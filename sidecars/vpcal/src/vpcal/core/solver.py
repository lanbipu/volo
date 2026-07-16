"""Solver façade: prefer the compiled C++ Ceres core, fall back to scipy.

The C++ module (``vpcal._vpcal_solver``) is built from source via CMake +
FetchContent at install time.  When it is unavailable (no compiler, build
skipped, or dev environment), :func:`solve_calibration` transparently uses the
pure-Python :mod:`vpcal.core.solver_scipy` backend — same residual, slower,
marked ``solver_backend="scipy"``.
"""

from __future__ import annotations

import contextlib
import logging
import os
import time

import numpy as np
from numpy.typing import NDArray

from vpcal.core import solver_scipy
from vpcal.core.errors import PreconditionError, SolverTimeoutError
from vpcal.core.observations import Observation
from vpcal.core.projection import CameraIntrinsics
from vpcal.core.solver_scipy import LensFreedom, SolverResult
from vpcal.core.transforms import invert_transform, make_transform, matrix_to_quat

_log = logging.getLogger("vpcal.solver")

Array = NDArray[np.float64]

MIN_POSES_HARD = 3  # < 3 → reject (exit 6)
MIN_POSES_SOFT = 6  # < 6 → very_low confidence
MIN_OBSERVATIONS_SOFT = 50


@contextlib.contextmanager
def _suppress_c_stderr():
    """Temporarily silence C-level stderr (Ceres/miniglog) at the fd level.

    Keeps the CLI stdout/stderr contract tidy; Python logging is unaffected.
    """
    saved = os.dup(2)
    devnull = os.open(os.devnull, os.O_WRONLY)
    try:
        os.dup2(devnull, 2)
        yield
    finally:
        os.dup2(saved, 2)
        os.close(devnull)
        os.close(saved)


def cpp_available() -> bool:
    """True if the compiled C++ solver module can be imported."""
    try:
        import vpcal._vpcal_solver  # noqa: F401

        return True
    except Exception:  # noqa: BLE001
        return False


def pnp_initial_tracker_to_stage(
    observations: list[Observation],
    intr: CameraIntrinsics,
    init_C: tuple[Array, Array],
) -> tuple[Array, Array]:
    """PnP-based initial guess for ``T_S_from_O`` from the richest frame.

    Derivation (spec §5.1.4 chain, with ``T_C_from_B`` = ``init_C``):
        PnP gives ``M = T_C_from_S = T_C_from_B · inv(T_sdk) · inv(T_S_from_O)``
        ⇒ ``T_S_from_O = inv(M) · T_C_from_B · inv(T_sdk)``.
    """
    import cv2

    by_frame: dict[int, list[Observation]] = {}
    for o in observations:
        by_frame.setdefault(o.frame_id, []).append(o)
    best = max(by_frame.values(), key=len)
    if len(best) < 4:
        return np.array([1.0, 0.0, 0.0, 0.0]), np.zeros(3)

    obj = np.array([o.world_rh for o in best], dtype=np.float64).reshape(-1, 1, 3)
    img = np.array([[o.pixel_u, o.pixel_v] for o in best], dtype=np.float64).reshape(-1, 1, 2)
    K = np.array([[intr.fx, 0, intr.cx], [0, intr.fy, intr.cy], [0, 0, 1]], dtype=np.float64)
    dist = np.array([intr.k1, intr.k2, intr.p1, intr.p2, intr.k3], dtype=np.float64)
    # RANSAC PnP so outliers in the seed frame don't corrupt the initial guess.
    ok, rvec, tvec, _inliers = cv2.solvePnPRansac(
        obj, img, K, dist, reprojectionError=3.0, flags=cv2.SOLVEPNP_ITERATIVE
    )
    if not ok:
        ok, rvec, tvec = cv2.solvePnP(obj, img, K, dist, flags=cv2.SOLVEPNP_EPNP)
        if not ok:
            return np.array([1.0, 0.0, 0.0, 0.0]), np.zeros(3)
    R, _ = cv2.Rodrigues(rvec)
    M = np.eye(4)
    M[:3, :3] = R
    M[:3, 3] = tvec.ravel()

    T_sdk = make_transform(np.asarray(best[0].track_q), np.asarray(best[0].track_t))
    T_C = make_transform(np.asarray(init_C[0]), np.asarray(init_C[1]))
    T_S_from_O = invert_transform(M) @ T_C @ invert_transform(T_sdk)
    return matrix_to_quat(T_S_from_O[:3, :3]), T_S_from_O[:3, 3].copy()


