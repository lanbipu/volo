#pragma once

// Ceres AutoDiff cost functions for the vpcal calibration solver.
//
// Residual = project(lens, T_C_from_B * inv(T_sdk) * inv(T_S_from_O) * world_rh)
//            - pixel_detected
//
// This MUST stay numerically identical to the Python reference in
// vpcal/core/transforms.py + projection.py, or simulate->solve will not close.
//
// Quaternions are scalar-first [w, x, y, z] (Ceres convention + vpcal §10.1).

#include <ceres/ceres.h>
#include <ceres/rotation.h>

#include "solver.h"

namespace vpcal {

// Brown-Conrady projection (spec §5.5), templated for AutoDiff.
template <typename T>
inline void project(const LensParams& lens, const T cam[3], T* u, T* v) {
    // Entrance pupil offset (architecture §4.3): shift along the optical axis
    // before the perspective divide, matching OpenLensIO eq. (1).  Fixed lens
    // constant, not a solved parameter — must match vpcal.core.projection.
    const T z = cam[2] - T(lens.entrance_pupil_offset_mm);
    const T xn = cam[0] / z;
    const T yn = cam[1] / z;
    const T r2 = xn * xn + yn * yn;
    const T radial =
        T(1.0) + r2 * (T(lens.k1) + r2 * (T(lens.k2) + r2 * T(lens.k3)));
    const T xd = xn * radial + T(2.0) * T(lens.p1) * xn * yn +
                 T(lens.p2) * (r2 + T(2.0) * xn * xn);
    const T yd = yn * radial + T(lens.p1) * (r2 + T(2.0) * yn * yn) +
                 T(2.0) * T(lens.p2) * xn * yn;
    *u = T(lens.fx) * xd + T(lens.cx);
    *v = T(lens.fy) * yd + T(lens.cy);
}

// Apply inv(rotation) of a unit quaternion q to vector v: R(q)^T * v = R(conj q) * v.
template <typename T>
inline void inverse_rotate(const T q[4], const T v[3], T out[3]) {
    const T qc[4] = {q[0], -q[1], -q[2], -q[3]};
    ceres::UnitQuaternionRotatePoint(qc, v, out);
}

// Reprojection residual for one observation.  Parameters:
//   qs[4], ts[3] : T_S_from_O   (tracker origin -> stage)
//   qc[4], tc[3] : T_C_from_B    (tracker body -> camera)
struct ReprojectionCost {
    ReprojectionCost(const Observation& obs, const LensParams& lens)
        : obs_(obs), lens_(lens) {}

    template <typename T>
    bool operator()(const T* const qs, const T* const ts, const T* const qc,
                    const T* const tc, T* residual) const {
        // P_origin = inv(T_S_from_O) * world_rh = R_S^T * (world - ts)
        const T world[3] = {T(obs_.world_x), T(obs_.world_y), T(obs_.world_z)};
        const T v1[3] = {world[0] - ts[0], world[1] - ts[1], world[2] - ts[2]};
        T p_origin[3];
        inverse_rotate(qs, v1, p_origin);

        // P_body = inv(T_sdk) * P_origin = R_sdk^T * (P_origin - t_sdk)
        const T q_sdk[4] = {T(obs_.track_qw), T(obs_.track_qx), T(obs_.track_qy),
                            T(obs_.track_qz)};
        const T t_sdk[3] = {T(obs_.track_tx), T(obs_.track_ty), T(obs_.track_tz)};
        const T v2[3] = {p_origin[0] - t_sdk[0], p_origin[1] - t_sdk[1],
                         p_origin[2] - t_sdk[2]};
        T p_body[3];
        inverse_rotate(q_sdk, v2, p_body);

        // P_camera = T_C_from_B * P_body = R_C * P_body + tc
        T p_cam[3];
        ceres::UnitQuaternionRotatePoint(qc, p_body, p_cam);
        p_cam[0] += tc[0];
        p_cam[1] += tc[1];
        p_cam[2] += tc[2];

        T u, v;
        project(lens_, p_cam, &u, &v);
        residual[0] = u - T(obs_.pixel_u);
        residual[1] = v - T(obs_.pixel_v);
        return true;
    }

    static ceres::CostFunction* Create(const Observation& obs, const LensParams& lens) {
        return new ceres::AutoDiffCostFunction<ReprojectionCost, 2, 4, 3, 4, 3>(
            new ReprojectionCost(obs, lens));
    }

    const Observation obs_;
    const LensParams lens_;
};

// Prior keeping T_C_from_B near its given value (small-delta, spec §5.2).
// Residual = [ sqrt(w_rot) * 2*vec(q_prior^-1 * qc) ; sqrt(w_trans) * (tc - t_prior) ].
// Rotation (rad) and translation (mm) carry separate weights — one shared
// weight is dimensionally wrong and froze the translation (A3.2).
struct CameraPriorCost {
    CameraPriorCost(const double q_prior[4], const double t_prior[3],
                    double weight_rotation, double weight_translation)
        : weight_rotation_(weight_rotation), weight_translation_(weight_translation) {
        for (int i = 0; i < 4; ++i) q_prior_[i] = q_prior[i];
        for (int i = 0; i < 3; ++i) t_prior_[i] = t_prior[i];
    }

    template <typename T>
    bool operator()(const T* const qc, const T* const tc, T* residual) const {
        // delta = q_prior^-1 * qc
        const T qp_inv[4] = {T(q_prior_[0]), -T(q_prior_[1]), -T(q_prior_[2]),
                             -T(q_prior_[3])};
        T delta[4];
        ceres::QuaternionProduct(qp_inv, qc, delta);
        const T sw_rot = T(std::sqrt(weight_rotation_));
        const T sw_trans = T(std::sqrt(weight_translation_));
        // 2*vector part approximates the rotation-vector error for small angles.
        residual[0] = sw_rot * T(2.0) * delta[1];
        residual[1] = sw_rot * T(2.0) * delta[2];
        residual[2] = sw_rot * T(2.0) * delta[3];
        residual[3] = sw_trans * (tc[0] - T(t_prior_[0]));
        residual[4] = sw_trans * (tc[1] - T(t_prior_[1]));
        residual[5] = sw_trans * (tc[2] - T(t_prior_[2]));
        return true;
    }

    static ceres::CostFunction* Create(const double q_prior[4], const double t_prior[3],
                                       double weight_rotation, double weight_translation) {
        return new ceres::AutoDiffCostFunction<CameraPriorCost, 6, 4, 3>(
            new CameraPriorCost(q_prior, t_prior, weight_rotation, weight_translation));
    }

    double q_prior_[4];
    double t_prior_[3];
    double weight_rotation_;
    double weight_translation_;
};

}  // namespace vpcal
