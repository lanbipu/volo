import pytest

from tracksim.cli.commands.factory import validate_config_enums
from tracksim.config import load_config
from tracksim.domain.errors import ConfigError


def test_nonpositive_timeout_rejected():
    with pytest.raises(ConfigError):
        validate_config_enums(load_config(None, {"fbx": {"timeout_s": 0}}))
    with pytest.raises(ConfigError):
        validate_config_enums(load_config(None, {"fbx": {"timeout_s": -5}}))


def test_default_fbx_ok():
    validate_config_enums(load_config(None, {}))       # 不抛
