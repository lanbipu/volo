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


def test_bad_mapping_entry_is_harmless_noop_alongside_good_entry():
    # 防回归 finding 2：坏条目在运行时不得中断，且不影响合法条目。
    states = [ControllerState(axes={"rightx": 1.0}, buttons={}, connected=True)]
    mapping = [
        MapEntry(channel="bogus", source="alsobad", scale=10.0),  # 坏条目
        MapEntry(channel="pan", source="rightx", scale=10.0),     # 合法条目
    ]
    src = ControllerPoseSource(FakeControllerInput(states), mapping, StubClock())
    pose = src.next(0.1)  # 不得抛异常
    assert pose.pan == pytest.approx(1.0)  # 合法条目照常工作
