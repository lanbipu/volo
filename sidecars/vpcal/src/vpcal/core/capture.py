"""Real-time tracking ingest (remediation C1.1 — capture service step 1).

Listens for FreeD / OpenTrackIO tracking datagrams over UDP and records them as a
timestamped vpcal tracking stream (``poses.jsonl``), so the image↔tracking pairing
can key on receive time instead of the file-name convention.  Steps C1.2 (video
stream) and C1.3 (pattern playback) need capture/display hardware and are scaffolded
separately (see ``docs/c1-capture-service.md``).
"""

from __future__ import annotations

import json
import socket
import struct
import time
from pathlib import Path
from typing import Iterable

from vpcal.core.freed import decode_freed_d1
from vpcal.models.tracking import RotationData, RotationOrder, TrackingFrame

_M_PER_MM = 1000.0
PROTOCOLS = ("freed", "opentrackio")

# OpenTrackIO UDP transport header (OTrk): 16 bytes, payload may be JSON or CBOR,
# and a large sample may be split across several segments.
_OTRK_MAGIC = b"OTrk"
_OTRK_HEADER_LEN = 16
_OTRK_ENCODING_JSON = 0x01
_OTRK_ENCODING_CBOR = 0x02


def _parse_otrk_segment(data: bytes):
    """Parse an OTrk datagram header → ``(encoding, seq, offset, last, payload)``.

    Returns ``None`` for a naked (header-less) payload.
    """
    if not (len(data) >= 4 and data[:4] == _OTRK_MAGIC):
        return None
    if len(data) < _OTRK_HEADER_LEN:
        raise ValueError("truncated OTrk datagram")
    encoding = data[5]
    sequence = struct.unpack("!H", data[6:8])[0]
    offset = struct.unpack("!I", data[8:12])[0]
    l_and_len = struct.unpack("!H", data[12:14])[0]
    last = bool(l_and_len >> 15)
    payload_len = l_and_len & 0x7FFF
    payload = data[_OTRK_HEADER_LEN:_OTRK_HEADER_LEN + payload_len]
    return encoding, sequence, offset, last, payload


def _decode_otrk_payload(encoding: int, payload: bytes) -> dict:
    if encoding == _OTRK_ENCODING_CBOR:
        try:
            import cbor2
        except ImportError as exc:  # pragma: no cover - optional dep
            raise ValueError("OpenTrackIO CBOR payload requires the 'cbor2' package") from exc
        return cbor2.loads(payload)
    if encoding == _OTRK_ENCODING_JSON:
        return json.loads(payload.decode("utf-8"))
    raise ValueError(f"unsupported OpenTrackIO encoding 0x{encoding:02X}")


def _wrap_otrk_single(payload: bytes, encoding: int) -> bytes:
    """Re-wrap a reassembled payload as a single complete OTrk datagram."""
    header = (_OTRK_MAGIC + bytes([0x00, encoding]) + struct.pack("!H", 0)
              + struct.pack("!I", 0) + struct.pack("!H", 0x8000 | (len(payload) & 0x7FFF))
              + struct.pack("!H", 0))
    return header + payload


def decode_opentrackio_datagram(data: bytes) -> dict:
    """Parse a *complete* OpenTrackIO datagram into its sample dict.

    Handles the 16-byte ``OTrk`` header (JSON or CBOR payload) and naked JSON.  A
    multi-segment fragment (offset > 0 or not the last segment) is NOT a complete
    sample — reassemble via :func:`record_packets` first; here it raises.
    """
    seg = _parse_otrk_segment(data)
    if seg is None:
        return json.loads(data.decode("utf-8"))
    encoding, _seq, offset, last, payload = seg
    if offset != 0 or not last:
        raise ValueError("multi-segment OpenTrackIO datagram; reassemble before decoding")
    return _decode_otrk_payload(encoding, payload)


def _reassemble_otrk(packets: Iterable[tuple[float, bytes]]) -> list[tuple[float, bytes]]:
    """Reassemble multi-segment OTrk datagrams; pass complete/naked ones through.

    Incomplete sequences (a missing segment) are dropped rather than emitted as
    fragments.  Output items are complete single datagrams ready for per-packet
    decode.
    """
    out: list[tuple[float, bytes]] = []
    buffers: dict[int, dict] = {}
    for recv_time, data in packets:
        try:
            seg = _parse_otrk_segment(data)
        except ValueError:
            continue  # malformed header — drop
        if seg is None or (seg[2] == 0 and seg[3]):
            out.append((recv_time, data))  # naked JSON or single complete segment
            continue
        encoding, seq, offset, last, payload = seg
        buf = buffers.setdefault(seq, {"frags": {}, "encoding": encoding, "last": False})
        buf["frags"][offset] = payload
        buf["recv"] = recv_time
        if last:
            buf["last"] = True
        if buf["last"]:
            assembled = _assemble_fragments(buf["frags"])
            if assembled is not None:
                out.append((buf["recv"], _wrap_otrk_single(assembled, buf["encoding"])))
                buffers.pop(seq, None)
    return out


def _assemble_fragments(frags: dict[int, bytes]) -> bytes | None:
    """Concatenate fragments if contiguous from offset 0, else None (incomplete)."""
    parts: list[bytes] = []
    expected = 0
    for off in sorted(frags):
        if off != expected:
            return None
        parts.append(frags[off])
        expected += len(frags[off])
    return b"".join(parts)


