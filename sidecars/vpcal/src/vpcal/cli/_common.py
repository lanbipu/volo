"""Shared CLI adapter infrastructure.

Everything in this module is *adapter* concern (CLI_DESIGN_SPEC §1.3): output
envelopes (§4), the mandatory flag set (§3.2), AI-stable profile resolution
(§3.4), and translation of :class:`~vpcal.core.errors.VpcalError` into error
envelopes + process exit codes (§5).  Core SDK code never imports this.
"""

from __future__ import annotations

import dataclasses
import functools
import json
import logging
import os
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Callable

import click

from vpcal.core.errors import RuntimeFailure, VpcalError

SCHEMA_VERSION = "1.0"


@dataclasses.dataclass
class OperationOutput:
    """What an operation function returns to the CLI wrapper.

    ``data`` is the structured payload (envelope ``data``); ``text`` is the
    human-readable rendering used in ``--output text`` mode; ``exit_code`` lets
    a successful-but-degraded operation signal a non-zero code (e.g. 9 partial
    failure) while still emitting a success envelope.
    """

    data: dict[str, Any]
    text: str
    exit_code: int = 0


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def resolve_output_format(ctx: click.Context, explicit: str | None) -> str:
    """Resolve the effective output format (§3.4).

    Priority: explicit leaf ``--output`` > explicit group ``--output`` >
    ``AI_AGENT=1`` env (→ json) > ``text``.
    """
    if explicit:
        return explicit.lower()
    group = (ctx.obj or {}).get("output")
    if group:
        return str(group).lower()
    if os.environ.get("AI_AGENT") == "1":
        return "json"
    return "text"


def _color_enabled(ctx: click.Context, no_color: bool) -> bool:
    if no_color or (ctx.obj or {}).get("no_color"):
        return False
    if os.environ.get("NO_COLOR") is not None:
        return False
    return sys.stdout.isatty()


def configure_logging(ctx: click.Context, log_level: str | None, verbose: bool, quiet: bool) -> None:
    """Configure logging to **stderr** (§3.3: stdout stays data-only)."""
    if quiet:
        level_name = "ERROR"
    elif verbose:
        level_name = "DEBUG"
    elif log_level:
        level_name = log_level.upper()
    else:
        level_name = (ctx.obj or {}).get("log_level") or "WARNING"
    level = getattr(logging, str(level_name).upper(), logging.WARNING)
    root = logging.getLogger("vpcal")
    root.setLevel(level)
    if not root.handlers:
        handler = logging.StreamHandler(sys.stderr)
        handler.setFormatter(logging.Formatter("%(levelname)s %(name)s: %(message)s"))
        root.addHandler(handler)


def _success_envelope(operation_id: str, data: dict[str, Any], request_id: str, duration_ms: int) -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "status": "ok",
        "operation_id": operation_id,
        "data": data,
        "meta": {
            "request_id": request_id,
            "duration_ms": duration_ms,
            "timestamp": _utc_now_iso(),
        },
    }


def _error_envelope(operation_id: str, err: VpcalError, request_id: str, duration_ms: int) -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "status": "error",
        "operation_id": operation_id,
        "error": {
            "code": err.code,
            "exit_code": err.exit_code,
            "message": err.message,
            "retryable": err.retryable,
            "details": err.details,
        },
        "meta": {
            "request_id": request_id,
            "duration_ms": duration_ms,
            "timestamp": _utc_now_iso(),
        },
    }


def _emit(envelope: dict[str, Any], fmt: str, text: str) -> None:
    if fmt == "json":
        click.echo(json.dumps(envelope, ensure_ascii=False))
    elif fmt == "ndjson":
        request_id = envelope.get("meta", {}).get("request_id", "")
        start_evt = {
            "type": "start",
            "sequence": 0,
            "timestamp": _utc_now_iso(),
            "request_id": request_id,
            "schema_version": SCHEMA_VERSION,
        }
        result_evt = {
            "type": "result",
            "sequence": 1,
            "timestamp": _utc_now_iso(),
            "request_id": request_id,
            "final": True,
            **envelope,
        }
        click.echo(json.dumps(start_evt, ensure_ascii=False))
        click.echo(json.dumps(result_evt, ensure_ascii=False))
    else:  # text
        click.echo(text)


