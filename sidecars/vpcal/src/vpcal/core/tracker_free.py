"""Tracker-free calibration: lens intrinsic estimation + multi-screen spatial solve.

Uses only images of VP-QSP calibration patterns — no external tracking system.
The camera itself serves as the common reference frame.

Workflow:
  1. lens_calibrate()  — multiple images of ONE screen → camera intrinsics
  2. spatial_solve()   — multiple images of BOTH screens → relative screen poses
  3. verify_pose()     — single image → camera pose for visual confirmation
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np
from numpy.typing import NDArray

from vpcal.core.detector import detect_markers, DetectorConfig
from vpcal.core.observations import MarkerId
from vpcal.core.screen_geometry import enumerate_markers, ScreenMarker
from vpcal.core.transforms import matrix_to_quat, quat_to_matrix
from vpcal.models.screen import ScreenDefinition


@dataclass
class LensCalResult:
    fx: float
    fy: float
    cx: float
    cy: float
    dist_coeffs: list[float]
    rms: float
    num_images: int
    num_points: int
    image_size: tuple[int, int]


@dataclass
class ScreenPose:
    """solvePnP output: transforms points FROM screen/object TO camera frame.

    X_cam = R @ X_screen + t
    """

    rvec: NDArray[np.float64]
    tvec: NDArray[np.float64]
    ambiguous: bool = False
    candidate_error_ratio: float | None = None

    @property
    def rotation_matrix(self) -> NDArray[np.float64]:
        R, _ = cv2.Rodrigues(self.rvec)
        return R

    @property
    def matrix_4x4(self) -> NDArray[np.float64]:
        M = np.eye(4, dtype=np.float64)
        M[:3, :3] = self.rotation_matrix
        M[:3, 3] = self.tvec.ravel()
        return M

    @property
    def camera_position_in_screen(self) -> NDArray[np.float64]:
        """Camera position expressed in the screen's coordinate frame."""
        R = self.rotation_matrix
        return -R.T @ self.tvec.ravel()

    @property
    def inverse_matrix_4x4(self) -> NDArray[np.float64]:
        """Inverse: transforms points FROM camera TO screen frame."""
        return np.linalg.inv(self.matrix_4x4)


@dataclass
class SpatialResult:
    screen_a_name: str
    screen_b_name: str
    screen_b_pose: ScreenPose
    per_image_poses: list[dict] = field(default_factory=list)
    num_co_visible: int = 0
    rms_reprojection_a: float = 0.0
    rms_reprojection_b: float = 0.0
    # Consistency of the per-image relative transforms about their average
    # (a QA signal: low dispersion ⇒ the averaged solution is well-supported).
    consistency: dict = field(default_factory=dict)
    num_rejected: int = 0


@dataclass
class VerifyResult:
    camera_pose_from_a: ScreenPose | None
    camera_pose_from_b: ScreenPose | None
    num_markers_a: int
    num_markers_b: int


@dataclass(frozen=True)
class StagePoseTarget:
    screen: ScreenDefinition
    screen_id: int
    cab_col_offset: int
    label: str


@dataclass
class StagePoseResult:
    """One fixed-camera pose in the common Stage coordinate frame."""

    camera_from_stage: ScreenPose
    rms_reprojection_px: float
    num_markers: int
    num_inliers: int
    markers_by_target: dict[str, int]
    inliers_by_target: dict[str, int]
    rms_by_target: dict[str, float]
    independent_rms_by_target: dict[str, float]
    screen_to_screen_consistency: dict
    rejected_observations: dict[str, int]
    preflight: dict


STAGE_POSE_MAX_RMS_PX = 2.0
STAGE_POSE_RANSAC_REPROJECTION_PX = 4.0
STAGE_POSE_MIN_MARKERS_PER_TARGET = 12
STAGE_POSE_MIN_INLIERS_PER_TARGET = 8
STAGE_POSE_MAX_HOMOGRAPHY_RMS_PX = 1.0
STAGE_POSE_MAX_JOINT_PROJECTIVE_RMS_PX = 2.0
MASTER_LENS_MIN_USABLE_IMAGES = 8


def _marker_grid_xy(detection, multi_marker: bool) -> list[float]:
    from vpcal.core.screen_geometry import _SUB_QUADRANTS

    marker = detection.marker_id
    if multi_marker:
        ou, ov = _SUB_QUADRANTS[min(marker.local_id, 3)]
    else:
        ou, ov = 0.5, 0.5
    return [float(marker.cab_col) + ou, float(marker.cab_row) + ov]


def _homography_rms(
    detections: list, image_points: NDArray[np.float64], *, multi_marker: bool
) -> tuple[float, int]:
    grid = np.asarray([_marker_grid_xy(d, multi_marker) for d in detections], dtype=np.float64)
    H, mask = cv2.findHomography(grid, image_points, cv2.RANSAC, 2.0)
    if H is None or mask is None:
        return float("inf"), 0
    projected = cv2.perspectiveTransform(grid.reshape(-1, 1, 2), H).reshape(-1, 2)
    keep = mask.reshape(-1).astype(bool)
    if not np.any(keep):
        return float("inf"), 0
    residual = projected[keep] - image_points[keep]
    return float(np.sqrt(np.mean(np.sum(residual * residual, axis=1)))), int(keep.sum())


