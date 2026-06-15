import io
import json

from tracksim.cli import render
from tracksim.cli.commands import run
from tracksim.domain.pose import CameraPose
from tracksim.simulator import Simulator


class FakeEmitter:
    def __init__(self, name: str) -> None:
        self.name = name
        self.emitted = 0
        self.closed = False

    def emit(self, pose: CameraPose) -> None:
        self.emitted += 1

    def close(self) -> None:
        self.closed = True


class FakePoseSource:
    def __init__(self, frames: int) -> None:
        self._frames = frames
        self._n = 0
        self.closed = False

    def next(self, dt: float) -> CameraPose:
        self._n += 1
        if self._n > self._frames:
            raise StopIteration
        return CameraPose(frame=self._n)

    def close(self) -> None:
        self.closed = True


class FakeClock:
    def __init__(self) -> None:
        self.t = 0.0

    def now(self) -> float:
        return self.t

    def sleep(self, seconds: float) -> None:
        self.t += seconds


def test_make_simulator_returns_simulator():
    sim = run.make_simulator(
        FakePoseSource(2), [FakeEmitter("freed")], FakeClock(), rate=60.0, fail_fast=False
    )
    assert isinstance(sim, Simulator)


def test_run_stream_emits_ndjson_with_final_result():
    src = FakePoseSource(3)
    emitter = FakeEmitter("freed")
    sim = Simulator(src, [emitter], FakeClock(), rate=60.0)
    buf = io.StringIO()
    writer = render.NdjsonWriter(buf, request_id="rq", timestamp="2026-06-02T00:00:00Z")
    op, data = run.run_stream(sim, writer)
    assert op == "sim.run"
    objs = [json.loads(ln) for ln in buf.getvalue().splitlines() if ln]
    assert objs[0]["type"] == "start"
    assert objs[-1]["type"] == "result"
    assert objs[-1]["final"] is True
    assert any(o["type"] == "progress" for o in objs)
    assert data["total_packets"] == objs[-1]["total_packets"]


def test_run_stream_without_writer_collects_summary_no_stdout():
    # 防回归 F2：json/text 模式 writer=None，不写中间行，只返回 summary
    src = FakePoseSource(3)
    sim = Simulator(src, [FakeEmitter("freed")], FakeClock(), rate=60.0)
    op, data = run.run_stream(sim, None)
    assert op == "sim.run"
    assert data["ticks"] == 3
    assert data["total_packets"] == 3
    assert data["reason"] == "source-exhausted"
