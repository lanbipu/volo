"""VP-QSP marker detection across an image set.

Ported from vpcal's VP-QCP detector (pure cv2 + numpy, no domain coupling) and
adapted to lmt's detection seam. Pipeline per image:

  Otsu threshold + morph-close → external contours → 4-vertex convex quad
  candidates → perspective rectify to a canonical 7x7 panel → cell sampling →
  4-rotation orientation gate → 32-bit decode + CRC-8 check →
  diagonal-intersection-seeded Gaussian centroid.

  FIX-8 threshold note: adaptiveThreshold (blocks 31/51/101) and CLAHE+Otsu were
  evaluated against the blur-degradation matrix (test_vpqsp_detect_envelope) and
  none beat global Otsu — the blur cliff is contour MERGING (bright outline
  bleeding into the dark inter-marker gap) plus rectified cell-contrast collapse,
  i.e. a resolution limit, not a thresholding artifact. Envelope: a marker needs
  >= ~48 camera px at sigma<=1 blur, >= 64px at sigma<=2, >= ~86px at sigma=3.

Output matches the ChArUco detect seam shape so reconstruct's Observation
assembly is near-identical:

  {"path": [{"cabinet": (col, row), "screen_id": int, "local_id": int,
             "corner_px": [x, y]}]}

The Gaussian centroid is the load-bearing sub-pixel measurement fed to BA.

W5 (2026-07-02): re-ported vpcal's A2.2 normal/inverted signed-difference
centroid (sidecars/vpcal/src/vpcal/core/detector.py, same date) — FIX-8 had
removed the `inverted` parameter as dead code (no producer ever generated an
inverted frame), which also meant no signed-difference cancellation of
ambient-light gradients existed here. vpqsp_pattern now emits an inverted
companion of every pattern image; ``detect_markers_image``/``detect_vpqsp_markers``
below take it as an optional input and, when supplied, sample cell values and
the centroid from ``int16(normal) − int16(inverted)`` instead of the raw
normal frame — ambient gradients cancel exactly (a saturating ``cv2.subtract``
would clip the negative half, so the diff is done in signed int16/float32).
Segmentation (contour finding) only needs the positive half, so it keeps using
the clipped uint8 image. With no inverted frame supplied, behaviour is
unchanged from before this port (single-frame, undifferenced).
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np
from numpy.typing import NDArray

from lmt_vba_sidecar.vpqsp_codec import (
    GRID,
    _MARGIN_FRAC,
    VpqspMarkerId,
    cellgrid_to_code,
    decode_marker,
    orientation_ok,
)

_CANON_CELL_PX = 12  # canonical pixels per cell for rectified sampling (7*12 = 84)


@dataclass
class VpqspDetectorConfig:
    min_area_px: float = 200.0
    max_area_frac: float = 0.25  # reject quads larger than this fraction of the image


def _order_corners(pts: NDArray[np.float64]) -> NDArray[np.float64]:
    """Order 4 points as TL, TR, BR, BL (image convention, y down).

    Uses centroid-relative polar angles — stable at any roll including the
    ~45° degenerate case where the old argmin(sum)/argmin(diff) trick picks
    the same vertex for both TL and TR (FIX-24).
    """
    pts = pts.reshape(4, 2).astype(np.float64)
    cx, cy = pts.mean(axis=0)
    angles = np.arctan2(pts[:, 1] - cy, pts[:, 0] - cx)
    # Sort CCW (ascending angle). atan2 range is [-π, π]; for image coords
    # (y-down) the "top-left" corner has angle closest to -3π/4 (up-left in
    # math coords maps to negative-x, negative-y in image coords).
    order = np.argsort(angles)
    sorted_pts = pts[order]
    sorted_angles = angles[order]
    # Rotate so TL (angle nearest -3π/4) comes first.
    target = -3 * np.pi / 4
    diffs = np.abs(np.arctan2(np.sin(sorted_angles - target),
                              np.cos(sorted_angles - target)))
    start = int(np.argmin(diffs))
    idx = [(start + i) % 4 for i in range(4)]
    return sorted_pts[idx].astype(np.float64)


def _threshold(gray: NDArray[np.uint8]) -> NDArray[np.uint8]:
    blur = cv2.GaussianBlur(gray, (3, 3), 0)
    _, th = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return cv2.morphologyEx(th, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))


def _sample_cellgrid(rect: NDArray[np.floating] | NDArray[np.uint8]) -> NDArray[np.int_]:
    """Sample the GRID×GRID cell value grid from a rectified marker panel image.

    ``rect`` may be the signed (possibly negative) normal-inverted difference
    when differencing is active — cell means and the max/min threshold split
    are sign-agnostic, so this works unchanged on a float32 signed input."""
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


def _decode_quad(
    sample_src: NDArray[np.float32] | NDArray[np.uint8], corners: NDArray[np.float64]
) -> VpqspMarkerId | None:
    """Rectify a quad and decode its marker id over the 4 orientations.

    ``sample_src`` is the signed normal-inverted difference image (float32, may
    contain negatives) when differencing is active, else the plain grayscale
    frame — ``cv2.warpPerspective`` accepts either dtype unchanged."""
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
    gray: NDArray[np.float32] | NDArray[np.uint8], corners: NDArray[np.float64]
) -> tuple[float, float, float]:
    """Intensity-weighted centroid of the central locator dot.

    ``gray`` is the signed normal-inverted difference image when differencing
    is active — ambient gradients cancel there, keeping the centroid unbiased
    (A2.2, ported from sidecars/vpcal/src/vpcal/core/detector.py::
    _subpixel_center as of 2026-07-02).

    Returns (u, v, sigma_px) where sigma_px is an observation uncertainty
    estimate derived from the blob's SNR and pixel count (FIX-25).
    """
    center = _diagonal_intersection(corners)
    side = np.mean([np.linalg.norm(corners[i] - corners[(i + 1) % 4]) for i in range(4)])
    cell = side * (1.0 - 2.0 * _MARGIN_FRAC) / GRID
    radius = max(3, int(round(cell)))
    cx, cy = float(center[0]), float(center[1])
    blob_npix = 1.0
    snr = 1.0
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
        _n_lbl, labels = cv2.connectedComponents(mask)
        seed = labels[
            min(int(round(cy)) - y0, win.shape[0] - 1),
            min(int(round(cx)) - x0, win.shape[1] - 1),
        ]
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
        blob_npix = max(1.0, float(blob.sum()))
        noise_est = max(1.0, float(np.std(win[~blob])) if (~blob).any() else 1.0)
        snr = max(0.1, (peak - bg) / noise_est)
    # sigma ∝ 1/√(SNR · N_pixels): well-lit large blobs have low uncertainty.
    # Clamp to [0.1, 5.0] px — below 0.1 is overconfident, above 5 is noise.
    sigma_px = max(0.1, min(5.0, 1.0 / max(0.01, np.sqrt(snr * blob_npix / 50.0))))
    return cx, cy, sigma_px


def detect_markers_image(
    image: NDArray[np.uint8],
    *,
    inverted: NDArray[np.uint8] | None = None,
    config: VpqspDetectorConfig | None = None,
) -> list[tuple[VpqspMarkerId, float, float, float]]:
    """Detect + decode VP-QSP markers in one image.

    Returns one (marker_id, u, v, sigma_px) per CRC-valid decoded marker; the
    (u, v) is the sub-pixel Gaussian centroid.

    ``inverted`` (optional) is the same scene with the pattern's normal/inverted
    frames swapped (see vpqsp_pattern's ``*_inverted.png`` outputs). When given,
    cell sampling, decode and the centroid all run on the signed difference
    ``int16(image) − int16(inverted)`` instead of the raw frame — ambient-light
    gradients cancel there instead of biasing the intensity-weighted centroid
    (A2.2, re-ported from sidecars/vpcal/src/vpcal/core/detector.py as of
    2026-07-02; FIX-8 had removed this as dead code because no producer emitted
    an inverted frame — that gap is what vpqsp_pattern's new inverted output
    closes). A saturating ``cv2.subtract`` would clip the negative half, so the
    diff is computed in signed int16/float32. Segmentation (contour finding)
    only needs the positive half, so it keeps using the clipped uint8 image.
    With ``inverted=None`` behaviour is unchanged from the single-frame path.
    """
    cfg = config or VpqspDetectorConfig()
    gray = image if image.ndim == 2 else cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    gray = gray.astype(np.uint8)

    if inverted is not None:
        inv = inverted if inverted.ndim == 2 else cv2.cvtColor(inverted, cv2.COLOR_BGR2GRAY)
        inv = inv.astype(np.uint8)
        signed = gray.astype(np.int16) - inv.astype(np.int16)
        seg_src = np.clip(signed, 0, 255).astype(np.uint8)
        sample_src = signed.astype(np.float32)
    else:
        seg_src = gray
        sample_src = gray.astype(np.float32)

    binary = _threshold(seg_src)
    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    img_area = gray.shape[0] * gray.shape[1]
    out: list[tuple[VpqspMarkerId, float, float, float]] = []
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
        u, v, sigma = _subpixel_center(sample_src, corners)
        out.append((marker, u, v, sigma))
    return out


def detect_vpqsp_markers(
    image_paths: list[str],
    *,
    inverted_image_paths: list[str | None] | None = None,
    screen_id_code: int | None = None,
    config: VpqspDetectorConfig | None = None,
) -> dict[str, list[dict]]:
    """Detect VP-QSP markers across an image set → per-image observation lists.

    Each observation: {"cabinet": (col, row), "screen_id": int, "local_id": int,
    "corner_px": [x, y]}. When `screen_id_code` is set, markers decoded to a
    different screen are dropped (multi-screen Volume disambiguation); None keeps
    all. Unreadable images yield an empty list (not an exception), matching
    detect_charuco_corners' tolerance.

    ``inverted_image_paths`` (optional) is a list parallel to ``image_paths``
    (same length); entry ``i`` is the inverted companion capture for
    ``image_paths[i]``, or ``None`` if that view has no inverted sibling —
    detection for that image then falls back to the undifferenced path (A2.2,
    see ``detect_markers_image``). There is currently no capture-manifest
    convention for pairing normal/inverted paths per view, so callers must
    supply this list explicitly; it is not derived automatically from a
    CaptureView's ``images`` list.
    """
    if inverted_image_paths is not None and len(inverted_image_paths) != len(image_paths):
        raise ValueError(
            f"inverted_image_paths length {len(inverted_image_paths)} != "
            f"image_paths length {len(image_paths)}"
        )
    out: dict[str, list[dict]] = {}
    for i, path in enumerate(image_paths):
        img = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
        if img is None:
            out[path] = []
            continue
        inv_img = None
        inv_path = inverted_image_paths[i] if inverted_image_paths is not None else None
        if inv_path is not None:
            inv_img = cv2.imread(inv_path, cv2.IMREAD_GRAYSCALE)
        observations: list[dict] = []
        for marker, u, v, sigma in detect_markers_image(img, inverted=inv_img, config=config):
            if screen_id_code is not None and marker.screen_id != screen_id_code:
                continue
            observations.append({
                "cabinet": (marker.col, marker.row),
                "screen_id": marker.screen_id,
                "local_id": marker.local_id,
                "corner_px": [float(u), float(v)],
                "sigma_px": float(sigma),
            })
        out[path] = observations
    return out
