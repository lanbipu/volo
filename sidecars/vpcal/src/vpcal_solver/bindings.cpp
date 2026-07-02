#include <pybind11/pybind11.h>
#include <pybind11/stl.h>

#include <array>
#include <stdexcept>
#include <string>
#include <vector>

#include "solver.h"

namespace py = pybind11;

namespace {

const char* termination_name(int t) {
    switch (t) {
        case 0: return "CONVERGENCE";
        case 1: return "NO_CONVERGENCE";
        case 2: return "FAILURE";
        case 3: return "USER_SUCCESS";
        case 4: return "USER_FAILURE";
        default: return "UNKNOWN";
    }
}

template <std::size_t N>
std::vector<double> to_vec(const double (&a)[N]) {
    return std::vector<double>(a, a + N);
}

}  // namespace

PYBIND11_MODULE(_vpcal_solver, m) {
    m.doc() = "vpcal C++ Ceres calibration solver";

    py::class_<vpcal::Observation>(m, "Observation")
        .def(py::init([](double pu, double pv, double wx, double wy, double wz,
                         double qw, double qx, double qy, double qz, double tx,
                         double ty, double tz) {
            vpcal::Observation o;
            o.pixel_u = pu; o.pixel_v = pv;
            o.world_x = wx; o.world_y = wy; o.world_z = wz;
            o.track_qw = qw; o.track_qx = qx; o.track_qy = qy; o.track_qz = qz;
            o.track_tx = tx; o.track_ty = ty; o.track_tz = tz;
            return o;
        }));

    py::class_<vpcal::LensParams>(m, "LensParams")
        .def(py::init([](double fx, double fy, double cx, double cy, double k1,
                         double k2, double k3, double p1, double p2,
                         double entrance_pupil_offset_mm) {
            vpcal::LensParams l;
            l.fx = fx; l.fy = fy; l.cx = cx; l.cy = cy;
            l.k1 = k1; l.k2 = k2; l.k3 = k3; l.p1 = p1; l.p2 = p2;
            l.entrance_pupil_offset_mm = entrance_pupil_offset_mm;
            return l;
        }),
             py::arg("fx"), py::arg("fy"), py::arg("cx"), py::arg("cy"),
             py::arg("k1"), py::arg("k2"), py::arg("k3"), py::arg("p1"), py::arg("p2"),
             py::arg("entrance_pupil_offset_mm") = 0.0);

    py::class_<vpcal::SolverConfig>(m, "SolverConfig")
        .def(py::init([](bool refine, double robust_scale, double prior_weight,
                         int max_iter, double timeout, int robust_loss_type,
                         double prior_weight_rotation, double prior_weight_translation) {
                 vpcal::SolverConfig c;
                 c.refine_tracker_to_camera = refine;
                 c.robust_loss_scale = robust_scale;
                 c.tracker_to_camera_prior_weight = prior_weight;
                 c.max_iterations = max_iter;
                 c.timeout_seconds = timeout;
                 c.robust_loss_type = robust_loss_type;
                 c.prior_weight_rotation = prior_weight_rotation;
                 c.prior_weight_translation = prior_weight_translation;
                 return c;
             }),
             py::arg("refine_tracker_to_camera"), py::arg("robust_loss_scale"),
             py::arg("tracker_to_camera_prior_weight"), py::arg("max_iterations"),
             py::arg("timeout_seconds"), py::arg("robust_loss_type") = 0,
             py::arg("prior_weight_rotation") = -1.0,
             py::arg("prior_weight_translation") = -1.0);

    py::class_<vpcal::SolverResult>(m, "SolverResult")
        .def_property_readonly("tracker_to_stage_rotation",
                               [](const vpcal::SolverResult& r) { return to_vec(r.tracker_to_stage_rotation); })
        .def_property_readonly("tracker_to_stage_translation",
                               [](const vpcal::SolverResult& r) { return to_vec(r.tracker_to_stage_translation); })
        .def_property_readonly("camera_from_tracker_rotation",
                               [](const vpcal::SolverResult& r) { return to_vec(r.camera_from_tracker_rotation); })
        .def_property_readonly("camera_from_tracker_translation",
                               [](const vpcal::SolverResult& r) { return to_vec(r.camera_from_tracker_translation); })
        .def_readonly("initial_cost", &vpcal::SolverResult::initial_cost)
        .def_readonly("final_cost", &vpcal::SolverResult::final_cost)
        .def_readonly("num_iterations", &vpcal::SolverResult::num_iterations)
        .def_readonly("num_inliers", &vpcal::SolverResult::num_inliers)
        .def_readonly("num_outliers", &vpcal::SolverResult::num_outliers)
        .def_readonly("termination_type", &vpcal::SolverResult::termination_type)
        .def_property_readonly("termination_type_name",
                               [](const vpcal::SolverResult& r) { return std::string(termination_name(r.termination_type)); })
        .def_property_readonly("termination_message",
                               [](const vpcal::SolverResult& r) { return std::string(r.termination_message); })
        .def_readonly("covariance_available", &vpcal::SolverResult::covariance_available)
        .def_property_readonly("tracker_to_stage_covariance",
                               [](const vpcal::SolverResult& r) { return to_vec(r.tracker_to_stage_covariance); });

    m.def("solve",
          [](const std::vector<vpcal::Observation>& obs, const vpcal::LensParams& lens,
             const vpcal::SolverConfig& cfg, const std::vector<double>& init_S,
             const std::vector<double>& init_C) {
              if (init_S.size() != 7 || init_C.size() != 7)
                  throw std::runtime_error("initial guesses must each have 7 elements (quat + translation)");
              return vpcal::solve(obs, lens, cfg, init_S.data(), init_C.data());
          },
          py::arg("observations"), py::arg("lens"), py::arg("config"),
          py::arg("initial_tracker_to_stage"), py::arg("initial_camera_from_tracker"));

    // Raw per-observation reprojection residuals at a fixed parameter vector
    // (no optimisation) — for the bit-level dual-backend test (D1).
    m.def("evaluate_residuals",
          [](const std::vector<vpcal::Observation>& obs, const vpcal::LensParams& lens,
             const std::vector<double>& T_S, const std::vector<double>& T_C) {
              if (T_S.size() != 7 || T_C.size() != 7)
                  throw std::runtime_error("transforms must each have 7 elements (quat + translation)");
              return vpcal::evaluate_residuals(obs, lens, T_S.data(), T_C.data());
          },
          py::arg("observations"), py::arg("lens"),
          py::arg("tracker_to_stage"), py::arg("camera_from_tracker"));
}
