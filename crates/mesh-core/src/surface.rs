use nalgebra::{Vector2, Vector3};
use serde::{Deserialize, Serialize};

use crate::reconstruct::surface_fit::ScatterFit;

/// Maximum allowed cabinet count per axis (prevents pathological allocations
/// + overflow). 10_000 × 10_000 cabinets = 100M vertices upper bound, far
///   beyond any realistic LED screen.
pub const MAX_GRID_DIM: u32 = 10_000;

/// Grid topology for a single screen.
/// Vertex count = (cols + 1) * (rows + 1).
#[derive(Debug, Clone, Copy, Serialize)]
pub struct GridTopology {
    pub cols: u32,
    pub rows: u32,
}

#[derive(Deserialize)]
struct GridTopologyRaw {
    cols: u32,
    rows: u32,
}

impl<'de> Deserialize<'de> for GridTopology {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let raw = GridTopologyRaw::deserialize(d)?;
        if raw.cols > MAX_GRID_DIM {
            return Err(serde::de::Error::custom(format!(
                "GridTopology.cols {} exceeds MAX_GRID_DIM ({})",
                raw.cols, MAX_GRID_DIM
            )));
        }
        if raw.rows > MAX_GRID_DIM {
            return Err(serde::de::Error::custom(format!(
                "GridTopology.rows {} exceeds MAX_GRID_DIM ({})",
                raw.rows, MAX_GRID_DIM
            )));
        }
        Ok(Self {
            cols: raw.cols,
            rows: raw.rows,
        })
    }
}

impl GridTopology {
    /// Total vertex count = (cols+1) * (rows+1). Panics on arithmetic overflow.
    pub fn vertex_count(&self) -> usize {
        let cols_p1 = (self.cols as usize)
            .checked_add(1)
            .expect("cols+1 overflow");
        let rows_p1 = (self.rows as usize)
            .checked_add(1)
            .expect("rows+1 overflow");
        cols_p1.checked_mul(rows_p1).expect("vertex_count overflow")
    }

    /// Row-major index. Panics if (col, row) out of bounds when usize-multiplied.
    pub fn vertex_index(&self, col: u32, row: u32) -> usize {
        let cols_p1 = (self.cols as usize)
            .checked_add(1)
            .expect("cols+1 overflow");
        (row as usize)
            .checked_mul(cols_p1)
            .and_then(|r| r.checked_add(col as usize))
            .expect("vertex_index overflow")
    }
}

/// Diagnostic metrics produced by the reconstruction step.
///
/// FIX-12: `estimated_rms_mm` / `estimated_p95_mm` are statistics of ACTUAL
/// fit residuals — distances from measured input points to the reconstructed
/// surface — over points that are NOT exactly reproduced by construction.
/// They are `None` when no such holdout exists (exact interpolators:
/// direct_link always, radial_basis always, boundary_interp/nominal without
/// extra interior points). They are never input-σ summaries and never clamped
/// to arbitrary floors (the old `max(5mm)`/`max(8mm)` constants are gone).
/// `shape_fit_rms_mm` was removed: it was never assigned anywhere; for the
/// scatter path the shape-fit residual now IS `estimated_rms_mm`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct QualityMetrics {
    pub method: String,
    pub middle_max_dev_mm: f64,
    pub middle_mean_dev_mm: f64,
    pub measured_count: usize,
    pub expected_count: usize,
    pub missing: Vec<String>,
    pub outliers: Vec<String>,
    #[serde(default)]
    pub estimated_rms_mm: Option<f64>,
    #[serde(default)]
    pub estimated_p95_mm: Option<f64>,
    pub warnings: Vec<String>,
}

/// Reconstructed surface: grid of vertices in model frame, with UVs.
#[derive(Debug, Clone, Serialize)]
pub struct ReconstructedSurface {
    pub screen_id: String,
    pub topology: GridTopology,
    /// (cols+1) × (rows+1) vertices, row-major: `vertex_index(col, row)`.
    #[serde(with = "vec_vector3_serde")]
    pub vertices: Vec<Vector3<f64>>,
    #[serde(with = "vec_vector2_serde")]
    pub uv_coords: Vec<Vector2<f64>>,
    pub quality_metrics: QualityMetrics,
    /// scatter 路径的拟合元数据；grid 路径为 None。
    #[serde(default)]
    pub scatter_fit: Option<ScatterFit>,
}

#[derive(Deserialize)]
struct ReconstructedSurfaceRaw {
    screen_id: String,
    topology: GridTopology,
    #[serde(with = "vec_vector3_serde")]
    vertices: Vec<Vector3<f64>>,
    #[serde(with = "vec_vector2_serde")]
    uv_coords: Vec<Vector2<f64>>,
    quality_metrics: QualityMetrics,
    /// scatter 路径的拟合元数据；grid 路径为 None。
    #[serde(default)]
    scatter_fit: Option<ScatterFit>,
}

impl<'de> Deserialize<'de> for ReconstructedSurface {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let raw = ReconstructedSurfaceRaw::deserialize(d)?;
        let surface = Self {
            screen_id: raw.screen_id,
            topology: raw.topology,
            vertices: raw.vertices,
            uv_coords: raw.uv_coords,
            quality_metrics: raw.quality_metrics,
            scatter_fit: raw.scatter_fit,
        };
        surface
            .validate()
            .map_err(|e| serde::de::Error::custom(e.to_string()))?;
        Ok(surface)
    }
}

