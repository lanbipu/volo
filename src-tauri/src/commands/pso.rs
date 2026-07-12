//! Tauri commands for PSO readiness (warmup / coldtest / status / driver cache).

use crate::commands::ddc_pak::UeJobRegistry;
use cache_core::core::{
    driver_cache_clear, driver_cache_probe, pso_coldtest,
    pso_status::{self, PsoStatusCell},
    pso_traversal::{self, TraversalSpec},
    pso_warmup::{self, PsoWarmupSpec},
    ue_runner::{RunnerCancel, UeRunnerBackend, UeRunnerEvent},
};
use cache_core::data::{
    driver_cache_snapshots, machine_ue_installs, machines as data_machines, project_locations,
    projects as data_projects, pso_project_settings, pso_warmup_runs, Db, DriverCacheSnapshot,
    PsoProjectSettings, PsoWarmupRun, WarmupStatus,
};
use cache_core::error::{VoloError, VoloResult};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

/// Parse `5.5` / `5.5.4` → (5, 5) so install rows and EngineAssociation align.
fn ue_version_key(version: &str) -> Option<(u32, u32)> {
    let mut parts = version.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    Some((major, minor))
}

/// Request pin → project EngineAssociation (major.minor) → machine primary.
fn resolve_warmup_ue_version(
    db: &Db,
    project_id: i64,
    request_ue_version: Option<&str>,
) -> VoloResult<Option<String>> {
    if let Some(v) = request_ue_version.map(str::trim).filter(|s| !s.is_empty()) {
        return Ok(Some(v.to_string()));
    }
    let project = data_projects::get(db, project_id)?.ok_or_else(|| {
        VoloError::InvalidInput(format!("project {} not found", project_id))
    })?;
    match (project.ue_version_major, project.ue_version_minor) {
        (Some(maj), Some(min)) => Ok(Some(format!("{}.{}", maj, min))),
        _ => Ok(None),
    }
}

fn resolve_engine_path(
    db: &Db,
    machine_id: i64,
    preferred_version: Option<&str>,
) -> VoloResult<String> {
    let installs = machine_ue_installs::list_for_machine(db, machine_id)?;
    if installs.is_empty() {
        return Err(VoloError::InvalidInput(format!(
            "machine {} has no detected UE installs",
            machine_id
        )));
    }
    if let Some(version) = preferred_version {
        let want = ue_version_key(version);
        let install = installs
            .into_iter()
            .find(|install| {
                install.version == version
                    || want.is_some() && ue_version_key(&install.version) == want
            })
            .ok_or_else(|| {
                VoloError::InvalidInput(format!("UE {} not on machine {}", version, machine_id))
            })?;
        return Ok(install.install_path);
    }
    let install = installs
        .iter()
        .find(|install| install.is_primary)
        .cloned()
        .unwrap_or_else(|| installs[0].clone());
    Ok(install.install_path)
}

// ---------------------------------------------------------------------------
// PSO warm-up & verification (per-node -game run with hitch counting).
// Replaces the falsified collect→distribute pipeline as the readiness path.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct StartPsoWarmupRequest {
    pub project_id: i64,
    pub target_machine_ids: Vec<i64>,
    pub resolution_w: u32,
    pub resolution_h: u32,
    pub max_minutes: u32,
    #[serde(default)]
    pub dc_cfg_path: Option<String>,
    #[serde(default)]
    pub dc_node: Option<String>,
    #[serde(default = "default_pso_offscreen")]
    pub offscreen: bool,
    #[serde(default)]
    pub extra_args: Vec<String>,
    /// Verify-phase window (minutes). After the prerun window a second run
    /// with the same spec counts hitches; 0 hitches there = green light.
    #[serde(default = "default_pso_verify_minutes")]
    pub verify_minutes: u32,
    /// 启用 RC 遍历（预跑/验证两段都驱动舞台扫场）；None = 固定机位。
    #[serde(default)]
    pub traversal: Option<TraversalRequest>,
    /// Pin the UE version used on every node. None = project's
    /// EngineAssociation (`ue_version_major.minor`); if the project has no
    /// parsed version, fall back to each node's primary install.
    #[serde(default)]
    pub ue_version: Option<String>,
}

fn default_pso_offscreen() -> bool {
    true
}

fn default_pso_verify_minutes() -> u32 {
    pso_warmup::DEFAULT_VERIFY_MINUTES
}

/// 遍历参数（host 由各目标机自动填充；其余省略走 TraversalSpec 默认值）。
#[derive(Debug, Clone, Deserialize)]
pub struct TraversalRequest {
    pub map_path: String,
    #[serde(default)]
    pub ws_port: Option<u16>,
    #[serde(default)]
    pub dwell_ms: Option<u64>,
    #[serde(default)]
    pub yaw_step_deg: Option<f64>,
    #[serde(default)]
    pub pitch_levels_deg: Option<Vec<f64>>,
    #[serde(default)]
    pub probe_interval_secs: Option<u64>,
}

