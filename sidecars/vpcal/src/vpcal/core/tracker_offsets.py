"""Tracker-side offset backfill blocks (plan Phase E3).

Most FreeD-era tracking devices (EZtrack etc.) accept two operator-entered
rigid offsets — the camera transform (hand-eye, sensor plane ↔ tracker body)
and the device/world transform (stage origin ↔ tracker origin) — so the
tracking output arrives pre-calibrated and the render engine needs zero
configuration (cf. Miraxyz CalibFX Lineup Step IV).

This module renders the solved ``T_C_from_B`` (hand-eye) and ``T_S_from_O``
(world alignment) as copyable X/Y/Z (mm) + Pan/Tilt/Roll (deg) blocks
**expressed in the session's declared tracker coordinate system**, with the
units and rotation convention labelled explicitly.  Frame conversion reuses
``core/coordinates.py``; the rotation convention is the project ``euler_ptr``
one (``R = Ry(pan) · Rx(tilt) · Rz(roll)``, tracker-native axes).

Schema discipline: the ``cameras`` list carries the per-camera dimension
even though Phase 1 is single-camera (docs/schema-versions.md D6 rule).
"""

from __future__ import annotations

import numpy as np
from numpy.typing import NDArray

from vpcal.core.coordinates import m_rh_from_source, matrix_to_euler_ptr
from vpcal.core.transforms import make_transform

Array = NDArray[np.float64]

TRACKER_OFFSETS_SCHEMA_VERSION = "1.0"

ROTATION_CONVENTION = (
    "euler_ptr: R = Ry(pan) * Rx(tilt) * Rz(roll), degrees, tracker-native axes"
)


def _to_source_frame(T_rh: Array, M: Array) -> Array:
    """Re-express an internal-frame transform in the tracker source frame.

    ``M = M_rh_from_source`` (4x4); the source-frame representation of a
    transform between internally-represented frames is
    ``T_src = inv(M) · T_rh · M``.
    """
    return np.linalg.inv(M) @ T_rh @ M


def _offset_entry(T_src: Array) -> dict:
    pan, tilt, roll = matrix_to_euler_ptr(T_src[:3, :3])
    t = T_src[:3, 3]
    return {
        "x_mm": float(t[0]),
        "y_mm": float(t[1]),
        "z_mm": float(t[2]),
        "pan_deg": pan,
        "tilt_deg": tilt,
        "roll_deg": roll,
    }


def tracker_offsets_block(
    tracker_to_stage: tuple[Array, Array],
    camera_from_tracker: tuple[Array, Array],
    coordinate_system: str,
    custom_transform: list[list[float]] | None = None,
    *,
    camera_id: str = "camA",
) -> dict:
    """Build the copyable offset block for the session's tracker frame.

    ``hand_eye`` is ``T_C_from_B`` (camera-from-tracker-body); ``world_alignment``
    is ``T_S_from_O`` (stage-from-tracker-origin) — both re-expressed in the
    declared tracker coordinate system.
    """
    M = m_rh_from_source(coordinate_system, custom_transform)
    T_S = make_transform(np.asarray(tracker_to_stage[0]), np.asarray(tracker_to_stage[1]))
    T_C = make_transform(np.asarray(camera_from_tracker[0]), np.asarray(camera_from_tracker[1]))
    return {
        "schema_version": TRACKER_OFFSETS_SCHEMA_VERSION,
        "coordinate_system": coordinate_system,
        "translation_unit": "mm",
        "rotation_convention": ROTATION_CONVENTION,
        "cameras": [
            {
                "id": camera_id,
                "hand_eye": _offset_entry(_to_source_frame(T_C, M)),
                "world_alignment": _offset_entry(_to_source_frame(T_S, M)),
            }
        ],
    }


def offsets_to_internal_matrix(
    entry: dict, coordinate_system: str, custom_transform: list[list[float]] | None = None
) -> Array:
    """Rebuild the internal-frame 4x4 from one offset entry (roundtrip check).

    Inverse of the export: parse the euler_ptr angles + translation in the
    source frame, then convert back with ``T_rh = M · T_src · inv(M)``.
    """
    from vpcal.core.coordinates import _euler_ptr_to_matrix

    M = m_rh_from_source(coordinate_system, custom_transform)
    T_src = np.eye(4, dtype=np.float64)
    T_src[:3, :3] = _euler_ptr_to_matrix(entry["pan_deg"], entry["tilt_deg"], entry["roll_deg"])
    T_src[:3, 3] = [entry["x_mm"], entry["y_mm"], entry["z_mm"]]
    return M @ T_src @ np.linalg.inv(M)


def render_offsets_text(block: dict) -> list[str]:
    """Human-readable rendering for the CLI report (copy-into-device block)."""
    lines = [
        "",
        "TRACKER OFFSET BACKFILL (enter on the tracking device):",
        f"  frame            : {block['coordinate_system']} (translation mm)",
        f"  rotation         : {block['rotation_convention']}",
    ]
    for cam in block["cameras"]:
        for key, label in (("hand_eye", "camera transform"), ("world_alignment", "world transform")):
            e = cam[key]
            lines.append(
                f"  {label:<17}: X {e['x_mm']:+.2f}  Y {e['y_mm']:+.2f}  Z {e['z_mm']:+.2f}  "
                f"Pan {e['pan_deg']:+.3f}  Tilt {e['tilt_deg']:+.3f}  Roll {e['roll_deg']:+.3f}"
            )
    return lines
