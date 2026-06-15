"""回归：成对反向输入在 clamp 边界应正确抵消；非法 channel 不得 crash。
（外部 review 两条 P2 finding 的守护）"""
from dataclasses import dataclass

import pytest

from tracksim.config import DEFAULT_CONTROLLER_MAPPING
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


def _default_source(states):
    return ControllerPoseSource(FakeControllerInput(states), DEFAULT_CONTROLLER_MAPPING, StubClock())


def test_both_triggers_at_rest_do_not_drift_z():
    # Finding A: z 默认 clamp_min=0、起始 z=0；同时按住 LT/RT 不应漂移（应抵消停在 0）。
    states = [ControllerState(axes={"lefttrigger": 1.0, "righttrigger": 1.0}, buttons={}, connected=True)]
    src = _default_source(states * 5)
    pose = None
    for _ in range(5):
        pose = src.next(0.1)
    assert pose.z == pytest.approx(0.0)


def test_both_paddles_at_focal_max_stay_pinned():
    # Finding A: 把 focal 顶到 300 后同时按住 P1/P3，应停在 300（不被中途 clamp 截成 295）。
    btn = ControllerState(axes={}, buttons={"p1": True, "p3": False, "p2": False, "p4": False}, connected=True)
    both = ControllerState(axes={}, buttons={"p1": True, "p3": True, "p2": False, "p4": False}, connected=True)
    # 先用 P1 顶到上限（100 ticks 足够），再切换成 P1+P3 同按。
    src = _default_source([btn] * 100 + [both])
    pose = None
    for _ in range(101):
        pose = src.next(0.1)
    assert pose.focal_length == pytest.approx(300.0)


def test_bad_channel_matching_camerapose_method_does_not_crash():
    # Finding B: channel 恰是 CameraPose 的方法名（如 model_dump）时不得 seed 绑定方法 -> 不得 TypeError。
    states = [ControllerState(axes={"rightx": 1.0}, buttons={}, connected=True)]
    mapping = [MapEntry(channel="model_dump", source="rightx", scale=10.0)]
    src = ControllerPoseSource(FakeControllerInput(states), mapping, StubClock())
    pose = src.next(0.1)  # 不得抛 TypeError
    assert pose.frame == 1  # model_dump 作为 extra 被 CameraPose 忽略，pose 合法
