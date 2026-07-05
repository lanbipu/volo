//! DDC Pak generation, verification, cancellation, and distribution commands.

use cache_core::core::ue_runner::{RunnerCancel, UeRunnerBackend, UeRunnerEvent};
use cache_core::core::{batch, ddc_pak, pak_distribute};
use cache_core::data::{
    machine_ue_installs, machines as data_machines, operations,
    project_locations, Db,
};
use cache_core::error::{VoloError, VoloResult};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;

#[derive(Default)]
pub struct UeJobRegistry {
    jobs: Mutex<HashMap<String, Arc<Mutex<RunnerCancel>>>>,
}

impl UeJobRegistry {
    pub(crate) async fn insert(&self, job_id: &str, cancel: Arc<Mutex<RunnerCancel>>) {
        self.jobs.lock().await.insert(job_id.to_string(), cancel);
    }

    pub(crate) async fn remove(&self, job_id: &str) {
        self.jobs.lock().await.remove(job_id);
    }

    async fn cancel(&self, job_id: &str) -> bool {
        let cancel = {
            let jobs = self.jobs.lock().await;
            jobs.get(job_id).cloned()
        };
        if let Some(cancel) = cancel {
            cancel.lock().await.requested = true;
            true
        } else {
            false
        }
    }
}

/// Where the UE process actually runs (remote source machine over SSH vs the
/// operator's local machine) — distinct from the project's cache storage
/// routing (zen/legacy_pak, see `cache_backend::Backend`).
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ExecutionLocation {
    Remote,
    Local,
}

#[derive(Debug, Serialize)]
pub struct GenerateJobResponse {
    pub job_id: String,
    pub source_machine_id: i64,
    pub project_id: i64,
    pub backend: String,
}

