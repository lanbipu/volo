use mesh_core::export::targets::{DisguiseTarget, NeutralTarget, OutputTarget};
use mesh_core::measured_points::MeasuredPoints;
use mesh_core::reconstruct::auto_reconstruct;
use std::path::PathBuf;
use tempfile::tempdir;

fn fixture_path(name: &str) -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.push("tests");
    p.push("fixtures");
    p.push(name);
    p
}

#[test]
fn full_pipeline_yaml_to_obj_neutral() {
    let yaml = std::fs::read_to_string(fixture_path("curved_demo_points.yaml")).unwrap();
    let mp: MeasuredPoints = serde_yaml::from_str(&yaml).unwrap();

    let surface = auto_reconstruct(&mp).expect("reconstruction succeeded");
    assert!(!surface.vertices.is_empty());
    assert_eq!(surface.uv_coords.len(), surface.vertices.len());

    let dir = tempdir().unwrap();
    let path = dir.path().join("end_to_end.obj");

    let target = NeutralTarget::default();
    target.export(&surface, &mp.cabinet_array, &path).unwrap();

    let obj = std::fs::read_to_string(&path).unwrap();
    assert!(obj.contains("# LED Mesh Toolkit OBJ export"));
    assert!(obj.lines().filter(|l| l.starts_with("v ")).count() > 0);
    assert!(obj.lines().filter(|l| l.starts_with("vt ")).count() > 0);
    assert!(obj.lines().filter(|l| l.starts_with("f ")).count() > 0);
}

#[test]
fn full_pipeline_yaml_to_obj_disguise_swaps_axes() {
    let yaml = std::fs::read_to_string(fixture_path("curved_demo_points.yaml")).unwrap();
    let mp: MeasuredPoints = serde_yaml::from_str(&yaml).unwrap();

    let surface = auto_reconstruct(&mp).unwrap();

    let dir = tempdir().unwrap();
    let path = dir.path().join("disguise.obj");

    let target = DisguiseTarget::default();
    target.export(&surface, &mp.cabinet_array, &path).unwrap();

    let obj = std::fs::read_to_string(&path).unwrap();
    assert!(obj.contains("disguise"));
}

#[test]
fn disguise_export_actually_swaps_y_z_axes() {
    // Construct an in-memory surface with a non-axis-aligned vertex set so
    // axis-swap effects are detectable in the OBJ output.
    use mesh_core::shape::CabinetArray;
    use mesh_core::surface::{GridTopology, QualityMetrics, ReconstructedSurface};
    use mesh_core::uv::compute_grid_uv;
    use nalgebra::Vector3;

    let topo = GridTopology { cols: 1, rows: 1 };
    // 4 corners with distinct non-zero y values (and asymmetric x/z) so
    // any axis confusion will produce different floats.
    let model_vertices = vec![
        Vector3::new(0.0, 0.5, 0.0), // bl  → after disguise: (0, 0, -0.5)
        Vector3::new(1.0, 0.7, 0.0), // br  → (1, 0, -0.7)
        Vector3::new(0.0, 0.9, 2.0), // tl  → (0, 2, -0.9)
        Vector3::new(1.0, 1.1, 2.0), // tr  → (1, 2, -1.1)
    ];
    let surf = ReconstructedSurface {
        screen_id: "MAIN".into(),
        topology: topo,
        vertices: model_vertices,
        uv_coords: compute_grid_uv(topo),
        quality_metrics: QualityMetrics::default(),
        scatter_fit: None,
        vertex_provenance: vec![],
    };
    let cab = CabinetArray::rectangle(1, 1, [500.0, 500.0]);

    let dir = tempdir().unwrap();
    let neutral_path = dir.path().join("neutral.obj");
    let disguise_path = dir.path().join("disguise.obj");

    NeutralTarget::default()
        .export(&surf, &cab, &neutral_path)
        .unwrap();
    DisguiseTarget::default()
        .export(&surf, &cab, &disguise_path)
        .unwrap();

    let neutral_obj = std::fs::read_to_string(&neutral_path).unwrap();
    let disguise_obj = std::fs::read_to_string(&disguise_path).unwrap();

    // Parse v lines: "v {x} {y} {z}" → Vec<(f64, f64, f64)>
    let parse_vs = |obj: &str| -> Vec<(f64, f64, f64)> {
        obj.lines()
            .filter_map(|l| {
                let stripped = l.strip_prefix("v ")?;
                let parts: Vec<&str> = stripped.split_whitespace().collect();
                if parts.len() != 3 {
                    return None;
                }
                let x: f64 = parts[0].parse().ok()?;
                let y: f64 = parts[1].parse().ok()?;
                let z: f64 = parts[2].parse().ok()?;
                Some((x, y, z))
            })
            .collect()
    };

    let neutral_vs = parse_vs(&neutral_obj);
    let disguise_vs = parse_vs(&disguise_obj);
    assert_eq!(neutral_vs.len(), disguise_vs.len());
    assert_eq!(neutral_vs.len(), 4, "1×1 grid has 4 vertices");

    // For every (x, y, z) in neutral, the matching disguise output must be
    // (x, z, -y). Welding may reorder, so we check via set equality.
    use std::collections::BTreeSet;
    fn approx_key(t: (f64, f64, f64)) -> (i64, i64, i64) {
        // Round to 6 decimals (matches OBJ writer precision)
        let scale = 1_000_000.0_f64;
        (
            (t.0 * scale).round() as i64,
            (t.1 * scale).round() as i64,
            (t.2 * scale).round() as i64,
        )
    }

    let neutral_set: BTreeSet<_> = neutral_vs.iter().copied().map(approx_key).collect();
    let expected_disguise_set: BTreeSet<_> = neutral_vs
        .iter()
        .map(|(x, y, z)| (*x, *z, -*y))
        .map(approx_key)
        .collect();
    let disguise_set: BTreeSet<_> = disguise_vs.iter().copied().map(approx_key).collect();

    assert_eq!(
        disguise_set, expected_disguise_set,
        "Disguise OBJ vertices must equal (x, z, -y) of neutral OBJ vertices.\n\
         Neutral: {neutral_set:?}\n\
         Expected: {expected_disguise_set:?}\n\
         Got:      {disguise_set:?}"
    );
}