def _normalise_points_2d(points: NDArray[np.float64]) -> tuple[NDArray[np.float64], NDArray[np.float64]]:
    mean = points.mean(axis=0)
    distance = float(np.mean(np.linalg.norm(points - mean, axis=1)))
    scale = np.sqrt(2.0) / max(distance, 1.0e-12)
    T = np.array([[scale, 0.0, -scale * mean[0]], [0.0, scale, -scale * mean[1]], [0.0, 0.0, 1.0]])
    homogeneous = np.column_stack([points, np.ones(len(points))])
    return (T @ homogeneous.T).T, T


def _normalise_points_3d(points: NDArray[np.float64]) -> tuple[NDArray[np.float64], NDArray[np.float64]]:
    mean = points.mean(axis=0)
    distance = float(np.mean(np.linalg.norm(points - mean, axis=1)))
    scale = np.sqrt(3.0) / max(distance, 1.0e-12)
    T = np.eye(4)
    T[:3, :3] *= scale
    T[:3, 3] = -scale * mean
    homogeneous = np.column_stack([points, np.ones(len(points))])
    return (T @ homogeneous.T).T, T


def _joint_projective_rms(
    object_points: NDArray[np.float64], image_points: NDArray[np.float64]
) -> tuple[float, float, float]:
    """Fit an unrestricted camera matrix; isolates geometry from PnP/K errors."""
    Xn, T3 = _normalise_points_3d(object_points)
    xn_h, T2 = _normalise_points_2d(image_points)
    xn = xn_h[:, :2] / xn_h[:, 2, None]
    rows: list[NDArray[np.float64]] = []
    for X, (u, v) in zip(Xn, xn):
        rows.append(np.r_[np.zeros(4), -X, v * X])
        rows.append(np.r_[X, np.zeros(4), -u * X])
    _u, singular, vt = np.linalg.svd(np.asarray(rows), full_matrices=False)
    if len(singular) < 12 or singular[-2] <= 0:
        return float("inf"), float("inf"), float("inf")
    Pn = vt[-1].reshape(3, 4)
    P = np.linalg.inv(T2) @ Pn @ T3
    Xh = np.column_stack([object_points, np.ones(len(object_points))])
    projected_h = (P @ Xh.T).T
    valid = np.abs(projected_h[:, 2]) > 1.0e-12
    if not np.all(valid):
        return float("inf"), float("inf"), float("inf")
    projected = projected_h[:, :2] / projected_h[:, 2, None]
    errors = np.linalg.norm(projected - image_points, axis=1)
    return (
        float(np.sqrt(np.mean(errors * errors))),
        float(np.median(errors)),
        float(np.percentile(errors, 95)),
    )


def _average_transforms(
    transforms: list[NDArray[np.float64]],
    weights: list[float],
) -> NDArray[np.float64]:
    """Weighted average of rigid transforms (rotation via quaternion averaging).

    Quaternion averaging: weighted sum of quaternions (flipping sign to stay in
    the same hemisphere), then normalize. This is the first-order optimal
    average for small angular spread.  The quaternion ⇄ matrix conversions reuse
    the canonical implementations in :mod:`vpcal.core.transforms` (single source
    of truth — D4 removed the duplicate copies that used to live here).
    """
    w = np.array(weights, dtype=np.float64)
    w /= w.sum()

    quats = np.array([matrix_to_quat(M[:3, :3]) for M in transforms])

    # Flip quaternions to same hemisphere as the first
    for i in range(1, len(quats)):
        if np.dot(quats[i], quats[0]) < 0:
            quats[i] = -quats[i]

    q_avg = (quats * w[:, None]).sum(axis=0)
    q_avg /= np.linalg.norm(q_avg)

    t_avg = np.zeros(3)
    for i, M in enumerate(transforms):
        t_avg += w[i] * M[:3, 3]

    M_avg = np.eye(4)
    M_avg[:3, :3] = quat_to_matrix(q_avg)
    M_avg[:3, 3] = t_avg
    return M_avg


def _transform_deviation(M: NDArray[np.float64], M_ref: NDArray[np.float64]) -> tuple[float, float]:
    """(rotation_deg, translation_mm) of ``M`` relative to ``M_ref``."""
    dR = M_ref[:3, :3].T @ M[:3, :3]
    ang = float(np.degrees(np.arccos(np.clip((np.trace(dR) - 1.0) / 2.0, -1.0, 1.0))))
    trans = float(np.linalg.norm(M[:3, 3] - M_ref[:3, 3]))
    return ang, trans


