from __future__ import annotations

from dataclasses import dataclass
from typing import Iterator, Union

from tracksim.domain.errors import TransportError
from tracksim.domain.pose import CameraPose
from tracksim.ports.clock import Clock
from tracksim.ports.emitter import Emitter
from tracksim.ports.pose_source import PoseSource


@dataclass
class SimStarted:
    protocols: list[str]
    rate: float


@dataclass
class SimTick:
    pose: CameraPose
    packets_sent: int
    rate_actual: float


@dataclass
class SimWarning:
    message: str


@dataclass
class SimStopped:
    reason: str
    total_packets: int


SimEvent = Union[SimStarted, SimTick, SimWarning, SimStopped]


class Simulator:
    def __init__(
        self,
        source: PoseSource,
        emitters: list[Emitter],
        clock: Clock,
        rate: float,
        fail_fast: bool = False,
    ) -> None:
        self.source = source
        self.emitters = emitters
        self.clock = clock
        self.rate = rate
        self.fail_fast = fail_fast
        self._stopped = False
        self._total_packets = 0

    def stop(self) -> None:
        self._stopped = True

    def _emit_all(self, pose: CameraPose) -> tuple[int, list[SimWarning]]:
        sent = 0
        warnings: list[SimWarning] = []
        for emitter in self.emitters:
            try:
                emitter.emit(pose)
            except TransportError as exc:
                if self.fail_fast:
                    raise
                warnings.append(SimWarning(message=str(exc)))
                continue
            sent += 1
        return sent, warnings

    def tick_once(self) -> SimTick:
        dt = 1.0 / self.rate
        pose = self.source.next(dt)
        sent, _warnings = self._emit_all(pose)
        self._total_packets += sent
        return SimTick(
            pose=pose,
            packets_sent=self._total_packets,
            rate_actual=self.rate,
        )

    def run(self) -> Iterator[SimEvent]:
        yield SimStarted(protocols=[e.name for e in self.emitters], rate=self.rate)
        dt = 1.0 / self.rate
        last = self.clock.now()
        while not self._stopped:
            try:
                pose = self.source.next(dt)
            except StopIteration:
                yield SimStopped(reason="source-exhausted", total_packets=self._total_packets)
                return
            sent, warnings = self._emit_all(pose)
            for warning in warnings:
                yield warning
            self._total_packets += sent
            now = self.clock.now()
            elapsed = now - last
            rate_actual = (1.0 / elapsed) if elapsed > 0 else self.rate
            last = now
            yield SimTick(pose=pose, packets_sent=self._total_packets, rate_actual=rate_actual)
            self.clock.sleep(dt)
        yield SimStopped(reason="stopped", total_packets=self._total_packets)
