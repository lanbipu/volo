//! Tauri commands for DDC cache-retention toggles ("keep cache forever" /
//! "restore default expiry"). Thin transport over `cache_core::core::ddc_retention`;
//! all resolution + writes live in the service layer.

use cache_core::core::ddc_retention;
use cache_core::data::{machines as data_machines, Db};
use cache_core::error::{VoloError, VoloResult};
use tauri::State;

fn ip_for(db: &Db, machine_id: i64) -> VoloResult<String> {
    Ok(data_machines::find_by_id(db, machine_id)?
        .ok_or_else(|| VoloError::InvalidInput(format!("machine {} not found", machine_id)))?
        .ip)
}

/// Pause FileSystem Shared DDC GC (DeleteUnused=false) — cache persists for the project.
#[tauri::command]
pub async fn gc_pause(db: State<'_, Db>, machine_id: i64, project_id: i64) -> VoloResult<String> {
    let db: Db = (*db).clone();
    tokio::task::spawn_blocking(move || {
        let host = ip_for(&db, machine_id)?;
        ddc_retention::pause_gc(&db, project_id, &host)
    })
    .await
    .map_err(|e| VoloError::OperationFailed(format!("gc task join: {}", e)))?
}

/// Resume FileSystem Shared DDC GC (DeleteUnused=true + UnusedFileAge in days).
#[tauri::command]
pub async fn gc_resume(
    db: State<'_, Db>,
    machine_id: i64,
    project_id: i64,
    unused_file_age: u32,
) -> VoloResult<String> {
    let db: Db = (*db).clone();
    tokio::task::spawn_blocking(move || {
        let host = ip_for(&db, machine_id)?;
        ddc_retention::resume_gc(&db, project_id, &host, unused_file_age)
    })
    .await
    .map_err(|e| VoloError::OperationFailed(format!("gc task join: {}", e)))?
}

/// Pause Zen Server GC — set --gc-cache-duration-seconds to ~100 years.
#[tauri::command]
pub async fn zen_gc_pause(db: State<'_, Db>, machine_id: i64, project_id: i64) -> VoloResult<String> {
    let db: Db = (*db).clone();
    tokio::task::spawn_blocking(move || {
        let host = ip_for(&db, machine_id)?;
        ddc_retention::set_zen_gc_duration(&db, project_id, &host, ddc_retention::ZEN_NEVER_EXPIRE_SECONDS)
    })
    .await
    .map_err(|e| VoloError::OperationFailed(format!("zen gc task join: {}", e)))?
}

/// Restore Zen Server GC retention window (seconds; default 1209600 = 14 days).
#[tauri::command]
pub async fn zen_gc_resume(
    db: State<'_, Db>,
    machine_id: i64,
    project_id: i64,
    gc_seconds: u64,
) -> VoloResult<String> {
    let db: Db = (*db).clone();
    tokio::task::spawn_blocking(move || {
        let host = ip_for(&db, machine_id)?;
        ddc_retention::set_zen_gc_duration(&db, project_id, &host, gc_seconds)
    })
    .await
    .map_err(|e| VoloError::OperationFailed(format!("zen gc task join: {}", e)))?
}
