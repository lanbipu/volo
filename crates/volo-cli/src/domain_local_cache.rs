//! `uecm-cli local-cache <action>` handlers.
use crate::args::LocalCacheAction;
use crate::destructive::{self, Outcome};
use crate::host_args::HostTarget;
use crate::output::Event;
use crate::run::Ctx;
use cache_core::core::local_cache;
use cache_core::error::UecmResult;

pub fn handle(ctx: &mut Ctx<'_>, action: LocalCacheAction) -> UecmResult<()> {
    match action {
        LocalCacheAction::Create { target, path, service_account, yes, dry_run, cred } => {
            let hosts: Vec<String> = match target.require_one()? {
                HostTarget::Single(h) => vec![h],
                HostTarget::Batch(hs) => hs,
            };
            let outcome = destructive::check(yes, dry_run, "local-cache.create")?;
            let db = ctx.require_db()?;
            cred.preflight(db)?;
            if outcome == Outcome::DryRun {
                destructive::emit_plan(
                    ctx.emitter.as_mut(),
                    "local-cache.create",
                    serde_json::json!({
                        "hosts": hosts,
                        "path": path,
                        "service_account": service_account,
                    }),
                );
                return Ok(());
            }
            // SSH key auth: local-cache create takes no operator credential.
            // preflight validates flags without reading DPAPI/stdin for a cred
            // that would only be discarded.
            cred.preflight(db)?;
            let total = hosts.len() as i64;
            ctx.emitter
                .emit_event(&Event::Started {
                    task_type: "local_cache_create".into(),
                    task_id: None,
                    metadata: serde_json::json!({"hosts": total, "path": path}),
                })
                .ok();
            for (idx, host) in hosts.iter().enumerate() {
                ctx.emitter
                    .emit_event(&Event::ItemStarted {
                        item_id: host.clone(),
                        index: idx as i64,
                        total,
                    })
                    .ok();
                let r = local_cache::create(
                    host,
                    &path,
                    service_account.as_deref(),
                    None,
                );
                match r {
                    Ok(_) => {
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
                        ctx.emitter
                            .emit_event(&Event::ItemCompleted {
                                item_id: host.clone(),
                                index: idx as i64,
                                ok: false,
                                message: Some(e.to_string()),
                            })
                            .ok();
                    }
                }
            }
            Ok(())
        }
    }
}
