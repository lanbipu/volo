from __future__ import annotations

import math
from typing import Any

from pydantic import ValidationError

from tracksim.domain.errors import InvalidTrajectoryError
from tracksim.domain.pose import CameraPose
from tracksim.ports.clock import Clock
from tracksim.ports.emitter import Emitter

_POSE_FIELDS = set(CameraPose.model_fields.keys())


def build_pose(flags: dict[str, Any], stdin_obj: dict[str, Any] | None) -> CameraPose:
    values: dict[str, Any] = {
        k: v for k, v in flags.items() if k in _POSE_FIELDS and v is not None
    }
    if stdin_obj is not None and not isinstance(stdin_obj, dict):
        raise InvalidTrajectoryError(
            f"stdin pose must be a JSON object, got {type(stdin_obj).__name__}",
            details={"type": type(stdin_obj).__name__},
        )
    if stdin_obj:
        for k, v in stdin_obj.items():
            if k not in _POSE_FIELDS:
                raise InvalidTrajectoryError(
                    f"unknown pose field: {k!r}",
                    details={"field": k},
                )
            values[k] = v
    try:
        return CameraPose(**values)
    except ValidationError as exc:
        # Sanitize pydantic error dicts: 'input' may be non-finite float and 'ctx.error'
        # may be a bare exception — neither is JSON-serializable.
        errors = []
        for err in exc.errors(include_url=False):
            e = dict(err)
            if "input" in e:
                inp = e["input"]
                if isinstance(inp, float) and not math.isfinite(inp):
                    e["input"] = str(inp)
            if "ctx" in e and isinstance(e["ctx"], dict):
                ctx = dict(e["ctx"])
                if "error" in ctx and isinstance(ctx["error"], Exception):
                    ctx["error"] = str(ctx["error"])
                e["ctx"] = ctx
            errors.append(e)
        raise InvalidTrajectoryError(
            "invalid pose input",
            details={"errors": errors},
        ) from exc


def send_once(emitters: list[Emitter], pose: CameraPose) -> tuple[str, dict[str, Any]]:
    for emitter in emitters:
        emitter.emit(pose)
    return "sim.send", {
        "packets_sent": len(emitters),
        "protocols": [e.name for e in emitters],
        "frames": 1,
    }


def send_hold(
    emitters: list[Emitter],
    pose: CameraPose,
    *,
    clock: Clock,
    rate: float,
    duration: float,
) -> tuple[str, dict[str, Any]]:
    if not math.isfinite(duration) or duration <= 0 or not math.isfinite(rate) or rate <= 0:
        raise InvalidTrajectoryError(
            "send hold requires finite duration > 0 and finite rate > 0",
            details={"duration": duration, "rate": rate},
        )
    if not math.isfinite(pose.timestamp) or not math.isfinite(pose.rate):
        raise InvalidTrajectoryError(
            "send hold requires pose with finite timestamp and rate",
            details={"timestamp": pose.timestamp, "rate": pose.rate},
        )
    period = 1.0 / rate
    # 任何正 duration 至少发 1 帧；用 ceil 而非 round，避免银行家舍入把 0.5 帧截成 0 帧的静默空发（修复 F8）
    total_frames = max(1, math.ceil(duration * rate))
    sent = 0
    for i in range(total_frames):
        frame_pose = pose.model_copy(update={"frame": pose.frame + i, "timestamp": pose.timestamp + i / rate})
        for emitter in emitters:
            emitter.emit(frame_pose)
            sent += 1
        clock.sleep(period)
    return "sim.send", {
        "packets_sent": sent,
        "protocols": [e.name for e in emitters],
        "frames": total_frames,
    }
