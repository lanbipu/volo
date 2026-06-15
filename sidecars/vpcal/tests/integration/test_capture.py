"""Real-time tracking ingest (remediation C1.1)."""

from __future__ import annotations

import json
import socket

import numpy as np
import pytest

from vpcal.core.capture import (
    capture_tracking_udp,
    opentrackio_to_frame,
    record_packets,
)
from vpcal.core.freed import FreeDPose, decode_freed_d1, encode_freed_d1
from vpcal.core.transforms import quat_to_matrix
from vpcal.models.tracking import RotationOrder


# ── FreeD codec ──────────────────────────────────────────────────────


def test_freed_encode_decode_roundtrip():
    p = FreeDPose(camera_id=3, pan=12.5, tilt=-7.25, roll=1.0,
                  x=1.234, y=-2.5, z=0.75, zoom_raw=4096, focus_raw=2048)
    data = encode_freed_d1(p)
    assert len(data) == 29 and data[0] == 0xD1
    back = decode_freed_d1(data)
    assert back.camera_id == 3
    assert abs(back.pan - 12.5) < 1e-3
    assert abs(back.tilt + 7.25) < 1e-3
    assert abs(back.x - 1.234) < 1e-4
    assert abs(back.z - 0.75) < 1e-4


def test_freed_bad_length_and_checksum():
    with pytest.raises(ValueError, match="29 bytes"):
        decode_freed_d1(b"\xd1\x00")
    good = bytearray(encode_freed_d1(FreeDPose(0, 0, 0, 0, 0, 0, 0, 0, 0)))
    good[28] ^= 0xFF  # corrupt checksum
    with pytest.raises(ValueError, match="checksum"):
        decode_freed_d1(bytes(good))


# ── record_packets (frame conversion) ────────────────────────────────


def test_record_packets_freed_units_and_timestamps():
    p0 = encode_freed_d1(FreeDPose(1, 10.0, 5.0, 0.0, 1.0, 2.0, 3.0, 0, 0))   # metres
    p1 = encode_freed_d1(FreeDPose(1, 11.0, 5.0, 0.0, 1.0, 2.0, 3.0, 0, 0))
    frames = record_packets([(100.0, p0), (100.5, p1)], "freed")
    assert len(frames) == 2
    # metres → mm
    assert frames[0].position == [1000.0, 2000.0, 3000.0]
    assert frames[0].rotation.order == RotationOrder.EULER_PTR
    assert abs(frames[0].rotation.values[0] - 10.0) < 1e-3
    # timestamps relative to the first packet
    assert frames[0].timestamp_s == 0.0
    assert abs(frames[1].timestamp_s - 0.5) < 1e-6
    assert [f.frame_id for f in frames] == [0, 1]


def test_record_packets_skips_invalid():
    good = encode_freed_d1(FreeDPose(0, 0, 0, 0, 0, 0, 0, 0, 0))
    frames = record_packets([(0.0, b"garbage"), (0.1, good)], "freed")
    assert len(frames) == 1  # invalid skipped, ids stay contiguous
    assert frames[0].frame_id == 0


def _otio_sample(pan=30.0, tilt=-10.0, roll=5.0):
    return {"transforms": [{"translation": {"x": 1.0, "y": 2.0, "z": 3.0},
                            "rotation": {"pan": pan, "tilt": tilt, "roll": roll}}]}


def _otrk_datagram(payload: bytes, encoding=0x01) -> bytes:
    """Wrap a payload in the 16-byte OpenTrackIO OTrk transport header."""
    import struct
    last_and_len = 0x8000 | (len(payload) & 0x7FFF)  # last-segment bit + length
    header = (b"OTrk" + bytes([0x00, encoding]) + struct.pack("!H", 0)
              + struct.pack("!I", 0) + struct.pack("!H", last_and_len) + struct.pack("!H", 0))
    return header + payload


def test_opentrackio_naked_json_to_frame():
    # Naked JSON (no OTrk header) accepted as a convenience.
    f = opentrackio_to_frame(json.dumps(_otio_sample()).encode(), 0, 0.0)
    assert f.position == [1000.0, 2000.0, 3000.0]
    # Rotation stored as a quaternion in the OpenTrackIO (intrinsic ZXY) convention.
    assert f.rotation.order == RotationOrder.QUATERNION
    from vpcal.core.coordinates import opentrackio_euler_to_matrix
    from vpcal.core.transforms import quat_to_matrix
    R_back = quat_to_matrix(f.rotation.values)
    np.testing.assert_allclose(R_back, opentrackio_euler_to_matrix(30.0, -10.0, 5.0), atol=1e-9)


