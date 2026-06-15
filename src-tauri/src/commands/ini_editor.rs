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
