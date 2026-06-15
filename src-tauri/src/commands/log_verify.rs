//! Tauri command: pull DDC startup log from a host and return a VerifyReport.

use cache_core::core::ue_log_verify::{self, VerifyReport};
use cache_core::data::Db;
use cache_core::error::UecmError;
use tauri::State;

#[tauri::command]
pub async fn run_log_verify(
    db: State<'_, Db>,
    host: String,
    editor_exe: String,
    project: String,
    timeout: u32,
    credential_alias: Option<String>,
) -> Result<VerifyReport, String> {
    let _ = (&db, credential_alias); // accepted-but-ignored shim (SSH key auth); Vue still sends it.

    tokio::task::spawn_blocking(move || {
        ue_log_verify::run_for_host(&host, &editor_exe, &project, timeout, None)
            .map_err(|e: UecmError| e.to_string())
    })
    .await
    .map_err(|e| format!("task join: {}", e))?
}
