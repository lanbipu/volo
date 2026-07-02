"""Live capture session state machine (plan Phase 1b — the C1.2/C1.3 core).

Runs the closed capture loop::

    WAIT_TRACKING → MOVING → SETTLING → CAPTURING → WAIT_MOVE → MOVING → …

- **settle detection**: tracking translation speed below
  ``settle_speed_mm_s`` for ``settle_duration_s`` ⇒ the operator has parked
  the camera on a pose (static multi-pose capture is constructively immune to
  frame-pairing latency — ``docs/error-budget.md``);
- **burst capture**: ``burst_frames`` consecutive frames are averaged into one
  full-quality PNG (noise ↓), paired with the tracking window's mean pose;
- **feedback**: every pose is immediately run through the VP-QSP detector and
  the running coverage summary is re-emitted, so insufficient coverage is
  discovered *while the crew is still on set* (the whole point of C1);
- **persistence**: a standard session directory (``captures/normal/NNNN.png``,
  ``tracking/poses.jsonl``, ``session.json``) directly consumable by
  ``vpcal quick run`` — pairing keys on ``frame_id`` in the persisted artifact
  (live pairing already happened here, by receive timestamp on one monotonic
  clock), which is the layout the offline pipeline already accepts.

The runner is I/O-injectable: any :class:`~vpcal.core.capture_backend.CaptureBackend`
provides frames, a :class:`~vpcal.core.tracking_listener.TrackingListener`
provides poses, events go to a callback, and control arrives via
:meth:`CaptureSessionRunner.post` — the CLI adapter wires stdin/stdout around
it, tests wire synthetic sources.
"""

from __future__ import annotations

import dataclasses
import enum
import json
import queue
import time
from pathlib import Path
from typing import Any, Callable

import numpy as np

from vpcal.core.capture import COORDINATE_SYSTEM
from vpcal.core.capture_backend import CaptureBackend, CaptureConfig
from vpcal.core.detector import detect_markers
from vpcal.core.errors import PreconditionError
from vpcal.core.graycode import decode_tag
from vpcal.core.screen_geometry import enumerate_markers
from vpcal.core.tracking_listener import TrackingListener
from vpcal.io.screen_io import load_screen
from vpcal.io.tracking_io import write_tracking
from vpcal.models.tracking import TrackingFrame

EventCallback = Callable[[str, dict[str, Any]], None]

_SENSOR_REGION_NAMES = {
    (0, 0): "左上", (0, 1): "上", (0, 2): "右上",
    (1, 0): "左", (1, 1): "中心", (1, 2): "右",
    (2, 0): "左下", (2, 1): "下", (2, 2): "右下",
}


class SessionState(str, enum.Enum):
    WAIT_TRACKING = "wait_tracking"
    MOVING = "moving"
    SETTLING = "settling"
    CAPTURING = "capturing"
    WAIT_MOVE = "wait_move"
    DONE = "done"


@dataclasses.dataclass
class SessionCaptureConfig:
    """All state-machine knobs (plan risk #5: defaults are provisional until
    bench-tested; every threshold is configurable)."""

    out_dir: Path
    screen_path: Path
    backend: CaptureConfig
    track_protocol: str = "freed"
    track_port: int = 6301
    track_host: str = "0.0.0.0"
    poses_target: int = 8              # 0 = unlimited (stop via control command)
    settle_speed_mm_s: float = 5.0     # below ⇒ settling
    move_speed_mm_s: float = 25.0      # above ⇒ moving again (hysteresis)
    settle_duration_s: float = 0.3     # T_settle (plan 1b default 300 ms)
    burst_frames: int = 5
    timestamp_tolerance_s: float = 0.05
    inverted: bool = False             # capture an inverted frame per pose
    graycode_sync: bool = False        # auto-confirm pattern via corner tags
    graycode_cell_px: int = 24
    pattern_wait_s: float = 10.0       # max wait for pattern switch per pose
    tracking_wait_s: float = 30.0      # max wait for first tracking packet
    lens_path: Path | None = None
    preview_sink: Any = None           # PreviewSink | None (duck-typed)


