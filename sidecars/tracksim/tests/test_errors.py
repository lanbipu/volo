import pytest

from tracksim.domain.errors import (
    TracksimError,
    ConfigError,
    ConflictError,
    NoControllerError,
    TransportError,
    UnsupportedProtocolError,
    InvalidTrajectoryError,
)


def test_base_error_attributes():
    err = TracksimError("boom")
    assert err.code == "INTERNAL"
    assert err.exit_code == 1
    assert err.retryable is False
    assert err.message == "boom"
    assert err.details == {}
    assert isinstance(err, Exception)


def test_base_error_details_passthrough():
    err = TracksimError("boom", details={"k": "v"})
    assert err.details == {"k": "v"}


def test_base_error_default_details_isolated():
    a = TracksimError("a")
    b = TracksimError("b")
    a.details["x"] = 1
    assert b.details == {}


@pytest.mark.parametrize(
    "cls, code, exit_code, retryable",
    [
        (ConfigError, "CONFIG_ERROR", 3, False),
        (ConflictError, "CONFLICT", 6, False),
        (NoControllerError, "NO_CONTROLLER", 10, False),
        (TransportError, "TRANSPORT_SEND_FAILED", 11, True),
        (UnsupportedProtocolError, "UNSUPPORTED_PROTOCOL", 12, False),
        (InvalidTrajectoryError, "INVALID_TRAJECTORY", 13, False),
    ],
)
def test_subclass_semantics(cls, code, exit_code, retryable):
    err = cls("msg")
    assert err.code == code
    assert err.exit_code == exit_code
    assert err.retryable is retryable
    assert err.message == "msg"
    assert isinstance(err, TracksimError)


def test_subclass_details():
    err = TransportError("send failed", details={"target": "239.135.1.1:55555"})
    assert err.details == {"target": "239.135.1.1:55555"}
