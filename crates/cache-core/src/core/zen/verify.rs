//! Plan 7 T4.4 — drive a headless UE editor against a project that has zen
//! enabled, watch the engine log for the ZenShared OK line.
//!
//! The actual editor launch / log tailing / process kill lives in the PS
//! sidecar `zen-verify-rules.ps1` (T4.6) because it has to run on the same
//! Windows host as UnrealEditor-Cmd.exe. This module is the Rust side: it
//! builds the inline PowerShell payload that splats the named parameters
//! into the sidecar, ships it across WinRM (with or without explicit
//! credentials), and parses the `{ ok, matched, ... }` envelope back into a
//! strongly-typed `VerifyOutcome`.
//!
//! Both the CLI (`voloctl cache zen verify-rules --run-editor`) and the Tauri
//! command go through `verify_endpoint` so the two surfaces emit the same
//! shape, per plan §3 CLI/Tauri 1:1 contract.

use crate::error::{VoloError, VoloResult};
use serde::{Deserialize, Serialize};

// -----------------------------------------------------------------------------
// Input / output structs
// -----------------------------------------------------------------------------

/// Inputs the sidecar needs to launch + tail an editor.
///
/// `expected_*` fields are optional assertions — when present, a successful
/// match line whose host/port/namespace don't agree flips `ok` to false. The
/// sidecar still kills the editor and still returns the matched line so
/// callers can render the mismatch in their report.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VerifyInput {
    pub ue_root: String,
    pub uproject_path: String,
    /// Wall-clock timeout for the regex match. 0 is rejected here (would
    /// trip the sidecar's `TimeoutSeconds > 0` guard).
    pub timeout_seconds: u64,
    pub expected_host: Option<String>,
    pub expected_port: Option<i64>,
    /// Defaults to `"ue.ddc"` in the sidecar when omitted; we forward the
    /// caller's value as-is and let the sidecar pick the default.
    pub expected_namespace: Option<String>,
}

/// Decoded payload from `zen-verify-rules.ps1`'s JSON envelope. Mirrors the
/// fields documented in the sidecar header. `ok` is reflected at the call
/// site (`verify_endpoint` returns `Err` on `ok=false`); this struct carries
/// the diagnostic context regardless.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VerifyOutcome {
    pub matched: bool,
    pub match_line: Option<String>,
    pub matched_host: Option<String>,
    pub matched_port: Option<i64>,
    pub matched_namespace: Option<String>,
    pub elapsed_sec: u64,
    pub editor_pid: Option<i64>,
    pub killed: bool,
    /// Last ~50 lines of the editor's stdout/stderr. Useful for triage when
    /// the regex misses (verbose-level mismatch, ini schema drift, etc.).
    pub log_tail: Vec<String>,
    /// Set when the sidecar took an early-exit path (timeout, editor crash,
    /// host/port/namespace assertion mismatch). `None` on the success path.
    pub message: Option<String>,
    /// Forwarded from the sidecar's `exit_code` field — only set when the
    /// editor exited before the regex matched.
    pub exit_code: Option<i64>,
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/// Run `zen-verify-rules.ps1` against `host` and return the parsed outcome.
///
/// `cred` is a back-compat shim — the sidecar runs over SSH (uecm-svc key auth)
/// regardless of `cred`. Same envelope pattern as the M2 zen handlers in
/// `cli::domain_zen` — `run_remote` / `parse_envelope`.
///
/// Returns `Err(VoloError::PowerShell)` when the sidecar's envelope has
/// `ok=false` (timeout / editor crash / host mismatch); the message includes
/// the sidecar's `message` field so the caller can render it directly. On
/// `ok=true` the function returns the full `VerifyOutcome`.
pub fn verify_endpoint(
    host: &str,
    cred: Option<(&str, &str)>,
    input: &VerifyInput,
) -> VoloResult<VerifyOutcome> {
    // Same validation the sidecar will do, but failing here gives a clearer
    // error than waiting for the SSH round-trip to return `ok:false`.
    if input.ue_root.trim().is_empty() {
        return Err(VoloError::InvalidInput("ue_root must be non-empty".into()));
    }
    if input.uproject_path.trim().is_empty() {
        return Err(VoloError::InvalidInput(
            "uproject_path must be non-empty".into(),
        ));
    }
    if input.timeout_seconds == 0 {
        return Err(VoloError::InvalidInput(
            "timeout_seconds must be > 0".into(),
        ));
    }
    // Codex P2: the sidecar's `if ($ExpectedPort -gt 0)` treats 0 / negative
    // as "unset", silently skipping the port assertion. A typo like
    // `--expected-port=-1` would then return ok=true without verifying the
    // requested port. Reject anything outside the TCP port range here so a
    // bad value never reaches the sidecar.
    if let Some(p) = input.expected_port {
        if !(1..=65535).contains(&p) {
            return Err(VoloError::InvalidInput(format!(
                "expected_port must be in 1..=65535; got {p}"
            )));
        }
    }

    // SSH key auth (uecm-svc); operator cred ignored (param kept as a shim). The
    // node script reads its named params from stdin JSON and supplies its own
    // defaults (TimeoutSeconds=300, ExpectedNamespace='ue.ddc', ExpectedPort=0)
    // when a field is absent, so we only emit the fields we have.
    let _ = cred;
    let raw = run_verify_node(host, input)?;
    parse_outcome_json(&raw)
}