impl TraversalRequest {
    fn to_spec(&self, host: &str) -> TraversalSpec {
        let base = TraversalSpec {
            host: host.into(),
            ws_port: 30020,
            map_path: self.map_path.clone(),
            dwell_ms: 2000,
            yaw_step_deg: 30.0,
            pitch_levels_deg: vec![-15.0, 0.0, 15.0],
            probe_interval_secs: 30,
        };
        TraversalSpec {
            ws_port: self.ws_port.unwrap_or(base.ws_port),
            dwell_ms: self.dwell_ms.unwrap_or(base.dwell_ms),
            yaw_step_deg: self.yaw_step_deg.unwrap_or(base.yaw_step_deg),
            pitch_levels_deg: self
                .pitch_levels_deg
                .clone()
                .unwrap_or(base.pitch_levels_deg.clone()),
            probe_interval_secs: self.probe_interval_secs.unwrap_or(base.probe_interval_secs),
            ..base
        }
    }
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

#[derive(Debug, Clone, Serialize)]
pub struct PsoWarmupLaunched {
    pub machine_id: i64,
    pub run_id: i64,
    pub job_id: String,
}

#[derive(Debug, Serialize)]
pub struct PsoWarmupJobResponse {
    pub job_id: String,
    pub runs: Vec<PsoWarmupLaunched>,
}

pub type StartPsoColdtestRequest = StartPsoWarmupRequest;

#[derive(Debug, Clone, Serialize)]
pub struct PsoColdtestLaunched {
    pub machine_id: i64,
    pub run_id: i64,
    pub job_id: Option<String>,
    pub clear_result: Option<driver_cache_clear::DriverCacheClearResult>,
    pub error_message: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct PsoColdtestJobResponse {
    pub job_id: String,
    pub runs: Vec<PsoColdtestLaunched>,
}

/// dc_cfg 存在性预检（巡检规则「nDisplay config 已配置且存在」的执行点）：
/// UE 对缺失的 -dc_cfg 不会 fail fast，预跑会静默跑成非集群形态、暖错 PSO 集，
/// 因此任何节点缺文件都整单拒绝（与 target 校验同一 fail-fast 语义）。
async fn preflight_dc_cfg(checks: Vec<(i64, String)>, dc_cfg_path: String) -> VoloResult<()> {
    let missing = tokio::task::spawn_blocking(move || -> VoloResult<Vec<i64>> {
        let mut missing = Vec::new();
        for (machine_id, ip) in checks {
            if !pso_warmup::check_dc_cfg_exists(&ip, &dc_cfg_path)? {
                missing.push(machine_id);
            }
        }
        Ok(missing)
    })
    .await
    .map_err(|err| VoloError::OperationFailed(format!("dc_cfg preflight join: {err}")))??;
    if !missing.is_empty() {
        return Err(VoloError::InvalidInput(format!(
            "nDisplay config (dc_cfg_path) not found on machine(s) {:?} — export it from Switchboard or fix the path",
            missing
        )));
    }
    Ok(())
}

#[derive(Clone, Serialize)]
struct WarmupProgressPayload<'a> {
    job_id: &'a str,
    parent_job_id: &'a str,
    machine_id: i64,
    project_id: i64,
    run_id: i64,
    phase: &'a str,
    hitch_count: i64,
    event: &'a UeRunnerEvent,
}

#[derive(Clone, Serialize)]
struct WarmupFinalizedPayload<'a> {
    job_id: &'a str,
    parent_job_id: &'a str,
    machine_id: i64,
    project_id: i64,
    run_id: i64,
    /// Phase the run ended in ("prerun" never reached verify).
    phase: &'a str,
    /// Prerun-phase hitches (absorption count, informational).
    hitch_count: Option<i64>,
    /// Verify-phase hitches — the green-light basis (0 = ok).
    verify_hitch_count: Option<i64>,
    status: &'a str,
    error_message: Option<String>,
}

enum WarmupPhaseEnd {
    /// Planned completion: engine exit 0 or the max-minutes watchdog.
    Completed,
    /// Operator cancel — the node was NOT verified.
    Cancelled,
    Error(String),
}

/// 遍历事件转发：TraversalEvent → 前端事件 pso-traversal-progress。
fn spawn_traversal_emitter(
    mut events: tokio::sync::mpsc::UnboundedReceiver<pso_traversal::TraversalEvent>,
    app: AppHandle,
    machine_id: i64,
    project_id: i64,
    run_id: i64,
    phase: &'static str,
    parent_job_id: String,
    job_id: String,
) {
    #[derive(Clone, Serialize)]
    struct TraversalProgressPayload<'a> {
        job_id: &'a str,
        parent_job_id: &'a str,
        machine_id: i64,
        project_id: i64,
        run_id: i64,
        phase: &'a str,
        event: &'a pso_traversal::TraversalEvent,
    }
    tokio::spawn(async move {
        while let Some(ev) = events.recv().await {
            let _ = app.emit(
                "pso-traversal-progress",
                TraversalProgressPayload {
                    job_id: &job_id,
                    parent_job_id: &parent_job_id,
                    machine_id,
                    project_id,
                    run_id,
                    phase,
                    event: &ev,
                },
            );
        }
    });
}

