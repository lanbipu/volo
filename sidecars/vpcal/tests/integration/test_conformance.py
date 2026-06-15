"""Manifest ↔ CLI alignment + mandatory-flag conformance (CLI_DESIGN_SPEC §2.3, §3.2)."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from vpcal.cli.main import cli
from vpcal.models.manifest import build_manifest

SRC = str(Path(__file__).resolve().parents[2] / "src")


def _run(*args):
    return subprocess.run(
        [sys.executable, "-m", "vpcal.cli.main", *args],
        capture_output=True, text=True, env=dict(os.environ, PYTHONPATH=SRC),
    )


def test_every_manifest_command_exists_in_cli():
    manifest = build_manifest()
    for op in manifest.operations:
        # op.cli.command == "vpcal <group> <sub>"; verify --help resolves (exit 0).
        parts = op.cli.command.split()[1:]  # drop "vpcal"
        r = _run(*parts, "--help")
        assert r.returncode == 0, f"{op.cli.command} --help failed"


def test_manifest_ids_match_cli_self_description():
    r = _run("manifest", "--output", "json")
    cli_ids = sorted(o["operation_id"] for o in json.loads(r.stdout)["data"]["operations"])
    manifest_ids = sorted(o.operation_id for o in build_manifest().operations)
    assert cli_ids == manifest_ids


@pytest.mark.parametrize("cmd", [
    ["quick", "run"], ["pattern", "generate"], ["screen", "create"],
    ["screen", "import"], ["simulate"], ["report", "generate"],
    ["export", "opentrackio"], ["version"], ["manifest"], ["schema"],
])
def test_mandatory_output_flag_present(cmd):
    r = _run(*cmd, "--help")
    assert r.returncode == 0
    assert "--output" in r.stdout


@pytest.mark.parametrize("cmd", [
    ["quick", "run"], ["pattern", "generate"], ["simulate"], ["screen", "create"],
])
def test_dry_run_flag_present(cmd):
    r = _run(*cmd, "--help")
    assert "--dry-run" in r.stdout


def test_exit_codes_documented():
    # All exit codes referenced by operations are within the spec table.
    valid = {0, 1, 2, 3, 4, 5, 6, 7, 8, 9}
    for op in build_manifest().operations:
        assert set(op.exit_codes) <= valid


def test_all_commands_registered():
    names = set(cli.commands.keys())
    assert {"quick", "pattern", "screen", "simulate", "report", "export",
            "manifest", "schema", "completion", "version"} <= names
