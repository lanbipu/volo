"""VP-QSP marker codec: CRC, 32-bit round-trip, capacity guards, cell grid."""
from __future__ import annotations

import numpy as np
import pytest

from lmt_vba_sidecar import vpqsp_codec as vc
from lmt_vba_sidecar.vpqsp_codec import (
    CODE_BITS,
    MAX_COL,
    MAX_LOCAL,
    MAX_ROW,
    MAX_SCREEN,
    VpqspMarkerId,
    cellgrid_to_code,
    code_to_cellgrid,
    crc8_autosar,
    decode_marker,
    encode_marker,
    orientation_ok,
)


def test_crc8_autosar_check_value():
    # Canonical CRC-8/AUTOSAR check value (ported verbatim from vpcal VP-QCP).
    assert crc8_autosar(b"123456789") == 0xDF


def test_cell_layout_dimensions():
    # 7x7 grid, 4 corners + 9 centre-well cells reserved, 36 data cells, 32-bit code.
    assert vc.GRID == 7
    assert len(vc._DATA_CELLS) == 36
    assert CODE_BITS == 32
    assert len(vc._DATA_CELLS) - CODE_BITS == 4  # spare pad cells


@pytest.mark.parametrize(
    "s",
    [
        (0, 0, 0, 0),
        (MAX_SCREEN, MAX_COL, MAX_ROW, MAX_LOCAL),
        (5, 100, 33, 17),
        (1, 1, 1, 1),
    ],
)
def test_encode_decode_roundtrip(s):
    m = VpqspMarkerId(*s)
    code = encode_marker(m)
    assert 0 <= code < (1 << 32)
    assert decode_marker(code) == m


def test_roundtrip_random_sweep():
    rng = np.random.default_rng(7)
    for _ in range(3000):
        m = VpqspMarkerId(
            int(rng.integers(0, MAX_SCREEN + 1)),
            int(rng.integers(0, MAX_COL + 1)),
            int(rng.integers(0, MAX_ROW + 1)),
            int(rng.integers(0, MAX_LOCAL + 1)),
        )
        assert decode_marker(encode_marker(m)) == m


@pytest.mark.parametrize(
    "s",
    [
        (MAX_SCREEN + 1, 0, 0, 0),
        (0, MAX_COL + 1, 0, 0),
        (0, 0, MAX_ROW + 1, 0),
        (0, 0, 0, MAX_LOCAL + 1),
        (-1, 0, 0, 0),
    ],
)
def test_encode_out_of_range_raises(s):
    with pytest.raises(ValueError):
        encode_marker(VpqspMarkerId(*s))


def test_crc_rejects_all_single_bit_flips():
    rng = np.random.default_rng(3)
    for _ in range(300):
        m = VpqspMarkerId(
            int(rng.integers(0, MAX_SCREEN + 1)),
            int(rng.integers(0, MAX_COL + 1)),
            int(rng.integers(0, MAX_ROW + 1)),
            int(rng.integers(0, MAX_LOCAL + 1)),
        )
        code = encode_marker(m)
        for bit in range(32):
            # CRC-8 detects every single-bit error in a <= 255-bit message.
            assert decode_marker(code ^ (1 << bit)) is None


def test_cellgrid_roundtrip_and_orientation_unique():
    m = VpqspMarkerId(3, 100, 33, 17)
    code = encode_marker(m)
    grid = code_to_cellgrid(code)
    assert orientation_ok(grid)
    assert cellgrid_to_code(grid) == code
    # Exactly one of the four 90-degree rotations passes the orientation gate.
    n_ok = sum(orientation_ok(np.rot90(grid, k)) for k in range(4))
    assert n_ok == 1


def test_capacity_exceeds_charuco_ceiling():
    # The whole point: VP-QSP addresses far more cabinets than ChArUco's ~13.
    addressable_cabinets = (MAX_COL + 1) * (MAX_ROW + 1)
    assert addressable_cabinets >= 2000
    assert MAX_SCREEN + 1 >= 8  # multi-screen Volume support
