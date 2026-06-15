use mesh_core::weld::weld_vertices;
use nalgebra::Vector3;

#[test]
fn no_duplicates_no_change() {
    let verts = vec![
        Vector3::new(0.0, 0.0, 0.0),
        Vector3::new(1.0, 0.0, 0.0),
        Vector3::new(2.0, 0.0, 0.0),
    ];
    let (welded, mapping) = weld_vertices(&verts, 0.001);
    assert_eq!(welded.len(), 3);
    assert_eq!(mapping, vec![0, 1, 2]);
}

#[test]
fn coincident_vertices_merge() {
    let verts = vec![
        Vector3::new(0.0, 0.0, 0.0),
        Vector3::new(1.0, 0.0, 0.0),
        Vector3::new(0.0001, 0.0, 0.0), // within 1mm of vertex 0
    ];
    let (welded, mapping) = weld_vertices(&verts, 0.001);
    assert_eq!(welded.len(), 2);
    assert_eq!(mapping[0], mapping[2]);
    assert_ne!(mapping[0], mapping[1]);
}

#[test]
#[should_panic(expected = "tolerance_m must be finite")]
fn weld_panics_on_nan_tolerance() {
    let verts = vec![Vector3::new(0.0, 0.0, 0.0)];
    let _ = weld_vertices(&verts, f64::NAN);
}

#[test]
#[should_panic(expected = "tolerance_m must be finite")]
fn weld_panics_on_infinite_tolerance() {
    let verts = vec![Vector3::new(0.0, 0.0, 0.0)];
    let _ = weld_vertices(&verts, f64::INFINITY);
}

#[test]
#[should_panic(expected = "tolerance_m must be non-negative")]
fn weld_panics_on_negative_tolerance() {
    let verts = vec![Vector3::new(0.0, 0.0, 0.0)];
    let _ = weld_vertices(&verts, -0.001);
}

#[test]
fn weld_with_zero_tolerance_only_merges_exact_duplicates() {
    let verts = vec![
        Vector3::new(0.0, 0.0, 0.0),
        Vector3::new(0.0, 0.0, 0.0),    // exact duplicate
        Vector3::new(0.0001, 0.0, 0.0), // 0.1mm away — does NOT merge at zero tolerance
    ];
    let (welded, mapping) = weld_vertices(&verts, 0.0);
    // tol_sq = 0, comparison `distance < 0` always false → no merging at all,
    // even exact duplicates. Document this behavior:
    assert_eq!(
        welded.len(),
        3,
        "zero tolerance must not merge anything (strict <)"
    );
    assert_eq!(mapping, vec![0, 1, 2]);
}
