use mesh_core::surface::{
    GridTopology, MeshOutput, QualityMetrics, ReconstructedSurface, TargetSoftware,
};
use nalgebra::{Vector2, Vector3};

#[test]
fn surface_construction_holds_consistent_sizes() {
    let cols = 4;
    let rows = 3;
    let n_verts = ((cols + 1) * (rows + 1)) as usize;

    let vertices: Vec<Vector3<f64>> = (0..n_verts)
        .map(|i| Vector3::new(i as f64, 0.0, 0.0))
        .collect();
    let uvs: Vec<Vector2<f64>> = (0..n_verts).map(|_| Vector2::zeros()).collect();

    let surf = ReconstructedSurface {
        screen_id: "MAIN".into(),
        topology: GridTopology { cols, rows },
        vertices,
        uv_coords: uvs,
        quality_metrics: QualityMetrics::default(),
        scatter_fit: None,
    };

    assert_eq!(surf.vertices.len(), n_verts);
    assert_eq!(surf.uv_coords.len(), n_verts);
}

#[test]
fn target_software_serializes_to_lowercase() {
    let s = serde_yaml::to_string(&TargetSoftware::Disguise).unwrap();
    assert!(s.contains("disguise"));
}

#[test]
fn mesh_output_default_target_neutral() {
    let mo = MeshOutput {
        target: TargetSoftware::Neutral,
        vertices: vec![],
        triangles: vec![],
        uv_coords: vec![],
    };
    assert_eq!(mo.target, TargetSoftware::Neutral);
}

#[test]
fn grid_topology_vertex_count_handles_boundaries() {
    assert_eq!(GridTopology { cols: 0, rows: 0 }.vertex_count(), 1);
    assert_eq!(GridTopology { cols: 0, rows: 3 }.vertex_count(), 4);
    assert_eq!(GridTopology { cols: 4, rows: 0 }.vertex_count(), 5);
    assert_eq!(
        GridTopology {
            cols: 500,
            rows: 500
        }
        .vertex_count(),
        251_001
    );
}

#[test]
fn grid_topology_vertex_index_is_row_major() {
    let topology = GridTopology { cols: 4, rows: 3 };
    assert_eq!(topology.vertex_index(0, 0), 0);
    assert_eq!(topology.vertex_index(4, 0), 4);
    assert_eq!(topology.vertex_index(0, 1), 5);
    assert_eq!(topology.vertex_index(3, 2), 13);
}

#[test]
fn reconstructed_surface_yaml_round_trips_vectors() {
    let surf = ReconstructedSurface {
        screen_id: "MAIN".into(),
        topology: GridTopology { cols: 1, rows: 1 },
        vertices: vec![
            Vector3::new(0.0, 0.0, 0.0),
            Vector3::new(1.0, 0.0, 0.0),
            Vector3::new(0.0, 1.0, 0.0),
            Vector3::new(1.0, 1.0, 0.0),
        ],
        uv_coords: vec![
            Vector2::new(0.0, 0.0),
            Vector2::new(1.0, 0.0),
            Vector2::new(0.0, 1.0),
            Vector2::new(1.0, 1.0),
        ],
        quality_metrics: QualityMetrics::default(),
        scatter_fit: None,
    };

    let yaml = serde_yaml::to_string(&surf).unwrap();
    let decoded: ReconstructedSurface = serde_yaml::from_str(&yaml).unwrap();

    assert_eq!(decoded.screen_id, surf.screen_id);
    assert_eq!(decoded.topology.cols, surf.topology.cols);
    assert_eq!(decoded.topology.rows, surf.topology.rows);
    assert_eq!(decoded.vertices, surf.vertices);
    assert_eq!(decoded.uv_coords, surf.uv_coords);
}

#[test]
fn deserialize_rejects_topology_exceeding_max_grid_dim() {
    let yaml = "cols: 20000\nrows: 100\n";
    let result: Result<GridTopology, _> = serde_yaml::from_str(yaml);
    assert!(result.is_err(), "should reject cols > MAX_GRID_DIM");

    let yaml = "cols: 100\nrows: 20000\n";
    let result: Result<GridTopology, _> = serde_yaml::from_str(yaml);
    assert!(result.is_err(), "should reject rows > MAX_GRID_DIM");
}

#[test]
fn deserialize_accepts_topology_at_max_grid_dim() {
    use mesh_core::surface::MAX_GRID_DIM;
    let yaml = format!("cols: {MAX_GRID_DIM}\nrows: {MAX_GRID_DIM}\n");
    let result: Result<GridTopology, _> = serde_yaml::from_str(&yaml);
    assert!(result.is_ok(), "boundary should be inclusive");
}

#[test]
#[should_panic(expected = "vertex_count overflow")]
fn vertex_count_panics_on_arithmetic_overflow() {
    // Construct via field init bypasses the deserialize validator on purpose
    // — proves checked_mul still catches the case if a buggy caller built
    // an oversized GridTopology directly.
    let topo = GridTopology {
        cols: u32::MAX,
        rows: u32::MAX,
    };
    let _ = topo.vertex_count();
}

