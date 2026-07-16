"""Observability / identifiability gates for Quick Lens Estimate (QLE spec §5).

Two stages, implementing the architecture's "先归因后放行" discipline:

* :func:`determine_lens_freedom` — PRE-SOLVE.  Given a spatial-only baseline
  solve and coverage signals, decide which requested lens scalars may be freed.
* :func:`validate_lens_estimate` — POST-SOLVE.  Given the joint solve result,
  decide which freed params to *keep* (covariance / correlation / cross-subset /
  improvement gates); reverted params are re-locked and the solve re-run.

Every decision records measured-vs-threshold values so QA can print them and the
thresholds can be re-tuned via config without code changes.
"""

from __future__ import annotations

import numpy as np

from vpcal.core.observations import Observation
from vpcal.core.projection import CameraIntrinsics
from vpcal.core.solver_scipy import LensFreedom, SolverResult
from vpcal.models.lens import LensProfile
from vpcal.models.session import LensEstimateConfig

# Post-solve covariance-std revert thresholds (QLE spec §5.3 #1).
_STD_LIMIT = {"focal_scale": 0.03, "cx": 5.0, "cy": 5.0, "k1": 0.15, "k2": 0.15}
_MIN_ANGULAR_SPREAD_DEG = 30.0


def edge_obs_fraction(
    observations: list[Observation], intr: CameraIntrinsics, edge_radius_fraction: float
) -> float:
    """Fraction of observations whose pixel radius (from cx,cy) exceeds the edge
    band ``edge_radius_fraction · image_diagonal`` (QLE spec §5.2 #3)."""
    if not observations:
        return 0.0
    w, h = intr.image_size
    thresh = edge_radius_fraction * float(np.hypot(w, h))
    r = np.array([np.hypot(o.pixel_u - intr.cx, o.pixel_v - intr.cy) for o in observations])
    return float(np.mean(r > thresh))


def _corners_present(regions: dict) -> bool:
    return bool(regions.get("center")) and all(
        regions.get(c) for c in ("top_left", "top_right", "bottom_left", "bottom_right")
    )


def determine_lens_freedom(
    cfg: LensEstimateConfig,
    lens: LensProfile,
    observations: list[Observation],
    intr: CameraIntrinsics,
    *,
    refine_C: bool,
    baseline_rms_px: float,
    condition_number: float | None,
    angular_spread_deg: float,
    sensor_regions: dict,
) -> tuple[LensFreedom, dict]:
    """PRE-SOLVE gate: decide which requested lens params may be freed.

    Returns ``(LensFreedom, pre_report)``.  An all-fixed ``LensFreedom`` means the
    solve degrades to the Phase-1 spatial-only path.
    """
    num_poses = len({o.frame_id for o in observations})
    num_obs = len(observations)
    edge_frac = edge_obs_fraction(observations, intr, cfg.edge_radius_fraction)
    requested = set(cfg.params)
    flags: list[str] = []
    gates: dict = {}

    margin_x = cfg.principal_point_margin_mm * intr.image_size[0] / lens.sensor_width_mm
    margin_y = cfg.principal_point_margin_mm * intr.image_size[1] / lens.sensor_height_mm

    # Gate 1 — condition number → refuse ALL lens freedom.
    kappa_ok = condition_number is None or condition_number < cfg.condition_number_limit
    gates["condition_number"] = {
        "value": condition_number, "threshold": cfg.condition_number_limit,
        "verdict": "pass" if kappa_ok else "fail",
    }
    base_signals = {
        "num_poses": num_poses, "num_observations": num_obs,
        "edge_obs_fraction": edge_frac, "angular_spread_deg": angular_spread_deg,
        "baseline_rms_px": baseline_rms_px, "condition_number": condition_number,
        "sensor_corners_present": _corners_present(sensor_regions),
    }
    if not kappa_ok:
        flags.append(
            f"ill-conditioned baseline (κ={condition_number:.2e} ≥ "
            f"{cfg.condition_number_limit:.0e}); all lens params locked"
        )
        return (
            LensFreedom(focal_prior_weight=cfg.focal_prior_weight),
            {"flags": flags, "gates": gates, "freed": [], "signals": base_signals},
        )

    free_focal = cfg.refine_focal
    free_cx = "cx" in requested
    free_cy = "cy" in requested
    free_k1 = "k1" in requested
    free_k2 = "k2" in requested

    # Gate 2 — cx/cy.  (No baseline-RMS check: a high spatial-only RMS is the
    # *expected* symptom of the unknown lens we are estimating, so gating on it
    # would defeat the feature — the post-solve improvement gate handles "did it
    # actually help".)
    cxcy_checks = {
        "refine_C_exclusion": not (refine_C and (free_cx or free_cy)),
        "angular_spread": angular_spread_deg >= _MIN_ANGULAR_SPREAD_DEG,
        "sensor_corners": _corners_present(sensor_regions),
        "min_poses": num_poses >= cfg.min_poses,
        "min_observations": num_obs >= cfg.min_observations,
    }
    gates["cx_cy"] = {"checks": cxcy_checks, "verdict": "pass" if all(cxcy_checks.values()) else "fail"}
    if (free_cx or free_cy) and not all(cxcy_checks.values()):
        failed = [k for k, v in cxcy_checks.items() if not v]
        flags.append(f"cx/cy locked (pre-solve): {', '.join(failed)}")
        free_cx = free_cy = False

    # Gate 3 — k1/k2 (edge coverage; same RMS rationale as above).
    k_checks = {"edge_coverage": edge_frac >= cfg.min_edge_obs_fraction}
    gates["k1_k2"] = {"checks": k_checks, "verdict": "pass" if all(k_checks.values()) else "fail"}
    if (free_k1 or free_k2) and not all(k_checks.values()):
        failed = [k for k, v in k_checks.items() if not v]
        flags.append(f"k1/k2 locked (pre-solve): {', '.join(failed)}")
        free_k1 = free_k2 = False

    lf = LensFreedom(
        free_focal=free_focal, free_cx=free_cx, free_cy=free_cy,
        free_k1=free_k1, free_k2=free_k2,
        pp_margin_x_px=margin_x, pp_margin_y_px=margin_y,
        k_lo=cfg.k_bounds[0], k_hi=cfg.k_bounds[1],
        focal_prior_weight=cfg.focal_prior_weight,
    )
    return lf, {"flags": flags, "gates": gates, "freed": lf.free_names, "signals": base_signals}


