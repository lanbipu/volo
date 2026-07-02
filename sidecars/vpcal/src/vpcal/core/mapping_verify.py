"""1:1 LED-processor canvas mapping verification pattern (architecture §3.3a, W9.1).

``processor_check.py`` already has the affine-fit math core
(``fit_canvas_mapping`` / ``verify_one_to_one``) but consumes correspondences
that "on a real wall ... come from detecting a known-fiducial test pattern"
(its own docstring, marked deferred). This module supplies that missing half:

  1. :func:`generate_mapping_pattern` renders a test image with 5 fiducials
     (4 corners + centre) at known ABSOLUTE pixel coordinates on the declared
     input canvas — reusing the VP-QSP marker codec (CRC-checked,
     sub-pixel-centred) so detection reuses the proven ``core.detector``
     pipeline instead of a new one-off fiducial format.
  2. :func:`verify_mapping_image` detects those fiducials in a captured image,
     matches them back to their known expected pixel positions, and feeds the
     correspondences into ``processor_check.verify_one_to_one``.  A mapping
     that is not 1:1 (or too few fiducials decoded to fit one) raises
     :class:`PreconditionError` with the measured scale/offset in ``details``.
"""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from vpcal.core.detector import detect_markers
from vpcal.core.errors import PreconditionError
from vpcal.core.observations import MarkerId
from vpcal.core.pattern import _MARGIN_FRAC, build_marker_template, encode_marker, splat_gaussian_dot
from vpcal.core.processor_check import (
    DEFAULT_OFFSET_TOL_PX,
    DEFAULT_SCALE_TOL,
    CanvasMapping,
    verify_one_to_one,
)

# Reserved VP-QSP screen_id for this pattern only (4-bit space, 0-15). The
# mapping-verify pattern is always captured standalone (never mixed with a
# real screen's calibration capture in the same image), so it cannot collide
# with a real screen's screen_id.
MAPPING_SCREEN_ID = 15
NUM_FIDUCIALS = 5  # 4 corners + centre
MIN_MATCHED_FIDUCIALS = 3  # need >= 2 per axis to fit scale+offset (processor_check)


def _marker_px(width: int, height: int) -> int:
    return max(48, int(round(min(width, height) * 0.06)))


def _margin_px(marker_px: int) -> float:
    return marker_px / 2.0 + 8.0


def _expected_points(width: int, height: int, margin: float) -> dict[int, tuple[float, float]]:
    """Deterministic absolute pixel positions for the 5 fiducials, keyed by local index."""
    return {
        0: (margin, margin),
        1: (width - 1 - margin, margin),
        2: (margin, height - 1 - margin),
        3: (width - 1 - margin, height - 1 - margin),
        4: (width / 2.0, height / 2.0),
    }


def generate_mapping_pattern(width: int, height: int, out_path: str | Path) -> dict:
    """Render the 1:1 mapping-verify pattern at the declared input canvas resolution.

    Writes a single grayscale PNG.  Returns a summary dict (fiducial positions
    are also re-derivable deterministically from ``width``/``height`` alone via
    the same formula ``verify_mapping_image`` uses — nothing needs to round-trip
    through a sidecar file).
    """
    if width <= 0 or height <= 0:
        raise ValueError(f"width/height must be positive, got {width}x{height}")
    marker_px = _marker_px(width, height)
    margin = _margin_px(marker_px)
    if width <= 2 * margin or height <= 2 * margin:
        raise ValueError(
            f"canvas {width}x{height} too small for a {marker_px}px fiducial "
            f"(margin {margin:.0f}px each side)"
        )
    points = _expected_points(width, height, margin)
    img = np.zeros((height, width), dtype=np.uint8)
    panel_px = marker_px - 2 * int(round(marker_px * _MARGIN_FRAC))
    for local_id, (fx, fy) in points.items():
        marker = MarkerId(screen_id=MAPPING_SCREEN_ID, cab_col=local_id, cab_row=0, local_id=0)
        tmpl = build_marker_template(encode_marker(marker), marker_px, bake_dot=False)
        cx, cy = int(round(fx)), int(round(fy))
        x0, y0 = cx - marker_px // 2, cy - marker_px // 2
        x1, y1 = x0 + marker_px, y0 + marker_px
        sx0, sy0 = max(0, -x0), max(0, -y0)
        x0c, y0c = max(0, x0), max(0, y0)
        x1c, y1c = min(width, x1), min(height, y1)
        if x1c > x0c and y1c > y0c:
            img[y0c:y1c, x0c:x1c] = np.maximum(
                img[y0c:y1c, x0c:x1c],
                tmpl[sy0:sy0 + (y1c - y0c), sx0:sx0 + (x1c - x0c)],
            )
        # Exact fractional dot position — only the locator dot needs sub-pixel
        # accuracy, matching pattern.generate_pattern_images's convention.
        splat_gaussian_dot(img, fx, fy, sigma=panel_px * 0.045, peak=255)
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(out), img)
    return {
        "width": width, "height": height, "marker_px": marker_px,
        "fiducials": {str(k): list(v) for k, v in points.items()},
        "path": str(out),
    }


