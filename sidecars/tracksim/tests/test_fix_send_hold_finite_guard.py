"""Guard send_hold pose finiteness: NaN timestamp/rate must raise InvalidTrajectoryError."""
from __future__ import annotations

import math
import pytest

from tracksim.cli.commands.send import send_hold
from tracksim.domain.errors import InvalidTrajectoryError
from tracksim.domain.pose import CameraPose
from tests.fakes import FakeClock, FakeEmitter


def test_send_hold_nan_timestamp_raises_invalid_trajectory():
    """send_hold with a pose whose timestamp is NaN must raise InvalidTrajectoryError."""
    # Bypass the CameraPose validator using model_construct
    pose = CameraPose.model_construct(
        pan=0.0, tilt=0.0, roll=0.0, x=0.0, y=0.0, z=0.0,
        focal_length=35.0, focus_distance=3.0, iris=None, entrance_pupil=None,
        frame=0, timestamp=float("nan"), rate=60.0,
    )
    assert not math.isfinite(pose.timestamp)
    emitter = FakeEmitter()
    clock = FakeClock()
    with pytest.raises(InvalidTrajectoryError):
        send_hold([emitter], pose, clock=clock, rate=30.0, duration=0.1)


def test_send_hold_inf_rate_in_pose_raises_invalid_trajectory():
    """send_hold with a pose whose rate is inf must raise InvalidTrajectoryError."""
    pose = CameraPose.model_construct(
        pan=0.0, tilt=0.0, roll=0.0, x=0.0, y=0.0, z=0.0,
        focal_length=35.0, focus_distance=3.0, iris=None, entrance_pupil=None,
        frame=0, timestamp=0.0, rate=float("inf"),
    )
    assert not math.isfinite(pose.rate)
    emitter = FakeEmitter()
    clock = FakeClock()
    with pytest.raises(InvalidTrajectoryError):
        send_hold([emitter], pose, clock=clock, rate=30.0, duration=0.1)


def test_send_hold_finite_pose_proceeds_normally():
    """send_hold with a finite pose must not raise and must emit frames."""
    pose = CameraPose(timestamp=1.0, rate=30.0)
    emitter = FakeEmitter()
    clock = FakeClock()
    op, data = send_hold([emitter], pose, clock=clock, rate=10.0, duration=0.2)
    assert op == "sim.send"
    assert data["frames"] >= 1
    assert len(emitter.emitted) >= 1
