"""v210 unpacking + SMPTE BCD timecode (core/v210.py) — synthetic-layer tests
(plan Phase 2 acceptance: no SDK, no card)."""

from __future__ import annotations

import numpy as np
import pytest

from vpcal.core.v210 import (
    gray10_to_v210,
    parse_bcd_timecode,
    v210_row_bytes,
    v210_to_gray16,
)


def test_row_bytes():
    assert v210_row_bytes(48) == 128
    assert v210_row_bytes(1920) == 1920 // 48 * 128  # multiple of 48
    assert v210_row_bytes(1280) == ((1280 + 47) // 48) * 128


@pytest.mark.parametrize("w,h", [(48, 4), (1920, 8), (1280, 3), (100, 2)])
def test_v210_roundtrip(w, h):
    rng = np.random.default_rng(42)
    luma = rng.integers(0, 1024, size=(h, w), dtype=np.uint16)
    packed = gray10_to_v210(luma)
    assert len(packed) == v210_row_bytes(w) * h
    gray16 = v210_to_gray16(packed, w, h)
    assert gray16.dtype == np.uint16
    assert gray16.shape == (h, w)
    # Left-aligned 10-bit: recover原值 by >> 6.
    np.testing.assert_array_equal(gray16 >> 6, luma)


def test_v210_gradient_preserves_10bit_precision():
    # 1024 distinct levels across one row — 8-bit would collapse neighbours.
    luma = np.arange(1024, dtype=np.uint16).reshape(1, 1024)
    gray16 = v210_to_gray16(gray10_to_v210(luma), 1024, 1)
    assert len(np.unique(gray16)) == 1024


def test_v210_rejects_bad_stride():
    with pytest.raises(ValueError, match="multiple of 16"):
        v210_to_gray16(b"\x00" * 120, 48, 1, row_bytes=120)


def test_gray10_rejects_overflow():
    with pytest.raises(ValueError, match="10 bits"):
        gray10_to_v210(np.full((1, 48), 1024, dtype=np.uint16))


def test_bcd_timecode_nominal():
    # 12:34:56:23 → BCD bytes 0x12 0x34 0x56 0x23
    assert parse_bcd_timecode(0x12345623) == "12:34:56:23"
    assert parse_bcd_timecode(0x00000000) == "00:00:00:00"


def test_bcd_timecode_drop_frame_flag():
    # Bit 6 of the frames byte marks drop-frame → ';' separator.
    assert parse_bcd_timecode(0x01000000 | 0x40 | 0x02) == "01:00:00;02"


def test_bcd_timecode_invalid_digit():
    with pytest.raises(ValueError, match="invalid BCD"):
        parse_bcd_timecode(0x0000000F)  # units nibble 0xF is not a BCD digit
