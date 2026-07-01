//! `voloctl cache env <action>` handlers.

use crate::args::EnvAction;
use crate::credential_args::CredentialArgs;
use crate::destructive::{self, Outcome};
use crate::host_args::HostTarget;
use crate::output::{EmitSerialize, Event};
use crate::run::Ctx;
use cache_core::core::env_vars;
use cache_core::error::{VoloError, VoloResult};
use serde::Serialize;
use sha2::{Digest, Sha256};

/// First 4 bytes of SHA-256 over the value, hex-encoded (8 chars).
/// Used in NDJSON metadata so callers can compare two runs' values without
/// the raw secret entering durable logs.
fn value_sha256_prefix(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    let mut out = String::with_capacity(8);
    for b in &digest[..4] {
        use std::fmt::Write as _;
        write!(out, "{:02x}", b).unwrap();
    }
    out
}

#[derive(Serialize)]
struct EnvGetOut<'a> {
    host: &'a str,
    name: &'a str,
    value: Option<String>,
}

pub fn handle(ctx: &mut Ctx<'_>, action: EnvAction) -> VoloResult<()> {
    match action {
        EnvAction::Get { host, name, cred } => get(ctx, &host, &name, &cred),
        EnvAction::Set { target, name, value, yes, dry_run, cred } => {
            let t = target.require_one()?;
            let outcome = destructive::check(yes, dry_run, "env.set")?;
            // Preflight: validate alias / flag combo WITHOUT reading stdin or
            // DPAPI. The real --yes path's `cred.resolve()` consumes
            // `--pass-stdin`, so we can't resolve here without breaking that.
            let db = ctx.require_db()?;
            cred.preflight(db)?;
            if outcome == Outcome::DryRun {
                let hosts: Vec<String> = match &t {
                    HostTarget::Single(h) => vec![h.clone()],
                    HostTarget::Batch(hs) => hs.clone(),
                };
                destructive::emit_plan(
                    ctx.emitter.as_mut(),
                    "env.set",
                    serde_json::json!({
                        "hosts": hosts,
                        "name": name,
                        "value_len": value.chars().count(),
                        "value_sha256_prefix": value_sha256_prefix(&value),
                    }),
                );
                return Ok(());
            }
            match t {
                HostTarget::Single(h) => set_single(ctx, &h, &name, &value, &cred),
                HostTarget::Batch(hs) => set_batch(ctx, &hs, &name, &value, &cred),
            }
        }
    }
}

fn get(ctx: &mut Ctx<'_>, host: &str, name: &str, cred: &CredentialArgs) -> VoloResult<()> {
    let db = ctx.require_db()?;
    // SSH key auth: env get takes no operator credential. preflight (not resolve)
    // validates --cred-alias existence / flag combo without reading DPAPI or stdin
    // for a credential that would only be discarded.
    cred.preflight(db)?;
    let value = env_vars::get(host, name)?;
    // env get is the ONE place value can surface — that's the whole point.
    ctx.emitter
        .emit_result(&EnvGetOut { host, name, value })
        .ok();
    Ok(())
}

fn set_single(
    ctx: &mut Ctx<'_>,
    host: &str,
    name: &str,
    value: &str,
    cred: &CredentialArgs,
) -> VoloResult<()> {
    let db = ctx.require_db()?;
    cred.preflight(db)?;
    let res = env_vars::set(host, name, value);
    res.map_err(|e| redact_error(e, value))?;
    // Redaction contract: never echo raw value.
    ctx.emitter
        .emit_event(&Event::Completed {
            summary: serde_json::json!({
                "host": host,
                "name": name,
                "value_len": value.chars().count(),
                "value_sha256_prefix": value_sha256_prefix(value),
            }),
        })
        .ok();
    Ok(())
}

