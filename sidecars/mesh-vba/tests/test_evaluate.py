import numpy as np
from lmt_vba_sidecar.evaluate import (
    gauge_invariant_metrics, se3_aligned_holdout_rms, umeyama_no_scale,
)


def test_umeyama_recovers_known_rigid():
    rng = np.random.default_rng(0)
    src = rng.normal(size=(20, 3)) * 100
    R, _ = np.linalg.qr(rng.normal(size=(3, 3)))
    if np.linalg.det(R) < 0:
        R[:, 0] *= -1
    t = np.array([10., -5., 3.])
    dst = (src @ R.T) + t
    R_est, t_est = umeyama_no_scale(src, dst)
    assert np.allclose(R_est, R, atol=1e-8)
    assert np.allclose(t_est, t, atol=1e-8)


def test_gauge_invariant_metrics_zero_when_perfect():
    true_centers = {0: np.zeros(3), 1: np.array([700., 0, 0])}
    true_normals = {0: np.array([0, 0, 1.]), 1: np.array([0, 0, 1.])}
    true_sizes = {0: (600., 340.), 1: (600., 340.)}
    m = gauge_invariant_metrics(true_centers, true_normals, true_sizes,
                                true_centers, true_normals, true_sizes)
    assert m["max_distance_error_mm"] < 1e-9
    assert m["max_angle_error_deg"] < 1e-9
    assert m["max_size_error_mm"] < 1e-9
    assert m["rms_size_error_mm"] < 1e-9


def test_se3_holdout_rms_zero_when_perfect():
    rng = np.random.default_rng(3)
    true_pts = rng.normal(size=(20, 3)) * 100
    R, _ = np.linalg.qr(rng.normal(size=(3, 3)))
    if np.linalg.det(R) < 0:
        R[:, 0] *= -1
    t = np.array([4., -2., 9.])
    est_pts = (true_pts - t) @ R  # est mapped so umeyama(est->true) recovers exactly
    align_idx = np.arange(10)
    score_idx = np.arange(10, 20)
    out = se3_aligned_holdout_rms(true_pts, est_pts, align_idx, score_idx)
    assert out["rms_mm"] < 1e-9
    assert out["p95_mm"] < 1e-9
    assert out["max_mm"] < 1e-9


# --------------------------------------------------------------------------- #
# FIX-9: per-corner SE(3)-holdout headline metrics
# --------------------------------------------------------------------------- #
def _row_poses(n, spacing=500.0):
    return {j: (np.eye(3), np.array([j * spacing, 0.0, 0.0])) for j in range(n)}


def _square_corners(n, half=250.0):
    c = np.array([[-half, -half, 0.0], [half, -half, 0.0],
                  [half, half, 0.0], [-half, half, 0.0]])
    return {j: c.copy() for j in range(n)}


def test_roll_about_normal_invisible_to_legacy_metrics_caught_by_holdout():
    """FIX-9 acceptance: cabinet 1 rolled 10 deg about its own normal moves its
    corners ~62mm, yet center/normal/size metrics all score 0.0 (the regression
    this pins). The per-corner SE(3)-holdout headline must be decisively
    non-zero. Cabinet 1 is ODD-ranked -> lands in the SCORE set of the
    even/odd cabinet split."""
    from lmt_vba_sidecar.eval_runner import compute_eval_metrics
    n = 4
    true_poses = _row_poses(n)
    corners = _square_corners(n)
    roll = np.deg2rad(10.0)
    Rz = np.array([[np.cos(roll), -np.sin(roll), 0.0],
                   [np.sin(roll), np.cos(roll), 0.0],
                   [0.0, 0.0, 1.0]])
    est_poses = {j: (R.copy(), t.copy()) for j, (R, t) in true_poses.items()}
    est_poses[1] = (Rz, est_poses[1][1])
    m = compute_eval_metrics(true_poses, est_poses, corners)
    # Legacy metrics are blind to the roll (the FIX-9 finding):
    assert m["max_size_error_mm"] < 1e-9
    assert m["max_distance_error_mm"] < 1e-9
    assert m["max_angle_error_deg"] < 1e-9
    # The corner displacement at 10 deg roll on a 500mm cabinet is
    # 2*sin(5 deg)*sqrt(250^2+250^2) = 61.6mm; the holdout headline sees it.
    assert m["holdout_max_mm"] > 50.0
    assert m["holdout_rms_mm"] > 20.0


def test_in_place_common_rotation_caught_by_holdout():
    """FIX-9: rotating EVERY cabinet in place by the same R (centers fixed) is a
    real non-rigid shape error — the simulate-style 'fan wall' artifact — yet
    pairwise distances and pairwise normal angles are both unchanged (legacy
    0.0). Holdout cannot absorb it with one SE(3) and must be non-zero."""
    from lmt_vba_sidecar.eval_runner import compute_eval_metrics
    n = 4
    true_poses = _row_poses(n)
    corners = _square_corners(n)
    a = np.deg2rad(15.0)
    Ry = np.array([[np.cos(a), 0.0, np.sin(a)], [0.0, 1.0, 0.0],
                   [-np.sin(a), 0.0, np.cos(a)]])
    est_poses = {j: (Ry, t.copy()) for j, (_R, t) in true_poses.items()}
    m = compute_eval_metrics(true_poses, est_poses, corners)
    assert m["max_distance_error_mm"] < 1e-9
    assert m["max_angle_error_deg"] < 1e-9
    assert m["holdout_rms_mm"] > 10.0


def test_global_rigid_motion_scores_zero_everywhere():
    """Gauge sanity: a single global SE(3) applied to ALL est poses is NOT an
    error — legacy metrics AND the holdout headline must both stay ~0."""
    from lmt_vba_sidecar.eval_runner import compute_eval_metrics
    n = 4
    true_poses = _row_poses(n)
    corners = _square_corners(n)
    a = np.deg2rad(20.0)
    Rg = np.array([[np.cos(a), 0.0, np.sin(a)], [0.0, 1.0, 0.0],
                   [-np.sin(a), 0.0, np.cos(a)]])
    tg = np.array([300.0, -150.0, 800.0])
    est_poses = {j: (Rg @ R, Rg @ t + tg) for j, (R, t) in true_poses.items()}
    m = compute_eval_metrics(true_poses, est_poses, corners)
    assert m["max_distance_error_mm"] < 1e-6
    assert m["max_angle_error_deg"] < 1e-6
    assert m["holdout_rms_mm"] < 1e-6
