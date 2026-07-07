//! `voloctl cache pso <action>` handlers.
//!
//! verify     — check R008-R010 PSO precaching CVars in project ConsoleVariables.ini.
//!              Delegates to `domain_ini::scan_dispatch` (same real-scan path as
//!              `ini verify-pso-precaching` / the UI's `verify_pso_precaching`
//!              Tauri command) — this used to be a stub that only printed a hint.
//! warmup     — run UE `-game` ON each target render node (held SSH session) and
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
use crate::output::{EmitSerialize, Event};
use crate::run::Ctx;
use cache_core::core::{
    driver_cache_probe, loopback, pso_coldtest, pso_status, pso_traversal,
    pso_warmup::{self, PsoWarmupSpec},
    ue_runner::{RunnerCancel, UeRunnerBackend, UeRunnerEvent},
};
use cache_core::data::{
    machines as data_machines, project_locations, pso_warmup_runs, WarmupStatus,
};
use cache_core::error::{VoloError, VoloResult};
use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};

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
            verify_minutes,
            traverse_map,
            dc_cfg_path,
            dc_node,
            offscreen,
            extra_args,
            ue_version,
            cred,
        } => warmup(
            ctx,
            project_id,
            &targets,
            &resolution,
            max_minutes,
            verify_minutes,
            traverse_map.as_deref(),
            dc_cfg_path.as_deref(),
            dc_node.as_deref(),
            offscreen,
            &extra_args,
            ue_version.as_deref(),
            &cred,
        ),
        PsoAction::Runs {
            project_id,
            machine,
        } => runs(ctx, project_id, machine),
        PsoAction::Status {
            project_id,
            machines,
        } => status(ctx, project_id, &machines),
        PsoAction::Coldtest {
            project_id,
            targets,
            resolution,
            max_minutes,
            dc_cfg_path,
            dc_node,
            offscreen,
            extra_args,
            ue_version,
            cred,
        } => coldtest(
            ctx,
            project_id,
            &targets,
            &resolution,
            max_minutes,
            dc_cfg_path.as_deref(),
            dc_node.as_deref(),
            offscreen,
            &extra_args,
            ue_version.as_deref(),
            &cred,
        ),
    }
}

