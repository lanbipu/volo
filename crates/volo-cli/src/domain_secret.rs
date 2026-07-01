//! `voloctl cache secret <action>` — manage the cross-platform SecretStore (AES-GCM)
//! directly. Lets operators / agents store and inspect transport secrets (Mode B
//! share svc passwords, saved WinRM aliases) from the command line. Replaces the
//! retiring `cred` domain's DPAPI write path with the SSH-era SecretStore.

use std::io::{self, BufRead};

use crate::args::SecretAction;
use crate::destructive::{self, Outcome};
use crate::output::EmitSerialize;
use crate::run::Ctx;
use cache_core::core::secrets::SecretStore;
use cache_core::error::{VoloError, VoloResult};

pub fn handle(ctx: &mut Ctx<'_>, action: SecretAction) -> VoloResult<()> {
    match action {
        SecretAction::Set { alias, value } => set(ctx, &alias, value),
        SecretAction::Get { alias } => get(ctx, &alias),
        SecretAction::List => list(ctx),
        SecretAction::Delete { alias, yes, dry_run } => delete(ctx, &alias, yes, dry_run),
    }
}

fn set(ctx: &mut Ctx<'_>, alias: &str, value: Option<String>) -> VoloResult<()> {
    let secret = match value {
        Some(v) => v,
        None => {
            // No --value: read one line from stdin (mirrors --pass-stdin), so the
            // secret never lands in shell history. `--no-input` forbids the
            // implicit stdin read — fail fast instead of blocking.
            if ctx.no_input {
                return Err(VoloError::InvalidInput(
                    "--no-input set but `secret set` requires the value via --value (stdin read disabled)".into(),
                ));
            }
            let mut line = String::new();
            io::stdin()
                .lock()
                .read_line(&mut line)
                .map_err(|e| VoloError::InvalidInput(format!("read secret from stdin: {}", e)))?;
            line.trim_end_matches(['\r', '\n']).to_string()
        }
    };
    if secret.is_empty() {
        return Err(VoloError::InvalidInput(
            "secret value is empty (pass --value or pipe it on stdin)".into(),
        ));
    }
    SecretStore::from_config()?.put(alias, &secret)?;
    // Never echo the secret — report only the alias + length.
    ctx.emitter
        .emit_result(&serde_json::json!({
            "alias": alias,
            "stored": true,
            "value_len": secret.chars().count(),
        }))
        .ok();
    Ok(())
}

fn get(ctx: &mut Ctx<'_>, alias: &str) -> VoloResult<()> {
    let value = SecretStore::from_config()?.get(alias)?.ok_or_else(|| {
        VoloError::InvalidInput(format!("no secret stored for alias '{}'", alias))
    })?;
    // `secret get` is the one place the plaintext intentionally surfaces.
    ctx.emitter
        .emit_result(&serde_json::json!({ "alias": alias, "value": value }))
        .ok();
    Ok(())
}

fn list(ctx: &mut Ctx<'_>) -> VoloResult<()> {
    let aliases = SecretStore::from_config()?.list()?;
    ctx.emitter
        .emit_result(&serde_json::json!({ "aliases": aliases }))
        .ok();
    Ok(())
}

fn delete(ctx: &mut Ctx<'_>, alias: &str, yes: bool, dry_run: bool) -> VoloResult<()> {
    let outcome = destructive::check(yes, dry_run, "secret.delete")?;
    if outcome == Outcome::DryRun {
        let exists = SecretStore::from_config()?.get(alias)?.is_some();
        destructive::emit_plan(
            ctx.emitter.as_mut(),
            "secret.delete",
            serde_json::json!({ "alias": alias, "exists": exists }),
        );
        return Ok(());
    }
    SecretStore::from_config()?.delete(alias)?;
    ctx.emitter
        .emit_result(&serde_json::json!({ "alias": alias, "deleted": true }))
        .ok();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::output::{Emitter, NdjsonEmitter};
    use crate::run::Ctx;

    fn ctx_no_input<'a>(buf: &'a mut Vec<u8>) -> Ctx<'a> {
        let emitter: Box<dyn Emitter> = Box::new(NdjsonEmitter::new(buf));
        Ctx {
            db: None,
            db_path: std::path::PathBuf::from(":memory:"),
            emitter,
            json_mode: true,
            operation_id: "secret.set",
            request_id: "test-req".into(),
            no_input: true,
        }
    }

    #[test]
    fn set_without_value_under_no_input_errors_before_stdin() {
        // `--no-input` + no `--value` must fail fast with InvalidInput rather
        // than blocking on the implicit stdin read. The early return also fires
        // before `SecretStore::from_config()`, keeping the test hermetic.
        let mut buf = Vec::new();
        let mut ctx = ctx_no_input(&mut buf);
        let r = set(&mut ctx, "some-alias", None);
        match r {
            Err(VoloError::InvalidInput(msg)) => assert!(msg.contains("--no-input")),
            other => panic!("expected InvalidInput, got {:?}", other),
        }
    }
}
