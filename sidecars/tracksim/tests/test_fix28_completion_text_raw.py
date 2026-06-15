"""Fix 28 (round 6 finding 1): completion text output must be a raw script, not wrapped in envelope."""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parent.parent
_ENV = {**os.environ, "PYTHONPATH": str(_REPO / "src"), "PYSDL3_NO_UPDATE_CHECK": "1"}


def _run(args, timeout=8):
    return subprocess.run(
        [sys.executable, "-m", "tracksim", *args],
        capture_output=True, text=True, env=_ENV, timeout=timeout, cwd=_REPO,
    )


def test_completion_bash_text_output_is_raw_script():
    """completion bash in text mode must print the raw script, no 'completion:' prefix."""
    proc = _run(["completion", "bash"], timeout=5)
    assert proc.returncode == 0, f"expected exit 0, got {proc.returncode}; stderr={proc.stderr}"
    out = proc.stdout
    # Must NOT start with 'completion:' (the dict-wrapping artifact)
    assert not out.strip().startswith("completion:"), (
        f"completion text output must be raw script, not dict-wrapped; got: {out[:120]!r}"
    )
    # Must NOT be JSON
    assert not out.strip().startswith("{"), (
        f"completion text output must be raw script, not JSON; got: {out[:120]!r}"
    )
    # Must contain the actual bash completion function
    assert "_tracksim_completions" in out, (
        f"expected bash completion function in output; got: {out[:200]!r}"
    )


def test_completion_zsh_text_output_is_raw_script():
    """completion zsh in text mode must print raw zsh script."""
    proc = _run(["completion", "zsh"], timeout=5)
    assert proc.returncode == 0
    out = proc.stdout
    assert not out.strip().startswith("completion:")
    assert not out.strip().startswith("{")
    assert "#compdef tracksim" in out


def test_completion_bash_json_output_has_envelope():
    """completion bash --output json must produce structured JSON envelope."""
    import json
    proc = _run(["completion", "bash", "--output", "json"], timeout=5)
    assert proc.returncode == 0
    obj = json.loads(proc.stdout)
    assert obj["status"] == "ok"
    # The completion script should be inside data
    assert "completion" in obj["data"]
    assert "_tracksim_completions" in obj["data"]["completion"]


def test_completion_bash_ndjson_output_has_envelope():
    """completion bash --output ndjson must produce ndjson result line with envelope."""
    import json
    proc = _run(["completion", "bash", "--output", "ndjson"], timeout=5)
    assert proc.returncode == 0
    obj = json.loads(proc.stdout.strip().splitlines()[-1])
    assert obj["status"] == "ok"
    assert "_tracksim_completions" in obj["data"]["completion"]
