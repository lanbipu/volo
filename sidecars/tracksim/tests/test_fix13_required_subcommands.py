"""Fix 13 (round 2 finding 6): Nested subcommands must be required (exit 2 on missing leaf)."""
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


def test_config_no_leaf_exits_2():
    """tracksim config (no leaf) must exit 2, not 1."""
    proc = _run(["config", "--output", "json"])
    assert proc.returncode == 2, f"expected exit 2, got {proc.returncode}; stdout={proc.stdout}"


def test_controllers_no_leaf_exits_2():
    """tracksim controllers (no leaf) must exit 2."""
    proc = _run(["controllers", "--output", "json"])
    assert proc.returncode == 2, f"expected exit 2, got {proc.returncode}; stdout={proc.stdout}"


def test_freed_no_leaf_exits_2():
    """tracksim freed (no leaf) must exit 2."""
    proc = _run(["freed", "--output", "json"])
    assert proc.returncode == 2, f"expected exit 2, got {proc.returncode}; stdout={proc.stdout}"


def test_opentrackio_no_leaf_exits_2():
    """tracksim opentrackio (no leaf) must exit 2."""
    proc = _run(["opentrackio", "--output", "json"])
    assert proc.returncode == 2, f"expected exit 2, got {proc.returncode}; stdout={proc.stdout}"


def test_config_init_still_works():
    """tracksim config init must still work (regression check)."""
    proc = _run(["config", "init", "--dry-run", "--output", "json"])
    assert proc.returncode == 0, f"expected exit 0, got {proc.returncode}; stderr={proc.stderr}"
    obj = json.loads(proc.stdout)
    assert obj["status"] == "ok"


def test_config_show_still_works():
    """tracksim config show must still work."""
    proc = _run(["config", "show", "--output", "json"])
    assert proc.returncode == 0, f"expected exit 0, got {proc.returncode}; stderr={proc.stderr}"


def test_controllers_list_still_works():
    """tracksim controllers list must still work (even if SDL fails gracefully)."""
    proc = _run(["controllers", "list", "--output", "json"])
    # May exit non-zero if no SDL; but it should not exit 2
    assert proc.returncode != 2, f"controllers list must not exit 2"
