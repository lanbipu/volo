//! `voloctl cache pso <action>` handlers.
//!
//! verify     — check R008-R010 PSO precaching CVars in project ConsoleVariables.ini.
//!              Delegates to `domain_ini::scan_dispatch` (same real-scan path as
//!              `ini verify-pso-precaching` / the UI's `verify_pso_precaching`
//!              Tauri command) — this used to be a stub that only printed a hint.
//! collect    — launch UE in `-game` mode on source machine, stream UeRunnerEvents as
//!              NDJSON, then enumerate + persist collected files.
//! list       — list collected PSO cache files for a project.
//! distribute — Robocopy fan-out of a PSO cache file to one or more target machines
//!              (with GPU mismatch preflight guard).

use crate::args::PsoAction;
use crate::credential_args::CredentialArgs;
use crate::destructive::{self, Outcome};
use crate::output::{EmitSerialize, Event};
use crate::run::Ctx;
use cache_core::core::{
    loopback,
    pso_collect::{self, PsoCollectSpec},
    pso_distribute,
    ue_runner::{UeRunnerBackend, UeRunnerEvent},
};
use cache_core::data::{machines as data_machines, project_locations, pso_cache_files};
use cache_core::error::{VoloError, VoloResult};

pub fn handle(ctx: &mut Ctx<'_>, action: PsoAction) -> VoloResult<()> {
    match action {
        PsoAction::Verify { project_id, cred } => {
            crate::domain_ini::scan_dispatch(ctx, vec![], Some(project_id), None, &cred)
        }
        PsoAction::Collect {
            project_id,
            source_machine,
            resolution,
            windowed,
            max_minutes,
            cred,
        } => collect(ctx, project_id, source_machine, &resolution, windowed, max_minutes, &cred),
        PsoAction::List { project_id } => list(ctx, project_id),
        PsoAction::Distribute { project_id, source_machine, targets, yes, dry_run, source_smb_cred_alias, cred } => {
            let outcome = destructive::check(yes, dry_run, "pso.distribute")?;
            distribute(
                ctx,
                project_id,
                source_machine,
                &targets,
                outcome == Outcome::DryRun,
                source_smb_cred_alias.as_deref(),
                &cred,
            )
        }
    }
}

// ─── collect ──────────────────────────────────────────────────────────────────

fn parse_resolution(resolution: &str) -> VoloResult<(u32, u32)> {
    let parts: Vec<&str> = resolution.splitn(2, 'x').collect();
    if parts.len() != 2 {
        return Err(VoloError::InvalidInput(format!(
            "resolution must be WxH (e.g. 1920x1080), got: {}",
            resolution
        )));
    }
    let w = parts[0].parse::<u32>().map_err(|_| {
        VoloError::InvalidInput(format!("invalid width in resolution: {}", parts[0]))
    })?;
    let h = parts[1].parse::<u32>().map_err(|_| {
        VoloError::InvalidInput(format!("invalid height in resolution: {}", parts[1]))
    })?;
    if w == 0 || h == 0 {
        return Err(VoloError::InvalidInput(
            "resolution width and height must be > 0".into(),
        ));
    }
    Ok((w, h))
}

fn collect(
    ctx: &mut Ctx<'_>,
    project_id: i64,
    source_machine_id: i64,
    resolution: &str,
    windowed: bool,
    max_minutes: u32,
    cred: &CredentialArgs,
) -> VoloResult<()> {
    let db = ctx.require_db()?;

    let machine = data_machines::find_by_id(db, source_machine_id)?.ok_or_else(|| {
        VoloError::InvalidInput(format!("machine {} not found", source_machine_id))
    })?;
    let location =
        project_locations::get_for_project_machine(db, project_id, source_machine_id)?
            .ok_or_else(|| {
                VoloError::InvalidInput(format!(
                    "project {} not located on machine {}",
                    project_id, source_machine_id
                ))
            })?;

    let engine_path = resolve_engine_path(db, source_machine_id)?;
    let (op_user, op_pass) = resolve_creds(db, cred)?;
    let (res_w, res_h) = parse_resolution(resolution)?;

    let backend = if loopback::is_loopback_target(&machine.ip)
        || loopback::is_loopback_target(&machine.hostname)
    {
        UeRunnerBackend::Local
    } else {
        UeRunnerBackend::Remote
    };

    let spec = PsoCollectSpec {
        project_id,
        source_machine_id,
        ue_version: None,
        resolution: (res_w, res_h),
        windowed,
        max_minutes,
    };

    // ue_runner::run() calls tokio::spawn() internally — the runtime must
    // exist BEFORE launch_collection so the spawn lands on a live executor.
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| VoloError::OperationFailed(format!("tokio runtime: {}", e)))?;

    // Capture data needed for post-completion finalization before moving into async block.
    let source_machine_ip = machine.ip.clone();
    let project_dir = location.abs_path.clone();
    let db_clone = db.clone();

    rt.block_on(async {
        let mut handle = pso_collect::launch_collection(
            backend,
            &machine.ip,
            &engine_path,
            &location.uproject_path,
            &spec,
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

        let mut ue_exit: Option<(i32, Vec<String>)> = None;

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
                    // Don't emit `Completed` yet — enumerate / persist still
                    // need to run and can fail. The emitter treats `Completed`
                    // as terminal, so emitting here would prevent a later
                    // failure's `cancelled` marker from terminating the
                    // stream. Surface UE exit as an informational LogLine.
                    ctx.emitter
                        .emit_event(&Event::LogLine {
                            text: format!(
                                "ue process exited (exit_code={:?})",
                                exit_code
                            ),
                            parsed_kind: Some("ue_exit".into()),
                        })
                        .ok();
                    ue_exit = Some((exit_code, log_tail));
                    break;
                }
                UeRunnerEvent::Cancelled => {
                    ctx.emitter
                        .emit_event(&Event::Cancelled {
                            reason: "external".into(),
                        })
                        .ok();
                    return Ok::<_, VoloError>(());
                }
                UeRunnerEvent::Error { message } => {
                    return Err(VoloError::OperationFailed(format!(
                        "ue runner: {}",
                        message
                    )));
                }
            }
        }

        // After UE process finishes, enumerate collected files and persist to
        // DB. Only here, once everything succeeded, do we emit the terminal
        // Completed event so consumers can rely on it as "no failure later".
        if let Some((exit_code, log_tail)) = ue_exit {
            let files = pso_collect::enumerate_remote(
                &source_machine_ip,
                &project_dir,
                op_user.as_deref(),
                op_pass.as_deref(),
            )
            .map_err(|e| VoloError::OperationFailed(format!("enumerate_remote: {}", e)))?;

            let ids = pso_collect::finalize_persist(
                &db_clone,
                project_id,
                source_machine_id,
                spec.ue_version.as_deref(),
                &files,
            )
            .map_err(|e| VoloError::OperationFailed(format!("finalize_persist: {}", e)))?;

            ctx.emitter
                .emit_event(&Event::Completed {
                    summary: serde_json::json!({
                        "exit_code": exit_code,
                        "log_tail": log_tail,
                        "files_collected": files.len(),
                        "file_ids": ids,
                    }),
                })
                .ok();
        }

        Ok::<_, VoloError>(())
    })?;

    Ok(())
}

