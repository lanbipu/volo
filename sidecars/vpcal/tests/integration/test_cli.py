"""CLI conformance tests (CLI_DESIGN_SPEC §12.3): envelopes, exit codes, isolation."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

SRC = str(Path(__file__).resolve().parents[2] / "src")


def _run(*args, env_extra=None):
    env = dict(os.environ, PYTHONPATH=SRC)
    if env_extra:
        env.update(env_extra)
    return subprocess.run(
        [sys.executable, "-m", "vpcal.cli.main", *args],
        capture_output=True, text=True, env=env,
    )


def test_version_text():
    r = _run("version")
    assert r.returncode == 0
    assert r.stdout.strip() == "vpcal 0.1.0"


def test_version_json_stdout_is_pure_json():
    r = _run("version", "--output", "json")
    assert r.returncode == 0
    env = json.loads(r.stdout)  # stdout must be parseable JSON only
    assert env["status"] == "ok"
    assert env["operation_id"] == "version"
    assert env["data"]["version"] == "0.1.0"


def test_ai_agent_env_defaults_to_json():
    r = _run("version", env_extra={"AI_AGENT": "1"})
    env = json.loads(r.stdout)
    assert env["status"] == "ok"


def test_usage_error_json_envelope_exit2():
    r = _run("quick", "run", "--badflag", "--output", "json")
    assert r.returncode == 2
    env = json.loads(r.stdout)
    assert env["status"] == "error"
    assert env["error"]["exit_code"] == 2
    assert env["error"]["code"] == "ARG_VALIDATION"


def test_missing_config_exit3():
    r = _run("quick", "run", "--config", "/no/such/file.json", "--output", "json")
    assert r.returncode == 3
    env = json.loads(r.stdout)
    assert env["error"]["code"] == "CONFIG_ERROR"


def test_stderr_isolated_from_stdout():
    # In json mode stdout is data-only; logs (if any) go to stderr.
    r = _run("version", "--output", "json", "--log-level", "debug")
    json.loads(r.stdout)  # must not raise
    assert "{" not in r.stderr or r.stderr.strip() == ""


def test_manifest_operation_ids():
    r = _run("manifest", "--output", "json")
    assert r.returncode == 0
    env = json.loads(r.stdout)
    ids = {o["operation_id"] for o in env["data"]["operations"]}
    assert ids == {
        "quick.run", "pattern.generate", "screen.create", "screen.import",
        "simulate", "simulate.sweep", "report.generate", "report.diff",
        "export.opentrackio", "export.ndisplay",
        "capture.track", "capture.video", "capture.playback",
    }


def test_schema_json():
    r = _run("schema", "--output", "json")
    assert r.returncode == 0
    env = json.loads(r.stdout)
    assert "session_config" in env["data"]
    assert "calibration_result" in env["data"]


def test_completion_bash():
    r = _run("completion", "bash")
    assert r.returncode == 0
    assert "_vpcal_completion" in r.stdout


def test_help_exit0():
    r = _run("--help")
    assert r.returncode == 0
    assert "quick" in r.stdout and "simulate" in r.stdout


def test_ndjson_final_event():
    r = _run("version", "--output", "ndjson")
    lines = [json.loads(ln) for ln in r.stdout.strip().splitlines()]
    assert lines[0]["type"] == "start"
    assert lines[-1]["type"] == "result"
    assert lines[-1]["final"] is True