/// Drives one warmup phase to its terminal event, counting hitches and
/// re-emitting progress. Shared by the prerun and verify phases.
#[allow(clippy::too_many_arguments)]
async fn drive_warmup_phase(
    events: &mut tokio::sync::mpsc::UnboundedReceiver<UeRunnerEvent>,
    cancel: &Arc<tokio::sync::Mutex<RunnerCancel>>,
    app: &AppHandle,
    job_id: &str,
    parent_job_id: &str,
    machine_id: i64,
    project_id: i64,
    run_id: i64,
    phase: &'static str,
    hitch_count: &mut i64,
    shared_hitches: Option<&Arc<AtomicI64>>,
) -> WarmupPhaseEnd {
    while let Some(event) = events.recv().await {
        if let UeRunnerEvent::LogLine { text, .. } = &event {
            if pso_warmup::is_hitch_line(text) {
                *hitch_count += 1;
                if let Some(shared) = shared_hitches {
                    shared.store(*hitch_count, Ordering::Relaxed);
                }
            }
        }
        let _ = app.emit(
            "pso-warmup-progress",
            WarmupProgressPayload {
                job_id,
                parent_job_id,
                machine_id,
                project_id,
                run_id,
                phase,
                hitch_count: *hitch_count,
                event: &event,
            },
        );

        match &event {
            UeRunnerEvent::Completed { exit_code, .. } => {
                // exit_critical parses to Completed{1}: a crashed UE never
                // warmed the node — must not read as green.
                return if *exit_code == 0 {
                    WarmupPhaseEnd::Completed
                } else {
                    WarmupPhaseEnd::Error(format!("UE exited with code {}", exit_code))
                };
            }
            UeRunnerEvent::Cancelled => {
                // Watchdog = planned phase window reached (a completion);
                // an operator cancel = the node was NOT verified.
                return if cancel.lock().await.watchdog {
                    WarmupPhaseEnd::Completed
                } else {
                    WarmupPhaseEnd::Cancelled
                };
            }
            UeRunnerEvent::Error { message } => {
                return WarmupPhaseEnd::Error(message.clone());
            }
            _ => {}
        }
    }
    WarmupPhaseEnd::Error("runner event stream ended without a terminal event".into())
}

