//! W6 R1: M1(全站仪)+ M2(视觉 BA)融合的核心对齐算法。
//!
//! 纯几何,不认识 `MeasuredPoints` / `CabinetPoseReportFile` —— 那些 IO / DTO
//! 边界的活儿在 `mesh_app::fuse`(ID 匹配 + 落盘)。这里只做一件事:给一组
//! 锚点对应关系(source→target),求 Umeyama/Kabsch 最优刚体(或相似)变换,
//! 并报告每个锚点的对齐残差。
//!
//! source = 视觉重建角点(mm),target = 全站仪测点(mm,独立真值)。

use nalgebra::{Matrix3, Vector3};

use crate::error::CoreError;

/// 一对对应锚点。`name` 是两侧共用的点位标识,供残差表回显与调试。
#[derive(Debug, Clone)]
pub struct AnchorCorrespondence {
    pub name: String,
    pub source: Vector3<f64>,
    pub target: Vector3<f64>,
}

/// 单个锚点对齐后的残差(mm)。
#[derive(Debug, Clone)]
pub struct AnchorResidual {
    pub name: String,
    pub residual_mm: f64,
    pub delta_mm: Vector3<f64>,
}

/// Umeyama 对齐结果:`target ≈ scale * rotation * source + translation`。
#[derive(Debug, Clone)]
pub struct FuseAlignment {
    pub rotation: Matrix3<f64>,
    pub translation: Vector3<f64>,
    pub scale: f64,
    pub anchor_residuals: Vec<AnchorResidual>,
    pub anchor_rms_mm: f64,
}

/// 最少锚点数——SE(3) 6 自由度,3 个非共线点提供 9 个方程,刚好可解;
/// 更少则欠定,不静默降级,直接拒绝。
pub const MIN_ANCHORS: usize = 3;

/// Umeyama 最小二乘刚体/相似配准(Least-squares estimation of transformation
/// parameters between two point patterns, Umeyama 1991)。
///
/// `allow_scale=false` 时退化为 Kabsch(scale 锁 1.0)——视觉重建已经用像素
/// 间距(pixel pitch)定标过,默认不应该再引入一个自由的全局缩放去悄悄吸收
/// 系统性误差;旋转的最优解与 scale 无关,所以两条路径共享同一个 SVD 步骤。
///
/// 少于 [`MIN_ANCHORS`] 个对应点,或 source 锚点退化(零散布,求不出旋转)时
/// 返回 `Err(CoreError::InvalidInput)`。
pub fn align(
    correspondences: &[AnchorCorrespondence],
    allow_scale: bool,
) -> Result<FuseAlignment, CoreError> {
    if correspondences.len() < MIN_ANCHORS {
        return Err(CoreError::InvalidInput(format!(
            "fuse alignment needs >= {MIN_ANCHORS} anchor correspondences, got {}",
            correspondences.len()
        )));
    }

    let n = correspondences.len() as f64;
    let src_mean: Vector3<f64> =
        correspondences.iter().map(|c| c.source).sum::<Vector3<f64>>() / n;
    let dst_mean: Vector3<f64> =
        correspondences.iter().map(|c| c.target).sum::<Vector3<f64>>() / n;

    // Sigma = (1/n) * sum (target_i - target_mean) * (source_i - source_mean)^T
    let mut cov = Matrix3::zeros();
    let mut src_var = 0.0;
    for c in correspondences {
        let sc = c.source - src_mean;
        let dc = c.target - dst_mean;
        cov += dc * sc.transpose();
        src_var += sc.norm_squared();
    }
    cov /= n;
    src_var /= n;

    if !src_var.is_finite() || src_var < 1e-12 {
        return Err(CoreError::InvalidInput(
            "fuse alignment: source anchors are coincident (zero spread) — cannot determine a rotation".into(),
        ));
    }

    let svd = cov.svd(true, true);
    let u = svd
        .u
        .ok_or_else(|| CoreError::InvalidInput("fuse alignment: SVD(U) did not converge".into()))?;
    let v_t = svd
        .v_t
        .ok_or_else(|| CoreError::InvalidInput("fuse alignment: SVD(V^T) did not converge".into()))?;

    // Reflection guard (Umeyama eq. 39/43, as implemented by e.g. Eigen's umeyama.h):
    // if U*V^T is improper (det < 0), flip the sign of the smallest-variance axis.
    let mut d = Matrix3::identity();
    if (u * v_t).determinant() < 0.0 {
        d[(2, 2)] = -1.0;
    }
    let rotation = u * d * v_t;

    let scale = if allow_scale {
        let weighted: f64 = svd
            .singular_values
            .iter()
            .zip(d.diagonal().iter())
            .map(|(s, dd)| s * dd)
            .sum();
        let s = weighted / src_var;
        if !s.is_finite() || s <= 0.0 {
            return Err(CoreError::InvalidInput(format!(
                "fuse alignment: degenerate scale estimate {s}"
            )));
        }
        s
    } else {
        1.0
    };

    let translation = dst_mean - rotation * src_mean * scale;
    let alignment_no_residuals = FuseAlignment {
        rotation,
        translation,
        scale,
        anchor_residuals: Vec::new(),
        anchor_rms_mm: 0.0,
    };

    let mut anchor_residuals = Vec::with_capacity(correspondences.len());
    let mut sq_sum = 0.0;
    for c in correspondences {
        let estimated = apply(&alignment_no_residuals, c.source);
        let delta_mm = c.target - estimated;
        let residual_mm = delta_mm.norm();
        sq_sum += residual_mm * residual_mm;
        anchor_residuals.push(AnchorResidual {
            name: c.name.clone(),
            residual_mm,
            delta_mm,
        });
    }
    let anchor_rms_mm = (sq_sum / n).sqrt();

    Ok(FuseAlignment {
        anchor_residuals,
        anchor_rms_mm,
        ..alignment_no_residuals
    })
}

