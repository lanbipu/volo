from __future__ import annotations

from tracksim.domain.pose import CameraPose
from tracksim.ports.clock import Clock
from tracksim.sources.scripted import ScriptedPoseSource
from tracksim.track import Track


class TrackPoseSource:
    """回放一条 Track：sample-then-advance；游标超过末帧 t（含半帧容差）后抛 StopIteration。
    loop=True 则游标回绕、无缝循环，从不耗尽（frame/timestamp 持续递增，phase 周期回到首帧）。"""

    def __init__(self, track: Track, *, rate: float, clock: Clock | None = None,
                 loop: bool = False) -> None:
        if not track.frames:
            from tracksim.domain.errors import InvalidTrajectoryError
            raise InvalidTrajectoryError("track has no frames")
        self._frames = track.frames
        self._rate = rate
        self._clock = clock
        self._loop = loop
        self._cursor = 0.0
        self._tick = 0          # 整数 tick：loop 相位用 tick*dt（单乘），避免 _cursor 浮点累积漂移
        self._frame = 0
        self._timestamp = 0.0
        self._start_t = track.frames[0][0]
        self._end_t = track.frames[-1][0]
        self._period = self._end_t - self._start_t

    def next(self, dt: float) -> CameraPose:
        if self._loop:
            # 相位由整数 tick 驱动（tick*dt 单乘，非 _cursor 累加）：避免浮点累积漂移造成循环间
            # seam 抖动；tick 从 0 ⇒ 首帧 phase=_start_t，对 t 不从 0 的轨迹也对齐到首帧。
            phase = (self._start_t + (self._tick * dt) % self._period
                     if self._period > 0 else self._start_t)   # period<=0（单帧/退化）：恒发首帧
        else:
            if self._cursor > self._end_t + 0.5 * dt:  # 半帧容差，防非整数 fps 丢末帧
                raise StopIteration
            phase = self._cursor
        pose = self._interpolate(phase)
        self._tick += 1
        self._frame += 1
        self._timestamp += dt
        out = pose.model_copy(update={
            "frame": self._frame, "timestamp": self._timestamp, "rate": self._rate})
        self._cursor += dt
        return out

    def _interpolate(self, t: float) -> CameraPose:
        frames = self._frames
        if t <= frames[0][0]:
            return frames[0][1]
        if t >= frames[-1][0]:
            return frames[-1][1]
        for i in range(len(frames) - 1):
            t0, p0 = frames[i]
            t1, p1 = frames[i + 1]
            if t0 <= t <= t1:
                span = t1 - t0
                ratio = 0.0 if span == 0 else (t - t0) / span
                return ScriptedPoseSource._lerp_pose(p0, p1, ratio)
        return frames[-1][1]

    def close(self) -> None:
        return None
