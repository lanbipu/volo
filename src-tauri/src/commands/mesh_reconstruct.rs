//! Mesh (LMT) reconstruction Tauri command shims. Business logic in `mesh_app`.

pub use mesh_app::reconstruct::{list_runs_for, read_run_report, run_reconstruction, set_current_run};

use crate::commands::mesh::MeshDb;
use std::path::Path;
use volo_shared::dto::{ReconstructionResult, ReconstructionRun};
use volo_shared::error::VoloResult;

#[tauri::command]
pub fn reconstruct_surface(
    state: tauri::State<'_, MeshDb>,
    project_path: String,
    screen_id: String,
    measurements_path: String,
) -> VoloResult<ReconstructionResult> {
    run_reconstruction(
        state.0.clone(),
        Path::new(&project_path),
        &screen_id,
        &measurements_path,
    )
}

#[tauri::command]
pub fn list_runs(
    state: tauri::State<'_, MeshDb>,
    project_path: String,
    screen_id: Option<String>,
) -> VoloResult<Vec<ReconstructionRun>> {
    list_runs_for(state.0.clone(), &project_path, screen_id.as_deref())
}

#[tauri::command]
pub fn get_run_report(
    state: tauri::State<'_, MeshDb>,
    run_id: i64,
) -> VoloResult<serde_json::Value> {
    read_run_report(state.0.clone(), run_id)
}

#[tauri::command]
pub fn set_run_current(state: tauri::State<'_, MeshDb>, run_id: i64) -> VoloResult<()> {
    set_current_run(state.0.clone(), run_id)
}
