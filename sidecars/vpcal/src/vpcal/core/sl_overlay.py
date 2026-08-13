"""Static validation overlay for structured-light fixed observations.

Renders measured dot centroids vs their reprojection through the solved
lens + pose — the eyes-on acceptance artifact (SL spec §9 ``static_overlay.png``)
written next to ``fixed_observation_result.json``. Reuses the verify-overlay
drawing conventions (green cross = measured, red circle = reprojected,
Pillow/CJK-capable label channel via ``overlay._draw_labels``); the legend
itself stays ASCII so the headless cv2 fallback never renders tofu.

Background: a capture frame when supplied AND its size matches the solve's
camera_image_size; otherwise a black canvas — resizing a mismatched frame
would silently falsify point geometry, so it is refused, not coerced.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

import cv2
import numpy as np

from vpcal.core.fixed_observation import Correspondence, FixedObservationResult
from vpcal.core.overlay import _GREEN, _RED, _draw_labels
from vpcal.core.sl_gates import _lens_K_dist


def render_sl_static_overlay(
    result: FixedObservationResult,
    correspondences: list[Correspondence],
    image_size: tuple[int, int],
    out_path: str,
    *,
    background_image: str | None = None,
    label_worst: int = 10,
) -> dict[str, Any]:
    """Write the overlay PNG; returns a summary block for result.validation."""
    w, h = int(image_size[0]), int(image_size[1])
    canvas = None
    background = "black"
    if background_image:
        img = cv2.imread(background_image, cv2.IMREAD_COLOR)
        if img is not None and (img.shape[1], img.shape[0]) == (w, h):
            canvas = img
            background = str(background_image)
        else:
            background = "black (background image missing or size-mismatched)"
    if canvas is None:
        canvas = np.zeros((h, w, 3), dtype=np.uint8)

    assert result.session_lens is not None
    K, dist = _lens_K_dist(result.session_lens)
    rvec = np.asarray(result.camera_from_stage["rvec"], dtype=np.float64).reshape(3, 1)
    tvec = np.asarray(result.camera_from_stage["tvec"], dtype=np.float64).reshape(3, 1)
    world = np.asarray([c.world_mm for c in correspondences], dtype=np.float64)
    measured = np.asarray([c.pixel_uv for c in correspondences], dtype=np.float64)
    proj, _ = cv2.projectPoints(world.reshape(-1, 1, 3), rvec, tvec, K, dist)
    proj = proj.reshape(-1, 2)
    err = np.linalg.norm(proj - measured, axis=1)

    for (mx, my), (px, py) in zip(measured, proj):
        mi = (int(round(mx)), int(round(my)))
        pi = (int(round(px)), int(round(py)))
        cv2.drawMarker(canvas, mi, _GREEN, cv2.MARKER_CROSS, 10, 1, cv2.LINE_AA)
        cv2.circle(canvas, pi, 6, _RED, 1, cv2.LINE_AA)
        cv2.line(canvas, mi, pi, (200, 200, 200), 1, cv2.LINE_AA)

    rms = float(np.sqrt(np.mean(err**2)))
    p95 = float(np.percentile(err, 95))
    labels: list[tuple[str, tuple[int, int], tuple[int, int, int]]] = []
    for i in np.argsort(err)[::-1][:label_worst]:
        x, y = measured[i]
        labels.append((f"{err[i]:.2f}px", (int(x) + 8, int(y) + 8), (80, 200, 255)))
    labels.append(
        (
            # Pure ASCII (no U+00B7): the headless cv2 fallback in
            # overlay._draw_labels only swaps the exact _LEGEND_CJK constant,
            # and Hershey fonts render any other non-ASCII char as "?".
            f"measured = green cross | reprojected = red circle | "
            f"RMS {rms:.2f}px | p95 {p95:.2f}px | n={len(err)}",
            (12, 12),
            (255, 255, 255),
        )
    )
    canvas = _draw_labels(canvas, labels)

    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    if not cv2.imwrite(str(out_path), canvas):
        raise OSError(f"failed to write static overlay: {out_path}")
    return {
        "path": str(out_path),
        "rms_px": rms,
        "p95_px": p95,
        "count": int(len(err)),
        "background": background,
    }
