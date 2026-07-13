"""vpcal capture — real-time capture service (C1).

``track`` (C1.1): listen for FreeD / OpenTrackIO over UDP and record a
timestamped tracking stream.  ``video`` (C1.2): capture a video stream via a
:mod:`~vpcal.core.capture_backend` backend (synthetic / uvc / ndi / decklink).
``session`` (C1.2+C1.3 core): the closed-loop auto-assembled capture session —
settle→burst→detect→advance state machine, NDJSON event stream, stdin control
channel (see ``docs/c1-capture-service.md`` and the live-capture plan).
"""

from __future__ import annotations

import json
import sys
import threading
import time
from pathlib import Path

import click

from vpcal.cli._common import (
    OperationOutput,
    StreamEmitter,
    common_options,
    run_operation,
    run_streaming_operation,
)
from vpcal.core.errors import PreconditionError

_BACKEND_CHOICES = ["uvc", "ndi", "decklink", "synthetic"]


@click.group()
@click.pass_context
def capture(ctx: click.Context) -> None:
    """Real-time capture service: tracking ingest, video, pattern playback."""


@capture.command(name="track")
@click.option("--protocol", type=click.Choice(["freed", "opentrackio"]), default="freed",
              show_default=True, help="Tracking wire protocol.")
@click.option("--port", type=int, required=True, help="UDP port to listen on.")
@click.option("--duration", "duration_s", type=float, default=30.0, show_default=True,
              help="Capture duration (seconds).")
@click.option("--host", default="0.0.0.0", show_default=True, help="Bind address.")
@click.option("--max-packets", type=int, default=None, help="Stop after N packets (optional).")
@click.option("--out", "out_path", required=True, type=click.Path(), help="Output poses.jsonl path.")
@common_options
@click.pass_context
def track(ctx, protocol, port, duration_s, host, max_packets, out_path, **flags) -> None:
    """Record a timestamped tracking stream from a live FreeD / OpenTrackIO source."""

    def body() -> OperationOutput:
        from vpcal.core.capture import COORDINATE_SYSTEM, capture_tracking_udp

        if flags.get("dry_run"):
            return OperationOutput(
                data={"exit_code": 0, "dry_run_plan": {"protocol": protocol, "port": port,
                                                        "duration_s": duration_s, "out": out_path}},
                text="Dry run OK.",
            )
        frames = capture_tracking_udp(
            port, protocol=protocol, duration_s=duration_s, host=host,
            max_packets=max_packets, out=out_path,
        )
        summary = {
            "output": out_path, "protocol": protocol,
            "coordinate_system": COORDINATE_SYSTEM[protocol], "frames": len(frames),
            "duration_s": frames[-1].timestamp_s if frames else 0.0,
        }
        return OperationOutput(
            data=summary,
            text=(f"Recorded {len(frames)} {protocol} frames → {out_path} "
                  f"(use coordinate_system='{COORDINATE_SYSTEM[protocol]}')"),
        )

    run_operation("capture.track", body, **flags)


def _backend_options(fn):
    """Shared video-source options for ``video`` and ``session``."""
    decorators = [
        click.option("--backend", type=click.Choice(_BACKEND_CHOICES), default="uvc",
                     show_default=True, help="Video capture backend."),
        click.option("--device", default="0", show_default=True,
                     help="Device index (uvc/decklink), source name (ndi), or URL."),
        click.option("--width", type=int, default=None, help="Requested frame width."),
        click.option("--height", type=int, default=None, help="Requested frame height."),
        click.option("--fps", type=float, default=None, help="Requested frame rate."),
        click.option("--transfer-function", default="sdr", show_default=True,
                     help="Declared source transfer function (sdr | log | …)."),
        click.option("--preview-port", type=int, default=None,
                     help="Serve a localhost MJPEG/WS preview on this port (0 = auto)."),
    ]
    for dec in reversed(decorators):
        fn = dec(fn)
    return fn


def _make_preview(preview_port, emitter: StreamEmitter):
    """Start the preview server when requested → (sink, server)."""
    if preview_port is None:
        return None, None
    from vpcal.core.preview_server import PreviewServer, PreviewSink

    sink = PreviewSink()
    server = PreviewServer(sink, port=preview_port)
    server.start()
    emitter.emit("preview_ready", {
        "port": server.port,
        "mjpeg_url": f"http://127.0.0.1:{server.port}/preview.mjpg",
        "ws_url": f"ws://127.0.0.1:{server.port}/preview.ws",
        "poc_url": f"http://127.0.0.1:{server.port}/poc",
    }, text=f"preview: http://127.0.0.1:{server.port}/preview.mjpg")
    return sink, server