def test_opentrackio_real_otrk_datagram():
    # The real wire format (OTrk header + JSON) must decode — not silently drop.
    payload = json.dumps(_otio_sample()).encode()
    datagram = _otrk_datagram(payload)
    f = opentrackio_to_frame(datagram, 0, 0.0)
    assert f.position == [1000.0, 2000.0, 3000.0]
    # Through the record path (skip_invalid default), the OTrk packet is kept.
    frames = record_packets([(0.0, datagram)], "opentrackio")
    assert len(frames) == 1


def test_opentrackio_coordinate_system_is_opentrackio():
    from vpcal.core.capture import COORDINATE_SYSTEM
    assert COORDINATE_SYSTEM["opentrackio"] == "opentrackio"
    assert COORDINATE_SYSTEM["freed"] == "freeDEuler"


def _otrk_segment(payload: bytes, *, offset=0, last=True, encoding=0x01, seq=5) -> bytes:
    import struct
    l_and_len = (0x8000 if last else 0) | (len(payload) & 0x7FFF)
    return (b"OTrk" + bytes([0x00, encoding]) + struct.pack("!H", seq) + struct.pack("!I", offset)
            + struct.pack("!H", l_and_len) + struct.pack("!H", 0) + payload)


def test_opentrackio_multisegment_reassembly():
    # A sample split across 2 OTrk segments must be reassembled, not dropped.
    payload = json.dumps(_otio_sample()).encode()
    half = len(payload) // 2
    seg0 = _otrk_segment(payload[:half], offset=0, last=False)
    seg1 = _otrk_segment(payload[half:], offset=half, last=True)
    frames = record_packets([(0.0, seg0), (0.1, seg1)], "opentrackio")
    assert len(frames) == 1
    assert frames[0].position == [1000.0, 2000.0, 3000.0]


def test_opentrackio_incomplete_segment_dropped_not_fragmented():
    # Only the first of two segments arrives → no fragment frame is emitted.
    payload = json.dumps(_otio_sample()).encode()
    seg0 = _otrk_segment(payload[: len(payload) // 2], offset=0, last=False)
    assert record_packets([(0.0, seg0)], "opentrackio") == []


def test_opentrackio_transform_chain_composed():
    from vpcal.core.capture import opentrackio_sample_to_frame
    sample = {"transforms": [
        {"translation": {"x": 1.0, "y": 0.0, "z": 0.0}},
        {"translation": {"x": 0.0, "y": 2.0, "z": 0.0}},
    ]}
    f = opentrackio_sample_to_frame(sample, 0, 0.0)
    # identity rotations → compound translation [1,2,0] m → mm
    assert f.position == [1000.0, 2000.0, 0.0]


def test_opentrackio_null_rotation_handled():
    from vpcal.core.capture import opentrackio_sample_to_frame
    sample = {"transforms": [{"translation": {"x": 1.0, "y": 2.0, "z": 3.0}, "rotation": None}]}
    f = opentrackio_sample_to_frame(sample, 0, 0.0)
    assert f.position == [1000.0, 2000.0, 3000.0]
    np.testing.assert_allclose(quat_to_matrix(f.rotation.values), np.eye(3), atol=1e-9)


def test_record_packets_skips_decode_errors_broadly():
    # A transform that is not a dict → AttributeError inside decode; must be
    # skipped under skip_invalid (broadened catch), not crash the capture.
    bad = json.dumps({"transforms": [123]}).encode()
    good = json.dumps(_otio_sample()).encode()
    frames = record_packets([(0.0, bad), (0.1, good)], "opentrackio")
    assert len(frames) == 1
    import pytest as _pytest
    with _pytest.raises(Exception):
        record_packets([(0.0, bad)], "opentrackio", skip_invalid=False)


# ── UDP loopback (real socket, no threads: packets queue then are read) ──


def test_capture_udp_loopback_records_packets(tmp_path):
    # Bind first so packets sent next are buffered by the kernel, then record.
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()  # free the port for the recorder to bind

    rec = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    rec.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    rec.bind(("127.0.0.1", port))

    client = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    for pan in (1.0, 2.0, 3.0):
        client.sendto(encode_freed_d1(FreeDPose(0, pan, 0, 0, 0, 0, 0, 0, 0)), ("127.0.0.1", port))
    client.close()

    from vpcal.core.capture import _record_from_socket
    frames = _record_from_socket(rec, protocol="freed", duration_s=2.0, max_packets=3)
    rec.close()
    assert len(frames) == 3
    assert [round(f.rotation.values[0]) for f in frames] == [1, 2, 3]


def test_capture_tracking_udp_writes_stream(tmp_path):
    # max_packets=0 with a tiny duration → returns promptly with no frames,
    # exercising the bind/write path and poses.jsonl creation.
    out = tmp_path / "poses.jsonl"
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()
    frames = capture_tracking_udp(port, protocol="freed", duration_s=0.1,
                                  host="127.0.0.1", max_packets=0, out=out)
    assert frames == []
    assert out.exists()


def test_unknown_protocol_raises():
    with pytest.raises(ValueError, match="unknown protocol"):
        record_packets([], "bogus")
