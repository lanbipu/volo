"""core/pnp.py — planar-safe RANSAC PnP (LAN-8: x86 hand-eye PnP failure)."""

from __future__ import annotations

import cv2
import numpy as np
import pytest

from vpcal.core.pnp import fit_pose, is_planar, ransac_pnp

K = np.array([[3733.33, 0, 1920.0], [0, 3733.33, 1080.0], [0, 0, 1]], dtype=np.float64)
DIST = np.zeros(5)


def _grid_y0(nx=8, nz=6):
    """Exactly coplanar LED-wall grid in the y = 0 plane (mm), like the simulator."""
    xs = np.linspace(-1125.0, 1875.0, nx)
    zs = np.linspace(375.0, 2625.0, nz)
    return np.array([[x, 0.0, z] for x in xs for z in zs], dtype=np.float64)


def _pose(rng):
    """Camera ~5 m in front of the wall (−y side), looking at it, random tilt."""
    rvec = np.array([np.pi / 2, 0.0, 0.0]) + rng.normal(scale=0.25, size=3)
    R, _ = cv2.Rodrigues(rvec)
    centre = np.array([375.0, 0.0, 1500.0])
    tvec = -R @ centre + np.array([rng.normal(scale=300), rng.normal(scale=200), 5000.0])
    return rvec.reshape(3, 1), tvec.reshape(3, 1)


def _project(obj, rvec, tvec):
    img, _ = cv2.projectPoints(obj, rvec, tvec, K, DIST)
    return img.reshape(-1, 2)


def _rot_err_deg(rv_a, rv_b):
    Ra, _ = cv2.Rodrigues(np.asarray(rv_a, dtype=np.float64))
    Rb, _ = cv2.Rodrigues(np.asarray(rv_b, dtype=np.float64))
    c = (np.trace(Ra.T @ Rb) - 1.0) / 2.0
    return float(np.degrees(np.arccos(np.clip(c, -1.0, 1.0))))


def test_is_planar():
    assert is_planar(_grid_y0())
    rng = np.random.default_rng(0)
    assert not is_planar(rng.uniform(-1000, 1000, size=(30, 3)))


@pytest.mark.parametrize("seed", range(10))
def test_ransac_pnp_exactly_coplanar_noise_free(seed):
    """The hand-eye fixture case: exactly coplanar, noise-free → every frame solves."""
    rng = np.random.default_rng(seed)
    obj = _grid_y0()
    rvec, tvec = _pose(rng)
    img = _project(obj, rvec, tvec)
    ok, rv, tv, inl = ransac_pnp(obj, img, K, DIST, reprojection_error=3.0)
    assert ok
    assert len(inl) == len(obj)
    assert inl.shape == (len(obj), 1) and inl.dtype == np.int32
    assert _rot_err_deg(rv, rvec) < 1e-4
    assert np.linalg.norm(tv - tvec) < 1e-2


@pytest.mark.parametrize("seed", range(5))
def test_ransac_pnp_planar_with_outliers(seed):
    rng = np.random.default_rng(100 + seed)
    obj = _grid_y0()
    rvec, tvec = _pose(rng)
    img = _project(obj, rvec, tvec) + rng.normal(scale=0.3, size=(len(obj), 2))
    bad = rng.choice(len(obj), size=len(obj) // 5, replace=False)
    img[bad] += rng.uniform(40.0, 200.0, size=(len(bad), 2)) * rng.choice([-1, 1], size=(len(bad), 2))
    ok, rv, tv, inl = ransac_pnp(obj, img, K, DIST, reprojection_error=3.0)
    assert ok
    assert set(inl.ravel().tolist()) == set(range(len(obj))) - set(bad.tolist())
    assert _rot_err_deg(rv, rvec) < 0.2  # 0.3 px noise at ~5 m
    assert np.linalg.norm(tv - tvec) < 10.0


def test_ransac_pnp_non_planar():
    rng = np.random.default_rng(7)
    obj = np.column_stack([
        rng.uniform(-1500, 1500, 60), rng.uniform(-800, 800, 60), rng.uniform(0, 3000, 60)
    ])
    rvec, tvec = _pose(rng)
    img = _project(obj, rvec, tvec)
    ok, rv, tv, inl = ransac_pnp(obj, img, K, DIST, reprojection_error=3.0)
    assert ok and len(inl) == len(obj)
    assert _rot_err_deg(rv, rvec) < 1e-4


def test_ransac_pnp_too_few_points():
    obj = _grid_y0()[:3]
    ok, rv, tv, inl = ransac_pnp(obj, np.zeros((3, 2)), K, DIST)
    assert not ok and rv is None and tv is None and inl is None


def test_fit_pose_planar_picks_correct_ippe_branch():
    rng = np.random.default_rng(3)
    obj = _grid_y0()
    rvec, tvec = _pose(rng)
    img = _project(obj, rvec, tvec)
    rv, tv = fit_pose(obj, img, K, DIST)
    assert _rot_err_deg(rv, rvec) < 1e-4
    assert np.linalg.norm(tv - tvec) < 1e-2