@capture.command(name="enumerate")
@click.option("--backend", type=click.Choice(["ndi", "synthetic"]), required=True,
              help="Video-source backend to enumerate.")
@click.option("--timeout", "timeout_s", type=click.FloatRange(min=0.0), default=3.0,
              show_default=True, help="NDI discovery window in seconds.")
@common_options
@click.pass_context
def enumerate_video_sources(ctx, backend, timeout_s, **flags) -> None:
    """Enumerate discoverable video sources for a supported backend."""

    def body() -> OperationOutput:
        if backend == "synthetic":
            sources = [{"name": "synthetic"}]
        else:
            from vpcal.core.ndi import enumerate_sources

            sources = enumerate_sources(timeout_s)
        data = {"backend": backend, "timeout_s": timeout_s, "sources": sources}
        return OperationOutput(data=data, text=f"Found {len(sources)} {backend} source(s)")

    run_operation("capture.enumerate", body, **flags)


@capture.command(name="video")
@_backend_options
@click.option("--allow-hx", is_flag=True,
              help="Allow NDI|HX for preview/probing only; calibration sessions still reject it.")
@click.option("--duration", "duration_s", type=float, default=10.0, show_default=True,
              help="Capture duration (seconds); 0 = until the source ends or the "
                   "process is cancelled (e.g. Volo bridge kill).")
@click.option("--max-frames", type=int, default=None, help="Stop after N frames.")
@click.option("--out", "out_dir", type=click.Path(), default=None,
              help="Write full-quality frames to this directory (PNG).")
@common_options
@click.pass_context
def video(ctx, backend, device, width, height, fps, transfer_function, preview_port,
          allow_hx, duration_s, max_frames, out_dir, **flags) -> None:
    """[C1.2] Capture a video stream (synthetic / uvc / ndi / decklink)."""

    def body(emitter: StreamEmitter) -> OperationOutput:
        import cv2

        from vpcal.core.capture_backend import CaptureConfig, open_backend

        if flags.get("dry_run"):
            return OperationOutput(
                data={"dry_run_plan": {"backend": backend, "device": device,
                                       "duration_s": duration_s, "out": out_dir}},
                text="Dry run OK.")
        cfg = CaptureConfig(backend=backend, device=device, width=width, height=height,
                            fps=fps, transfer_function=transfer_function,
                            extra={"allow_hx": allow_hx})
        src = open_backend(cfg)
        sink, server = _make_preview(preview_port, emitter)
        out = Path(out_dir) if out_dir else None
        if out:
            out.mkdir(parents=True, exist_ok=True)
        n = 0
        source_info = None
        t0 = time.monotonic()
        last_report = t0
        try:
            for frame in src.frames():
                if source_info is None:
                    source_info = {
                        "width": int(frame.gray.shape[1]),
                        "height": int(frame.gray.shape[0]),
                        "fps": frame.meta.get("frame_rate", fps),
                        "fourcc": frame.meta.get("fourcc"),
                        "bit_depth": frame.meta.get("bit_depth", int(frame.gray.dtype.itemsize * 8)),
                        "is_hx": frame.meta.get("is_hx", False),
                        "transfer_function": frame.meta.get("transfer_function", transfer_function),
                    }
                if sink is not None:
                    sink.publish(frame.bgr if frame.bgr is not None else frame.gray)
                if out:
                    cv2.imwrite(str(out / f"{n:06d}.png"), frame.gray)
                n += 1
                now = time.monotonic()
                if now - last_report >= 1.0:
                    emitter.emit("progress", {
                        "frames": n, "fps": round(n / (now - t0), 1),
                        "timecode": frame.timecode,
                    }, text=f"{n} frames ({n / (now - t0):.1f} fps)")
                    last_report = now
                if duration_s > 0 and now - t0 >= duration_s:
                    break
                if max_frames is not None and n >= max_frames:
                    break
        finally:
            src.close()
            if server is not None:
                server.stop()
        elapsed = time.monotonic() - t0
        data = {"backend": backend, "frames": n, "elapsed_s": round(elapsed, 2),
                "mean_fps": round(n / elapsed, 2) if elapsed > 0 else 0.0,
                "out_dir": str(out) if out else None, "source": source_info}
        return OperationOutput(data=data, text=f"Captured {n} frames in {elapsed:.1f}s "
                                               f"({data['mean_fps']} fps)")

    run_streaming_operation("capture.video", body, **flags)


