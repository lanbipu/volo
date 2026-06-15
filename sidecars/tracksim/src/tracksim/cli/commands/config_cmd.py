from __future__ import annotations

import os
from typing import Any

from tracksim.cli.commands.factory import check_controller_mapping, validate_config_enums
from tracksim.config import Config
from tracksim.domain.errors import ConfigError, ConflictError

DEFAULT_CONFIG_TOML = """\
[protocols]
freed = true
opentrackio = false

[freed]
transport = "udp_unicast"
target_ip = "127.0.0.1"
port = 6000
serial_device = "/dev/ttyUSB0"
baud = 38400
camera_id = 0
rate_hz = 60.0

[freed.scaling]
variant = "native"
angle_lsb_per_deg = 32768.0
pos_lsb_per_m = 64000.0

[opentrackio]
transport = "multicast"
source_number = 1
ip = "239.135.1.1"
port = 55555
encoding = "json"
rate_hz = 60.0

[controller]
device = "0"

[motion]
motion = "static"
radius = 1.0
speed = 1.0
amplitude = 1.0
freq = 0.5

[output]
format = "text"
log_level = "info"
"""


def init(
    path: str, *, dry_run: bool, force: bool = False
) -> tuple[str, dict[str, Any]]:
    exists = os.path.exists(path)
    if dry_run:
        return "config.init", {
            "dry_run_plan": {
                "path": path,
                "action": "overwrite" if exists else "create",
                "content": DEFAULT_CONFIG_TOML,
            }
        }
    if exists and not force:
        # 破坏性操作（CLI_DESIGN_SPEC §9）：覆盖已有配置需显式 --yes
        raise ConflictError(
            f"config file already exists: {path} (use --yes to overwrite)",
            details={"path": path},
        )
    try:
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(DEFAULT_CONFIG_TOML)
    except OSError as exc:
        raise ConfigError(
            f"cannot write config file: {path}: {exc.strerror}",
            details={"path": path},
        ) from exc
    return "config.init", {"written": True, "path": path, "overwritten": exists}


def show(config: Config) -> tuple[str, dict[str, Any]]:
    return "config.show", config.model_dump()


def validate(config: Config) -> tuple[str, dict[str, Any]]:
    validate_config_enums(config)
    problems = check_controller_mapping(config.controller.mapping)
    if problems:
        raise ConfigError("invalid controller mapping", details={"problems": problems})
    return "config.validate", {"valid": True}
