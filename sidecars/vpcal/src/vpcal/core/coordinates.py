"""Source coordinate-system → right-hand internal frame conversion (spec §10.2).

The internal frame is right-handed: **X-forward, Y-left, Z-up** (UE with Y
flipped).  Each input source defines a single matrix ``M_rh_from_<source>`` that
maps source coordinates straight into the internal frame:

    position:  p_rh = M3 @ p_src + M_t
    rotation:  R_rh = M3 @ R_src @ M3.T   (stays a proper rotation, det +1)

A handedness-flipping source (e.g. UE, det(M3) = -1) still yields a proper
rotation because ``det(M3 @ R @ M3.T) = det(M3)^2 · det(R) = +1`` (spec §10.2
requirement 4).
"""

from __future__ import annotations

import numpy as np
from numpy.typing import NDArray

from vpcal.core.errors import ArgumentError, ConfigError
from vpcal.core.transforms import matrix_to_quat, normalize_quat, quat_to_matrix

Array = NDArray[np.float64]


# 3x3 linear parts of M_rh_from_<source> (spec §10.2 table).
_M3: dict[str, Array] = {
    # UE: X-fwd, Y-right, Z-up (left-hand).  Flip Y → right-hand.  det = -1.
    "unreal": np.diag([1.0, -1.0, 1.0]),
    # OptiTrack: X-right, Y-up, Z-back (right-hand).  det = +1.
    "optitrack": np.array(
        [[0.0, 0.0, -1.0], [-1.0, 0.0, 0.0], [0.0, 1.0, 0.0]], dtype=np.float64
    ),
    # Vicon: X-fwd, Y-left, Z-up (right-hand) — identical to internal.  det = +1.
    "vicon": np.eye(3, dtype=np.float64),
    # FreeD: PROVISIONAL.  Spec §10.2 flags FreeD axis conventions as
    # hardware-dependent and requires verification against the real tracker.
    # Default here treats FreeD as a right-handed Y-up / Z-back system (det +1).
    "freeDEuler": np.array(
        [[0.0, 0.0, -1.0], [-1.0, 0.0, 0.0], [0.0, 1.0, 0.0]], dtype=np.float64
    ),
    # OpenTrackIO spec frame: right-hand, Z-up, Y = camera-forward, X = camera-
    # right.  Internal is X-forward / Y-left / Z-up, so X_rh = Y_otio,
    # Y_rh = -X_otio, Z_rh = Z_otio.  det = +1.
    "opentrackio": np.array(
        [[0.0, 1.0, 0.0], [-1.0, 0.0, 0.0], [0.0, 0.0, 1.0]], dtype=np.float64
    ),
}

# M_ue_from_rh == M_rh_from_ue (diag(1,-1,1) is self-inverse); used for export.
M3_UE_FROM_RH: Array = np.diag([1.0, -1.0, 1.0])


def m_rh_from_source(source: str, custom_transform: list[list[float]] | None = None) -> Array:
    """Return the 4x4 ``M_rh_from_<source>`` for a coordinate-system name."""
    if source == "custom":
        if custom_transform is None:
            raise ConfigError(
                "coordinate_system 'custom' requires tracking.custom_transform (4x4 matrix)"
            )
        M = np.asarray(custom_transform, dtype=np.float64)
        if M.shape != (4, 4):
            raise ConfigError("custom_transform must be a 4x4 matrix")
        # The 3x3 block must be orthonormal; otherwise R_rh = M3·R·M3^T is not a
        # rotation and matrix_to_quat yields garbage/NaN.
        _require_proper_rotation(M[:3, :3], context="custom_transform 3x3 block", allow_reflection=True)
        return M
    if source not in _M3:
        raise ConfigError(f"unknown coordinate_system: {source!r}")
    M = np.eye(4, dtype=np.float64)
    M[:3, :3] = _M3[source]
    return M


