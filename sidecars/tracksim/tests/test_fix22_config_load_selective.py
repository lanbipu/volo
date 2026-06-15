"""Fix 22 (round 4 finding 5): load_config only called for commands that need it.

Commands that don't use config (version, manifest, schema, completion, config init,
freed decode, opentrackio decode, controllers list/monitor) must succeed even when
--config points to a nonexistent file.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parent.parent
_ENV = {**os.environ, "PYTHONPATH": str(_REPO / "src"), "PYSDL3_NO_UPDATE_CHECK": "1"}
_NONEXISTENT_CONFIG = "/tmp/__nonexistent_tracksim_config_9z8x7.toml"


def _run(args, timeout=10, **kw):
    return subprocess.run(
        [sys.executable, "-m", "tracksim", *args],
        capture_output=True, text=True, env=_ENV, timeout=timeout, cwd=str(_REPO), **kw
    )


def test_version_with_missing_config_exits_0():
    """version --config /nonexistent.toml must exit 0 (config not loaded)."""
    proc = _run(["version", "--config", _NONEXISTENT_CONFIG, "--output", "json"])
    assert proc.returncode == 0, f"expected exit 0, got {proc.returncode}; stderr={proc.stderr}"
    obj = json.loads(proc.stdout)
    assert obj["status"] == "ok"


def test_manifest_with_missing_config_exits_0():
    """manifest --config /nonexistent.toml must exit 0."""
    proc = _run(["manifest", "--config", _NONEXISTENT_CONFIG, "--output", "json"])
    assert proc.returncode == 0, f"expected exit 0, got {proc.returncode}; stderr={proc.stderr}"


def test_schema_with_missing_config_exits_0():
    """schema --config /nonexistent.toml must exit 0."""
    proc = _run(["schema", "--config", _NONEXISTENT_CONFIG, "--output", "json"])
    assert proc.returncode == 0, f"expected exit 0, got {proc.returncode}; stderr={proc.stderr}"


def test_config_init_with_missing_config_exits_0(tmp_path):
    """config init --config /nonexistent.toml must succeed without reading nonexistent config."""
    out = tmp_path / "out.toml"
    proc = _run([
        "config", "init",
        "--config", _NONEXISTENT_CONFIG,
        "--path", str(out),
        "--output", "json",
    ])
    assert proc.returncode == 0, f"expected exit 0, got {proc.returncode}; stderr={proc.stderr}"
    obj = json.loads(proc.stdout)
    assert obj["status"] == "ok"
    assert out.exists(), "config init must create the output file"


def test_freed_decode_with_missing_config_no_config_error():
    """freed decode --config /nonexistent.toml must not fail with ConfigError (exit 3)."""
    # A valid 29-byte FreeD D1 packet (all zeros except header) — may fail checksum,
    # but it must NOT fail with CONFIG_ERROR (exit 3).
    valid_hex = "d1" + "00" * 28
    proc = _run(["freed", "decode", "--config", _NONEXISTENT_CONFIG, "--output", "json", valid_hex])
    # Exit 3 means ConfigError; any other exit code (including 0 or 13 for bad packet) is fine
    assert proc.returncode != 3, (
        f"freed decode must not load config (got exit {proc.returncode}); stderr={proc.stderr}"
    )
    obj = json.loads(proc.stdout)
    # Status can be ok or error (for bad packet), but not due to config
    if obj["status"] == "error":
        assert obj["error"]["code"] != "CONFIG_ERROR", f"got unexpected CONFIG_ERROR: {obj}"


def test_send_with_missing_config_exits_nonzero_with_config_error():
    """send --config /nonexistent.toml must fail with ConfigError (not succeed with defaults)."""
    proc = _run(["send", "--config", _NONEXISTENT_CONFIG, "--protocol", "freed", "--output", "json"])
    assert proc.returncode != 0, f"expected non-zero exit, got {proc.returncode}"
    obj = json.loads(proc.stdout)
    assert obj["status"] == "error"
    # Should be a config-related error
    assert obj["error"]["exit_code"] == 3 or "config" in obj["error"]["message"].lower() or "CONFIG" in obj["error"]["code"]