#[tauri::command]
pub async fn start_pso_warmup(
    app: AppHandle,
    db: State<'_, Db>,
    registry: State<'_, UeJobRegistry>,
    request: StartPsoWarmupRequest,
) -> VoloResult<PsoWarmupJobResponse> {
    let mut target_ids = request.target_machine_ids.clone();
    target_ids.sort_unstable();
    target_ids.dedup();
    if target_ids.is_empty() {
        return Err(VoloError::InvalidInput("no target machines".into()));
    }
    if request.max_minutes == 0 {
        // 0 disarms the watchdog — the only mechanism that ever ends a -game run.
        return Err(VoloError::InvalidInput("max_minutes must be >= 1".into()));
    }
    if request.verify_minutes == 0 {
        return Err(VoloError::InvalidInput("verify_minutes must be >= 1".into()));
    }

    let preferred_ue =
        resolve_warmup_ue_version(&db, request.project_id, request.ue_version.as_deref())?;

    // Validate ALL targets up front — reject the whole request on any gap so a
    // partial fan-out never leaves half the farm silently unwarmed.
    struct Target {
        machine_id: i64,
        ip: String,
        engine_path: String,
        uproject_path: String,
    }
    let mut targets = Vec::with_capacity(target_ids.len());
    for machine_id in &target_ids {
        let machine = data_machines::find_by_id(&db, *machine_id)?
            .ok_or_else(|| VoloError::InvalidInput(format!("machine {} not found", machine_id)))?;
        let location =
            project_locations::get_for_project_machine(&db, request.project_id, *machine_id)?
                .ok_or_else(|| {
                    VoloError::InvalidInput(format!(
                        "project {} not located on machine {}",
                        request.project_id, machine_id
                    ))
                })?;
        let engine_path = resolve_engine_path(&db, *machine_id, preferred_ue.as_deref())?;
        targets.push(Target {
            machine_id: *machine_id,
            ip: machine.ip,
            engine_path,
            uproject_path: location.uproject_path,
        });
    }

    let parent_job_id = format!("pso-warmup-{}-{}", request.project_id, now_millis());
    let resolution = (request.resolution_w.max(1), request.resolution_h.max(1));
    let dc_cfg_path = normalize_optional(request.dc_cfg_path.as_deref());
    let dc_node = normalize_optional(request.dc_node.as_deref());
    let extra_args = normalize_extra_args(&request.extra_args);
    let specs: Vec<PsoWarmupSpec> = targets
        .iter()
        .map(|target| PsoWarmupSpec {
            project_id: request.project_id,
            machine_id: target.machine_id,
            resolution,
            max_minutes: request.max_minutes,
            dc_cfg_path: dc_cfg_path.clone(),
            dc_node: dc_node.clone(),
            offscreen: request.offscreen,
            extra_args: extra_args.clone(),
        })
        .collect();
    for spec in &specs {
        pso_warmup::validate_warmup_spec(spec)?;
    }
    if let Some(traversal) = &request.traversal {
        for target in &targets {
            pso_traversal::validate_traversal_spec(&traversal.to_spec(&target.ip))?;
        }
    }
    preflight_dc_cfg(
        targets
            .iter()
            .map(|t| (t.machine_id, t.ip.clone()))
            .collect(),
        dc_cfg_path.clone().unwrap_or_default(),
    )
    .await?;

    // Persist ALL run rows before launching anything: a mid-loop DB failure
    // must never leave already-launched nodes running untracked.
    let mut run_ids = Vec::with_capacity(targets.len());
    for (target, spec) in targets.iter().zip(&specs) {
        run_ids.push(pso_warmup_runs::insert_started(
            &db,
            request.project_id,
            target.machine_id,
            resolution,
            request.max_minutes,
            spec.mode(),
            spec.dc_node.as_deref(),
            request.traversal.is_some(),
        )?);
    }

    let verify_minutes = request.verify_minutes;
    let mut launched = Vec::with_capacity(targets.len());
    for ((target, run_id), spec) in targets.into_iter().zip(run_ids).zip(specs) {
        let handle = pso_warmup::launch_warmup(
            UeRunnerBackend::Remote,
            &target.ip,
            &target.engine_path,
            &target.uproject_path,
            &spec,
        )?;

        let job_id = format!("pso-warmup-{}-{}", target.machine_id, now_millis());
        registry.insert(&job_id, handle.cancel.clone()).await;
        pso_warmup::spawn_watchdog(handle.cancel.clone(), request.max_minutes, job_id.clone());

        let prerun_cancel = handle.cancel.clone();
        let mut events = handle.events;
        let app_for_task = app.clone();
        let db_for_task: Db = (*db).clone();
        let parent_for_task = parent_job_id.clone();
        let job_id_for_task = job_id.clone();
        let machine_id = target.machine_id;
        let project_id = request.project_id;
        let ip_for_task = target.ip.clone();
        let engine_for_task = target.engine_path.clone();
        let uproject_for_task = target.uproject_path.clone();
        let spec_for_task = spec.clone();
        let traversal_for_task = request.traversal.clone();

        tokio::spawn(async move {
            let started = std::time::Instant::now();
            let mut prerun_hitches: i64 = 0;
            let mut verify_hitches: i64 = 0;

            // 遍历（可选）：与预跑段并行驱动舞台；收敛会置 watchdog 位提前
            // 结束预跑段（读作计划内完成）。
            let mut prerun_shared: Option<Arc<AtomicI64>> = None;
            let mut prerun_traversal = None;
            if let Some(req) = &traversal_for_task {
                let counter = Arc::new(AtomicI64::new(0));
                let handle = pso_traversal::spawn_traversal(
                    req.to_spec(&ip_for_task),
                    counter.clone(),
                    prerun_cancel.clone(),
                );
                spawn_traversal_emitter(
                    handle.events,
                    app_for_task.clone(),
                    machine_id,
                    project_id,
                    run_id,
                    "prerun",
                    parent_for_task.clone(),
                    job_id_for_task.clone(),
                );
                prerun_shared = Some(counter);
                prerun_traversal = Some((handle.stop, handle.join));
            }

            let prerun_end = drive_warmup_phase(
                &mut events,
                &prerun_cancel,
                &app_for_task,
                &job_id_for_task,
                &parent_for_task,
                machine_id,
                project_id,
                run_id,
                "prerun",
                &mut prerun_hitches,
                prerun_shared.as_ref(),
            )
            .await;

            if let Some((stop, join)) = prerun_traversal {
                stop.store(true, Ordering::Relaxed);
                match join.await {
                    Ok(outcome) => {
                        if let Err(err) = pso_warmup_runs::record_convergence(
                            &db_for_task,
                            run_id,
                            outcome.converged,
                        ) {
                            tracing::error!(?err, run_id, "pso traversal convergence persist failed");
                        }
                    }
                    Err(err) => tracing::error!(?err, run_id, "pso traversal task join failed"),
                }
            }

            // Phase 2: the prerun window completing hands over to a verify run
            // with the same spec — its hitch count is the green-light basis.
            let (ended_phase, status, error_message, verify_ran) = match prerun_end {
                WarmupPhaseEnd::Cancelled => ("prerun", WarmupStatus::Cancelled, None, false),
                WarmupPhaseEnd::Error(msg) => ("prerun", WarmupStatus::Err, Some(msg), false),
                WarmupPhaseEnd::Completed => {
                    match pso_warmup::launch_warmup(
                        UeRunnerBackend::Remote,
                        &ip_for_task,
                        &engine_for_task,
                        &uproject_for_task,
                        &spec_for_task,
                    ) {
                        Err(err) => (
                            "prerun",
                            WarmupStatus::Err,
                            Some(format!("verify phase launch failed: {err}")),
                            false,
                        ),
                        Ok(verify_handle) => {
                            // Same job_id: an operator cancel keeps working
                            // across the phase handover.
                            app_for_task
                                .state::<UeJobRegistry>()
                                .insert(&job_id_for_task, verify_handle.cancel.clone())
                                .await;
                            pso_warmup::spawn_watchdog(
                                verify_handle.cancel.clone(),
                                verify_minutes,
                                job_id_for_task.clone(),
                            );
                            let verify_started = std::time::Instant::now();
                            let verify_cancel = verify_handle.cancel.clone();
                            let mut verify_events = verify_handle.events;
                            // 验证段同样遍历：hitch=0 的绿灯必须在覆盖扫场
                            // 条件下成立，而不是只盯固定机位。
                            let mut verify_shared: Option<Arc<AtomicI64>> = None;
                            let mut verify_traversal = None;
                            if let Some(req) = &traversal_for_task {
                                let counter = Arc::new(AtomicI64::new(0));
                                let handle = pso_traversal::spawn_traversal(
                                    req.to_spec(&ip_for_task),
                                    counter.clone(),
                                    verify_cancel.clone(),
                                );
                                spawn_traversal_emitter(
                                    handle.events,
                                    app_for_task.clone(),
                                    machine_id,
                                    project_id,
                                    run_id,
                                    "verify",
                                    parent_for_task.clone(),
                                    job_id_for_task.clone(),
                                );
                                verify_shared = Some(counter);
                                verify_traversal = Some((handle.stop, handle.join));
                            }
                            let verify_end = drive_warmup_phase(
                                &mut verify_events,
                                &verify_cancel,
                                &app_for_task,
                                &job_id_for_task,
                                &parent_for_task,
                                machine_id,
                                project_id,
                                run_id,
                                "verify",
                                &mut verify_hitches,
                                verify_shared.as_ref(),
                            )
                            .await;
                            if let Some((stop, join)) = verify_traversal {
                                stop.store(true, Ordering::Relaxed);
                                let _ = join.await;
                            }
                            if let Err(err) = pso_warmup_runs::record_verify_phase(
                                &db_for_task,
                                run_id,
                                verify_hitches,
                                verify_started.elapsed().as_secs() as i64,
                            ) {
                                tracing::error!(?err, run_id, "pso warmup verify persist failed");
                            }
                            match verify_end {
                                WarmupPhaseEnd::Cancelled => {
                                    ("verify", WarmupStatus::Cancelled, None, true)
                                }
                                WarmupPhaseEnd::Error(msg) => {
                                    ("verify", WarmupStatus::Err, Some(msg), true)
                                }
                                WarmupPhaseEnd::Completed => (
                                    "verify",
                                    pso_warmup::verify_outcome(verify_hitches),
                                    None,
                                    true,
                                ),
                            }
                        }
                    }
                }
            };

            let duration_secs = started.elapsed().as_secs() as i64;
            // Cancelled/NotReady keep the (partial-window) hitch count as
            // info; green-light eligibility lives in the status alone.
            let persisted_hitches = matches!(
                status,
                WarmupStatus::Ok | WarmupStatus::Cancelled | WarmupStatus::NotReady
            )
            .then_some(prerun_hitches);
            if let Err(err) = pso_warmup_runs::finish(
                &db_for_task,
                run_id,
                status,
                persisted_hitches,
                error_message.as_deref(),
                duration_secs,
                None,
            ) {
                tracing::error!(?err, run_id, "pso warmup finish persist failed");
            }
            let _ = app_for_task.emit(
                "pso-warmup-finalized",
                WarmupFinalizedPayload {
                    job_id: &job_id_for_task,
                    parent_job_id: &parent_for_task,
                    machine_id,
                    project_id,
                    run_id,
                    phase: ended_phase,
                    hitch_count: persisted_hitches,
                    verify_hitch_count: verify_ran.then_some(verify_hitches),
                    status: status.as_str(),
                    error_message,
                },
            );
            app_for_task
                .state::<UeJobRegistry>()
                .remove(&job_id_for_task)
                .await;
        });

        launched.push(PsoWarmupLaunched {
            machine_id: target.machine_id,
            run_id,
            job_id,
        });
    }

    Ok(PsoWarmupJobResponse {
        job_id: parent_job_id,
        runs: launched,
    })
}

