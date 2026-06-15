use mesh_adapter_total_station::raw_point::RawPoint;
use mesh_adapter_total_station::reference_frame::build_frame_from_first_three;
use nalgebra::Vector3;

fn rp(id: u32, x: f64, y: f64, z: f64) -> RawPoint {
    RawPoint {
        instrument_id: id,
        position_mm: Vector3::new(x, y, z),
        note: None,
    }
}

#[test]
fn xy_plane_marker_lands_on_positive_z_in_model() {
    // M0.1 convention (per crates/core/tests/fixtures/curved_demo_points.yaml):
    //   model +X = cols, model +Z = rows-up, model +Y = screen normal.
    // raw[2] is the xy-plane marker — 1 row up the screen from origin.
    // In model frame it must therefore land on +Z, not +Y or -Y. This test
    // catches the basis Y/Z permutation contract.
    let raw = vec![
        rp(1, 0.0, 0.0, 0.0),    // origin → (0,0,0)
        rp(2, 2000.0, 0.0, 0.0), // x-axis → (+2m X)
        rp(3, 0.0, 0.0, 1000.0), // xy-plane marker, 1m above origin
    ];
    let frame = build_frame_from_first_three(&raw).unwrap();
    let xy = frame.world_to_model(&Vector3::new(0.0, 0.0, 1.0));
    assert!(
        (xy - Vector3::new(0.0, 0.0, 1.0)).norm() < 1e-9,
        "xy-plane marker must land on +Z (rows-up) in model frame, got {:?}",
        xy
    );
}

#[test]
fn build_frame_uses_first_three_points_in_meters() {
    // origin at (10000mm, 10000mm, 10000mm) = (10m, 10m, 10m)
    // x_axis_ref at (12000, 10000, 10000) → +X 2m away
    // xy_plane_ref at (10000, 10000, 13000) → up = +Y after Gram-Schmidt
    let raw = vec![
        rp(1, 10000.0, 10000.0, 10000.0),
        rp(2, 12000.0, 10000.0, 10000.0),
        rp(3, 10000.0, 10000.0, 13000.0),
        rp(4, 99999.0, 0.0, 0.0), // ignored
    ];
    let frame = build_frame_from_first_three(&raw).unwrap();

    let origin_in_model = frame.world_to_model(&Vector3::new(10.0, 10.0, 10.0));
    assert!(origin_in_model.norm() < 1e-9);

    let x_in_model = frame.world_to_model(&Vector3::new(12.0, 10.0, 10.0));
    assert!((x_in_model - Vector3::new(2.0, 0.0, 0.0)).norm() < 1e-9);
}

#[test]
fn build_frame_rejects_fewer_than_three_points() {
    let raw = vec![rp(1, 0.0, 0.0, 0.0), rp(2, 1.0, 0.0, 0.0)];
    let result = build_frame_from_first_three(&raw);
    assert!(result.is_err());
}

#[test]
fn build_frame_rejects_collinear_first_three() {
    let raw = vec![
        rp(1, 0.0, 0.0, 0.0),
        rp(2, 1000.0, 0.0, 0.0),
        rp(3, 2000.0, 0.0, 0.0),
        rp(4, 0.0, 0.0, 1000.0),
    ];
    let result = build_frame_from_first_three(&raw);
    assert!(result.is_err());
}

#[test]
fn build_frame_requires_instrument_ids_to_be_first_three() {
    // Plan SOP: first 3 points (by instrument_id 1, 2, 3) are reference markers.
    // If the input is not sorted, function should error.
    let raw = vec![
        rp(2, 0.0, 0.0, 0.0),
        rp(1, 1000.0, 0.0, 0.0),
        rp(3, 0.0, 0.0, 1000.0),
    ];
    let result = build_frame_from_first_three(&raw);
    assert!(result.is_err());
}

#[test]
fn build_frame_rejects_baseline_below_sop_minimum() {
    // origin→x_axis = 50mm (below 100mm SOP minimum).
    let raw = vec![
        rp(1, 0.0, 0.0, 0.0),
        rp(2, 50.0, 0.0, 0.0),
        rp(3, 0.0, 0.0, 1000.0),
    ];
    let err = build_frame_from_first_three(&raw).unwrap_err();
    assert!(format!("{err}").contains("baseline"));
}

#[test]
fn build_frame_rejects_xy_plane_near_x_axis_line() {
    // xy_plane sits 1mm off the x-axis line — formally non-collinear but
    // the perpendicular distance (1mm) is well below SOP minimum.
    let raw = vec![
        rp(1, 0.0, 0.0, 0.0),
        rp(2, 2000.0, 0.0, 0.0),
        rp(3, 1000.0, 0.0, 1.0),
    ];
    let err = build_frame_from_first_three(&raw).unwrap_err();
    assert!(format!("{err}").contains("perpendicular"));
}
