"""Coordinate-system conversion tests (spec §10.2)."""

from __future__ import annotations

import numpy as np
import pytest

from vpcal.core.coordinates import convert_pose, m_rh_from_source
from vpcal.core.transforms import quat_to_matrix


@pytest.mark.parametrize(
    "source,expected_det",
    [("unreal", -1.0), ("optitrack", 1.0), ("vicon", 1.0), ("freeDEuler", 1.0)],
)
def test_matrix_determinants(source, expected_det):
    M3 = m_rh_from_source(source)[:3, :3]
    assert np.isclose(np.linalg.det(M3), expected_det)


def test_unreal_flips_y():
    # UE position (1000, 500, 2000) → right-hand (1000, -500, 2000).
    q, t = convert_pose("unreal", "quaternion", [1, 0, 0, 0], [1000, 500, 2000])
    assert np.allclose(t, [1000, -500, 2000])


def test_vicon_identity():
    q, t = convert_pose("vicon", "quaternion", [1, 0, 0, 0], [1, 2, 3])
    assert np.allclose(t, [1, 2, 3])
    assert np.allclose(q, [1, 0, 0, 0])


def test_optitrack_axis_mapping():
    # OptiTrack X-right,Y-up,Z-back → internal X-fwd,Y-left,Z-up.
    # point on OptiTrack +Y (up) → internal +Z (up).
    _q, t = convert_pose("optitrack", "quaternion", [1, 0, 0, 0], [0, 10, 0])
    assert np.allclose(t, [0, 0, 10])
    # OptiTrack -Z (forward) → internal +X (forward).
    _q, t = convert_pose("optitrack", "quaternion", [1, 0, 0, 0], [0, 0, -7])
    assert np.allclose(t, [7, 0, 0])


@pytest.mark.parametrize("source", ["unreal", "optitrack", "vicon", "freeDEuler"])
def test_converted_rotation_is_proper(source):
    # A non-identity 45° rotation must remain a proper rotation (det +1).
    c = np.cos(np.pi / 8)
    s = np.sin(np.pi / 8)
    q, _t = convert_pose(source, "quaternion", [c, 0, 0, s], [100, 0, 50])
    R = quat_to_matrix(q)
    assert np.isclose(np.linalg.det(R), 1.0)
    assert np.allclose(R @ R.T, np.eye(3), atol=1e-9)


def test_custom_transform():
    M = [[1, 0, 0, 0], [0, 0, -1, 0], [0, 1, 0, 0], [0, 0, 0, 1]]
    _q, t = convert_pose("custom", "quaternion", [1, 0, 0, 0], [1, 2, 3], custom_transform=M)
    assert np.allclose(t, [1, -3, 2])


def test_custom_requires_transform():
    from vpcal.core.errors import ConfigError

    with pytest.raises(ConfigError):
        convert_pose("custom", "quaternion", [1, 0, 0, 0], [0, 0, 0])


def test_euler_ptr_and_quaternion_xyzw_orders():
    # quaternion_xyzw identity (0,0,0,1) == wxyz identity.
    q, _t = convert_pose("vicon", "quaternion_xyzw", [0, 0, 0, 1], [0, 0, 0])
    assert np.allclose(q, [1, 0, 0, 0])
    # euler all-zero → identity.
    q, _t = convert_pose("vicon", "euler_ptr", [0, 0, 0], [0, 0, 0])
    assert np.allclose(q, [1, 0, 0, 0])
