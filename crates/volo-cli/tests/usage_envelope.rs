use std::process::Command;

#[test]
fn invalid_flag_json_is_error_envelope_exit_64() {
    // Migrated to `voloctl uecm`: the unknown flag rides the `uecm` subtree, so
    // the top-level parse fails → uecm `usage_error` envelope / exit 64 (NOT the
    // lmt `invalid_input`/exit-2 path; review #2 keeps the two distinct).
    let exe = env!("CARGO_BIN_EXE_voloctl");
    let out = Command::new(exe)
        .args(["uecm", "--no-such-flag", "--output", "json"])
        .env("NO_COLOR", "1")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(64));
    let err: serde_json::Value = serde_json::from_slice(&out.stderr).unwrap();
    assert_eq!(err["status"], "error");
    assert_eq!(err["error"]["code"], "usage_error");
    assert_eq!(err["error"]["exit_code"], 64);
}

#[test]
fn bad_config_json_is_full_error_envelope_on_stderr() {
    // A `--config` load failure happens BEFORE the envelope-aware emitter is
    // built and routes through `finish_error`. Under `--output json` it must
    // emit the full ErrorEnvelope shape (schema_version/status/operation_id/
    // error{code,exit_code,message,retryable}/meta), NOT the legacy flat
    // `{"type":"error",...}`.
    let exe = env!("CARGO_BIN_EXE_voloctl");
    let out = Command::new(exe)
        .args([
            "uecm",
            "--config",
            "/nonexistent/uecm-cli-no-such-config.yml",
            "--output",
            "json",
            "system",
            "version",
        ])
        .env("NO_COLOR", "1")
        .output()
        .unwrap();
    // Configuration error -> exit 3 (environment failure family).
    assert_eq!(out.status.code(), Some(3));
    let err: serde_json::Value = serde_json::from_slice(&out.stderr).unwrap();
    assert_eq!(err["schema_version"], "1.0");
    assert_eq!(err["status"], "error");
    assert_eq!(err["operation_id"], "");
    assert_eq!(err["error"]["code"], "environment_error");
    assert_eq!(err["error"]["exit_code"], 3);
    assert_eq!(err["error"]["retryable"], false);
    assert!(err["error"]["message"].is_string());
    // Must NOT be the legacy flat shape.
    assert!(err.get("type").is_none());
    assert!(err["meta"]["timestamp"].is_string());
}
