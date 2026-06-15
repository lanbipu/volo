"""Fix 5: When only opentrackio is enabled, use opentrackio.rate_hz not freed.rate_hz.

Before the fix, run/send always defaulted to config.freed.rate_hz regardless
of which protocols were enabled.
"""
from __future__ import annotations

import argparse
import math

import pytest

from tracksim.cli import main as cli_main
from tracksim.config import Config, FreeDCfg, OpenTrackIOCfg, ProtocolsCfg


def _make_otrk_only_config(freed_rate: float = 60.0, otrk_rate: float = 30.0) -> Config:
    """Config with freed disabled, opentrackio enabled, and different rates."""
    return Config(
        protocols=ProtocolsCfg(freed=False, opentrackio=True),
        freed=FreeDCfg(rate_hz=freed_rate),
        opentrackio=OpenTrackIOCfg(rate_hz=otrk_rate),
    )


class TransportOpenedError(Exception):
    pass


def _block_build_emitters(monkeypatch):
    import tracksim.cli.commands.factory as factory

    def fail_build(config, protocols):
        raise TransportOpenedError("emitters built")

    monkeypatch.setattr(factory, "build_emitters", fail_build)


def test_run_dry_run_opentrackio_only_uses_otrk_rate(monkeypatch):
    """run --dry-run with only opentrackio enabled should use opentrackio.rate_hz."""
    _block_build_emitters(monkeypatch)

    # Patch load_config to return our config
    import tracksim.cli.main as cli_main_mod
    otrk_rate = 30.0
    freed_rate = 60.0
    cfg = _make_otrk_only_config(freed_rate=freed_rate, otrk_rate=otrk_rate)
    monkeypatch.setattr(cli_main_mod, "load_config", lambda path: cfg)

    args = argparse.Namespace(
        command="run",
        subcommand=None,
        dry_run=True,
        config=None,
        output="json",
        protocol=None,  # None -> resolved from config (only opentrackio is on)
        rate=None,      # None -> use protocol's rate
        duration=2.0,
        source="script",
        no_input=True,
        log_level="info",
        verbose=0,
        quiet=False,
        no_color=False,
        yes=False,
    )

    op, data = cli_main._dispatch(
        args, fmt="json", request_id="r1", timestamp="2026-01-01T00:00:00Z"
    )

    plan = data["dry_run_plan"]
    assert plan["rate"] == otrk_rate, f"Expected rate {otrk_rate}, got {plan['rate']}"
    assert plan["rate"] != freed_rate, "Must NOT use freed.rate_hz when freed is disabled"
    assert plan["max_ticks"] == math.ceil(2.0 * otrk_rate)  # 60


def test_send_dry_run_opentrackio_only_uses_otrk_rate(monkeypatch):
    """send --dry-run with only opentrackio enabled should use opentrackio.rate_hz for hold."""
    _block_build_emitters(monkeypatch)

    import tracksim.cli.main as cli_main_mod
    otrk_rate = 25.0
    freed_rate = 60.0
    cfg = _make_otrk_only_config(freed_rate=freed_rate, otrk_rate=otrk_rate)
    monkeypatch.setattr(cli_main_mod, "load_config", lambda path: cfg)

    args = argparse.Namespace(
        command="send",
        subcommand=None,
        dry_run=True,
        config=None,
        output="json",
        protocol=None,
        rate=None,
        duration=1.0,
        pan=None, tilt=None, roll=None, x=None, y=None, z=None,
        focal_length=None, focus_distance=None,
        no_input=True,
        log_level="info",
        verbose=0,
        quiet=False,
        no_color=False,
        yes=False,
    )

    op, data = cli_main._dispatch(
        args, fmt="json", request_id="r1", timestamp="2026-01-01T00:00:00Z"
    )

    plan = data["dry_run_plan"]
    # frames = ceil(1.0 * otrk_rate) = 25
    assert plan["frames"] == math.ceil(1.0 * otrk_rate), f"got frames={plan['frames']}"


def test_send_hold_with_otrk_only_uses_otrk_rate_not_freed(monkeypatch):
    """Live send path: hold duration frames must be computed from opentrackio rate."""
    import tracksim.cli.main as cli_main_mod
    from tracksim.cli.commands import send as send_cmd_mod

    freed_rate = 60.0
    otrk_rate = 20.0  # distinct: if freed rate is accidentally used, frames will be 60 not 20
    cfg = _make_otrk_only_config(freed_rate=freed_rate, otrk_rate=otrk_rate)
    monkeypatch.setattr(cli_main_mod, "load_config", lambda path: cfg)

    holds = {}

    original_send_hold = send_cmd_mod.send_hold

    def capture_send_hold(emitters, pose, *, clock, rate, duration):
        holds["rate"] = rate
        return original_send_hold(emitters, pose, clock=clock, rate=rate, duration=duration)

    monkeypatch.setattr(send_cmd_mod, "send_hold", capture_send_hold)

    class FakeEmitter:
        name = "opentrackio"
        def emit(self, pose): pass
        def close(self): pass

    import tracksim.cli.commands.factory as factory
    monkeypatch.setattr(factory, "build_emitters", lambda cfg, protocols: [FakeEmitter()])

    from tracksim.infra.clock import FakeClock

    monkeypatch.setattr(cli_main_mod, "WallClock", FakeClock)

    args = argparse.Namespace(
        command="send",
        subcommand=None,
        dry_run=False,
        config=None,
        output="json",
        protocol=None,
        rate=None,
        duration=1.0,
        pan=None, tilt=None, roll=None, x=None, y=None, z=None,
        focal_length=None, focus_distance=None,
        no_input=True,
        log_level="info",
        verbose=0,
        quiet=False,
        no_color=False,
        yes=False,
    )

    cli_main._dispatch(args, fmt="json", request_id="r1", timestamp="2026-01-01T00:00:00Z")

    assert holds.get("rate") == otrk_rate, (
        f"send_hold was called with rate={holds.get('rate')}, expected otrk_rate={otrk_rate}. "
        "Likely freed.rate_hz was used instead."
    )


def test_run_dry_run_freed_only_uses_freed_rate(monkeypatch):
    """run --dry-run with only freed enabled should use freed.rate_hz."""
    _block_build_emitters(monkeypatch)

    import tracksim.cli.main as cli_main_mod
    from tracksim.config import Config, FreeDCfg, OpenTrackIOCfg, ProtocolsCfg
    freed_rate = 50.0
    otrk_rate = 25.0
    cfg = Config(
        protocols=ProtocolsCfg(freed=True, opentrackio=False),
        freed=FreeDCfg(rate_hz=freed_rate),
        opentrackio=OpenTrackIOCfg(rate_hz=otrk_rate),
    )
    monkeypatch.setattr(cli_main_mod, "load_config", lambda path: cfg)

    args = argparse.Namespace(
        command="run",
        subcommand=None,
        dry_run=True,
        config=None,
        output="json",
        protocol=None,
        rate=None,
        duration=1.0,
        source="script",
        no_input=True,
        log_level="info",
        verbose=0,
        quiet=False,
        no_color=False,
        yes=False,
    )

    op, data = cli_main._dispatch(
        args, fmt="json", request_id="r1", timestamp="2026-01-01T00:00:00Z"
    )

    plan = data["dry_run_plan"]
    assert plan["rate"] == freed_rate
    assert plan["rate"] != otrk_rate
