from tracksim.checksum import fletcher16


def _ref_fletcher16(data: bytes) -> int:
    sum1 = 0
    sum2 = 0
    for byte in data:
        sum1 = (sum1 + byte) % 256
        sum2 = (sum2 + sum1) % 256
    return (sum2 << 8) | sum1


def test_returns_int():
    assert isinstance(fletcher16(b"OTrk"), int)


def test_empty():
    assert fletcher16(b"") == 0


def test_otrk_vector():
    # derived by hand from camdkit opentrackio_lib.fletcher16 algorithm
    assert fletcher16(b"OTrk") == 0x8780


def test_classic_abcde_vector():
    # Plan stated 0xC8F0 but the reference algorithm (mod-256 variant) yields 0xC3EF
    assert fletcher16(b"abcde") == 0xC3EF


def test_matches_reference_algorithm():
    for data in [b"", b"\x00", b"\xff" * 17, bytes(range(64)), b"hello world"]:
        assert fletcher16(data) == _ref_fletcher16(data)


def test_result_in_16bit_range():
    val = fletcher16(bytes(range(256)) * 4)
    assert 0 <= val <= 0xFFFF
