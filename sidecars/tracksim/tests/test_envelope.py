from tracksim import envelope as env


def test_version_constants():
    assert env.SCHEMA_VERSION == "1.0"
    assert env.CONTRACT_VERSION == "1.0"


def test_exit_code_constants():
    assert env.EXIT_OK == 0
    assert env.EXIT_USAGE == 2
    assert env.EXIT_CONFIG == 3
    assert env.EXIT_CONFLICT == 6
    assert env.EXIT_TIMEOUT == 7
    assert env.EXIT_EXTERNAL == 8
    assert env.EXIT_NO_CONTROLLER == 10
    assert env.EXIT_TRANSPORT == 11
    assert env.EXIT_UNSUPPORTED == 12
    assert env.EXIT_INVALID_INPUT == 13
    assert env.EXIT_SIGINT == 130


def test_success_envelope_shape():
    out = env.success_envelope(
        "config.show",
        {"k": "v"},
        request_id="req-1",
        duration_ms=42,
        timestamp="2026-06-02T00:00:00Z",
    )
    assert out == {
        "schema_version": "1.0",
        "status": "ok",
        "operation_id": "config.show",
        "data": {"k": "v"},
        "meta": {
            "request_id": "req-1",
            "duration_ms": 42,
            "timestamp": "2026-06-02T00:00:00Z",
        },
    }


def test_error_envelope_shape():
    out = env.error_envelope(
        "sim.send",
        code="TRANSPORT_SEND_FAILED",
        exit_code=11,
        message="send failed",
        retryable=True,
        details={"target": "239.135.1.1:55555"},
        request_id="req-2",
        duration_ms=7,
        timestamp="2026-06-02T00:00:01Z",
    )
    assert out == {
        "schema_version": "1.0",
        "status": "error",
        "operation_id": "sim.send",
        "error": {
            "code": "TRANSPORT_SEND_FAILED",
            "exit_code": 11,
            "message": "send failed",
            "retryable": True,
            "details": {"target": "239.135.1.1:55555"},
        },
        "meta": {
            "request_id": "req-2",
            "duration_ms": 7,
            "timestamp": "2026-06-02T00:00:01Z",
        },
    }
