"""Pure-Python fallback solver (spec §5.3): ``scipy.optimize.least_squares``.

Minimises the 2D reprojection residual of the spec §5.1.4 chain over
``T_S_from_O`` (and optionally a small ``T_C_from_B`` delta) using a
trust-region Levenberg-Marquardt with a robust loss.  The **un-robustified
per-observation reprojection residual** is numerically identical to the C++
Ceres core (locked by the bit-level dual-backend test); the backends
legitimately differ in three places and are NOT bit-identical there: robust
loss aggregation (scipy applies the loss to the full stacked vector incl.
priors, Ceres per residual block with the prior un-robustified), the
``T_C_from_B`` prior parametrisation (rotation-vector delta here vs
quaternion-product small-angle in ``CameraPriorCost``), and the optimiser
internals (TRF vs Levenberg-Marquardt trust region).

Rotations are parametrised as so(3) rotation vectors (3 params) to avoid the
gauge freedom of a free 4-quaternion.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field, replace

import numpy as np
from numpy.typing import NDArray
from scipy.optimize import least_squares

from vpcal.core.errors import SolverTimeoutError
from vpcal.core.observations import Observation
from vpcal.core.projection import CameraIntrinsics, project_points
from vpcal.core.transforms import invert_transform, make_transform, matrix_to_quat

# session.solver.robust_loss → scipy least_squares ``loss`` argument.
_LOSS_MAP = {"huber": "huber", "cauchy": "cauchy", "none": "linear"}

Array = NDArray[np.float64]

# Canonical order of free lens scalars in the solver state vector (QLE spec §4.2).
# ``focal_scale`` is a multiplicative factor on the nominal fx/fy (single focal
# DoF) so the solver needs no sensor dimensions; focal_length_mm = scale·nominal.
_LENS_ORDER = ("focal_scale", "cx", "cy", "k1", "k2")


@dataclass
class LensFreedom:
    """Which lens scalars are free in the joint solve + their bounds (QLE spec §4).

    Each scalar is an independent degree of freedom, so any subset (incl.
    k1-only / cx-only) is expressible.  Default = all fixed = Phase-1 behaviour.
    """

    free_focal: bool = False
    free_cx: bool = False
    free_cy: bool = False
    free_k1: bool = False
    free_k2: bool = False
    pp_margin_x_px: float = 1.0e9
    pp_margin_y_px: float = 1.0e9
    k_lo: float = -0.5
    k_hi: float = 0.5
    focal_scale_bound: float = 0.10  # box half-width on the focal scale factor
    focal_prior_weight: float = 1000.0

    @property
    def free_names(self) -> list[str]:
        flags = {
            "focal_scale": self.free_focal, "cx": self.free_cx, "cy": self.free_cy,
            "k1": self.free_k1, "k2": self.free_k2,
        }
        return [n for n in _LENS_ORDER if flags[n]]

    @property
    def any_free(self) -> bool:
        return bool(self.free_names)


@dataclass
class SolverResult:
    """Solver output shared by the scipy and Ceres backends."""

    tracker_to_stage_q: tuple[float, float, float, float]
    tracker_to_stage_t: tuple[float, float, float]
    camera_from_tracker_q: tuple[float, float, float, float]
    camera_from_tracker_t: tuple[float, float, float]
    initial_cost: float
    final_cost: float
    num_iterations: int
    num_inliers: int
    num_outliers: int
    termination_type: str
    termination_message: str
    solver_backend: str
    residuals_px: list[float] = field(default_factory=list)
    covariance_std: dict[str, float] | None = None
    # Quick Lens Estimate outputs (None unless lens params were free).
    lens_values: dict[str, float] | None = None
    """Estimated solver-space values for freed params (focal_scale, cx/cy px, k1, k2)."""
    lens_std: dict[str, float] | None = None
    """Per-param std; focal_scale std is relative (≈ σ_focal/focal)."""
    lens_corr: dict[str, float] | None = None
    """Per-param max |ρ| against the *free* spatial params (T_S, +T_C if refine_C)."""
    lens_corr_available: bool = False
    condition_number: float | None = None
    """κ of the normal equations JᵀJ at the solution (None if not computable)."""


# ── so(3) <-> quaternion ─────────────────────────────────────────────


def rotvec_to_quat(rv: Array) -> Array:
    """Rotation vector (axis*angle) → quaternion (w, x, y, z)."""
    theta = float(np.linalg.norm(rv))
    if theta < 1e-12:
        return np.array([1.0, 0.0, 0.0, 0.0])
    axis = rv / theta
    half = theta / 2.0
    s = np.sin(half)
    return np.array([np.cos(half), axis[0] * s, axis[1] * s, axis[2] * s])


def quat_to_rotvec(q: Array) -> Array:
    """Quaternion (w, x, y, z) → rotation vector."""
    q = q / (np.linalg.norm(q) or 1.0)
    w = np.clip(q[0], -1.0, 1.0)
    angle = 2.0 * np.arccos(w)
    s = np.sqrt(max(1.0 - w * w, 0.0))
    if s < 1e-12:
        return np.zeros(3)
    return (q[1:] / s) * angle


def _transform_from_params(p: Array) -> Array:
    """6-vector [rotvec(3), t(3)] → 4x4 transform."""
    return make_transform(rotvec_to_quat(p[:3]), p[3:6])


def _build_observation_arrays(observations: list[Observation]) -> tuple[Array, Array, Array]:
    """Return (world_h (N,4), pixels (N,2), inv_T_sdk (N,4,4))."""
    n = len(observations)
    world_h = np.ones((n, 4))
    pixels = np.zeros((n, 2))
    inv_sdk = np.zeros((n, 4, 4))
    for i, o in enumerate(observations):
        world_h[i, :3] = o.world_rh
        pixels[i] = (o.pixel_u, o.pixel_v)
        T_sdk = make_transform(np.asarray(o.track_q), np.asarray(o.track_t))
        inv_sdk[i] = invert_transform(T_sdk)
    return world_h, pixels, inv_sdk


def _reproject(world_h: Array, inv_sdk: Array, T_S: Array, T_C: Array, intr: CameraIntrinsics) -> Array:
    """Vectorised chain: stage points → pixels for all observations."""
    inv_T_S = invert_transform(T_S)
    p1 = world_h @ inv_T_S.T  # (N,4) origin frame
    p2 = np.einsum("nij,nj->ni", inv_sdk, p1)  # body frame
    p3 = p2 @ T_C.T  # camera frame
    return project_points(p3[:, :3], intr)


def solve(
    observations: list[Observation],
    intr: CameraIntrinsics,
    *,
    init_S: tuple[Array, Array],
    init_C: tuple[Array, Array] | None = None,
    refine_C: bool = False,
    robust_scale: float = 1.0,
    robust_loss: str = "huber",
    prior_weight_rotation: float = 820.7,
    prior_weight_translation: float = 0.01,
    max_iterations: int = 200,
    timeout_seconds: float | None = None,
    lens_free: LensFreedom | None = None,
) -> SolverResult:
    """Solve for ``T_S_from_O`` (and optional ``T_C_from_B`` delta + lens params).

    With ``lens_free`` None or all-fixed, the state vector, residual and
    ``least_squares`` call are identical to the Phase-1 path (bit-identical
    backward compat).  When lens scalars are free, they are appended to the
    state in :data:`_LENS_ORDER` and refined jointly.
    """
    world_h, pixels, inv_sdk = _build_observation_arrays(observations)

    q_S0, t_S0 = init_S
    p_S0 = np.concatenate([quat_to_rotvec(np.asarray(q_S0, float)), np.asarray(t_S0, float)])
    if init_C is None:
        init_C = (np.array([1.0, 0.0, 0.0, 0.0]), np.zeros(3))
    q_C0, t_C0 = init_C
    p_C0 = np.concatenate([quat_to_rotvec(np.asarray(q_C0, float)), np.asarray(t_C0, float)])
    T_C_fixed = _transform_from_params(p_C0)

    lf = lens_free or LensFreedom()
    free_names = lf.free_names
    n_spatial = 12 if refine_C else 6
    lens_init = {"focal_scale": 1.0, "cx": intr.cx, "cy": intr.cy, "k1": intr.k1, "k2": intr.k2}

    def _intr_for(x: Array) -> CameraIntrinsics:
        if not free_names:
            return intr
        xl = {n: x[n_spatial + i] for i, n in enumerate(free_names)}
        scale = xl.get("focal_scale", 1.0)
        return replace(
            intr,
            fx=intr.fx * scale, fy=intr.fy * scale,
            cx=xl.get("cx", intr.cx), cy=xl.get("cy", intr.cy),
            k1=xl.get("k1", intr.k1), k2=xl.get("k2", intr.k2),
        )

    deadline = time.monotonic() + timeout_seconds if timeout_seconds else None

    def residuals(x: Array) -> Array:
        if deadline is not None and time.monotonic() > deadline:
            raise SolverTimeoutError(
                f"solver exceeded timeout_seconds={timeout_seconds}",
                details={"timeout_seconds": timeout_seconds},
            )
        T_S = _transform_from_params(x[:6])
        T_C = _transform_from_params(x[6:12]) if refine_C else T_C_fixed
        pred = _reproject(world_h, inv_sdk, T_S, T_C, _intr_for(x))
        res = (pred - pixels).ravel()
        if refine_C:
            # Split prior weights: rotation residual is in rad, translation in
            # mm — one shared weight made the translation prior a hard freeze
            # (σ ≈ 0.03 mm) while the rotation prior stayed loose (A3.2).
            rot_prior = np.sqrt(prior_weight_rotation) * (x[6:9] - p_C0[:3])
            t_prior = np.sqrt(prior_weight_translation) * (x[9:12] - p_C0[3:])
            res = np.concatenate([res, rot_prior, t_prior])
        if lf.free_focal:
            fs = x[n_spatial + free_names.index("focal_scale")]
            res = np.concatenate([res, [np.sqrt(lf.focal_prior_weight) * (fs - 1.0)]])
        # Behind-camera iterates project to inf/NaN; replace with a large finite
        # penalty so least_squares stays finite and steps away from them.
        return np.nan_to_num(res, nan=1.0e6, posinf=1.0e6, neginf=-1.0e6)

    x0_spatial = p_S0.copy() if not refine_C else np.concatenate([p_S0, p_C0])
    if free_names:
        x0 = np.concatenate([x0_spatial, [lens_init[n] for n in free_names]])
    else:
        x0 = x0_spatial
    init_res = residuals(x0)
    initial_cost = 0.5 * float(init_res @ init_res)

    if robust_loss not in _LOSS_MAP:
        raise ValueError(f"unsupported robust_loss: {robust_loss!r} (expected huber/cauchy/none)")
    ls_kwargs: dict = dict(
        method="trf", loss=_LOSS_MAP[robust_loss], f_scale=robust_scale,
        max_nfev=max_iterations * (len(x0) + 1),
    )
    if free_names:
        lo = np.full(len(x0), -np.inf)
        hi = np.full(len(x0), np.inf)
        for i, n in enumerate(free_names):
            gi = n_spatial + i
            if n == "focal_scale":
                lo[gi], hi[gi] = 1.0 - lf.focal_scale_bound, 1.0 + lf.focal_scale_bound
            elif n == "cx":
                lo[gi], hi[gi] = intr.cx - lf.pp_margin_x_px, intr.cx + lf.pp_margin_x_px
            elif n == "cy":
                lo[gi], hi[gi] = intr.cy - lf.pp_margin_y_px, intr.cy + lf.pp_margin_y_px
            else:  # k1, k2
                lo[gi], hi[gi] = lf.k_lo, lf.k_hi
        ls_kwargs["bounds"] = (lo, hi)

    sol = least_squares(residuals, x0, **ls_kwargs)

    T_S = _transform_from_params(sol.x[:6])
    T_C = _transform_from_params(sol.x[6:12]) if refine_C else T_C_fixed
    pred = _reproject(world_h, inv_sdk, T_S, T_C, _intr_for(sol.x))
    per_obs = np.nan_to_num(np.linalg.norm(pred - pixels, axis=1), nan=1.0e6, posinf=1.0e6)
    outlier_thresh = max(3.0 * robust_scale, 1e-6)
    num_outliers = int(np.sum(per_obs > outlier_thresh))

    lens_values = lens_std = lens_corr = None
    lens_corr_available = False
    if free_names:
        lens_values = {n: float(sol.x[n_spatial + i]) for i, n in enumerate(free_names)}
        lens_std, lens_corr, lens_corr_available = _lens_covariance(
            sol, n_spatial, free_names
        )

    try:
        # Scale-invariant conditioning: normalise Jacobian columns to unit norm
        # first, so κ reflects parameter *collinearity* (observability) rather
        # than the unit mismatch between mm translations, radian rotations and
        # dimensionless lens coefficients (which alone inflates κ by ~1e8).
        J = np.asarray(sol.jac, dtype=np.float64)
        colnorm = np.linalg.norm(J, axis=0)
        colnorm[colnorm == 0.0] = 1.0
        Jn = J / colnorm
        condition_number = float(np.linalg.cond(Jn.T @ Jn))
    except Exception:  # noqa: BLE001
        condition_number = None

    termination = "CONVERGENCE" if sol.success else "NO_CONVERGENCE"
    return SolverResult(
        tracker_to_stage_q=tuple(matrix_to_quat(T_S[:3, :3])),
        tracker_to_stage_t=tuple(T_S[:3, 3]),
        camera_from_tracker_q=tuple(matrix_to_quat(T_C[:3, :3])),
        camera_from_tracker_t=tuple(T_C[:3, 3]),
        initial_cost=initial_cost,
        final_cost=float(sol.cost),
        num_iterations=int(sol.nfev),
        num_inliers=int(len(observations) - num_outliers),
        num_outliers=num_outliers,
        termination_type=termination,
        termination_message=sol.message,
        solver_backend="scipy",
        residuals_px=[float(r) for r in per_obs],
        lens_values=lens_values,
        lens_std=lens_std,
        lens_corr=lens_corr,
        lens_corr_available=lens_corr_available,
        condition_number=condition_number,
    )


def _lens_covariance(
    sol, n_spatial: int, free_names: list[str]
) -> tuple[dict[str, float] | None, dict[str, float] | None, bool]:
    """Per-param std + max |ρ| vs free spatial params from the solution Jacobian.

    Returns ``(std, corr, available)``.  ``corr[name]`` is the max absolute
    correlation of that lens param against any free spatial parameter (indices
    ``0:n_spatial``) — the §5.3 #2 backstop signal.  Best-effort: a singular
    ``JᵀJ`` yields ``available=False`` (gate then fails closed, §5.6).
    """
    try:
        J = np.asarray(sol.jac, dtype=np.float64)
        cov = np.linalg.pinv(J.T @ J)
        d = np.sqrt(np.clip(np.diag(cov), 0.0, None))
        std: dict[str, float] = {}
        corr: dict[str, float] = {}
        for i, n in enumerate(free_names):
            gi = n_spatial + i
            std[n] = float(d[gi])
            denom = d[gi] * d[:n_spatial]
            with np.errstate(divide="ignore", invalid="ignore"):
                rho = np.where(denom > 0, cov[gi, :n_spatial] / denom, 0.0)
            corr[n] = float(np.max(np.abs(rho))) if n_spatial > 0 else 0.0
        return std, corr, True
    except Exception:  # noqa: BLE001 — singular/degenerate → fail closed
        return None, None, False
