from __future__ import annotations

import math
from typing import Any

from tracksim.domain.errors import InvalidTrajectoryError
from tracksim.domain.pose import CameraPose
from tracksim.ports.clock import Clock


class ScriptedPoseSource:
    """Procedural / keyframe pose source.

    `rate` 与 `clock` 与 StaticPoseSource 保持一致的构造契约（factory 会传入）：
    rate 写入每帧 CameraPose.rate；clock 作为可选依赖保留（按 dt 推进，无需墙钟）。
    """

    def __init__(
        self,
        motion: str = "static",
        radius: float = 1.0,
        speed: float = 1.0,
        amplitude: float = 10.0,
        freq: float = 1.0,
        axis: str = "pan",
        rate: float = 60.0,
        clock: Clock | None = None,
    ) -> None:
        self._motion = motion
        self._radius = radius
        self._speed = speed
        self._amplitude = amplitude
        self._freq = freq
        self._axis = axis
        self._rate = rate
        self._clock = clock
        self._keyframes: list[tuple[float, CameraPose]] | None = None
        self._phase = 0.0
        self._cursor = 0.0
        self._frame = 0
        self._timestamp = 0.0

    @classmethod
    def from_keyframes(
        cls,
        frames: list[dict],
        *,
        rate: float = 60.0,
        clock: Clock | None = None,
    ) -> "ScriptedPoseSource":
        if not frames:
            raise InvalidTrajectoryError("keyframe list is empty")
        keyframes: list[tuple[float, CameraPose]] = []
        for frame in frames:
            if "t" not in frame or "pose" not in frame:
                raise InvalidTrajectoryError(
                    "each keyframe must have 't' and 'pose'"
                )
            keyframes.append((float(frame["t"]), CameraPose(**frame["pose"])))
        keyframes.sort(key=lambda kf: kf[0])
        source = cls(motion="keyframes", rate=rate, clock=clock)
        source._keyframes = keyframes
        return source

    def next(self, dt: float) -> CameraPose:
        self._frame += 1
        self._timestamp += dt
        if self._keyframes is not None:
            self._cursor += dt
            pose = self._interpolate(self._cursor)
        else:
            pose = self._procedural(dt)
        return pose.model_copy(
            update={
                "frame": self._frame,
                "timestamp": self._timestamp,
                "rate": self._rate,
            }
        )

    def _procedural(self, dt: float) -> CameraPose:
        if self._motion == "orbit":
            self._phase += self._speed * dt
            return CameraPose(
                x=self._radius * math.cos(self._phase),
                y=self._radius * math.sin(self._phase),
            )
        if self._motion == "sine":
            self._phase += dt
            value = self._amplitude * math.sin(
                2.0 * math.pi * self._freq * self._phase
            )
            return CameraPose(**{self._axis: value})
        if self._motion == "sweep":
            self._phase += self._speed * dt
            return CameraPose(**{self._axis: self._phase})
        return CameraPose()

    def _interpolate(self, t: float) -> CameraPose:
        assert self._keyframes is not None
        keyframes = self._keyframes
        if t <= keyframes[0][0]:
            return keyframes[0][1]
        if t >= keyframes[-1][0]:
            return keyframes[-1][1]
        for i in range(len(keyframes) - 1):
            t0, p0 = keyframes[i]
            t1, p1 = keyframes[i + 1]
            if t0 <= t <= t1:
                span = t1 - t0
                ratio = 0.0 if span == 0 else (t - t0) / span
                return self._lerp_pose(p0, p1, ratio)
        return keyframes[-1][1]

    @staticmethod
    def _lerp_pose(p0: CameraPose, p1: CameraPose, ratio: float) -> CameraPose:
        fields = ["pan", "tilt", "roll", "x", "y", "z", "focal_length", "focus_distance"]
        update: dict[str, Any] = {}
        for name in fields:
            v0 = getattr(p0, name)
            v1 = getattr(p1, name)
            update[name] = v0 + (v1 - v0) * ratio
        return p0.model_copy(update=update)

    def close(self) -> None:
        return None
