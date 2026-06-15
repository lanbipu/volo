from __future__ import annotations

from typing import Iterable

from tracksim.domain.errors import NoControllerError
from tracksim.domain.pose import CameraPose, VALID_POSE_CHANNELS
from tracksim.ports.clock import Clock
from tracksim.ports.controller_input import ControllerInput


class ControllerPoseSource:
    """Pose source driven by a ControllerInput via a channel mapping."""

    def __init__(
        self,
        controller: ControllerInput,
        mapping: Iterable,
        clock: Clock,
    ) -> None:
        self._controller = controller
        self._mapping = list(mapping)
        self._clock = clock
        self._channels: dict[str, float] = {}
        # rate 模式从 channel 当前值积分；用 CameraPose 默认值播种，使 focal_length
        # 起于 35mm、focus_distance 起于 3m（否则会从 0 起积分 = 0mm 镜头）。
        base = CameraPose()
        for entry in self._mapping:
            # 只对合法 pose channel 播种；非法 channel（含恰好是 CameraPose 方法名的）
            # 不播种，next() 会以 get(ch, 0.0) 兜底为无害 no-op，避免 seed 绑定方法后 += 崩溃。
            if entry.channel not in VALID_POSE_CHANNELS:
                continue
            seed = getattr(base, entry.channel, 0.0)
            self._channels.setdefault(entry.channel, seed if seed is not None else 0.0)
        self._frame = 0
        self._timestamp = 0.0

    def next(self, dt: float) -> CameraPose:
        state = self._controller.poll()
        if not state.connected:
            raise NoControllerError("controller is not connected")

        # 每个 channel 的 clamp 边界在本 tick 内跨所有 entry 取交集，待所有 entry 累加完
        # 后再统一钳制一次；否则成对反向输入（如 LT/RT 都绑 z）会被中途某条 entry 的 clamp
        # 截断，导致相反输入无法抵消、在边界处漂移。
        clamp_lo: dict[str, float] = {}
        clamp_hi: dict[str, float] = {}

        for entry in self._mapping:
            if entry.source in state.buttons:
                value = 1.0 if state.buttons[entry.source] else 0.0
            else:
                value = state.axes.get(entry.source, 0.0)
            if abs(value) < entry.deadzone:
                value = 0.0
            if entry.invert:
                value = -value

            effective_scale = entry.scale
            mod = getattr(entry, "modifier", None)
            if mod and mod in state.buttons and state.buttons[mod]:
                effective_scale *= getattr(entry, "modifier_scale", 3.0)

            if entry.mode == "rate":
                current = self._channels.get(entry.channel, 0.0)
                current += value * effective_scale * dt
            else:  # "absolute"
                current = value * effective_scale
            self._channels[entry.channel] = current

            # clamp_min/clamp_max 默认 None（不钳制）；±inf 兜底（修复 F7）。
            # 钳制延后到本 tick 所有 entry 累加完毕后统一执行（见上方说明）。
            lo = entry.clamp_min if entry.clamp_min is not None else float("-inf")
            hi = entry.clamp_max if entry.clamp_max is not None else float("inf")
            clamp_lo[entry.channel] = max(clamp_lo.get(entry.channel, float("-inf")), lo)
            clamp_hi[entry.channel] = min(clamp_hi.get(entry.channel, float("inf")), hi)

        for channel, lo in clamp_lo.items():
            self._channels[channel] = max(lo, min(clamp_hi[channel], self._channels[channel]))

        self._frame += 1
        self._timestamp += dt
        return CameraPose(
            **self._channels,
            frame=self._frame,
            timestamp=self._timestamp,
        )

    def close(self) -> None:
        self._controller.close()
