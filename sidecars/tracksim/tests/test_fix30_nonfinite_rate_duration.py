"""Fix 30 (round 6 finding 3): NaN/Inf rate and duration must be rejected as InvalidTrajectoryError."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from tracksim.cli.commands import controllers
from tracksim.domain.errors import InvalidTrajectoryError
from tracksim.ports.controller_input import ControllerDevice, ControllerState

_REPO = Path(__file__).resolve().parent.parent
_ENV = {**os.environ, "PYTHONPATH": str(_REPO / "src"), "PYSDL3_NO_UPDATE_CHECK": "1"}


def _run(args, timeout=8):
    return subprocess.run(
        [sys.executable, "-m", "tracksim", *args],
        capture_output=True, text=True, env=_ENV, timeout=timeout, cwd=_REPO,
    )


class FakeControllerInput:
    def list_devices(self):
        return [ControllerDevice(index=0, name="Pad", guid="g0")]

    def open(self, index: int) -> None:
        pass

    def poll(self) -> ControllerState:
        return ControllerState(axes={}, buttons={})

    def close(self) -> None:
        pass


class FakeClock:
    def sleep(self, seconds: float) -> None:
        pass

    def now(self) -> float:
        return 0.0


# --- Unit test: monitor_stream with NaN/Inf rate ---

def test_monitor_stream_nan_rate_raises_invalid_trajectory():
    """monitor_stream with rate=NaN must raise InvalidTrajectoryError, not crash."""
    ci = FakeControllerInput()
    with pytest.raises(InvalidTrajectoryError):
        controllers.monitor_stream(ci, None, clock=FakeClock(), rate=float("nan"), samples=1)


def test_monitor_stream_inf_rate_raises_invalid_trajectory():
    """monitor_stream with rate=Inf must raise InvalidTrajectoryError."""
    ci = FakeControllerInput()
    with pytest.raises(InvalidTrajectoryError):
        controllers.monitor_stream(ci, None, clock=FakeClock(), rate=float("inf"), samples=1)


# --- Subprocess tests: run ---

def test_run_nan_rate_exits_13():
    """run --rate nan must exit 13 (not traceback)."""
    proc = _run(
        ["run", "--rate", "nan", "--protocol", "freed", "--output", "json", "--duration", "0.1"],
        timeout=5,
    )
    assert proc.returncode == 13, (
        f"expected 13, got {proc.returncode}; stdout={proc.stdout!r}; stderr={proc.stderr!r}"
    )
    obj = json.loads(proc.stdout)
    assert obj["status"] == "error"
    assert obj["error"]["code"] == "INVALID_TRAJECTORY"


def test_run_inf_duration_exits_13():
    """run --duration inf must exit 13 (math.ceil(inf*rate) raises OverflowError without guard)."""
    proc = _run(
        ["run", "--duration", "inf", "--rate", "10", "--protocol", "freed", "--output", "json"],
        timeout=5,
    )
    assert proc.returncode == 13, (
        f"expected 13, got {proc.returncode}; stdout={proc.stdout!r}; stderr={proc.stderr!r}"
    )
    obj = json.loads(proc.stdout)
    assert obj["status"] == "error"
    assert obj["error"]["code"] == "INVALID_TRAJECTORY"


def test_run_nan_duration_exits_13():
    """run --duration nan must exit 13."""
    proc = _run(
        ["run", "--duration", "nan", "--rate", "10", "--protocol", "freed", "--output", "json"],
        timeout=5,
    )
    assert proc.returncode == 13, (
        f"expected 13, got {proc.returncode}; stdout={proc.stdout!r}; stderr={proc.stderr!r}"
    )
    obj = json.loads(proc.stdout)
    assert obj["status"] == "error"
    assert obj["error"]["code"] == "INVALID_TRAJECTORY"


def test_send_nan_rate_exits_13():
    """send --rate nan must exit 13."""
    proc = _run(
        ["send", "--rate", "nan", "--protocol", "freed", "--output", "json"],
        timeout=5,
    )
    assert proc.returncode == 13, f"expected 13, got {proc.returncode}; stdout={proc.stdout!r}"
    obj = json.loads(proc.stdout)
    assert obj["error"]["code"] == "INVALID_TRAJECTORY"


def test_send_inf_duration_exits_13():
    """send --duration inf must exit 13."""
    proc = _run(
        ["send", "--duration", "inf", "--rate", "10", "--protocol", "freed", "--output", "json"],
        timeout=5,
    )
    assert proc.returncode == 13, f"expected 13, got {proc.returncode}; stdout={proc.stdout!r}"
    obj = json.loads(proc.stdout)
    assert obj["error"]["code"] == "INVALID_TRAJECTORY"


def test_run_valid_rate_still_works():
    """Sanity: run with valid rate/duration must still succeed."""
    proc = _run(
        ["run", "--rate", "10", "--duration", "0.05", "--protocol", "freed", "--output", "json"],
        timeout=10,
    )
    assert proc.returncode == 0, f"expected 0, got {proc.returncode}; stderr={proc.stderr}"
