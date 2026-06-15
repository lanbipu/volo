import dataclasses

from tracksim.domain.pose import CameraPose
from tracksim.simulator import (
    SimEvent,
    SimStarted,
    SimStopped,
    SimTick,
    SimWarning,
)


def test_sim_started_fields():
    ev = SimStarted(protocols=["freed", "opentrackio"], rate=60.0)
    assert ev.protocols == ["freed", "opentrackio"]
    assert ev.rate == 60.0


def test_sim_tick_fields():
    pose = CameraPose()
    ev = SimTick(pose=pose, packets_sent=3, rate_actual=59.5)
    assert ev.pose is pose
    assert ev.packets_sent == 3
    assert ev.rate_actual == 59.5


def test_sim_warning_field():
    ev = SimWarning(message="send failed")
    assert ev.message == "send failed"


def test_sim_stopped_fields():
    ev = SimStopped(reason="source-exhausted", total_packets=120)
    assert ev.reason == "source-exhausted"
    assert ev.total_packets == 120


def test_events_are_dataclasses_and_union_members():
    for cls in (SimStarted, SimTick, SimWarning, SimStopped):
        assert dataclasses.is_dataclass(cls)
    members = set(getattr(SimEvent, "__args__", ()))
    assert members == {SimStarted, SimTick, SimWarning, SimStopped}
