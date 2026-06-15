"""OpenTrackIO export round-trip (spec §11): export → re-import → reproject."""

from __future__ import annotations

import json

import numpy as np

from vpcal.core.projection import CameraIntrinsics, project_point
from vpcal.core.simulator import default_lens, forward_observations, generate_camera_poses, random_ground_truth
from vpcal.core.transforms import invert_transform, make_transform
from vpcal.io.export.opentrackio import export_opentrackio
from vpcal.models.screen import PlaneSection, ScreenDefinition

INTR = CameraIntrinsics(fx=3733.33, fy=3733.33, cx=1920.0, cy=1080.0)


def test_opentrackio_roundtrip_nonidentity(tmp_path):
    screen = ScreenDefinition(
        name="w", unit="mm", cabinet_size=(500, 500), led_pixel_pitch_mm=2.8,
        markers_per_cabinet=4,
        sections=[PlaneSection(name="w", width_mm=4000, height_mm=3000, origin=[0, 0, 0])],
    )
    rng = np.random.default_rng(5)
    gt = random_ground_truth(rng)
    # Non-identity camera-from-tracker delta (spec §11 requirement).
    ang = 0.05
    q = np.array([np.cos(ang / 2), *(np.sin(ang / 2) * np.array([0.3, 0.5, 0.8]))])
    gt.camera_from_tracker_q = list(q / np.linalg.norm(q))
    gt.camera_from_tracker_t = [12.0, -5.0, 8.0]

    poses = generate_camera_poses(screen, 6, rng)
    obs, tracker_poses, _vis = forward_observations(screen, INTR, gt, poses, markers_per_cabinet=4, rng=rng)

    tp = [(fid, fid / 30.0, qf, tf) for fid, (qf, tf) in enumerate(tracker_poses)]
    t2s = (np.array(gt.tracker_to_stage_q), np.array(gt.tracker_to_stage_t))
    c2t = (np.array(gt.camera_from_tracker_q), np.array(gt.camera_from_tracker_t))
    out = tmp_path / "otio.jsonl"
    n = export_opentrackio(tp, t2s, c2t, default_lens(), out)
    assert n == len(tracker_poses)

    # Re-import through the real OpenTrackIO importer (load_tracking composes the
    # chain + decodes the spec's intrinsic-ZXY euler), convert spec frame→RH,
    # reproject.  No custom coordinate-system declaration: the exported file is
    # in the OpenTrackIO spec frame and reads back via the built-in source.
    from vpcal.io.tracking_io import load_tracking, to_internal_pose

    by_frame: dict[int, list] = {}
    for o in obs:
        by_frame.setdefault(o.frame_id, []).append(o)
    max_err = 0.0
    for frame in load_tracking(out):
        fid = frame.frame_id
        q_rh, t_rh = to_internal_pose(frame, "opentrackio")
        T_C_from_S = invert_transform(make_transform(q_rh, t_rh))
        for o in by_frame[fid]:
            pc = T_C_from_S[:3, :3] @ np.array(o.world_rh) + T_C_from_S[:3, 3]
            uv = project_point(pc, INTR)
            max_err = max(max_err, float(np.hypot(uv[0] - o.pixel_u, uv[1] - o.pixel_v)))
    assert max_err < 0.01  # spec §11: round-trip reprojection within 0.01 px


def test_opentrackio_schema_fields(tmp_path):
    """Exported samples carry the required OpenTrackIO transform fields."""
    rng = np.random.default_rng(0)
    out = tmp_path / "otio.jsonl"
    tp = [(0, 0.0, np.array([1.0, 0, 0, 0]), np.array([10.0, 20.0, 30.0]))]
    export_opentrackio(tp, (np.array([1.0, 0, 0, 0]), np.zeros(3)),
                       (np.array([1.0, 0, 0, 0]), np.zeros(3)), default_lens(), out)
    s = json.loads(out.read_text().splitlines()[0])
    assert s["protocol"]["name"] == "OpenTrackIO"
    assert s["tracker"]["status"] == "calibrated"
    tr = s["transforms"][0]
    assert set(tr["translation"].keys()) == {"x", "y", "z"}
    assert set(tr["rotation"].keys()) == {"pan", "tilt", "roll"}
