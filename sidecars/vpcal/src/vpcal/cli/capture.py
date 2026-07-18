"""vpcal capture — real-time capture service (C1).

``track`` (C1.1): listen for FreeD / OpenTrackIO over UDP and record a
timestamped tracking stream.  ``video`` (C1.2): capture a video stream via a
:mod:`~vpcal.core.capture_backend` backend (synthetic / uvc / ndi / decklink).
``stills``: tracker-free stills capture for grid screen rebuild — single process
opens the device, serves MJPEG preview, and writes ``captures/normal/*.png``
(auto frame-diff snap + manual shutter; no tracking / no capture_manifest).
``session`` (C1.2+C1.3 core): the closed-loop auto-assembled capture session —
settle→burst→detect→advance state machine, NDJSON event stream, stdin control
channel (see ``docs/c1-capture-service.md`` and the live-capture plan).
"""

from __future__ import annotations

import json
import queue
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
@click.option("--out", "out_path", required=False, type=click.Path(), help="Output poses.jsonl path.")
@click.option("--monitor", is_flag=True, help="Emit 0.5 s live NDJSON monitor events until stdin EOF.")
@common_options
@click.pass_context
def track(ctx, protocol, port, duration_s, host, max_packets, out_path, monitor, **flags) -> None:
    """Record a timestamped tracking stream from a live FreeD / OpenTrackIO source."""

    if monitor:
        def stream_body(emitter: StreamEmitter) -> OperationOutput:
            from vpcal.core.tracking_listener import TrackingListener

            listener = TrackingListener(port, protocol=protocol, host=host)
            eof = threading.Event()
            threading.Thread(target=lambda: (sys.stdin.read(), eof.set()), daemon=True).start()
            listener.start()
            t0 = time.monotonic()
            last_total = 0
            last_t = t0
            try:
                while not eof.wait(0.5):
                    now = time.monotonic()
                    total = listener.packets_seen
                    frames = listener.all_frames()
                    latest = frames[-1] if frames else None
                    emitter.emit("monitor", {
                        "pkt_s": round((total - last_total) / max(now - last_t, 1e-9), 1),
                        "total": total,
                        "camera_ids": sorted({str(f.camera_id) for f in frames if f.camera_id is not None}),
                        "pose": latest.model_dump(mode="json") if latest else None,
                        "protocol": protocol,
                    })
                    last_total, last_t = total, now
                    if duration_s > 0 and now - t0 >= duration_s:
                        break
            finally:
                listener.stop()
            return OperationOutput(data={"protocol": protocol, "total": listener.packets_seen},
                                   text=f"Monitored {listener.packets_seen} packets")

        run_streaming_operation("capture.track.monitor", stream_body, **flags)
        return

    if not out_path:
        raise click.UsageError("--out is required unless --monitor is used")

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


@capture.command(name="list-devices")
@click.option("--backend", type=click.Choice(["uvc"]), default="uvc", show_default=True)
@common_options
@click.pass_context
def list_devices(ctx, backend, **flags) -> None:
    """Probe local capture devices without fabricated display names."""
    def body() -> OperationOutput:
        from vpcal.core.capture_backend import list_uvc_devices

        devices = list_uvc_devices()
        return OperationOutput(data={"backend": backend, "devices": devices},
                               text=f"Probed {len(devices)} UVC indices")
    run_operation("capture.list_devices", body, **flags)


@capture.command(name="finalize")
@click.argument("session_dir", type=click.Path(file_okay=False))
@common_options
@click.pass_context
def finalize(ctx, session_dir, **flags) -> None:
    """Recover a quick-run-compatible session from incremental capture files."""
    def body() -> OperationOutput:
        from vpcal.core.capture_session import finalize_partial_session
        data = finalize_partial_session(session_dir)
        return OperationOutput(data=data, text=(f"Recovered {data['poses_recovered']} poses → "
                                                f"{data['session_json']}"))
    run_operation("capture.finalize", body, **flags)


