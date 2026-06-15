//! 散点曲面拟合重建（scatter 路径）。不进 auto_reconstruct 序列，
//! 由 lmt-app 顶层在 sampling_mode==Scatter 时直接调用。

pub mod boundary;
pub mod fit;
pub mod frame;
pub mod project;
pub mod register;
pub mod resample;

use serde::{Deserialize, Serialize};

use crate::error::CoreError;
use crate::measured_points::MeasuredPoints;
use crate::reconstruct::Reconstructor;
use crate::sampling::SamplingMode;
use crate::surface::ReconstructedSurface;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "shape")]
pub enum ScatterShape {
    Plane { normal: [f64; 3] },
    Cylinder { radius_mm: f64, axis: [f64; 3] },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScatterOutlier {
    pub point_id: String,
    pub source_row: usize,
    pub coordinates: [f64; 3],
    pub residual_mm: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrameDerivation {
    pub axis: [f64; 3],
    pub origin: [f64; 3],
    pub unwrap_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoundaryCheck {
    pub verdict: String,
    pub projected_size_mm: [f64; 2],
    pub expected_size_mm: [f64; 2],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScatterFit {
    pub shape: ScatterShape,
    pub inlier_count: usize,
    pub outliers: Vec<ScatterOutlier>,
    pub param_range: [f64; 4],
    pub boundary_check: BoundaryCheck,
    pub frame_derivation: FrameDerivation,
}

pub struct SurfaceFitReconstructor;

impl Reconstructor for SurfaceFitReconstructor {
    fn name(&self) -> &'static str {
        "surface_fit"
    }
    fn applicable(&self, points: &MeasuredPoints) -> bool {
        points.sampling_mode == SamplingMode::Scatter
    }
    fn reconstruct(&self, points: &MeasuredPoints) -> Result<ReconstructedSurface, CoreError> {
        use crate::reconstruct::surface_fit::{boundary, fit, frame, project, resample};
        use crate::shape::ShapePrior;
        use crate::surface::{GridTopology, QualityMetrics, ReconstructedSurface};

        let cols = points.cabinet_array.cols;
        let rows = points.cabinet_array.rows;
        let raw: Vec<_> = points.points.iter().map(|p| p.position).collect();
        if raw.len() < 5 {
            return Err(CoreError::Reconstruction(
                "scatter needs >=5 points".into(),
            ));
        }

        // FIX-12 ③: 倾斜的圆柱屏违反竖直轴假设 → 拒绝（>1° 且杠杆臂足够）。
        const CYLINDER_TILT_REJECT_DEG: f64 = 1.0;
        // 已知屏幕物理跨度（米），用于 FIX-12 ② 的范围配准。
        let cab_w_m = points.cabinet_array.cabinet_size_mm[0] / 1000.0;
        let cab_h_m = points.cabinet_array.cabinet_size_mm[1] / 1000.0;

        let mut warnings: Vec<String> = vec![];
        // resid_m[i] = 第 i 个输入点到拟合形状的法向距离（米）— FIX-12 ①
        let (
            verts_world,
            cframe,
            deriv,
            shape,
            inliers,
            outlier_idx,
            proj_size_m,
            param_range,
            resid_m,
        ) = match &points.shape_prior {
            ShapePrior::Curved { .. } => {
                let cyl = fit::fit_cylinder(&raw).ok_or_else(|| {
                    CoreError::Reconstruction("cylinder fit failed".into())
                })?;
                if let Some(tilt) = fit::cylinder_tilt_deg(&raw, &cyl) {
                    if tilt > CYLINDER_TILT_REJECT_DEG {
                        return Err(CoreError::Reconstruction(format!(
                            "cylinder fit appears tilted ~{tilt:.1}° — the scatter \
                             cylinder model assumes a VERTICAL axis; re-level the \
                             measurement frame or correct the shape prior"
                        )));
                    }
                }
                let resid: Vec<f64> = raw
                    .iter()
                    .map(|p| {
                        ((nalgebra::Vector2::new(p.x, p.y) - cyl.center_xy).norm()
                            - cyl.radius_m)
                            .abs()
                    })
                    .collect();
                let mut proj = project::project_cylinder(&raw, &cyl);
                // 原始测量跨度先留给 boundary check（数据合理性诊断）。
                let raw_width_m = cyl.radius_m * (proj.range[1] - proj.range[0]);
                let raw_height_m = proj.range[3] - proj.range[2];
                // FIX-12 ②: 已知跨度配准替代 min/max。
                let pitch_t = cab_w_m / cyl.radius_m;
                let ts: Vec<f64> = proj.params.iter().map(|p| p[0]).collect();
                let hs: Vec<f64> = proj.params.iter().map(|p| p[1]).collect();
                let (t0, t1, lock_t) = register::register_range_1d(
                    &ts, pitch_t, cols as f64 * pitch_t, proj.range[0], proj.range[1]);
                let (h0, h1, lock_h) = register::register_range_1d(
                    &hs, cab_h_m, rows as f64 * cab_h_m, proj.range[2], proj.range[3]);
                if !(lock_t && lock_h) {
                    warnings.push(
                        "scatter range: known screen span placed by centering the \
                         measured extent (samples show no cabinet-pitch phase lock)"
                            .into(),
                    );
                }
                proj.range = [t0, t1, h0, h1];
                let (f, d) = frame::derive_cylinder_frame(&cyl, &proj);
                let verts = resample::resample_cylinder(&cyl, &proj, cols, rows);
                (
                    verts,
                    f,
                    d,
                    ScatterShape::Cylinder {
                        radius_mm: cyl.radius_m * 1000.0,
                        axis: [0.0, 0.0, 1.0],
                    },
                    cyl.inliers,
                    cyl.outliers,
                    [raw_width_m, raw_height_m],
                    proj.range,
                    resid,
                )
            }
            ShapePrior::Flat => {
                let pl = fit::fit_plane(&raw).ok_or_else(|| {
                    CoreError::Reconstruction("plane fit failed".into())
                })?;
                let resid: Vec<f64> = raw
                    .iter()
                    .map(|p| pl.normal.dot(&(p - pl.centroid)).abs())
                    .collect();
                let (mut proj, proj_warnings) = project::project_plane(&raw, &pl, cols, rows);
                warnings.extend(proj_warnings);
                let raw_width_m = proj.range[1] - proj.range[0];
                let raw_height_m = proj.range[3] - proj.range[2];
                let us: Vec<f64> = proj.params.iter().map(|p| p[0]).collect();
                let vs: Vec<f64> = proj.params.iter().map(|p| p[1]).collect();
                let (u0, u1, lock_u) = register::register_range_1d(
                    &us, cab_w_m, cols as f64 * cab_w_m, proj.range[0], proj.range[1]);
                let (v0, v1, lock_v) = register::register_range_1d(
                    &vs, cab_h_m, rows as f64 * cab_h_m, proj.range[2], proj.range[3]);
                if !(lock_u && lock_v) {
                    warnings.push(
                        "scatter range: known screen span placed by centering the \
                         measured extent (samples show no cabinet-pitch phase lock)"
                            .into(),
                    );
                }
                // origin 是 (umin, vmin) 角点 — range 平移后必须同步平移。
                if let Some((origin, u_dir, v_dir)) = proj.plane_basis {
                    let origin = origin
                        + u_dir * (u0 - proj.range[0])
                        + v_dir * (v0 - proj.range[2]);
                    proj.plane_basis = Some((origin, u_dir, v_dir));
                }
                proj.range = [u0, u1, v0, v1];
                let (f, d) = frame::derive_plane_frame(pl.normal, &proj);
                let verts = resample::resample_plane(&proj, cols, rows);
                (
                    verts,
                    f,
                    d,
                    ScatterShape::Plane {
                        normal: [pl.normal.x, pl.normal.y, pl.normal.z],
                    },
                    pl.inliers,
                    pl.outliers,
                    [raw_width_m, raw_height_m],
                    proj.range,
                    resid,
                )
            }
            ShapePrior::Folded { .. } => {
                return Err(CoreError::Reconstruction(
                    "folded prior not supported in scatter mode".into(),
                ));
            }
        };

        let ratio = inliers.len() as f64 / raw.len() as f64;
        if ratio < 0.5 {
            return Err(CoreError::Reconstruction(format!(
                "inlier ratio {ratio:.2} below 0.5 — scatter data does not fit the shape prior"
            )));
        }

        let bcheck = boundary::check_boundary(proj_size_m, &points.cabinet_array);
        if bcheck.verdict == "reject" {
            return Err(CoreError::Reconstruction(format!(
                "boundary check rejected: projected {:?}mm vs expected {:?}mm",
                bcheck.projected_size_mm, bcheck.expected_size_mm
            )));
        }

        let vertices: Vec<_> = verts_world.iter().map(|w| cframe.world_to_model(w)).collect();
        let uv_coords = resample::grid_uv(cols, rows);

        // FIX-12 ①: 真实残差 — outlier 带实际拟合残差；rms/p95 统计 inlier 残差。
        let outliers: Vec<ScatterOutlier> = outlier_idx
            .iter()
            .map(|&i| ScatterOutlier {
                point_id: points.points[i].name.clone(),
                source_row: i,
                coordinates: [raw[i].x, raw[i].y, raw[i].z],
                residual_mm: resid_m[i] * 1000.0,
            })
            .collect();
        let outlier_ids: Vec<String> = outliers.iter().map(|o| o.point_id.clone()).collect();
        let inlier_resid_mm: Vec<f64> =
            inliers.iter().map(|&i| resid_m[i] * 1000.0).collect();
        let stats = crate::reconstruct::grid_check::residual_stats_mm(&inlier_resid_mm);

        let method = match shape {
            ScatterShape::Cylinder { .. } => "surface_fit_cylinder",
            ScatterShape::Plane { .. } => "surface_fit_plane",
        };
        if bcheck.verdict == "warning" {
            warnings.push(
                "boundary size deviates from cabinet array; verify edge coverage".into(),
            );
        }
        warnings.push(
            "facing (+Y normal) auto-derived from fit and NOT audience-pinned; \
             verify the screen is not back-facing (see FrameDerivation in report)"
                .into(),
        );

        let scatter_fit = ScatterFit {
            shape,
            inlier_count: inliers.len(),
            outliers,
            param_range,
            boundary_check: bcheck,
            frame_derivation: deriv,
        };

        let quality_metrics = QualityMetrics {
            method: method.into(),
            measured_count: inliers.len(),
            expected_count: ((cols + 1) * (rows + 1)) as usize,
            outliers: outlier_ids,
            estimated_rms_mm: stats.map(|(rms, _)| rms),
            estimated_p95_mm: stats.map(|(_, p95)| p95),
            warnings,
            ..Default::default()
        };

        Ok(ReconstructedSurface {
            screen_id: points.screen_id.clone(),
            topology: GridTopology { cols, rows },
            vertices,
            uv_coords,
            quality_metrics,
            scatter_fit: Some(scatter_fit),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::reconstruct::Reconstructor;
    use crate::sampling::SamplingMode;
    use crate::test_support::minimal_scatter_points;

    #[test]
    fn applicable_only_for_scatter() {
        let mut mp = minimal_scatter_points();
        assert!(SurfaceFitReconstructor.applicable(&mp));
        mp.sampling_mode = SamplingMode::Grid;
        assert!(!SurfaceFitReconstructor.applicable(&mp));
    }

    #[test]
    fn reconstruct_cylinder_end_to_end() {
        use crate::coordinate::CoordinateFrame;
        use crate::measured_points::MeasuredPoints;
        use crate::point::{MeasuredPoint, PointSource};
        use crate::sampling::SamplingMode;
        use crate::shape::{CabinetArray, ShapePrior};
        use crate::uncertainty::Uncertainty;
        use nalgebra::Vector3;

        let r = 9.523_f64;
        let (cx, cy) = (0.0_f64, 0.0_f64);
        let mk = |p: Vector3<f64>, n: &str| MeasuredPoint {
            name: n.into(),
            position: p,
            uncertainty: Uncertainty::Isotropic(1.0),
            source: PointSource::TotalStation,
        };
        let mut points = vec![];
        for k in 0..60 {
            let t = -1.4 + 2.8 * (k as f64 / 59.0);
            for (li, &z) in [0.0_f64, 7.5].iter().enumerate() {
                points.push(mk(
                    Vector3::new(cx + r * t.cos(), cy + r * t.sin(), z),
                    &format!("row{k}_{li}"),
                ));
            }
        }
        points.push(mk(
            Vector3::new(cx + 0.3, cy, 3.0),
            "row999_CD1",
        )); // 杂点

        let mp = MeasuredPoints {
            screen_id: "MAIN".into(),
            coordinate_frame: CoordinateFrame {
                origin_world: [0.0; 3],
                basis: [[1., 0., 0.], [0., 1., 0.], [0., 0., 1.]],
            },
            cabinet_array: CabinetArray::rectangle(55, 15, [500.0, 500.0]),
            shape_prior: ShapePrior::Curved { radius_mm: 9523.0 },
            points,
            sampling_mode: SamplingMode::Scatter,
        };

        let surf = SurfaceFitReconstructor.reconstruct(&mp).unwrap();
        assert_eq!(surf.vertices.len(), (56 * 16) as usize);
        assert_eq!(surf.uv_coords.len(), surf.vertices.len());
        let sf = surf.scatter_fit.as_ref().unwrap();
        match &sf.shape {
            ScatterShape::Cylinder { radius_mm, .. } => {
                assert!((radius_mm - 9523.0).abs() < 50.0)
            }
            _ => panic!("expected cylinder"),
        }
        assert_eq!(sf.outliers.len(), 1);
        // FIX-12: outlier 必须带真实拟合残差(到圆柱面的法向距离),不再是 0。
        assert!(
            sf.outliers[0].residual_mm > 1000.0,
            "outlier residual_mm should be meters-scale, got {}",
            sf.outliers[0].residual_mm
        );
        // inlier 残差统计可计算(合成数据 → 接近 0 但 Some)。
        assert!(surf.quality_metrics.estimated_rms_mm.is_some());
        assert!(surf.quality_metrics.estimated_p95_mm.is_some());
        assert!(surf.quality_metrics.estimated_rms_mm.unwrap() < 5.0);
        assert_eq!(surf.quality_metrics.method, "surface_fit_cylinder");
        // 朝向：model frame +Z=up，圆柱屏高 7.5m → model z 跨度≈7.5
        let zmin = surf
            .vertices
            .iter()
            .map(|v| v.z)
            .fold(f64::INFINITY, f64::min);
        let zmax = surf
            .vertices
            .iter()
            .map(|v| v.z)
            .fold(f64::NEG_INFINITY, f64::max);
        assert!(
            (zmax - zmin - 7.5).abs() < 0.2,
            "model-frame height span={}",
            zmax - zmin
        );
    }

    fn scatter_points(
        pts: Vec<crate::point::MeasuredPoint>,
        cols: u32,
        rows: u32,
        prior: crate::shape::ShapePrior,
    ) -> MeasuredPoints {
        use crate::coordinate::CoordinateFrame;
        use crate::shape::CabinetArray;
        MeasuredPoints {
            screen_id: "MAIN".into(),
            coordinate_frame: CoordinateFrame {
                origin_world: [0.0; 3],
                basis: [[1., 0., 0.], [0., 1., 0.], [0., 0., 1.]],
            },
            cabinet_array: CabinetArray::rectangle(cols, rows, [500.0, 500.0]),
            shape_prior: prior,
            points: pts,
            sampling_mode: SamplingMode::Scatter,
        }
    }

    fn mk_pt(p: nalgebra::Vector3<f64>, n: &str) -> crate::point::MeasuredPoint {
        use crate::point::{MeasuredPoint, PointSource};
        use crate::uncertainty::Uncertainty;
        MeasuredPoint {
            name: n.into(),
            position: p,
            uncertainty: Uncertainty::Isotropic(1.0),
            source: PointSource::TotalStation,
        }
    }

    /// FIX-12 ② 验收:删掉最外列测量点,total_size 误差 < 10mm
    /// (min/max 会缩水一整列 = 500mm;已知跨度 + 相位配准恢复真实宽度)。
    #[test]
    fn scatter_plane_range_registration_survives_missing_edge_column() {
        use nalgebra::Vector3;
        let (cols, rows) = (4u32, 2u32);
        let mut pts = vec![];
        // 角点网格 0.5m pitch,x ∈ {0..2.0} —— 但最外列 x=2.0 不测。
        for c in 0..cols {
            for r in 0..=rows {
                pts.push(mk_pt(
                    Vector3::new(c as f64 * 0.5, 0.0, r as f64 * 0.5),
                    &format!("free_{c}_{r}"),
                ));
            }
        }
        let mp = scatter_points(pts, cols, rows, crate::shape::ShapePrior::Flat);
        let surf = SurfaceFitReconstructor.reconstruct(&mp).unwrap();
        // 第一行格点 (0,0)→(cols,0) 的欧氏距离 = 重建宽度。
        let topo = surf.topology;
        let w = (surf.vertices[topo.vertex_index(cols, 0)]
            - surf.vertices[topo.vertex_index(0, 0)])
        .norm();
        assert!(
            (w - 2.0).abs() < 0.010,
            "registered width should be 2.0m ±10mm, got {w}"
        );
        let h = (surf.vertices[topo.vertex_index(0, rows)]
            - surf.vertices[topo.vertex_index(0, 0)])
        .norm();
        assert!((h - 1.0).abs() < 0.010, "height {h}");
    }

    /// FIX-12 ③ 验收:倾斜安装的圆柱屏违反竖直轴假设 → 拒绝而非静默偏置。
    #[test]
    fn scatter_cylinder_rejects_tilted_axis() {
        use nalgebra::Vector3;
        let r = 9.5_f64;
        let alpha = 1.2_f64.to_radians(); // 绕 x 轴倾斜 1.2°
        let (s, c) = alpha.sin_cos();
        let mut pts = vec![];
        for k in 0..40 {
            let t = -1.2 + 2.4 * (k as f64 / 39.0);
            for h in 0..5 {
                let (x, y, z) = (r * t.cos(), r * t.sin(), h as f64);
                pts.push(mk_pt(
                    Vector3::new(x, y * c - z * s, y * s + z * c),
                    &format!("tilt_{k}_{h}"),
                ));
            }
        }
        let mp = scatter_points(pts, 55, 8, crate::shape::ShapePrior::Curved { radius_mm: 9500.0 });
        let err = SurfaceFitReconstructor.reconstruct(&mp).unwrap_err();
        assert!(
            err.to_string().contains("tilted"),
            "expected tilt rejection, got: {err}"
        );
    }
}
