import numpy as np
import pytest
from lmt_vba_sidecar.sl_feasibility import (
    project_point, triangulate_multiview, look_at_pose, solve_pnp_pose,
)


def _K(f=3000.0, cx=1920.0, cy=1080.0):
    return np.array([[f, 0, cx], [0, f, cy], [0, 0, 1]], float)


def test_project_then_triangulate_is_exact_without_noise():
    K = _K()
    X = np.array([100.0, -50.0, 0.0])
    poses = [look_at_pose(np.array([-1500.0, 0.0, -4000.0])),
             look_at_pose(np.array([1500.0, 0.0, -4000.0]))]
    pts = [project_point(K, R, t, X) for (R, t) in poses]
    Xhat = triangulate_multiview(K, poses, pts)
    assert np.linalg.norm(Xhat - X) < 1e-6


def test_triangulate_requires_two_views():
    K = _K()
    with pytest.raises(ValueError):
        triangulate_multiview(K, [look_at_pose(np.array([0.0, 0.0, -4000.0]))],
                              [np.array([1920.0, 1080.0])])


def test_solve_pnp_recovers_true_pose_without_noise():
    K = _K()
    R_true, t_true = look_at_pose(np.array([800.0, 0.0, -4000.0]))
    # a non-trivial (slightly curved) object so PnP is well-posed
    obj = np.array([[x, y, 5.0 * np.cos(x / 500.0)]
                    for y in (-600, 0, 600) for x in (-900, -300, 300, 900)], float)
    img = np.array([project_point(K, R_true, t_true, X) for X in obj])
    R_est, t_est = solve_pnp_pose(K, obj, img)
    assert np.linalg.norm(R_est - R_true) < 1e-3
    assert np.linalg.norm(t_est - t_true) < 1e-2


from lmt_vba_sidecar.sl_feasibility import (
    build_screen, camera_ring, feasibility_rms_mm,
)


def test_zero_perturbation_is_near_exact():
    K = _K()
    pts = build_screen(2000.0, 1200.0, 6, 5, curve_mm=20.0)  # mild curvature -> well-posed PnP
    poses = camera_ring(4000.0, 4, 45.0)
    s = feasibility_rms_mm(K=K, screen_points_mm=pts, camera_poses=poses,
                           pixel_sigma=0.0, nominal_deviation_mm=0.0,
                           focal_err_frac=0.0, trials=3, seed=0)
    assert s["rms_mm"] < 1e-2


def test_estimated_pose_is_worse_than_oracle():
    """The PnP gate must capture pose/deviation error the oracle ignores: with a
    real nominal deviation, estimated-pose RMS must exceed oracle (true-pose) RMS.
    (With zero deviation the two sit in the noise floor and are not comparable.)"""
    K = _K()
    pts = build_screen(2000.0, 1200.0, 6, 5, curve_mm=20.0)
    poses = camera_ring(4000.0, 4, 45.0)
    est = feasibility_rms_mm(K=K, screen_points_mm=pts, camera_poses=poses,
                             pixel_sigma=0.1, nominal_deviation_mm=3.0,
                             trials=20, seed=2)
    rng = np.random.default_rng(2)
    errs = []
    for _ in range(20):
        for X in pts:
            obs = [project_point(K, R, t, X) + rng.normal(0, 0.1, 2) for (R, t) in poses]
            errs.append(np.linalg.norm(triangulate_multiview(K, poses, obs) - X))
    oracle_rms = float(np.sqrt(np.mean(np.square(errs))))
    assert est["rms_mm"] >= oracle_rms


def test_focal_error_increases_rms():
    K = _K()
    pts = build_screen(2000.0, 1200.0, 6, 5, curve_mm=20.0)
    poses = camera_ring(4000.0, 5, 50.0)
    base = feasibility_rms_mm(K=K, screen_points_mm=pts, camera_poses=poses,
                              pixel_sigma=0.1, focal_err_frac=0.0, trials=20, seed=3)
    perturbed = feasibility_rms_mm(K=K, screen_points_mm=pts, camera_poses=poses,
                                   pixel_sigma=0.1, focal_err_frac=0.02, trials=20, seed=3)
    assert perturbed["rms_mm"] > base["rms_mm"]
