import os

import pytest

from tracksim.cli.commands import config_cmd
from tracksim.config import load_config
from tracksim.domain.errors import ConflictError


def test_init_dry_run_writes_nothing(tmp_path):
    target = tmp_path / "tracksim.toml"
    op, data = config_cmd.init(str(target), dry_run=True)
    assert op == "config.init"
    assert "dry_run_plan" in data
    assert data["dry_run_plan"]["path"] == str(target)
    assert "[protocols]" in data["dry_run_plan"]["content"]
    assert not target.exists()


def test_init_real_write_creates_file(tmp_path):
    target = tmp_path / "tracksim.toml"
    op, data = config_cmd.init(str(target), dry_run=False)
    assert op == "config.init"
    assert data["written"] is True
    assert target.exists()
    assert "[protocols]" in target.read_text()


def test_init_real_write_is_loadable(tmp_path):
    target = tmp_path / "tracksim.toml"
    config_cmd.init(str(target), dry_run=False)
    cfg = load_config(str(target))
    assert cfg is not None


def test_init_existing_file_requires_force(tmp_path):
    target = tmp_path / "tracksim.toml"
    target.write_text("# user-tuned config\n", encoding="utf-8")
    with pytest.raises(ConflictError):
        config_cmd.init(str(target), dry_run=False)
    # 未被覆盖
    assert target.read_text() == "# user-tuned config\n"


def test_init_force_overwrites_existing(tmp_path):
    target = tmp_path / "tracksim.toml"
    target.write_text("# user-tuned config\n", encoding="utf-8")
    op, data = config_cmd.init(str(target), dry_run=False, force=True)
    assert data["written"] is True
    assert data["overwritten"] is True
    assert "[protocols]" in target.read_text()


def test_init_dry_run_action_overwrite_when_exists(tmp_path):
    target = tmp_path / "tracksim.toml"
    target.write_text("# user-tuned config\n", encoding="utf-8")
    op, data = config_cmd.init(str(target), dry_run=True)
    assert data["dry_run_plan"]["action"] == "overwrite"
    assert target.read_text() == "# user-tuned config\n"


def test_show_returns_config_dump():
    cfg = load_config(None)
    op, data = config_cmd.show(cfg)
    assert op == "config.show"
    assert data == cfg.model_dump()


def test_validate_ok():
    cfg = load_config(None)
    op, data = config_cmd.validate(cfg)
    assert op == "config.validate"
    assert data["valid"] is True
