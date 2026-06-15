//! `uecm-cli ddc <action>` handlers.
//!
//! generate — runs UE with -DDC=CreatePak on the source machine, streams
//!            UeRunnerEvents as NDJSON until the process terminates.
//! verify   — checks that a .ddp file exists and is non-zero on the source machine.
//! distribute — Robocopy fan-out from source to one or more target machines.

use crate::args::{BackendChoice, DdcAction};
use crate::credential_args::CredentialArgs;
use crate::destructive::{self, Outcome};
use crate::output::{EmitSerialize, Event};
use crate::run::Ctx;
use cache_core::core::cache_backend::{self, Backend, Routing};
use cache_core::core::ddc_pak;
use cache_core::core::pak_distribute;
use cache_core::core::ue_runner::{UeRunnerBackend, UeRunnerEvent};
use cache_core::data::{machines as data_machines, project_locations, Db};
use cache_core::error::{UecmError, UecmResult};

pub fn handle(ctx: &mut Ctx<'_>, action: DdcAction) -> UecmResult<()> {
    match action {
        DdcAction::Generate { project_id, source_machine, backend, cred } => {
            generate(ctx, project_id, source_machine, backend, &cred)
        }
        DdcAction::Verify { project_id, source_machine, backend, cred } => {
            verify(ctx, project_id, source_machine, backend, &cred)
        }
        DdcAction::Distribute { project_id, source_machine, targets, yes, dry_run, backend, source_smb_cred_alias, cred } => {
            let outcome = destructive::check(yes, dry_run, "ddc.distribute")?;
            distribute(
                ctx,
                project_id,
                source_machine,
                &targets,
                outcome == Outcome::DryRun,
                backend,
                source_smb_cred_alias.as_deref(),
                &cred,
            )
        }
    }
}

/// Outcome of the backend gate.
///
/// Carries the resolved backend plus the `Routing` payload when `--backend
/// auto` triggered the router (None when the operator forced a backend, so
/// callers can tell "operator chose this" apart from "router picked this").
struct BackendResolution {
    backend: Backend,
    routing: Option<Routing>,
}

/// Resolve the operator's `--backend` choice into a concrete [`Backend`].
///
/// `Legacy` / `Zen` short-circuit the router; `Auto` calls
/// `core::cache_backend::resolve_for`. This function **does not emit** the
/// routing reason — callers decide how to surface it because emitting an
/// extra event would break stdout shape for one-shot JSON commands like
/// `ddc verify --json`. Streaming callers (`generate`, real `distribute`)
/// emit `Started` via [`emit_routing_event`]; one-shot callers fold
/// `routing` into their final result via [`augment_with_routing`].
///
/// Keeping this in one place lets `generate` / `verify` / `distribute` share
/// the same gate logic without each duplicating the router invocation.
fn resolve_backend(
    db: &Db,
    project_id: i64,
    source_machine_id: i64,
    choice: BackendChoice,
) -> UecmResult<BackendResolution> {
    if let Some(forced) = map_forced_choice(choice) {
        return Ok(BackendResolution { backend: forced, routing: None });
    }
    let routing = cache_backend::resolve_for(db, project_id, source_machine_id)?;
    Ok(BackendResolution {
        backend: routing.backend,
        routing: Some(routing),
    })
}

/// Build the structured routing-info JSON value. Re-used by both the
/// streaming event emission and the one-shot result-folding paths so they
/// stay in sync on field names.
fn routing_metadata(routing: &Routing) -> serde_json::Value {
    serde_json::json!({
        "backend": routing.backend.as_str(),
        "reason": routing.reason,
        "override_source": routing.override_source,
        "project_ue": routing.project_ue,
        "machine_best_ue": routing.machine_best_ue,
        "zen_reachable": routing.zen_reachable,
    })
}

/// Emit the router's decision as a `Started` event. Use ONLY from streaming
/// handlers (`generate`, real `distribute`) — one-shot handlers must fold
/// the routing into their result instead so stdout stays a single JSON doc.
fn emit_routing_event(ctx: &mut Ctx<'_>, op: &str, routing: &Routing) {
    ctx.emitter
        .emit_event(&Event::Started {
            task_type: format!("{op}.backend_resolution"),
            task_id: None,
            metadata: routing_metadata(routing),
        })
        .ok();
}

/// Fold the router's decision into an existing JSON result so one-shot JSON
/// commands stay a single JSON document on stdout. No-op if `routing` is
/// `None` (the operator forced a backend — nothing to surface).
fn augment_with_routing(value: &mut serde_json::Value, routing: Option<&Routing>) {
    if let (Some(r), Some(obj)) = (routing, value.as_object_mut()) {
        obj.insert("routing".into(), routing_metadata(r));
    }
}