#[tauri::command]
pub async fn start_pso_coldtest(
    app: AppHandle,
    db: State<'_, Db>,
    registry: State<'_, UeJobRegistry>,
    request: StartPsoColdtestRequest,
) -> VoloResult<PsoColdtestJobResponse> {
    let mut target_ids = request.target_machine_ids.clone();
    target_ids.sort_unstable();
    target_ids.dedup();
    if target_ids.is_empty() {
        return Err(VoloError::InvalidInput("no target machines".into()));
    }
    if request.max_minutes == 0 {
        return Err(VoloError::InvalidInput("max_minutes must be >= 1".into()));
    }

    let preferred_ue =
        resolve_warmup_ue_version(&db, request.project_id, request.ue_version.as_deref())?;

    struct Target {
        machine_id: i64,
        ip: String,
        engine_path: String,
        uproject_path: String,
    }
    let mut targets = Vec::with_capacity(target_ids.len());
    for machine_id in &target_ids {
        let machine = data_machines::find_by_id(&db, *machine_id)?
            .ok_or_else(|| VoloError::InvalidInput(format!("machine {} not found", machine_id)))?;
        let location =
            project_locations::get_for_project_machine(&db, request.project_id, *machine_id)?
                .ok_or_else(|| {
                    VoloError::InvalidInput(format!(
                        "project {} not located on machine {}",
                        request.project_id, machine_id
                    ))
                })?;
        let engine_path = resolve_engine_path(&db, *machine_id, preferred_ue.as_deref())?;
        targets.push(Target {
            machine_id: *machine_id,
            ip: machine.ip,
            engine_path,
            uproject_path: location.uproject_path,
        });
    }

    let parent_job_id = format!("pso-coldtest-{}-{}", request.project_id, now_millis());
    let resolution = (request.resolution_w.max(1), request.resolution_h.max(1));
    let dc_cfg_path = normalize_optional(request.dc_cfg_path.as_deref());
    let dc_node = normalize_optional(request.dc_node.as_deref());
    let extra_args = normalize_extra_args(&request.extra_args);
    let specs: Vec<PsoWarmupSpec> = targets
        .iter()
        .map(|target| PsoWarmupSpec {
            project_id: request.project_id,
            machine_id: target.machine_id,
            resolution,
            max_minutes: request.max_minutes,
            dc_cfg_path: dc_cfg_path.clone(),
            dc_node: dc_node.clone(),
            offscreen: request.offscreen,
            extra_args: extra_args.clone(),
        })
        .collect();
    for spec in &specs {
        pso_warmup::validate_warmup_spec(spec)?;
    }
    if let Some(traversal) = &request.traversal {
        for target in &targets {
            pso_traversal::validate_traversal_spec(&traversal.to_spec(&target.ip))?;
        }
    }
    preflight_dc_cfg(
        targets
            .iter()
            .map(|t| (t.machine_id, t.ip.clone()))
            .collect(),
        dc_cfg_path.clone().unwrap_or_default(),
    )
    .await?;

    let mut run_ids = Vec::with_capacity(targets.len());
    for (target, spec) in targets.iter().zip(&specs) {
        run_ids.push(pso_warmup_runs::insert_started(
            &db,
            request.project_id,
            target.machine_id,
            resolution,
            request.max_minutes,
            pso_coldtest::COLDTEST_MODE,
            spec.dc_node.as_deref(),
            false,
        )?);
    }

    let mut launched = Vec::with_capacity(targets.len());
    for ((target, run_id), spec) in targets.into_iter().zip(run_ids).zip(specs) {
        let clear_started = std::time::Instant::now();
        let host_for_clear = target.ip.clone();
        let clear_decision = tokio::task::spawn_blocking(move || {
            pso_coldtest::clear_and_decide(&host_for_clear)
        })
        .await
        .map_err(|err| VoloError::OperationFailed(format!("driver cache clear join: {err}")))??;

        if !clear_decision.can_run {
            let message = clear_decision.error_message.clone().unwrap_or_else(|| {
                "driver cache clear residual exceeds coldtest threshold".into()
            });
            if let Err(err) = pso_warmup_runs::finish(
                &db,
                run_id,
                WarmupStatus::Err,
                None,
                Some(&message),
                clear_started.elapsed().as_secs() as i64,
                None,
            ) {
                tracing::error!(?err, run_id, "pso coldtest clear failure persist failed");
            }
            launched.push(PsoColdtestLaunched {
                machine_id: target.machine_id,
                run_id,
                job_id: None,
                clear_result: Some(clear_decision.clear_result),
                error_message: Some(message),
            });
            continue;
        }

        let handle = match pso_coldtest::launch_coldtest_run(
            UeRunnerBackend::Remote,
            &target.ip,
            &target.engine_path,
            &target.uproject_path,
            &spec,
        ) {
            Ok(handle) => handle,
            Err(err) => {
                let message = format!("coldtest launch failed: {err}");
                if let Err(persist_err) = pso_warmup_runs::finish(
                    &db,
                    run_id,
                    WarmupStatus::Err,
                    None,
                    Some(&message),
                    clear_started.elapsed().as_secs() as i64,
                    None,
                ) {
                    tracing::error!(
                        ?persist_err,
                        run_id,
                        "pso coldtest launch failure persist failed"
                    );
                }
                launched.push(PsoColdtestLaunched {
                    machine_id: target.machine_id,
                    run_id,
                    job_id: None,
                    clear_result: Some(clear_decision.clear_result),
                    error_message: Some(message),
                });
                continue;
            }
        };

        let job_id = format!("pso-coldtest-{}-{}", target.machine_id, now_millis());
        registry.insert(&job_id, handle.cancel.clone()).await;
        pso_warmup::spawn_watchdog(handle.cancel.clone(), request.max_minutes, job_id.clone());

        let cancel_for_task = handle.cancel.clone();
        let mut events = handle.events;
        let app_for_task = app.clone();
        let db_for_task: Db = (*db).clone();
        let parent_for_task = parent_job_id.clone();
        let job_id_for_task = job_id.clone();
        let machine_id = target.machine_id;
        let project_id = request.project_id;
        let host_for_task = target.ip.clone();
        let clear_result_for_task = clear_decision.clear_result.clone();
        let clear_after_bytes = clear_decision.clear_result.after_bytes;

        tokio::spawn(async move {
            let started = std::time::Instant::now();
            let mut hitch_count: i64 = 0;

            #[derive(Clone, Serialize)]
            struct ProgressPayload<'a> {
                job_id: &'a str,
                parent_job_id: &'a str,
                machine_id: i64,
                project_id: i64,
                run_id: i64,
                hitch_count: i64,
                clear_result: &'a driver_cache_clear::DriverCacheClearResult,
                event: &'a UeRunnerEvent,
            }
            #[derive(Clone, Serialize)]
            struct FinalizedPayload<'a> {
                job_id: &'a str,
                parent_job_id: &'a str,
                machine_id: i64,
                project_id: i64,
                run_id: i64,
                hitch_count: Option<i64>,
                driver_cache_growth_bytes: Option<i64>,
                status: &'a str,
                error_message: Option<String>,
                clear_result: &'a driver_cache_clear::DriverCacheClearResult,
            }

            while let Some(event) = events.recv().await {
                if let UeRunnerEvent::LogLine { text, .. } = &event {
                    if pso_warmup::is_hitch_line(text) {
                        hitch_count += 1;
                    }
                }
                let _ = app_for_task.emit(
                    "pso-coldtest-progress",
                    ProgressPayload {
                        job_id: &job_id_for_task,
                        parent_job_id: &parent_for_task,
                        machine_id,
                        project_id,
                        run_id,
                        hitch_count,
                        clear_result: &clear_result_for_task,
                        event: &event,
                    },
                );

                let (done, status, error_message) = match &event {
                    UeRunnerEvent::Completed { exit_code, .. } => {
                        if *exit_code == 0 {
                            (true, WarmupStatus::Ok, None)
                        } else {
                            (
                                true,
                                WarmupStatus::Err,
                                Some(format!("UE exited with code {}", exit_code)),
                            )
                        }
                    }
                    UeRunnerEvent::Cancelled => {
                        if cancel_for_task.lock().await.watchdog {
                            (true, WarmupStatus::Ok, None)
                        } else {
                            (true, WarmupStatus::Cancelled, None)
                        }
                    }
                    UeRunnerEvent::Error { message } => {
                        (true, WarmupStatus::Err, Some(message.clone()))
                    }
                    _ => (false, WarmupStatus::Running, None),
                };
                if !done {
                    continue;
                }

                let duration_secs = started.elapsed().as_secs() as i64;
                let mut final_status = status;
                let mut final_error_message = error_message;
                let mut driver_cache_growth_bytes = None;
                if matches!(final_status, WarmupStatus::Ok) {
                    let host_for_probe = host_for_task.clone();
                    let probe_result =
                        tokio::task::spawn_blocking(move || driver_cache_probe::probe(&host_for_probe))
                            .await;
                    match probe_result {
                        Ok(Ok(probe)) => {
                            let after_run_bytes = probe.total_bytes;
                            match driver_cache_snapshot_input(machine_id, probe) {
                                Ok(input) => {
                                    driver_cache_growth_bytes = Some(
                                        pso_coldtest::driver_cache_growth_bytes(
                                            clear_after_bytes,
                                            after_run_bytes,
                                        ),
                                    );
                                    if let Err(err) =
                                        driver_cache_snapshots::insert(&db_for_task, &input)
                                    {
                                        final_status = WarmupStatus::Err;
                                        final_error_message = Some(format!(
                                            "driver cache snapshot persist failed: {err}"
                                        ));
                                    }
                                }
                                Err(err) => {
                                    final_status = WarmupStatus::Err;
                                    final_error_message = Some(format!(
                                        "driver cache verification failed: {err}"
                                    ));
                                }
                            }
                        }
                        Ok(Err(err)) => {
                            final_status = WarmupStatus::Err;
                            final_error_message =
                                Some(format!("driver cache verification failed: {err}"));
                        }
                        Err(err) => {
                            final_status = WarmupStatus::Err;
                            final_error_message =
                                Some(format!("driver cache verification join failed: {err}"));
                        }
                    }
                }
                let persisted_hitches =
                    matches!(final_status, WarmupStatus::Ok | WarmupStatus::Cancelled)
                        .then_some(hitch_count);
                if let Err(err) = pso_warmup_runs::finish(
                    &db_for_task,
                    run_id,
                    final_status,
                    persisted_hitches,
                    final_error_message.as_deref(),
                    duration_secs,
                    driver_cache_growth_bytes,
                ) {
                    tracing::error!(?err, run_id, "pso coldtest finish persist failed");
                }
                let _ = app_for_task.emit(
                    "pso-coldtest-finalized",
                    FinalizedPayload {
                        job_id: &job_id_for_task,
                        parent_job_id: &parent_for_task,
                        machine_id,
                        project_id,
                        run_id,
                        hitch_count: persisted_hitches,
                        driver_cache_growth_bytes,
                        status: final_status.as_str(),
                        error_message: final_error_message,
                        clear_result: &clear_result_for_task,
                    },
                );
                app_for_task
                    .state::<UeJobRegistry>()
                    .remove(&job_id_for_task)
                    .await;
                break;
            }
        });

        launched.push(PsoColdtestLaunched {
            machine_id: target.machine_id,
            run_id,
            job_id: Some(job_id),
            clear_result: Some(clear_decision.clear_result),
            error_message: None,
        });
    }

    Ok(PsoColdtestJobResponse {
        job_id: parent_job_id,
        runs: launched,
    })
}

