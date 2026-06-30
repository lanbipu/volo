//! Wraps the `setup-share-mode-{a,b}.ps1` sidecar scripts. Mode A (`Open`) is
//! Guest+Everyone:Full; Mode B (`Managed`) provisions a local `ddc-svc`
//! account with a freshly generated password and locks the share to that
//! single account.
//!
//! The Mode B password is generated here (not from PowerShell) so the Rust
//! caller can persist it to cmdkey/DPAPI/SQLite immediately after the script
//! returns success — see `commands::shares::create_share`.

use crate::core::ssh::{run_json, NodeScript, SshExecutor};
use crate::data::{machines as data_machines, share_configs::ShareConfig, Db};
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

#[derive(Debug, Deserialize)]
struct GuestAuthScriptResult {
    ok: bool,
    message: String,
}

#[derive(Debug, Deserialize)]
struct ManagedPrepScriptResult {
    ok: bool,
    #[allow(dead_code)]
    verified: bool,
    message: String,
}

/// Mode A client prep: AllowInsecureGuestAuth + Guest cmdkey/net use for each UNC
/// variant so Explorer and UE reach the share without a credential dialog.
pub fn prepare_open_share_client(host: &str, target_uncs: &[String]) -> UecmResult<String> {
    if target_uncs.is_empty() {
        return Err(UecmError::InvalidInput(
            "prepare_open_share_client requires at least one target UNC".into(),
        ));
    }
    let exec = SshExecutor::from_config()?;
    let result: GuestAuthScriptResult = run_json(
        &exec,
        host,
        &NodeScript {
            name: "prepare-open-share-client.ps1",
            args: serde_json::json!({ "TargetUncs": target_uncs }),
            ssh_user: None,
        },
    )?;
    if !result.ok {
        return Err(UecmError::OperationFailed(format!(
            "open share client prep failed: {}",
            result.message
        )));
    }
    Ok(result.message)
}

/// Mode A client teardown: undo `prepare_open_share_client` for one share —
/// remove the per-share targets file + scheduled tasks and drop live guest net
/// use sessions, so leaving/tearing down a share stops the client auto-reconnecting.
pub fn unprepare_open_share_client(host: &str, target_uncs: &[String]) -> UecmResult<String> {
    if target_uncs.is_empty() {
        return Err(UecmError::InvalidInput(
            "unprepare_open_share_client requires at least one target UNC".into(),
        ));
    }
    let exec = SshExecutor::from_config()?;
    let result: GuestAuthScriptResult = run_json(
        &exec,
        host,
        &NodeScript {
            name: "unprepare-open-share-client.ps1",
            args: serde_json::json!({ "TargetUncs": target_uncs }),
            ssh_user: None,
        },
    )?;
    if !result.ok {
        return Err(UecmError::OperationFailed(format!(
            "open share client unprep failed: {}",
            result.message
        )));
    }
    Ok(result.message)
}

/// Mode B client prep: scheduled tasks in the interactive user session + SYSTEM
/// cmdkey so Explorer and LocalSystem services reach the managed share.
pub fn prepare_managed_share_client(
    host: &str,
    target_uncs: &[String],
    cmdkey_targets: &[String],
    svc_server_name: &str,
    svc_user: &str,
    svc_pass: &str,
) -> UecmResult<String> {
    if target_uncs.is_empty() {
        return Err(UecmError::InvalidInput(
            "prepare_managed_share_client requires at least one target UNC".into(),
        ));
    }
    if cmdkey_targets.is_empty() {
        return Err(UecmError::InvalidInput(
            "prepare_managed_share_client requires at least one cmdkey target".into(),
        ));
    }
    let exec = SshExecutor::from_config()?;
    let result: ManagedPrepScriptResult = run_json(
        &exec,
        host,
        &NodeScript {
            name: "prepare-managed-share-client.ps1",
            args: serde_json::json!({
                "TargetUncs": target_uncs,
                "CmdkeyTargets": cmdkey_targets,
                "SvcServerName": svc_server_name,
                "SvcUsername": svc_user,
                "SvcPassword": svc_pass,
            }),
            ssh_user: None,
        },
    )?;
    if !result.ok {
        return Err(UecmError::OperationFailed(format!(
            "managed share client prep failed: {}",
            result.message
        )));
    }
    Ok(result.message)
}

