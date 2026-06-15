//! Pull a verbose DDC startup log from one host and convert it to a summary
//! report. Calls parse-ue-log.ps1 sidecar; parses content via ue_log_parser.

use crate::core::ssh::{run_json, NodeScript, SshExecutor};
use crate::core::ue_log_parser::{self, DdcEvent};
use crate::error::{UecmError, UecmResult};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
struct ScriptResult {
    ok: bool,
    log_path: Option<String>,
    content: Option<String>,
    truncated: Option<bool>,
    message: Option<String>,
}

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
pub struct VerifyReport {
    pub host: String,
    pub local_path: Option<String>,
    pub local_writable: Option<bool>,
    pub shared_path: Option<String>,
    pub shared_writable: Option<bool>,
    pub shared_deactivated_reason: Option<String>,
    pub move_collision_count: u64,
    pub maintenance: Vec<MaintenanceFact>,
    pub paks_opened: Vec<String>,
    pub truncated: bool,
    pub log_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
pub struct MaintenanceFact {
    pub layer: String,
    pub file_count: u64,
    pub total_bytes: u64,
}

pub fn summarize(host: &str, log_text: &str, log_path: Option<String>, truncated: bool) -> VerifyReport {
    let mut r = VerifyReport {
        host: host.to_string(),
        local_path: None,
        local_writable: None,
        shared_path: None,
        shared_writable: None,
        shared_deactivated_reason: None,
        move_collision_count: 0,
        maintenance: vec![],
        paks_opened: vec![],
        truncated,
        log_path,
    };
    for line in log_text.lines() {
        match ue_log_parser::parse_line(line) {
            DdcEvent::LocalPath { path, writable } => {
                r.local_path = Some(path);
                r.local_writable = Some(writable);
            }
            DdcEvent::SharedPath { path, writable } => {
                r.shared_path = Some(path);
                r.shared_writable = Some(writable);
            }
            DdcEvent::SharedDeactivated { reason } => {
                r.shared_deactivated_reason = Some(reason);
            }
            DdcEvent::MoveCollision { .. } => {
                r.move_collision_count += 1;
            }
            DdcEvent::MaintenanceFinished { layer, file_count, total_bytes } => {
                r.maintenance.push(MaintenanceFact { layer, file_count, total_bytes });
            }
            DdcEvent::PakOpened { path } => r.paks_opened.push(path),
            DdcEvent::Other => {}
        }
    }
    r
}

pub fn run_for_host(
    host: &str,
    editor_exe: &str,
    project_path: &str,
    timeout_seconds: u32,
    creds: Option<(&str, &str)>,
) -> UecmResult<VerifyReport> {
    let _ = creds; // SSH key auth; per-call WinRM cred no longer used (kept until A5).
    let exec = SshExecutor::from_config()?;
    let result: ScriptResult = run_json(
        &exec,
        host,
        &NodeScript {
            name: "parse-ue-log.ps1",
            args: serde_json::json!({
                "EditorExe": editor_exe,
                "ProjectPath": project_path,
                "TimeoutSeconds": timeout_seconds,
            }),
            ssh_user: None,
        },
    )?;
    if !result.ok {
        return Err(UecmError::OperationFailed(
            result.message.unwrap_or_else(|| "log verify failed".into()),
        ));
    }
    let content = result.content.unwrap_or_default();
    Ok(summarize(host, &content, result.log_path, result.truncated.unwrap_or(false)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summarize_extracts_local_and_shared_paths() {
        let log = "\
LogTemp: irrelevant
LogDerivedDataCache: Using Local data cache path D:\\DDC: Writable
LogDerivedDataCache: Using Shared data cache path \\\\NAS\\DDC: Writable
LogDerivedDataCache: Warning: Move collision when writing \\\\NAS\\DDC\\AB\\foo.udd
LogDerivedDataCache: Warning: Move collision when writing \\\\NAS\\DDC\\AB\\bar.udd
LogDerivedDataCache: Maintenance finished on Local: 25065 files, 1546 MiB
LogDerivedDataCache: Maintenance finished on Shared: 152 files, 30 MiB
";
        let r = summarize("RENDER-01", log, None, false);
        assert_eq!(r.local_path.as_deref(), Some(r"D:\DDC"));
        assert_eq!(r.local_writable, Some(true));
        assert_eq!(r.shared_path.as_deref(), Some(r"\\NAS\DDC"));
        assert_eq!(r.move_collision_count, 2);
        assert_eq!(r.maintenance.len(), 2);
        assert_eq!(r.maintenance[0].layer, "Local");
        assert_eq!(r.maintenance[0].file_count, 25065);
    }

    #[test]
    fn summarize_captures_deactivation_reason() {
        let log = "LogDerivedDataCache: Warning: Shared backend deactivated due to latency (87ms over 70ms threshold)\n";
        let r = summarize("X", log, None, false);
        assert!(r.shared_deactivated_reason.is_some());
    }
}