def verify_mapping_image(
    image_path: str | Path,
    expected_width: int,
    expected_height: int,
    *,
    scale_tol: float = DEFAULT_SCALE_TOL,
    offset_tol_px: float = DEFAULT_OFFSET_TOL_PX,
) -> CanvasMapping:
    """Detect the mapping-verify fiducials in a captured image and verify 1:1.

    ``expected_width``/``expected_height`` is the input canvas resolution the
    pattern was generated at (``generate_mapping_pattern``'s ``width``/``height``).

    Raises :class:`PreconditionError` (exit 6) when: the image cannot be read;
    fewer than :data:`MIN_MATCHED_FIDUCIALS` fiducials decode (insufficient
    correspondences); or the fitted mapping is not 1:1 within tolerance — in
    the last two cases with the measured state in ``details`` for diagnosis.
    """
    img = cv2.imread(str(image_path), cv2.IMREAD_GRAYSCALE)
    if img is None:
        raise PreconditionError(
            f"could not read mapping-verify image: {image_path}",
            details={"image": str(image_path)},
        )
    marker_px = _marker_px(expected_width, expected_height)
    margin = _margin_px(marker_px)
    expected = _expected_points(expected_width, expected_height, margin)

    matched: dict[int, tuple[float, float]] = {}
    for d in detect_markers(img):
        marker_id = d.marker_id
        if getattr(marker_id, "screen_id", None) != MAPPING_SCREEN_ID:
            continue
        local = marker_id.cab_col
        if local in expected and local not in matched:
            matched[local] = (d.pixel_u, d.pixel_v)

    if len(matched) < MIN_MATCHED_FIDUCIALS:
        raise PreconditionError(
            f"only {len(matched)}/{NUM_FIDUCIALS} mapping-verify fiducials decoded "
            f"(need >= {MIN_MATCHED_FIDUCIALS} to fit scale+offset); check "
            "exposure/focus/framing and re-shoot",
            details={"matched": len(matched), "expected": NUM_FIDUCIALS},
        )

    ids = sorted(matched)
    expected_px = np.array([expected[i] for i in ids], dtype=np.float64)
    observed_px = np.array([matched[i] for i in ids], dtype=np.float64)
    try:
        ok, mapping = verify_one_to_one(
            expected_px, observed_px, scale_tol=scale_tol, offset_tol_px=offset_tol_px
        )
    except ValueError as exc:
        raise PreconditionError(
            f"mapping-verify fiducials are degenerate for an affine fit: {exc}",
            details={"matched": len(matched)},
        ) from None
    if not ok:
        raise PreconditionError(
            "LED processor canvas mapping is NOT 1:1 "
            f"(scale {mapping.scale_x:.4f}/{mapping.scale_y:.4f}, "
            f"offset {mapping.offset_x_px:.2f}/{mapping.offset_y_px:.2f} px) — "
            "marker 3D lookup will be wrong until the processor canvas is corrected",
            details={
                "scale_x": mapping.scale_x, "scale_y": mapping.scale_y,
                "offset_x_px": mapping.offset_x_px, "offset_y_px": mapping.offset_y_px,
                "matched_fiducials": len(matched),
            },
        )
    return mapping
