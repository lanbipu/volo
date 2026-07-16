#include "solver.h"

#include <ceres/ceres.h>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <vector>

#include "cost_functions.h"

namespace vpcal {

namespace {

void copy7_to_qt(const double in[7], double q[4], double t[3]) {
    for (int i = 0; i < 4; ++i) q[i] = in[i];
    for (int i = 0; i < 3; ++i) t[i] = in[4 + i];
}

double reprojection_norm(const Observation& o, const LensParams& lens,
                         const double qs[4], const double ts[3],
                         const double qc[4], const double tc[3]) {
    ReprojectionCost cost(o, lens);
    double residual[2];
    cost(qs, ts, qc, tc, residual);
    return std::sqrt(residual[0] * residual[0] + residual[1] * residual[1]);
}

}  // namespace

SolverResult solve(const std::vector<Observation>& observations,
                   const LensParams& lens, const SolverConfig& config,
                   const double initial_tracker_to_stage[7],
                   const double initial_camera_from_tracker[7]) {
    SolverResult result;
    std::memset(&result, 0, sizeof(result));

    double qs[4], ts[3], qc[4], tc[3];
    copy7_to_qt(initial_tracker_to_stage, qs, ts);
    copy7_to_qt(initial_camera_from_tracker, qc, tc);
    const double qc_prior[4] = {qc[0], qc[1], qc[2], qc[3]};
    const double tc_prior[3] = {tc[0], tc[1], tc[2]};

    ceres::Problem problem;
    ceres::LossFunction* loss = nullptr;  // robust_loss_type 2 = plain squared
    if (config.robust_loss_type == 0) {
        loss = new ceres::HuberLoss(config.robust_loss_scale);
    } else if (config.robust_loss_type == 1) {
        loss = new ceres::CauchyLoss(config.robust_loss_scale);
    }

    for (const auto& obs : observations) {
        problem.AddResidualBlock(ReprojectionCost::Create(obs, lens), loss, qs, ts, qc, tc);
    }
    problem.SetManifold(qs, new ceres::QuaternionManifold);
    problem.SetManifold(qc, new ceres::QuaternionManifold);

    if (config.refine_tracker_to_camera) {
        const double w_rot = config.prior_weight_rotation >= 0.0
                                 ? config.prior_weight_rotation
                                 : config.tracker_to_camera_prior_weight;
        const double w_trans = config.prior_weight_translation >= 0.0
                                   ? config.prior_weight_translation
                                   : config.tracker_to_camera_prior_weight;
        problem.AddResidualBlock(
            CameraPriorCost::Create(qc_prior, tc_prior, w_rot, w_trans),
            nullptr, qc, tc);
    } else {
        problem.SetParameterBlockConstant(qc);
        problem.SetParameterBlockConstant(tc);
    }

    ceres::Solver::Options options;
    options.linear_solver_type = ceres::DENSE_QR;
    options.minimizer_type = ceres::TRUST_REGION;
    options.trust_region_strategy_type = ceres::LEVENBERG_MARQUARDT;
    options.max_num_iterations = config.max_iterations;
    options.max_solver_time_in_seconds = config.timeout_seconds;
    options.num_threads = 1;
    options.logging_type = ceres::SILENT;
    options.minimizer_progress_to_stdout = false;

    ceres::Solver::Summary summary;
    ceres::Solve(options, &problem, &summary);

    for (int i = 0; i < 4; ++i) {
        result.tracker_to_stage_rotation[i] = qs[i];
        result.camera_from_tracker_rotation[i] = qc[i];
    }
    for (int i = 0; i < 3; ++i) {
        result.tracker_to_stage_translation[i] = ts[i];
        result.camera_from_tracker_translation[i] = tc[i];
    }
    result.initial_cost = summary.initial_cost;
    result.final_cost = summary.final_cost;
    result.num_iterations = static_cast<int>(summary.iterations.size());
    result.termination_type = static_cast<int>(summary.termination_type);
    std::strncpy(result.termination_message, summary.message.c_str(), 255);
    result.termination_message[255] = '\0';

    const double thresh = 3.0 * config.robust_loss_scale;
    int outliers = 0;
    for (const auto& obs : observations) {
        if (reprojection_norm(obs, lens, qs, ts, qc, tc) > thresh) ++outliers;
    }
    result.num_outliers = outliers;
    result.num_inliers = static_cast<int>(observations.size()) - outliers;

    // Covariance of T_S_from_O in tangent space (3 rot + 3 trans).
    result.covariance_available = false;
    try {
        ceres::Covariance::Options cov_opts;
        ceres::Covariance covariance(cov_opts);
        std::vector<std::pair<const double*, const double*>> blocks = {
            {qs, qs}, {ts, ts}};
        if (covariance.Compute(blocks, &problem)) {
            double cov_qs[3 * 3];
            double cov_ts[3 * 3];
            covariance.GetCovarianceBlockInTangentSpace(qs, qs, cov_qs);
            covariance.GetCovarianceBlock(ts, ts, cov_ts);
            constexpr double kPi = 3.14159265358979323846;
            const double rad2deg = 180.0 / kPi;
            const int residual_count = static_cast<int>(observations.size() * 2)
                + (config.refine_tracker_to_camera ? 6 : 0);
            const int parameter_count = config.refine_tracker_to_camera ? 12 : 6;
            const int dof = std::max(residual_count - parameter_count, 1);
            const double sigma = std::sqrt(std::max(2.0 * summary.final_cost / dof, 0.0));
            result.tracker_to_stage_covariance[0] = sigma * std::sqrt(std::abs(cov_ts[0]));
            result.tracker_to_stage_covariance[1] = sigma * std::sqrt(std::abs(cov_ts[4]));
            result.tracker_to_stage_covariance[2] = sigma * std::sqrt(std::abs(cov_ts[8]));
            result.tracker_to_stage_covariance[3] = sigma * std::sqrt(std::abs(cov_qs[0])) * rad2deg;
            result.tracker_to_stage_covariance[4] = sigma * std::sqrt(std::abs(cov_qs[4])) * rad2deg;
            result.tracker_to_stage_covariance[5] = sigma * std::sqrt(std::abs(cov_qs[8])) * rad2deg;
            result.covariance_available = true;
        }
    } catch (...) {
        result.covariance_available = false;
    }

    return result;
}

std::vector<double> evaluate_residuals(const std::vector<Observation>& observations,
                                       const LensParams& lens,
                                       const double tracker_to_stage[7],
                                       const double camera_from_tracker[7]) {
    double qs[4], ts[3], qc[4], tc[3];
    copy7_to_qt(tracker_to_stage, qs, ts);
    copy7_to_qt(camera_from_tracker, qc, tc);
    std::vector<double> out;
    out.reserve(observations.size() * 2);
    for (const auto& obs : observations) {
        ReprojectionCost cost(obs, lens);
        double residual[2];
        cost(qs, ts, qc, tc, residual);
        out.push_back(residual[0]);
        out.push_back(residual[1]);
    }
    return out;
}

}  // namespace vpcal