#[derive(Debug, Serialize)]
pub struct DistributeJobResponse {
    pub job_id: String,
    pub project_id: i64,
    pub source_machine_id: i64,
    pub plan: Vec<pak_distribute::DistributePlanItem>,
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
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

fn resolve_operator_engine_path(_preferred_version: Option<&str>) -> VoloResult<String> {
    if let Some(local_app) = std::env::var_os("LOCALAPPDATA") {
        let cfg_path = std::path::Path::new(&local_app)
            .join("UECM")
            .join("operator-config.json");
        if cfg_path.exists() {
            #[derive(Deserialize)]
            struct OperatorConfig {
                engine_path: String,
            }
            let text = std::fs::read_to_string(&cfg_path).map_err(VoloError::Io)?;
            let cfg: OperatorConfig = serde_json::from_str(&text).map_err(|e| {
                VoloError::OperationFailed(format!("operator-config.json parse: {}", e))
            })?;
            return Ok(cfg.engine_path);
        }
    }
    Err(VoloError::InvalidInput(
        "local_engine_path is required when operator-config.json is absent".into(),
    ))
}

fn project_dir_from_uproject_path(path: &str) -> String {
    path.rfind(['\\', '/'])
        .map(|idx| path[..idx].to_string())
        .unwrap_or_default()
}

#[tauri::command]
pub async fn generate_ddc_pak(
    app: AppHandle,
    db: State<'_, Db>,
    registry: State<'_, UeJobRegistry>,
    backend: ExecutionLocation,
    source_machine_id: Option<i64>,
    project_id: i64,
    local_uproject_path: Option<String>,
    local_engine_path: Option<String>,
    ue_version: Option<String>,
    operator_credential_alias: Option<String>,
) -> VoloResult<GenerateJobResponse> {
    let (host, engine_path, uproject_path, runtime_backend) = match backend {
        ExecutionLocation::Remote => {
            let machine_id = source_machine_id.ok_or_else(|| {
                VoloError::InvalidInput("source_machine_id required for remote backend".into())
            })?;
            let machine = data_machines::find_by_id(&db, machine_id)?.ok_or_else(|| {
                VoloError::InvalidInput(format!("machine {} not found", machine_id))
            })?;
            let location =
                project_locations::get_for_project_machine(&db, project_id, machine_id)?
                    .ok_or_else(|| {
                        VoloError::InvalidInput(format!(
                            "project {} not located on machine {}",
                            project_id, machine_id
                        ))
            })?;
            let engine_path = resolve_engine_path(&db, machine_id, ue_version.as_deref())?;
            let runtime_backend = if cache_core::core::loopback::is_loopback_target(&machine.ip)
                || cache_core::core::loopback::is_loopback_target(&machine.hostname)
            {
                tracing::debug!(
                    machine_id,
                    host = %machine.ip,
                    hostname = %machine.hostname,
                    "ddc_pak: source machine is local, forcing local UE backend"
                );
                UeRunnerBackend::Local
            } else {
                UeRunnerBackend::Remote
            };
            (
                machine.ip,
                engine_path,
                location.uproject_path,
                runtime_backend,
            )
        }
        ExecutionLocation::Local => {
            let uproject_path = local_uproject_path.ok_or_else(|| {
                VoloError::InvalidInput("local_uproject_path required for local backend".into())
            })?;
            let engine_path = local_engine_path
                .or_else(|| resolve_operator_engine_path(ue_version.as_deref()).ok())
                .ok_or_else(|| {
                    VoloError::InvalidInput(
                        "local_engine_path required for local backend".into(),
                    )
                })?;
            (
                String::new(),
                engine_path,
                uproject_path,
                UeRunnerBackend::Local,
            )
        }
    };

    // SSH key auth: operator cred vestigial (param kept as shim, Vue compat).
    let _ = &operator_credential_alias;
    let (op_user, op_pass): (Option<String>, Option<String>) = (None, None);
    if matches!(runtime_backend, UeRunnerBackend::Remote) {
        ddc_pak::preflight(
            &host,
            &engine_path,
            &uproject_path,
            op_user.as_deref(),
            op_pass.as_deref(),
        )?;
    }

    let handle = ddc_pak::launch_generation(
        runtime_backend,
        &host,
        &engine_path,
        &uproject_path,
        op_user.as_deref(),
        op_pass.as_deref(),
    );

    let resolved_source_id = source_machine_id.unwrap_or(-1);
    let operation_id = operations::start(&db, "ddc_pak.generate", &[resolved_source_id])?;
    let job_id = format!("ddc-pak-gen-{}-{}", resolved_source_id, now_millis());
    registry.insert(&job_id, handle.cancel.clone()).await;

    let app_clone = app.clone();
    let db_for_task: Db = (*db).clone();
    let job_id_for_task = job_id.clone();
    let project_dir_for_verify = project_dir_from_uproject_path(&uproject_path);
    let host_for_verify = host.clone();
    let user_for_verify = op_user.clone();
    let pass_for_verify = op_pass.clone();
    let mut events = handle.events;
    tokio::spawn(async move {
        while let Some(event) = events.recv().await {
            #[derive(Clone, Serialize)]
            struct Payload<'a> {
                job_id: &'a str,
                source_machine_id: i64,
                project_id: i64,
                event: &'a UeRunnerEvent,
            }
            let _ = app_clone.emit(
                "ue-runner-progress",
                Payload {
                    job_id: &job_id_for_task,
                    source_machine_id: resolved_source_id,
                    project_id,
                    event: &event,
                },
            );

            match &event {
                UeRunnerEvent::Completed {
                    exit_code,
                    log_tail,
                } => {
                    let verified = if *exit_code == 0 {
                        match runtime_backend {
                            UeRunnerBackend::Remote => ddc_pak::verify_output(
                                &host_for_verify,
                                &project_dir_for_verify,
                                user_for_verify.as_deref(),
                                pass_for_verify.as_deref(),
                            )
                            .ok(),
                            UeRunnerBackend::Local => {
                                ddc_pak::verify_output_local(&project_dir_for_verify).ok()
                            }
                        }
                    } else {
                        None
                    };
                    #[derive(Clone, Serialize)]
                    struct VerifyPayload<'a> {
                        job_id: &'a str,
                        project_id: i64,
                        verified: bool,
                        output: Option<ddc_pak::PakOutput>,
                    }
                    let _ = app_clone.emit(
                        "pak-verified",
                        VerifyPayload {
                            job_id: &job_id_for_task,
                            project_id,
                            verified: verified.is_some(),
                            output: verified,
                        },
                    );
                    let status = if *exit_code == 0 { "ok" } else { "err" };
                    let log_text = log_tail.join("\n");
                    let _ = operations::finish(&db_for_task, operation_id, status, Some(&log_text));
                }
                UeRunnerEvent::Cancelled => {
                    let _ = operations::finish(&db_for_task, operation_id, "cancelled", None);
                }
                UeRunnerEvent::Error { message } => {
                    let _ = operations::finish(&db_for_task, operation_id, "err", Some(message));
                }
                _ => {}
            }

            if matches!(
                event,
                UeRunnerEvent::Completed { .. }
                    | UeRunnerEvent::Cancelled
                    | UeRunnerEvent::Error { .. }
            ) {
                let registry = app_clone.state::<UeJobRegistry>();
                registry.remove(&job_id_for_task).await;
                break;
            }
        }
    });

    Ok(GenerateJobResponse {
        job_id,
        source_machine_id: resolved_source_id,
        project_id,
        backend: match runtime_backend {
            UeRunnerBackend::Remote => "remote",
            UeRunnerBackend::Local => "local",
        }
        .into(),
    })
}

#[tauri::command]
pub async fn cancel_ue_job(
    registry: State<'_, UeJobRegistry>,
    job_id: String,
) -> VoloResult<bool> {
    Ok(registry.cancel(&job_id).await)
}

