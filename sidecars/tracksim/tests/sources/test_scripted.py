import math

import pytest

from tracksim.domain.errors import InvalidTrajectoryError
from tracksim.sources.scripted import ScriptedPoseSource


def test_orbit_motion_at_known_phase():
    source = ScriptedPoseSource(motion="orbit", radius=2.0, speed=1.0)
    pose = source.next(math.pi / 2.0)
    # phase = speed * dt = pi/2 -> x = radius*cos, y = radius*sin
    assert pose.x == pytest.approx(2.0 * math.cos(math.pi / 2.0), abs=1e-9)
    assert pose.y == pytest.approx(2.0 * math.sin(math.pi / 2.0), abs=1e-9)
    assert pose.frame == 1
    assert pose.timestamp == pytest.approx(math.pi / 2.0)


def test_sine_motion_at_known_phase():
    source = ScriptedPoseSource(
        motion="sine", amplitude=10.0, freq=1.0, axis="pan"
    )
    pose = source.next(0.25)
    # phase = dt = 0.25 -> pan = amplitude * sin(2*pi*freq*phase)
    assert pose.pan == pytest.approx(10.0 * math.sin(2.0 * math.pi * 0.25), abs=1e-9)


def test_from_keyframes_interpolates_midpoint():
    frames = [
        {"t": 0.0, "pose": {"pan": 0.0, "x": 0.0}},
        {"t": 1.0, "pose": {"pan": 10.0, "x": 2.0}},
    ]
    source = ScriptedPoseSource.from_keyframes(frames)
    pose = source.next(0.5)
    assert pose.pan == pytest.approx(5.0, abs=1e-9)
    assert pose.x == pytest.approx(1.0, abs=1e-9)
    assert pose.frame == 1
    assert pose.timestamp == pytest.approx(0.5)


def test_from_keyframes_clamps_at_end():
    frames = [
        {"t": 0.0, "pose": {"pan": 0.0}},
        {"t": 1.0, "pose": {"pan": 10.0}},
    ]
    source = ScriptedPoseSource.from_keyframes(frames)
    pose = source.next(5.0)
    assert pose.pan == pytest.approx(10.0, abs=1e-9)


def test_from_keyframes_empty_raises():
    with pytest.raises(InvalidTrajectoryError):
        ScriptedPoseSource.from_keyframes([])


def test_from_keyframes_malformed_raises():
    with pytest.raises(InvalidTrajectoryError):
        ScriptedPoseSource.from_keyframes([{"t": 0.0}])


def test_scripted_accepts_rate_and_clock():
    # factory 会传 rate/clock；构造必须接受且 rate 写入每帧 pose（防回归 F4 签名不匹配）
    source = ScriptedPoseSource(motion="static", rate=50.0, clock=None)
    pose = source.next(0.1)
    assert pose.rate == 50.0


def test_from_keyframes_accepts_rate():
    frames = [{"t": 0.0, "pose": {"pan": 0.0}}, {"t": 1.0, "pose": {"pan": 10.0}}]
    source = ScriptedPoseSource.from_keyframes(frames, rate=30.0)
    assert source.next(0.5).rate == 30.0