/// Run the node-pure `zen-verify-rules.ps1` over SSH, passing `input` as the
/// stdin JSON parameter object. Returns the raw stdout envelope so
/// `parse_outcome_json` can apply the same `ok`-flag hardening as before.
fn run_verify_node(host: &str, input: &VerifyInput) -> VoloResult<String> {
    use crate::core::ssh::{NodeScript, RemoteExecutor, SshExecutor};
    let mut args = serde_json::json!({
        "UeRoot": input.ue_root,
        "UprojectPath": input.uproject_path,
        "TimeoutSeconds": input.timeout_seconds,
    });
    if let Some(obj) = args.as_object_mut() {
        if let Some(h) = &input.expected_host {
            obj.insert("ExpectedHost".into(), serde_json::Value::String(h.clone()));
        }
        if let Some(p) = input.expected_port {
            obj.insert("ExpectedPort".into(), serde_json::json!(p));
        }
        if let Some(n) = &input.expected_namespace {
            obj.insert("ExpectedNamespace".into(), serde_json::Value::String(n.clone()));
        }
    }
    // Loopback (`--run-editor` against the operator's own machine) runs the
    // verifier locally instead of SSH-to-self — handled inside `SshExecutor::run`
    // for every node script, so no special-casing is needed here.
    let exec = SshExecutor::from_config()?;
    let out = exec.run(
        host,
        &NodeScript { name: "zen-verify-rules.ps1", args, ssh_user: None },
    )?;
    if out.stdout.trim().is_empty() && out.exit_code != 0 {
        return Err(crate::core::ssh::map_exit(out.exit_code, &out.stderr));
    }
    Ok(out.stdout)
}

// -----------------------------------------------------------------------------
// Internal helpers (separated for unit-testability without WinRM)
// -----------------------------------------------------------------------------

/// Parse the `{ ok, matched, ... }` envelope into a `VerifyOutcome`. Returns
/// `Err(VoloError::PowerShell)` on `ok=false` so the caller layer doesn't need
/// to remember to re-check the flag. Same hardening as
/// `cli::domain_zen::parse_envelope`: only the literal boolean `true` is
/// success — missing / non-bool `ok` is treated as a protocol violation.
pub fn parse_outcome_json(raw: &str) -> VoloResult<VerifyOutcome> {
    let envelope: serde_json::Value = serde_json::from_str(raw).map_err(|e| {
        VoloError::PowerShell(format!(
            "zen-verify-rules returned non-JSON output: {e}; raw: {}",
            raw.chars().take(200).collect::<String>()
        ))
    })?;
    let ok = match envelope.get("ok").and_then(|v| v.as_bool()) {
        Some(b) => b,
        None => {
            return Err(VoloError::PowerShell(format!(
                "zen-verify-rules returned envelope without a boolean `ok` field; raw: {}",
                raw.chars().take(200).collect::<String>()
            )));
        }
    };

    let outcome = extract_outcome(&envelope);

    if ok {
        Ok(outcome)
    } else {
        // Preserve the sidecar's message in the error AND include the
        // diagnostic outcome (matched/elapsed/log_tail) under a JSON
        // payload so callers logging the error keep the context. We use
        // PowerShell as the category because the contract is "the
        // sidecar reported a logical failure" — same category the rest
        // of M2 uses for envelope-ok=false.
        let msg = outcome
            .message
            .clone()
            .unwrap_or_else(|| "zen-verify-rules reported ok=false".to_string());
        Err(VoloError::PowerShell(format!(
            "zen-verify-rules: {msg}; outcome: {}",
            serde_json::to_string(&outcome).unwrap_or_else(|_| "<unserializable>".into())
        )))
    }
}

