//! Tauri commands for reading/writing remote env vars on a single machine.

use cache_core::core::env_vars;
use cache_core::data::{machines as data_machines, Db};
use cache_core::error::{VoloError, VoloResult};
use tauri::State;

pub(crate) fn ip_for(db: &Db, machine_id: i64) -> VoloResult<String> {
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

#[derive(Debug, Clone, serde::Serialize)]
pub struct DdcRegistryOverrides {
    pub machine_id: i64,
    pub ue_runtime_user: String,
    /// `HKCU\SOFTWARE\Epic Games\GlobalDataCachePath` key exists for that user.
    pub found: bool,
    pub local_path: Option<String>,
    pub shared_path: Option<String>,
}

/// Read `machine_id`'s UE DDC registry overrides (`HKCU\SOFTWARE\Epic Games\
/// GlobalDataCachePath`, values `UE-LocalDataCachePath`/`UE-SharedDataCachePath`)
/// under `ue_runtime_user`'s hive. This is the channel the editor preferences
/// 「全局本地/共享DDC路径」 fields actually read/write (registry only, never ini),
/// and in UE's FFileSystemCacheStoreParams::Parse it beats the same-named env
/// var — so probing only env vars misreports 「未设」 (lanPC 2026-07-12).
/// Requires `ue_runtime_user` (same precondition as zen_read_local_runcontext).
#[tauri::command]
pub async fn get_ddc_registry_overrides(
    db: State<'_, Db>,
    machine_id: i64,
) -> VoloResult<DdcRegistryOverrides> {
    use cache_core::core::zen::ops as node;
    // 同 get_machine_env_var：阻塞 SSH 不进主线程。
    let db: Db = (*db).clone();
    tokio::task::spawn_blocking(move || -> VoloResult<DdcRegistryOverrides> {
        let host = ip_for(&db, machine_id)?;
        let ue_user = data_machines::get_ue_runtime_user(&db, machine_id)?.ok_or_else(|| {
            VoloError::InvalidInput(format!(
                "machine id={machine_id} has no ue_runtime_user set — 先在机器详情①填「UE 运行用户」"
            ))
        })?;
        let env = node::run_node(
            &host,
            "ddc-read-registry.ps1",
            serde_json::json!({ "RuntimeUser": ue_user }),
        )
        .and_then(|raw| node::parse_envelope(&raw, "ddc-read-registry"))?;
        let s = |k: &str| env.get(k).and_then(|v| v.as_str()).map(str::to_string);
        Ok(DdcRegistryOverrides {
            machine_id,
            ue_runtime_user: ue_user,
            found: env.get("found").and_then(|v| v.as_bool()).unwrap_or(false),
            local_path: s("local_path"),
            shared_path: s("shared_path"),
        })
    })
    .await
    .map_err(|e| VoloError::OperationFailed(format!("ddc registry task join: {}", e)))?
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
