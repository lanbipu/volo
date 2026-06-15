"""VP-QSP encoding + CRC-8 tests."""

from __future__ import annotations

import numpy as np
import pytest

from vpcal.core.observations import MarkerId
from vpcal.core.pattern import (
    CODE_BITS,
    MAX_COL,
    MAX_LOCAL,
    MAX_ROW,
    MAX_SCREEN,
    cellgrid_to_code,
    code_to_cellgrid,
    crc8_autosar,
    decode_marker,
    encode_marker,
    orientation_ok,
)


def test_crc8_autosar_check_value():
    assert crc8_autosar(b"123456789") == 0xDF


def test_encode_decode_roundtrip_exhaustive():
    rng = np.random.default_rng(0)
    for _ in range(3000):
        m = MarkerId(
            int(rng.integers(0, MAX_SCREEN + 1)),
            int(rng.integers(0, MAX_COL + 1)),
            int(rng.integers(0, MAX_ROW + 1)),
            int(rng.integers(0, MAX_LOCAL + 1)),
        )
        assert decode_marker(encode_marker(m)) == m


def test_encode_extremes():
    for m in [MarkerId(0, 0, 0, 0), MarkerId(MAX_SCREEN, MAX_COL, MAX_ROW, MAX_LOCAL)]:
        assert decode_marker(encode_marker(m)) == m


def test_crc_rejects_single_bit_errors():
    code = encode_marker(MarkerId(0, 12, 5, 1))
    rejected = 0
    for bit in range(CODE_BITS):
        if decode_marker(code ^ (1 << bit)) is None:
            rejected += 1
    assert rejected == CODE_BITS


def test_cellgrid_roundtrip_and_orientation():
    code = encode_marker(MarkerId(0, 33, 17, 2))
    grid = code_to_cellgrid(code)
    assert orientation_ok(grid)
    assert cellgrid_to_code(grid) == code


def test_encode_out_of_range():
    with pytest.raises(ValueError):
        encode_marker(MarkerId(MAX_SCREEN + 1, 0, 0, 0))
    with pytest.raises(ValueError):
        encode_marker(MarkerId(0, MAX_COL + 1, 0, 0))
    with pytest.raises(ValueError):
        encode_marker(MarkerId(0, 0, MAX_ROW + 1, 0))
    with pytest.raises(ValueError):
        encode_marker(MarkerId(0, 0, 0, MAX_LOCAL + 1))
