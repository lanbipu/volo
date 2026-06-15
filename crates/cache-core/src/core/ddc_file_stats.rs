//! Probe file count + total size for Local DDC and Shared DDC paths on a
//! remote host, then classify imbalance signals (the SOP case study).

use crate::core::ssh::{run_json, NodeScript, RemoteExecutor};
use crate::error::{UecmError, UecmResult};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct LayerStat {
    pub path: String,
    pub ok: bool,
    #[serde(default)]
    pub file_count: u64,
    #[serde(default)]
    pub total_bytes: u64,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Stats {
    #[serde(default)]
    pub ok: bool,
    pub local: LayerStat,
    pub shared: LayerStat,
}

pub fn run(
    exec: &dyn RemoteExecutor,
    host: &str,
    local_path: &str,
    shared_path: &str,
) -> UecmResult<Stats> {
    let s: Stats = run_json(
        exec,
        host,
        &NodeScript {
            name: "ddc-file-stats.ps1",
            args: serde_json::json!({ "LocalPath": local_path, "SharedPath": shared_path }),
            ssh_user: None,
        },
    )?;
    if !s.ok {
        return Err(UecmError::OperationFailed("ddc-file-stats failed".into()));
    }
    Ok(s)
}

#[derive(Debug, Clone, Serialize)]
pub struct ImbalanceFinding {
    pub local_count: u64,
    pub shared_count: u64,
    pub local_bytes: u64,
    pub shared_bytes: u64,
    pub severity: &'static str,
    pub message: String,
}

pub fn classify_imbalance(s: &Stats) -> Option<ImbalanceFinding> {
    if !s.local.ok || !s.shared.ok {
        return None;
    }
    if s.local.file_count == 0 {
        return None;
    }
    let ratio = (s.shared.file_count as f64) / (s.local.file_count as f64);
    if ratio < 0.05 && s.local.file_count > 500 {
        return Some(ImbalanceFinding {
            local_count: s.local.file_count,
            shared_count: s.shared.file_count,
            local_bytes: s.local.total_bytes,
            shared_bytes: s.shared.total_bytes,
            severity: "critical",
            message: format!(
                "Shared DDC has {} files vs Local {} ({}x lower). Likely the first host that opened the project did so before Shared was configured -- re-open the project on that host or generate a DDC Pak.",
                s.shared.file_count,
                s.local.file_count,
                (1.0 / ratio.max(1e-9)) as u64
            ),
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::ssh::{NodeScript, ProbeResult, RemoteExecutor, ScriptOutput};

    struct FakeExec(String);
    impl RemoteExecutor for FakeExec {
        fn run(&self, _h: &str, _s: &NodeScript) -> UecmResult<ScriptOutput> {
            Ok(ScriptOutput { stdout: self.0.clone(), stderr: String::new(), exit_code: 0 })
        }
        fn probe(&self, _h: &str, _u: Option<&str>) -> UecmResult<ProbeResult> {
            unreachable!()
        }
    }

    #[test]
    fn run_parses_layer_stats() {
        let exec = FakeExec(
            r#"{"ok":true,"local":{"path":"D:\\DDC","ok":true,"file_count":10,"total_bytes":2048},"shared":{"path":"X","ok":true,"file_count":5,"total_bytes":1024}}"#
                .to_string(),
        );
        let s = run(&exec, "RENDER-01", "D:\\DDC", "X").unwrap();
        assert_eq!(s.local.file_count, 10);
        assert_eq!(s.shared.total_bytes, 1024);
    }

    fn stat(ok: bool, n: u64) -> LayerStat {
        LayerStat {
            path: "p".into(),
            ok,
            file_count: n,
            total_bytes: n * 1024,
            error: None,
        }
    }

    #[test]
    fn flags_classic_imbalance_case() {
        // SOP case study: Local 25065 files, Shared 152 files.
        let s = Stats {
            ok: true,
            local: stat(true, 25065),
            shared: stat(true, 152),
        };
        let f = classify_imbalance(&s).unwrap();
        assert_eq!(f.severity, "critical");
        assert_eq!(f.local_count, 25065);
        assert_eq!(f.shared_count, 152);
    }

    #[test]
    fn silent_when_balanced() {
        let s = Stats {
            ok: true,
            local: stat(true, 25065),
            shared: stat(true, 24000),
        };
        assert!(classify_imbalance(&s).is_none());
    }

    #[test]
    fn silent_when_either_layer_failed() {
        let s = Stats {
            ok: true,
            local: stat(true, 25065),
            shared: stat(false, 0),
        };
        assert!(classify_imbalance(&s).is_none());
    }

    #[test]
    fn silent_when_local_is_tiny() {
        // Below the 500-file threshold, even ratio < 0.05 doesn't fire (would be noisy on cold caches).
        let s = Stats {
            ok: true,
            local: stat(true, 200),
            shared: stat(true, 5),
        };
        assert!(classify_imbalance(&s).is_none());
    }
}
