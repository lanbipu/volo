"""Camera projection model tests (spec §5.5)."""

from __future__ import annotations

import numpy as np

from vpcal.core.projection import CameraIntrinsics, project_point, project_points, unproject_pixel


def test_pinhole_no_distortion():
    intr = CameraIntrinsics(fx=1000, fy=1000, cx=960, cy=540)
    uv = project_point([100.0, -50.0, 200.0], intr)
    assert np.isclose(uv[0], 1000 * 100 / 200 + 960)
    assert np.isclose(uv[1], 1000 * -50 / 200 + 540)


def test_principal_point_at_optical_axis():
    intr = CameraIntrinsics(fx=800, fy=800, cx=320, cy=240)
    uv = project_point([0.0, 0.0, 5.0], intr)
    assert np.allclose(uv, [320, 240])


def test_brown_conrady_radial_formula():
    intr = CameraIntrinsics(fx=1000, fy=1000, cx=0, cy=0, k1=0.1, k2=-0.05)
    xn, yn, z = 0.2, 0.1, 1.0
    uv = project_point([xn, yn, z], intr)
    r2 = xn * xn + yn * yn
    radial = 1 + 0.1 * r2 + (-0.05) * r2 * r2
    assert np.isclose(uv[0], 1000 * xn * radial)
    assert np.isclose(uv[1], 1000 * yn * radial)


def test_tangential_terms():
    intr = CameraIntrinsics(fx=1, fy=1, cx=0, cy=0, p1=0.01, p2=0.02)
    xn, yn = 0.3, -0.2
    uv = project_point([xn, yn, 1.0], intr)
    r2 = xn * xn + yn * yn
    xd = xn + 2 * 0.01 * xn * yn + 0.02 * (r2 + 2 * xn * xn)
    yd = yn + 0.01 * (r2 + 2 * yn * yn) + 2 * 0.02 * xn * yn
    assert np.isclose(uv[0], xd)
    assert np.isclose(uv[1], yd)


def test_project_unproject_roundtrip():
    intr = CameraIntrinsics(fx=1800, fy=1800, cx=960, cy=540, k1=0.05, k2=-0.02, k3=0.001, p1=0.001, p2=-0.0008)
    rng = np.random.default_rng(0)
    for _ in range(50):
        xn, yn = rng.uniform(-0.4, 0.4, size=2)
        uv = project_point([xn, yn, 1.0], intr)
        ray = unproject_pixel(uv, intr)
        assert np.isclose(ray[0], xn, atol=1e-9)
        assert np.isclose(ray[1], yn, atol=1e-9)


def test_batched_matches_single():
    intr = CameraIntrinsics(fx=1000, fy=1100, cx=640, cy=360, k1=0.03)
    pts = np.array([[1, 2, 10], [-3, 1, 8], [0.5, -0.5, 4]], dtype=float)
    batched = project_points(pts, intr)
    for i, p in enumerate(pts):
        assert np.allclose(batched[i], project_point(p, intr))


# ── entrance pupil offset (architecture §4.3, W8) ────────────────────


def test_zero_entrance_pupil_offset_is_default_behaviour():
    intr = CameraIntrinsics(fx=1000, fy=1000, cx=960, cy=540, k1=0.05)
    assert intr.entrance_pupil_offset_mm == 0.0
    pt = [50.0, -20.0, 300.0]
    assert np.allclose(project_point(pt, intr), project_point(pt, CameraIntrinsics(fx=1000, fy=1000, cx=960, cy=540, k1=0.05, entrance_pupil_offset_mm=0.0)))


def test_entrance_pupil_offset_shifts_z_before_divide():
    # OpenLensIO eq (1): z_p = z - z_epd; X/Y unaffected, only the divisor moves.
    fx, fy, cx, cy = 1000.0, 1000.0, 960.0, 540.0
    x, y, z, offset = 30.0, -10.0, 500.0, 30.0
    intr = CameraIntrinsics(fx=fx, fy=fy, cx=cx, cy=cy, entrance_pupil_offset_mm=offset)
    uv = project_point([x, y, z], intr)
    z_eff = z - offset
    assert np.isclose(uv[0], fx * x / z_eff + cx)
    assert np.isclose(uv[1], fy * y / z_eff + cy)


def test_entrance_pupil_offset_from_lens_profile():
    from vpcal.models.lens import LensProfile

    lens = LensProfile(
        focal_length_mm=50, sensor_width_mm=36, sensor_height_mm=24,
        image_width_px=1920, image_height_px=1280, entrance_pupil_offset_mm=30.0,
    )
    intr = CameraIntrinsics.from_lens(lens)
    assert intr.entrance_pupil_offset_mm == 30.0


def test_entrance_pupil_offset_none_defaults_to_zero():
    from vpcal.models.lens import LensProfile

    lens = LensProfile(
        focal_length_mm=50, sensor_width_mm=36, sensor_height_mm=24,
        image_width_px=1920, image_height_px=1280,
    )
    assert lens.entrance_pupil_offset_mm is None
    intr = CameraIntrinsics.from_lens(lens)
    assert intr.entrance_pupil_offset_mm == 0.0