# ── Mandatory flag set (§3.2) ────────────────────────────────────────


def common_options(fn: Callable) -> Callable:
    """Attach the mandatory CLI flag set to a leaf command.

    Applied per leaf command so they may appear *after* the subcommand
    (e.g. ``vpcal version --output json``).  Group-level values act as
    defaults; explicit leaf values win.
    """
    decorators = [
        click.option(
            "--output",
            "-o",
            "output",
            type=click.Choice(["text", "json", "ndjson", "stream-json"], case_sensitive=False),
            default=None,
            help="Output format: text | json | ndjson.",
        ),
        click.option("--log-level", "log_level", default=None, help="debug | info | warn | error."),
        click.option("--verbose", "-v", is_flag=True, help="Shorthand for --log-level debug."),
        click.option("--quiet", "-q", is_flag=True, help="Suppress non-error output."),
        click.option("--no-color", is_flag=True, help="Disable ANSI colour (also honours NO_COLOR)."),
        click.option("--no-input", is_flag=True, help="Refuse interactive prompts (recommended for agents)."),
        click.option("--yes", "-y", is_flag=True, help="Skip confirmation prompts."),
        click.option("--dry-run", "dry_run", is_flag=True, help="Validate and plan without writing."),
    ]
    for dec in reversed(decorators):
        fn = dec(fn)
    return fn


# ── Streaming operations (NDJSON event flow) ────────────────────────


class StreamEmitter:
    """Incremental NDJSON event writer for long-running operations.

    Events share the envelope discipline: every line carries ``type``,
    monotonically increasing ``sequence``, ``timestamp`` and ``request_id``.
    In ``text`` mode events render as one human line each (stderr-free,
    stdout stays the single data channel).  Lines are flushed immediately so
    a host (Volo streaming bridge) sees them in real time.
    """

    def __init__(self, request_id: str, fmt: str) -> None:
        self.request_id = request_id
        self.fmt = fmt
        self._sequence = 0
        self._lock = threading.Lock()

    def emit(self, event_type: str, payload: dict[str, Any] | None = None, *, text: str | None = None) -> None:
        with self._lock:
            self._sequence += 1
            seq = self._sequence
        if self.fmt == "ndjson":
            line = {
                "type": event_type,
                "sequence": seq,
                "timestamp": _utc_now_iso(),
                "request_id": self.request_id,
                **(payload or {}),
            }
            sys.stdout.write(json.dumps(line, ensure_ascii=False) + "\n")
        else:
            sys.stdout.write((text or f"[{event_type}] {json.dumps(payload or {}, ensure_ascii=False)}") + "\n")
        sys.stdout.flush()

    @property
    def next_sequence(self) -> int:
        return self._sequence + 1


