"""VP-QSP (Virtual Production Quick Screen Pattern) marker codec.

Self-encoding marker that replaces ChArUco for lmt's fast screen-fit pipeline.
Unlike ChArUco — which shares one 1000-marker dictionary across all cabinets and
caps at ~13 cabinets — every VP-QSP marker encodes WHICH cabinet it belongs to
plus its in-cabinet position, so the addressable count is bounded only by the
payload width, not a global dictionary.

Encoding (see docs/VP-QSP-quick-screen-fit-design.md §2):
  payload  24-bit = screen_id(4) | cab_col(7) | cab_row(7) | local_id(6)
  codeword 32-bit = payload << 8 | CRC-8

  CRC = CRC-8/AUTOSAR (poly 0x2F, init 0xFF, xorout 0xFF, no reflection) over the
  3-byte big-endian payload. Detection-only: a marker whose CRC fails is
  discarded, never corrected (ported verbatim from vpcal VP-QCP).

Visual structure (§2.3): a bright square outline enclosing a dark 7x7 cell panel;
the 4 grid corners encode orientation (TL/TR/BL on, BR off), the central 3x3 well
holds a Gaussian locator dot for sub-pixel centring. 36 data cells carry the
32-bit codeword (4 pad cells stay 0).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

# ── CRC-8/AUTOSAR (ported verbatim from vpcal VP-QCP) ─────────────────

_CRC8_POLY = 0x2F
_CRC8_INIT = 0xFF
_CRC8_XOROUT = 0xFF


def crc8_autosar(data: bytes) -> int:
    """CRC-8/AUTOSAR (poly 0x2F, init 0xFF, no reflection, xorout 0xFF).

    Check value: ``crc8_autosar(b"123456789") == 0xDF``.
    """
    crc = _CRC8_INIT
    for byte in data:
        crc ^= byte
        for _ in range(8):
            if crc & 0x80:
                crc = ((crc << 1) ^ _CRC8_POLY) & 0xFF
            else:
                crc = (crc << 1) & 0xFF
    return crc ^ _CRC8_XOROUT


# ── 32-bit self-encoding address ─────────────────────────────────────

SCREEN_BITS, COL_BITS, ROW_BITS, LOCAL_BITS = 4, 7, 7, 6
_PAYLOAD_BITS = SCREEN_BITS + COL_BITS + ROW_BITS + LOCAL_BITS  # 24
_PAYLOAD_BYTES = (_PAYLOAD_BITS + 7) // 8  # 3
CRC_BITS = 8
CODE_BITS = _PAYLOAD_BITS + CRC_BITS  # 32

MAX_SCREEN = (1 << SCREEN_BITS) - 1  # 15
MAX_COL = (1 << COL_BITS) - 1  # 127
MAX_ROW = (1 << ROW_BITS) - 1  # 127
MAX_LOCAL = (1 << LOCAL_BITS) - 1  # 63

# Field shifts within the payload (MSB → LSB: screen | col | row | local).
_SHIFT_LOCAL = 0
_SHIFT_ROW = LOCAL_BITS
_SHIFT_COL = LOCAL_BITS + ROW_BITS
_SHIFT_SCREEN = LOCAL_BITS + ROW_BITS + COL_BITS


@dataclass(frozen=True)
class VpqspMarkerId:
    """A VP-QSP marker's full self-encoded identity.

    `screen_id` selects the screen within a Volume; `(col, row)` is the cabinet;
    `local_id` is the marker's index within that cabinet's marker grid
    (row-major: ``local_id = marker_row * markers_x + marker_col``).
    """

    screen_id: int
    col: int
    row: int
    local_id: int

    def to_dict(self) -> dict[str, int]:
        return {
            "screen_id": self.screen_id,
            "col": self.col,
            "row": self.row,
            "local_id": self.local_id,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "VpqspMarkerId":
        return cls(int(d["screen_id"]), int(d["col"]), int(d["row"]), int(d["local_id"]))


def _payload_bytes_be(payload: int) -> bytes:
    """3-byte big-endian serialization of the 24-bit payload (CRC input)."""
    return bytes(
        (payload >> (8 * (_PAYLOAD_BYTES - 1 - i))) & 0xFF for i in range(_PAYLOAD_BYTES)
    )


def encode_marker(marker: VpqspMarkerId) -> int:
    """Encode a :class:`VpqspMarkerId` into a 32-bit code (payload << 8 | crc)."""
    if not (
        0 <= marker.screen_id <= MAX_SCREEN
        and 0 <= marker.col <= MAX_COL
        and 0 <= marker.row <= MAX_ROW
        and 0 <= marker.local_id <= MAX_LOCAL
    ):
        raise ValueError(f"marker id out of {_PAYLOAD_BITS}-bit range: {marker}")
    payload = (
        (marker.screen_id << _SHIFT_SCREEN)
        | (marker.col << _SHIFT_COL)
        | (marker.row << _SHIFT_ROW)
        | (marker.local_id << _SHIFT_LOCAL)
    )
    crc = crc8_autosar(_payload_bytes_be(payload))
    return (payload << CRC_BITS) | crc


def decode_marker(code: int) -> VpqspMarkerId | None:
    """Decode a 32-bit code, returning ``None`` if the CRC fails."""
    code &= (1 << CODE_BITS) - 1
    payload = code >> CRC_BITS
    crc = code & ((1 << CRC_BITS) - 1)
    if crc8_autosar(_payload_bytes_be(payload)) != crc:
        return None
    screen_id = (payload >> _SHIFT_SCREEN) & MAX_SCREEN
    col = (payload >> _SHIFT_COL) & MAX_COL
    row = (payload >> _SHIFT_ROW) & MAX_ROW
    local_id = (payload >> _SHIFT_LOCAL) & MAX_LOCAL
    return VpqspMarkerId(screen_id, col, row, local_id)


def code_to_bits(code: int) -> list[int]:
    """32-bit code → list of 32 bits, MSB first."""
    return [(code >> (CODE_BITS - 1 - i)) & 1 for i in range(CODE_BITS)]


def bits_to_code(bits: list[int]) -> int:
    """List of 32 bits (MSB first) → integer code."""
    code = 0
    for b in bits:
        code = (code << 1) | (b & 1)
    return code


# ── Cell layout (7x7 data grid) ──────────────────────────────────────

GRID = 7
_LAST = GRID - 1
_CORNERS = {(0, 0), (0, _LAST), (_LAST, 0), (_LAST, _LAST)}
# Centre 3x3 well (holds the Gaussian locator dot); stays dark.
_CENTER = {(r, c) for r in (2, 3, 4) for c in (2, 3, 4)}
# Orientation pattern: three corners "on", the bottom-right corner "off"
# (TL/TR/BL = 1, BR = 0) — an asymmetric L that resolves the 4-way rotation.
_CORNER_PATTERN = {(0, 0): 1, (0, _LAST): 1, (_LAST, 0): 1, (_LAST, _LAST): 0}

# Bright outline margin as a fraction of template size (shared with detector
# cell sampling; matches vpcal's _MARGIN_FRAC convention).
_MARGIN_FRAC = 0.14


def _data_cell_order() -> list[tuple[int, int]]:
    """Row-major data-cell positions (excludes corners + centre well)."""
    return [
        (r, c)
        for r in range(GRID)
        for c in range(GRID)
        if (r, c) not in _CORNERS and (r, c) not in _CENTER
    ]


_DATA_CELLS = _data_cell_order()  # 36 cells; first 32 carry the code, rest pad 0


def code_to_cellgrid(code: int) -> NDArray[np.int_]:
    """Build the 7x7 cell value grid (0/1) for a code (corners + data + well)."""
    grid = np.zeros((GRID, GRID), dtype=int)
    for (r, c), v in _CORNER_PATTERN.items():
        grid[r, c] = v
    bits = code_to_bits(code)
    for i, (r, c) in enumerate(_DATA_CELLS):
        grid[r, c] = bits[i] if i < len(bits) else 0
    return grid


def cellgrid_to_code(grid: NDArray[np.int_]) -> int:
    """Read the 32-bit code back from a 7x7 cell value grid."""
    bits = [int(grid[r, c]) for (r, c) in _DATA_CELLS[:CODE_BITS]]
    return bits_to_code(bits)


def orientation_ok(grid: NDArray[np.int_]) -> bool:
    """True if the corner orientation pattern matches the canonical layout."""
    return all(int(grid[r, c]) == v for (r, c), v in _CORNER_PATTERN.items())
