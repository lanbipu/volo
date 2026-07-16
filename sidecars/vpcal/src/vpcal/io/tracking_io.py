"""Tracking JSONL I/O: compact + OpenTrackIO formats, with auto-detection.

Two on-the-wire formats per spec §4.2:
  * **compact** — one :class:`~vpcal.models.tracking.TrackingFrame` per line.
  * **OpenTrackIO native** — one full OpenTrackIO sample per line; the needed
    fields are extracted into a TrackingFrame.

Detection: the first non-empty line is parsed; if it carries a ``protocol`` or
``static`` key it is treated as OpenTrackIO, otherwise compact.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from numpy.typing import NDArray

from vpcal.core.coordinates import convert_pose, opentrackio_euler_to_matrix
from vpcal.core.errors import ArgumentError, ResourceNotFoundError
from vpcal.core.transforms import matrix_to_quat, quat_to_matrix
from vpcal.models.tracking import RotationData, RotationOrder, TrackingFrame

# OpenTrackIO expresses translations in metres; vpcal works in millimetres.
_M_TO_MM = 1000.0


def detect_format(first_line: str) -> str:
    """Return ``"opentrackio"`` or ``"compact"`` from the first JSONL line."""
    obj = json.loads(first_line)
    if isinstance(obj, dict) and ("protocol" in obj or "static" in obj):
        return "opentrackio"
    return "compact"


def _transform_matrix(tr: dict) -> NDArray[np.float64]:
    """Build a 4x4 from one OpenTrackIO transform (translation m→mm + rotation)."""
    t = tr.get("translation", {}) or {}
    rot = tr.get("rotation", {}) or {}
    if {"pan", "tilt", "roll"} & rot.keys():
        R = opentrackio_euler_to_matrix(
            float(rot.get("pan", 0.0)), float(rot.get("tilt", 0.0)), float(rot.get("roll", 0.0))
        )
    elif {"w", "x", "y", "z"} <= rot.keys():
        R = quat_to_matrix(np.array([float(rot["w"]), float(rot["x"]), float(rot["y"]), float(rot["z"])]))
    else:
        R = np.eye(3)
    M = np.eye(4)
    M[:3, :3] = R
    M[:3, 3] = [float(t.get("x", 0.0)) * _M_TO_MM, float(t.get("y", 0.0)) * _M_TO_MM, float(t.get("z", 0.0)) * _M_TO_MM]
    return M


def _frame_from_opentrackio(obj: dict, fallback_id: int) -> TrackingFrame:
    """Extract a TrackingFrame from one OpenTrackIO sample.

    OpenTrackIO ``transforms`` is a *chain* composed in order (the compound is
    the camera pose relative to stage origin), so all elements are multiplied —
    not just the last (which would be wrong for any multi-link rig).
    """
    timing = obj.get("timing", {}) or {}
    frame_id = timing.get("sequenceNumber", fallback_id)
    ts = 0.0
    sample_ts = timing.get("sampleTimestamp")
    if isinstance(sample_ts, dict):
        ts = float(sample_ts.get("seconds", 0)) + float(sample_ts.get("nanoseconds", 0)) * 1e-9
    transforms = obj.get("transforms") or []
    if not transforms:
        raise ArgumentError("OpenTrackIO sample has no transforms", details={"frame_id": frame_id})
    compound = np.eye(4)
    for tr in transforms:
        compound = compound @ _transform_matrix(tr)
    q = matrix_to_quat(compound[:3, :3])
    return TrackingFrame(
        frame_id=int(frame_id),
        timestamp_s=ts,
        protocol_ts_s=ts,
        position=[float(x) for x in compound[:3, 3]],
        rotation=RotationData(order=RotationOrder.QUATERNION, values=[float(x) for x in q]),
        confidence=1.0,
    )


def load_tracking(path: str | Path) -> list[TrackingFrame]:
    """Load tracking frames from a JSONL file (auto-detecting the format)."""
    p = Path(path)
    if not p.exists():
        raise ResourceNotFoundError(f"tracking file not found: {p}", details={"path": str(p)})
    lines = [ln for ln in p.read_text().splitlines() if ln.strip()]
    if not lines:
        return []
    fmt = detect_format(lines[0])
    frames: list[TrackingFrame] = []
    for i, ln in enumerate(lines):
        obj = json.loads(ln)
        if fmt == "opentrackio":
            frames.append(_frame_from_opentrackio(obj, fallback_id=i))
        else:
            frames.append(TrackingFrame.model_validate(obj))
    return frames


def write_tracking(frames: list[TrackingFrame], path: str | Path) -> None:
    """Write tracking frames in the compact JSONL format."""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("w") as fh:
        for fr in frames:
            fh.write(json.dumps(fr.model_dump(mode="json"), ensure_ascii=False) + "\n")


def to_internal_pose(
    frame: TrackingFrame, coordinate_system: str, custom_transform: list[list[float]] | None = None
) -> tuple[NDArray[np.float64], NDArray[np.float64]]:
    """Convert one frame's pose to the internal right-hand frame ``(q_wxyz, t)``."""
    return convert_pose(
        coordinate_system,
        frame.rotation.order.value,
        list(frame.rotation.values),
        list(frame.position),
        custom_transform,
    )


def to_internal_poses(
    frames: list[TrackingFrame],
    coordinate_system: str,
    custom_transform: list[list[float]] | None = None,
) -> dict[int, tuple[NDArray[np.float64], NDArray[np.float64]]]:
    """Map ``frame_id`` → internal right-hand pose ``(q_wxyz, t)`` for all frames.

    Duplicate ``frame_id`` records keep the FIRST occurrence — the same policy
    as ``match_frames``, so the exact-observations and detector paths resolve
    duplicates identically (D5).
    """
    out: dict[int, tuple[NDArray[np.float64], NDArray[np.float64]]] = {}
    for fr in frames:
        if fr.frame_id not in out:
            out[fr.frame_id] = to_internal_pose(fr, coordinate_system, custom_transform)
    return out
