//! Tauri commands for reading/writing remote env vars on a single machine.

use cache_core::core::env_vars;
use cache_core::data::{machines as data_machines, Db};
use cache_core::error::{UecmError, UecmResult};
use tauri::State;

fn ip_for(db: &Db, machine_id: i64) -> UecmResult<String> {
    Ok(data_machines::find_by_id(db, machine_id)?
        .ok_or_else(|| UecmError::InvalidInput(format!("machine {} not found", machine_id)))?
        .ip)
}

#[tauri::command]
pub fn set_machine_env_var(
    db: State<'_, Db>,
    machine_id: i64,
    name: String,
    value: String,
) -> UecmResult<()> {
    let host = ip_for(&db, machine_id)?;
    env_vars::set(&host, &name, &value)
}

#[tauri::command]
pub fn get_machine_env_var(
    db: State<'_, Db>,
    machine_id: i64,
    name: String,
) -> UecmResult<Option<String>> {
    let host = ip_for(&db, machine_id)?;
    env_vars::get(&host, &name)
}

#[tauri::command]
pub fn set_machine_env_var_with_credential(
    db: State<'_, Db>,
    machine_id: i64,
    name: String,
    value: String,
    credential_alias: String,
) -> UecmResult<()> {
    let _ = credential_alias; // accepted-but-ignored shim (SSH key auth); Vue still sends it.
    let host = ip_for(&db, machine_id)?;
    env_vars::set(&host, &name, &value)
}

#[tauri::command]
pub fn get_machine_env_var_with_credential(
    db: State<'_, Db>,
    machine_id: i64,
    name: String,
    credential_alias: String,
) -> UecmResult<Option<String>> {
    let _ = credential_alias; // accepted-but-ignored shim (SSH key auth); Vue still sends it.
    let host = ip_for(&db, machine_id)?;
    env_vars::get(&host, &name)
}
