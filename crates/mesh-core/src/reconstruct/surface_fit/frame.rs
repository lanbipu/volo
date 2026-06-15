use nalgebra::Vector3;

use crate::coordinate::CoordinateFrame;
use crate::reconstruct::surface_fit::fit::CylinderFit;
use crate::reconstruct::surface_fit::project::Projection;
use crate::reconstruct::surface_fit::FrameDerivation;

/// M0.1 IR 坐标系：+X=列(周向)、+Y=法向(径向朝外)、+Z=行向上(竖直)。
/// origin = θmin 对应弧面上 h_min 点（即屏左下角）。
/// 定向基准用弧【中点】θ_mid（不是端点 θ0）——见函数内说明。
///
/// basis 列序 [X, Y, Z]，det = X·(Y×Z) = +1 由数学保证：
///   Y = radial = (cos θ_mid, sin θ_mid, 0)
///   Z = up     = (0, 0, 1)
///   X = radial × up = (sin θ_mid, -cos θ_mid, 0)
///   det = X·(Y×Z) = 1
pub fn derive_cylinder_frame(
    cyl: &CylinderFit,
    proj: &Projection,
) -> (CoordinateFrame, FrameDerivation) {
    let [t0, t1, h0, _h1] = proj.range;

    // origin 仍是 θmin/h_min 角点（屏左下角，M0.1 IR 约定）。
    let origin = Vector3::new(
        cyl.center_xy.x + cyl.radius_m * t0.cos(),
        cyl.center_xy.y + cyl.radius_m * t0.sin(),
        h0,
    );

    // +Y：法向。定向基准用弧【中点】而非端点 θ0——用端点会让整屏朝向偏
    // half_span（这份 165° 弧偏 ~82.6°，在 disguise 里表现为要手动绕竖直轴
    // 纠正 ~90°）。用中点 → 屏中心法向对齐 model +Y（→ disguise -Z），屏正对
    // 默认相机，且对任意张角的弧都成立。
    //
    // ⚠ 局限：法向取「从拟合圆心向外」（弧中点径向），并未钉到真实观众侧——隐含
    // 假设观众在凸面外侧（圆心在屏后）。若安装是 convex-toward-audience（圆心在
    // 观众侧），+Y 会朝后、屏在 disguise 里背面对观众；reprojection 与 compare-known
    // （角度对镜像不变）都抓不到，仅靠下方 warning 提示人工核对 FrameDerivation。
    let t_mid = 0.5 * (t0 + t1);
    let radial = Vector3::new(t_mid.cos(), t_mid.sin(), 0.0);
    // +Z：竖直向上
    let up = Vector3::new(0.0, 0.0, 1.0);
    // +X：周向切线 = radial × up，保证右手系（det=+1）
    let x_col = radial.cross(&up).normalize();

    let basis = [
        [x_col.x, x_col.y, x_col.z],   // X = 周向
        [radial.x, radial.y, radial.z], // Y = 法向
        [up.x, up.y, up.z],             // Z = 竖直
    ];

    let frame = CoordinateFrame {
        origin_world: [origin.x, origin.y, origin.z],
        basis,
    };
    let deriv = FrameDerivation {
        axis: [0.0, 0.0, 1.0],
        origin: [origin.x, origin.y, origin.z],
        unwrap_dir: format!("theta {:.3}->{:.3}", proj.range[0], proj.range[1]),
    };
    (frame, deriv)
}