#[tauri::command]
pub fn list_pso_warmup_runs(
    db: State<'_, Db>,
    project_id: i64,
    machine_id: Option<i64>,
) -> VoloResult<Vec<PsoWarmupRun>> {
    // Lazy reaper: rows stuck 'running' past their planned window mean the
    // supervising process died — reap on read so they never look in-flight.
    let _ = pso_warmup_runs::reap_overdue(&db);
    pso_warmup_runs::list_by_project(&db, project_id, machine_id)
}

#[tauri::command]
pub fn list_pso_status(
    db: State<'_, Db>,
    project_id: i64,
    machine_ids: Option<Vec<i64>>,
) -> VoloResult<Vec<PsoStatusCell>> {
    pso_status::list_pso_status(&db, project_id, machine_ids)
}

#[tauri::command]
pub async fn clear_driver_cache(
    db: State<'_, Db>,
    machine_id: i64,
) -> VoloResult<driver_cache_clear::DriverCacheClearResult> {
    let machine = data_machines::find_by_id(&db, machine_id)?
        .ok_or_else(|| VoloError::InvalidInput(format!("machine {} not found", machine_id)))?;
    let host = machine.ip.clone();
    tokio::task::spawn_blocking(move || driver_cache_clear::clear(&host))
        .await
        .map_err(|err| VoloError::OperationFailed(format!("driver cache clear join: {err}")))?
}

