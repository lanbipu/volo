//! Tauri commands for PSO cache collection and distribution.

use crate::commands::ddc_pak::UeJobRegistry;
use cache_core::core::{
    batch,
    pso_collect::{self, PsoCollectSpec},
    pso_distribute::{self, PsoDistributePlanItem},
    ue_runner::{UeRunnerBackend, UeRunnerEvent},
};
use cache_core::data::{
    machine_ue_installs, machines as data_machines,
    project_locations, pso_cache_files, pso_distributions, Db, DistributionStatus, PsoCacheFile,
    PsoDistribution,
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
                    cache_core::core::gpu_consistency::normalize_signature_string(&file.gpu_signature)
                        == *filter
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
    let source_machine = data_machines::find_by_id(&db, file.source_machine_id)?.ok_or_else(|| {
        VoloError::InvalidInput(format!("source machine {} not found", file.source_machine_id))
    })?;
    // SSH key auth: operator cred no longer used (param kept as shim, Vue compat).
    let _ = &request.operator_credential_alias;
    // Source SMB access from the SecretStore: explicit alias, else auto-derived
    // from a Mode B share on the source host.
    // NOTE (sub-project B): the UI's share-credential dropdown must pass a
    // SecretStore/share alias here, not a DPAPI cred alias; `None` now means
    // "auto-derive", not "same as operator".
    let smb = cache_core::core::pak_distribute::resolve_source_smb(
        &db,
        file.source_machine_id,
        request.source_smb_credential_alias.as_deref(),
        true,
    )?;
    let (source_smb_user, source_smb_pass) = (smb.user, smb.pass);

    if !request.force_gpu_mismatch {
        let matrix = cache_core::core::gpu_consistency::build_matrix(&db)?;
        for target_id in &request.target_machine_ids {
            let cell = matrix.cells.iter().find(|cell| cell.machine_id == *target_id);
            let Some(signature) = cell.and_then(|cell| cell.signature.as_ref()) else {
                return Err(VoloError::InvalidInput(format!(
                    "target machine {} has unknown GPU signature; refresh inventory or force",
                    target_id
                )));
            };
            if cache_core::core::gpu_consistency::normalize_signature_string(&signature.as_string())
                != cache_core::core::gpu_consistency::normalize_signature_string(&file.gpu_signature)
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

    // Explicit request UNC wins; else the auto-derived managed-share UNC paired
    // with the SMB cred (so ddc-svc mounts the share it actually has rights to).
    let named_unc = request
        .named_share_unc
        .clone()
        .or(smb.named_share_unc.clone());
    let plan = pso_distribute::plan(
        &db,
        &source_machine.ip,
        &file,
        &request.target_machine_ids,
        named_unc.as_deref(),
        source_smb_user,
        source_smb_pass,
    )?;
    if plan.is_empty() {
        return Err(VoloError::InvalidInput(
            "distribution plan has no non-source targets".into(),
        ));
    }
    for item in &plan {
        pso_distribute::preflight_one(item).await.map_err(|err| {
            VoloError::OperationFailed(format!(
                "target {} cannot reach source UNC: {}",
                item.target_machine_id, err
            ))
        })?;
    }

    let job_id = format!("pso-dist-{}-{}", request.file_id, now_millis());
    let plan_for_task = Arc::new(plan.clone());
    let app_for_task = app.clone();
    let db_for_task: Db = (*db).clone();
    let file_id = request.file_id;
    let project_id = file.project_id;
    let source_machine_id = file.source_machine_id;
    let job_id_for_task = job_id.clone();

    tokio::spawn(async move {
        let machine_ids: Vec<i64> = plan_for_task
            .iter()
            .map(|item| item.target_machine_id)
            .collect();
        let plan_lookup = plan_for_task.clone();
        let db_lookup = db_for_task.clone();
        let mut rx = batch::run_batch(
            machine_ids,
            batch::DEFAULT_MAX_CONCURRENCY,
            move |machine_id| {
                let plan_lookup = plan_lookup.clone();
                let db_for_op = db_lookup.clone();
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
                    let outcome = pso_distribute::run_one(item).await?;
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
            #[derive(Clone, Serialize)]
            struct Payload<'a> {
                job_id: &'a str,
                project_id: i64,
                source_machine_id: i64,
                event: batch::BatchEvent,
            }
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
    });

    Ok(PsoDistributeJobResponse { job_id, plan })
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
