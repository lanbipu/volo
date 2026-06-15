from tracksim.simulator import (
    SimStarted,
    SimStopped,
    SimTick,
    Simulator,
)
from tests.fakes import FakeClock, FakeEmitter, FakePoseSource


def test_run_emits_started_ticks_stopped_in_order():
    src = FakePoseSource(limit=3)
    em = FakeEmitter(name="freed")
    sim = Simulator(source=src, emitters=[em], clock=FakeClock(), rate=10.0)

    events = list(sim.run())

    assert isinstance(events[0], SimStarted)
    assert events[0].protocols == ["freed"]
    assert events[0].rate == 10.0

    ticks = [e for e in events if isinstance(e, SimTick)]
    assert len(ticks) == 3

    assert isinstance(events[-1], SimStopped)
    assert events[-1].reason == "source-exhausted"


def test_run_passes_dt_one_over_rate_to_source():
    src = FakePoseSource(limit=2)
    sim = Simulator(source=src, emitters=[FakeEmitter()], clock=FakeClock(), rate=50.0)
    list(sim.run())
    assert src.dts == [0.02, 0.02]


def test_run_started_lists_all_emitter_names():
    src = FakePoseSource(limit=1)
    a = FakeEmitter(name="freed")
    b = FakeEmitter(name="opentrackio")
    sim = Simulator(source=src, emitters=[a, b], clock=FakeClock(), rate=10.0)
    events = list(sim.run())
    assert isinstance(events[0], SimStarted)
    assert events[0].protocols == ["freed", "opentrackio"]
