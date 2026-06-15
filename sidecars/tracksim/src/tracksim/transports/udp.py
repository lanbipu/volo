from __future__ import annotations

import socket

from tracksim.domain.errors import TransportError

_VALID_MODES = ("unicast", "multicast", "broadcast")


class UdpTransport:
    """UDP transport implementing the ports.transport.Transport protocol."""

    def __init__(self, mode: str, host: str, port: int, ttl: int = 2) -> None:
        if mode not in _VALID_MODES:
            raise TransportError(
                f"unknown UDP mode: {mode!r}",
                details={"mode": mode, "valid": list(_VALID_MODES)},
            )
        if not (0 <= port <= 65535):
            raise TransportError(
                f"UDP port out of range: {port} (must be 0..65535)",
                details={"port": port},
            )
        self.mode = mode
        self.host = host
        self.port = port
        self.ttl = ttl
        try:
            self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            if mode == "multicast":
                self._sock.setsockopt(
                    socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, ttl
                )
            elif mode == "broadcast":
                self._sock.setsockopt(
                    socket.SOL_SOCKET, socket.SO_BROADCAST, 1
                )
        except OSError as exc:
            raise TransportError(
                f"failed to open UDP socket: {exc}",
                details={"mode": mode, "host": host, "port": port},
            ) from exc

    def send(self, data: bytes) -> None:
        try:
            self._sock.sendto(data, (self.host, self.port))
        except OSError as exc:
            raise TransportError(
                f"UDP send failed: {exc}",
                details={"host": self.host, "port": self.port},
            ) from exc

    def close(self) -> None:
        self._sock.close()
