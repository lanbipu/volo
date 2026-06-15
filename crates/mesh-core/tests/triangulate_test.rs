use mesh_core::shape::CabinetArray;
use mesh_core::surface::GridTopology;
use mesh_core::triangulate::triangulate_grid;
use nalgebra::Vector3;

fn flat_vertices(topo: GridTopology) -> Vec<Vector3<f64>> {
    let mut v = Vec::with_capacity(topo.vertex_count());
    for r in 0..=topo.rows {
        for c in 0..=topo.cols {
            v.push(Vector3::new(c as f64 * 0.5, 0.0, r as f64 * 0.5));
        }
    }
    v
}

#[test]
fn one_quad_yields_two_triangles() {
    let topo = GridTopology { cols: 1, rows: 1 };
    let verts = flat_vertices(topo);
    let cab = CabinetArray::rectangle(1, 1, [500.0, 500.0]);
    let tris = triangulate_grid(topo, &verts, &cab);
    assert_eq!(tris.len(), 2);
}

#[test]
fn four_quads_yield_eight_triangles() {
    let topo = GridTopology { cols: 2, rows: 2 };
    let verts = flat_vertices(topo);
    let cab = CabinetArray::rectangle(2, 2, [500.0, 500.0]);
    let tris = triangulate_grid(topo, &verts, &cab);
    assert_eq!(tris.len(), 8);
}

#[test]
fn absent_cell_is_skipped() {
    let topo = GridTopology { cols: 2, rows: 2 };
    let verts = flat_vertices(topo);
    // mark (1, 1) absent — should drop 2 triangles for that cell
    let cab = CabinetArray::irregular(2, 2, [500.0, 500.0], vec![(1, 1)]);
    let tris = triangulate_grid(topo, &verts, &cab);
    assert_eq!(tris.len(), 6); // 8 - 2
}

#[test]
fn triangle_indices_are_within_vertex_range() {
    let topo = GridTopology { cols: 4, rows: 3 };
    let verts = flat_vertices(topo);
    let cab = CabinetArray::rectangle(4, 3, [500.0, 500.0]);
    let n_verts = topo.vertex_count() as u32;
    let tris = triangulate_grid(topo, &verts, &cab);
    for t in tris {
        for &i in &t {
            assert!(i < n_verts);
        }
    }
}

#[test]
fn shorter_diagonal_is_chosen_when_quad_is_skewed() {
    // 1×1 quad with one corner pushed up:
    //   tl(0, 0, 1) ---- tr(1, 0.0, 1)
    //   |                |
    //   bl(0, 0, 0) ---- br(1, 5.0, 0)   ← y pushed: |bl-tr| > |br-tl|
    //
    // |bl - tr| = sqrt(1 + 0 + 1) = sqrt(2)
    // |br - tl| = sqrt(1 + 25 + 1) = sqrt(27)
    // Shorter diagonal: bl-tr  → triangles (bl,br,tr) + (bl,tr,tl)
    let topo = GridTopology { cols: 1, rows: 1 };
    let verts = vec![
        Vector3::new(0.0, 0.0, 0.0), // bl   index 0
        Vector3::new(1.0, 5.0, 0.0), // br   index 1
        Vector3::new(0.0, 0.0, 1.0), // tl   index 2
        Vector3::new(1.0, 0.0, 1.0), // tr   index 3
    ];
    let cab = CabinetArray::rectangle(1, 1, [500.0, 500.0]);
    let tris = triangulate_grid(topo, &verts, &cab);
    assert_eq!(tris.len(), 2);
    // Both triangles should share the bl-tr diagonal (indices 0 and 3)
    let shared: Vec<[u32; 3]> = tris
        .iter()
        .filter(|t| t.contains(&0) && t.contains(&3))
        .copied()
        .collect();
    assert_eq!(
        shared.len(),
        2,
        "both tris should share the shorter (bl-tr) diagonal"
    );
}

#[test]
#[should_panic(expected = "cabinet_array.cols")]
fn triangulate_panics_on_dimension_mismatch_cols() {
    let topo = GridTopology { cols: 3, rows: 2 };
    let verts = flat_vertices(topo);
    let cab = CabinetArray::rectangle(2, 2, [500.0, 500.0]); // wrong cols
    let _ = triangulate_grid(topo, &verts, &cab);
}

#[test]
#[should_panic(expected = "cabinet_array.rows")]
fn triangulate_panics_on_dimension_mismatch_rows() {
    let topo = GridTopology { cols: 2, rows: 3 };
    let verts = flat_vertices(topo);
    let cab = CabinetArray::rectangle(2, 2, [500.0, 500.0]); // wrong rows
    let _ = triangulate_grid(topo, &verts, &cab);
}

#[test]
#[should_panic(expected = "vertices.len()")]
fn triangulate_panics_on_short_vertex_buffer() {
    let topo = GridTopology { cols: 2, rows: 2 };
    let verts = vec![Vector3::zeros(); 3]; // expected 9
    let cab = CabinetArray::rectangle(2, 2, [500.0, 500.0]);
    let _ = triangulate_grid(topo, &verts, &cab);
}
