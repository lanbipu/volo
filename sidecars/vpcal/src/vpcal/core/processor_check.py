"""LED-processor canvas mapping verification (remediation C0).

A real LED wall sits behind a processor (Brompton / Megapixel / Nova) that may
scale or offset the input canvas before it reaches the physical LED grid.  Any
such scale/offset makes the marker 3D lookup wrong, and Phase 1 had no way to
detect it.  This module:

  * fits the input→physical affine mapping from fiducial correspondences,
  * verifies a claimed 1:1 mapping (flagging e.g. a 1-px canvas offset),
  * sanity-checks a declared :class:`ProcessorCanvas` against the screen's
    physical pixel dimensions.

The math core consumes 2-D correspondences ``(expected_px, observed_px)``.  On a
real wall the ``observed_px`` come from detecting a known-fiducial test pattern
and mapping detections back to the screen plane via the solved camera homography
(deferred — needs a real capture); the verifier here is what consumes them.

NOTE: a *uniform* scale of a flat screen trades off with camera distance and is
unobservable from a single view without an independent physical reference; an
*offset* and a *non-uniform* (aspect) scale ARE observable.  Supply correspondences
already in the physical-pixel domain (e.g. via the known screen geometry) so the
absolute scale is anchored.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

from vpcal.models.screen import ProcessorCanvas, ScreenDefinition

DEFAULT_SCALE_TOL = 1e-3       # 0.1%
DEFAULT_OFFSET_TOL_PX = 0.5    # half a pixel


@dataclass
class CanvasMapping:
    """Affine input→physical mapping, per axis: physical = input·scale + offset."""

    scale_x: float
    scale_y: float
    offset_x_px: float
    offset_y_px: float

    def is_one_to_one(self, *, scale_tol: float = DEFAULT_SCALE_TOL,
                      offset_tol_px: float = DEFAULT_OFFSET_TOL_PX) -> bool:
        return (abs(self.scale_x - 1.0) <= scale_tol
                and abs(self.scale_y - 1.0) <= scale_tol
                and abs(self.offset_x_px) <= offset_tol_px
                and abs(self.offset_y_px) <= offset_tol_px)


def _fit_axis(expected: NDArray, observed: NDArray) -> tuple[float, float]:
    """Least-squares (scale, offset) for observed ≈ scale·expected + offset."""
    A = np.column_stack([expected, np.ones_like(expected)])
    (scale, offset), *_ = np.linalg.lstsq(A, observed, rcond=None)
    return float(scale), float(offset)


def fit_canvas_mapping(expected_px: NDArray, observed_px: NDArray) -> CanvasMapping:
    """Fit the per-axis affine canvas mapping from N≥2 fiducial correspondences."""
    expected = np.asarray(expected_px, dtype=np.float64).reshape(-1, 2)
    observed = np.asarray(observed_px, dtype=np.float64).reshape(-1, 2)
    if len(expected) < 2 or len(expected) != len(observed):
        raise ValueError("need >= 2 matched (expected, observed) fiducials")
    # Each axis needs spread in the EXPECTED fiducials to separate scale from
    # offset; a single row/column is rank-deficient and would mis-attribute them.
    if np.ptp(expected[:, 0]) < 1e-6 or np.ptp(expected[:, 1]) < 1e-6:
        raise ValueError("fiducials are collinear on an axis; need spread in both x and y")
    sx, ox = _fit_axis(expected[:, 0], observed[:, 0])
    sy, oy = _fit_axis(expected[:, 1], observed[:, 1])
    return CanvasMapping(sx, sy, ox, oy)


def verify_one_to_one(
    expected_px: NDArray,
    observed_px: NDArray,
    *,
    scale_tol: float = DEFAULT_SCALE_TOL,
    offset_tol_px: float = DEFAULT_OFFSET_TOL_PX,
) -> tuple[bool, CanvasMapping]:
    """Verify the captured canvas is 1:1; return ``(ok, measured_mapping)``."""
    mapping = fit_canvas_mapping(expected_px, observed_px)
    return mapping.is_one_to_one(scale_tol=scale_tol, offset_tol_px=offset_tol_px), mapping


def screen_physical_pixels(screen: ScreenDefinition) -> tuple[int, int]:
    """(width, height) physical LED pixels of the wall from section extents.

    Width = Σ section horizontal extents / pitch (sections tiled horizontally);
    height = max section vertical extent / pitch.  An approximation for complex
    multi-section walls — exact for the common single-section case.
    """
    pitch = screen.led_pixel_pitch_mm
    w = sum(s.u_extent_mm() for s in screen.sections) / pitch
    h = max(s.v_extent_mm() for s in screen.sections) / pitch
    return int(round(w)), int(round(h))


def check_screen_consistency(screen: ScreenDefinition) -> list[str]:
    """Sanity-check a screen's declared processor canvas; return issue strings.

    Empty list ⇒ no processor declared (assumed 1:1) or the declared mapping is
    self-consistent.  Non-empty ⇒ surface in the validate stage (C0).
    """
    proc: ProcessorCanvas | None = screen.processor
    if proc is None:
        return []
    issues: list[str] = []
    mapping = CanvasMapping(proc.scale_x, proc.scale_y, proc.offset_x_px, proc.offset_y_px)
    if not mapping.is_one_to_one():
        issues.append(
            f"processor canvas mapping is NOT 1:1 (scale {proc.scale_x:.4f}/{proc.scale_y:.4f}, "
            f"offset {proc.offset_x_px:.2f}/{proc.offset_y_px:.2f} px) — pattern generation assumes "
            "a direct 1:1 canvas; markers will be mis-placed until this is corrected"
        )
    # input·scale + offset should reproduce the wall's physical pixel dims.
    phys_w, phys_h = screen_physical_pixels(screen)
    pred_w = proc.input_width_px * proc.scale_x + proc.offset_x_px
    pred_h = proc.input_height_px * proc.scale_y + proc.offset_y_px
    if abs(pred_w - phys_w) > 1.0 or abs(pred_h - phys_h) > 1.0:
        issues.append(
            f"processor input {proc.input_width_px}×{proc.input_height_px} px under the declared "
            f"mapping yields {pred_w:.1f}×{pred_h:.1f} px, but the wall geometry is "
            f"{phys_w}×{phys_h} physical px — canvas config and screen geometry disagree"
        )
    return issues
