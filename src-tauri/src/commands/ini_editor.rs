//! Tauri commands for reading + writing INI keys on a single remote machine.

use cache_core::core::ini_editor;
use cache_core::data::{machines as data_machines, Db};
use cache_core::error::{UecmError, UecmResult};
use serde::Serialize;
use tauri::State;

fn ip_for(db: &Db, machine_id: i64) -> UecmResult<String> {
    Ok(data_machines::find_by_id(db, machine_id)?
        .ok_or_else(|| UecmError::InvalidInput(format!("machine {} not found", machine_id)))?
        .ip)
}

#[derive(Debug, Serialize)]
pub struct WriteIniResponse {
    pub backup_path: String,
}

#[tauri::command]
pub fn read_ini_section(
    db: State<'_, Db>,
    machine_id: i64,
    file_path: String,
    section: String,
) -> UecmResult<Vec<ini_editor::IniKey>> {
    let host = ip_for(&db, machine_id)?;
    ini_editor::read_section(&host, &file_path, &section)
}

#[tauri::command]
pub fn set_ini_key(
    db: State<'_, Db>,
    machine_id: i64,
    file_path: String,
    section: String,
    name: String,
    value: String,
) -> UecmResult<WriteIniResponse> {
    let host = ip_for(&db, machine_id)?;
    let backup_path = ini_editor::set_key(&host, &file_path, &section, &name, &value)?;
    Ok(WriteIniResponse { backup_path })
}

/// Write one field of a DerivedDataBackendGraph backend node (e.g. the
/// `Shared` node's `Path` / `EnvPathOverride`). Unlike `set_ini_key` (which
/// sets a whole `[section] name=value` line), this edits a sub-field INSIDE a
/// compound backend line — required to wire the file-system shared DDC so UE
/// actually honors `UE-SharedDataCachePath` (the node needs
/// `EnvPathOverride=UE-SharedDataCachePath`, else UE ignores the env var).
#[tauri::command]
pub fn set_machine_backend_field(
    db: State<'_, Db>,
    machine_id: i64,
    file_path: String,
    section: String,
    node_name: String,
    field: String,
    value: String,
) -> UecmResult<String> {
    // Logged so the join's project-INI half (wiring [DerivedDataBackendGraph]
    // Shared Path / EnvPathOverride) leaves an `operations` row on failure.
    let invocation = format!(
        "set backend field [{section}] {node_name}.{field}=\"{value}\" in {file_path} on machine {machine_id}"
    );
    crate::commands::oplog::logged(
        &db,
        "ini.set_backend_field",
        &[machine_id],
        &invocation,
        || {
            let host = ip_for(&db, machine_id)?;
            ini_editor::set_backend_field(&host, &file_path, &section, &node_name, &field, &value)
        },
    )
}

/// Inverse of [`set_machine_backend_field`]: drop one field of a backend node
/// (the `Shared` node's `Path` / `EnvPathOverride`). Used by leave to roll back
/// the join's project-INI wiring so no dormant shared-DDC config lingers once the
/// env var is cleared. Idempotent on the remote side (absent field = success).
#[tauri::command]
pub fn remove_machine_backend_field(
    db: State<'_, Db>,
    machine_id: i64,
    file_path: String,
    section: String,
    node_name: String,
    field: String,
) -> UecmResult<String> {
    let invocation = format!(
        "remove backend field [{section}] {node_name}.{field} in {file_path} on machine {machine_id}"
    );
    crate::commands::oplog::logged(
        &db,
        "ini.remove_backend_field",
        &[machine_id],
        &invocation,
        || {
            let host = ip_for(&db, machine_id)?;
            ini_editor::remove_backend_field(&host, &file_path, &section, &node_name, &field)
        },
    )
}

#[tauri::command]
pub fn read_ini_section_with_credential(
    db: State<'_, Db>,
    machine_id: i64,
    file_path: String,
    section: String,
    credential_alias: String,
) -> UecmResult<Vec<ini_editor::IniKey>> {
    let _ = credential_alias; // accepted-but-ignored shim (SSH key auth); Vue still sends it.
    let host = ip_for(&db, machine_id)?;
    ini_editor::read_section(&host, &file_path, &section)
}

#[tauri::command]
pub fn set_ini_key_with_credential(
    db: State<'_, Db>,
    machine_id: i64,
    file_path: String,
    section: String,
    name: String,
    value: String,
    credential_alias: String,
) -> UecmResult<WriteIniResponse> {
    let _ = credential_alias; // accepted-but-ignored shim (SSH key auth); Vue still sends it.
    let host = ip_for(&db, machine_id)?;
    let backup_path = ini_editor::set_key(&host, &file_path, &section, &name, &value)?;
    Ok(WriteIniResponse { backup_path })
}
