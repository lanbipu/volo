use nalgebra::Vector3;

use crate::reconstruct::surface_fit::fit::{CylinderFit, PlaneFit};

/// 参数空间投影结果。`range = [min_a, max_a, min_b, max_b]`。
/// 圆柱: a=θ(rad), b=h(m，沿轴)。平面: a=u(m), b=v(m)。
pub struct Projection {
    pub range: [f64; 4],
    /// 平面专用：(origin, u_dir, v_dir)（世界系单位基）；圆柱为 None。
    pub plane_basis: Option<(Vector3<f64>, Vector3<f64>, Vector3<f64>)>,
    /// 每个 inlier 的参数坐标 [(a, b)]，与 fit.inliers 顺序对齐。
    /// FIX-12 ②: 范围配准（register.rs）需要逐点参数做相位估计。
    pub params: Vec<[f64; 2]>,
}

pub fn project_cylinder(pts: &[Vector3<f64>], cyl: &CylinderFit) -> Projection {
    debug_assert!(!cyl.inliers.is_empty(), "project_cylinder needs inliers");
    // 角度参考方向 = inlier 角度的圆形均值；每个角度相对它解缠绕到 (-π, π]，使
    // 跨越 θ=±π 安装边界的弧得到连续的 [min, max] 区间。旧实现直接取 atan2 的
    // min/max，弧的安装方位跨 ±π 时 span 会虚高到接近 2π（boundary check 误判屏宽
    // 翻倍）。仍假设弧张角 < π —— 圆形均值对优弧(>π)会指向弧的反侧，超出设计范围。
    let phi_c = {
        let (mut sc, mut ss) = (0.0, 0.0);
        for &i in &cyl.inliers {
            let p = pts[i];
            let t = (p.y - cyl.center_xy.y).atan2(p.x - cyl.center_xy.x);
            sc += t.cos();
            ss += t.sin();
        }
        ss.atan2(sc)
    };
    let (mut min_t, mut max_t) = (f64::INFINITY, f64::NEG_INFINITY);
    let (mut min_h, mut max_h) = (f64::INFINITY, f64::NEG_INFINITY);
    let mut params = Vec::with_capacity(cyl.inliers.len());
    for &i in &cyl.inliers {
        let p = pts[i];
        let raw = (p.y - cyl.center_xy.y).atan2(p.x - cyl.center_xy.x);
        let t = phi_c + wrap_to_pi(raw - phi_c);
        let h = p.z;
        params.push([t, h]);
        min_t = min_t.min(t);
        max_t = max_t.max(t);
        min_h = min_h.min(h);
        max_h = max_h.max(h);
    }
    Projection { range: [min_t, max_t, min_h, max_h], plane_basis: None, params }
}

/// 把角度规范到 (-π, π]。
fn wrap_to_pi(a: f64) -> f64 {
    use std::f64::consts::PI;
    let x = (a + PI).rem_euclid(2.0 * PI) - PI;
    if x <= -PI {
        x + 2.0 * PI
    } else {
        x
    }
}