#[test]
fn surface_validate_passes_on_consistent_data() {
    let topo = GridTopology { cols: 1, rows: 1 };
    let surf = ReconstructedSurface {
        screen_id: "MAIN".into(),
        topology: topo,
        vertices: vec![Vector3::zeros(); 4],
        uv_coords: vec![Vector2::zeros(); 4],
        quality_metrics: QualityMetrics::default(),
        scatter_fit: None,
    };
    assert!(surf.validate().is_ok());
}

#[test]
fn surface_validate_rejects_vertex_count_mismatch() {
    let topo = GridTopology { cols: 2, rows: 2 }; // expects 9
    let surf = ReconstructedSurface {
        screen_id: "MAIN".into(),
        topology: topo,
        vertices: vec![Vector3::zeros(); 4], // wrong
        uv_coords: vec![Vector2::zeros(); 4],
        quality_metrics: QualityMetrics::default(),
        scatter_fit: None,
    };
    assert!(surf.validate().is_err());
}

#[test]
fn mesh_output_validate_rejects_triangle_index_out_of_bounds() {
    let mo = MeshOutput {
        target: TargetSoftware::Neutral,
        vertices: vec![Vector3::zeros(); 3],
        uv_coords: vec![Vector2::zeros(); 3],
        triangles: vec![[0, 1, 5]], // 5 out of bounds
    };
    assert!(mo.validate().is_err());
}

#[test]
fn mesh_output_validate_rejects_uv_length_mismatch() {
    let mo = MeshOutput {
        target: TargetSoftware::Neutral,
        vertices: vec![Vector3::zeros(); 3],
        uv_coords: vec![Vector2::zeros(); 2], // mismatch
        triangles: vec![[0, 1, 2]],
    };
    assert!(mo.validate().is_err());
}

#[test]
fn surface_validate_rejects_non_finite_uv() {
    let topo = GridTopology { cols: 1, rows: 1 };
    let surf = ReconstructedSurface {
        screen_id: "MAIN".into(),
        topology: topo,
        vertices: vec![Vector3::zeros(); 4],
        uv_coords: vec![
            Vector2::zeros(),
            Vector2::zeros(),
            Vector2::new(f64::NAN, 0.0), // non-finite
            Vector2::zeros(),
        ],
        quality_metrics: QualityMetrics::default(),
        scatter_fit: None,
    };
    assert!(surf.validate().is_err());
}

#[test]
fn mesh_output_validate_rejects_non_finite_uv() {
    let mo = MeshOutput {
        target: TargetSoftware::Neutral,
        vertices: vec![Vector3::zeros(); 3],
        uv_coords: vec![
            Vector2::zeros(),
            Vector2::new(0.0, f64::INFINITY),
            Vector2::zeros(),
        ],
        triangles: vec![[0, 1, 2]],
    };
    assert!(mo.validate().is_err());
}

#[test]
fn deserialize_rejects_surface_with_vertex_count_mismatch() {
    // topology = 2x2 → expects 9 vertices, but YAML provides 4
    let yaml = r#"
screen_id: MAIN
topology:
  cols: 2
  rows: 2
vertices:
  - [0.0, 0.0, 0.0]
  - [1.0, 0.0, 0.0]
  - [0.0, 1.0, 0.0]
  - [1.0, 1.0, 0.0]
uv_coords:
  - [0.0, 0.0]
  - [1.0, 0.0]
  - [0.0, 1.0]
  - [1.0, 1.0]
quality_metrics:
  method: ""
  middle_max_dev_mm: 0.0
  middle_mean_dev_mm: 0.0
  measured_count: 0
  expected_count: 0
  missing: []
  outliers: []
  estimated_rms_mm: 0.0
  estimated_p95_mm: 0.0
  warnings: []
"#;
    let result: Result<ReconstructedSurface, _> = serde_yaml::from_str(yaml);
    assert!(result.is_err());
}

#[test]
fn deserialize_rejects_mesh_output_with_oob_triangle() {
    let yaml = r#"
target: neutral
vertices:
  - [0.0, 0.0, 0.0]
  - [1.0, 0.0, 0.0]
  - [0.0, 1.0, 0.0]
triangles:
  - [0, 1, 5]
uv_coords:
  - [0.0, 0.0]
  - [1.0, 0.0]
  - [0.0, 1.0]
"#;
    let result: Result<MeshOutput, _> = serde_yaml::from_str(yaml);
    assert!(result.is_err());
}

#[test]
fn deserialize_accepts_consistent_surface_round_trip() {
    let topo = GridTopology { cols: 1, rows: 1 };
    let surf = ReconstructedSurface {
        screen_id: "MAIN".into(),
        topology: topo,
        vertices: vec![
            Vector3::new(0.0, 0.0, 0.0),
            Vector3::new(1.0, 0.0, 0.0),
            Vector3::new(0.0, 1.0, 0.0),
            Vector3::new(1.0, 1.0, 0.0),
        ],
        uv_coords: vec![
            Vector2::new(0.0, 0.0),
            Vector2::new(1.0, 0.0),
            Vector2::new(0.0, 1.0),
            Vector2::new(1.0, 1.0),
        ],
        quality_metrics: QualityMetrics::default(),
        scatter_fit: None,
    };
    let yaml = serde_yaml::to_string(&surf).unwrap();
    let back: ReconstructedSurface = serde_yaml::from_str(&yaml).unwrap();
    assert_eq!(back.screen_id, surf.screen_id);
}
