"""Bit-level dual-backend residual consistency (remediation D1).

At a FIXED parameter vector, the raw (un-robustified) per-observation
reprojection residual must agree between the C++ Ceres core and the Python
reference chain to 1e-9.  The backends legitimately differ in robust-loss
aggregation, prior parametrisation and prior robustification — those are NOT
asserted here (see the solver_scipy module docstring).
"""

from __future__ import annotations

import numpy as np
import pytest

from vpcal.core.projection import CameraIntrinsics
from vpcal.core.simulator import forward_observations, generate_camera_poses, random_ground_truth
from vpcal.core.solver import cpp_available
from vpcal.core.solver_scipy import _build_observation_arrays, _reproject
from vpcal.core.transforms import make_transform, normalize_quat
from vpcal.models.screen import PlaneSection, ScreenDefinition

INTR = CameraIntrinsics(
    fx=3733.33, fy=3733.33, cx=1920.0, cy=1080.0,
    k1=-0.06, k2=0.012, k3=-0.001, p1=0.0004, p2=-0.0002,
)


def _observations(seed=7):
    screen = ScreenDefinition(
        name="w", unit="mm", cabinet_size=(500, 500), led_pixel_pitch_mm=2.8,
        markers_per_cabinet=4,
        sections=[PlaneSection(name="w", width_mm=4000, height_mm=3000, origin=[0, 0, 0])],
    )
    rng = np.random.default_rng(seed)
    gt = random_ground_truth(rng)
    poses = generate_camera_poses(screen, 6, rng)
    obs, _tp, _vis = forward_observations(
        screen, INTR, gt, poses, markers_per_cabinet=4, noise_px=0.5, rng=rng
    )
    return obs


def _python_residuals(observations, T_S, T_C, intr):
    world_h, pixels, inv_sdk = _build_observation_arrays(observations)
    pred = _reproject(world_h, inv_sdk, T_S, T_C, intr)
    return (pred - pixels).ravel()


@pytest.mark.skipif(not cpp_available(), reason="C++ solver not built")
def test_cpp_python_residuals_bit_level():
    import vpcal._vpcal_solver as cpp

    observations = _observations()
    rng = np.random.default_rng(42)
    # Deliberately non-identity, non-converged parameter vector.
    q_S = normalize_quat(np.array([0.9, 0.1, -0.2, 0.15]))
    t_S = np.array([512.3, -210.7, 88.1])
    q_C = normalize_quat(np.array([0.99, -0.02, 0.05, 0.01]))
    t_C = np.array([12.5, -3.2, 7.9])

    T_S = make_transform(q_S, t_S)
    T_C = make_transform(q_C, t_C)
    py_res = _python_residuals(observations, T_S, T_C, INTR)

    cpp_obs = [
        cpp.Observation(
            o.pixel_u, o.pixel_v,
            o.world_rh[0], o.world_rh[1], o.world_rh[2],
            o.track_q[0], o.track_q[1], o.track_q[2], o.track_q[3],
            o.track_t[0], o.track_t[1], o.track_t[2],
        )
        for o in observations
    ]
    lens = cpp.LensParams(INTR.fx, INTR.fy, INTR.cx, INTR.cy,
                          INTR.k1, INTR.k2, INTR.k3, INTR.p1, INTR.p2)
    cpp_res = np.asarray(
        cpp.evaluate_residuals(cpp_obs, lens, [*q_S, *t_S], [*q_C, *t_C])
    )

    assert cpp_res.shape == py_res.shape
    np.testing.assert_allclose(cpp_res, py_res, atol=1e-9, rtol=0)
