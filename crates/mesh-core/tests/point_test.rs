use mesh_core::point::{MeasuredPoint, PointSource};
use mesh_core::uncertainty::Uncertainty;
use nalgebra::Vector3;

#[test]
fn point_round_trips_through_yaml() {
    let p = MeasuredPoint {
        name: "MAIN_V001_R005".to_string(),
        position: Vector3::new(0.0, 0.0, 2.0),
        uncertainty: Uncertainty::Isotropic(2.0),
        source: PointSource::TotalStation,
    };
    let s = serde_yaml::to_string(&p).unwrap();
    let back: MeasuredPoint = serde_yaml::from_str(&s).unwrap();
    assert_eq!(back.name, p.name);
    assert_eq!(back.position, p.position);
}

#[test]
fn point_visual_ba_source_carries_camera_count() {
    let p = MeasuredPoint {
        name: "MAIN_V010_R010".to_string(),
        position: Vector3::new(5.0, 0.5, 5.0),
        uncertainty: Uncertainty::Isotropic(3.5),
        source: PointSource::VisualBA { camera_count: 12 },
    };
    let s = serde_yaml::to_string(&p).unwrap();
    assert!(s.contains("camera_count: 12"));
}
