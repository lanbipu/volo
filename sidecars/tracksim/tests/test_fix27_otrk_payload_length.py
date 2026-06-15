"""Fix 27 (round 5 finding 4): Validate OpenTrackIO datagram length vs header payload_length."""
from __future__ import annotations

import json
import struct

import pytest

from tracksim.checksum import fletcher16
from tracksim.cli.commands import decode
from tracksim.domain.errors import InvalidTrajectoryError
from tracksim.domain.pose import CameraPose
from tracksim.emitters.opentrackio import (
    ENCODING_JSON,
    OTRK_HEADER_LENGTH,
    OTRK_IDENTIFIER,
    build_packets,
    build_sample,
)


def _build_valid_packet() -> bytes:
    pose = CameraPose(pan=1.0)
    sample = build_sample(pose, source_number=1, sequence=0, static_meta={})
    payload = json.dumps(sample).encode("utf-8")
    return build_packets(payload, encoding=ENCODING_JSON, sequence=0)[0]


def _make_packet_with_claimed_length(actual_payload: bytes, claimed_payload_len: int) -> bytes:
    """Build a packet where the header claims a different payload length than actual_payload."""
    # Build header bytes 0-13 with the claimed length
    header = bytearray(OTRK_HEADER_LENGTH)
    header[0:4] = OTRK_IDENTIFIER
    header[4] = 0x00  # version
    header[5] = ENCODING_JSON
    struct.pack_into("!H", header, 6, 0)   # sequence
    struct.pack_into("!I", header, 8, 0)   # offset
    # last_segment=1, payload_length=claimed_payload_len
    l_and_len = (1 << 15) | (claimed_payload_len & 0x7FFF)
    struct.pack_into("!H", header, 12, l_and_len)
    # compute checksum over header[0:14] + actual_payload
    checksum = fletcher16(bytes(header[0:14]) + actual_payload)
    struct.pack_into("!H", header, 14, checksum)
    return bytes(header) + actual_payload


def test_otrk_claimed_length_exceeds_actual_data():
    """A packet claiming payload_length larger than actual data must raise InvalidTrajectoryError."""
    actual_payload = b'{"sourceNumber": 1}'
    claimed_len = len(actual_payload) + 10  # claims 10 extra bytes that aren't there
    packet = _make_packet_with_claimed_length(actual_payload, claimed_len)
    with pytest.raises(InvalidTrajectoryError) as exc_info:
        decode.opentrackio_decode(packet)
    assert exc_info.value.exit_code == 13


def test_otrk_exact_length_is_accepted():
    """A well-formed packet (claimed length == actual payload length) must decode successfully."""
    packet = _build_valid_packet()
    op, data = decode.opentrackio_decode(packet)
    assert op == "opentrackio.decode"
    assert data["checksum_valid"] is True


def test_otrk_claimed_length_less_than_actual_data():
    """A packet claiming a smaller payload than available is also rejected (length mismatch)."""
    actual_payload = b'{"sourceNumber": 1}'
    claimed_len = len(actual_payload) - 3
    packet = _make_packet_with_claimed_length(actual_payload, claimed_len)
    with pytest.raises(InvalidTrajectoryError):
        decode.opentrackio_decode(packet)
