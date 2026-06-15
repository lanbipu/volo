"""VP-QSP marker encoding + pattern generation.

Encoding: a 32-bit self-encoding address compatible with LED Mesh Toolkit.
  payload  24-bit = screen_id(4) | cab_col(7) | cab_row(7) | local_id(6)
  codeword 32-bit = payload << 8 | CRC-8

  CRC = CRC-8/AUTOSAR (poly 0x2F, init 0xFF, xorout 0xFF, no reflection) over
  the 3-byte big-endian payload.  Detection-only: a marker whose CRC fails is
  discarded, never corrected.

Visual structure: a bright square outline enclosing a dark 7×7 cell panel;
the 4 grid corners encode orientation (TL/TR/BL on, BR off), the central 3×3
well holds a Gaussian locator dot for sub-pixel centring.  36 data cells carry
the 32-bit codeword (4 pad cells stay 0).
"""

from __future__ import annotations

import numpy as np
from numpy.typing import NDArray

from vpcal.core.observations import MarkerId

# ── CRC-8/AUTOSAR ────────────────────────────────────────────────────

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


# ── 32-bit VP-QSP self-encoding address ─────────────────────────────

SCREEN_BITS, COL_BITS, ROW_BITS, LOCAL_BITS = 4, 7, 7, 6
_PAYLOAD_BITS = SCREEN_BITS + COL_BITS + ROW_BITS + LOCAL_BITS  # 24
_PAYLOAD_BYTES = 3
CRC_BITS = 8
CODE_BITS = _PAYLOAD_BITS + CRC_BITS  # 32

MAX_SCREEN = (1 << SCREEN_BITS) - 1  # 15
MAX_COL = (1 << COL_BITS) - 1  # 127
MAX_ROW = (1 << ROW_BITS) - 1  # 127
MAX_LOCAL = (1 << LOCAL_BITS) - 1  # 63

_SHIFT_LOCAL = 0
_SHIFT_ROW = LOCAL_BITS
_SHIFT_COL = LOCAL_BITS + ROW_BITS
_SHIFT_SCREEN = LOCAL_BITS + ROW_BITS + COL_BITS


def _payload_bytes_be(payload: int) -> bytes:
    return bytes(
        (payload >> (8 * (_PAYLOAD_BYTES - 1 - i))) & 0xFF for i in range(_PAYLOAD_BYTES)
    )


def encode_marker(marker: MarkerId) -> int:
    """Encode a :class:`MarkerId` into a 32-bit code (payload << 8 | crc)."""
    if not (
        0 <= marker.screen_id <= MAX_SCREEN
        and 0 <= marker.cab_col <= MAX_COL
        and 0 <= marker.cab_row <= MAX_ROW
        and 0 <= marker.local_id <= MAX_LOCAL
    ):
        raise ValueError(f"marker id out of {_PAYLOAD_BITS}-bit range: {marker}")
    payload = (
        (marker.screen_id << _SHIFT_SCREEN)
        | (marker.cab_col << _SHIFT_COL)
        | (marker.cab_row << _SHIFT_ROW)
        | (marker.local_id << _SHIFT_LOCAL)
    )
    crc = crc8_autosar(_payload_bytes_be(payload))
    return (payload << CRC_BITS) | crc


def decode_marker(code: int) -> MarkerId | None:
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
    return MarkerId(screen_id, col, row, local_id)


def code_to_bits(code: int) -> list[int]:
    """32-bit code → list of 32 bits, MSB first."""
    return [(code >> (CODE_BITS - 1 - i)) & 1 for i in range(CODE_BITS)]


def bits_to_code(bits: list[int]) -> int:
    """List of 32 bits (MSB first) → integer code."""
    code = 0
    for b in bits:
        code = (code << 1) | (b & 1)
    return code


# ── Cell layout (7×7 data grid) ─────────────────────────────────────

GRID = 7
_LAST = GRID - 1
_CORNERS = {(0, 0), (0, _LAST), (_LAST, 0), (_LAST, _LAST)}
_CENTER = {(r, c) for r in (2, 3, 4) for c in (2, 3, 4)}
_CORNER_PATTERN = {(0, 0): 1, (0, _LAST): 1, (_LAST, 0): 1, (_LAST, _LAST): 0}


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
    """Build the 7×7 cell value grid (0/1) for a code (corners + data + well)."""
    grid = np.zeros((GRID, GRID), dtype=int)
    for (r, c), v in _CORNER_PATTERN.items():
        grid[r, c] = v
    bits = code_to_bits(code)
    for i, (r, c) in enumerate(_DATA_CELLS):
        grid[r, c] = bits[i] if i < len(bits) else 0
    return grid


def cellgrid_to_code(grid: NDArray[np.int_]) -> int:
    """Read the 32-bit code back from a 7×7 cell value grid."""
    bits = [int(grid[r, c]) for (r, c) in _DATA_CELLS[:CODE_BITS]]
    return bits_to_code(bits)


def orientation_ok(grid: NDArray[np.int_]) -> bool:
    """True if the corner orientation pattern matches the canonical layout."""
    return all(int(grid[r, c]) == v for (r, c), v in _CORNER_PATTERN.items())


# ── Marker template rendering ────────────────────────────────────────

_MARGIN_FRAC = 0.14
_PANEL_BG = 40


