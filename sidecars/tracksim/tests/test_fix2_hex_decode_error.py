"""Fix 2: freed decode with invalid hex should raise InvalidTrajectoryError (exit 13)."""
from __future__ import annotations

import json
import os
import subprocess
import sys

import pytest

from tracksim.cli import main as cli_main
from tracksim.domain.errors import InvalidTrajectoryError

_ENV = {**os.environ, "PYTHONPATH": os.path.abspath("src")}


def _run(args, **kw):
    return subprocess.run(
        [sys.executable, "-m", "tracksim", *args],
        capture_output=True, text=True, env=_ENV, **kw
    )


def test_freed_decode_invalid_hex_raises_invalid_trajectory():
    """bytes.fromhex('nothex') must raise InvalidTrajectoryError, not ValueError."""
    with pytest.raises(InvalidTrajectoryError) as exc_info:
        # Simulate what main.py does: bytes.fromhex on bad input, wrapped
        from tracksim.cli.main import _dispatch
        import argparse
        args = argparse.Namespace(
            command="freed",
            subcommand="decode",
            hex="nothex",
            dry_run=False,
            config=None,
            output="json",
            no_input=True,
            log_level="info",
            verbose=0,
            quiet=False,
            no_color=False,
            yes=False,
        )
        _dispatch(args, fmt="json", request_id="r1", timestamp="2026-01-01T00:00:00Z")

    assert exc_info.value.exit_code == 13
    assert exc_info.value.code == "INVALID_TRAJECTORY"


def test_freed_decode_invalid_hex_subprocess_exit_13():
    """subprocess: freed decode nothex --output json -> exit 13, JSON error envelope."""
    proc = _run(["freed", "decode", "nothex", "--output", "json"])
    assert proc.returncode == 13, f"expected 13, got {proc.returncode}: {proc.stderr}"
    obj = json.loads(proc.stdout)
    assert obj["status"] == "error"
    assert obj["error"]["code"] == "INVALID_TRAJECTORY"
    assert obj["error"]["exit_code"] == 13


def test_freed_decode_valid_hex_still_works():
    """Sanity: valid 29-byte FreeD packet still decodes correctly."""
    # Build a minimal valid D1 packet (all zeros + correct checksum)
    data = bytearray(29)
    data[0] = 0xD1
    # checksum = (0x40 - sum(data[:28])) & 0xFF
    data[28] = (0x40 - sum(data[:28])) & 0xFF
    hex_str = data.hex()
    proc = _run(["freed", "decode", hex_str, "--output", "json"])
    assert proc.returncode == 0, proc.stderr
    obj = json.loads(proc.stdout)
    assert obj["status"] == "ok"
    assert obj["data"]["message_type"] == "0xD1"
