"""Fix 26 (round 5 finding 3): argparse usage errors must honor --output ndjson."""
from __future__ import annotations

import json
import subprocess
import sys


def _run(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-m", "tracksim"] + args,
        capture_output=True,
        text=True,
    )


def test_bad_flag_with_ndjson_outputs_ndjson_result():
    """tracksim run --badflag --output ndjson → exit 2, last stdout line is valid ndjson result."""
    result = _run(["run", "--badflag", "--output", "ndjson"])
    assert result.returncode == 2
    lines = [l for l in result.stdout.splitlines() if l.strip()]
    assert lines, "expected at least one line of stdout"
    last = json.loads(lines[-1])
    assert last.get("type") == "result"
    assert last.get("final") is True
    assert last.get("status") == "error"


def test_bad_flag_with_stream_json_outputs_ndjson_result():
    """tracksim run --badflag --output stream-json → exit 2, last stdout line is valid ndjson result."""
    result = _run(["run", "--badflag", "--output", "stream-json"])
    assert result.returncode == 2
    lines = [l for l in result.stdout.splitlines() if l.strip()]
    assert lines, "expected at least one line of stdout"
    last = json.loads(lines[-1])
    assert last.get("type") == "result"
    assert last.get("final") is True
    assert last.get("status") == "error"


def test_bad_flag_with_json_output_still_works():
    """--output json still works as before (plain JSON envelope)."""
    result = _run(["run", "--badflag", "--output", "json"])
    assert result.returncode == 2
    assert result.stdout.strip()
    envelope = json.loads(result.stdout.strip())
    assert envelope.get("status") == "error"
