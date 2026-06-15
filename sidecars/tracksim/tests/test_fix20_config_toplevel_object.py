"""Fix 20 (round 4 finding 3): config top-level must be an object, not array/scalar."""
from __future__ import annotations

import json
import tempfile
import os

import pytest

from tracksim.config import load_config
from tracksim.domain.errors import ConfigError


def _write_tmp(content: str, suffix: str) -> str:
    fd, path = tempfile.mkstemp(suffix=suffix)
    try:
        os.write(fd, content.encode())
    finally:
        os.close(fd)
    return path


def test_json_top_level_array_raises_config_error():
    """A JSON config file containing [] must raise ConfigError, not AttributeError."""
    path = _write_tmp("[]", ".json")
    try:
        with pytest.raises(ConfigError) as exc_info:
            load_config(path)
        assert "dict" in exc_info.value.message.lower() or "object" in exc_info.value.message.lower()
    finally:
        os.unlink(path)


def test_json_top_level_scalar_raises_config_error():
    """A JSON config file containing a bare integer must raise ConfigError."""
    path = _write_tmp("42", ".json")
    try:
        with pytest.raises(ConfigError):
            load_config(path)
    finally:
        os.unlink(path)


def test_yaml_top_level_list_raises_config_error():
    """A YAML config file whose top-level is a list must raise ConfigError."""
    path = _write_tmp("- a\n- b\n", ".yaml")
    try:
        with pytest.raises(ConfigError):
            load_config(path)
    finally:
        os.unlink(path)


def test_toml_valid_object_still_works():
    """A well-formed TOML config must not raise."""
    path = _write_tmp("[protocols]\nfreed = true\n", ".toml")
    try:
        cfg = load_config(path)
        assert cfg.protocols.freed is True
    finally:
        os.unlink(path)
