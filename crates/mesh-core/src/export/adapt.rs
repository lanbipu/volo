use nalgebra::Vector3;

use crate::surface::TargetSoftware;

/// Adapt a model-frame vertex to the target software's coordinate
/// system + units.
///
/// Model frame: right-handed, +Z up, meters. Convex (outward) normal = +Y,
/// columns = +X, height = +Z.
/// - Disguise: right-handed, +Y up, meters.  (x, y, z) → (x, z, -y).
///   Screen ends up facing ±Z; `build` reverses winding + mirrors U so the lit
///   face lands on the concave (audience) side.
/// - Unreal: left-handed, +Z up, cm.  (x, y, z) → (100y, 100x, 100z).
///   Maps convex normal +Y → UE +X (forward), columns +X → +Y, height +Z → +Z.
///   `build` keeps model winding (no reversal): empirically the lit face lands
///   on the concave side under UE's rendering, so no swap/U-mirror is applied.
/// - Neutral:  identity (debugging).
///
/// Winding handling is per-target and lives in `build::surface_to_mesh_output`
/// (the conventions differ by software and were pinned empirically against
/// disguise / UE imports), not driven mechanically by handedness here.
pub fn adapt_to_target(p: &Vector3<f64>, target: TargetSoftware) -> Vector3<f64> {
    match target {
        TargetSoftware::Neutral => *p,
        TargetSoftware::Disguise => Vector3::new(p.x, p.z, -p.y),
        TargetSoftware::Unreal => Vector3::new(p.y * 100.0, p.x * 100.0, p.z * 100.0),
    }
}
