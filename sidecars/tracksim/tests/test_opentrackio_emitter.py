import json
import struct

import cbor2

from tracksim.domain.pose import CameraPose
from tracksim.emitters.opentrackio import (
    ENCODING_CBOR,
    ENCODING_JSON,
    OpenTrackIOEmitter,
)


class FakeTransport:
    def __init__(self) -> None:
        self.sent: list[bytes] = []
        self.closed = False

    def send(self, data: bytes) -> None:
        self.sent.append(data)

    def close(self) -> None:
        self.closed = True


def _body(packet: bytes) -> bytes:
    length = struct.unpack("!H", packet[12:14])[0] & 0x7FFF
    return packet[16 : 16 + length]


def test_opentrackio_emitter_name():
    assert OpenTrackIOEmitter(FakeTransport()).name == "opentrackio"


def test_json_emit_roundtrips_sample():
    transport = FakeTransport()
    emitter = OpenTrackIOEmitter(transport, source_number=3, encoding=ENCODING_JSON)
    emitter.emit(CameraPose(pan=10.0, x=1.0, z=1.5))
    assert len(transport.sent) == 1
    packet = transport.sent[0]
    assert packet[5] == ENCODING_JSON
    sample = json.loads(_body(packet))
    assert sample["sourceNumber"] == 3
    assert sample["transforms"][0]["rotation"]["pan"] == 10.0
    assert sample["transforms"][0]["translation"]["x"] == 1.0


def test_cbor_emit_roundtrips_sample():
    transport = FakeTransport()
    emitter = OpenTrackIOEmitter(transport, source_number=2, encoding=ENCODING_CBOR)
    emitter.emit(CameraPose(tilt=-5.0, z=1.2))
    packet = transport.sent[0]
    assert packet[5] == ENCODING_CBOR
    sample = cbor2.loads(_body(packet))
    assert sample["sourceNumber"] == 2
    assert sample["transforms"][0]["rotation"]["tilt"] == -5.0


def test_sequence_increments_across_emits():
    transport = FakeTransport()
    emitter = OpenTrackIOEmitter(transport, encoding=ENCODING_JSON)
    emitter.emit(CameraPose())
    emitter.emit(CameraPose())
    seq0 = struct.unpack("!H", transport.sent[0][6:8])[0]
    seq1 = struct.unpack("!H", transport.sent[1][6:8])[0]
    assert seq1 == seq0 + 1


def test_multi_segment_samples_have_unique_monotonic_sequences():
    # 防回归 F6：超过单包的样本会分多段；跨样本所有分段的 sequence 必须唯一且连续递增，
    # 不得复用上一样本后续分段的 sequence（否则接收端按 sequence 去重时会丢包）。
    transport = FakeTransport()
    big = {"blob": "x" * 8000}  # 使 JSON payload 远超 OTRK_MTU，强制分段
    emitter = OpenTrackIOEmitter(transport, encoding=ENCODING_JSON, static_meta=big)
    emitter.emit(CameraPose())
    emitter.emit(CameraPose())
    assert len(transport.sent) > 2  # 至少两个样本、每样本多段
    seqs = [struct.unpack("!H", p[6:8])[0] for p in transport.sent]
    assert len(seqs) == len(set(seqs)), f"sequence reuse across samples: {seqs}"
    assert seqs == list(range(seqs[0], seqs[0] + len(seqs)))  # 连续单调递增


def test_close_forwards():
    transport = FakeTransport()
    OpenTrackIOEmitter(transport).close()
    assert transport.closed is True
