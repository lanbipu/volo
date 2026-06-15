"""Clock implementations: real wall clock + deterministic fake."""

from __future__ import annotations

import time


class WallClock:
    """Real monotonic wall clock used for live frame pacing."""

    def now(self) -> float:
        return time.monotonic()

    def sleep(self, seconds: float) -> None:
        if seconds <= 0.0:
            return
        time.sleep(seconds)


class FakeClock:
    """Deterministic clock for tests; sleep advances a virtual time base."""

    def __init__(self, start: float = 0.0) -> None:
        self._t = float(start)

    def now(self) -> float:
        return self._t

    def sleep(self, seconds: float) -> None:
        if seconds <= 0.0:
            return
        self._t += float(seconds)

    def advance(self, seconds: float) -> None:
        self._t += float(seconds)
