"""VP-QSP marker detection pipeline.

Pipeline: optional normal−inverted differencing → threshold → quad contour
detection → perspective rectification → 7×7 cell sampling → 32-bit decode +
CRC-8 check → local topology consistency → Gaussian sub-pixel centring.

Camera I/O uses OpenCV (``cv2``); the sub-pixel centre is an intensity-weighted
centroid of the marker's central locator dot, which recovers a clean isotropic
dot to < 0.01 px on noiseless renders.

With an inverted frame, cell sampling and the sub-pixel centroid run on the
**signed** difference ``int16(normal) − int16(inverted)`` — ambient-light
gradients cancel exactly instead of biasing the intensity-weighted centroid
(remediation A2.2); a saturating ``cv2.subtract`` would clip the negative half.
When the global Otsu threshold yields too few detections, the detector retries
with a block-wise adaptive threshold (remediation A2.4).
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

import cv2
import numpy as np
from numpy.typing import NDArray

from vpcal.core.observations import Detection, MarkerId
from vpcal.core.pattern import (
    GRID,
    _MARGIN_FRAC,
    cellgrid_to_code,
    decode_marker,
    orientation_ok,
)

_CANON_CELL_PX = 12


@dataclass
class DetectorConfig:
    min_area_px: float = 200.0
    max_area_frac: float = 0.25
    approx_eps_frac: float = 0.04
    topology_neighbors: int = 6
    topology_max_residual_px: float = 8.0
    enable_topology: bool = True
    detect_fallback_min: int = 4
    # When set, topology uses the real cabinet sub-grid. When unset, treat each
    # marker as cabinet-centred — do not infer mpc from sparse local_ids.
    markers_per_cabinet: int | None = None


def common_markers_per_cabinet(values: Iterable[int]) -> int | None:
    """Return the shared mpc when all values agree; otherwise ``None``."""
    uniq = {int(v) for v in values}
    if len(uniq) == 1:
        return next(iter(uniq))
    return None


def detector_config_for_mpc(markers_per_cabinet: int | None) -> DetectorConfig:
    if markers_per_cabinet is None:
        return DetectorConfig()
    return DetectorConfig(markers_per_cabinet=int(markers_per_cabinet))


def _order_corners(pts: NDArray[np.float64]) -> NDArray[np.float64]:
    """Order 4 points as TL, TR, BR, BL (image convention, y down)."""
    pts = pts.reshape(4, 2).astype(np.float64)
    s = pts.sum(axis=1)
    d = np.diff(pts, axis=1).ravel()
    return np.array(
        [pts[np.argmin(s)], pts[np.argmin(d)], pts[np.argmax(s)], pts[np.argmax(d)]],
        dtype=np.float64,
    )


def _threshold(gray: NDArray[np.uint8]) -> NDArray[np.uint8]:
    blur = cv2.GaussianBlur(gray, (3, 3), 0)
    _, th = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return cv2.morphologyEx(th, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))


def _threshold_adaptive(gray: NDArray[np.uint8]) -> NDArray[np.uint8]:
    """Block-wise adaptive threshold — fallback when global Otsu fails (A2.4)."""
    blur = cv2.GaussianBlur(gray, (3, 3), 0)
    block = min(51, (min(gray.shape) // 2) * 2 + 1)  # odd, fits small images
    th = cv2.adaptiveThreshold(
        blur, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, block, -5
    )
    return cv2.morphologyEx(th, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))


def _sample_cellgrid(rect: NDArray[np.float32]) -> NDArray[np.int_]:
    """Sample the 7×7 cell value grid from a rectified marker panel image."""
    n = GRID * _CANON_CELL_PX
    margin = int(round(n * _MARGIN_FRAC))
    panel = rect[margin : n - margin, margin : n - margin]
    ps = panel.shape[0]
    cell = ps / GRID
    vals = np.zeros((GRID, GRID), dtype=np.float64)
    for r in range(GRID):
        for c in range(GRID):
            y0 = int(round(r * cell + cell * 0.25))
            y1 = int(round(r * cell + cell * 0.75))
            x0 = int(round(c * cell + cell * 0.25))
            x1 = int(round(c * cell + cell * 0.75))
            vals[r, c] = panel[y0:y1, x0:x1].mean()
    thresh = (vals.max() + vals.min()) / 2.0
    return (vals > thresh).astype(int)


def _decode_quad(sample_src: NDArray[np.float32], corners: NDArray[np.float64]) -> MarkerId | None:
    """Rectify a quad and decode its marker id over the 4 orientations.

    ``sample_src`` is the signed difference image when differencing is active
    (float32, may contain negatives), else the plain grayscale frame.
    """
    n = GRID * _CANON_CELL_PX
    dst = np.array([[0, 0], [n - 1, 0], [n - 1, n - 1], [0, n - 1]], dtype=np.float32)
    H = cv2.getPerspectiveTransform(corners.astype(np.float32), dst)
    rect = cv2.warpPerspective(sample_src, H, (n, n))
    grid = _sample_cellgrid(rect)
    for k in range(4):
        g = np.rot90(grid, k)
        if orientation_ok(g):
            marker = decode_marker(cellgrid_to_code(g))
            if marker is not None:
                return marker
    return None


def _diagonal_intersection(corners: NDArray[np.float64]) -> NDArray[np.float64]:
    """Intersection of the quad diagonals = projection of the square's centre."""
    tl, tr, br, bl = corners
    p, r = tl, br - tl
    q, s = tr, bl - tr
    denom = r[0] * s[1] - r[1] * s[0]
    if abs(denom) < 1e-12:
        return corners.mean(axis=0)
    t = ((q[0] - p[0]) * s[1] - (q[1] - p[1]) * s[0]) / denom
    return p + t * r


