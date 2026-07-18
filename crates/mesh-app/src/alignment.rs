//! Transport-agnostic rebuilt-alignment helpers (Tauri + CLI).

use mesh_core::rigid::{compute_rebuilt_alignment, RigidTransform};
use nalgebra::Vector3;
use serde::{Deserialize, Serialize};
use volo_shared::error::VoloResult;

#[derive(Debug, Clone, Deserialize)]
pub struct ComputeRebuiltAlignmentInput {
    pub origin: [f64; 3],
    #[serde(default)]
    pub x_axis: Option<[f64; 3]>,
    #[serde(default)]
    pub xy_plane: Option<[f64; 3]>,
    /// Row-major 3×3; omit / identity when no prior alignment.
    #[serde(default = "identity_rotation")]
    pub a_old_rotation: [[f64; 3]; 3],
    #[serde(default)]
    pub a_old_t_m: [f64; 3],
}

fn identity_rotation() -> [[f64; 3]; 3] {
    RigidTransform::identity().rotation
}

#[derive(Debug, Clone, Serialize)]
pub struct ComputeRebuiltAlignmentResult {
    pub rotation: [[f64; 3]; 3],
    pub t_m: [f64; 3],
}

fn v3(p: [f64; 3]) -> Vector3<f64> {
    Vector3::new(p[0], p[1], p[2])
}

/// Compute new group alignment `A' = F⁻¹ ∘ A_old` via mesh-core (single source of truth).
pub fn compute_rebuilt_alignment_dto(
    input: ComputeRebuiltAlignmentInput,
) -> VoloResult<ComputeRebuiltAlignmentResult> {
    let a_old = RigidTransform {
        rotation: input.a_old_rotation,
        t_m: input.a_old_t_m,
    };
    RigidTransform::validate_rotation(&a_old.rotation).map_err(volo_shared::error::VoloError::InvalidInput)?;
    let a_new = compute_rebuilt_alignment(
        v3(input.origin),
        input.x_axis.map(v3),
        input.xy_plane.map(v3),
        &a_old,
    )?;
    Ok(ComputeRebuiltAlignmentResult {
        rotation: a_new.rotation,
        t_m: a_new.t_m,
    })
}
