use crate::error::CoreError;
use crate::export::adapt::adapt_to_target;
use crate::shape::CabinetArray;
use crate::surface::{MeshOutput, ReconstructedSurface, TargetSoftware};
use crate::triangulate::triangulate_grid;
use crate::weld::weld_vertices;

/// Disguise hard limit on per-screen mesh vertex count.
pub const DISGUISE_VERTEX_LIMIT: usize = 200_000;

/// Convert a `ReconstructedSurface` into a `MeshOutput` ready for the
/// given target software.
///
/// Pipeline (order matters for unit-correct welding + winding):
/// 0. Preflight validate inputs (returns `CoreError::InvalidInput` on
///    malformed surface, cabinet/topology mismatch, bad tolerance, or
///    over-the-limit Disguise vertex count) — fail fast before allocation.
/// 1. Triangulate the grid in model frame (with absent-cell skipping +
///    shorter-diagonal selection).
/// 2. Weld coincident vertices in the model frame (meters), using
///    `weld_tolerance_m`.
/// 3. Remap triangle indices through the welding map; drop degenerate
///    triangles where two indices collapse onto the same welded vertex.
/// 4. Apply the target software's coordinate-frame + unit adapter.
/// 5. Disguise only: reverse winding + mirror UV U so the lit face lands on the
///    concave (audience) side without left-right mirroring. Unreal/Neutral keep
///    model winding (Unreal's facing is handled by its adapt transform).
pub fn surface_to_mesh_output(
    surface: &ReconstructedSurface,
    cabinet_array: &CabinetArray,
    target: TargetSoftware,
    weld_tolerance_m: f64,
) -> Result<MeshOutput, CoreError> {
    // 0a. Validate surface invariants.
    surface.validate()?;

    // 0b. Validate cabinet_array matches topology.
    if cabinet_array.cols != surface.topology.cols {
        return Err(CoreError::InvalidInput(format!(
            "cabinet_array.cols ({}) must match topology.cols ({})",
            cabinet_array.cols, surface.topology.cols
        )));
    }
    if cabinet_array.rows != surface.topology.rows {
        return Err(CoreError::InvalidInput(format!(
            "cabinet_array.rows ({}) must match topology.rows ({})",
            cabinet_array.rows, surface.topology.rows
        )));
    }

    // 0c. Validate weld tolerance.
    if !weld_tolerance_m.is_finite() {
        return Err(CoreError::InvalidInput(format!(
            "weld_tolerance_m must be finite, got {weld_tolerance_m}"
        )));
    }
    if weld_tolerance_m < 0.0 {
        return Err(CoreError::InvalidInput(format!(
            "weld_tolerance_m must be non-negative, got {weld_tolerance_m}"
        )));
    }

    // 0d. Disguise vertex-count limit (early reject before allocation).
    if matches!(target, TargetSoftware::Disguise) && surface.vertices.len() > DISGUISE_VERTEX_LIMIT
    {
        return Err(CoreError::Reconstruction(format!(
            "input surface has {} vertices, exceeds Disguise limit of {}",
            surface.vertices.len(),
            DISGUISE_VERTEX_LIMIT
        )));
    }

    // 1. Triangulate in model frame.
    let raw_tris = triangulate_grid(surface.topology, &surface.vertices, cabinet_array);

    // 2. Weld in model frame (meters).
    let (welded_model, mapping) = weld_vertices(&surface.vertices, weld_tolerance_m);

    // 3. Remap + drop degenerate triangles.
    let mut triangles: Vec<[u32; 3]> = raw_tris
        .iter()
        .map(|t| {
            [
                mapping[t[0] as usize],
                mapping[t[1] as usize],
                mapping[t[2] as usize],
            ]
        })
        .filter(|t| t[0] != t[1] && t[1] != t[2] && t[0] != t[2])
        .collect();

    // UVs follow welded vertex indices (first input UV wins per welded id).
    let mut uv_coords = vec![nalgebra::Vector2::zeros(); welded_model.len()];
    let mut uv_filled = vec![false; welded_model.len()];
    for (raw_idx, welded_idx) in mapping.iter().enumerate() {
        let wi = *welded_idx as usize;
        if !uv_filled[wi] && raw_idx < surface.uv_coords.len() {
            uv_coords[wi] = surface.uv_coords[raw_idx];
            uv_filled[wi] = true;
        }
    }

    // 4. Apply target adapter to the welded model-frame vertices.
    let vertices: Vec<_> = welded_model
        .iter()
        .map(|v| adapt_to_target(v, target))
        .collect();

    // 5. Disguise only: reverse winding so the lit face points to the concave
    //    (audience) side, and mirror UV U to compensate the texture flip so
    //    content isn't left-right mirrored. Unreal needs neither — its adapt
    //    transform (convex normal → +X) already lands the lit face on the
    //    concave side. Neutral keeps model winding for debugging.
    if matches!(target, TargetSoftware::Disguise) {
        for t in triangles.iter_mut() {
            t.swap(1, 2);
        }
        for uv in uv_coords.iter_mut() {
            uv.x = 1.0 - uv.x;
        }
    }

    Ok(MeshOutput {
        target,
        vertices,
        triangles,
        uv_coords,
    })
}
