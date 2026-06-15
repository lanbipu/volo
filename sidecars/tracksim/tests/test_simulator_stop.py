from tracksim.domain.pose import CameraPose
from tracksim.simulator import SimStopped, SimTick, Simulator
from tests.fakes import FakeClock, FakeEmitter, FakePoseSource


class StoppingEmitter:
    """Emitter that calls sim.stop() after its first emit."""

    name = "freed"

    def __init__(self) -> None:
        self.emitted: list[CameraPose] = []
        self.sim: Simulator | None = None

    def emit(self, pose: CameraPose) -> None:
        self.emitted.append(pose)
        if self.sim is not None and len(self.emitted) == 1:
            self.sim.stop()

    def close(self) -> None:
        pass


def test_stop_ends_loop_with_stopped_reason():
    src = FakePoseSource()  # unbounded
    em = StoppingEmitter()
    sim = Simulator(source=src, emitters=[em], clock=FakeClock(), rate=10.0)
    em.sim = sim

    events = list(sim.run())

    ticks = [e for e in events if isinstance(e, SimTick)]
    assert len(ticks) == 1
    assert isinstance(events[-1], SimStopped)
    assert events[-1].reason == "stopped"
    assert events[-1].total_packets == 1


def test_stop_before_run_yields_only_started_and_stopped():
    src = FakePoseSource()
    em = FakeEmitter(name="freed")
    sim = Simulator(source=src, emitters=[em], clock=FakeClock(), rate=10.0)
    sim.stop()

    events = list(sim.run())

    assert [type(e).__name__ for e in events] == ["SimStarted", "SimStopped"]
    assert events[-1].reason == "stopped"
    assert events[-1].total_packets == 0
