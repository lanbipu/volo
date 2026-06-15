import pytest

from tracksim.domain.errors import TransportError
from tracksim.simulator import SimTick, Simulator
from tests.fakes import FakeClock, FakeEmitter, FakePoseSource


def test_tick_once_returns_single_tick_no_pacing():
    src = FakePoseSource(limit=5)
    em = FakeEmitter(name="freed")
    clock = FakeClock()
    sim = Simulator(source=src, emitters=[em], clock=clock, rate=20.0)

    tick = sim.tick_once()

    assert isinstance(tick, SimTick)
    assert src.calls == 1
    assert src.dts == [0.05]  # 1 / 20
    assert len(em.emitted) == 1
    assert tick.packets_sent == 1
    assert tick.rate_actual == 20.0
    # no pacing: clock.sleep never called
    assert clock.sleeps == []


def test_tick_once_counts_all_emitters_and_accumulates():
    src = FakePoseSource(limit=5)
    a = FakeEmitter(name="freed")
    b = FakeEmitter(name="opentrackio")
    sim = Simulator(source=src, emitters=[a, b], clock=FakeClock(), rate=10.0)

    t1 = sim.tick_once()
    t2 = sim.tick_once()

    assert t1.packets_sent == 2
    assert t2.packets_sent == 4


def test_tick_once_fail_fast_propagates_transport_error():
    src = FakePoseSource(limit=5)
    bad = FakeEmitter(name="freed", fail_times=1)
    sim = Simulator(
        source=src,
        emitters=[bad],
        clock=FakeClock(),
        rate=10.0,
        fail_fast=True,
    )
    with pytest.raises(TransportError):
        sim.tick_once()
