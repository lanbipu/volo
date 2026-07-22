"""Offline delay-calibration orchestration (plan Phase C1, offline mode).

Glue over :mod:`vpcal.core.delay`: read the swing-test frames, detect the
markers (physical detector for a marker-map session, VP-QSP for a screen
session), build the per-marker pixel trajectories and the pose sampler, run
the τ scan and write ``timing/delay_profile.json``.

The live path (CaptureBackend + C1.1 tracking ingest) plugs into the same
:func:`vpcal.core.delay.estimate_delay` once the capture service exposes a
timestamped frame stream — only this file's input side is offline-specific.
"""

from __future__ import annotations

import json
from pathlib import Path

import cv2
import numpy as np

from vpcal.core.delay import (
    PoseSampler,
    build_delay_profile,
    estimate_delay,
    tracks_from_detections,
)
from vpcal.core.errors import PreconditionError
from vpcal.core.projection import CameraIntrinsics
from vpcal.io.frame_matching import parse_frame_number
from vpcal.io.tracking_io import load_tracking, to_internal_pose
from vpcal.models.lens import effective_lens
from vpcal.models.session import SessionConfig


def _resolve(session_dir: Path, p: str) -> Path:
    path = Path(p)
    return path if path.is_absolute() else session_dir / path


def _world_map(session: SessionConfig, session_dir: Path):
    """(world_map, marker_map|None) — same truth routing as the pipeline."""
    if session.marker_map is not None:
        from vpcal.core.marker_map import physical_world_map
        from vpcal.io.marker_map_io import load_marker_map

        marker_map = load_marker_map(_resolve(session_dir, session.marker_map.path))
        return physical_world_map(marker_map), marker_map
    from vpcal.core.pipeline import _M_UE
    from vpcal.core.session_targets import combined_world_map, load_screen_targets

    targets = load_screen_targets(session, session_dir)
    world, _ = combined_world_map(targets, transform=lambda point: _M_UE @ point)
    return world, None


def run_delay_cal(
    session: SessionConfig,
    session_dir: Path,
    result: dict,
    video_dir: Path,
    tracking_path: Path,
    *,
    fps: float = 30.0,
    search_ms: float = 100.0,
    out_path: Path | None = None,
    camera_id: str = "camA",
) -> dict:
    """Run the offline swing-test delay calibration; returns the delay profile."""
    for key in ("tracker_to_stage", "tracker_to_camera"):
        if key not in result:
            raise PreconditionError(
                f"result.json lacks {key!r} — delay calibration needs a completed "
                "spatial calibration",
                details={"missing": key},
            )
    from vpcal.core.validator import list_images

    images = list_images(video_dir)
    if len(images) < 2:
        raise PreconditionError(
            f"only {len(images)} frame(s) under {video_dir}; the swing test needs a "
            "continuous frame sequence",
            details={"video_dir": str(video_dir), "frames": len(images)},
        )
    world_map, marker_map = _world_map(session, session_dir)
    # A QLE result was solved with result.quality.lens_estimate, not the
    # nominal session lens — predicting trajectories through the nominal lens
    # lets the τ scan absorb the lens mismatch into a biased delay_ms.
    lens_estimate = (result.get("quality") or {}).get("lens_estimate")
    lens = effective_lens(session.lens, lens_estimate) if lens_estimate else session.lens
    intr = CameraIntrinsics.from_lens(lens)

    tracking = load_tracking(tracking_path)
    samples = []
    ts_by_fid: dict[int, float] = {}
    for fr in tracking:
        q, t = to_internal_pose(
            fr, session.tracking.coordinate_system, session.tracking.custom_transform
        )
        clock_ts = fr.raw_monotonic_ts if fr.raw_monotonic_ts is not None else fr.timestamp_s
        samples.append((clock_ts, q, t))
        ts_by_fid.setdefault(fr.frame_id, clock_ts)
    sampler = PoseSampler(samples)

    # Video frame times must live in the TRACKING clock domain: the offline
    # convention is a frame-indexed take (video frame N ↔ tracking record N),
    # so a frame's time is that record's timestamp.  Deriving it as
    # ``frame_id / fps`` instead would bias the recovered delay by any
    # filename-numbering offset (a 0001-based sequence alone adds one frame)
    # or clamp everything when the tracking clock has a different origin.
    base_fid = min(ts_by_fid) if ts_by_fid else None
    manifest_times: dict[int, float] = {}
    manifest_path = video_dir / "frames.jsonl"
    if manifest_path.exists():
        for line in manifest_path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            rec = json.loads(line)
            if rec.get("recv_ts") is not None:
                manifest_times[int(rec["frame_index"])] = float(rec["recv_ts"])

    image_fids = [parse_frame_number(p) for p in images]
    matched_ts = [ts_by_fid[fid] for fid in image_fids if fid is not None and fid in ts_by_fid]
    if not manifest_times and len(matched_ts) >= 3:
        median_dt = float(np.median(np.diff(sorted(matched_ts))))
        nominal_dt = 1.0 / fps
        if abs(median_dt - nominal_dt) / nominal_dt > 0.15:
            raise PreconditionError(
                "video/tracking sampling rates disagree by more than 15% and "
                "frames.jsonl is missing — recapture video with the frame manifest",
                details={"tracking_median_dt_s": median_dt, "video_nominal_dt_s": nominal_dt,
                         "fps": fps, "manifest": str(manifest_path)},
            )

    def _frame_time(fid: int) -> float:
        if fid in manifest_times:
            return manifest_times[fid]
        ts = ts_by_fid.get(fid)
        if ts is not None:
            return ts
        if base_fid is not None:
            return ts_by_fid[base_fid] + (fid - base_fid) / fps
        return fid / fps

    detections_by_frame: dict[int, list] = {}
    frame_times: dict[int, float] = {}
    for image_path in images:
        frame_id = parse_frame_number(image_path)
        if frame_id is None:
            continue
        img = cv2.imread(image_path, cv2.IMREAD_GRAYSCALE)
        if img is None:
            continue
        if marker_map is not None:
            from vpcal.core.detector_physical import detect_physical_markers

            dets, _counters = detect_physical_markers(img, marker_map, frame_id=frame_id)
        else:
            from vpcal.core.detector import detect_markers

            dets = [d for d in detect_markers(img, frame_id=frame_id) if d.confidence >= 1.0]
        detections_by_frame[frame_id] = dets
        frame_times[frame_id] = _frame_time(frame_id)

    tracks = tracks_from_detections(detections_by_frame, frame_times, world_map)
    t2s = (np.asarray(result["tracker_to_stage"]["rotation"]),
           np.asarray(result["tracker_to_stage"]["translation"]))
    c2t = (np.asarray(result["tracker_to_camera"]["rotation"]),
           np.asarray(result["tracker_to_camera"]["translation"]))
    delay = estimate_delay(tracks, sampler, t2s, c2t, intr, search_ms=search_ms)
    profile = build_delay_profile(delay, camera_id=camera_id)

    if out_path is not None:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(profile, indent=2, ensure_ascii=False))
    return profile
