from __future__ import annotations

from typing import Any

from tracksim.cli.render import NdjsonWriter, sim_event_fields
from tracksim.ports.clock import Clock
from tracksim.ports.emitter import Emitter
from tracksim.ports.pose_source import PoseSource
from tracksim.simulator import SimStopped, SimTick, Simulator


def make_simulator(
    source: PoseSource,
    emitters: list[Emitter],
    clock: Clock,
    *,
    rate: float,
    fail_fast: bool = False,
) -> Simulator:
    return Simulator(source, emitters, clock, rate=rate, fail_fast=fail_fast)


def run_stream(
    simulator: Simulator,
    writer: NdjsonWriter | None,
    *,
    max_ticks: int | None = None,
) -> tuple[str, dict[str, Any]]:
    # writer 非空（ndjson 模式）：逐事件流式写出；writer=None（json/text 模式）：
    # 不向 stdout 写任何中间行，只累计 summary，由 main 输出单个 envelope（修复 F2 stdout 污染）。
    # max_ticks 非空（来自 --duration*rate）：达到后调用 simulator.stop() 优雅收尾，使 run 有界可测。
    summary: dict[str, Any] = {"total_packets": 0, "ticks": 0, "reason": "completed"}
    ticks = 0
    for event in simulator.run():
        if writer is not None:
            writer.event(event)
        if isinstance(event, SimTick):
            ticks += 1
            if max_ticks is not None and ticks >= max_ticks:
                simulator.stop()
        if isinstance(event, SimStopped):
            summary = {"total_packets": event.total_packets, "reason": event.reason}
    summary["ticks"] = ticks
    return "sim.run", summary
