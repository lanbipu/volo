"""VP-QSP per-cabinet marker layout + local-mm geometry (single source of truth).

Both pattern generation (vpqsp_pattern) and reconstruct (the p_local lookup) call
`marker_center_px` / `marker_local_mm` here, so a decoded marker's nominal 3D
coordinate is guaranteed to match the pixel position it was actually rendered at.

Layout (MVP): a regular markers_x × markers_y grid filling each cabinet's LED
canvas; `local_id = marker_row * markers_x + marker_col` (row-major). Because each
marker carries a globally-unique self-encoded id, a regular grid is unambiguous —
the design doc's anti-regular-grid guidance targets plain dot matrices, not
self-coded markers. Blue-noise / multi-scale layout is a documented follow-up that
can replace these functions without touching the codec / detector / BA contract.

local-mm convention (MUST match screen_mapping.charuco_corner_local_mm): origin =
cabinet active-surface center, +x right, **+y up** (OpenCV board frame), z = 0,
millimetres. Feeding a y-down model to solvePnP recovers a chirally-mirrored pose,
so the +y-up sign is load-bearing.
"""

from __future__ import annotations

import numpy as np
from numpy.typing import NDArray

from lmt_vba_sidecar.vpqsp_codec import (
    GRID,
    MAX_LOCAL,
    _CENTER,
    _MARGIN_FRAC,
    code_to_cellgrid,
)

# A cabinet cannot host more markers than the 6-bit local_id can address; the grid
# is capped here so encode_marker never overflows at generation time (a wide/large
# cabinet otherwise produces local_id > MAX_LOCAL → ValueError → internal_error).
MAX_MARKERS_PER_CABINET = MAX_LOCAL + 1  # 64

# Marker-grid sizing. Anchor the marker count to the cabinet's SHORT side so a
# square cabinet gets TARGET_MARKERS_SHORT per side; the long side scales by
# aspect ratio. MIN_CELL_PX keeps each marker physically large enough to decode
# (a 9x9-effective marker needs ~6 px/cell). DEFAULT_MARKER_FILL is the fraction
# of each grid cell a marker fills; the (1 - fill) remainder is the dark gap that
# keeps adjacent (and seam-abutting) bright outlines from merging into one contour.
# 0.9 maximises screen utilisation — markers fill 90% of their cell vs the old
# 0.8 (the "~80% coverage" the operator saw) — while leaving (1-0.9)=10% of the
# cell as a gap: on the smallest supported cabinets (~106 px cells) that is still
# ~10 px of crisp dark between markers, comfortably above the 1 px findContours
# needs; on production cabinets (200-360 px cells) it is 20-36 px, robust to
# capture blur. Raising it further shrinks the seam gap toward merge territory.
#
# 6/side ≈ ChArUco's effective per-side marker density (squares_short 9 / √2 ≈ 6.4),
# restoring the observation margin VP-QSP loses by emitting one centroid per marker
# (vs ChArUco's ~64 inner corners): each cabinet gets >> the 8-observation
# observability floor, so per-view marker loss (occlusion/glare/incidence) keeps a
# healthy margin instead of sitting one bad decode above the floor.
TARGET_MARKERS_SHORT = 6
MIN_CELL_PX = 80
DEFAULT_MARKER_FILL = 0.9
MIN_MARKER_PX = 48  # absolute floor; below this the 7x7 panel is undecodable
_PANEL_BG = 40  # dark panel grey level (matches vpcal)


def choose_marker_grid(resolution_px: tuple[int, int]) -> tuple[int, int, int]:
    """Pick (markers_x, markers_y, marker_px) for one cabinet's LED canvas.

    Short-side anchoring with aspect-aware long-side rounding: tries short-side
    counts from TARGET_MARKERS_SHORT downward, computing the long-side count via
    round() (not floor) so cells stay as square as possible.  When a lower
    short-side count yields significantly squarer cells (>2 pp), it wins over a
    higher-count but skewed grid — the coverage gain from square cells outweighs
    the loss of a few markers.

    Square cabinets (typical LED walls) are unaffected: cell aspect is already
    1.0 at TARGET_MARKERS_SHORT.  The fix matters for wide/tall screens (16:9
    monitors etc.) where floor-dividing the long side produced non-square cells.
    """
    w_px, h_px = int(resolution_px[0]), int(resolution_px[1])
    short = min(w_px, h_px)
    long_ = max(w_px, h_px)
    is_landscape = w_px >= h_px

    best: tuple[int, int, float, int] | None = None  # (mx, my, squareness, count)

    for ms in range(TARGET_MARKERS_SHORT, 1, -1):  # ms >= 2: avoid collinear grid
        cell = short / ms
        if cell < MIN_CELL_PX:
            continue
        ml = max(2, round(long_ / cell))  # ml >= 2: avoid collinear grid
        if ms * ml > MAX_MARKERS_PER_CABINET:
            ml = MAX_MARKERS_PER_CABINET // ms
        if ml < 2 or long_ / ml < MIN_CELL_PX:
            continue

        mx = ml if is_landscape else ms
        my = ms if is_landscape else ml

        cell_w = w_px / mx
        cell_h = h_px / my
        sq = min(cell_w, cell_h) / max(cell_w, cell_h)
        count = mx * my

        if best is None or sq > best[2] + 0.02 or (
            sq >= best[2] - 0.005 and count > best[3]
        ):
            best = (mx, my, sq, count)

    if best is None:
        return 1, 1, max(MIN_MARKER_PX, int(round(DEFAULT_MARKER_FILL * min(w_px, h_px))))

    markers_x, markers_y = best[0], best[1]
    cell_w = w_px / markers_x
    cell_h = h_px / markers_y
    marker_px = max(MIN_MARKER_PX, int(round(DEFAULT_MARKER_FILL * min(cell_w, cell_h))))
    return markers_x, markers_y, marker_px