// ─── list ─────────────────────────────────────────────────────────────────────

fn list(ctx: &mut Ctx<'_>, project_id: i64) -> VoloResult<()> {
    let db = ctx.require_db()?;
    let files = pso_cache_files::list_by_project(db, project_id)?;
    ctx.emitter.emit_result(&files).ok();
    Ok(())
}

// ─── distribute ───────────────────────────────────────────────────────────────

fn distribute(
    ctx: &mut Ctx<'_>,
    project_id: i64,
    source_machine_id: i64,
    target_ids: &[i64],
    dry_run: bool,
    source_smb_cred_alias: Option<&str>,
    cred: &CredentialArgs,
) -> VoloResult<()> {
    let db = ctx.require_db()?;

    let source_machine = data_machines::find_by_id(db, source_machine_id)?.ok_or_else(|| {
        VoloError::InvalidInput(format!("machine {} not found", source_machine_id))
    })?;

    // Dry-run resolves the same share/UNC + validation but skips the secret
    // read (see `domain_ddc::distribute`).
    cred.preflight(db)?;
    let smb = cache_core::core::pak_distribute::resolve_source_smb(
        db,
        source_machine_id,
        source_smb_cred_alias,
        !dry_run,
    )?;

    // Find the most recent PSO cache file for this project + source machine.
    let files = pso_cache_files::list_by_project(db, project_id)?;
    let file = files
        .into_iter()
        .filter(|f| f.source_machine_id == source_machine_id)
        .next()
        .ok_or_else(|| {
            VoloError::InvalidInput(format!(
                "no PSO cache file found for project {} on machine {}; run `pso collect` first",
                project_id, source_machine_id
            ))
        })?;

    let plan = pso_distribute::plan(
        db,
        &source_machine.ip,
        &file,
        target_ids,
        smb.named_share_unc.as_deref(), // managed-share UNC paired with the SMB cred
        smb.user,
        smb.pass,
    )?;

    if plan.is_empty() {
        return Err(VoloError::InvalidInput(
            "distribution plan has no non-source targets".into(),
        ));
    }

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
        destructive::emit_plan(
            ctx.emitter.as_mut(),
            "pso.distribute",
            serde_json::json!({
                "project_id": project_id,
                "source_machine": source_machine_id,
                "pso_cache_file_id": file.id,
                "targets": summary_targets,
            }),
        );
        return Ok(());
    }

    let total = plan.len() as i64;

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| VoloError::OperationFailed(format!("tokio runtime: {}", e)))?;

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

            // GPU mismatch preflight guard — surface as a non-ok completion rather than panic.
            if let Err(e) = pso_distribute::preflight_one(&item).await {
                ctx.emitter
                    .emit_event(&Event::ItemCompleted {
                        item_id,
                        index: idx as i64,
                        ok: false,
                        message: Some(format!("gpu mismatch preflight: {}", e)),
                    })
                    .ok();
                return Err(VoloError::OperationFailed(format!(
                    "preflight failed for machine {}: {}",
                    item.target_machine_id, e
                )));
            }

            let outcome = pso_distribute::run_one(item).await;

            match outcome {
                Ok(out) => {
                    let msg = if out.ok {
                        None
                    } else {
                        Some(out.message.unwrap_or_else(|| out.stdout_tail.clone()))
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
                        return Err(VoloError::OperationFailed(format!(
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
        Ok::<_, VoloError>(())
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
) -> VoloResult<(Option<String>, Option<String>)> {
    // SSH key auth: pso operations take no operator credential. preflight
    // validates --cred-alias / flag combo without reading DPAPI or stdin for a
    // credential that would only be discarded.
    cred.preflight(db)?;
    Ok((None, None))
}

fn resolve_engine_path(db: &cache_core::data::Db, machine_id: i64) -> VoloResult<String> {
    let installs = cache_core::data::machine_ue_installs::list_for_machine(db, machine_id)?;
    if installs.is_empty() {
        return Err(VoloError::InvalidInput(format!(
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
