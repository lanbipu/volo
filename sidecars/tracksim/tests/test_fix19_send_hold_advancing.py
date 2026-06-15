"""Fix 19 (round 4 finding 2): send_hold must advance frame/timestamp per emitted frame."""
from __future__ import annotations

import pytest

from tracksim.cli.commands.send import send_hold
from tracksim.domain.pose import CameraPose


class FakeEmitter:
    def __init__(self, name: str = "fake") -> None:
        self.name = name
        self.emitted: list[CameraPose] = []
        self.closed = False

    def emit(self, pose: CameraPose) -> None:
        self.emitted.append(pose)

    def close(self) -> None:
        self.closed = True


class FakeClock:
    def __init__(self) -> None:
        self.t = 0.0
        self.slept: list[float] = []

    def now(self) -> float:
        return self.t

    def sleep(self, seconds: float) -> None:
        self.slept.append(seconds)
        self.t += seconds


def test_send_hold_frames_are_monotonically_increasing():
    """Each emitted pose must have a strictly greater frame number than the previous."""
    e = FakeEmitter()
    clock = FakeClock()
    pose = CameraPose(frame=10, timestamp=1.0, rate=30.0)
    send_hold([e], pose, clock=clock, rate=30.0, duration=0.1)
    frames = [p.frame for p in e.emitted]
    assert len(frames) >= 2, f"expected at least 2 frames, got {frames}"
    for i in range(1, len(frames)):
        assert frames[i] > frames[i - 1], f"frames not increasing: {frames}"


def test_send_hold_timestamps_are_monotonically_increasing():
    """Each emitted pose must have a strictly greater timestamp than the previous."""
    e = FakeEmitter()
    clock = FakeClock()
    pose = CameraPose(frame=0, timestamp=5.0, rate=60.0)
    send_hold([e], pose, clock=clock, rate=60.0, duration=0.1)
    ts = [p.timestamp for p in e.emitted]
    assert len(ts) >= 2, f"expected at least 2 timestamps, got {ts}"
    for i in range(1, len(ts)):
        assert ts[i] > ts[i - 1], f"timestamps not increasing: {ts}"


def test_send_hold_frame_increment_is_one():
    """Consecutive emitted frames must differ by exactly 1."""
    e = FakeEmitter()
    clock = FakeClock()
    pose = CameraPose(frame=0, timestamp=0.0, rate=10.0)
    send_hold([e], pose, clock=clock, rate=10.0, duration=0.5)
    frames = [p.frame for p in e.emitted]
    for i in range(1, len(frames)):
        assert frames[i] - frames[i - 1] == 1, f"frame gap != 1 at index {i}: {frames}"


def test_send_hold_timestamp_increment_matches_rate():
    """Timestamp increments between consecutive poses must equal 1/rate."""
    rate = 20.0
    e = FakeEmitter()
    clock = FakeClock()
    pose = CameraPose(frame=0, timestamp=0.0, rate=rate)
    send_hold([e], pose, clock=clock, rate=rate, duration=0.2)
    ts = [p.timestamp for p in e.emitted]
    expected_step = 1.0 / rate
    for i in range(1, len(ts)):
        got = ts[i] - ts[i - 1]
        assert abs(got - expected_step) < 1e-9, f"step {got} != {expected_step} at index {i}"


def test_send_hold_single_frame_unchanged():
    """A single-frame hold (duration=0.05, rate=10) must emit exactly once without mutation."""
    e = FakeEmitter()
    clock = FakeClock()
    pose = CameraPose(frame=7, timestamp=3.5, rate=10.0)
    send_hold([e], pose, clock=clock, rate=10.0, duration=0.05)
    assert len(e.emitted) == 1
    assert e.emitted[0].frame == 7
    assert e.emitted[0].timestamp == 3.5