def _reject_transform_outliers(
    transforms: list[NDArray[np.float64]],
    weights: list[float],
) -> list[int]:
    """Indices of inlier transforms (robust MAD gate about the weighted average).

    A combined score (rotation° + translation_mm/10) is gated at
    ``median + 3.5·1.4826·MAD`` with a 0.5 absolute floor, so a clean
    (zero-noise) set keeps every image.  Never prunes below 3 inliers.

    Breakdown point: the consensus is the weighted *mean* of all transforms, so a
    gross-outlier fraction approaching ~50% (e.g. 2 of 4) can pull the mean toward
    the bad cluster and inflate the MAD, weakening the gate.  This is adequate for
    the intended regime (a few bad views among many — real data showed 2/10); for
    heavier contamination prefer more/cleaner captures.
    """
    n = len(transforms)
    if n < 4:
        return list(range(n))
    M_avg = _average_transforms(transforms, weights)
    scores = np.array([
        (lambda dev: dev[0] + dev[1] / 10.0)(_transform_deviation(M, M_avg))
        for M in transforms
    ])
    med = float(np.median(scores))
    mad = float(np.median(np.abs(scores - med)))
    thresh = max(med + 3.5 * 1.4826 * mad, 0.5)
    inliers = [i for i, s in enumerate(scores) if s <= thresh]
    return inliers if len(inliers) >= 3 else list(range(n))


def _reprojection_rms(
    obj_pts: NDArray[np.float64],
    img_pts: NDArray[np.float64],
    rvec: NDArray[np.float64],
    tvec: NDArray[np.float64],
    camera_matrix: NDArray[np.float64],
    dist: NDArray[np.float64],
) -> tuple[float, int]:
    """Sum-of-squared pixel residual and point count for one view (planar obj)."""
    proj, _ = cv2.projectPoints(_to_planar(obj_pts), rvec, tvec, camera_matrix, dist)
    proj = proj.reshape(-1, 2)
    err = proj - img_pts
    return float(np.sum(err * err)), len(img_pts)


def _build_world_map(
    screen: ScreenDefinition,
    cab_col_offset: int = 0,
    screen_id: int = 0,
) -> dict[MarkerId, NDArray[np.float64]]:
    markers = enumerate_markers(
        screen,
        markers_per_cabinet=screen.markers_per_cabinet,
        screen_id=screen_id,
        cab_col_offset=cab_col_offset,
    )
    return {m.marker_id: np.array(m.world, dtype=np.float64) for m in markers}


def _detect_images(
    images_dir: Path,
    extensions: tuple[str, ...] = (".jpg", ".jpeg", ".png", ".tif", ".tiff"),
) -> list[tuple[str, NDArray]]:
    paths = sorted(
        p for p in images_dir.iterdir()
        if p.suffix.lower() in extensions and not p.name.startswith(".")
    )
    results = []
    for p in paths:
        img = cv2.imread(str(p), cv2.IMREAD_UNCHANGED)
        if img is not None:
            results.append((p.name, img))
    return results


def _to_planar(pts: NDArray[np.float64]) -> NDArray[np.float64]:
    """Remap 3D coplanar points to Z=0 plane for cv2.calibrateCamera.

    vpcal's PlaneSection puts markers in the XZ plane (Y=0, Z varies).
    OpenCV expects planar calibration targets in the XY plane (Z=0).
    Remap (x, y, z) → (x, z, 0) when all points share the same Y.
    For non-planar arrangements, return as-is.
    """
    if len(pts) < 2:
        return pts
    y_vals = pts[:, 1]
    if np.ptp(y_vals) < 1e-6:
        return np.column_stack([pts[:, 0], pts[:, 2], np.zeros(len(pts))])
    return pts


def _match_detections(
    detections: list,
    world_map: dict[MarkerId, NDArray[np.float64]],
) -> tuple[NDArray[np.float64], NDArray[np.float64]]:
    obj_pts = []
    img_pts = []
    for d in detections:
        if d.marker_id in world_map:
            obj_pts.append(world_map[d.marker_id])
            img_pts.append([d.pixel_u, d.pixel_v])
    return np.array(obj_pts, dtype=np.float64), np.array(img_pts, dtype=np.float64)


def lens_calibrate(
    images_dir: Path,
    screen: ScreenDefinition,
    *,
    cab_col_offset: int = 0,
    screen_id: int = 0,
    min_usable_images: int = MASTER_LENS_MIN_USABLE_IMAGES,
) -> LensCalResult:
    """Calibrate camera intrinsics from multiple images of one screen's pattern."""
    world_map = _build_world_map(screen, cab_col_offset, screen_id)

    images = _detect_images(images_dir)
    if not images:
        raise ValueError(f"No images found in {images_dir}")

    all_obj: list[NDArray] = []
    all_img: list[NDArray] = []
    image_size = None

    for name, img in images:
        if image_size is None:
            image_size = (img.shape[1], img.shape[0])
        dets = detect_markers(img)
        obj_pts, img_pts = _match_detections(dets, world_map)
        if len(obj_pts) >= 6:
            obj_planar = _to_planar(obj_pts)
            all_obj.append(obj_planar.reshape(-1, 1, 3).astype(np.float32))
            all_img.append(img_pts.reshape(-1, 1, 2).astype(np.float32))

    if len(all_obj) < min_usable_images:
        raise ValueError(
            f"Need >= {min_usable_images} images with >= 6 detected markers; "
            f"got {len(all_obj)} usable images"
        )

    # Fix k3=0 by default to prevent overfitting on small datasets.
    # k1+k2 is sufficient for most lenses; k3 adds no meaningful accuracy
    # but produces large, mutually-cancelling coefficients that look wrong.
    rms, mtx, dist, rvecs, tvecs = cv2.calibrateCamera(
        all_obj, all_img, image_size, None, None,
        flags=cv2.CALIB_FIX_K3,
    )

    total_pts = sum(len(o) for o in all_obj)
    return LensCalResult(
        fx=float(mtx[0, 0]),
        fy=float(mtx[1, 1]),
        cx=float(mtx[0, 2]),
        cy=float(mtx[1, 2]),
        dist_coeffs=[float(d) for d in dist.ravel()],
        rms=float(rms),
        num_images=len(all_obj),
        num_points=total_pts,
        image_size=image_size,
    )