/// Mode B client teardown: undo `prepare_managed_share_client` for one share.
pub fn unprepare_managed_share_client(host: &str, target_uncs: &[String]) -> UecmResult<String> {
    if target_uncs.is_empty() {
        return Err(UecmError::InvalidInput(
            "unprepare_managed_share_client requires at least one target UNC".into(),
        ));
    }
    let exec = SshExecutor::from_config()?;
    let result: GuestAuthScriptResult = run_json(
        &exec,
        host,
        &NodeScript {
            name: "unprepare-managed-share-client.ps1",
            args: serde_json::json!({ "TargetUncs": target_uncs }),
            ssh_user: None,
        },
    )?;
    if !result.ok {
        return Err(UecmError::OperationFailed(format!(
            "managed share client unprep failed: {}",
            result.message
        )));
    }
    Ok(result.message)
}

/// NetBIOS/computer name of the share host for `SERVER\ddc-svc` SMB auth.
pub fn smb_server_name_for_share(db: &Db, share: &ShareConfig) -> UecmResult<String> {
    let unc_target = unc_host(&share.unc_path).ok_or_else(|| {
        UecmError::OperationFailed(format!(
            "cannot parse host from share unc_path '{}'",
            share.unc_path
        ))
    })?;
    if !looks_like_ipv4(&unc_target) {
        return Ok(unc_target);
    }
    let hostname = host_hostname(db, share.host_machine_id)?;
    if !looks_like_ipv4(&hostname) {
        return Ok(hostname);
    }
    Err(UecmError::OperationFailed(format!(
        "share unc_path host '{unc_target}' and machine hostname '{hostname}' are both IPs; \
         set the share host machine's hostname to its NetBIOS name (e.g. LANPC) so Mode B \
         clients can authenticate as SERVER\\ddc-svc"
    )))
}

fn looks_like_ipv4(host: &str) -> bool {
    host.parse::<std::net::Ipv4Addr>().is_ok()
}
pub fn unc_variants_for_share(db: &Db, share: &ShareConfig) -> UecmResult<Vec<String>> {
    let hosts = cmdkey_targets_for_share(db, share)?;
    Ok(hosts
        .into_iter()
        .map(|h| format!(r"\\{}\{}", h, share.share_name))
        .collect())
}

pub fn cmdkey_targets_for_share(db: &Db, share: &ShareConfig) -> UecmResult<Vec<String>> {
    let unc_target = unc_host(&share.unc_path).ok_or_else(|| {
        UecmError::OperationFailed(format!(
            "cannot parse host from share unc_path '{}'",
            share.unc_path
        ))
    })?;
    let mut targets = vec![unc_target];
    for candidate in [
        host_ip(db, share.host_machine_id).ok(),
        host_hostname(db, share.host_machine_id).ok(),
    ]
    .into_iter()
    .flatten()
    {
        if !targets
            .iter()
            .any(|t| t.eq_ignore_ascii_case(&candidate))
        {
            targets.push(candidate);
        }
    }
    Ok(targets)
}

fn unc_host(unc_path: &str) -> Option<String> {
    let host = unc_path.strip_prefix(r"\\")?.split('\\').next().unwrap_or("");
    (!host.is_empty()).then(|| host.to_string())
}

fn host_ip(db: &Db, machine_id: i64) -> UecmResult<String> {
    Ok(data_machines::find_by_id(db, machine_id)?
        .ok_or_else(|| UecmError::InvalidInput(format!("machine {} not found", machine_id)))?
        .ip)
}

fn host_hostname(db: &Db, machine_id: i64) -> UecmResult<String> {
    Ok(data_machines::find_by_id(db, machine_id)?
        .ok_or_else(|| UecmError::InvalidInput(format!("machine {} not found", machine_id)))?
        .hostname)
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
