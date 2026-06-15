import logging

from tracksim.cli.commands.factory import warn_controller_mapping
from tracksim.config import ControllerMappingEntry


def test_warn_logs_problems_without_raising(caplog):
    m = [ControllerMappingEntry(channel="nope", source="alsobad")]
    with caplog.at_level(logging.WARNING, logger="tracksim"):
        warn_controller_mapping(m, logging.getLogger("tracksim"))
    text = " ".join(r.message for r in caplog.records)
    assert "channel" in text and "source" in text


def test_warn_clean_mapping_logs_nothing(caplog):
    m = [ControllerMappingEntry(channel="pan", source="rightx")]
    with caplog.at_level(logging.WARNING, logger="tracksim"):
        warn_controller_mapping(m, logging.getLogger("tracksim"))
    assert caplog.records == []
