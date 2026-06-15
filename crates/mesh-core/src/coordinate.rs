use nalgebra::{Matrix3, Vector3};
use serde::{Deserialize, Deserializer, Serialize};

use crate::error::CoreError;

/// 3-point method: origin + X-axis reference + XY-plane reference.
///
/// Internally builds an orthonormal basis via Gram-Schmidt:
///   X = normalize(P_x - P_origin)
///   Z = normalize((P_xy - P_origin) × X)
///   Y = Z × X
///
/// Stores world-frame origin + basis-as-rotation. Translation
/// from world to model is `R^T * (p - origin)`.
///
/// Custom `Deserialize` rejects non-finite values, non-unit-length
/// or non-orthogonal columns, and left-handed bases — preventing
/// imported YAML/JSON from silently poisoning transforms.
#[derive(Debug, Clone, Serialize)]
pub struct CoordinateFrame {
    pub origin_world: [f64; 3],
    pub basis: [[f64; 3]; 3], // columns: X, Y, Z (world frame)
}

#[derive(Deserialize)]
struct CoordinateFrameRaw {
    origin_world: [f64; 3],
    basis: [[f64; 3]; 3],
}

impl<'de> Deserialize<'de> for CoordinateFrame {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let raw = CoordinateFrameRaw::deserialize(d)?;
        validate_origin(&raw.origin_world).map_err(serde::de::Error::custom)?;
        validate_basis(&raw.basis).map_err(serde::de::Error::custom)?;
        Ok(Self {
            origin_world: raw.origin_world,
            basis: raw.basis,
        })
    }
}

fn validate_origin(o: &[f64; 3]) -> Result<(), String> {
    for (i, v) in o.iter().enumerate() {
        if !v.is_finite() {
            return Err(format!("origin[{i}] is not finite: {v}"));
        }
    }
    Ok(())
}

fn validate_basis(b: &[[f64; 3]; 3]) -> Result<(), String> {
    let cols: [Vector3<f64>; 3] = [
        Vector3::new(b[0][0], b[0][1], b[0][2]),
        Vector3::new(b[1][0], b[1][1], b[1][2]),
        Vector3::new(b[2][0], b[2][1], b[2][2]),
    ];
    // finite
    for (i, c) in cols.iter().enumerate() {
        if !c.x.is_finite() || !c.y.is_finite() || !c.z.is_finite() {
            return Err(format!("basis column {i} contains non-finite value"));
        }
    }
    // unit length
    for (i, c) in cols.iter().enumerate() {
        let n = c.norm();
        if (n - 1.0).abs() > 1e-6 {
            return Err(format!("basis column {i} not unit length: norm={n}"));
        }
    }
    // mutual orthogonality
    for i in 0..3 {
        for j in (i + 1)..3 {
            let d = cols[i].dot(&cols[j]);
            if d.abs() > 1e-6 {
                return Err(format!("basis columns {i} and {j} not orthogonal: dot={d}"));
            }
        }
    }
    // right-handed: det = X · (Y × Z) = +1
    let det = cols[0].dot(&cols[1].cross(&cols[2]));
    if (det - 1.0).abs() > 1e-6 {
        return Err(format!("basis not right-handed: det={det}"));
    }
    Ok(())
}

impl CoordinateFrame {
    /// Build a coordinate frame from three world-frame points.
    /// Returns `CoreError::InvalidInput` if points are collinear or coincident.
    pub fn from_three_points(
        origin: Vector3<f64>,
        x_axis_ref: Vector3<f64>,
        xy_plane_ref: Vector3<f64>,
    ) -> Result<Self, CoreError> {
        let dx = x_axis_ref - origin;
        let dxy = xy_plane_ref - origin;

        if dx.norm() < 1e-9 {
            return Err(CoreError::InvalidInput(
                "x-axis reference coincides with origin".into(),
            ));
        }
        if dxy.norm() < 1e-9 {
            return Err(CoreError::InvalidInput(
                "xy-plane reference coincides with origin".into(),
            ));
        }

        let x = dx.normalize();
        let z_unnorm = dxy.cross(&x);
        if z_unnorm.norm() < 1e-9 {
            return Err(CoreError::InvalidInput("three points are collinear".into()));
        }
        let z = z_unnorm.normalize();
        let y = z.cross(&x);

        let basis = [[x.x, x.y, x.z], [y.x, y.y, y.z], [z.x, z.y, z.z]];

        Ok(Self {
            origin_world: [origin.x, origin.y, origin.z],
            basis,
        })
    }

    /// `from_three_points` followed by the M0.1 basis permutation `[b0, b2, -b1]`
    /// → model +X = cols, +Y = screen normal, +Z = rows-up. This is the same
    /// convention the total-station `reference_frame` builder produces; both share
    /// this single definition so visual/SL export and total-station agree.
    pub fn from_three_points_m01(
        origin: Vector3<f64>,
        x_axis_ref: Vector3<f64>,
        xy_plane_ref: Vector3<f64>,
    ) -> Result<Self, CoreError> {
        let native = Self::from_three_points(origin, x_axis_ref, xy_plane_ref)?;
        let b = &native.basis;
        Ok(CoordinateFrame {
            origin_world: native.origin_world,
            basis: [b[0], b[2], [-b[1][0], -b[1][1], -b[1][2]]],
        })
    }

    fn rotation(&self) -> Matrix3<f64> {
        Matrix3::from_columns(&[
            Vector3::new(self.basis[0][0], self.basis[0][1], self.basis[0][2]),
            Vector3::new(self.basis[1][0], self.basis[1][1], self.basis[1][2]),
            Vector3::new(self.basis[2][0], self.basis[2][1], self.basis[2][2]),
        ])
    }

    fn origin(&self) -> Vector3<f64> {
        Vector3::new(
            self.origin_world[0],
            self.origin_world[1],
            self.origin_world[2],
        )
    }

    /// Transform a world-frame point to model frame.
    pub fn world_to_model(&self, world: &Vector3<f64>) -> Vector3<f64> {
        self.rotation().transpose() * (world - self.origin())
    }

    /// Transform a model-frame point back to world.
    pub fn model_to_world(&self, model: &Vector3<f64>) -> Vector3<f64> {
        self.rotation() * model + self.origin()
    }
}
