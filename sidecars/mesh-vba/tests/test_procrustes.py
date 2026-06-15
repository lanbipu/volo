"""Procrustes alignment tests with synthetic point sets."""
from __future__ import annotations

import numpy as np
import pytest

from lmt_vba_sidecar.procrustes import procrustes_rigid


def test_recovers_known_transform() -> None:
    src = np.array([
        [0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 1],
    ], dtype=float)
    angle = np.deg2rad(35)
    R = np.array([
        [np.cos(angle), -np.sin(angle), 0],
        [np.sin(angle),  np.cos(angle), 0],
        [0,              0,             1],
    ])
    t = np.array([5.0, -2.0, 3.0])
    dst = (src @ R.T) + t
    R_est, t_est, rms = procrustes_rigid(src, dst)
    assert np.allclose(R_est, R, atol=1e-9)
    assert np.allclose(t_est, t, atol=1e-9)
    assert rms < 1e-9


def test_rejects_collinear_anchors() -> None:
    src = np.array([[0, 0, 0], [1, 0, 0], [2, 0, 0]], dtype=float)
    dst = src + np.array([1.0, 1.0, 1.0])
    with pytest.raises(ValueError, match="collinear|degenerate"):
        procrustes_rigid(src, dst)


def test_minimum_three_anchors() -> None:
    src = np.array([[0, 0, 0], [1, 0, 0]], dtype=float)
    dst = src
    with pytest.raises(ValueError):
        procrustes_rigid(src, dst)


def test_rejects_reflection() -> None:
    """Procrustes must produce det(R) = +1 (rotation), not a reflection."""
    src = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], dtype=float)
    # Mirror via z-flip
    dst = src.copy()
    dst[:, 2] = -dst[:, 2]
    R_est, _, _ = procrustes_rigid(src, dst)
    assert np.linalg.det(R_est) > 0.999


def test_rejects_nan_anchors() -> None:
    src = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0], [np.nan, 0, 1]], dtype=float)
    dst = np.array([[1, 0, 0], [2, 0, 0], [1, 1, 0], [1, 0, 1]], dtype=float)
    with pytest.raises(ValueError, match="non-finite"):
        procrustes_rigid(src, dst)


def test_rejects_inf_anchors() -> None:
    src = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, np.inf]], dtype=float)
    dst = np.array([[1, 0, 0], [2, 0, 0], [1, 1, 0], [1, 0, 1]], dtype=float)
    with pytest.raises(ValueError, match="non-finite"):
        procrustes_rigid(src, dst)


def test_rejects_wrong_dimension() -> None:
    src = np.array([[0, 0], [1, 0], [0, 1]], dtype=float)  # 2D points
    dst = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0]], dtype=float)
    with pytest.raises(ValueError, match=r"\(N,3\)"):
        procrustes_rigid(src, dst)


def test_aligns_noisy_anchors() -> None:
    """With noise, recovered transform should still be close to ground truth."""
    rng = np.random.default_rng(42)
    n = 20
    src = rng.uniform(-1, 1, (n, 3))
    angle = np.deg2rad(15)
    R = np.array([
        [np.cos(angle), 0, np.sin(angle)],
        [0,             1, 0],
        [-np.sin(angle),0, np.cos(angle)],
    ])
    t = np.array([2.0, 1.0, -0.5])
    dst = (src @ R.T) + t + rng.normal(0, 0.001, (n, 3))
    R_est, t_est, rms = procrustes_rigid(src, dst)
    assert np.allclose(R_est, R, atol=0.01)
    assert np.allclose(t_est, t, atol=0.01)
    assert rms < 0.01
