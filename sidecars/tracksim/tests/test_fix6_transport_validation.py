"""Fix 6: factory.build_emitters must raise ConfigError on unknown transport value."""
from __future__ import annotations

import pytest

from tracksim.cli.commands import factory
from tracksim.config import Config, FreeDCfg, OpenTrackIOCfg, ProtocolsCfg
from tracksim.domain.errors import ConfigError


def _freed_cfg_with_transport(transport: str) -> Config:
    return Config(
        protocols=ProtocolsCfg(freed=True, opentrackio=False),
        freed=FreeDCfg(transport=transport),
    )


def _otrk_cfg_with_transport(transport: str) -> Config:
    return Config(
        protocols=ProtocolsCfg(freed=False, opentrackio=True),
        opentrackio=OpenTrackIOCfg(transport=transport),
    )


def test_build_freed_unknown_transport_raises_config_error():
    """freed.transport='bogus' must raise ConfigError (exit 3)."""
    cfg = _freed_cfg_with_transport("bogus")
    with pytest.raises(ConfigError) as exc_info:
        factory.build_emitters(cfg, ["freed"])
    assert exc_info.value.exit_code == 3
    assert exc_info.value.code == "CONFIG_ERROR"


def test_build_otrk_unknown_transport_raises_config_error():
    """opentrackio.transport='bogus' must raise ConfigError (exit 3)."""
    cfg = _otrk_cfg_with_transport("bogus_otrk")
    with pytest.raises(ConfigError) as exc_info:
        factory.build_emitters(cfg, ["opentrackio"])
    assert exc_info.value.exit_code == 3
    assert exc_info.value.code == "CONFIG_ERROR"


def test_build_freed_valid_udp_transports_do_not_raise():
    """Valid freed UDP transports must not raise ConfigError."""
    for transport in ("udp_unicast", "udp_broadcast"):
        cfg = Config(
            protocols=ProtocolsCfg(freed=True, opentrackio=False),
            freed=FreeDCfg(transport=transport),
        )
        emitters = factory.build_emitters(cfg, ["freed"])
        assert len(emitters) == 1
        for e in emitters:
            e.close()


def test_build_freed_serial_transport_does_not_raise_config_error():
    """freed.transport='serial' must not raise ConfigError (may raise TransportError on bad device)."""
    from tracksim.domain.errors import TransportError
    cfg = Config(
        protocols=ProtocolsCfg(freed=True, opentrackio=False),
        freed=FreeDCfg(transport="serial", serial_device="/dev/null"),
    )
    try:
        emitters = factory.build_emitters(cfg, ["freed"])
        for e in emitters:
            e.close()
    except (TransportError, Exception) as exc:
        # SerialTransport may fail to open on /dev/null, but must not be ConfigError
        assert not isinstance(exc, ConfigError), f"ConfigError raised for serial transport: {exc}"


def test_build_otrk_valid_transports_do_not_raise():
    """Valid opentrackio transports must not raise."""
    for transport in ("unicast", "multicast"):
        cfg = Config(
            protocols=ProtocolsCfg(freed=False, opentrackio=True),
            opentrackio=OpenTrackIOCfg(transport=transport),
        )
        emitters = factory.build_emitters(cfg, ["opentrackio"])
        assert len(emitters) == 1
        for e in emitters:
            e.close()
