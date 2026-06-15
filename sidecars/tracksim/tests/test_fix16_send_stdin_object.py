"""Fix 16 (round 3 finding 3): send stdin must be a JSON object (dict), not array/scalar."""
from __future__ import annotations

import pytest

from tracksim.cli.commands.send import build_pose
from tracksim.domain.errors import InvalidTrajectoryError


def test_build_pose_rejects_list_stdin():
    """stdin parsed as a JSON array must raise InvalidTrajectoryError."""
    with pytest.raises(InvalidTrajectoryError):
        build_pose({}, [{"pan": 1}])


def test_build_pose_rejects_string_stdin():
    """stdin parsed as a JSON string must raise InvalidTrajectoryError."""
    with pytest.raises(InvalidTrajectoryError):
        build_pose({}, "x")


def test_build_pose_rejects_int_stdin():
    """stdin parsed as a JSON number must raise InvalidTrajectoryError."""
    with pytest.raises(InvalidTrajectoryError):
        build_pose({}, 42)


def test_build_pose_rejects_bool_true_stdin():
    """stdin parsed as JSON true (bool, not dict) must raise InvalidTrajectoryError."""
    with pytest.raises(InvalidTrajectoryError):
        build_pose({}, True)


def test_build_pose_accepts_dict_stdin():
    """stdin as a proper dict must still work (regression)."""
    pose = build_pose({}, {"pan": 10.0})
    assert pose.pan == 10.0
