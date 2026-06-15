from __future__ import annotations

from typing import Any

SCHEMA_VERSION = "1.0"
CONTRACT_VERSION = "1.0"

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_CONFIG = 3
EXIT_CONFLICT = 6
EXIT_TIMEOUT = 7
EXIT_EXTERNAL = 8
EXIT_NO_CONTROLLER = 10
EXIT_TRANSPORT = 11
EXIT_UNSUPPORTED = 12
EXIT_INVALID_INPUT = 13
EXIT_SIGINT = 130


def success_envelope(
    operation_id: str,
    data: Any,
    *,
    request_id: str,
    duration_ms: int,
    timestamp: str,
) -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "status": "ok",
        "operation_id": operation_id,
        "data": data,
        "meta": {
            "request_id": request_id,
            "duration_ms": duration_ms,
            "timestamp": timestamp,
        },
    }


def error_envelope(
    operation_id: str,
    *,
    code: str,
    exit_code: int,
    message: str,
    retryable: bool,
    details: dict[str, Any],
    request_id: str,
    duration_ms: int,
    timestamp: str,
) -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "status": "error",
        "operation_id": operation_id,
        "error": {
            "code": code,
            "exit_code": exit_code,
            "message": message,
            "retryable": retryable,
            "details": details,
        },
        "meta": {
            "request_id": request_id,
            "duration_ms": duration_ms,
            "timestamp": timestamp,
        },
    }
