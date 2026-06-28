//! Wraps the `setup-share-mode-{a,b}.ps1` sidecar scripts. Mode A (`Open`) is
//! Guest+Everyone:Full; Mode B (`Managed`) provisions a local `ddc-svc`
//! account with a freshly generated password and locks the share to that
//! single account.
//!
//! The Mode B password is generated here (not from PowerShell) so the Rust
//! caller can persist it to cmdkey/DPAPI/SQLite immediately after the script
//! returns success — see `commands::shares::create_share`.

use crate::core::ssh::{run_json, NodeScript, SshExecutor};
use crate::error::{UecmError, UecmResult};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
struct ShareScriptResult {
    ok: bool,
    unc_path: String,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ShareCreateResult {
    pub unc_path: String,
    pub message: String,
}

pub fn create_mode_a(
    host: &str,
    share_name: &str,
    local_path: &str,
    operator_user: Option<&str>,
    operator_pass: Option<&str>,
) -> UecmResult<ShareCreateResult> {
    let _ = (operator_user, operator_pass); // SSH key auth; per-call WinRM cred ignored until A5.
    let exec = SshExecutor::from_config()?;
    let result: ShareScriptResult = run_json(
        &exec,
        host,
        &NodeScript {
            name: "setup-share-mode-a.ps1",
            args: serde_json::json!({ "ShareName": share_name, "LocalPath": local_path }),
            ssh_user: None,
        },
    )?;
    if !result.ok {
        return Err(UecmError::OperationFailed(format!(
            "Mode A share creation failed: {}",
            result.message
        )));
    }
    Ok(ShareCreateResult {
        unc_path: result.unc_path,
        message: result.message,
    })
}

pub fn create_mode_b(
    host: &str,
    share_name: &str,
    local_path: &str,
    svc_user: &str,
    svc_pass: &str,
    operator_user: Option<&str>,
    operator_pass: Option<&str>,
) -> UecmResult<ShareCreateResult> {
    let _ = (operator_user, operator_pass); // SSH key auth; per-call WinRM cred ignored until A5.
    let exec = SshExecutor::from_config()?;
    let result: ShareScriptResult = run_json(
        &exec,
        host,
        &NodeScript {
            name: "setup-share-mode-b.ps1",
            args: serde_json::json!({
                "ShareName": share_name,
                "LocalPath": local_path,
                "SvcUsername": svc_user,
                "SvcPassword": svc_pass,
            }),
            ssh_user: None,
        },
    )?;
    if !result.ok {
        return Err(UecmError::OperationFailed(format!(
            "Mode B share creation failed: {}",
            result.message
        )));
    }
    Ok(ShareCreateResult {
        unc_path: result.unc_path,
        message: result.message,
    })
}

#[derive(Debug, Deserialize)]
struct TeardownScriptResult {
    ok: bool,
    message: String,
}

/// Tear down an SMB share on `host`: `Remove-SmbShare` and, for Mode B, the
/// dedicated svc local account (`Remove-LocalUser`). `keep_files = true` leaves
/// the folder + cached files on disk (the default for "取消该服务器部署");
/// `keep_files = false` also deletes `local_path`. Wraps `remove-share.ps1`.
pub fn teardown(
    host: &str,
    share_name: &str,
    svc_username: Option<&str>,
    local_path: Option<&str>,
    keep_files: bool,
) -> UecmResult<String> {
    let exec = SshExecutor::from_config()?;
    let result: TeardownScriptResult = run_json(
        &exec,
        host,
        &NodeScript {
            name: "remove-share.ps1",
            args: serde_json::json!({
                "ShareName": share_name,
                "SvcUsername": svc_username,
                "LocalPath": local_path,
                "KeepFiles": keep_files,
            }),
            ssh_user: None,
        },
    )?;
    if !result.ok {
        return Err(UecmError::OperationFailed(format!(
            "share teardown failed: {}",
            result.message
        )));
    }
    Ok(result.message)
}

/// Generate a 24-byte random password, base64url-encoded (no padding) so
/// the value is PowerShell-safe (no quotes, slashes, `$`, `+`, `=`, spaces
/// — anything that would break `-Password` argv passing). 24 bytes ->
/// exactly 32 chars of [A-Za-z0-9_-].
pub fn generate_svc_password() -> String {
    use base64::Engine;
    use rand::RngCore;
    let mut bytes = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_password_has_expected_length_and_charset() {
        let pwd = generate_svc_password();
        // 24 bytes -> ceil(24*4/3) = 32 chars URL_SAFE_NO_PAD
        assert_eq!(pwd.len(), 32);
        for c in pwd.chars() {
            assert!(
                c.is_ascii_alphanumeric() || c == '-' || c == '_',
                "unexpected char {} in password",
                c
            );
        }
    }

    #[test]
    fn generated_passwords_differ() {
        let a = generate_svc_password();
        let b = generate_svc_password();
        assert_ne!(a, b);
    }
}