def _solve_pnp(
    obj_pts: NDArray[np.float64],
    img_pts: NDArray[np.float64],
    camera_matrix: NDArray[np.float64],
    dist_coeffs: NDArray[np.float64],
) -> ScreenPose | None:
    if len(obj_pts) < 4:
        return None
    obj = _to_planar(obj_pts).astype(np.float64)
    img = img_pts.astype(np.float64)
    is_planar = np.ptp(obj[:, 2]) < 1e-6
    flag = cv2.SOLVEPNP_IPPE if is_planar and len(obj) >= 4 else cv2.SOLVEPNP_ITERATIVE
    ambiguous = False
    ratio = None
    if flag == cv2.SOLVEPNP_IPPE:
        result = cv2.solvePnPGeneric(obj, img, camera_matrix, dist_coeffs, flags=flag)
        ok, rvecs, tvecs = result[:3]
        if not ok or not rvecs:
            return None
        scored = []
        for rv, tv in zip(rvecs, tvecs):
            projected, _ = cv2.projectPoints(obj, rv, tv, camera_matrix, dist_coeffs)
            rms = float(np.sqrt(np.mean(np.sum((projected.reshape(-1, 2) - img) ** 2, axis=1))))
            R, _ = cv2.Rodrigues(rv)
            normal_z = float(R[2, 2])
            scored.append((rms, normal_z, rv, tv))
        scored.sort(key=lambda x: (x[0], -x[1]))
        if len(scored) > 1:
            ratio = scored[1][0] / max(scored[0][0], 1.0e-12)
            ambiguous = ratio < 1.2
        _err, _normal, rvec, tvec = scored[0]
    else:
        ok, rvec, tvec = cv2.solvePnP(obj, img, camera_matrix, dist_coeffs, flags=flag)
    if not ok:
        return None
    rvec, tvec = cv2.solvePnPRefineLM(obj, img, camera_matrix, dist_coeffs, rvec, tvec)
    return ScreenPose(
        rvec=rvec, tvec=tvec, ambiguous=ambiguous,
        candidate_error_ratio=ratio,
    )


