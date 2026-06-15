from __future__ import annotations

import argparse
import json
import logging
import math
import os
import signal
import sys
import time
from typing import Any, TextIO

from tracksim.cli import render, runtime
from tracksim.cli.commands import (
    config_cmd,
    controllers as controllers_cmd,
    decode as decode_cmd,
    factory,
    meta as meta_cmd,
    run as run_cmd,
    send as send_cmd,
)
from tracksim.config import load_config
from tracksim.domain.errors import ConfigError, TracksimError
from tracksim.envelope import EXIT_OK, EXIT_SIGINT, EXIT_USAGE, error_envelope, success_envelope
from tracksim.infra.clock import WallClock
from tracksim.simulator import Simulator

_LOG = logging.getLogger("tracksim")


def _add_global_flags(parser: argparse.ArgumentParser, *, suppress: bool = False) -> None:
    # suppress=True 用于挂到 subparser 的副本：未显式给出的 flag 不写回 namespace，
    # 因此不会用 None/False 覆盖在子命令之前已解析的全局 flag 值（argparse 的 parents 已知陷阱）。
    def d(real: Any) -> Any:
        return argparse.SUPPRESS if suppress else real

    parser.add_argument("--version", action="store_true", default=d(False), help="Show version and exit")
    parser.add_argument("--yes", "-y", action="store_true", default=d(False), help="Skip confirmations")
    parser.add_argument("--dry-run", action="store_true", default=d(False), help="Simulate without side effects")
    parser.add_argument("--config", metavar="PATH", default=d(None), help="Config file (TOML/YAML/JSON)")
    parser.add_argument("--output", "-o", choices=["text", "json", "ndjson", "stream-json"], default=d(None), help="Output format")
    parser.add_argument("--input-format", default=d("json"), help="stdin input format")
    parser.add_argument("--log-level", choices=["debug", "info", "warn", "error"], default=d("info"))
    parser.add_argument("--verbose", "-v", action="count", default=d(0))
    parser.add_argument("--quiet", "-q", action="store_true", default=d(False))
    parser.add_argument("--no-color", action="store_true", default=d(False))
    parser.add_argument("--no-input", action="store_true", default=d(False))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="tracksim", description="Camera tracking protocol simulator")
    _add_global_flags(parser)  # 真实默认值挂在 root：支持「全局 flag 在子命令之前」
    gp = argparse.ArgumentParser(add_help=False)
    _add_global_flags(gp, suppress=True)  # 同一组 flag 挂到每个 subparser：支持「全局 flag 在子命令之后」
    sub = parser.add_subparsers(dest="command")

    p_run = sub.add_parser("run", parents=[gp], help="Stream poses to enabled protocols")
    p_run.add_argument("--source", choices=["controller", "script", "static", "fbx", "track"], default="script")
    p_run.add_argument("input", nargs="?", default=None, help="Input file for --source fbx/track")
    p_run.add_argument("--camera", default=None, help="Camera name for --source fbx")
    p_run.add_argument("--protocol", action="append", choices=["freed", "opentrackio"], default=None)
    p_run.add_argument("--rate", type=float, default=None)
    p_run.add_argument("--duration", type=float, default=None)
    p_run.add_argument("--loop", action="store_true",
                       help="--source track/fbx：播完游标回绕、无缝循环（不耗尽，靠 --duration 或 Ctrl-C 停止）")

    p_send = sub.add_parser("send", parents=[gp], help="Send one frame or hold a fixed pose")
    p_send.add_argument("--protocol", action="append", choices=["freed", "opentrackio"], default=None)
    p_send.add_argument("--duration", type=float, default=None)
    p_send.add_argument("--rate", type=float, default=None)
    for field in ("pan", "tilt", "roll", "x", "y", "z", "focal_length", "focus_distance"):
        p_send.add_argument(f"--{field.replace('_', '-')}", type=float, default=None, dest=field)

    p_ctrl = sub.add_parser("controllers", parents=[gp], help="Controller utilities")
    ctrl_sub = p_ctrl.add_subparsers(dest="subcommand", required=True)
    ctrl_sub.add_parser("list", parents=[gp], help="List controllers")
    p_mon = ctrl_sub.add_parser("monitor", parents=[gp], help="Stream controller axis/button values")
    p_mon.add_argument("--rate", type=float, default=30.0)
    p_mon.add_argument("--samples", type=int, default=100)

    p_cfg = sub.add_parser("config", parents=[gp], help="Config utilities")
    cfg_sub = p_cfg.add_subparsers(dest="subcommand", required=True)
    p_cfg_init = cfg_sub.add_parser("init", parents=[gp], help="Write default config")
    p_cfg_init.add_argument("--path", default="tracksim.toml")
    cfg_sub.add_parser("show", parents=[gp], help="Show effective config")
    cfg_sub.add_parser("validate", parents=[gp], help="Validate config")

    p_freed = sub.add_parser("freed", parents=[gp], help="FreeD utilities")
    freed_sub = p_freed.add_subparsers(dest="subcommand", required=True)
    p_freed_dec = freed_sub.add_parser("decode", parents=[gp], help="Decode a FreeD packet (hex or stdin)")
    p_freed_dec.add_argument("hex", nargs="?", default=None)

    p_otrk = sub.add_parser("opentrackio", parents=[gp], help="OpenTrackIO utilities")
    otrk_sub = p_otrk.add_subparsers(dest="subcommand", required=True)
    otrk_sub.add_parser("decode", parents=[gp], help="Decode an OpenTrackIO packet (stdin)")

    sub.add_parser("manifest", parents=[gp], help="Output contract manifest")
    sub.add_parser("schema", parents=[gp], help="Output CLI structure schema")
    p_comp = sub.add_parser("completion", parents=[gp], help="Output shell completion script")
    p_comp.add_argument("shell", choices=["bash", "zsh", "fish"])
    sub.add_parser("version", parents=[gp], help="Output version metadata")

    p_conv = sub.add_parser("convert", parents=[gp], help="Convert an FBX camera animation to track.json")
    p_conv.add_argument("input", help="Input FBX path")
    p_conv.add_argument("--out", required=True, help="Output track.json path")
    p_conv.add_argument("--camera", default=None, help="Camera name (required if FBX has multiple)")

    return parser


