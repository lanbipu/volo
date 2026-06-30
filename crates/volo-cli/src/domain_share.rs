//! `uecm-cli share <action>` handlers.

use crate::args::ShareAction;
use crate::credential_args::CredentialArgs;
use crate::destructive::{self, Outcome};
use crate::output::{EmitSerialize, Event};
use crate::run::Ctx;
use cache_core::data::share_configs::{self as data_shares, ShareMode};
use cache_core::error::{UecmError, UecmResult};

pub fn handle(ctx: &mut Ctx<'_>, action: ShareAction) -> UecmResult<()> {
    match action {
        ShareAction::List => list(ctx),
        ShareAction::Forget { id, yes, dry_run } => forget(ctx, id, yes, dry_run),
        ShareAction::Create { mode, host, share, local_path, yes, dry_run, cred } => {
            let outcome = destructive::check(yes, dry_run, "share.create")?;
            // Validate mode + credential + host inventory locally before
            // reporting any dry-run success. The real `create()` path does a
            // `machines::find_by_ip` lookup AFTER side effects; we want
            // dry-run preview to fail-fast on host typos.
            let resolved_mode = match mode.as_str() {
                "a" | "A" => "open (Mode A, Guest+Everyone)",
                "b" | "B" => "managed (Mode B, dedicated ddc-svc)",
                other => {
                    return Err(UecmError::InvalidInput(format!(
                        "unknown share mode '{}'; expected 'a' or 'b'",
                        other
                    )));
                }
            };
            let db = ctx.require_db()?;
            // Preflight only — see env.set for stdin-double-read rationale.
            cred.preflight(db)?;
            // Mirror `create()` host resolution: IP first, then hostname fallback.
            let host_found = cache_core::data::machines::find_by_ip(db, &host)?.is_some()
                || cache_core::data::machines::list_all(db)
                    .ok()
                    .is_some_and(|rows| rows.iter().any(|m| m.hostname == host));
            if !host_found {
                return Err(UecmError::InvalidInput(format!(
                    "host '{}' is not in the machine inventory; run `machine add` first",
                    host
                )));
            }
            if outcome == Outcome::DryRun {
                destructive::emit_plan(
                    ctx.emitter.as_mut(),
                    "share.create",
                    serde_json::json!({
                        "mode": mode,
                        "mode_resolved": resolved_mode,
                        "host": host,
                        "share": share,
                        "local_path": local_path,
                    }),
                );
                return Ok(());
            }
            create(ctx, &mode, &host, &share, &local_path, &cred)
        }
        ShareAction::InjectSystemCred { client_host, target_host, svc_user, yes, dry_run, cred } => {
            let outcome = destructive::check(yes, dry_run, "share.inject-system-cred")?;
            let db = ctx.require_db()?;
            cred.preflight(db)?;
            if outcome == Outcome::DryRun {
                // Dry-run validates that a Mode-B share alias EXISTS for the
                // target, without decrypting it. The real `--yes` path runs
                // `find_share_svc_password` which reads the SecretStore; doing
                // that here would read secret material unnecessarily.
                let alias_present = find_managed_share_for_target(db, &target_host).is_ok();
                if !alias_present {
                    return Err(UecmError::InvalidInput(format!(
                        "no Mode B share found for host '{}'; create one via `share create --mode b` first",
                        target_host
                    )));
                }
                destructive::emit_plan(
                    ctx.emitter.as_mut(),
                    "share.inject-system-cred",
                    serde_json::json!({
                        "client_host": client_host,
                        "target_host": target_host,
                        "svc_user": svc_user,
                    }),
                );
                return Ok(());
            }
            inject_system_cred(ctx, &client_host, &target_host, &svc_user, &cred)
        }
    }
}

fn list(ctx: &mut Ctx<'_>) -> UecmResult<()> {
    let db = ctx.require_db()?;
    let rows = data_shares::list_all(db)?;
    ctx.emitter.emit_result(&rows).ok();
    Ok(())
}

