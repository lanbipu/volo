import pytest

from tracksim.cli.commands import send
from tracksim.domain.errors import InvalidTrajectoryError
from tracksim.domain.pose import CameraPose


class FakeEmitter:
    def __init__(self, name: str) -> None:
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


def test_build_pose_from_flags():
    pose = send.build_pose({"pan": 30.0, "x": 1.5}, None)
    assert pose.pan == 30.0
    assert pose.x == 1.5


def test_build_pose_stdin_overrides():
    pose = send.build_pose({"pan": 0.0}, {"pan": 45.0, "tilt": -10.0})
    assert pose.pan == 45.0
    assert pose.tilt == -10.0


def test_build_pose_rejects_bad_field():
    with pytest.raises(InvalidTrajectoryError):
        send.build_pose({}, {"pan": "not-a-number"})


def test_send_once_emits_to_all_emitters():
    e1 = FakeEmitter("freed")
    e2 = FakeEmitter("opentrackio")
    pose = CameraPose(pan=10.0)
    op, data = send.send_once([e1, e2], pose)
    assert op == "sim.send"
    assert len(e1.emitted) == 1
    assert len(e2.emitted) == 1
    assert data["packets_sent"] == 2
    assert set(data["protocols"]) == {"freed", "opentrackio"}


def test_send_hold_repeats_for_duration():
    e1 = FakeEmitter("freed")
    clock = FakeClock()
    pose = CameraPose()
    op, data = send.send_hold([e1], pose, clock=clock, rate=10.0, duration=0.5)
    assert op == "sim.send"
    assert len(e1.emitted) == 5
    assert data["packets_sent"] == 5


def test_send_hold_sub_frame_duration_sends_at_least_one_frame():
    # 防回归 F8：duration=0.05, rate=10 -> 0.5 帧；round 会银行家舍入成 0（静默空发），
    # 必须 ceil+下限 1，至少发 1 帧
    e1 = FakeEmitter("freed")
    op, data = send.send_hold([e1], CameraPose(), clock=FakeClock(), rate=10.0, duration=0.05)
    assert data["frames"] == 1
    assert data["packets_sent"] == 1
    assert len(e1.emitted) == 1


def test_send_hold_rejects_nonpositive_duration():
    e1 = FakeEmitter("freed")
    with pytest.raises(InvalidTrajectoryError):
        send.send_hold([e1], CameraPose(), clock=FakeClock(), rate=10.0, duration=0.0)
