"""Bundle adjustment with synthetic perfect observations."""
from __future__ import annotations

import numpy as np
import pytest

from lmt_vba_sidecar.ba import bundle_adjust


def _project(point: np.ndarray, R: np.ndarray, t: np.ndarray, K: np.ndarray) -> np.ndarray:
    cam = R @ point + t
    pix = K @ cam
    return pix[:2] / pix[2]


def test_recovers_synthetic_3d_points_within_tolerance() -> None:
    np.random.seed(0)
    K = np.array([[1000, 0, 960], [0, 1000, 540], [0, 0, 1]], dtype=float)
    points_world = np.random.uniform(-1, 1, (10, 3))
    points_world[:, 2] += 5  # in front of cameras

    n_cams = 5
    cam_poses: list[tuple[np.ndarray, np.ndarray]] = []
    observations: list[tuple[int, int, np.ndarray]] = []
    for cam_i in range(n_cams):
        angle = np.deg2rad(cam_i * 8)
        R = np.array([
            [np.cos(angle), 0, np.sin(angle)],
            [0, 1, 0],
            [-np.sin(angle), 0, np.cos(angle)],
        ])
        t = np.array([cam_i * 0.3 - 0.6, 0.0, 0.0])
        cam_poses.append((R, t))
        for pt_i, pt in enumerate(points_world):
            pix = _project(pt, R, t, K)
            observations.append((cam_i, pt_i, pix))

    initial_points = points_world + np.random.normal(0, 0.05, points_world.shape)
    initial_cams = [(R + np.random.normal(0, 0.01, (3, 3)), t + np.random.normal(0, 0.05, 3))
                    for (R, t) in cam_poses]

    result = bundle_adjust(
        K=K, dist_coeffs=np.zeros(5),
        initial_points=initial_points,
        initial_cam_poses=initial_cams,
        observations=observations,
    )
    assert result.converged
    # Reprojection RMS is gauge-invariant — primary success metric.
    assert result.rms_reprojection_px < 0.1
    # Per-point covariance was returned.
    assert len(result.point_covariances) == len(points_world)
    for cov in result.point_covariances.values():
        assert cov.shape == (3, 3)
        assert np.isfinite(cov).all()
    # Absolute coordinate match would require a gauge fix (e.g. anchor
    # camera 0 to identity); BA alone is correct only up to a rigid
    # transform. Procrustes (Task 7) handles this in the reconstruct
    # pipeline. So we only loosely bound the drift here.
    assert np.linalg.norm(result.points - points_world, axis=1).max() < 0.1


def test_rejects_nonzero_dist_coeffs() -> None:
    """Caller must undistort observations upstream; non-zero dist_coeffs is
    an API misuse that would otherwise silently fit lens distortion into
    pose error."""
    K = np.eye(3)
    K[0, 0] = K[1, 1] = 1000
    K[0, 2] = 960
    K[1, 2] = 540
    with pytest.raises(ValueError, match="undistorted"):
        bundle_adjust(
            K=K, dist_coeffs=np.array([0.1, -0.2, 0.0, 0.0, 0.0]),
            initial_points=np.zeros((3, 3)),
            initial_cam_poses=[(np.eye(3), np.zeros(3))],
            observations=[],
        )


def test_compute_covariance_off_returns_empty_dict() -> None:
    """Opt-out path: large reconstructions can disable covariance to avoid
    dense pseudo-inverse blowup."""
    K = np.array([[1000, 0, 960], [0, 1000, 540], [0, 0, 1]], dtype=float)
    points_world = np.array([[0.0, 0.0, 5.0], [0.5, 0.0, 5.0], [0.0, 0.5, 5.0]])
    cam_poses = [(np.eye(3), np.array([0.0, 0.0, 0.0]))]
    obs: list[tuple[int, int, np.ndarray]] = []
    for pt_i, pt in enumerate(points_world):
        proj = K @ pt
        obs.append((0, pt_i, proj[:2] / proj[2]))
    # Need >= 2 cams for proper BA; add a second
    cam_poses.append((np.eye(3), np.array([0.1, 0.0, 0.0])))
    for pt_i, pt in enumerate(points_world):
        cam_pt = pt - np.array([0.1, 0.0, 0.0])
        proj = K @ cam_pt
        obs.append((1, pt_i, proj[:2] / proj[2]))

    result = bundle_adjust(
        K=K, dist_coeffs=np.zeros(5),
        initial_points=points_world.copy(),
        initial_cam_poses=cam_poses,
        observations=obs,
        compute_covariance=False,
    )
    assert result.point_covariances == {}


def test_covariance_succeeds_with_many_params() -> None:
    """FIX-19③: sparse LU handles large param counts that the old dense pinv cap rejected."""
    target_params = 2500
    n_cams = 4
    n_points = (target_params - 6 * n_cams) // 3
    K = np.array([[1000, 0, 960], [0, 1000, 540], [0, 0, 1]], dtype=float)
    rng = np.random.default_rng(0)
    points_world = rng.uniform(-1, 1, (n_points, 3))
    points_world[:, 2] += 5
    cam_poses = []
    obs: list[tuple[int, int, np.ndarray]] = []
    for cam_i in range(n_cams):
        cam_poses.append((np.eye(3), np.array([cam_i * 0.1, 0.0, 0.0])))
        for pt_i, pt in enumerate(points_world):
            cam_pt = pt - cam_poses[cam_i][1]
            proj = K @ cam_pt
            obs.append((cam_i, pt_i, proj[:2] / proj[2]))
    result = bundle_adjust(
        K=K, dist_coeffs=np.zeros(5),
        initial_points=points_world,
        initial_cam_poses=cam_poses,
        observations=obs,
        compute_covariance=True,
        max_iters=50,
    )
    assert len(result.point_covariances) == n_points
    for cov in result.point_covariances.values():
        assert cov.shape == (3, 3)
        assert np.isfinite(cov).all()
