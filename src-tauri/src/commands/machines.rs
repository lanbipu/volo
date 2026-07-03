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

#[derive(Debug, Serialize)]
pub struct UeRuntimeUserRow {
    pub machine_id: i64,
    pub ue_runtime_user: Option<String>,
}

/// Set (or clear, with empty / blank string) `machine_id`'s UE runtime
/// Windows username — the in-app counterpart of `voloctl cache machine
/// set-ue-user`. Zen 的用户全局指向 / 本地端口 / 本地缓存目录 / runcontext
/// 回读都要靠它定位 `C:\Users\<user>\...`；没有 App 内入口时全新环境会
/// 卡死在只能跑 CLI 的指引上。
#[tauri::command]
pub fn set_ue_runtime_user(db: State<'_, Db>, machine_id: i64, ue_user: String) -> VoloResult<()> {
    let trimmed = ue_user.trim();
    let user_opt = if trimmed.is_empty() { None } else { Some(trimmed) };
    data_machines::set_ue_runtime_user(&db, machine_id, user_opt)
}

/// Bulk `ue_runtime_user` read for every machine — hydrates the machine list
/// view's "该机 UE 运行用户" field (Cache · ZenServer ② 客户端指向 · 用户全局
/// scope readiness) without one round trip per machine.
#[tauri::command]
pub fn list_ue_runtime_users(db: State<'_, Db>) -> VoloResult<Vec<UeRuntimeUserRow>> {
    Ok(data_machines::list_ue_runtime_users(&db)?
        .into_iter()
        .map(|(machine_id, ue_runtime_user)| UeRuntimeUserRow {
            machine_id,
            ue_runtime_user,
        })
        .collect())
}
