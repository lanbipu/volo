//! WinRM dispatch for `health-probes.ps1`.

use crate::core::ssh::{run_json, NodeScript, SshExecutor};
use crate::error::{UecmError, UecmResult};
use serde::Deserialize;
use std::collections::HashMap;
use super::health_check::CheckOutcome;

#[derive(Debug, Deserialize)]
struct ProbeResult {
    pub ok: bool,
    #[serde(default)]
    pub results: HashMap<String, CheckOutcome>,
    #[serde(default)]
    pub message: String,
}

pub fn run(
    host: &str,
    share_unc: &str,
    svc_username: &str,
    expected_shared_path: &str,
    expected_local_path: &str,
    cred: Option<(&str, &str)>,
) -> UecmResult<HashMap<String, CheckOutcome>> {
    // SSH key auth: per-call WinRM cred no longer used (kept until A5). The old
    // loopback `-Local` special-case existed to dodge WinRM-to-self NTLM loopback
    // blocking; SSH-to-self has no such issue and runs the probes in a fresh login
    // (clean admin token), so the loopback host now goes over SSH like any other.
    let _ = cred;
    let exec = SshExecutor::from_config()?;
    let result: ProbeResult = run_json(
        &exec,
        host,
        &NodeScript {
            name: "health-probes.ps1",
            args: serde_json::json!({
                "ShareUnc": share_unc,
                "SvcUsername": svc_username,
                "ExpectedSharedDataCachePath": expected_shared_path,
                "ExpectedLocalDataCachePath": expected_local_path,
            }),
            ssh_user: None,
        },
    )?;
    if !result.ok {
        return Err(UecmError::OperationFailed(format!("health-probes failed: {}", result.message)));
    }
    Ok(result.results)
}
