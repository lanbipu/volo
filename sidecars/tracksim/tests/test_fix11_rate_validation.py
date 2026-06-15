"""Fix 11 (round 2 finding 4): --rate 0 and --rate -1 must be rejected (exit 13)."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parent.parent
_ENV = {**os.environ, "PYTHONPATH": str(_REPO / "src"), "PYSDL3_NO_UPDATE_CHECK": "1"}


def _run(args, timeout=8):
    return subprocess.run(
        [sys.executable, "-m", "tracksim", *args],
        capture_output=True, text=True, env=_ENV, timeout=timeout, cwd=_REPO,
    )


def test_send_rate_zero_exits_13():
    """send --rate 0 must exit 13 with INVALID_TRAJECTORY envelope."""
    proc = _run(
        ["send", "--rate", "0", "--protocol", "freed", "--output", "json"],
        timeout=5,
    )
    assert proc.returncode == 13, f"expected 13, got {proc.returncode}; stdout={proc.stdout}"
    obj = json.loads(proc.stdout)
    assert obj["status"] == "error"
    assert obj["error"]["code"] == "INVALID_TRAJECTORY"


def test_send_rate_negative_exits_13():
    """send --rate -1 must exit 13."""
    proc = _run(
        ["send", "--rate", "-1", "--protocol", "freed", "--output", "json"],
        timeout=5,
    )
    assert proc.returncode == 13, f"expected 13, got {proc.returncode}; stdout={proc.stdout}"
    obj = json.loads(proc.stdout)
    assert obj["status"] == "error"
    assert obj["error"]["code"] == "INVALID_TRAJECTORY"


def test_run_rate_zero_exits_13():
    """run --rate 0 must exit 13 (not hang)."""
    proc = _run(
        ["run", "--rate", "0", "--protocol", "freed", "--output", "json", "--duration", "0.1"],
        timeout=5,
    )
    assert proc.returncode == 13, f"expected 13, got {proc.returncode}; stdout={proc.stdout}"
    obj = json.loads(proc.stdout)
    assert obj["status"] == "error"
    assert obj["error"]["code"] == "INVALID_TRAJECTORY"


def test_run_rate_negative_exits_13():
    """run --rate -1 must exit 13 (not hang in tight loop)."""
    proc = _run(
        ["run", "--rate", "-1", "--protocol", "freed", "--output", "json", "--duration", "0.1"],
        timeout=5,
    )
    assert proc.returncode == 13, f"expected 13, got {proc.returncode}; stdout={proc.stdout}"
    obj = json.loads(proc.stdout)
    assert obj["status"] == "error"
    assert obj["error"]["code"] == "INVALID_TRAJECTORY"


def test_send_rate_valid_works():
    """send with a valid rate must succeed."""
    proc = _run(
        ["send", "--rate", "10", "--protocol", "freed", "--output", "json"],
        timeout=10,
    )
    assert proc.returncode == 0, f"expected 0, got {proc.returncode}; stderr={proc.stderr}"


def test_run_rate_valid_works():
    """run with a valid rate must succeed."""
    proc = _run(
        ["run", "--rate", "10", "--protocol", "freed", "--output", "json", "--duration", "0.1"],
        timeout=10,
    )
    assert proc.returncode == 0, f"expected 0, got {proc.returncode}; stderr={proc.stderr}"