def build_marker_template(code: int, size_px: int = 96, *, bake_dot: bool = False) -> NDArray[np.uint8]:
    """Render the canonical (fronto-parallel) marker image for a code.

    Bright square outline → dark panel → 7×7 bright/dark cells → dark centre
    well.  With ``bake_dot`` a bright Gaussian locator dot is drawn in the well
    (used for LED-facing patterns); the simulator instead splats an analytic dot
    at the projected centre for sub-pixel accuracy.
    """
    img = np.full((size_px, size_px), 255, dtype=np.uint8)
    m = int(round(size_px * _MARGIN_FRAC))
    panel = slice(m, size_px - m)
    img[panel, panel] = _PANEL_BG
    grid = code_to_cellgrid(code)
    panel_size = size_px - 2 * m
    cell = panel_size / GRID
    pad = cell * 0.12
    for r in range(GRID):
        for c in range(GRID):
            if (r, c) in _CENTER:
                continue
            value = 255 if grid[r, c] else _PANEL_BG
            if value == _PANEL_BG:
                continue
            y0 = int(round(m + r * cell + pad))
            y1 = int(round(m + (r + 1) * cell - pad))
            x0 = int(round(m + c * cell + pad))
            x1 = int(round(m + (c + 1) * cell - pad))
            img[y0:y1, x0:x1] = 255
    if bake_dot:
        splat_gaussian_dot(img, size_px / 2.0, size_px / 2.0, sigma=panel_size * 0.045, peak=255)
    return img


def generate_pattern_images(
    screen,
    out_dir,
    *,
    markers_per_cabinet: int,
    max_dim: int = 8192,
    screen_id: int = 0,
    cab_col_offset: int = 0,
) -> dict:
    """Render LED-facing ``normal``/``inverted`` patterns per section.

    Each section is rendered at its native LED resolution (``extent_mm /
    pixel_pitch_mm``), capped at ``max_dim``.
    """
    import cv2

    from vpcal.core.screen_geometry import enumerate_markers, uv_to_pattern_pixel
    from pathlib import Path

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    pitch = screen.led_pixel_pitch_mm
    markers = enumerate_markers(
        screen, markers_per_cabinet=markers_per_cabinet,
        screen_id=screen_id, cab_col_offset=cab_col_offset,
    )
    by_section: dict[str, list] = {}
    for m in markers:
        by_section.setdefault(m.section_name, []).append(m)

    written: list[str] = []
    warnings: list[str] = []
    single = len(screen.sections) == 1
    for section in screen.sections:
        w = int(round(section.u_extent_mm() / pitch))
        h = int(round(section.v_extent_mm() / pitch))
        scale = 1.0
        if max(w, h) > max_dim:
            scale = max_dim / max(w, h)
            warnings.append(f"section '{section.name}' downscaled (×{scale:.3f}); 1:1 mapping broken")
        w = max(1, int(w * scale))
        h = max(1, int(h * scale))
        img = np.zeros((h, w), dtype=np.uint8)
        from vpcal.core.simulator import marker_size_mm

        marker_px = max(24, int(round(marker_size_mm(screen, markers_per_cabinet) / pitch * scale)))
        for m in by_section.get(section.name, []):
            tmpl = build_marker_template(encode_marker(m.marker_id), marker_px, bake_dot=False)
            # Exact fractional dot position (pixel-centre convention shared with
            # the marker world map); the template body may sit on the nearest
            # integer pixel — only the locator dot carries sub-pixel meaning.
            fx, fy = uv_to_pattern_pixel(m.u, m.v, w, h)
            cx, cy = int(round(fx)), int(round(fy))
            x0, y0 = cx - marker_px // 2, cy - marker_px // 2
            x1, y1 = x0 + marker_px, y0 + marker_px
            sx0, sy0 = max(0, -x0), max(0, -y0)
            x0, y0 = max(0, x0), max(0, y0)
            x1, y1 = min(w, x1), min(h, y1)
            if x1 <= x0 or y1 <= y0:
                continue
            img[y0:y1, x0:x1] = np.maximum(img[y0:y1, x0:x1], tmpl[sy0:sy0 + (y1 - y0), sx0:sx0 + (x1 - x0)])
            panel_px = marker_px - 2 * int(round(marker_px * _MARGIN_FRAC))
            splat_gaussian_dot(img, fx, fy, sigma=panel_px * 0.045, peak=255)
        suffix = "" if single else f"_{section.name}"
        normal_path = out / f"normal{suffix}.png"
        inverted_path = out / f"inverted{suffix}.png"
        cv2.imwrite(str(normal_path), img)
        cv2.imwrite(str(inverted_path), 255 - img)
        written.extend([str(normal_path), str(inverted_path)])
    return {"files": written, "warnings": warnings, "num_markers": len(markers)}


def splat_gaussian_dot(
    img: NDArray[np.uint8], cx: float, cy: float, sigma: float, peak: int = 255
) -> None:
    """Add a bright isotropic Gaussian dot centred at ``(cx, cy)`` (in place)."""
    win = int(np.ceil(sigma * 4))
    x0 = max(0, int(round(cx)) - win)
    x1 = min(img.shape[1], int(round(cx)) + win + 1)
    y0 = max(0, int(round(cy)) - win)
    y1 = min(img.shape[0], int(round(cy)) + win + 1)
    if x1 <= x0 or y1 <= y0:
        return
    ys, xs = np.mgrid[y0:y1, x0:x1]
    g = peak * np.exp(-((xs - cx) ** 2 + (ys - cy) ** 2) / (2.0 * sigma * sigma))
    region = img[y0:y1, x0:x1].astype(np.float64)
    img[y0:y1, x0:x1] = np.clip(np.maximum(region, g), 0, 255).astype(np.uint8)