/// Emit the canonical "zen handles caching natively" no-op result.
///
/// Shared by all three handlers so the JSON shape stays identical (operators
/// downstream key off `backend == "zen" && skipped == true`). When the
/// backend was chosen by the router (`--backend auto`), the routing payload
/// is folded into the same JSON object so consumers still see the reason —
/// without splitting stdout into multiple lines.
fn emit_zen_skip(
    ctx: &mut Ctx<'_>,
    operation: &str,
    project_id: i64,
    source_machine_id: i64,
    routing: Option<&Routing>,
) -> UecmResult<()> {
    let mut summary = serde_json::json!({
        "ok": true,
        "operation": operation,
        "backend": "zen",
        "skipped": true,
        "reason": "zen handles caching natively",
        "project_id": project_id,
        "source_machine_id": source_machine_id,
    });
    augment_with_routing(&mut summary, routing);
    ctx.emitter.emit_result(&summary).ok();
    Ok(())
}

// ─── generate ─────────────────────────────────────────────────────────────────

fn generate(
    ctx: &mut Ctx<'_>,
    project_id: i64,
    source_machine_id: i64,
    backend_choice: BackendChoice,
    cred: &CredentialArgs,
) -> UecmResult<()> {
    let db = ctx.require_db()?.clone();

    // Backend gate: forced `--backend zen` AND `auto` that resolves to zen
    // both short-circuit. We still validate the (project, machine) pair so a
    // typo doesn't silently return "skipped: zen". The router itself already
    // requires the project / machine rows to exist, so for `auto` this check
    // is a no-op; for forced `--backend zen` it provides parity with legacy.
    let resolution = resolve_backend(&db, project_id, source_machine_id, backend_choice)?;
    if resolution.backend == Backend::Zen {
        let _ = data_machines::find_by_id(&db, source_machine_id)?.ok_or_else(|| {
            UecmError::InvalidInput(format!("machine {} not found", source_machine_id))
        })?;
        let _ = project_locations::get_for_project_machine(&db, project_id, source_machine_id)?
            .ok_or_else(|| {
                UecmError::InvalidInput(format!(
                    "project {} not located on machine {}",
                    project_id, source_machine_id
                ))
            })?;
        return emit_zen_skip(
            ctx,
            "ddc.generate",
            project_id,
            source_machine_id,
            resolution.routing.as_ref(),
        );
    }

    // Streaming path: safe to emit the routing as a standalone Started event
    // — `generate` already streams Spawned/LogLine/Progress/Completed events
    // as NDJSON, so one more line at the top of the stream doesn't change the
    // output shape.
    if let Some(routing) = resolution.routing.as_ref() {
        emit_routing_event(ctx, "ddc.generate", routing);
    }

    let machine = data_machines::find_by_id(&db, source_machine_id)?.ok_or_else(|| {
        UecmError::InvalidInput(format!("machine {} not found", source_machine_id))
    })?;
    let location =
        project_locations::get_for_project_machine(&db, project_id, source_machine_id)?
            .ok_or_else(|| {
                UecmError::InvalidInput(format!(
                    "project {} not located on machine {}",
                    project_id, source_machine_id
                ))
            })?;

    let engine_path = resolve_engine_path(&db, source_machine_id)?;

    let (op_user, op_pass) = resolve_creds(&db, cred)?;

    // Pick backend: if the machine's IP resolves to loopback, run locally.
    let backend = if cache_core::core::loopback::is_loopback_target(&machine.ip)
        || cache_core::core::loopback::is_loopback_target(&machine.hostname)
    {
        UeRunnerBackend::Local
    } else {
        UeRunnerBackend::Remote
    };

    // Preflight only makes sense for remote (needs WinRM to check paths).
    if matches!(backend, UeRunnerBackend::Remote) {
        ddc_pak::preflight(
            &machine.ip,
            &engine_path,
            &location.uproject_path,
            op_user.as_deref(),
            op_pass.as_deref(),
        )?;
    }

    // ue_runner::run() calls tokio::spawn() internally — the runtime must
    // exist BEFORE launch_generation so the spawn lands on a live executor.
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| UecmError::OperationFailed(format!("tokio runtime: {}", e)))?;

    rt.block_on(async {
        let mut handle = ddc_pak::launch_generation(
            backend,
            &machine.ip,
            &engine_path,
            &location.uproject_path,
            op_user.as_deref(),
            op_pass.as_deref(),
        );

        // Wire Ctrl-C → graceful cancel. The runner's poll loop checks
        // `cancel.requested` each tick and, when set, calls `stop_process`
        // (kills the remote/local UE editor) then emits `Cancelled`. Without
        // this, SIGINT tears the runtime down and leaves the headless UE
        // running on the source node until its own timeout. A *second* Ctrl-C
        // force-quits (128 + SIGINT = 130) so a hung remote stop can't trap
        // the operator.
        let cancel = handle.cancel.clone();
        tokio::spawn(async move {
            if tokio::signal::ctrl_c().await.is_ok() {
                cancel.lock().await.requested = true;
                eprintln!(
                    "→ interrupt received; stopping UE on the source node \
                     (Ctrl-C again to force-quit)"
                );
            }
            let _ = tokio::signal::ctrl_c().await;
            std::process::exit(130);
        });

        while let Some(ev) = handle.events.recv().await {
            match ev {
                UeRunnerEvent::Spawned { pid, log_path } => {
                    ctx.emitter
                        .emit_event(&Event::Spawned { pid, log_path })
                        .ok();
                }
                UeRunnerEvent::LogLine { text, parsed_kind } => {
                    ctx.emitter
                        .emit_event(&Event::LogLine { text, parsed_kind })
                        .ok();
                }
                UeRunnerEvent::Progress { pct, label } => {
                    ctx.emitter
                        .emit_event(&Event::Progress {
                            pct,
                            label,
                            current: None,
                            total: None,
                        })
                        .ok();
                }
                UeRunnerEvent::Completed { exit_code, log_tail } => {
                    ctx.emitter
                        .emit_event(&Event::Completed {
                            summary: serde_json::json!({
                                "exit_code": exit_code,
                                "log_tail": log_tail,
                            }),
                        })
                        .ok();
                    break;
                }
                UeRunnerEvent::Cancelled => {
                    ctx.emitter
                        .emit_event(&Event::Cancelled {
                            reason: "external".into(),
                        })
                        .ok();
                    break;
                }
                UeRunnerEvent::Error { message } => {
                    return Err(UecmError::OperationFailed(format!(
                        "ue runner: {}",
                        message
                    )));
                }
            }
        }
        Ok::<_, UecmError>(())
    })?;

    Ok(())
}