def _euler_ptr_to_matrix(pan_deg: float, tilt_deg: float, roll_deg: float) -> Array:
    """pan/tilt/roll (degrees) → rotation matrix, ``R = Ry(pan)·Rx(tilt)·Rz(roll)``.

    Per spec §10.2: pan about the vertical axis, tilt about the horizontal axis,
    roll about the depth axis (axes in the source frame).
    """
    p, t, r = np.radians([pan_deg, tilt_deg, roll_deg])
    cp, sp = np.cos(p), np.sin(p)
    ct, st = np.cos(t), np.sin(t)
    cr, sr = np.cos(r), np.sin(r)
    Ry = np.array([[cp, 0, sp], [0, 1, 0], [-sp, 0, cp]], dtype=np.float64)
    Rx = np.array([[1, 0, 0], [0, ct, -st], [0, st, ct]], dtype=np.float64)
    Rz = np.array([[cr, -sr, 0], [sr, cr, 0], [0, 0, 1]], dtype=np.float64)
    return Ry @ Rx @ Rz


def matrix_to_euler_ptr(R: Array) -> tuple[float, float, float]:
    """Inverse of :func:`_euler_ptr_to_matrix`: 3x3 → (pan, tilt, roll) degrees.

    Consistent with ``R = Ry(pan) · Rx(tilt) · Rz(roll)``.
    """
    R = np.asarray(R, dtype=np.float64)
    pan = np.arctan2(R[0, 2], R[2, 2])
    tilt = np.arctan2(-R[1, 2], np.hypot(R[1, 0], R[1, 1]))
    roll = np.arctan2(R[1, 0], R[1, 1])
    return float(np.degrees(pan)), float(np.degrees(tilt)), float(np.degrees(roll))


def opentrackio_euler_to_matrix(pan_deg: float, tilt_deg: float, roll_deg: float) -> Array:
    """OpenTrackIO intrinsic-ZXY euler (pan, tilt, roll degrees) → rotation matrix.

    Per the OpenTrackIO spec, transform rotations are intrinsic about ZXY:
    ``R = Rz(pan) · Rx(tilt) · Ry(roll)`` — distinct from the project-internal
    FreeD convention in :func:`_euler_ptr_to_matrix`.
    """
    p, t, r = np.radians([pan_deg, tilt_deg, roll_deg])
    cp, sp = np.cos(p), np.sin(p)
    ct, st = np.cos(t), np.sin(t)
    cr, sr = np.cos(r), np.sin(r)
    Rz = np.array([[cp, -sp, 0], [sp, cp, 0], [0, 0, 1]], dtype=np.float64)
    Rx = np.array([[1, 0, 0], [0, ct, -st], [0, st, ct]], dtype=np.float64)
    Ry = np.array([[cr, 0, sr], [0, 1, 0], [-sr, 0, cr]], dtype=np.float64)
    return Rz @ Rx @ Ry


def matrix_to_opentrackio_euler(R: Array) -> tuple[float, float, float]:
    """Inverse of :func:`opentrackio_euler_to_matrix` (intrinsic ZXY)."""
    R = np.asarray(R, dtype=np.float64)
    tilt = np.arcsin(np.clip(R[2, 1], -1.0, 1.0))
    roll = np.arctan2(-R[2, 0], R[2, 2])
    pan = np.arctan2(-R[0, 1], R[1, 1])
    return float(np.degrees(pan)), float(np.degrees(tilt)), float(np.degrees(roll))