def _backend_options(fn):
    """Shared video-source options for ``video``, ``stills``, and ``session``."""
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

    # Monitor feed: native resolution, near-transparent JPEG. The calibration
    # chain still writes full-quality PNGs elsewhere — this only affects the
    # on-screen preview.
    sink = PreviewSink(max_width=None, jpeg_quality=92)
    server = PreviewServer(sink, port=preview_port)
    server.start()
    emitter.emit("preview_ready", {
        "port": server.port,
        "mjpeg_url": f"http://127.0.0.1:{server.port}/preview.mjpg",
        "ws_url": f"ws://127.0.0.1:{server.port}/preview.ws",
        "poc_url": f"http://127.0.0.1:{server.port}/poc",
    }, text=f"preview: http://127.0.0.1:{server.port}/preview.mjpg")
    return sink, server


def _source_info(frame, *, fps, transfer_function) -> dict:
    """Shared source_info payload for ``video`` / ``stills`` NDJSON events."""
    return {
        "width": int(frame.gray.shape[1]),
        "height": int(frame.gray.shape[0]),
        "fps": frame.meta.get("frame_rate", fps),
        "fourcc": frame.meta.get("fourcc"),
        "pixel_format": frame.meta.get("pixel_format"),
        "bit_depth": frame.meta.get("bit_depth", int(frame.gray.dtype.itemsize * 8)),
        "is_hx": frame.meta.get("is_hx", False),
        "transfer_function": frame.meta.get("transfer_function", transfer_function),
    }


@capture.command(name="enumerate")
@click.option("--backend", type=click.Choice(["ndi", "decklink", "synthetic"]), required=True,
              help="Video-source backend to enumerate.")
@click.option("--timeout", "timeout_s", type=click.FloatRange(min=0.0), default=3.0,
              show_default=True, help="NDI discovery window in seconds (ignored for decklink).")