def marker_count(markers_x: int, markers_y: int) -> int:
    return int(markers_x) * int(markers_y)


def local_ids(markers_x: int, markers_y: int) -> range:
    """All valid local_ids for a markers_x × markers_y grid (row-major)."""
    return range(marker_count(markers_x, markers_y))


def marker_center_px(
    local_id: int, *, markers_x: int, markers_y: int, resolution_px: tuple[int, int]
) -> tuple[float, float]:
    """Pixel centre (cx, cy) of `local_id`'s marker on the cabinet canvas.

    Image convention: top-left origin, +y down. The marker sits at the centre of
    its grid cell. This is the SINGLE definition shared by generation and the
    p_local lookup.

    The grid is cell-CENTERED on purpose, not edge-anchored. With a uniform
    ``marker_px`` and seamless cabinet tiling (a real LED wall abuts cabinets
    pixel-to-pixel — no bezel gap in the framebuffer), the centred layout already
    places the outermost markers as close to each edge as detection allows: the
    outer margin equals half the inter-marker gap, so two cabinets meeting at a
    seam leave exactly one inter-marker gap between their edge markers. Pushing
    the centres any closer to the edge would make seam-adjacent markers' bright
    outlines merge into one contour and drop both from detection. Screen
    utilisation is therefore raised by enlarging the markers within each cell
    (``DEFAULT_MARKER_FILL``), not by moving their centres outward.
    """
    w_px, h_px = float(resolution_px[0]), float(resolution_px[1])
    mr, mc = divmod(int(local_id), int(markers_x))
    if not (0 <= mr < markers_y):
        raise ValueError(
            f"local_id {local_id} out of range for {markers_x}x{markers_y} grid"
        )
    cell_w = w_px / markers_x
    cell_h = h_px / markers_y
    cx = (mc + 0.5) * cell_w
    cy = (mr + 0.5) * cell_h
    return cx, cy


def marker_blit_origin_and_center_px(
    local_id: int,
    *,
    markers_x: int,
    markers_y: int,
    marker_px: int,
    resolution_px: tuple[int, int],
) -> tuple[int, int, float, float]:
    """(x0, y0, cx_actual, cy_actual): the integer blit origin the renderer uses
    AND the actual post-blit marker centre on the cabinet canvas.

    FIX-6 single source: the renderer blits the marker template at
    ``round(ideal_center) - marker_px // 2``, which quantises the centre by up
    to 0.5px (round) plus a constant +0.5px for ODD marker_px (integer-floor
    half-size) — up to ~0.83px combined, i.e. 0.5–1.6mm of systematic nominal
    error at LED pitches. Both the renderer and the local-mm lookup derive from
    THIS function, so rendered position and nominal coordinate agree exactly
    (the rendering itself is unchanged)."""
    cx, cy = marker_center_px(
        local_id, markers_x=markers_x, markers_y=markers_y, resolution_px=resolution_px
    )
    x0 = int(round(cx)) - int(marker_px) // 2
    y0 = int(round(cy)) - int(marker_px) // 2
    return x0, y0, x0 + marker_px / 2.0, y0 + marker_px / 2.0


