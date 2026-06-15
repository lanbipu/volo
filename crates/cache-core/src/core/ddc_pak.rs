//! High-level DDC Pak generation helpers.

use crate::core::ssh::{run_json, NodeScript, SshExecutor};
use crate::core::ue_runner::{self, UeRunSpec, UeRunnerBackend};
use crate::error::{UecmError, UecmResult};
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
    message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PakOutput {
    pub path: String,
    pub size_bytes: i64,
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
) -> UecmResult<()> {
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
        return Err(UecmError::OperationFailed(
            result.message.unwrap_or_else(|| "preflight failed".into()),
        ));
    }
    if !result.exe_exists {
        return Err(UecmError::InvalidInput(
            "UnrealEditor.exe not found at engine_path".into(),
        ));
    }
    if !result.proj_exists {
        return Err(UecmError::InvalidInput(
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
) -> UecmResult<PakOutput> {
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
        return Err(UecmError::OperationFailed(
            result.message.unwrap_or_else(|| "pak verify failed".into()),
        ));
    }
    if !result.found {
        return Err(UecmError::OperationFailed(
            ".ddp not found after generation".into(),
        ));
    }
    let size_bytes = result.size.parse().unwrap_or_default();
    Ok(PakOutput {
        path: result.path,
        size_bytes,
    })
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
    })
}

// (Old `#[cfg(not(windows))]` "returns PowerShell error" tests for preflight/
// verify_output removed: both now go over SSH — they error at ssh connect and
// from_config would touch the real config dir. Remote behavior is validated on a
// real node; the pak generation itself runs through ue_runner.)