def _subpixel_center(
    gray: NDArray[np.float32], corners: NDArray[np.float64], *, radius_scale: float = 1.0
) -> tuple[float, float]:
    """Intensity-weighted centroid of the central locator dot.

    ``gray`` is the signed difference image when differencing is active —
    ambient gradients cancel there, keeping the centroid unbiased (A2.2).
    ``radius_scale`` multiplies the default locator window (used for
    multi-scale centroid stability checks).
    """
    center = _diagonal_intersection(corners)
    side = np.mean([np.linalg.norm(corners[i] - corners[(i + 1) % 4]) for i in range(4)])
    cell = side * (1.0 - 2.0 * _MARGIN_FRAC) / GRID
    radius = max(3, int(round(cell * radius_scale)))
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


def multi_scale_centroid_stable(
    gray: NDArray[np.float32],
    corners: NDArray[np.float64],
    *,
    scales: tuple[float, float] = (0.85, 1.25),
    max_delta_cells: float = 0.15,
) -> tuple[bool, float, tuple[float, float]]:
    """Require two window scales to agree within ``max_delta_cells`` locator cells."""
    side = np.mean([np.linalg.norm(corners[i] - corners[(i + 1) % 4]) for i in range(4)])
    cell = side * (1.0 - 2.0 * _MARGIN_FRAC) / GRID
    c0 = _subpixel_center(gray, corners, radius_scale=scales[0])
    c1 = _subpixel_center(gray, corners, radius_scale=scales[1])
    delta = float(np.hypot(c0[0] - c1[0], c0[1] - c1[1]))
    delta_cells = delta / max(cell, 1.0e-6)
    mid = (0.5 * (c0[0] + c1[0]), 0.5 * (c0[1] + c1[1]))
    return delta_cells < max_delta_cells, delta_cells, mid


def burst_median_centroids(
    frames_centers: list[dict[str, tuple[float, float]]],
) -> tuple[dict[str, tuple[float, float]], dict[str, float]]:
    """Median-combine per-marker centroids across a same-pose burst.

    ``frames_centers`` is a list of ``{point_id: (u,v)}`` dicts. Returns
    (median_centers, temporal_jitter_px). Burst frames are NOT multi-pose evidence.
    """
    ids = set()
    for frame in frames_centers:
        ids.update(frame)
    medians: dict[str, tuple[float, float]] = {}
    jitter: dict[str, float] = {}
    for pid in ids:
        pts = [frame[pid] for frame in frames_centers if pid in frame]
        if not pts:
            continue
        arr = np.asarray(pts, dtype=np.float64)
        med = (float(np.median(arr[:, 0])), float(np.median(arr[:, 1])))
        medians[pid] = med
        if len(arr) >= 2:
            jitter[pid] = float(np.mean(np.linalg.norm(arr - med, axis=1)))
        else:
            jitter[pid] = 0.0
    return medians, jitter


