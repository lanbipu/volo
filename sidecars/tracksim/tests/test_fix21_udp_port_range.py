"""Fix 21 (round 4 finding 4): UdpTransport must reject ports outside 0..65535."""
from __future__ import annotations

import pytest

from tracksim.domain.errors import TransportError
from tracksim.transports.udp import UdpTransport


def test_port_99999_raises_transport_error():
    """Port 99999 must raise TransportError, not OverflowError/traceback."""
    with pytest.raises(TransportError):
        UdpTransport("unicast", "127.0.0.1", 99999)


def test_port_negative_raises_transport_error():
    """Negative port must raise TransportError."""
    with pytest.raises(TransportError):
        UdpTransport("unicast", "127.0.0.1", -1)


def test_port_65536_raises_transport_error():
    """Port exactly 65536 must raise TransportError."""
    with pytest.raises(TransportError):
        UdpTransport("unicast", "127.0.0.1", 65536)


def test_port_0_is_valid():
    """Port 0 must not raise TransportError."""
    t = UdpTransport("unicast", "127.0.0.1", 0)
    t.close()


def test_port_65535_is_valid():
    """Port 65535 must not raise TransportError."""
    t = UdpTransport("unicast", "127.0.0.1", 65535)
    t.close()


def test_port_6000_is_valid():
    """Port 6000 (typical FreeD) must not raise TransportError."""
    t = UdpTransport("unicast", "127.0.0.1", 6000)
    t.close()
