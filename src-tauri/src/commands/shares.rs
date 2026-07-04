//! Tauri commands for SMB share creation, listing, deletion, and per-client
//! SYSTEM credential injection.
//!
//! Mode A (`Open`) — Guest+Everyone:Full. No svc credential to track.
//! Mode B (`Managed`) — generates a 24-byte URL-safe password, runs the
//! PS script (host-side `New-SmbShare` + local `ddc-svc`), then on success
//! persists the alias to:
//!   1. `cmdkey` (transparent SMB auth on the operator host)
//!   2. DPAPI-encrypted store (so future `inject_share_credential_to_clients`
//!      can read the plaintext back)
//!   3. SQLite `credentials` row (so the alias surfaces in the UI list)
//!
//! Persistence happens AFTER the PS script succeeds — a PS failure leaves
//! SQLite untouched.

use cache_core::core::{psexec, shares as core_shares};
use cache_core::data::{
    credentials as data_creds, machines as data_machines, share_configs as data_shares,
    CredentialKind, CredentialRecord, Db, ShareConfig, ShareMode,
};
use cache_core::error::{VoloError, VoloResult};
use serde::Serialize;
use tauri::State;

#[derive(Debug, Serialize)]
pub struct CreateShareResponse {
    pub share_config_id: i64,
    pub unc_path: String,
    pub mode: ShareMode,
    pub credential_alias: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct InjectionResult {
    pub client_machine_id: i64,
    pub ok: bool,
    pub message: String,
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

fn push_injection_results(
    results: &mut Vec<InjectionResult>,
    client_id: i64,
    client_ip: &str,
    cmdkey_targets: &[String],
    svc_server_name: &str,
    svc_user: &str,
    svc_pass: &str,
    op_user: Option<&str>,
    op_pass: Option<&str>,
) {
    let mut parts = Vec::with_capacity(cmdkey_targets.len());
    let mut all_ok = true;
    for target in cmdkey_targets {
        match psexec::inject_system_credential(
            client_ip,
            target,
            Some(svc_server_name),
            svc_user,
            svc_pass,
            op_user,
            op_pass,
        ) {
            Ok(msg) => parts.push(format!("{target}: {msg}")),
            Err(e) => {
                all_ok = false;
                parts.push(format!("{target}: {e}"));
            }
        }
    }
    results.push(InjectionResult {
        client_machine_id: client_id,
        ok: all_ok,
        message: parts.join("; "),
    });
}

#[tauri::command]
pub fn create_share(
    db: State<'_, Db>,
    host_machine_id: i64,
    mode: ShareMode,
    share_name: String,
    local_path: String,
    operator_credential_alias: Option<String>,
    svc_username: Option<String>,
) -> VoloResult<CreateShareResponse> {
    let host_ip = host_ip(&db, host_machine_id)?;
    // SSH key auth: operator cred vestigial (param kept as shim, Vue compat).
    let _ = &operator_credential_alias;
    let (op_user, op_pass): (Option<String>, Option<String>) = (None, None);

    let (unc_path, persisted_alias): (String, Option<String>) = match mode {
        ShareMode::Open => {
            let result = core_shares::create_mode_a(
                &host_ip,
                &share_name,
                &local_path,
                op_user.as_deref(),
                op_pass.as_deref(),
            )?;
            (result.unc_path, None)
        }
        ShareMode::Managed => {
            let svc_user = svc_username
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or("ddc-svc")
                .to_string();
            let svc_pass = core_shares::generate_svc_password();
            let result = core_shares::create_mode_b(
                &host_ip,
                &share_name,
                &local_path,
                &svc_user,
                &svc_pass,
                op_user.as_deref(),
                op_pass.as_deref(),
            )?;
            // PS script succeeded — host-side `ddc-svc` exists and
            // `New-SmbShare` is up. Now persist the alias locally so the
            // operator host can transparently mount the share AND so future
            // injection calls can read the password back.
            let host_hn = host_hostname(&db, host_machine_id)?;
            let alias = format!("UECM:share:{}:{}", host_hn, svc_user);
            // Persist the svc password to the cross-platform SecretStore (AES-GCM)
            // so inject_share_credential_to_clients reads it back from any operator
            // OS — replaces the old cmdkey + DPAPI persistence.
            cache_core::core::secrets::SecretStore::from_config()?.put(&alias, &svc_pass)?;
            // SQLite credential record — idempotent (skip if alias somehow
            //    already exists from a prior partial run).
            if data_creds::find_by_alias(&db, &alias)?.is_none() {
                data_creds::insert(
                    &db,
                    &CredentialRecord {
                        id: None,
                        alias: alias.clone(),
                        kind: CredentialKind::Share,
                        username: svc_user.clone(),
                    },
                )?;
            }
            (result.unc_path, Some(alias))
        }
    };

    let cfg = ShareConfig {
        id: None,
        host_machine_id,
        share_name: share_name.clone(),
        unc_path: unc_path.clone(),
        local_path: local_path.clone(),
        mode,
        credential_alias: persisted_alias.clone(),
    };
    // PS scripts replace existing host-side shares idempotently; mirror that
    // on the SQLite side so a Mode A -> Mode B re-creation doesn't trip the
    // (host_machine_id, share_name) UNIQUE constraint.
    let existing = data_shares::find_by_host(&db, host_machine_id)?
        .into_iter()
        .find(|s| s.share_name == share_name);
    let share_config_id = if let Some(prior) = existing {
        if let Some(prior_id) = prior.id {
            data_shares::delete(&db, prior_id)?;
        }
        data_shares::insert(&db, &cfg)?
    } else {
        data_shares::insert(&db, &cfg)?
    };

    Ok(CreateShareResponse {
        share_config_id,
        unc_path,
        mode,
        credential_alias: persisted_alias,
    })
}

#[tauri::command]
pub fn inject_share_credential_to_clients(
    db: State<'_, Db>,
    share_config_id: i64,
    client_machine_ids: Vec<i64>,
    operator_credential_alias: Option<String>,
) -> VoloResult<Vec<InjectionResult>> {
    let share = data_shares::find_by_id(&db, share_config_id)?.ok_or_else(|| {
        VoloError::InvalidInput(format!("share_config {} not found", share_config_id))
    })?;
    if share.mode != ShareMode::Managed {
        return Err(VoloError::InvalidInput(
            "credential injection only applies to Mode B (managed) shares".to_string(),
        ));
    }
    let svc_alias = share.credential_alias.as_ref().ok_or_else(|| {
        VoloError::OperationFailed("managed share missing credential_alias".to_string())
    })?;
    let svc_cred = data_creds::find_by_alias(&db, svc_alias)?.ok_or_else(|| {
        VoloError::OperationFailed(format!(
            "credential alias '{}' from share row not found in credentials",
            svc_alias
        ))
    })?;
    // Mode B share svc password from the SecretStore (was DPAPI). Mirrors
    // cli/domain_share.rs::find_share_svc_password.
    let svc_pass = cache_core::core::secrets::get_share_secret_migrating(svc_alias)?
        .ok_or_else(|| {
            VoloError::InvalidInput(format!(
                "no stored svc password for alias '{}'; re-create the share via `share create --mode b`",
                svc_alias
            ))
        })?;
    let cmdkey_targets = core_shares::cmdkey_targets_for_share(&db, &share)?;
    let svc_server_name = core_shares::smb_server_name_for_share(&db, &share)?;
    // SSH key auth: operator cred vestigial (param kept as shim, Vue compat).
    let _ = &operator_credential_alias;
    let (op_user, op_pass): (Option<String>, Option<String>) = (None, None);

    let mut results = Vec::with_capacity(client_machine_ids.len());
    for client_id in client_machine_ids {
        let client_ip = match host_ip(&db, client_id) {
            Ok(ip) => ip,
            Err(e) => {
                results.push(InjectionResult {
                    client_machine_id: client_id,
                    ok: false,
                    message: e.to_string(),
                });
                continue;
            }
        };
        push_injection_results(
            &mut results,
            client_id,
            &client_ip,
            &cmdkey_targets,
            &svc_server_name,
            &svc_cred.username,
            &svc_pass,
            op_user.as_deref(),
            op_pass.as_deref(),
        );
    }
    Ok(results)
}

/// Prepare Mode B (managed) share clients: interactive-user scheduled tasks +
/// SYSTEM cmdkey so Explorer and LocalSystem services reach the share.
#[tauri::command]
pub fn prepare_managed_share_clients(
    db: State<'_, Db>,
    share_config_id: i64,
    client_machine_ids: Vec<i64>,
) -> VoloResult<Vec<InjectionResult>> {
    let share = data_shares::find_by_id(&db, share_config_id)?.ok_or_else(|| {
        VoloError::InvalidInput(format!("share_config {} not found", share_config_id))
    })?;
    if share.mode != ShareMode::Managed {
        return Err(VoloError::InvalidInput(
            "managed share client prep only applies to Mode B (managed) shares".to_string(),
        ));
    }
    let svc_alias = share.credential_alias.as_ref().ok_or_else(|| {
        VoloError::OperationFailed("managed share missing credential_alias".to_string())
    })?;
    let svc_cred = data_creds::find_by_alias(&db, svc_alias)?.ok_or_else(|| {
        VoloError::OperationFailed(format!(
            "credential alias '{}' from share row not found in credentials",
            svc_alias
        ))
    })?;
    let svc_pass = cache_core::core::secrets::get_share_secret_migrating(svc_alias)?
        .ok_or_else(|| {
            VoloError::InvalidInput(format!(
                "no stored svc password for alias '{}'; re-create the share via Mode B deploy",
                svc_alias
            ))
        })?;
    let target_uncs = core_shares::unc_variants_for_share(&db, &share)?;
    let cmdkey_targets = core_shares::cmdkey_targets_for_share(&db, &share)?;
    let svc_server_name = core_shares::smb_server_name_for_share(&db, &share)?;

    let mut results = Vec::with_capacity(client_machine_ids.len());
    for client_id in client_machine_ids {
        let client_ip = match host_ip(&db, client_id) {
            Ok(ip) => ip,
            Err(e) => {
                results.push(InjectionResult {
                    client_machine_id: client_id,
                    ok: false,
                    message: e.to_string(),
                });
                continue;
            }
        };
        match core_shares::prepare_managed_share_client(
            &client_ip,
            &target_uncs,
            &cmdkey_targets,
            &svc_server_name,
            &svc_cred.username,
            &svc_pass,
        ) {
            Ok(msg) => results.push(InjectionResult {
                client_machine_id: client_id,
                ok: true,
                message: msg,
            }),
            Err(e) => results.push(InjectionResult {
                client_machine_id: client_id,
                ok: false,
                message: e.to_string(),
            }),
        }
    }
    Ok(results)
}

/// Tear down Mode B (managed) client prep for ONE share.
#[tauri::command]
pub fn unprepare_managed_share_clients(
    db: State<'_, Db>,
    share_config_id: i64,
    client_machine_ids: Vec<i64>,
) -> VoloResult<Vec<InjectionResult>> {
    let share = data_shares::find_by_id(&db, share_config_id)?.ok_or_else(|| {
        VoloError::InvalidInput(format!("share_config {} not found", share_config_id))
    })?;
    if share.mode != ShareMode::Managed {
        return Err(VoloError::InvalidInput(
            "managed share client unprep only applies to Mode B (managed) shares".to_string(),
        ));
    }
    let target_uncs = core_shares::unc_variants_for_share(&db, &share)?;
    // Same cmdkey aliases prepare added, so teardown clears exactly those.
    let cmdkey_targets = core_shares::cmdkey_targets_for_share(&db, &share)?;
    let mut results = Vec::with_capacity(client_machine_ids.len());
    for client_id in client_machine_ids {
        let client_ip = match host_ip(&db, client_id) {
            Ok(ip) => ip,
            Err(e) => {
                results.push(InjectionResult {
                    client_machine_id: client_id,
                    ok: false,
                    message: e.to_string(),
                });
                continue;
            }
        };
        match core_shares::unprepare_managed_share_client(&client_ip, &target_uncs, &cmdkey_targets) {
            Ok(msg) => results.push(InjectionResult {
                client_machine_id: client_id,
                ok: true,
                message: msg,
            }),
            Err(e) => results.push(InjectionResult {
                client_machine_id: client_id,
                ok: false,
                message: e.to_string(),
            }),
        }
    }
    Ok(results)
}

/// Prepare Mode A (open) share clients: Guest cmdkey + net use for silent UNC access.
#[tauri::command]
pub fn prepare_open_share_clients(
    db: State<'_, Db>,
    share_config_id: i64,
    client_machine_ids: Vec<i64>,
) -> VoloResult<Vec<InjectionResult>> {
    let share = data_shares::find_by_id(&db, share_config_id)?.ok_or_else(|| {
        VoloError::InvalidInput(format!("share_config {} not found", share_config_id))
    })?;
    if share.mode != ShareMode::Open {
        return Err(VoloError::InvalidInput(
            "open share client prep only applies to Mode A (open) shares".to_string(),
        ));
    }
    let target_uncs = core_shares::unc_variants_for_share(&db, &share)?;
    let mut results = Vec::with_capacity(client_machine_ids.len());
    for client_id in client_machine_ids {
        let client_ip = match host_ip(&db, client_id) {
            Ok(ip) => ip,
            Err(e) => {
                results.push(InjectionResult {
                    client_machine_id: client_id,
                    ok: false,
                    message: e.to_string(),
                });
                continue;
            }
        };
        match core_shares::prepare_open_share_client(&client_ip, &target_uncs) {
            Ok(msg) => {
                results.push(InjectionResult {
                    client_machine_id: client_id,
                    ok: true,
                    message: msg,
                });
            }
            Err(e) => results.push(InjectionResult {
                client_machine_id: client_id,
                ok: false,
                message: e.to_string(),
            }),
        }
    }
    Ok(results)
}

/// Tear down Mode A (open) client prep for ONE share — remove the per-share
/// scheduled tasks + targets file + live guest net use sessions on each client,
/// so leaving/tearing down a share stops the client auto-reconnecting at logon.
#[tauri::command]
pub fn unprepare_open_share_clients(
    db: State<'_, Db>,
    share_config_id: i64,
    client_machine_ids: Vec<i64>,
) -> VoloResult<Vec<InjectionResult>> {
    let share = data_shares::find_by_id(&db, share_config_id)?.ok_or_else(|| {
        VoloError::InvalidInput(format!("share_config {} not found", share_config_id))
    })?;
    if share.mode != ShareMode::Open {
        return Err(VoloError::InvalidInput(
            "open share client unprep only applies to Mode A (open) shares".to_string(),
        ));
    }
    let target_uncs = core_shares::unc_variants_for_share(&db, &share)?;
    let mut results = Vec::with_capacity(client_machine_ids.len());
    for client_id in client_machine_ids {
        let client_ip = match host_ip(&db, client_id) {
            Ok(ip) => ip,
            Err(e) => {
                results.push(InjectionResult {
                    client_machine_id: client_id,
                    ok: false,
                    message: e.to_string(),
                });
                continue;
            }
        };
        match core_shares::unprepare_open_share_client(&client_ip, &target_uncs) {
            Ok(msg) => results.push(InjectionResult {
                client_machine_id: client_id,
                ok: true,
                message: msg,
            }),
            Err(e) => results.push(InjectionResult {
                client_machine_id: client_id,
                ok: false,
                message: e.to_string(),
            }),
        }
    }
    Ok(results)
}

#[tauri::command]
pub fn list_shares(db: State<'_, Db>) -> VoloResult<Vec<ShareConfig>> {
    data_shares::list_all(&db)
}

#[tauri::command]
pub fn delete_share(
    db: State<'_, Db>,
    share_config_id: i64,
    also_remove_remote: bool,
) -> VoloResult<()> {
    // delete_share = pure unmanage: drop the SQLite row only, leave the remote
    // share serving. To actually un-deploy the share on the host (Remove-SmbShare
    // + Mode-B account, keep folder) use `teardown_share` instead.
    let _ = also_remove_remote;
    data_shares::delete(&db, share_config_id)?;
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct TeardownShareResult {
    pub share_config_id: i64,
    pub host: String,
    pub share_name: String,
    pub kept_files: bool,
    pub message: String,
}

/// Tear down an SMB share *on the host*: stop sharing the folder
/// (`Remove-SmbShare`) and, for Mode B, remove the dedicated `ddc-svc` account.
/// `keep_files = true` keeps the folder + cached files on disk. On success the
/// SQLite share row (and any Mode-B credential/secret) is dropped so the share
/// leaves the managed list. Distinct from `delete_share`, which only unmanages.
#[tauri::command]
pub fn teardown_share(
    db: State<'_, Db>,
    share_config_id: i64,
    keep_files: bool,
) -> VoloResult<TeardownShareResult> {
    let share = data_shares::find_by_id(&db, share_config_id)?.ok_or_else(|| {
        VoloError::InvalidInput(format!("share_config {} not found", share_config_id))
    })?;
    let host_ip = host_ip(&db, share.host_machine_id)?;
    let host_hn = host_hostname(&db, share.host_machine_id)?;

    // Mode B: the dedicated svc account (username on the credential row keyed by
    // the share alias) is removed together with the share.
    let svc_username: Option<String> = match share.mode {
        ShareMode::Managed => share
            .credential_alias
            .as_deref()
            .and_then(|alias| data_creds::find_by_alias(&db, alias).ok().flatten())
            .map(|c| c.username),
        ShareMode::Open => None,
    };

    let message = core_shares::teardown(
        &host_ip,
        &share.share_name,
        svc_username.as_deref(),
        Some(&share.local_path),
        keep_files,
    )?;

    // Remote teardown succeeded — drop local bookkeeping. Mode B: also remove the
    // stored secret + credential row so the freed alias doesn't linger in the UI.
    if let Some(alias) = share.credential_alias.as_deref() {
        if let Ok(store) = cache_core::core::secrets::SecretStore::from_config() {
            let _ = store.delete(alias);
        }
        let _ = data_creds::delete_by_alias(&db, alias);
    }
    data_shares::delete(&db, share_config_id)?;

    Ok(TeardownShareResult {
        share_config_id,
        host: host_hn,
        share_name: share.share_name,
        kept_files: keep_files,
        message,
    })
}

#[derive(Debug, Serialize)]
pub struct EnsureOpenDirShareResponse {
    pub share_config_id: i64,
    pub unc_path: String,
    pub created: bool,
    pub client_results: Vec<InjectionResult>,
}

/// Case-insensitive Windows path equality (separator- and trailing-slash-
/// tolerant) for deciding whether an existing share already covers `path`.
fn same_win_path(a: &str, b: &str) -> bool {
    let norm = |p: &str| {
        p.replace('/', "\\")
            .trim_end_matches('\\')
            .to_ascii_lowercase()
    };
    norm(a) == norm(b)
}

/// Union of the guest-reachable UNC variants of EVERY Mode A share on one
/// host. `prepare-open-share-client.ps1` keys its targets file + scheduled
/// task on the UNC host alone — preparing a client with a single share's UNCs
/// would silently clobber the auto-reconnect list of any other open share on
/// the same machine, so every (re-)prep must carry the full per-host set.
fn open_share_target_uncs_for_host(db: &Db, host_machine_id: i64) -> VoloResult<Vec<String>> {
    let mut all: Vec<String> = Vec::new();
    for share in data_shares::find_by_host(db, host_machine_id)? {
        if share.mode != ShareMode::Open {
            continue;
        }
        for unc in core_shares::unc_variants_for_share(db, &share)? {
            if !all.iter().any(|u| u.eq_ignore_ascii_case(&unc)) {
                all.push(unc);
            }
        }
    }
    Ok(all)
}

/// One-call orchestration behind「设置缓存目录 → 同时开放远程访问」: ensure a
/// Mode A (Guest) share named `share_name` exists on `host_machine_id` for
/// exactly `local_path`, then prep every machine in `client_machine_ids` for
/// silent guest access (AllowInsecureGuestAuth + cmdkey + net use logon task).
/// Idempotent: an existing share row with the same name+path skips the host-side
/// re-create; a same-named share pointing elsewhere is replaced (the Mode A PS
/// script re-creates host-side idempotently, `create_share` replaces the row).
/// Client prep failures are reported per machine, never fail the whole call.
#[tauri::command]
pub fn ensure_open_dir_share(
    db: State<'_, Db>,
    host_machine_id: i64,
    share_name: String,
    local_path: String,
    client_machine_ids: Vec<i64>,
) -> VoloResult<EnsureOpenDirShareResponse> {
    let existing = data_shares::find_by_host(&db, host_machine_id)?
        .into_iter()
        .find(|s| {
            s.mode == ShareMode::Open
                && s.share_name.eq_ignore_ascii_case(&share_name)
                && same_win_path(&s.local_path, &local_path)
        });
    let (share_config_id, unc_path, created) = match existing {
        Some(share) => (share.id.unwrap_or_default(), share.unc_path, false),
        None => {
            let resp = create_share(
                db.clone(),
                host_machine_id,
                ShareMode::Open,
                share_name,
                local_path,
                None,
                None,
            )?;
            (resp.share_config_id, resp.unc_path, true)
        }
    };

    // Full per-host UNC set (includes the row just ensured above) — see
    // `open_share_target_uncs_for_host` for why prep must never be per-share.
    let target_uncs = open_share_target_uncs_for_host(&db, host_machine_id)?;
    let mut client_results = Vec::with_capacity(client_machine_ids.len());
    for client_id in client_machine_ids {
        let outcome = host_ip(&db, client_id)
            .and_then(|ip| core_shares::prepare_open_share_client(&ip, &target_uncs));
        match outcome {
            Ok(msg) => client_results.push(InjectionResult {
                client_machine_id: client_id,
                ok: true,
                message: msg,
            }),
            Err(e) => client_results.push(InjectionResult {
                client_machine_id: client_id,
                ok: false,
                message: e.to_string(),
            }),
        }
    }

    Ok(EnsureOpenDirShareResponse {
        share_config_id,
        unc_path,
        created,
        client_results,
    })
}

/// Undo `ensure_open_dir_share` for one host. Order matters:
/// 1. tear the share down host-side first (Remove-SmbShare, files kept) — if
///    that fails the SQLite row survives and the whole call is retriable;
/// 2. then fix up each client: if OTHER Mode A shares remain on this host,
///    re-prep with the remaining per-host UNC union (rewrites the host-keyed
///    targets file instead of deleting the shared logon task); only when none
///    remain, unprep (drop task + targets + guest sessions).
/// A client that's offline here keeps a stale logon task pointing at the
/// removed share — harmless (its guest `net use` just fails silently) and
/// self-healing: the next per-host prep re-registers with `-Force`.
/// No-op success if no matching Mode A share is on record.
#[tauri::command]
pub fn remove_open_dir_share(
    db: State<'_, Db>,
    host_machine_id: i64,
    share_name: String,
    client_machine_ids: Vec<i64>,
) -> VoloResult<Vec<InjectionResult>> {
    let Some(share) = data_shares::find_by_host(&db, host_machine_id)?
        .into_iter()
        .find(|s| s.mode == ShareMode::Open && s.share_name.eq_ignore_ascii_case(&share_name))
    else {
        return Ok(Vec::new());
    };
    let share_id = share.id.unwrap_or_default();
    let removed_uncs = core_shares::unc_variants_for_share(&db, &share)?;
    teardown_share(db.clone(), share_id, true)?;
    let remaining_uncs = open_share_target_uncs_for_host(&db, host_machine_id)?;
    let mut results = Vec::with_capacity(client_machine_ids.len());
    for client_id in client_machine_ids {
        let outcome = host_ip(&db, client_id).and_then(|ip| {
            if remaining_uncs.is_empty() {
                core_shares::unprepare_open_share_client(&ip, &removed_uncs)
            } else {
                core_shares::prepare_open_share_client(&ip, &remaining_uncs)
            }
        });
        match outcome {
            Ok(msg) => results.push(InjectionResult {
                client_machine_id: client_id,
                ok: true,
                message: msg,
            }),
            Err(e) => results.push(InjectionResult {
                client_machine_id: client_id,
                ok: false,
                message: e.to_string(),
            }),
        }
    }
    Ok(results)
}