#[tauri::command]
pub async fn verify_pak_output(
    db: State<'_, Db>,
    machine_id: i64,
    project_id: i64,
    operator_credential_alias: Option<String>,
) -> VoloResult<ddc_pak::PakOutput> {
    let machine = data_machines::find_by_id(&db, machine_id)?
        .ok_or_else(|| VoloError::InvalidInput(format!("machine {} not found", machine_id)))?;
    let location = project_locations::get_for_project_machine(&db, project_id, machine_id)?
        .ok_or_else(|| {
            VoloError::InvalidInput(format!(
                "project {} not located on machine {}",
                project_id, machine_id
            ))
        })?;
    let _ = &operator_credential_alias;
    let (op_user, op_pass): (Option<String>, Option<String>) = (None, None);
    let host = machine.ip;
    let project_dir = location.abs_path;
    tokio::task::spawn_blocking(move || {
        ddc_pak::verify_output(
            &host,
            &project_dir,
            op_user.as_deref(),
            op_pass.as_deref(),
        )
    })
    .await
    .map_err(|err| VoloError::OperationFailed(format!("verify_pak_output task failed: {err}")))?
}

#[tauri::command]
pub async fn distribute_ddc_pak(
    app: AppHandle,
    db: State<'_, Db>,
    source_machine_id: i64,
    project_id: i64,
    target_machine_ids: Vec<i64>,
    named_share_unc: Option<String>,
    operator_credential_alias: Option<String>,
    source_smb_credential_alias: Option<String>,
) -> VoloResult<DistributeJobResponse> {
    let source_machine = data_machines::find_by_id(&db, source_machine_id)?
        .ok_or_else(|| VoloError::InvalidInput(format!("machine {} not found", source_machine_id)))?;
    let source_location =
        project_locations::get_for_project_machine(&db, project_id, source_machine_id)?
            .ok_or_else(|| {
                VoloError::InvalidInput(format!(
                    "project {} not located on machine {}",
                    project_id, source_machine_id
                ))
            })?;
    // SSH key auth: operator cred vestigial (param kept as shim). Source-SMB cred
    // from the SecretStore (Mode B share), not DPAPI.
    let _ = &operator_credential_alias;
    let (effective_unc, smb_user, smb_pass) = match &named_share_unc {
        // Explicit UNC wins and bypasses share auto-pick (which errors when the
        // source host has multiple registered shares) — preserve the old
        // behavior of letting a manual/override UNC through. Cred from the
        // SecretStore alias if given (Mode B svc = ddc-svc), else none (open share).
        Some(unc) => {
            // Resolve the SMB cred ALIAS for this explicit UNC: the caller's
            // explicit alias wins; otherwise match the UNC to a registered share
            // on the source host (an explicit UNC uniquely identifies the share,
            // so we sidestep resolve_source_smb's multi-share ambiguity error).
            // A Mode B share -> its alias -> SecretStore cred + real svc account.
            // An open (Mode A) share or an unregistered manual UNC -> no alias ->
            // anonymous (fine for open shares).
            // Only a MANAGED (Mode B) share carries an SMB credential; match the
            // UNC to a Mode B share on the source to find its alias. (An open
            // Mode A row may store an unrelated operator alias and is mounted
            // anonymously, so it must not be treated as an SMB cred.)
            let alias = source_smb_credential_alias.clone().or_else(|| {
                cache_core::data::share_configs::find_by_host(&db, source_machine_id)
                    .ok()
                    .and_then(|shares| {
                        shares
                            .into_iter()
                            .find(|s| {
                                s.mode == cache_core::data::ShareMode::Managed
                                    && pak_distribute::unc_names_share(unc, &s.unc_path)
                            })
                            .and_then(|s| s.credential_alias)
                    })
            });
            let (user, pass) = match alias.as_deref() {
                Some(a) => {
                    // The SecretStore secret is required for a Mode B share (error
                    // clearly rather than mounting anonymously, which it rejects).
                    // The svc username mirrors resolve_source_smb: the real account
                    // from the credential record, else the `ddc-svc` convention.
                    let pass = cache_core::core::secrets::get_share_secret_migrating(a)?
                        .ok_or_else(|| {
                            VoloError::InvalidInput(format!(
                                "source SMB alias '{a}' has no stored secret; re-create the share via `share create --mode b`"
                            ))
                        })?;
                    let user = cache_core::data::credentials::find_by_alias(&db, a)?
                        .map(|c| c.username)
                        .unwrap_or_else(|| "ddc-svc".to_string());
                    (Some(user), Some(pass))
                }
                None => (None, None),
            };
            (Some(unc.clone()), user, pass)
        }
        // No explicit UNC: DDC.ddp lives under the project directory — pull via the
        // source admin share (D$/…/DerivedDataCache), not the fleet DDC SMB share.
        None => {
            let _ = &source_smb_credential_alias;
            let (user, pass) =
                pak_distribute::resolve_admin_pull_smb(&db, source_machine_id, true)?;
            (None, user, pass)
        }
    };

    let distribute_profile = pak_distribute::DistributeProfile::ddc_pak();
    let plan = pak_distribute::plan(
        &distribute_profile,
        &db,
        source_machine_id,
        &source_machine.ip,
        &source_location,
        &target_machine_ids,
        project_id,
        effective_unc.as_deref(),
        smb_user,
        smb_pass,
    )?;
    if plan.is_empty() {
        return Err(VoloError::InvalidInput(
            "distribution plan has no non-source targets".into(),
        ));
    }

    for item in &plan {
        pak_distribute::preflight_one_with_profile(&distribute_profile, item).await.map_err(|e| {
            VoloError::OperationFailed(format!(
                "target {} cannot reach source UNC: {}",
                item.target_machine_id, e
            ))
        })?;
    }

    let mut operation_machines = Vec::with_capacity(target_machine_ids.len() + 1);
    operation_machines.push(source_machine_id);
    for machine_id in target_machine_ids.iter().copied() {
        if !operation_machines.contains(&machine_id) {
            operation_machines.push(machine_id);
        }
    }
    let operation_id = operations::start(&db, "ddc_pak.distribute", &operation_machines)?;
    let job_id = format!("ddc-pak-dist-{}-{}", source_machine_id, now_millis());
    let plan_for_task = Arc::new(plan.clone());
    let db_for_task: Db = (*db).clone();
    let app_for_task = app.clone();
    let job_id_for_task = job_id.clone();

    tokio::spawn(async move {
        let machine_ids: Vec<i64> = plan_for_task
            .iter()
            .map(|item| item.target_machine_id)
            .collect();
        let plan_lookup = plan_for_task.clone();
        let mut rx = batch::run_batch(
            machine_ids,
            batch::DEFAULT_MAX_CONCURRENCY,
            move |machine_id| {
                let plan_lookup = plan_lookup.clone();
                async move {
                    let distribute_profile = pak_distribute::DistributeProfile::ddc_pak();
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
                    let outcome = pak_distribute::run_one_with_profile(
                        &distribute_profile,
                        item,
                    )
                    .await?;
                    if !outcome.ok {
                        return Err(VoloError::OperationFailed(format!(
                            "robocopy exit {}: {}",
                            outcome.exit_code,
                            outcome
                                .message
                                .unwrap_or_else(|| outcome.stdout_tail.clone())
                        )));
                    }
                    Ok::<_, VoloError>(outcome)
                }
            },
        )
        .await;

        let mut had_error = false;
        while let Some(event) = rx.recv().await {
            if matches!(event.status, batch::BatchStatus::Err) {
                had_error = true;
            }
            #[derive(Clone, Serialize)]
            struct Payload<'a> {
                job_id: &'a str,
                project_id: i64,
                source_machine_id: i64,
                event: batch::BatchEvent,
            }
            let _ = app_for_task.emit(
                "pak-distribute-progress",
                Payload {
                    job_id: &job_id_for_task,
                    project_id,
                    source_machine_id,
                    event,
                },
            );
        }
        let status = if had_error { "err" } else { "ok" };
        let _ = operations::finish(&db_for_task, operation_id, status, None);
    });

    Ok(DistributeJobResponse {
        job_id,
        project_id,
        source_machine_id,
        plan,
    })
}

