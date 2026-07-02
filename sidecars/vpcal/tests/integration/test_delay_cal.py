"""Delay calibration (plan Phase C): synthetic injection + recovery + gates.

The simulator injects a known temporal offset on a smooth trajectory
(``temporal_offset_frames``); the swing-test scan must recover it in ms.
Convention under test: reported(t) = true(t + offset) ⇒ tracking leads video
by ``offset``, and ``delay_ms == offset_ms`` (positive).
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from vpcal.core.delay import PoseSampler, estimate_delay, tracks_from_detections
from vpcal.core.errors import PreconditionError
from vpcal.core.marker_map import physical_world_map
from vpcal.core.observations import PhysicalMarkerId
from vpcal.core.projection import CameraIntrinsics
from vpcal.core.simulator import default_lens, simulate_marker_map_dataset
from vpcal.models.marker_map import MarkerMapDefinition, SurveyedMarker

_FPS = 30.0


def _wall_map() -> MarkerMapDefinition:
    markers = []
    tid = 0
    for r in range(2):
        for c in range(3):
            markers.append(SurveyedMarker(
                marker_id=f"AT_36h11_{tid}", marker_type="apriltag",
                dictionary="DICT_APRILTAG_36h11", tag_id=tid,
                center_stage_mm=[c * 800.0, 0.0, 900.0 + r * 700.0],
                size_mm=250.0, normal=[0.0, -1.0, 0.0]))
            tid += 1
    return MarkerMapDefinition(name="delay_wall", frame_name="RH Z-up", markers=markers)


class _Det:
    """Duck-typed detection record for tracks_from_detections."""

    def __init__(self, marker_id, u, v):
        self.marker_id = marker_id
        self.pixel_u = u
        self.pixel_v = v


def _setup(tmp_path: Path, offset_frames: float, *, num_poses: int = 90, seed: int = 3):
    """Simulate a swing take; return (tracks, sampler, gt transforms, intr)."""
    mm = _wall_map()
    simulate_marker_map_dataset(
        mm, tmp_path, num_poses=num_poses, render_images=False, seed=seed,
        trajectory=True, temporal_offset_frames=offset_frames, fps=_FPS,
    )
    gt = json.loads((tmp_path / "ground_truth.json").read_text())
    world_map = physical_world_map(mm)

    detections: dict[int, list] = {}
    frame_times: dict[int, float] = {}
    for line in (tmp_path / "observations.jsonl").read_text().splitlines():
        rec = json.loads(line)
        fid = rec["frame_id"]
        mid = PhysicalMarkerId.from_dict(rec["marker_id"])
        detections.setdefault(fid, []).append(_Det(mid, rec["pixel_u"], rec["pixel_v"]))
        frame_times[fid] = fid / _FPS

    from vpcal.io.tracking_io import load_tracking, to_internal_pose

    samples = []
    for fr in load_tracking(tmp_path / "tracking" / "poses.jsonl"):
        q, t = to_internal_pose(fr, "vicon", None)
        samples.append((fr.timestamp_s, q, t))
    sampler = PoseSampler(samples)
    tracks = tracks_from_detections(detections, frame_times, world_map)
    t2s = (np.asarray(gt["tracker_to_stage"]["rotation"]),
           np.asarray(gt["tracker_to_stage"]["translation"]))
    c2t = (np.asarray(gt["camera_from_tracker"]["rotation"]),
           np.asarray(gt["camera_from_tracker"]["translation"]))
    intr = CameraIntrinsics.from_lens(default_lens())
    return tracks, sampler, t2s, c2t, intr


def test_recovers_injected_40ms(tmp_path):
    offset_frames = 0.040 * _FPS  # 40 ms
    tracks, sampler, t2s, c2t, intr = _setup(tmp_path, offset_frames)
    delay = estimate_delay(tracks, sampler, t2s, c2t, intr)
    assert delay["delay_ms"] == pytest.approx(40.0, abs=2.0)
    assert delay["num_markers"] >= 3


def test_zero_offset_reports_near_zero(tmp_path):
    tracks, sampler, t2s, c2t, intr = _setup(tmp_path, 0.0)
    delay = estimate_delay(tracks, sampler, t2s, c2t, intr)
    assert abs(delay["delay_ms"]) < 2.0


def test_static_capture_rejected(tmp_path):
    tracks, sampler, t2s, c2t, intr = _setup(tmp_path, 0.0)
    # Freeze every trajectory at its first sample: a static "swing".
    for tr in tracks:
        tr.pixels[:] = tr.pixels[0]
    with pytest.raises(PreconditionError, match="swing"):
        estimate_delay(tracks, sampler, t2s, c2t, intr)


def test_offline_cli_path_runs(tmp_path):
    """Full offline plumbing: rendered frames → detector → delay profile file."""
    mm = _wall_map()
    simulate_marker_map_dataset(
        mm, tmp_path, num_poses=45, render_images=True, seed=4,
        trajectory=True, temporal_offset_frames=0.040 * _FPS, fps=_FPS,
    )
    gt = json.loads((tmp_path / "ground_truth.json").read_text())
    result = {
        "tracker_to_stage": gt["tracker_to_stage"],
        "tracker_to_camera": gt["camera_from_tracker"],
    }
    raw = json.loads((tmp_path / "session.json").read_text())
    from vpcal.core.delay_cal import run_delay_cal
    from vpcal.models.session import SessionConfig

    session = SessionConfig.model_validate(raw)
    out = tmp_path / "timing" / "delay_profile.json"
    profile = run_delay_cal(
        session, tmp_path, result, tmp_path / "captures" / "normal",
        tmp_path / "tracking" / "poses.jsonl", fps=_FPS, out_path=out,
    )
    assert out.exists()
    cam = profile["cameras"][0]
    assert cam["delay_ms"] == pytest.approx(40.0, abs=4.0)
    assert "recommendation" in profile


def test_offline_cli_path_tolerates_frame_numbering_offset(tmp_path):
    """Frame times come from the tracking clock: a 1000-based filename sequence
    and an arbitrary tracking clock origin must not bias the recovered delay."""
    mm = _wall_map()
    simulate_marker_map_dataset(
        mm, tmp_path, num_poses=45, render_images=True, seed=4,
        trajectory=True, temporal_offset_frames=0.040 * _FPS, fps=_FPS,
    )
    # Shift BOTH the filenames and the tracking frame ids/timestamps by a
    # consistent offset (a real take recorded with non-zero-based numbering
    # and a wall-clock time origin).
    frames_dir = tmp_path / "captures" / "normal"
    for p in sorted(frames_dir.glob("*.png"), reverse=True):
        p.rename(frames_dir / f"{int(p.stem) + 1000:04d}.png")
    poses = tmp_path / "tracking" / "poses.jsonl"
    shifted = []
    for line in poses.read_text().splitlines():
        rec = json.loads(line)
        rec["frame_id"] += 1000
        rec["timestamp_s"] += 500.0
        shifted.append(json.dumps(rec))
    poses.write_text("\n".join(shifted) + "\n")

    gt = json.loads((tmp_path / "ground_truth.json").read_text())
    result = {
        "tracker_to_stage": gt["tracker_to_stage"],
        "tracker_to_camera": gt["camera_from_tracker"],
    }
    raw = json.loads((tmp_path / "session.json").read_text())
    from vpcal.core.delay_cal import run_delay_cal
    from vpcal.models.session import SessionConfig

    session = SessionConfig.model_validate(raw)
    profile = run_delay_cal(
        session, tmp_path, result, frames_dir,
        poses, fps=_FPS, out_path=None,
    )
    assert profile["cameras"][0]["delay_ms"] == pytest.approx(40.0, abs=4.0)


def test_export_apply_delay_shifts_timestamps(tmp_path):
    """Plan C3: --apply-delay re-timestamps samples and flags the compensation."""
    from vpcal.io.export.opentrackio import export_opentrackio

    q = np.array([1.0, 0.0, 0.0, 0.0])
    t = np.array([0.0, 0.0, 0.0])
    poses = [(0, 1.0, q, t), (1, 1.5, q, t)]
    out = tmp_path / "otio.jsonl"
    export_opentrackio(poses, (q, t), (q, t), default_lens(), out, applied_delay_ms=40.0)
    lines = [json.loads(ln) for ln in out.read_text().splitlines()]
    ts0 = lines[0]["timing"]["sampleTimestamp"]
    assert ts0["seconds"] == 1 and ts0["nanoseconds"] == pytest.approx(40_000_000, abs=1)
    assert "delayCompensated" in lines[0]["tracker"]["notes"]
