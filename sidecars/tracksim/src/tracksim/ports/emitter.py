from __future__ import annotations

from typing import Protocol

from tracksim.domain.pose import CameraPose


class Emitter(Protocol):
    name: str

    def emit(self, pose: CameraPose) -> None: ...
    def close(self) -> None: ...