/// 把对齐变换应用到 source 系的一个点:`scale * rotation * p + translation`。
pub fn apply(alignment: &FuseAlignment, p: Vector3<f64>) -> Vector3<f64> {
    alignment.rotation * p * alignment.scale + alignment.translation
}

#[cfg(test)]
mod tests {
    use super::*;
    use nalgebra::Rotation3;

    fn corners_cube(scale: f64) -> Vec<Vector3<f64>> {
        // 4 个非共面点(3 点已能定 SE(3),这里用 4 个降低数值边界情况)。
        vec![
            Vector3::new(0.0, 0.0, 0.0) * scale,
            Vector3::new(1.0, 0.0, 0.0) * scale,
            Vector3::new(0.0, 1.0, 0.0) * scale,
            Vector3::new(0.0, 0.0, 1.0) * scale,
        ]
    }

    #[test]
    fn errors_on_fewer_than_3_anchors() {
        let pts = corners_cube(1.0);
        let corr: Vec<AnchorCorrespondence> = pts[..2]
            .iter()
            .enumerate()
            .map(|(i, p)| AnchorCorrespondence {
                name: format!("p{i}"),
                source: *p,
                target: *p,
            })
            .collect();
        let err = align(&corr, false).unwrap_err();
        assert!(matches!(err, CoreError::InvalidInput(_)));
        assert!(format!("{err}").contains(">= 3"), "got: {err}");
    }

    #[test]
    fn errors_on_coincident_anchors() {
        let corr: Vec<AnchorCorrespondence> = (0..4)
            .map(|i| AnchorCorrespondence {
                name: format!("p{i}"),
                source: Vector3::new(5.0, 5.0, 5.0),
                target: Vector3::new(5.0, 5.0, 5.0),
            })
            .collect();
        let err = align(&corr, false).unwrap_err();
        assert!(matches!(err, CoreError::InvalidInput(_)));
    }

