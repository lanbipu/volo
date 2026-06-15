"""Fix 23 (round 4 finding 6): errors in ndjson mode must emit ndjson result event lines."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parent.parent
_ENV = {**os.environ, "PYTHONPATH": str(_REPO / "src"), "PYSDL3_NO_UPDATE_CHECK": "1"}


def _run(args, timeout=10, **kw):
    return subprocess.run(
        [sys.executable, "-m", "tracksim", *args],
        capture_output=True, text=True, env=_ENV, timeout=timeout, cwd=str(_REPO), **kw
    )


def test_run_rate_zero_ndjson_last_line_has_type_and_final():
    """run --rate 0 --output ndjson: last stdout line must be a ndjson result event."""
    proc = _run(["run", "--rate", "0", "--protocol", "freed", "--output", "ndjson"], timeout=5)
    assert proc.returncode != 0
    lines = [l for l in proc.stdout.splitlines() if l.strip()]
    assert lines, f"expected at least one ndjson line; stdout={proc.stdout!r}"
    last = json.loads(lines[-1])
    assert last.get("type") == "result", f"last line must have type=result: {last}"
    assert last.get("final") is True, f"last line must have final=true: {last}"
    assert last.get("status") == "error", f"last line must have status=error: {last}"


def test_run_rate_zero_ndjson_has_request_id_and_timestamp():
    """ndjson error line must include request_id and timestamp fields."""
    proc = _run(["run", "--rate", "0", "--protocol", "freed", "--output", "ndjson"], timeout=5)
    lines = [l for l in proc.stdout.splitlines() if l.strip()]
    assert lines
    last = json.loads(lines[-1])
    assert "request_id" in last, f"missing request_id in ndjson error: {last}"
    assert "timestamp" in last, f"missing timestamp in ndjson error: {last}"


def test_run_rate_zero_ndjson_has_error_field():
    """ndjson error line must include the error details."""
    proc = _run(["run", "--rate", "0", "--protocol", "freed", "--output", "ndjson"], timeout=5)
    lines = [l for l in proc.stdout.splitlines() if l.strip()]
    assert lines
    last = json.loads(lines[-1])
    assert "error" in last, f"missing error field in ndjson error: {last}"
    assert last["error"].get("code") == "INVALID_TRAJECTORY"


def test_run_rate_zero_ndjson_line_is_valid_json():
    """Each line of ndjson output must be parseable as JSON."""
    proc = _run(["run", "--rate", "0", "--protocol", "freed", "--output", "ndjson"], timeout=5)
    for line in proc.stdout.splitlines():
        if line.strip():
            json.loads(line)  # must not raise


def test_run_with_error_ndjson_not_bare_envelope():
    """ndjson error output must NOT be a bare JSON envelope (missing type/final/sequence)."""
    proc = _run(["run", "--rate", "0", "--protocol", "freed", "--output", "ndjson"], timeout=5)
    lines = [l for l in proc.stdout.splitlines() if l.strip()]
    assert lines
    last = json.loads(lines[-1])
    # A bare envelope has 'schema_version' at top level but no 'type' field
    # ndjson result line MUST have 'type'
    assert "type" in last, f"bare envelope emitted instead of ndjson line (missing 'type'): {last}"
