from tracksim.cli.commands.factory import check_controller_mapping
from tracksim.config import ControllerMappingEntry


def test_clean_mapping_has_no_problems():
    m = [ControllerMappingEntry(channel="focal_length", source="p1", mode="rate")]
    assert check_controller_mapping(m) == []


def test_unknown_channel_flagged():
    probs = check_controller_mapping([ControllerMappingEntry(channel="zoomzoom", source="p1")])
    assert len(probs) == 1 and "channel" in probs[0]


def test_unknown_source_flagged():
    probs = check_controller_mapping([ControllerMappingEntry(channel="pan", source="P1")])
    assert len(probs) == 1 and "source" in probs[0]


def test_unknown_mode_flagged():
    probs = check_controller_mapping([ControllerMappingEntry(channel="pan", source="rightx", mode="ratee")])
    assert any("mode" in p for p in probs)


def test_unknown_modifier_flagged():
    probs = check_controller_mapping([ControllerMappingEntry(channel="pan", source="rightx", modifier="nope")])
    assert any("modifier" in p for p in probs)


def test_default_mapping_is_clean():
    from tracksim.config import DEFAULT_CONTROLLER_MAPPING
    assert check_controller_mapping(DEFAULT_CONTROLLER_MAPPING) == []
