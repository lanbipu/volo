cmake_minimum_required(VERSION 3.20)
project(vpcal_solver LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# Allow FetchContent sub-projects that declare an old cmake_minimum_required to
# configure under CMake >= 4 (which otherwise rejects compatibility < 3.5).
set(CMAKE_POLICY_VERSION_MINIMUM 3.5 CACHE STRING "" FORCE)

# Skip the native Ceres solver (Eigen/Ceres FetchContent + _vpcal_solver) and
# rely on the pure-Python scipy fallback at runtime. Useful on machines where
# the Ceres git clone/build is network-flaky or unwanted (e.g. a DeckLink
# capture-only bench) — the calibration path still works via scipy. Default OFF
# keeps the compiled solver on every normal build.
option(VPCAL_SKIP_SOLVER "Skip the native Ceres solver (scipy fallback)" OFF)

# ---------------------------------------------------------------------------
# pybind11 — provided by the build env (scikit-build-core requires pybind11).
# Both native modules (solver + capture) need it, so resolve it unconditionally.
# ---------------------------------------------------------------------------
find_package(pybind11 CONFIG REQUIRED)

if(VPCAL_SKIP_SOLVER)
  message(STATUS
    "vpcal: VPCAL_SKIP_SOLVER=ON — skipping Ceres/_vpcal_solver; the scipy "
    "backend is used at runtime.")
else()

# ---------------------------------------------------------------------------
# FetchContent: pin every dependency to an exact git tag for reproducibility.
# Ceres is built with MINIGLOG (its bundled mini-logger), so neither glog nor
# gflags is needed — this keeps the build small and avoids the CMake>=4 /
# gflags<3.5 policy conflict.
# ---------------------------------------------------------------------------
include(FetchContent)

FetchContent_Declare(
  eigen
  GIT_REPOSITORY https://gitlab.com/libeigen/eigen.git
  GIT_TAG        3.4.0
  GIT_SHALLOW    TRUE
)
# Eigen: configure as a header-only dependency, skip its tests/build steps.
set(EIGEN_BUILD_DOC OFF CACHE BOOL "" FORCE)
set(EIGEN_BUILD_TESTING OFF CACHE BOOL "" FORCE)
set(BUILD_TESTING OFF CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(eigen)

# Ceres Solver — MINIGLOG, no SuiteSparse/LAPACK extras, no tests/examples.
set(MINIGLOG ON CACHE BOOL "" FORCE)
set(GFLAGS OFF CACHE BOOL "" FORCE)
set(SUITESPARSE OFF CACHE BOOL "" FORCE)
set(CXSPARSE OFF CACHE BOOL "" FORCE)
set(ACCELERATESPARSE OFF CACHE BOOL "" FORCE)
set(LAPACK OFF CACHE BOOL "" FORCE)
set(BUILD_TESTING OFF CACHE BOOL "" FORCE)
set(BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(BUILD_BENCHMARKS OFF CACHE BOOL "" FORCE)
set(PROVIDE_UNINSTALL_TARGET OFF CACHE BOOL "" FORCE)
set(CERES_THREADING_MODEL "CXX_THREADS" CACHE STRING "" FORCE)

FetchContent_Declare(
  ceres-solver
  GIT_REPOSITORY https://github.com/ceres-solver/ceres-solver.git
  GIT_TAG        2.2.0
  GIT_SHALLOW    TRUE
)
FetchContent_MakeAvailable(ceres-solver)

# ---------------------------------------------------------------------------
# Solver module
# ---------------------------------------------------------------------------
add_subdirectory(src/vpcal_solver)

endif()  # VPCAL_SKIP_SOLVER

# ---------------------------------------------------------------------------
# DeckLink capture shim (Phase 2a) — builds ONLY when DECKLINK_SDK_DIR points
# at a local Blackmagic SDK (headers are not redistributable); otherwise the
# subdirectory logs a status note and skips itself.
# ---------------------------------------------------------------------------
add_subdirectory(src/vpcal_capture)