#[tauri::command]
pub async fn list_deployed_ddc_paks(db: State<'_, Db>) -> VoloResult<Vec<ddc_pak::DeployedPakEntry>> {
    ddc_pak::scan_deployed(&db).await
}

#[tauri::command]
pub async fn delete_ddc_pak(
    db: State<'_, Db>,
    machine_id: i64,
    project_id: i64,
) -> VoloResult<()> {
    let machine = data_machines::find_by_id(&db, machine_id)?
        .ok_or_else(|| VoloError::InvalidInput(format!("machine {} not found", machine_id)))?;
    let location = project_locations::get_for_project_machine(&db, project_id, machine_id)?
        .ok_or_else(|| {
            VoloError::InvalidInput(format!(
                "project {} not located on machine {}",
                project_id, machine_id
            ))
        })?;
    let host = machine.ip;
    let project_dir = location.abs_path;
    tokio::task::spawn_blocking(move || ddc_pak::delete_output(&host, &project_dir))
        .await
        .map_err(|err| VoloError::OperationFailed(format!("delete_ddc_pak task failed: {err}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_dir_from_windows_path() {
        assert_eq!(
            project_dir_from_uproject_path("D:\\Work\\Demo\\Demo.uproject"),
            "D:\\Work\\Demo"
        );
    }
}
