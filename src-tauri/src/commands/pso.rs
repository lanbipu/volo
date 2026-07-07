//! Tauri commands for PSO cache collection and distribution.

use crate::commands::ddc_pak::UeJobRegistry;
use cache_core::core::{
    batch, driver_cache_clear, driver_cache_probe, ini_editor, pso_coldtest,
    pso_collect::{self, PsoCollectSpec},
    pso_distribute::{self, PsoDistributePlanItem},
    pso_status::{self, PsoStatusCell},
    pso_warmup::{self, PsoWarmupSpec},
    ue_runner::{RunnerCancel, UeRunnerBackend, UeRunnerEvent},
};
use cache_core::data::{
    driver_cache_snapshots, machine_ue_installs, machines as data_machines, project_locations,
    pso_cache_files, pso_distributions, pso_warmup_runs, Db, DistributionStatus,
    DriverCacheSnapshot, PsoCacheFile, PsoDistribution, PsoWarmupRun, WarmupStatus,
};
use cache_core::error::{VoloError, VoloResult};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Debug, Serialize)]
pub struct PsoCollectJobResponse {
    pub job_id: String,
    pub source_machine_id: i64,
    pub project_id: i64,
}

#[derive(Debug, Serialize)]
pub struct PsoDistributeJobResponse {
    pub job_id: String,
    pub plan: Vec<PsoDistributePlanItem>,
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
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
        let install = installs
            .into_iter()
            .find(|install| install.version == version)
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

#[tauri::command]
pub async fn start_pso_collection(
    app: AppHandle,
    db: State<'_, Db>,
    registry: State<'_, UeJobRegistry>,
    source_machine_id: i64,
    project_id: i64,
    ue_version: Option<String>,
    resolution_w: u32,
    resolution_h: u32,
    windowed: bool,
    max_minutes: u32,
    operator_credential_alias: Option<String>,
) -> VoloResult<PsoCollectJobResponse> {
    let machine = data_machines::find_by_id(&db, source_machine_id)?.ok_or_else(|| {
        VoloError::InvalidInput(format!("machine {} not found", source_machine_id))
    })?;
    let location = project_locations::get_for_project_machine(&db, project_id, source_machine_id)?
        .ok_or_else(|| {
            VoloError::InvalidInput(format!(
                "project {} not located on machine {}",
                project_id, source_machine_id
            ))
        })?;
    let engine_path = resolve_engine_path(&db, source_machine_id, ue_version.as_deref())?;
    // SSH key auth: operator cred no longer used (param kept as shim, Vue compat).
    let _ = &operator_credential_alias;
    let (operator_user, operator_pass): (Option<String>, Option<String>) = (None, None);

    let spec = PsoCollectSpec {
        project_id,
        source_machine_id,
        ue_version: ue_version.clone(),
        resolution: (resolution_w.max(1), resolution_h.max(1)),
        windowed,
        max_minutes,
    };
    let handle = pso_collect::launch_collection(
        UeRunnerBackend::Remote,
        &machine.ip,
        &engine_path,
        &location.uproject_path,
        &spec,
        operator_user.as_deref(),
        operator_pass.as_deref(),
    );

    let job_id = format!("pso-collect-{}-{}", source_machine_id, now_millis());
    registry.insert(&job_id, handle.cancel.clone()).await;
    pso_collect::spawn_watchdog(handle.cancel.clone(), max_minutes, job_id.clone());

    let mut events = handle.events;
    let app_for_task = app.clone();
    let db_for_task: Db = (*db).clone();
    let job_id_for_task = job_id.clone();
    let source_machine_ip = machine.ip.clone();
    let project_dir = location.abs_path.clone();
    let user_for_task = operator_user.clone();
    let pass_for_task = operator_pass.clone();
    let ue_version_for_task = ue_version.clone();

    tokio::spawn(async move {
        while let Some(event) = events.recv().await {
            #[derive(Clone, Serialize)]
            struct ProgressPayload<'a> {
                job_id: &'a str,
                source_machine_id: i64,
                project_id: i64,
                event: &'a UeRunnerEvent,
            }
            let _ = app_for_task.emit(
                "ue-runner-progress",
                ProgressPayload {
                    job_id: &job_id_for_task,
                    source_machine_id,
                    project_id,
                    event: &event,
                },
            );

            match &event {
                UeRunnerEvent::Completed { .. } | UeRunnerEvent::Cancelled => {
                    #[derive(Clone, Serialize)]
                    struct FinalizedPayload<'a> {
                        job_id: &'a str,
                        source_machine_id: i64,
                        project_id: i64,
                        files_collected: Option<usize>,
                        error_message: Option<String>,
                    }

                    match pso_collect::enumerate_remote(
                        &source_machine_ip,
                        &project_dir,
                        user_for_task.as_deref(),
                        pass_for_task.as_deref(),
                    ) {
                        Ok(files) => match pso_collect::finalize_persist(
                            &db_for_task,
                            project_id,
                            source_machine_id,
                            ue_version_for_task.as_deref(),
                            &files,
                        ) {
                            Ok(_) => {
                                let _ = app_for_task.emit(
                                    "pso-collect-finalized",
                                    FinalizedPayload {
                                        job_id: &job_id_for_task,
                                        source_machine_id,
                                        project_id,
                                        files_collected: Some(files.len()),
                                        error_message: None,
                                    },
                                );
                            }
                            Err(err) => {
                                tracing::error!(?err, "pso finalize_persist failed");
                                let _ = app_for_task.emit(
                                    "pso-collect-finalized",
                                    FinalizedPayload {
                                        job_id: &job_id_for_task,
                                        source_machine_id,
                                        project_id,
                                        files_collected: None,
                                        error_message: Some(format!("persist failed: {err}")),
                                    },
                                );
                            }
                        },
                        Err(err) => {
                            tracing::error!(?err, "pso enumerate_remote failed");
                            let _ = app_for_task.emit(
                                "pso-collect-finalized",
                                FinalizedPayload {
                                    job_id: &job_id_for_task,
                                    source_machine_id,
                                    project_id,
                                    files_collected: None,
                                    error_message: Some(format!("enumerate failed: {err}")),
                                },
                            );
                        }
                    }
                    app_for_task
                        .state::<UeJobRegistry>()
                        .remove(&job_id_for_task)
                        .await;
                    break;
                }
                UeRunnerEvent::Error { .. } => {
                    app_for_task
                        .state::<UeJobRegistry>()
                        .remove(&job_id_for_task)
                        .await;
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(PsoCollectJobResponse {
        job_id,
        source_machine_id,
        project_id,
    })
}

#[tauri::command]
pub fn list_pso_cache_files(
    db: State<'_, Db>,
    project_id: i64,
    source_machine_id: Option<i64>,
    gpu_signature: Option<String>,
) -> VoloResult<Vec<PsoCacheFile>> {
    let normalized_filter = gpu_signature
        .as_deref()
        .map(cache_core::core::gpu_consistency::normalize_signature_string);
    Ok(pso_cache_files::list_by_project(&db, project_id)?
        .into_iter()
        .filter(|file| {
            source_machine_id
                .map(|machine_id| file.source_machine_id == machine_id)
                .unwrap_or(true)
        })
        .filter(|file| {
            normalized_filter
                .as_ref()
                .map(|filter| {
                    cache_core::core::gpu_consistency::normalize_signature_string(
                        &file.gpu_signature,
                    ) == *filter
                })
                .unwrap_or(true)
        })
        .collect())
}

#[derive(Debug, Clone, Deserialize)]
pub struct DistributePsoCacheRequest {
    pub file_id: i64,
    pub target_machine_ids: Vec<i64>,
    pub named_share_unc: Option<String>,
    pub operator_credential_alias: Option<String>,
    pub source_smb_credential_alias: Option<String>,
    pub force_gpu_mismatch: bool,
}

#[tauri::command]
pub async fn distribute_pso_cache(
    app: AppHandle,
    db: State<'_, Db>,
    request: DistributePsoCacheRequest,
) -> VoloResult<PsoDistributeJobResponse> {
    let file = pso_cache_files::get(&db, request.file_id)?.ok_or_else(|| {
        VoloError::InvalidInput(format!("pso cache file {} not found", request.file_id))
    })?;
    let source_machine =
        data_machines::find_by_id(&db, file.source_machine_id)?.ok_or_else(|| {
            VoloError::InvalidInput(format!(
                "source machine {} not found",
                file.source_machine_id
            ))
        })?;
    // SSH key auth: operator cred no longer used (param kept as shim, Vue compat).
    let _ = &request.operator_credential_alias;
    // Default transport: SSH push (no share/SMB involved). The legacy SMB pull
    // path below stays as an explicit escape hatch (named_share_unc / alias) —
    // see docs/changes/2026-07-05-ssh-push-distribute-plan.md.
    let push_mode =
        request.named_share_unc.is_none() && request.source_smb_credential_alias.is_none();

    if !request.force_gpu_mismatch {
        let matrix = cache_core::core::gpu_consistency::build_matrix(&db)?;
        for target_id in &request.target_machine_ids {
            let cell = matrix
                .cells
                .iter()
                .find(|cell| cell.machine_id == *target_id);
            let Some(signature) = cell.and_then(|cell| cell.signature.as_ref()) else {
                return Err(VoloError::InvalidInput(format!(
                    "target machine {} has unknown GPU signature; refresh inventory or force",
                    target_id
                )));
            };
            if cache_core::core::gpu_consistency::normalize_signature_string(&signature.as_string())
                != cache_core::core::gpu_consistency::normalize_signature_string(
                    &file.gpu_signature,
                )
            {
                return Err(VoloError::InvalidInput(format!(
                    "target machine {} GPU signature {} does not match file signature {}",
                    target_id,
                    signature.as_string(),
                    file.gpu_signature
                )));
            }
        }
    }

    let job_id = format!("pso-dist-{}-{}", request.file_id, now_millis());

    let plan = if push_mode {
        cache_core::core::push_distribute::plan_push(
            &db,
            file.source_machine_id,
            &source_machine.ip,
            &request.target_machine_ids,
            file.project_id,
            "Saved\\CollectedPSOs",
            &file.file_name,
        )?
    } else {
        // Legacy SMB pull: resolve the source share + cred from the SecretStore
        // (explicit alias, else auto-derived from a share covering the source
        // project dir).
        let source_location = cache_core::data::project_locations::get_for_project_machine(
            &db,
            file.project_id,
            file.source_machine_id,
        )?
        .ok_or_else(|| VoloError::InvalidInput("source project location missing".into()))?;
        let smb = cache_core::core::pak_distribute::resolve_source_smb(
            &db,
            file.source_machine_id,
            request.source_smb_credential_alias.as_deref(),
            true,
            &source_location.abs_path,
        )?;
        let named_unc = request
            .named_share_unc
            .clone()
            .or(smb.named_share_unc.clone());
        pso_distribute::plan(
            &db,
            &source_machine.ip,
            &file,
            &request.target_machine_ids,
            named_unc.as_deref(),
            smb.user,
            smb.pass,
        )?
    };
    if plan.is_empty() {
        return Err(VoloError::InvalidInput(
            "distribution plan has no non-source targets".into(),
        ));
    }
    for item in &plan {
        if push_mode {
            let item_for_preflight = item.clone();
            let job_for_preflight = job_id.clone();
            tokio::task::spawn_blocking(move || {
                cache_core::core::push_distribute::preflight_push_one(
                    &item_for_preflight,
                    &job_for_preflight,
                )
            })
            .await
            .map_err(|e| VoloError::OperationFailed(format!("preflight task failed: {e}")))?
            .map_err(|err| {
                VoloError::OperationFailed(format!(
                    "target {} push preflight failed: {}",
                    item.target_machine_id, err
                ))
            })?;
        } else {
            pso_distribute::preflight_one(item).await.map_err(|err| {
                VoloError::OperationFailed(format!(
                    "target {} cannot reach source UNC: {}",
                    item.target_machine_id, err
                ))
            })?;
        }
    }
    let plan_for_task = Arc::new(plan.clone());
    let app_for_task = app.clone();
    let db_for_task: Db = (*db).clone();
    let file_id = request.file_id;
    let project_id = file.project_id;
    let source_machine_id = file.source_machine_id;
    let job_id_for_task = job_id.clone();
    let source_host_for_task = source_machine.ip.clone();
    let source_path_for_task = file.file_path.clone();

    tokio::spawn(async move {
        #[derive(Clone, Serialize)]
        struct Payload<'a> {
            job_id: &'a str,
            project_id: i64,
            source_machine_id: i64,
            event: batch::BatchEvent,
        }

        // Push mode: resolve the source file onto the operator before fanning
        // out (loopback source: instant; remote source: stage + scp pull).
        let push_source = if push_mode {
            let job = job_id_for_task.clone();
            let host = source_host_for_task.clone();
            let path = source_path_for_task.clone();
            let acquired = tokio::task::spawn_blocking(move || {
                cache_core::core::push_distribute::acquire_source(&host, &path, &job)
            })
            .await
            .map_err(|e| VoloError::OperationFailed(format!("acquire task failed: {e}")))
            .and_then(|r| r);
            match acquired {
                Ok(source) => Some(Arc::new(source)),
                Err(err) => {
                    for item in plan_for_task.iter() {
                        upsert_distribution(
                            &db_for_task,
                            file_id,
                            item.target_machine_id,
                            DistributionStatus::Err,
                            0,
                            Some(format!("source acquire failed: {err}")),
                        );
                        let _ = app_for_task.emit(
                            "pso-distribute-progress",
                            Payload {
                                job_id: &job_id_for_task,
                                project_id,
                                source_machine_id,
                                event: batch::BatchEvent {
                                    machine_id: item.target_machine_id,
                                    status: batch::BatchStatus::Err,
                                    message: Some(format!("source acquire failed: {err}")),
                                },
                            },
                        );
                    }
                    return;
                }
            }
        } else {
            None
        };

        let machine_ids: Vec<i64> = plan_for_task
            .iter()
            .map(|item| item.target_machine_id)
            .collect();
        let plan_lookup = plan_for_task.clone();
        let db_lookup = db_for_task.clone();
        let source_for_batch = push_source.clone();
        let job_for_batch = job_id_for_task.clone();
        let mut rx = batch::run_batch(
            machine_ids,
            batch::DEFAULT_MAX_CONCURRENCY,
            move |machine_id| {
                let plan_lookup = plan_lookup.clone();
                let db_for_op = db_lookup.clone();
                let push_source = source_for_batch.clone();
                let job_id = job_for_batch.clone();
                async move {
                    upsert_distribution(
                        &db_for_op,
                        file_id,
                        machine_id,
                        DistributionStatus::Running,
                        0,
                        None,
                    );
                    let item = plan_lookup
                        .iter()
                        .find(|item| item.target_machine_id == machine_id)
                        .ok_or_else(|| {
                            VoloError::InvalidInput(format!(
                                "distribution plan missing machine {}",
                                machine_id
                            ))
                        })?
                        .clone();
                    let outcome = match push_source {
                        Some(source) => tokio::task::spawn_blocking(move || {
                            cache_core::core::push_distribute::push_one(&item, &source, &job_id)
                        })
                        .await
                        .map_err(|e| {
                            VoloError::OperationFailed(format!("push task failed: {e}"))
                        })??,
                        None => pso_distribute::run_one(item).await?,
                    };
                    if !outcome.ok {
                        let message = outcome
                            .message
                            .clone()
                            .unwrap_or_else(|| outcome.stdout_tail.clone());
                        upsert_distribution(
                            &db_for_op,
                            file_id,
                            machine_id,
                            DistributionStatus::Err,
                            outcome.bytes_copied,
                            Some(message.clone()),
                        );
                        return Err(VoloError::OperationFailed(format!(
                            "robocopy exit {}: {}",
                            outcome.exit_code, message
                        )));
                    }
                    upsert_distribution(
                        &db_for_op,
                        file_id,
                        machine_id,
                        DistributionStatus::Ok,
                        outcome.bytes_copied,
                        None,
                    );
                    Ok::<_, VoloError>(outcome)
                }
            },
        )
        .await;

        while let Some(event) = rx.recv().await {
            let _ = app_for_task.emit(
                "pso-distribute-progress",
                Payload {
                    job_id: &job_id_for_task,
                    project_id,
                    source_machine_id,
                    event,
                },
            );
        }
        if let Some(source) = push_source {
            source.cleanup();
        }
    });

    Ok(PsoDistributeJobResponse { job_id, plan })
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
    /// Pin the UE version used on every node; None = each node's primary
    /// install (risky when a node's primary differs from the project version).
    #[serde(default)]
    pub ue_version: Option<String>,
}

fn default_pso_offscreen() -> bool {
    true
}

fn default_pso_verify_minutes() -> u32 {
    pso_warmup::DEFAULT_VERIFY_MINUTES
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
) -> WarmupPhaseEnd {
    while let Some(event) = events.recv().await {
        if let UeRunnerEvent::LogLine { text, .. } = &event {
            if pso_warmup::is_hitch_line(text) {
                *hitch_count += 1;
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
        let engine_path = resolve_engine_path(&db, *machine_id, request.ue_version.as_deref())?;
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

        tokio::spawn(async move {
            let started = std::time::Instant::now();
            let mut prerun_hitches: i64 = 0;
            let mut verify_hitches: i64 = 0;

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
            )
            .await;

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
                            )
                            .await;
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
        let engine_path = resolve_engine_path(&db, *machine_id, request.ue_version.as_deref())?;
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

/// PSO precache CVars applied by "one-click fix" (same set as the deploy
/// workflow's SetPsoCvars step; R009 healthy value is Mode=0 / Full PSO).
const PSO_FIX_CVARS: [(&str, &str); 4] = [
    ("r.ShaderPipelineCache.Enabled", "1"),
    ("r.PSOPrecaching", "1"),
    ("r.PSOPrecache.GlobalShaders", "1"),
    ("r.PSOPrecache.Mode", "0"),
];

#[tauri::command]
pub async fn fix_pso_cvars(
    db: State<'_, Db>,
    project_id: i64,
    machine_id: i64,
) -> VoloResult<Vec<String>> {
    let machine = data_machines::find_by_id(&db, machine_id)?
        .ok_or_else(|| VoloError::InvalidInput(format!("machine {} not found", machine_id)))?;
    let location = project_locations::get_for_project_machine(&db, project_id, machine_id)?
        .ok_or_else(|| {
            VoloError::InvalidInput(format!(
                "project {} not located on machine {}",
                project_id, machine_id
            ))
        })?;
    // UE 5.8 source-verified (ConfigCacheIni.cpp::LoadConsoleVariablesFromINI):
    // the project-level file the engine actually loads CVars from is the
    // [ConsoleVariables] section of the GEngineIni hierarchy — i.e.
    // <Project>\Config\DefaultEngine.ini. A project ConsoleVariables.ini is
    // never read (only Engine/Config/ConsoleVariables.ini [Startup] is).
    let ini = format!(
        "{}\\Config\\DefaultEngine.ini",
        location.abs_path.trim_end_matches('\\')
    );
    // set_key_create is blocking SSH — keep it off the async runtime thread.
    let host = machine.ip;
    tokio::task::spawn_blocking(move || {
        let mut applied = Vec::with_capacity(PSO_FIX_CVARS.len());
        for (key, value) in PSO_FIX_CVARS {
            ini_editor::set_key_create(&host, &ini, "ConsoleVariables", key, value)?;
            applied.push(format!("{}={}", key, value));
        }
        Ok(applied)
    })
    .await
    .map_err(|err| VoloError::OperationFailed(format!("fix_pso_cvars task join: {err}")))?
}

fn upsert_distribution(
    db: &Db,
    file_id: i64,
    target_machine_id: i64,
    status: DistributionStatus,
    bytes_copied: i64,
    error_message: Option<String>,
) {
    let _ = pso_distributions::upsert(
        db,
        &PsoDistribution {
            id: None,
            pso_cache_file_id: file_id,
            target_machine_id,
            status,
            bytes_copied,
            distributed_at: (status == DistributionStatus::Ok)
                .then(|| chrono::Utc::now().to_rfc3339()),
            error_message,
            created_at: None,
        },
    );
}
