"""Fix 37 (round 7 finding 3): already-built emitters must be closed if a later builder raises."""
from __future__ import annotations

import pytest

from tracksim.cli.commands import factory
from tracksim.config import Config
from tracksim.domain.errors import ConfigError, UnsupportedProtocolError


# --- Test using monkeypatch to make the opentrackio builder raise ---

def test_first_emitter_closed_when_second_builder_raises(monkeypatch):
    """If freed emitter is built and opentrackio builder raises, freed emitter must be closed."""
    close_calls = []

    class TrackingEmitter:
        name = "freed"

        def emit(self, pose):
            pass

        def close(self):
            close_calls.append("freed_closed")

    # Monkeypatch _build_freed to return a tracking emitter
    monkeypatch.setattr(factory, "_build_freed", lambda cfg: TrackingEmitter())

    # Monkeypatch _build_opentrackio to raise
    def raising_opentrackio(cfg):
        raise ConfigError("opentrackio setup failed", details={})

    monkeypatch.setattr(factory, "_build_opentrackio", raising_opentrackio)

    cfg = Config()
    with pytest.raises(ConfigError, match="opentrackio setup failed"):
        factory.build_emitters(cfg, ["freed", "opentrackio"])

    # The freed emitter that was already built must have been closed
    assert close_calls == ["freed_closed"], (
        f"Expected freed emitter to be closed, got close_calls={close_calls!r}"
    )


def test_original_exception_propagates_after_cleanup(monkeypatch):
    """The original exception must propagate (not be swallowed by cleanup)."""
    class TrackingEmitter:
        name = "freed"
        def emit(self, pose): pass
        def close(self): pass

    monkeypatch.setattr(factory, "_build_freed", lambda cfg: TrackingEmitter())

    sentinel = UnsupportedProtocolError("specific error", details={})

    def raising_opentrackio(cfg):
        raise sentinel

    monkeypatch.setattr(factory, "_build_opentrackio", raising_opentrackio)

    cfg = Config()
    with pytest.raises(UnsupportedProtocolError) as exc_info:
        factory.build_emitters(cfg, ["freed", "opentrackio"])

    assert exc_info.value is sentinel, "Original exception identity must be preserved"


def test_no_emitters_built_when_first_builder_raises(monkeypatch):
    """If the first builder raises, nothing needs closing (and nothing crashes)."""
    def raising_freed(cfg):
        raise ConfigError("freed setup failed", details={})

    monkeypatch.setattr(factory, "_build_freed", raising_freed)

    cfg = Config()
    with pytest.raises(ConfigError, match="freed setup failed"):
        factory.build_emitters(cfg, ["freed", "opentrackio"])
    # Should reach here without error from cleanup logic


def test_both_emitters_closed_when_third_builder_raises(monkeypatch):
    """If three protocols are requested and the third raises, the first two must be closed."""
    close_calls = []

    class TrackingEmitter:
        def __init__(self, name):
            self.name = name

        def emit(self, pose): pass

        def close(self):
            close_calls.append(f"{self.name}_closed")

    monkeypatch.setattr(factory, "_build_freed", lambda cfg: TrackingEmitter("freed"))
    monkeypatch.setattr(factory, "_build_opentrackio", lambda cfg: TrackingEmitter("opentrackio"))

    cfg = Config()
    # Use an unknown protocol as the third — will hit the UnsupportedProtocolError branch
    with pytest.raises(UnsupportedProtocolError):
        factory.build_emitters(cfg, ["freed", "opentrackio", "bogus"])

    assert "freed_closed" in close_calls, "freed emitter must be closed"
    assert "opentrackio_closed" in close_calls, "opentrackio emitter must be closed"
