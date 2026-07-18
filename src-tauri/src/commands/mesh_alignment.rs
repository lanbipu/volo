//! Mesh rebuilt-alignment Tauri shims. Math lives in `mesh_core::rigid`.

use mesh_app::alignment::{
    compute_rebuilt_alignment_dto, ComputeRebuiltAlignmentInput, ComputeRebuiltAlignmentResult,
};
use volo_shared::error::VoloResult;

#[tauri::command]
pub fn mesh_compute_rebuilt_alignment(
    input: ComputeRebuiltAlignmentInput,
) -> VoloResult<ComputeRebuiltAlignmentResult> {
    compute_rebuilt_alignment_dto(input)
}
