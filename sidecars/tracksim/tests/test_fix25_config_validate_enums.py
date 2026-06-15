"""Fix 25 (round 5 finding 2): config validate must reject invalid enum values."""
from __future__ import annotations

import pytest

from tracksim.cli.commands import config_cmd
from tracksim.config import (
    Config,
    FreeDCfg,
    FreeDScalingCfg,
    OpenTrackIOCfg,
    ProtocolsCfg,
)
from tracksim.domain.errors import ConfigError


def _make_config(**overrides) -> Config:
    kwargs = {}
    kwargs.update(overrides)
    return Config(**kwargs)


def test_validate_bad_freed_transport_raises_config_error():
    cfg = Config(freed=FreeDCfg(transport="bogus"))
    with pytest.raises(ConfigError) as exc_info:
        config_cmd.validate(cfg)
    assert exc_info.value.exit_code == 3


def test_validate_bad_opentrackio_transport_raises_config_error():
    cfg = Config(opentrackio=OpenTrackIOCfg(transport="ftp"))
    with pytest.raises(ConfigError) as exc_info:
        config_cmd.validate(cfg)
    assert exc_info.value.exit_code == 3


def test_validate_bad_opentrackio_encoding_raises_config_error():
    cfg = Config(opentrackio=OpenTrackIOCfg(encoding="xml"))
    with pytest.raises(ConfigError) as exc_info:
        config_cmd.validate(cfg)
    assert exc_info.value.exit_code == 3


def test_validate_bad_freed_scaling_variant_raises_config_error():
    cfg = Config(freed=FreeDCfg(scaling=FreeDScalingCfg(variant="foo")))
    with pytest.raises(ConfigError) as exc_info:
        config_cmd.validate(cfg)
    assert exc_info.value.exit_code == 3


def test_validate_good_config_returns_valid_true():
    from tracksim.config import load_config
    cfg = load_config(None)
    op, data = config_cmd.validate(cfg)
    assert op == "config.validate"
    assert data["valid"] is True