fn forget(ctx: &mut Ctx<'_>, id: i64, yes: bool, dry_run: bool) -> UecmResult<()> {
    let outcome = destructive::check(yes, dry_run, "share.forget")?;
    let db = ctx.require_db()?;
    // Mirror `machine delete` / `project delete`: refuse to pretend success
    // on a typo'd id, in either --yes or --dry-run mode.
    let existing = data_shares::list_all(db)?
        .into_iter()
        .find(|s| s.id == Some(id))
        .ok_or_else(|| {
            UecmError::InvalidInput(format!("share id={} not found in local inventory", id))
        })?;
    if outcome == Outcome::DryRun {
        destructive::emit_plan(
            ctx.emitter.as_mut(),
            "share.forget",
            serde_json::json!({
                "id": id,
                "host_machine_id": existing.host_machine_id,
                "share_name": existing.share_name,
                "note": "local inventory only; remote SMB share is NOT removed by this command",
            }),
        );
        return Ok(());
    }
    data_shares::delete(db, id)?;
    ctx.emitter
        .emit_event(&Event::Completed {
            summary: serde_json::json!({
                "id": id,
                "forgotten": true,
                "note": "local inventory only; remote share still active",
            }),
        })
        .ok();
    Ok(())
}

fn create(
    ctx: &mut Ctx<'_>,
    mode: &str,
    host: &str,
    share: &str,
    local_path: &str,
    cred: &CredentialArgs,
) -> UecmResult<()> {
    use cache_core::core::shares;

    let db = ctx.require_db()?;
    // SSH key auth: share ops take no operator credential (the Mode B svc password
    // is read from the SecretStore separately). preflight validates flags without
    // reading DPAPI/stdin for a discarded credential.
    cred.preflight(db)?;
    let (op_user, op_pass): (Option<&str>, Option<&str>) = (None, None);

    let (result, share_mode, credential_alias) = match mode {
        "a" | "A" => {
            let r = shares::create_mode_a(host, share, local_path, op_user, op_pass)?;
            (r, ShareMode::Open, cred.cred_alias.clone())
        }
        "b" | "B" => {
            let svc_user = "ddc-svc";
            let svc_pass = shares::generate_svc_password();
            let r = shares::create_mode_b(
                host,
                share,
                local_path,
                svc_user,
                &svc_pass,
                op_user,
                op_pass,
            )?;
            // Persist svc password to the cross-platform SecretStore (AES-GCM)
            // so subsequent `inject-system-cred` / Robocopy fan-out can resolve
            // it from any operator OS. Replaces the old cmdkey + DPAPI path.
            let svc_alias = format!("share-{}-{}", host, share);
            cache_core::core::secrets::SecretStore::from_config()?.put(&svc_alias, &svc_pass)?;
            (r, ShareMode::Managed, Some(svc_alias))
        }
        other => {
            return Err(UecmError::InvalidInput(format!(
                "unknown share mode '{}'; expected 'a' or 'b'",
                other
            )))
        }
    };

    // Resolve host's machine_id. Try by IP first; fall back to hostname match.
    let host_machine = cache_core::data::machines::find_by_ip(db, host)?
        .or_else(|| {
            cache_core::data::machines::list_all(db).ok().and_then(|rows| {
                rows.into_iter().find(|m| m.hostname == host)
            })
        })
        .ok_or_else(|| {
            UecmError::InvalidInput(format!(
                "host '{}' is not in the machine inventory; run `machine add` first",
                host
            ))
        })?;
    let machine_id = host_machine.id.expect("machine from DB has id");

    let config = data_shares::ShareConfig {
        id: None,
        host_machine_id: machine_id,
        share_name: share.to_string(),
        unc_path: result.unc_path.clone(),
        local_path: local_path.to_string(),
        mode: share_mode,
        credential_alias,
    };
    let id = data_shares::insert(db, &config)?;

    ctx.emitter
        .emit_event(&Event::Completed {
            summary: serde_json::json!({
                "id": id,
                "host": host,
                "share": share,
                "unc_path": result.unc_path,
                "mode": mode.to_uppercase(),
            }),
        })
        .ok();
    Ok(())
}

fn inject_system_cred(
    ctx: &mut Ctx<'_>,
    client_host: &str,
    target_host: &str,
    svc_user: &str,
    cred: &CredentialArgs,
) -> UecmResult<()> {
    let db = ctx.require_db()?;
    // SSH key auth: share ops take no operator credential (the Mode B svc password
    // is read from the SecretStore separately). preflight validates flags without
    // reading DPAPI/stdin for a discarded credential.
    cred.preflight(db)?;
    let (op_user, op_pass): (Option<&str>, Option<&str>) = (None, None);

    // Look up the share's svc password from the SecretStore alias created during `share create`.
    // The alias scheme matches `share create`: `share-<host>-<share>`. For
    // inject-system-cred we only know target_host + svc_user, so we look for
    // ANY alias starting with `share-<target_host>-`.
    let svc_pass = find_share_svc_password(db, target_host, svc_user)?;
    let share = find_managed_share_for_target(db, target_host)?;
    let svc_server =
        cache_core::core::shares::smb_server_name_for_share(db, &share)?;

    let message = cache_core::core::psexec::inject_system_credential(
        client_host,
        target_host,
        Some(&svc_server),
        svc_user,
        &svc_pass,
        op_user,
        op_pass,
    )?;

    ctx.emitter
        .emit_event(&Event::Completed {
            summary: serde_json::json!({
                "client_host": client_host,
                "target_host": target_host,
                "svc_user": svc_user,
                "message": message,
            }),
        })
        .ok();
    Ok(())
}

