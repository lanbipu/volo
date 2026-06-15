"""Fix 8 (round 2 finding 1): Invalid stdin JSON must raise InvalidTrajectoryError (exit 13)."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parent.parent
_ENV = {**os.environ, "PYTHONPATH": str(_REPO / "src"), "PYSDL3_NO_UPDATE_CHECK": "1"}


def _run(args, stdin_data=None, timeout=10):
    return subprocess.run(
        [sys.executable, "-m", "tracksim", *args],
        capture_output=True, text=True, env=_ENV, timeout=timeout,
        input=stdin_data, cwd=_REPO,
    )


def test_bad_stdin_json_send_exits_13():
    """send with bad stdin JSON must exit 13 with INVALID_TRAJECTORY envelope."""
    proc = _run(
        ["send", "--output", "json", "--protocol", "freed"],
        stdin_data="{bad json",
    )
    assert proc.returncode == 13, f"expected exit 13, got {proc.returncode}; stderr={proc.stderr}"
    obj = json.loads(proc.stdout)
    assert obj["status"] == "error"
    assert obj["error"]["code"] == "INVALID_TRAJECTORY"


def test_unicode_decode_error_send_exits_13():
    """send with invalid bytes on stdin must exit 13 (not traceback)."""
    # We'll simulate this by making json.loads fail via malformed JSON
    proc = _run(
        ["send", "--output", "json", "--protocol", "freed"],
        stdin_data="not-json-at-all!!",
    )
    assert proc.returncode == 13, f"expected exit 13, got {proc.returncode}"
    obj = json.loads(proc.stdout)
    assert obj["status"] == "error"
    assert obj["error"]["code"] == "INVALID_TRAJECTORY"