@common_options
@click.pass_context
def enumerate_video_sources(ctx, backend, timeout_s, **flags) -> None:
    """Enumerate discoverable video sources for a supported backend."""

    def body() -> OperationOutput:
        if backend == "synthetic":
            sources = [{"name": "synthetic"}]
        elif backend == "decklink":
            from vpcal.core.capture_backend import (
                DECKLINK_CONNECTOR_LABELS,
                list_decklink_devices,
            )

            sources = [
                {
                    "index": d["index"],
                    "name": d["name"],
                    "connectors": [
                        {"id": c, "name": DECKLINK_CONNECTOR_LABELS.get(c, c.upper())}
                        for c in d.get("connectors", [])
                    ],
                }
                for d in list_decklink_devices()
            ]
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
                            extra={"allow_hx": allow_hx,
                                   "want_bgr": preview_port is not None,
                                   # Open-ended preview run = the UI monitor:
                                   # survive signal drops instead of exiting.
                                   "keep_alive": duration_s == 0 and preview_port is not None})
        src = open_backend(cfg)
        # Monitor mode (duration 0 + preview) is Volo-driven: the bridge closes
        # our stdin on cancel, but a hard kill only lands after a 3 s grace —
        # far too long for an exclusive device (DeckLink/UVC) the real capture
        # session is waiting to reopen. Watch stdin for EOF and exit promptly.
        stdin_closed = threading.Event()
        if duration_s == 0 and preview_port is not None:
            def _watch_stdin() -> None:
                try:
                    while sys.stdin.buffer.read(4096):
                        pass
                except Exception:
                    pass
                stdin_closed.set()
            threading.Thread(target=_watch_stdin, daemon=True).start()
        sink, server = _make_preview(preview_port, emitter)
        out = Path(out_dir) if out_dir else None
        manifest_fh = None
        if out:
            out.mkdir(parents=True, exist_ok=True)
            manifest_fh = (out / "frames.jsonl").open("w", encoding="utf-8")
        n = 0
        source_info = None
        t0 = time.monotonic()
        last_report = t0
        try:
            for frame in src.frames():
                # Refresh each frame so the reported format reflects the final
                # frame — DeckLink/NDI may renegotiate resolution/format mid-run
                # (format auto-detection), and the last frame is authoritative.
                first_info = source_info is None
                source_info = _source_info(frame, fps=fps, transfer_function=transfer_function)
                if first_info:
                    # Push the format to the live monitor as soon as it is known.
                    emitter.emit("source_info", dict(source_info))
                if sink is not None:
                    sink.publish(frame.bgr if frame.bgr is not None else frame.gray)
                if out:
                    cv2.imwrite(str(out / f"{n:06d}.png"), frame.gray)
                    manifest_fh.write(json.dumps({
                        "frame_index": n,
                        "recv_ts": frame.recv_ts,
                        "timecode": frame.timecode,
                        "hardware_time_s": frame.hardware_time_s,
                        "fps_nominal": fps or frame.meta.get("frame_rate"),
                    }, ensure_ascii=False) + "\n")
                    manifest_fh.flush()
                n += 1
                now = time.monotonic()
                if now - last_report >= 1.0:
                    emitter.emit("progress", {
                        "frames": n, "fps": round(n / (now - t0), 1),
                        "timecode": frame.timecode,
                    }, text=f"{n} frames ({n / (now - t0):.1f} fps)")
                    last_report = now
                if stdin_closed.is_set():
                    break
                if duration_s > 0 and now - t0 >= duration_s:
                    break
                if max_frames is not None and n >= max_frames:
                    break
        finally:
            src.close()
            if manifest_fh is not None:
                manifest_fh.close()
            if server is not None:
                server.stop()
        elapsed = time.monotonic() - t0
        data = {"backend": backend, "frames": n, "elapsed_s": round(elapsed, 2),
                "mean_fps": round(n / elapsed, 2) if elapsed > 0 else 0.0,
                "out_dir": str(out) if out else None, "source": source_info}
        return OperationOutput(data=data, text=f"Captured {n} frames in {elapsed:.1f}s "
                                               f"({data['mean_fps']} fps)")

    run_streaming_operation("capture.video", body, **flags)


@capture.command(name="stills")
@_backend_options
@click.option("--allow-hx", is_flag=True,
              help="Allow NDI|HX for preview/probing only.")
@click.option("--out", "out_dir", required=True, type=click.Path(),
              help="Session output directory (writes captures/normal/*.png).")
@click.option("--auto/--no-auto", default=True, show_default=True,
              help="Enable automatic stills detection (frame-diff gate).")
@click.option("--stable-ms", type=float, default=700.0, show_default=True,
              help="Required stillness duration before an auto snap (ms).")
@click.option("--motion-thresh", type=float, default=1.5, show_default=True,
              help="EMA motion score above which the camera counts as moving.")
@click.option("--novelty-thresh", type=float, default=6.0, show_default=True,
              help="Min mean-abs-diff vs last saved frame to accept an auto snap.")
@click.option("--min-interval", type=float, default=1.0, show_default=True,
              help="Minimum seconds between auto snaps (manual snap ignores this).")
@click.option("--min-markers", type=int, default=4, show_default=True,
              help="Min VP-QSP markers required for auto snap (0 = disable content gate).")