fn set_batch(
    ctx: &mut Ctx<'_>,
    hosts: &[String],
    name: &str,
    value: &str,
    cred: &CredentialArgs,
) -> VoloResult<()> {
    let db = ctx.require_db()?;
    cred.preflight(db)?;
    let total = hosts.len() as i64;

    ctx.emitter
        .emit_event(&Event::Started {
            task_type: "env_set".into(),
            task_id: None,
            metadata: serde_json::json!({
                "hosts": total,
                "name": name,
                "value_len": value.chars().count(),
                "value_sha256_prefix": value_sha256_prefix(value),
            }),
        })
        .ok();

    let mut ok_count: i64 = 0;
    let mut fail_count: i64 = 0;
    // Sequential — env_vars::set is blocking (SSH/PowerShell); there's no real
    // concurrency win and fanning out many ssh processes can hammer the operator.
    for (idx, host) in hosts.iter().enumerate() {
        ctx.emitter
            .emit_event(&Event::ItemStarted {
                item_id: host.clone(),
                index: idx as i64,
                total,
            })
            .ok();

        let res = env_vars::set(host, name, value);

        match res {
            Ok(()) => {
                ok_count += 1;
                ctx.emitter
                    .emit_event(&Event::ItemCompleted {
                        item_id: host.clone(),
                        index: idx as i64,
                        ok: true,
                        message: None,
                    })
                    .ok();
            }
            Err(e) => {
                fail_count += 1;
                let msg = redact_in_string(e.to_string(), value);
                ctx.emitter
                    .emit_event(&Event::ItemCompleted {
                        item_id: host.clone(),
                        index: idx as i64,
                        ok: false,
                        message: Some(msg),
                    })
                    .ok();
            }
        }
    }

    ctx.emitter
        .emit_event(&Event::Completed {
            summary: serde_json::json!({
                "hosts": total,
                "ok": ok_count,
                "failed": fail_count,
            }),
        })
        .ok();

    if fail_count > 0 {
        return Err(VoloError::OperationFailed(format!(
            "{}/{} hosts failed env set",
            fail_count, total
        )));
    }
    Ok(())
}

fn redact_error(e: VoloError, value: &str) -> VoloError {
    match e {
        VoloError::PowerShell(msg) => VoloError::PowerShell(redact_in_string(msg, value)),
        VoloError::OperationFailed(msg) => VoloError::OperationFailed(redact_in_string(msg, value)),
        other => other,
    }
}

fn redact_in_string(msg: String, value: &str) -> String {
    // Redact any non-empty value occurrence. The earlier `len >= 4` guard let
    // short secrets (`abc`, `p1`) leak when setx-machine.ps1 echoed them in
    // verification failures.
    if !value.is_empty() && msg.contains(value) {
        msg.replace(value, "[REDACTED:value]")
    } else {
        msg
    }
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
            operation_id: "env.unmapped",
            request_id: "test-req".into(),
            no_input: false,
        }
    }

    #[test]
    fn value_sha256_prefix_is_stable() {
        assert_eq!(value_sha256_prefix("hello"), "2cf24dba");
        assert_eq!(value_sha256_prefix(""), "e3b0c442");
    }

    #[cfg(not(windows))]
    #[test]
    fn set_hosts_emits_full_lifecycle_with_no_value_leak() {
        let db = fresh_db();
        let mut buf: Vec<u8> = Vec::new();
        let mut ctx = make_ctx(&mut buf, &db);
        let cred = CredentialArgs {
            cred_alias: None,
            user: None,
            pass: None,
            pass_stdin: false,
        };
        let secret = "SECRET-VALUE-XYZ-NEVER-LEAK";
        let _ = set_batch(
            &mut ctx,
            &["192.0.2.1".into(), "192.0.2.2".into()],
            "DUMMY",
            secret,
            &cred,
        );
        drop(ctx); // release borrow on buf before we move it
        let s = String::from_utf8(buf).unwrap();
        // started + 2 item_started + 2 item_completed + completed = 6 lines
        assert_eq!(s.lines().count(), 6, "stream: {}", s);
        assert!(s.contains("\"type\":\"started\""));
        assert!(s.contains("\"type\":\"item_completed\""));
        assert!(s.contains("\"type\":\"completed\""));
        // Redaction MUST hold: raw value NEVER in NDJSON.
        assert!(
            !s.contains(secret),
            "value leaked into NDJSON stream: {}",
            s
        );
    }
}
