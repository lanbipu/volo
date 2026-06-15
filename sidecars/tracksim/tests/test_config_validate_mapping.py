import pytest

from tracksim.cli.commands import config_cmd
from tracksim.config import Config, ControllerCfg, ControllerMappingEntry
from tracksim.domain.errors import ConfigError


def test_validate_rejects_bad_mapping():
    cfg = Config(controller=ControllerCfg(
        mapping=[ControllerMappingEntry(channel="nope", source="p1")]
    ))
    with pytest.raises(ConfigError) as exc:
        config_cmd.validate(cfg)
    assert exc.value.exit_code == 3
    assert "problems" in exc.value.details


def test_validate_accepts_clean_mapping():
    cfg = Config(controller=ControllerCfg(
        mapping=[ControllerMappingEntry(channel="focal_length", source="p1")]
    ))
    _op, data = config_cmd.validate(cfg)
    assert data["valid"] is True


def test_validate_accepts_empty_mapping():
    _op, data = config_cmd.validate(Config())
    assert data["valid"] is True