def run_streaming_operation(
    operation_id: str,
    body: Callable[[StreamEmitter], OperationOutput],
    **flags: Any,
) -> None:
    """Like :func:`run_operation` but for event-streaming commands.

    Emits a ``start`` event immediately, hands ``body`` a
    :class:`StreamEmitter` for incremental events, then closes the stream
    with a final ``result`` (or error) event embedding the standard envelope.
    Defaults to ``ndjson`` output (a streaming command in plain-json mode
    would buffer everything, defeating the point).
    """
    ctx = click.get_current_context()
    fmt = resolve_output_format(ctx, flags.get("output"))
    if fmt in ("stream-json", "json"):
        fmt = "ndjson"
    configure_logging(ctx, flags.get("log_level"), flags.get("verbose", False), flags.get("quiet", False))

    request_id = str(uuid.uuid4())
    start = time.monotonic()
    emitter = StreamEmitter(request_id, fmt)
    if fmt == "ndjson":
        sys.stdout.write(json.dumps({
            "type": "start",
            "sequence": 0,
            "timestamp": _utc_now_iso(),
            "request_id": request_id,
            "schema_version": SCHEMA_VERSION,
            "operation_id": operation_id,
        }, ensure_ascii=False) + "\n")
        sys.stdout.flush()

    def _final(envelope: dict[str, Any], text: str) -> None:
        if fmt == "ndjson":
            line = {
                "type": "result" if envelope.get("status") == "ok" else "error",
                "sequence": emitter.next_sequence,
                "timestamp": _utc_now_iso(),
                "request_id": request_id,
                "final": True,
                **envelope,
            }
            sys.stdout.write(json.dumps(line, ensure_ascii=False) + "\n")
        else:
            sys.stdout.write(text + "\n")
        sys.stdout.flush()

    try:
        result = body(emitter)
    except VpcalError as err:
        duration_ms = int((time.monotonic() - start) * 1000)
        _final(_error_envelope(operation_id, err, request_id, duration_ms),
               text=f"error: {err.message} (exit {err.exit_code})")
        ctx.exit(err.exit_code)
    except click.exceptions.Exit:
        raise
    except KeyboardInterrupt:
        duration_ms = int((time.monotonic() - start) * 1000)
        err = RuntimeFailure("interrupted")
        _final(_error_envelope(operation_id, err, request_id, duration_ms), text="error: interrupted")
        ctx.exit(130)
    except Exception as exc:  # noqa: BLE001 — last-resort: classify as runtime error
        duration_ms = int((time.monotonic() - start) * 1000)
        err = RuntimeFailure(str(exc) or exc.__class__.__name__)
        _final(_error_envelope(operation_id, err, request_id, duration_ms),
               text=f"error: {err.message} (exit 1)")
        logging.getLogger("vpcal").debug("unhandled exception", exc_info=True)
        ctx.exit(1)
    else:
        duration_ms = int((time.monotonic() - start) * 1000)
        _final(_success_envelope(operation_id, result.data, request_id, duration_ms), text=result.text)
        ctx.exit(result.exit_code)


# ── Operation wrapper ────────────────────────────────────────────────


def run_operation(operation_id: str, body: Callable[..., OperationOutput], **flags: Any) -> None:
    """Execute an operation body and emit the appropriate envelope + exit code.

    ``body`` is a zero-arg callable returning an :class:`OperationOutput` or
    raising a :class:`VpcalError`.  ``flags`` carries the resolved CLI flags
    (output, no_color, etc.); ``stream-json`` is normalised to ``ndjson``.
    """
    ctx = click.get_current_context()
    fmt = resolve_output_format(ctx, flags.get("output"))
    if fmt == "stream-json":
        fmt = "ndjson"
    configure_logging(ctx, flags.get("log_level"), flags.get("verbose", False), flags.get("quiet", False))

    request_id = str(uuid.uuid4())
    start = time.monotonic()
    try:
        result = body()
    except VpcalError as err:
        duration_ms = int((time.monotonic() - start) * 1000)
        env = _error_envelope(operation_id, err, request_id, duration_ms)
        _emit(env, fmt, text=f"error: {err.message} (exit {err.exit_code})")
        ctx.exit(err.exit_code)
    except click.exceptions.Exit:
        raise
    except Exception as exc:  # noqa: BLE001 — last-resort: classify as runtime error
        duration_ms = int((time.monotonic() - start) * 1000)
        err = RuntimeFailure(str(exc) or exc.__class__.__name__)
        env = _error_envelope(operation_id, err, request_id, duration_ms)
        _emit(env, fmt, text=f"error: {err.message} (exit 1)")
        logging.getLogger("vpcal").debug("unhandled exception", exc_info=True)
        ctx.exit(1)
    else:
        duration_ms = int((time.monotonic() - start) * 1000)
        env = _success_envelope(operation_id, result.data, request_id, duration_ms)
        _emit(env, fmt, text=result.text)
        ctx.exit(result.exit_code)
