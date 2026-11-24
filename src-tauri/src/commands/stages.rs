//! Stage ownership Tauri command shims (LAN-9). Transport translation only —
//! logic lives in `cache_core::data::stages` (membership rows in the cache DB)
//! and `mesh_app::projects::ensure_stage_id` (the Stage document, project.yaml).

use cache_core::data::{stages, Db, StageMembership};
use std::path::Path;
use tauri::State;

/// Return the project's `stage_id`, assigning + persisting one for legacy
/// projects. Call before writing any Cache ownership row for that Stage.
#[tauri::command]
pub fn ensure_project_stage_id(abs_path: String) -> volo_shared::error::VoloResult<String> {
    mesh_app::projects::ensure_stage_id(Path::new(&abs_path))
}

#[tauri::command]
pub fn get_stage_membership(
    db: State<'_, Db>,
    stage_id: String,
) -> cache_core::error::VoloResult<StageMembership> {
    stages::membership(&db, &stage_id)
}

#[tauri::command]
pub fn assign_machine_to_stage(
    db: State<'_, Db>,
    stage_id: String,
    machine_id: i64,
) -> cache_core::error::VoloResult<()> {
    stages::assign_machine(&db, &stage_id, machine_id)
}

#[tauri::command]
pub fn unassign_machine_from_stage(
    db: State<'_, Db>,
    stage_id: String,
    machine_id: i64,
) -> cache_core::error::VoloResult<()> {
    stages::unassign_machine(&db, &stage_id, machine_id)
}

#[tauri::command]
pub fn assign_project_to_stage(
    db: State<'_, Db>,
    stage_id: String,
    project_id: i64,
) -> cache_core::error::VoloResult<()> {
    stages::assign_project(&db, &stage_id, project_id)
}

#[tauri::command]
pub fn unassign_project_from_stage(
    db: State<'_, Db>,
    stage_id: String,
    project_id: i64,
) -> cache_core::error::VoloResult<()> {
    stages::unassign_project(&db, &stage_id, project_id)
}

#[tauri::command]
pub fn list_stages_for_machine(
    db: State<'_, Db>,
    machine_id: i64,
) -> cache_core::error::VoloResult<Vec<String>> {
    stages::stages_for_machine(&db, machine_id)
}

#[tauri::command]
pub fn list_stages_for_project(
    db: State<'_, Db>,
    project_id: i64,
) -> cache_core::error::VoloResult<Vec<String>> {
    stages::stages_for_project(&db, project_id)
}
