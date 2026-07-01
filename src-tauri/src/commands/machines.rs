//! Tauri command handlers for machine CRUD + detail lookup.

use cache_core::data::{
    machine_gpus, machine_ue_installs, machines as data_machines, Db, GpuInfo, Machine, UeInstall,
};
use cache_core::error::{VoloError, VoloResult};
use serde::Serialize;
use tauri::State;

#[derive(Debug, Serialize)]
pub struct MachineDetail {
    pub machine: Machine,
    pub ue_installs: Vec<UeInstall>,
    pub gpus: Vec<GpuInfo>,
}

#[tauri::command]
pub fn list_machines(db: State<'_, Db>) -> VoloResult<Vec<Machine>> {
    data_machines::list_all(&db)
}

#[tauri::command]
pub fn add_machine(
    db: State<'_, Db>,
    hostname: String,
    ip: String,
) -> VoloResult<i64> {
    let machine = Machine::new(&hostname, &ip);
    data_machines::insert(&db, &machine)
}

#[tauri::command]
pub fn delete_machine(db: State<'_, Db>, id: i64) -> VoloResult<()> {
    data_machines::delete(&db, id)
}

#[tauri::command]
pub fn rename_machine(db: State<'_, Db>, id: i64, hostname: String) -> VoloResult<()> {
    data_machines::rename(&db, id, &hostname)
}

#[tauri::command]
pub fn get_machine_detail(db: State<'_, Db>, id: i64) -> VoloResult<MachineDetail> {
    let machine = data_machines::find_by_id(&db, id)?
        .ok_or_else(|| VoloError::InvalidInput(format!("machine {} not found", id)))?;
    let ue_installs = machine_ue_installs::list_for_machine(&db, id)?;
    let gpus = machine_gpus::list_for_machine(&db, id)?;
    Ok(MachineDetail {
        machine,
        ue_installs,
        gpus,
    })
}
