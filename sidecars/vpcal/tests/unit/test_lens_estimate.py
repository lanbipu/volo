"""Quick Lens Estimate unit tests (QLE spec §10.1).

Solver-level recovery (bypassing the gate), gate logic, and config validation.
"""

from __future__ import annotations

import dataclasses

import numpy as np
import pytest

from vpcal.core.projection import CameraIntrinsics
from vpcal.core.simulator import (
    default_lens,
    forward_observations,
    generate_camera_poses,
    random_ground_truth,
)
from vpcal.core.solver import solve_calibration
from vpcal.core.solver_scipy import LensFreedom
from vpcal.models.screen import PlaneSection, ScreenDefinition
from vpcal.models.session import LensEstimateConfig
from vpcal.qa.observability import determine_lens_freedom, validate_lens_estimate


def _screen() -> ScreenDefinition:
    return ScreenDefinition(
        name="t", unit="mm", cabinet_size=[500, 500], led_pixel_pitch_mm=2.8,
        markers_per_cabinet=4,
        sections=[PlaneSection(name="w", width_mm=5000, height_mm=3000, origin=[0, 0, 0])],
    )


def _make_obs(gt_intr: CameraIntrinsics, *, num_poses=14, seed=7, noise_px=0.0):
    screen = _screen()
    rng = np.random.default_rng(seed)
    gt = random_ground_truth(rng)
    poses = generate_camera_poses(screen, num_poses, rng)
    obs, _tp, _v = forward_observations(
        screen, default_intr(), gt, poses, markers_per_cabinet=4,
        noise_px=noise_px, rng=rng, ground_truth_intr=gt_intr,
    )
    return obs


def default_intr() -> CameraIntrinsics:
    return CameraIntrinsics.from_lens(default_lens(1920, 1080))


# ── Solver-level recovery (gate bypassed) ────────────────────────────


def test_lens_recovery_k1():
    nominal = default_intr()
    gt = dataclasses.replace(nominal, k1=-0.07)
    obs = _make_obs(gt)
    r = solve_calibration(obs, nominal, lens_free=LensFreedom(free_k1=True), prefer_cpp=False)
    assert abs(r.lens_values["k1"] - (-0.07)) < 0.005
    assert r.final_cost < 0.05


def test_lens_recovery_cx_cy():
    nominal = default_intr()
    gt = dataclasses.replace(nominal, cx=nominal.cx + 25.0, cy=nominal.cy - 15.0)
    obs = _make_obs(gt)
    r = solve_calibration(
        obs, nominal,
        lens_free=LensFreedom(free_cx=True, free_cy=True, pp_margin_x_px=200, pp_margin_y_px=200),
        prefer_cpp=False,
    )
    assert abs(r.lens_values["cx"] - (nominal.cx + 25.0)) < 5.0
    assert abs(r.lens_values["cy"] - (nominal.cy - 15.0)) < 5.0


def test_lens_recovery_all_distortion_and_center():
    nominal = default_intr()
    gt = dataclasses.replace(nominal, k1=-0.06, k2=0.01, cx=nominal.cx + 12.0, cy=nominal.cy - 8.0)
    obs = _make_obs(gt)
    r = solve_calibration(
        obs, nominal,
        lens_free=LensFreedom(free_cx=True, free_cy=True, free_k1=True, free_k2=True,
                              pp_margin_x_px=200, pp_margin_y_px=200),
        prefer_cpp=False,
    )
    assert abs(r.lens_values["k1"] - (-0.06)) < 0.005
    assert abs(r.lens_values["cx"] - (nominal.cx + 12.0)) < 5.0
    assert r.final_cost < 0.1


