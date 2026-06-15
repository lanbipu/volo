"""Fix 7: ControllerPoseSource must read button state when source is a button name."""
from __future__ import annotations

import pytest

from tracksim.ports.controller_input import ControllerState
from tracksim.sources.controller import ControllerPoseSource


# ---- Helpers ----

class MapEntry:
    def __init__(self, channel, source, mode="absolute", scale=1.0, deadzone=0.0,
                 invert=False, clamp_min=None, clamp_max=None):
        self.channel = channel
        self.source = source
        self.mode = mode
        self.scale = scale
        self.deadzone = deadzone
        self.invert = invert
        self.clamp_min = clamp_min
        self.clamp_max = clamp_max


class FakeController:
    def __init__(self, state: ControllerState) -> None:
        self._state = state
        self.closed = False

    def list_devices(self): return []
    def open(self, index): pass
    def poll(self): return self._state
    def close(self): self.closed = True


class FakeClock:
    def now(self): return 0.0
    def sleep(self, s): pass


# ---- Tests ----

def test_pressed_button_drives_channel():
    """Button 'a' pressed -> source 'a' in buttons dict -> channel gets 1.0 * scale."""
    state = ControllerState(
        axes={},
        buttons={"a": True, "b": False},
        connected=True,
    )
    mapping = [MapEntry(channel="pan", source="a", mode="absolute", scale=45.0)]
    src = ControllerPoseSource(FakeController(state), mapping, FakeClock())
    pose = src.next(0.1)
    # button 'a' is pressed -> 1.0 * 45.0 = 45.0
    assert pose.pan == pytest.approx(45.0)


def test_released_button_gives_zero():
    """Button 'b' released -> 0.0 * scale = 0.0."""
    state = ControllerState(
        axes={},
        buttons={"a": True, "b": False},
        connected=True,
    )
    mapping = [MapEntry(channel="tilt", source="b", mode="absolute", scale=30.0)]
    src = ControllerPoseSource(FakeController(state), mapping, FakeClock())
    pose = src.next(0.1)
    assert pose.tilt == pytest.approx(0.0)


def test_button_source_rate_mode_integrates():
    """Button in rate mode: pressing drives accumulation each tick."""
    states = [
        ControllerState(axes={}, buttons={"leftshoulder": True}, connected=True),
        ControllerState(axes={}, buttons={"leftshoulder": True}, connected=True),
        ControllerState(axes={}, buttons={"leftshoulder": False}, connected=True),
    ]
    idx = [0]

    class MultiStateController:
        def list_devices(self): return []
        def open(self, i): pass
        def poll(self):
            s = states[min(idx[0], len(states) - 1)]
            idx[0] += 1
            return s
        def close(self): pass

    mapping = [MapEntry(channel="x", source="leftshoulder", mode="rate", scale=10.0)]
    src = ControllerPoseSource(MultiStateController(), mapping, FakeClock())

    src.next(0.1)   # pressed: +1.0 * 10.0 * 0.1 = +1.0
    src.next(0.1)   # pressed: +1.0 again -> 2.0
    pose = src.next(0.1)  # released: +0.0 -> still 2.0
    assert pose.x == pytest.approx(2.0)


def test_axis_source_still_works_when_not_in_buttons():
    """When source is an axis name (not in buttons), axis value is used as before."""
    state = ControllerState(
        axes={"rightx": 0.5},
        buttons={},
        connected=True,
    )
    mapping = [MapEntry(channel="pan", source="rightx", mode="absolute", scale=100.0)]
    src = ControllerPoseSource(FakeController(state), mapping, FakeClock())
    pose = src.next(0.1)
    assert pose.pan == pytest.approx(50.0)


def test_unknown_source_defaults_to_zero():
    """If source is neither in buttons nor axes, fall back to 0.0 (unchanged behavior)."""
    state = ControllerState(axes={}, buttons={}, connected=True)
    mapping = [MapEntry(channel="z", source="nonexistent", mode="absolute", scale=99.0)]
    src = ControllerPoseSource(FakeController(state), mapping, FakeClock())
    pose = src.next(0.1)
    assert pose.z == pytest.approx(0.0)
