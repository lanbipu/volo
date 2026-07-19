"""Tracking data models.

Represents per-frame tracker output in the compact JSONL format.
See spec section 4.2 for the schema and supported rotation orders.
"""

from __future__ import annotations

from enum import Enum
from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, Field

_M_TO_MM = 1000.0


def extract_opentrackio_lens_fields(sample: dict[str, Any]) -> dict[str, Any]:
    """Pull optional OpenTrackIO lens / sensor fields for monitor passthrough.

    Missing keys are omitted (caller merges onto TrackingFrame). Distortion may be
    a plain ``{k1,k2,…}`` dict or the OpenTrackIO array form with mm-normalised
    radial/tangential coeffs (converted back when focal length is known).
    """
    out: dict[str, Any] = {}
    lens = sample.get("lens") or {}
    if not isinstance(lens, dict):
        lens = {}

    focal = lens.get("focalLength", lens.get("pinholeFocalLength"))
    if focal is not None:
        try:
            out["focal_length_mm"] = float(focal)
        except (TypeError, ValueError):
            pass

    po = lens.get("projectionOffset")
    if isinstance(po, dict) and ("x" in po or "y" in po):
        try:
            out["projection_offset_mm"] = [float(po.get("x", 0.0)), float(po.get("y", 0.0))]
        except (TypeError, ValueError):
            pass

    dist = lens.get("distortion")
    F = out.get("focal_length_mm")
    if isinstance(dist, dict):
        for src, dst in (("k1", "distortion_k1"), ("k2", "distortion_k2"), ("k3", "distortion_k3"),
                         ("p1", "distortion_p1"), ("p2", "distortion_p2")):
            if dist.get(src) is not None:
                try:
                    out[dst] = float(dist[src])
                except (TypeError, ValueError):
                    pass
    elif isinstance(dist, list) and dist:
        block = dist[0] if isinstance(dist[0], dict) else None
        if block is not None and F and F > 0:
            f2, f4, f6 = F * F, F**4, F**6
            radial = block.get("radial") or []
            tangential = block.get("tangential") or []
            try:
                if len(radial) > 0:
                    out["distortion_k1"] = float(radial[0]) * f2
                if len(radial) > 1:
                    out["distortion_k2"] = float(radial[1]) * f4
                if len(radial) > 2:
                    out["distortion_k3"] = float(radial[2]) * f6
                if len(tangential) > 0:
                    out["distortion_p1"] = float(tangential[0]) * f2
                if len(tangential) > 1:
                    out["distortion_p2"] = float(tangential[1]) * f2
            except (TypeError, ValueError):
                pass

    cam = sample.get("camera") or {}
    if isinstance(cam, dict):
        dims = cam.get("activeSensorPhysicalDimensions")
        if isinstance(dims, dict):
            # OpenTrackIO / camdkit: metres → mm for UI archive units.
            try:
                if dims.get("width") is not None:
                    out["sensor_width_mm"] = float(dims["width"]) * _M_TO_MM
                if dims.get("height") is not None:
                    out["sensor_height_mm"] = float(dims["height"]) * _M_TO_MM
            except (TypeError, ValueError):
                pass
    return out


class RotationOrder(str, Enum):
    """Supported rotation representation orders."""

    QUATERNION = "quaternion"
    """Quaternion (w, x, y, z)."""
    QUATERNION_XYZW = "quaternion_xyzw"
    """Quaternion (x, y, z, w)."""
    EULER_PTR = "euler_ptr"
    """Euler angles: pan, tilt, roll (degrees)."""
    MATRIX = "matrix"
    """3x3 rotation matrix (row-major, 9 values)."""


class RotationData(BaseModel):
    """Rotation in a specified representation."""

    model_config = ConfigDict(
        populate_by_name=True,
    )

    order: RotationOrder = RotationOrder.QUATERNION
    values: list[float]
    """Rotation values whose length depends on ``order``:
    quaternion/quaternion_xyzw -> 4, euler_ptr -> 3, matrix -> 9.
    """


class TrackingFrame(BaseModel):
    """A single frame of tracking data.

    Corresponds to one line in the compact JSONL tracking format.
    """

    model_config = ConfigDict(
        populate_by_name=True,
    )

    frame_id: int = Field(ge=0)
    timestamp_s: float = Field(ge=0.0)
    raw_monotonic_ts: float | None = None
    protocol_ts_s: float | None = None
    zoom_raw: int | None = None
    focus_raw: int | None = None
    camera_id: int | str | None = None
    position: Annotated[list[float], Field(min_length=3, max_length=3)]
    """(x, y, z) position in the tracker's native coordinate system."""
    rotation: RotationData
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)
    # OpenTrackIO lens passthrough for live monitor (not consumed by BA / solve).
    # Absent when the sample has no lens block or the field is missing.
    focal_length_mm: float | None = None
    distortion_k1: float | None = None
    distortion_k2: float | None = None
    distortion_k3: float | None = None
    distortion_p1: float | None = None
    distortion_p2: float | None = None
    projection_offset_mm: Annotated[list[float], Field(min_length=2, max_length=2)] | None = None
    """Principal-point offset (x, y) in mm when present on the sample."""
    sensor_width_mm: float | None = None
    sensor_height_mm: float | None = None
