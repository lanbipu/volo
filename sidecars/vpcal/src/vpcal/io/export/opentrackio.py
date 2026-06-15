"""OpenTrackIO export of calibrated tracking (spec §11).

For each raw tracking frame, the calibrated camera pose in the stage frame is:

    T_S_from_C = T_S_from_O · T_sdk · inv(T_C_from_B)         (right-hand)

By default the pose is written in the OpenTrackIO spec frame (right-hand,
Z-up, Y = camera-forward) as the ``transforms.camera_to_world`` compound
(translation in metres, rotation as intrinsic-ZXY pan/tilt/roll degrees).
``frame="ue"`` instead writes the Unreal left-hand frame — explicitly
non-spec, flagged in ``tracker.notes`` of every sample.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path

import numpy as np
from numpy.typing import NDArray

from vpcal.core.coordinates import (
    matrix_to_opentrackio_euler,
    to_opentrackio_transform,
    to_ue_transform,
)
from vpcal.core.errors import ArgumentError
from vpcal.core.transforms import camera_in_stage_transform, make_transform
from vpcal.models.lens import LensProfile

Array = NDArray[np.float64]
_MM_TO_M = 1e-3

# OpenTrackIO protocol version (JSON schema: 3-element integer array).
_PROTOCOL_VERSION = [1, 0, 0]

_UE_FRAME_NOTE = (
    "coordinateSystem: Unreal Engine left-hand (X-fwd/Y-right/Z-up) — "
    "NON-SPEC frame, exported with vpcal --frame ue"
)
_SESSION_ESTIMATE_NOTE = (
    "session-coupled quick lens estimate (non-master); "
    "calibrationHistory: vpcal Quick Lens Estimate v1.0"
)


def _sample_id(frame_id: int) -> str:
    """Deterministic spec-conformant ``urn:uuid:`` sample id for a frame."""
    return f"urn:uuid:{uuid.uuid5(uuid.NAMESPACE_URL, f'vpcal:sample:{frame_id}')}"


def _lens_block(lens: LensProfile) -> dict:
    """OpenTrackIO/OpenLensIO lens block from a vpcal LensProfile (QLE spec §7.1).

    Brown-Conrady coefficients are normalised from vpcal pixel-space to the
    resolution-independent mm-based OpenLensIO form ``l_i = k_i / F^(2i)``,
    ``q_i = p_i / F²``.  The principal point becomes a mm projection offset
    ``∆P = w·(cx/wshader − 0.5)`` (= principal_point_offset_mm; 0 when centred).

    The coefficients are the OpenCV forward model (undistorted → distorted),
    hence the "Brown-Conrady U-D" model label (../docs/OpenCV_to_OpenTrackIO.md).
    """
    F = lens.focal_length_mm
    f2, f4, f6 = F * F, F**4, F**6
    d = lens.distortion
    w, h = lens.sensor_width_mm, lens.sensor_height_mm
    ws, hs = lens.image_width_px, lens.image_height_px
    return {
        "pinholeFocalLength": F,
        "distortion": [
            {
                "model": "Brown-Conrady U-D",
                "radial": [d.k1 / f2, d.k2 / f4, d.k3 / f6],
                "tangential": [d.p1 / f2, d.p2 / f2],
            }
        ],
        "projectionOffset": {
            "x": w * (lens.cx / ws - 0.5),
            "y": h * (lens.cy / hs - 0.5),
        },
    }


def _camera_to_world_sample(
    frame_id: int,
    timestamp_s: float,
    T_S_from_C_out: Array,
    lens: LensProfile,
    session_estimate: bool,
    frame_note: str | None,
) -> dict:
    t = T_S_from_C_out[:3, 3]
    pan, tilt, roll = matrix_to_opentrackio_euler(T_S_from_C_out[:3, :3])
    tracker: dict = {"status": "calibrated", "recording": False}
    # Discipline §7 #1: a session-coupled quick estimate is NEVER a master lens;
    # the schema forbids custom lens keys, so the flag lives in tracker.notes.
    notes = "; ".join(
        n for n in (_SESSION_ESTIMATE_NOTE if session_estimate else None, frame_note) if n
    )
    if notes:
        tracker["notes"] = notes
    return {
        "protocol": {"name": "OpenTrackIO", "version": _PROTOCOL_VERSION},
        "sampleId": _sample_id(frame_id),
        "timing": {
            "sequenceNumber": frame_id,
            "sampleTimestamp": {
                "seconds": int(timestamp_s),
                "nanoseconds": int(round((timestamp_s - int(timestamp_s)) * 1e9)),
            },
        },
        "tracker": tracker,
        "lens": _lens_block(lens),
        "transforms": [
            {
                "translation": {"x": float(t[0]) * _MM_TO_M, "y": float(t[1]) * _MM_TO_M, "z": float(t[2]) * _MM_TO_M},
                "rotation": {"pan": pan, "tilt": tilt, "roll": roll},
                "id": "camera_to_world",
            }
        ],
    }


def export_opentrackio(
    tracker_poses: list[tuple[int, float, Array, Array]],
    tracker_to_stage: tuple[Array, Array],
    camera_from_tracker: tuple[Array, Array],
    lens: LensProfile,
    out_path: str | Path,
    *,
    session_estimate: bool = False,
    frame: str = "spec",
) -> int:
    """Export calibrated camera poses to OpenTrackIO JSONL.

    ``tracker_poses`` is a list of ``(frame_id, timestamp_s, q_internal,
    t_internal)`` SDK outputs (right-hand frame).  When ``session_estimate`` is
    True the sample is tagged (in ``tracker.notes``) as a non-master
    session-coupled estimate (QLE spec §7.2).  ``frame`` selects the output
    pose frame: ``"spec"`` (default, OpenTrackIO RH Z-up Y-forward) or ``"ue"``
    (Unreal left-hand, non-spec, flagged in notes).  Returns the sample count.
    """
    if frame not in ("spec", "ue"):
        raise ArgumentError(f"unsupported export frame: {frame!r} (expected 'spec' or 'ue')")
    to_out = to_opentrackio_transform if frame == "spec" else to_ue_transform
    frame_note = _UE_FRAME_NOTE if frame == "ue" else None
    T_S_from_O = make_transform(np.asarray(tracker_to_stage[0]), np.asarray(tracker_to_stage[1]))
    T_C_from_B = make_transform(np.asarray(camera_from_tracker[0]), np.asarray(camera_from_tracker[1]))
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with out.open("w") as fh:
        for frame_id, ts, q, t in tracker_poses:
            T_sdk = make_transform(np.asarray(q), np.asarray(t))
            T_S_from_C = camera_in_stage_transform(T_S_from_O, T_sdk, T_C_from_B)
            sample = _camera_to_world_sample(
                frame_id, ts, to_out(T_S_from_C), lens, session_estimate, frame_note
            )
            fh.write(json.dumps(sample, ensure_ascii=False) + "\n")
            n += 1
    return n
