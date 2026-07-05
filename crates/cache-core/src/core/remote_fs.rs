//! Remote directory listing through the `list-remote-dirs.ps1` sidecar —
//! powers the DDC PAK 搜索根目录 address-bar drill-down (real folders on the
//! chosen machine, not guessed ones).

use crate::core::ssh::{run_json, NodeScript, SshExecutor};
use crate::error::{VoloError, VoloResult};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct ListDirScriptResult {
    ok: bool,
    entries: Vec<String>,
    #[serde(default)]
    message: Option<String>,
}

/// `path = None`/empty → the machine's fixed local drives (e.g. `["C:", "D:"]`).
/// Otherwise → immediate subdirectory names under `path`.
pub fn list_remote_dirs(host: &str, path: Option<&str>) -> VoloResult<Vec<String>> {
    let exec = SshExecutor::from_config()?;
    let result: ListDirScriptResult = run_json(
        &exec,
        host,
        &NodeScript {
            name: "list-remote-dirs.ps1",
            args: serde_json::json!({ "Path": path }),
            ssh_user: None,
        },
    )?;
    if !result.ok {
        return Err(VoloError::OperationFailed(
            result.message.unwrap_or_else(|| "list directories failed".into()),
        ));
    }
    Ok(result.entries)
}
