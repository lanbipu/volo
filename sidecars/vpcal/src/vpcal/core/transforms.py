"""Rigid-transform algebra + the calibration reprojection chain.

This module is the **single source of truth** for the transform conventions in
spec §5.1.  Every other component (simulator, scipy solver, C++ cost function,
OpenTrackIO export) must agree with it, or the simulate→solve round-trip will
not close to <0.01 px.

Conventions (spec §10.1):
  * quaternion = (w, x, y, z), unit, active rotation.
  * rigid transform = 4x4 homogeneous matrix ``T``; ``T_A_from_B`` maps a point
    expressed in frame B to frame A: ``P_A = T_A_from_B @ [P_B; 1]``.
  * length unit = mm.

The reprojection chain (spec §5.1.4), with the world point already converted to
the right-hand internal frame by the caller (``world_rh = M_rh_from_ue @ P_ue``):

    P_origin = inv(T_S_from_O) @ world_rh        # stage  → tracker origin
    P_body   = inv(T_sdk)      @ P_origin        # origin → tracker body   (T_sdk = T_O_from_B)
    P_camera = T_C_from_B      @ P_body          # body   → camera
    pixel    = project(lens, P_camera)
"""

from __future__ import annotations

import numpy as np
from numpy.typing import NDArray

Array = NDArray[np.float64]


# ── Quaternion <-> rotation matrix ───────────────────────────────────


def normalize_quat(q: Array) -> Array:
    """Return ``q`` (w,x,y,z) normalised to unit length."""
    q = np.asarray(q, dtype=np.float64)
    n = np.linalg.norm(q)
    if n == 0.0:
        raise ValueError("zero-norm quaternion")
    return q / n


def quat_to_matrix(q: Array) -> Array:
    """Convert a unit quaternion (w, x, y, z) to a 3x3 rotation matrix."""
    w, x, y, z = normalize_quat(q)
    return np.array(
        [
            [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
            [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
            [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
        ],
        dtype=np.float64,
    )


def matrix_to_quat(R: Array) -> Array:
    """Convert a 3x3 rotation matrix to a unit quaternion (w, x, y, z).

    Uses Shepperd's method (numerically stable across all rotations).  The
    returned quaternion is canonicalised to have ``w >= 0``.
    """
    R = np.asarray(R, dtype=np.float64)
    t = np.trace(R)
    if t > 0.0:
        s = np.sqrt(t + 1.0) * 2.0
        w = 0.25 * s
        x = (R[2, 1] - R[1, 2]) / s
        y = (R[0, 2] - R[2, 0]) / s
        z = (R[1, 0] - R[0, 1]) / s
    elif R[0, 0] > R[1, 1] and R[0, 0] > R[2, 2]:
        s = np.sqrt(1.0 + R[0, 0] - R[1, 1] - R[2, 2]) * 2.0
        w = (R[2, 1] - R[1, 2]) / s
        x = 0.25 * s
        y = (R[0, 1] + R[1, 0]) / s
        z = (R[0, 2] + R[2, 0]) / s
    elif R[1, 1] > R[2, 2]:
        s = np.sqrt(1.0 + R[1, 1] - R[0, 0] - R[2, 2]) * 2.0
        w = (R[0, 2] - R[2, 0]) / s
        x = (R[0, 1] + R[1, 0]) / s
        y = 0.25 * s
        z = (R[1, 2] + R[2, 1]) / s
    else:
        s = np.sqrt(1.0 + R[2, 2] - R[0, 0] - R[1, 1]) * 2.0
        w = (R[1, 0] - R[0, 1]) / s
        x = (R[0, 2] + R[2, 0]) / s
        y = (R[1, 2] + R[2, 1]) / s
        z = 0.25 * s
    q = np.array([w, x, y, z], dtype=np.float64)
    if q[0] < 0.0:
        q = -q
    return normalize_quat(q)


def quat_multiply(a: Array, b: Array) -> Array:
    """Hamilton product of two quaternions (w, x, y, z): ``a ⊗ b``."""
    aw, ax, ay, az = a
    bw, bx, by, bz = b
    return np.array(
        [
            aw * bw - ax * bx - ay * by - az * bz,
            aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
        ],
        dtype=np.float64,
    )


# ── Homogeneous rigid transforms ─────────────────────────────────────


def make_transform(q: Array, t: Array) -> Array:
    """Build a 4x4 transform from quaternion (w,x,y,z) and translation (x,y,z)."""
    T = np.eye(4, dtype=np.float64)
    T[:3, :3] = quat_to_matrix(q)
    T[:3, 3] = np.asarray(t, dtype=np.float64)
    return T


def transform_to_qt(T: Array) -> tuple[Array, Array]:
    """Decompose a 4x4 transform into (quaternion w,x,y,z, translation)."""
    return matrix_to_quat(T[:3, :3]), np.asarray(T[:3, 3], dtype=np.float64).copy()


def invert_transform(T: Array) -> Array:
    """Invert a 4x4 rigid transform (rotation transpose, rotated translation)."""
    R = T[:3, :3]
    t = T[:3, 3]
    Ti = np.eye(4, dtype=np.float64)
    Ti[:3, :3] = R.T
    Ti[:3, 3] = -R.T @ t
    return Ti


def apply_transform(T: Array, p: Array) -> Array:
    """Apply a 4x4 transform to a point or an ``(N, 3)`` array of points."""
    p = np.asarray(p, dtype=np.float64)
    R = T[:3, :3]
    t = T[:3, 3]
    if p.ndim == 1:
        return R @ p + t
    return p @ R.T + t


def compose(*transforms: Array) -> Array:
    """Compose transforms left-to-right: ``compose(A, B) == A @ B``."""
    out = np.eye(4, dtype=np.float64)
    for T in transforms:
        out = out @ T
    return out


# ── The reprojection chain (spec §5.1.4) ─────────────────────────────


def world_to_camera(
    world_rh: Array,
    T_S_from_O: Array,
    T_sdk: Array,
    T_C_from_B: Array,
) -> Array:
    """Transform a right-hand world point (or ``(N,3)`` array) into camera frame.

    ``world_rh`` is already ``M_rh_from_ue @ P_stage_ue`` (caller's
    responsibility).  Returns the point in the OpenCV camera frame.
    """
    return apply_transform(
        stage_to_camera_transform(T_S_from_O, T_sdk, T_C_from_B), world_rh
    )


def stage_to_camera_transform(
    T_S_from_O: Array, T_sdk: Array, T_C_from_B: Array
) -> Array:
    """Return the 4x4 ``T_C_from_S`` = ``T_C_from_B · inv(T_sdk) · inv(T_S_from_O)``."""
    return compose(T_C_from_B, invert_transform(T_sdk), invert_transform(T_S_from_O))


def camera_in_stage_transform(
    T_S_from_O: Array, T_sdk: Array, T_C_from_B: Array
) -> Array:
    """Return ``T_S_from_C`` = ``T_S_from_O · T_sdk · inv(T_C_from_B)`` (spec §11).

    This is the camera pose expressed in the (right-hand) stage frame, used by
    the OpenTrackIO export.
    """
    return compose(T_S_from_O, T_sdk, invert_transform(T_C_from_B))
