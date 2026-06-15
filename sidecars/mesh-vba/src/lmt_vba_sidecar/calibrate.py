"""Camera intrinsics from a checkerboard image set."""
from __future__ import annotations

import json
import pathlib

import cv2
import numpy as np

from lmt_vba_sidecar.io_utils import write_event
from lmt_vba_sidecar.ipc import (
    BaStats,
    CalibrateInput,
    ErrorEvent,
    ProgressEvent,
    ResultData,
    ResultEvent,
)


def _build_object_points(inner: tuple[int, int], square_mm: float) -> np.ndarray:
    cols, rows = inner
    pts = np.zeros((cols * rows, 3), dtype=np.float32)
    pts[:, :2] = np.mgrid[0:cols, 0:rows].T.reshape(-1, 2) * square_mm
    return pts


def _atomic_write(path: pathlib.Path, content: str) -> None:
    """Write content to path atomically: write to <path>.tmp + rename."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(content)
    tmp.replace(path)


# Quality thresholds.
MAX_REPROJECTION_RMS_PX = 0.5  # cv2 RMS reprojection error gate (tightened from 2.0)
FOCAL_BOUNDS_FRACTION = (0.2, 5.0)  # fx/fy must lie within (frac × image_dim)


def _has_corner_coverage(
    img_points_list: list, image_size: tuple[int, int], min_frac: float = 0.6,
) -> bool:
    """True if the union bounding box of all detected corners covers enough of the image.

    Prevents calibration from fitting to corners clustered in one image region.
    img_points_list: list of (N,2) or (N,1,2) arrays.
    image_size: (width, height).
    min_frac: required coverage fraction (default 0.6).

    Note: this is the union bbox across all frames; a few outlier frames in
    opposite corners can satisfy the gate even when most frames cluster, so the
    principal-point estimate may still be dominated by the clustered frames. A
    per-cell grid-occupancy check would be stricter (future). The RMS<0.5px gate
    is the final quality arbiter.
    """
    if not img_points_list:
        return False
    all_pts = np.concatenate(
        [np.asarray(p).reshape(-1, 2) for p in img_points_list], axis=0,
    )
    x_min, y_min = all_pts[:, 0].min(), all_pts[:, 1].min()
    x_max, y_max = all_pts[:, 0].max(), all_pts[:, 1].max()
    bbox_area = (x_max - x_min) * (y_max - y_min)
    img_area = image_size[0] * image_size[1]
    return bool((bbox_area / img_area) >= min_frac)


def run_calibrate(cmd: CalibrateInput) -> int:
    inner = (cmd.inner_corners[0], cmd.inner_corners[1])
    obj_template = _build_object_points(inner, cmd.square_size_mm)

    obj_points: list[np.ndarray] = []
    img_points: list[np.ndarray] = []
    image_size: tuple[int, int] | None = None

    for idx, path in enumerate(cmd.checkerboard_images):
        img = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
        if img is None:
            write_event(ErrorEvent(
                event="error", code="image_load_failed",
                message=f"could not read image {path}", fatal=True,
            ))
            return 1
        if image_size is None:
            image_size = (img.shape[1], img.shape[0])
        elif (img.shape[1], img.shape[0]) != image_size:
            write_event(ErrorEvent(
                event="error", code="invalid_input",
                message=f"image {path} dim {img.shape[::-1]} differs from {image_size}",
                fatal=True,
            ))
            return 1
        found, corners = cv2.findChessboardCorners(img, inner, flags=cv2.CALIB_CB_ADAPTIVE_THRESH)
        if not found:
            write_event(ProgressEvent(
                event="progress", stage="detect_charuco",
                percent=(idx + 1) / len(cmd.checkerboard_images),
                message=f"checkerboard not found in {pathlib.Path(path).name}",
            ))
            continue
        criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 1e-3)
        corners_refined = cv2.cornerSubPix(img, corners, (11, 11), (-1, -1), criteria)
        obj_points.append(obj_template)
        img_points.append(corners_refined)
        write_event(ProgressEvent(
            event="progress", stage="detect_charuco",
            percent=(idx + 1) / len(cmd.checkerboard_images),
            message=f"{len(obj_points)}/{idx + 1} usable",
        ))

    if len(obj_points) < 5:
        write_event(ErrorEvent(
            event="error", code="detection_failed",
            message=f"only {len(obj_points)} of {len(cmd.checkerboard_images)} images yielded detectable checkerboards (need ≥ 5)",
            fatal=True,
        ))
        return 1

    # Corner coverage: if all detected corners are clustered in one image region,
    # calibration cannot reliably estimate principal point or distortion. Reject.
    # (Stricter than the shared solver's 20% min-dim span: a checkerboard anchor
    # demands 60% bbox-area coverage.)
    if not _has_corner_coverage(img_points, image_size):
        write_event(ErrorEvent(
            event="error", code="intrinsics_invalid",
            message=(
                "corner coverage insufficient: detected corners span less than 60% of "
                "the image area. Capture checkerboard across the full frame."
            ),
            fatal=True,
        ))
        return 1

    write_event(ProgressEvent(event="progress", stage="bundle_adjustment", percent=0.7, message="solving intrinsics"))
    # FIX-5: solve through the SHARED gated solver instead of a bare
    # cv2.calibrateCamera. This replaces the old pixel-translation "pose
    # diversity" gate (which roll-only / translation-only Zhang-degenerate sets
    # passed with fx off by several hundred percent — only the focal sanity
    # bound caught the extreme cases) with the view-axis diversity gate plus
    # the principal-point/focal covariance gates. The distortion model is
    # adaptive: full (k3+tangential) only when those coefficients are
    # observable, else radial k1,k2 — a checkerboard anchor must not ship
    # overfit tangential terms from a handful of frames.
    from lmt_vba_sidecar.intrinsics_solve import IntrinsicsRefused, solve_sl_intrinsics
    try:
        # Covariance gates re-levelled to the checkerboard capture class:
        # ~0.3px corner-detection noise at 1080p puts the NATURAL pp/focal
        # stddev floor well above the SL-white-dot defaults (sub-0.1px
        # centroids on 4000px frames). 8px pp / 1% focal still refuses junk;
        # the Zhang-degeneracy guard is the (independent) view-axis gate.
        res = solve_sl_intrinsics(
            obj_points, img_points, image_size,
            max_rms_px=MAX_REPROJECTION_RMS_PX, allow_full_distortion=True,
            max_pp_std_px=8.0, max_focal_std_frac=0.01)
    except IntrinsicsRefused as e:
        write_event(ErrorEvent(event="error", code=e.code, message=e.message, fatal=True))
        return 1
    K, dist, rms = res.K, res.dist, res.rms

    out_path = pathlib.Path(cmd.output_path)
    payload = json.dumps({
        "K": K.tolist(),
        "dist_coeffs": dist.flatten().tolist(),
        "image_size": list(image_size),
        "reproj_error_px": float(rms),
        "frames_used": len(obj_points),
    }, indent=2)
    _atomic_write(out_path, payload)

    write_event(ResultEvent(
        event="result",
        data=ResultData(
            measured_points=[],
            ba_stats=BaStats(rms_reprojection_px=float(rms), iterations=0, converged=True),
            frame_strategy_used="nominal_anchoring",
            procrustes_align_rms_m=0.0,  # calibrate does no Procrustes
        ),
    ))
    return 0
