import pytest

from tracksim.cli.commands import factory
from tracksim.config import load_config
from tracksim.domain.errors import UnsupportedProtocolError
from tracksim.emitters.freed import FreeDEmitter
from tracksim.emitters.opentrackio import OpenTrackIOEmitter
from tracksim.infra.clock import FakeClock
from tracksim.sources.static import StaticPoseSource
from tracksim.sources.scripted import ScriptedPoseSource


def test_build_emitters_freed_only():
    cfg = load_config(None)
    emitters = factory.build_emitters(cfg, ["freed"])
    assert len(emitters) == 1
    assert isinstance(emitters[0], FreeDEmitter)
    assert emitters[0].name == "freed"
    for e in emitters:
        e.close()


def test_build_emitters_both_protocols():
    cfg = load_config(None)
    emitters = factory.build_emitters(cfg, ["freed", "opentrackio"])
    names = {e.name for e in emitters}
    assert names == {"freed", "opentrackio"}
    assert any(isinstance(e, OpenTrackIOEmitter) for e in emitters)
    for e in emitters:
        e.close()


def test_build_freed_wires_zoom_focus_scaling_from_config():
    """REGRESSION: _build_freed must pass zoom/focus lsb factors from config into
    FreeDScaling. Without this wiring FreeD zoom/focus stay 0 regardless of config."""
    cfg = load_config(
        None,
        overrides={"freed": {"scaling": {"zoom_lsb_per_mm": 1234.0, "focus_lsb_per_m": 5678.0}}},
    )
    emitters = factory.build_emitters(cfg, ["freed"])
    try:
        scaling = emitters[0]._scaling
        assert scaling.zoom_lsb_per_mm == 1234.0
        assert scaling.focus_lsb_per_m == 5678.0
    finally:
        for e in emitters:
            e.close()


def test_build_emitters_unknown_protocol_raises():
    cfg = load_config(None)
    with pytest.raises(UnsupportedProtocolError):
        factory.build_emitters(cfg, ["bogus"])


def test_build_source_static():
    cfg = load_config(None)
    clock = FakeClock()
    src = factory.build_source(cfg, "static", rate=60.0, clock=clock)
    assert isinstance(src, StaticPoseSource)
    src.close()


def test_build_source_script():
    cfg = load_config(None)
    clock = FakeClock()
    src = factory.build_source(cfg, "script", rate=60.0, clock=clock)
    assert isinstance(src, ScriptedPoseSource)
    src.close()