def marker_local_mm(
    local_id: int,
    *,
    markers_x: int,
    markers_y: int,
    marker_px: int,
    resolution_px: tuple[int, int],
    pixel_pitch_mm: tuple[float, float],
) -> np.ndarray:
    """Local-mm [x, y, 0] of `local_id`'s ACTUAL (post-blit) marker centre,
    center origin, +y up.

    Identical convention to screen_mapping.charuco_corner_local_mm: subtract half
    the canvas to move edge-origin → center, scale by the cabinet's own pitch, and
    flip y so larger pixel-y (lower on the displayed pattern) → smaller local y.
    FIX-6: the centre is the blit-quantised one the renderer actually painted
    (marker_blit_origin_and_center_px), not the ideal grid-cell centre.
    """
    _x0, _y0, cx, cy = marker_blit_origin_and_center_px(
        local_id, markers_x=markers_x, markers_y=markers_y,
        marker_px=marker_px, resolution_px=resolution_px
    )
    w_px, h_px = float(resolution_px[0]), float(resolution_px[1])
    pitch_x, pitch_y = float(pixel_pitch_mm[0]), float(pixel_pitch_mm[1])
    x_mm = (cx - w_px / 2.0) * pitch_x
    y_mm = (h_px / 2.0 - cy) * pitch_y
    return np.array([x_mm, y_mm, 0.0], dtype=float)


def splat_gaussian_dot(
    img: NDArray[np.uint8], cx: float, cy: float, sigma: float, peak: int = 255
) -> None:
    """Add a bright isotropic Gaussian dot centred at (cx, cy) (in place).

    Ported from vpcal: the locator dot the detector's centroid locks onto. An
    analytic Gaussian recovers a clean sub-pixel centroid and is robust to mild
    defocus / LED bloom.
    """
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


def build_marker_template(
    code: int, size_px: int, *, bake_dot: bool = True
) -> NDArray[np.uint8]:
    """Render the canonical (fronto-parallel) VP-QSP marker image for a code.

    Bright square outline → dark panel → 7x7 bright/dark cells → dark centre well
    with a baked Gaussian locator dot (ported from vpcal build_marker_template,
    GRID=7 + 3x3 centre well). `bake_dot=True` for LED-facing patterns.
    """
    img = np.full((size_px, size_px), 255, dtype=np.uint8)  # bright outline
    m = int(round(size_px * _MARGIN_FRAC))
    panel = slice(m, size_px - m)
    img[panel, panel] = _PANEL_BG  # dark panel
    grid = code_to_cellgrid(code)
    panel_size = size_px - 2 * m
    cell = panel_size / GRID
    pad = cell * 0.12
    for r in range(GRID):
        for c in range(GRID):
            if (r, c) in _CENTER:
                continue  # centre well stays dark (holds the locator dot)
            if not grid[r, c]:
                continue  # dark cell == panel background
            y0 = int(round(m + r * cell + pad))
            y1 = int(round(m + (r + 1) * cell - pad))
            x0 = int(round(m + c * cell + pad))
            x1 = int(round(m + (c + 1) * cell - pad))
            img[y0:y1, x0:x1] = 255
    if bake_dot:
        splat_gaussian_dot(img, size_px / 2.0, size_px / 2.0, sigma=panel_size * 0.045, peak=255)
    return img


def render_cabinet_tile(
    *,
    screen_id_code: int,
    col: int,
    row: int,
    markers_x: int,
    markers_y: int,
    marker_px: int,
    resolution_px: tuple[int, int],
) -> NDArray[np.uint8]:
    """Render one cabinet's full VP-QSP tile at exactly resolution_px.

    Each marker encodes (screen_id_code, col, row, local_id) and is centred at its
    grid cell via marker_center_px — the same function the p_local lookup uses, so
    rendered position and reconstructed nominal coordinate agree by construction.
    """
    from lmt_vba_sidecar.vpqsp_codec import VpqspMarkerId, encode_marker

    w_px, h_px = int(resolution_px[0]), int(resolution_px[1])
    img = np.zeros((h_px, w_px), dtype=np.uint8)
    for lid in local_ids(markers_x, markers_y):
        code = encode_marker(VpqspMarkerId(screen_id_code, col, row, lid))
        tmpl = build_marker_template(code, marker_px, bake_dot=True)
        x0, y0, _cx, _cy = marker_blit_origin_and_center_px(
            lid, markers_x=markers_x, markers_y=markers_y,
            marker_px=marker_px, resolution_px=resolution_px
        )
        x1, y1 = x0 + marker_px, y0 + marker_px
        sx0, sy0 = max(0, -x0), max(0, -y0)
        x0c, y0c = max(0, x0), max(0, y0)
        x1c, y1c = min(w_px, x1), min(h_px, y1)
        if x1c <= x0c or y1c <= y0c:
            continue
        img[y0c:y1c, x0c:x1c] = np.maximum(
            img[y0c:y1c, x0c:x1c], tmpl[sy0 : sy0 + (y1c - y0c), sx0 : sx0 + (x1c - x0c)]
        )
    return img
