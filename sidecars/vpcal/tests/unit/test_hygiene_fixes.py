"""Remediation D2 (un-wired config) + D5 (small-fix set) acceptance tests."""

from __future__ import annotations

import json

import numpy as np
import pytest

from vpcal.core.errors import ConfigError, PreconditionError, SolverTimeoutError
from vpcal.core.projection import CameraIntrinsics
from vpcal.core.simulator import (
    default_lens,
    forward_observations,
    generate_camera_poses,
    random_ground_truth,
    simulate_dataset,
)
from vpcal.models.screen import PlaneSection, ScreenDefinition

INTR = CameraIntrinsics(fx=3733.33, fy=3733.33, cx=1920.0, cy=1080.0)


def _observations(seed=7):
    screen = ScreenDefinition(
        name="w", unit="mm", cabinet_size=(500, 500), led_pixel_pitch_mm=2.8,
        markers_per_cabinet=4,
        sections=[PlaneSection(name="w", width_mm=4000, height_mm=3000, origin=[0, 0, 0])],
    )
    rng = np.random.default_rng(seed)
    gt = random_ground_truth(rng)
    poses = generate_camera_poses(screen, 6, rng)
    obs, _tp, _vis = forward_observations(screen, INTR, gt, poses, markers_per_cabinet=4, rng=rng)
    return obs, gt


# ── D2: robust_loss is wired, not silently ignored ──────────────────────


@pytest.mark.parametrize("loss", ["cauchy", "none"])
def test_robust_loss_variants_solve(loss):
    from vpcal.core.solver import solve_calibration

    obs, gt = _observations()
    result = solve_calibration(obs, INTR, robust_loss=loss, prefer_cpp=False)
    assert np.allclose(result.tracker_to_stage_t, gt.tracker_to_stage_t, atol=0.5)


def test_robust_loss_invalid_raises():
    from vpcal.core.solver_scipy import solve

    obs, _gt = _observations()
    with pytest.raises(ValueError, match="robust_loss"):
        solve(obs, INTR, init_S=(np.array([1.0, 0, 0, 0]), np.zeros(3)), robust_loss="tukey")


# ── D2: timeout_seconds is enforced on the scipy backend ────────────────


def test_timeout_seconds_enforced():
    from vpcal.core.solver import solve_calibration

    obs, _gt = _observations()
    with pytest.raises(SolverTimeoutError):
        solve_calibration(obs, INTR, timeout_seconds=1e-9, prefer_cpp=False)


# ── D2: capture_mode reserved value is rejected, not ignored ────────────


def test_capture_mode_dual_frame_rejected(tmp_path):
    from vpcal.core.validator import validate_session
    from vpcal.models.session import SessionConfig

    raw = {
        "images": {"path": "./captures/"},
        "tracking": {"path": "./tracking.jsonl"},
        "screen": {"path": "./screen.json"},
        "lens": default_lens(1920, 1080).model_dump(mode="json", exclude={"fx", "fy", "cx", "cy"}),
        "capture_mode": "dual_frame",
    }
    session = SessionConfig.model_validate(raw)
    with pytest.raises(ConfigError, match="capture_mode"):
        validate_session(session, tmp_path, raw_session=raw)


# ── D5: line_number natural sort + zero-padding warning ─────────────────


def test_line_number_natural_sort_warns():
    from vpcal.io.frame_matching import match_frames

    images = ["img10.png", "img2.png", "img1.png"]
    with pytest.warns(UserWarning, match="zero-padded"):
        report = match_frames(images, [100, 200, 300], strategy="line_number")
    assert [m.image for m in report.matched] == ["img1.png", "img2.png", "img10.png"]


def test_line_number_zero_padded_no_warning(recwarn):
    from vpcal.io.frame_matching import match_frames

    images = ["img02.png", "img01.png", "img10.png"]
    report = match_frames(images, [1, 2, 3], strategy="line_number")
    assert [m.image for m in report.matched] == ["img01.png", "img02.png", "img10.png"]
    assert not [w for w in recwarn.list if "zero-padded" in str(w.message)]


# ── D5: duplicate frame_id resolves to the FIRST record on both paths ───


def test_duplicate_frame_id_takes_first():
    from vpcal.io.tracking_io import to_internal_poses
    from vpcal.models.tracking import TrackingFrame

    def frame(fid, x):
        return TrackingFrame(
            frame_id=fid, timestamp_s=0.0, position=[x, 0.0, 0.0],
            rotation={"order": "quaternion", "values": [1.0, 0.0, 0.0, 0.0]},
        )

    poses = to_internal_poses([frame(5, 111.0), frame(5, 222.0)], "vicon")
    assert poses[5][1][0] == 111.0  # first record wins (same policy as match_frames)


# ── D5: observations.jsonl next to real capture images is an error ──────


def test_exact_sidecar_with_real_images_rejected(tmp_path):
    from vpcal.core.pipeline import run_quick
    from vpcal.models.session import SessionConfig

    screen = ScreenDefinition(
        name="s", unit="mm", cabinet_size=(500, 500), led_pixel_pitch_mm=2.8,
        markers_per_cabinet=4,
        sections=[PlaneSection(name="w", width_mm=1200, height_mm=900, origin=[0, 0, 0])],
    )
    simulate_dataset(screen, tmp_path, num_poses=6, lens=default_lens(640, 480),
                     render_images=True)
    raw = json.loads((tmp_path / "session.json").read_text())
    # Strip the simulator provenance marker → the dataset now claims to be a
    # real capture, where the sidecar/images combination is ambiguous.
    raw.pop("_simulator")
    session = SessionConfig.model_validate(raw)
    with pytest.raises(PreconditionError, match="observations.jsonl"):
        run_quick(session, tmp_path, tmp_path / "out", raw_session=raw, prefer_cpp=False)


def test_simulated_dataset_with_images_still_allowed(tmp_path):
    from vpcal.core.pipeline import run_quick
    from vpcal.models.session import SessionConfig

    screen = ScreenDefinition(
        name="s", unit="mm", cabinet_size=(500, 500), led_pixel_pitch_mm=2.8,
        markers_per_cabinet=4,
        sections=[PlaneSection(name="w", width_mm=1200, height_mm=900, origin=[0, 0, 0])],
    )
    simulate_dataset(screen, tmp_path, num_poses=6, noise_px=0.0,
                     lens=default_lens(640, 480), render_images=True)
    raw = json.loads((tmp_path / "session.json").read_text())
    session = SessionConfig.model_validate(raw)
    result = run_quick(session, tmp_path, tmp_path / "out", raw_session=raw, prefer_cpp=False)
    assert result["detection_source"] == "exact"
    # D5: the QA report states the pixel semantics of the inlier threshold.
    assert result["qa"]["reprojection"]["inlier_threshold_px"] == pytest.approx(3.0)
