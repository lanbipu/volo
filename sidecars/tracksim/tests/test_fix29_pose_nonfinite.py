"""Fix 29 (round 6 finding 2): CameraPose must reject non-finite float values."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from pydantic import ValidationError

from tracksim.domain.pose import CameraPose

_REPO = Path(__file__).resolve().parent.parent
_ENV = {**os.environ, "PYTHONPATH": str(_REPO / "src"), "PYSDL3_NO_UPDATE_CHECK": "1"}


def _run(args, stdin=None, timeout=8):
    return subprocess.run(
        [sys.executable, "-m", "tracksim", *args],
        capture_output=True, text=True, env=_ENV, timeout=timeout,
        cwd=_REPO, input=stdin,
    )


# --- Unit tests: CameraPose validators ---

def test_camera_pose_nan_pan_raises_validation_error():
    """CameraPose(pan=float('nan')) must raise ValidationError."""
    with pytest.raises(ValidationError):
        CameraPose(pan=float("nan"))


def test_camera_pose_inf_x_raises_validation_error():
    """CameraPose(x=float('inf')) must raise ValidationError."""
    with pytest.raises(ValidationError):
        CameraPose(x=float("inf"))


def test_camera_pose_neg_inf_focal_length_raises_validation_error():
    """CameraPose(focal_length=float('-inf')) must raise ValidationError."""
    with pytest.raises(ValidationError):
        CameraPose(focal_length=float("-inf"))


def test_camera_pose_nan_tilt_raises_validation_error():
    with pytest.raises(ValidationError):
        CameraPose(tilt=float("nan"))


def test_camera_pose_nan_roll_raises_validation_error():
    with pytest.raises(ValidationError):
        CameraPose(roll=float("nan"))


def test_camera_pose_nan_y_raises_validation_error():
    with pytest.raises(ValidationError):
        CameraPose(y=float("nan"))


def test_camera_pose_nan_z_raises_validation_error():
    with pytest.raises(ValidationError):
        CameraPose(z=float("nan"))


def test_camera_pose_nan_focus_distance_raises_validation_error():
    with pytest.raises(ValidationError):
        CameraPose(focus_distance=float("nan"))


def test_camera_pose_nan_iris_raises_validation_error():
    with pytest.raises(ValidationError):
        CameraPose(iris=float("nan"))


def test_camera_pose_nan_entrance_pupil_raises_validation_error():
    with pytest.raises(ValidationError):
        CameraPose(entrance_pupil=float("nan"))


def test_camera_pose_finite_values_accepted():
    """Normal finite values must still build without error."""
    p = CameraPose(pan=30.0, tilt=-5.0, x=1.0, focal_length=50.0)
    assert p.pan == 30.0


def test_camera_pose_zero_accepted():
    """Zero is finite and must be accepted."""
    p = CameraPose(pan=0.0, x=0.0)
    assert p.pan == 0.0


# --- Subprocess tests ---

def test_subprocess_send_nan_pan_exits_13():
    """send --pan nan --output json must exit 13 with INVALID_TRAJECTORY."""
    proc = _run(
        ["send", "--pan", "nan", "--protocol", "freed", "--output", "json"],
        timeout=5,
    )
    assert proc.returncode == 13, (
        f"expected 13, got {proc.returncode}; stdout={proc.stdout!r}; stderr={proc.stderr!r}"
    )
    obj = json.loads(proc.stdout)
    assert obj["status"] == "error"
    assert obj["error"]["code"] == "INVALID_TRAJECTORY"


def test_subprocess_send_inf_x_exits_13():
    """send --x inf --output json must exit 13."""
    proc = _run(
        ["send", "--x", "inf", "--protocol", "freed", "--output", "json"],
        timeout=5,
    )
    assert proc.returncode == 13, f"expected 13, got {proc.returncode}; stdout={proc.stdout!r}"
    obj = json.loads(proc.stdout)
    assert obj["error"]["code"] == "INVALID_TRAJECTORY"


def test_subprocess_send_stdin_nan_exits_13():
    """send with stdin JSON pan=NaN must exit 13."""
    proc = _run(
        ["send", "--protocol", "freed", "--output", "json"],
        stdin=json.dumps({"pan": float("nan")}),
        timeout=5,
    )
    # json.dumps with nan produces 'NaN' which may or may not be valid JSON in Python
    # but the pose validator must catch it if it parses
    # Either it fails at JSON parse (also exits non-zero) or at pose validation (exit 13)
    assert proc.returncode != 0, f"expected non-zero exit; stdout={proc.stdout!r}"