// ─── verify ───────────────────────────────────────────────────────────────────

fn verify(
    ctx: &mut Ctx<'_>,
    project_id: i64,
    source_machine_id: i64,
    backend_choice: BackendChoice,
    cred: &CredentialArgs,
) -> UecmResult<()> {
    let db = ctx.require_db()?.clone();

    let resolution = resolve_backend(&db, project_id, source_machine_id, backend_choice)?;
    if resolution.backend == Backend::Zen {
        let _ = data_machines::find_by_id(&db, source_machine_id)?.ok_or_else(|| {
            UecmError::InvalidInput(format!("machine {} not found", source_machine_id))
        })?;
        let _ = project_locations::get_for_project_machine(&db, project_id, source_machine_id)?
            .ok_or_else(|| {
                UecmError::InvalidInput(format!(
                    "project {} not located on machine {}",
                    project_id, source_machine_id
                ))
            })?;
        return emit_zen_skip(
            ctx,
            "ddc.verify",
            project_id,
            source_machine_id,
            resolution.routing.as_ref(),
        );
    }

    let machine = data_machines::find_by_id(&db, source_machine_id)?.ok_or_else(|| {
        UecmError::InvalidInput(format!("machine {} not found", source_machine_id))
    })?;
    let location =
        project_locations::get_for_project_machine(&db, project_id, source_machine_id)?
            .ok_or_else(|| {
                UecmError::InvalidInput(format!(
                    "project {} not located on machine {}",
                    project_id, source_machine_id
                ))
            })?;

    let (op_user, op_pass) = resolve_creds(&db, cred)?;

    // verify_output returns Err when .ddp is not found. For the CLI verify
    // command that's a valid query result ("no, the pak does not exist"),
    // not an operational failure — return it as a structured JSON result
    // with found=false so the exit code stays 0 and behaviour is consistent
    // with `ddc generate --backend auto` which returns skipped=true when
    // zen is the active backend (a stale zen probe can flip the router to
    // legacy between generate and verify, making verify hit this path even
    // though generate skipped — the operator should see a clean result, not
    // an error).
    let mut output_value = match ddc_pak::verify_output(
        &machine.ip,
        &location.abs_path,
        op_user.as_deref(),
        op_pass.as_deref(),
    ) {
        Ok(output) => {
            let mut v = serde_json::to_value(&output)
                .unwrap_or_else(|_| serde_json::Value::Null);
            if let Some(obj) = v.as_object_mut() {
                obj.insert("found".into(), serde_json::json!(true));
            }
            v
        }
        Err(e) => {
            // Only convert the specific "not found" outcome into a
            // structured result. Operational failures (SSH down, script
            // error, malformed output) must still propagate so
            // automation can distinguish "pak absent" from "host
            // unreachable".
            let msg = e.to_string();
            if !msg.contains(".ddp not found") {
                return Err(e);
            }
            serde_json::json!({
                "ok": true,
                "found": false,
                "path": "",
                "size_bytes": 0,
                "message": msg,
            })
        }
    };

    // One-shot JSON path: fold routing into the same result object so stdout
    // stays a single JSON document (consumers that parse stdout as one value
    // would break if we emitted a separate Started event before this).
    augment_with_routing(&mut output_value, resolution.routing.as_ref());
    ctx.emitter.emit_result(&output_value).ok();
    Ok(())
}

