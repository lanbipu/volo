"""Hand-eye chain remediation acceptance tests (A3.1 closed-form init +
A3.2 dimensionally split prior weights)."""

from __future__ import annotations

import json

import numpy as np
import pytest

from vpcal.core.errors import PreconditionError
from vpcal.core.handeye import closed_form_handeye
from vpcal.core.projection import CameraIntrinsics
from vpcal.core.simulator import (
    default_lens,
    forward_observations,
    generate_camera_poses,
    random_ground_truth,
    simulate_dataset,
)
from vpcal.core.solver import solve_calibration
from vpcal.core.transforms import quat_multiply
from vpcal.models.screen import PlaneSection, ScreenDefinition

INTR = CameraIntrinsics(fx=3733.33, fy=3733.33, cx=1920.0, cy=1080.0)


def _screen():
    return ScreenDefinition(
        name="w", unit="mm", cabinet_size=(500, 500), led_pixel_pitch_mm=2.8,
        markers_per_cabinet=4,
        sections=[PlaneSection(name="w", width_mm=4000, height_mm=3000, origin=[0, 0, 0])],
    )


def _gt_with_handeye(rng, rot_deg, trans_mm, axis=(0.3, 0.5, 0.8)):
    gt = random_ground_truth(rng)
    a = np.asarray(axis, float)
    a /= np.linalg.norm(a)
    half = np.radians(rot_deg) / 2.0
    gt.camera_from_tracker_q = [float(np.cos(half)), *(float(x) for x in np.sin(half) * a)]
    t = rng.normal(size=3)
    gt.camera_from_tracker_t = [float(x) for x in trans_mm * t / np.linalg.norm(t)]
    return gt


def _rot_diff_deg(q_est, q_gt):
    q_inv = np.array([q_gt[0], -q_gt[1], -q_gt[2], -q_gt[3]])
    d = quat_multiply(q_inv, np.asarray(q_est))
    return float(np.degrees(2.0 * np.arccos(np.clip(abs(d[0]), -1.0, 1.0))))


def test_closed_form_recovers_50mm_30deg_handeye():
    """A3.1: identity prior + true T_C_from_B at 5 cm / 30° — the closed form
    alone lands near the truth, and closed-form + BA closes to < 2 mm / 0.05°
    (this scenario diverged or converged to the wrong basin before A3)."""
    rng = np.random.default_rng(11)
    gt = _gt_with_handeye(rng, rot_deg=30.0, trans_mm=50.0)
    poses = generate_camera_poses(_screen(), 10, rng)
    obs, _tp, _vis = forward_observations(_screen(), INTR, gt, poses, markers_per_cabinet=4, rng=rng)

    he = closed_form_handeye(obs, INTR)
    assert _rot_diff_deg(he.camera_from_tracker_q, gt.camera_from_tracker_q) < 0.5
    assert np.linalg.norm(he.camera_from_tracker_t - gt.camera_from_tracker_t) < 5.0

    result = solve_calibration(
        obs, INTR,
        init_C=(he.camera_from_tracker_q, he.camera_from_tracker_t),
        refine_C=True, prefer_cpp=False,
    )
    t_err = np.linalg.norm(np.asarray(result.camera_from_tracker_t) - gt.camera_from_tracker_t)
    r_err = _rot_diff_deg(result.camera_from_tracker_q, gt.camera_from_tracker_q)
    assert t_err < 2.0, f"translation error {t_err:.3f} mm"
    assert r_err < 0.05, f"rotation error {r_err:.4f}°"
    # The registration itself must also close.
    assert np.allclose(result.tracker_to_stage_t, gt.tracker_to_stage_t, atol=2.0)


def test_split_prior_weights_recover_8mm_offset():
    """A3.2: true hand-eye 8 mm from the prior; with the split (per-dimension)
    weights refine_C recovers it to < 1 mm.  The legacy single weight froze the
    translation (σ ≈ 0.03 mm) and could not."""
    rng = np.random.default_rng(5)
    gt = _gt_with_handeye(rng, rot_deg=0.0, trans_mm=8.0)
    poses = generate_camera_poses(_screen(), 10, rng)
    obs, _tp, _vis = forward_observations(_screen(), INTR, gt, poses, markers_per_cabinet=4, rng=rng)

    ident = (np.array([1.0, 0, 0, 0]), np.zeros(3))
    fixed = solve_calibration(
        obs, INTR, init_C=ident, refine_C=True,
        prior_weight_rotation=1000.0, prior_weight_translation=1000.0,  # legacy behaviour
        prefer_cpp=False,
    )
    legacy_err = np.linalg.norm(np.asarray(fixed.camera_from_tracker_t) - gt.camera_from_tracker_t)
    assert legacy_err > 3.0, "legacy shared weight should largely freeze the translation prior"

    split = solve_calibration(obs, INTR, init_C=ident, refine_C=True, prefer_cpp=False)
    split_err = np.linalg.norm(np.asarray(split.camera_from_tracker_t) - gt.camera_from_tracker_t)
    assert split_err < 1.0, f"split-weight recovery error {split_err:.3f} mm"
    assert legacy_err > 4 * split_err


def test_handeye_degenerate_pure_translation_raises():
    """A3.1: pure-translation capture (no relative rotation) must raise a
    PreconditionError with re-shoot guidance, not return garbage."""
    rng = np.random.default_rng(3)
    gt = _gt_with_handeye(rng, rot_deg=10.0, trans_mm=30.0)
    base = generate_camera_poses(_screen(), 1, rng)[0]
    poses = []
    for i in range(6):
        T = base.copy()
        T[:3, 3] = T[:3, 3] + np.array([150.0 * i, 40.0 * i, -60.0 * i])
        poses.append(T)
    obs, _tp, _vis = forward_observations(_screen(), INTR, gt, poses, markers_per_cabinet=4, rng=rng)
    with pytest.raises(PreconditionError, match="rotat"):
        closed_form_handeye(obs, INTR)


def test_pipeline_auto_handeye_with_refine(tmp_path):
    """End-to-end: refine_C on + no user prior + perturbed ground-truth
    hand-eye → the pipeline auto-applies the closed-form init, recovers the
    perturbation and writes qa/handeye.json."""
    from vpcal.core.pipeline import run_quick
    from vpcal.models.session import SessionConfig

    simulate_dataset(
        _screen(), tmp_path, num_poses=10, noise_px=0.0, lens=default_lens(1920, 1080),
        seed=9, render_images=False, handeye_perturbation=(30.0, 50.0),
    )
    raw = json.loads((tmp_path / "session.json").read_text())
    raw["solver"]["refine_tracker_to_camera"] = True
    assert "tracker_to_camera_prior" not in raw["solver"]
    session = SessionConfig.model_validate(raw)
    result = run_quick(session, tmp_path, tmp_path / "out", raw_session=raw, prefer_cpp=False)

    he_report = json.loads((tmp_path / "out" / "qa" / "handeye.json").read_text())
    assert he_report["applied"] is True

    gt = json.loads((tmp_path / "ground_truth.json").read_text())["camera_from_tracker"]
    got = result["result"]["tracker_to_camera"]
    t_err = np.linalg.norm(np.asarray(got["translation"]) - np.asarray(gt["translation"]))
    r_err = _rot_diff_deg(got["rotation"], gt["rotation"])
    assert t_err < 2.0 and r_err < 0.05