def freed_to_frame(packet: bytes, frame_id: int, timestamp_s: float) -> TrackingFrame:
    """Decode a FreeD D1 packet into a TrackingFrame (mm + EULER_PTR degrees)."""
    p = decode_freed_d1(packet)
    return TrackingFrame(
        frame_id=frame_id,
        timestamp_s=timestamp_s,
        position=[p.x * _M_PER_MM, p.y * _M_PER_MM, p.z * _M_PER_MM],
        rotation=RotationData(order=RotationOrder.EULER_PTR, values=[p.pan, p.tilt, p.roll]),
        confidence=1.0,
    )


def opentrackio_sample_to_frame(sample: dict, frame_id: int, timestamp_s: float) -> TrackingFrame:
    """Build a TrackingFrame from an OpenTrackIO sample dict.

    Composes the full ``transforms`` chain (not just the first link), so a
    multi-link rig (pedestal + head) yields the compound camera-relative pose.
    Translation is metres → mm; pan/tilt/roll use the OpenTrackIO intrinsic-ZXY
    convention → matrix → quaternion (``coordinate_system="opentrackio"`` then
    applies the axis basis).  ``rotation``/``translation`` may be absent or null.
    """
    import numpy as np

    from vpcal.core.coordinates import opentrackio_euler_to_matrix
    from vpcal.core.transforms import matrix_to_quat

    transforms = sample.get("transforms") or []
    if not transforms:
        raise ValueError("OpenTrackIO sample has no transforms")
    M = np.eye(4)
    for tr in transforms:
        t = tr.get("translation") or {}
        r = tr.get("rotation") or {}
        link = np.eye(4)
        link[:3, :3] = opentrackio_euler_to_matrix(r.get("pan", 0.0), r.get("tilt", 0.0), r.get("roll", 0.0))
        link[:3, 3] = [t.get("x", 0.0), t.get("y", 0.0), t.get("z", 0.0)]
        M = M @ link
    q = matrix_to_quat(M[:3, :3])
    return TrackingFrame(
        frame_id=frame_id,
        timestamp_s=timestamp_s,
        position=[float(M[0, 3]) * _M_PER_MM, float(M[1, 3]) * _M_PER_MM, float(M[2, 3]) * _M_PER_MM],
        rotation=RotationData(order=RotationOrder.QUATERNION, values=[float(x) for x in q]),
        confidence=1.0,
    )


def opentrackio_to_frame(packet: bytes, frame_id: int, timestamp_s: float) -> TrackingFrame:
    """Decode a complete OpenTrackIO datagram → frame (see :func:`opentrackio_sample_to_frame`)."""
    return opentrackio_sample_to_frame(decode_opentrackio_datagram(packet), frame_id, timestamp_s)


_DECODERS = {"freed": freed_to_frame, "opentrackio": opentrackio_to_frame}

# Coordinate system each protocol's frames are expressed in (for the session).
# OpenTrackIO has its own RH source basis — distinct from the FreeD/OptiTrack one.
COORDINATE_SYSTEM = {"freed": "freeDEuler", "opentrackio": "opentrackio"}


def record_packets(
    packets: Iterable[tuple[float, bytes]],
    protocol: str = "freed",
    *,
    start_time: float | None = None,
    skip_invalid: bool = True,
) -> list[TrackingFrame]:
    """Convert ``(recv_time, raw_packet)`` pairs into TrackingFrames (testable core).

    Timestamps are relative to ``start_time`` (default: the first packet).
    OpenTrackIO multi-segment datagrams are reassembled first.  A packet whose
    decode raises ANY error (malformed JSON/CBOR, bad encoding, missing fields)
    is skipped (``skip_invalid``, default) or re-raised — one bad packet never
    aborts a live capture.
    """
    if protocol not in _DECODERS:
        raise ValueError(f"unknown protocol {protocol!r}; expected one of {PROTOCOLS}")
    if protocol == "opentrackio":
        packets = _reassemble_otrk(packets)
    decode = _DECODERS[protocol]
    frames: list[TrackingFrame] = []
    fid = 0
    for recv_time, packet in packets:
        if start_time is None:
            start_time = recv_time
        try:
            frames.append(decode(packet, fid, max(0.0, recv_time - start_time)))
            fid += 1
        except Exception:
            if not skip_invalid:
                raise
    return frames


def _record_from_socket(
    sock: socket.socket,
    *,
    protocol: str,
    duration_s: float,
    max_packets: int | None,
    poll_s: float = 0.2,
) -> list[TrackingFrame]:
    sock.settimeout(poll_s)
    start = time.monotonic()
    raw: list[tuple[float, bytes]] = []
    while time.monotonic() - start < duration_s:
        if max_packets is not None and len(raw) >= max_packets:
            break
        try:
            data, _addr = sock.recvfrom(4096)
        except socket.timeout:
            continue
        raw.append((time.monotonic(), data))
    # Anchor timestamps to the first received packet (record_packets' documented
    # default), so frame 0 is t=0 regardless of the bind→first-packet gap.
    return record_packets(raw, protocol)


def capture_tracking_udp(
    port: int,
    *,
    protocol: str = "freed",
    duration_s: float = 30.0,
    host: str = "0.0.0.0",
    max_packets: int | None = None,
    out: str | Path | None = None,
) -> list[TrackingFrame]:
    """Bind a UDP socket and record incoming tracking packets to a stream.

    Returns the recorded frames; if ``out`` is given, also writes ``poses.jsonl``.
    """
    if protocol not in PROTOCOLS:
        raise ValueError(f"unknown protocol {protocol!r}; expected one of {PROTOCOLS}")
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((host, port))
    try:
        frames = _record_from_socket(
            sock, protocol=protocol, duration_s=duration_s, max_packets=max_packets
        )
    finally:
        sock.close()
    if out is not None:
        from vpcal.io.tracking_io import write_tracking
        write_tracking(frames, Path(out))
    return frames
