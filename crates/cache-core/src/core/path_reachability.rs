//! Tests whether a filesystem path a machine currently has configured (env
//! var / registry / project-INI backend field) is actually reachable from
//! that machine right now — backs the "路径失效" badge on the 共享 DDC 配置
//! 通道 panel (a channel value that was written but whose target UNC share
//! has since been torn down / renamed / gone offline).

use crate::core::ssh::{run_json, NodeScript, RemoteExecutor};
use crate::error::{VoloError, VoloResult};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct ScriptResult {
    ok: bool,
    reachable: Option<bool>,
    message: Option<String>,
}

pub fn test_reachable(exec: &dyn RemoteExecutor, host: &str, path: &str) -> VoloResult<bool> {
    let r: ScriptResult = run_json(
        exec,
        host,
        &NodeScript {
            name: "test-path-reachable.ps1",
            args: serde_json::json!({ "Path": path }),
            ssh_user: None,
        },
    )?;
    if !r.ok {
        return Err(VoloError::OperationFailed(r.message.unwrap_or_default()));
    }
    Ok(r.reachable.unwrap_or(false))
}
