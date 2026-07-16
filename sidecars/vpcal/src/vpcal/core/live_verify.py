"""Live calibration verification with an MJPEG preview.

Pairs each captured camera frame with the closest live tracking sample, then
draws detected marker positions as green crosses and their calibrated
reprojections as red circles.  The full-quality capture plane is never
modified; only the independently encoded preview receives the annotation.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import cv2
import numpy as np
from numpy.typing import NDArray

from vpcal.core.capture_backend import CaptureBackend, CaptureConfig, CapturedFrame, open_backend
from vpcal.core.coordinates import m_rh_from_source
from vpcal.core.errors import PreconditionError
from vpcal.core.overlay import (
    _GREEN,
    _LEGEND_CJK,
    _RED,
    _detections_for_image,
    _draw_labels,
)
from vpcal.core.preview_server import PreviewServer, PreviewSink
from vpcal.core.projection import CameraIntrinsics, project_point
from vpcal.core.tracking_listener import TrackingListener
from vpcal.core.transforms import make_transform, stage_to_camera_transform
from vpcal.io.tracking_io import to_internal_pose
from vpcal.models.lens import effective_lens
from vpcal.models.session import SessionConfig
from vpcal.models.tracking import TrackingFrame

ArrayU8 = NDArray[np.uint8]
EventCallback = Callable[[str, dict], None]


@dataclass(frozen=True)
class LiveFrameResult:
    """One annotated preview frame and its measured reprojection errors."""

    image: ArrayU8
    frame_index: int
    tracking_frame_id: int
    num_observations: int
    rms_px: float | None
    max_px: float | None
    errors_px: tuple[float, ...]


class LiveOverlay:
    """Immutable solved calibration and truth-source state for live frames."""

    def __init__(self, session: SessionConfig, session_dir: Path, result: dict) -> None:
        for key in ("tracker_to_stage", "tracker_to_camera"):
            if key not in result:
                raise PreconditionError(
                    f"result.json lacks {key!r} — run `vpcal quick run` first",
                    details={"missing": key},
                )

        self.session = session
        self.session_dir = session_dir
        t2s = result["tracker_to_stage"]
        c2t = result["tracker_to_camera"]
        self._T_S = make_transform(np.asarray(t2s["rotation"]), np.asarray(t2s["translation"]))
        self._T_C = make_transform(np.asarray(c2t["rotation"]), np.asarray(c2t["translation"]))

        lens_estimate = (result.get("quality") or {}).get("lens_estimate")
        lens = effective_lens(session.lens, lens_estimate) if lens_estimate else session.lens
        self._intr = CameraIntrinsics.from_lens(lens)

        if session.marker_map is not None:
            from vpcal.core.marker_map import physical_world_map
            from vpcal.io.marker_map_io import load_marker_map

            self._marker_map = load_marker_map(_resolve(session_dir, session.marker_map.path))
            self._world_map = physical_world_map(self._marker_map)
        else:
            from vpcal.core.screen_geometry import marker_world_map
            from vpcal.io.screen_io import load_screen

            assert session.screen is not None
            self._marker_map = None
            screen = load_screen(_resolve(session_dir, session.screen.path))
            m_ue = m_rh_from_source("unreal")[:3, :3]
            self._world_map = {
                marker_id: m_ue @ world
                for marker_id, world in marker_world_map(
                    screen, markers_per_cabinet=screen.markers_per_cabinet
                ).items()
            }

    def annotate(self, captured: CapturedFrame, tracking: TrackingFrame) -> LiveFrameResult:
        """Detect and reproject markers into a preview-safe 8-bit BGR image."""
        gray = _preview_plane(captured.gray)
        q, t = to_internal_pose(
            tracking,
            self.session.tracking.coordinate_system,
            self.session.tracking.custom_transform,
        )
        T_sdk = make_transform(q, t)
        T_C_from_S = stage_to_camera_transform(self._T_S, T_sdk, self._T_C)

        if captured.bgr is not None:
            canvas = _preview_plane(captured.bgr).copy()
        else:
            canvas = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
        labels: list[tuple[str, tuple[int, int], tuple[int, int, int]]] = [
            (_LEGEND_CJK, (12, 8), (235, 235, 235))
        ]
        errors: list[float] = []
        for det in _detections_for_image(
            self.session, self._marker_map, gray, captured.frame_index
        ):
            world = self._world_map.get(det.marker_id)
            if world is None:
                continue
            cam = T_C_from_S[:3, :3] @ np.asarray(world) + T_C_from_S[:3, 3]
            if cam[2] <= 1.0:
                continue
            pred = project_point(cam, self._intr)
            if not np.all(np.isfinite(pred)):
                continue
            detected_px = (int(round(det.pixel_u)), int(round(det.pixel_v)))
            predicted_px = (int(round(pred[0])), int(round(pred[1])))
            err = float(np.hypot(pred[0] - det.pixel_u, pred[1] - det.pixel_v))
            cv2.drawMarker(canvas, detected_px, _GREEN, cv2.MARKER_CROSS, 14, 2)
            cv2.circle(canvas, predicted_px, 7, _RED, 2)
            cv2.line(canvas, detected_px, predicted_px, (0, 200, 255), 1)
            labels.append((f"{err:.1f}px", (predicted_px[0] + 8, predicted_px[1] + 4), (0, 200, 255)))
            errors.append(err)

        canvas = _draw_labels(canvas, labels)
        return LiveFrameResult(
            image=canvas,
            frame_index=captured.frame_index,
            tracking_frame_id=tracking.frame_id,
            num_observations=len(errors),
            rms_px=float(np.sqrt(np.mean(np.square(errors)))) if errors else None,
            max_px=float(np.max(errors)) if errors else None,
            errors_px=tuple(errors),
        )


def run_live_verify(
    session: SessionConfig,
    session_dir: Path,
    result: dict,
    capture_config: CaptureConfig,
    *,
    track_port: int,
    track_protocol: str = "freed",
    track_host: str = "0.0.0.0",
    track_camera_id: str | int | None = None,
    timestamp_tolerance_s: float = 0.05,
    preview_port: int = 0,
    duration_s: float = 0.0,
    max_frames: int | None = None,
    event_callback: EventCallback | None = None,
    backend: CaptureBackend | None = None,
    listener: TrackingListener | None = None,
) -> dict:
    """Run live frame/tracking pairing and publish the annotated MJPEG stream.

    ``backend`` and ``listener`` are injectable for deterministic simulator
    closure tests; production callers omit them and use the configured video
    backend plus UDP listener.
    """
    if timestamp_tolerance_s < 0:
        raise PreconditionError("timestamp tolerance must be non-negative")
    overlay = LiveOverlay(session, session_dir, result)
    source = backend if backend is not None else open_backend(capture_config)
    tracking = listener if listener is not None else TrackingListener(
        track_port, protocol=track_protocol, host=track_host,
        camera_id=track_camera_id,
    )
    sink = PreviewSink()
    server = PreviewServer(sink, port=preview_port)
    emit = event_callback or (lambda _kind, _payload: None)

    frames_seen = 0
    frames_paired = 0
    frames_annotated = 0
    skipped_tracking = 0
    observations = 0
    all_errors: list[float] = []
    started = time.monotonic()
    last_report = started
    tracking_started = False
    server_started = False
    try:
        tracking.start()
        tracking_started = True
        server.start()
        server_started = True
        emit(
            "preview_ready",
            {
                "port": server.port,
                "mjpeg_url": f"http://127.0.0.1:{server.port}/preview.mjpg",
                "ws_url": f"ws://127.0.0.1:{server.port}/preview.ws",
            },
        )
        for frame in source.frames():
            frames_seen += 1
            pair = tracking.nearest(frame.recv_ts, timestamp_tolerance_s)
            if pair is None:
                skipped_tracking += 1
                sink.publish(frame.bgr if frame.bgr is not None else frame.gray)
            else:
                frames_paired += 1
                _sample_ts, tracking_frame = pair
                annotated = overlay.annotate(frame, tracking_frame)
                sink.publish(annotated.image)
                if annotated.num_observations:
                    frames_annotated += 1
                    observations += annotated.num_observations
                    all_errors.extend(annotated.errors_px)

            now = time.monotonic()
            if now - last_report >= 0.5:
                emit(
                    "live_stats",
                    {
                        "frames": frames_seen,
                        "paired": frames_paired,
                        "annotated": frames_annotated,
                        "observations": observations,
                        "rms_px": _rms(all_errors),
                        "tracking_connected": tracking.connected,
                    },
                )
                last_report = now
            if duration_s > 0 and now - started >= duration_s:
                break
            if max_frames is not None and frames_seen >= max_frames:
                break
    finally:
        source.close()
        if tracking_started:
            tracking.stop()
        if server_started:
            server.stop()

    elapsed = time.monotonic() - started
    return {
        "backend": capture_config.backend,
        "frames": frames_seen,
        "paired_frames": frames_paired,
        "annotated_frames": frames_annotated,
        "skipped_tracking_frames": skipped_tracking,
        "num_observations": observations,
        "global_rms_px": _rms(all_errors),
        "global_max_px": float(np.max(all_errors)) if all_errors else None,
        "elapsed_s": round(elapsed, 3),
        "mean_fps": round(frames_seen / elapsed, 2) if elapsed > 0 else 0.0,
        "preview_port": server.port,
    }


def _preview_plane(image: np.ndarray) -> ArrayU8:
    if image.dtype == np.uint8:
        return image
    if image.dtype == np.uint16:
        return (image >> 8).astype(np.uint8)
    return np.clip(image, 0, 255).astype(np.uint8)


def _rms(values: list[float]) -> float | None:
    return float(np.sqrt(np.mean(np.square(values)))) if values else None


def _resolve(session_dir: Path, path_value: str) -> Path:
    path = Path(path_value)
    return path if path.is_absolute() else session_dir / path


__all__ = ["LiveFrameResult", "LiveOverlay", "run_live_verify"]