def spatial_solve(
    images_dir: Path,
    screen_a: ScreenDefinition,
    screen_b: ScreenDefinition,
    lens: LensCalResult,
    *,
    cab_col_offset_a: int = 0,
    cab_col_offset_b: int = 16,
    screen_id: int = 0,
) -> SpatialResult:
    """Solve relative screen positions from co-visible images of both screens."""
    world_a = _build_world_map(screen_a, cab_col_offset_a, screen_id)
    world_b = _build_world_map(screen_b, cab_col_offset_b, screen_id)

    camera_matrix = np.array([
        [lens.fx, 0, lens.cx],
        [0, lens.fy, lens.cy],
        [0, 0, 1],
    ], dtype=np.float64)
    dist = np.array(lens.dist_coeffs, dtype=np.float64)

    images = _detect_images(images_dir)
    per_image = []
    rel_transforms = []
    weights = []
    # Per co-visible image, keep the data needed for reprojection QA.
    covis: list[dict] = []

    for name, img in images:
        dets = detect_markers(img)
        obj_a, img_a = _match_detections(dets, world_a)
        obj_b, img_b = _match_detections(dets, world_b)

        pose_a = _solve_pnp(obj_a, img_a, camera_matrix, dist) if len(obj_a) >= 4 else None
        pose_b = _solve_pnp(obj_b, img_b, camera_matrix, dist) if len(obj_b) >= 4 else None

        entry = {
            "image": name,
            "markers_a": len(obj_a),
            "markers_b": len(obj_b),
            "pose_a": pose_a is not None,
            "pose_b": pose_b is not None,
            "pose_a_ambiguous": bool(pose_a and pose_a.ambiguous),
            "pose_b_ambiguous": bool(pose_b and pose_b.ambiguous),
        }
        per_image.append(entry)

        # IPPE's two planar solutions can be nearly indistinguishable in a
        # fronto-parallel view.  Until a cross-image normal consensus selects a
        # branch, fail closed instead of feeding a possible mirror solution to
        # the relative-transform average.
        if (pose_a is not None and pose_b is not None
                and not pose_a.ambiguous and not pose_b.ambiguous):
            M_a = pose_a.matrix_4x4
            M_b = pose_b.matrix_4x4
            M_rel = np.linalg.inv(M_a) @ M_b
            rel_transforms.append(M_rel)
            weights.append(min(len(obj_a), len(obj_b)))
            covis.append({
                "entry": entry, "pose_a": pose_a, "M_a": M_a,
                "obj_a": obj_a, "img_a": img_a, "obj_b": obj_b, "img_b": img_b,
            })

    if not rel_transforms:
        raise ValueError("No images with both screens detected; cannot compute relative position")

    # Reject per-image relative transforms that disagree with the consensus,
    # then average only the inliers (D4: outlier-robust spatial averaging).
    inlier_idx = _reject_transform_outliers(rel_transforms, weights)
    inlier_set = set(inlier_idx)
    for j, c in enumerate(covis):
        c["entry"]["rejected"] = j not in inlier_set
    M_avg = _average_transforms(
        [rel_transforms[i] for i in inlier_idx],
        [weights[i] for i in inlier_idx],
    )
    num_rejected = len(rel_transforms) - len(inlier_idx)

    # Per-image dispersion about the averaged relative transform.
    devs = [_transform_deviation(rel_transforms[i], M_avg) for i in inlier_idx]
    rot_devs = [d[0] for d in devs]
    trans_devs = [d[1] for d in devs]
    consistency = {
        "rotation_deg_mean": float(np.mean(rot_devs)),
        "rotation_deg_max": float(np.max(rot_devs)),
        "translation_mm_mean": float(np.mean(trans_devs)),
        "translation_mm_max": float(np.max(trans_devs)),
    }

    # Reprojection RMS: screen A against its own PnP pose; screen B against the
    # pose predicted by the *averaged* relative transform (M_b_pred = M_a · M_avg).
    sse_a = n_a = 0
    sse_b = n_b = 0
    for i in inlier_idx:
        c = covis[i]
        s, n = _reprojection_rms(
            c["obj_a"], c["img_a"], c["pose_a"].rvec, c["pose_a"].tvec, camera_matrix, dist
        )
        sse_a += s
        n_a += n
        M_b_pred = c["M_a"] @ M_avg
        rvec_b, _ = cv2.Rodrigues(M_b_pred[:3, :3])
        s, n = _reprojection_rms(
            c["obj_b"], c["img_b"], rvec_b, M_b_pred[:3, 3:], camera_matrix, dist
        )
        sse_b += s
        n_b += n
    rms_a = float(np.sqrt(sse_a / n_a)) if n_a else 0.0
    rms_b = float(np.sqrt(sse_b / n_b)) if n_b else 0.0

    rvec_rel, _ = cv2.Rodrigues(M_avg[:3, :3])
    pose_b_rel = ScreenPose(rvec=rvec_rel, tvec=M_avg[:3, 3:])

    return SpatialResult(
        screen_a_name=screen_a.name,
        screen_b_name=screen_b.name,
        screen_b_pose=pose_b_rel,
        per_image_poses=per_image,
        num_co_visible=len(rel_transforms),
        rms_reprojection_a=rms_a,
        rms_reprojection_b=rms_b,
        consistency=consistency,
        num_rejected=num_rejected,
    )


def verify_pose(
    image_path: Path,
    screen_a: ScreenDefinition,
    screen_b: ScreenDefinition,
    lens: LensCalResult,
    *,
    cab_col_offset_a: int = 0,
    cab_col_offset_b: int = 16,
    screen_id: int = 0,
) -> VerifyResult:
    """Compute camera pose from a single verification image."""
    world_a = _build_world_map(screen_a, cab_col_offset_a, screen_id)
    world_b = _build_world_map(screen_b, cab_col_offset_b, screen_id)

    camera_matrix = np.array([
        [lens.fx, 0, lens.cx],
        [0, lens.fy, lens.cy],
        [0, 0, 1],
    ], dtype=np.float64)
    dist = np.array(lens.dist_coeffs, dtype=np.float64)

    img = cv2.imread(str(image_path), cv2.IMREAD_UNCHANGED)
    if img is None:
        raise ValueError(f"Cannot read image: {image_path}")

    dets = detect_markers(img)
    obj_a, img_a = _match_detections(dets, world_a)
    obj_b, img_b = _match_detections(dets, world_b)

    pose_a = _solve_pnp(obj_a, img_a, camera_matrix, dist) if len(obj_a) >= 4 else None
    pose_b = _solve_pnp(obj_b, img_b, camera_matrix, dist) if len(obj_b) >= 4 else None
    if pose_a is not None and pose_a.ambiguous:
        pose_a = None
    if pose_b is not None and pose_b.ambiguous:
        pose_b = None

    return VerifyResult(
        camera_pose_from_a=pose_a,
        camera_pose_from_b=pose_b,
        num_markers_a=len(obj_a),
        num_markers_b=len(obj_b),
    )