def _require_proper_rotation(M3: Array, *, context: str, allow_reflection: bool = False) -> None:
    """Raise :class:`ConfigError` if a 3x3 matrix isn't an admissible rotation.

    Requires orthonormality with ``det == +1``.  ``allow_reflection`` also permits
    a handedness flip (``det == -1``), valid for a coordinate-system map (e.g.
    UE→right-hand) but NOT for a rotation matrix, which matrix_to_quat
    (Shepperd's method) assumes is proper.
    """
    M3 = np.asarray(M3, dtype=np.float64)
    det = float(np.linalg.det(M3))
    det_ok = np.isclose(abs(det), 1.0, atol=1e-6) if allow_reflection else np.isclose(det, 1.0, atol=1e-6)
    if not np.allclose(M3 @ M3.T, np.eye(3), atol=1e-6) or not det_ok:
        expected = "det ±1" if allow_reflection else "det +1"
        raise ConfigError(
            f"{context} must be orthonormal ({expected}, no scale/shear)",
            details={"det": det},
        )


def rotation_to_source_matrix(order: str, values: list[float]) -> Array:
    """Convert a rotation in its declared representation to a 3x3 matrix (source frame)."""
    vals = list(values)
    if order == "quaternion":  # (w, x, y, z)
        if len(vals) != 4:
            raise ArgumentError("quaternion requires 4 values (w, x, y, z)")
        return quat_to_matrix(np.asarray(vals, dtype=np.float64))
    if order == "quaternion_xyzw":  # (x, y, z, w) → reorder
        if len(vals) != 4:
            raise ArgumentError("quaternion_xyzw requires 4 values (x, y, z, w)")
        x, y, z, w = vals
        return quat_to_matrix(np.array([w, x, y, z], dtype=np.float64))
    if order == "euler_ptr":  # pan, tilt, roll (degrees)
        if len(vals) != 3:
            raise ArgumentError("euler_ptr requires 3 values (pan, tilt, roll)")
        return _euler_ptr_to_matrix(*vals)
    if order == "matrix":  # 3x3 row-major
        if len(vals) != 9:
            raise ArgumentError("matrix requires 9 values (row-major 3x3)")
        M3 = np.asarray(vals, dtype=np.float64).reshape(3, 3)
        _require_proper_rotation(M3, context="rotation matrix")
        return M3
    raise ArgumentError(f"unsupported rotation order: {order!r}")


def convert_pose(
    source: str,
    order: str,
    rotation_values: list[float],
    position: list[float],
    custom_transform: list[list[float]] | None = None,
) -> tuple[Array, Array]:
    """Convert a source-frame pose into the right-hand internal frame.

    Returns ``(quaternion_wxyz, translation)`` with the rotation guaranteed to
    be a proper rotation (det +1) and the quaternion normalised.
    """
    M = m_rh_from_source(source, custom_transform)
    M3 = M[:3, :3]
    Mt = M[:3, 3]
    R_src = rotation_to_source_matrix(order, rotation_values)
    R_rh = M3 @ R_src @ M3.T
    t_rh = M3 @ np.asarray(position, dtype=np.float64) + Mt
    q_rh = matrix_to_quat(R_rh)
    return normalize_quat(q_rh), t_rh


def to_ue_transform(T_rh: Array) -> Array:
    """Convert a 4x4 transform from the internal right-hand frame back to UE.

    ``T_ue = M4 · T_rh · M4^-1`` with ``M4 = diag(1,-1,1,1)`` (self-inverse).
    """
    M4 = np.eye(4, dtype=np.float64)
    M4[:3, :3] = M3_UE_FROM_RH
    return M4 @ T_rh @ M4  # M4 is self-inverse


def to_opentrackio_transform(T_rh: Array) -> Array:
    """Convert a 4x4 transform from the internal frame to the OpenTrackIO frame.

    ``T_otio = M4 · T_rh · M4^-1`` with ``M4[:3,:3] = M_rh_from_opentrackio^T``
    (proper rotation, so the inverse is the transpose).
    """
    M4 = np.eye(4, dtype=np.float64)
    M4[:3, :3] = _M3["opentrackio"].T
    M4_inv = np.eye(4, dtype=np.float64)
    M4_inv[:3, :3] = _M3["opentrackio"]
    return M4 @ T_rh @ M4_inv