def cv2_bootstrap_lens(
    observations: list[Observation], intr: CameraIntrinsics
) -> CameraIntrinsics:
    """Init-only intrinsics+distortion seed via ``cv2.calibrateCamera`` (QLE §2.3).

    Runs a tracking-agnostic calibration over the per-pose 2D-3D correspondences
    to seed cx/cy/k1/k2 for the joint solve.  Per-view extrinsics are discarded
    (they live in cv2's frame, not ``T_S_from_O``).  Returns the original ``intr``
    unchanged on any failure or implausible result (graceful fallback).
    """
    import dataclasses

    import cv2

    by_frame: dict[int, list[Observation]] = {}
    for o in observations:
        by_frame.setdefault(o.frame_id, []).append(o)
    obj_pts: list[Array] = []
    img_pts: list[Array] = []
    for lst in by_frame.values():
        if len(lst) < 6:  # too few points for a stable per-view solve
            continue
        obj_pts.append(np.array([o.world_rh for o in lst], dtype=np.float32))
        img_pts.append(np.array([[o.pixel_u, o.pixel_v] for o in lst], dtype=np.float32))
    if len(obj_pts) < 3:
        return intr

    w, h = intr.image_size
    K0 = np.array([[intr.fx, 0, intr.cx], [0, intr.fy, intr.cy], [0, 0, 1]], dtype=np.float64)
    # Fix aspect ratio + zero tangential + fix k3 to match the Level-2 free set.
    flags = (
        cv2.CALIB_USE_INTRINSIC_GUESS | cv2.CALIB_FIX_ASPECT_RATIO
        | cv2.CALIB_ZERO_TANGENT_DIST | cv2.CALIB_FIX_K3
    )
    try:
        with _suppress_c_stderr():
            ret, K, dist, _rvecs, _tvecs = cv2.calibrateCamera(
                obj_pts, img_pts, (int(round(w)), int(round(h))), K0, None, flags=flags
            )
    except Exception as exc:  # noqa: BLE001
        _log.warning("cv2 bootstrap failed (%s); using nominal lens", exc)
        return intr
    if not (np.isfinite(K).all() and np.isfinite(dist).all()):
        return intr
    cx2, cy2 = float(K[0, 2]), float(K[1, 2])
    k1_2, k2_2 = float(dist.ravel()[0]), float(dist.ravel()[1])
    # Sanity: principal point inside the image, distortion in a plausible band.
    if not (0 < cx2 < w and 0 < cy2 < h and abs(k1_2) < 1.0 and abs(k2_2) < 1.0):
        _log.warning("cv2 bootstrap produced implausible values; using nominal lens")
        return intr
    return dataclasses.replace(intr, cx=cx2, cy=cy2, k1=k1_2, k2=k2_2)


