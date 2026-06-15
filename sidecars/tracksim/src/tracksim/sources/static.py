from __future__ import annotations

from tracksim.domain.pose import CameraPose
from tracksim.ports.clock import Clock


class StaticPoseSource:
    """Pose source that returns a fixed pose, advancing frame/timestamp."""

    def __init__(self, pose: CameraPose, clock: Clock | None = None) -> None:
        self._pose = pose
        self._clock = clock
        self._frame = 0
        self._timestamp = 0.0

    def next(self, dt: float) -> CameraPose:
        self._frame += 1
        self._timestamp += dt
        return self._pose.model_copy(
            update={"frame": self._frame, "timestamp": self._timestamp}
        )

    def close(self) -> None:
        return None
