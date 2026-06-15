from __future__ import annotations

from tracksim.domain.errors import TransportError
from tracksim.domain.pose import CameraPose


class FakeClock:
    """Deterministic clock: now() advances only via sleep()."""

    def __init__(self, start: float = 0.0) -> None:
        self._now = start
        self.sleeps: list[float] = []

    def now(self) -> float:
        return self._now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        if seconds > 0:
            self._now += seconds

    def advance(self, seconds: float) -> None:
        self._now += seconds


class FakeTransport:
    def __init__(self, fail_times: int = 0) -> None:
        self.sent: list[bytes] = []
        self.fail_times = fail_times
        self.closed = False

    def send(self, data: bytes) -> None:
        if self.fail_times > 0:
            self.fail_times -= 1
            raise TransportError("fake transport send failed")
        self.sent.append(data)

    def close(self) -> None:
        self.closed = True


class FakePoseSource:
    """Counting pose source. Raises StopIteration after `limit` calls."""

    def __init__(self, limit: int | None = None) -> None:
        self.limit = limit
        self.calls = 0
        self.dts: list[float] = []
        self.closed = False

    def next(self, dt: float) -> CameraPose:
        if self.limit is not None and self.calls >= self.limit:
            raise StopIteration
        frame = self.calls
        self.dts.append(dt)
        self.calls += 1
        return CameraPose(frame=frame)

    def close(self) -> None:
        self.closed = True


class FakeEmitter:
    """Emitter recording poses; can raise TransportError on first N emits."""

    def __init__(self, name: str = "fake", fail_times: int = 0) -> None:
        self.name = name
        self.fail_times = fail_times
        self.emitted: list[CameraPose] = []
        self.closed = False

    def emit(self, pose: CameraPose) -> None:
        if self.fail_times > 0:
            self.fail_times -= 1
            raise TransportError(f"{self.name} emit failed")
        self.emitted.append(pose)

    def close(self) -> None:
        self.closed = True
