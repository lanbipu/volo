"""C++ Ceres vs scipy fallback equivalence (spec §1.1, §5.3)."""

from __future__ import annotations

import numpy as np
import pytest

from vpcal.core.projection import CameraIntrinsics
from vpcal.core.simulator import forward_observations, generate_camera_poses, random_ground_truth
from vpcal.core.solver import cpp_available, solve_calibration
from vpcal.models.screen import PlaneSection, ScreenDefinition

INTR = CameraIntrinsics(fx=3733.33, fy=3733.33, cx=1920.0, cy=1080.0)


def _observations(seed=7, noise_px=0.0):
    screen = ScreenDefinition(
        name="w", unit="mm", cabinet_size=(500, 500), led_pixel_pitch_mm=2.8,
        markers_per_cabinet=4,
        sections=[PlaneSection(name="w", width_mm=4000, height_mm=3000, origin=[0, 0, 0])],
    )
    rng = np.random.default_rng(seed)
    gt = random_ground_truth(rng)
    poses = generate_camera_poses(screen, 10, rng)
    obs, _tp, _vis = forward_observations(screen, INTR, gt, poses, markers_per_cabinet=4, noise_px=noise_px, rng=rng)
    return obs, gt


def test_scipy_fallback_recovers_ground_truth():
    obs, gt = _observations()
    result = solve_calibration(obs, INTR, prefer_cpp=False)
    assert result.solver_backend == "scipy"
    assert np.sqrt(np.mean(np.square(result.residuals_px))) < 0.01
    assert np.allclose(result.tracker_to_stage_t, gt.tracker_to_stage_t, atol=0.5)


def test_scipy_reports_scaled_covariance():
    obs, _gt = _observations(noise_px=0.3)
    result = solve_calibration(obs, INTR, prefer_cpp=False)
    assert result.covariance_std is not None
    assert result.covariance_std["tx_mm"] > 0


@pytest.mark.skipif(not cpp_available(), reason="C++ solver not built")
def test_cpp_and_scipy_agree():
    obs, _gt = _observations(noise_px=0.3)
    rc = solve_calibration(obs, INTR, prefer_cpp=True)
    rs = solve_calibration(obs, INTR, prefer_cpp=False)
    assert rc.solver_backend == "ceres"
    assert rs.solver_backend == "scipy"
    # Both converge to the same minimum.
    assert np.allclose(rc.tracker_to_stage_t, rs.tracker_to_stage_t, atol=1.0)
    qc, qs = np.array(rc.tracker_to_stage_q), np.array(rs.tracker_to_stage_q)
    assert min(np.linalg.norm(qc - qs), np.linalg.norm(qc + qs)) < 1e-2


@pytest.mark.skipif(not cpp_available(), reason="C++ solver not built")
def test_cpp_reports_covariance():
    obs, _gt = _observations()
    rc = solve_calibration(obs, INTR, prefer_cpp=True)
    assert rc.covariance_std is not None
    assert rc.covariance_std["tx_mm"] >= 0
