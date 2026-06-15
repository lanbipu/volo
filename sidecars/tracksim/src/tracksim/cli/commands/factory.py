from __future__ import annotations

from tracksim.config import Config, ControllerMappingEntry, DEFAULT_CONTROLLER_MAPPING
from tracksim.domain.errors import ConfigError, InvalidTrajectoryError, UnsupportedProtocolError
from tracksim.domain.pose import CameraPose, VALID_POSE_CHANNELS
from tracksim.emitters.freed import FreeDEmitter, FreeDScaling
from tracksim.emitters.opentrackio import (
    ENCODING_CBOR,
    ENCODING_JSON,
    OpenTrackIOEmitter,
)
from tracksim.ports.clock import Clock
from tracksim.ports.controller_input import CONTROLLER_BUTTONS, CONTROLLER_SOURCES
from tracksim.ports.emitter import Emitter
from tracksim.ports.pose_source import PoseSource
from tracksim.sources.scripted import ScriptedPoseSource
from tracksim.sources.track import TrackPoseSource
from tracksim.track import load_track
from tracksim.sources.static import StaticPoseSource
from tracksim.transports.serial_port import SerialTransport
from tracksim.transports.udp import UdpTransport

_FREED_UDP_MODE = {"udp_unicast": "unicast", "udp_broadcast": "broadcast"}
_FREED_VALID_TRANSPORTS = frozenset(_FREED_UDP_MODE) | {"serial"}
_OTRK_VALID_TRANSPORTS = frozenset({"unicast", "multicast"})
_OTRK_VALID_ENCODINGS = frozenset({"json", "cbor"})
_FREED_VALID_SCALING_VARIANTS = frozenset({"native", "radamec"})


def _build_freed(config: Config) -> FreeDEmitter:
    fc = config.freed
    if fc.transport == "serial":
        transport = SerialTransport(fc.serial_device, baud=fc.baud)
    else:
        mode = _FREED_UDP_MODE[fc.transport]
        transport = UdpTransport(mode, fc.target_ip, fc.port)
    scaling = FreeDScaling(
        variant=fc.scaling.variant,
        angle_lsb_per_deg=fc.scaling.angle_lsb_per_deg,
        pos_lsb_per_m=fc.scaling.pos_lsb_per_m,
        zoom_lsb_per_mm=fc.scaling.zoom_lsb_per_mm,
        focus_lsb_per_m=fc.scaling.focus_lsb_per_m,
    )
    return FreeDEmitter(transport, camera_id=fc.camera_id, scaling=scaling)


def _build_opentrackio(config: Config) -> OpenTrackIOEmitter:
    oc = config.opentrackio
    mode = oc.transport  # "multicast" or "unicast"
    transport = UdpTransport(mode, oc.ip, oc.port)
    encoding = ENCODING_CBOR if oc.encoding == "cbor" else ENCODING_JSON
    return OpenTrackIOEmitter(
        transport, source_number=oc.source_number, encoding=encoding
    )


def validate_config_enums(config: Config) -> None:
    """Raise ConfigError if any enum-valued config field has an invalid value.

    Called by both build_emitters and config_cmd.validate so validation is DRY.
    """
    fc = config.freed
    if fc.transport not in _FREED_VALID_TRANSPORTS:
        raise ConfigError(
            f"unknown freed.transport: {fc.transport!r}; expected one of {sorted(_FREED_VALID_TRANSPORTS)}",
            details={"transport": fc.transport, "allowed": sorted(_FREED_VALID_TRANSPORTS)},
        )
    if fc.scaling.variant not in _FREED_VALID_SCALING_VARIANTS:
        raise ConfigError(
            f"unknown freed.scaling.variant: {fc.scaling.variant!r}; expected one of {sorted(_FREED_VALID_SCALING_VARIANTS)}",
            details={"variant": fc.scaling.variant, "allowed": sorted(_FREED_VALID_SCALING_VARIANTS)},
        )
    if not (0 <= fc.camera_id <= 255):
        raise ConfigError(
            f"freed.camera_id must be in 0..255, got {fc.camera_id}",
            details={"camera_id": fc.camera_id, "allowed": "0..255"},
        )
    oc = config.opentrackio
    if oc.transport not in _OTRK_VALID_TRANSPORTS:
        raise ConfigError(
            f"unknown opentrackio.transport: {oc.transport!r}; expected one of {sorted(_OTRK_VALID_TRANSPORTS)}",
            details={"transport": oc.transport, "allowed": sorted(_OTRK_VALID_TRANSPORTS)},
        )
    if oc.encoding not in _OTRK_VALID_ENCODINGS:
        raise ConfigError(
            f"unknown opentrackio.encoding: {oc.encoding!r}; expected one of {sorted(_OTRK_VALID_ENCODINGS)}",
            details={"encoding": oc.encoding, "allowed": sorted(_OTRK_VALID_ENCODINGS)},
        )
    import math
    fx = config.fbx
    if not math.isfinite(fx.timeout_s) or fx.timeout_s <= 0:
        raise ConfigError(
            f"fbx.timeout_s must be a finite number > 0, got {fx.timeout_s}",
            details={"timeout_s": fx.timeout_s},
        )