def solve_stage_pose(
    image_path: Path,
    targets: list[StagePoseTarget],
    lens: LensCalResult,
) -> StagePoseResult:
    """Solve one fixed-camera Stage pose from independently calibrated intrinsics.

    Every selected target participates in the formal solution.  A target with
    fewer than four trustworthy correspondences cannot validate the selected
    screens' relative Stage geometry, so the solve fails closed rather than
    silently degrading to a one-screen pose.
    """
    if not targets:
        raise ValueError("At least one Stage screen target is required")

    world: dict[MarkerId, NDArray[np.float64]] = {}
    ids_by_target: dict[str, set[MarkerId]] = {}
    for target in targets:
        current = _build_world_map(
            target.screen,
            cab_col_offset=target.cab_col_offset,
            screen_id=target.screen_id,
        )
        collisions = set(current).intersection(world)
        if collisions:
            raise ValueError(
                f"Marker identity collision for target '{target.label}'; "
                "screen_id/cab_col_offset assignments must be unique"
            )
        world.update(current)
        ids_by_target[target.label] = set(current)

    image = cv2.imread(str(image_path), cv2.IMREAD_UNCHANGED)
    if image is None:
        raise ValueError(f"Cannot read image: {image_path}")
    detections = detect_markers(image)
    low_confidence = sum(
        1 for detection in detections
        if detection.marker_id in world and float(getattr(detection, "confidence", 1.0)) < 1.0
    )
    brightness_warnings = sum(
        1 for detection in detections
        if detection.marker_id in world and bool(getattr(detection, "saturated", False))
    )
    localization_rejected = sum(
        1 for detection in detections
        if detection.marker_id in world and bool(getattr(detection, "localization_rejected", False))
    )
    matched = [
        detection for detection in detections
        if detection.marker_id in world
        and float(getattr(detection, "confidence", 1.0)) >= 1.0
        and not bool(getattr(detection, "localization_rejected", False))
    ]
    obj_pts = np.asarray([world[d.marker_id] for d in matched], dtype=np.float64)
    img_pts = np.asarray([[d.pixel_u, d.pixel_v] for d in matched], dtype=np.float64)
    if len(obj_pts) < 4:
        raise ValueError(
            f"Need >= 4 trustworthy matched markers; got {len(obj_pts)} "
            f"({low_confidence} low-confidence, {localization_rejected} localization rejected)"
        )

    markers_by_target = {
        label: sum(1 for detection in matched if detection.marker_id in ids)
        for label, ids in ids_by_target.items()
    }
    incomplete_targets = {
        label: count for label, count in markers_by_target.items()
        if count < STAGE_POSE_MIN_MARKERS_PER_TARGET
    }
    if incomplete_targets:
        detail = ", ".join(f"{label}={count}" for label, count in incomplete_targets.items())
        from vpcal.core.errors import LocalizationQualityFailed
        raise LocalizationQualityFailed(
            "Stage pose requires >= "
            f"{STAGE_POSE_MIN_MARKERS_PER_TARGET} trustworthy markers on every selected screen; "
            f"insufficient: {detail}",
            details={
                "markers_by_screen": markers_by_target,
                "low_confidence": low_confidence,
                "localization_rejected": localization_rejected,
                "brightness_warnings": brightness_warnings,
            },
        )

    camera_matrix = np.array([
        [lens.fx, 0, lens.cx],
        [0, lens.fy, lens.cy],
        [0, 0, 1],
    ], dtype=np.float64)
    dist = np.asarray(lens.dist_coeffs, dtype=np.float64)

    undistorted = cv2.undistortPoints(
        img_pts.reshape(-1, 1, 2), camera_matrix, dist, P=camera_matrix
    ).reshape(-1, 2)
    homography_by_target: dict[str, dict] = {}
    target_by_label = {target.label: target for target in targets}
    for label, ids in ids_by_target.items():
        indices = [i for i, detection in enumerate(matched) if detection.marker_id in ids]
        target_detections = [matched[i] for i in indices]
        h_rms, h_inliers = _homography_rms(
            target_detections,
            undistorted[indices],
            multi_marker=target_by_label[label].screen.markers_per_cabinet > 1,
        )
        homography_by_target[label] = {
            "rms_px": h_rms,
            "inliers": h_inliers,
            "decoded": sum(1 for d in detections if d.marker_id in ids),
            "trustworthy": len(indices),
            "brightness_warnings": sum(
                1 for d in detections if d.marker_id in ids and bool(getattr(d, "saturated", False))
            ),
            "localization_rejected": sum(
                1 for d in detections if d.marker_id in ids
                and bool(getattr(d, "localization_rejected", False))
            ),
        }
    bad_homographies = {
        label: metrics for label, metrics in homography_by_target.items()
        if metrics["rms_px"] >= STAGE_POSE_MAX_HOMOGRAPHY_RMS_PX
    }
    if bad_homographies:
        from vpcal.core.errors import LocalizationQualityFailed
        raise LocalizationQualityFailed(
            "Per-screen marker localization failed homography validation",
            details={"homography_by_screen": homography_by_target},
        )

    joint_projective = None
    if len(targets) > 1:
        joint_rms, joint_median, joint_p95 = _joint_projective_rms(obj_pts, undistorted)
        joint_projective = {
            "rms_px": joint_rms,
            "median_px": joint_median,
            "p95_px": joint_p95,
        }
        if joint_rms >= STAGE_POSE_MAX_JOINT_PROJECTIVE_RMS_PX:
            from vpcal.core.errors import ScreenGeometryInconsistent
            raise ScreenGeometryInconsistent(
                "Selected screens are individually detected but their Stage geometry "
                "cannot be explained by one camera",
                details={
                    "homography_by_screen": homography_by_target,
                    "joint_projective": joint_projective,
                    "limit_px": STAGE_POSE_MAX_JOINT_PROJECTIVE_RMS_PX,
                },
            )

    ok, rvec, tvec, inliers = cv2.solvePnPRansac(
        obj_pts.astype(np.float64),
        img_pts.astype(np.float64),
        camera_matrix,
        dist,
        iterationsCount=200,
        reprojectionError=STAGE_POSE_RANSAC_REPROJECTION_PX,
        confidence=0.999,
        flags=cv2.SOLVEPNP_ITERATIVE,
    )
    if not ok or inliers is None or len(inliers) < 4:
        raise ValueError(
            "Stage pose RANSAC failed closed; no fallback pose was persisted "
            f"({len(obj_pts)} trustworthy markers, threshold "
            f"{STAGE_POSE_RANSAC_REPROJECTION_PX:.1f}px)"
        )

    if inliers is not None and len(inliers) >= 4:
        keep = inliers.reshape(-1)
        rvec, tvec = cv2.solvePnPRefineLM(
            obj_pts[keep], img_pts[keep], camera_matrix, dist, rvec, tvec
        )
    keep = inliers.reshape(-1)
    projected, _ = cv2.projectPoints(obj_pts, rvec, tvec, camera_matrix, dist)
    residual = projected.reshape(-1, 2) - img_pts
    rms = float(np.sqrt(np.mean(np.sum(residual[keep] * residual[keep], axis=1))))

    inlier_set = set(int(index) for index in keep)
    inliers_by_target: dict[str, int] = {}
    rms_by_target: dict[str, float] = {}
    independent_rms_by_target: dict[str, float] = {}
    independent_poses: dict[str, ScreenPose] = {}
    for label, ids in ids_by_target.items():
        target_indices = [
            index for index, detection in enumerate(matched)
            if detection.marker_id in ids and index in inlier_set
        ]
        inliers_by_target[label] = len(target_indices)
        if len(target_indices) < STAGE_POSE_MIN_INLIERS_PER_TARGET:
            raise ValueError(
                f"Stage pose RANSAC retained only {len(target_indices)} inliers for "
                f"screen '{label}' (need >= {STAGE_POSE_MIN_INLIERS_PER_TARGET})"
            )
        target_residual = residual[target_indices]
        rms_by_target[label] = float(
            np.sqrt(np.mean(np.sum(target_residual * target_residual, axis=1)))
        )

        target_obj = obj_pts[target_indices]
        target_img = img_pts[target_indices]
        independent = _solve_pnp(target_obj, target_img, camera_matrix, dist)
        if independent is not None and not independent.ambiguous:
            target_projected, _ = cv2.projectPoints(
                target_obj, independent.rvec, independent.tvec, camera_matrix, dist
            )
            target_error = target_projected.reshape(-1, 2) - target_img
            independent_rms_by_target[label] = float(
                np.sqrt(np.mean(np.sum(target_error * target_error, axis=1)))
            )
            independent_poses[label] = independent

    max_translation_mm = 0.0
    max_rotation_deg = 0.0
    labels = list(independent_poses)
    for i, label_a in enumerate(labels):
        pose_a = independent_poses[label_a]
        for label_b in labels[i + 1:]:
            pose_b = independent_poses[label_b]
            translation = float(np.linalg.norm(
                pose_a.camera_position_in_screen - pose_b.camera_position_in_screen
            ))
            relative = pose_a.rotation_matrix @ pose_b.rotation_matrix.T
            cosine = float(np.clip((np.trace(relative) - 1.0) / 2.0, -1.0, 1.0))
            rotation_deg = float(np.degrees(np.arccos(cosine)))
            max_translation_mm = max(max_translation_mm, translation)
            max_rotation_deg = max(max_rotation_deg, rotation_deg)

    failed_rms = {
        label: value for label, value in rms_by_target.items()
        if value >= STAGE_POSE_MAX_RMS_PX
    }
    if rms >= STAGE_POSE_MAX_RMS_PX or failed_rms:
        individual_good = (
            len(independent_rms_by_target) == len(targets)
            and all(value < STAGE_POSE_MAX_RMS_PX for value in independent_rms_by_target.values())
        )
        per_screen = ", ".join(
            f"{label}={value:.3f}px" for label, value in sorted(rms_by_target.items())
        )
        independent_text = ", ".join(
            f"{label}={value:.3f}px"
            for label, value in sorted(independent_rms_by_target.items())
        )
        reason = "screen geometry inconsistency" if individual_good and len(targets) > 1 else "reprojection gate failed"
        message = (
            f"Stage pose {reason}: combined={rms:.3f}px, per-screen [{per_screen}], "
            f"independent [{independent_text}], limit={STAGE_POSE_MAX_RMS_PX:.3f}px"
        )
        if reason == "screen geometry inconsistency":
            from vpcal.core.errors import ScreenGeometryInconsistent
            raise ScreenGeometryInconsistent(
                message,
                details={
                    "combined_rms_px": rms,
                    "rms_by_screen": rms_by_target,
                    "independent_rms_by_screen": independent_rms_by_target,
                },
            )
        raise ValueError(message)

    return StagePoseResult(
        camera_from_stage=ScreenPose(rvec=rvec, tvec=tvec),
        rms_reprojection_px=rms,
        num_markers=len(obj_pts),
        num_inliers=len(keep),
        markers_by_target=markers_by_target,
        inliers_by_target=inliers_by_target,
        rms_by_target=rms_by_target,
        independent_rms_by_target=independent_rms_by_target,
        screen_to_screen_consistency={
            "consistent": True,
            "max_camera_translation_delta_mm": max_translation_mm,
            "max_camera_rotation_delta_deg": max_rotation_deg,
        },
        rejected_observations={
            "low_confidence": low_confidence,
            "brightness_warning": brightness_warnings,
            "localization_rejected": localization_rejected,
        },
        preflight={
            "homography_by_screen": homography_by_target,
            "joint_projective": joint_projective,
            "passed": True,
        },
    )