def _localization_quality(
    gray: NDArray[np.float32], corners: NDArray[np.float64], center: tuple[float, float]
) -> tuple[float, bool, tuple[str, ...]]:
    """Score the central locator, independent of intentionally-white code cells.

    The old ``roi >= 250`` rule measured the marker's white border/data cells,
    not whether the Gaussian locator could be positioned.  Formal rejection is
    now based only on the small central locator window used by the centroid.
    """
    geometric = _diagonal_intersection(corners)
    side = np.mean([
        np.linalg.norm(corners[i] - corners[(i + 1) % 4]) for i in range(4)
    ])
    cell = max(1.0, side * (1.0 - 2.0 * _MARGIN_FRAC) / GRID)
    radius = max(3, int(round(cell)))
    cx, cy = center
    x0, x1 = max(0, int(round(cx)) - radius), min(gray.shape[1], int(round(cx)) + radius + 1)
    y0, y1 = max(0, int(round(cy)) - radius), min(gray.shape[0], int(round(cy)) + radius + 1)
    win = gray[y0:y1, x0:x1].astype(np.float64)
    if win.size == 0:
        return 0.0, True, ("locator_window_empty",)
    background = float(np.median(win))
    peak = float(win.max())
    contrast = peak - background
    plateau_margin = max(1.0, 0.02 * max(contrast, 1.0))
    plateau_fraction = float(np.mean(win >= peak - plateau_margin))
    displacement_cells = float(np.linalg.norm(np.asarray(center) - geometric) / cell)
    reasons: list[str] = []
    if contrast < 8.0:
        reasons.append("locator_low_contrast")
    if plateau_fraction > 0.65:
        reasons.append("locator_flat_topped")
    if displacement_cells > 0.45:
        reasons.append("locator_centroid_unstable")
    stable, delta_cells, _mid = multi_scale_centroid_stable(gray, corners)
    if not stable:
        reasons.append("locator_multiscale_unstable")
    contrast_score = float(np.clip((contrast - 8.0) / 32.0, 0.0, 1.0))
    plateau_score = float(np.clip(1.0 - plateau_fraction / 0.65, 0.0, 1.0))
    displacement_score = float(np.clip(1.0 - displacement_cells / 0.45, 0.0, 1.0))
    multiscale_score = float(np.clip(1.0 - delta_cells / 0.15, 0.0, 1.0))
    quality = min(contrast_score, plateau_score, displacement_score, multiscale_score)
    return quality, bool(reasons), tuple(reasons)


def _normalise_detector_gray(image: NDArray) -> NDArray[np.uint8]:
    """Preserve native input until a deliberate, non-wrapping 8-bit conversion."""
    gray = image if image.ndim == 2 else cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    if gray.dtype == np.uint8:
        return gray
    if np.issubdtype(gray.dtype, np.integer):
        maximum = float(np.iinfo(gray.dtype).max)
        return np.clip(np.rint(gray.astype(np.float64) * (255.0 / maximum)), 0, 255).astype(np.uint8)
    finite = gray[np.isfinite(gray)]
    if finite.size == 0:
        return np.zeros(gray.shape, dtype=np.uint8)
    lo, hi = float(finite.min()), float(finite.max())
    if hi <= lo:
        return np.zeros(gray.shape, dtype=np.uint8)
    return np.clip(np.rint((gray - lo) * (255.0 / (hi - lo))), 0, 255).astype(np.uint8)


def _grid_coords(
    dets: list[Detection], *, markers_per_cabinet: int | None = None
) -> NDArray[np.float64]:
    """Continuous grid position per detection, including the sub-marker offset.

    With multiple markers per cabinet, ``local_id`` indexes the sub-grid
    (see ``screen_geometry.sub_offsets_for_count``); ignoring it would put
    all of a cabinet's markers at one grid point and break the local affine fit.

    ``markers_per_cabinet`` must come from the configured screen layout. Inferring
    it from observed ``local_id`` values is unsafe under sparse detections.
    When unset, every marker is treated as cabinet-centred (mpc=1).
    """
    from vpcal.core.screen_geometry import sub_offset_for_local_id

    mpc = 1 if markers_per_cabinet is None else max(int(markers_per_cabinet), 1)
    coords = []
    for d in dets:
        ou, ov = sub_offset_for_local_id(d.marker_id.local_id, mpc)
        coords.append([d.marker_id.cab_col + ou, d.marker_id.cab_row + ov])
    return np.array(coords, dtype=np.float64)


