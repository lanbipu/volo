import socket
import socket as _socket_module

import pytest

from tracksim.domain.errors import TransportError
from tracksim.transports.udp import UdpTransport


def test_unicast_loopback_send_delivers_bytes():
    recv = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    recv.bind(("127.0.0.1", 0))
    recv.settimeout(2.0)
    host, port = recv.getsockname()

    transport = UdpTransport(mode="unicast", host=host, port=port)
    try:
        payload = b"hello-tracksim"
        transport.send(payload)
        data, _addr = recv.recvfrom(4096)
        assert data == payload
    finally:
        transport.close()
        recv.close()


class _FakeSocket:
    def __init__(self, *args, **kwargs):
        self.sockopts: list[tuple[int, int, int]] = []
        self.sent: list[tuple[bytes, tuple[str, int]]] = []
        self.closed = False

    def setsockopt(self, level, optname, value):
        self.sockopts.append((level, optname, value))

    def sendto(self, data, addr):
        self.sent.append((data, addr))

    def close(self):
        self.closed = True


def test_multicast_sets_ip_multicast_ttl(monkeypatch):
    created: list[_FakeSocket] = []

    def factory(*args, **kwargs):
        sock = _FakeSocket(*args, **kwargs)
        created.append(sock)
        return sock

    monkeypatch.setattr(_socket_module, "socket", factory)
    transport = UdpTransport(mode="multicast", host="239.135.1.1", port=55555, ttl=5)
    assert (
        _socket_module.IPPROTO_IP,
        _socket_module.IP_MULTICAST_TTL,
        5,
    ) in created[0].sockopts
    transport.close()
    assert created[0].closed is True


def test_broadcast_sets_so_broadcast(monkeypatch):
    created: list[_FakeSocket] = []

    def factory(*args, **kwargs):
        sock = _FakeSocket(*args, **kwargs)
        created.append(sock)
        return sock

    monkeypatch.setattr(_socket_module, "socket", factory)
    transport = UdpTransport(mode="broadcast", host="255.255.255.255", port=55555)
    assert (
        _socket_module.SOL_SOCKET,
        _socket_module.SO_BROADCAST,
        1,
    ) in created[0].sockopts
    transport.close()


def test_invalid_mode_raises_transport_error():
    with pytest.raises(TransportError) as excinfo:
        UdpTransport(mode="bogus", host="127.0.0.1", port=55555)
    assert excinfo.value.code == "TRANSPORT_SEND_FAILED"
    assert excinfo.value.details["mode"] == "bogus"
