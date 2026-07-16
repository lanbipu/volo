"""Continuous background tracking listener (plan Phase 1b input side).

Unlike :func:`vpcal.core.capture.capture_tracking_udp` (one-shot, fixed
duration), this listener runs for the whole capture session on a daemon
thread, keeps a sliding window of decoded samples, and answers the state
machine's questions: current translation speed (settle detection), and the
pose(s) nearest a video frame's receive timestamp (timestamp pairing).

All timestamps are ``time.monotonic()`` — the same clock the video backends
stamp frames with, so pairing never crosses clock domains (precision red
line #4); the session records the clock domain in its metadata.
"""

from __future__ import annotations

import socket
import threading
import time
from collections import deque

import numpy as np

from vpcal.core.capture import (
    PROTOCOLS,
    _assemble_fragments,
    _decode_otrk_payload,
    _parse_otrk_segment,
    freed_to_frame,
    opentrackio_sample_to_frame,
)
from vpcal.models.tracking import TrackingFrame


class TrackingListener:
    """UDP tracking listener with a sliding sample window.

    Samples are ``(mono_ts, TrackingFrame)``; ``TrackingFrame.timestamp_s`` is
    ``mono_ts - t0`` where ``t0`` is the listener start (so a written
    ``poses.jsonl`` shares the session-relative time base with frame stamps).
    """

    def __init__(self, port: int, *, protocol: str = "freed", host: str = "0.0.0.0",
                 window_s: float = 600.0) -> None:
        if protocol not in PROTOCOLS:
            raise ValueError(f"unknown protocol {protocol!r}; expected one of {PROTOCOLS}")
        self.port = port
        self.protocol = protocol
        self.host = host
        self.window_s = window_s
        self.t0: float | None = None
        self._samples: deque[tuple[float, TrackingFrame]] = deque()
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._sock: socket.socket | None = None
        self._frame_id = 0
        self._otrk_buffers: dict[int, dict] = {}
        self.packets_seen = 0
        self.packets_bad = 0
        self.last_packet_mono: float | None = None

    # ── lifecycle ────────────────────────────────────────────────────

    def start(self) -> None:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((self.host, self.port))
        sock.settimeout(0.2)
        self._sock = sock
        self.t0 = time.monotonic()
        self._thread = threading.Thread(target=self._loop, name="vpcal-tracking", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)
            self._thread = None
        if self._sock is not None:
            self._sock.close()
            self._sock = None

    def _loop(self) -> None:
        assert self._sock is not None
        while not self._stop.is_set():
            try:
                data, _addr = self._sock.recvfrom(4096)
            except socket.timeout:
                continue
            except OSError:
                return
            now = time.monotonic()
            self.packets_seen += 1
            self.last_packet_mono = now
            try:
                frame = self._decode(data, now)
            except Exception:
                self.packets_bad += 1
                continue
            if frame is None:  # OTrk fragment awaiting reassembly
                continue
            with self._lock:
                self._samples.append((now, frame))
                horizon = now - self.window_s
                while self._samples and self._samples[0][0] < horizon:
                    self._samples.popleft()

    def _decode(self, data: bytes, now: float) -> TrackingFrame | None:
        assert self.t0 is not None
        rel = now - self.t0
        if self.protocol == "freed":
            frame = freed_to_frame(data, self._frame_id, rel).model_copy(
                update={"raw_monotonic_ts": now})
            self._frame_id += 1
            return frame
        # opentrackio: handle OTrk fragmentation incrementally.
        seg = _parse_otrk_segment(data)
        if seg is None:
            import json
            sample = json.loads(data.decode("utf-8"))
        else:
            encoding, seq, offset, last, payload = seg
            if offset == 0 and last:
                sample = _decode_otrk_payload(encoding, payload)
            else:
                buf = self._otrk_buffers.setdefault(
                    seq, {"frags": {}, "encoding": encoding, "last": False})
                buf["frags"][offset] = payload
                if last:
                    buf["last"] = True
                if not buf["last"]:
                    return None
                assembled = _assemble_fragments(buf["frags"])
                if assembled is None:
                    return None
                self._otrk_buffers.pop(seq, None)
                sample = _decode_otrk_payload(buf["encoding"], assembled)
        frame = opentrackio_sample_to_frame(sample, self._frame_id, rel).model_copy(
            update={"raw_monotonic_ts": now})
        self._frame_id += 1
        return frame

    # ── queries ──────────────────────────────────────────────────────

    @property
    def connected(self) -> bool:
        """True when a packet arrived within the last second."""
        return self.last_packet_mono is not None and (time.monotonic() - self.last_packet_mono) < 1.0

    def snapshot(self) -> list[tuple[float, TrackingFrame]]:
        with self._lock:
            return list(self._samples)

    def all_frames(self) -> list[TrackingFrame]:
        with self._lock:
            return [f for _ts, f in self._samples]

    def speed_mm_s(self, window_s: float = 0.3) -> float | None:
        """Translation speed over the trailing ``window_s`` (None: too few samples)."""
        now = time.monotonic()
        with self._lock:
            recent = [(ts, f) for ts, f in self._samples if ts >= now - window_s]
        if len(recent) < 2:
            return None
        speeds = []
        for (t_a, f_a), (t_b, f_b) in zip(recent, recent[1:]):
            dt = t_b - t_a
            if dt > 0:
                speeds.append(float(np.linalg.norm(
                    np.asarray(f_b.position) - np.asarray(f_a.position)) / dt))
        return max(speeds) if speeds else None

    def angular_speed_deg_s(self, window_s: float = 0.3) -> float | None:
        """Maximum adjacent-sample geodesic rotation speed in the trailing window."""
        from vpcal.core.coordinates import rotation_to_source_matrix

        now = time.monotonic()
        with self._lock:
            recent = [(ts, f) for ts, f in self._samples if ts >= now - window_s]
        speeds = []
        for (t_a, f_a), (t_b, f_b) in zip(recent, recent[1:]):
            dt = t_b - t_a
            if dt <= 0:
                continue
            Ra = rotation_to_source_matrix(f_a.rotation.order.value, f_a.rotation.values)
            Rb = rotation_to_source_matrix(f_b.rotation.order.value, f_b.rotation.values)
            angle = np.degrees(np.arccos(np.clip((np.trace(Ra.T @ Rb) - 1.0) / 2.0, -1, 1)))
            speeds.append(float(angle / dt))
        return max(speeds) if speeds else None

    def samples_between(self, t0: float, t1: float) -> list[tuple[float, TrackingFrame]]:
        with self._lock:
            return [(ts, f) for ts, f in self._samples if t0 <= ts <= t1]

    def nearest(self, ts: float, tolerance_s: float) -> tuple[float, TrackingFrame] | None:
        """Sample closest to monotonic time ``ts`` within ``tolerance_s``."""
        with self._lock:
            if not self._samples:
                return None
            best = min(self._samples, key=lambda s: abs(s[0] - ts))
        return best if abs(best[0] - ts) <= tolerance_s else None

    def mean_pose(self, t0: float, t1: float) -> TrackingFrame | None:
        """Average position and rotation over [t0, t1] (Markley quaternion mean)."""
        window = self.samples_between(t0, t1)
        if not window:
            return None
        from vpcal.core.coordinates import rotation_to_source_matrix
        from vpcal.core.transforms import matrix_to_quat

        mid = window[len(window) // 2][1]
        pos = np.mean([f.position for _ts, f in window], axis=0)
        quats = [matrix_to_quat(rotation_to_source_matrix(
            f.rotation.order.value, f.rotation.values)) for _ts, f in window]
        A = sum(np.outer(q, q) for q in quats)
        q = np.linalg.eigh(A)[1][:, -1]
        if q[0] < 0:
            q = -q
        from vpcal.models.tracking import RotationData, RotationOrder
        return TrackingFrame(
            frame_id=mid.frame_id,
            timestamp_s=mid.timestamp_s,
            position=[float(x) for x in pos],
            rotation=RotationData(order=RotationOrder.QUATERNION,
                                  values=[float(x) for x in q]),
            confidence=min(f.confidence for _ts, f in window),
            raw_monotonic_ts=mid.raw_monotonic_ts,
            protocol_ts_s=mid.protocol_ts_s,
            zoom_raw=mid.zoom_raw,
            focus_raw=mid.focus_raw,
        )


__all__ = ["TrackingListener"]
