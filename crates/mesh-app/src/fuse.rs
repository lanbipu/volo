//! W6 R1: M1(全站仪)+ M2(视觉 BA)融合的 service-layer helper。
//!
//! Tauri GUI 的 `#[tauri::command]` 与 volo-cli 的子命令都通过 thin shim 调用
//! 本文件的 `run_fuse`。核心对齐算法在 `mesh_core::fuse`(纯几何,不认识
//! DTO);本文件只负责两侧命名约定的 ID 匹配 + 落盘。
//!
//! ## 点位命名约定(实测核对,非猜测)
//!
//! - M1 `MeasuredPoints.points[].name` 是**网格顶点**名
//!   `{screen_id}_V{col:03}_R{row:03}`,`col∈[1,cols+1]`、`row∈[1,rows+1]`,
//!   1-based(见 `mesh_core::reconstruct::{direct,grid_check,nominal}`)。
//! - M2 `CabinetPoseEntry.cabinet_id`(cabinet_pose_report.json)是**箱体**索引
//!   `V{col:03}_R{row:03}`,`col∈[0,cols)`、`row∈[0,rows)`,0-based,**不带**
//!   screen 前缀(见 `sidecars/mesh-vba/.../reconstruct.py:270` `_cabinet_id`;
//!   FIX-13 注释里提到的 "MAIN_ 前缀 + 0-based" 是已经删除的旧
//!   `measured.yaml` 写出路径,与当前 pose report 的 `cabinet_id` 无关)。
//!   `corners_mm[4]` 顺序固定 BL,BR,TR,TL(reconstruct.py 的
//!   `_active_surface_corners_mm` docstring,仿射变换保序)。
//!
//! 两个 ID 空间不是同一套——融合前先把每个箱体的 4 个角点分解成它触达的 4
//! 个网格顶点(0-based 箱体 (col,row) 的 BL/BR/TR/TL 分别对应顶点
//! (col,row)/(col+1,row)/(col+1,row+1)/(col,row+1)),换算成 M1 的
//! 1-based 顶点名再去 `MeasuredPoints::find`。相邻箱体共享的顶点会产生多个
//! 视觉估计,取均值后再匹配,避免因加权不对称影响对齐。

use std::collections::HashMap;
use std::path::Path;

use nalgebra::{Matrix3, Vector3};

use mesh_core::fuse::{align, apply, AnchorCorrespondence, FuseAlignment, MIN_ANCHORS};
use volo_shared::dto::{CabinetPoseReportFile, FuseAnchorResidual, FuseResult};
use volo_shared::error::{VoloError, VoloResult};

/// 箱体 4 角点(BL,BR,TR,TL)相对箱体自身 (col,row) 的顶点偏移。
const CORNER_VERTEX_OFFSETS: [(u32, u32); 4] = [(0, 0), (1, 0), (1, 1), (0, 1)];

/// 解析 python sidecar 写出的 `cabinet_id`(`V{col:03d}_R{row:03d}`,0-based,
/// 无 screen 前缀)。格式不符返回 `None`。
fn parse_cabinet_id(id: &str) -> Option<(u32, u32)> {
    let rest = id.strip_prefix('V')?;
    let (col_str, row_str) = rest.split_once("_R")?;
    let col = col_str.parse::<u32>().ok()?;
    let row = row_str.parse::<u32>().ok()?;
    Some((col, row))
}

/// 0-based 箱体 (col,row) 的第 `corner_idx`(0=BL,1=BR,2=TR,3=TL)个角点，
/// 换算成 M1 的 1-based 网格顶点名。
pub(crate) fn corner_vertex_name(screen_id: &str, col0: u32, row0: u32, corner_idx: usize) -> String {
    let (dc, dr) = CORNER_VERTEX_OFFSETS[corner_idx];
    format!("{screen_id}_V{:03}_R{:03}", col0 + dc + 1, row0 + dr + 1)
}

