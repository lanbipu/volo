from __future__ import annotations

import math
from typing import Any

from tracksim.cli.render import NdjsonWriter
from tracksim.domain.errors import InvalidTrajectoryError
from tracksim.ports.clock import Clock
from tracksim.ports.controller_input import ControllerInput


def list_controllers(controller_input: ControllerInput) -> tuple[str, dict[str, Any]]:
    devices = [
        {"index": d.index, "name": d.name, "guid": d.guid}
        for d in controller_input.list_devices()
    ]
    return "controllers.list", {"devices": devices}


def monitor_stream(
    controller_input: ControllerInput,
    writer: NdjsonWriter | None,
    *,
    clock: Clock,
    rate: float,
    samples: int,
) -> tuple[str, dict[str, Any]]:
    # writer 非空（ndjson 模式）：逐采样流式写出；writer=None（json/text 模式）：
    # 不污染 stdout，只采样并累计最后一帧状态，由 main 输出单个 envelope（修复 F2）。
    if not math.isfinite(rate) or rate <= 0:
        raise InvalidTrajectoryError(
            f"--rate must be a finite number > 0, got {rate}",
            details={"rate": rate},
        )
    period = 1.0 / rate
    controller_input.open(0)
    if writer is not None:
        writer.start({"index": 0, "rate": rate})
    taken = 0
    last: dict[str, Any] = {}
    try:
        for _ in range(samples):
            state = controller_input.poll()
            last = {
                "axes": dict(state.axes),
                "buttons": dict(state.buttons),
                "connected": state.connected,
            }
            if writer is not None:
                writer.progress(last)
            taken += 1
            clock.sleep(period)
    finally:
        controller_input.close()
    if writer is not None:
        writer.result(status="ok", data={"samples": taken})
    return "controllers.monitor", {"samples": taken, "last": last}
