"""Controlled copy of vpcal's A2.2 sub-pixel centroid, for the W5 parity test.

Verbatim port of ``_subpixel_center`` from
sidecars/vpcal/src/vpcal/core/detector.py (as of 2026-07-02, lines 127-166),
renamed with a `vpcal_` prefix. This file exists ONLY to give
test_vpqsp_detection_bias.py an independent, byte-checkable reference to
compare mesh-vba's real (production) ``lmt_vba_sidecar.vpqsp_detect._subpixel_center``
against on an identical input — it must NOT be imported by any non-test module.
If vpcal's algorithm changes, re-sync this copy and update the date above.
"""
from __future__ import annotations

import cv2
import numpy as np
from numpy.typing import NDArray

GRID = 7
_MARGIN_FRAC = 0.14


def vpcal_diagonal_intersection(corners: NDArray[np.float64]) -> NDArray[np.float64]:
    tl, tr, br, bl = corners
    p, r = tl, br - tl
    q, s = tr, bl - tr
    denom = r[0] * s[1] - r[1] * s[0]
    if abs(denom) < 1e-12:
        return corners.mean(axis=0)
    t = ((q[0] - p[0]) * s[1] - (q[1] - p[1]) * s[0]) / denom
    return p + t * r


def vpcal_subpixel_center(
    gray: NDArray[np.float32], corners: NDArray[np.float64]
) -> tuple[float, float]:
    """vpcal detector.py::_subpixel_center, verbatim (return signature trimmed to
    (u, v) — vpcal's version returns only these two; mesh-vba's real
    implementation additionally returns a sigma_px this copy doesn't need)."""
    center = vpcal_diagonal_intersection(corners)
    side = np.mean([np.linalg.norm(corners[i] - corners[(i + 1) % 4]) for i in range(4)])
    cell = side * (1.0 - 2.0 * _MARGIN_FRAC) / GRID
    radius = max(3, int(round(cell)))
    cx, cy = float(center[0]), float(center[1])
    for _ in range(3):
        cx0, cy0 = int(round(cx)), int(round(cy))
        x0 = max(0, cx0 - radius)
        x1 = min(gray.shape[1], cx0 + radius + 1)
        y0 = max(0, cy0 - radius)
        y1 = min(gray.shape[0], cy0 + radius + 1)
        win = gray[y0:y1, x0:x1].astype(np.float64)
        if win.size == 0:
            break
        bg = float(np.median(win))
        peak = float(win.max())
        if peak <= bg:
            break
        mask = (win > bg + 0.3 * (peak - bg)).astype(np.uint8)
        n_lbl, labels = cv2.connectedComponents(mask)
        seed = labels[min(int(round(cy)) - y0, win.shape[0] - 1), min(int(round(cx)) - x0, win.shape[1] - 1)]
        if seed == 0:
            seed = labels[labels.shape[0] // 2, labels.shape[1] // 2]
        blob = labels == seed
        weights = np.where(blob, win - bg, 0.0)
        total = weights.sum()
        if total <= 0:
            break
        ys, xs = np.mgrid[y0:y1, x0:x1]
        cx = float((xs * weights).sum() / total)
        cy = float((ys * weights).sum() / total)
    return cx, cy
