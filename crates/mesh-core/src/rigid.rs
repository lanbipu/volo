//! Rigid SE(3) transforms for rebuilt-mesh alignment (`P = A ∘ B`).
//!
//! Rotation is stored **row-major** so yaml / TS can round-trip the same layout
//! as `rebuilt_alignment.groups[].rotation` in the project config.

use nalgebra::{Matrix3, Vector3};

use crate::coordinate::CoordinateFrame;
use crate::error::CoreError;

/// Rigid transform `p' = R · p + t` with `R` row-major.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RigidTransform {
    pub rotation: [[f64; 3]; 3],
    pub t_m: [f64; 3],
}

impl RigidTransform {
    pub fn identity() -> Self {
        Self {
            rotation: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
            t_m: [0.0, 0.0, 0.0],
        }
    }

    pub fn translation(t: Vector3<f64>) -> Self {
        Self {
            rotation: Self::identity().rotation,
            t_m: [t.x, t.y, t.z],
        }
    }

    /// Reject non-finite / non-orthonormal / left-handed row-major `R`.
    pub fn validate_rotation(r: &[[f64; 3]; 3]) -> Result<(), String> {
        // Row-major R → columns are (r[0][j], r[1][j], r[2][j]).
        let cols: [Vector3<f64>; 3] = [
            Vector3::new(r[0][0], r[1][0], r[2][0]),
            Vector3::new(r[0][1], r[1][1], r[2][1]),
            Vector3::new(r[0][2], r[1][2], r[2][2]),
        ];
        crate::coordinate::validate_orthonormal_columns(&cols)
            .map_err(|e| format!("rotation {e}"))
    }

    fn matrix(&self) -> Matrix3<f64> {
        Matrix3::new(
            self.rotation[0][0],
            self.rotation[0][1],
            self.rotation[0][2],
            self.rotation[1][0],
            self.rotation[1][1],
            self.rotation[1][2],
            self.rotation[2][0],
            self.rotation[2][1],
            self.rotation[2][2],
        )
    }

    fn from_matrix_t(r: Matrix3<f64>, t: Vector3<f64>) -> Self {
        Self {
            rotation: [
                [r[(0, 0)], r[(0, 1)], r[(0, 2)]],
                [r[(1, 0)], r[(1, 1)], r[(1, 2)]],
                [r[(2, 0)], r[(2, 1)], r[(2, 2)]],
            ],
            t_m: [t.x, t.y, t.z],
        }
    }

    pub fn apply(&self, p: &Vector3<f64>) -> Vector3<f64> {
        self.matrix() * p + Vector3::new(self.t_m[0], self.t_m[1], self.t_m[2])
    }

    /// Apply to many points, building `R` once (export / large meshes).
    pub fn apply_inplace(&self, vertices: &mut [Vector3<f64>]) {
        if self.approx_eq(&Self::identity(), 0.0) {
            return;
        }
        let r = self.matrix();
        let t = Vector3::new(self.t_m[0], self.t_m[1], self.t_m[2]);
        for v in vertices.iter_mut() {
            *v = r * *v + t;
        }
    }

    /// `self ∘ other`: apply `other` first, then `self`.
    pub fn compose(&self, other: &Self) -> Self {
        let r_self = self.matrix();
        let r = r_self * other.matrix();
        let t_other = Vector3::new(other.t_m[0], other.t_m[1], other.t_m[2]);
        let t = r_self * t_other + Vector3::new(self.t_m[0], self.t_m[1], self.t_m[2]);
        Self::from_matrix_t(r, t)
    }

    pub fn invert(&self) -> Self {
        let r_inv = self.matrix().transpose();
        let t = Vector3::new(self.t_m[0], self.t_m[1], self.t_m[2]);
        Self::from_matrix_t(r_inv, -(r_inv * t))
    }

    /// `CoordinateFrame::world_to_model` as an SE(3): `p' = Rᵀ(p − origin)`.
    pub fn from_world_to_model(frame: &CoordinateFrame) -> Self {
        // `basis` columns are R's columns → Rᵀ row-major == `basis` as stored.
        let r_t = Self {
            rotation: frame.basis,
            t_m: [0.0, 0.0, 0.0],
        }
        .matrix();
        let o = Vector3::new(
            frame.origin_world[0],
            frame.origin_world[1],
            frame.origin_world[2],
        );
        Self::from_matrix_t(r_t, -(r_t * o))
    }

    /// Approx equality for tests / idempotence checks.
    pub fn approx_eq(&self, other: &Self, tol: f64) -> bool {
        for i in 0..3 {
            if (self.t_m[i] - other.t_m[i]).abs() > tol {
                return false;
            }
            for j in 0..3 {
                if (self.rotation[i][j] - other.rotation[i][j]).abs() > tol {
                    return false;
                }
            }
        }
        true
    }
}

