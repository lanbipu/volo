//! Mesh (LMT) measurements Tauri command shim. Business logic in `mesh_app`.

pub use mesh_app::measurements::load_measurements_from_path;

use mesh_core::measured_points::MeasuredPoints;
use std::path::Path;
use volo_shared::error::VoloResult;

#[tauri::command]
pub fn load_measurements_yaml(path: String) -> VoloResult<MeasuredPoints> {
    load_measurements_from_path(Path::new(&path))
}
