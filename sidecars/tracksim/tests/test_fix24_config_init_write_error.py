"""Fix 24 (round 5 finding 1): config init write failures must raise ConfigError, not raw OSError."""
from __future__ import annotations

import pytest

from tracksim.cli.commands import config_cmd
from tracksim.domain.errors import ConfigError


def test_init_to_nonexistent_parent_dir_raises_config_error(tmp_path):
    """Writing to a path whose parent dir does not exist must raise ConfigError (exit 3)."""
    target = tmp_path / "nonexistent_dir" / "tracksim.toml"
    with pytest.raises(ConfigError) as exc_info:
        config_cmd.init(str(target), dry_run=False)
    assert exc_info.value.exit_code == 3
    assert exc_info.value.code == "CONFIG_ERROR"
    assert str(target) in exc_info.value.message or "nonexistent_dir" in exc_info.value.message
