"""Simulator poses must not depend on the SVD sign convention of the host's
LAPACK kernel (AVX-512 vs. AVX2 OpenBLAS paths flip singular vectors), so a
fixed seed reproduces the same dataset on every machine."""

from __future__ import annotations

import itertools

import numpy as np
import pytest

from vpcal.core import simulator
from vpcal.core.simulator import (
    _screen_markers_and_facing,
    _standoff_frame,
    generate_camera_poses,
    generate_poses_for_points,
    generate_trajectory_poses,
)
from vpcal.models.screen import ArcSection, PlaneSection, ScreenDefinition

_REAL_SVD = np.linalg.svd


def _flat_screen():
    return ScreenDefinition(
        name="w", unit="mm", cabinet_size=(500, 500), led_pixel_pitch_mm=2.8,
        markers_per_cabinet=4,
        sections=[PlaneSection(name="w", width_mm=4000, height_mm=3000, origin=[0, 0, 0])],
    )


def _curved_screen():
    return ScreenDefinition(
        name="c", unit="mm", cabinet_size=(500, 500), led_pixel_pitch_mm=2.8,
        markers_per_cabinet=4,
        sections=[ArcSection(name="c", arc_radius_mm=6000, arc_angle_deg=60, height_mm=3000)],
    )


def _flipped_svd(signs):
    """An SVD whose singular vectors carry the given (still valid) sign flips."""

    def svd(a, *args, **kwargs):
        u, s, vt = _REAL_SVD(a, *args, **kwargs)
        d = np.asarray(signs, float)
        u = u.copy()
        u[:, :3] *= d
        return u, s, vt * d[:, None]

    return svd


_SIGN_SETS = [s for s in itertools.product((1.0, -1.0), repeat=3) if s != (1.0, 1.0, 1.0)]


def _poses(fn, *args, seed=17, **kwargs):
    return np.array(fn(*args, rng=np.random.default_rng(seed), **kwargs))


@pytest.mark.parametrize("screen_fn", [_flat_screen, _curved_screen])
@pytest.mark.parametrize("gen", [generate_camera_poses, generate_trajectory_poses])
@pytest.mark.parametrize("signs", _SIGN_SETS)
def test_screen_poses_invariant_to_svd_signs(monkeypatch, screen_fn, gen, signs):
    screen = screen_fn()
    ref = _poses(gen, screen, 8)
    monkeypatch.setattr(np.linalg, "svd", _flipped_svd(signs))
    got = _poses(gen, screen, 8)
    assert np.max(np.abs(got - ref)) < 1e-9


@pytest.mark.parametrize("trajectory", [False, True])
@pytest.mark.parametrize("preferred", [None, (0.0, -1.0, 0.0)])
@pytest.mark.parametrize("signs", _SIGN_SETS)
def test_point_cloud_poses_invariant_to_svd_signs(monkeypatch, trajectory, preferred, signs):
    rng = np.random.default_rng(3)
    pts = rng.uniform([-2000, -50, 0], [2000, 50, 2500], size=(40, 3))
    pn = None if preferred is None else np.asarray(preferred)
    ref = _poses(generate_poses_for_points, pts, 6, trajectory=trajectory, preferred_normal=pn)
    monkeypatch.setattr(np.linalg, "svd", _flipped_svd(signs))
    got = _poses(generate_poses_for_points, pts, 6, trajectory=trajectory, preferred_normal=pn)
    assert np.max(np.abs(got - ref)) < 1e-9


def _rotated_flat_screen():
    return ScreenDefinition(
        name="r", unit="mm", cabinet_size=(500, 500), led_pixel_pitch_mm=2.8,
        markers_per_cabinet=4,
        sections=[PlaneSection(name="r", width_mm=4000, height_mm=3000,
                               rotation=[0.9238795, 0.0, 0.0, 0.3826834])],
    )


@pytest.mark.parametrize("screen_fn", [_flat_screen, _rotated_flat_screen, _curved_screen])
def test_standoff_frame_is_right_handed_and_faces_viewer(screen_fn):
    """``u × v = n``, and the camera stands on the side the pattern faces (it
    reads unmirrored from there) — not on whichever side the SVD sign picked."""
    markers, facing = _screen_markers_and_facing(screen_fn())
    _c, _e, _r, u, v, n = _standoff_frame(markers, facing)
    np.testing.assert_allclose(np.cross(u, v), n, atol=1e-12)
    assert u[np.argmax(np.abs(u))] > 0
    assert float(facing @ n) > 0


def test_arc_standoff_is_on_concave_side():
    """An arc wall (centre angle 180°, centred on the stage origin) is viewed
    from inside: the camera standoff points from the wall toward the origin."""
    markers, facing = _screen_markers_and_facing(_curved_screen())
    c, _e, _r, _u, _v, n = _standoff_frame(markers, facing)
    assert float(n @ (-c)) > 0
    for T in generate_camera_poses(_curved_screen(), 6, np.random.default_rng(0)):
        assert float((T[:3, 3] - c) @ n) > 0


def test_canonical_sign_tie_resolves_to_first_axis():
    a = np.array([-1.0, 1.0, 0.0]) / np.sqrt(2.0)
    b = a + np.array([0.0, 1e-15, 0.0])  # float-noise-level tie break
    np.testing.assert_allclose(simulator._canonical_sign(a), simulator._canonical_sign(b), atol=1e-14)
    assert simulator._canonical_sign(a)[0] > 0
