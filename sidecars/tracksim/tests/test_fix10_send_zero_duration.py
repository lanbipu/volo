"""Fix 10 (round 2 finding 3): send --duration 0 or negative must be rejected (exit 13)."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parent.parent
_ENV = {**os.environ, "PYTHONPATH": str(_REPO / "src"), "PYSDL3_NO_UPDATE_CHECK": "1"}


def _run(args, timeout=10):
    return subprocess.run(
        [sys.executable, "-m", "tracksim", *args],
        capture_output=True, text=True, env=_ENV, timeout=timeout, cwd=_REPO,
    )


def test_send_duration_zero_exits_13():
    """send --duration 0 must exit 13 with INVALID_TRAJECTORY error envelope."""
    proc = _run(
        ["send", "--duration", "0", "--protocol", "freed", "--output", "json"],
        timeout=5,
    )
    assert proc.returncode == 13, f"expected exit 13, got {proc.returncode}; stdout={proc.stdout}; stderr={proc.stderr}"
    obj = json.loads(proc.stdout)
    assert obj["status"] == "error"
    assert obj["error"]["code"] == "INVALID_TRAJECTORY"


def test_send_duration_negative_exits_13():
    """send --duration -1 must exit 13 with INVALID_TRAJECTORY error envelope."""
    proc = _run(
        ["send", "--duration", "-1", "--protocol", "freed", "--output", "json"],
        timeout=5,
    )
    assert proc.returncode == 13, f"expected exit 13, got {proc.returncode}; stdout={proc.stdout}"
    obj = json.loads(proc.stdout)
    assert obj["status"] == "error"
    assert obj["error"]["code"] == "INVALID_TRAJECTORY"


def test_send_duration_positive_works():
    """send --duration 0.05 (valid) must succeed."""
    proc = _run(
        ["send", "--duration", "0.05", "--protocol", "freed", "--output", "json"],
        timeout=10,
    )
    assert proc.returncode == 0, f"expected exit 0, got {proc.returncode}; stderr={proc.stderr}"
    obj = json.loads(proc.stdout)
    assert obj["status"] == "ok"
