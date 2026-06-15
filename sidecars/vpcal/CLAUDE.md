# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`vpcal` is a **Virtual Production spatial calibration toolkit** — it solves the rigid transform between a camera tracking system and the LED stage coordinate system (tracker-to-stage), so the render engine can accurately composite CG content onto the physical LED wall.

**Phase 1 (QuickSpatialCal MVP)** is complete: an offline pipeline that takes captured images of VP-QSP calibration markers displayed on an LED screen, paired with synchronous camera tracking data, and solves the 6-DoF tracker-to-stage transform via bundle adjustment (Ceres Solver, with scipy fallback).

**Quick Lens Estimate (Level 2)** adds optional joint lens estimation when no master lens is available: `vpcal quick run --estimate-lens` frees lens params (default `k1,k2,cx,cy`) alongside the spatial registration in one solve, gated by an observability module (`qa/observability.py`) that decides which params are observable and reverts confounded ones. The result is a **session-coupled, non-master** estimate carrying a mandatory identifiability warning. It runs on the **scipy backend** (the gates need full parameter covariance/correlation); the Ceres backend stays primary for the default lens-fixed path. See `../docs/vpcal_quick_lens_estimate_spec.md`.

The project follows the house CLI contract defined in `../docs/CLI_DESIGN_SPEC.md` — contract-first, CLI mandatory, JSON envelope output.

## Build, test, run

Python **>=3.11**. The build uses scikit-build-core to compile the C++ Ceres solver module; if no C++ toolchain is available, the pure-Python scipy backend activates transparently at runtime.

```bash
cd vpcal
pip install -e ".[dev]"          # editable install with dev deps (pytest, pytest-cov)
pytest                           # full suite (321 tests; 3 skip without B2 real data), run from repo root
pytest tests/unit/               # unit tests only
pytest tests/integration/        # integration tests only
pytest -k "test_solver"          # by keyword
pytest --cov=vpcal --cov-report=term-missing   # with coverage (~88%)

vpcal --help                     # CLI entry point
vpcal quick run session.json     # full pipeline: validate → detect → solve → report
vpcal simulate --out-dir /tmp/sim  # generate synthetic dataset with known ground truth
vpcal pattern generate --screen screen.json --out-dir /tmp/patterns  # generate VP-QSP patterns
vpcal screen create --width 5000 --height 2700 -o screen.json  # create screen definition
vpcal report generate result.json  # generate QA report from calibration result
vpcal export opentrackio result.json tracking.csv  # export calibrated data as OpenTrackIO JSONL
AI_AGENT=1 vpcal quick run session.json  # agent mode: defaults to JSON output
```

## Project layout

```
vpcal/
├── pyproject.toml              scikit-build-core + project metadata
├── CMakeLists.txt              top-level CMake (FetchContent for Ceres/Eigen/pybind11)
├── src/
│   ├── vpcal/                  Python package
│   │   ├── cli/                Click CLI adapter (main.py = entry, one file per subcommand)
│   │   ├── core/               Business logic (solver, pipeline, detector, transforms, etc.)
│   │   ├── models/             Pydantic v2 data models (session, calibration, screen, lens, ...)
│   │   ├── io/                 File I/O (tracking CSV/JSON, screen JSON/OBJ, OpenTrackIO export)
│   │   └── qa/                 Quality assurance (reprojection analysis, coverage metrics)
│   └── vpcal_solver/           C++ Ceres solver + pybind11 bindings
│       ├── solver.{h,cpp}      C++ solver core
│       ├── cost_functions.h    Ceres cost functors (reprojection residual)
│       └── bindings.cpp        pybind11 module (_vpcal_solver)
├── tests/
│   ├── unit/                   Pure unit tests (no file I/O, no subprocess)
│   └── integration/            Pipeline & CLI integration tests
└── docs/                       Project docs (exit codes, schema versions, capture workflow)
```

## Architecture

### Pipeline (`core/pipeline.py`)

The calibration pipeline runs four stages: **validate → detect → solve → report**.

