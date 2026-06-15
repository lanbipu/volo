import pytest

from tracksim.domain.errors import TransportError
from tracksim.simulator import SimTick, SimWarning, Simulator
from tests.fakes import FakeClock, FakeEmitter, FakePoseSource


def test_transport_error_becomes_warning_when_not_fail_fast():
    src = FakePoseSource(limit=1)
    bad = FakeEmitter(name="freed", fail_times=1)
    good = FakeEmitter(name="opentrackio")
    sim = Simulator(
        source=src,
        emitters=[bad, good],
        clock=FakeClock(),
        rate=10.0,
        fail_fast=False,
    )

    events = list(sim.run())

    warnings = [e for e in events if isinstance(e, SimWarning)]
    assert len(warnings) == 1
    assert "freed emit failed" in warnings[0].message

    ticks = [e for e in events if isinstance(e, SimTick)]
    assert len(ticks) == 1
    # only the good emitter succeeded -> 1 packet
    assert ticks[0].packets_sent == 1
    # warning is emitted before the tick of that frame
    w_idx = events.index(warnings[0])
    t_idx = events.index(ticks[0])
    assert w_idx < t_idx


def test_transport_error_raises_when_fail_fast():
    src = FakePoseSource(limit=1)
    bad = FakeEmitter(name="freed", fail_times=1)
    sim = Simulator(
        source=src,
        emitters=[bad],
        clock=FakeClock(),
        rate=10.0,
        fail_fast=True,
    )

    gen = sim.run()
    assert type(next(gen)).__name__ == "SimStarted"
    with pytest.raises(TransportError):
        next(gen)