// ─── distribute ───────────────────────────────────────────────────────────────

fn distribute(
    ctx: &mut Ctx<'_>,
    project_id: i64,
    source_machine_id: i64,
    target_ids: &[i64],
    dry_run: bool,
    backend_choice: BackendChoice,
    source_smb_cred_alias: Option<&str>,
    cred: &CredentialArgs,
) -> UecmResult<()> {
    let db = ctx.require_db()?.clone();

    let resolution = resolve_backend(&db, project_id, source_machine_id, backend_choice)?;
    if resolution.backend == Backend::Zen {
        let _ = data_machines::find_by_id(&db, source_machine_id)?.ok_or_else(|| {
            UecmError::InvalidInput(format!("machine {} not found", source_machine_id))
        })?;
        let _ = project_locations::get_for_project_machine(&db, project_id, source_machine_id)?
            .ok_or_else(|| {
                UecmError::InvalidInput(format!(
                    "project {} not located on machine {}",
                    project_id, source_machine_id
                ))
            })?;
        return emit_zen_skip(
            ctx,
            "ddc.distribute",
            project_id,
            source_machine_id,
            resolution.routing.as_ref(),
        );
    }

    let source_machine = data_machines::find_by_id(&db, source_machine_id)?.ok_or_else(|| {
        UecmError::InvalidInput(format!("machine {} not found", source_machine_id))
    })?;
    let source_location =
        project_locations::get_for_project_machine(&db, project_id, source_machine_id)?
            .ok_or_else(|| {
                UecmError::InvalidInput(format!(
                    "project {} not located on machine {}",
                    project_id, source_machine_id
                ))
            })?;

    // Source SMB now comes from the SecretStore (explicit alias or auto-derived
    // from the source host's Mode B/A share), not the operator WinRM cred — the
    // operator->target leg is SSH key auth. Dry-run resolves the same share/UNC
    // and runs the same validation, but skips reading the secret (read_secret =
    // false), so previews stay side-effect-free yet show the real source UNC.
    let (op_user, op_pass, smb) = if dry_run {
        cred.preflight(&db)?;
        let smb = pak_distribute::resolve_source_smb(
            &db,
            source_machine_id,
            source_smb_cred_alias,
            false,
        )?;
        (None, None, smb)
    } else {
        let (op_user, op_pass) = resolve_creds(&db, cred)?;
        let smb = pak_distribute::resolve_source_smb(
            &db,
            source_machine_id,
            source_smb_cred_alias,
            true,
        )?;
        (op_user, op_pass, smb)
    };

    let profile = pak_distribute::DistributeProfile::ddc_pak();
    let plan = pak_distribute::plan(
        &profile,
        &db,
        source_machine_id,
        &source_machine.ip,
        &source_location,
        target_ids,
        project_id,
        smb.named_share_unc.as_deref(), // managed-share UNC paired with the SMB cred
        op_user,
        op_pass,
        smb.user,
        smb.pass,
    )?;

    if plan.is_empty() {
        return Err(UecmError::InvalidInput(
            "distribution plan has no non-source targets".into(),
        ));
    }

    // Dry-run reports the validated plan and exits without running Robocopy.
    // Preflight checks above (machine / location / non-empty plan) have already
    // run, so a successful dry-run means the real command would at least get
    // past argument validation. One-shot JSON path: fold routing into the
    // plan's `details` so stdout stays a single JSON document.
    if dry_run {
        let summary_targets: Vec<serde_json::Value> = plan
            .iter()
            .map(|i| serde_json::json!({
                "target_machine_id": i.target_machine_id,
                "target_host": i.target_host,
                "target_local": i.target_local,
                "source_unc": i.source_unc,
            }))
            .collect();
        let mut details = serde_json::json!({
            "project_id": project_id,
            "source_machine": source_machine_id,
            "targets": summary_targets,
        });
        augment_with_routing(&mut details, resolution.routing.as_ref());
        destructive::emit_plan(ctx.emitter.as_mut(), "ddc.distribute", details);
        return Ok(());
    }

    // Streaming real-run path: safe to emit routing as a standalone event —
    // the rest of distribute streams ItemStarted/ItemCompleted/Completed.
    if let Some(routing) = resolution.routing.as_ref() {
        emit_routing_event(ctx, "ddc.distribute", routing);
    }

    let total = plan.len() as i64;

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| UecmError::OperationFailed(format!("tokio runtime: {}", e)))?;

    rt.block_on(async {
        for (idx, item) in plan.into_iter().enumerate() {
            let item_id = format!("machine:{}", item.target_machine_id);

            ctx.emitter
                .emit_event(&Event::ItemStarted {
                    item_id: item_id.clone(),
                    index: idx as i64,
                    total,
                })
                .ok();

            let outcome = pak_distribute::run_one_with_profile(&profile, item).await;

            match outcome {
                Ok(out) => {
                    let msg = if out.ok {
                        None
                    } else {
                        Some(
                            out.message
                                .unwrap_or_else(|| out.stdout_tail.clone()),
                        )
                    };
                    ctx.emitter
                        .emit_event(&Event::ItemCompleted {
                            item_id,
                            index: idx as i64,
                            ok: out.ok,
                            message: msg,
                        })
                        .ok();
                    if !out.ok {
                        return Err(UecmError::OperationFailed(format!(
                            "robocopy exit {} on machine {}",
                            out.exit_code, out.target_machine_id
                        )));
                    }
                }
                Err(e) => {
                    ctx.emitter
                        .emit_event(&Event::ItemCompleted {
                            item_id,
                            index: idx as i64,
                            ok: false,
                            message: Some(e.to_string()),
                        })
                        .ok();
                    return Err(e);
                }
            }
        }
        Ok::<_, UecmError>(())
    })?;

    ctx.emitter
        .emit_event(&Event::Completed {
            summary: serde_json::json!({"distributed": true}),
        })
        .ok();

    Ok(())
}