@common_options
@click.pass_context
def stills(ctx, backend, device, width, height, fps, transfer_function, preview_port,
           allow_hx, out_dir, auto, stable_ms, motion_thresh, novelty_thresh,
           min_interval, min_markers, **flags) -> None:
    """Tracker-free stills capture → ``<out>/captures/normal/{n:06d}.png``.

    Single process owns the device for MJPEG preview + stills. Emits NDJSON
    events (preview_ready | source_info | progress | snap_saved | auto_state |
    detect_state | warning | result) and accepts JSON control lines on stdin:

    \b
      {"cmd": "snap"}                 save immediately (bypasses thresholds)
      {"cmd": "auto", "enabled": bool}
      {"cmd": "finish"}               close device → result → exit 0
    stdin EOF is equivalent to finish (exclusive devices release promptly).
    Does **not** write frames.jsonl or capture_manifest.json.
    """

    def body(emitter: StreamEmitter) -> OperationOutput:
        import cv2

        from vpcal.core.capture_backend import CaptureConfig, open_backend
        from vpcal.core.detector import detect_markers
        from vpcal.core.framing_match import summarize_detections
        from vpcal.core.stills import AutoSnapDetector, DetectionGate, gray_to_uint8

        if flags.get("dry_run"):
            return OperationOutput(
                data={"dry_run_plan": {"backend": backend, "device": device,
                                       "out": out_dir, "auto": auto,
                                       "min_markers": min_markers}},
                text="Dry run OK.")

        session_dir = Path(out_dir)
        normal_dir = session_dir / "captures" / "normal"
        normal_dir.mkdir(parents=True, exist_ok=True)

        cfg = CaptureConfig(
            backend=backend, device=device, width=width, height=height,
            fps=fps, transfer_function=transfer_function,
            extra={"allow_hx": allow_hx, "want_bgr": preview_port is not None},
        )
        sink, server = _make_preview(preview_port, emitter)
        src = open_backend(cfg)
        detector = AutoSnapDetector(
            stable_ms=stable_ms, motion_thresh=motion_thresh,
            novelty_thresh=novelty_thresh, min_interval=min_interval,
            enabled=auto,
        )

        def _detect(gray):
            dets = detect_markers(gray_to_uint8(gray))
            return summarize_detections(dets, gray.shape)

        gate = DetectionGate(min_markers=min_markers, detect_fn=_detect)

        finish = threading.Event()
        cmds: queue.Queue[tuple] = queue.Queue()
        mailbox: dict[str, object] = {"gray": None, "t": 0.0}
        mailbox_lock = threading.Lock()
        last_auto_state: str | None = None
        gate_blocked = False
        last_motion = 0.0
        last_novelty = 0.0
        frames_seen = 0
        auto_snaps = 0
        manual_snaps = 0
        gated_rejects = 0
        source_info = None
        latest_gray = None
        t0 = time.monotonic()
        last_report = t0
        last_gated_emit = 0.0

        def _emit_auto_state(*, gate_flag: str | None = None) -> None:
            payload = {
                "enabled": detector.enabled,
                "state": detector.state,
                "motion": last_motion,
                "novelty": last_novelty,
            }
            if gate_flag is not None:
                payload["gate"] = gate_flag
            emitter.emit("auto_state", payload)

        def _save(gray, *, is_auto: bool) -> None:
            nonlocal auto_snaps, manual_snaps, gate_blocked
            idx = auto_snaps + manual_snaps
            path = normal_dir / f"{idx:06d}.png"
            cv2.imwrite(str(path), gray)
            now = time.monotonic()
            # Auto path just ran update() — reuse its downsampled buffer.
            if is_auto:
                detector.mark_saved(None, now)
            else:
                detector.mark_saved(gray, now)
            if is_auto:
                auto_snaps += 1
            else:
                manual_snaps += 1
            gate_blocked = False
            emitter.emit("snap_saved", {
                "index": idx, "path": str(path), "auto": is_auto,
                "markers": gate.markers_for_event(now),
            }, text=f"snap {idx:06d} ({'auto' if is_auto else 'manual'}) → {path}")

        def _drain_cmds(gray) -> None:
            while True:
                try:
                    item = cmds.get_nowait()
                except queue.Empty:
                    return
                if item[0] == "snap":
                    _save(gray, is_auto=False)
                elif item[0] == "auto":
                    detector.set_enabled(item[1])
                    _emit_auto_state()

        def _stdin_pump() -> None:
            for line in sys.stdin:
                if finish.is_set():
                    return
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    emitter.emit("warning", {"message": f"bad control line: {line[:120]}"})
                    continue
                cmd = msg.get("cmd")
                if cmd == "finish":
                    finish.set()
                    return
                if cmd == "snap":
                    cmds.put(("snap",))
                elif cmd == "auto":
                    cmds.put(("auto", bool(msg.get("enabled", True))))
                else:
                    emitter.emit("warning", {"message": f"unknown control cmd: {cmd}"})
            finish.set()

        def _detect_worker() -> None:
            last_emit = None
            last_heartbeat = 0.0
            while not finish.is_set():
                with mailbox_lock:
                    gray = mailbox["gray"]
                    t = mailbox["t"]
                if gray is None:
                    finish.wait(0.05)
                    continue
                snap = gate.poll(gray, float(t))
                markers = 0 if snap["markers"] is None else int(snap["markers"])
                stale = bool(snap["stale"] or snap["markers"] is None)
                cabinets = snap.get("cabinets") or []
                bbox_frac = snap.get("bbox_frac")
                payload = (
                    markers, stale,
                    tuple(tuple(c) for c in cabinets),
                    None if bbox_frac is None else tuple(bbox_frac),
                )
                now_hb = time.monotonic()
                # Emit on change; heartbeat only when stale so UI can show "—"
                # without re-pushing identical cabinets every second.
                if payload != last_emit or (
                    stale and (now_hb - last_heartbeat) >= 1.0
                ):
                    emitter.emit("detect_state", {
                        "markers": markers,
                        "stale": stale,
                        "cabinets": [list(c) for c in cabinets],
                        "bbox_frac": None if bbox_frac is None else list(bbox_frac),
                    })
                    last_emit = payload
                    last_heartbeat = now_hb
                finish.wait(gate.interval_s)

        threading.Thread(target=_stdin_pump, name="vpcal-stills-control", daemon=True).start()
        threading.Thread(target=_detect_worker, name="vpcal-stills-detect", daemon=True).start()

        try:
            for frame in src.frames():
                now = time.monotonic()
                latest_gray = frame.gray
                frames_seen += 1

                with mailbox_lock:
                    mailbox["gray"] = frame.gray
                    mailbox["t"] = now

                first_info = source_info is None
                source_info = _source_info(frame, fps=fps, transfer_function=transfer_function)
                if first_info:
                    emitter.emit("source_info", dict(source_info))
                if sink is not None:
                    sink.publish(frame.bgr if frame.bgr is not None else frame.gray)

                # Drain before finish check so snap lines that raced ahead of the
                # first frame still land on a real buffer.
                _drain_cmds(frame.gray)
                if finish.is_set():
                    break

                result = detector.update(frame.gray, now)
                last_motion = result["motion"]
                last_novelty = result["novelty"]
                if result["state"] != last_auto_state:
                    last_auto_state = result["state"]
                    gate_blocked = False
                    _emit_auto_state()
                if result.get("warning"):
                    emitter.emit("warning", result["warning"])
                if result["snap"]:
                    if gate.allow(now):
                        _save(frame.gray, is_auto=True)
                    elif (
                        not gate_blocked
                        or (now - last_gated_emit) >= gate.interval_s
                    ):
                        # No mark_saved — motion gate stays armed; detect cache retries.
                        gated_rejects += 1
                        last_gated_emit = now
                        gate_blocked = True
                        _emit_auto_state(gate_flag="no_pattern")

                if now - last_report >= 1.0:
                    elapsed = max(now - t0, 1e-9)
                    snaps = auto_snaps + manual_snaps
                    emitter.emit("progress", {
                        "fps": round(frames_seen / elapsed, 1),
                        "frames_seen": frames_seen,
                        "snaps": snaps,
                    }, text=f"{frames_seen} frames / {snaps} snaps "
                            f"({frames_seen / elapsed:.1f} fps)")
                    last_report = now
        finally:
            finish.set()
            src.close()
            if server is not None:
                server.stop()

        if latest_gray is not None:
            _drain_cmds(latest_gray)

        data = {
            "session_dir": str(session_dir),
            "frames_captured": auto_snaps + manual_snaps,
            "auto_snaps": auto_snaps,
            "manual_snaps": manual_snaps,
            "gated_rejects": gated_rejects,
            "source": source_info,
        }
        return OperationOutput(
            data=data,
            text=(f"Stills complete: {data['frames_captured']} frames → "
                  f"{session_dir / 'captures' / 'normal'} "
                  f"(auto={auto_snaps}, manual={manual_snaps}, "
                  f"gated_rejects={gated_rejects})"),
        )

    run_streaming_operation("capture.stills", body, **flags)


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
@click.option("--track-camera-id", default=None,
              help="FreeD camera ID to accept; packets from other IDs are ignored.")
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
@click.option("--settle-ang-speed", type=float, default=0.2, show_default=True,
              help="Angular speed (deg/s) below which the camera counts as settling.")