def emit_success(
    stream: TextIO,
    operation_id: str,
    data: Any,
    *,
    fmt: str,
    request_id: str,
    timestamp: str,
    duration_ms: int,
) -> None:
    env = success_envelope(
        operation_id, data, request_id=request_id, duration_ms=duration_ms, timestamp=timestamp
    )
    stream.write(render.render_success(env, fmt) + "\n")


def emit_error(
    stream: TextIO,
    operation_id: str,
    error: TracksimError,
    *,
    fmt: str,
    request_id: str,
    timestamp: str,
    duration_ms: int,
) -> None:
    env = error_envelope(
        operation_id,
        code=error.code,
        exit_code=error.exit_code,
        message=error.message,
        retryable=error.retryable,
        details=error.details,
        request_id=request_id,
        duration_ms=duration_ms,
        timestamp=timestamp,
    )
    stream.write(render.render_error(env, fmt) + "\n")


def exit_for_error(error: TracksimError) -> int:
    return error.exit_code


def _normalize_fmt(fmt: str) -> str:
    return "ndjson" if fmt == "stream-json" else fmt


def _read_stdin_json(no_input: bool) -> dict[str, Any] | None:
    from tracksim.domain.errors import InvalidTrajectoryError
    if no_input or sys.stdin.isatty():
        return None
    raw = sys.stdin.read().strip()
    if not raw:
        return None
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise InvalidTrajectoryError(
            f"stdin is not valid JSON: {exc}",
            details={"error": str(exc)},
        ) from exc


