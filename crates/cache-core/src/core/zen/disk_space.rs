//! Disk-volume capacity for the drive hosting a Zen endpoint's `data_dir`.
//!
//! zen's own `/stats/z$` (see [`crate::core::zen::cache_stats`]) only reports
//! what the cache provider itself has written, never the volume's total
//! capacity — there is no such field in zen's wire format. This module reads
//! it directly off the OS via `[System.IO.DriveInfo]` on the remote node,
//! over the same SSH `-File` channel used elsewhere (`get-disk-space.ps1`).

use crate::core::ssh::{run_json, NodeScript, RemoteExecutor};
use crate::error::{VoloError, VoloResult};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DiskSpace {
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub drive: String,
    #[serde(default)]
    pub total_bytes: u64,
    #[serde(default)]
    pub free_bytes: u64,
    #[serde(default)]
    pub message: Option<String>,
}

/// Query total/free bytes of the disk volume containing `path` (a Windows
/// path like `D:\ZenData`) on `host`.
pub fn run(exec: &dyn RemoteExecutor, host: &str, path: &str) -> VoloResult<DiskSpace> {
    let s: DiskSpace = run_json(
        exec,
        host,
        &NodeScript {
            name: "get-disk-space.ps1",
            args: serde_json::json!({ "Path": path }),
            ssh_user: None,
        },
    )?;
    if !s.ok {
        return Err(VoloError::OperationFailed(
            s.message
                .clone()
                .unwrap_or_else(|| "get-disk-space failed".into()),
        ));
    }
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::ssh::{NodeScript, ProbeResult, RemoteExecutor, ScriptOutput};

    struct FakeExec(String);
    impl RemoteExecutor for FakeExec {
        fn run(&self, _h: &str, _s: &NodeScript) -> VoloResult<ScriptOutput> {
            Ok(ScriptOutput {
                stdout: self.0.clone(),
                stderr: String::new(),
                exit_code: 0,
            })
        }
        fn probe(&self, _h: &str, _u: Option<&str>) -> VoloResult<ProbeResult> {
            unreachable!()
        }
    }

    #[test]
    fn run_parses_disk_space() {
        let exec = FakeExec(
            r#"{"ok":true,"drive":"D:","total_bytes":8796093022208,"free_bytes":3298534883328}"#
                .to_string(),
        );
        let s = run(&exec, "ZEN-SRV-01", r"D:\ZenData").unwrap();
        assert_eq!(s.drive, "D:");
        assert_eq!(s.total_bytes, 8796093022208);
        assert_eq!(s.free_bytes, 3298534883328);
    }

    #[test]
    fn run_errors_when_not_ok() {
        let exec = FakeExec(r#"{"ok":false,"message":"drive not ready"}"#.to_string());
        let err = run(&exec, "ZEN-SRV-01", r"D:\ZenData").unwrap_err();
        assert!(matches!(err, VoloError::OperationFailed(_)));
    }
}
