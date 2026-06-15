use mesh_core::coordinate::CoordinateFrame;
use mesh_core::measured_points::MeasuredPoints;
use mesh_core::point::{MeasuredPoint, PointSource};
use mesh_core::shape::{CabinetArray, ShapePrior};
use mesh_core::uncertainty::Uncertainty;
use mesh_core::sampling::SamplingMode;
use nalgebra::Vector3;

fn sample_frame() -> CoordinateFrame {
    CoordinateFrame::from_three_points(
        Vector3::zeros(),
        Vector3::new(1.0, 0.0, 0.0),
        Vector3::new(0.0, 0.0, 1.0),
    )
    .unwrap()
}

fn sample_point(name: &str, x: f64, y: f64, z: f64) -> MeasuredPoint {
    MeasuredPoint {
        name: name.into(),
        position: Vector3::new(x, y, z),
        uncertainty: Uncertainty::Isotropic(2.0),
        source: PointSource::TotalStation,
    }
}

#[test]
fn full_collection_round_trips_through_yaml() {
    let mp = MeasuredPoints {
        screen_id: "MAIN".into(),
        coordinate_frame: sample_frame(),
        cabinet_array: CabinetArray::rectangle(10, 10, [500.0, 500.0]),
        shape_prior: ShapePrior::Flat,
        points: vec![
            sample_point("MAIN_V001_R001", 0.0, 0.0, 0.0),
            sample_point("MAIN_V005_R005", 2.0, 0.0, 2.0),
        ],
        sampling_mode: SamplingMode::Grid,
    };
    let yaml = serde_yaml::to_string(&mp).unwrap();
    let back: MeasuredPoints = serde_yaml::from_str(&yaml).unwrap();
    assert_eq!(back.screen_id, "MAIN");
    assert_eq!(back.points.len(), 2);
    assert_eq!(back.points[0].name, "MAIN_V001_R001");
    assert_eq!(back.points[0].position, Vector3::new(0.0, 0.0, 0.0));
    assert_eq!(back.cabinet_array.cols, 10);
    assert!(matches!(back.shape_prior, ShapePrior::Flat));
}

#[test]
fn lookup_by_name() {
    let mp = MeasuredPoints {
        screen_id: "MAIN".into(),
        coordinate_frame: sample_frame(),
        cabinet_array: CabinetArray::rectangle(10, 10, [500.0, 500.0]),
        shape_prior: ShapePrior::Flat,
        points: vec![
            sample_point("MAIN_V001_R001", 0.0, 0.0, 0.0),
            sample_point("MAIN_V002_R001", 0.5, 0.0, 0.0),
        ],
        sampling_mode: SamplingMode::Grid,
    };
    let found = mp.find("MAIN_V001_R001").unwrap();
    assert_eq!(found.name, "MAIN_V001_R001");
    assert_eq!(found.position, Vector3::new(0.0, 0.0, 0.0));
    // exact match — prefix should not match
    assert!(mp.find("MAIN_V001").is_none());
    assert!(mp.find("MAIN_V999_R999").is_none());
}