def solve_calibration(
    observations: list[Observation],
    intr: CameraIntrinsics,
    *,
    init_S: tuple[Array, Array] | None = None,
    init_C: tuple[Array, Array] | None = None,
    refine_C: bool = False,
    robust_scale: float | str = 1.0,
    robust_loss: str = "huber",
    prior_weight_rotation: float = 820.7,
    prior_weight_translation: float = 0.01,
    max_iterations: int = 200,
    timeout_seconds: float | None = None,
    prefer_cpp: bool = True,
    lens_free: LensFreedom | None = None,
    diagnose_scale: bool = False,
) -> SolverResult:
    """Solve the calibration, preferring the C++ backend with scipy fallback.

    When ``lens_free`` requests free lens scalars (Quick Lens Estimate) and the
    compiled C++ module lacks lens support (old build), ``_solve_cpp`` raises and
    the scipy backend — which always supports lens estimation — takes over.
    """
    num_poses = len({o.frame_id for o in observations})
    if num_poses < MIN_POSES_HARD:
        raise PreconditionError(
            f"need >= {MIN_POSES_HARD} poses to solve; got {num_poses}",
            details={"num_poses": num_poses},
        )
    if init_C is None:
        init_C = (np.array([1.0, 0.0, 0.0, 0.0]), np.zeros(3))
    if init_S is None:
        init_S = pnp_initial_tracker_to_stage(observations, intr, init_C)

    if robust_scale == "auto":
        first = solve_calibration(
            observations, intr, init_S=init_S, init_C=init_C,
            refine_C=refine_C, robust_scale=1.0, robust_loss=robust_loss,
            prior_weight_rotation=prior_weight_rotation,
            prior_weight_translation=prior_weight_translation,
            max_iterations=max_iterations, timeout_seconds=timeout_seconds,
            prefer_cpp=False, lens_free=lens_free, diagnose_scale=False,
        )
        residuals = np.asarray(first.residuals_px, dtype=float)
        median = float(np.median(residuals)) if residuals.size else 0.0
        mad = float(np.median(np.abs(residuals - median))) if residuals.size else 0.0
        adaptive_scale = max(1.4826 * mad, 0.1)
        _log.info("auto robust scale resolved to %.4f px", adaptive_scale)
        return solve_calibration(
            observations, intr,
            init_S=(np.asarray(first.tracker_to_stage_q), np.asarray(first.tracker_to_stage_t)),
            init_C=(np.asarray(first.camera_from_tracker_q), np.asarray(first.camera_from_tracker_t)),
            refine_C=refine_C, robust_scale=adaptive_scale, robust_loss=robust_loss,
            prior_weight_rotation=prior_weight_rotation,
            prior_weight_translation=prior_weight_translation,
            max_iterations=max_iterations, timeout_seconds=timeout_seconds,
            prefer_cpp=False, lens_free=lens_free, diagnose_scale=diagnose_scale,
        )

    if diagnose_scale and prefer_cpp:
        _log.info("tracking scale diagnostic requires scipy; bypassing Ceres")
        prefer_cpp = False

    degraded = False
    if prefer_cpp and cpp_available():
        try:
            return _solve_cpp(
                observations, intr, init_S, init_C, refine_C, robust_scale,
                robust_loss, prior_weight_rotation, prior_weight_translation,
                max_iterations, timeout_seconds, lens_free,
            )
        except SolverTimeoutError:
            raise
        except Exception as exc:  # noqa: BLE001
            _log.warning("C++ solver failed (%s); falling back to scipy", exc)
            degraded = True
    elif prefer_cpp:
        _log.warning("C++ solver unavailable; using degraded scipy backend")
        degraded = True

    result = solver_scipy.solve(
        observations,
        intr,
        init_S=init_S,
        init_C=init_C,
        refine_C=refine_C,
        robust_scale=robust_scale,
        robust_loss=robust_loss,
        prior_weight_rotation=prior_weight_rotation,
        prior_weight_translation=prior_weight_translation,
        max_iterations=max_iterations,
        timeout_seconds=timeout_seconds,
        lens_free=lens_free,
        diagnose_scale=diagnose_scale,
    )
    result.degraded_backend = degraded
    return result


