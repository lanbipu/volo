use mesh_adapter_total_station::raw_point::RawPoint;
use nalgebra::Vector3;

#[test]
fn raw_point_construction_holds_fields() {
    let p = RawPoint {
        instrument_id: 7,
        position_mm: Vector3::new(1234.5, 5678.9, 12345.0),
        note: Some("origin marker".into()),
    };
    assert_eq!(p.instrument_id, 7);
    assert_eq!(p.position_mm.x, 1234.5);
    assert_eq!(p.note.as_deref(), Some("origin marker"));
}

#[test]
fn raw_point_position_meters_converts_from_mm() {
    let p = RawPoint {
        instrument_id: 1,
        position_mm: Vector3::new(1000.0, 2000.0, 3000.0),
        note: None,
    };
    let m = p.position_meters();
    assert!((m.x - 1.0).abs() < 1e-9);
    assert!((m.y - 2.0).abs() < 1e-9);
    assert!((m.z - 3.0).abs() < 1e-9);
}