// ─── warmup ───────────────────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
fn warmup(
    ctx: &mut Ctx<'_>,
    project_id: i64,
    target_ids: &[i64],
    resolution: &str,
    max_minutes: u32,
    verify_minutes: u32,
    traverse_map: Option<&str>,
    dc_cfg_path: Option<&str>,
    dc_node: Option<&str>,
    offscreen: bool,
    extra_args: &[String],
    ue_version: Option<&str>,
    cred: &CredentialArgs,
) -> VoloResult<()> {
    let (res_w, res_h) = parse_resolution(resolution)?;
    if max_minutes == 0 {
        // 0 disarms the watchdog — the only mechanism that ever ends a -game run.
        return Err(VoloError::InvalidInput("max-minutes must be >= 1".into()));
    }
    if verify_minutes == 0 {
        return Err(VoloError::InvalidInput("verify-minutes must be >= 1".into()));
    }
    let targets = resolve_targets(ctx, project_id, target_ids, ue_version, cred)?;
    let db_clone = ctx.require_db()?.clone();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| VoloError::OperationFailed(format!("tokio runtime: {}", e)))?;
    let total = targets.len() as i64;

    rt.block_on(async {
        let (agg_tx, mut agg_rx) = tokio::sync::mpsc::unbounded_channel();
        // Verify-phase relaunches push cancels AFTER the Ctrl-C task is armed,
        // so the list is shared instead of a snapshot Vec.
        let cancels: std::sync::Arc<
            std::sync::Mutex<Vec<std::sync::Arc<tokio::sync::Mutex<RunnerCancel>>>>,
        > = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut cancel_map: HashMap<i64, std::sync::Arc<tokio::sync::Mutex<RunnerCancel>>> =
            HashMap::new();
        let mut run_ids: HashMap<i64, i64> = HashMap::new();
        let mut started_at: HashMap<i64, std::time::Instant> = HashMap::new();
        let dc_cfg_path = normalize_optional(dc_cfg_path);
        let dc_node = normalize_optional(dc_node);
        let extra_args = normalize_extra_args(extra_args);
        let specs: HashMap<i64, PsoWarmupSpec> = targets
            .iter()
            .map(|target| {
                (
                    target.machine_id,
                    PsoWarmupSpec {
                        project_id,
                        machine_id: target.machine_id,
                        resolution: (res_w, res_h),
                        max_minutes,
                        dc_cfg_path: dc_cfg_path.clone(),
                        dc_node: dc_node.clone(),
                        offscreen,
                        extra_args: extra_args.clone(),
                    },
                )
            })
            .collect();
        for spec in specs.values() {
            pso_warmup::validate_warmup_spec(spec)?;
        }
        let traversal_spec_for = |host: &str| -> Option<pso_traversal::TraversalSpec> {
            traverse_map.map(|map| pso_traversal::TraversalSpec {
                host: host.into(),
                ws_port: 30020,
                map_path: map.into(),
                dwell_ms: 2000,
                yaw_step_deg: 30.0,
                pitch_levels_deg: vec![-15.0, 0.0, 15.0],
                probe_interval_secs: 30,
            })
        };
        if traverse_map.is_some() {
            for target in &targets {
                pso_traversal::validate_traversal_spec(
                    &traversal_spec_for(&target.ip).expect("traverse_map is Some"),
                )?;
            }
        }

        // Persist ALL run rows before launching anything: a mid-loop DB failure
        // must never leave already-launched nodes running untracked.
        for target in &targets {
            let spec = &specs[&target.machine_id];
            let run_id = pso_warmup_runs::insert_started(
                &db_clone,
                project_id,
                target.machine_id,
                (res_w, res_h),
                max_minutes,
                spec.mode(),
                spec.dc_node.as_deref(),
                traverse_map.is_some(),
            )?;
            run_ids.insert(target.machine_id, run_id);
        }

        let targets_by_id: HashMap<i64, &WarmupTarget> =
            targets.iter().map(|t| (t.machine_id, t)).collect();
        // 遍历任务与其 hitch 共享计数器（按机，跨段替换）。
        let mut traversals: HashMap<
            i64,
            (
                std::sync::Arc<std::sync::atomic::AtomicBool>,
                tokio::task::JoinHandle<pso_traversal::TraversalOutcome>,
            ),
        > = HashMap::new();
        let mut active_counters: HashMap<i64, std::sync::Arc<AtomicI64>> = HashMap::new();

        for (idx, target) in targets.iter().enumerate() {
            started_at.insert(target.machine_id, std::time::Instant::now());
            let spec = specs[&target.machine_id].clone();
            let handle = pso_warmup::launch_warmup(
                target.backend(),
                &target.ip,
                &target.engine_path,
                &target.uproject_path,
                &spec,
            )?;
            cancels.lock().unwrap().push(handle.cancel.clone());
            cancel_map.insert(target.machine_id, handle.cancel.clone());
            pso_warmup::spawn_watchdog(
                handle.cancel.clone(),
                max_minutes,
                format!("pso-warmup-{}", target.machine_id),
            );
            if let Some(tspec) = traversal_spec_for(&target.ip) {
                let counter = std::sync::Arc::new(AtomicI64::new(0));
                let th = pso_traversal::spawn_traversal(
                    tspec,
                    counter.clone(),
                    handle.cancel.clone(),
                );
                spawn_traversal_logger(th.events, target.machine_id);
                active_counters.insert(target.machine_id, counter);
                traversals.insert(target.machine_id, (th.stop, th.join));
            }
            spawn_event_forwarder(handle, target.machine_id, agg_tx.clone());
            ctx.emitter
                .emit_event(&Event::ItemStarted {
                    item_id: format!("machine:{}", target.machine_id),
                    index: idx as i64,
                    total,
                })
                .ok();
        }
        // agg_tx intentionally stays alive for verify-phase forwarders; the
        // drain loop exits on done == total instead of channel close.

        // Ctrl-C → graceful cancel on ALL nodes; second Ctrl-C force-quits.
        let cancels_for_sig = cancels.clone();
        tokio::spawn(async move {
            if tokio::signal::ctrl_c().await.is_ok() {
                let list = { cancels_for_sig.lock().unwrap().clone() };
                for cancel in &list {
                    cancel.lock().await.requested = true;
                }
                eprintln!(
                    "→ interrupt received; stopping UE on all nodes (Ctrl-C again to force-quit)"
                );
            }
            let _ = tokio::signal::ctrl_c().await;
            std::process::exit(130);
        });

        // Two-phase state per machine: prerun absorbs hitches, then the same
        // spec re-runs as the verify phase — its hitch count is the green-light
        // basis (0 = ok, >0 = not_ready).
        let mut phases: HashMap<i64, &'static str> =
            targets.iter().map(|t| (t.machine_id, "prerun")).collect();
        let mut prerun_hitches: HashMap<i64, i64> = HashMap::new();
        let mut verify_hitches: HashMap<i64, i64> = HashMap::new();
        let mut verify_started: HashMap<i64, std::time::Instant> = HashMap::new();
        let mut summary: Vec<serde_json::Value> = Vec::new();
        let mut failed = false;
        let mut any_not_ready = false;
        let mut done: i64 = 0;

        while done < total {
            let Some((machine_id, ev)) = agg_rx.recv().await else {
                break;
            };
            let run_id = run_ids[&machine_id];
            let phase = phases[&machine_id];
            match &ev {
                UeRunnerEvent::Spawned { pid, log_path } => {
                    ctx.emitter
                        .emit_event(&Event::LogLine {
                            text: format!(
                                "[m{}] ue spawned ({}) pid={} log={}",
                                machine_id, phase, pid, log_path
                            ),
                            parsed_kind: Some("spawned".into()),
                        })
                        .ok();
                }
                UeRunnerEvent::LogLine { text, parsed_kind } => {
                    if pso_warmup::is_hitch_line(text) {
                        let bucket = if phase == "verify" {
                            &mut verify_hitches
                        } else {
                            &mut prerun_hitches
                        };
                        let entry = bucket.entry(machine_id).or_insert(0);
                        *entry += 1;
                        if let Some(counter) = active_counters.get(&machine_id) {
                            counter.store(*entry, Ordering::Relaxed);
                        }
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
                    // 当前段的遍历任务先停（收敛结论只在预跑段落库）。
                    let traversal_outcome = match traversals.remove(&machine_id) {
                        Some((stop, join)) => {
                            stop.store(true, Ordering::Relaxed);
                            join.await.ok()
                        }
                        None => None,
                    };
                    active_counters.remove(&machine_id);
                    if phase == "prerun" {
                        if let Some(outcome) = &traversal_outcome {
                            if let Err(err) = pso_warmup_runs::record_convergence(
                                &db_clone,
                                run_id,
                                outcome.converged,
                            ) {
                                eprintln!(
                                    "warning: persisting convergence for run {} failed: {}",
                                    run_id, err
                                );
                            }
                        }
                    }
                    // Planned completion = engine exit 0 or the phase watchdog;
                    // an operator Ctrl-C = the node was NOT verified.
                    enum PhaseEnd {
                        Completed,
                        Cancelled,
                        Error(String),
                    }
                    let end = match &ev {
                        UeRunnerEvent::Completed { exit_code, .. } => {
                            // exit_critical parses to Completed{1}: a crashed UE
                            // never warmed the node — must not read as green.
                            if *exit_code == 0 {
                                PhaseEnd::Completed
                            } else {
                                PhaseEnd::Error(format!("UE exited with code {}", exit_code))
                            }
                        }
                        UeRunnerEvent::Cancelled => {
                            if cancel_map[&machine_id].lock().await.watchdog {
                                PhaseEnd::Completed
                            } else {
                                PhaseEnd::Cancelled
                            }
                        }
                        UeRunnerEvent::Error { message } => PhaseEnd::Error(message.clone()),
                        _ => unreachable!(),
                    };

                    // Prerun window done → hand over to the verify phase.
                    if phase == "prerun" && matches!(end, PhaseEnd::Completed) {
                        let target = targets_by_id[&machine_id];
                        let spec = specs[&machine_id].clone();
                        match pso_warmup::launch_warmup(
                            target.backend(),
                            &target.ip,
                            &target.engine_path,
                            &target.uproject_path,
                            &spec,
                        ) {
                            Ok(handle) => {
                                cancels.lock().unwrap().push(handle.cancel.clone());
                                cancel_map.insert(machine_id, handle.cancel.clone());
                                pso_warmup::spawn_watchdog(
                                    handle.cancel.clone(),
                                    verify_minutes,
                                    format!("pso-warmup-verify-{}", machine_id),
                                );
                                if let Some(tspec) =
                                    traversal_spec_for(&targets_by_id[&machine_id].ip)
                                {
                                    let counter = std::sync::Arc::new(AtomicI64::new(0));
                                    let th = pso_traversal::spawn_traversal(
                                        tspec,
                                        counter.clone(),
                                        handle.cancel.clone(),
                                    );
                                    spawn_traversal_logger(th.events, machine_id);
                                    active_counters.insert(machine_id, counter);
                                    traversals.insert(machine_id, (th.stop, th.join));
                                }
                                verify_started.insert(machine_id, std::time::Instant::now());
                                phases.insert(machine_id, "verify");
                                spawn_event_forwarder(handle, machine_id, agg_tx.clone());
                                ctx.emitter
                                    .emit_event(&Event::LogLine {
                                        text: format!(
                                            "[m{}] prerun complete (absorbed {} hitches) — starting verify phase ({} min)",
                                            machine_id,
                                            prerun_hitches.get(&machine_id).unwrap_or(&0),
                                            verify_minutes
                                        ),
                                        parsed_kind: Some("phase".into()),
                                    })
                                    .ok();
                                continue;
                            }
                            Err(err) => {
                                finalize_warmup_run(
                                    ctx,
                                    &db_clone,
                                    run_id,
                                    machine_id,
                                    "prerun",
                                    WarmupStatus::Err,
                                    Some(format!("verify phase launch failed: {err}")),
                                    prerun_hitches.get(&machine_id).copied().unwrap_or(0),
                                    None,
                                    started_at[&machine_id].elapsed().as_secs() as i64,
                                    None,
                                    &mut summary,
                                    &mut failed,
                                    done,
                                );
                                done += 1;
                                continue;
                            }
                        }
                    }

                    let vh = verify_hitches.get(&machine_id).copied().unwrap_or(0);
                    let (status, error_message) = match end {
                        PhaseEnd::Cancelled => (WarmupStatus::Cancelled, None),
                        PhaseEnd::Error(msg) => (WarmupStatus::Err, Some(msg)),
                        // Only the verify phase can reach here with Completed.
                        PhaseEnd::Completed => (pso_warmup::verify_outcome(vh), None),
                    };
                    let verify_secs = (phase == "verify").then(|| {
                        verify_started
                            .get(&machine_id)
                            .map(|t| t.elapsed().as_secs() as i64)
                            .unwrap_or(0)
                    });
                    if let Some(secs) = verify_secs {
                        if let Err(err) =
                            pso_warmup_runs::record_verify_phase(&db_clone, run_id, vh, secs)
                        {
                            eprintln!(
                                "warning: persisting verify phase for run {} failed: {}",
                                run_id, err
                            );
                        }
                    }
                    if status == WarmupStatus::NotReady {
                        any_not_ready = true;
                    }
                    finalize_warmup_run(
                        ctx,
                        &db_clone,
                        run_id,
                        machine_id,
                        phase,
                        status,
                        error_message,
                        prerun_hitches.get(&machine_id).copied().unwrap_or(0),
                        (phase == "verify").then_some(vh),
                        started_at[&machine_id].elapsed().as_secs() as i64,
                        None,
                        &mut summary,
                        &mut failed,
                        done,
                    );
                    done += 1;
                }
            }
        }

        if failed {
            return Err(VoloError::OperationFailed(
                "one or more warm-up runs failed (see items above)".into(),
            ));
        }
        if any_not_ready {
            return Err(VoloError::OperationFailed(
                "verify phase still counted hitches on one or more nodes (not_ready) — run warmup again".into(),
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

struct WarmupTarget {
    machine_id: i64,
    ip: String,
    hostname: String,
    engine_path: String,
    uproject_path: String,
}

impl WarmupTarget {
    fn backend(&self) -> UeRunnerBackend {
        if loopback::is_loopback_target(&self.ip) || loopback::is_loopback_target(&self.hostname) {
            UeRunnerBackend::Local
        } else {
            UeRunnerBackend::Remote
        }
    }
}

/// Validate ALL targets up front so a partial fan-out never leaves half the
/// farm silently unwarmed.
fn resolve_targets(
    ctx: &mut Ctx<'_>,
    project_id: i64,
    target_ids: &[i64],
    ue_version: Option<&str>,
    cred: &CredentialArgs,
) -> VoloResult<Vec<WarmupTarget>> {
    let mut ids: Vec<i64> = target_ids.to_vec();
    ids.sort_unstable();
    ids.dedup();
    if ids.is_empty() {
        return Err(VoloError::InvalidInput(
            "no target machines (--targets)".into(),
        ));
    }
    let db = ctx.require_db()?;
    let _ = resolve_creds(db, cred)?; // preflight only (SSH key auth)
    let mut targets = Vec::with_capacity(ids.len());
    for machine_id in &ids {
        let machine = data_machines::find_by_id(db, *machine_id)?
            .ok_or_else(|| VoloError::InvalidInput(format!("machine {} not found", machine_id)))?;
        let location = project_locations::get_for_project_machine(db, project_id, *machine_id)?
            .ok_or_else(|| {
                VoloError::InvalidInput(format!(
                    "project {} not located on machine {}",
                    project_id, machine_id
                ))
            })?;
        let engine_path = resolve_engine_path_versioned(db, *machine_id, ue_version)?;
        targets.push(WarmupTarget {
            machine_id: *machine_id,
            ip: machine.ip,
            hostname: machine.hostname,
            engine_path,
            uproject_path: location.uproject_path,
        });
    }
    Ok(targets)
}

/// 遍历事件走 stderr（信息性），保持 stdout 的 NDJSON 纯净。
fn spawn_traversal_logger(
    mut events: tokio::sync::mpsc::UnboundedReceiver<pso_traversal::TraversalEvent>,
    machine_id: i64,
) {
    tokio::spawn(async move {
        while let Some(ev) = events.recv().await {
            match ev {
                pso_traversal::TraversalEvent::Info(msg) => {
                    eprintln!("[m{} traversal] {}", machine_id, msg)
                }
                pso_traversal::TraversalEvent::Sample {
                    hitch_count,
                    cache_bytes,
                    cycles_completed,
                } => eprintln!(
                    "[m{} traversal] sample: hitches={} cache={}B cycles={}",
                    machine_id, hitch_count, cache_bytes, cycles_completed
                ),
                pso_traversal::TraversalEvent::Converged {
                    cycles_completed,
                    poses_sent,
                } => eprintln!(
                    "[m{} traversal] CONVERGED after {} cycles / {} poses — ending prerun early",
                    machine_id, cycles_completed, poses_sent
                ),
                pso_traversal::TraversalEvent::Error(msg) => {
                    eprintln!("[m{} traversal] error: {}", machine_id, msg)
                }
            }
        }
    });
}

fn spawn_event_forwarder(
    mut handle: cache_core::core::ue_runner::RunnerHandle,
    machine_id: i64,
    tx: tokio::sync::mpsc::UnboundedSender<(i64, UeRunnerEvent)>,
) {
    tokio::spawn(async move {
        let mut saw_terminal = false;
        while let Some(ev) = handle.events.recv().await {
            let terminal = matches!(
                ev,
                UeRunnerEvent::Completed { .. }
                    | UeRunnerEvent::Cancelled
                    | UeRunnerEvent::Error { .. }
            );
            let _ = tx.send((machine_id, ev));
            if terminal {
                saw_terminal = true;
                break;
            }
        }
        // The drain loop exits on done-count, not channel close — a stream
        // that dies without a terminal event must still produce one.
        if !saw_terminal {
            let _ = tx.send((
                machine_id,
                UeRunnerEvent::Error {
                    message: "runner event stream ended without a terminal event".into(),
                },
            ));
        }
    });
}

/// Persist + emit one node's terminal state. `verify_hitch_count` is None when
/// the run never reached the verify phase.
#[allow(clippy::too_many_arguments)]
fn finalize_warmup_run(
    ctx: &mut Ctx<'_>,
    db: &cache_core::data::Db,
    run_id: i64,
    machine_id: i64,
    ended_phase: &str,
    status: WarmupStatus,
    error_message: Option<String>,
    prerun_hitch_count: i64,
    verify_hitch_count: Option<i64>,
    duration_secs: i64,
    driver_cache_growth_bytes: Option<i64>,
    summary: &mut Vec<serde_json::Value>,
    failed: &mut bool,
    index: i64,
) {
    // Cancelled/NotReady keep the (partial-window) hitch count as info;
    // green-light eligibility lives in the status alone.
    let persisted_hitches = matches!(
        status,
        WarmupStatus::Ok | WarmupStatus::Cancelled | WarmupStatus::NotReady
    )
    .then_some(prerun_hitch_count);
    // A DB write failure must not abort the drain loop — the other nodes'
    // watchdogs/cancels live on this runtime.
    if let Err(err) = pso_warmup_runs::finish(
        db,
        run_id,
        status,
        persisted_hitches,
        error_message.as_deref(),
        duration_secs,
        driver_cache_growth_bytes,
    ) {
        eprintln!(
            "warning: persisting run {} for machine {} failed: {}",
            run_id, machine_id, err
        );
        *failed = true;
    }
    if status == WarmupStatus::Err {
        *failed = true;
    }
    let message = match (&status, &error_message) {
        (WarmupStatus::Ok, _) => format!(
            "verify hitch=0 (prerun absorbed {})",
            prerun_hitch_count
        ),
        (WarmupStatus::NotReady, _) => format!(
            "verify hitch={} — not ready, run warmup again",
            verify_hitch_count.unwrap_or(0)
        ),
        (WarmupStatus::Cancelled, _) => format!(
            "cancelled by operator (hitch_count={}, not verified)",
            prerun_hitch_count
        ),
        (_, Some(msg)) => msg.clone(),
        (_, None) => "failed".into(),
    };
    ctx.emitter
        .emit_event(&Event::ItemCompleted {
            item_id: format!("machine:{}", machine_id),
            index,
            ok: status == WarmupStatus::Ok,
            message: Some(message),
        })
        .ok();
    let mut entry = serde_json::json!({
        "machine_id": machine_id,
        "run_id": run_id,
        "status": status.as_str(),
        "ended_phase": ended_phase,
        "duration_secs": duration_secs,
    });
    if let Some(h) = persisted_hitches {
        entry["hitch_count"] = serde_json::json!(h);
    }
    if let Some(vh) = verify_hitch_count {
        entry["verify_hitch_count"] = serde_json::json!(vh);
    }
    if let Some(g) = driver_cache_growth_bytes {
        entry["driver_cache_growth_bytes"] = serde_json::json!(g);
    }
    if let Some(msg) = &error_message {
        entry["error_message"] = serde_json::json!(msg);
    }
    summary.push(entry);
}

fn normalize_optional(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn normalize_extra_args(values: &[String]) -> Vec<String> {
    values
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect()
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

// ─── status ───────────────────────────────────────────────────────────────────

fn status(ctx: &mut Ctx<'_>, project_id: i64, machines: &[i64]) -> VoloResult<()> {
    let db = ctx.require_db()?;
    // Same lazy reaper as `runs`: stuck 'running' rows must not read as in-flight.
    let _ = pso_warmup_runs::reap_overdue(db);
    let machine_ids = (!machines.is_empty()).then(|| machines.to_vec());
    let cells = pso_status::list_pso_status(db, project_id, machine_ids)?;
    ctx.emitter.emit_result(&cells).ok();
    Ok(())
}

// ─── coldtest ─────────────────────────────────────────────────────────────────

/// Clear the driver cache, run the nDisplay spec once (single phase) and count
/// hitches — a cold-start diagnostic, NOT a green-light path (that is warmup's
/// two-phase job). Results land in pso_warmup_runs with mode=coldtest.
#[allow(clippy::too_many_arguments)]
fn coldtest(
    ctx: &mut Ctx<'_>,
    project_id: i64,
    target_ids: &[i64],
    resolution: &str,
    max_minutes: u32,
    dc_cfg_path: Option<&str>,
    dc_node: Option<&str>,
    offscreen: bool,
    extra_args: &[String],
    ue_version: Option<&str>,
    cred: &CredentialArgs,
) -> VoloResult<()> {
    let (res_w, res_h) = parse_resolution(resolution)?;
    if max_minutes == 0 {
        return Err(VoloError::InvalidInput("max-minutes must be >= 1".into()));
    }
    let targets = resolve_targets(ctx, project_id, target_ids, ue_version, cred)?;
    let db_clone = ctx.require_db()?.clone();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| VoloError::OperationFailed(format!("tokio runtime: {}", e)))?;
    let total = targets.len() as i64;

    rt.block_on(async {
        let (agg_tx, mut agg_rx) = tokio::sync::mpsc::unbounded_channel();
        let cancels: std::sync::Arc<
            std::sync::Mutex<Vec<std::sync::Arc<tokio::sync::Mutex<RunnerCancel>>>>,
        > = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut cancel_map: HashMap<i64, std::sync::Arc<tokio::sync::Mutex<RunnerCancel>>> =
            HashMap::new();
        let mut started_at: HashMap<i64, std::time::Instant> = HashMap::new();
        let mut clear_after: HashMap<i64, i64> = HashMap::new();
        let dc_cfg_path = normalize_optional(dc_cfg_path);
        let dc_node = normalize_optional(dc_node);
        let extra_args = normalize_extra_args(extra_args);
        let specs: HashMap<i64, PsoWarmupSpec> = targets
            .iter()
            .map(|target| {
                (
                    target.machine_id,
                    PsoWarmupSpec {
                        project_id,
                        machine_id: target.machine_id,
                        resolution: (res_w, res_h),
                        max_minutes,
                        dc_cfg_path: dc_cfg_path.clone(),
                        dc_node: dc_node.clone(),
                        offscreen,
                        extra_args: extra_args.clone(),
                    },
                )
            })
            .collect();
        for spec in specs.values() {
            pso_warmup::validate_warmup_spec(spec)?;
        }

        let mut run_ids: HashMap<i64, i64> = HashMap::new();
        for target in &targets {
            let spec = &specs[&target.machine_id];
            let run_id = pso_warmup_runs::insert_started(
                &db_clone,
                project_id,
                target.machine_id,
                (res_w, res_h),
                max_minutes,
                pso_coldtest::COLDTEST_MODE,
                spec.dc_node.as_deref(),
                false,
            )?;
            run_ids.insert(target.machine_id, run_id);
        }

        // Ctrl-C → graceful cancel on ALL nodes; second Ctrl-C force-quits.
        let cancels_for_sig = cancels.clone();
        tokio::spawn(async move {
            if tokio::signal::ctrl_c().await.is_ok() {
                let list = { cancels_for_sig.lock().unwrap().clone() };
                for cancel in &list {
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

        for (idx, target) in targets.iter().enumerate() {
            let machine_id = target.machine_id;
            let run_id = run_ids[&machine_id];
            // Per-file clear tolerating locked residue (blocking SSH).
            let host = target.ip.clone();
            let decision =
                tokio::task::spawn_blocking(move || pso_coldtest::clear_and_decide(&host))
                    .await
                    .map_err(|err| {
                        VoloError::OperationFailed(format!("driver cache clear join: {err}"))
                    })?;
            let decision = match decision {
                Ok(d) => d,
                Err(err) => {
                    finalize_warmup_run(
                        ctx, &db_clone, run_id, machine_id, "coldtest",
                        WarmupStatus::Err, Some(format!("driver cache clear failed: {err}")),
                        0, None, 0, None, &mut summary, &mut failed, done,
                    );
                    done += 1;
                    continue;
                }
            };
            ctx.emitter
                .emit_event(&Event::LogLine {
                    text: format!(
                        "[m{}] driver cache cleared: {} deleted, residual {} files / {} bytes",
                        machine_id,
                        decision.clear_result.cleared_file_count,
                        decision.clear_result.after_file_count,
                        decision.clear_result.after_bytes
                    ),
                    parsed_kind: Some("clear".into()),
                })
                .ok();
            if !decision.can_run {
                let msg = decision.error_message.clone().unwrap_or_else(|| {
                    "driver cache clear residual exceeds coldtest threshold".into()
                });
                finalize_warmup_run(
                    ctx, &db_clone, run_id, machine_id, "coldtest",
                    WarmupStatus::Err, Some(msg), 0, None, 0, None,
                    &mut summary, &mut failed, done,
                );
                done += 1;
                continue;
            }
            clear_after.insert(machine_id, decision.clear_result.after_bytes);

            started_at.insert(machine_id, std::time::Instant::now());
            let spec = specs[&machine_id].clone();
            let handle = match pso_coldtest::launch_coldtest_run(
                target.backend(),
                &target.ip,
                &target.engine_path,
                &target.uproject_path,
                &spec,
            ) {
                Ok(handle) => handle,
                Err(err) => {
                    finalize_warmup_run(
                        ctx, &db_clone, run_id, machine_id, "coldtest",
                        WarmupStatus::Err, Some(format!("coldtest launch failed: {err}")),
                        0, None, 0, None, &mut summary, &mut failed, done,
                    );
                    done += 1;
                    continue;
                }
            };
            cancels.lock().unwrap().push(handle.cancel.clone());
            cancel_map.insert(machine_id, handle.cancel.clone());
            pso_warmup::spawn_watchdog(
                handle.cancel.clone(),
                max_minutes,
                format!("pso-coldtest-{}", machine_id),
            );
            spawn_event_forwarder(handle, machine_id, agg_tx.clone());
            ctx.emitter
                .emit_event(&Event::ItemStarted {
                    item_id: format!("machine:{}", machine_id),
                    index: idx as i64,
                    total,
                })
                .ok();
        }

        while done < total {
            let Some((machine_id, ev)) = agg_rx.recv().await else {
                break;
            };
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
                    // Growth = after-run size vs after-clear size (probe over
                    // SSH); a probe failure downgrades to growth=None, not Err.
                    let mut growth = None;
                    if status == WarmupStatus::Ok {
                        let host = targets.iter().find(|t| t.machine_id == machine_id)
                            .map(|t| t.ip.clone()).unwrap_or_default();
                        match tokio::task::spawn_blocking(move || driver_cache_probe::probe(&host))
                            .await
                        {
                            Ok(Ok(probe)) => {
                                growth = Some(pso_coldtest::driver_cache_growth_bytes(
                                    clear_after.get(&machine_id).copied().unwrap_or(0),
                                    probe.total_bytes,
                                ));
                            }
                            Ok(Err(err)) => {
                                eprintln!(
                                    "warning: post-run driver cache probe failed for machine {}: {}",
                                    machine_id, err
                                );
                            }
                            Err(err) => {
                                eprintln!(
                                    "warning: post-run driver cache probe join failed for machine {}: {}",
                                    machine_id, err
                                );
                            }
                        }
                    }
                    finalize_warmup_run(
                        ctx, &db_clone, run_id, machine_id, "coldtest",
                        status, error_message, hitch_count, None, duration, growth,
                        &mut summary, &mut failed, done,
                    );
                    done += 1;
                }
            }
        }

        if failed {
            return Err(VoloError::OperationFailed(
                "one or more coldtest runs failed (see items above)".into(),
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

// ─── shared parsing ───────────────────────────────────────────────────────────

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
