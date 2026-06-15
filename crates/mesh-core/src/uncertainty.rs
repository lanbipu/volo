use nalgebra::Matrix3;
use serde::{Deserialize, Serialize};

/// Per-point measurement uncertainty.
///
/// Serialized as externally tagged (single-key map) — internally
/// tagged is incompatible with tuple variants in serde.
///
/// Variant name `Covariance3x3` matches the spec; YAML form is the
/// shorter `covariance` via the explicit `serde(rename)` attribute.
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
