from tracksim.cli.commands.factory import resolve_controller_mapping
from tracksim.config import (
    Config,
    ControllerCfg,
    ControllerMappingEntry,
    DEFAULT_CONTROLLER_MAPPING,
)


def test_empty_mapping_resolves_to_default():
    resolved = resolve_controller_mapping(Config())
    assert [e.source for e in resolved] == [e.source for e in DEFAULT_CONTROLLER_MAPPING]


def test_nonempty_mapping_used_verbatim():
    entry = ControllerMappingEntry(channel="pan", source="rightx")
    cfg = Config(controller=ControllerCfg(mapping=[entry]))
    resolved = resolve_controller_mapping(cfg)
    assert len(resolved) == 1
    assert resolved[0].source == "rightx"
