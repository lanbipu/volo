import json
import struct

import pytest

from tracksim.checksum import fletcher16
from tracksim.cli.commands import decode
from tracksim.domain.errors import InvalidTrajectoryError
from tracksim.domain.pose import CameraPose
from tracksim.emitters.freed import FreeDScaling, encode_d1
from tracksim.emitters.opentrackio import (
    ENCODING_JSON,
    OTRK_IDENTIFIER,
    build_packets,
    build_sample,
)


def test_freed_decode_roundtrips_basic_fields():
    pose = CameraPose(pan=12.0, tilt=-3.0, x=1.0, z=2.0)
    packet = encode_d1(pose, camera_id=7, scaling=FreeDScaling())
    op, data = decode.freed_decode(packet)
    assert op == "freed.decode"
    assert data["camera_id"] == 7
    assert data["message_type"] == "0xD1"
    assert abs(data["pan"] - 12.0) < 0.01
    assert abs(data["tilt"] - (-3.0)) < 0.01
    assert data["checksum_valid"] is True


def test_freed_decode_rejects_wrong_length():
    with pytest.raises(InvalidTrajectoryError):
        decode.freed_decode(b"\x00" * 10)


def test_freed_decode_rejects_bad_checksum():
    pose = CameraPose(pan=1.0)
    packet = bytearray(encode_d1(pose, camera_id=0, scaling=FreeDScaling()))
    packet[-1] ^= 0xFF
    with pytest.raises(InvalidTrajectoryError):
        decode.freed_decode(bytes(packet))


def test_opentrackio_decode_returns_sample_fields():
    pose = CameraPose(pan=5.0, focal_length=50.0)
    sample = build_sample(pose, source_number=3, sequence=0, static_meta={})
    payload = json.dumps(sample).encode("utf-8")
    packet = build_packets(payload, encoding=ENCODING_JSON, sequence=0)[0]
    op, data = decode.opentrackio_decode(packet)
    assert op == "opentrackio.decode"
    assert data["encoding"] == "json"
    assert data["sample"]["sourceNumber"] == 3
    assert data["checksum_valid"] is True


def test_opentrackio_decode_rejects_bad_identifier():
    bad = b"XXXX" + b"\x00" * 12
    with pytest.raises(InvalidTrajectoryError):
        decode.opentrackio_decode(bad)
