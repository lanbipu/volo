//! Mesh (LMT) OBJ export Tauri command shim. Business logic in `mesh_app`.

pub use mesh_app::export::{build_cabinet_array, run_export};

use crate::commands::mesh::MeshDb;
use volo_shared::error::VoloResult;

#[tauri::command]
pub fn export_obj(
    state: tauri::State<'_, MeshDb>,
    run_id: i64,
    target: String,
    dst_abs_path: Option<String>,
) -> VoloResult<String> {
    let dst = dst_abs_path.as_deref().map(std::path::Path::new);
    run_export(state.0.clone(), run_id, &target, dst)
}
