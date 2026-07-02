//! PSO cache collection helpers.

use crate::core::{
    gpu_consistency,
    ue_runner::{self, UeRunSpec, UeRunnerBackend},
};
use crate::data::{machine_gpus, pso_cache_files, Db, PsoCacheFile};
use crate::error::{VoloError, VoloResult};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PsoCollectSpec {
    pub project_id: i64,
    pub source_machine_id: i64,
    pub ue_version: Option<String>,
    pub resolution: (u32, u32),
    pub windowed: bool,
    pub max_minutes: u32,
}

impl Default for PsoCollectSpec {
    fn default() -> Self {
        Self {
            project_id: 0,
            source_machine_id: 0,
            ue_version: None,
            resolution: (1920, 1080),
            windowed: true,
            max_minutes: 10,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EnumeratedFile {
    pub file_path: String,
    pub file_name: String,
    pub size_bytes: i64,
}

#[derive(Debug, Deserialize)]
struct ListScriptResult {
    ok: bool,
    #[serde(default)]
    items: Vec<ListItemRaw>,
    #[serde(default)]
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ListItemRaw {
    file_path: String,
    file_name: String,
    size: String,
}

pub fn build_ue_args(spec: &PsoCollectSpec) -> Vec<String> {
    let (width, height) = spec.resolution;
    let mut args = vec!["-game".into()];
    if spec.windowed {
        args.push("-windowed".into());
    }
    args.push(format!("-resx={}", width));
    args.push(format!("-resy={}", height));
    args.push("-log".into());
    args.push("-unattended".into());
    args.push(
        "-ExecCmds=r.ShaderPipelineCache.Enabled 1; r.ShaderPipelineCache.LogPSO 1; r.PSO.WarmingTime 0"
            .into(),
    );
    args
}

pub fn launch_collection(
    backend: UeRunnerBackend,
    host: &str,
    engine_path: &str,
    project_path: &str,
    spec: &PsoCollectSpec,
    user: Option<&str>,
    pass: Option<&str>,
) -> ue_runner::RunnerHandle {
    ue_runner::run(UeRunSpec {
        backend,
        host: host.into(),
        engine_path: engine_path.into(),
        project_path: project_path.into(),
        extra_args: build_ue_args(spec),
        credential_user: user.map(str::to_string),
        credential_pass: pass.map(str::to_string),
        interactive: false,
    })
}

pub fn enumerate_remote(
    host: &str,
    project_dir: &str,
    user: Option<&str>,
    pass: Option<&str>,
) -> VoloResult<Vec<EnumeratedFile>> {
    if crate::core::loopback::is_loopback_target(host) {
        return enumerate_local(project_dir);
    }

    let _ = (user, pass); // SSH key auth; per-call WinRM cred ignored until A5.
    let exec = crate::core::ssh::SshExecutor::from_config()?;
    let result: ListScriptResult = crate::core::ssh::run_json(
        &exec,
        host,
        &crate::core::ssh::NodeScript {
            name: "list-pso-cache-files.ps1",
            args: serde_json::json!({ "ProjectDir": project_dir }),
            ssh_user: None,
        },
    )?;
    if !result.ok {
        return Err(VoloError::OperationFailed(
            result.message.unwrap_or_else(|| "PSO file enumeration failed".into()),
        ));
    }
    Ok(result
        .items
        .into_iter()
        .map(|item| EnumeratedFile {
            file_path: item.file_path,
            file_name: item.file_name,
            size_bytes: item.size.parse().unwrap_or_default(),
        })
        .collect())
}

fn enumerate_local(project_dir: &str) -> VoloResult<Vec<EnumeratedFile>> {
    let dir = std::path::Path::new(project_dir)
        .join("Saved")
        .join("CollectedPSOs");
    let mut files = Vec::new();
    let entries = std::fs::read_dir(&dir).map_err(VoloError::Io)?;
    for entry in entries {
        let entry = entry.map_err(VoloError::Io)?;
        let path = entry.path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        let lower = name.to_lowercase();
        let is_target = lower.ends_with(".upipelinecache") || lower.ends_with(".stablepc.csv");
        if !is_target { continue; }
        let metadata = entry.metadata().map_err(VoloError::Io)?;
        files.push(EnumeratedFile {
            file_path: path.to_string_lossy().to_string(),
            file_name: entry.file_name().to_string_lossy().to_string(),
            size_bytes: metadata.len() as i64,
        });
    }
    Ok(files)
}

pub fn gpu_signature_for_machine(db: &Db, machine_id: i64) -> VoloResult<String> {
    let rows = machine_gpus::list_for_machine(db, machine_id)?;
    let gpu = rows
        .first()
        .ok_or_else(|| VoloError::InvalidInput(format!("machine {} has no GPU rows", machine_id)))?;
    Ok(gpu_consistency::signature_from_gpu(gpu).as_string())
}

pub fn finalize_persist(
    db: &Db,
    project_id: i64,
    source_machine_id: i64,
    ue_version: Option<&str>,
    files: &[EnumeratedFile],
) -> VoloResult<Vec<i64>> {
    let signature = gpu_signature_for_machine(db, source_machine_id)?;
    let mut ids = Vec::with_capacity(files.len());
    for file in files {
        ids.push(pso_cache_files::upsert(
            db,
            &PsoCacheFile {
                id: None,
                project_id,
                source_machine_id,
                file_path: file.file_path.clone(),
                file_name: file.file_name.clone(),
                size_bytes: file.size_bytes,
                gpu_signature: signature.clone(),
                ue_version: ue_version.map(str::to_string),
                collected_at: None,
            },
        )?);
    }
    Ok(ids)
}

pub fn spawn_watchdog(
    cancel: Arc<Mutex<crate::core::ue_runner::RunnerCancel>>,
    max_minutes: u32,
    job_id: String,
) {
    if max_minutes == 0 {
        return;
    }
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(max_minutes as u64 * 60)).await;
        let mut state = cancel.lock().await;
        if !state.requested {
            state.requested = true;
            // Planned-duration stop, not an abort — consumers (warmup finalize)
            // distinguish this from a user cancel via the flag.
            state.watchdog = true;
            tracing::info!("pso collection watchdog fired for job {}", job_id);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::{machine_gpus, machines, open_in_memory, schema, GpuInfo, GpuVendor, Machine};

    #[test]
    fn build_ue_args_includes_resolution_and_exec_cmds() {
        let spec = PsoCollectSpec::default();
        let args = build_ue_args(&spec);
        assert!(args.iter().any(|arg| arg == "-game"));
        assert!(args.iter().any(|arg| arg == "-windowed"));
        assert!(args.iter().any(|arg| arg == "-resx=1920"));
        assert!(args.iter().any(|arg| arg == "-resy=1080"));
        assert_eq!(
            args.iter().filter(|arg| arg.starts_with("-ExecCmds=")).count(),
            1
        );
    }

    #[test]
    fn build_ue_args_skips_windowed_when_false() {
        let spec = PsoCollectSpec {
            windowed: false,
            resolution: (320, 240),
            ..PsoCollectSpec::default()
        };
        let args = build_ue_args(&spec);
        assert!(!args.iter().any(|arg| arg == "-windowed"));
        assert!(args.iter().any(|arg| arg == "-resx=320"));
        assert!(args.iter().any(|arg| arg == "-resy=240"));
    }

    #[test]
    fn finalize_persist_uses_source_gpu_signature() {
        let db = open_in_memory().unwrap();
        {
            let mut conn = db.lock().unwrap();
            schema::migrate(&mut conn).unwrap();
        }
        let machine_id = machines::insert(&db, &Machine::new("SOURCE", "192.168.10.21")).unwrap();
        let project_id = {
            let conn = db.lock().unwrap();
            conn.execute(
                "INSERT INTO projects (uproject_name, uproject_stem_lower) VALUES ('X.uproject', 'x')",
                [],
            )
            .unwrap();
            conn.last_insert_rowid()
        };
        machine_gpus::insert(
            &db,
            &GpuInfo {
                id: None,
                machine_id,
                gpu_model: "RTX 4090".into(),
                driver_version: "551.86".into(),
                vendor: GpuVendor::Nvidia,
                vram_mb: Some(24576),
            },
        )
        .unwrap();

        let ids = finalize_persist(
            &db,
            project_id,
            machine_id,
            Some("5.4.4"),
            &[EnumeratedFile {
                file_path: "D:\\X\\Saved\\CollectedPSOs\\X.upipelinecache".into(),
                file_name: "X.upipelinecache".into(),
                size_bytes: 512,
            }],
        )
        .unwrap();
        assert_eq!(ids.len(), 1);
        let files = pso_cache_files::list_by_project(&db, project_id).unwrap();
        assert_eq!(files[0].gpu_signature, "nvidia:rtx 4090:551.86");
    }
}