def _topology_filter(dets: list[Detection], cfg: DetectorConfig) -> list[Detection]:
    """Down-weight markers whose decoded id disagrees with their neighbours."""
    if not cfg.enable_topology or len(dets) < cfg.topology_neighbors + 1:
        return dets
    pix = np.array([[d.pixel_u, d.pixel_v] for d in dets])
    grid = _grid_coords(dets, markers_per_cabinet=cfg.markers_per_cabinet)
    out: list[Detection] = []
    for i, d in enumerate(dets):
        dist = np.linalg.norm(pix - pix[i], axis=1)
        order = np.argsort(dist)[1 : cfg.topology_neighbors + 1]
        try:
            # A rogue neighbour with far-off grid coords is a high-leverage
            # point: plain least squares bends towards it and honest markers
            # near it would be rejected too.  Fit every leave-one-out neighbour
            # subset and keep the most self-consistent fit (the subset without
            # the rogue fits the local affine almost exactly).
            coef = None
            best_rms = np.inf
            subsets = (
                [np.delete(order, j) for j in range(len(order))]
                if len(order) > 4
                else [order]
            )
            for keep in subsets:
                A = np.column_stack([grid[keep], np.ones(len(keep))])
                c_fit, *_ = np.linalg.lstsq(A, pix[keep], rcond=None)
                rms = float(np.linalg.norm(A @ c_fit - pix[keep]))
                if rms < best_rms:
                    best_rms, coef = rms, c_fit
            pred = np.array([grid[i, 0], grid[i, 1], 1.0]) @ coef
        except np.linalg.LinAlgError:
            out.append(d)
            continue
        residual = float(np.linalg.norm(pred - pix[i]))
        conf = d.confidence if residual <= cfg.topology_max_residual_px else d.confidence * 0.5
        out.append(Detection(
            d.frame_id, d.marker_id, d.pixel_u, d.pixel_v,
            conf, d.differenced, d.saturated, d.localization_quality,
            d.localization_rejected, d.localization_reasons,
        ))
    return out


def detect_markers(
    image: NDArray,
    *,
    frame_id: int = 0,
    inverted: NDArray | None = None,
    config: DetectorConfig | None = None,
) -> list[Detection]:
    """Detect and decode VP-QSP markers in one image.

    ``image`` is the normal-frame capture; ``inverted`` (optional) enables
    normal−inverted differencing.  Returns one :class:`Detection` per
    successfully decoded, CRC-valid marker.
    """
    cfg = config or DetectorConfig()
    gray = _normalise_detector_gray(image)
    differenced = inverted is not None
    if differenced:
        inv = _normalise_detector_gray(inverted)
        signed = gray.astype(np.int16) - inv.astype(np.int16)
        # Segmentation only needs the positive half; decode + centroid use the
        # full signed image so ambient gradients cancel (A2.2).
        seg_src = np.clip(signed, 0, 255).astype(np.uint8)
        sample_src = signed.astype(np.float32)
    else:
        seg_src = gray
        sample_src = gray.astype(np.float32)

    dets = _detect_pass(_threshold(seg_src), sample_src, frame_id, differenced, cfg)
    if len(dets) < cfg.detect_fallback_min:
        adaptive = _detect_pass(
            _threshold_adaptive(seg_src), sample_src, frame_id, differenced, cfg
        )
        for candidate in adaptive:
            if all(
                np.hypot(candidate.pixel_u - d.pixel_u, candidate.pixel_v - d.pixel_v) > 3.0
                for d in dets
            ):
                dets.append(candidate)

    return _topology_filter(dets, cfg)


def _detect_pass(
    binary: NDArray[np.uint8],
    sample_src: NDArray[np.float32],
    frame_id: int,
    differenced: bool,
    cfg: DetectorConfig,
) -> list[Detection]:
    """One contour → decode → sub-pixel pass over a binarised image."""
    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    img_area = sample_src.shape[0] * sample_src.shape[1]
    dets: list[Detection] = []
    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area < cfg.min_area_px or area > cfg.max_area_frac * img_area:
            continue
        peri = cv2.arcLength(cnt, True)
        approx = None
        for eps in (0.02, 0.03, 0.04, 0.05):
            cand = cv2.approxPolyDP(cnt, eps * peri, True)
            if len(cand) == 4 and cv2.isContourConvex(cand):
                approx = cand
                break
        if approx is None:
            continue
        corners = _order_corners(approx.reshape(4, 2).astype(np.float64))
        marker = _decode_quad(sample_src, corners)
        if marker is None:
            continue
        u, v = _subpixel_center(sample_src, corners)
        localization_quality, localization_rejected, localization_reasons = (
            _localization_quality(sample_src, corners, (u, v))
        )
        x0, y0 = np.floor(corners.min(axis=0)).astype(int)
        x1, y1 = np.ceil(corners.max(axis=0)).astype(int)
        x0, y0 = max(x0, 0), max(y0, 0)
        x1, y1 = min(x1, sample_src.shape[1] - 1), min(y1, sample_src.shape[0] - 1)
        roi = sample_src[y0:y1 + 1, x0:x1 + 1]
        brightness_warning = bool(roi.size and np.mean(roi >= 250) > 0.01)
        dets.append(Detection(
            frame_id, marker, u, v, 1.0, differenced, brightness_warning,
            localization_quality, localization_rejected, localization_reasons,
        ))
    return dets
