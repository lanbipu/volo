"""Fix 15 (round 3 finding 2): controllers monitor --rate 0 must raise InvalidTrajectoryError."""
from __future__ import annotations

import io
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


class FakeControllerInput:
    def __init__(self):
        self._devices = [ControllerDevice(index=0, name="Pad", guid="g0")]

    def list_devices(self):
        return list(self._devices)

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


def test_monitor_stream_rate_zero_raises_invalid_trajectory():
    """rate=0 must raise InvalidTrajectoryError, not ZeroDivisionError."""
    ci = FakeControllerInput()
    with pytest.raises(InvalidTrajectoryError):
        controllers.monitor_stream(ci, None, clock=FakeClock(), rate=0, samples=1)


def test_monitor_stream_rate_negative_raises_invalid_trajectory():
    """rate=-1 must raise InvalidTrajectoryError."""
    ci = FakeControllerInput()
    with pytest.raises(InvalidTrajectoryError):
        controllers.monitor_stream(ci, None, clock=FakeClock(), rate=-1.0, samples=1)


def test_subprocess_monitor_rate_zero_structured_error():
    """Subprocess: controllers monitor --rate 0 --output json → structured error, non-zero exit."""
    proc = subprocess.run(
        [sys.executable, "-m", "tracksim", "controllers", "monitor",
         "--rate", "0", "--output", "json"],
        capture_output=True, text=True, env=_ENV, timeout=8, cwd=_REPO,
    )
    assert proc.returncode != 0, f"expected non-zero exit, got {proc.returncode}"
    obj = json.loads(proc.stdout)
    assert obj["status"] == "error"
    assert "traceback" not in proc.stderr.lower() or "ZeroDivision" not in proc.stderr
    assert obj["error"]["code"] == "INVALID_TRAJECTORY"
