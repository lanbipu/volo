use mesh_adapter_total_station::builder::build_screen_measured_points;
use mesh_adapter_total_station::csv_parser::parse_csv;
use mesh_adapter_total_station::project_loader::load_project;
use mesh_core::export::targets::{NeutralTarget, OutputTarget};
use mesh_core::reconstruct::auto_reconstruct;
use std::path::PathBuf;
use tempfile::tempdir;

fn fixture(name: &str) -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.push("tests/fixtures");
    p.push(name);
    p
}

#[test]
fn full_csv_to_obj_pipeline() {
    let raw = parse_csv(&fixture("e2e.csv")).unwrap();
    let cfg = load_project(&fixture("e2e.yaml")).unwrap();
    let main = cfg.screens.get("MAIN").unwrap();

    // Sanity-check the inputs so a regression that drops CSV rows
    // can't slip through as "non-empty OBJ".
    assert_eq!(raw.len(), 15, "fixture provides 15 raw points");

    let mp = build_screen_measured_points("MAIN", &raw, main).unwrap();

    // All 15 measured points should be named and present — no outliers,
    // no fabrication (full grid measured, no bottom_completion).
    assert_eq!(
        mp.points.len(),
        15,
        "every CSV point should be named and present; got {} points",
        mp.points.len()
    );
    for c in 1..=5u32 {
        for r in 1..=3u32 {
            let name = format!("MAIN_V{c:03}_R{r:03}");
            assert!(
                mp.points.iter().any(|p| p.name == name),
                "missing expected grid point {name}"
            );
        }
    }

    let surface = auto_reconstruct(&mp).expect("reconstruction succeeded");

    // Full grid should pick direct_link (every vertex measured).
    assert_eq!(
        surface.quality_metrics.method, "direct_link",
        "full-grid input should reconstruct via direct_link, got {}",
        surface.quality_metrics.method
    );
    assert_eq!(surface.vertices.len(), 15);

    let dir = tempdir().unwrap();
    let path = dir.path().join("e2e.obj");
    NeutralTarget::default()
        .export(&surface, &mp.cabinet_array, &path)
        .unwrap();

    let obj = std::fs::read_to_string(&path).unwrap();
    let v_count = obj.lines().filter(|l| l.starts_with("v ")).count();
    let f_count = obj.lines().filter(|l| l.starts_with("f ")).count();
    // 5×3 grid → 15 vertices. 4×2 cabinets × 2 triangles = 16 face lines.
    assert_eq!(v_count, 15, "expected 15 v lines, got {v_count}");
    assert_eq!(f_count, 16, "expected 16 f lines, got {f_count}");
}
