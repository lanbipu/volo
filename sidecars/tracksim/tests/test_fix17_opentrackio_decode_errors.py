"""Fix 17 (round 3 finding 4): opentrackio decode must validate encoding byte and wrap decode errors."""
from __future__ import annotations

import json
import struct

import pytest

from tracksim.checksum import fletcher16
from tracksim.cli.commands import decode
from tracksim.domain.errors import InvalidTrajectoryError
from tracksim.emitters.opentrackio import (
    ENCODING_JSON,
    OTRK_IDENTIFIER,
    build_packets,
    build_sample,
)
from tracksim.domain.pose import CameraPose


def _build_packet_with_encoding(encoding_byte: int, payload: bytes) -> bytes:
    """Build a checksum-valid OTrk packet with arbitrary encoding byte."""
    l_and_len = (1 << 15) | len(payload)  # last_segment=1
    header_wo_ck = (
        OTRK_IDENTIFIER
        + struct.pack("!B", 0)          # reserved
        + struct.pack("!B", encoding_byte)
        + struct.pack("!H", 0)          # sequence
        + struct.pack("!I", 0)          # offset
        + struct.pack("!H", l_and_len)
    )
    checksum = fletcher16(header_wo_ck + payload)
    header = header_wo_ck + struct.pack("!H", checksum)
    return header + payload


def test_unsupported_encoding_raises_invalid_trajectory():
    """Encoding byte that is neither JSON (0x01) nor CBOR (0x02) must raise InvalidTrajectoryError."""
    payload = b'{"sourceNumber":1}'
    packet = _build_packet_with_encoding(0xFF, payload)
    with pytest.raises(InvalidTrajectoryError) as exc_info:
        decode.opentrackio_decode(packet)
    assert "encoding" in exc_info.value.message.lower() or "0xff" in exc_info.value.message.lower()


def test_encoding_zero_raises_invalid_trajectory():
    """Encoding byte 0x00 must raise InvalidTrajectoryError."""
    payload = b'{"sourceNumber":1}'
    packet = _build_packet_with_encoding(0x00, payload)
    with pytest.raises(InvalidTrajectoryError):
        decode.opentrackio_decode(packet)


def test_malformed_json_payload_raises_invalid_trajectory():
    """A packet with valid header+checksum but invalid JSON payload must raise InvalidTrajectoryError."""
    payload = b"not-json!!!"
    packet = _build_packet_with_encoding(ENCODING_JSON, payload)
    with pytest.raises(InvalidTrajectoryError) as exc_info:
        decode.opentrackio_decode(packet)
    assert exc_info.value.code == "INVALID_TRAJECTORY"


def test_good_json_packet_still_works():
    """Regression: a well-formed JSON packet must still decode correctly."""
    pose = CameraPose(pan=5.0)
    sample = build_sample(pose, source_number=1, sequence=0, static_meta={})
    payload = json.dumps(sample).encode("utf-8")
    packet = build_packets(payload, encoding=ENCODING_JSON, sequence=0)[0]
    op, data = decode.opentrackio_decode(packet)
    assert op == "opentrackio.decode"
    assert data["encoding"] == "json"
