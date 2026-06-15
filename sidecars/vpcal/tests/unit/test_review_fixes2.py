"""Regression tests for the gap-closure review round (post-fix re-review findings)."""

from __future__ import annotations

import json
import warnings

import numpy as np
import pytest

from vpcal.core.coordinates import (
    _euler_ptr_to_matrix,
    convert_pose,
    matrix_to_opentrackio_euler,
    opentrackio_euler_to_matrix,
)
from vpcal.core.errors import ConfigError
from vpcal.core.observations import MarkerId, Observation
from vpcal.core.projection import CameraIntrinsics
from vpcal.io.tracking_io import load_tracking
from vpcal.qa.reprojection import reprojection_report

INTR = CameraIntrinsics(fx=1000, fy=1000, cx=960, cy=540, width=1920, height=1080)


# ── Finding 1: OpenTrackIO euler convention (intrinsic ZXY, not internal) ──


def test_opentrackio_uses_intrinsic_zxy_convention(tmp_path):
    """A pan-only OpenTrackIO sample must decode under Rz·Rx·Ry, not the internal Ry·Rx·Rz."""
    sample = {
        "protocol": {"name": "OpenTrackIO"},
        "timing": {"sequenceNumber": 0},
        "transforms": [{"translation": {"x": 0, "y": 0, "z": 0}, "rotation": {"pan": 30.0, "tilt": 0.0, "roll": 0.0}}],
    }
    p = tmp_path / "o.jsonl"
    p.write_text(json.dumps(sample))
    frame = load_tracking(p)[0]
    from vpcal.core.transforms import quat_to_matrix

    R_decoded = quat_to_matrix(np.array(frame.rotation.values))
    assert np.allclose(R_decoded, opentrackio_euler_to_matrix(30, 0, 0), atol=1e-9)
    # And it differs from the internal FreeD convention for pan-only.
    assert not np.allclose(R_decoded, _euler_ptr_to_matrix(30, 0, 0), atol=1e-3)


def test_opentrackio_euler_matrix_are_inverses():
    R = opentrackio_euler_to_matrix(40, -20, 15)
    p, t, r = matrix_to_opentrackio_euler(R)
    assert np.allclose(opentrackio_euler_to_matrix(p, t, r), R, atol=1e-9)


# ── Finding 4 & matrix path: order="matrix" orthonormality ──


def test_matrix_rotation_rejects_non_orthonormal():
    reflection = [1, 0, 0, 0, 1, 0, 0, 0, -1]  # det = -1
    with pytest.raises(ConfigError):
        convert_pose("vicon", "matrix", reflection, [0, 0, 0])
    scale = [2, 0, 0, 0, 1, 0, 0, 0, 1]  # det = 2
    with pytest.raises(ConfigError):
        convert_pose("vicon", "matrix", scale, [0, 0, 0])


def test_matrix_rotation_accepts_proper_rotation():
    rot90z = [0, -1, 0, 1, 0, 0, 0, 0, 1]
    q, _t = convert_pose("vicon", "matrix", rot90z, [0, 0, 0])
    assert np.isclose(np.linalg.norm(q), 1.0)


# ── Finding 2: behind-camera observations excluded from stats ──


def _obs(pixel, world, frame_id=0):
    return Observation(pixel[0], pixel[1], world, (1, 0, 0, 0), (0, 0, 0), frame_id, MarkerId(0, 0, frame_id, 0))


def test_behind_camera_excluded_from_stats():
    # 30 good in-front markers + 1 behind-camera (Z<0) marker.
    t2s = (np.array([1.0, 0, 0, 0]), np.zeros(3))
    c2t = (np.array([1.0, 0, 0, 0]), np.zeros(3))
    obs = []
    for i in range(30):
        world = (i * 5.0, 0.0, 1000.0)  # Z>0, projects near principal axis
        # detected = exact projection so error ~0
        u = INTR.fx * world[0] / world[2] + INTR.cx
        obs.append(_obs((u, INTR.cy), world, frame_id=i % 5))
    obs.append(_obs((100.0, 100.0), (10.0, 5.0, 0.0), frame_id=0))  # on camera plane Z=0 → inf
    rep = reprojection_report(obs, INTR, t2s, c2t)
    assert rep["non_projectable_observations"] == 1
    # Headline RMS must stay tiny (not ~1e5), unaffected by the behind-camera point.
    assert rep["global_rms_px"] < 1.0
    assert np.isfinite(rep["global_max_px"])
    # JSON must be valid (no Infinity/NaN).
    json.dumps(rep)  # raises if non-finite leaked in
    # Histogram counts the finite observations.
    assert sum(rep["error_histogram"]["counts"]) == 30


def test_reprojection_report_empty_no_warnings():
    t2s = (np.array([1.0, 0, 0, 0]), np.zeros(3))
    with warnings.catch_warnings():
        warnings.simplefilter("error")  # any RuntimeWarning becomes an error
        rep = reprojection_report([], INTR, t2s, t2s)
    assert rep["global_rms_px"] == 0.0
    assert rep["lens_residual_check"]["radial_pattern_detected"] is False


# ── Finding 5: image_count is the pose count, not the observation count ──


def test_image_count_is_pose_count(tmp_path):
    from vpcal.core.pipeline import run_quick
    from vpcal.core.simulator import default_lens, simulate_dataset
    from vpcal.models.screen import PlaneSection, ScreenDefinition
    from vpcal.models.session import SessionConfig

    screen = ScreenDefinition(
        name="s", unit="mm", cabinet_size=(500, 500), led_pixel_pitch_mm=2.8,
        markers_per_cabinet=4,
        sections=[PlaneSection(name="w", width_mm=2400, height_mm=1600, origin=[0, 0, 0])],
    )
    simulate_dataset(screen, tmp_path, num_poses=9, lens=default_lens(1920, 1080), render_images=False)
    raw = json.loads((tmp_path / "session.json").read_text())
    result = run_quick(SessionConfig.model_validate(raw), tmp_path, tmp_path / "output", raw_session=raw, prefer_cpp=True)
    quality = result["result"]["quality"]
    inputs = result["result"]["inputs"]
    assert inputs["image_count"] == 9  # poses, not observations
    assert quality["total_observations"] > 9  # many markers per pose
    assert inputs["image_count"] != quality["total_observations"]
