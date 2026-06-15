"""Fix 36 (round 7 finding 2): freed.camera_id outside 0..255 must be rejected as ConfigError."""
from __future__ import annotations

import pytest

from tracksim.cli.commands import config_cmd, factory
from tracksim.config import Config, FreeDCfg
from tracksim.domain.errors import ConfigError


def _config_with_camera_id(camera_id: int) -> Config:
    return Config(freed=FreeDCfg(camera_id=camera_id))


# --- Unit tests: build_emitters raises ConfigError for out-of-range camera_id ---

def test_build_emitters_camera_id_256_raises_config_error():
    """camera_id=256 must raise ConfigError (exit 3), not silently mask to 0."""
    cfg = _config_with_camera_id(256)
    with pytest.raises(ConfigError) as exc_info:
        factory.build_emitters(cfg, ["freed"])
    assert exc_info.value.exit_code == 3


def test_build_emitters_camera_id_neg1_raises_config_error():
    """camera_id=-1 must raise ConfigError."""
    cfg = _config_with_camera_id(-1)
    with pytest.raises(ConfigError) as exc_info:
        factory.build_emitters(cfg, ["freed"])
    assert exc_info.value.exit_code == 3


def test_build_emitters_camera_id_1000_raises_config_error():
    """camera_id=1000 (well above 255) must raise ConfigError."""
    cfg = _config_with_camera_id(1000)
    with pytest.raises(ConfigError):
        factory.build_emitters(cfg, ["freed"])


def test_build_emitters_camera_id_0_accepted():
    """camera_id=0 is at the lower bound and must be accepted."""
    cfg = _config_with_camera_id(0)
    emitters = factory.build_emitters(cfg, ["freed"])
    assert len(emitters) == 1
    for e in emitters:
        e.close()


def test_build_emitters_camera_id_255_accepted():
    """camera_id=255 is at the upper bound and must be accepted."""
    cfg = _config_with_camera_id(255)
    emitters = factory.build_emitters(cfg, ["freed"])
    assert len(emitters) == 1
    for e in emitters:
        e.close()


def test_build_emitters_camera_id_128_accepted():
    """camera_id=128 is within range and must be accepted."""
    cfg = _config_with_camera_id(128)
    emitters = factory.build_emitters(cfg, ["freed"])
    assert len(emitters) == 1
    for e in emitters:
        e.close()


# --- validate_config_enums also catches out-of-range camera_id ---

def test_validate_config_enums_camera_id_256_raises():
    """validate_config_enums must flag camera_id=256."""
    cfg = _config_with_camera_id(256)
    with pytest.raises(ConfigError) as exc_info:
        factory.validate_config_enums(cfg)
    assert exc_info.value.exit_code == 3


def test_validate_config_enums_camera_id_valid_ok():
    """validate_config_enums with camera_id=1 (default) must not raise."""
    cfg = Config()  # default camera_id=1
    factory.validate_config_enums(cfg)  # must not raise


# --- config validate command also flags it ---

def test_config_validate_camera_id_256_raises_config_error():
    """config validate with camera_id=256 must raise ConfigError."""
    cfg = _config_with_camera_id(256)
    with pytest.raises(ConfigError):
        config_cmd.validate(cfg)
