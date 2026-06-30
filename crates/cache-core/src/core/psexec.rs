//! Wraps `inject-system-credential.ps1`. Over SSH we run the node-pure script
//! on the client node; it uses PsExec64 -s to drop into the SYSTEM context and
//! stores a host-specific cmdkey entry so SYSTEM-context services (e.g. the UE
//! engine) can transparently reach the share.
//!
//! `PsExec64.exe` is installed on the node at onboarding (enable-ssh.ps1) to
//! `C:\ProgramData\UECM\PsExec64.exe`; the node script resolves it there.

use crate::core::ssh::{run_json, NodeScript, SshExecutor};
use crate::error::{UecmError, UecmResult};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct InjectScriptResult {
    ok: bool,
    message: String,
}

/// Inject the SMB svc credential into `client_host`'s SYSTEM credential store
/// for `target_host`. `operator_user`/`operator_pass` are ignored (SSH key auth
/// replaced the per-call WinRM credential); the params stay until A5 strips the
/// WinRM cred plumbing from every caller.
pub fn inject_system_credential(
    client_host: &str,
    target_host: &str,
    svc_server_name: Option<&str>,
    svc_user: &str,
    svc_pass: &str,
    operator_user: Option<&str>,
    operator_pass: Option<&str>,
) -> UecmResult<String> {
    let _ = (operator_user, operator_pass);
    let exec = SshExecutor::from_config()?;
    let mut args = serde_json::json!({
        "TargetHost": target_host,
        "SvcUsername": svc_user,
        "SvcPassword": svc_pass,
    });
    if let Some(server) = svc_server_name.filter(|s| !s.is_empty()) {
        args["SvcServerName"] = serde_json::Value::String(server.to_string());
    }
    let result: InjectScriptResult = run_json(
        &exec,
        client_host,
        &NodeScript {
            name: "inject-system-credential.ps1",
            args,
            ssh_user: None,
        },
    )?;
    if !result.ok {
        return Err(UecmError::OperationFailed(format!(
            "SYSTEM credential injection failed: {}",
            result.message
        )));
    }
    Ok(result.message)
}

// (Old `#[cfg(not(windows))]` "returns PowerShell error" test removed: injection
// now goes over SSH — on a dev box it errors at ssh connect, and from_config
// would touch the real config dir. Remote behavior is validated on a real node.)
