from tracksim.simulator import SimTick, Simulator
from tests.fakes import FakeClock, FakeEmitter, FakePoseSource


def test_packets_sent_is_cumulative_total_over_emitters():
    src = FakePoseSource(limit=2)
    a = FakeEmitter(name="freed")
    b = FakeEmitter(name="opentrackio")
    sim = Simulator(source=src, emitters=[a, b], clock=FakeClock(), rate=10.0)

    ticks = [e for e in sim.run() if isinstance(e, SimTick)]

    # 2 emitters * 2 frames = 4 packets total; cumulative per tick
    assert [t.packets_sent for t in ticks] == [2, 4]


def test_rate_actual_derived_from_clock_deltas():
    src = FakePoseSource(limit=2)
    em = FakeEmitter(name="freed")
    # rate=10 -> dt=0.1 -> each frame clock advances 0.1 via sleep
    sim = Simulator(source=src, emitters=[em], clock=FakeClock(), rate=10.0)

    ticks = [e for e in sim.run() if isinstance(e, SimTick)]

    # first tick: no prior sleep elapsed -> falls back to nominal rate
    assert ticks[0].rate_actual == 10.0
    # second tick: 0.1s elapsed since first -> 1/0.1 = 10.0
    assert abs(ticks[1].rate_actual - 10.0) < 1e-9
