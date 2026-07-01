//! Tauri command for provisioning a local DDC directory on a remote host.
//!
//! Wraps `cache_core::core::local_cache::create` (New-Item + icacls over SSH)
//! so the Cache page's "部署本地 DDC" can actually create the data-dir on the
//! target before pointing `UE-LocalDataCachePath` at it. Undeploy keeps the
//! folder (keep_files semantics) — it just clears the env-var pointer on the
//! frontend — so there is no remote delete here.

use cache_core::core::local_cache;
use cache_core::data::{machines as data_machines, Db};
use cache_core::error::{VoloError, VoloResult};
use tauri::State;

#[tauri::command]
pub fn create_local_cache(
    db: State<'_, Db>,
    machine_id: i64,
    local_path: String,
) -> VoloResult<String> {
    // Logged so a failed local-DDC dir provision leaves an `operations` row.
    let invocation = format!("create local DDC dir {local_path} on machine {machine_id}");
    crate::commands::oplog::logged(&db, "local_cache.create", &[machine_id], &invocation, || {
        let host_ip = data_machines::find_by_id(&db, machine_id)?
            .ok_or_else(|| VoloError::InvalidInput(format!("machine {} not found", machine_id)))?
            .ip;
        // SSH key auth: no per-call operator credential (kept None like create_share).
        local_cache::create(&host_ip, &local_path, None, None)
    })
}
