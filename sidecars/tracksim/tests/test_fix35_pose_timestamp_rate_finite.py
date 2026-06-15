"""Fix 35 (round 7 finding 1): CameraPose must reject non-finite timestamp and rate."""
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
        cwd=str(_REPO), input=stdin,
    )


# --- Unit tests: CameraPose.timestamp and .rate ---

def test_camera_pose_nan_timestamp_raises():
    """CameraPose(timestamp=float('nan')) must raise ValidationError."""
    with pytest.raises(ValidationError):
        CameraPose(timestamp=float("nan"))


def test_camera_pose_inf_timestamp_raises():
    """CameraPose(timestamp=float('inf')) must raise ValidationError."""
    with pytest.raises(ValidationError):
        CameraPose(timestamp=float("inf"))


def test_camera_pose_neg_inf_timestamp_raises():
    """CameraPose(timestamp=float('-inf')) must raise ValidationError."""
    with pytest.raises(ValidationError):
        CameraPose(timestamp=float("-inf"))


def test_camera_pose_nan_rate_raises():
    """CameraPose(rate=float('nan')) must raise ValidationError."""
    with pytest.raises(ValidationError):
        CameraPose(rate=float("nan"))


def test_camera_pose_inf_rate_raises():
    """CameraPose(rate=float('inf')) must raise ValidationError."""
    with pytest.raises(ValidationError):
        CameraPose(rate=float("inf"))


def test_camera_pose_finite_timestamp_and_rate_accepted():
    """Normal finite timestamp and rate must still build without error."""
    p = CameraPose(timestamp=1.5, rate=30.0)
    assert p.timestamp == 1.5
    assert p.rate == 30.0


def test_camera_pose_zero_timestamp_accepted():
    """Zero timestamp is finite and must be accepted."""
    p = CameraPose(timestamp=0.0)
    assert p.timestamp == 0.0


# --- Subprocess tests: stdin JSON with NaN timestamp ---

def test_subprocess_send_stdin_nan_timestamp_exits_13():
    """send with stdin {timestamp: NaN} must exit 13 (INVALID_TRAJECTORY), no traceback."""
    proc = _run(
        ["send", "--protocol", "freed", "--output", "json", "--dry-run"],
        stdin='{"timestamp": NaN}',
        timeout=5,
    )
    # Python's json.loads does NOT accept NaN, so this will exit with a JSON parse error
    # (also exit 13). Either way, must be non-zero and no traceback.
    assert proc.returncode != 0, (
        f"expected non-zero exit; stdout={proc.stdout!r}; stderr={proc.stderr!r}"
    )
    # No traceback in stderr
    assert "Traceback" not in proc.stderr, f"unexpected traceback: {proc.stderr!r}"
    # No NaN in stdout
    assert "NaN" not in proc.stdout, f"NaN leaked to stdout: {proc.stdout!r}"
