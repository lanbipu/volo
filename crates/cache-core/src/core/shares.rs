//! Wraps the `setup-share-mode-{a,b}.ps1` sidecar scripts. Mode A (`Open`) is
//! Guest+Everyone:Full; Mode B (`Managed`) provisions a local `ddc-svc`
//! account with a freshly generated password and locks the share to that
//! single account.
//!
//! The Mode B password is generated here (not from PowerShell) so the Rust
//! caller can persist it to cmdkey/DPAPI/SQLite immediately after the script
//! returns success — see `commands::shares::create_share`.

use crate::core::ssh::{run_json, NodeScript, SshExecutor};
use crate::data::{
    credentials as data_credentials, machines as data_machines,
    share_configs::{self, ShareConfig, ShareMode},
    Db,
};
use crate::error::{VoloError, VoloResult};
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
) -> VoloResult<ShareCreateResult> {
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
        return Err(VoloError::OperationFailed(format!(
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
) -> VoloResult<ShareCreateResult> {
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
        return Err(VoloError::OperationFailed(format!(
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
) -> VoloResult<String> {
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
        return Err(VoloError::OperationFailed(format!(
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
pub fn prepare_open_share_client(host: &str, target_uncs: &[String]) -> VoloResult<String> {
    if target_uncs.is_empty() {
        return Err(VoloError::InvalidInput(
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
        return Err(VoloError::OperationFailed(format!(
            "open share client prep failed: {}",
            result.message
        )));
    }
    Ok(result.message)
}

/// Mode A client teardown: undo `prepare_open_share_client` for one share —
/// remove the per-share targets file + scheduled tasks and drop live guest net
/// use sessions, so leaving/tearing down a share stops the client auto-reconnecting.
pub fn unprepare_open_share_client(host: &str, target_uncs: &[String]) -> VoloResult<String> {
    if target_uncs.is_empty() {
        return Err(VoloError::InvalidInput(
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
        return Err(VoloError::OperationFailed(format!(
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
) -> VoloResult<String> {
    if target_uncs.is_empty() {
        return Err(VoloError::InvalidInput(
            "prepare_managed_share_client requires at least one target UNC".into(),
        ));
    }
    if cmdkey_targets.is_empty() {
        return Err(VoloError::InvalidInput(
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
        return Err(VoloError::OperationFailed(format!(
            "managed share client prep failed: {}",
            result.message
        )));
    }
    Ok(result.message)
}

/// Mode B client teardown: undo `prepare_managed_share_client` for one share.
/// `cmdkey_targets` mirrors prepare so the teardown clears the same vault aliases
/// it added (interactive user + SYSTEM); empty falls back to the UNC hosts in PS.
pub fn unprepare_managed_share_client(
    host: &str,
    target_uncs: &[String],
    cmdkey_targets: &[String],
) -> VoloResult<String> {
    if target_uncs.is_empty() {
        return Err(VoloError::InvalidInput(
            "unprepare_managed_share_client requires at least one target UNC".into(),
        ));
    }
    let exec = SshExecutor::from_config()?;
    let result: GuestAuthScriptResult = run_json(
        &exec,
        host,
        &NodeScript {
            name: "unprepare-managed-share-client.ps1",
            args: serde_json::json!({
                "TargetUncs": target_uncs,
                "CmdkeyTargets": cmdkey_targets,
            }),
            ssh_user: None,
        },
    )?;
    if !result.ok {
        return Err(VoloError::OperationFailed(format!(
            "managed share client unprep failed: {}",
            result.message
        )));
    }
    Ok(result.message)
}

/// NetBIOS/computer name of a machine for `SERVER\uecm-svc` / `SERVER\ddc-svc` SMB auth.
pub fn smb_server_name_for_machine(db: &Db, machine_id: i64) -> VoloResult<String> {
    let machine = data_machines::find_by_id(db, machine_id)?.ok_or_else(|| {
        VoloError::InvalidInput(format!("machine {} not found", machine_id))
    })?;
    resolve_smb_server_name(&machine.hostname, &machine.ip, || probe_netbios_name_over_ssh(&machine.ip))
}

/// NetBIOS/computer name of the share host for `SERVER\ddc-svc` SMB auth.
pub fn smb_server_name_for_share(db: &Db, share: &ShareConfig) -> VoloResult<String> {
    let unc_target = unc_host(&share.unc_path).ok_or_else(|| {
        VoloError::OperationFailed(format!(
            "cannot parse host from share unc_path '{}'",
            share.unc_path
        ))
    })?;
    let hostname = host_hostname(db, share.host_machine_id)?;
    let ip = host_ip(db, share.host_machine_id).unwrap_or_else(|_| unc_target.clone());
    resolve_smb_server_name(&unc_target, &hostname, || probe_netbios_name_over_ssh(&ip))
}

#[derive(Debug, Deserialize)]
struct NetbiosProbeRaw {
    ok: bool,
    #[serde(default)]
    name: String,
}

#[derive(Debug, Deserialize)]
struct SmbShareProbeRaw {
    ok: bool,
    exists: bool,
    #[serde(default)]
    message: String,
}

/// SSH probe: does `share_name` exist as a local SMB share on `host`?
pub fn smb_share_exists_on_host(host: &str, share_name: &str) -> VoloResult<bool> {
    let exec = SshExecutor::from_config()?;
    let result: SmbShareProbeRaw = run_json(
        &exec,
        host,
        &NodeScript {
            name: "probe-smb-share.ps1",
            args: serde_json::json!({ "ShareName": share_name }),
            ssh_user: None,
        },
    )?;
    if !result.ok {
        return Err(VoloError::OperationFailed(format!(
            "SMB share probe failed on {host}: {}",
            result.message
        )));
    }
    Ok(result.exists)
}

/// Re-create a registered share when the DB row exists but the host SMB share was removed.
pub fn ensure_registered_share_live(db: &Db, share: &ShareConfig) -> VoloResult<()> {
    let host_addr = host_ip(db, share.host_machine_id)?;
    if smb_share_exists_on_host(&host_addr, &share.share_name)? {
        return Ok(());
    }
    let result = match share.mode {
        ShareMode::Open => {
            create_mode_a(
                &host_addr,
                &share.share_name,
                &share.local_path,
                None,
                None,
            )?
        }
        ShareMode::Managed => {
            let alias = share.credential_alias.as_ref().ok_or_else(|| {
                VoloError::OperationFailed("managed share missing credential_alias".into())
            })?;
            let pass = crate::core::secrets::get_share_secret_migrating(alias)?.ok_or_else(|| {
                VoloError::InvalidInput(format!(
                    "Mode B share secret '{alias}' missing from SecretStore"
                ))
            })?;
            let user = data_credentials::find_by_alias(db, alias)?
                .map(|c| c.username)
                .unwrap_or_else(|| "ddc-svc".to_string());
            let bare = user
                .rsplit('\\')
                .next()
                .filter(|s| !s.is_empty())
                .unwrap_or(user.as_str());
            create_mode_b(
                &host_addr,
                &share.share_name,
                &share.local_path,
                bare,
                &pass,
                None,
                None,
            )?
        }
    };
    if let Some(id) = share.id {
        share_configs::update_unc_path(db, id, &result.unc_path)?;
    }
    Ok(())
}

/// Verify an explicit distribute UNC before target preflight. Registered shares
/// are self-healed from their DB definition; unregistered manual UNC values can
/// only be probed and receive a precise error when the share is absent.
pub fn ensure_source_unc_share_live(
    db: &Db,
    source_machine_id: i64,
    source_host: &str,
    unc: &str,
) -> VoloResult<()> {
    let share_name = unc_share_name(unc).ok_or_else(|| {
        VoloError::InvalidInput(format!("cannot parse share name from source UNC '{unc}'"))
    })?;
    if let Some(share) = share_configs::find_by_host(db, source_machine_id)?
        .into_iter()
        .find(|share| share.share_name.eq_ignore_ascii_case(&share_name))
    {
        return ensure_registered_share_live(db, &share);
    }
    if smb_share_exists_on_host(source_host, &share_name)? {
        return Ok(());
    }
    Err(VoloError::OperationFailed(format!(
        "source SMB share '{share_name}' does not exist on {source_host} and has no DB record to recreate"
    )))
}

/// Best-effort SSH probe for `$env:COMPUTERNAME` when the DB only has an IP label.
fn probe_netbios_name_over_ssh(host: &str) -> Option<String> {
    let exec = SshExecutor::from_config().ok()?;
    let result: NetbiosProbeRaw = run_json(
        &exec,
        host,
        &NodeScript {
            name: "probe-netbios-name.ps1",
            args: serde_json::json!({}),
            ssh_user: None,
        },
    )
    .ok()?;
    if result.ok && !result.name.is_empty() && !looks_like_ipv4(&result.name) {
        Some(result.name)
    } else {
        None
    }
}

/// Pick the server prefix for `SERVER\account` SMB auth.
fn resolve_smb_server_name(
    primary: &str,
    secondary: &str,
    probe: impl FnOnce() -> Option<String>,
) -> VoloResult<String> {
    if !looks_like_ipv4(primary) {
        return Ok(primary.to_string());
    }
    if !looks_like_ipv4(secondary) {
        return Ok(secondary.to_string());
    }
    if let Some(name) = probe() {
        return Ok(name);
    }
    // Last resort: qualify with the same IP the UNC uses (common when machines
    // were onboarded by scan and never given a friendly hostname row).
    Ok(primary.to_string())
}

fn looks_like_ipv4(host: &str) -> bool {
    host.parse::<std::net::Ipv4Addr>().is_ok()
}
pub fn unc_variants_for_share(db: &Db, share: &ShareConfig) -> VoloResult<Vec<String>> {
    let hosts = cmdkey_targets_for_share(db, share)?;
    Ok(hosts
        .into_iter()
        .map(|h| format!(r"\\{}\{}", h, share.share_name))
        .collect())
}

pub fn cmdkey_targets_for_share(db: &Db, share: &ShareConfig) -> VoloResult<Vec<String>> {
    let unc_target = unc_host(&share.unc_path).ok_or_else(|| {
        VoloError::OperationFailed(format!(
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

fn host_ip(db: &Db, machine_id: i64) -> VoloResult<String> {
    Ok(data_machines::find_by_id(db, machine_id)?
        .ok_or_else(|| VoloError::InvalidInput(format!("machine {} not found", machine_id)))?
        .ip)
}

fn host_hostname(db: &Db, machine_id: i64) -> VoloResult<String> {
    Ok(data_machines::find_by_id(db, machine_id)?
        .ok_or_else(|| VoloError::InvalidInput(format!("machine {} not found", machine_id)))?
        .hostname)
}

/// A registered share whose `local_path` prefix-covers an absolute path.
#[derive(Debug, Clone)]
pub struct SharePathCover {
    pub share: ShareConfig,
    /// Path from `share.local_path` to the covered absolute path (empty = exact).
    pub rel: String,
}

fn norm_win_path(p: &str) -> String {
    p.replace('/', "\\")
        .trim_end_matches('\\')
        .to_ascii_lowercase()
}

/// Case-insensitive Windows path equality (separator- and trailing-slash-tolerant).
pub fn same_win_path(a: &str, b: &str) -> bool {
    norm_win_path(a) == norm_win_path(b)
}

/// Longest registered share on `host_machine_id` whose `local_path` covers `abs_path`.
/// Mirrors `share_reveal_target` in `commands/bootstrap.rs`.
pub fn share_covering_local_path(
    db: &Db,
    host_machine_id: i64,
    abs_path: &str,
) -> VoloResult<Option<SharePathCover>> {
    let shares = share_configs::find_by_host(db, host_machine_id)?;
    let path_norm = abs_path.replace('/', "\\");
    let path_low = norm_win_path(abs_path);
    let best = shares
        .iter()
        .filter_map(|share| {
            let base_low = norm_win_path(&share.local_path);
            if base_low.is_empty() {
                return None;
            }
            if path_low == base_low {
                Some((share, String::new()))
            } else if path_low.starts_with(&base_low)
                && path_low.as_bytes().get(base_low.len()) == Some(&b'\\')
            {
                let rel = path_norm[base_low.len() + 1..]
                    .trim_end_matches('\\')
                    .to_string();
                Some((share, rel))
            } else {
                None
            }
        })
        .max_by_key(|(share, _)| share.local_path.len());
    Ok(best.map(|(share, rel)| SharePathCover {
        share: share.clone(),
        rel,
    }))
}

/// Share name segment from `\\host\share\...` (second path component).
pub fn unc_share_name(unc: &str) -> Option<String> {
    let name = unc
        .trim_start_matches('\\')
        .split('\\')
        .nth(1)?
        .trim();
    (!name.is_empty()).then(|| name.to_string())
}

/// `\\host\share` roots to try for distribute `net use` (IP + hostname variants).
pub fn share_mount_root_variants(
    db: &Db,
    source_machine_id: i64,
    reach_host: &str,
    named_share_unc: &str,
) -> VoloResult<Vec<String>> {
    let shares = share_configs::find_by_host(db, source_machine_id)?;
    if let Some(share) = shares
        .iter()
        .find(|s| unc_names_share(named_share_unc, &s.unc_path))
    {
        let primary = reachable_share_unc(reach_host, &share.share_name, "");
        let mut roots = unc_variants_for_share(db, share)?;
        if !roots
            .iter()
            .any(|r| r.eq_ignore_ascii_case(&primary))
        {
            roots.insert(0, primary);
        }
        return Ok(dedupe_uncs_case_insensitive(roots));
    }

    let share_name = unc_share_name(named_share_unc).ok_or_else(|| {
        VoloError::InvalidInput(format!(
            "cannot parse share name from distribute UNC '{named_share_unc}'"
        ))
    })?;
    let mut roots = vec![reachable_share_unc(reach_host, &share_name, "")];
    for candidate in [
        host_hostname(db, source_machine_id).ok(),
        host_ip(db, source_machine_id).ok(),
    ]
    .into_iter()
    .flatten()
    {
        let unc = reachable_share_unc(&candidate, &share_name, "");
        if !roots.iter().any(|r| r.eq_ignore_ascii_case(&unc)) {
            roots.push(unc);
        }
    }
    Ok(roots)
}

fn dedupe_uncs_case_insensitive(uncs: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(uncs.len());
    for unc in uncs {
        if !out.iter().any(|u| u.eq_ignore_ascii_case(&unc)) {
            out.push(unc);
        }
    }
    out
}

/// True when `candidate` names the registered share `share_unc` — matched by
/// leading path segments, case-insensitively, ignoring trailing separators and
/// any appended source subdir.
pub fn unc_names_share(candidate: &str, share_unc: &str) -> bool {
    let cand: Vec<_> = candidate
        .split(['\\', '/'])
        .filter(|segment| !segment.is_empty())
        .collect();
    let base: Vec<_> = share_unc
        .split(['\\', '/'])
        .filter(|segment| !segment.is_empty())
        .collect();
    if base.is_empty() || base.len() > cand.len() {
        return false;
    }
    cand[..base.len()]
        .iter()
        .zip(base.iter())
        .all(|(left, right)| left.eq_ignore_ascii_case(right))
}

/// Build `\\reach_host\share\rel` using the address targets actually dial (usually IP).
pub fn reachable_share_unc(reach_host: &str, share_name: &str, rel: &str) -> String {
    let rel = rel.trim_matches(['\\', '/']);
    if rel.is_empty() {
        format!(r"\\{reach_host}\{share_name}")
    } else {
        format!(r"\\{reach_host}\{share_name}\{rel}")
    }
}

/// SMB credential for a target pulling from a registered share (Mode A = guest, Mode B = ddc-svc).
pub fn resolve_share_pull_cred(
    db: &Db,
    share: &ShareConfig,
    read_secret: bool,
) -> VoloResult<(Option<String>, Option<String>)> {
    match share.mode {
        ShareMode::Open => Ok((None, None)),
        ShareMode::Managed => {
            let alias = share.credential_alias.as_ref().ok_or_else(|| {
                VoloError::OperationFailed("managed share missing credential_alias".into())
            })?;
            let server = smb_server_name_for_share(db, share)?;
            let user = data_credentials::find_by_alias(db, alias)?
                .map(|c| c.username)
                .unwrap_or_else(|| "ddc-svc".to_string());
            let qualified = qualify_smb_user(&server, &user);
            if !read_secret {
                return Ok((Some(qualified), None));
            }
            let pass = crate::core::secrets::get_share_secret_migrating(alias)?
                .ok_or_else(|| {
                    VoloError::InvalidInput(format!(
                        "Mode B share secret '{alias}' missing from SecretStore; \
                         re-run `share create --mode b`"
                    ))
                })?;
            Ok((Some(qualified), Some(pass)))
        }
    }
}

pub fn qualify_smb_user(server: &str, username: &str) -> String {
    if username.contains('\\') {
        username.to_string()
    } else {
        format!(r"{server}\{username}")
    }
}

fn open_share_target_uncs_for_host(db: &Db, host_machine_id: i64) -> VoloResult<Vec<String>> {
    let mut all = Vec::new();
    for share in share_configs::find_by_host(db, host_machine_id)? {
        if share.mode != ShareMode::Open {
            continue;
        }
        for unc in unc_variants_for_share(db, &share)? {
            if !all.iter().any(|u: &String| u.eq_ignore_ascii_case(&unc)) {
                all.push(unc);
            }
        }
    }
    Ok(all)
}

/// Ensure a Mode A guest share exists for `local_path` and prep `client_machine_ids`
/// for silent guest access. Idempotent — mirrors `commands/shares::ensure_open_dir_share`.
pub fn ensure_open_dir_share(
    db: &Db,
    host_machine_id: i64,
    share_name: &str,
    local_path: &str,
    client_machine_ids: &[i64],
) -> VoloResult<()> {
    let host_addr = host_ip(db, host_machine_id)?;
    let existing = share_configs::find_by_host(db, host_machine_id)?
        .into_iter()
        .find(|s| {
            s.mode == ShareMode::Open
                && s.share_name.eq_ignore_ascii_case(share_name)
                && same_win_path(&s.local_path, local_path)
        });
    if let Some(share) = existing {
        ensure_registered_share_live(db, &share)?;
    } else {
        let result = create_mode_a(&host_addr, share_name, local_path, None, None)?;
        if let Some(prior) = share_configs::find_by_host(db, host_machine_id)?
            .into_iter()
            .find(|s| s.share_name.eq_ignore_ascii_case(share_name))
        {
            if let Some(id) = prior.id {
                share_configs::delete(db, id)?;
            }
        }
        share_configs::insert(
            db,
            &ShareConfig {
                id: None,
                host_machine_id,
                share_name: share_name.to_string(),
                unc_path: result.unc_path,
                local_path: local_path.to_string(),
                mode: ShareMode::Open,
                credential_alias: None,
            },
        )?;
    }
    let target_uncs = open_share_target_uncs_for_host(db, host_machine_id)?;
    prep_open_share_clients_for_targets(db, client_machine_ids, &target_uncs)
}

/// Mode A client prep on each target so Explorer/UE get guest sessions; also sets
/// machine-wide AllowInsecureGuestAuth (needed when distribute runs as uecm-svc).
pub fn prep_open_share_clients_for_targets(
    db: &Db,
    client_machine_ids: &[i64],
    target_uncs: &[String],
) -> VoloResult<()> {
    if target_uncs.is_empty() {
        return Ok(());
    }
    for client_id in client_machine_ids {
        let client_ip = host_ip(db, *client_id)?;
        prepare_open_share_client(&client_ip, target_uncs).map_err(|e| {
            VoloError::OperationFailed(format!(
                "open-share client prep failed on machine {client_id}: {e}"
            ))
        })?;
    }
    Ok(())
}

/// Prep all open-share UNC variants on targets (convenience wrapper).
pub fn prep_open_share_clients_on_targets(
    db: &Db,
    host_machine_id: i64,
    client_machine_ids: &[i64],
) -> VoloResult<()> {
    let target_uncs = open_share_target_uncs_for_host(db, host_machine_id)?;
    prep_open_share_clients_for_targets(db, client_machine_ids, &target_uncs)
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

    #[test]
    fn unc_share_name_parses_second_segment() {
        assert_eq!(
            unc_share_name(r"\\192.168.0.1\volo-dir-d-projects\X"),
            Some("volo-dir-d-projects".into())
        );
    }

    #[test]
    fn unc_names_share_matches_case_and_subdir() {
        let share = r"\\HOST\DDC";
        assert!(unc_names_share(r"\\host\ddc\DerivedDataCache", share));
        assert!(!unc_names_share(r"\\HOST\DDCX", share));
    }
}