def build_emitters(config: Config, protocols: list[str]) -> list[Emitter]:
    validate_config_enums(config)
    emitters: list[Emitter] = []
    try:
        for proto in protocols:
            if proto == "freed":
                emitters.append(_build_freed(config))
            elif proto == "opentrackio":
                emitters.append(_build_opentrackio(config))
            else:
                raise UnsupportedProtocolError(
                    f"unknown protocol: {proto!r}",
                    details={"protocol": proto},
                )
    except Exception:
        for e in emitters:
            e.close()
        raise
    return emitters


def build_source(
    config: Config, source: str, *, rate: float, clock: Clock
) -> PoseSource:
    if source == "static":
        return StaticPoseSource(CameraPose(rate=rate), clock=clock)
    if source == "script":
        mc = config.motion
        return ScriptedPoseSource(
            motion=mc.motion,
            radius=mc.radius,
            speed=mc.speed,
            amplitude=mc.amplitude,
            freq=mc.freq,
            rate=rate,
            clock=clock,
        )
    raise UnsupportedProtocolError(
        f"unknown pose source: {source!r}",
        details={"source": source},
    )


def build_track_source(
    input_path: str | None, *, rate: float | None, clock: Clock, loop: bool = False
) -> tuple[TrackPoseSource, float]:
    """装载 track 文件并构造回放源。rate=None → 发射速率取 track.rate。loop=True → 无缝循环。
    返回 (source, effective_rate)。"""
    if not input_path:
        raise InvalidTrajectoryError("--source track/fbx requires an input file path")
    # --rate 透传给 load_track：CSV 无 sidecar 时作为作者帧率、原生 track.json 时覆盖其 rate。
    track = load_track(input_path, rate_override=rate)
    return TrackPoseSource(track, rate=track.rate, clock=clock, loop=loop), track.rate


def resolve_controller_mapping(config: Config) -> list[ControllerMappingEntry]:
    """返回用户 mapping；为空时回退到内置默认映射。"""
    if config.controller.mapping:
        return list(config.controller.mapping)
    return list(DEFAULT_CONTROLLER_MAPPING)


_VALID_MAPPING_MODES = frozenset({"rate", "absolute"})


def check_controller_mapping(mapping: list[ControllerMappingEntry]) -> list[str]:
    """返回 mapping 的问题描述列表（空 == 干净）。本函数永不抛异常。

    被 `config validate` 用作严格校验（-> 报错），被控制器运行路径用作宽松检查（-> 警告）。
    """
    problems: list[str] = []
    for i, entry in enumerate(mapping):
        if entry.channel not in VALID_POSE_CHANNELS:
            problems.append(
                f"mapping[{i}]: unknown channel {entry.channel!r} "
                f"(allowed: {sorted(VALID_POSE_CHANNELS)})"
            )
        if entry.source not in CONTROLLER_SOURCES:
            problems.append(
                f"mapping[{i}]: unknown source {entry.source!r} "
                f"(allowed: {sorted(CONTROLLER_SOURCES)})"
            )
        if entry.mode not in _VALID_MAPPING_MODES:
            problems.append(
                f"mapping[{i}]: unknown mode {entry.mode!r} "
                f"(allowed: {sorted(_VALID_MAPPING_MODES)})"
            )
        modifier = getattr(entry, "modifier", None)
        if modifier is not None and modifier not in CONTROLLER_BUTTONS:
            problems.append(
                f"mapping[{i}]: unknown modifier {modifier!r} "
                f"(allowed: {sorted(CONTROLLER_BUTTONS)})"
            )
    return problems


def warn_controller_mapping(mapping, log) -> None:
    """把 mapping 的每条问题作为 warning 记录；永不抛异常（控制器运行路径用）。"""
    for problem in check_controller_mapping(mapping):
        log.warning("controller mapping: %s", problem)
