from tracksim.domain.pose import CameraPose
from tracksim.track import Track
from tracksim.sources.track import TrackPoseSource
from tracksim.simulator import Simulator, SimStopped, SimTick
from tracksim.infra.clock import FakeClock
from tests.fakes import FakeEmitter


def test_track_plays_then_source_exhausted():
    track = Track(rate=10.0, camera="c", frames=[
        (0.0, CameraPose(pan=0.0)), (0.1, CameraPose(pan=1.0)), (0.2, CameraPose(pan=2.0))])
    sim = Simulator(TrackPoseSource(track, rate=10.0), [FakeEmitter()], FakeClock(), rate=10.0, fail_fast=False)
    events = list(sim.run())
    ticks = [e for e in events if isinstance(e, SimTick)]
    stopped = [e for e in events if isinstance(e, SimStopped)]
    assert len(ticks) == 3                              # cursor 0.0/0.1/0.2 都 <= 末帧 0.2
    assert stopped and stopped[-1].reason == "source-exhausted"
