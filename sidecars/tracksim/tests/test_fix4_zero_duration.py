"""Fix 4: run --duration 0 (or negative) must be rejected, not treated as unbounded."""
from __future__ import annotations

import json
import os
import subprocess
import sys

import pytest

_ENV = {**os.environ, "PYTHONPATH": os.path.abspath("src"), "PYSDL3_NO_UPDATE_CHECK": "1"}


def _run(args, timeout=10, **kw):
    return subprocess.run(
        [sys.executable, "-m", "tracksim", *args],
        capture_output=True, text=True, env=_ENV, timeout=timeout, **kw
    )


def test_run_duration_zero_exits_nonzero():
    """run --duration 0 must exit non-zero with a proper error envelope (not hang)."""
    proc = _run(
        ["run", "--duration", "0", "--rate", "10", "--protocol", "freed", "--output", "json"],
        timeout=5,
    )
    assert proc.returncode != 0, f"expected non-zero exit, got 0; stdout={proc.stdout}"
    obj = json.loads(proc.stdout)
    assert obj["status"] == "error"


def test_run_duration_negative_exits_nonzero():
    """run --duration -1 must exit non-zero with a proper error envelope."""
    proc = _run(
        ["run", "--duration", "-1", "--rate", "10", "--protocol", "freed", "--output", "json"],
        timeout=5,
    )
    assert proc.returncode != 0
    obj = json.loads(proc.stdout)
    assert obj["status"] == "error"


def test_run_duration_positive_still_works():
    """Sanity: run --duration 0.1 must complete successfully."""
    proc = _run(
        ["run", "--duration", "0.1", "--rate", "10", "--source", "script",
         "--protocol", "freed", "--output", "json"],
        timeout=10,
    )
    assert proc.returncode == 0, proc.stderr
    obj = json.loads(proc.stdout)
    assert obj["status"] == "ok"
