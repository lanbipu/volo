"""Fix 32 (round 6 finding 5): source.close() must be called if build_emitters raises."""
from __future__ import annotations

import pytest

from tracksim.cli import main as cli_main
from tracksim.domain.errors import ConfigError


class _FakeSource:
    """Minimal fake pose source that tracks close() calls."""
    closed = False

    def close(self):
        _FakeSource.closed = True

    def get_pose(self):
        from tracksim.domain.pose import CameraPose
        return CameraPose()


def test_controller_source_closed_when_build_emitters_raises(monkeypatch):
    """If build_emitters raises after source is opened, source.close() must still be called."""
    import tracksim.cli.commands.factory as factory_mod

    close_calls = []

    class TrackingSource:
        def close(self):
            close_calls.append("closed")

        def next(self, dt: float):
            from tracksim.domain.pose import CameraPose
            return CameraPose()

    source = TrackingSource()

    # Monkeypatch build_source to return our tracking source
    def fake_build_source(config, src_name, **kwargs):
        return source

    monkeypatch.setattr(factory_mod, "build_source", fake_build_source)

    # Monkeypatch build_emitters to raise
    def raising_build_emitters(config, protocols):
        raise ConfigError("emitter setup failed", details={})

    monkeypatch.setattr(factory_mod, "build_emitters", raising_build_emitters)

    # Monkeypatch stdin to be non-tty (avoid SDL init)
    import io
    monkeypatch.setattr("sys.stdin", io.StringIO(""))

    # Use --source script (not controller) to avoid SDL path
    args_list = ["run", "--source", "script", "--protocol", "freed",
                 "--output", "json", "--duration", "0.1"]
    rc = cli_main.main(args_list)

    # Should exit with config error (exit 3)
    assert rc == 3, f"expected 3, got {rc}"
    # Source must have been closed
    assert close_calls, "source.close() must be called even when build_emitters raises"


def test_controller_source_not_closed_on_successful_run(monkeypatch):
    """Sanity: source.close() in the finally block is what closes it on success."""
    import tracksim.cli.commands.factory as factory_mod
    import tracksim.cli.commands.run as run_mod

    close_calls = []

    class TrackingSource:
        def close(self):
            close_calls.append("closed")

        def next(self, dt: float):
            from tracksim.domain.pose import CameraPose
            return CameraPose()

    source = TrackingSource()
    monkeypatch.setattr(factory_mod, "build_source", lambda *a, **kw: source)

    class FakeEmitter:
        name = "freed"
        def emit(self, pose): pass
        def close(self): pass

    monkeypatch.setattr(factory_mod, "build_emitters", lambda *a, **kw: [FakeEmitter()])

    import io
    monkeypatch.setattr("sys.stdin", io.StringIO(""))

    args_list = ["run", "--source", "script", "--protocol", "freed",
                 "--output", "json", "--duration", "0.01", "--rate", "100"]
    rc = cli_main.main(args_list)

    assert rc == 0, f"expected 0, got {rc}"
    assert close_calls, "source must be closed after successful run"