// ─── helpers ──────────────────────────────────────────────────────────────────

fn resolve_creds(
    db: &cache_core::data::Db,
    cred: &CredentialArgs,
) -> UecmResult<(Option<String>, Option<String>)> {
    // SSH key auth: ddc operations take no operator credential. preflight
    // validates --cred-alias / flag combo without reading DPAPI or stdin for a
    // credential that would only be discarded.
    cred.preflight(db)?;
    Ok((None, None))
}

fn resolve_engine_path(db: &cache_core::data::Db, machine_id: i64) -> UecmResult<String> {
    let installs = cache_core::data::machine_ue_installs::list_for_machine(db, machine_id)?;
    if installs.is_empty() {
        return Err(UecmError::InvalidInput(format!(
            "machine {} has no detected UE installs",
            machine_id
        )));
    }
    let install = installs
        .iter()
        .find(|i| i.is_primary)
        .cloned()
        .unwrap_or_else(|| installs[0].clone());
    Ok(install.install_path)
}

/// Map a forced `BackendChoice` (`Legacy` / `Zen`) onto a concrete
/// [`Backend`]. Returns `None` for `Auto` — the auto branch needs DB access
/// to call `cache_backend::resolve_for`, so it can't be expressed as a pure
/// mapping. Pulled out as a helper so it can be unit-tested without spinning
/// up a `Ctx` + DB.
fn map_forced_choice(choice: BackendChoice) -> Option<Backend> {
    match choice {
        BackendChoice::Zen => Some(Backend::Zen),
        BackendChoice::Legacy => Some(Backend::LegacyPak),
        BackendChoice::Auto => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn map_forced_choice_zen_maps_to_zen_backend() {
        assert_eq!(map_forced_choice(BackendChoice::Zen), Some(Backend::Zen));
    }

    #[test]
    fn map_forced_choice_legacy_maps_to_legacy_pak_backend() {
        assert_eq!(
            map_forced_choice(BackendChoice::Legacy),
            Some(Backend::LegacyPak)
        );
    }

    #[test]
    fn map_forced_choice_auto_returns_none_so_caller_consults_router() {
        // Auto must NOT be pre-mapped — the auto branch in `resolve_backend`
        // is the only place that gets to talk to `cache_backend::resolve_for`.
        assert_eq!(map_forced_choice(BackendChoice::Auto), None);
    }
}