    #[test]
    fn identity_alignment_has_zero_residual() {
        let pts = corners_cube(500.0);
        let corr: Vec<AnchorCorrespondence> = pts
            .iter()
            .enumerate()
            .map(|(i, p)| AnchorCorrespondence {
                name: format!("p{i}"),
                source: *p,
                target: *p,
            })
            .collect();
        let a = align(&corr, false).unwrap();
        assert!((a.rotation - Matrix3::identity()).norm() < 1e-9);
        assert!(a.translation.norm() < 1e-9);
        assert_eq!(a.scale, 1.0);
        assert!(a.anchor_rms_mm < 1e-9, "rms={}", a.anchor_rms_mm);
        for r in &a.anchor_residuals {
            assert!(r.residual_mm < 1e-9);
        }
    }

    #[test]
    fn recovers_known_rotation_and_translation() {
        let pts = corners_cube(500.0);
        let true_r = Rotation3::from_axis_angle(&Vector3::z_axis(), 30f64.to_radians());
        let true_t = Vector3::new(1234.0, -567.0, 89.0);

        let corr: Vec<AnchorCorrespondence> = pts
            .iter()
            .enumerate()
            .map(|(i, p)| AnchorCorrespondence {
                name: format!("p{i}"),
                source: *p,
                target: true_r * p + true_t,
            })
            .collect();

        let a = align(&corr, false).unwrap();
        assert!(
            (a.rotation - true_r.matrix()).norm() < 1e-6,
            "rotation mismatch: {:?}",
            a.rotation
        );
        assert!(
            (a.translation - true_t).norm() < 1e-6,
            "translation mismatch: {:?}",
            a.translation
        );
        assert_eq!(a.scale, 1.0, "scale must stay locked to 1.0 when allow_scale=false");
        assert!(a.anchor_rms_mm < 1e-6, "rms={}", a.anchor_rms_mm);
    }

    #[test]
    fn scale_stays_locked_when_not_requested() {
        // dst is a genuinely scaled (1.02x) copy of src; with allow_scale=false
        // the fit must NOT chase the scale — it should report nonzero residual
        // instead of silently absorbing the discrepancy into scale=1.02.
        let pts = corners_cube(500.0);
        let true_scale = 1.02;
        let corr: Vec<AnchorCorrespondence> = pts
            .iter()
            .enumerate()
            .map(|(i, p)| AnchorCorrespondence {
                name: format!("p{i}"),
                source: *p,
                target: p * true_scale,
            })
            .collect();
        let a = align(&corr, false).unwrap();
        assert_eq!(a.scale, 1.0);
        assert!(a.anchor_rms_mm > 1.0, "rms={} should reflect the unabsorbed scale error", a.anchor_rms_mm);
    }

    #[test]
    fn allow_scale_recovers_known_scale() {
        let pts = corners_cube(500.0);
        let true_r = Rotation3::from_axis_angle(&Vector3::y_axis(), 12f64.to_radians());
        let true_t = Vector3::new(10.0, 20.0, 30.0);
        let true_scale = 1.02;

        let corr: Vec<AnchorCorrespondence> = pts
            .iter()
            .enumerate()
            .map(|(i, p)| AnchorCorrespondence {
                name: format!("p{i}"),
                source: *p,
                target: (true_r * p) * true_scale + true_t,
            })
            .collect();

        let a = align(&corr, true).unwrap();
        assert!((a.scale - true_scale).abs() < 1e-6, "scale={}", a.scale);
        assert!(a.anchor_rms_mm < 1e-6, "rms={}", a.anchor_rms_mm);
    }

    #[test]
    fn apply_matches_alignment_definition() {
        let pts = corners_cube(500.0);
        let true_r = Rotation3::from_axis_angle(&Vector3::x_axis(), 45f64.to_radians());
        let true_t = Vector3::new(1.0, 2.0, 3.0);
        let corr: Vec<AnchorCorrespondence> = pts
            .iter()
            .enumerate()
            .map(|(i, p)| AnchorCorrespondence {
                name: format!("p{i}"),
                source: *p,
                target: true_r * p + true_t,
            })
            .collect();
        let a = align(&corr, false).unwrap();
        for c in &corr {
            let estimated = apply(&a, c.source);
            assert!((estimated - c.target).norm() < 1e-6);
        }
    }
}
