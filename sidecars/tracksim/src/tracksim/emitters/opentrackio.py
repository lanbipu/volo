import json
import struct
import uuid

from tracksim.checksum import fletcher16
from tracksim.domain.pose import CameraPose
from tracksim.ports.transport import Transport

OTRK_IDENTIFIER = b"OTrk"
OTRK_HEADER_LENGTH = 16
OTRK_MTU = 1500
OTRK_MAX_PAYLOAD_SIZE = OTRK_MTU - OTRK_HEADER_LENGTH
ENCODING_JSON = 0x01
ENCODING_CBOR = 0x02

PROTOCOL_NAME = "OpenTrackIO"
PROTOCOL_VERSION = [1, 0, 1]

_SOURCE_NS = uuid.UUID("6ba7b810-9dad-11d1-80b4-00c04fd430c8")


def _stable_uuid(name: str) -> str:
    return f"urn:uuid:{uuid.uuid5(_SOURCE_NS, name)}"


def build_sample(
    pose: CameraPose,
    *,
    source_number: int,
    sequence: int,
    static_meta: dict,
) -> dict:
    """Build an OpenTrackIO sample dict conforming to the JSON schema."""
    seconds = int(pose.timestamp)
    nanoseconds = int(round((pose.timestamp - seconds) * 1_000_000_000))

    sample: dict = {
        "protocol": {"name": PROTOCOL_NAME, "version": list(PROTOCOL_VERSION)},
        "sampleId": _stable_uuid(f"sample:{source_number}:{sequence}"),
        "sourceId": _stable_uuid(f"source:{source_number}"),
        "sourceNumber": source_number,
        "timing": {
            "sampleTimestamp": {
                "seconds": seconds,
                "nanoseconds": nanoseconds,
            }
        },
        "lens": {
            "pinholeFocalLength": pose.focal_length,
            "focusDistance": pose.focus_distance,
        },
        "transforms": [
            {
                "translation": {"x": pose.x, "y": pose.y, "z": pose.z},
                "rotation": {"pan": pose.pan, "tilt": pose.tilt, "roll": pose.roll},
                "id": "Camera",
            }
        ],
    }
    if static_meta:
        sample.update(static_meta)
    return sample


def build_packets(payload: bytes, *, encoding: int, sequence: int) -> list[bytes]:
    """Wrap a payload in one or more 16-byte OTrk-header UDP packets.

    Header layout (OpenTrackIO transport spec, copied from camdkit
    opentrackio_sender._construct_udp_header):
      [0:4]   identifier b"OTrk"
      [4]     reserved (0)
      [5]     encoding byte
      [6:8]   sequence number (uint16 BE)
      [8:12]  segment offset (uint32 BE)
      [12:14] (last_segment << 15) | payload_length (uint16 BE)
      [14:16] fletcher16(header[0:14] + payload) (uint16 BE)
    Segmentation occurs at OTRK_MAX_PAYLOAD_SIZE.
    """
    segments: list[bytes] = []
    total_length = len(payload)
    max_payload_size = OTRK_MAX_PAYLOAD_SIZE

    offsets = range(0, total_length, max_payload_size) if total_length else [0]
    for offset in offsets:
        segment_payload = payload[offset : offset + max_payload_size]
        last_segment = offset + max_payload_size >= total_length

        l_and_len = (int(last_segment) << 15) | len(segment_payload)
        header_wo_ck = (
            OTRK_IDENTIFIER
            + struct.pack("!B", 0)
            + struct.pack("!B", encoding)
            + struct.pack("!H", sequence & 0xFFFF)
            + struct.pack("!I", offset)
            + struct.pack("!H", l_and_len)
        )
        checksum = fletcher16(header_wo_ck + segment_payload)
        header = header_wo_ck + struct.pack("!H", checksum)
        segments.append(header + segment_payload)
        sequence = (sequence + 1) & 0xFFFF

    return segments


class OpenTrackIOEmitter:
    name = "opentrackio"

    def __init__(
        self,
        transport: Transport,
        *,
        source_number: int = 1,
        encoding: int = ENCODING_JSON,
        static_meta: dict | None = None,
    ) -> None:
        self._transport = transport
        self._source_number = source_number
        self._encoding = encoding
        self._static_meta = static_meta or {}
        self._sequence = 0

    def emit(self, pose: CameraPose) -> None:
        sample = build_sample(
            pose,
            source_number=self._source_number,
            sequence=self._sequence,
            static_meta=self._static_meta,
        )
        if self._encoding == ENCODING_CBOR:
            import cbor2

            payload = cbor2.dumps(sample)
        else:
            payload = json.dumps(sample).encode("utf-8")

        # OTrk sequence 是「每包」递增（对齐 camdkit 参考实现：接收端按 sequence 去重）。
        # build_packets 已为各分段分配连续 sequence，故发送后须按分段数推进 self._sequence；
        # 若只 +1，下一样本会复用上一样本后续分段的 sequence，污染分段重组（修复 F6）。
        packets = build_packets(payload, encoding=self._encoding, sequence=self._sequence)
        for packet in packets:
            self._transport.send(packet)
        self._sequence = (self._sequence + len(packets)) & 0xFFFF

    def close(self) -> None:
        self._transport.close()
