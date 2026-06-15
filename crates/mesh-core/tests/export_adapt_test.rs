use mesh_core::export::adapt::adapt_to_target;
use mesh_core::surface::TargetSoftware;
use nalgebra::Vector3;

#[test]
fn neutral_is_identity() {
    let p = Vector3::new(1.0, 2.0, 3.0);
    assert_eq!(adapt_to_target(&p, TargetSoftware::Neutral), p);
}

#[test]
fn disguise_swaps_y_z() {
    // Model: right-hand, +Z up. Disguise: right-hand, +Y up.
    // (x, y, z) → (x, z, -y) keeps right-handedness.
    let p = Vector3::new(1.0, 2.0, 3.0);
    let q = adapt_to_target(&p, TargetSoftware::Disguise);
    assert_eq!(q, Vector3::new(1.0, 3.0, -2.0));
}

#[test]
fn unreal_maps_convex_to_forward_x_and_scales_to_cm() {
    // Model: right-hand, +Z up, m. UE: left-hand, +Z up, cm.
    // (x, y, z) → (100y, 100x, 100z): convex normal +Y → UE +X (forward),
    // columns +X → +Y, height +Z → +Z. Determinant < 0 ⇒ left-handed.
    let p = Vector3::new(1.0, 2.0, 3.0);
    let q = adapt_to_target(&p, TargetSoftware::Unreal);
    assert_eq!(q, Vector3::new(200.0, 100.0, 300.0));

    // Convex (outward) normal model +Y → UE +X (forward).
    let convex = adapt_to_target(&Vector3::new(0.0, 1.0, 0.0), TargetSoftware::Unreal);
    assert_eq!(convex, Vector3::new(100.0, 0.0, 0.0));
    // Height model +Z → UE +Z (up).
    let up = adapt_to_target(&Vector3::new(0.0, 0.0, 1.0), TargetSoftware::Unreal);
    assert_eq!(up, Vector3::new(0.0, 0.0, 100.0));
}