@dataclasses.dataclass
class _PoseRecord:
    index: int                 # 1-based; equals persisted frame_id
    tracking: TrackingFrame
    marker_hits: int
    detections: list


class CaptureSessionRunner:
    """Drives one live capture session; see module docstring."""

    def __init__(self, config: SessionCaptureConfig, backend: CaptureBackend,
                 emit: EventCallback, *, listener: TrackingListener | None = None) -> None:
        self.cfg = config
        self.backend = backend
        self.emit = emit
        self.listener = listener or TrackingListener(
            config.track_port, protocol=config.track_protocol, host=config.track_host)
        self._own_listener = listener is None
        self._control: queue.Queue[dict] = queue.Queue()
        self._poses: list[_PoseRecord] = []
        self._all_detections: list = []
        self._seen_marker_ids: set = set()
        self._screen = load_screen(config.screen_path)
        self._total_markers = len(enumerate_markers(
            self._screen, markers_per_cabinet=self._screen.markers_per_cabinet))
        self._frame_size: tuple[int, int] | None = None  # (w, h)
        self._state = SessionState.WAIT_TRACKING
        self._timings: dict[str, Any] = {"poses": []}
        self._stopped = False

    # ── control channel ──────────────────────────────────────────────

    def post(self, command: dict[str, Any]) -> None:
        """Post a control command (thread-safe): ``{"cmd": ...}``.

        Commands: ``stop`` (abort), ``finish`` (stop after current pose and
        assemble), ``skip_pose``, ``pattern_ready`` (playback switched, fields
        ``pattern``: "normal"|"inverted", optional ``frame_index``).
        """
        self._control.put(dict(command))

    def _drain_control(self) -> list[dict]:
        cmds = []
        while True:
            try:
                cmds.append(self._control.get_nowait())
            except queue.Empty:
                return cmds

    # ── event helpers ────────────────────────────────────────────────

    def _set_state(self, state: SessionState, **extra: Any) -> None:
        if state is self._state:
            return
        self._state = state
        self.emit("progress", {"state": state.value, "poses_captured": len(self._poses),
                               "poses_target": self.cfg.poses_target, **extra})

    # ── main loop ────────────────────────────────────────────────────

    def run(self) -> dict[str, Any]:
        t_session0 = time.monotonic()
        out = self.cfg.out_dir
        (out / "captures" / "normal").mkdir(parents=True, exist_ok=True)
        if self.cfg.inverted:
            (out / "captures" / "inverted").mkdir(parents=True, exist_ok=True)
        (out / "tracking").mkdir(parents=True, exist_ok=True)

        if self._own_listener:
            self.listener.start()
        frames = self.backend.frames()
        settle_t0: float | None = None
        finish_requested = False
        abort = False
        try:
            self._set_state(SessionState.WAIT_TRACKING)
            wait_t0 = time.monotonic()
            for frame in frames:
                if self._frame_size is None:
                    h, w = frame.gray.shape[:2]
                    self._frame_size = (w, h)
                if self.cfg.preview_sink is not None:
                    self.cfg.preview_sink.publish(
                        frame.bgr if frame.bgr is not None else frame.gray)

                for cmd in self._drain_control():
                    name = cmd.get("cmd")
                    if name == "stop":
                        abort = True
                    elif name == "finish":
                        finish_requested = True
                    elif name == "skip_pose":
                        settle_t0 = None
                        self._set_state(SessionState.WAIT_MOVE)
                if abort:
                    break
                # `finish` must work from ANY state (stdin EOF posts it when the
                # host goes away) — checking it only after the state dispatch
                # would strand it behind WAIT_TRACKING's `continue`.
                if finish_requested:
                    break

                speed = self.listener.speed_mm_s()
                now = time.monotonic()

                if self._state is SessionState.WAIT_TRACKING:
                    if self.listener.connected:
                        self._set_state(SessionState.MOVING)
                    elif now - wait_t0 > self.cfg.tracking_wait_s:
                        raise PreconditionError(
                            f"no tracking packets on {self.cfg.track_protocol} UDP port "
                            f"{self.cfg.track_port} within {self.cfg.tracking_wait_s:.0f}s",
                            details={"port": self.cfg.track_port,
                                     "protocol": self.cfg.track_protocol})
                    continue

                if not self.listener.connected:
                    self.emit("warning", {"message": "tracking stream lost; waiting"})
                    self._set_state(SessionState.WAIT_TRACKING)
                    wait_t0 = now
                    settle_t0 = None
                    continue

                if self._state in (SessionState.MOVING, SessionState.SETTLING):
                    if speed is not None and speed < self.cfg.settle_speed_mm_s:
                        if settle_t0 is None:
                            settle_t0 = now
                            self._set_state(SessionState.SETTLING, speed_mm_s=speed)
                        elif now - settle_t0 >= self.cfg.settle_duration_s:
                            self._set_state(SessionState.CAPTURING)
                            self._capture_pose(frames, frame)
                            settle_t0 = None
                            if self._target_reached() or finish_requested:
                                break
                            self._set_state(SessionState.WAIT_MOVE)
                    else:
                        settle_t0 = None
                        if self._state is SessionState.SETTLING:
                            self._set_state(SessionState.MOVING)
                elif self._state is SessionState.WAIT_MOVE:
                    if speed is not None and speed > self.cfg.move_speed_mm_s:
                        self._set_state(SessionState.MOVING)
        finally:
            self.backend.close()
            if self._own_listener:
                self.listener.stop()

        if abort:
            raise PreconditionError("capture session aborted by controller",
                                    details={"poses_captured": len(self._poses)})
        self._set_state(SessionState.DONE)
        self._timings["total_s"] = round(time.monotonic() - t_session0, 3)
        return self._assemble(out)

    def _target_reached(self) -> bool:
        return self.cfg.poses_target > 0 and len(self._poses) >= self.cfg.poses_target

    # ── pose capture ─────────────────────────────────────────────────

    def _burst(self, frames_iter, first_frame) -> tuple[np.ndarray, float, float, str | None]:
        """Average ``burst_frames`` frames → (avg_image, t_start, t_end, timecode)."""
        acc = first_frame.gray.astype(np.float64)
        t_start = first_frame.recv_ts
        t_end = first_frame.recv_ts
        timecode = first_frame.timecode
        n = 1
        while n < self.cfg.burst_frames:
            frame = next(frames_iter)
            if self.cfg.preview_sink is not None:
                self.cfg.preview_sink.publish(
                    frame.bgr if frame.bgr is not None else frame.gray)
            acc += frame.gray.astype(np.float64)
            t_end = frame.recv_ts
            timecode = timecode or frame.timecode
            n += 1
        avg = acc / n
        dtype = first_frame.gray.dtype
        return avg.astype(dtype), t_start, t_end, timecode

    def _wait_pattern(self, frames_iter, pattern: str) -> tuple[Any, bool]:
        """Ask playback for ``pattern``; wait for ack (stdin) or Gray-code proof.

        Returns ``(next_frame, ok)`` — the frame stream keeps advancing while
        waiting so the preview stays live and stale frames are not captured.
        """
        self.emit("request_pattern", {"pattern": pattern})
        deadline = time.monotonic() + self.cfg.pattern_wait_s
        acked = False
        frame = None
        while time.monotonic() < deadline:
            frame = next(frames_iter)
            if self.cfg.preview_sink is not None:
                self.cfg.preview_sink.publish(
                    frame.bgr if frame.bgr is not None else frame.gray)
            for cmd in self._drain_control():
                if cmd.get("cmd") == "pattern_ready" and cmd.get("pattern") == pattern:
                    acked = True
                elif cmd.get("cmd") == "stop":
                    self._control.put(cmd)  # re-queue for the main loop
                    return frame, False
            if acked and not self.cfg.graycode_sync:
                return frame, True
            if self.cfg.graycode_sync:
                gray8 = frame.gray if frame.gray.dtype == np.uint8 \
                    else (frame.gray >> 8).astype(np.uint8)
                tag = decode_tag(gray8, cell_px=self.cfg.graycode_cell_px)
                if tag is not None and tag.inverted == (pattern == "inverted"):
                    return frame, True
            if acked:  # graycode requested but not decodable — trust the ack
                return frame, True
        self.emit("warning", {"message": f"pattern switch to '{pattern}' not confirmed "
                                         f"within {self.cfg.pattern_wait_s:.0f}s"})
        return frame, False

    def _capture_pose(self, frames_iter, current_frame) -> None:
        import cv2

        cfg = self.cfg
        index = len(self._poses) + 1
        t_pose0 = time.monotonic()

        avg_n, t0, t1, timecode = self._burst(frames_iter, current_frame)
        avg_i = None
        if cfg.inverted:
            frame, ok = self._wait_pattern(frames_iter, "inverted")
            if ok and frame is not None:
                avg_i, _ti0, t1, _tc = self._burst(frames_iter, frame)
            # Switch playback back for the next pose (ack awaited next round).
            self.emit("request_pattern", {"pattern": "normal"})

        pose = self.listener.mean_pose(t0 - cfg.timestamp_tolerance_s,
                                       t1 + cfg.timestamp_tolerance_s)
        if pose is None:
            self.emit("warning", {
                "message": f"pose {index}: no tracking samples within tolerance "
                           f"({cfg.timestamp_tolerance_s}s) of the burst window — pose dropped",
            })
            return
        # Persisted frame_id == file number == pose index (live pairing done).
        tracked = TrackingFrame(
            frame_id=index, timestamp_s=max(0.0, pose.timestamp_s),
            position=pose.position, rotation=pose.rotation, confidence=pose.confidence)

        name = f"{index:04d}.png"
        cv2.imwrite(str(cfg.out_dir / "captures" / "normal" / name), avg_n)
        if avg_i is not None:
            cv2.imwrite(str(cfg.out_dir / "captures" / "inverted" / name), avg_i)

        self.emit("pose_captured", {
            "pose_index": index, "file": f"captures/normal/{name}",
            "inverted_captured": avg_i is not None,
            "timecode": timecode,
            "burst_frames": cfg.burst_frames,
            "position_mm": [round(x, 2) for x in tracked.position],
        })

        det_n = avg_n if avg_n.dtype == np.uint8 else (avg_n >> 8).astype(np.uint8)
        det_i = None
        if avg_i is not None:
            det_i = avg_i if avg_i.dtype == np.uint8 else (avg_i >> 8).astype(np.uint8)
        detections = detect_markers(det_n, frame_id=index, inverted=det_i)
        self._poses.append(_PoseRecord(index, tracked, len(detections), detections))
        self._all_detections.extend(detections)
        for d in detections:
            self._seen_marker_ids.add(d.marker_id)

        self.emit("detect_feedback", {
            "pose_index": index,
            "marker_hits": len(detections),
            "differenced": bool(detections) and all(d.differenced for d in detections),
            "mean_confidence": round(float(np.mean([d.confidence for d in detections])), 3)
            if detections else 0.0,
        })
        self.emit("coverage_update", self._coverage_summary())
        self._timings["poses"].append({"pose": index,
                                       "duration_s": round(time.monotonic() - t_pose0, 3)})

    # ── coverage feedback ────────────────────────────────────────────

    def _coverage_summary(self) -> dict[str, Any]:
        w, h = self._frame_size or (1, 1)
        grid = np.zeros((3, 3), dtype=bool)
        for d in self._all_detections:
            c = min(2, max(0, int(d.pixel_u / w * 3)))
            r = min(2, max(0, int(d.pixel_v / h * 3)))
            grid[r, c] = True
        missing = [_SENSOR_REGION_NAMES[(r, c)] for r in range(3) for c in range(3)
                   if not grid[r, c]]
        positions = np.array([p.tracking.position for p in self._poses]) \
            if self._poses else np.zeros((0, 3))
        spread = float(np.linalg.norm(positions.max(axis=0) - positions.min(axis=0))) \
            if len(positions) > 1 else 0.0
        suggestions = []
        if missing:
            suggestions.append("画面 " + "、".join(missing[:4]) + " 区域未覆盖，建议调整取景")
        if self.cfg.poses_target > 0 and len(self._poses) < self.cfg.poses_target:
            suggestions.append(f"还需 {self.cfg.poses_target - len(self._poses)} 个 pose")
        elif not missing:
            suggestions.append("覆盖达标，可以求解")
        return {
            "poses_captured": len(self._poses),
            "sensor_coverage_pct": round(float(grid.sum() / 9.0), 3),
            "sensor_missing_regions": missing,
            "screen_markers_seen": len(self._seen_marker_ids),
            "screen_markers_total": self._total_markers,
            "screen_coverage_pct": round(len(self._seen_marker_ids) / max(self._total_markers, 1), 3),
            "pose_spatial_spread_mm": round(spread, 1),
            "suggestions": suggestions,
        }

    # ── session assembly ─────────────────────────────────────────────

    def _assemble(self, out: Path) -> dict[str, Any]:
        if not self._poses:
            raise PreconditionError("capture session produced no poses",
                                    details={"hint": "check tracking stream and settle thresholds"})
        write_tracking([p.tracking for p in self._poses], out / "tracking" / "poses.jsonl")

        session: dict[str, Any] = {
            "images": {"path": "captures/normal", "format": "png"},
            "tracking": {
                "path": "tracking/poses.jsonl",
                "coordinate_system": COORDINATE_SYSTEM[self.cfg.track_protocol],
                "frame_matching": "frame_id",
                "timestamp_tolerance_s": self.cfg.timestamp_tolerance_s,
            },
            "screen": {"path": str(self.cfg.screen_path)},
        }
        lens_ready = False
        if self.cfg.lens_path is not None:
            session["lens"] = json.loads(Path(self.cfg.lens_path).read_text(encoding="utf-8"))
            lens_ready = True
        (out / "session.json").write_text(
            json.dumps(session, ensure_ascii=False, indent=2), encoding="utf-8")

        meta = {
            "capture": {
                "backend": self.cfg.backend.backend,
                "transport": ("ndi(speedhq)" if self.cfg.backend.backend == "ndi"
                              else self.cfg.backend.backend),
                "transfer_function": self.cfg.backend.transfer_function,
                "burst_frames": self.cfg.burst_frames,
                "settle_speed_mm_s": self.cfg.settle_speed_mm_s,
                "settle_duration_s": self.cfg.settle_duration_s,
                "clock_domain": "time.monotonic",
                "lossy_transport": self.cfg.backend.backend == "ndi",
            },
            "timings": self._timings,
        }
        (out / "capture_meta.json").write_text(
            json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

        if not lens_ready:
            self.emit("warning", {"message": "session.json written without a lens profile — "
                                             "add one before `vpcal quick run`"})
        return {
            "session_dir": str(out),
            "session_json": str(out / "session.json"),
            "lens_ready": lens_ready,
            "poses_captured": len(self._poses),
            "marker_hits_total": len(self._all_detections),
            "coverage": self._coverage_summary(),
            "timings": self._timings,
        }


__all__ = ["SessionState", "SessionCaptureConfig", "CaptureSessionRunner"]