@click.option("--move-speed", type=float, default=25.0, show_default=True,
              help="Speed (mm/s) above which the camera counts as moving again.")
@click.option("--burst", "burst_frames", type=int, default=5, show_default=True,
              help="Frames averaged per pose.")
@click.option("--tolerance", "timestamp_tolerance_s", type=float, default=0.05,
              show_default=True, help="Frame↔tracking pairing tolerance (s).")
@click.option("--graycode-sync", is_flag=True,
              help="Confirm pattern switches by decoding corner Gray-code tags.")
@click.option("--allow-ack-without-graycode", is_flag=True,
              help="Compatibility escape hatch: permit playback ack without visual evidence.")
@click.option("--control-stdin/--no-control-stdin", default=True, show_default=True,
              help="Read JSON control commands from stdin (stop/finish/pattern_ready).")
@common_options
@click.pass_context
def session(ctx, screen_path, out_dir, backend, device, width, height, fps,
            transfer_function, preview_port, track_protocol, track_port, track_host, track_camera_id,
            poses_target, inverted, lens_path, settle_ms, settle_speed, settle_ang_speed, move_speed,
            burst_frames, timestamp_tolerance_s, graycode_sync, control_stdin,
            allow_ack_without_graycode,
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

        if inverted and not control_stdin and not graycode_sync:
            raise PreconditionError(
                "capture session has no pattern-confirmation channel: enable control stdin "
                "for pattern_ready acknowledgements or enable --graycode-sync"
            )

        backend_cfg = CaptureConfig(backend=backend, device=device, width=width,
                                    height=height, fps=fps,
                                    transfer_function=transfer_function)
        sink, server = _make_preview(preview_port, emitter)
        cfg = SessionCaptureConfig(
            out_dir=Path(out_dir), screen_path=Path(screen_path), backend=backend_cfg,
            track_protocol=track_protocol, track_port=track_port, track_host=track_host,
            track_camera_id=track_camera_id if track_protocol == "freed" else None,
            poses_target=poses_target, settle_speed_mm_s=settle_speed,
            settle_ang_speed_deg_s=settle_ang_speed,
            move_speed_mm_s=move_speed, settle_duration_s=settle_ms / 1000.0,
            burst_frames=burst_frames, timestamp_tolerance_s=timestamp_tolerance_s,
            inverted=inverted, graycode_sync=graycode_sync,
            allow_ack_without_graycode=allow_ack_without_graycode,
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
        sigma_text = (f"{cam['sigma_ms']:.1f}" if cam.get("sigma_ms") is not None
                      else "unknown")
        return OperationOutput(
            data=profile,
            text=(f"Delay: {cam['delay_ms']:+.1f} ± {sigma_text} ms "
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
