//! Provision a local DDC directory on a remote host: New-Item + icacls.

use crate::core::ssh::{run_json, NodeScript, SshExecutor};
use crate::error::{UecmError, UecmResult};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct CreateResult {
    ok: bool,
    message: String,
    path: Option<String>,
}

/// On Windows: create the directory and set ACLs via icacls locally.
/// On non-Windows (dev/CI): just create the directory (icacls is not available).
#[cfg(windows)]
fn provision_local_cache_dir(local_path: &str, service_account: Option<&str>) -> UecmResult<String> {
    use std::process::Command;
    std::fs::create_dir_all(local_path)
        .map_err(|e| UecmError::OperationFailed(format!("mkdir {}: {}", local_path, e)))?;
    for grant in ["SYSTEM:(OI)(CI)F", "Administrators:(OI)(CI)F"] {
        let status = Command::new("icacls")
            .args([local_path, "/grant", grant, "/T", "/C"])
            .status()
            .map_err(|e| UecmError::OperationFailed(format!("icacls: {}", e)))?;
        if !status.success() {
            return Err(UecmError::OperationFailed(format!("icacls {} failed", grant)));
        }
    }
    if let Some(svc) = service_account {
        let grant = format!("{}:(OI)(CI)F", svc);
        let status = Command::new("icacls")
            .args([local_path, "/grant", &grant, "/T", "/C"])
            .status()
            .map_err(|e| UecmError::OperationFailed(format!("icacls: {}", e)))?;
        if !status.success() {
            return Err(UecmError::OperationFailed(format!("icacls {} failed", grant)));
        }
    }
    Ok(local_path.to_string())
}

#[cfg(not(windows))]
fn provision_local_cache_dir(local_path: &str, _service_account: Option<&str>) -> UecmResult<String> {
    std::fs::create_dir_all(local_path)
        .map_err(|e| UecmError::OperationFailed(format!("mkdir {}: {}", local_path, e)))?;
    Ok(local_path.to_string())
}

pub fn create(
    host: &str,
    local_path: &str,
    service_account: Option<&str>,
    operator: Option<(&str, &str)>,
) -> UecmResult<String> {
    let _ = operator; // SSH key auth; per-call WinRM cred ignored (kept until A5).
    if crate::core::loopback::is_loopback_target(host) {
        return provision_local_cache_dir(local_path, service_account);
    }

    let exec = SshExecutor::from_config()?;
    let r: CreateResult = run_json(
        &exec,
        host,
        &NodeScript {
            name: "create-local-cache-dir.ps1",
            args: serde_json::json!({ "LocalPath": local_path, "ServiceAccount": service_account }),
            ssh_user: None,
        },
    )?;
    if !r.ok {
        return Err(UecmError::OperationFailed(r.message));
    }
    Ok(r.path.unwrap_or(r.message))
}

#[cfg(test)]
mod tests {
    use super::*;
    // (removed `returns_powershell_error_off_windows`: remote create now goes over
    // SSH — errors at ssh connect, and from_config would touch the real config dir.)

    #[cfg(not(windows))]
    #[test]
    fn loopback_call_works_off_windows() {
        let tmp = tempfile::tempdir().unwrap();
        let path_str = tmp.path().to_str().unwrap();
        let r = create("localhost", path_str, None, None);
        // On non-Windows the mkdir succeeds (icacls is skipped via cfg)
        assert!(r.is_ok(), "got: {:?}", r);
    }
}
