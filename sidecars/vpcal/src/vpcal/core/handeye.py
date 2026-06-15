"""Closed-form hand-eye initialisation (remediation A3.1).

Per-frame PnP on the marker observations gives the camera-from-stage pose
``T_C_from_S_i``; the tracker reports ``T_sdk_i = T_O_from_B_i``.  With the
unknown hand-eye ``X = T_C_from_B`` and the (also unknown) stage registration
folded into ``Y = inv(T_S_from_O)``:

    T_C_from_S_i = X · inv(T_sdk_i) · Y

For any frame pair (i, j) the registration Y cancels:

    A_ij := T_C_from_S_i · inv(T_C_from_S_j) = X · B_ij · inv(X)
    B_ij := inv(T_sdk_i) · T_sdk_j

which is the classic ``A X = X B`` hand-eye problem, solved here in closed
form (Park & Martin 1994: rotation via the log-map least squares, then
translation via a stacked linear system).

Degeneracy: with pure-translation camera motion all relative rotation axes
vanish/align and the rotation part of X is unobservable — the classic
degenerate configuration.  :func:`closed_form_handeye` checks rotation-axis
diversity and raises :class:`PreconditionError` with capture guidance.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from numpy.typing import NDArray

from vpcal.core.errors import PreconditionError
from vpcal.core.observations import Observation
from vpcal.core.projection import CameraIntrinsics
from vpcal.core.transforms import invert_transform, make_transform, matrix_to_quat

Array = NDArray[np.float64]

_MIN_FRAMES = 3
_MIN_PAIR_ANGLE_DEG = 2.0   # pairs rotating less than this carry no axis signal
_MIN_AXIS_SPREAD = 0.10     # 2nd singular value of the axis bundle (≈ sin of spread)
_MAX_PAIRS = 300


@dataclass
class HandeyeResult:
    """Closed-form hand-eye solution + diagnostics."""

    camera_from_tracker_q: Array
    camera_from_tracker_t: Array
    num_frames: int
    num_pairs: int
    axis_spread: float
    diagnostics: dict = field(default_factory=dict)


def _rotvec(R: Array) -> Array:
    """Rotation matrix → rotation vector (log map)."""
    q = matrix_to_quat(R)
    w = float(np.clip(q[0], -1.0, 1.0))
    angle = 2.0 * np.arccos(abs(w))
    vec = q[1:] * (1.0 if w >= 0 else -1.0)
    s = float(np.linalg.norm(vec))
    if s < 1e-12:
        return np.zeros(3)
    return vec / s * angle


def per_frame_camera_poses(
    observations: list[Observation], intr: CameraIntrinsics, *, min_points: int = 6
) -> dict[int, Array]:
    """Per-frame PnP: frame_id → ``T_C_from_S`` (4x4) for frames with enough points."""
    import cv2

    by_frame: dict[int, list[Observation]] = {}
    for o in observations:
        by_frame.setdefault(o.frame_id, []).append(o)

    K = np.array([[intr.fx, 0, intr.cx], [0, intr.fy, intr.cy], [0, 0, 1]], dtype=np.float64)
    dist = np.array([intr.k1, intr.k2, intr.p1, intr.p2, intr.k3], dtype=np.float64)
    poses: dict[int, Array] = {}
    for fid, lst in sorted(by_frame.items()):
        if len(lst) < min_points:
            continue
        obj = np.array([o.world_rh for o in lst], dtype=np.float64).reshape(-1, 1, 3)
        img = np.array([[o.pixel_u, o.pixel_v] for o in lst], dtype=np.float64).reshape(-1, 1, 2)
        ok, rvec, tvec, _inl = cv2.solvePnPRansac(
            obj, img, K, dist, reprojectionError=3.0, flags=cv2.SOLVEPNP_ITERATIVE
        )
        if not ok:
            continue
        R, _ = cv2.Rodrigues(rvec)
        T = np.eye(4)
        T[:3, :3] = R
        T[:3, 3] = tvec.ravel()
        poses[fid] = T
    return poses


def closed_form_handeye(
    observations: list[Observation],
    intr: CameraIntrinsics,
    tracker_poses: dict[int, tuple[Array, Array]] | None = None,
    *,
    min_pair_angle_deg: float = _MIN_PAIR_ANGLE_DEG,
    min_axis_spread: float = _MIN_AXIS_SPREAD,
) -> HandeyeResult:
    """Park-Martin closed-form ``T_C_from_B`` from observations + tracker poses.

    ``tracker_poses`` maps frame_id → ``(q, t)`` of ``T_sdk`` in the internal
    frame; when omitted it is taken from the observations themselves.  Raises
    :class:`PreconditionError` when fewer than 3 usable frames exist or the
    relative-rotation axes are too collinear (pure-translation capture).
    """
    cam_poses = per_frame_camera_poses(observations, intr)
    if tracker_poses is None:
        tracker_poses = {}
        for o in observations:
            tracker_poses.setdefault(o.frame_id, (np.asarray(o.track_q), np.asarray(o.track_t)))

    fids = [f for f in sorted(cam_poses) if f in tracker_poses]
    if len(fids) < _MIN_FRAMES:
        raise PreconditionError(
            f"hand-eye initialisation needs >= {_MIN_FRAMES} frames with a PnP pose; "
            f"got {len(fids)}",
            details={"usable_frames": len(fids)},
        )
    T_sdk = {f: make_transform(*tracker_poses[f]) for f in fids}

    alphas: list[Array] = []
    betas: list[Array] = []
    pairs: list[tuple[Array, Array]] = []  # (A_ij, B_ij) for the translation stage
    min_angle = np.radians(min_pair_angle_deg)
    all_pairs = [(i, j) for k, i in enumerate(fids) for j in fids[k + 1:]]
    if len(all_pairs) > _MAX_PAIRS:
        idx = np.linspace(0, len(all_pairs) - 1, _MAX_PAIRS).astype(int)
        all_pairs = [all_pairs[i] for i in idx]
    for i, j in all_pairs:
        A = cam_poses[i] @ invert_transform(cam_poses[j])
        B = invert_transform(T_sdk[i]) @ T_sdk[j]
        a, b = _rotvec(A[:3, :3]), _rotvec(B[:3, :3])
        if np.linalg.norm(a) < min_angle or np.linalg.norm(b) < min_angle:
            continue
        alphas.append(a)
        betas.append(b)
        pairs.append((A, B))

    if len(alphas) < 2:
        raise PreconditionError(
            "hand-eye initialisation is degenerate: the capture contains almost no "
            "relative camera rotation (pure-translation motion). Re-shoot with the "
            "camera rotated between poses (vary pan/tilt by >10° across >=3 poses)",
            details={"rotating_pairs": len(alphas), "min_pair_angle_deg": min_pair_angle_deg},
        )

    axes = np.array([a / np.linalg.norm(a) for a in alphas])
    svals = np.linalg.svd(axes, compute_uv=False)
    axis_spread = float(svals[1] / svals[0]) if svals[0] > 0 else 0.0
    if axis_spread < min_axis_spread:
        raise PreconditionError(
            "hand-eye initialisation is degenerate: all relative rotations share one "
            "axis. Re-shoot with rotations about at least two distinct axes "
            "(e.g. vary both pan and tilt)",
            details={"axis_spread": axis_spread, "min_axis_spread": min_axis_spread},
        )

    # Rotation (Park-Martin / Kabsch): R_X = argmin Σ ||R_X β − α||².
    H = np.zeros((3, 3))
    for a, b in zip(alphas, betas):
        H += np.outer(b, a)
    U, _S, Vt = np.linalg.svd(H)
    D = np.diag([1.0, 1.0, np.sign(np.linalg.det(Vt.T @ U.T))])
    R_X = Vt.T @ D @ U.T

    # Translation: (R_A − I) t_X = R_X t_B − t_A, stacked over all pairs.
    M = np.vstack([A[:3, :3] - np.eye(3) for A, _B in pairs])
    rhs = np.concatenate([R_X @ B[:3, 3] - A[:3, 3] for A, B in pairs])
    t_X, *_ = np.linalg.lstsq(M, rhs, rcond=None)

    return HandeyeResult(
        camera_from_tracker_q=matrix_to_quat(R_X),
        camera_from_tracker_t=t_X,
        num_frames=len(fids),
        num_pairs=len(alphas),
        axis_spread=axis_spread,
        diagnostics={
            "usable_frames": len(fids),
            "rotating_pairs": len(alphas),
            "axis_spread": axis_spread,
        },
    )