def test_lens_recovery_focal_scale():
    nominal = default_intr()
    gt = dataclasses.replace(nominal, fx=nominal.fx * 1.04, fy=nominal.fy * 1.04)  # +4% focal
    obs = _make_obs(gt)
    r = solve_calibration(
        obs, nominal,
        lens_free=LensFreedom(free_focal=True, focal_scale_bound=0.10, focal_prior_weight=1e-6),
        prefer_cpp=False,
    )
    assert abs(r.lens_values["focal_scale"] - 1.04) < 0.01


# ── Backward compatibility ───────────────────────────────────────────


def test_phase1_bit_identical_disabled():
    """lens_free=None vs LensFreedom() (all fixed) must give identical results."""
    nominal = default_intr()
    obs = _make_obs(nominal)
    init_C = (np.array([1.0, 0, 0, 0]), np.zeros(3))
    r0 = solve_calibration(obs, nominal, init_C=init_C, prefer_cpp=False)
    r1 = solve_calibration(obs, nominal, init_C=init_C, lens_free=LensFreedom(), prefer_cpp=False)
    assert np.allclose(r0.tracker_to_stage_t, r1.tracker_to_stage_t, atol=1e-9)
    assert np.allclose(r0.tracker_to_stage_q, r1.tracker_to_stage_q, atol=1e-9)
    assert abs(r0.final_cost - r1.final_cost) < 1e-9
    assert r1.lens_values is None


# ── Config validation ────────────────────────────────────────────────


def test_config_rejects_k2_without_k1():
    with pytest.raises(Exception):
        LensEstimateConfig(enabled=True, params={"k2"})


def test_config_default_params():
    cfg = LensEstimateConfig()
    assert cfg.params == {"k1", "k2", "cx", "cy"}
    assert cfg.enabled is False
    assert cfg.refine_focal is False


# ── Pre-solve gates ──────────────────────────────────────────────────


def _regions(all_on=True):
    v = bool(all_on)
    return {"center": v, "top_left": v, "top_right": v, "bottom_left": v, "bottom_right": v}


def test_gate_cx_cy_forced_off_when_refine_C():
    cfg = LensEstimateConfig(enabled=True, params={"cx", "cy", "k1"})
    lens = default_lens(1920, 1080)
    obs = _make_obs(default_intr())
    lf, pre = determine_lens_freedom(
        cfg, lens, obs, default_intr(), refine_C=True,
        baseline_rms_px=1.0, condition_number=10.0, angular_spread_deg=45.0,
        sensor_regions=_regions(True),
    )
    assert not lf.free_cx and not lf.free_cy
    assert any("cx/cy locked" in f for f in pre["flags"])


def test_gate_condition_number_locks_all():
    cfg = LensEstimateConfig(enabled=True)
    lens = default_lens(1920, 1080)
    obs = _make_obs(default_intr())
    lf, pre = determine_lens_freedom(
        cfg, lens, obs, default_intr(), refine_C=False,
        baseline_rms_px=1.0, condition_number=1e6, angular_spread_deg=45.0,
        sensor_regions=_regions(True),
    )
    assert not lf.any_free
    assert any("ill-conditioned" in f for f in pre["flags"])


def test_gate_k1_locked_on_poor_edge_coverage():
    """Center-clustered observations → edge fraction below threshold → k1 locked."""
    cfg = LensEstimateConfig(enabled=True, params={"k1", "k2"}, min_edge_obs_fraction=0.25)
    lens = default_lens(1920, 1080)
    intr = default_intr()
    # Build synthetic obs all near the image centre.
    from vpcal.core.observations import MarkerId, Observation
    obs = [
        Observation(
            pixel_u=intr.cx + d, pixel_v=intr.cy + d, world_rh=(0.0, 0.0, 1.0),
            track_q=(1.0, 0, 0, 0), track_t=(0.0, 0.0, 0.0), frame_id=f,
            marker_id=MarkerId(0, 0, 0, 0),
        )
        for f in range(8) for d in (-3, 0, 3)
    ]
    lf, pre = determine_lens_freedom(
        cfg, lens, obs, intr, refine_C=False,
        baseline_rms_px=0.5, condition_number=10.0, angular_spread_deg=45.0,
        sensor_regions=_regions(True),
    )
    assert not lf.free_k1 and not lf.free_k2
    assert any("edge_coverage" in f for f in pre["flags"])


