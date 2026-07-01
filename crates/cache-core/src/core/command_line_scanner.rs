//! Scans Windows shortcuts, bat files, and services for embedded DDC
//! command-line overrides like -LocalDataCachePath / -SharedDataCachePath.

use crate::core::ssh::{run_json, NodeScript, RemoteExecutor};
use crate::error::{VoloError, VoloResult};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Deserialize, Serialize, schemars::JsonSchema)]
pub struct CmdLineHit {
    pub source: String,
    #[serde(default)]
    pub name: Option<String>,
    pub path: String,
    #[serde(default)]
    pub cmd: Option<String>,
    pub matches: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
struct ScriptResult {
    ok: bool,
    findings: Option<Vec<CmdLineHit>>,
    message: Option<String>,
}

pub fn scan(exec: &dyn RemoteExecutor, host: &str) -> VoloResult<Vec<CmdLineHit>> {
    let r: ScriptResult = run_json(
        exec,
        host,
        &NodeScript {
            name: "scan-command-line-args.ps1",
            args: serde_json::json!({}),
            ssh_user: None,
        },
    )?;
    if !r.ok {
        return Err(VoloError::OperationFailed(r.message.unwrap_or_default()));
    }
    Ok(r.findings.unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::ssh::{ProbeResult, ScriptOutput};

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
    fn scan_parses_findings() {
        let exec = FakeExec(
            r#"{"ok":true,"findings":[{"source":"service","name":"RenderSvc","path":"x.exe -LocalDataCachePath=D:\\DDC","matches":{"local":"D:\\DDC"}}]}"#
                .to_string(),
        );
        let hits = scan(&exec, "RENDER-01").unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].source, "service");
        assert_eq!(hits[0].matches.get("local").map(String::as_str), Some("D:\\DDC"));
    }

    #[test]
    fn scan_surfaces_not_ok_as_error() {
        let exec = FakeExec(r#"{"ok":false,"message":"boom","findings":[]}"#.to_string());
        assert!(matches!(scan(&exec, "H"), Err(VoloError::OperationFailed(_))));
    }
}
