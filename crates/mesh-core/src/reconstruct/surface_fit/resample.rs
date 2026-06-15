use nalgebra::{Vector2, Vector3};

use crate::reconstruct::surface_fit::fit::CylinderFit;
use crate::reconstruct::surface_fit::project::Projection;
use crate::surface::GridTopology;
use crate::uv::compute_grid_uv;

/// 行优先 (cols+1)×(rows+1) 顶点，顺序与 `GridTopology::vertex_index`（row 外 col 内）
/// 和 `compute_grid_uv` 对齐。
///
/// θ 从 proj.range[0] 线性插到 proj.range[1]，h 从 proj.range[2] 到 proj.range[3]。
pub fn resample_cylinder(
    cyl: &CylinderFit,
    proj: &Projection,
    cols: u32,
    rows: u32,
) -> Vec<Vector3<f64>> {
    let [t0, t1, h0, h1] = proj.range;
    let mut out = Vec::with_capacity(((cols + 1) * (rows + 1)) as usize);
    for r in 0..=rows {
        let h = h0 + (h1 - h0) * (r as f64 / rows as f64);
        for c in 0..=cols {
            let t = t0 + (t1 - t0) * (c as f64 / cols as f64);
            out.push(Vector3::new(
                cyl.center_xy.x + cyl.radius_m * t.cos(),
                cyl.center_xy.y + cyl.radius_m * t.sin(),
                h,
            ));
        }
    }
    out
}

/// 平面重采样：从 proj.plane_basis 的 origin 沿 u_dir / v_dir 铺均匀网格。
///
/// origin 已是 (umin, vmin) 角点（由 project_plane 保证），所以偏移量从 0 开始
/// 跨越 [0, du] × [0, dv]。
pub fn resample_plane(proj: &Projection, cols: u32, rows: u32) -> Vec<Vector3<f64>> {
    let (origin, u_dir, v_dir) = proj
        .plane_basis
        .expect("resample_plane requires plane_basis");
    let [u0, u1, v0, v1] = proj.range;
    let du = u1 - u0;
    let dv = v1 - v0;
    let mut out = Vec::with_capacity(((cols + 1) * (rows + 1)) as usize);
    for r in 0..=rows {
        let fv = dv * (r as f64 / rows as f64);
        for c in 0..=cols {
            let fu = du * (c as f64 / cols as f64);
            out.push(origin + u_dir * fu + v_dir * fv);
        }
    }
    out
}

/// UV 复用现有 grid UV（与顶点行优先顺序一致）。
pub fn grid_uv(cols: u32, rows: u32) -> Vec<Vector2<f64>> {
    compute_grid_uv(GridTopology { cols, rows })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::reconstruct::surface_fit::fit::fit_cylinder;
    use crate::reconstruct::surface_fit::project::project_cylinder;
    use nalgebra::Vector3;

    #[test]
    fn cylinder_resample_vertex_count_and_on_surface() {
        let r = 9.5_f64;
        let (cx, cy) = (1.0_f64, 0.5_f64);
        let mut pts = vec![];
        for k in 0..40 {
            let t = -1.0 + 2.0 * (k as f64 / 39.0);
            for &z in &[2.0_f64, 4.0_f64] {
                pts.push(Vector3::new(cx + r * t.cos(), cy + r * t.sin(), z));
            }
        }
        let cyl = fit_cylinder(&pts).unwrap();
        let proj = project_cylinder(&pts, &cyl);
        let (cols, rows) = (8u32, 4u32);
        let verts = resample_cylinder(&cyl, &proj, cols, rows);
        assert_eq!(verts.len(), ((cols + 1) * (rows + 1)) as usize);
        for v in &verts {
            let d = ((v.x - cx).powi(2) + (v.y - cy).powi(2)).sqrt();
            assert!((d - r).abs() < 1e-6, "off-surface: d={d}");
        }
    }

    #[test]
    fn plane_resample_vertex_count_and_coplanar() {
        use crate::reconstruct::surface_fit::fit::fit_plane;
        use crate::reconstruct::surface_fit::project::project_plane;

        let mut pts = vec![];
        for i in 0..9 {
            for j in 0..5 {
                pts.push(Vector3::new(i as f64 * 0.25, 0.0_f64, j as f64 * 0.25));
            }
        }
        let pl = fit_plane(&pts).unwrap();
        let (proj, _w) = project_plane(&pts, &pl, 4, 2);
        let (cols, rows) = (4u32, 2u32);
        let verts = resample_plane(&proj, cols, rows);
        assert_eq!(verts.len(), ((cols + 1) * (rows + 1)) as usize);
        // 所有顶点都在 y=0 平面上
        for v in &verts {
            assert!(v.y.abs() < 1e-9, "off-plane: y={}", v.y);
        }
    }

    #[test]
    fn grid_uv_count_matches_vertices() {
        let uvs = grid_uv(4, 2);
        assert_eq!(uvs.len(), 5 * 3);
    }
}
