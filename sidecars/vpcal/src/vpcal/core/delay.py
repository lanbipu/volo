"""Video ↔ tracking delay calibration (plan Phase C, offline mode).

Why AR needs this daily: LED in-camera content and the physical set share the
camera's optical path, so a tracking delay is invisible at standstill; AR
composites the tracked CG stream over live video, so ANY offset shows
directly while moving (error budget: 0.59 mm per ms at working speeds).

Method (swing test): the operator pans the camera left-right across the
marker field.  Each detected marker traces a pixel trajectory u(t); the
current calibration (T_S_from_O, hand-eye, lens) predicts û(t + τ) from the
tracking stream sampled with a candidate time shift τ.  The prediction error
is scanned over τ ∈ [-search, +search], the minimum is refined by parabolic
interpolation to sub-frame resolution, and the per-marker estimates are
combined by median.

Sign convention: ``delay_ms > 0`` means the tracking stream LEADS the video
(the pose timestamped t describes the camera at video time t + delay); the
compositor must delay tracking by ``delay_ms`` to align.  Equivalently
``delay_ms = -τ*``.
"""

from __future__ import annotations

from bisect import bisect_left
from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

from vpcal.core.errors import PreconditionError
from vpcal.core.projection import CameraIntrinsics, project_points
from vpcal.core.transforms import make_transform, stage_to_camera_transform

Array = NDArray[np.float64]

DELAY_PROFILE_SCHEMA_VERSION = "1.0"

_MIN_FRAMES_PER_MARKER = 8
_MIN_MARKERS = 1
_MIN_MEAN_SPEED_PX_S = 15.0    # swing-test motion gate
_MIN_PATH_PX = 60.0


@dataclass
class _Track:
    """One marker's detected pixel trajectory."""

    times: Array       # (N,) seconds
    pixels: Array      # (N, 2)
    world: Array       # (3,) stage-frame point


class PoseSampler:
    """Time-interpolating sampler over a tracking stream (slerp + lerp)."""

    def __init__(self, samples: list[tuple[float, Array, Array]]):
        """``samples`` = time-sorted ``(timestamp_s, q_wxyz, t)`` internal poses."""
        if len(samples) < 2:
            raise PreconditionError(
                f"tracking stream has {len(samples)} samples; need >= 2 to interpolate"
            )
        self.times = np.array([s[0] for s in samples], dtype=np.float64)
        if np.any(np.diff(self.times) < 0):
            order = np.argsort(self.times)
            samples = [samples[i] for i in order]
            self.times = self.times[order]
        self.quats = np.array([s[1] for s in samples], dtype=np.float64)
        self.trans = np.array([s[2] for s in samples], dtype=np.float64)

    def sample(self, t: float) -> tuple[Array, Array]:
        times = self.times
        if t <= times[0]:
            return self.quats[0], self.trans[0]
        if t >= times[-1]:
            return self.quats[-1], self.trans[-1]
        i1 = bisect_left(times, t)
        i0 = i1 - 1
        span = times[i1] - times[i0]
        frac = 0.0 if span <= 0 else (t - times[i0]) / span
        q = _slerp(self.quats[i0], self.quats[i1], float(frac))
        tr = (1.0 - frac) * self.trans[i0] + frac * self.trans[i1]
        return q, tr


def _slerp(q0: Array, q1: Array, frac: float) -> Array:
    q0 = q0 / np.linalg.norm(q0)
    q1 = q1 / np.linalg.norm(q1)
    dot = float(np.dot(q0, q1))
    if dot < 0.0:
        q1, dot = -q1, -dot
    if dot > 0.9995:
        q = q0 + frac * (q1 - q0)
        return q / np.linalg.norm(q)
    theta = np.arccos(np.clip(dot, -1.0, 1.0))
    s0 = np.sin((1.0 - frac) * theta) / np.sin(theta)
    s1 = np.sin(frac * theta) / np.sin(theta)
    return s0 * q0 + s1 * q1


def _check_motion(tracks: list[_Track]) -> dict:
    """Swing-test motion gate: reject (exit 6) when the capture is static."""
    speeds = []
    paths = []
    for tr in tracks:
        d = np.linalg.norm(np.diff(tr.pixels, axis=0), axis=1)
        dt = np.diff(tr.times)
        ok = dt > 0
        if ok.any():
            speeds.append(float(np.mean(d[ok] / dt[ok])))
        paths.append(float(d.sum()))
    mean_speed = float(np.mean(speeds)) if speeds else 0.0
    mean_path = float(np.mean(paths)) if paths else 0.0
    if mean_speed < _MIN_MEAN_SPEED_PX_S or mean_path < _MIN_PATH_PX:
        raise PreconditionError(
            "insufficient camera motion for delay calibration "
            f"(mean pixel speed {mean_speed:.1f} px/s, mean path {mean_path:.0f} px) — "
            "swing the camera left-right across the marker field and re-capture",
            details={
                "mean_speed_px_s": mean_speed,
                "mean_path_px": mean_path,
                "min_speed_px_s": _MIN_MEAN_SPEED_PX_S,
                "min_path_px": _MIN_PATH_PX,
            },
        )
    return {"mean_speed_px_s": mean_speed, "mean_path_px": mean_path}