def _solve_cpp(
    observations: list[Observation],
    intr: CameraIntrinsics,
    init_S: tuple[Array, Array],
    init_C: tuple[Array, Array],
    refine_C: bool,
    robust_scale: float,
    robust_loss: str,
    prior_weight_rotation: float,
    prior_weight_translation: float,
    max_iterations: int,
    timeout_seconds: float | None = None,
    lens_free: LensFreedom | None = None,
) -> SolverResult:
    """Call the compiled Ceres backend and normalise its result."""
    import vpcal._vpcal_solver as cpp

    want_lens = lens_free is not None and lens_free.any_free
    if want_lens and not hasattr(cpp, "LensFree"):
        raise RuntimeError(
            "compiled C++ solver lacks lens-estimate support (LensFree); "
            "rebuild the module or use the scipy backend"
        )
    loss_type = {"huber": 0, "cauchy": 1, "none": 2}.get(robust_loss)
    if loss_type is None:
        raise ValueError(f"unsupported robust_loss: {robust_loss!r} (expected huber/cauchy/none)")

    obs = [
        cpp.Observation(
            o.pixel_u, o.pixel_v,
            o.world_rh[0], o.world_rh[1], o.world_rh[2],
            o.track_q[0], o.track_q[1], o.track_q[2], o.track_q[3],
            o.track_t[0], o.track_t[1], o.track_t[2],
            o.sigma_px,
        )
        for o in observations
    ]
    try:
        lens = cpp.LensParams(
            intr.fx, intr.fy, intr.cx, intr.cy, intr.k1, intr.k2, intr.k3, intr.p1, intr.p2,
            intr.entrance_pupil_offset_mm,
        )
    except TypeError:
        # Old prebuilt module without entrance_pupil_offset_mm (W8): a zero
        # offset is bit-identical to omitting it, so fall back silently; a
        # non-zero offset would be silently dropped, so refuse instead.
        if intr.entrance_pupil_offset_mm != 0.0:
            raise RuntimeError(
                "compiled C++ solver predates entrance_pupil_offset_mm (W8); "
                "rebuild the module or use the scipy backend"
            ) from None
        lens = cpp.LensParams(
            intr.fx, intr.fy, intr.cx, intr.cy, intr.k1, intr.k2, intr.k3, intr.p1, intr.p2,
        )
    timeout = float(timeout_seconds) if timeout_seconds else 300.0
    try:
        cfg = cpp.SolverConfig(
            refine_C, robust_scale, prior_weight_rotation, int(max_iterations), timeout,
            loss_type, prior_weight_rotation, prior_weight_translation,
        )
    except TypeError:
        # Old prebuilt module without the split prior weights / robust_loss_type
        # arguments: refuse rather than silently solving with wrong weights —
        # solve_calibration then falls back to scipy.
        raise RuntimeError(
            "compiled C++ solver predates split prior weights (A3.2); "
            "rebuild the module or use the scipy backend"
        ) from None
    init_S7 = [*init_S[0], *init_S[1]]
    init_C7 = [*init_C[0], *init_C[1]]
    started = time.monotonic()
    with _suppress_c_stderr():
        if want_lens:
            lf = cpp.LensFree(
                lens_free.free_focal, lens_free.free_cx, lens_free.free_cy,
                lens_free.free_k1, lens_free.free_k2,
                lens_free.pp_margin_x_px, lens_free.pp_margin_y_px,
                lens_free.k_lo, lens_free.k_hi,
                lens_free.focal_scale_bound, lens_free.focal_prior_weight,
            )
            r = cpp.solve(obs, lens, cfg, init_S7, init_C7, lf)
        else:
            r = cpp.solve(obs, lens, cfg, init_S7, init_C7)
    elapsed = time.monotonic() - started
    if r.termination_type_name == "NO_CONVERGENCE" and elapsed >= timeout * 0.9:
        raise SolverTimeoutError(
            f"solver exceeded timeout_seconds={timeout}",
            details={"timeout_seconds": timeout, "elapsed_seconds": elapsed},
        )

    lens_values = lens_std = lens_corr = None
    lens_corr_available = False
    if want_lens:
        lens_values = dict(r.lens_values())
        lens_std = dict(r.lens_std())
        lens_corr = dict(r.lens_corr())
        lens_corr_available = bool(r.lens_corr_available)

    return SolverResult(
        tracker_to_stage_q=tuple(r.tracker_to_stage_rotation),
        tracker_to_stage_t=tuple(r.tracker_to_stage_translation),
        camera_from_tracker_q=tuple(r.camera_from_tracker_rotation),
        camera_from_tracker_t=tuple(r.camera_from_tracker_translation),
        initial_cost=r.initial_cost,
        final_cost=r.final_cost,
        num_iterations=r.num_iterations,
        num_inliers=r.num_inliers,
        num_outliers=r.num_outliers,
        termination_type=r.termination_type_name,
        termination_message=r.termination_message,
        solver_backend="ceres",
        residuals_px=[],
        covariance_std=(
            {
                "tx_mm": r.tracker_to_stage_covariance[0],
                "ty_mm": r.tracker_to_stage_covariance[1],
                "tz_mm": r.tracker_to_stage_covariance[2],
                "rx_deg": r.tracker_to_stage_covariance[3],
                "ry_deg": r.tracker_to_stage_covariance[4],
                "rz_deg": r.tracker_to_stage_covariance[5],
            }
            if r.covariance_available
            else None
        ),
        lens_values=lens_values,
        lens_std=lens_std,
        lens_corr=lens_corr,
        lens_corr_available=lens_corr_available,
    )
