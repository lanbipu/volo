#pragma once

#include <vector>

namespace vpcal {

/// A single 2D-3D correspondence with the tracker pose at that frame.
struct Observation {
    double pixel_u, pixel_v;           // detected 2D pixel coords (OpenCV convention, origin top-left)

    double world_x, world_y, world_z;  // marker 3D coords, pre-converted to right-hand system
                                       // (= M_rh_from_ue * P_stage_ue; Python wrapper applies this
                                       // before passing to the solver)

    double track_qw, track_qx, track_qy, track_qz;  // tracker SDK output T_O_from_B rotation (quaternion w,x,y,z)
    double track_tx, track_ty, track_tz;              // tracker SDK output T_O_from_B translation
    double sigma_px = 1.0;              // observation uncertainty; residuals are divided by sigma
                                       // Python wrapper is responsible for:
                                       //   1) coordinate-system conversion to right-hand
                                       //   2) passing the raw SDK output directly
                                       // The C++ cost function internally inverts T_sdk to get T_B_from_O.
};

/// Camera intrinsics (pixel units) + Brown-Conrady distortion coefficients.
struct LensParams {
    double fx, fy, cx, cy;             // intrinsics
    double k1, k2, k3, p1, p2;        // Brown-Conrady: 3 radial + 2 tangential
    // Fixed shift along the camera-frame optical axis (architecture §4.3),
    // applied before the perspective divide.  0.0 reproduces pre-W8 behaviour
    // exactly.  NOT a solved parameter — mirrors vpcal.core.projection.
    double entrance_pupil_offset_mm = 0.0;
};

/// Solver tuning knobs.
struct SolverConfig {
    bool refine_tracker_to_camera;
    double robust_loss_scale;
    double tracker_to_camera_prior_weight;
    int max_iterations;
    double timeout_seconds;
    int robust_loss_type = 0;  // 0 = huber, 1 = cauchy, 2 = none (squared)
    // Split camera-prior weights (A3.2): rotation residual is rad, translation
    // is mm — one shared weight froze the translation while leaving the
    // rotation loose.  < 0 → fall back to the legacy single weight above.
    double prior_weight_rotation = -1.0;
    double prior_weight_translation = -1.0;
};

/// Solver output: optimised transforms + diagnostics.
struct SolverResult {
    // T_S_from_O (tracker_to_stage)
    double tracker_to_stage_rotation[4];       // quaternion (w,x,y,z)
    double tracker_to_stage_translation[3];

    // T_C_from_B (camera_from_tracker)
    double camera_from_tracker_rotation[4];    // quaternion (w,x,y,z)
    double camera_from_tracker_translation[3];

    // diagnostics
    double initial_cost;
    double final_cost;
    int num_iterations;
    int num_inliers;
    int num_outliers;
    int termination_type;              // maps to ceres::TerminationType enum
    char termination_message[256];

    // covariance (if computed)
    bool covariance_available;
    double tracker_to_stage_covariance[6];     // std dev: tx,ty,tz,rx,ry,rz
};

/// Run the Ceres-based calibration solver.
///
/// @param observations       2D-3D correspondences with per-frame tracker poses
/// @param lens               camera intrinsics + distortion
/// @param config             solver tuning parameters
/// @param initial_tracker_to_stage    initial guess: quaternion(w,x,y,z) + translation (7 doubles)
/// @param initial_camera_from_tracker initial guess: quaternion(w,x,y,z) + translation (7 doubles)
/// @return                   optimised result with diagnostics
SolverResult solve(
    const std::vector<Observation>& observations,
    const LensParams& lens,
    const SolverConfig& config,
    const double initial_tracker_to_stage[7],
    const double initial_camera_from_tracker[7]
);

/// Evaluate the raw (un-robustified) 2D reprojection residual of every
/// observation at a FIXED parameter vector — no optimisation.  Returns
/// 2N doubles (u then v residual per observation).  Exists for the
/// bit-level dual-backend consistency test (remediation D1).
std::vector<double> evaluate_residuals(
    const std::vector<Observation>& observations,
    const LensParams& lens,
    const double tracker_to_stage[7],
    const double camera_from_tracker[7]
);

} // namespace vpcal