def validate_lens_estimate(
    lens_free: LensFreedom,
    solver_result: SolverResult,
    cfg: LensEstimateConfig,
    *,
    baseline_rms_px: float,
    refined_rms_px: float,
    cross_subset_deltas: dict[str, float] | None = None,
) -> tuple[dict, LensFreedom]:
    """POST-SOLVE gate: decide which freed params to KEEP.

    Returns ``(post_report, surviving_freedom)``.  ``surviving_freedom`` drops the
    reverted params so the caller can re-solve consistently (QLE spec §5.4).
    """
    freed = lens_free.free_names
    std = solver_result.lens_std or {}
    corr = solver_result.lens_corr or {}
    corr_avail = solver_result.lens_corr_available
    values = solver_result.lens_values or {}
    improvement_pct = (
        100.0 * (baseline_rms_px - refined_rms_px) / baseline_rms_px
        if baseline_rms_px > 0 else 0.0
    )
    improvement_ok = improvement_pct >= cfg.min_improvement_pct

    keep = {n: True for n in freed}
    verdicts: dict = {}
    for n in freed:
        reasons: list[str] = []
        if not improvement_ok:
            reasons.append(
                f"global RMS improvement {improvement_pct:.1f}% < {cfg.min_improvement_pct}%"
            )
        s = std.get(n)
        if s is not None and s > _STD_LIMIT.get(n, np.inf):
            reasons.append(f"std {s:.4g} > {_STD_LIMIT[n]}")
        if not corr_avail:
            # §5.6 fail-closed: cannot verify confounding → do not keep.
            reasons.append("correlation unavailable (fail-closed)")
        else:
            c = corr.get(n, 0.0)
            if c > cfg.correlation_limit:
                reasons.append(
                    f"|ρ|={c:.2f} > {cfg.correlation_limit} "
                    "(confounded with free spatial params)"
                )
        if reasons:
            keep[n] = False
        verdicts[n] = {"kept": keep[n], "std": s, "corr": corr.get(n), "reasons": reasons}

    # Cross-subset consistency for distortion (deltas supplied by the pipeline).
    if cross_subset_deltas and "k1" in freed:
        dk1 = cross_subset_deltas.get("k1")
        if dk1 is not None:
            k1v = abs(values.get("k1", 0.0))
            rel = abs(dk1) / k1v if k1v > 1e-9 else float("inf")
            if abs(dk1) > cfg.cross_subset_k_abs_delta or rel > cfg.cross_subset_k_rel_delta:
                for kk in ("k1", "k2"):
                    if kk in keep:
                        keep[kk] = False
                        verdicts[kk]["kept"] = False
                        verdicts[kk]["reasons"].append(
                            f"cross-subset |Δk1|={abs(dk1):.4g} unstable "
                            "(likely absorbing screen/tracking error)"
                        )

    params_kept = [n for n in freed if keep[n]]
    params_reverted = [n for n in freed if not keep[n]]
    post = {
        "improvement_pct": improvement_pct,
        "corr_available": corr_avail,
        "verdicts": verdicts,
        "params_kept": params_kept,
        "params_reverted": params_reverted,
        "cross_subset_skipped": bool(
            cross_subset_deltas and cross_subset_deltas.get("cross_subset_skipped")
        ),
        "confidence": confidence_label(
            backend=solver_result.solver_backend,
            params_kept=params_kept, params_reverted=params_reverted,
            corr_available=corr_avail,
        ),
    }
    if post["cross_subset_skipped"] and post["confidence"] == "high":
        post["confidence"] = "medium"
    surviving = LensFreedom(
        free_focal=("focal_scale" in freed and keep["focal_scale"]),
        free_cx=("cx" in freed and keep["cx"]),
        free_cy=("cy" in freed and keep["cy"]),
        free_k1=("k1" in freed and keep["k1"]),
        free_k2=("k2" in freed and keep["k2"]),
        pp_margin_x_px=lens_free.pp_margin_x_px, pp_margin_y_px=lens_free.pp_margin_y_px,
        k_lo=lens_free.k_lo, k_hi=lens_free.k_hi,
        focal_scale_bound=lens_free.focal_scale_bound,
        focal_prior_weight=lens_free.focal_prior_weight,
    )
    return post, surviving


def confidence_label(
    *, backend: str, params_kept: list[str], params_reverted: list[str], corr_available: bool
) -> str:
    """Map gate outcomes to a confidence label (QLE spec §6.1 / §15-6).

    All gates clean on the Ceres backend → ``high``; any revert, the scipy
    backend (no full covariance), or missing correlation → capped at ``medium``;
    nothing kept → ``low``.

    NOTE (D5): ``high`` is currently unreachable by design — QLE always runs on
    the scipy backend (the gates need the full parameter covariance, which the
    compiled Ceres module does not expose for lens params), so ``backend`` is
    never ``"ceres"`` here.  The branch is kept for a future Ceres backend with
    lens covariance support rather than removed.
    """
    if not params_kept:
        return "low"
    if params_reverted or backend != "ceres" or not corr_available:
        return "medium"
    return "high"