#[tauri::command]
pub async fn probe_driver_cache(
    db: State<'_, Db>,
    machine_id: i64,
) -> VoloResult<DriverCacheSnapshot> {
    let machine = data_machines::find_by_id(&db, machine_id)?
        .ok_or_else(|| VoloError::InvalidInput(format!("machine {} not found", machine_id)))?;
    let host = machine.ip.clone();
    let probe = tokio::task::spawn_blocking(move || driver_cache_probe::probe(&host))
        .await
        .map_err(|err| VoloError::OperationFailed(format!("driver cache probe join: {err}")))??;
    let input = driver_cache_snapshot_input(machine_id, probe)?;
    driver_cache_snapshots::insert(&db, &input)
}

fn driver_cache_snapshot_input(
    machine_id: i64,
    probe: driver_cache_probe::DriverCacheProbe,
) -> VoloResult<driver_cache_snapshots::DriverCacheSnapshotInput> {
    let local = probe
        .directories
        .iter()
        .find(|dir| dir.kind == driver_cache_probe::local_dxcache_kind())
        .ok_or_else(|| {
            VoloError::OperationFailed("driver cache probe missing local DXCache".into())
        })?;
    let low = probe
        .directories
        .iter()
        .find(|dir| dir.kind == driver_cache_probe::low_dxcache_kind())
        .ok_or_else(|| {
            VoloError::OperationFailed("driver cache probe missing LocalLow DXCache".into())
        })?;
    Ok(driver_cache_snapshots::DriverCacheSnapshotInput {
        machine_id,
        gpu_model: probe.gpu_model,
        gpu_driver_version: probe.gpu_driver_version,
        interactive_user: probe.interactive_user,
        node_last_boot_time: probe.node_last_boot_time,
        local_appdata_dxcache: driver_cache_dir_to_data(local),
        locallow_per_driver_dxcache: driver_cache_dir_to_data(low),
        total_file_count: probe.total_file_count,
        total_bytes: probe.total_bytes,
        newest_mtime: probe.newest_mtime,
    })
}