def _operation_id_for(args: argparse.Namespace) -> str:
    cmd = args.command
    sub = getattr(args, "subcommand", None)
    mapping = {
        ("run", None): "sim.run",
        ("send", None): "sim.send",
        ("controllers", "list"): "controllers.list",
        ("controllers", "monitor"): "controllers.monitor",
        ("config", "init"): "config.init",
        ("config", "show"): "config.show",
        ("config", "validate"): "config.validate",
        ("freed", "decode"): "freed.decode",
        ("opentrackio", "decode"): "opentrackio.decode",
        ("manifest", None): "meta.manifest",
        ("schema", None): "meta.schema",
        ("completion", None): "meta.completion",
        ("version", None): "meta.version",
        ("convert", None): "sim.convert",
    }
    return mapping.get((cmd, sub), "INTERNAL")


def _dispatch(args: argparse.Namespace, fmt: str, request_id: str, timestamp: str) -> tuple[str, Any]:
    cmd = args.command
    sub = getattr(args, "subcommand", None)
    clock = WallClock()

    if cmd == "version":
        return meta_cmd.version()
    if cmd == "manifest":
        return meta_cmd.manifest()
    if cmd == "schema":
        return meta_cmd.schema()
    if cmd == "completion":
        return "meta.completion", {"completion": meta_cmd.completion(args.shell)}
    if cmd == "convert":
        config = load_config(args.config)
        from tracksim.cli.commands import convert as convert_cmd
        return convert_cmd.convert(args.input, out=args.out, camera=args.camera, config=config, dry_run=args.dry_run)
    if cmd == "config" and sub == "init":
        # 全局 --yes 映射为 force：允许覆盖已存在的配置（CLI_DESIGN_SPEC §9）
        return config_cmd.init(args.path, dry_run=args.dry_run, force=args.yes)
    if cmd == "config" and sub == "show":
        config = load_config(args.config)
        return config_cmd.show(config)
    if cmd == "config" and sub == "validate":
        config = load_config(args.config)
        return config_cmd.validate(config)
    if cmd == "freed" and sub == "decode":
        if args.hex:
            from tracksim.domain.errors import InvalidTrajectoryError as _ITE
            try:
                raw = bytes.fromhex(args.hex)
            except ValueError as exc:
                raise _ITE(
                    f"invalid hex string: {exc}",
                    details={"input": args.hex},
                ) from exc
        else:
            raw = sys.stdin.buffer.read()
        return decode_cmd.freed_decode(raw)
    if cmd == "opentrackio" and sub == "decode":
        raw = sys.stdin.buffer.read()
        return decode_cmd.opentrackio_decode(raw)
    if cmd == "controllers" and sub == "list":
        from tracksim.infra.sdl_controller import SDLControllerInput

        ci = SDLControllerInput()
        try:
            return controllers_cmd.list_controllers(ci)
        finally:
            ci.close()
    if cmd == "controllers" and sub == "monitor":
        from tracksim.infra.sdl_controller import SDLControllerInput

        ci = SDLControllerInput()
        if fmt == "ndjson":
            writer = render.NdjsonWriter(sys.stdout, request_id=request_id, timestamp=timestamp)
        elif fmt == "text" and sys.stderr.isatty():
            writer = render.TextProgressWriter(sys.stderr)
        else:
            writer = None
        return controllers_cmd.monitor_stream(ci, writer, clock=clock, rate=args.rate, samples=args.samples)
    if cmd == "send":
        config = load_config(args.config)
        protocols = args.protocol or [p for p, on in (("freed", config.protocols.freed), ("opentrackio", config.protocols.opentrackio)) if on]
        if not protocols:
            raise ConfigError(
                "no protocols enabled; enable freed/opentrackio in config or pass --protocol",
                details={"protocols": protocols},
            )
        _validate_duration(args.duration)
        if args.rate is not None and (not math.isfinite(args.rate) or args.rate <= 0):
            from tracksim.domain.errors import InvalidTrajectoryError
            raise InvalidTrajectoryError(
                f"--rate must be a finite number > 0, got {args.rate}",
                details={"rate": args.rate},
            )
        if args.dry_run:
            stdin_obj = _read_stdin_json(args.no_input)
            flags = {f: getattr(args, f, None) for f in ("pan", "tilt", "roll", "x", "y", "z", "focal_length", "focus_distance")}
            pose = send_cmd.build_pose(flags, stdin_obj)
            rate = args.rate if args.rate is not None else (config.freed.rate_hz if "freed" in protocols else config.opentrackio.rate_hz)
            if args.duration is not None and (not math.isfinite(rate) or rate <= 0):
                from tracksim.domain.errors import InvalidTrajectoryError
                raise InvalidTrajectoryError(
                    f"effective rate must be a finite number > 0 for --duration, got {rate}",
                    details={"rate": rate},
                )
            frames = max(1, math.ceil(args.duration * rate)) if args.duration is not None else 1
            targets: dict[str, Any] = {}
            if "freed" in protocols:
                targets["freed"] = {"ip": config.freed.target_ip, "port": config.freed.port}
            if "opentrackio" in protocols:
                targets["opentrackio"] = {"ip": config.opentrackio.ip, "port": config.opentrackio.port}
            return "sim.send", {"dry_run_plan": {"protocols": protocols, "targets": targets, "pose": pose.model_dump(), "frames": frames}}
        # Validate pose FIRST before opening any transports (finding 4)
        stdin_obj = _read_stdin_json(args.no_input)
        flags = {f: getattr(args, f, None) for f in ("pan", "tilt", "roll", "x", "y", "z", "focal_length", "focus_distance")}
        pose = send_cmd.build_pose(flags, stdin_obj)
        emitters = factory.build_emitters(config, protocols)
        try:
            if args.duration is not None:
                rate = args.rate if args.rate is not None else (config.freed.rate_hz if "freed" in protocols else config.opentrackio.rate_hz)
                return send_cmd.send_hold(emitters, pose, clock=clock, rate=rate, duration=args.duration)
            return send_cmd.send_once(emitters, pose)
        finally:
            for e in emitters:
                e.close()
    if cmd == "run":
        config = load_config(args.config)
        protocols = args.protocol or [p for p, on in (("freed", config.protocols.freed), ("opentrackio", config.protocols.opentrackio)) if on]
        if not protocols:
            raise ConfigError(
                "no protocols enabled; enable freed/opentrackio in config or pass --protocol",
                details={"protocols": protocols},
            )
        rate = args.rate if args.rate is not None else (config.freed.rate_hz if "freed" in protocols else config.opentrackio.rate_hz)
        # --duration（秒）映射为最大帧数，使 run 有界；不给则无界（直到 SIGINT / source 耗尽）
        _validate_duration(args.duration)
        if not math.isfinite(rate) or rate <= 0:
            from tracksim.domain.errors import InvalidTrajectoryError
            raise InvalidTrajectoryError(
                f"--rate must be a finite number > 0, got {rate}",
                details={"rate": rate},
            )
        max_ticks = max(1, math.ceil(args.duration * rate)) if args.duration is not None else None
        if getattr(args, "loop", False) and args.source not in ("track", "fbx"):
            _LOG.warning("--loop 仅对 --source track/fbx 有效；--source %s 已忽略该选项", args.source)
        if args.dry_run:
            max_ticks_plan = max(1, math.ceil(args.duration * rate)) if args.duration is not None else None
            return "sim.run", {"dry_run_plan": {"protocols": protocols, "source": args.source, "rate": rate, "max_ticks": max_ticks_plan}}
        # fbx/track：装载结构化轨迹回放（fbx 先经 Blender 转 track.json）；rate 默认取 track.rate（§11）。
        # controller：特判打开 SDL 设备（保持 factory 设备无关、可无硬件测试，修复 F5）。
        # 先建 source（含转换/设备打开），失败则不构造 emitters，避免泄漏。
        if args.source in ("fbx", "track"):
            track_path = args.input
            if not track_path:
                from tracksim.domain.errors import InvalidTrajectoryError
                raise InvalidTrajectoryError(f"--source {args.source} requires an input file path")
            if args.source == "fbx":
                from tracksim.infra.blender_fbx import convert_fbx
                track_path = convert_fbx(args.input, camera=args.camera, config=config, use_cache=True)
            source, rate = factory.build_track_source(track_path, rate=args.rate, clock=clock, loop=args.loop)
            max_ticks = max(1, math.ceil(args.duration * rate)) if args.duration is not None else None
        elif args.source == "controller":
            from tracksim.infra.sdl_controller import SDLControllerInput
            from tracksim.sources.controller import ControllerPoseSource

            ci = SDLControllerInput()
            try:
                device = config.controller.device
                device_index = int(device) if device is not None else 0
            except (TypeError, ValueError):
                ci.close()
                raise ConfigError(
                    f"controller.device must be an integer index, got {config.controller.device!r}",
                    details={"device": config.controller.device},
                )
            try:
                ci.open(device_index)  # 无手柄 -> NoControllerError(exit 10)
            except Exception:
                ci.close()
                raise
            mapping = factory.resolve_controller_mapping(config)
            factory.warn_controller_mapping(mapping, _LOG)
            source = ControllerPoseSource(ci, mapping, clock)
        else:
            source = factory.build_source(config, args.source, rate=rate, clock=clock)
        try:
            emitters = factory.build_emitters(config, protocols)
        except Exception:
            source.close()
            raise
        sim = run_cmd.make_simulator(source, emitters, clock, rate=rate, fail_fast=False)
        is_interrupted = _install_sigint(sim)
        if fmt == "ndjson":
            writer = render.NdjsonWriter(sys.stdout, request_id=request_id, timestamp=timestamp)
        elif fmt == "text" and sys.stderr.isatty():
            writer = render.TextProgressWriter(sys.stderr)
        else:
            writer = None
        try:
            op, data = run_cmd.run_stream(sim, writer, max_ticks=max_ticks)
            if is_interrupted():
                data["_interrupted"] = True
                data["_sig_exit_code"] = is_interrupted.exit_code()
            return op, data
        finally:
            source.close()
            for e in emitters:
                e.close()
    raise TracksimError("no command given")