1. **Validate** (`core/validator.py`): parse `SessionConfig`, check file paths exist, verify lens model support
2. **Detect** (`core/detector.py`): find self-developed **VP-QSP** markers (32-bit Grid-Position codec + CRC-8) in captured images — OpenCV is used only for primitives (contour finding, perspective rectification); the marker codec, topology check and sub-pixel centroid are vpcal's own (**not** OpenCV ArUco). Or load a pre-computed `observations.jsonl` from `vpcal simulate`
3. **Solve** (`core/solver.py` → `core/solver_scipy.py`): bundle adjustment minimizing reprojection error; prefers compiled Ceres module, falls back to scipy `least_squares`
4. **Report**: compute quality metrics (RMS, inlier/outlier ratio, confidence level), assemble `CalibrationResult`

### Solver dual-backend

- **Primary**: C++ Ceres Solver compiled via CMake FetchContent, exposed to Python through pybind11 (`src/vpcal_solver/`). Uses Huber robust loss, analytic Jacobian via `ceres::AutoDiffCostFunction`.
- **Fallback**: Pure-Python scipy `least_squares` with identical residual formulation (`core/solver_scipy.py`). Slower, no covariance estimation, but zero native dependencies.

The active backend is reported in `CalibrationResult.solver_diagnostics.solver_backend` (`"ceres"` or `"scipy"`).

### Coordinate systems (`core/coordinates.py`, `core/transforms.py`)

Tracking data arrives in vendor-specific coordinate systems (Unreal LHS, OptiTrack RHS, Vicon RHS, FreeD Euler). `coordinates.py` provides the rotation matrix `m_rh_from_source()` that converts any supported system to the internal right-handed convention before solving.

### CLI contract

All subcommands follow `CLI_DESIGN_SPEC.md`:
- `--output text|json|ndjson|stream-json` — structured JSON envelope on stdout
- `AI_AGENT=1` env var defaults output to `json`
- Deterministic exit codes (see `docs/exit-codes.md`): 0=success, 1=runtime, 2=arg, 3=config, 5=resource, 6=precondition, 7=timeout, 9=partial
- `vpcal manifest` emits the contract manifest (canonical operation_id → CLI command mapping)

## Key data models

| Model | File | Role |
|-------|------|------|
| `SessionConfig` | `models/session.py` | Top-level input: images + tracking + screen + lens + solver config |
| `CalibrationResult` | `models/calibration.py` | Top-level output: solved transforms + quality + diagnostics |
| `LensProfile` | `models/lens.py` | Camera intrinsics + Brown-Conrady distortion (5-param) |
| `ScreenDefinition` | `models/screen.py` | LED screen geometry (flat/curved panels, marker grid layout) |
| `Observation` | `core/observations.py` | A single 2D-3D correspondence (marker_id, image point, frame_id) |

All models are Pydantic v2 `BaseModel` subclasses with full JSON Schema support (`vpcal schema`).

## Gotchas

- The C++ solver module (`_vpcal_solver`) requires CMake + a C++17 compiler + internet (FetchContent pulls Ceres/Eigen). If the build fails or is skipped, everything still works via scipy — tests explicitly cover both paths (`tests/integration/test_solver_fallback.py`).
- `vpcal simulate` produces synthetic data with `observations.jsonl` — the pipeline detects this file and skips image detection, enabling solver verification to < 0.01 px RMS.
- Screen definitions can be JSON (from `vpcal screen create`) or OBJ mesh (from `vpcal screen import`).
- The project's reference specs live in the parent workspace at `../docs/` (OpenTrackIO, OpenLensIO, OpenCV conversion math, CLI design spec).

## Relation to the parent workspace

This repo lives inside the `calibration/` workspace umbrella but is a **standalone git repo**. The parent workspace provides read-only reference material:

| Parent path | What vpcal uses it for |
|------------|----------------------|
| `../docs/CLI_DESIGN_SPEC.md` | The CLI contract this project implements |
| `../docs/vpcal_phase1_implementation_spec.md` | The spec this Phase 1 was built from |
| `../docs/OpenLensIO-Lens-Model-Version-1-0-0.md` | Lens distortion model definition |
| `../docs/OpenCV_to_OpenTrackIO.md` | OpenCV ↔ OpenLensIO parameter conversion |
| `../ris-osvp-metadata-camdkit/` | Canonical OpenTrackIO data model (cross-referenced for export) |
