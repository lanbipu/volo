from __future__ import annotations

import json
from typing import Any, TextIO

from tracksim.envelope import SCHEMA_VERSION
from tracksim.simulator import (
    SimEvent,
    SimStarted,
    SimStopped,
    SimTick,
    SimWarning,
)


def render_success(envelope: dict[str, Any], fmt: str) -> str:
    if fmt == "json":
        return json.dumps(envelope)
    if fmt == "ndjson":
        return json.dumps(_result_line(envelope))
    return _text_success(envelope)


def render_error(envelope: dict[str, Any], fmt: str) -> str:
    if fmt == "json":
        return json.dumps(envelope)
    if fmt == "ndjson":
        return json.dumps(_result_line(envelope))
    return _text_error(envelope)


def _result_line(envelope: dict[str, Any]) -> dict[str, Any]:
    line: dict[str, Any] = {
        "type": "result",
        "sequence": 0,
        "timestamp": envelope["meta"]["timestamp"],
        "request_id": envelope["meta"]["request_id"],
        "schema_version": SCHEMA_VERSION,
        "final": True,
        "status": envelope["status"],
        "operation_id": envelope["operation_id"],
    }
    if envelope["status"] == "ok":
        line["data"] = envelope["data"]
    else:
        line["error"] = envelope["error"]
    return line


def _text_success(envelope: dict[str, Any]) -> str:
    data = envelope.get("data")
    if isinstance(data, dict):
        body = "\n".join(f"{k}: {v}" for k, v in data.items())
    else:
        body = str(data)
    return body


def _text_error(envelope: dict[str, Any]) -> str:
    err = envelope["error"]
    return f"error [{err['code']}] (exit {err['exit_code']}): {err['message']}"


class NdjsonWriter:
    """Writes sequenced ndjson event lines to a text stream."""

    def __init__(self, stream: TextIO, *, request_id: str, timestamp: str) -> None:
        self._stream = stream
        self._request_id = request_id
        self._timestamp = timestamp
        self._sequence = 0

    def _emit(self, event_type: str, fields: dict[str, Any]) -> None:
        line: dict[str, Any] = {
            "type": event_type,
            "sequence": self._sequence,
            "timestamp": self._timestamp,
            "request_id": self._request_id,
            "schema_version": SCHEMA_VERSION,
        }
        line.update(fields)
        self._stream.write(json.dumps(line) + "\n")
        self._stream.flush()
        self._sequence += 1

    def start(self, fields: dict[str, Any]) -> None:
        self._emit("start", fields)

    def progress(self, fields: dict[str, Any]) -> None:
        self._emit("progress", fields)

    def warning(self, message: str) -> None:
        self._emit("warning", {"message": message})

    def result(self, *, status: str, data: dict[str, Any]) -> None:
        self._emit("result", {"final": True, "status": status, "data": data})

    def event(self, event: SimEvent) -> None:
        fields = sim_event_fields(event)
        self._emit(fields.pop("type"), fields)


class TextProgressWriter:
    """Writes human-readable progress to a text stream (typically stderr).

    Uses carriage return to overwrite the current line each tick,
    keeping the terminal clean while showing real-time data.
    Supports both SimEvent (run) and start/progress/result (monitor) interfaces.
    """

    def __init__(self, stream: TextIO) -> None:
        self._stream = stream
        self._is_tty = hasattr(stream, "isatty") and stream.isatty()

    def _write_line(self, text: str, *, overwrite: bool = False) -> None:
        if overwrite and self._is_tty:
            self._stream.write(f"\r{text}\033[K")
        else:
            self._stream.write(text + "\n")
        self._stream.flush()

    # -- SimEvent interface (used by run_stream) --

    def event(self, event: SimEvent) -> None:
        if isinstance(event, SimStarted):
            protos = ", ".join(event.protocols)
            self._write_line(f"streaming {protos} @ {event.rate:.0f} Hz ...")
        elif isinstance(event, SimTick):
            p = event.pose
            self._write_line(
                f"pan={p.pan:+7.1f}  tilt={p.tilt:+7.1f}  roll={p.roll:+6.1f}"
                f"  x={p.x:+5.2f}  y={p.y:+5.2f}  z={p.z:+5.2f}"
                f"  focal={p.focal_length:5.1f}mm"
                f"  #{event.packets_sent}",
                overwrite=True,
            )
        elif isinstance(event, SimWarning):
            self._write_line(f"warning: {event.message}")
        elif isinstance(event, SimStopped):
            if self._is_tty:
                self._stream.write("\n")
            self._write_line(
                f"stopped: {event.reason}, {event.total_packets} packets sent"
            )

    # -- start/progress/result interface (used by monitor_stream) --

    def start(self, fields: dict[str, Any]) -> None:
        rate = fields.get("rate", "?")
        self._write_line(f"monitoring controller @ {rate} Hz ...")

    def progress(self, fields: dict[str, Any]) -> None:
        axes = fields.get("axes", {})
        parts = [f"{k}={v:+5.2f}" for k, v in axes.items()]
        self._write_line("  ".join(parts), overwrite=True)

    def result(self, *, status: str, data: dict[str, Any]) -> None:
        if self._is_tty:
            self._stream.write("\n")
        samples = data.get("samples", "?")
        self._write_line(f"done: {samples} samples")


def sim_event_fields(event: SimEvent) -> dict[str, Any]:
    if isinstance(event, SimStarted):
        return {"type": "start", "protocols": list(event.protocols), "rate": event.rate}
    if isinstance(event, SimTick):
        return {
            "type": "progress",
            "packets_sent": event.packets_sent,
            "rate_actual": event.rate_actual,
            "pose": event.pose.model_dump(),
        }
    if isinstance(event, SimWarning):
        return {"type": "warning", "message": event.message}
    if isinstance(event, SimStopped):
        return {
            "type": "result",
            "final": True,
            "status": "ok",
            "reason": event.reason,
            "total_packets": event.total_packets,
        }
    raise TypeError(f"unknown SimEvent: {event!r}")
