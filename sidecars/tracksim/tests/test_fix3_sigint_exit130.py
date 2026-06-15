"""Fix 3: SIGINT during run should return exit code 130."""
from __future__ import annotations

import signal
from unittest.mock import patch

import pytest

from tracksim.cli import main as cli_main
from tracksim.envelope import EXIT_SIGINT


def test_install_sigint_returns_is_interrupted_predicate():
    """After fix: _install_sigint returns a callable that becomes truthy on SIGINT."""
    sim_mock = type("S", (), {"stop": lambda self: None})()

    handlers = {}
    original_signal = signal.signal

    def capture(signum, h):
        handlers[signum] = h
        return original_signal(signum, h)

    with patch("signal.signal", side_effect=capture):
        result = cli_main._install_sigint(sim_mock)

    assert result is not None, "_install_sigint must return an is_interrupted predicate"
    assert not result(), "before SIGINT: is_interrupted() must be False"

    # Fire SIGINT
    handlers[signal.SIGINT](signal.SIGINT, None)

    assert result(), "after SIGINT: is_interrupted() must be True"


def test_install_sigint_still_calls_sim_stop():
    """The SIGINT handler must still call sim.stop() after the fix."""
    stopped = []
    sim_mock = type("S", (), {"stop": lambda self: stopped.append(True)})()

    handlers = {}
    original_signal = signal.signal

    def capture(signum, h):
        handlers[signum] = h
        return original_signal(signum, h)

    with patch("signal.signal", side_effect=capture):
        cli_main._install_sigint(sim_mock)

    handlers[signal.SIGINT](signal.SIGINT, None)
    assert stopped, "SIGINT handler must call sim.stop()"
