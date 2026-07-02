use nalgebra::Matrix3;
use serde::{Deserialize, Serialize};

/// Per-point measurement uncertainty.
///
/// Serialized as externally tagged (single-key map) — internally
/// tagged is incompatible with tuple variants in serde.
///
/// Variant name `Covariance3x3` matches the spec; YAML form is the
/// shorter `covariance` via the explicit `serde(rename)` attribute.
///
/// **M1 uncertainty-ledger fix (item 5), explicit non-use note**: BA
/// (bundle adjustment / visual reconstruction) output carries a real
/// anisotropic `Covariance3x3` per point, but `crate::reconstruct` does
/// NOT weight any fit by it — every reconstructor (`direct_link`,
/// `boundary_interp`, `nominal`, `radial_basis`, `surface_fit`) treats all
/// input points as equally trustworthy positions and derives
/// `estimated_rms_mm`/`estimated_p95_mm` purely from geometric holdout /
/// cross-validation residuals (see `reconstruct::grid_check` /
/// `reconstruct::radial_basis::cross_validate_rms_p95`), never from
/// `sigma_approx()` or the raw matrix. This is a deliberate low-cost
/// decision, not an oversight: wiring per-point covariance into a
/// weighted fit (or into BA-side pose refinement) is real numerical work
/// with no current consumer request, and would risk exactly the kind of
/// decorative "uses uncertainty but not really" number this fix is meant
/// to eliminate. `covariance()` / `sigma_approx()` remain available for
/// callers that DO consume them today
/// (`mesh_adapter_total_station::report_builder` uses `sigma_approx()`
/// for its measured/fabricated split).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Uncertainty {
    /// Single sigma (mm), isotropic. Used by total-station (instrument spec).
    Isotropic(f64),
    /// 3x3 covariance matrix. Used by visual BA output.
    #[serde(rename = "covariance")]
    Covariance3x3(#[serde(with = "matrix3_serde")] Matrix3<f64>),
}

impl Uncertainty {
    /// Convert to a 3x3 covariance matrix.
    pub fn covariance(&self) -> Matrix3<f64> {
        match self {
            Self::Isotropic(sigma) => Matrix3::from_diagonal_element(sigma * sigma),
            Self::Covariance3x3(m) => *m,
        }
    }

    /// Approximate isotropic sigma (for reporting).
    pub fn sigma_approx(&self) -> f64 {
        match self {
            Self::Isotropic(s) => *s,
            Self::Covariance3x3(m) => (m.trace() / 3.0).sqrt(),
        }
    }
}

mod matrix3_serde {
    use nalgebra::Matrix3;
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<S: Serializer>(m: &Matrix3<f64>, s: S) -> Result<S::Ok, S::Error> {
        let arr: [[f64; 3]; 3] = [
            [m[(0, 0)], m[(0, 1)], m[(0, 2)]],
            [m[(1, 0)], m[(1, 1)], m[(1, 2)]],
            [m[(2, 0)], m[(2, 1)], m[(2, 2)]],
        ];
        arr.serialize(s)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Matrix3<f64>, D::Error> {
        let arr: [[f64; 3]; 3] = Deserialize::deserialize(d)?;
        Ok(Matrix3::new(
            arr[0][0], arr[0][1], arr[0][2], arr[1][0], arr[1][1], arr[1][2], arr[2][0], arr[2][1],
            arr[2][2],
        ))
    }
}
