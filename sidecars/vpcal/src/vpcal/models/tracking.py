"""Tracking data models.

Represents per-frame tracker output in the compact JSONL format.
See spec section 4.2 for the schema and supported rotation orders.
"""

from __future__ import annotations

from enum import Enum
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field


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
