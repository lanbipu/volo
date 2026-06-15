"""Transform-chain identity + solver recovery tests (spec §5.1.4, §8.4)."""

from __future__ import annotations

import numpy as np
import pytest

from vpcal.core.coordinates import m_rh_from_source
from vpcal.core.projection import CameraIntrinsics, project_point
from vpcal.core.simulator import (
    GroundTruth,
    forward_observations,
    generate_camera_poses,
    random_ground_truth,
)
from vpcal.core.solver import solve_calibration
from vpcal.core.solver_scipy import solve as solve_scipy
from vpcal.core.transforms import (
    invert_transform,
    make_transform,
    matrix_to_quat,
    world_to_camera,
)
from vpcal.models.lens import LensProfile
from vpcal.models.screen import PlaneSection, ScreenDefinition

INTR = CameraIntrinsics(fx=3733.33, fy=3733.33, cx=1920.0, cy=1080.0)
_M = m_rh_from_source("unreal")[:3, :3]
_I = np.eye(4)


def test_spec_example_1():
    p_rh = _M @ np.array([1000.0, 500.0, 2000.0])
    pc = world_to_camera(p_rh, _I, _I, _I)
    assert np.allclose(pc, [1000, -500, 2000])
    uv = project_point(pc, INTR)
    assert np.isclose(uv[0], INTR.fx * 1000 / 2000 + INTR.cx)
    assert np.isclose(uv[1], INTR.fy * -500 / 2000 + INTR.cy)


def test_spec_example_2():
    T_S_from_O = make_transform([1, 0, 0, 0], [100, 0, 0])
    p_rh = _M @ np.array([1000.0, 0.0, 2000.0])
    pc = world_to_camera(p_rh, T_S_from_O, _I, _I)
    assert np.allclose(pc, [900, 0, 2000])
    uv = project_point(pc, INTR)
    assert np.isclose(uv[0], INTR.fx * 900 / 2000 + INTR.cx)


def test_identity_chain():
    p_rh = np.array([123.0, -45.0, 678.0])
    assert np.allclose(world_to_camera(p_rh, _I, _I, _I), p_rh)


def test_chain_with_nontrivial_tracker():
    # With a non-identity tracker pose, the chain must invert T_sdk correctly.
    T_S_from_O = make_transform([1, 0, 0, 0], [0, 0, 0])
    T_sdk = make_transform([0.9659258, 0, 0, 0.258819], [10, 20, 30])  # 30° about Z
    p_rh = np.array([100.0, 0.0, 500.0])
    pc = world_to_camera(p_rh, T_S_from_O, T_sdk, _I)
    expected = invert_transform(T_sdk) @ np.array([100.0, 0.0, 500.0, 1.0])
    assert np.allclose(pc, expected[:3])


def _plane_screen():
    return ScreenDefinition(
        name="wall", unit="mm", cabinet_size=(500, 500), led_pixel_pitch_mm=2.8,
        markers_per_cabinet=4,
        sections=[PlaneSection(name="w", width_mm=6000, height_mm=4000, origin=[0, 0, 0])],
    )


def _solve_and_check(gt: GroundTruth, screen, num_poses=10, noise_px=0.0, mpc=4, seed=0):
    rng = np.random.default_rng(seed)
    poses = generate_camera_poses(screen, num_poses, rng)
    obs, _tp, _vis = forward_observations(
        screen, INTR, gt, poses, markers_per_cabinet=mpc, noise_px=noise_px, rng=rng
    )
    assert len(obs) > 50
    result = solve_calibration(obs, INTR, robust_scale=1.0, prefer_cpp=False)
    return result, obs


def test_solver_recovers_identity_ground_truth():
    gt = random_ground_truth(np.random.default_rng(0), identity=True)
    result, obs = _solve_and_check(gt, _plane_screen())
    assert np.max(result.residuals_px) < 0.01
    assert np.allclose(result.tracker_to_stage_t, [0, 0, 0], atol=1e-2)


def test_solver_recovers_random_ground_truth_zero_noise():
    gt = random_ground_truth(np.random.default_rng(7))
    result, obs = _solve_and_check(gt, _plane_screen(), seed=3)
    # Reprojection essentially perfect.
    assert np.sqrt(np.mean(np.square(result.residuals_px))) < 0.01
    # Translation recovered to < 0.001 mm-ish; compare transforms.
    gt_t = np.array(gt.tracker_to_stage_t)
    assert np.allclose(result.tracker_to_stage_t, gt_t, atol=0.5)
    # Rotation recovered (compare quaternions up to sign).
    q_gt = np.array(gt.tracker_to_stage_q)
    q_est = np.array(result.tracker_to_stage_q)
    assert min(np.linalg.norm(q_gt - q_est), np.linalg.norm(q_gt + q_est)) < 1e-2


def test_solver_robust_to_outliers():
    gt = random_ground_truth(np.random.default_rng(2))
    rng = np.random.default_rng(11)
    screen = _plane_screen()
    poses = generate_camera_poses(screen, 12, rng)
    obs, _tp, _vis = forward_observations(
        screen, INTR, gt, poses, markers_per_cabinet=4, noise_px=0.0, outlier_ratio=0.05, rng=rng
    )
    result = solve_calibration(obs, INTR, robust_scale=1.0, prefer_cpp=False)
    inlier_res = [r for r in result.residuals_px if r < 3.0]
    assert np.sqrt(np.mean(np.square(inlier_res))) < 0.05
    assert result.num_outliers > 0


def test_solver_rejects_too_few_poses():
    from vpcal.core.errors import PreconditionError

    gt = random_ground_truth(np.random.default_rng(0), identity=True)
    screen = _plane_screen()
    rng = np.random.default_rng(0)
    poses = generate_camera_poses(screen, 2, rng)
    obs, _tp, _vis = forward_observations(screen, INTR, gt, poses, markers_per_cabinet=4, rng=rng)
    with pytest.raises(PreconditionError):
        solve_calibration(obs, INTR, prefer_cpp=False)