# ── Post-solve gates ─────────────────────────────────────────────────


def _fake_result(lens_values, lens_corr, *, corr_available=True, backend="scipy", lens_std=None):
    from vpcal.core.solver_scipy import SolverResult
    return SolverResult(
        tracker_to_stage_q=(1, 0, 0, 0), tracker_to_stage_t=(0, 0, 0),
        camera_from_tracker_q=(1, 0, 0, 0), camera_from_tracker_t=(0, 0, 0),
        initial_cost=1.0, final_cost=0.01, num_iterations=10, num_inliers=100, num_outliers=0,
        termination_type="CONVERGENCE", termination_message="", solver_backend=backend,
        lens_values=lens_values, lens_std=lens_std or {k: 0.001 for k in lens_values},
        lens_corr=lens_corr, lens_corr_available=corr_available,
    )


def test_post_solve_high_correlation_reverts():
    cfg = LensEstimateConfig(enabled=True, params={"cx", "cy"})
    lf = LensFreedom(free_cx=True, free_cy=True)
    sr = _fake_result({"cx": 960.0, "cy": 540.0}, {"cx": 0.97, "cy": 0.99})
    post, surviving = validate_lens_estimate(
        lf, sr, cfg, baseline_rms_px=10.0, refined_rms_px=1.0, cross_subset_deltas=None
    )
    assert post["params_reverted"] == ["cx", "cy"]
    assert not surviving.any_free


def test_post_solve_corr_unavailable_fails_closed():
    cfg = LensEstimateConfig(enabled=True, params={"k1"})
    lf = LensFreedom(free_k1=True)
    sr = _fake_result({"k1": -0.05}, {}, corr_available=False)
    post, surviving = validate_lens_estimate(
        lf, sr, cfg, baseline_rms_px=10.0, refined_rms_px=1.0, cross_subset_deltas=None
    )
    assert "k1" in post["params_reverted"]
    assert not surviving.free_k1


def test_post_solve_cross_subset_reverts_k1():
    cfg = LensEstimateConfig(enabled=True, params={"k1"}, cross_subset_k_abs_delta=0.05)
    lf = LensFreedom(free_k1=True)
    sr = _fake_result({"k1": -0.05}, {"k1": 0.3})
    post, surviving = validate_lens_estimate(
        lf, sr, cfg, baseline_rms_px=10.0, refined_rms_px=1.0,
        cross_subset_deltas={"k1": 0.2},  # large inter-subset drift
    )
    assert "k1" in post["params_reverted"]


def test_post_solve_low_improvement_reverts():
    cfg = LensEstimateConfig(enabled=True, params={"k1"}, min_improvement_pct=3.0)
    lf = LensFreedom(free_k1=True)
    sr = _fake_result({"k1": -0.05}, {"k1": 0.3})
    post, _surv = validate_lens_estimate(
        lf, sr, cfg, baseline_rms_px=1.0, refined_rms_px=0.99, cross_subset_deltas=None
    )  # ~1% improvement < 3%
    assert "k1" in post["params_reverted"]


def test_post_solve_keeps_observable_k1():
    cfg = LensEstimateConfig(enabled=True, params={"k1"})
    lf = LensFreedom(free_k1=True)
    sr = _fake_result({"k1": -0.05}, {"k1": 0.4})
    post, surviving = validate_lens_estimate(
        lf, sr, cfg, baseline_rms_px=10.0, refined_rms_px=0.1,
        cross_subset_deltas={"k1": 0.001},
    )
    assert post["params_kept"] == ["k1"]
    assert surviving.free_k1
    assert post["confidence"] == "medium"  # scipy backend caps at medium
