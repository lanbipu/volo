"""Fix 38 (round 7 finding 4): dry-run send must validate the effective rate (reject 0/NaN/Inf)."""
from __future__ import annotations

import pytest

from tracksim.cli import main as cli_main
from tracksim.config import Config, FreeDCfg


def _run_with_config(monkeypatch, config: Config, extra_args=None):
    """Run main() for 'send --dry-run' with a fake config."""
    import io
    monkeypatch.setattr("sys.stdin", io.StringIO(""))
    # main.py imports load_config as `from tracksim.config import load_config`,
    # so we must patch it in tracksim.cli.main namespace.
    monkeypatch.setattr("tracksim.cli.main.load_config", lambda path, overrides=None: config)
    args = ["send", "--dry-run", "--protocol", "freed", "--output", "json"]
    if extra_args:
        args.extend(extra_args)
    return cli_main.main(args)


# --- Unit tests using main() directly ---

def test_dryrun_send_zero_rate_config_raises(monkeypatch):
    """--dry-run with config rate_hz=0 and --duration must exit 13 (InvalidTrajectoryError)."""
    cfg = Config(freed=FreeDCfg(rate_hz=0.0))
    rc = _run_with_config(monkeypatch, cfg, extra_args=["--duration", "1"])
    assert rc == 13, f"expected exit 13, got {rc}"


def test_dryrun_send_negative_rate_config_raises(monkeypatch):
    """--dry-run with config rate_hz=-1 and --duration must exit 13."""
    cfg = Config(freed=FreeDCfg(rate_hz=-1.0))
    rc = _run_with_config(monkeypatch, cfg, extra_args=["--duration", "1"])
    assert rc == 13, f"expected exit 13, got {rc}"


def test_dryrun_send_nan_rate_via_cli_arg_raises(monkeypatch):
    """--dry-run --rate nan with --duration must exit 13 (caught by earlier --rate validation)."""
    import io
    monkeypatch.setattr("sys.stdin", io.StringIO(""))
    rc = cli_main.main([
        "send", "--dry-run", "--protocol", "freed",
        "--output", "json", "--duration", "1", "--rate", "nan",
    ])
    assert rc == 13, f"expected exit 13, got {rc}"


def test_dryrun_send_valid_rate_and_duration_succeeds(monkeypatch):
    """--dry-run with valid rate and duration must still exit 0."""
    import io
    monkeypatch.setattr("sys.stdin", io.StringIO(""))
    rc = cli_main.main([
        "send", "--dry-run", "--protocol", "freed",
        "--output", "json", "--duration", "1", "--rate", "30",
    ])
    assert rc == 0, f"expected exit 0, got {rc}"


def test_dryrun_send_no_duration_zero_rate_succeeds(monkeypatch):
    """--dry-run without --duration must succeed even if rate is 0 (frames=1, rate not used)."""
    cfg = Config(freed=FreeDCfg(rate_hz=0.0))
    rc = _run_with_config(monkeypatch, cfg)
    assert rc == 0, f"expected exit 0, got {rc}"
