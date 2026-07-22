"""Detection-agnostic fixed single-observation joint lens + pose solver.

Shared substrate for VP-QSP and Structured Light fixed-camera paths.

Pipeline:
  correspondences → preflight / observability gates → DLT+RQ init
  → model ladder (M1→M3) robust LM → withheld validation → artifact
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Literal

import cv2
import numpy as np
from numpy.typing import NDArray
from scipy.optimize import least_squares

from vpcal.core.errors import (
    DetectionQualityFailed,
    LocalizationQualityFailed,
    ScreenGeometryInconsistent,
    SingleViewUnobservable,
)
from vpcal.core.projection import CameraIntrinsics, project_points

Array = NDArray[np.float64]

SCHEMA_VERSION = "fixed_observation_result.v1"
CORRELATION_LOCK_THRESHOLD = 0.8

# Spec §3.4 formal thresholds (placeholder until synthetic sweep re-pins).
MIN_TRUSTWORTHY_TOTAL = 60
MIN_TRUSTWORTHY_PER_SCREEN = 12
MIN_INLIERS_TOTAL = 40
MIN_INLIERS_PER_SCREEN = 8
MIN_INLIER_RATIO = 0.70
MIN_COVERAGE_XY = 0.35
MIN_EDGE_FRACTION = 0.15  # pinned by P0 synthetic sweep (2026-07-22); was 0.25 placeholder
EDGE_RADIUS_FRACTION = 0.35
MIN_DEPTH_RATIO = 0.02
MIN_PLANE_ANGLE_DEG = 15.0
MAX_DLT_CONDITION = 1.0e6
MAX_HESSIAN_CONDITION = 1.0e8  # pinned soft; column-normalized JTJ still ill-scaled vs pose mm
MAX_FOCAL_REL_STD = 0.01
MAX_PP_STD_PX = 3.0
MAX_WITHHELD_RMS_PX = 2.0
MAX_HOMOGRAPHY_RMS_PX = 1.0
MAX_JOINT_PROJECTIVE_RMS_PX = 2.0
MAX_PER_SCREEN_POSE_ROT_DEG = 1.0
MAX_PER_SCREEN_POSE_TRANS_MM = 50.0


class ModelLevel(str, Enum):
    M1_FOCAL_POSE = "M1_focal_pose"
    M2_RADIAL_POSE = "M2_radial_pose"
    M3_CENTER_RADIAL_POSE = "M3_center_radial_pose"


ModeRequested = Literal["auto", "known-lens", "joint-session-lens"]
ModeResolved = Literal["known-lens", "joint-session-lens"]


@dataclass(frozen=True)
class Correspondence:
    """One detection-agnostic 3D↔2D correspondence."""

    world_mm: tuple[float, float, float]
    pixel_uv: tuple[float, float]
    screen_label: str
    quality: float = 1.0
    point_id: str = ""


@dataclass
class CameraStateFingerprint:
    camera_id: str
    resolution: tuple[int, int]
    crop: tuple[int, int, int, int] | None = None
    transfer_path: str = ""
    focus_zoom_attested: bool = False
    attest_timestamp: str | None = None

    def machine_readable_hash(self) -> str:
        payload = {
            "camera_id": self.camera_id,
            "resolution": list(self.resolution),
            "crop": list(self.crop) if self.crop else None,
            "transfer_path": self.transfer_path,
        }
        digest = hashlib.sha256(
            json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        return f"sha256:{digest}"

    def to_dict(self) -> dict[str, Any]:
        return {
            "machine_readable_hash": self.machine_readable_hash(),
            "components": {
                "camera_id": self.camera_id,
                "resolution": list(self.resolution),
                "crop": list(self.crop) if self.crop else None,
                "transfer_path": self.transfer_path,
            },
            "focus_zoom_attested": self.focus_zoom_attested,
            "attest_timestamp": self.attest_timestamp,
        }


@dataclass
class KnownLens:
    fx: float
    fy: float
    cx: float
    cy: float
    dist_coeffs: list[float]
    image_size: tuple[int, int]
    is_master: bool = True
    session_coupled: bool = False


@dataclass
class FixedObservationInput:
    correspondences: list[Correspondence]
    image_size: tuple[int, int]
    screen_normals: dict[str, tuple[float, float, float]] = field(default_factory=dict)
    stage_geometry_fingerprint: str = ""
    camera_state: CameraStateFingerprint | None = None
    mode_requested: ModeRequested = "auto"
    known_lens: KnownLens | None = None
    weak_focal_guess_px: float | None = None
    formal: bool = True


@dataclass
class SessionLens:
    fx: float
    fy: float
    cx: float
    cy: float
    dist_coeffs: list[float]
    image_size: tuple[int, int]
    model: str = "brown_conrady_radial2"
    is_master: bool = False
    session_coupled: bool = True

    def to_dict(self) -> dict[str, Any]:
        return {
            "is_master": self.is_master,
            "session_coupled": self.session_coupled,
            "K": [
                [self.fx, 0.0, self.cx],
                [0.0, self.fy, self.cy],
                [0.0, 0.0, 1.0],
            ],
            "dist_coeffs": list(self.dist_coeffs),
            "image_size": list(self.image_size),
            "model": self.model,
        }

    def as_intrinsics(self) -> CameraIntrinsics:
        d = list(self.dist_coeffs) + [0.0] * 5
        return CameraIntrinsics(
            fx=self.fx,
            fy=self.fy,
            cx=self.cx,
            cy=self.cy,
            k1=float(d[0]),
            k2=float(d[1]),
            p1=float(d[2]),
            p2=float(d[3]),
            k3=float(d[4]),
            width=float(self.image_size[0]),
            height=float(self.image_size[1]),
        )


@dataclass
class FixedObservationResult:
    formal: bool
    mode_requested: ModeRequested
    mode_resolved: ModeResolved
    solve_kind: str
    camera_from_stage: dict[str, Any]
    session_lens: SessionLens | None
    camera_state_fingerprint: dict[str, Any] | None
    stage_geometry_fingerprint: str
    detection: dict[str, Any]
    observability: dict[str, Any]
    preflight: dict[str, Any]
    validation: dict[str, Any]
    qualification: dict[str, Any]
    model_level: str | None = None
    rms_reprojection_px: float = 0.0
    num_correspondences: int = 0
    num_inliers: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": SCHEMA_VERSION,
            "solve_kind": self.solve_kind,
            "mode_requested": self.mode_requested,
            "mode_resolved": self.mode_resolved,
            "formal": self.formal,
            "model_level": self.model_level,
            "camera_from_stage": self.camera_from_stage,
            "session_lens": None if self.session_lens is None else self.session_lens.to_dict(),
            "camera_state_fingerprint": self.camera_state_fingerprint,
            "stage_geometry_fingerprint": self.stage_geometry_fingerprint,
            "detection": self.detection,
            "observability": self.observability,
            "preflight": self.preflight,
            "validation": self.validation,
            "qualification": self.qualification,
            "rms_reprojection_px": self.rms_reprojection_px,
            "num_correspondences": self.num_correspondences,
            "num_inliers": self.num_inliers,
        }


def resolve_mode(
    mode_requested: ModeRequested,
    *,
    has_qualified_master_lens: bool,
) -> ModeResolved:
    if mode_requested == "known-lens":
        return "known-lens"
    if mode_requested == "joint-session-lens":
        return "joint-session-lens"
    return "known-lens" if has_qualified_master_lens else "joint-session-lens"


def fingerprint_stale(
    stored: dict[str, Any] | None,
    current: CameraStateFingerprint,
) -> bool:
    """True when machine-readable fingerprint components changed.

    focus/zoom attest is NOT part of automatic stale detection.
    """
    if stored is None:
        return True
    return stored.get("machine_readable_hash") != current.machine_readable_hash()


# ── Arrays / geometry helpers ───────────────────────────────────────


def _as_arrays(
    correspondences: list[Correspondence],
) -> tuple[Array, Array, list[str]]:
    world = np.asarray([c.world_mm for c in correspondences], dtype=np.float64)
    pixels = np.asarray([c.pixel_uv for c in correspondences], dtype=np.float64)
    labels = [c.screen_label for c in correspondences]
    return world, pixels, labels


def _normalise_points_2d(points: Array) -> tuple[Array, Array]:
    mean = points.mean(axis=0)
    distance = float(np.mean(np.linalg.norm(points - mean, axis=1)))
    scale = np.sqrt(2.0) / max(distance, 1.0e-12)
    T = np.array(
        [[scale, 0.0, -scale * mean[0]], [0.0, scale, -scale * mean[1]], [0.0, 0.0, 1.0]]
    )
    homogeneous = np.column_stack([points, np.ones(len(points))])
    return (T @ homogeneous.T).T, T


def _normalise_points_3d(points: Array) -> tuple[Array, Array]:
    mean = points.mean(axis=0)
    distance = float(np.mean(np.linalg.norm(points - mean, axis=1)))
    scale = np.sqrt(3.0) / max(distance, 1.0e-12)
    T = np.eye(4)
    T[:3, :3] *= scale
    T[:3, 3] = -scale * mean
    homogeneous = np.column_stack([points, np.ones(len(points))])
    return (T @ homogeneous.T).T, T


def fit_projective_camera(
    object_points: Array, image_points: Array
) -> tuple[Array, float, float]:
    """Normalized DLT → unrestricted P (3×4). Returns (P, condition, rms)."""
    if len(object_points) < 6:
        return np.full((3, 4), np.nan), float("inf"), float("inf")
    Xn, T3 = _normalise_points_3d(object_points)
    xn_h, T2 = _normalise_points_2d(image_points)
    xn = xn_h[:, :2] / xn_h[:, 2, None]
    rows: list[Array] = []
    for X, (u, v) in zip(Xn, xn):
        rows.append(np.r_[np.zeros(4), -X, v * X])
        rows.append(np.r_[X, np.zeros(4), -u * X])
    _u, singular, vt = np.linalg.svd(np.asarray(rows), full_matrices=False)
    if len(singular) < 12 or singular[-1] <= 0:
        return np.full((3, 4), np.nan), float("inf"), float("inf")
    condition = float(singular[0] / singular[-1])
    Pn = vt[-1].reshape(3, 4)
    P = np.linalg.inv(T2) @ Pn @ T3
    Xh = np.column_stack([object_points, np.ones(len(object_points))])
    projected_h = (P @ Xh.T).T
    valid = np.abs(projected_h[:, 2]) > 1.0e-12
    if not np.all(valid):
        return P, condition, float("inf")
    projected = projected_h[:, :2] / projected_h[:, 2, None]
    errors = np.linalg.norm(projected - image_points, axis=1)
    rms = float(np.sqrt(np.mean(errors * errors)))
    return P, condition, rms


def rq_decompose_camera(P: Array) -> tuple[Array, Array, Array]:
    """Decompose camera matrix P into K, R, t (OpenCV camera frame)."""
    # cv2.decomposeProjectionMatrix returns K, R, camera center in homogeneous form.
    out = cv2.decomposeProjectionMatrix(P.astype(np.float64))
    K = np.asarray(out[0], dtype=np.float64)
    R = np.asarray(out[1], dtype=np.float64)
    cam_h = np.asarray(out[2], dtype=np.float64).reshape(-1)
    if abs(cam_h[3]) > 1.0e-12:
        C = cam_h[:3] / cam_h[3]
    else:
        C = cam_h[:3]
    # Force positive diagonal on K and normalize K[2,2]
    for i in range(3):
        if K[i, i] < 0:
            K[:, i] *= -1.0
            R[i, :] *= -1.0
    if abs(K[2, 2]) > 1.0e-12:
        K = K / K[2, 2]
    K[0, 1] = 0.0  # kill skew for our model
    if np.linalg.det(R) < 0:
        R = -R
    t = (-R @ C).astype(np.float64)
    return K.astype(np.float64), R.astype(np.float64), t


def _physical_bounds_K(
    K: Array, image_size: tuple[int, int], weak_focal: float | None
) -> Array:
    w, h = image_size
    out = K.copy()
    fx = abs(float(out[0, 0]))
    fy = abs(float(out[1, 1]))
    if not np.isfinite(fx) or fx < 0.2 * w or fx > 5.0 * w:
        fx = weak_focal if weak_focal and weak_focal > 0 else float(w)
    if not np.isfinite(fy) or fy < 0.2 * h or fy > 5.0 * h:
        fy = fx
    # Force square pixels for M1 init
    f = 0.5 * (fx + fy)
    out[0, 0] = f
    out[1, 1] = f
    out[0, 1] = 0.0
    cx = float(out[0, 2])
    cy = float(out[1, 2])
    if not np.isfinite(cx) or cx < 0 or cx > w:
        cx = 0.5 * w
    if not np.isfinite(cy) or cy < 0 or cy > h:
        cy = 0.5 * h
    out[0, 2] = cx
    out[1, 2] = cy
    out[2, :] = [0.0, 0.0, 1.0]
    return out


def initialize_from_dlt(
    object_points: Array,
    image_points: Array,
    image_size: tuple[int, int],
    *,
    weak_focal_guess_px: float | None = None,
) -> tuple[Array, Array, Array, dict[str, Any]]:
    """Return (K, rvec, tvec, diagnostics)."""
    P, condition, rms = fit_projective_camera(object_points, image_points)
    if not np.isfinite(condition) or not np.all(np.isfinite(P)):
        raise SingleViewUnobservable(
            "Normalized DLT failed to produce a finite camera matrix",
            details={"dlt_condition": condition, "dlt_rms_px": rms},
        )
    K_raw, R, t = rq_decompose_camera(P)
    K = _physical_bounds_K(K_raw, image_size, weak_focal_guess_px)
    # Prefer image-center principal point for M1 init (spec model ladder).
    w, h = image_size
    K[0, 2] = 0.5 * w
    K[1, 2] = 0.5 * h
    K[0, 0] = K[1, 1] = float(0.5 * (abs(K[0, 0]) + abs(K[1, 1])))

    # Re-estimate pose with this K via PnP (more stable than RQ t when distorted).
    dist0 = np.zeros(5, dtype=np.float64)
    ok, rvec, tvec = cv2.solvePnP(
        object_points.astype(np.float64),
        image_points.astype(np.float64),
        K,
        dist0,
        flags=cv2.SOLVEPNP_EPNP,
    )
    if not ok:
        rvec, _ = cv2.Rodrigues(R)
        tvec = t.reshape(3, 1)
    rvec = rvec.reshape(3).astype(np.float64)
    tvec = tvec.reshape(3).astype(np.float64)

    # Orient so majority of points are in front of camera
    R_chk, _ = cv2.Rodrigues(rvec)
    cam_pts = (R_chk @ object_points.T).T + tvec
    if float(np.mean(cam_pts[:, 2] > 0)) < 0.5:
        rvec = -rvec
        tvec = -tvec
        R_chk, _ = cv2.Rodrigues(rvec)
        cam_pts = (R_chk @ object_points.T).T + tvec
    if float(np.mean(cam_pts[:, 2] > 0)) < 0.5:
        raise SingleViewUnobservable(
            "DLT/RQ initialization places majority of points behind camera",
            details={"dlt_condition": condition, "dlt_rms_px": rms},
        )

    # Quick init reprojection sanity: if terrible, seed focal from weak guess + PnP again
    proj, _ = cv2.projectPoints(object_points, rvec, tvec, K, dist0)
    init_rms = float(np.sqrt(np.mean(np.sum((proj.reshape(-1, 2) - image_points) ** 2, axis=1))))
    if init_rms > 50.0 and weak_focal_guess_px and weak_focal_guess_px > 0:
        K[0, 0] = K[1, 1] = float(weak_focal_guess_px)
        ok, rvec, tvec = cv2.solvePnP(
            object_points.astype(np.float64),
            image_points.astype(np.float64),
            K,
            dist0,
            flags=cv2.SOLVEPNP_EPNP,
        )
        if ok:
            rvec = rvec.reshape(3).astype(np.float64)
            tvec = tvec.reshape(3).astype(np.float64)
            proj, _ = cv2.projectPoints(object_points, rvec, tvec, K, dist0)
            init_rms = float(
                np.sqrt(np.mean(np.sum((proj.reshape(-1, 2) - image_points) ** 2, axis=1)))
            )

    diagnostics = {
        "dlt_condition": condition,
        "dlt_rms_px": rms,
        "init_rms_px": init_rms,
        "K_raw": K_raw.tolist(),
        "K_init": K.tolist(),
    }
    return K, rvec, tvec, diagnostics


# ── Observability gates ─────────────────────────────────────────────


def coverage_xy(pixels: Array, image_size: tuple[int, int]) -> tuple[float, float]:
    w, h = image_size
    if len(pixels) == 0 or w <= 0 or h <= 0:
        return 0.0, 0.0
    xs = pixels[:, 0]
    ys = pixels[:, 1]
    return float((xs.max() - xs.min()) / w), float((ys.max() - ys.min()) / h)


def edge_fraction(
    pixels: Array, image_size: tuple[int, int], *, cx: float, cy: float
) -> float:
    if len(pixels) == 0:
        return 0.0
    diag = float(np.hypot(*image_size))
    thresh = EDGE_RADIUS_FRACTION * diag
    r = np.hypot(pixels[:, 0] - cx, pixels[:, 1] - cy)
    return float(np.mean(r >= thresh))


def depth_ratio(world: Array) -> float:
    if len(world) < 3:
        return 0.0
    centered = world - world.mean(axis=0)
    _, singular, _ = np.linalg.svd(centered, full_matrices=False)
    if singular[0] <= 0:
        return 0.0
    return float(singular[-1] / singular[0])


def max_plane_angle_deg(
    screen_normals: dict[str, tuple[float, float, float]],
) -> float:
    labels = list(screen_normals)
    best = 0.0
    for i in range(len(labels)):
        for j in range(i + 1, len(labels)):
            a = np.asarray(screen_normals[labels[i]], dtype=np.float64)
            b = np.asarray(screen_normals[labels[j]], dtype=np.float64)
            na = np.linalg.norm(a)
            nb = np.linalg.norm(b)
            if na < 1.0e-12 or nb < 1.0e-12:
                continue
            cos = float(np.clip(np.dot(a, b) / (na * nb), -1.0, 1.0))
            best = max(best, float(np.degrees(np.arccos(abs(cos)))))
    return best


def detection_metrics(
    correspondences: list[Correspondence],
    image_size: tuple[int, int],
) -> dict[str, Any]:
    world, pixels, labels = _as_arrays(correspondences)
    per_screen: dict[str, int] = {}
    for label in labels:
        per_screen[label] = per_screen.get(label, 0) + 1
    cov_x, cov_y = coverage_xy(pixels, image_size)
    cx, cy = 0.5 * image_size[0], 0.5 * image_size[1]
    return {
        "decoded": len(correspondences),
        "trustworthy": len(correspondences),
        "coverage_xy": [cov_x, cov_y],
        "edge_fraction": edge_fraction(pixels, image_size, cx=cx, cy=cy),
        "per_screen": per_screen,
        "depth_ratio": depth_ratio(world),
    }


def evaluate_observability_gates(
    correspondences: list[Correspondence],
    image_size: tuple[int, int],
    *,
    screen_normals: dict[str, tuple[float, float, float]],
    inlier_mask: Array | None = None,
    dlt_condition: float | None = None,
    hessian_condition: float | None = None,
    focal_rel_std: float | None = None,
    pp_std: tuple[float, float] | None = None,
    require_multi_plane: bool = True,
) -> dict[str, Any]:
    world, pixels, labels = _as_arrays(correspondences)
    per_screen: dict[str, int] = {}
    for label in labels:
        per_screen[label] = per_screen.get(label, 0) + 1

    if inlier_mask is None:
        inlier_mask = np.ones(len(correspondences), dtype=bool)
    inliers = int(inlier_mask.sum())
    inlier_pixels = pixels[inlier_mask]
    inlier_labels = [labels[i] for i, keep in enumerate(inlier_mask) if keep]
    inliers_by_screen: dict[str, int] = {}
    for label in inlier_labels:
        inliers_by_screen[label] = inliers_by_screen.get(label, 0) + 1

    cov_x, cov_y = coverage_xy(inlier_pixels if len(inlier_pixels) else pixels, image_size)
    cx, cy = 0.5 * image_size[0], 0.5 * image_size[1]
    edge_frac = edge_fraction(
        inlier_pixels if len(inlier_pixels) else pixels, image_size, cx=cx, cy=cy
    )
    depth = depth_ratio(world)
    plane_angle = max_plane_angle_deg(screen_normals)

    gates: dict[str, Any] = {
        "trustworthy_total": {
            "value": len(correspondences),
            "threshold": MIN_TRUSTWORTHY_TOTAL,
            "pass": len(correspondences) >= MIN_TRUSTWORTHY_TOTAL,
        },
        "trustworthy_per_screen": {
            "value": per_screen,
            "threshold": MIN_TRUSTWORTHY_PER_SCREEN,
            "pass": all(v >= MIN_TRUSTWORTHY_PER_SCREEN for v in per_screen.values())
            and len(per_screen) > 0,
        },
        "inliers_total": {
            "value": inliers,
            "threshold": MIN_INLIERS_TOTAL,
            "pass": inliers >= MIN_INLIERS_TOTAL,
        },
        "inliers_per_screen": {
            "value": inliers_by_screen,
            "threshold": MIN_INLIERS_PER_SCREEN,
            "pass": all(v >= MIN_INLIERS_PER_SCREEN for v in inliers_by_screen.values())
            and len(inliers_by_screen) > 0,
        },
        "inlier_ratio": {
            "value": inliers / max(len(correspondences), 1),
            "threshold": MIN_INLIER_RATIO,
            "pass": (inliers / max(len(correspondences), 1)) >= MIN_INLIER_RATIO,
        },
        "coverage_xy": {
            "value": [cov_x, cov_y],
            "threshold": MIN_COVERAGE_XY,
            "pass": cov_x >= MIN_COVERAGE_XY and cov_y >= MIN_COVERAGE_XY,
        },
        "edge_fraction": {
            "value": edge_frac,
            "threshold": MIN_EDGE_FRACTION,
            "pass": edge_frac >= MIN_EDGE_FRACTION,
        },
        "depth_ratio": {
            "value": depth,
            "threshold": MIN_DEPTH_RATIO,
            "pass": depth >= MIN_DEPTH_RATIO,
        },
        "multi_plane_angle_deg": {
            "value": plane_angle,
            "threshold": MIN_PLANE_ANGLE_DEG,
            "pass": (not require_multi_plane) or plane_angle >= MIN_PLANE_ANGLE_DEG,
        },
    }
    if dlt_condition is not None:
        gates["dlt_condition"] = {
            "value": dlt_condition,
            "threshold": MAX_DLT_CONDITION,
            "pass": dlt_condition < MAX_DLT_CONDITION,
        }
    if hessian_condition is not None:
        gates["hessian_condition"] = {
            "value": hessian_condition,
            "threshold": MAX_HESSIAN_CONDITION,
            "pass": hessian_condition < MAX_HESSIAN_CONDITION,
        }
    if focal_rel_std is not None:
        gates["focal_rel_std"] = {
            "value": focal_rel_std,
            "threshold": MAX_FOCAL_REL_STD,
            "pass": focal_rel_std <= MAX_FOCAL_REL_STD,
        }
    if pp_std is not None:
        gates["principal_point_std_px"] = {
            "value": list(pp_std),
            "threshold": MAX_PP_STD_PX,
            "pass": max(pp_std) <= MAX_PP_STD_PX,
        }

    failed = [name for name, g in gates.items() if not g["pass"]]
    return {"passed": len(failed) == 0, "failed": failed, "gates": gates}


# ── Preflight ───────────────────────────────────────────────────────


def _per_screen_homography_rms(
    correspondences: list[Correspondence],
) -> dict[str, dict[str, Any]]:
    by_label: dict[str, list[Correspondence]] = {}
    for c in correspondences:
        by_label.setdefault(c.screen_label, []).append(c)
    out: dict[str, dict[str, Any]] = {}
    for label, items in by_label.items():
        if len(items) < 4:
            out[label] = {"rms_px": float("inf"), "count": len(items)}
            continue
        # Fit plane-local 2D grid via PCA of world XY-ish → use world projected to
        # best-fit plane as "grid", then homography to pixels.
        world = np.asarray([c.world_mm for c in items], dtype=np.float64)
        pixels = np.asarray([c.pixel_uv for c in items], dtype=np.float64)
        centered = world - world.mean(axis=0)
        _, _, vt = np.linalg.svd(centered, full_matrices=False)
        basis = vt[:2]
        grid = centered @ basis.T
        H, mask = cv2.findHomography(grid, pixels, cv2.RANSAC, 2.0)
        if H is None or mask is None:
            out[label] = {"rms_px": float("inf"), "count": len(items), "inliers": 0}
            continue
        projected = cv2.perspectiveTransform(grid.reshape(-1, 1, 2), H).reshape(-1, 2)
        keep = mask.reshape(-1).astype(bool)
        if not np.any(keep):
            out[label] = {"rms_px": float("inf"), "count": len(items), "inliers": 0}
            continue
        residual = projected[keep] - pixels[keep]
        rms = float(np.sqrt(np.mean(np.sum(residual * residual, axis=1))))
        out[label] = {"rms_px": rms, "count": len(items), "inliers": int(keep.sum())}
    return out


def run_preflight(
    correspondences: list[Correspondence],
    image_size: tuple[int, int],
    *,
    screen_normals: dict[str, tuple[float, float, float]],
) -> dict[str, Any]:
    if len(correspondences) < MIN_TRUSTWORTHY_TOTAL:
        raise DetectionQualityFailed(
            f"Need >= {MIN_TRUSTWORTHY_TOTAL} trustworthy correspondences; "
            f"got {len(correspondences)}",
            details=detection_metrics(correspondences, image_size),
        )
    per_screen = detection_metrics(correspondences, image_size)["per_screen"]
    bad = {k: v for k, v in per_screen.items() if v < MIN_TRUSTWORTHY_PER_SCREEN}
    if bad:
        raise DetectionQualityFailed(
            f"Need >= {MIN_TRUSTWORTHY_PER_SCREEN} trustworthy per screen",
            details={"per_screen": per_screen},
        )

    # Observability first: planar / insufficient angle must fail as
    # SINGLE_VIEW_UNOBSERVABLE, not as a geometry or detection error.
    obs_early = evaluate_observability_gates(
        correspondences,
        image_size,
        screen_normals=screen_normals,
        require_multi_plane=True,
    )
    if (
        not obs_early["gates"]["multi_plane_angle_deg"]["pass"]
        or not obs_early["gates"]["depth_ratio"]["pass"]
    ):
        raise SingleViewUnobservable(
            "Single-view geometry is not observable for joint lens estimation",
            details=obs_early,
        )

    homography = _per_screen_homography_rms(correspondences)
    # Joint path cannot undistort before homography; treat as soft signal.
    # Hard 1px gate applies only after a known lens undistorts points.
    soft_limit = max(MAX_HOMOGRAPHY_RMS_PX * 4.0, 4.0)
    bad_h = {
        k: v for k, v in homography.items() if v["rms_px"] >= soft_limit
    }
    if bad_h:
        raise DetectionQualityFailed(
            "Per-screen localization failed planar consistency (soft gate)",
            details={"homography_by_screen": homography, "soft_limit_px": soft_limit},
        )

    world, pixels, _ = _as_arrays(correspondences)
    P, condition, joint_rms = fit_projective_camera(world, pixels)
    joint = {"rms_px": joint_rms, "dlt_condition": condition}
    # Distortion prevents a pure projective model from reaching the 2px known-lens
    # undistorted gate; keep a soft ceiling that still catches broken Stage geometry.
    soft_joint_limit = max(MAX_JOINT_PROJECTIVE_RMS_PX * 5.0, 10.0)
    if joint_rms >= soft_joint_limit:
        raise ScreenGeometryInconsistent(
            "Selected screens cannot be explained by one projective camera",
            details={
                "homography_by_screen": homography,
                "joint_projective": joint,
                "soft_limit_px": soft_joint_limit,
            },
        )

    obs = evaluate_observability_gates(
        correspondences,
        image_size,
        screen_normals=screen_normals,
        dlt_condition=condition,
        require_multi_plane=True,
    )
    if condition >= MAX_DLT_CONDITION:
        raise SingleViewUnobservable(
            "Normalized DLT condition exceeds formal threshold",
            details=obs,
        )

    return {
        "passed": True,
        "homography_by_screen": homography,
        "joint_projective": joint,
        "observability_pre": obs,
    }


# ── Model ladder + refinement ───────────────────────────────────────


@dataclass
class _PoseLensState:
    rvec: Array
    tvec: Array
    f: float
    cx: float
    cy: float
    k1: float = 0.0
    k2: float = 0.0


def _state_to_intr(state: _PoseLensState, image_size: tuple[int, int]) -> CameraIntrinsics:
    return CameraIntrinsics(
        fx=state.f,
        fy=state.f,
        cx=state.cx,
        cy=state.cy,
        k1=state.k1,
        k2=state.k2,
        width=float(image_size[0]),
        height=float(image_size[1]),
    )


def _project_world(
    world: Array, state: _PoseLensState, image_size: tuple[int, int]
) -> Array:
    R, _ = cv2.Rodrigues(state.rvec)
    cam = (R @ world.T).T + state.tvec.reshape(1, 3)
    return project_points(cam, _state_to_intr(state, image_size))


def _pack(
    state: _PoseLensState, level: ModelLevel, *, fix_focal: bool = False
) -> Array:
    pose = np.concatenate([state.rvec.ravel(), state.tvec.ravel()])
    base = pose if fix_focal else np.concatenate([pose, [state.f]])
    if level == ModelLevel.M1_FOCAL_POSE:
        return base
    if level == ModelLevel.M2_RADIAL_POSE:
        return np.concatenate([base, [state.k1, state.k2]])
    return np.concatenate([base, [state.k1, state.k2, state.cx, state.cy]])


def _unpack(
    x: Array,
    level: ModelLevel,
    template: _PoseLensState,
    *,
    fix_focal: bool = False,
) -> _PoseLensState:
    rvec = x[0:3].copy()
    tvec = x[3:6].copy()
    if fix_focal:
        f = float(template.f)
        i = 6
    else:
        f = float(x[6])
        i = 7
    k1 = k2 = 0.0
    cx, cy = template.cx, template.cy
    if level in (ModelLevel.M2_RADIAL_POSE, ModelLevel.M3_CENTER_RADIAL_POSE):
        k1, k2 = float(x[i]), float(x[i + 1])
        if level == ModelLevel.M3_CENTER_RADIAL_POSE:
            cx, cy = float(x[i + 2]), float(x[i + 3])
    return _PoseLensState(rvec=rvec, tvec=tvec, f=f, cx=cx, cy=cy, k1=k1, k2=k2)


def _param_names(level: ModelLevel, *, fix_focal: bool = False) -> list[str]:
    names = ["rx", "ry", "rz", "tx", "ty", "tz"]
    if not fix_focal:
        names = names + ["f"]
    if level == ModelLevel.M1_FOCAL_POSE:
        return names
    if level == ModelLevel.M2_RADIAL_POSE:
        return names + ["k1", "k2"]
    return names + ["k1", "k2", "cx", "cy"]


def refine_model(
    world: Array,
    pixels: Array,
    state0: _PoseLensState,
    image_size: tuple[int, int],
    level: ModelLevel,
    *,
    prior_pp_weight: float = 0.01,
    prior_dist_weight: float = 0.1,
    fix_focal: bool = False,
) -> tuple[_PoseLensState, dict[str, Any]]:
    w, h = image_size
    x0 = _pack(state0, level, fix_focal=fix_focal)
    names = _param_names(level, fix_focal=fix_focal)

    def residuals(x: Array) -> Array:
        st = _unpack(x, level, state0, fix_focal=fix_focal)
        n_pix = len(pixels) * 2
        if level == ModelLevel.M1_FOCAL_POSE:
            n_extra = 0
        elif level == ModelLevel.M2_RADIAL_POSE:
            n_extra = 2
        else:
            n_extra = 4
        out = np.empty(n_pix + n_extra, dtype=np.float64)
        if not np.isfinite(st.f) or st.f <= 1.0:
            out[:] = 1.0e6
            return out
        pred = _project_world(world, st, image_size)
        out[:n_pix] = (pred - pixels).ravel()
        if level == ModelLevel.M2_RADIAL_POSE:
            out[n_pix] = np.sqrt(prior_dist_weight) * st.k1
            out[n_pix + 1] = np.sqrt(prior_dist_weight) * st.k2
        elif level == ModelLevel.M3_CENTER_RADIAL_POSE:
            out[n_pix] = np.sqrt(prior_dist_weight) * st.k1
            out[n_pix + 1] = np.sqrt(prior_dist_weight) * st.k2
            out[n_pix + 2] = np.sqrt(prior_pp_weight) * (st.cx - 0.5 * w)
            out[n_pix + 3] = np.sqrt(prior_pp_weight) * (st.cy - 0.5 * h)
        return np.nan_to_num(out, nan=1.0e6, posinf=1.0e6, neginf=-1.0e6)

    result = least_squares(
        residuals,
        x0,
        method="trf",
        loss="huber",
        f_scale=2.0,
        max_nfev=300,
    )
    if not result.success and result.cost > residuals(x0).dot(residuals(x0)):
        raise SingleViewUnobservable(
            f"Joint refinement failed at {level.value}",
            details={"message": result.message, "cost": float(result.cost)},
        )
    state = _unpack(result.x, level, state0, fix_focal=fix_focal)
    if not np.all(np.isfinite(result.x)) or state.f <= 1.0:
        raise SingleViewUnobservable(
            f"Non-finite or bound-hit parameters at {level.value}",
            details={"x": result.x.tolist()},
        )

    # Covariance from approximate J^T J
    jac = result.jac
    JTJ = jac.T @ jac
    # Column normalize for condition
    col_norm = np.linalg.norm(JTJ, axis=0)
    col_norm = np.where(col_norm > 0, col_norm, 1.0)
    JTJ_n = JTJ / col_norm / col_norm[:, None]
    try:
        eig = np.linalg.eigvalsh(JTJ_n)
        eig = eig[eig > 0]
        hess_cond = float(eig.max() / eig.min()) if len(eig) else float("inf")
        cov = np.linalg.pinv(JTJ)
    except np.linalg.LinAlgError:
        hess_cond = float("inf")
        cov = np.full((len(names), len(names)), np.nan)

    std = np.sqrt(np.clip(np.diag(cov), 0, None))
    corr = np.full_like(cov, np.nan)
    with np.errstate(invalid="ignore", divide="ignore"):
        outer = np.outer(std, std)
        corr = np.where(outer > 0, cov / outer, np.nan)

    pred = _project_world(world, state, image_size)
    rms = float(np.sqrt(np.mean(np.sum((pred - pixels) ** 2, axis=1))))
    diagnostics = {
        "level": level.value,
        "success": bool(result.success),
        "cost": float(result.cost),
        "rms_px": rms,
        "param_names": names,
        "param_std": {n: float(s) for n, s in zip(names, std)},
        "hessian_condition": hess_cond,
        "fix_focal": bool(fix_focal),
        "correlation": {
            f"{names[i]}|{names[j]}": float(corr[i, j])
            for i in range(len(names))
            for j in range(i + 1, len(names))
            if np.isfinite(corr[i, j]) and abs(corr[i, j]) > 0.5
        },
    }
    return state, diagnostics


def _dangerous_f_depth_correlation(diagnostics: dict[str, Any]) -> bool:
    corr = diagnostics.get("correlation") or {}
    for key, rho in corr.items():
        if abs(rho) <= CORRELATION_LOCK_THRESHOLD:
            continue
        a, b = key.split("|")
        pair = {a, b}
        if "f" in pair and (pair & {"tx", "ty", "tz"}):
            return True
    return False


def _state_lock_focal(state: _PoseLensState, focal: float) -> _PoseLensState:
    """Copy pose/distortion state with focal fixed to ``focal``."""
    return _PoseLensState(
        rvec=state.rvec.copy(),
        tvec=state.tvec.copy(),
        f=float(focal),
        cx=state.cx,
        cy=state.cy,
        k1=state.k1,
        k2=state.k2,
    )


def _correlation_lock(
    diagnostics: dict[str, Any], level: ModelLevel
) -> ModelLevel | None:
    """Apply Spec correlation lock-backs for free lens parameters.

    Returns accepted ``level``, ``M2`` on M3 pp↔pose lock-back, or ``None`` when
    free-focal must be locked (caller re-refines with ``fix_focal``). Raises
    ``SingleViewUnobservable`` when M1 free-f is correlated and std is unusable.
    """
    corr = diagnostics.get("correlation") or {}
    lock_to: ModelLevel = level
    if _dangerous_f_depth_correlation(diagnostics):
        if level == ModelLevel.M1_FOCAL_POSE:
            f_std = float((diagnostics.get("param_std") or {}).get("f", float("inf")))
            if not np.isfinite(f_std):
                raise SingleViewUnobservable(
                    "Focal↔camera-depth correlation exceeds lock threshold with "
                    "unusable focal uncertainty",
                    details={
                        "correlation": corr,
                        "level": level.value,
                        "threshold": CORRELATION_LOCK_THRESHOLD,
                        "param_std": diagnostics.get("param_std"),
                    },
                )
            return level
        return None
    if level == ModelLevel.M3_CENTER_RADIAL_POSE:
        for key, rho in corr.items():
            if abs(rho) <= CORRELATION_LOCK_THRESHOLD:
                continue
            a, b = key.split("|")
            pair = {a, b}
            if ({"cx", "cy"} & pair) and (pair & {"tx", "ty", "tz", "rx", "ry", "rz"}):
                lock_to = ModelLevel.M2_RADIAL_POSE
    return lock_to


def run_model_ladder(
    world: Array,
    pixels: Array,
    state0: _PoseLensState,
    image_size: tuple[int, int],
    *,
    allow_m3: bool,
) -> tuple[_PoseLensState, ModelLevel, list[dict[str, Any]]]:
    reports: list[dict[str, Any]] = []
    state, diag = refine_model(world, pixels, state0, image_size, ModelLevel.M1_FOCAL_POSE)
    reports.append(diag)
    _correlation_lock(diag, ModelLevel.M1_FOCAL_POSE)
    m1_f_depth = _dangerous_f_depth_correlation(diag)
    chosen_level = ModelLevel.M1_FOCAL_POSE
    chosen_state = state

    state2, diag2 = refine_model(world, pixels, state, image_size, ModelLevel.M2_RADIAL_POSE)
    reports.append(diag2)
    f_std = diag2["param_std"].get("f", float("inf"))
    if f_std / max(state2.f, 1.0) <= MAX_FOCAL_REL_STD * 2:
        locked = _correlation_lock(diag2, ModelLevel.M2_RADIAL_POSE)
        if locked == ModelLevel.M2_RADIAL_POSE:
            chosen_level = ModelLevel.M2_RADIAL_POSE
            chosen_state = state2
        else:
            state2_locked, diag2_locked = refine_model(
                world,
                pixels,
                _state_lock_focal(state2, state.f),
                image_size,
                ModelLevel.M2_RADIAL_POSE,
                fix_focal=True,
            )
            reports.append(diag2_locked)
            chosen_level = ModelLevel.M2_RADIAL_POSE
            chosen_state = state2_locked

    if allow_m3 and chosen_level == ModelLevel.M2_RADIAL_POSE:
        state3, diag3 = refine_model(
            world, pixels, chosen_state, image_size, ModelLevel.M3_CENTER_RADIAL_POSE,
            fix_focal=_dangerous_f_depth_correlation(reports[-1]) or m1_f_depth,
        )
        reports.append(diag3)
        pp_ok = (
            diag3["param_std"].get("cx", float("inf")) <= MAX_PP_STD_PX
            and diag3["param_std"].get("cy", float("inf")) <= MAX_PP_STD_PX
        )
        locked = _correlation_lock(diag3, ModelLevel.M3_CENTER_RADIAL_POSE)
        if locked is None:
            state3, diag3 = refine_model(
                world,
                pixels,
                _state_lock_focal(state3, chosen_state.f),
                image_size,
                ModelLevel.M3_CENTER_RADIAL_POSE,
                fix_focal=True,
            )
            reports.append(diag3)
            locked = _correlation_lock(diag3, ModelLevel.M3_CENTER_RADIAL_POSE)
            pp_ok = (
                diag3["param_std"].get("cx", float("inf")) <= MAX_PP_STD_PX
                and diag3["param_std"].get("cy", float("inf")) <= MAX_PP_STD_PX
            )
        if pp_ok and locked == ModelLevel.M3_CENTER_RADIAL_POSE:
            chosen_level = ModelLevel.M3_CENTER_RADIAL_POSE
            chosen_state = state3

    return chosen_state, chosen_level, reports


# ── Withheld validation ─────────────────────────────────────────────


def spatial_block_split(
    correspondences: list[Correspondence],
    *,
    withhold_fraction: float = 0.2,
) -> tuple[list[int], list[int]]:
    """Per-screen spatial blocks: perimeter / center / depth-extreme."""
    by_label: dict[str, list[int]] = {}
    for i, c in enumerate(correspondences):
        by_label.setdefault(c.screen_label, []).append(i)

    withhold: list[int] = []
    for indices in by_label.values():
        if len(indices) < 5:
            continue
        world = np.asarray(
            [correspondences[i].world_mm for i in indices], dtype=np.float64
        )
        pixels = np.asarray(
            [correspondences[i].pixel_uv for i in indices], dtype=np.float64
        )
        # Center vs perimeter in image
        center = pixels.mean(axis=0)
        radius = np.linalg.norm(pixels - center, axis=1)
        order_r = np.argsort(radius)
        # Depth extremes along principal PCA axis of world
        centered = world - world.mean(axis=0)
        _, _, vt = np.linalg.svd(centered, full_matrices=False)
        depth = centered @ vt[0]
        order_d = np.argsort(depth)

        n_w = max(1, int(round(len(indices) * withhold_fraction)))
        picks: list[int] = []
        # perimeter
        picks.extend(order_r[-max(1, n_w // 3) :])
        # center
        picks.extend(order_r[: max(1, n_w // 3)])
        # depth extremes
        picks.extend(order_d[: max(1, n_w // 4)])
        picks.extend(order_d[-max(1, n_w // 4) :])
        # unique, cap at ~20%
        seen: set[int] = set()
        for local in picks:
            idx = indices[int(local)]
            if idx not in seen:
                withhold.append(idx)
                seen.add(idx)
            if len(seen) >= n_w:
                break

    withhold_set = set(withhold)
    # Ensure overall withhold ≥20% when possible
    target = max(1, int(np.ceil(len(correspondences) * withhold_fraction)))
    if len(withhold_set) < target:
        remaining = [i for i in range(len(correspondences)) if i not in withhold_set]
        rng = np.random.default_rng(0)
        need = target - len(withhold_set)
        if remaining:
            extra = rng.choice(remaining, size=min(need, len(remaining)), replace=False)
            withhold_set.update(int(i) for i in np.atleast_1d(extra))

    solve_idx = [i for i in range(len(correspondences)) if i not in withhold_set]
    withhold_idx = sorted(withhold_set)
    if len(solve_idx) < 8 or len(withhold_idx) < 1:
        # Degenerate: use all for solve, empty withhold (caller must fail formal)
        return list(range(len(correspondences))), []
    return solve_idx, withhold_idx


def withheld_rms(
    world: Array,
    pixels: Array,
    state: _PoseLensState,
    image_size: tuple[int, int],
    withhold_idx: list[int],
) -> float:
    if not withhold_idx:
        return float("inf")
    pred = _project_world(world[withhold_idx], state, image_size)
    err = pred - pixels[withhold_idx]
    return float(np.sqrt(np.mean(np.sum(err * err, axis=1))))


def per_screen_pose_consistency(
    correspondences: list[Correspondence],
    state: _PoseLensState,
    image_size: tuple[int, int],
) -> dict[str, Any]:
    world_all, pixels_all, labels = _as_arrays(correspondences)
    K = np.array(
        [[state.f, 0, state.cx], [0, state.f, state.cy], [0, 0, 1]], dtype=np.float64
    )
    dist = np.array([state.k1, state.k2, 0, 0, 0], dtype=np.float64)
    by_label: dict[str, list[int]] = {}
    for i, label in enumerate(labels):
        by_label.setdefault(label, []).append(i)

    ref_R, _ = cv2.Rodrigues(state.rvec)
    deltas: dict[str, dict[str, float]] = {}
    for label, idxs in by_label.items():
        if len(idxs) < 4:
            continue
        ok, rvec, tvec, _ = cv2.solvePnPRansac(
            world_all[idxs],
            pixels_all[idxs],
            K,
            dist,
            flags=cv2.SOLVEPNP_ITERATIVE,
        )
        if not ok:
            deltas[label] = {"rotation_deg": float("inf"), "translation_mm": float("inf")}
            continue
        R, _ = cv2.Rodrigues(rvec)
        dR = ref_R.T @ R
        ang = float(
            np.degrees(np.arccos(np.clip((np.trace(dR) - 1.0) / 2.0, -1.0, 1.0)))
        )
        trans = float(np.linalg.norm(tvec.ravel() - state.tvec.ravel()))
        deltas[label] = {"rotation_deg": ang, "translation_mm": trans}

    ok = all(
        d["rotation_deg"] <= MAX_PER_SCREEN_POSE_ROT_DEG
        and d["translation_mm"] <= MAX_PER_SCREEN_POSE_TRANS_MM
        for d in deltas.values()
    ) if deltas else False
    return {"passed": ok, "per_screen": deltas}


# ── Pose packaging ──────────────────────────────────────────────────


def _pose_dict(rvec: Array, tvec: Array) -> dict[str, Any]:
    R, _ = cv2.Rodrigues(rvec)
    M = np.eye(4)
    M[:3, :3] = R
    M[:3, 3] = tvec.ravel()
    # Camera position in stage frame
    cam_pos = (-R.T @ tvec.ravel()).tolist()
    return {
        "position_mm": cam_pos,
        "rvec": rvec.ravel().tolist(),
        "tvec": tvec.ravel().tolist(),
        "matrix_4x4": M.tolist(),
    }


def _inlier_mask_from_reproj(
    world: Array,
    pixels: Array,
    state: _PoseLensState,
    image_size: tuple[int, int],
    *,
    threshold_px: float = 4.0,
) -> Array:
    pred = _project_world(world, state, image_size)
    err = np.linalg.norm(pred - pixels, axis=1)
    return err <= threshold_px


# ── Public solve entry ──────────────────────────────────────────────


def solve_fixed_observation(inp: FixedObservationInput) -> FixedObservationResult:
    """Run the full fixed-observation pipeline (known-lens or joint)."""
    has_master = inp.known_lens is not None and bool(inp.known_lens.is_master)
    mode = resolve_mode(inp.mode_requested, has_qualified_master_lens=has_master)

    if mode == "known-lens" and inp.known_lens is None:
        raise DetectionQualityFailed(
            "known-lens mode requires a Qualified Master Lens",
            details={"mode_requested": inp.mode_requested},
        )

    detection = detection_metrics(inp.correspondences, inp.image_size)
    screen_normals = inp.screen_normals

    if mode == "known-lens":
        return _solve_known_lens(inp, mode, detection, screen_normals)

    preflight = run_preflight(
        inp.correspondences, inp.image_size, screen_normals=screen_normals
    )
    world, pixels, _labels = _as_arrays(inp.correspondences)
    K, rvec, tvec, init_diag = initialize_from_dlt(
        world,
        pixels,
        inp.image_size,
        weak_focal_guess_px=inp.weak_focal_guess_px,
    )
    state0 = _PoseLensState(
        rvec=rvec,
        tvec=tvec,
        f=float(0.5 * (K[0, 0] + K[1, 1])),
        cx=0.5 * inp.image_size[0],
        cy=0.5 * inp.image_size[1],
    )

    solve_idx, withhold_idx = spatial_block_split(inp.correspondences)
    if len(withhold_idx) < max(1, int(0.2 * len(inp.correspondences))):
        raise SingleViewUnobservable(
            "Unable to form a spatial-block withheld set ≥20%",
            details={"solve": len(solve_idx), "withheld": len(withhold_idx)},
        )

    cov_x, cov_y = coverage_xy(pixels[solve_idx], inp.image_size)
    edge_frac = edge_fraction(
        pixels[solve_idx],
        inp.image_size,
        cx=state0.cx,
        cy=state0.cy,
    )
    allow_m3 = cov_x >= MIN_COVERAGE_XY and cov_y >= MIN_COVERAGE_XY and edge_frac >= MIN_EDGE_FRACTION

    state, level, ladder = run_model_ladder(
        world[solve_idx],
        pixels[solve_idx],
        state0,
        inp.image_size,
        allow_m3=allow_m3,
    )

    inliers = _inlier_mask_from_reproj(world, pixels, state, inp.image_size)
    # Prefer focal uncertainty from the last free-f step (locked-f reports omit f).
    focal_std = float("inf")
    for report in reversed(ladder):
        if "f" in (report.get("param_std") or {}):
            focal_std = float(report["param_std"]["f"])
            break
    last = ladder[-1]
    focal_rel = focal_std / max(state.f, 1.0)
    pp_std = (
        (
            last["param_std"].get("cx", float("inf")),
            last["param_std"].get("cy", float("inf")),
        )
        if level == ModelLevel.M3_CENTER_RADIAL_POSE
        else None
    )
    observability = evaluate_observability_gates(
        inp.correspondences,
        inp.image_size,
        screen_normals=screen_normals,
        inlier_mask=inliers,
        dlt_condition=init_diag["dlt_condition"],
        hessian_condition=last.get("hessian_condition"),
        focal_rel_std=focal_rel,
        pp_std=pp_std,
    )
    if not observability["passed"]:
        raise SingleViewUnobservable(
            "Joint solve failed observability gates",
            details=observability,
        )

    w_rms = withheld_rms(world, pixels, state, inp.image_size, withhold_idx)
    consistency = per_screen_pose_consistency(inp.correspondences, state, inp.image_size)
    if w_rms >= MAX_WITHHELD_RMS_PX:
        raise SingleViewUnobservable(
            f"Withheld RMS {w_rms:.3f}px exceeds {MAX_WITHHELD_RMS_PX}px",
            details={"withheld_rms_px": w_rms, "withheld_count": len(withhold_idx)},
        )
    if not consistency["passed"]:
        raise ScreenGeometryInconsistent(
            "Per-screen independent pose disagrees with joint solve",
            details=consistency,
        )

    pred = _project_world(world, state, inp.image_size)
    rms = float(np.sqrt(np.mean(np.sum((pred - pixels) ** 2, axis=1))))
    session_lens = SessionLens(
        fx=state.f,
        fy=state.f,
        cx=state.cx,
        cy=state.cy,
        dist_coeffs=[state.k1, state.k2, 0.0, 0.0, 0.0],
        image_size=inp.image_size,
    )
    validation = {
        "withheld_rms_px": w_rms,
        "withheld_count": len(withhold_idx),
        "solve_count": len(solve_idx),
        "screen_to_screen_consistency": consistency,
        "ladder": ladder,
        "init": init_diag,
    }
    qualification = {
        "passed": True,
        "fail_closed": True,
        "scope": "current_camera_state_only",
        "formal": inp.formal,
    }
    return FixedObservationResult(
        formal=inp.formal,
        mode_requested=inp.mode_requested,
        mode_resolved=mode,
        solve_kind="joint_single_observation",
        camera_from_stage=_pose_dict(state.rvec, state.tvec),
        session_lens=session_lens,
        camera_state_fingerprint=(
            None if inp.camera_state is None else inp.camera_state.to_dict()
        ),
        stage_geometry_fingerprint=inp.stage_geometry_fingerprint,
        detection=detection,
        observability=observability,
        preflight=preflight,
        validation=validation,
        qualification=qualification,
        model_level=level.value,
        rms_reprojection_px=rms,
        num_correspondences=len(inp.correspondences),
        num_inliers=int(inliers.sum()),
    )


def _solve_known_lens(
    inp: FixedObservationInput,
    mode: ModeResolved,
    detection: dict[str, Any],
    screen_normals: dict[str, tuple[float, float, float]],
) -> FixedObservationResult:
    assert inp.known_lens is not None
    lens = inp.known_lens
    world, pixels, labels = _as_arrays(inp.correspondences)
    per_screen = detection_metrics(inp.correspondences, inp.image_size)["per_screen"]
    bad_trustworthy = {
        label: count
        for label, count in per_screen.items()
        if count < MIN_TRUSTWORTHY_PER_SCREEN
    }
    if bad_trustworthy or len(per_screen) == 0:
        raise DetectionQualityFailed(
            f"Need >= {MIN_TRUSTWORTHY_PER_SCREEN} trustworthy markers per screen "
            "for known-lens pose",
            details={"per_screen": per_screen, "detection": detection},
        )
    K = np.array(
        [[lens.fx, 0, lens.cx], [0, lens.fy, lens.cy], [0, 0, 1]], dtype=np.float64
    )
    dist = np.asarray(lens.dist_coeffs, dtype=np.float64)
    ok, rvec, tvec, inliers = cv2.solvePnPRansac(
        world,
        pixels,
        K,
        dist,
        iterationsCount=200,
        reprojectionError=4.0,
        confidence=0.999,
        flags=cv2.SOLVEPNP_ITERATIVE,
    )
    if not ok or inliers is None:
        raise DetectionQualityFailed(
            "known-lens solvePnPRansac failed closed",
            details={"num_points": len(world)},
        )
    keep = inliers.reshape(-1)
    inlier_mask = np.zeros(len(world), dtype=bool)
    inlier_mask[keep] = True
    inliers_by_screen: dict[str, int] = {}
    for i in keep.tolist():
        label = labels[int(i)]
        inliers_by_screen[label] = inliers_by_screen.get(label, 0) + 1
    bad_inliers = {
        label: count
        for label, count in inliers_by_screen.items()
        if count < MIN_INLIERS_PER_SCREEN
    }
    missing_screens = [label for label in per_screen if label not in inliers_by_screen]
    if int(keep.size) < MIN_INLIERS_TOTAL or bad_inliers or missing_screens:
        raise LocalizationQualityFailed(
            "known-lens pose failed closed inlier gates "
            f"(need >= {MIN_INLIERS_TOTAL} total and "
            f">= {MIN_INLIERS_PER_SCREEN} per screen)",
            details={
                "num_inliers": int(keep.size),
                "inliers_by_screen": inliers_by_screen,
                "per_screen": per_screen,
                "missing_screens": missing_screens,
            },
        )
    rvec, tvec = cv2.solvePnPRefineLM(world[keep], pixels[keep], K, dist, rvec, tvec)
    projected, _ = cv2.projectPoints(world, rvec, tvec, K, dist)
    projected = projected.reshape(-1, 2)
    rms = float(np.sqrt(np.mean(np.sum((projected - pixels) ** 2, axis=1))))
    session_lens = SessionLens(
        fx=lens.fx,
        fy=lens.fy,
        cx=lens.cx,
        cy=lens.cy,
        dist_coeffs=list(lens.dist_coeffs),
        image_size=lens.image_size,
        is_master=True,
        session_coupled=False,
        model="brown_conrady_radial2",
    )
    # known-lens does not require multi-plane observability for formal extrinsics
    observability = evaluate_observability_gates(
        inp.correspondences,
        inp.image_size,
        screen_normals=screen_normals,
        inlier_mask=inlier_mask,
        require_multi_plane=False,
    )
    return FixedObservationResult(
        formal=inp.formal,
        mode_requested=inp.mode_requested,
        mode_resolved=mode,
        solve_kind="fixed_extrinsics_only",
        camera_from_stage=_pose_dict(rvec.reshape(3), tvec.reshape(3)),
        session_lens=session_lens,
        camera_state_fingerprint=(
            None if inp.camera_state is None else inp.camera_state.to_dict()
        ),
        stage_geometry_fingerprint=inp.stage_geometry_fingerprint,
        detection=detection,
        observability=observability,
        preflight={"passed": True, "mode": "known-lens"},
        validation={"rms_reprojection_px": rms, "num_inliers": int(keep.size)},
        qualification={
            "passed": True,
            "fail_closed": True,
            "scope": "qualified_master_lens",
            "formal": inp.formal,
            "master_lens": True,
        },
        model_level="M0_pose_only",
        rms_reprojection_px=rms,
        num_correspondences=len(inp.correspondences),
        num_inliers=int(keep.size),
    )


def write_fixed_observation_result(result: FixedObservationResult, path: str) -> None:
    """Persist artifact; refuse to write unqualified formal results."""
    payload = result.to_dict()
    if result.formal and not result.qualification.get("passed", False):
        raise DetectionQualityFailed(
            "Refusing to persist formal=false-negative result",
            details=result.qualification,
        )
    payload["written_at"] = datetime.now(timezone.utc).isoformat()
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2)


def make_attest_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()
