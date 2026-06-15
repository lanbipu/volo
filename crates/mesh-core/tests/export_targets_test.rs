use mesh_core::export::targets::{DisguiseTarget, NeutralTarget, OutputTarget, UnrealTarget};
use mesh_core::shape::CabinetArray;
use mesh_core::surface::{GridTopology, QualityMetrics, ReconstructedSurface, TargetSoftware};
use mesh_core::uv::compute_grid_uv;
use nalgebra::Vector3;
use tempfile::tempdir;

fn sample_surface() -> ReconstructedSurface {
    let topo = GridTopology { cols: 1, rows: 1 };
    let v = vec![
        Vector3::new(0.0, 0.0, 0.0),
        Vector3::new(0.5, 0.0, 0.0),
        Vector3::new(0.0, 0.0, 0.5),
        Vector3::new(0.5, 0.0, 0.5),
    ];
    let uvs = compute_grid_uv(topo);
    ReconstructedSurface {
        screen_id: "MAIN".into(),
        topology: topo,
        vertices: v,
        uv_coords: uvs,
        quality_metrics: QualityMetrics::default(),
        scatter_fit: None,
    }
}

#[test]
fn disguise_target_reports_correct_software() {
    let t = DisguiseTarget::default();
    assert_eq!(t.software(), TargetSoftware::Disguise);
}

#[test]
fn unreal_target_reports_correct_software() {
    let t = UnrealTarget::default();
    assert_eq!(t.software(), TargetSoftware::Unreal);
}

#[test]
fn neutral_target_reports_correct_software() {
    let t = NeutralTarget::default();
    assert_eq!(t.software(), TargetSoftware::Neutral);
}

#[test]
fn disguise_target_writes_obj_file() {
    let s = sample_surface();
    let cab = CabinetArray::rectangle(1, 1, [500.0, 500.0]);
    let dir = tempdir().unwrap();
    let path = dir.path().join("d.obj");

    let t = DisguiseTarget::default();
    t.export(&s, &cab, &path).unwrap();

    let obj = std::fs::read_to_string(&path).unwrap();
    assert!(obj.contains("disguise"));
    assert!(obj.lines().filter(|l| l.starts_with("v ")).count() > 0);
}
