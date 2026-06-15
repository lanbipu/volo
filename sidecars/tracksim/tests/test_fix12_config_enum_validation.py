"""Fix 12 (round 2 finding 5): Validate opentrackio.encoding and freed.scaling.variant enums."""
from __future__ import annotations

import pytest

from tracksim.cli.commands import factory
from tracksim.config import Config, FreeDCfg, FreeDScalingCfg, OpenTrackIOCfg, ProtocolsCfg
from tracksim.domain.errors import ConfigError


def _otrk_cfg_with_encoding(encoding: str) -> Config:
    return Config(
        protocols=ProtocolsCfg(freed=False, opentrackio=True),
        opentrackio=OpenTrackIOCfg(encoding=encoding),
    )


def _freed_cfg_with_variant(variant: str) -> Config:
    return Config(
        protocols=ProtocolsCfg(freed=True, opentrackio=False),
        freed=FreeDCfg(scaling=FreeDScalingCfg(variant=variant)),
    )


def test_opentrackio_unknown_encoding_raises_config_error():
    """opentrackio.encoding='xml' must raise ConfigError (exit 3)."""
    cfg = _otrk_cfg_with_encoding("xml")
    with pytest.raises(ConfigError) as exc_info:
        factory.build_emitters(cfg, ["opentrackio"])
    assert exc_info.value.exit_code == 3
    assert exc_info.value.code == "CONFIG_ERROR"


def test_opentrackio_encoding_json_is_valid():
    """opentrackio.encoding='json' must not raise."""
    cfg = _otrk_cfg_with_encoding("json")
    emitters = factory.build_emitters(cfg, ["opentrackio"])
    assert len(emitters) == 1
    for e in emitters:
        e.close()


def test_opentrackio_encoding_cbor_is_valid():
    """opentrackio.encoding='cbor' must not raise."""
    cfg = _otrk_cfg_with_encoding("cbor")
    emitters = factory.build_emitters(cfg, ["opentrackio"])
    assert len(emitters) == 1
    for e in emitters:
        e.close()


def test_freed_unknown_scaling_variant_raises_config_error():
    """freed.scaling.variant='unknown' must raise ConfigError (exit 3)."""
    cfg = _freed_cfg_with_variant("unknown_variant")
    with pytest.raises(ConfigError) as exc_info:
        factory.build_emitters(cfg, ["freed"])
    assert exc_info.value.exit_code == 3
    assert exc_info.value.code == "CONFIG_ERROR"


def test_freed_scaling_variant_native_is_valid():
    """freed.scaling.variant='native' must not raise."""
    cfg = _freed_cfg_with_variant("native")
    emitters = factory.build_emitters(cfg, ["freed"])
    assert len(emitters) == 1
    for e in emitters:
        e.close()


def test_freed_scaling_variant_radamec_is_valid():
    """freed.scaling.variant='radamec' must not raise."""
    cfg = _freed_cfg_with_variant("radamec")
    emitters = factory.build_emitters(cfg, ["freed"])
    assert len(emitters) == 1
    for e in emitters:
        e.close()