@capture.command(name="session")
@click.option("--screen", "screen_path", required=True, type=click.Path(exists=True),
              help="Screen definition (JSON/OBJ) — coverage denominator + quick-run input.")
@click.option("--out", "out_dir", required=True, type=click.Path(),
              help="Session output directory (created if missing).")
@_backend_options
@click.option("--track-protocol", type=click.Choice(["freed", "opentrackio"]), default="freed",
              show_default=True, help="Tracking wire protocol.")
@click.option("--track-port", type=int, default=6301, show_default=True,
              help="Tracking UDP port.")
@click.option("--track-host", default="0.0.0.0", show_default=True, help="Tracking bind address.")
@click.option("--poses", "poses_target", type=int, default=8, show_default=True,
              help="Target pose count (0 = unlimited, finish via stdin control).")
@click.option("--inverted", is_flag=True,
              help="Capture an inverted-pattern frame per pose (differencing).")
@click.option("--lens", "lens_path", type=click.Path(exists=True), default=None,
              help="Lens profile JSON to embed in session.json (quick-run-ready).")
@click.option("--settle-ms", type=float, default=300.0, show_default=True,
              help="Required stillness duration before capture (T_settle).")
@click.option("--settle-speed", type=float, default=5.0, show_default=True,
              help="Speed (mm/s) below which the camera counts as settling.")
@click.option("--move-speed", type=float, default=25.0, show_default=True,
              help="Speed (mm/s) above which the camera counts as moving again.")
@click.option("--burst", "burst_frames", type=int, default=5, show_default=True,
              help="Frames averaged per pose.")
@click.option("--tolerance", "timestamp_tolerance_s", type=float, default=0.05,
              show_default=True, help="Frame↔tracking pairing tolerance (s).")
@click.option("--graycode-sync", is_flag=True,
              help="Confirm pattern switches by decoding corner Gray-code tags.")
@click.option("--control-stdin/--no-control-stdin", default=True, show_default=True,
              help="Read JSON control commands from stdin (stop/finish/pattern_ready).")
@common_options
@click.pass_context
def session(ctx, screen_path, out_dir, backend, device, width, height, fps,
            transfer_function, preview_port, track_protocol, track_port, track_host,
            poses_target, inverted, lens_path, settle_ms, settle_speed, move_speed,
            burst_frames, timestamp_tolerance_s, graycode_sync, control_stdin,
            **flags) -> None:
    """[C1.2+C1.3] Closed-loop capture session → quick-run-ready session directory.

    Emits NDJSON events (progress | pose_captured | detect_feedback |
    coverage_update | request_pattern | warning | preview_ready | result | error)
    and accepts JSON control lines on stdin:

    \b
      {"cmd": "stop"}                        abort
      {"cmd": "finish"}                      stop after current pose, assemble
      {"cmd": "skip_pose"}                   re-arm the current pose
      {"cmd": "pattern_ready", "pattern": "inverted"}   playback switched
    """

    def body(emitter: StreamEmitter) -> OperationOutput:
        from vpcal.core.capture_backend import CaptureConfig, open_backend
        from vpcal.core.capture_session import CaptureSessionRunner, SessionCaptureConfig

        if flags.get("dry_run"):
            return OperationOutput(
                data={"dry_run_plan": {"screen": screen_path, "out": out_dir,
                                       "backend": backend, "poses": poses_target,
                                       "track": f"{track_protocol}:{track_port}"}},
                text="Dry run OK.")

        backend_cfg = CaptureConfig(backend=backend, device=device, width=width,
                                    height=height, fps=fps,
                                    transfer_function=transfer_function)
        sink, server = _make_preview(preview_port, emitter)
        cfg = SessionCaptureConfig(
            out_dir=Path(out_dir), screen_path=Path(screen_path), backend=backend_cfg,
            track_protocol=track_protocol, track_port=track_port, track_host=track_host,
            poses_target=poses_target, settle_speed_mm_s=settle_speed,
            move_speed_mm_s=move_speed, settle_duration_s=settle_ms / 1000.0,
            burst_frames=burst_frames, timestamp_tolerance_s=timestamp_tolerance_s,
            inverted=inverted, graycode_sync=graycode_sync,
            lens_path=Path(lens_path) if lens_path else None, preview_sink=sink)

        src = open_backend(backend_cfg)
        runner = CaptureSessionRunner(cfg, src, emitter.emit)

        stop_stdin = threading.Event()
        if control_stdin:
            def _stdin_pump() -> None:
                for line in sys.stdin:
                    if stop_stdin.is_set():
                        return
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        runner.post(json.loads(line))
                    except json.JSONDecodeError:
                        emitter.emit("warning", {"message": f"bad control line: {line[:120]}"})
                # stdin EOF: the host went away — stop the session cleanly.
                runner.post({"cmd": "finish"})

            threading.Thread(target=_stdin_pump, name="vpcal-control", daemon=True).start()

        try:
            data = runner.run()
        finally:
            stop_stdin.set()
            if server is not None:
                server.stop()
        return OperationOutput(
            data=data,
            text=(f"Session complete: {data['poses_captured']} poses → {data['session_dir']} "
                  f"({'quick-run ready' if data['lens_ready'] else 'lens profile still needed'})"))

    run_streaming_operation("capture.session", body, **flags)


