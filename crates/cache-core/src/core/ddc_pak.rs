//! High-level DDC Pak generation helpers.

use crate::core::ssh::{run_json, NodeScript, SshExecutor};
use crate::core::ue_runner::{self, UeRunSpec, UeRunnerBackend};
use crate::data::Db;
use crate::error::{VoloError, VoloResult};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
struct PreflightRaw {
    ok: bool,
    #[serde(default)]
    exe_exists: bool,
    #[serde(default)]
    proj_exists: bool,
    #[serde(default)]
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct VerifyRaw {
    ok: bool,
    #[serde(default)]
    found: bool,
    #[serde(default)]
    path: String,
    #[serde(default)]
    size: String,
    #[serde(default)]
    last_write: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DeleteRaw {
    ok: bool,
    #[serde(default)]
    message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PakOutput {
    pub path: String,
    pub size_bytes: i64,
    /// File mtime (RFC 3339 UTC), when the verify script reported one.
    /// `None` for outputs verified before this field existed / local paks
    /// whose mtime read failed.
    pub modified_at: Option<String>,
}

/// One (project, machine) location where a DDC pak was found by
/// `scan_deployed`. The frontend groups these by `project_id` — it already
/// holds full project/machine identity (`UE_PROJECTS`/`RENDER_NODES`) and
/// picks a "source" using the same primary-machine preference it applies
/// elsewhere, so this DTO stays a flat fact list rather than pre-aggregating.
#[derive(Debug, Clone, Serialize)]
pub struct DeployedPakEntry {
    pub project_id: i64,
    pub machine_id: i64,
    pub pak_path: String,
    pub size_bytes: i64,
    pub modified_at: Option<String>,
}

fn default_extra_args() -> Vec<String> {
    vec![
        "-run=DerivedDataCache".into(),
        "-fill".into(),
        "-DDC=CreatePak".into(),
        "-unattended".into(),
        "-nopause".into(),
        "-nosplash".into(),
    ]
}

pub fn preflight(
    host: &str,
    engine_path: &str,
    project_path: &str,
    user: Option<&str>,
    pass: Option<&str>,
) -> VoloResult<()> {
    let _ = (user, pass); // SSH key auth; per-call WinRM cred ignored (kept until A5).
    let exec = SshExecutor::from_config()?;
    let result: PreflightRaw = run_json(
        &exec,
        host,
        &NodeScript {
            name: "generate-ddc-pak.ps1",
            args: serde_json::json!({ "EnginePath": engine_path, "ProjectPath": project_path }),
            ssh_user: None,
        },
    )?;
    if !result.ok {
        return Err(VoloError::OperationFailed(
            result.message.unwrap_or_else(|| "preflight failed".into()),
        ));
    }
    if !result.exe_exists {
        return Err(VoloError::InvalidInput(
            "UnrealEditor.exe not found at engine_path".into(),
        ));
    }
    if !result.proj_exists {
        return Err(VoloError::InvalidInput(
            ".uproject not found at project_path".into(),
        ));
    }
    Ok(())
}

pub fn verify_output(
    host: &str,
    project_dir: &str,
    user: Option<&str>,
    pass: Option<&str>,
) -> VoloResult<PakOutput> {
    let _ = (user, pass); // SSH key auth; per-call WinRM cred ignored (kept until A5).
    let exec = SshExecutor::from_config()?;
    let result: VerifyRaw = run_json(
        &exec,
        host,
        &NodeScript {
            name: "verify-pak-output.ps1",
            args: serde_json::json!({ "ProjectDir": project_dir }),
            ssh_user: None,
        },
    )?;
    if !result.ok {
        return Err(VoloError::OperationFailed(
            result.message.unwrap_or_else(|| "pak verify failed".into()),
        ));
    }
    if !result.found {
        return Err(VoloError::OperationFailed(
            ".ddp not found after generation".into(),
        ));
    }
    let size_bytes = result.size.parse().unwrap_or_default();
    Ok(PakOutput {
        path: result.path,
        size_bytes,
        modified_at: result.last_write,
    })
}

/// Local-backend counterpart of `verify_output`: checks the pak on the
/// operator's own filesystem instead of over SSH.
pub fn verify_output_local(project_dir: &str) -> VoloResult<PakOutput> {
    let path = std::path::Path::new(project_dir)
        .join("DerivedDataCache")
        .join("DDC.ddp");
    if path.exists() {
        let meta = std::fs::metadata(&path).map_err(VoloError::Io)?;
        let size = meta.len() as i64;
        if size > 0 {
            let modified_at = meta
                .modified()
                .ok()
                .map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339());
            return Ok(PakOutput {
                path: path.to_string_lossy().to_string(),
                size_bytes: size,
                modified_at,
            });
        }
    }
    Err(VoloError::OperationFailed(
        "DDC.ddp not found locally".into(),
    ))
}

/// Deletes the generated DDC pak on a remote host over SSH. Idempotent-ish:
/// the script no-ops (but still `ok`) when the file is already gone.
pub fn delete_output(host: &str, project_dir: &str) -> VoloResult<()> {
    let exec = SshExecutor::from_config()?;
    let result: DeleteRaw = run_json(
        &exec,
        host,
        &NodeScript {
            name: "delete-pak-output.ps1",
            args: serde_json::json!({ "ProjectDir": project_dir }),
            ssh_user: None,
        },
    )?;
    if !result.ok {
        return Err(VoloError::OperationFailed(
            result.message.unwrap_or_else(|| "pak delete failed".into()),
        ));
    }
    Ok(())
}

/// Local-backend counterpart of `delete_output`.
pub fn delete_output_local(project_dir: &str) -> VoloResult<()> {
    let path = std::path::Path::new(project_dir)
        .join("DerivedDataCache")
        .join("DDC.ddp");
    if path.exists() {
        std::fs::remove_file(&path).map_err(VoloError::Io)?;
    }
    Ok(())
}

/// Fans out `verify_output` across every known (project, machine) location to
/// find already-generated DDC paks. Per-location failures (no pak there yet,
/// unreachable host, …) are dropped silently — that is the expected common
/// case, not an error worth surfacing.
pub async fn scan_deployed(db: &Db) -> VoloResult<Vec<DeployedPakEntry>> {
    let projects = crate::data::projects::list(db)?;
    // Bounded like the existing batch fan-out (core::batch::run_batch): unbounded
    // spawn_blocking here would open one SSH process per (project, location) at
    // once, which scales badly and can hit the remote sshd's MaxStartups.
    let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(
        crate::core::batch::DEFAULT_MAX_CONCURRENCY,
    ));
    let mut handles = Vec::new();
    for project in &projects {
        let project_id = match project.id {
            Some(id) => id,
            None => continue,
        };
        for loc in crate::data::project_locations::list_by_project(db, project_id)? {
            let machine = match crate::data::machines::find_by_id(db, loc.machine_id)? {
                Some(m) => m,
                None => continue,
            };
            let host = machine.ip;
            let abs_path = loc.abs_path;
            let machine_id = loc.machine_id;
            // Acquired on the async side before spawning: the loop itself stalls
            // here once all permits are checked out, throttling how many blocking
            // SSH calls are in flight rather than racing them all immediately.
            let permit = semaphore.clone().acquire_owned().await.map_err(|err| {
                VoloError::OperationFailed(format!("scan_deployed semaphore closed: {err}"))
            })?;
            handles.push(tokio::task::spawn_blocking(move || {
                let _permit = permit; // held until this task finishes, then released
                let result = verify_output(&host, &abs_path, None, None);
                (project_id, machine_id, result)
            }));
        }
    }
    let mut out = Vec::new();
    for handle in handles {
        if let Ok((project_id, machine_id, Ok(pak))) = handle.await {
            out.push(DeployedPakEntry {
                project_id,
                machine_id,
                pak_path: pak.path,
                size_bytes: pak.size_bytes,
                modified_at: pak.modified_at,
            });
        }
    }
    Ok(out)
}

pub fn launch_generation(
    backend: UeRunnerBackend,
    host: &str,
    engine_path: &str,
    project_path: &str,
    user: Option<&str>,
    pass: Option<&str>,
) -> ue_runner::RunnerHandle {
    ue_runner::run(UeRunSpec {
        backend,
        host: host.to_string(),
        engine_path: engine_path.to_string(),
        project_path: project_path.to_string(),
        extra_args: default_extra_args(),
        credential_user: user.map(String::from),
        credential_pass: pass.map(String::from),
        interactive: false,
        hold_ssh_session: false,
    })
}

// (Old `#[cfg(not(windows))]` "returns PowerShell error" tests for preflight/
// verify_output removed: both now go over SSH — they error at ssh connect and
// from_config would touch the real config dir. Remote behavior is validated on a
// real node; the pak generation itself runs through ue_runner.)
