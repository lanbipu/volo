//! Tauri command for GPU consistency matrix.

use cache_core::core::gpu_consistency::{self, GpuMatrix};
use cache_core::data::Db;
use cache_core::error::VoloResult;
use tauri::State;

#[tauri::command]
pub fn get_gpu_consistency_matrix(db: State<'_, Db>) -> VoloResult<GpuMatrix> {
    gpu_consistency::build_matrix(&db)
}