@capture.command(name="delay-cal")
@click.option("--config", "config_path", required=True, type=click.Path(),
              help="Session config JSON (lens + marker truth + coordinate system).")
@click.option("--result", "result_path", required=True, type=click.Path(),
              help="Solved result.json (spatial calibration precondition).")
@click.option("--video", "video_dir", required=True, type=click.Path(file_okay=False),
              help="Directory of swing-test frames (offline mode; frame-numbered filenames).")
@click.option("--tracking", "tracking_path", required=True, type=click.Path(),
              help="Timestamped tracking stream JSONL for the same take.")
@click.option("--fps", type=float, default=30.0, show_default=True,
              help="Video frame rate (frame timestamps = frame_id / fps).")
@click.option("--search-ms", type=float, default=100.0, show_default=True,
              help="Delay scan half-range (ms).")
@click.option("--out", "out_path", type=click.Path(), default=None,
              help="Output delay profile path (default: <video>/../timing/delay_profile.json).")
@common_options
@click.pass_context
def delay_cal(ctx, config_path, result_path, video_dir, tracking_path, fps, search_ms,
              out_path, **flags) -> None:
    """[Phase C] Calibrate the video↔tracking delay from a swing-test capture.

    Offline mode: point --video at a directory of extracted frames and
    --tracking at the recorded stream.  Needs a completed spatial calibration
    (--result); a static capture is rejected with re-shoot guidance (exit 6).
    """

    def body() -> OperationOutput:
        from vpcal.cli.quick import _load_session
        from vpcal.core.delay_cal import run_delay_cal

        rp = Path(result_path)
        if not rp.exists():
            raise PreconditionError(
                f"result not found: {rp} — delay calibration needs a completed "
                "spatial calibration (run `vpcal quick run` first)",
                details={"path": str(rp)},
            )
        session, _raw, session_dir = _load_session(config_path)
        result = json.loads(rp.read_text())
        if flags.get("dry_run"):
            return OperationOutput(
                data={"exit_code": 0, "dry_run_plan": {"video": video_dir, "tracking": tracking_path,
                                                       "fps": fps, "search_ms": search_ms}},
                text="Dry run OK.",
            )
        out = Path(out_path) if out_path else Path(video_dir).parent / "timing" / "delay_profile.json"
        profile = run_delay_cal(
            session, session_dir, result, Path(video_dir), Path(tracking_path),
            fps=fps, search_ms=search_ms, out_path=out,
        )
        cam = profile["cameras"][0]
        return OperationOutput(
            data=profile,
            text=(f"Delay: {cam['delay_ms']:+.1f} ± {cam['sigma_ms']:.1f} ms "
                  f"(confidence {cam['confidence']:.2f}, {cam['num_markers']} markers) → {out}\n"
                  f"  {profile['recommendation']}"),
        )

    run_operation("capture.delay_cal", body, **flags)


@capture.command(name="playback")
@common_options
@click.pass_context
def playback(ctx, **flags) -> None:
    """[C1.3] Pattern playback lives in the Volo player window (scaffold here)."""

    def body() -> OperationOutput:
        raise PreconditionError(
            "pattern playback is driven by the Volo player window (Tauri) — "
            "vpcal participates via Gray-code tags in generated patterns "
            "(`vpcal pattern generate --graycode-tags`) and the `capture session` "
            "pattern_ready control command; see docs/c1-capture-service.md",
            details={"step": "playback", "roadmap": "C1.3", "status": "delegated-to-volo"},
        )

    run_operation("capture.playback", body, **flags)
