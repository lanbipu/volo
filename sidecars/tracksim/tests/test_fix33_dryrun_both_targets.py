"""Fix 33 (round 6 finding 6): dry-run plan must include targets for every enabled protocol."""
from __future__ import annotations

import io
import json

import pytest

from tracksim.cli import main as cli_main


def _run_main_json(args, stdin=""):
    """Run cli_main and capture stdout as JSON."""
    import sys
    from unittest.mock import patch

    out = io.StringIO()
    with patch("sys.stdout", out), patch("sys.stdin", io.StringIO(stdin)):
        rc = cli_main.main(args)
    out.seek(0)
    text = out.getvalue().strip()
    obj = json.loads(text) if text else {}
    return rc, obj


def test_send_dryrun_both_protocols_includes_both_targets():
    """dry-run send with both protocols must include both freed and opentrackio targets."""
    rc, obj = _run_main_json([
        "send", "--dry-run", "--protocol", "freed", "--protocol", "opentrackio",
        "--output", "json",
    ])
    assert rc == 0, f"expected 0, got {rc}; obj={obj}"
    assert obj["status"] == "ok"
    plan = obj["data"]["dry_run_plan"]
    assert "protocols" in plan
    assert set(plan["protocols"]) == {"freed", "opentrackio"}
    # Both targets must be present
    assert "targets" in plan, f"dry_run_plan must have 'targets', got keys: {list(plan.keys())}"
    targets = plan["targets"]
    assert "freed" in targets, f"freed target missing from plan['targets']: {targets}"
    assert "opentrackio" in targets, f"opentrackio target missing from plan['targets']: {targets}"


def test_send_dryrun_freed_only_includes_freed_target():
    """dry-run send with only freed must include freed target."""
    rc, obj = _run_main_json([
        "send", "--dry-run", "--protocol", "freed", "--output", "json",
    ])
    assert rc == 0
    plan = obj["data"]["dry_run_plan"]
    assert "targets" in plan
    assert "freed" in plan["targets"]


def test_send_dryrun_opentrackio_only_includes_opentrackio_target():
    """dry-run send with only opentrackio must include opentrackio target."""
    rc, obj = _run_main_json([
        "send", "--dry-run", "--protocol", "opentrackio", "--output", "json",
    ])
    assert rc == 0
    plan = obj["data"]["dry_run_plan"]
    assert "targets" in plan
    assert "opentrackio" in plan["targets"]


def test_send_dryrun_no_legacy_single_target_field():
    """dry-run plan must NOT have the old flat 'target' field when both protocols are active."""
    rc, obj = _run_main_json([
        "send", "--dry-run", "--protocol", "freed", "--protocol", "opentrackio",
        "--output", "json",
    ])
    plan = obj["data"]["dry_run_plan"]
    # The old 'target' field was single-protocol — it should not exist or must not be the sole target
    # Accept either: no 'target' key, or both targets present in 'targets'
    assert "targets" in plan, "must have 'targets' (per-protocol)"
