from __future__ import annotations

import math

from pydantic import BaseModel, field_validator


def _check_finite(name: str, v: float) -> float:
    if not math.isfinite(v):
        raise ValueError(f"{name} must be a finite number, got {v!r}")
    return v


class CameraPose(BaseModel):
    """Canonical physical camera pose shared by all protocol encoders."""

    pan: float = 0.0
    tilt: float = 0.0
    roll: float = 0.0
    x: float = 0.0
    y: float = 0.0
    z: float = 0.0
    focal_length: float = 35.0
    focus_distance: float = 3.0
    iris: float | None = None
    entrance_pupil: float | None = None
    frame: int = 0
    timestamp: float = 0.0
    rate: float = 60.0

    @field_validator("pan", "tilt", "roll", "x", "y", "z", "focal_length", "focus_distance", "timestamp", "rate")
    @classmethod
    def _finite_required(cls, v: float, info) -> float:  # noqa: ANN001
        return _check_finite(info.field_name, v)

    @field_validator("iris", "entrance_pupil")
    @classmethod
    def _finite_optional(cls, v: float | None, info) -> float | None:  # noqa: ANN001
        if v is None:
            return v
        return _check_finite(info.field_name, v)


# 控制器 mapping 可作为目标的 pose 字段（排除 frame/timestamp/rate 记账字段）。
VALID_POSE_CHANNELS = frozenset(CameraPose.model_fields) - {"frame", "timestamp", "rate"}