def _install_sigint(sim: Simulator):  # returns Callable[[], bool] with .exit_code()
    _signum: list[int | None] = [None]

    def _handler(signum, frame):  # noqa: ANN001
        _signum[0] = signum
        sim.stop()

    signal.signal(signal.SIGINT, _handler)
    signal.signal(signal.SIGTERM, _handler)

    def is_interrupted() -> bool:
        return _signum[0] is not None

    def exit_code() -> int:
        sn = _signum[0]
        return 128 + sn if sn is not None else 0

    is_interrupted.exit_code = exit_code  # type: ignore[attr-defined]

    return is_interrupted


def _validate_duration(value: float | None) -> None:
    """Raise InvalidTrajectoryError if value is not None and not a finite positive number."""
    if value is not None and (not math.isfinite(value) or value <= 0):
        from tracksim.domain.errors import InvalidTrajectoryError
        raise InvalidTrajectoryError(
            f"--duration must be a finite number > 0, got {value}",
            details={"duration": value},
        )


def _configure_logging(args: argparse.Namespace) -> None:
    level = logging.INFO
    if args.quiet:
        level = logging.ERROR
    elif args.verbose >= 1:
        level = logging.DEBUG
    else:
        level = {"debug": logging.DEBUG, "info": logging.INFO, "warn": logging.WARNING, "error": logging.ERROR}[args.log_level]
    logging.basicConfig(stream=sys.stderr, level=level, format="%(levelname)s %(name)s: %(message)s")


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    ai_agent = os.environ.get("AI_AGENT") == "1"
    no_color_env = bool(os.environ.get("NO_COLOR"))
    request_id = runtime.new_request_id()
    timestamp = runtime.utc_now_iso()
    started = time.monotonic()
    # Resolve effective argv early so _wants_json works even when argv=None (sys.argv path)
    effective_argv: list[str] = argv if argv is not None else sys.argv[1:]

    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        if exc.code in (0, None):
            return EXIT_OK
        fmt = _normalize_fmt(_detect_fmt(effective_argv, ai_agent=ai_agent))
        if fmt in ("json", "ndjson"):
            env = error_envelope(
                "INTERNAL", code="ARG_VALIDATION", exit_code=EXIT_USAGE,
                message="invalid command-line arguments", retryable=False, details={},
                request_id=request_id, duration_ms=0, timestamp=timestamp,
            )
            sys.stdout.write(render.render_error(env, fmt) + "\n")
        return EXIT_USAGE

    _configure_logging(args)
    fmt = _normalize_fmt(runtime.resolve_output(args.output, ai_agent_env=ai_agent, is_tty=sys.stdout.isatty()))

    if args.version:
        op, data = meta_cmd.version()
        emit_success(sys.stdout, op, data, fmt=fmt, request_id=request_id, timestamp=timestamp, duration_ms=int((time.monotonic() - started) * 1000))
        return EXIT_OK
    if args.command is None:
        parser.print_help(sys.stderr)
        return EXIT_USAGE

    streaming = (fmt == "ndjson") and (
        args.command == "run" or (args.command == "controllers" and getattr(args, "subcommand", None) == "monitor")
    )
    operation_id = _operation_id_for(args)
    try:
        op, data = _dispatch(args, fmt, request_id, timestamp)
        interrupted_flag = isinstance(data, dict) and data.pop("_interrupted", False)
        sig_exit_code = isinstance(data, dict) and data.pop("_sig_exit_code", None)
        duration_ms = int((time.monotonic() - started) * 1000)
        if not streaming:
            # completion in text mode: print raw script, no envelope
            if args.command == "completion" and fmt == "text":
                sys.stdout.write(data["completion"])
                if not data["completion"].endswith("\n"):
                    sys.stdout.write("\n")
            else:
                emit_success(sys.stdout, op, data, fmt=fmt, request_id=request_id, timestamp=timestamp, duration_ms=duration_ms)
        if sig_exit_code:
            return sig_exit_code
        return EXIT_SIGINT if interrupted_flag else EXIT_OK
    except TracksimError as exc:
        _LOG.error("%s: %s", exc.code, exc.message)
        duration_ms = int((time.monotonic() - started) * 1000)
        emit_error(sys.stdout, operation_id, exc, fmt=_normalize_fmt(fmt), request_id=request_id, timestamp=timestamp, duration_ms=duration_ms)
        return exit_for_error(exc)
    except KeyboardInterrupt:
        _LOG.error("interrupted")
        return 130


def _wants_json(argv: list[str] | None) -> bool:
    if not argv:
        return False
    for i, tok in enumerate(argv):
        if tok in ("--output", "-o") and i + 1 < len(argv) and argv[i + 1] in ("json", "ndjson", "stream-json"):
            return True
        if tok.startswith("--output=") and tok.split("=", 1)[1] in ("json", "ndjson", "stream-json"):
            return True
    return False


def _detect_fmt(argv: list[str] | None, *, ai_agent: bool) -> str:
    """Return the requested output format from argv before argparse runs.

    Returns "ndjson", "stream-json", "json", or "text" (default).
    Used in the SystemExit path where args namespace is not yet available.
    """
    if not argv:
        return "json" if ai_agent else "text"
    for i, tok in enumerate(argv):
        if tok in ("--output", "-o") and i + 1 < len(argv):
            return argv[i + 1]
        if tok.startswith("--output="):
            return tok.split("=", 1)[1]
    return "json" if ai_agent else "text"