/// 把 pose report 的全部箱体角点按顶点名分组求均值,得到"视觉侧"每个网格顶点
/// 的世界系估计(mm)。`cabinet_id` 不符合预期格式时返回明确错误(不静默跳过)。
pub(crate) fn build_visual_vertex_points(
    screen_id: &str,
    report: &CabinetPoseReportFile,
) -> VoloResult<HashMap<String, Vector3<f64>>> {
    let mut sums: HashMap<String, (Vector3<f64>, u32)> = HashMap::new();
    let mut bad_ids = Vec::new();
    for entry in &report.cabinet_poses {
        let Some((col0, row0)) = parse_cabinet_id(&entry.cabinet_id) else {
            bad_ids.push(entry.cabinet_id.clone());
            continue;
        };
        for (i, corner) in entry.corners_mm.iter().enumerate() {
            let name = corner_vertex_name(screen_id, col0, row0, i);
            let p = Vector3::new(corner[0], corner[1], corner[2]);
            let e = sums.entry(name).or_insert((Vector3::zeros(), 0));
            e.0 += p;
            e.1 += 1;
        }
    }
    if !bad_ids.is_empty() {
        return Err(VoloError::InvalidInput(format!(
            "pose report has {} cabinet_id(s) not matching the expected 0-based 'V###_R###' \
             format: {bad_ids:?}",
            bad_ids.len()
        )));
    }
    Ok(sums
        .into_iter()
        .map(|(name, (sum, n))| (name, sum / n as f64))
        .collect())
}

/// 3x3 协方差(mm²)在 `q = scale*R*p + t` 下的变换:`Cov(q) = scale^2 * R * Cov(p) * R^T`。
fn transform_covariance(rotation: &Matrix3<f64>, scale: f64, cov: &[[f64; 3]; 3]) -> [[f64; 3]; 3] {
    let m = Matrix3::new(
        cov[0][0], cov[0][1], cov[0][2], cov[1][0], cov[1][1], cov[1][2], cov[2][0], cov[2][1],
        cov[2][2],
    );
    let out = rotation * m * rotation.transpose() * (scale * scale);
    [
        [out[(0, 0)], out[(0, 1)], out[(0, 2)]],
        [out[(1, 0)], out[(1, 1)], out[(1, 2)]],
        [out[(2, 0)], out[(2, 1)], out[(2, 2)]],
    ]
}

/// 把对齐变换应用到整份 pose report(全部箱体的 corners_mm + covariance_mm2)。
fn apply_alignment_to_report(
    report: &CabinetPoseReportFile,
    alignment: &FuseAlignment,
) -> CabinetPoseReportFile {
    let mut fused = report.clone();
    for entry in fused.cabinet_poses.iter_mut() {
        for corner in entry.corners_mm.iter_mut() {
            let p = Vector3::new(corner[0], corner[1], corner[2]);
            let q = apply(alignment, p);
            *corner = [q.x, q.y, q.z];
        }
        if let Some(cov) = entry.covariance_mm2.as_mut() {
            *cov = transform_covariance(&alignment.rotation, alignment.scale, cov);
        }
    }
    fused
}

fn build_result_dto(
    screen_id: &str,
    alignment: &FuseAlignment,
    anchor_count: usize,
    allow_scale: bool,
    fused_pose_report_path: &Path,
) -> FuseResult {
    let r = &alignment.rotation;
    FuseResult {
        screen_id: screen_id.to_string(),
        anchor_count,
        rotation: [
            [r[(0, 0)], r[(0, 1)], r[(0, 2)]],
            [r[(1, 0)], r[(1, 1)], r[(1, 2)]],
            [r[(2, 0)], r[(2, 1)], r[(2, 2)]],
        ],
        translation_mm: [
            alignment.translation.x,
            alignment.translation.y,
            alignment.translation.z,
        ],
        scale: alignment.scale,
        scale_locked: !allow_scale,
        anchor_residuals: alignment
            .anchor_residuals
            .iter()
            .map(|res| FuseAnchorResidual {
                point_name: res.name.clone(),
                residual_mm: res.residual_mm,
                delta_mm: [res.delta_mm.x, res.delta_mm.y, res.delta_mm.z],
            })
            .collect(),
        anchor_rms_mm: alignment.anchor_rms_mm,
        fused_pose_report_path: fused_pose_report_path.display().to_string(),
    }
}