fn driver_cache_dir_to_data(
    dir: &driver_cache_probe::DriverCacheDirectorySnapshot,
) -> driver_cache_snapshots::DriverCacheDirectorySnapshot {
    driver_cache_snapshots::DriverCacheDirectorySnapshot {
        kind: dir.kind.clone(),
        path: dir.path.clone(),
        exists: dir.exists,
        file_count: dir.file_count,
        total_bytes: dir.total_bytes,
        newest_mtime: dir.newest_mtime.clone(),
    }
}

/// 批量驱动缓存快照读取（无 SSH 往返，纯读库）：从未探测过的机器直接跳过，
/// 不用错误占位。供「配置巡检」/概览卡片一次性拉全量最新快照用。
#[tauri::command]
pub fn list_driver_cache_snapshots(
    db: State<'_, Db>,
    machine_ids: Vec<i64>,
) -> VoloResult<Vec<DriverCacheSnapshot>> {
    let mut out = Vec::with_capacity(machine_ids.len());
    for machine_id in machine_ids {
        if let Some(snapshot) = driver_cache_snapshots::latest_for_machine(&db, machine_id)? {
            out.push(snapshot);
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn get_pso_project_settings(
    db: State<'_, Db>,
    project_id: i64,
) -> VoloResult<Option<PsoProjectSettings>> {
    pso_project_settings::get(&db, project_id)
}

#[tauri::command]
pub fn set_pso_project_settings(
    db: State<'_, Db>,
    settings: PsoProjectSettings,
) -> VoloResult<PsoProjectSettings> {
    pso_project_settings::upsert(&db, &settings)
}

/// nDisplay 配置资产发现：见 `discover-ndisplay-assets.ps1`（*.ndisplay +
/// Content/nDisplay_*.uasset → Saved/Volo/ndisplay）。
#[tauri::command]
pub async fn discover_ndisplay_assets(
    db: State<'_, Db>,
    machine_id: i64,
    project_root: String,
) -> VoloResult<Vec<String>> {
    discover_on_machine(db, machine_id, project_root, pso_warmup::discover_ndisplay_assets, "ndisplay").await
}

/// 工程地图包发现：见 `discover-project-maps.ps1`（Content/**/*.umap → /Game/...）。
#[tauri::command]
pub async fn discover_project_maps(
    db: State<'_, Db>,
    machine_id: i64,
    project_root: String,
) -> VoloResult<Vec<String>> {
    discover_on_machine(db, machine_id, project_root, pso_warmup::discover_project_maps, "project map").await
}

async fn discover_on_machine(
    db: State<'_, Db>,
    machine_id: i64,
    project_root: String,
    discover: fn(&str, &str) -> VoloResult<Vec<String>>,
    join_label: &'static str,
) -> VoloResult<Vec<String>> {
    let machine = data_machines::find_by_id(&db, machine_id)?
        .ok_or_else(|| VoloError::InvalidInput(format!("machine {} not found", machine_id)))?;
    let host = machine.ip.clone();
    tokio::task::spawn_blocking(move || discover(&host, &project_root))
        .await
        .map_err(|err| {
            VoloError::OperationFailed(format!("{join_label} discovery join: {err}"))
        })?
}

#[derive(Debug, Clone, Serialize)]
pub struct PsoConfigPreflightResult {
    pub machine_id: i64,
    pub exists: bool,
}

/// 预跑配置巡检：逐机检查 dc_cfg_path 是否存在，单台 SSH 失败只记 exists=false
/// 并继续，不让整单命令失败（与 all-or-nothing 的 preflight_dc_cfg 区分开，
/// 后者是真正发起预跑前的拒绝闸；这个是「配置巡检」卡片/保存前校验用的只读探测）。
#[tauri::command]
pub async fn check_pso_config_preflight(
    db: State<'_, Db>,
    machine_ids: Vec<i64>,
    dc_cfg_path: String,
) -> VoloResult<Vec<PsoConfigPreflightResult>> {
    let mut checks = Vec::with_capacity(machine_ids.len());
    for machine_id in machine_ids {
        let machine = data_machines::find_by_id(&db, machine_id)?
            .ok_or_else(|| VoloError::InvalidInput(format!("machine {} not found", machine_id)))?;
        checks.push((machine_id, machine.ip));
    }
    tokio::task::spawn_blocking(move || {
        checks
            .into_iter()
            .map(|(machine_id, ip)| PsoConfigPreflightResult {
                machine_id,
                exists: pso_warmup::check_dc_cfg_exists(&ip, &dc_cfg_path).unwrap_or(false),
            })
            .collect()
    })
    .await
    .map_err(|err| VoloError::OperationFailed(format!("pso config preflight join: {err}")))
}

