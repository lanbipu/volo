use nalgebra::Vector3;

use crate::shape::CabinetArray;
use crate::surface::GridTopology;

/// Triangulate a regular (cols+1)×(rows+1) vertex grid.
///
/// For each quad:
/// - skip if the cabinet at (c, r) is marked absent (irregular shape)
/// - otherwise pick the shorter diagonal between (bl–tr) and (br–tl)
///   to minimize triangle distortion (spec §6.4)
///
/// **Panics** if:
/// - `cabinet_array.cols != topology.cols` or `cabinet_array.rows != topology.rows`
///   (caller bug — would silently delete entire rows/cols of mesh)
/// - `vertices.len() != topology.vertex_count()` (caller bug — would index OOB)
pub fn triangulate_grid(
    topology: GridTopology,
    vertices: &[Vector3<f64>],
    cabinet_array: &CabinetArray,
) -> Vec<[u32; 3]> {
    assert_eq!(
        cabinet_array.cols, topology.cols,
        "triangulate_grid: cabinet_array.cols ({}) must match topology.cols ({})",
        cabinet_array.cols, topology.cols
    );
    assert_eq!(
        cabinet_array.rows, topology.rows,
        "triangulate_grid: cabinet_array.rows ({}) must match topology.rows ({})",
        cabinet_array.rows, topology.rows
    );
    assert_eq!(
        vertices.len(),
        topology.vertex_count(),
        "triangulate_grid: vertices.len() ({}) must equal topology.vertex_count() ({})",
        vertices.len(),
        topology.vertex_count()
    );

    let cols = topology.cols;
    let rows = topology.rows;
    let mut tris = Vec::with_capacity((cols * rows * 2) as usize);

    for r in 0..rows {
        for c in 0..cols {
            // Skip cells removed by irregular shape mask.
            if !cabinet_array.is_present(c, r) {
                continue;
            }

            let i_bl = topology.vertex_index(c, r) as u32;
            let i_br = topology.vertex_index(c + 1, r) as u32;
            let i_tl = topology.vertex_index(c, r + 1) as u32;
            let i_tr = topology.vertex_index(c + 1, r + 1) as u32;

            let v_bl = vertices[i_bl as usize];
            let v_br = vertices[i_br as usize];
            let v_tl = vertices[i_tl as usize];
            let v_tr = vertices[i_tr as usize];

            let d_bl_tr = (v_bl - v_tr).norm_squared();
            let d_br_tl = (v_br - v_tl).norm_squared();

            if d_bl_tr <= d_br_tl {
                // Diagonal bl–tr: triangles (bl, br, tr) + (bl, tr, tl)
                tris.push([i_bl, i_br, i_tr]);
                tris.push([i_bl, i_tr, i_tl]);
            } else {
                // Diagonal br–tl: triangles (bl, br, tl) + (br, tr, tl)
                tris.push([i_bl, i_br, i_tl]);
                tris.push([i_br, i_tr, i_tl]);
            }
        }
    }

    tris
}
