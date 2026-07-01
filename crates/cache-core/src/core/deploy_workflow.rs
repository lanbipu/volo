//! Orchestrates the 11-step DDC deployment workflow. Takes &Db from caller;
//! never opens DB itself.

use crate::core::{
    ddc_pak, env_vars, ini_editor, local_cache, pak_distribute, pso_collect, pso_distribute,
    shares, ue_log_verify,
    ue_runner::{UeRunnerBackend, UeRunnerEvent},
};
use crate::data::{
    credentials as data_creds, machine_ue_installs, machines as data_machines, project_locations,
    pso_cache_files, share_configs, CredentialKind, CredentialRecord, Db, ShareConfig, ShareMode,
};
use crate::error::{UecmError, UecmResult};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeployPlan {
    pub project_id: i64,
    pub source_machine_id: i64,
    pub target_machine_ids: Vec<i64>,
    pub local_cache: LocalCacheSpec,
    pub shared_cache: SharedCacheSpec,
    pub ddc_pak: PakSpec,
    pub pso: PsoSpec,
    pub verify: VerifySpec,
}

impl DeployPlan {
    /// DESIGN-2: feature-gated required-field validation. The PSO and
    /// log-verify sub-specs carry `#[serde(default)]` fields so a plan can omit
    /// them when the feature is disabled, but they ARE required when the
    /// feature is on (the steps consume them). Call this right after
    /// deserialization on both the CLI and Tauri entry points so an
    /// enabled-but-incomplete plan fails with a clear error instead of running
    /// with an empty resolution / editor path.
    pub fn validate(&self) -> UecmResult<()> {
        if self.pso.enabled && self.pso.resolution.trim().is_empty() {
            return Err(UecmError::InvalidInput(
                "pso.resolution is required when pso.enabled is true".into(),
            ));
        }
        if self.verify.run_log_verify && self.verify.editor_exe.trim().is_empty() {
            return Err(UecmError::InvalidInput(
                "verify.editor_exe is required when verify.run_log_verify is true".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalCacheSpec {
    pub path: String,
    pub service_account: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SharedCacheSpec {
    pub server_machine_id: i64,
    pub share_name: String,
    pub server_path: String,
    pub mode: String,
    pub unc_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PakSpec { pub enabled: bool }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PsoSpec {
    pub enabled: bool,
    // DESIGN-2: only consumed when `enabled` (parse_resolution + the PSO steps in
    // plan_steps). Optional in JSON so a `"pso": { "enabled": false }` plan
    // doesn't have to carry dummy values; `DeployPlan::validate` enforces them
    // when the feature IS enabled.
    #[serde(default)]
    pub resolution: String,
    #[serde(default)]
    pub max_minutes: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerifySpec {
    pub run_log_verify: bool,
    // DESIGN-2: only consumed when `run_log_verify` (VerifyStartupLogs step).
    // Optional in JSON; `DeployPlan::validate` enforces them when enabled.
    #[serde(default)]
    pub editor_exe: String,
    #[serde(default)]
    pub timeout_seconds: u32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum DeployStep {
    ProvisionLocalDir,
    SetLocalEnv,
    CreateSmbShare,
    SetSharedEnv,
    WriteBackendGraph,
    GenerateDdcPak,
    DistributeDdcPak,
    SetPsoCvars,
    CollectPso,
    DistributePso,
    VerifyStartupLogs,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DeployEvent {
    StepStarted { step: DeployStep, hosts: Vec<String> },
    StepHostOk { step: DeployStep, host: String, message: Option<String> },
    StepHostError { step: DeployStep, host: String, error: String },
    StepCompleted { step: DeployStep, ok_count: u32, fail_count: u32 },
    PlanCompleted { ok: bool, summary: String },
}

pub fn plan_steps(plan: &DeployPlan) -> Vec<DeployStep> {
    use DeployStep::*;
    let mut s = vec![
        ProvisionLocalDir,
        SetLocalEnv,
        CreateSmbShare,
        SetSharedEnv,
        WriteBackendGraph,
    ];
    if plan.ddc_pak.enabled {
        s.push(GenerateDdcPak);
        s.push(DistributeDdcPak);
    }
    if plan.pso.enabled {
        s.push(SetPsoCvars);
        s.push(CollectPso);
        s.push(DistributePso);
    }
    if plan.verify.run_log_verify {
        s.push(VerifyStartupLogs);
    }
    s
}

#[derive(Debug, Clone)]
pub struct RunOptions {
    pub stop_on_step_failure: bool,
}

// ---------------------------------------------------------------------------
// Step executor
// ---------------------------------------------------------------------------

fn host_for(db: &Db, machine_id: i64) -> UecmResult<String> {
    data_machines::find_by_id(db, machine_id)?
        .map(|m| m.ip)
        .ok_or_else(|| UecmError::InvalidInput(format!("machine {} not found", machine_id)))
}

/// Source SMB credential for a deploy distribution step. The targets mount the
/// shared-cache share created by `CreateSmbShare` on
/// `shared_cache.server_machine_id`: a Mode B (managed) share's svc password is
/// read from the SecretStore under the deterministic alias `CreateSmbShare`
/// wrote; a Mode A (open) share needs no credential. Derived from the plan's own
/// share spec (not a DB share lookup), so a same-run open share that was never
/// persisted to `share_configs` still distributes.
fn deploy_source_smb(db: &Db, plan: &DeployPlan) -> UecmResult<(Option<String>, Option<String>)> {
    match plan.shared_cache.mode.as_str() {
        "b" | "B" => {
            let server_host = host_for(db, plan.shared_cache.server_machine_id)?;
            let alias = format!("UECM:share:{}:ddc-svc", server_host);
            let pass = crate::core::secrets::SecretStore::from_config()?
                .get(&alias)?
                .ok_or_else(|| {
                    UecmError::OperationFailed(format!(
                        "Mode B share secret '{alias}' missing from the SecretStore; \
                         re-run the share-creation step"
                    ))
                })?;
            Ok((Some("ddc-svc".to_string()), Some(pass)))
        }
        _ => Ok((None, None)), // Mode A (open) share — anonymous mount, no credential
    }
}

fn project_root_for(db: &Db, project_id: i64, machine_id: i64) -> UecmResult<String> {
    project_locations::get_for_project_machine(db, project_id, machine_id)?
        .map(|loc| loc.abs_path)
        .ok_or_else(|| {
            UecmError::InvalidInput(format!(
                "project {} not located on machine {}",
                project_id, machine_id
            ))
        })
}

fn project_location_for(
    db: &Db,
    project_id: i64,
    machine_id: i64,
) -> UecmResult<project_locations::ProjectLocation> {
    project_locations::get_for_project_machine(db, project_id, machine_id)?.ok_or_else(|| {
        UecmError::InvalidInput(format!(
            "project {} not located on machine {}",
            project_id, machine_id
        ))
    })
}

fn resolve_primary_engine_path(db: &Db, machine_id: i64) -> UecmResult<String> {
    let installs = machine_ue_installs::list_for_machine(db, machine_id)?;
    if installs.is_empty() {
        return Err(UecmError::InvalidInput(format!(
            "machine {} has no detected UE installs",
            machine_id
        )));
    }
    let install = installs
        .iter()
        .find(|install| install.is_primary)
        .cloned()
        .unwrap_or_else(|| installs[0].clone());
    Ok(install.install_path)
}

fn parse_resolution(text: &str) -> UecmResult<(u32, u32)> {
    let mut parts = text.split(|c| c == 'x' || c == 'X');
    let w = parts
        .next()
        .and_then(|v| v.trim().parse::<u32>().ok())
        .ok_or_else(|| UecmError::InvalidInput(format!("bad resolution: {}", text)))?;
    let h = parts
        .next()
        .and_then(|v| v.trim().parse::<u32>().ok())
        .ok_or_else(|| UecmError::InvalidInput(format!("bad resolution: {}", text)))?;
    Ok((w, h))
}

fn step_machine_ids(plan: &DeployPlan, step: DeployStep) -> Vec<i64> {
    use DeployStep::*;
    match step {
        ProvisionLocalDir | SetLocalEnv | SetSharedEnv | WriteBackendGraph | SetPsoCvars
        | DistributeDdcPak | DistributePso | VerifyStartupLogs => plan.target_machine_ids.clone(),
        CreateSmbShare => vec![plan.shared_cache.server_machine_id],
        GenerateDdcPak | CollectPso => vec![plan.source_machine_id],
    }
}

pub fn run_step(
    db: &Db,
    plan: &mut DeployPlan,
    step: DeployStep,
    creds: Option<(&str, &str)>,
    emit: &mut dyn FnMut(DeployEvent),
) {
    let machine_ids = step_machine_ids(plan, step);
    let mut hosts: Vec<String> = Vec::with_capacity(machine_ids.len());
    for mid in &machine_ids {
        match host_for(db, *mid) {
            Ok(h) => hosts.push(h),
            Err(e) => {
                emit(DeployEvent::StepHostError {
                    step,
                    host: format!("machine_id={}", mid),
                    error: e.to_string(),
                });
                hosts.push(format!("machine_id={}", mid));
            }
        }
    }
    emit(DeployEvent::StepStarted {
        step,
        hosts: hosts.clone(),
    });
    let mut ok = 0u32;
    let mut fail = 0u32;
    for (mid, host) in machine_ids.iter().zip(hosts.iter()) {
        match execute_one(db, plan, step, *mid, host, creds) {
            Ok(msg) => {
                ok += 1;
                emit(DeployEvent::StepHostOk {
                    step,
                    host: host.clone(),
                    message: msg,
                });
            }
            Err(e) => {
                fail += 1;
                emit(DeployEvent::StepHostError {
                    step,
                    host: host.clone(),
                    error: e.to_string(),
                });
            }
        }
    }
    emit(DeployEvent::StepCompleted {
        step,
        ok_count: ok,
        fail_count: fail,
    });
}

fn execute_one(
    db: &Db,
    plan: &mut DeployPlan,
    step: DeployStep,
    machine_id: i64,
    host: &str,
    creds: Option<(&str, &str)>,
) -> UecmResult<Option<String>> {
    use DeployStep::*;
    match step {
        ProvisionLocalDir => local_cache::create(
            host,
            &plan.local_cache.path,
            plan.local_cache.service_account.as_deref(),
            creds,
        )
        .map(Some),
        SetLocalEnv => env_vars::set(host, "UE-LocalDataCachePath", &plan.local_cache.path)
            .map(|_| None),
        CreateSmbShare => {
            let op_user = creds.map(|(u, _)| u);
            let op_pass = creds.map(|(_, p)| p);
            let r = match plan.shared_cache.mode.as_str() {
                "a" | "A" => shares::create_mode_a(
                    host,
                    &plan.shared_cache.share_name,
                    &plan.shared_cache.server_path,
                    op_user,
                    op_pass,
                )?,
                "b" | "B" => {
                    let svc_pass = shares::generate_svc_password();
                    let r = shares::create_mode_b(
                        host,
                        &plan.shared_cache.share_name,
                        &plan.shared_cache.server_path,
                        "ddc-svc",
                        &svc_pass,
                        op_user,
                        op_pass,
                    )?;
                    // Persist the generated svc credential + share row so a later
                    // DistributeDdcPak/Pso (which resolves the source SMB credential
                    // from the registered share via resolve_source_smb) can mount
                    // this managed share. Mirrors `share create --mode b`. Without
                    // this a one-click deploy that creates the share AND distributes
                    // would hit "source host has no registered share".
                    let server_host = host_for(db, plan.shared_cache.server_machine_id)?;
                    let alias = format!("UECM:share:{}:ddc-svc", server_host);
                    crate::core::secrets::SecretStore::from_config()?.put(&alias, &svc_pass)?;
                    if data_creds::find_by_alias(db, &alias)?.is_none() {
                        data_creds::insert(
                            db,
                            &CredentialRecord {
                                id: None,
                                alias: alias.clone(),
                                kind: CredentialKind::Share,
                                username: "ddc-svc".into(),
                            },
                        )?;
                    }
                    let already = share_configs::find_by_host(db, plan.shared_cache.server_machine_id)?
                        .into_iter()
                        .any(|s| s.share_name == plan.shared_cache.share_name);
                    if !already {
                        share_configs::insert(
                            db,
                            &ShareConfig {
                                id: None,
                                host_machine_id: plan.shared_cache.server_machine_id,
                                share_name: plan.shared_cache.share_name.clone(),
                                unc_path: r.unc_path.clone(),
                                local_path: plan.shared_cache.server_path.clone(),
                                mode: ShareMode::Managed,
                                credential_alias: Some(alias),
                            },
                        )?;
                    }
                    r
                }
                other => {
                    return Err(UecmError::InvalidInput(format!(
                        "unknown share mode '{}'",
                        other
                    )));
                }
            };
            plan.shared_cache.unc_path = Some(r.unc_path.clone());
            Ok(Some(format!("UNC={}", r.unc_path)))
        }
        SetSharedEnv => {
            let unc = plan.shared_cache.unc_path.clone().unwrap_or_else(|| {
                let server_host = host_for(db, plan.shared_cache.server_machine_id)
                    .unwrap_or_else(|_| "?".into());
                format!("\\\\{}\\{}", server_host, plan.shared_cache.share_name)
            });
            env_vars::set(host, "UE-SharedDataCachePath", &unc)
                .map(|_| Some(format!("=> {}", unc)))
        }
        WriteBackendGraph => {
            let unc = plan.shared_cache.unc_path.clone().unwrap_or_else(|| {
                let server_host = host_for(db, plan.shared_cache.server_machine_id)
                    .unwrap_or_else(|_| "?".into());
                format!("\\\\{}\\{}", server_host, plan.shared_cache.share_name)
            });
            let project_root = project_root_for(db, plan.project_id, machine_id)?;
            let ini_path = format!(
                "{}\\Config\\DefaultEngine.ini",
                project_root.trim_end_matches('\\')
            );
            ini_editor::set_backend_field(
                host, &ini_path, "DerivedDataBackendGraph", "Shared", "Path", &unc,
            )?;
            ini_editor::set_backend_field(
                host,
                &ini_path,
                "DerivedDataBackendGraph",
                "Shared",
                "EnvPathOverride",
                "UE-SharedDataCachePath",
            )?;
            Ok(Some("Shared.Path + EnvPathOverride".into()))
        }
        GenerateDdcPak => {
            let loc = project_location_for(db, plan.project_id, machine_id)?;
            let engine_path = resolve_primary_engine_path(db, machine_id)?;
            let out =
                generate_pak_sync(host, &engine_path, &loc.uproject_path, &loc.abs_path, creds)?;
            Ok(Some(format!("pak={} ({} bytes)", out.path, out.size_bytes)))
        }
        DistributeDdcPak => {
            let source_machine = data_machines::find_by_id(db, plan.source_machine_id)?
                .ok_or_else(|| {
                    UecmError::InvalidInput(format!(
                        "machine {} not found",
                        plan.source_machine_id
                    ))
                })?;
            let source_location =
                project_location_for(db, plan.project_id, plan.source_machine_id)?;
            // SSH key auth: source SMB credential for the shared-cache share the
            // targets mount — Mode B svc password from the SecretStore, or none for
            // an open Mode A share. (See deploy_source_smb; operator creds gone.)
            let (smb_user, smb_pass) = deploy_source_smb(db, plan)?;
            let profile = pak_distribute::DistributeProfile::ddc_pak();
            let items = pak_distribute::plan(
                &profile,
                db,
                plan.source_machine_id,
                &source_machine.ip,
                &source_location,
                &[machine_id],
                plan.project_id,
                plan.shared_cache.unc_path.as_deref(),
                smb_user,
                smb_pass,
            )?;
            let item = items
                .into_iter()
                .find(|i| i.target_machine_id == machine_id)
                .ok_or_else(|| {
                    UecmError::InvalidInput("no plan item for target".into())
                })?;
            let outcome = block_on_async(pak_distribute::run_one_with_profile(&profile, item))?;
            if !outcome.ok {
                return Err(UecmError::OperationFailed(format!(
                    "robocopy exit {}: {}",
                    outcome.exit_code,
                    outcome
                        .message
                        .unwrap_or_else(|| outcome.stdout_tail.clone())
                )));
            }
            Ok(Some(format!("{} bytes copied", outcome.bytes_copied)))
        }
        SetPsoCvars => {
            let project_root = project_root_for(db, plan.project_id, machine_id)?;
            let ini = format!(
                "{}\\Config\\ConsoleVariables.ini",
                project_root.trim_end_matches('\\')
            );
            for key in [
                "r.ShaderPipelineCache.Enabled",
                "r.PSOPrecaching",
                "r.PSOPrecache.GlobalShaders",
            ] {
                ini_editor::set_key(host, &ini, "ConsoleVariables", key, "1")?;
            }
            // r.PSOPrecache.Compile 不是真实存在的 CVar（UE 5.8 源码核实过），已从这里删除；
            // R009 巡检的是 r.PSOPrecache.Mode，健康值是 0（Full PSO），不是 1。
            ini_editor::set_key(host, &ini, "ConsoleVariables", "r.PSOPrecache.Mode", "0")?;
            Ok(Some("4 CVars set".into()))
        }
        CollectPso => {
            let loc = project_location_for(db, plan.project_id, machine_id)?;
            let engine_path = resolve_primary_engine_path(db, machine_id)?;
            let count = collect_pso_sync(
                db,
                plan.project_id,
                machine_id,
                host,
                &engine_path,
                &loc.uproject_path,
                &loc.abs_path,
                &plan.pso,
                creds,
            )?;
            Ok(Some(format!("{} PSO files", count)))
        }
        DistributePso => {
            let source_machine = data_machines::find_by_id(db, plan.source_machine_id)?
                .ok_or_else(|| {
                    UecmError::InvalidInput(format!(
                        "machine {} not found",
                        plan.source_machine_id
                    ))
                })?;
            let files = pso_cache_files::list_by_project(db, plan.project_id)?
                .into_iter()
                .filter(|f| f.source_machine_id == plan.source_machine_id)
                .collect::<Vec<_>>();
            if files.is_empty() {
                return Err(UecmError::OperationFailed(
                    "no PSO cache files collected on source".into(),
                ));
            }
            // SSH key auth: source SMB credential for the shared-cache share (Mode
            // B svc password from the SecretStore, or none for open Mode A). See
            // deploy_source_smb / DistributeDdcPak.
            let (smb_user, smb_pass) = deploy_source_smb(db, plan)?;
            let mut total_bytes: i64 = 0;
            for file in &files {
                let items = pso_distribute::plan(
                    db,
                    &source_machine.ip,
                    file,
                    &[machine_id],
                    plan.shared_cache.unc_path.as_deref(),
                    smb_user.clone(),
                    smb_pass.clone(),
                )?;
                let item = items
                    .into_iter()
                    .find(|i| i.target_machine_id == machine_id)
                    .ok_or_else(|| {
                        UecmError::InvalidInput(
                            "no pso plan item for target".into(),
                        )
                    })?;
                let outcome = block_on_async(pso_distribute::run_one(item))?;
                if !outcome.ok {
                    return Err(UecmError::OperationFailed(format!(
                        "robocopy exit {} ({}): {}",
                        outcome.exit_code,
                        file.file_name,
                        outcome
                            .message
                            .unwrap_or_else(|| outcome.stdout_tail.clone())
                    )));
                }
                total_bytes += outcome.bytes_copied;
            }
            Ok(Some(format!(
                "{} files, {} bytes",
                files.len(),
                total_bytes
            )))
        }
        VerifyStartupLogs => {
            let uproject = project_location_for(db, plan.project_id, machine_id)?
                .uproject_path;
            let report = ue_log_verify::run_for_host(
                host,
                &plan.verify.editor_exe,
                &uproject,
                plan.verify.timeout_seconds,
                creds,
            )?;
            let ok = report.local_path.is_some()
                && report.shared_path.is_some()
                && report.shared_deactivated_reason.is_none()
                && report.move_collision_count < 10;
            if ok {
                Ok(Some(format!(
                    "Local={}, Shared={}",
                    report.local_path.as_deref().unwrap_or("?"),
                    report.shared_path.as_deref().unwrap_or("?")
                )))
            } else {
                Err(UecmError::OperationFailed(format!(
                    "verify failed: local={:?} shared={:?} deactivated={:?} collisions={}",
                    report.local_path,
                    report.shared_path,
                    report.shared_deactivated_reason,
                    report.move_collision_count
                )))
            }
        }
    }
}

fn block_on_async<F, T>(fut: F) -> UecmResult<T>
where
    F: std::future::Future<Output = UecmResult<T>>,
{
    match tokio::runtime::Handle::try_current().ok() {
        // Called from spawn_blocking (or any dedicated blocking thread):
        // block_on drives the future directly on this thread.
        // block_in_place must NOT be used here — it requires a tokio worker
        // thread and panics from spawn_blocking threads.
        Some(h) => h.block_on(fut),
        None => {
            let rt = tokio::runtime::Runtime::new()
                .map_err(|e| UecmError::OperationFailed(format!("tokio rt: {}", e)))?;
            rt.block_on(fut)
        }
    }
}

// ---------------------------------------------------------------------------
// Sync wrappers around async UE pipelines (adapted from commands/ddc_pak.rs
// and commands/pso.rs wait loops).
// ---------------------------------------------------------------------------

/// Run a DDC Pak generation end-to-end synchronously: preflight (for remote),
/// launch via ue_runner, drain events until Completed/Cancelled/Error, then
/// verify_output. Mirrors the wait loop in `commands::ddc_pak::generate_ddc_pak`
/// but without Tauri event emission.
fn generate_pak_sync(
    host: &str,
    engine_path: &str,
    uproject_path: &str,
    project_dir: &str,
    creds: Option<(&str, &str)>,
) -> UecmResult<ddc_pak::PakOutput> {
    let (user, pass) = match creds {
        Some((u, p)) => (Some(u), Some(p)),
        None => (None, None),
    };

    // Choose backend the same way commands/ddc_pak.rs does — loopback target
    // means local UE process.
    let backend = if crate::core::loopback::is_loopback_target(host) {
        UeRunnerBackend::Local
    } else {
        UeRunnerBackend::Remote
    };

    if matches!(backend, UeRunnerBackend::Remote) {
        ddc_pak::preflight(host, engine_path, uproject_path, user, pass)?;
    }

    let handle = ddc_pak::launch_generation(backend, host, engine_path, uproject_path, user, pass);
    let mut events = handle.events;

    enum Outcome {
        Completed(i32),
        Cancelled,
        Error(String),
        StreamEnded,
    }

    let outcome = block_on_async(async move {
        while let Some(event) = events.recv().await {
            match event {
                UeRunnerEvent::Completed { exit_code, .. } => {
                    return Ok(Outcome::Completed(exit_code));
                }
                UeRunnerEvent::Cancelled => return Ok(Outcome::Cancelled),
                UeRunnerEvent::Error { message } => return Ok(Outcome::Error(message)),
                _ => {}
            }
        }
        Ok::<Outcome, UecmError>(Outcome::StreamEnded)
    })?;

    let exit = match outcome {
        Outcome::Completed(code) => code,
        Outcome::Cancelled => {
            return Err(UecmError::OperationFailed("ue runner cancelled".into()));
        }
        Outcome::Error(msg) => return Err(UecmError::OperationFailed(msg)),
        Outcome::StreamEnded => {
            return Err(UecmError::OperationFailed(
                "ue runner event stream ended without completion".into(),
            ));
        }
    };
    if exit != 0 {
        return Err(UecmError::OperationFailed(format!(
            "UE exited with code {}",
            exit
        )));
    }

    if matches!(backend, UeRunnerBackend::Remote) {
        ddc_pak::verify_output(host, project_dir, user, pass)
    } else {
        ddc_pak::verify_output_local(project_dir)
    }
}

/// Run a PSO collection end-to-end synchronously: launch via ue_runner, drain
/// events until Completed/Cancelled/Error, then enumerate_remote +
/// finalize_persist. Returns the number of files collected. Mirrors
/// `commands::pso::start_pso_collection`'s wait loop minus Tauri events.
#[allow(clippy::too_many_arguments)]
fn collect_pso_sync(
    db: &Db,
    project_id: i64,
    source_machine_id: i64,
    host: &str,
    engine_path: &str,
    uproject_path: &str,
    project_dir: &str,
    spec: &PsoSpec,
    creds: Option<(&str, &str)>,
) -> UecmResult<usize> {
    let (user, pass) = match creds {
        Some((u, p)) => (Some(u), Some(p)),
        None => (None, None),
    };
    let resolution = parse_resolution(&spec.resolution)?;
    let collect_spec = pso_collect::PsoCollectSpec {
        project_id,
        source_machine_id,
        ue_version: None,
        resolution,
        windowed: true,
        max_minutes: spec.max_minutes,
    };

    let backend = if crate::core::loopback::is_loopback_target(host) {
        UeRunnerBackend::Local
    } else {
        UeRunnerBackend::Remote
    };

    let handle = pso_collect::launch_collection(
        backend,
        host,
        engine_path,
        uproject_path,
        &collect_spec,
        user,
        pass,
    );
    pso_collect::spawn_watchdog(
        handle.cancel.clone(),
        spec.max_minutes,
        format!("deploy-pso-{}-{}", project_id, source_machine_id),
    );
    let mut events = handle.events;

    enum PsoOutcome {
        Done,
        Error(String),
        StreamEnded,
    }

    let outcome = block_on_async(async move {
        while let Some(event) = events.recv().await {
            match event {
                // Treat both Completed and Cancelled as "process exited; try to
                // collect whatever files landed" - matches commands/pso.rs.
                UeRunnerEvent::Completed { .. } | UeRunnerEvent::Cancelled => {
                    return Ok(PsoOutcome::Done);
                }
                UeRunnerEvent::Error { message } => return Ok(PsoOutcome::Error(message)),
                _ => {}
            }
        }
        Ok::<PsoOutcome, UecmError>(PsoOutcome::StreamEnded)
    })?;

    match outcome {
        PsoOutcome::Done => {}
        PsoOutcome::Error(msg) => return Err(UecmError::OperationFailed(msg)),
        PsoOutcome::StreamEnded => {
            return Err(UecmError::OperationFailed(
                "pso runner event stream ended without completion".into(),
            ));
        }
    }

    let files = pso_collect::enumerate_remote(host, project_dir, user, pass)?;
    pso_collect::finalize_persist(db, project_id, source_machine_id, None, &files)?;
    Ok(files.len())
}

pub fn run_plan(
    db: &Db,
    plan: &mut DeployPlan,
    creds: Option<(&str, &str)>,
    opts: RunOptions,
    emit: &mut dyn FnMut(DeployEvent),
) {
    let steps = plan_steps(plan);
    let mut overall_ok = true;
    for step in steps {
        let mut step_ok = 0u32;
        let mut step_fail = 0u32;
        run_step(db, plan, step, creds, &mut |evt| {
            match &evt {
                DeployEvent::StepHostOk { .. } => step_ok += 1,
                DeployEvent::StepHostError { .. } => step_fail += 1,
                _ => {}
            }
            emit(evt);
        });
        if step_fail > 0 {
            overall_ok = false;
            if opts.stop_on_step_failure {
                emit(DeployEvent::PlanCompleted {
                    ok: false,
                    summary: format!("aborted after {:?} ({} failures)", step, step_fail),
                });
                return;
            }
        }
        // Suppress unused warning when stop_on_step_failure is false and there are no failures
        let _ = step_ok;
    }
    emit(DeployEvent::PlanCompleted {
        ok: overall_ok,
        summary: if overall_ok { "all steps ok".into() } else { "completed with failures".into() },
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn baseline_plan() -> DeployPlan {
        DeployPlan {
            project_id: 1,
            source_machine_id: 100,
            target_machine_ids: vec![200, 201],
            local_cache: LocalCacheSpec { path: "D:\\UE-DDC-Local".into(), service_account: None },
            shared_cache: SharedCacheSpec {
                server_machine_id: 300,
                share_name: "DDC".into(),
                server_path: "D:\\DDC".into(),
                mode: "b".into(),
                unc_path: None,
            },
            ddc_pak: PakSpec { enabled: true },
            pso: PsoSpec { enabled: true, resolution: "1920x1080".into(), max_minutes: 10 },
            verify: VerifySpec {
                run_log_verify: true,
                editor_exe: "C:\\UE\\UnrealEditor.exe".into(),
                timeout_seconds: 180,
            },
        }
    }

    #[test]
    fn full_plan_has_11_steps() {
        assert_eq!(plan_steps(&baseline_plan()).len(), 11);
    }

    #[test]
    fn minimal_plan_skips_optional_phases() {
        let mut p = baseline_plan();
        p.ddc_pak.enabled = false;
        p.pso.enabled = false;
        p.verify.run_log_verify = false;
        let steps = plan_steps(&p);
        assert_eq!(steps.len(), 5);
        assert!(steps.contains(&DeployStep::WriteBackendGraph));
        assert!(!steps.contains(&DeployStep::GenerateDdcPak));
    }

    // DESIGN-2: a plan that disables PSO + log-verify must deserialize WITHOUT
    // carrying dummy resolution / max_minutes / editor_exe / timeout_seconds.
    const MINIMAL_JSON: &str = r#"{
        "project_id": 1,
        "source_machine_id": 100,
        "target_machine_ids": [200],
        "local_cache": { "path": "D:\\DDC-Local" },
        "shared_cache": { "server_machine_id": 300, "share_name": "DDC", "server_path": "D:\\DDC", "mode": "read_write" },
        "ddc_pak": { "enabled": false },
        "pso": { "enabled": false },
        "verify": { "run_log_verify": false }
    }"#;

    #[test]
    fn minimal_json_plan_deserializes_and_validates_with_disabled_features() {
        let plan: DeployPlan =
            serde_json::from_str(MINIMAL_JSON).expect("minimal disabled-feature plan must deserialize");
        // Omitted fields take their defaults.
        assert_eq!(plan.pso.resolution, "");
        assert_eq!(plan.pso.max_minutes, 0);
        assert_eq!(plan.verify.editor_exe, "");
        // Disabled features need no values → validation passes.
        plan.validate().expect("disabled features must not require resolution/editor_exe");
        let steps = plan_steps(&plan);
        assert!(!steps.contains(&DeployStep::CollectPso));
        assert!(!steps.contains(&DeployStep::VerifyStartupLogs));
    }

    #[test]
    fn validate_requires_resolution_when_pso_enabled() {
        let json = MINIMAL_JSON.replace(
            "\"pso\": { \"enabled\": false }",
            "\"pso\": { \"enabled\": true }",
        );
        let plan: DeployPlan = serde_json::from_str(&json).unwrap();
        let err = plan.validate().expect_err("pso.enabled=true with empty resolution must fail");
        match err {
            UecmError::InvalidInput(m) => assert!(m.contains("pso.resolution"), "msg={m}"),
            other => panic!("expected InvalidInput, got {other:?}"),
        }
    }

    #[test]
    fn validate_requires_editor_exe_when_log_verify_enabled() {
        let json = MINIMAL_JSON.replace(
            "\"verify\": { \"run_log_verify\": false }",
            "\"verify\": { \"run_log_verify\": true }",
        );
        let plan: DeployPlan = serde_json::from_str(&json).unwrap();
        let err = plan.validate().expect_err("run_log_verify=true with empty editor_exe must fail");
        match err {
            UecmError::InvalidInput(m) => assert!(m.contains("editor_exe"), "msg={m}"),
            other => panic!("expected InvalidInput, got {other:?}"),
        }
    }

    #[test]
    fn pak_only_plan_has_7_steps() {
        let mut p = baseline_plan();
        p.pso.enabled = false;
        p.verify.run_log_verify = false;
        assert_eq!(plan_steps(&p).len(), 7);
    }

    #[test]
    fn deploy_step_serializes_snake_case() {
        let s = DeployStep::WriteBackendGraph;
        let j = serde_json::to_string(&s).unwrap();
        assert_eq!(j, r#""write_backend_graph""#);
    }

    // Tests for run_step / execute_one require a Db + full I/O stack;
    // integration coverage lives in the Tauri layer. Sanity test:
    #[test]
    fn step_machine_ids_routes_correctly() {
        let p = baseline_plan();
        let on_targets = step_machine_ids(&p, DeployStep::SetLocalEnv);
        assert_eq!(on_targets, vec![200, 201]);
        let on_server = step_machine_ids(&p, DeployStep::CreateSmbShare);
        assert_eq!(on_server, vec![300]);
        let on_source = step_machine_ids(&p, DeployStep::GenerateDdcPak);
        assert_eq!(on_source, vec![100]);
    }

    #[test]
    fn parse_resolution_accepts_x_separator() {
        assert_eq!(parse_resolution("1920x1080").unwrap(), (1920, 1080));
        assert_eq!(parse_resolution("640X480").unwrap(), (640, 480));
        assert!(parse_resolution("bad").is_err());
    }

    #[test]
    fn run_plan_emits_plan_completed_on_empty_target_set() {
        // With empty target_machine_ids, every step runs over zero hosts and
        // therefore completes successfully. We use an in-memory DB.
        let db = crate::data::open_in_memory().expect("in-memory db");
        let mut plan = baseline_plan();
        plan.target_machine_ids.clear();
        plan.ddc_pak.enabled = false;
        plan.pso.enabled = false;
        plan.verify.run_log_verify = false;

        let mut events: Vec<DeployEvent> = Vec::new();
        run_plan(&db, &mut plan, None, RunOptions { stop_on_step_failure: false }, &mut |e| events.push(e));

        let last = events.last().expect("at least one event");
        match last {
            DeployEvent::PlanCompleted { .. } => {} // any PlanCompleted is success here
            other => panic!("expected PlanCompleted, got {:?}", other),
        }
    }

    /// Verify block_on_async works when called from spawn_blocking inside a
    /// tokio runtime. This is exactly the path deploy_ddc_run takes:
    ///   tokio runtime -> spawn_blocking -> run_plan -> block_on_async
    ///
    /// The original bug: block_in_place panics from spawn_blocking threads
    /// because they are not tokio worker threads. The fix (h.block_on directly)
    /// must not panic here.
    #[test]
    fn block_on_async_works_from_spawn_blocking_in_tokio_context() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(async {
            tokio::task::spawn_blocking(|| {
                block_on_async(async { Ok::<i32, UecmError>(42) })
            })
            .await
            .unwrap()
        });
        assert_eq!(result.unwrap(), 42);
    }
}
