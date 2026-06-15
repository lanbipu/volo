import struct

from tracksim.checksum import fletcher16
from tracksim.emitters.opentrackio import (
    ENCODING_CBOR,
    ENCODING_JSON,
    OTRK_HEADER_LENGTH,
    OTRK_IDENTIFIER,
    OTRK_MAX_PAYLOAD_SIZE,
    build_packets,
)


def _parse_header(packet: bytes):
    assert packet[0:4] == OTRK_IDENTIFIER
    reserved = packet[4]
    encoding = packet[5]
    sequence = struct.unpack("!H", packet[6:8])[0]
    offset = struct.unpack("!I", packet[8:12])[0]
    l_and_len = struct.unpack("!H", packet[12:14])[0]
    last = bool(l_and_len >> 15)
    length = l_and_len & 0x7FFF
    checksum = struct.unpack("!H", packet[14:16])[0]
    payload = packet[16 : 16 + length]
    return reserved, encoding, sequence, offset, last, length, checksum, payload


def test_single_segment_header_fields():
    payload = b'{"a":1}'
    packets = build_packets(payload, encoding=ENCODING_JSON, sequence=42)
    assert len(packets) == 1
    reserved, encoding, seq, offset, last, length, ck, body = _parse_header(packets[0])
    assert reserved == 0
    assert encoding == ENCODING_JSON
    assert seq == 42
    assert offset == 0
    assert last is True
    assert length == len(payload)
    assert body == payload


def test_single_segment_fletcher16_self_consistent():
    payload = b"hello-opentrackio"
    packet = build_packets(payload, encoding=ENCODING_CBOR, sequence=1)[0]
    header_wo_ck = packet[0:14]
    body = packet[16:]
    ck = struct.unpack("!H", packet[14:16])[0]
    assert ck == fletcher16(header_wo_ck + body)
    assert struct.unpack("!H", packet[14:16])[0] != 0


def test_large_payload_segments_and_reassembles():
    payload = bytes((i % 251) for i in range(OTRK_MAX_PAYLOAD_SIZE * 2 + 100))
    packets = build_packets(payload, encoding=ENCODING_JSON, sequence=10)
    assert len(packets) == 3

    # sequence increments per segment
    seqs = [struct.unpack("!H", p[6:8])[0] for p in packets]
    assert seqs == [10, 11, 12]

    # last flag only on final segment
    flags = [bool(struct.unpack("!H", p[12:14])[0] >> 15) for p in packets]
    assert flags == [False, False, True]

    # reassemble by segment offset
    reassembled = bytearray()
    for p in packets:
        _, _, _, offset, _, length, _, body = _parse_header(p)
        assert offset == len(reassembled)
        reassembled += body
    assert bytes(reassembled) == payload


def test_packet_total_size_within_mtu():
    payload = bytes(OTRK_MAX_PAYLOAD_SIZE)
    packets = build_packets(payload, encoding=ENCODING_JSON, sequence=0)
    assert len(packets) == 1
    assert len(packets[0]) == OTRK_HEADER_LENGTH + OTRK_MAX_PAYLOAD_SIZE
