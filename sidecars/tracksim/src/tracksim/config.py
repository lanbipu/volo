from __future__ import annotations

import json
import tomllib
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, ValidationError

from tracksim.domain.errors import ConfigError


class ProtocolsCfg(BaseModel):
    freed: bool = True
    opentrackio: bool = True


class FreeDScalingCfg(BaseModel):
    variant: str = "native"
    angle_lsb_per_deg: float = 32768.0
    pos_lsb_per_m: float = 64000.0
    # focal_length(mm)/focus_distance(m) -> 24-bit 镜头编码器 raw 的线性缩放；
    # 默认是标定起点，需对着接收端调；设 0 关闭该字段。
    zoom_lsb_per_mm: float = 1000.0
    focus_lsb_per_m: float = 1000.0


class FreeDCfg(BaseModel):
    transport: str = "udp_unicast"
    target_ip: str = "127.0.0.1"
    port: int = 6000
    serial_device: str | None = None
    baud: int = 38400
    camera_id: int = 1
    rate_hz: float = 60.0
    scaling: FreeDScalingCfg = FreeDScalingCfg()


class OpenTrackIOCfg(BaseModel):
    transport: str = "multicast"
    source_number: int = 1
    ip: str = "239.135.1.1"
    port: int = 55555
    encoding: str = "json"
    rate_hz: float = 60.0


class ControllerMappingEntry(BaseModel):
    channel: str
    source: str
    mode: str = "rate"
    scale: float = 1.0
    deadzone: float = 0.0
    invert: bool = False
    clamp_min: float | None = None
    clamp_max: float | None = None
    modifier: str | None = None
    modifier_scale: float = 3.0


class ControllerCfg(BaseModel):
    device: str | None = None
    mapping: list[ControllerMappingEntry] = []


# 内置默认手柄映射：仅当 config.controller.mapping 为空时启用（见 factory.resolve_controller_mapping）。
# scale/clamp 为「实测手感后微调」的起点值；正负号是初始猜测，全可配。
# 拨片：上排 P1/P3 -> 变焦（focal_length），下排 P2/P4 -> 对焦（focus_distance），各管一个方向。
DEFAULT_CONTROLLER_MAPPING: list[ControllerMappingEntry] = [
    ControllerMappingEntry(channel="x", source="leftx", mode="rate", scale=1.0, deadzone=0.1, clamp_min=-10.0, clamp_max=10.0),
    ControllerMappingEntry(channel="y", source="lefty", mode="rate", scale=1.0, invert=True, deadzone=0.1, clamp_min=-10.0, clamp_max=10.0),
    ControllerMappingEntry(channel="pan", source="rightx", mode="rate", scale=60.0, deadzone=0.1),
    ControllerMappingEntry(channel="tilt", source="righty", mode="rate", scale=60.0, invert=True, deadzone=0.1, clamp_min=-90.0, clamp_max=90.0),
    ControllerMappingEntry(channel="z", source="lefttrigger", mode="rate", scale=1.0, invert=True, deadzone=0.05, clamp_min=0.0, clamp_max=10.0),
    ControllerMappingEntry(channel="z", source="righttrigger", mode="rate", scale=1.0, deadzone=0.05, clamp_min=0.0, clamp_max=10.0),
    ControllerMappingEntry(channel="roll", source="leftshoulder", mode="rate", scale=30.0, invert=True, clamp_min=-30.0, clamp_max=30.0),
    ControllerMappingEntry(channel="roll", source="rightshoulder", mode="rate", scale=30.0, clamp_min=-30.0, clamp_max=30.0),
    ControllerMappingEntry(channel="focal_length", source="p1", mode="rate", scale=50.0, clamp_min=12.0, clamp_max=300.0),
    ControllerMappingEntry(channel="focal_length", source="p3", mode="rate", scale=50.0, invert=True, clamp_min=12.0, clamp_max=300.0),
    ControllerMappingEntry(channel="focus_distance", source="p2", mode="rate", scale=1.0, clamp_min=0.1, clamp_max=100.0),
    ControllerMappingEntry(channel="focus_distance", source="p4", mode="rate", scale=1.0, invert=True, clamp_min=0.1, clamp_max=100.0),
]


class MotionCfg(BaseModel):
    motion: str = "static"
    radius: float = 2.0
    speed: float = 30.0
    amplitude: float = 10.0
    freq: float = 0.5


class OutputCfg(BaseModel):
    format: str = "text"
    log_level: str = "info"


class FbxCfg(BaseModel):
    blender_path: str = ""
    default_camera: str = ""
    timeout_s: float = 120.0
    cache_dir: str = ""


class Config(BaseModel):
    protocols: ProtocolsCfg = ProtocolsCfg()
    freed: FreeDCfg = FreeDCfg()
    opentrackio: OpenTrackIOCfg = OpenTrackIOCfg()
    controller: ControllerCfg = ControllerCfg()
    motion: MotionCfg = MotionCfg()
    output: OutputCfg = OutputCfg()
    fbx: FbxCfg = FbxCfg()


def _deep_merge(base: dict[str, Any], over: dict[str, Any]) -> dict[str, Any]:
    result = dict(base)
    for key, value in over.items():
        if (
            key in result
            and isinstance(result[key], dict)
            and isinstance(value, dict)
        ):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def _load_file(path: str) -> dict[str, Any]:
    p = Path(path)
    try:
        raw = p.read_bytes()
    except OSError as e:
        raise ConfigError(f"Cannot read config file: {path}", details={"path": path}) from e

    suffix = p.suffix.lower()
    try:
        if suffix == ".toml":
            parsed = tomllib.loads(raw.decode("utf-8"))
        elif suffix in (".yaml", ".yml"):
            parsed = yaml.safe_load(raw.decode("utf-8")) or {}
        elif suffix == ".json":
            parsed = json.loads(raw.decode("utf-8"))
        else:
            raise ConfigError(
                f"Unsupported config extension: {suffix}", details={"path": path}
            )
    except (tomllib.TOMLDecodeError, yaml.YAMLError, json.JSONDecodeError, ValueError) as e:
        raise ConfigError(f"Cannot parse config file: {path}", details={"path": path}) from e

    if not isinstance(parsed, dict):
        raise ConfigError(
            f"Config file must be a TOML/YAML/JSON object (dict), got {type(parsed).__name__}",
            details={"path": path, "type": type(parsed).__name__},
        )
    return parsed


def load_config(
    path: str | None, overrides: dict[str, Any] | None = None
) -> Config:
    """Merge defaults < file < overrides into a validated Config."""
    merged: dict[str, Any] = {}
    if path is not None:
        merged = _deep_merge(merged, _load_file(path))
    if overrides is not None:
        merged = _deep_merge(merged, overrides)
    try:
        return Config.model_validate(merged)
    except ValidationError as e:
        raise ConfigError("Invalid config values", details={"errors": e.errors()}) from e