/// 平面投影 + 定向：u 基取使 Δu:Δv 最接近 cols:rows 的方向，避免网格旋转/镜像。
pub fn project_plane(
    pts: &[Vector3<f64>],
    pl: &PlaneFit,
    cols: u32,
    rows: u32,
) -> (Projection, Vec<String>) {
    let mut warnings: Vec<String> = Vec::new();
    let n = pl.normal;
    let seed = if n.x.abs() < 0.9 {
        Vector3::new(1.0, 0.0, 0.0)
    } else {
        Vector3::new(0.0, 1.0, 0.0)
    };
    let e1 = (seed - n * seed.dot(&n)).normalize();
    let e2 = n.cross(&e1).normalize();
    let proj = |e: &Vector3<f64>| {
        let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
        for &i in &pl.inliers {
            let s = (pts[i] - pl.centroid).dot(e);
            lo = lo.min(s);
            hi = hi.max(s);
        }
        (lo, hi)
    };
    let (e1lo, e1hi) = proj(&e1);
    let (e2lo, e2hi) = proj(&e2);
    let (d1, d2) = (e1hi - e1lo, e2hi - e2lo);
    let target = cols as f64 / rows as f64;
    // FIX-31: detect near-square ambiguity where noise can swap col/row axes.
    let ratio_a = d1 / d2;
    let ratio_b = d2 / d1;
    let margin = (ratio_a - target).abs() - (ratio_b - target).abs();
    if margin.abs() < 0.15 * target {
        warnings.push(format!(
            "grid axis assignment is ambiguous (margin {:.1}% of target ratio {:.2}): \
             near-square measured extent may cause 90° transposition — \
             verify the output grid orientation",
            margin.abs() / target * 100.0,
            target,
        ));
    }
    let (mut u_dir, mut v_dir, mut urange, mut vrange) =
        if (ratio_a - target).abs() <= (ratio_b - target).abs() {
            (e1, e2, (e1lo, e1hi), (e2lo, e2hi))
        } else {
            (e2, e1, (e2lo, e2hi), (e1lo, e1hi))
        };
    // FIX-31: v_dir.z ≈ 0 means the up-direction is noise-determined (ground
    // screens, ceiling mounts, or a transposed near-square grid).
    if v_dir.z.abs() < 0.05 {
        warnings.push(format!(
            "v-axis z-component is near zero ({:.4}): up-direction is unstable — \
             verify row ordering is correct (ground/ceiling screens are susceptible)",
            v_dir.z,
        ));
    }
    // 翻方向时必须同步翻它的 range，否则 origin/range 在非对称点云下算错。
    if v_dir.z < 0.0 {
        v_dir = -v_dir;
        vrange = (-vrange.1, -vrange.0);
    }
    if u_dir.cross(&v_dir).dot(&n) < 0.0 {
        u_dir = -u_dir;
        urange = (-urange.1, -urange.0);
    }
    let origin = pl.centroid + u_dir * urange.0 + v_dir * vrange.0;
    let params = pl
        .inliers
        .iter()
        .map(|&i| {
            let d = pts[i] - pl.centroid;
            [d.dot(&u_dir), d.dot(&v_dir)]
        })
        .collect();
    (
        Projection {
            range: [urange.0, urange.1, vrange.0, vrange.1],
            plane_basis: Some((origin, u_dir, v_dir)),
            params,
        },
        warnings,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::reconstruct::surface_fit::fit::{fit_cylinder, fit_plane};
    use nalgebra::Vector3;

    #[test]
    fn cylinder_param_range_covers_arc() {
        let r = 9.5_f64;
        let mut pts = vec![];
        for k in 0..40 {
            let t = -1.0 + 2.0 * (k as f64 / 39.0);
            for &z in &[2.0_f64, 4.0_f64] {
                pts.push(Vector3::new(1.0 + r * t.cos(), 0.5 + r * t.sin(), z));
            }
        }
        let cyl = fit_cylinder(&pts).unwrap();
        let p = project_cylinder(&pts, &cyl);
        assert!((p.range[1] - p.range[0] - 2.0).abs() < 0.05);
        assert!((p.range[3] - p.range[2] - 2.0).abs() < 0.05);
    }

    /// 弧居中于 θ=π（-x 方向），跨越 atan2 的 ±π 断点。旧实现直接取 min/max
    /// 会得到接近 2π 的虚高 span；解缠绕后应恢复真实张角 2.8 rad。
    /// 回归用例对应真实现场数据（崩铁弧屏安装方位恰好横跨 θ=±π）。
    #[test]
    fn cylinder_param_range_handles_pi_boundary() {
        let r = 9.5_f64;
        let (cx, cy) = (1.0_f64, 0.5_f64);
        let center = std::f64::consts::PI;
        let half = 1.4_f64; // 真实半张角；总张角 2.8 rad
        let mut pts = vec![];
        for k in 0..40 {
            let t = center - half + 2.0 * half * (k as f64 / 39.0);
            for &z in &[2.0_f64, 4.0_f64] {
                pts.push(Vector3::new(cx + r * t.cos(), cy + r * t.sin(), z));
            }
        }
        let cyl = fit_cylinder(&pts).unwrap();
        let p = project_cylinder(&pts, &cyl);
        let span = p.range[1] - p.range[0];
        assert!(
            (span - 2.8).abs() < 0.05,
            "arc crossing θ=±π should yield real span ~2.8, got {span}"
        );
        // resample 出的顶点必须都落在拟合圆柱面上（span 错会撒到屏外）。
        let verts =
            crate::reconstruct::surface_fit::resample::resample_cylinder(&cyl, &p, 8, 4);
        for v in &verts {
            let d = ((v.x - cx).powi(2) + (v.y - cy).powi(2)).sqrt();
            assert!((d - r).abs() < 1e-6, "off-surface vertex: d={d}");
        }
    }

    #[test]
    fn plane_orientation_matches_cabinet_aspect() {
        let mut pts = vec![];
        for i in 0..9 {
            for j in 0..5 {
                pts.push(Vector3::new(i as f64 * 0.25, 0.0, j as f64 * 0.25));
            }
        }
        let pl = fit_plane(&pts).unwrap();
        let (p, _w) = project_plane(&pts, &pl, 4, 2);
        let du = p.range[1] - p.range[0];
        let dv = p.range[3] - p.range[2];
        assert!((du / dv - 2.0).abs() < 0.1, "du={du} dv={dv}");
    }

    /// 非对称点云：在 x=z=0 角堆 30 个重复点，把质心拉离几何中心，使某轴投影
    /// 范围不再 lo=-hi（这里 u 轴变成 (-1.4, 0.6)）。屏 x∈[0,2]、z∈[0,1]，4×2。
    ///
    /// 不变量（不依赖 PCA 法向符号）：origin 必须是 min-u/min-v 真角点 —— 每个 inlier
    /// 投到 (u_dir, v_dir) 相对 origin 的坐标都落在 [0, du]/[0, dv]，且 du≈2、dv≈1。
    ///
    /// 旧代码翻转 u_dir/v_dir 后没同步翻 range，origin 会落到非角点（实测 (1.2,0,-0.4)），
    /// 部分点投影变负 / 超界。对称点云（lo=-hi）下翻不翻一样，所以必须用这个偏心点云才能抓到。
    #[test]
    fn plane_origin_at_min_corner_for_asymmetric_cloud() {
        let mut pts = vec![];
        for i in 0..9 {
            for j in 0..5 {
                pts.push(Vector3::new(i as f64 * 0.25, 0.0, j as f64 * 0.25));
            }
        }
        for _ in 0..30 {
            pts.push(Vector3::new(0.0, 0.0, 0.0));
        }
        let pl = fit_plane(&pts).unwrap();
        let (p, _w) = project_plane(&pts, &pl, 4, 2);
        let du = p.range[1] - p.range[0];
        let dv = p.range[3] - p.range[2];
        assert!((du - 2.0).abs() < 0.05, "du={du}");
        assert!((dv - 1.0).abs() < 0.05, "dv={dv}");
        let (origin, u_dir, v_dir) = p.plane_basis.unwrap();
        let eps = 1e-6;
        for &i in &pl.inliers {
            let d = pts[i] - origin;
            let su = d.dot(&u_dir);
            let sv = d.dot(&v_dir);
            assert!(
                su >= -eps && su <= du + eps,
                "u proj {su} out of [0,{du}] for pt {:?}",
                pts[i]
            );
            assert!(
                sv >= -eps && sv <= dv + eps,
                "v proj {sv} out of [0,{dv}] for pt {:?}",
                pts[i]
            );
        }
    }

    /// FIX-31: a near-square screen (10×8 cabinets) where measured extent is
    /// nearly equal in both directions must emit an ambiguity warning.
    #[test]
    fn near_square_screen_emits_axis_ambiguity_warning() {
        let mut pts = vec![];
        // 10 cols × 8 rows, each cabinet ~0.6m → 6m × 4.8m.
        // But make measured extent nearly square (5.0 × 4.8) by omitting edge columns.
        for i in 1..9 {
            for j in 0..8 {
                pts.push(Vector3::new(i as f64 * 0.6, 0.0, j as f64 * 0.6));
            }
        }
        let pl = fit_plane(&pts).unwrap();
        let (_p, warnings) = project_plane(&pts, &pl, 10, 8);
        assert!(
            warnings.iter().any(|w| w.contains("ambiguous")),
            "near-square extent should warn about axis ambiguity: {warnings:?}"
        );
    }
}