@dataclass
class ExportedScreen:
    name: str
    vertices: NDArray[np.float64]  # 4×3, meters


def export_obj(
    spatial_json: Path,
    screen_a: ScreenDefinition,
    screen_b: ScreenDefinition,
    out_dir: Path,
    *,
    root: str = "b",
) -> list[ExportedScreen]:
    """Export calibrated screen meshes as OBJ files in disguise coordinate system.

    The *root* screen is placed at the origin with its plane aligned to
    the XY plane (normal = +Z).  The other screen is positioned relative
    to it using the spatial calibration result.

    Args:
        root: "a" or "b" — which screen is the world-origin reference.
    """
    import json as _json

    sp = _json.loads(spatial_json.read_text())
    M_rel = np.array(sp["screen_b_relative"]["matrix_4x4"])  # A←B, mm
    M_rel_m = M_rel.copy()
    M_rel_m[:3, 3] /= 1000.0  # mm → m

    sa = screen_a.sections[0]
    sb = screen_b.sections[0]
    wa = sa.u_extent_mm() / 1000.0
    ha = sa.v_extent_mm() / 1000.0
    wb = sb.u_extent_mm() / 1000.0
    hb = sb.v_extent_mm() / 1000.0

    def _quad(w: float, h: float) -> NDArray[np.float64]:
        return np.array([[-w/2, 0, 0], [w/2, 0, 0], [-w/2, h, 0], [w/2, h, 0]])

    verts_a_local = _quad(wa, ha)
    verts_b_local = _quad(wb, hb)

    if root == "b":
        M_inv = np.linalg.inv(M_rel_m)
        verts_b = verts_b_local
        verts_a = (M_inv[:3, :3] @ verts_a_local.T).T + M_inv[:3, 3]
    else:
        verts_a = verts_a_local
        verts_b = (M_rel_m[:3, :3] @ verts_b_local.T).T + M_rel_m[:3, 3]

    out_dir.mkdir(parents=True, exist_ok=True)
    screens = [
        ExportedScreen(screen_a.name, verts_a),
        ExportedScreen(screen_b.name, verts_b),
    ]
    names_seen: set[str] = set()
    for scr in screens:
        slug = scr.name.replace(" ", "_")
        if slug in names_seen:
            slug += "_B"
        names_seen.add(slug)
        _write_obj(out_dir / f"{slug}.obj", scr.vertices, scr.name)
    return screens


def _write_obj(path: Path, verts: NDArray[np.float64], name: str) -> None:
    with open(path, "w") as f:
        f.write(f"# vpcal tracker-free calibration export\n")
        f.write(f"# Target: disguise (right-hand, +Y up, m)\n")
        f.write(f"# Screen: {name}\n")
        f.write(f"# Vertices: 4\n")
        f.write(f"# Triangles: 2\n\n")
        for v in verts:
            f.write(f"v {v[0]:.6f} {v[1]:.6f} {v[2]:.6f}\n")
        f.write("vt 0 0\nvt 1 0\nvt 0 1\nvt 1 1\n")
        f.write("g screen_mesh\n")
        f.write("f 1/1 2/2 4/4\nf 1/1 4/4 3/3\n")