/// Resolve the managed share whose cmdkey targets include `target_host`.
fn find_managed_share_for_target(
    db: &cache_core::data::Db,
    target_host: &str,
) -> UecmResult<data_shares::ShareConfig> {
    use cache_core::core::shares;
    for share in data_shares::list_all(db)? {
        if share.mode != ShareMode::Managed {
            continue;
        }
        if let Ok(targets) = shares::cmdkey_targets_for_share(db, &share) {
            if targets
                .iter()
                .any(|t| t.eq_ignore_ascii_case(target_host))
            {
                return Ok(share);
            }
        }
    }
    Err(UecmError::InvalidInput(format!(
        "no Mode B share found for host '{target_host}'; create one via `share create --mode b` first"
    )))
}

/// Looks up the svc password for any Mode-B share on `target_host`.
fn find_share_svc_password(
    db: &cache_core::data::Db,
    target_host: &str,
    _svc_user: &str,
) -> UecmResult<String> {
    let share = find_managed_share_for_target(db, target_host)?;
    let alias = share.credential_alias.ok_or_else(|| {
        UecmError::InvalidInput(format!(
            "managed share for host '{target_host}' has no credential_alias"
        ))
    })?;
    cache_core::core::secrets::get_share_secret_migrating(&alias)?.ok_or_else(|| {
        UecmError::InvalidInput(format!(
            "no stored svc password for alias '{}'. The share may have been created \
             outside this CLI; re-create it via `share create --mode b`.",
            alias
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::output::{Emitter, NdjsonEmitter};
    use cache_core::data::{open_in_memory, schema, Db};

    fn fresh_db() -> Db {
        let db = open_in_memory().unwrap();
        {
            let mut conn = db.lock().unwrap();
            schema::migrate(&mut conn).unwrap();
        }
        db
    }

    fn make_ctx<'a>(buf: &'a mut Vec<u8>, db: &'a Db) -> Ctx<'a> {
        let emitter: Box<dyn Emitter> = Box::new(NdjsonEmitter::new(buf));
        Ctx {
            db: Some(db.clone()),
            db_path: std::path::PathBuf::from(":memory:"),
            emitter,
            json_mode: true,
            operation_id: "share.unmapped",
            request_id: "test-req".into(),
            no_input: false,
        }
    }

    #[test]
    fn forget_without_yes_returns_invalid_input() {
        let db = fresh_db();
        let mut buf: Vec<u8> = Vec::new();
        let mut ctx = make_ctx(&mut buf, &db);
        assert!(matches!(forget(&mut ctx, 1, false, false), Err(UecmError::InvalidInput(_))));
    }

    #[cfg(not(windows))]
    #[test]
    fn create_unknown_mode_returns_invalid_input() {
        let db = fresh_db();
        let mut buf: Vec<u8> = Vec::new();
        let mut ctx = make_ctx(&mut buf, &db);
        let cred = CredentialArgs { cred_alias: None, user: None, pass: None, pass_stdin: false };
        let r = create(&mut ctx, "z", "host", "share", "C:\\path", &cred);
        assert!(matches!(r, Err(UecmError::InvalidInput(_))));
    }

    #[test]
    fn list_empty_db_returns_empty_vec() {
        let db = fresh_db();
        let mut buf: Vec<u8> = Vec::new();
        let r = {
            let mut ctx = make_ctx(&mut buf, &db);
            list(&mut ctx)
        };
        assert!(r.is_ok());
        let output = String::from_utf8(buf).unwrap();
        assert!(output.contains("[]"));
    }

    #[test]
    fn inject_system_cred_no_share_returns_invalid_input() {
        let db = fresh_db();
        let mut buf: Vec<u8> = Vec::new();
        let mut ctx = make_ctx(&mut buf, &db);
        let cred = CredentialArgs { cred_alias: None, user: None, pass: None, pass_stdin: false };
        let r = inject_system_cred(&mut ctx, "client", "192.0.2.2", "ddc-svc", &cred);
        assert!(matches!(r, Err(UecmError::InvalidInput(_))));
    }
}