/// 融合一个 screen 的 M2 视觉重建(`pose_report_path`)与 M1 全站仪测量
/// (`measurements_path`):按 grid-vertex 名匹配对应点,Umeyama 对齐,
/// 把变换后的完整 pose report 写到
/// `<project_path>/measurements/<screen_id>_fused_pose_report.json`
/// (与 `visual::run_reconstruct` 的产物同目录、命名风格一致)。
///
/// `allow_scale=false`(默认/保守选择)锁 scale=1.0——视觉重建已经用像素
/// 间距定标,不应该再引入一个自由缩放悄悄吸收系统性误差;传 true 时对齐
/// 用相似变换求解,`FuseResult.scale` 回显估计出的尺度偏差。
///
/// 少于 [`MIN_ANCHORS`] 个匹配锚点时返回 `InvalidInput`(不静默降级)。
pub fn run_fuse(
    project_path: &Path,
    screen_id: &str,
    pose_report_path: &Path,
    measurements_path: &Path,
    allow_scale: bool,
) -> VoloResult<FuseResult> {
    let report = crate::visual::load_pose_report(pose_report_path)?;
    let measured = crate::measurements::load_measurements_from_path(measurements_path)?;

    let visual_vertices = build_visual_vertex_points(screen_id, &report)?;

    let mut correspondences: Vec<AnchorCorrespondence> = visual_vertices
        .iter()
        .filter_map(|(name, visual_mm)| {
            measured.find(name).map(|mp| AnchorCorrespondence {
                name: name.clone(),
                source: *visual_mm,
                // M1 MeasuredPoint.position 是米,融合内部统一用毫米。
                target: mp.position * 1000.0,
            })
        })
        .collect();
    // 确定性顺序,便于残差表 / 测试断言复现。
    correspondences.sort_by(|a, b| a.name.cmp(&b.name));

    if correspondences.len() < MIN_ANCHORS {
        return Err(VoloError::InvalidInput(format!(
            "fuse: only {} of {} visual grid-vertex points matched a name in measured.yaml \
             (need >= {MIN_ANCHORS}); visual cabinet_id is 0-based 'V###_R###' mapped to \
             1-based grid-vertex names '{{screen}}_V###_R###' — check screen_id and that \
             measured.yaml covers the same grid range",
            correspondences.len(),
            visual_vertices.len()
        )));
    }

    let alignment = align(&correspondences, allow_scale)?;
    let fused_report = apply_alignment_to_report(&report, &alignment);

    let measurements_dir = project_path.join("measurements");
    std::fs::create_dir_all(&measurements_dir)?;
    let out_path = measurements_dir.join(format!("{screen_id}_fused_pose_report.json"));
    let tmp_path = measurements_dir.join(format!("{screen_id}_fused_pose_report.json.tmp"));
    let json = serde_json::to_string_pretty(&fused_report)?;
    std::fs::write(&tmp_path, json)?;
    std::fs::rename(&tmp_path, &out_path)?;

    Ok(build_result_dto(
        screen_id,
        &alignment,
        correspondences.len(),
        allow_scale,
        &out_path,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use mesh_core::coordinate::CoordinateFrame;
    use mesh_core::measured_points::MeasuredPoints;
    use mesh_core::point::{MeasuredPoint, PointSource};
    use mesh_core::sampling::SamplingMode;
    use mesh_core::shape::{CabinetArray, ShapePrior};
    use mesh_core::uncertainty::Uncertainty;
    use nalgebra::Rotation3;
    use tempfile::tempdir;
    use volo_shared::dto::{CabinetPoseEntry, PoseReportFrame};

    /// 2x2 箱体(3x3 网格顶点),flat,500mm 见方。M1 测点是精确的 nominal grid
    /// (identity frame,单位米);M2 pose report 是同一 nominal grid 施加已知
    /// 整体平移 + 旋转(mm,模拟系统性配准误差)。
    fn nominal_vertex_mm(col1: u32, row1: u32) -> Vector3<f64> {
        // col1/row1 是 1-based 顶点索引;每格 500mm。
        Vector3::new((col1 - 1) as f64 * 500.0, (row1 - 1) as f64 * 500.0, 0.0)
    }

    fn seed_measured(dir: &Path, screen_id: &str) -> std::path::PathBuf {
        let mut points = Vec::new();
        for row1 in 1..=3u32 {
            for col1 in 1..=3u32 {
                let mm = nominal_vertex_mm(col1, row1);
                points.push(MeasuredPoint {
                    name: format!("{screen_id}_V{col1:03}_R{row1:03}"),
                    position: mm / 1000.0,
                    uncertainty: Uncertainty::Isotropic(1.0),
                    source: PointSource::TotalStation,
                });
            }
        }
        let measured = MeasuredPoints {
            screen_id: screen_id.to_string(),
            coordinate_frame: CoordinateFrame {
                origin_world: [0.0, 0.0, 0.0],
                basis: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
            },
            cabinet_array: CabinetArray::rectangle(2, 2, [500.0, 500.0]),
            shape_prior: ShapePrior::Flat,
            points,
            sampling_mode: SamplingMode::Grid,
        };
        let measurements_dir = dir.join("measurements");
        std::fs::create_dir_all(&measurements_dir).unwrap();
        let path = measurements_dir.join("measured.yaml");
        std::fs::write(&path, serde_yaml::to_string(&measured).unwrap()).unwrap();
        path
    }

    /// 构造一份注入已知系统性变形(整体旋转 + 平移)的 pose report:2x2
    /// 箱体,0-based cabinet_id,corners_mm 顺序 BL,BR,TR,TL。
    fn seed_pose_report(
        dir: &Path,
        screen_id: &str,
        distortion_r: &Rotation3<f64>,
        distortion_t: Vector3<f64>,
    ) -> std::path::PathBuf {
        let mut cabinet_poses = Vec::new();
        for row0 in 0..2u32 {
            for col0 in 0..2u32 {
                let bl = nominal_vertex_mm(col0 + 1, row0 + 1);
                let br = nominal_vertex_mm(col0 + 2, row0 + 1);
                let tr = nominal_vertex_mm(col0 + 2, row0 + 2);
                let tl = nominal_vertex_mm(col0 + 1, row0 + 2);
                let corners_mm = [bl, br, tr, tl].map(|p| {
                    let q = distortion_r * p + distortion_t;
                    [q.x, q.y, q.z]
                });
                cabinet_poses.push(CabinetPoseEntry {
                    cabinet_id: format!("V{col0:03}_R{row0:03}"),
                    corners_mm,
                    observed_views: 0,
                    covariance_mm2: Some([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]),
                });
            }
        }
        let report = CabinetPoseReportFile {
            schema_version: "visual_pose_report.v1".into(),
            frame: PoseReportFrame::default(),
            cabinet_poses,
        };
        let dir_path = dir.join("visual");
        std::fs::create_dir_all(&dir_path).unwrap();
        let path = dir_path.join(format!("{screen_id}_cabinet_pose_report.json"));
        std::fs::write(&path, serde_json::to_string_pretty(&report).unwrap()).unwrap();
        path
    }

    #[test]
    fn fuse_recovers_injected_distortion_and_shrinks_residual() {
        let dir = tempdir().unwrap();
        let screen_id = "MAIN";
        let measured_path = seed_measured(dir.path(), screen_id);

        let true_r = Rotation3::from_axis_angle(&Vector3::z_axis(), 5f64.to_radians());
        let true_t = Vector3::new(120.0, -80.0, 15.0);
        let pose_path = seed_pose_report(dir.path(), screen_id, &true_r, true_t);

        // Pre-alignment error at a representative anchor (V001_R001, visual origin
        // corner) should equal the injected translation's norm (nominal is at the
        // origin, so distortion(0) = true_t exactly).
        let pre_error_mm = true_t.norm();

        let result = run_fuse(dir.path(), screen_id, &pose_path, &measured_path, false).unwrap();

        assert_eq!(result.anchor_count, 9, "3x3 grid vertices should all match");
        // Alignment must recover the injected rotation/translation almost exactly
        // (synthetic data is noise-free) — residual should collapse near zero,
        // i.e. drop by >> the tolerance band, not just "improve a little".
        assert!(
            result.anchor_rms_mm < 1e-6,
            "anchor_rms_mm={} should collapse to ~0 for noise-free synthetic distortion",
            result.anchor_rms_mm
        );
        assert!(
            result.anchor_rms_mm < pre_error_mm * 0.2,
            "post-fit rms {} should be far below the {}mm injected pre-fit error",
            result.anchor_rms_mm,
            pre_error_mm
        );
        assert!(result.scale_locked);
        assert_eq!(result.scale, 1.0);

        // The fit maps source(visual, distorted) -> target(M1, nominal), so the
        // recovered transform is the INVERSE of the injected distortion:
        // g(v) = R^T*v - R^T*t undoes v = R*p + t. Noise-free synthetic data ->
        // recovery should be near-exact (well within the ±20% acceptance band).
        let expected_r = true_r.inverse();
        let expected_t = -(expected_r * true_t);
        let recovered_t = Vector3::new(
            result.translation_mm[0],
            result.translation_mm[1],
            result.translation_mm[2],
        );
        let t_err = (recovered_t - expected_t).norm();
        assert!(
            t_err < expected_t.norm() * 0.2,
            "recovered translation {:?} should be within 20% of the inverse-distortion {:?}",
            recovered_t,
            expected_t
        );

        assert!(std::path::Path::new(&result.fused_pose_report_path).is_file());
        let fused: CabinetPoseReportFile = serde_json::from_str(
            &std::fs::read_to_string(&result.fused_pose_report_path).unwrap(),
        )
        .unwrap();
        assert_eq!(fused.cabinet_poses.len(), 4);
        // After alignment, cabinet V000_R000's BL corner should land back near
        // the nominal origin (0,0,0) — the distortion has been undone.
        let bl = fused.cabinet_poses[0].corners_mm[0];
        assert!(
            (bl[0].powi(2) + bl[1].powi(2) + bl[2].powi(2)).sqrt() < 1.0,
            "fused BL corner should be back near origin, got {bl:?}"
        );
    }

    #[test]
    fn fuse_errors_when_fewer_than_3_anchors_match() {
        let dir = tempdir().unwrap();
        let screen_id = "MAIN";
        // Only seed a single M1 point so matching necessarily produces < 3 anchors.
        let measured = MeasuredPoints {
            screen_id: screen_id.to_string(),
            coordinate_frame: CoordinateFrame {
                origin_world: [0.0, 0.0, 0.0],
                basis: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
            },
            cabinet_array: CabinetArray::rectangle(2, 2, [500.0, 500.0]),
            shape_prior: ShapePrior::Flat,
            points: vec![MeasuredPoint {
                name: format!("{screen_id}_V001_R001"),
                position: Vector3::zeros(),
                uncertainty: Uncertainty::Isotropic(1.0),
                source: PointSource::TotalStation,
            }],
            sampling_mode: SamplingMode::Grid,
        };
        let measurements_dir = dir.path().join("measurements");
        std::fs::create_dir_all(&measurements_dir).unwrap();
        let measured_path = measurements_dir.join("measured.yaml");
        std::fs::write(&measured_path, serde_yaml::to_string(&measured).unwrap()).unwrap();

        let pose_path = seed_pose_report(
            dir.path(),
            screen_id,
            &Rotation3::identity(),
            Vector3::zeros(),
        );

        let err = run_fuse(dir.path(), screen_id, &pose_path, &measured_path, false).unwrap_err();
        assert!(matches!(err, VoloError::InvalidInput(_)), "got: {err:?}");
        assert!(format!("{err}").contains(">= 3"), "got: {err}");
    }

    #[test]
    fn fuse_errors_on_malformed_cabinet_id() {
        let dir = tempdir().unwrap();
        let screen_id = "MAIN";
        let measured_path = seed_measured(dir.path(), screen_id);

        let report = CabinetPoseReportFile {
            schema_version: "visual_pose_report.v1".into(),
            frame: PoseReportFrame::default(),
            cabinet_poses: vec![CabinetPoseEntry {
                // Legacy/foreign naming (screen-prefixed, per the removed FIX-13
                // measured.yaml writer) must not silently pass through.
                cabinet_id: "MAIN_V000_R000".into(),
                corners_mm: [[0.0, 0.0, 0.0]; 4],
                observed_views: 0,
                covariance_mm2: None,
            }],
        };
        let visual_dir = dir.path().join("visual");
        std::fs::create_dir_all(&visual_dir).unwrap();
        let pose_path = visual_dir.join(format!("{screen_id}_cabinet_pose_report.json"));
        std::fs::write(&pose_path, serde_json::to_string(&report).unwrap()).unwrap();

        let err = run_fuse(dir.path(), screen_id, &pose_path, &measured_path, false).unwrap_err();
        assert!(matches!(err, VoloError::InvalidInput(_)), "got: {err:?}");
        assert!(format!("{err}").contains("MAIN_V000_R000"), "got: {err}");
    }

    #[test]
    fn fuse_allow_scale_reports_scale_deviation() {
        let dir = tempdir().unwrap();
        let screen_id = "MAIN";
        let measured_path = seed_measured(dir.path(), screen_id);

        // Inject a pure 1.03x scale (no rotation/translation) — the sidecar's
        // pixel-pitch calibration is slightly off in this scenario.
        let scale = 1.03;
        let mut cabinet_poses = Vec::new();
        for row0 in 0..2u32 {
            for col0 in 0..2u32 {
                let bl = nominal_vertex_mm(col0 + 1, row0 + 1) * scale;
                let br = nominal_vertex_mm(col0 + 2, row0 + 1) * scale;
                let tr = nominal_vertex_mm(col0 + 2, row0 + 2) * scale;
                let tl = nominal_vertex_mm(col0 + 1, row0 + 2) * scale;
                cabinet_poses.push(CabinetPoseEntry {
                    cabinet_id: format!("V{col0:03}_R{row0:03}"),
                    corners_mm: [bl, br, tr, tl].map(|p| [p.x, p.y, p.z]),
                    observed_views: 0,
                    covariance_mm2: None,
                });
            }
        }
        let report = CabinetPoseReportFile {
            schema_version: "visual_pose_report.v1".into(),
            frame: PoseReportFrame::default(),
            cabinet_poses,
        };
        let visual_dir = dir.path().join("visual");
        std::fs::create_dir_all(&visual_dir).unwrap();
        let pose_path = visual_dir.join(format!("{screen_id}_cabinet_pose_report.json"));
        std::fs::write(&pose_path, serde_json::to_string(&report).unwrap()).unwrap();

        let locked = run_fuse(dir.path(), screen_id, &pose_path, &measured_path, false).unwrap();
        assert_eq!(locked.scale, 1.0);
        assert!(locked.anchor_rms_mm > 1.0, "locked scale must NOT absorb the 3% error");

        let free = run_fuse(dir.path(), screen_id, &pose_path, &measured_path, true).unwrap();
        assert!(!free.scale_locked);
        // source(visual) = nominal * scale, so the fit's recovered scale is the
        // CORRECTIVE factor 1/scale that maps visual back down onto M1 nominal.
        let expected_scale = 1.0 / scale;
        assert!(
            (free.scale - expected_scale).abs() < 1e-3,
            "scale={} should recover the corrective 1/{}={}",
            free.scale,
            scale,
            expected_scale
        );
        assert!(free.anchor_rms_mm < 1e-6);
    }
}
