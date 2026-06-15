//! Single-machine environment variable read/write via PowerShell sidecar.

use crate::core::ssh::{run_json, NodeScript, SshExecutor};
use crate::error::{UecmError, UecmResult};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct SetResult {
    pub ok: bool,
    pub message: String,
}

#[derive(Debug, Deserialize)]
pub struct GetResult {
    pub ok: bool,
    pub value: Option<String>,
    pub message: String,
}

pub fn set(host: &str, name: &str, value: &str) -> UecmResult<()> {
    let exec = SshExecutor::from_config()?;
    let result: SetResult = run_json(
        &exec,
        host,
        &NodeScript {
            name: "setx-machine.ps1",
            args: serde_json::json!({ "Name": name, "Value": value }),
            ssh_user: None,
        },
    )?;
    if !result.ok {
        return Err(UecmError::OperationFailed(format!(
            "set env var failed: {}",
            result.message
        )));
    }
    Ok(())
}

pub fn get(host: &str, name: &str) -> UecmResult<Option<String>> {
    let exec = SshExecutor::from_config()?;
    let result: GetResult = run_json(
        &exec,
        host,
        &NodeScript {
            name: "getx-machine.ps1",
            args: serde_json::json!({ "Name": name }),
            ssh_user: None,
        },
    )?;
    if !result.ok {
        return Err(UecmError::OperationFailed(format!(
            "get env var failed: {}",
            result.message
        )));
    }
    Ok(result.value)
}

// (Old `#[cfg(not(windows))]` "returns PowerShell error" tests removed: set/get now
// go over SSH — on a dev box they error at ssh connect, and from_config would touch
// the real config dir. Remote behavior is validated on a real node.)
