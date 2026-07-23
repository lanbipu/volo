"""``capture video`` graceful finish (Phase 1.3 of the structured-light fixed
calibration plan): before this, ``video`` had no stdin control protocol
(unlike ``stills``/``session``), so the only way the Volo bridge could stop a
--duration-bounded recording early was close-stdin -> 3s grace -> SIGKILL,
which cannot guarantee frames.jsonl / the last frame write landed. This test
proves ``{"cmd":"finish"}`` now stops the process promptly (well under the
configured --duration) with a clean exit and a fully flushed manifest.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

SRC = str(Path(__file__).resolve().parents[2] / "src")


def _spawn(*args):
    env = dict(os.environ, PYTHONPATH=SRC)
    return subprocess.Popen(
        [sys.executable, "-m", "vpcal.cli.main", *args],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, env=env,
    )


def test_finish_stops_before_duration_elapses(tmp_path):
    out_dir = tmp_path / "video"
    # Long --duration: if finish did nothing, the process would still be
    # running (and this test would time out) long after the assertions below.
    proc = _spawn(
        "capture", "video", "--backend", "synthetic",
        "--duration", "30", "--out", str(out_dir), "--output", "ndjson",
    )
    try:
        # Wait for at least one frame to be captured before asking it to stop,
        # so the manifest-completeness assertion below is meaningful.
        deadline = time.monotonic() + 5.0
        saw_source_info = False
        while time.monotonic() < deadline:
            line = proc.stdout.readline()
            if not line:
                break
            evt = json.loads(line)
            if evt.get("type") == "source_info":
                saw_source_info = True
                break
        assert saw_source_info, "capture video never emitted source_info"

        t_finish = time.monotonic()
        proc.stdin.write(json.dumps({"cmd": "finish"}) + "\n")
        proc.stdin.flush()
        proc.stdin.close()

        returncode = proc.wait(timeout=5.0)
        elapsed_since_finish = time.monotonic() - t_finish
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=5.0)

    assert returncode == 0, proc.stderr.read()
    # Must exit promptly on finish, not ride out the 30s --duration.
    assert elapsed_since_finish < 5.0

    remaining_lines = [json.loads(ln) for ln in proc.stdout if ln.strip()]
    result = next(evt for evt in remaining_lines if evt.get("type") == "result")
    data = result["data"]
    assert data["frames"] > 0
    assert data["elapsed_s"] < 5.0  # short recording, not the full 30s duration
    assert data["out_dir"] == str(out_dir)

    manifest_path = out_dir / "frames.jsonl"
    assert manifest_path.exists()
    manifest_lines = manifest_path.read_text().strip().splitlines()
    assert len(manifest_lines) == data["frames"]
    for ln in manifest_lines:
        json.loads(ln)  # every manifest line is valid, complete JSON (no truncated write)
    png_files = sorted(out_dir.glob("*.png"))
    assert len(png_files) == data["frames"]


def test_non_object_control_line_does_not_kill_the_control_thread(tmp_path):
    """A stray valid-JSON-but-non-dict control line (a bare scalar/list) must
    not crash the stdin-pump thread — a subsequent legitimate finish command
    must still be honored."""
    out_dir = tmp_path / "video"
    proc = _spawn(
        "capture", "video", "--backend", "synthetic",
        "--duration", "30", "--out", str(out_dir), "--output", "ndjson",
    )
    try:
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            line = proc.stdout.readline()
            if not line:
                break
            if json.loads(line).get("type") == "source_info":
                break

        proc.stdin.write("5\n")  # valid JSON, not a dict — must not raise
        proc.stdin.flush()
        proc.stdin.write(json.dumps({"cmd": "finish"}) + "\n")
        proc.stdin.flush()
        proc.stdin.close()

        returncode = proc.wait(timeout=5.0)
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=5.0)

    assert returncode == 0, proc.stderr.read()
    remaining_lines = [json.loads(ln) for ln in proc.stdout if ln.strip()]
    assert any(evt.get("type") == "result" for evt in remaining_lines)


def test_bare_stdin_eof_does_not_truncate_a_duration_bound_run(tmp_path):
    """A --duration-bound run invoked without a live control pipe (a plain
    shell/CI/subprocess caller that never writes to or holds stdin open, e.g.
    the project's own subprocess.run-based CLI tests) must still run its
    requested duration — bare EOF is NOT finish outside monitor mode. Only an
    explicit {"cmd":"finish"} line (see test above) stops it early; anything
    else would silently truncate every headless/CI invocation of this
    command to ~1 frame."""
    out_dir = tmp_path / "video"
    duration_s = 2.0
    proc = _spawn(
        "capture", "video", "--backend", "synthetic",
        "--duration", str(duration_s), "--out", str(out_dir), "--output", "ndjson",
    )
    try:
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            line = proc.stdout.readline()
            if not line:
                break
            if json.loads(line).get("type") == "source_info":
                break

        proc.stdin.close()  # EOF, no explicit {"cmd":"finish"} line
        # Must still be running well past when a (buggy) EOF-triggers-finish
        # implementation would have exited.
        time.sleep(1.0)
        assert proc.poll() is None, "process exited early on bare stdin EOF"

        returncode = proc.wait(timeout=5.0)
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=5.0)

    assert returncode == 0
    remaining_lines = [json.loads(ln) for ln in proc.stdout if ln.strip()]
    result = next(evt for evt in remaining_lines if evt.get("type") == "result")
    assert result["data"]["elapsed_s"] >= duration_s * 0.9  # ran its full duration


def test_monitor_mode_still_treats_stdin_eof_as_finish(tmp_path):
    """Preserves the original narrow behavior: duration=0 + a live preview
    (the Volo UI's open-ended monitor mode) must still exit promptly on
    stdin EOF, since a hard kill only lands after the bridge's 3s grace."""
    out_dir = tmp_path / "video"
    proc = _spawn(
        "capture", "video", "--backend", "synthetic",
        "--duration", "0", "--preview-port", "0",
        "--out", str(out_dir), "--output", "ndjson",
    )
    try:
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            line = proc.stdout.readline()
            if not line:
                break
            if json.loads(line).get("type") == "source_info":
                break

        t_close = time.monotonic()
        proc.stdin.close()  # EOF, no explicit {"cmd":"finish"} line
        returncode = proc.wait(timeout=5.0)
        elapsed_since_close = time.monotonic() - t_close
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=5.0)

    assert returncode == 0
    assert elapsed_since_close < 5.0
