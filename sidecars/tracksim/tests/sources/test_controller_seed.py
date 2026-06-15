from dataclasses import dataclass

import pytest

from tracksim.ports.controller_input import ControllerState
from tracksim.sources.controller import ControllerPoseSource


@dataclass
class MapEntry:
    channel: str
    source: str
    mode: str = "rate"
    scale: float = 1.0
    deadzone: float = 0.0
    invert: bool = False
    clamp_min: float | None = None
    clamp_max: float | None = None


class FakeControllerInput:
    def __init__(self, states):
        self._states = states
        self._i = 0

    def list_devices(self):
        return []

    def open(self, index):
        return None

    def poll(self):
        s = self._states[min(self._i, len(self._states) - 1)]
        self._i += 1
        return s

    def close(self):
        return None


class StubClock:
    def now(self):
        return 0.0

    def sleep(self, seconds):
        return None


def test_rate_channels_seed_from_camerapose_defaults():
    # 未按拨片：focal/focus 应停在 CameraPose 默认值，而非 0。
    states = [ControllerState(axes={}, buttons={"p1": False, "p2": False}, connected=True)]
    mapping = [
        MapEntry(channel="focal_length", source="p1"),
        MapEntry(channel="focus_distance", source="p2"),
        MapEntry(channel="pan", source="rightx"),
    ]
    src = ControllerPoseSource(FakeControllerInput(states), mapping, StubClock())
    pose = src.next(0.1)
    assert pose.focal_length == pytest.approx(35.0)
    assert pose.focus_distance == pytest.approx(3.0)
    assert pose.pan == pytest.approx(0.0)  # 未映射来源静止仍为 0