/// Field-by-field extraction from the envelope. Kept lenient — missing
/// fields collapse to `None` / defaults so a future sidecar that adds new
/// keys doesn't trip a strict-decode failure on older clients.
fn extract_outcome(envelope: &serde_json::Value) -> VerifyOutcome {
    let matched = envelope
        .get("matched")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let match_line = envelope
        .get("match_line")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let matched_host = envelope
        .get("matched_host")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let matched_port = envelope.get("matched_port").and_then(|v| v.as_i64());
    let matched_namespace = envelope
        .get("matched_namespace")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let elapsed_sec = envelope
        .get("elapsed_sec")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let editor_pid = envelope.get("editor_pid").and_then(|v| v.as_i64());
    let killed = envelope
        .get("killed")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let log_tail = envelope
        .get("log_tail")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let message = envelope
        .get("message")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let exit_code = envelope.get("exit_code").and_then(|v| v.as_i64());

    VerifyOutcome {
        matched,
        match_line,
        matched_host,
        matched_port,
        matched_namespace,
        elapsed_sec,
        editor_pid,
        killed,
        log_tail,
        message,
        exit_code,
    }
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn full_input() -> VerifyInput {
        VerifyInput {
            ue_root: r"D:\Program Files\Epic Games\UE_5.7".to_string(),
            uproject_path: r"E:\RenderStream Projects\test_0311\test_0311.uproject"
                .to_string(),
            timeout_seconds: 300,
            expected_host: Some("127.0.0.1".to_string()),
            expected_port: Some(8558),
            expected_namespace: Some("ue.ddc".to_string()),
        }
    }

    // ---- input validation ----------------------------------------------

    #[test]
    fn verify_endpoint_rejects_empty_ue_root() {
        let mut i = full_input();
        i.ue_root = "  ".into();
        let e = verify_endpoint("10.0.0.1", None, &i).unwrap_err();
        assert!(matches!(e, VoloError::InvalidInput(_)));
    }

    #[test]
    fn verify_endpoint_rejects_empty_uproject_path() {
        let mut i = full_input();
        i.uproject_path = "".into();
        let e = verify_endpoint("10.0.0.1", None, &i).unwrap_err();
        assert!(matches!(e, VoloError::InvalidInput(_)));
    }

    #[test]
    fn verify_endpoint_rejects_zero_timeout() {
        let mut i = full_input();
        i.timeout_seconds = 0;
        let e = verify_endpoint("10.0.0.1", None, &i).unwrap_err();
        assert!(matches!(e, VoloError::InvalidInput(_)));
    }

    // ---- parse_outcome_json --------------------------------------------

    #[test]
    fn parse_outcome_json_success_envelope() {
        let raw = r#"{
            "ok": true, "matched": true,
            "match_line": "LogDerivedDataCache: Display: ZenShared: Using ZenServer HTTP service at 127.0.0.1 with namespace ue.ddc status: OK!",
            "matched_host": "127.0.0.1", "matched_port": 8558, "matched_namespace": "ue.ddc",
            "elapsed_sec": 47, "editor_pid": 12345, "killed": true,
            "log_tail": ["line1", "line2"]
        }"#;
        let o = parse_outcome_json(raw).unwrap();
        assert!(o.matched);
        assert_eq!(o.matched_host.as_deref(), Some("127.0.0.1"));
        assert_eq!(o.matched_port, Some(8558));
        assert_eq!(o.matched_namespace.as_deref(), Some("ue.ddc"));
        assert_eq!(o.elapsed_sec, 47);
        assert_eq!(o.editor_pid, Some(12345));
        assert!(o.killed);
        assert_eq!(o.log_tail.len(), 2);
        assert_eq!(o.message, None);
        assert_eq!(o.exit_code, None);
    }

    #[test]
    fn parse_outcome_json_failure_envelope_returns_err() {
        let raw = r#"{
            "ok": false, "matched": false,
            "message": "timeout waiting for ZenShared OK line after 300s",
            "elapsed_sec": 300, "editor_pid": 100, "killed": true,
            "log_tail": ["line1"]
        }"#;
        let e = parse_outcome_json(raw).unwrap_err();
        match e {
            VoloError::PowerShell(msg) => {
                assert!(msg.contains("timeout waiting for ZenShared"));
                assert!(msg.contains("outcome"));
            }
            other => panic!("expected PowerShell error, got {other:?}"),
        }
    }

    #[test]
    fn parse_outcome_json_editor_crash_envelope() {
        let raw = r#"{
            "ok": false, "matched": false,
            "message": "editor process exited before match (exit code 3)",
            "exit_code": 3, "elapsed_sec": 12, "editor_pid": 100, "killed": false,
            "log_tail": []
        }"#;
        let e = parse_outcome_json(raw).unwrap_err();
        // The outcome JSON should round-trip carrying exit_code.
        match e {
            VoloError::PowerShell(msg) => {
                assert!(msg.contains("\"exit_code\":3"));
                assert!(msg.contains("editor process exited"));
            }
            other => panic!("expected PowerShell error, got {other:?}"),
        }
    }

    #[test]
    fn parse_outcome_json_missing_ok_is_protocol_error() {
        let raw = r#"{ "matched": true }"#;
        let e = parse_outcome_json(raw).unwrap_err();
        assert!(matches!(e, VoloError::PowerShell(_)));
    }

    #[test]
    fn parse_outcome_json_non_json_is_powershell_error() {
        let e = parse_outcome_json("not json at all").unwrap_err();
        assert!(matches!(e, VoloError::PowerShell(_)));
    }

    #[test]
    fn parse_outcome_json_assertion_mismatch_envelope() {
        // The sidecar emits ok=false + matched=true when assertions disagree
        // — we should still surface the matched_* fields in the outcome that
        // ships in the error string.
        let raw = r#"{
            "ok": false, "matched": true,
            "match_line": "LogDerivedDataCache: Display: ZenShared: Using ZenServer HTTP service at 192.168.10.20 with namespace ue.ddc status: OK!",
            "matched_host": "192.168.10.20", "matched_port": null,
            "matched_namespace": "ue.ddc",
            "message": "host mismatch: expected=127.0.0.1 got=192.168.10.20",
            "elapsed_sec": 21, "editor_pid": 12345, "killed": true,
            "log_tail": []
        }"#;
        let e = parse_outcome_json(raw).unwrap_err();
        match e {
            VoloError::PowerShell(msg) => {
                assert!(msg.contains("host mismatch"));
                assert!(msg.contains("192.168.10.20"));
                assert!(msg.contains("\"matched\":true"));
            }
            other => panic!("expected PowerShell error, got {other:?}"),
        }
    }

    // ---- struct (de)serialization stability ------------------------------

    #[test]
    fn verify_input_round_trips_via_serde_json() {
        let i = full_input();
        let s = serde_json::to_string(&i).unwrap();
        let back: VerifyInput = serde_json::from_str(&s).unwrap();
        assert_eq!(i, back);
    }

    #[test]
    fn verify_outcome_round_trips_via_serde_json() {
        let o = VerifyOutcome {
            matched: true,
            match_line: Some("a".into()),
            matched_host: Some("h".into()),
            matched_port: Some(123),
            matched_namespace: Some("ns".into()),
            elapsed_sec: 9,
            editor_pid: Some(7),
            killed: true,
            log_tail: vec!["x".into()],
            message: None,
            exit_code: None,
        };
        let s = serde_json::to_string(&o).unwrap();
        let back: VerifyOutcome = serde_json::from_str(&s).unwrap();
        assert_eq!(o, back);
    }
}
