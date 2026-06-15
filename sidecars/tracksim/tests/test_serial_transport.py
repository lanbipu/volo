import pytest

from tracksim.domain.errors import TransportError
from tracksim.transports.serial_port import SerialTransport


class _FakeSerial:
    def __init__(self, port, baudrate, parity, stopbits, bytesize):
        self.port = port
        self.baudrate = baudrate
        self.parity = parity
        self.stopbits = stopbits
        self.bytesize = bytesize
        self.written: list[bytes] = []
        self.closed = False

    def write(self, data):
        self.written.append(data)
        return len(data)

    def close(self):
        self.closed = True


def test_serial_opens_with_freed_params_and_writes():
    created: list[_FakeSerial] = []

    def factory(**kwargs):
        sock = _FakeSerial(**kwargs)
        created.append(sock)
        return sock

    transport = SerialTransport(device="/dev/ttyUSB0", serial_factory=factory)
    assert created[0].port == "/dev/ttyUSB0"
    assert created[0].baudrate == 38400
    assert created[0].parity == "O"
    assert created[0].stopbits == 1
    assert created[0].bytesize == 8

    transport.send(b"\xd1\x00")
    assert created[0].written == [b"\xd1\x00"]

    transport.close()
    assert created[0].closed is True


def test_serial_open_failure_raises_transport_error():
    def factory(**kwargs):
        raise OSError("port busy")

    with pytest.raises(TransportError) as excinfo:
        SerialTransport(device="/dev/ttyUSB0", serial_factory=factory)
    assert excinfo.value.code == "TRANSPORT_SEND_FAILED"
    assert excinfo.value.details["device"] == "/dev/ttyUSB0"


def test_serial_send_failure_raises_transport_error():
    class _FailingSerial(_FakeSerial):
        def write(self, data):
            raise OSError("write error")

    def factory(**kwargs):
        return _FailingSerial(**kwargs)

    transport = SerialTransport(device="/dev/ttyUSB0", serial_factory=factory)
    with pytest.raises(TransportError) as excinfo:
        transport.send(b"\x00")
    assert excinfo.value.code == "TRANSPORT_SEND_FAILED"
