//! `voloctl cache pso <action>` handlers.
//!
//! verify     — check R008-R010 PSO precaching CVars in project ConsoleVariables.ini.
//!              Delegates to `domain_ini::scan_dispatch` (same real-scan path as
//!              `ini verify-pso-precaching` / the UI's `verify_pso_precaching`
//!              Tauri command) — this used to be a stub that only printed a hint.
//! warmup     — run UE `-game` ON each target render node (interactive session) and
//!              count PSO creation hitches; the readiness path replacing
//!              collect/distribute. Concurrent fan-out, NDJSON stream.
//! runs       — list warm-up/verification runs for a project.
//! collect    — [DEPRECATED] launch UE `-game` on source machine to record PSO files;
//!              uncooked `-game` records nothing (verified 2026-07-02).
//! list       — list collected PSO cache files for a project.
//! distribute — [DEPRECATED] Robocopy fan-out of a PSO cache file; distributed files
//!              are never consumed by uncooked `-game` builds.

use crate::args::PsoAction;
use crate::credential_args::CredentialArgs;
use crate::destructive::{self, Outcome};
use crate::output::{EmitSerialize, Event};
use crate::run::Ctx;
use cache_core::core::{
    loopback,
    pso_collect::{self, PsoCollectSpec},
    pso_distribute,
    pso_warmup::{self, PsoWarmupSpec},
    ue_runner::{RunnerCancel, UeRunnerBackend, UeRunnerEvent},
};
use cache_core::data::{
    machines as data_machines, project_locations, pso_cache_files, pso_warmup_runs, WarmupStatus,
};
use cache_core::error::{VoloError, VoloResult};
use std::collections::HashMap;

