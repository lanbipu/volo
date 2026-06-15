from lmt_vba_sidecar.sl_codec import (
    data_bits_for, even_parity, encode_id, decode_bits, build_dots_in_rect,
)


def test_data_bits_for():
    assert data_bits_for(1) == 1
    assert data_bits_for(2) == 1
    assert data_bits_for(3) == 2
    assert data_bits_for(1000) == 10


def test_encode_decode_roundtrip_including_zero():
    db = data_bits_for(500)
    for i in (0, 1, 255, 499):       # 0 must round-trip
        bits = encode_id(i, db)
        assert len(bits) == db + 1
        assert decode_bits(bits, db) == i


def test_decode_rejects_bad_parity():
    db = data_bits_for(500)
    bits = encode_id(42, db)
    bits[-1] ^= 1
    assert decode_bits(bits, db) is None


def test_build_dots_in_rect_places_inside_with_margin():
    # rect (x=100,y=50,w=960,h=540), spacing 240, margin 120, ids from 7
    dots = build_dots_in_rect(rect=(100, 50, 960, 540), spacing_px=240,
                              margin_px=120, id_start=7)
    assert dots[0][0] == 7
    for (_id, u, v) in dots:
        assert 100 + 120 <= u <= 100 + 960 - 120
        assert 50 + 120 <= v <= 50 + 540 - 120