/// 平面坐标系：+X=列(u_dir)、+Y=法向(v×u)、+Z=行向上(v_dir)。
/// 与圆柱 [周向(列), radial(法向), up(行)] 统一——两者 +Z 都是行向上(up)，
/// 匹配 export adapt 的 model-frame +Z up 约定（adapt.rs:8）。
///
/// basis=[u, v×u, v]，det = u·((v×u)×v) = u·u = 1（v 单位、u⊥v）——手性(det=+1)
/// 恒成立，与 PCA normal 符号无关。列/行方向取 project_plane 的 u_dir/v_dir，与
/// resample 撒点方向一致，避免镜像。
///
/// ⚠ 但法向【朝向】（+Y 指向哪一物理面）取决于 u_dir 的定向，而 project_plane 用
/// `u_dir.cross(v_dir)·n >= 0` 把 u_dir 钉到 PCA 最小特征向量 n 上；n 的符号是
/// 求解器/输入相关的任意符号——所以 +Y 朝向并未钉到真实观众侧，扰动点云可能翻面。
/// 同 cylinder：reprojection / compare-known 抓不到，靠 warning 人工核对。
pub fn derive_plane_frame(
    _normal: Vector3<f64>,
    proj: &Projection,
) -> (CoordinateFrame, FrameDerivation) {
    let (origin, u_dir, v_dir) = proj
        .plane_basis
        .expect("derive_plane_frame requires plane_basis from project_plane");

    let u = u_dir.normalize(); // +X = 列（与 resample 列方向一致）
    let v = v_dir.normalize(); // +Z = 行（竖直向上，符合 export adapt 的 model +Z up）
    let y = v.cross(&u); // +Y = 法向，v×u 保证 [u, y, v] 右手 det=+1

    let basis = [
        [u.x, u.y, u.z], // X = 列
        [y.x, y.y, y.z], // Y = 法向
        [v.x, v.y, v.z], // Z = 行（up）
    ];

    let frame = CoordinateFrame {
        origin_world: [origin.x, origin.y, origin.z],
        basis,
    };
    let deriv = FrameDerivation {
        axis: [y.x, y.y, y.z], // 法向轴 = frame +Y
        origin: [origin.x, origin.y, origin.z],
        unwrap_dir: "planar".into(),
    };
    (frame, deriv)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::reconstruct::surface_fit::fit::{fit_cylinder, fit_plane};
    use crate::reconstruct::surface_fit::project::{project_cylinder, project_plane};
    use nalgebra::Vector3;

    #[test]
    fn cylinder_frame_is_orthonormal_right_handed() {
        let r = 9.5_f64;
        let mut pts = vec![];
        for k in 0..40 {
            let t = -1.0 + 2.0 * (k as f64 / 39.0);
            for &z in &[2.0_f64, 4.0_f64] {
                pts.push(Vector3::new(1.0 + r * t.cos(), 0.5 + r * t.sin(), z));
            }
        }
        let cyl = fit_cylinder(&pts).unwrap();
        let proj = project_cylinder(&pts, &cyl);
        let (frame, deriv) = derive_cylinder_frame(&cyl, &proj);

        // serde 往返触发 CoordinateFrame 的自定义 Deserialize 校验：
        // 正交、单位长度、右手系（det=+1）
        let yaml = serde_yaml::to_string(&frame).unwrap();
        let back: crate::coordinate::CoordinateFrame = serde_yaml::from_str(&yaml).unwrap();
        assert_eq!(back.basis, frame.basis);

        // axis-identity：+Z(basis[2]) = 竖直向上，匹配 export adapt model +Z up
        let z_col = Vector3::new(frame.basis[2][0], frame.basis[2][1], frame.basis[2][2]);
        assert!((z_col - Vector3::new(0.0, 0.0, 1.0)).norm() < 1e-9, "+Z not up: {:?}", z_col);
        // +Y(basis[1]) = 单位径向法向（水平，z≈0）
        let y_col = Vector3::new(frame.basis[1][0], frame.basis[1][1], frame.basis[1][2]);
        assert!((y_col.norm() - 1.0).abs() < 1e-9, "+Y not unit: norm={}", y_col.norm());
        assert!(y_col.z.abs() < 1e-9, "radial normal should be horizontal: {:?}", y_col);

        // 圆柱轴应接近 Z 方向
        assert!(
            deriv.axis[2].abs() > 0.99,
            "axis Z component too small: {:?}",
            deriv.axis
        );
    }

    #[test]
    fn plane_frame_is_orthonormal_right_handed() {
        // 在 xz 平面上的矩形格点，法向 = Y (0,1,0)
        let mut pts = vec![];
        for i in 0..9 {
            for j in 0..5 {
                pts.push(Vector3::new(i as f64 * 0.25, 0.0, j as f64 * 0.25));
            }
        }
        let pl = fit_plane(&pts).unwrap();
        let (proj, _w) = project_plane(&pts, &pl, 4, 2);
        let (frame, deriv) = derive_plane_frame(pl.normal, &proj);

        // serde 往返强制校验 basis 正交/单位/右手
        let yaml = serde_yaml::to_string(&frame).unwrap();
        let back: crate::coordinate::CoordinateFrame = serde_yaml::from_str(&yaml).unwrap();
        assert_eq!(back.basis, frame.basis);

        let (_origin, u_dir, v_dir) = proj.plane_basis.unwrap();
        let u = u_dir.normalize();
        let v = v_dir.normalize();
        // axis-identity：+X(basis[0]) = u_dir(列)
        let x_col = Vector3::new(frame.basis[0][0], frame.basis[0][1], frame.basis[0][2]);
        assert!((x_col - u).norm() < 1e-9, "+X not u_dir(列): {:?} vs {:?}", x_col, u);
        // +Z(basis[2]) = v_dir(行/up)
        let z_col = Vector3::new(frame.basis[2][0], frame.basis[2][1], frame.basis[2][2]);
        assert!((z_col - v).norm() < 1e-9, "+Z not v_dir(行): {:?} vs {:?}", z_col, v);
        // +Y(basis[1]) = v×u 法向，单位长度
        let y_col = Vector3::new(frame.basis[1][0], frame.basis[1][1], frame.basis[1][2]);
        let expect_y = v.cross(&u);
        assert!((y_col - expect_y).norm() < 1e-9, "+Y not v×u: {:?} vs {:?}", y_col, expect_y);
        assert!((y_col.norm() - 1.0).abs() < 1e-9, "+Y not unit: norm={}", y_col.norm());

        // FrameDerivation.axis = 法向(frame +Y)
        let n = deriv.axis;
        assert!((Vector3::new(n[0], n[1], n[2]) - expect_y).norm() < 1e-9, "axis not normal: {:?}", n);
    }
}
