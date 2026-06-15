from __future__ import annotations

from typing import Any


class TracksimError(Exception):
    """Base class for all tracksim domain errors."""

    code: str = "INTERNAL"
    exit_code: int = 1
    retryable: bool = False

    def __init__(self, message: str, *, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.details: dict[str, Any] = details if details is not None else {}


class ConfigError(TracksimError):
    code = "CONFIG_ERROR"
    exit_code = 3
    retryable = False


class ConflictError(TracksimError):
    code = "CONFLICT"
    exit_code = 6
    retryable = False


class NoControllerError(TracksimError):
    code = "NO_CONTROLLER"
    exit_code = 10
    retryable = False


class TransportError(TracksimError):
    code = "TRANSPORT_SEND_FAILED"
    exit_code = 11
    retryable = True


class UnsupportedProtocolError(TracksimError):
    code = "UNSUPPORTED_PROTOCOL"
    exit_code = 12
    retryable = False


class InvalidTrajectoryError(TracksimError):
    code = "INVALID_TRAJECTORY"
    exit_code = 13
    retryable = False


class FbxConversionError(TracksimError):
    code = "FBX_CONVERSION_FAILED"
    exit_code = 13
    retryable = False
