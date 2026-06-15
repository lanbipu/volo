from __future__ import annotations

from typing import Protocol


class Transport(Protocol):
    def send(self, data: bytes) -> None: ...
    def close(self) -> None: ...
