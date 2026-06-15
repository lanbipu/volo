from __future__ import annotations

from typing import Any, Callable

from tracksim.domain.errors import TransportError

# Map FreeD/contract parity codes to pyserial PARITY_* string constants.
_PARITY_MAP = {"N": "N", "E": "E", "O": "O", "M": "M", "S": "S"}


def _default_serial_factory(**kwargs: Any) -> Any:
    import serial  # lazy import so tests can inject a fake factory

    parity_map = {
        "N": serial.PARITY_NONE,
        "E": serial.PARITY_EVEN,
        "O": serial.PARITY_ODD,
        "M": serial.PARITY_MARK,
        "S": serial.PARITY_SPACE,
    }
    stopbits_map = {
        1: serial.STOPBITS_ONE,
        2: serial.STOPBITS_TWO,
    }
    bytesize_map = {
        5: serial.FIVEBITS,
        6: serial.SIXBITS,
        7: serial.SEVENBITS,
        8: serial.EIGHTBITS,
    }
    return serial.Serial(
        port=kwargs["port"],
        baudrate=kwargs["baudrate"],
        parity=parity_map[kwargs["parity"]],
        stopbits=stopbits_map[kwargs["stopbits"]],
        bytesize=bytesize_map[kwargs["bytesize"]],
    )


class SerialTransport:
    """Serial transport implementing the ports.transport.Transport protocol.

    Defaults match the FreeD v1.0 RS422 line settings: 38400 baud, 8 data
    bits (LSB first), odd parity, 1 stop bit.
    """

    def __init__(
        self,
        device: str,
        baud: int = 38400,
        parity: str = "O",
        stopbits: int = 1,
        *,
        serial_factory: Callable[..., Any] = _default_serial_factory,
    ) -> None:
        if parity not in _PARITY_MAP:
            raise TransportError(
                f"unknown parity: {parity!r}",
                details={"device": device, "parity": parity},
            )
        self.device = device
        self.baud = baud
        self.parity = parity
        self.stopbits = stopbits
        try:
            self._port = serial_factory(
                port=device,
                baudrate=baud,
                parity=parity,
                stopbits=stopbits,
                bytesize=8,
            )
        except Exception as exc:
            raise TransportError(
                f"failed to open serial port: {exc}",
                details={"device": device, "baud": baud},
            ) from exc

    def send(self, data: bytes) -> None:
        try:
            self._port.write(data)
        except Exception as exc:
            raise TransportError(
                f"serial write failed: {exc}",
                details={"device": self.device},
            ) from exc

    def close(self) -> None:
        self._port.close()
