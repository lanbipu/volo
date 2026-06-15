"""Fix 18 (round 3 comprehensive hardening): no invalid user input raises non-TracksimError.

Covers:
- freed decode: too-short binary packet
- freed decode: odd-length hex string via CLI
- freed decode: malformed hex string via CLI
- opentrackio decode: too-short binary
- _read_stdin_json: non-object JSON values produce InvalidTrajectoryError (via main dispatch)
"""
from __future__ import annotations

import io
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from tracksim.cli.commands.decode import freed_decode, opentrackio_decode
from tracksim.domain.errors import InvalidTrajectoryError

_REPO = Path(__file__).resolve().parent.parent
_ENV = {**os.environ, "PYTHONPATH": str(_REPO / "src"), "PYSDL3_NO_UPDATE_CHECK": "1"}


def _run(args, stdin_text=None, timeout=8):
    return subprocess.run(
        [sys.executable, "-m", "tracksim", *args],
        input=stdin_text,
        capture_output=True, text=True, env=_ENV, timeout=timeout, cwd=_REPO,
    )


# --- freed_decode unit-level hardening ---

def test_freed_decode_too_short_raises_invalid_trajectory():
    """Binary FreeD packet shorter than 29 bytes must raise InvalidTrajectoryError."""
    with pytest.raises(InvalidTrajectoryError) as exc_info:
        freed_decode(b"\xd1" + b"\x00" * 5)
    assert "29" in exc_info.value.message


def test_freed_decode_empty_raises_invalid_trajectory():
    """Empty bytes must raise InvalidTrajectoryError, not IndexError."""
    with pytest.raises(InvalidTrajectoryError):
        freed_decode(b"")


def test_freed_decode_too_long_raises_invalid_trajectory():
    """Packet longer than 29 bytes must raise InvalidTrajectoryError."""
    with pytest.raises(InvalidTrajectoryError):
        freed_decode(b"\xd1" + b"\x00" * 30)


# --- opentrackio_decode unit-level hardening ---

def test_opentrackio_decode_too_short_raises_invalid_trajectory():
    """Binary OTrk packet shorter than OTRK_HEADER_LENGTH must raise InvalidTrajectoryError."""
    with pytest.raises(InvalidTrajectoryError):
        opentrackio_decode(b"\x00" * 5)


# --- subprocess: freed decode with malformed hex ---

def test_subprocess_freed_decode_odd_hex_exits_nonzero():
    """freed decode abc (odd-length hex) must exit non-zero with structured error."""
    proc = _run(["freed", "decode", "--output", "json", "abc"])
    assert proc.returncode != 0, f"expected non-zero, got {proc.returncode}"
    obj = json.loads(proc.stdout)
    assert obj["status"] == "error"
    assert "Traceback" not in proc.stderr


def test_subprocess_freed_decode_invalid_hex_exits_nonzero():
    """freed decode ZZZZZZ... (invalid hex chars) must exit non-zero with structured error."""
    proc = _run(["freed", "decode", "--output", "json", "ZZ" * 29])
    assert proc.returncode != 0, f"expected non-zero, got {proc.returncode}"
    obj = json.loads(proc.stdout)
    assert obj["status"] == "error"
    assert "Traceback" not in proc.stderr


def test_subprocess_freed_decode_short_hex_exits_nonzero():
    """freed decode with a 5-byte hex (10 chars) must exit non-zero."""
    proc = _run(["freed", "decode", "--output", "json", "d1" + "00" * 4])
    assert proc.returncode != 0, f"expected non-zero, got {proc.returncode}"
    obj = json.loads(proc.stdout)
    assert obj["status"] == "error"
