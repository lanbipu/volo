//! Tauri commands for cluster batch ops. Each command resolves credentials
//! once, then fans out to N machines via core::batch::run_batch, forwarding
//! progress events to the frontend via the `batch-progress` Tauri event.

use cache_core::core::{batch, env_vars, ini_editor};
use cache_core::data::{machines as data_machines, Db};
use cache_core::error::{UecmError, UecmResult};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

const BATCH_EVENT_NAME: &str = "batch-progress";

fn ip_for(db: &Db, machine_id: i64) -> UecmResult<String> {
    Ok(data_machines::find_by_id(db, machine_id)?
        .ok_or_else(|| UecmError::InvalidInput(format!("machine {} not found", machine_id)))?
        .ip)
}

#[tauri::command]
pub async fn batch_set_env_var(
    db: State<'_, Db>,
    app: AppHandle,
    machine_ids: Vec<i64>,
    name: String,
    value: String,
    credential_alias: String,
) -> UecmResult<()> {
    let _ = credential_alias; // accepted-but-ignored shim (SSH key auth); Vue still sends it.
    let ips: Vec<(i64, String)> = machine_ids
        .iter()
        .map(|id| ip_for(&db, *id).map(|ip| (*id, ip)))
        .collect::<UecmResult<Vec<_>>>()?;
    let ip_lookup: std::collections::HashMap<i64, String> = ips.into_iter().collect();
    let name = Arc::new(name);
    let value = Arc::new(value);

    let mut rx = batch::run_batch(machine_ids, batch::DEFAULT_MAX_CONCURRENCY, {
        let name = name.clone();
        let value = value.clone();
        let ip_lookup = ip_lookup.clone();
        move |machine_id| {
            let name = name.clone();
            let value = value.clone();
            let host = ip_lookup.get(&machine_id).cloned();
            async move {
                let host = host.ok_or_else(|| {
                    UecmError::InvalidInput(format!("machine {} not in lookup", machine_id))
                })?;
                tokio::task::spawn_blocking(move || {
                    env_vars::set(&host, &name, &value)
                })
                .await
                .map_err(|e| UecmError::OperationFailed(format!("join error: {}", e)))?
            }
        }
    })
    .await;

    while let Some(ev) = rx.recv().await {
        let _ = app.emit(BATCH_EVENT_NAME, ev);
    }
    Ok(())
}

#[tauri::command]
pub async fn batch_set_ini_key(
    db: State<'_, Db>,
    app: AppHandle,
    machine_ids: Vec<i64>,
    file_path: String,
    section: String,
    name: String,
    value: String,
    credential_alias: String,
) -> UecmResult<()> {
    let _ = credential_alias; // accepted-but-ignored shim (SSH key auth); Vue still sends it.
    let ips: Vec<(i64, String)> = machine_ids
        .iter()
        .map(|id| ip_for(&db, *id).map(|ip| (*id, ip)))
        .collect::<UecmResult<Vec<_>>>()?;
    let ip_lookup: std::collections::HashMap<i64, String> = ips.into_iter().collect();
    let file_path = Arc::new(file_path);
    let section = Arc::new(section);
    let name = Arc::new(name);
    let value = Arc::new(value);

    let mut rx = batch::run_batch(machine_ids, batch::DEFAULT_MAX_CONCURRENCY, {
        let file_path = file_path.clone();
        let section = section.clone();
        let name = name.clone();
        let value = value.clone();
        let ip_lookup = ip_lookup.clone();
        move |machine_id| {
            let file_path = file_path.clone();
            let section = section.clone();
            let name = name.clone();
            let value = value.clone();
            let host = ip_lookup.get(&machine_id).cloned();
            async move {
                let host = host.ok_or_else(|| {
                    UecmError::InvalidInput(format!("machine {} not in lookup", machine_id))
                })?;
                tokio::task::spawn_blocking(move || {
                    ini_editor::set_key(&host, &file_path, &section, &name, &value)
                        .map(|_backup| ())
                })
                .await
                .map_err(|e| UecmError::OperationFailed(format!("join error: {}", e)))?
            }
        }
    })
    .await;

    while let Some(ev) = rx.recv().await {
        let _ = app.emit(BATCH_EVENT_NAME, ev);
    }
    Ok(())
}