def _track_cost(
    track: _Track, sampler: PoseSampler, tau_s: float,
    T_S: Array, T_C: Array, intr: CameraIntrinsics,
) -> float:
    """RMS pixel error of one marker's trajectory for a candidate shift τ."""
    preds = np.empty_like(track.pixels)
    for i, t in enumerate(track.times):
        q, tr = sampler.sample(float(t) + tau_s)
        T_sdk = make_transform(q, tr)
        T_C_from_S = stage_to_camera_transform(T_S, T_sdk, T_C)
        cam = T_C_from_S[:3, :3] @ track.world + T_C_from_S[:3, 3]
        if cam[2] <= 1.0:
            return float("inf")
        preds[i] = project_points(cam.reshape(1, 3), intr)[0]
    return float(np.sqrt(np.mean(np.sum((preds - track.pixels) ** 2, axis=1))))


def _parabolic_min(taus: Array, costs: Array, idx: int) -> float:
    """Sub-step minimum via a parabola through (idx-1, idx, idx+1)."""
    if idx <= 0 or idx >= len(taus) - 1:
        return float(taus[idx])
    y0, y1, y2 = costs[idx - 1], costs[idx], costs[idx + 1]
    denom = y0 - 2.0 * y1 + y2
    if denom <= 0 or not np.isfinite(denom):
        return float(taus[idx])
    step = taus[idx + 1] - taus[idx]
    return float(taus[idx] + 0.5 * step * (y0 - y2) / denom)


def estimate_delay(
    tracks: list[_Track],
    sampler: PoseSampler,
    tracker_to_stage: tuple[Array, Array],
    camera_from_tracker: tuple[Array, Array],
    intr: CameraIntrinsics,
    *,
    search_ms: float = 100.0,
    step_ms: float = 2.0,
) -> dict:
    """Estimate the video↔tracking delay from detected marker trajectories.

    Returns the delay block: ``delay_ms ± sigma_ms`` (median over per-marker
    estimates + MAD spread) and the correlation-trough confidence.
    """
    usable = [t for t in tracks if len(t.times) >= _MIN_FRAMES_PER_MARKER]
    if len(usable) < _MIN_MARKERS:
        raise PreconditionError(
            f"only {len(usable)} marker(s) tracked over >= {_MIN_FRAMES_PER_MARKER} "
            "frames — capture a longer swing with more visible markers",
            details={"usable_markers": len(usable)},
        )
    motion = _check_motion(usable)

    T_S = make_transform(np.asarray(tracker_to_stage[0]), np.asarray(tracker_to_stage[1]))
    T_C = make_transform(np.asarray(camera_from_tracker[0]), np.asarray(camera_from_tracker[1]))
    taus = np.arange(-search_ms, search_ms + step_ms / 2, step_ms) * 1e-3

    per_marker_tau: list[float] = []
    per_marker_depth: list[float] = []
    for track in usable:
        costs = np.array([_track_cost(track, sampler, float(tau), T_S, T_C, intr) for tau in taus])
        if not np.isfinite(costs).all():
            continue
        idx = int(np.argmin(costs))
        tau_star = _parabolic_min(taus, costs, idx)
        per_marker_tau.append(tau_star)
        # Trough depth: how decisively the scan prefers the minimum (0..1).
        rng = float(costs.max() - costs.min())
        per_marker_depth.append(rng / float(costs.max()) if costs.max() > 0 else 0.0)

    if not per_marker_tau:
        raise PreconditionError(
            "delay scan produced no finite cost curve — check the calibration result "
            "and that the markers stay in frame during the swing"
        )
    tau_med = float(np.median(per_marker_tau))
    mad = float(np.median(np.abs(np.asarray(per_marker_tau) - tau_med)))
    delay_ms = -tau_med * 1e3
    sigma_ms = 1.4826 * mad * 1e3  # MAD → σ under normality
    confidence = float(np.median(per_marker_depth)) if per_marker_depth else 0.0

    return {
        "delay_ms": delay_ms,
        "sigma_ms": sigma_ms,
        "confidence": confidence,
        "num_markers": len(per_marker_tau),
        "num_frames": int(max(len(t.times) for t in usable)),
        "search_ms": search_ms,
        "step_ms": step_ms,
        "motion": motion,
        "method": "swing_reprojection_scan",
        "per_marker_delay_ms": [-t * 1e3 for t in per_marker_tau],
    }


def build_delay_profile(delay: dict, *, camera_id: str = "camA") -> dict:
    """Wrap an :func:`estimate_delay` block as ``timing/delay_profile.json``.

    Schema discipline: ``cameras`` list (multi-camera stays a 2.0 concern).
    """
    entry = {"id": camera_id, **{k: v for k, v in delay.items() if k != "per_marker_delay_ms"}}
    return {
        "schema_version": DELAY_PROFILE_SCHEMA_VERSION,
        "cameras": [entry],
        "recommendation": (
            f"set tracking delay = {delay['delay_ms']:+.1f} ms in the compositing "
            "engine (positive: tracking leads video), or export OpenTrackIO with "
            "--apply-delay to bake the compensation into the timestamps"
        ),
    }


def tracks_from_detections(
    detections_by_frame: dict[int, list],
    frame_times: dict[int, float],
    world_map: dict,
) -> list[_Track]:
    """Group per-frame detections into per-marker pixel trajectories."""
    by_marker: dict[object, list[tuple[float, float, float]]] = {}
    for frame_id, dets in detections_by_frame.items():
        t = frame_times.get(frame_id)
        if t is None:
            continue
        for det in dets:
            if det.marker_id not in world_map:
                continue
            by_marker.setdefault(det.marker_id, []).append((t, det.pixel_u, det.pixel_v))
    tracks: list[_Track] = []
    for mid, rows in by_marker.items():
        rows.sort()
        arr = np.asarray(rows, dtype=np.float64)
        tracks.append(
            _Track(times=arr[:, 0], pixels=arr[:, 1:3], world=np.asarray(world_map[mid], dtype=np.float64))
        )
    return tracks
