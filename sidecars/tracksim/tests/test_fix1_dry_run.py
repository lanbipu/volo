"""Fix 1: --dry-run in send/run must NOT open transports or build emitters."""
from __future__ import annotations

import argparse
import io

import pytest

from tracksim.cli import main as cli_main
from tracksim.config import load_config


def _make_args(**kwargs) -> argparse.Namespace:
    defaults = {
        "command": "send",
        "subcommand": None,
        "dry_run": False,
        "config": None,
        "output": "json",
        "protocol": None,
        "rate": None,
        "duration": None,
        "pan": None,
        "tilt": None,
        "roll": None,
        "x": None,
        "y": None,
        "z": None,
        "focal_length": None,
        "focus_distance": None,
        "no_input": True,
        "log_level": "info",
        "verbose": 0,
        "quiet": False,
        "no_color": False,
        "yes": False,
        "source": "script",
    }
    defaults.update(kwargs)
    return argparse.Namespace(**defaults)


class TransportOpenedError(Exception):
    pass


def _make_fail_transport_config(monkeypatch):
    """Monkeypatch build_emitters to raise if called."""
    import tracksim.cli.commands.factory as factory

    original = factory.build_emitters

    def fail_build(config, protocols):
        raise TransportOpenedError("build_emitters was called during dry-run!")

    monkeypatch.setattr(factory, "build_emitters", fail_build)


def test_send_dry_run_does_not_open_transport(monkeypatch):
    """send --dry-run must NOT call build_emitters."""
    _make_fail_transport_config(monkeypatch)
    args = _make_args(command="send", dry_run=True, pan=15.0)
    op, data = cli_main._dispatch(
        args, fmt="json", request_id="r1", timestamp="2026-01-01T00:00:00Z"
    )
    assert op == "sim.send"
    assert "dry_run_plan" in data
    plan = data["dry_run_plan"]
    assert isinstance(plan["protocols"], list)


def test_send_dry_run_plan_contains_expected_fields(monkeypatch):
    """dry_run_plan must include protocols, target, and pose info."""
    _make_fail_transport_config(monkeypatch)
    args = _make_args(command="send", dry_run=True, pan=10.0, tilt=5.0, protocol=["freed"])
    op, data = cli_main._dispatch(
        args, fmt="json", request_id="r1", timestamp="2026-01-01T00:00:00Z"
    )
    plan = data["dry_run_plan"]
    assert plan["protocols"] == ["freed"]
    assert "pose" in plan
    assert plan["pose"]["pan"] == 10.0


def test_send_dry_run_with_duration_shows_frames(monkeypatch):
    """send --dry-run with --duration should show frame count in plan."""
    _make_fail_transport_config(monkeypatch)
    args = _make_args(command="send", dry_run=True, duration=1.0, rate=10.0)
    op, data = cli_main._dispatch(
        args, fmt="json", request_id="r1", timestamp="2026-01-01T00:00:00Z"
    )
    plan = data["dry_run_plan"]
    assert plan["frames"] > 0


def test_run_dry_run_does_not_open_transport(monkeypatch):
    """run --dry-run must NOT call build_emitters or build the Simulator."""
    _make_fail_transport_config(monkeypatch)
    args = _make_args(
        command="run", dry_run=True, source="script",
        protocol=["freed"], rate=60.0, duration=None,
    )
    op, data = cli_main._dispatch(
        args, fmt="json", request_id="r1", timestamp="2026-01-01T00:00:00Z"
    )
    assert op == "sim.run"
    assert "dry_run_plan" in data
    plan = data["dry_run_plan"]
    assert "protocols" in plan
    assert "rate" in plan


def test_run_dry_run_plan_fields(monkeypatch):
    """run --dry-run plan must contain protocols, rate, source, max_ticks."""
    _make_fail_transport_config(monkeypatch)
    args = _make_args(
        command="run", dry_run=True, source="script",
        protocol=["freed"], rate=30.0, duration=2.0,
    )
    op, data = cli_main._dispatch(
        args, fmt="json", request_id="r1", timestamp="2026-01-01T00:00:00Z"
    )
    plan = data["dry_run_plan"]
    assert plan["protocols"] == ["freed"]
    assert plan["rate"] == 30.0
    assert plan["source"] == "script"
    assert plan["max_ticks"] == 60  # 2.0 * 30.0
