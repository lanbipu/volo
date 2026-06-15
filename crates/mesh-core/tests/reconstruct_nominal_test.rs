use mesh_core::coordinate::CoordinateFrame;
use mesh_core::measured_points::MeasuredPoints;
use mesh_core::point::{MeasuredPoint, PointSource};
use mesh_core::reconstruct::nominal::NominalReconstructor;
use mesh_core::reconstruct::Reconstructor;
use mesh_core::shape::{CabinetArray, ShapePrior};
use mesh_core::uncertainty::Uncertainty;
use mesh_core::sampling::SamplingMode;
use nalgebra::Vector3;

fn frame_at_origin() -> CoordinateFrame {
    CoordinateFrame::from_three_points(
        Vector3::zeros(),
        Vector3::new(1.0, 0.0, 0.0),
        Vector3::new(0.0, 0.0, 1.0),
    )
    .unwrap()
}

fn p(name: &str, x: f64, y: f64, z: f64) -> MeasuredPoint {
    MeasuredPoint {
        name: name.into(),
        position: Vector3::new(x, y, z),
        uncertainty: Uncertainty::Isotropic(2.0),
        source: PointSource::TotalStation,
    }
}

#[test]
fn nominal_flat_4x4_panel_emits_25_vertices() {
    // 4 col × 4 row cabinets → 5 × 5 = 25 vertices
    let mp = MeasuredPoints {
        screen_id: "MAIN".into(),
        coordinate_frame: frame_at_origin(),
        cabinet_array: CabinetArray::rectangle(4, 4, [500.0, 500.0]),
        shape_prior: ShapePrior::Flat,
        points: vec![
            p("MAIN_V001_R001", 0.0, 0.0, 0.0),
            p("MAIN_V005_R001", 2.0, 0.0, 0.0),
            p("MAIN_V001_R005", 0.0, 0.0, 2.0),
            p("MAIN_V005_R005", 2.0, 0.0, 2.0),
        ],
        sampling_mode: SamplingMode::Grid,
    };

    let r = NominalReconstructor;
    let surface = r.reconstruct(&mp).expect("reconstruction should succeed");

    assert_eq!(surface.topology.cols, 4);
    assert_eq!(surface.topology.rows, 4);
    assert_eq!(surface.vertices.len(), 25);
    assert_eq!(surface.uv_coords.len(), 25);

    // bottom-left vertex (col=0, row=0) at (0,0,0)
    assert!((surface.vertices[0] - Vector3::new(0.0, 0.0, 0.0)).norm() < 1e-9);
    // top-right vertex (col=4, row=4) at (2,0,2)
    let tr = surface.topology.vertex_index(4, 4);
    assert!((surface.vertices[tr] - Vector3::new(2.0, 0.0, 2.0)).norm() < 1e-9);
}

#[test]
fn nominal_with_too_few_points_returns_error() {
    let mp = MeasuredPoints {
        screen_id: "MAIN".into(),
        coordinate_frame: frame_at_origin(),
        cabinet_array: CabinetArray::rectangle(4, 4, [500.0, 500.0]),
        shape_prior: ShapePrior::Flat,
        points: vec![
            p("MAIN_V001_R001", 0.0, 0.0, 0.0),
            // only 1 corner; need 4
        ],
        sampling_mode: SamplingMode::Grid,
    };

    let r = NominalReconstructor;
    assert!(r.reconstruct(&mp).is_err());
}
