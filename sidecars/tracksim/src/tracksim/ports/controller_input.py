from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

# 一个 ControllerState 能包含的全部 axis / button 键。
# SDL 后端的 poll() 产出与 mapping 校验共同引用此处，保证「合法 source」单一事实来源。
CONTROLLER_AXES = frozenset({
    "leftx", "lefty", "rightx", "righty", "lefttrigger", "righttrigger",
})
CONTROLLER_BUTTONS = frozenset({
    "a", "b", "x", "y", "leftshoulder", "rightshoulder", "back", "start",
    "p1", "p2", "p3", "p4",  # Xbox Elite 背板拨片：p1=右上 p2=右下 p3=左上 p4=左下
})
CONTROLLER_SOURCES = CONTROLLER_AXES | CONTROLLER_BUTTONS


@dataclass
class ControllerDevice:
    index: int
    name: str
    guid: str


@dataclass
class ControllerState:
    # axis keys: leftx, lefty, rightx, righty in -1..1;
    #            lefttrigger, righttrigger in 0..1   (见 CONTROLLER_AXES)
    axes: dict[str, float] = field(default_factory=dict)
    # button keys: a, b, x, y, leftshoulder, rightshoulder, back, start,
    #              p1, p2, p3, p4 (Elite paddles)    (见 CONTROLLER_BUTTONS)
    buttons: dict[str, bool] = field(default_factory=dict)
    connected: bool = True


class ControllerInput(Protocol):
    def list_devices(self) -> list[ControllerDevice]: ...
    def open(self, index: int) -> None: ...
    def poll(self) -> ControllerState: ...
    def close(self) -> None: ...
