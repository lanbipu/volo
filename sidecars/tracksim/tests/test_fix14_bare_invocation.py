"""Fix 14 (round 3 finding 1): bare invocation (no args) must always be EXIT_USAGE=2.

Both main([]) and `tracksim` (no args) must print help to stderr and return 2.
--version must still work.
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

from tracksim.cli.main import main
from tracksim.envelope import EXIT_OK, EXIT_USAGE

_REPO = Path(__file__).resolve().parent.parent
_ENV = {**os.environ, "PYTHONPATH": str(_REPO / "src"), "PYSDL3_NO_UPDATE_CHECK": "1"}


def _run(args, timeout=8):
    return subprocess.run(
        [sys.executable, "-m", "tracksim", *args],
        capture_output=True, text=True, env=_ENV, timeout=timeout, cwd=_REPO,
    )


def test_main_empty_list_exits_usage(capsys):
    """main([]) must return EXIT_USAGE (2), not 0."""
    rc = main([])
    assert rc == EXIT_USAGE, f"expected {EXIT_USAGE}, got {rc}"


def test_main_empty_list_prints_help_to_stderr(capsys):
    """main([]) must print help text to stderr."""
    main([])
    captured = capsys.readouterr()
    assert "usage" in captured.err.lower() or "tracksim" in captured.err.lower()


def test_main_version_still_exits_ok(capsys):
    """main(['--version']) must return EXIT_OK (0)."""
    rc = main(["--version"])
    assert rc == EXIT_OK, f"expected {EXIT_OK}, got {rc}"


def test_subprocess_bare_exits_2():
    """Subprocess `tracksim` with no args must exit 2."""
    proc = _run([])
    assert proc.returncode == 2, (
        f"expected exit 2 for bare tracksim, got {proc.returncode}; "
        f"stdout={proc.stdout!r}; stderr={proc.stderr!r}"
    )
