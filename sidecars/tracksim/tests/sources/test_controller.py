from dataclasses import dataclass

import pytest

from tracksim.domain.errors import NoControllerError
from tracksim.ports.controller_input import ControllerState
from tracksim.sources.controller import ControllerPoseSource


@dataclass
class MapEntry:
    channel: str
    source: str
    mode: str
    scale: float
    deadzone: float
    invert: bool
    # 默认 None，与 config 的 ControllerMappingEntry 一致（省略 clamp 即不钳制）
    clamp_min: float | None = None
    clamp_max: float | None = None


class FakeControllerInput:
    """Scripted ControllerInput returning a queued list of states."""

    def __init__(self, states: list[ControllerState]) -> None:
        self._states = states
        self._index = 0
        self.closed = False

    def list_devices(self):
        return []

    def open(self, index: int) -> None:
        return None

    def poll(self) -> ControllerState:
        state = self._states[min(self._index, len(self._states) - 1)]
        self._index += 1
        return state

    def close(self) -> None:
        self.closed = True


class StubClock:
    def now(self) -> float:
        return 0.0

    def sleep(self, seconds: float) -> None:
        return None


def _connected(axes):
    return ControllerState(axes=axes, buttons={}, connected=True)


def test_rate_mode_integrates_over_three_ticks():
    states = [_connected({"rightx": 1.0}) for _ in range(3)]
    controller = FakeControllerInput(states)
    mapping = [
        MapEntry(
            channel="pan",
            source="rightx",
            mode="rate",
            scale=10.0,
            deadzone=0.0,
            invert=False,
            clamp_min=-1000.0,
            clamp_max=1000.0,
        )
    ]
    source = ControllerPoseSource(controller, mapping, StubClock())

    source.next(0.1)
    source.next(0.1)
    pose = source.next(0.1)
    # 1.0 * 10.0 * 0.1 per tick * 3 ticks = 3.0
    assert pose.pan == pytest.approx(3.0, abs=1e-9)
    assert pose.frame == 3
    assert pose.timestamp == pytest.approx(0.3)


def test_deadzone_zeroes_small_value():
    controller = FakeControllerInput([_connected({"rightx": 0.05})])
    mapping = [
        MapEntry(
            channel="pan",
            source="rightx",
            mode="rate",
            scale=10.0,
            deadzone=0.1,
            invert=False,
            clamp_min=-1000.0,
            clamp_max=1000.0,
        )
    ]
    source = ControllerPoseSource(controller, mapping, StubClock())
    pose = source.next(0.1)
    assert pose.pan == pytest.approx(0.0, abs=1e-9)


def test_clamp_caps_at_clamp_max():
    controller = FakeControllerInput([_connected({"leftx": 1.0})])
    mapping = [
        MapEntry(
            channel="x",
            source="leftx",
            mode="absolute",
            scale=100.0,
            deadzone=0.0,
            invert=False,
            clamp_min=-5.0,
            clamp_max=5.0,
        )
    ]
    source = ControllerPoseSource(controller, mapping, StubClock())
    pose = source.next(0.1)
    # absolute: 1.0 * 100.0 = 100.0 -> clamped to 5.0
    assert pose.x == pytest.approx(5.0, abs=1e-9)


def test_no_controller_error_when_disconnected():
    state = ControllerState(axes={}, buttons={}, connected=False)
    controller = FakeControllerInput([state])
    source = ControllerPoseSource(controller, [], StubClock())
    with pytest.raises(NoControllerError):
        source.next(0.1)


def test_close_forwards_to_controller():
    controller = FakeControllerInput([_connected({})])
    source = ControllerPoseSource(controller, [], StubClock())
    source.close()
    assert controller.closed is True


def test_mapping_without_clamps_does_not_crash():
    # 防回归 F7：clamp_min/clamp_max 省略（默认 None）时不得对 None 调 min/max 抛 TypeError，
    # 应原样透传（不钳制）
    controller = FakeControllerInput([_connected({"leftx": 1.0})])
    mapping = [
        MapEntry(
            channel="x",
            source="leftx",
            mode="absolute",
            scale=10.0,
            deadzone=0.0,
            invert=False,
        )  # clamp_min / clamp_max 省略 -> None
    ]
    source = ControllerPoseSource(controller, mapping, StubClock())
    pose = source.next(0.1)
    assert pose.x == pytest.approx(10.0, abs=1e-9)
