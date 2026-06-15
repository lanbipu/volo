//! `uecm-cli cred <action>` handlers.

use crate::args::CredAction;
use crate::destructive::{self, Outcome};
use crate::output::EmitSerialize;
use crate::run::Ctx;
use cache_core::data::credentials as data_creds;
use cache_core::error::{UecmError, UecmResult};
use std::io::{self, BufRead};

pub fn handle(ctx: &mut Ctx<'_>, action: CredAction) -> UecmResult<()> {
    match action {
        CredAction::List => list(ctx),
        CredAction::Save {
            alias,
            user,
            pass,
            pass_stdin,
            kind,
        } => save(ctx, &alias, &user, pass.as_deref(), pass_stdin, &kind),
        CredAction::Delete { alias, yes, dry_run } => delete(ctx, &alias, yes, dry_run),
    }
}

fn list(ctx: &mut Ctx<'_>) -> UecmResult<()> {
    let db = ctx.require_db()?;
    let rows = data_creds::list_all(db)?;
    ctx.emitter.emit_result(&rows).ok();
    Ok(())
}

fn read_password(pass_inline: Option<&str>, pass_stdin: bool) -> UecmResult<String> {
    if let Some(p) = pass_inline {
        return Ok(p.to_string());
    }
    if pass_stdin {
        let mut line = String::new();
        io::stdin().lock().read_line(&mut line).map_err(|e| {
            UecmError::InvalidInput(format!("read password from stdin: {}", e))
        })?;
        return Ok(line.trim_end_matches(['\r', '\n']).to_string());
    }
    Err(UecmError::InvalidInput(
        "either --pass or --pass-stdin is required".into(),
    ))
}

fn save(
    ctx: &mut Ctx<'_>,
    alias: &str,
    user: &str,
    pass_inline: Option<&str>,
    pass_stdin: bool,
    kind: &str,
) -> UecmResult<()> {
    let password = read_password(pass_inline, pass_stdin)?;
    save_resolved(ctx, alias, user, &password, kind)
}

/// Persist an already-resolved `(user, password)` credential under `alias`
/// (SecretStore for the secret + SQLite for the alias metadata). Used by
/// `cred save`.
pub(crate) fn save_resolved(
    ctx: &mut Ctx<'_>,
    alias: &str,
    user: &str,
    password: &str,
    kind: &str,
) -> UecmResult<()> {
    use cache_core::core::credentials as core_creds;

    let username = core_creds::normalize_username_for_storage(user);

    // Validate --kind BEFORE any side effects. A typo here used to silently fall
    // back to Winrm and persist under the wrong type.
    let _validated_kind = parse_credential_kind(kind)?;

    // Store the secret in the cross-platform SecretStore (replaces cmdkey + DPAPI),
    // so `cred save` works off Windows and the saved alias is usable as
    // `--cred-alias` (CredentialArgs::resolve reads the SecretStore first).
    cache_core::core::secrets::SecretStore::from_config()?.put(alias, password)?;

    // SQLite metadata. Replace if alias already exists, else insert.
    let db = ctx.require_db()?;
    if data_creds::find_by_alias(db, alias)?.is_some() {
        data_creds::delete_by_alias(db, alias)?;
    }
    // Build record (kind already validated above, so unwrap is sound).
    let record = build_credential_record(alias, &username, kind)?;
    let id = data_creds::insert(db, &record)?;

    ctx.emitter
        .emit_event(&crate::output::Event::Completed {
            summary: serde_json::json!({ "id": id, "alias": alias }),
        })
        .ok();
    Ok(())
}

fn parse_credential_kind(kind_str: &str) -> UecmResult<data_creds::CredentialKind> {
    use data_creds::CredentialKind;
    match kind_str.to_lowercase().as_str() {
        "winrm" => Ok(CredentialKind::Winrm),
        "share" => Ok(CredentialKind::Share),
        other => Err(UecmError::InvalidInput(format!(
            "unknown credential kind '{}'; expected 'winrm' or 'share'",
            other
        ))),
    }
}

fn build_credential_record(
    alias: &str,
    username: &str,
    kind_str: &str,
) -> UecmResult<data_creds::CredentialRecord> {
    use data_creds::CredentialRecord;
    let kind = parse_credential_kind(kind_str)?;
    Ok(CredentialRecord {
        id: None,
        alias: alias.to_string(),
        kind,
        username: username.to_string(),
    })
}

fn delete(ctx: &mut Ctx<'_>, alias: &str, yes: bool, dry_run: bool) -> UecmResult<()> {
    let outcome = destructive::check(yes, dry_run, "cred.delete")?;

    let db = ctx.require_db()?;

    if outcome == Outcome::DryRun {
        let exists = data_creds::find_by_alias(db, alias)?.is_some();
        destructive::emit_plan(
            ctx.emitter.as_mut(),
            "cred.delete",
            serde_json::json!({
                "alias": alias,
                "exists_in_db": exists,
                "side_effects": ["SQLite delete", "SecretStore delete (best-effort)"],
            }),
        );
        return Ok(());
    }

    // SQLite delete — environment error if this fails, propagate now.
    data_creds::delete_by_alias(db, alias)?;

    // SecretStore delete — best-effort (mirrors the Tauri delete_credential
    // cleanup so a CLI delete doesn't leave the AES secret orphaned on disk).
    if let Err(e) = cache_core::core::secrets::SecretStore::from_config().and_then(|s| s.delete(alias)) {
        tracing::warn!(alias = %alias, error = %e, "SecretStore delete failed; orphan secret may remain");
    }

    let _ = ctx.emitter.emit_event(&crate::output::Event::Completed {
        summary: serde_json::json!({ "alias": alias, "deleted": true }),
    });
    Ok(())
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
            operation_id: "cred.unmapped",
            request_id: "test-req".into(),
            no_input: false,
        }
    }

    // (Removed `save_returns_powershell_error_when_cmdkey_unavailable`: `cred save`
    // is now SecretStore-backed and cross-platform — it no longer fails without
    // cmdkey, so the old non-Windows assertion is obsolete. A hermetic test would
    // also have to avoid writing the real SecretStore via from_config.)
}
