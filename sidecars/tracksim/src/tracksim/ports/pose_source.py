from __future__ import annotations

from typing import Protocol

from tracksim.domain.pose import CameraPose


class PoseSource(Protocol):
    def next(self, dt: float) -> CameraPose: ...
    def close(self) -> None: ...
