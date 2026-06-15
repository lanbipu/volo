"""Fix 31 (round 6 finding 4): send must validate pose before opening transports."""
from __future__ import annotations

import pytest

from tracksim.cli import main as cli_main
from tracksim.config import Config, FreeDCfg, ProtocolsCfg
from tracksim.domain.errors import InvalidTrajectoryError


class _NeverOpenedError(Exception):
    """Raised if the serial factory is called — proves transport was opened."""
    pass


def _make_never_open_emitter():
    """Returns an emitter object whose construction raises if called."""
    raise _NeverOpenedError("transport was opened before pose was validated")


def test_send_invalid_pose_does_not_open_transport(monkeypatch):
    """Invalid pose (nan pan) must fail with INVALID_TRAJECTORY before any transport opens."""
    opened = []

    # Monkeypatch build_emitters to track whether it was called
    import tracksim.cli.commands.factory as factory_mod

    original_build = factory_mod.build_emitters

    def spy_build_emitters(config, protocols):
        opened.append(True)
        # Return a minimal fake emitter so we can confirm it's never reached
        class _FakeEmitter:
            name = "freed"
            def emit(self, pose): pass
            def close(self): pass
        return [_FakeEmitter()]

    monkeypatch.setattr(factory_mod, "build_emitters", spy_build_emitters)

    # Patch stdin to avoid isatty issues
    import io
    import sys
    monkeypatch.setattr("sys.stdin", io.StringIO(""))

    # Call dispatch with an invalid pan (nan was rejected at argparse float() level,
    # but we can simulate by calling build_pose directly with bad value)
    # Instead test via the main entry point with monkeypatched stdin
    # Use a bad stdin JSON with non-finite value to trigger InvalidTrajectoryError from build_pose

    # Actually the cleanest test: monkeypatch build_pose to raise, assert build_emitters not called
    import tracksim.cli.commands.send as send_mod

    original_build_pose = send_mod.build_pose

    def raising_build_pose(flags, stdin_obj):
        raise InvalidTrajectoryError("bad pose", details={})

    monkeypatch.setattr(send_mod, "build_pose", raising_build_pose)

    args_list = ["send", "--protocol", "freed", "--output", "json"]
    rc = cli_main.main(args_list)

    # Must exit 13 (INVALID_TRAJECTORY)
    assert rc == 13, f"expected 13, got {rc}"
    # build_emitters must NOT have been called
    assert not opened, "build_emitters must not be called before pose validation"


def test_send_valid_pose_does_open_transport(monkeypatch):
    """Sanity: valid pose must open transport (build_emitters called)."""
    opened = []

    import tracksim.cli.commands.factory as factory_mod

    def spy_build_emitters(config, protocols):
        opened.append(True)
        class _FakeEmitter:
            name = "freed"
            def emit(self, pose): pass
            def close(self): pass
        return [_FakeEmitter()]

    monkeypatch.setattr(factory_mod, "build_emitters", spy_build_emitters)

    import io
    monkeypatch.setattr("sys.stdin", io.StringIO(""))

    args_list = ["send", "--protocol", "freed", "--output", "json"]
    rc = cli_main.main(args_list)

    assert rc == 0, f"expected 0, got {rc}"
    assert opened, "build_emitters must be called for valid pose"
