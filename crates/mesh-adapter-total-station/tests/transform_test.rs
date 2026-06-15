use mesh_adapter_total_station::raw_point::RawPoint;
use mesh_adapter_total_station::reference_frame::build_frame_from_first_three;
use mesh_adapter_total_station::transform::transform_to_model;
use nalgebra::Vector3;

fn rp(id: u32, x: f64, y: f64, z: f64) -> RawPoint {
    RawPoint {
        instrument_id: id,
        position_mm: Vector3::new(x, y, z),
        note: None,
    }
}

#[test]
fn transform_returns_one_position_per_input_point() {
    let raw = vec![
        rp(1, 0.0, 0.0, 0.0),
        rp(2, 1000.0, 0.0, 0.0),
        rp(3, 0.0, 0.0, 1000.0),
        rp(4, 500.0, 0.0, 500.0),
    ];
    let frame = build_frame_from_first_three(&raw).unwrap();
    let model = transform_to_model(&raw, &frame);
    assert_eq!(model.len(), 4);
    // Origin reference point (id=1) → (0, 0, 0)
    assert!(model[0].1.norm() < 1e-9);
    // X-axis reference (id=2) → (1, 0, 0)
    assert!((model[1].1 - Vector3::new(1.0, 0.0, 0.0)).norm() < 1e-9);
    // pair preserves instrument id
    assert_eq!(model[3].0, 4);
}
