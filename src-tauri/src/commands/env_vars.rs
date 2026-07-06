//! Tauri commands for reading/writing remote env vars on a single machine.

use cache_core::core::env_vars;
use cache_core::data::{machines as data_machines, Db};
use cache_core::error::{VoloError, VoloResult};
use tauri::State;

fn ip_for(db: &Db, machine_id: i64) -> VoloResult<String> {
    Ok(data_machines::find_by_id(db, machine_id)?
        .ok_or_else(|| VoloError::InvalidInput(format!("machine {} not found", machine_id)))?
        .ip)
}

#[tauri::command]
pub async fn set_machine_env_var(
    db: State<'_, Db>,
    machine_id: i64,
    name: String,
    value: String,
) -> VoloResult<()> {
    let db: Db = (*db).clone();
    tokio::task::spawn_blocking(move || {
        // Logged so a failed share join/leave (this is the join's env-var half) or
        // local-DDC pointer write leaves an `operations` row with the exact error.
        let invocation = format!("set env var {name}=\"{value}\" on machine {machine_id}");
        crate::commands::oplog::logged(&db, "env.set_machine_var", &[machine_id], &invocation, || {
            let host = ip_for(&db, machine_id)?;
            env_vars::set(&host, &name, &value)
        })
    })
    .await
    .map_err(|e| VoloError::OperationFailed(format!("env var task join: {}", e)))?
}

#[tauri::command]
pub async fn get_machine_env_var(
    db: State<'_, Db>,
    machine_id: i64,
    name: String,
) -> VoloResult<Option<String>> {
    // 同 run_health_check：同步阻塞 SSH 跑在 Tauri 主线程会冻结 UI（Cache 子页挂载时
    // 逐台 fan-out 本命令是切页卡顿主因之一）→ async + spawn_blocking。
    let db: Db = (*db).clone();
    tokio::task::spawn_blocking(move || {
        let host = ip_for(&db, machine_id)?;
        env_vars::get(&host, &name)
    })
    .await
    .map_err(|e| VoloError::OperationFailed(format!("env var task join: {}", e)))?
}

#[tauri::command]
pub async fn set_machine_env_var_with_credential(
    db: State<'_, Db>,
    machine_id: i64,
    name: String,
    value: String,
    credential_alias: String,
) -> VoloResult<()> {
    let db: Db = (*db).clone();
    tokio::task::spawn_blocking(move || {
        let _ = credential_alias; // accepted-but-ignored shim (SSH key auth); Vue still sends it.
        let host = ip_for(&db, machine_id)?;
        env_vars::set(&host, &name, &value)
    })
    .await
    .map_err(|e| VoloError::OperationFailed(format!("env var task join: {}", e)))?
}

#[tauri::command]
pub async fn get_machine_env_var_with_credential(
    db: State<'_, Db>,
    machine_id: i64,
    name: String,
    credential_alias: String,
) -> VoloResult<Option<String>> {
    let _ = credential_alias; // accepted-but-ignored shim (SSH key auth); Vue still sends it.
    // 与 get_machine_env_var 同体：同样 async + spawn_blocking，避免阻塞 SSH 冻结 UI。
    let db: Db = (*db).clone();
    tokio::task::spawn_blocking(move || {
        let host = ip_for(&db, machine_id)?;
        env_vars::get(&host, &name)
    })
    .await
    .map_err(|e| VoloError::OperationFailed(format!("env var task join: {}", e)))?
}