/// New group alignment `A' = F⁻¹ ∘ A_old` (or pure translation when only O is set).
///
/// `origin` / optional `x_axis` / `xy_plane` are in **current display** coordinates
/// (already include `A_old`). See `docs/calibrate/rebuilt-alignment-spec.md` §5.
pub fn compute_rebuilt_alignment(
    origin: Vector3<f64>,
    x_axis: Option<Vector3<f64>>,
    xy_plane: Option<Vector3<f64>>,
    a_old: &RigidTransform,
) -> Result<RigidTransform, CoreError> {
    match (x_axis, xy_plane) {
        (None, None) => Ok(RigidTransform::translation(-origin).compose(a_old)),
        (Some(x), Some(y)) => {
            let frame = CoordinateFrame::from_three_points_m01(origin, x, y)?;
            Ok(RigidTransform::from_world_to_model(&frame).compose(a_old))
        }
        _ => Err(CoreError::InvalidInput(
            "x_axis and xy_plane must both be set or both omitted".into(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(x: f64, y: f64, z: f64) -> Vector3<f64> {
        Vector3::new(x, y, z)
    }

    /// O at (10,0,0), X along +world-X, Y ref along +world-Z → m01 frame ≈ identity @ O.
    fn sample_oxy() -> (Vector3<f64>, Vector3<f64>, Vector3<f64>) {
        (v(10.0, 0.0, 0.0), v(12.0, 0.0, 0.0), v(10.0, 0.0, 2.0))
    }

    #[test]
    fn identity_compose_and_invert() {
        let a = RigidTransform::translation(v(1.0, 2.0, 3.0));
        assert!(a.compose(&RigidTransform::identity()).approx_eq(&a, 1e-12));
        assert!(a.invert().compose(&a).approx_eq(&RigidTransform::identity(), 1e-12));
    }

    #[test]
    fn validate_rotation_rejects_reflection() {
        let bad = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, -1.0]];
        assert!(RigidTransform::validate_rotation(&bad).is_err());
    }

    #[test]
    fn translation_only_maps_origin_to_zero() {
        let o = v(3.0, -1.0, 4.0);
        let a = compute_rebuilt_alignment(o, None, None, &RigidTransform::identity()).unwrap();
        let o2 = a.apply(&o);
        assert!(o2.norm() < 1e-9, "got {o2:?}");
    }

    #[test]
    fn oxy_maps_refs_per_spec_section_5() {
        let (o, x, y) = sample_oxy();
        let a =
            compute_rebuilt_alignment(o, Some(x), Some(y), &RigidTransform::identity()).unwrap();

        let o2 = a.apply(&o);
        assert!(o2.norm() < 1e-9, "O→0 got {o2:?}");

        let x2 = a.apply(&x);
        assert!(
            (x2.x - 2.0).abs() < 1e-9 && x2.y.abs() < 1e-9 && x2.z.abs() < 1e-9,
            "X→(+d,0,0) got {x2:?}"
        );

        let y2 = a.apply(&y);
        assert!(y2.z > 0.0, "Y height (Z) should be positive, got {y2:?}");
    }

    #[test]
    fn apply_twice_is_idempotent_a7() {
        let (o, x, y) = sample_oxy();
        let a_old = RigidTransform::translation(v(0.5, -0.25, 1.0));
        let a1 = compute_rebuilt_alignment(o, Some(x), Some(y), &a_old).unwrap();

        // After apply, the viewport shows A'∘B. Ref points that were at o/x/y in the
        // old display sit at F⁻¹(o/x/y) now — i.e. A'(A_old⁻¹(p)).
        let a_old_inv = a_old.invert();
        let o2 = a1.apply(&a_old_inv.apply(&o));
        let x2 = a1.apply(&a_old_inv.apply(&x));
        let y2 = a1.apply(&a_old_inv.apply(&y));
        assert!(o2.norm() < 1e-9, "post-align O should be at origin, got {o2:?}");

        let a2 = compute_rebuilt_alignment(o2, Some(x2), Some(y2), &a1).unwrap();
        assert!(
            a2.approx_eq(&a1, 1e-9),
            "second apply should leave A unchanged:\n a1={a1:?}\n a2={a2:?}"
        );
    }

    #[test]
    fn from_world_to_model_matches_frame() {
        let frame = CoordinateFrame::from_three_points_m01(
            v(1.0, 2.0, 3.0),
            v(2.0, 2.0, 3.0),
            v(1.0, 2.0, 4.0),
        )
        .unwrap();
        let se3 = RigidTransform::from_world_to_model(&frame);
        let p = v(5.0, -1.0, 7.0);
        let via_frame = frame.world_to_model(&p);
        let via_se3 = se3.apply(&p);
        assert!((via_frame - via_se3).norm() < 1e-12);
    }
}