/// Target export software (controls coordinate-frame + units).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TargetSoftware {
    /// Right-handed, +Y up, meters.
    Disguise,
    /// Left-handed, +Z up, centimeters.
    Unreal,
    /// Right-handed, +Z up, meters (raw model frame).
    Neutral,
}

/// Final mesh ready for export — already adapted to the target software.
#[derive(Debug, Clone, Serialize)]
pub struct MeshOutput {
    pub target: TargetSoftware,
    #[serde(with = "vec_vector3_serde")]
    pub vertices: Vec<Vector3<f64>>,
    pub triangles: Vec<[u32; 3]>,
    #[serde(with = "vec_vector2_serde")]
    pub uv_coords: Vec<Vector2<f64>>,
}

#[derive(Deserialize)]
struct MeshOutputRaw {
    target: TargetSoftware,
    #[serde(with = "vec_vector3_serde")]
    vertices: Vec<Vector3<f64>>,
    triangles: Vec<[u32; 3]>,
    #[serde(with = "vec_vector2_serde")]
    uv_coords: Vec<Vector2<f64>>,
}

impl<'de> Deserialize<'de> for MeshOutput {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let raw = MeshOutputRaw::deserialize(d)?;
        let mesh = Self {
            target: raw.target,
            vertices: raw.vertices,
            triangles: raw.triangles,
            uv_coords: raw.uv_coords,
        };
        mesh.validate()
            .map_err(|e| serde::de::Error::custom(e.to_string()))?;
        Ok(mesh)
    }
}

mod vec_vector3_serde {
    use nalgebra::Vector3;
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<S: Serializer>(v: &[Vector3<f64>], s: S) -> Result<S::Ok, S::Error> {
        let arr: Vec<[f64; 3]> = v.iter().map(|p| [p.x, p.y, p.z]).collect();
        arr.serialize(s)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<Vector3<f64>>, D::Error> {
        let arr: Vec<[f64; 3]> = Deserialize::deserialize(d)?;
        Ok(arr
            .into_iter()
            .map(|a| Vector3::new(a[0], a[1], a[2]))
            .collect())
    }
}

mod vec_vector2_serde {
    use nalgebra::Vector2;
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<S: Serializer>(v: &[Vector2<f64>], s: S) -> Result<S::Ok, S::Error> {
        let arr: Vec<[f64; 2]> = v.iter().map(|p| [p.x, p.y]).collect();
        arr.serialize(s)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<Vector2<f64>>, D::Error> {
        let arr: Vec<[f64; 2]> = Deserialize::deserialize(d)?;
        Ok(arr.into_iter().map(|a| Vector2::new(a[0], a[1])).collect())
    }
}

use crate::error::CoreError;

impl ReconstructedSurface {
    /// Verify struct invariants: vertices count matches topology, UVs
    /// count matches vertices, all coordinates finite. Used by export
    /// boundaries to reject malformed deserialized data.
    pub fn validate(&self) -> Result<(), CoreError> {
        let expected = self.topology.vertex_count();
        if self.vertices.len() != expected {
            return Err(CoreError::InvalidInput(format!(
                "ReconstructedSurface.vertices.len() {} != topology.vertex_count() {}",
                self.vertices.len(),
                expected
            )));
        }
        if self.uv_coords.len() != self.vertices.len() {
            return Err(CoreError::InvalidInput(format!(
                "ReconstructedSurface.uv_coords.len() {} != vertices.len() {}",
                self.uv_coords.len(),
                self.vertices.len()
            )));
        }
        for (i, v) in self.vertices.iter().enumerate() {
            if !v.x.is_finite() || !v.y.is_finite() || !v.z.is_finite() {
                return Err(CoreError::InvalidInput(format!(
                    "ReconstructedSurface.vertices[{i}] contains non-finite value"
                )));
            }
        }
        for (i, uv) in self.uv_coords.iter().enumerate() {
            if !uv.x.is_finite() || !uv.y.is_finite() {
                return Err(CoreError::InvalidInput(format!(
                    "ReconstructedSurface.uv_coords[{i}] contains non-finite value"
                )));
            }
        }
        Ok(())
    }
}

impl MeshOutput {
    /// Verify struct invariants: UVs count matches vertices, all triangles
    /// reference valid vertex indices, all coordinates finite. Used by
    /// writers (OBJ etc.) before serialization.
    pub fn validate(&self) -> Result<(), CoreError> {
        let n = self.vertices.len();
        if self.uv_coords.len() != n {
            return Err(CoreError::InvalidInput(format!(
                "MeshOutput.uv_coords.len() {} != vertices.len() {}",
                self.uv_coords.len(),
                n
            )));
        }
        let n_u32 = n as u32;
        for (i, t) in self.triangles.iter().enumerate() {
            for &idx in t {
                if idx >= n_u32 {
                    return Err(CoreError::InvalidInput(format!(
                        "MeshOutput.triangles[{i}] index {idx} out of bounds (vertex count {n})"
                    )));
                }
            }
        }
        for (i, v) in self.vertices.iter().enumerate() {
            if !v.x.is_finite() || !v.y.is_finite() || !v.z.is_finite() {
                return Err(CoreError::InvalidInput(format!(
                    "MeshOutput.vertices[{i}] contains non-finite value"
                )));
            }
        }
        for (i, uv) in self.uv_coords.iter().enumerate() {
            if !uv.x.is_finite() || !uv.y.is_finite() {
                return Err(CoreError::InvalidInput(format!(
                    "MeshOutput.uv_coords[{i}] contains non-finite value"
                )));
            }
        }
        Ok(())
    }
}