pub fn handle(ctx: &mut Ctx<'_>, action: PsoAction) -> VoloResult<()> {
    match action {
        PsoAction::Verify { project_id, cred } => {
            crate::domain_ini::scan_dispatch(ctx, vec![], Some(project_id), None, &cred)
        }
        PsoAction::Warmup {
            project_id,
            targets,
            resolution,
            max_minutes,
            ue_version,
            cred,
        } => warmup(
            ctx,
            project_id,
            &targets,
            &resolution,
            max_minutes,
            ue_version.as_deref(),
            &cred,
        ),
        PsoAction::Runs { project_id, machine } => runs(ctx, project_id, machine),
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

// ─── warmup ───────────────────────────────────────────────────────────────────

fn warmup(
    ctx: &mut Ctx<'_>,
    project_id: i64,
    target_ids: &[i64],
    resolution: &str,
    max_minutes: u32,
    ue_version: Option<&str>,
    cred: &CredentialArgs,
) -> VoloResult<()> {
    let (res_w, res_h) = parse_resolution(resolution)?;
    if max_minutes == 0 {
        // 0 disarms the watchdog — the only mechanism that ever ends a -game run.
        return Err(VoloError::InvalidInput("max-minutes must be >= 1".into()));
    }
    let mut ids: Vec<i64> = target_ids.to_vec();
    ids.sort_unstable();
    ids.dedup();
    if ids.is_empty() {
        return Err(VoloError::InvalidInput("no target machines (--targets)".into()));
    }

    struct Target {
        machine_id: i64,
        ip: String,
        hostname: String,
        engine_path: String,
        uproject_path: String,
    }

    // Validate ALL targets up front so a partial fan-out never leaves half the
    // farm silently unwarmed.
    let db_clone = {
        let db = ctx.require_db()?;
        let _ = resolve_creds(db, cred)?; // preflight only (SSH key auth)
        db.clone()
    };
    let mut targets = Vec::with_capacity(ids.len());
    for machine_id in &ids {
        let machine = data_machines::find_by_id(&db_clone, *machine_id)?.ok_or_else(|| {
            VoloError::InvalidInput(format!("machine {} not found", machine_id))
        })?;
        let location = project_locations::get_for_project_machine(&db_clone, project_id, *machine_id)?
            .ok_or_else(|| {
                VoloError::InvalidInput(format!(
                    "project {} not located on machine {}",
                    project_id, machine_id
                ))
            })?;
        let engine_path = resolve_engine_path_versioned(&db_clone, *machine_id, ue_version)?;
        targets.push(Target {
            machine_id: *machine_id,
            ip: machine.ip,
            hostname: machine.hostname,
            engine_path,
            uproject_path: location.uproject_path,
        });
    }

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| VoloError::OperationFailed(format!("tokio runtime: {}", e)))?;
    let total = targets.len() as i64;

    rt.block_on(async {
        let (agg_tx, mut agg_rx) = tokio::sync::mpsc::unbounded_channel();
        let mut cancels = Vec::with_capacity(targets.len());
        let mut cancel_map: HashMap<i64, std::sync::Arc<tokio::sync::Mutex<RunnerCancel>>> =
            HashMap::new();
        let mut run_ids: HashMap<i64, i64> = HashMap::new();
        let mut started_at: HashMap<i64, std::time::Instant> = HashMap::new();

        // Persist ALL run rows before launching anything: a mid-loop DB failure
        // must never leave already-launched nodes running untracked.
        for target in &targets {
            let run_id = pso_warmup_runs::insert_started(
                &db_clone,
                project_id,
                target.machine_id,
                (res_w, res_h),
                max_minutes,
            )?;
            run_ids.insert(target.machine_id, run_id);
        }

        for (idx, target) in targets.iter().enumerate() {
            started_at.insert(target.machine_id, std::time::Instant::now());

            let backend = if loopback::is_loopback_target(&target.ip)
                || loopback::is_loopback_target(&target.hostname)
            {
                UeRunnerBackend::Local
            } else {
                UeRunnerBackend::Remote
            };
            let spec = PsoWarmupSpec {
                project_id,
                machine_id: target.machine_id,
                resolution: (res_w, res_h),
                max_minutes,
            };
            let mut handle = pso_warmup::launch_warmup(
                backend,
                &target.ip,
                &target.engine_path,
                &target.uproject_path,
                &spec,
            );
            cancels.push(handle.cancel.clone());
            cancel_map.insert(target.machine_id, handle.cancel.clone());
            pso_warmup::spawn_watchdog(
                handle.cancel.clone(),
                max_minutes,
                format!("pso-warmup-{}", target.machine_id),
            );

            let tx = agg_tx.clone();
            let machine_id = target.machine_id;
            tokio::spawn(async move {
                while let Some(ev) = handle.events.recv().await {
                    let terminal = matches!(
                        ev,
                        UeRunnerEvent::Completed { .. }
                            | UeRunnerEvent::Cancelled
                            | UeRunnerEvent::Error { .. }
                    );
                    let _ = tx.send((machine_id, ev));
                    if terminal {
                        break;
                    }
                }
            });

            ctx.emitter
                .emit_event(&Event::ItemStarted {
                    item_id: format!("machine:{}", machine_id),
                    index: idx as i64,
                    total,
                })
                .ok();
        }
        drop(agg_tx);

        // Ctrl-C → graceful cancel on ALL nodes; second Ctrl-C force-quits.
        let cancels_for_sig = cancels.clone();
        tokio::spawn(async move {
            if tokio::signal::ctrl_c().await.is_ok() {
                for cancel in &cancels_for_sig {
                    cancel.lock().await.requested = true;
                }
                eprintln!(
                    "→ interrupt received; stopping UE on all nodes (Ctrl-C again to force-quit)"
                );
            }
            let _ = tokio::signal::ctrl_c().await;
            std::process::exit(130);
        });

        let mut hitches: HashMap<i64, i64> = HashMap::new();
        let mut summary: Vec<serde_json::Value> = Vec::new();
        let mut failed = false;
        let mut done: i64 = 0;

        while let Some((machine_id, ev)) = agg_rx.recv().await {
            let run_id = run_ids[&machine_id];
            match &ev {
                UeRunnerEvent::Spawned { pid, log_path } => {
                    ctx.emitter
                        .emit_event(&Event::LogLine {
                            text: format!("[m{}] ue spawned pid={} log={}", machine_id, pid, log_path),
                            parsed_kind: Some("spawned".into()),
                        })
                        .ok();
                }
                UeRunnerEvent::LogLine { text, parsed_kind } => {
                    if pso_warmup::is_hitch_line(text) {
                        *hitches.entry(machine_id).or_insert(0) += 1;
                    }
                    ctx.emitter
                        .emit_event(&Event::LogLine {
                            text: format!("[m{}] {}", machine_id, text),
                            parsed_kind: parsed_kind.clone(),
                        })
                        .ok();
                }
                UeRunnerEvent::Progress { pct, label } => {
                    ctx.emitter
                        .emit_event(&Event::Progress {
                            pct: *pct,
                            label: format!("[m{}] {}", machine_id, label),
                            current: None,
                            total: None,
                        })
                        .ok();
                }
                UeRunnerEvent::Completed { .. }
                | UeRunnerEvent::Cancelled
                | UeRunnerEvent::Error { .. } => {
                    let duration = started_at[&machine_id].elapsed().as_secs() as i64;
                    let hitch_count = *hitches.get(&machine_id).unwrap_or(&0);
                    let (status, error_message): (WarmupStatus, Option<String>) = match &ev {
                        UeRunnerEvent::Completed { exit_code, .. } => {
                            // exit_critical parses to Completed{1}: a crashed UE
                            // never warmed the node — must not read as green.
                            if *exit_code == 0 {
                                (WarmupStatus::Ok, None)
                            } else {
                                (
                                    WarmupStatus::Err,
                                    Some(format!("UE exited with code {}", exit_code)),
                                )
                            }
                        }
                        UeRunnerEvent::Cancelled => {
                            // Watchdog = planned duration reached (a completion);
                            // an operator Ctrl-C = the node was NOT verified.
                            if cancel_map[&machine_id].lock().await.watchdog {
                                (WarmupStatus::Ok, None)
                            } else {
                                (WarmupStatus::Cancelled, None)
                            }
                        }
                        UeRunnerEvent::Error { message } => {
                            (WarmupStatus::Err, Some(message.clone()))
                        }
                        _ => unreachable!(),
                    };
                    // Cancelled keeps the (partial-window) hitch count as info;
                    // green-light eligibility lives in the status alone.
                    let persisted_hitches =
                        matches!(status, WarmupStatus::Ok | WarmupStatus::Cancelled)
                            .then_some(hitch_count);
                    // A DB write failure must not abort the drain loop — the
                    // other nodes' watchdogs/cancels live on this runtime.
                    if let Err(err) = pso_warmup_runs::finish(
                        &db_clone,
                        run_id,
                        status,
                        persisted_hitches,
                        error_message.as_deref(),
                        duration,
                    ) {
                        eprintln!(
                            "warning: persisting run {} for machine {} failed: {}",
                            run_id, machine_id, err
                        );
                        failed = true;
                    }
                    let item_ok = status == WarmupStatus::Ok;
                    if status == WarmupStatus::Err {
                        failed = true;
                    }
                    let message = match (&status, &error_message) {
                        (WarmupStatus::Ok, _) => format!("hitch_count={}", hitch_count),
                        (WarmupStatus::Cancelled, _) => {
                            format!("cancelled by operator (hitch_count={}, not verified)", hitch_count)
                        }
                        (_, Some(msg)) => msg.clone(),
                        (_, None) => "failed".into(),
                    };
                    ctx.emitter
                        .emit_event(&Event::ItemCompleted {
                            item_id: format!("machine:{}", machine_id),
                            index: done,
                            ok: item_ok,
                            message: Some(message),
                        })
                        .ok();
                    let mut entry = serde_json::json!({
                        "machine_id": machine_id,
                        "run_id": run_id,
                        "status": status.as_str(),
                        "duration_secs": duration,
                    });
                    if let Some(h) = persisted_hitches {
                        entry["hitch_count"] = serde_json::json!(h);
                    }
                    if let Some(msg) = &error_message {
                        entry["error_message"] = serde_json::json!(msg);
                    }
                    summary.push(entry);
                    done += 1;
                }
            }
        }

        if failed {
            return Err(VoloError::OperationFailed(
                "one or more warm-up runs failed (see items above)".into(),
            ));
        }
        ctx.emitter
            .emit_event(&Event::Completed {
                summary: serde_json::json!({ "runs": summary }),
            })
            .ok();
        Ok::<_, VoloError>(())
    })?;

    Ok(())
}

// ─── runs ─────────────────────────────────────────────────────────────────────

fn runs(ctx: &mut Ctx<'_>, project_id: i64, machine: Option<i64>) -> VoloResult<()> {
    let db = ctx.require_db()?;
    // Lazy reaper: rows stuck 'running' past their planned window mean the
    // supervising process died — reap on read so they never look in-flight.
    let _ = pso_warmup_runs::reap_overdue(db);
    let rows = pso_warmup_runs::list_by_project(db, project_id, machine)?;
    ctx.emitter.emit_result(&rows).ok();
    Ok(())
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
    resolve_engine_path_versioned(db, machine_id, None)
}

fn resolve_engine_path_versioned(
    db: &cache_core::data::Db,
    machine_id: i64,
    preferred_version: Option<&str>,
) -> VoloResult<String> {
    let installs = cache_core::data::machine_ue_installs::list_for_machine(db, machine_id)?;
    if installs.is_empty() {
        return Err(VoloError::InvalidInput(format!(
            "machine {} has no detected UE installs",
            machine_id
        )));
    }
    if let Some(version) = preferred_version {
        return installs
            .into_iter()
            .find(|i| i.version == version)
            .map(|i| i.install_path)
            .ok_or_else(|| {
                VoloError::InvalidInput(format!("UE {} not on machine {}", version, machine_id))
            });
    }
    let install = installs
        .iter()
        .find(|i| i.is_primary)
        .cloned()
        .unwrap_or_else(|| installs[0].clone());
    Ok(install.install_path)
}
