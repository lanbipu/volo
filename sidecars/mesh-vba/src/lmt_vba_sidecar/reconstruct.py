"""Reconstruct top-level: capture-manifest → detection → model-constrained BA
→ cabinet pose report + IR MeasuredPoints.

Zero total station. The scale trust is the per-cabinet active-surface size in
ScreenMapping (local mm); the root cabinet (V000_R000) is the gauge — its
active-surface frame IS the world frame (R=I, t=0). All other cabinet poses
and the cameras are solved relative to it, so the result is a self-consistent
screen-local reconstruction with no anchors / world datum.

Pipeline:
  1. Load capture manifest (charuco method only this release).
  2. Load screen_mapping + pattern_meta + intrinsics referenced by the manifest.
  3. Preflight: hash pattern_meta and check it against screen_mapping.
  4. Build per-cabinet ChArUco board descriptors + a deterministic cabinet
     index map (root = index of (0,0)).
  5. Detect ChArUco corners across all view images; for each corner look up its
     local mm via screen_mapping, undistort its pixel, and tag it with the
     view's camera index. → list[Observation].
  6. Observability gate.
  7. Init cameras via per-view PnP against the root cabinet (or any seen cabinet
     composed with that cabinet's nominal pose); init cabinet translations from
     the nominal grid (root re-centered to origin).
  8. model_constrained_ba.
  9. Per-cabinet geometry from solved pose + the 4 active-surface CORNERS.
 10. Write cabinet_pose_report.json (if requested).
 11. Emit MeasuredPoints (center in meters) + ResultEvent.
"""
from __future__ import annotations

from collections import Counter
from collections.abc import Callable

import dataclasses
import hashlib
import json
import os
import pathlib
import tempfile

import cv2
import numpy as np

from lmt_vba_sidecar.capture_manifest import load_capture_manifest
from lmt_vba_sidecar.detect import detect_charuco_corners
from lmt_vba_sidecar.eval_runner import reconstruct_cabinet_geometry
from lmt_vba_sidecar.intrinsics_io import load_intrinsics_file
from lmt_vba_sidecar.intrinsics_solve import (
    POSE_ROT_DIVERSITY_STRICT_DEG,
    STANDOFF_RATIO_MIN,
    IntrinsicsRefused,
    _grouped_standoff_ratio,
    _grouped_view_axis_deg,
    crosscheck_intrinsics,
    solve_sl_intrinsics,
)
from lmt_vba_sidecar.io_utils import write_event
from lmt_vba_sidecar.ipc import (
    BaStats,
    CabinetPose,
    CabinetPoseReport,
    ErrorEvent,
    FrameSpec,
    MeasuredPoint,
    PatternMeta,
    PointSource,
    PointSourceVisualBa,
    ProgressEvent,
    ReconstructInput,
    ReconstructProject,
    ResultData,
    ResultEvent,
    ScreenResultSummary,
    ScreenTransformEntry,
    ScreenTransformsReport,
    Uncertainty,
    VpqspPatternMeta,
    WarningEvent,
    WithheldSummary,
)
from lmt_vba_sidecar.model_constrained_ba import (
    BAResult,
    Observation,
    model_constrained_ba,
    _precompute_obs_arrays,
    _residuals,
    _nonroot_cabinets,
    _pack,
)
from lmt_vba_sidecar.nominal import (
    nominal_cabinet_poses_model_frame,
)
from lmt_vba_sidecar.observability import (
    ObservabilityError,
    ScreenConnectivityError,
    check_observability,
    check_screen_connectivity,
)
from lmt_vba_sidecar.procrustes import procrustes_rigid
from lmt_vba_sidecar.screen_mapping import ScreenMapping, ScreenMappingError


ROOT_CABINET = (0, 0)  # V000_R000 is the gauge cabinet (world == its frame)
MIN_PNP_CORNERS = 4
# Stage A PnP-RANSAC: gross-outlier reject threshold + RANSAC config (sidecar
# internal constants; NOT a CLI knob). 2-3px is below the minimum resolvable
# inter-dot spacing in the image, so near-neighbor mis-IDs still exceed it.
PNP_RANSAC_REPROJ_PX = 3.0
PNP_RANSAC_CONFIDENCE = 0.99
PNP_RANSAC_ITERS = 100
FALLBACK_ISOTROPIC_M = 0.005

# --- per-cabinet SOFT quality thresholds (tunable) ---
# These sit ABOVE the HARD observability gate (min_views=2, min_points=8) in
# check_observability: a cabinet that clears observability can still be flagged
# here as a soft warning. A cabinet seen by <2 views never reaches this stage
# (reconstruct aborts at observability_failed first).
QUALITY_MIN_VIEWS = 4  # below this (but >=2) -> "low_observation"
QUALITY_MAX_CABINET_RMS_PX = 2.0  # per-cabinet reproj RMS above this -> "high_residual"
# align_to_nominal rigid-fit residual above this => the as-built wall deviates from the
# nominal design by more than reconstruction noise (a clean given-K reconstruction aligns at
# ~0.2mm; ~1% global pitch scale ~2.5mm, ~2% ~4.9mm). Surfaces the NON-absorbable pitch/shape
# class (P5) the L1 cross-check (absorbable class) does not cover. SL (align_to_nominal) only.
NOMINAL_MISFIT_WARN_MM = 3.0

# --- Stage B robust-residual trim (PRIMARY geometric authority) ---
STAGE_B_MAX_ITERS = 3
STAGE_B_MAD_K = 3.0
STAGE_B_ABS_PX_FLOOR = 3.0
STAGE_B_GROUP_MEDIAN_PX = 4.0  # whole-(cam,cab)-group coherence guard
BA_RMS_FATAL_PX = 2.0          # FIX-4: converged solutions above this rms are refused
BA_NFEV_FLOOR = 200
BA_NFEV_PER_CAB_CAM = 50
# Budget-exhaust practical acceptance: scipy status=0 with excellent residual
# (joint 2×8 captures stall near rms≈0.18px without xtol/ftol). Starve tests
# (max_nfev < BA_NFEV_MIN_FOR_BUDGET_ACCEPT) stay fatal. Tighter than
# BA_RMS_FATAL_PX so anisotropic-pitch stalls (~1.5px) remain refused.
BA_NFEV_MIN_FOR_BUDGET_ACCEPT = 50
BA_RMS_BUDGET_ACCEPT_PX = 1.0


def _ba_max_nfev(n_cabinets: int, n_cameras: int) -> int:
    return max(BA_NFEV_FLOOR, BA_NFEV_PER_CAB_CAM * n_cabinets * n_cameras)


def _ba_acceptance_failed(result: BAResult, max_nfev: int) -> bool:
    """Emit ba_diverged / ba_budget_exhausted; True means refuse the solve.

    ba_stats.converged stays scipy's truthful success flag.
    """
    if result.rms_reprojection_px > BA_RMS_FATAL_PX:
        write_event(ErrorEvent(
            event="error", code="ba_diverged",
            message=(f"BA {'converged' if result.converged else 'finished'} but "
                     f"reprojection rms {result.rms_reprojection_px:.2f}px "
                     f"exceeds {BA_RMS_FATAL_PX}px: the model does not explain the "
                     f"observations (wrong shape_prior / intrinsics / capture geometry)"),
            fatal=True))
        return True
    if result.converged:
        return False
    if (result.iterations >= max_nfev
            and max_nfev >= BA_NFEV_MIN_FOR_BUDGET_ACCEPT
            and result.rms_reprojection_px <= BA_RMS_BUDGET_ACCEPT_PX):
        write_event(WarningEvent(
            event="warning", code="ba_budget_exhausted",
            message=(f"BA hit nfev budget ({result.iterations}) with acceptable "
                     f"rms={result.rms_reprojection_px:.2f}px; accepting solution")))
        return False
    write_event(ErrorEvent(
        event="error", code="ba_diverged",
        message=(f"BA did not converge (rms={result.rms_reprojection_px:.2f}px "
                 f"after {result.iterations} iters)"),
        fatal=True))
    return True


def _classify_cabinet_quality(observed_views: int, reproj_rms_px: float) -> str:
    """Classify a cabinet's soft quality after BA.

    Order: under-observation dominates residual (too few views makes the
    residual itself untrustworthy), so check views first.
    """
    if observed_views < QUALITY_MIN_VIEWS:
        return "low_observation"
    if reproj_rms_px > QUALITY_MAX_CABINET_RMS_PX:
        return "high_residual"
    return "ok"


def _emit_cabinet_quality_summary(
    items: list[tuple[str, str]],
) -> None:
    """Emit one aggregated ``cabinet_quality`` warning (counts + sample ids).

    ``items`` is ``(cabinet_id, quality)`` for non-ok cabinets. Mirrors
    ``dead_weight_image`` aggregation so the UI does not get one event per cabinet.
    """
    if not items:
        return
    counts = Counter(q for _, q in items)
    count_txt = ", ".join(f"{n} {q}" for q, n in sorted(counts.items()))
    sample = [cid for cid, _ in items[:5]]
    sample_txt = ", ".join(sample)
    more = len(items) - len(sample)
    if more > 0:
        sample_txt += f", … (+{more} more)"
    write_event(WarningEvent(
        event="warning",
        code="cabinet_quality",
        message=(f"{len(items)} cabinet(s) with quality issues ({count_txt}); "
                 f"e.g. {sample_txt}"),
        cabinet=items[0][0],
    ))


def _per_cabinet_reproj_rms(
    K: np.ndarray,
    camera_poses: list[tuple[np.ndarray, np.ndarray]],
    cabinet_poses: dict[int, tuple[np.ndarray, np.ndarray]],
    observations: list[Observation],
) -> dict[int, float]:
    """Per-cabinet reprojection RMS (px) using the SAME projection convention as
    model_constrained_ba._residuals: xc = Rc @ (Rb @ p_local + tb) + tc, then
    p = K @ xc; residual = p[:2]/p[2] - pixel.

    RMS over a cabinet's observations is sqrt(mean over obs of (dx^2 + dy^2)),
    matching the BA's global rms = sqrt(mean_obs(dx^2 + dy^2)).

    Precondition: every observation's cabinet_idx must be present in
    cabinet_poses (guaranteed by check_observability upstream, which aborts
    reconstruct unless every cabinet has >=2 views / >=8 observations). The
    returned dict therefore has an entry for every observed cabinet.
    """
    sq_sum: dict[int, float] = {}
    counts: dict[int, int] = {}
    for o in observations:
        Rc, tc = camera_poses[o.camera_idx]
        Rb, tb = cabinet_poses[o.cabinet_idx]
        xw = Rb @ o.p_local + tb
        xc = Rc @ xw + tc
        p = K @ xc
        d = p[:2] / p[2] - o.pixel
        sq_sum[o.cabinet_idx] = sq_sum.get(o.cabinet_idx, 0.0) + float(d @ d)
        counts[o.cabinet_idx] = counts.get(o.cabinet_idx, 0) + 1
    return {
        idx: float(np.sqrt(sq_sum[idx] / counts[idx]))
        for idx in sq_sum
    }


def _obs_residual_norms(K, result, observations, root_idx):
    """Per-observation reprojection residual norm (px), using the CURRENT
    iteration's poses (recomputed, not stale sol.fun)."""
    nonroot = _nonroot_cabinets(
        max(observations, key=lambda o: o.cabinet_idx).cabinet_idx + 1, root_idx)
    # Reuse model_constrained_ba._residuals by packing the solved state.
    cabs = dict(result.cabinet_poses)
    for j in nonroot:
        cabs.setdefault(j, (np.eye(3), np.zeros(3)))
    x = _pack(result.camera_poses, cabs, nonroot)
    obs_arrays = _precompute_obs_arrays(observations)
    res = _residuals(x, len(result.camera_poses), nonroot, root_idx, K, obs_arrays)
    # _residuals returns weighted residuals (r/σ); recover unweighted norms.
    sigma = obs_arrays[4]
    r = res.reshape(-1, 2) * sigma[:, None]
    return np.sqrt((r * r).sum(axis=1))


WITHHELD_RMS_MAX_PX = 2.0  # withheld-view reprojection gate (matches BA_RMS_FATAL_PX)

# Screen-to-screen relative-pose consistency (D3): the full-solve vs TRAIN-solve
# relative transform between each screen and the frame screen must agree. This
# surfaces the focal↔depth-coupling systematic (a good BA RMS can still hide a
# mm-level inter-screen error). Marker-only (user decision 1): never fatal.
SCREEN_CONSISTENCY_MAX_MM = 1.0
SCREEN_CONSISTENCY_MAX_DEG = 0.15  # ~1mm at a 600mm lever + 50% margin vs TRAIN jitter


def _rel_screen_transform(poses, ref_root, screen_root):
    """Relative pose of one screen's root cabinet expressed in the frame screen's
    root frame: (R_rel, t_rel) with X_ref = R_rel · X_screen + t_rel."""
    R0, t0 = poses[ref_root]
    Rs, ts = poses[screen_root]
    R0 = np.asarray(R0, float)
    t0 = np.asarray(t0, float).ravel()
    Rs = np.asarray(Rs, float)
    ts = np.asarray(ts, float).ravel()
    return R0.T @ Rs, R0.T @ (ts - t0)


def _screen_to_screen_consistency(full_poses, train_poses, screen_root_indices, screen_ids):
    """Compare each screen's relative pose (vs frame screen 0) between the full
    solve and the TRAIN re-solve. Returns a dict for the validation product; single
    screen -> passed with reason 'single_screen'."""
    ref = 0
    base = {"limit_mm": SCREEN_CONSISTENCY_MAX_MM, "limit_deg": SCREEN_CONSISTENCY_MAX_DEG}
    if ref not in screen_root_indices:
        return {**base, "passed": True, "reason": "single_screen", "pairs": []}
    ref_root = screen_root_indices[ref]
    pairs = []
    all_ok = True
    for si in sorted(screen_root_indices):
        if si == ref:
            continue
        sroot = screen_root_indices[si]
        Rf, tf = _rel_screen_transform(full_poses, ref_root, sroot)
        Rt, tt = _rel_screen_transform(train_poses, ref_root, sroot)
        d_t = Rf.T @ (tt - tf)                     # dT = Tf^-1 ∘ Tt translation
        d_R = Rf.T @ Rt
        dt_norm = float(np.linalg.norm(d_t))
        cos = (float(np.trace(d_R)) - 1.0) / 2.0
        drot = float(np.degrees(np.arccos(np.clip(cos, -1.0, 1.0))))
        ok = dt_norm <= SCREEN_CONSISTENCY_MAX_MM and drot <= SCREEN_CONSISTENCY_MAX_DEG
        all_ok = all_ok and ok
        pairs.append({
            "screen_id": screen_ids[si],
            "ref_screen_id": screen_ids[ref],
            "delta_t_mm": d_t.tolist(),
            "delta_t_norm_mm": dt_norm,
            "delta_rot_deg": drot,
            "passed": bool(ok),
        })
    if not pairs:
        return {**base, "passed": True, "reason": "single_screen", "pairs": []}
    return {**base, "passed": bool(all_ok), "pairs": pairs}


def _run_withheld_validation(
    *,
    K: np.ndarray,
    result: "BAResult",
    observations: list[Observation],
    n_cabinets: int,
    root_idx: int,
    cab_idx_to_screen: dict[int, int],
    screen_ids: list[str],
    screen_root_indices: dict[int, int],
    screen_transforms_path: str,
) -> dict:
    """Camera-view holdout validation for the joint reconstruction (spec Stage B).

    Hold out >=20% of cameras — including >=1 bridge (multi-screen) view so the
    split can actually test the *cross-screen* geometry — re-solve the cabinet
    geometry on the TRAIN cameras only, PnP each withheld camera against that
    train geometry, and reproject the withheld observations. If the train-solved
    cross-screen geometry does not generalize, the withheld bridge views blow up.

    Also compares each screen's relative pose (vs the frame screen) between the
    full solve and the TRAIN re-solve (`screen_to_screen_consistency`); the
    top-level ``passed`` ANDs the withheld-RMS gate with that consistency check.

    Writes ``{screen_transforms_path}.validation.json`` carrying
    ``withheld_validation.passed`` — the formal export gate reads that pointer
    (src-tauri/src/commands/mesh_export.rs). Returns the ``withheld_validation``
    dict for the ResultData summary. Fail-closed: too few views, non-convergence,
    or any error yields ``passed: false`` with a reason and never blocks the
    already-emitted solve.
    """
    out_path = f"{screen_transforms_path}.validation.json"

    def _write(wv: dict) -> dict:
        try:
            _atomic_write_json(out_path, json.dumps(
                {"schema_version": "withheld_validation.v2", "withheld_validation": wv},
                indent=2, allow_nan=False))
        except Exception:  # a validation-write failure must never block the solve
            pass
        return wv

    try:
        # Derive screen coverage, the per-(camera,cabinet) corner map, and the
        # per-cabinet camera sets all from `observations` (= surviving_observations):
        # its camera_idx is the reindexed, stage-pruned space, so the corner map
        # stays consistent with result.camera_poses even after Stage-C view
        # rejection (and carries only surviving, outlier-free detections).
        cam_screens: dict[int, set[int]] = {}
        pvcc: dict[tuple[int, int], list[tuple[np.ndarray, np.ndarray]]] = {}
        cab_cam: dict[int, set[int]] = {}
        for o in observations:
            cam_screens.setdefault(o.camera_idx, set()).add(cab_idx_to_screen[o.cabinet_idx])
            pvcc.setdefault((o.camera_idx, o.cabinet_idx), []).append((o.p_local, o.pixel))
            cab_cam.setdefault(o.cabinet_idx, set()).add(o.camera_idx)
        cams = sorted(cam_screens)
        bridges = [c for c in cams if len(cam_screens[c]) >= 2]
        singles = [c for c in cams if len(cam_screens[c]) < 2]
        # Need >=3 bridge views to hold out >=1 while keeping >=2 in train.
        if len(bridges) < 3:
            return _write({"passed": False, "reason": "insufficient_bridge_views_for_holdout",
                           "bridge_views": len(bridges)})
        n_hold_bridge = min(max(1, len(bridges) // 5), len(bridges) - 2)
        withheld = set(bridges[-n_hold_bridge:])
        n_hold_single = len(singles) // 5
        if n_hold_single:
            withheld |= set(singles[-n_hold_single:])
        train = [c for c in cams if c not in withheld]
        train_set = set(train)
        # Every CABINET must keep >=2 train views. A cabinet observed only by
        # withheld views is never re-estimated on train — the warm-started re-solve
        # leaves it at its full-solve pose, so its withheld reprojection is
        # trivially ~0 and would spuriously pass. (Per-cabinet, not per-screen.)
        if any(len(cab_cam[cab] & train_set) < 2 for cab in cab_cam):
            return _write({"passed": False, "reason": "insufficient_train_coverage_after_holdout"})

        # Re-solve cabinet geometry on TRAIN cameras only (reindexed, warm-started).
        remap = {c: i for i, c in enumerate(train)}
        train_obs = [Observation(camera_idx=remap[o.camera_idx], cabinet_idx=o.cabinet_idx,
                                 p_local=o.p_local, pixel=o.pixel, sigma_px=o.sigma_px)
                     for o in observations if o.camera_idx in train_set]
        # Match the primary solve's iteration budget and budget-accept semantics:
        # the default max_nfev=200 is 1/10th of the scale-based budget and joint
        # captures stall (rms≈0.18px) without triggering xtol/ftol, so scipy
        # success stays False -> a good re-solve was misjudged as non-convergent.
        # Inline the acceptance check (do NOT reuse _ba_acceptance_failed: it emits
        # fatal ba_diverged events; validation must never block or emit events).
        train_max_nfev = _ba_max_nfev(n_cabinets, len(train))
        train_res = model_constrained_ba(
            K=K, observations=train_obs, n_cameras=len(train), n_cabinets=n_cabinets,
            root_cabinet_idx=root_idx,
            init_cameras=[result.camera_poses[c] for c in train],
            init_cabinets=dict(result.cabinet_poses), compute_covariance=False,
            max_nfev=train_max_nfev)
        train_accepted = train_res.converged or (
            train_res.iterations >= train_max_nfev
            and train_max_nfev >= BA_NFEV_MIN_FOR_BUDGET_ACCEPT
            and train_res.rms_reprojection_px <= BA_RMS_BUDGET_ACCEPT_PX)
        if not train_accepted:
            return _write({"passed": False, "reason": "train_resolve_did_not_converge",
                           "train_rms_px": train_res.rms_reprojection_px,
                           "train_iterations": train_res.iterations})
        train_cabinets = train_res.cabinet_poses

        # Screen-to-screen relative-pose consistency: full solve vs TRAIN re-solve.
        s2s = _screen_to_screen_consistency(
            result.cabinet_poses, train_cabinets, screen_root_indices, screen_ids)

        # PnP each withheld camera against the train geometry; reproject its obs.
        obs_by_cam: dict[int, list[Observation]] = {}
        for o in observations:
            if o.camera_idx in withheld:
                obs_by_cam.setdefault(o.camera_idx, []).append(o)
        norms: list[float] = []
        per_screen_sq: dict[int, list[float]] = {}
        for c in sorted(withheld):
            Rc, tc = _pnp_camera(c, root_idx, train_cabinets, pvcc, K)
            for o in obs_by_cam.get(c, []):
                Rb, tb = train_cabinets[o.cabinet_idx]
                p = K @ (Rc @ (Rb @ o.p_local + tb) + tc)
                d = float(np.linalg.norm(p[:2] / p[2] - o.pixel))
                norms.append(d)
                per_screen_sq.setdefault(cab_idx_to_screen[o.cabinet_idx], []).append(d * d)
        if not norms:
            return _write({"passed": False, "reason": "no_withheld_observations",
                           "screen_to_screen_consistency": s2s})
        arr = np.asarray(norms)
        if not np.all(np.isfinite(arr)):
            return _write({"passed": False, "reason": "non_finite_reprojection",
                           "screen_to_screen_consistency": s2s})
        combined = float(np.sqrt(np.mean(arr * arr)))
        per_screen = {screen_ids[s]: float(np.sqrt(np.mean(v))) for s, v in per_screen_sq.items()}
        withheld_rms_ok = combined < WITHHELD_RMS_MAX_PX and all(
            v < WITHHELD_RMS_MAX_PX for v in per_screen.values())
        return _write({
            "passed": bool(withheld_rms_ok and s2s["passed"]),
            "limit_px": WITHHELD_RMS_MAX_PX,
            "combined_rms_px": combined,
            "per_screen_rms_px": per_screen,
            "p50_px": float(np.percentile(arr, 50)),
            "p95_px": float(np.percentile(arr, 95)),
            "max_px": float(arr.max()),
            "train_views": train,
            "withheld_views": sorted(withheld),
            "withheld_bridge_views": sorted(set(bridges) & withheld),
            "screen_to_screen_consistency": s2s,
        })
    except Exception as exc:  # noqa: BLE001 — fail-closed, never block the solve
        return _write({"passed": False, "reason": f"validation_error: {type(exc).__name__}: {exc}"})


def _withheld_summary_from_wv(wv: dict) -> WithheldSummary:
    """Distill the withheld_validation dict into the compact ResultData summary
    (the durable digest / provenance surface). All fields optional."""
    s2s = wv.get("screen_to_screen_consistency") or {}
    pairs = s2s.get("pairs") or []
    return WithheldSummary(
        passed=bool(wv.get("passed", False)),
        reason=wv.get("reason"),
        combined_rms_px=wv.get("combined_rms_px"),
        limit_px=wv.get("limit_px"),
        screen_consistency_passed=(s2s.get("passed") if s2s else None),
        max_delta_t_mm=(max(p["delta_t_norm_mm"] for p in pairs) if pairs else None),
        max_delta_rot_deg=(max(p["delta_rot_deg"] for p in pairs) if pairs else None),
    )


def stage_b_robust_solve(*, K, observations, n_cameras, n_cabinets,
                         root_cabinet_idx, init_cameras, init_cabinets,
                         per_cabinet_min_points, max_nfev=200):
    """Iterative robust-residual trim wrapping model_constrained_ba (PRIMARY
    geometric authority). Recomputes residuals each iter (sol.fun is stale),
    drops norm > max(k*MAD, abs_px_floor) plus whole-(cam,cab)-group coherence
    outliers, re-solves, <=3 iters. Never trims any cabinet below
    per_cabinet_min_points. Returns (result, rejected_per_cab, total,
    surviving_observations) where surviving_observations is the trimmed obs list
    the final solve ran on (caller reuses it for _per_cabinet_reproj_rms,
    per-cabinet view/point recompute, and the post-trim observability check)."""
    obs = list(observations)
    rejected_per_cab: dict[int, int] = {}
    result = model_constrained_ba(
        K=K, observations=obs, n_cameras=n_cameras, n_cabinets=n_cabinets,
        root_cabinet_idx=root_cabinet_idx, init_cameras=init_cameras,
        init_cabinets=init_cabinets, loss="huber", max_nfev=max_nfev)
    for _ in range(STAGE_B_MAX_ITERS):
        norms = _obs_residual_norms(K, result, obs, root_cabinet_idx)
        mad = float(np.median(np.abs(norms - np.median(norms)))) or 0.0
        thr = max(STAGE_B_MAD_K * mad, STAGE_B_ABS_PX_FLOOR)
        # group coherence: median residual per (cam,cab)
        group_norms: dict[tuple[int, int], list[float]] = {}
        for o, nrm in zip(obs, norms):
            group_norms.setdefault((o.camera_idx, o.cabinet_idx), []).append(nrm)
        group_thr = max(STAGE_B_GROUP_MEDIAN_PX,
                        min(2.0 * result.rms_reprojection_px, 8.0))
        bad_groups = {g for g, v in group_norms.items()
                      if float(np.median(v)) > group_thr}
        # candidate drops: pointwise OR in a bad group
        drop = [(nrm > thr) or ((o.camera_idx, o.cabinet_idx) in bad_groups)
                for o, nrm in zip(obs, norms)]
        if not any(drop):
            break
        # Drop flagged outliers down to a BA-SAFETY floor (MIN_PNP_CORNERS — enough
        # to keep model_constrained_ba well-defined), deliberately PAST
        # per_cabinet_min_points. We must NOT retain known-bad observations just to
        # keep a cabinet at the minimum: that left an over-corrupted cabinet with
        # high-residual points and shipped a wrong report (Codex P2). When a
        # cabinet's good points can't sustain >= per_cabinet_min_points, it falls
        # below the floor here and solve_and_emit's post-trim observability check
        # (>= per_cabinet_min_points points, >= 2 views) hard-stops it.
        from collections import Counter
        safety_floor = min(MIN_PNP_CORNERS, per_cabinet_min_points)
        kept_counts = Counter(o.cabinet_idx for o, d in zip(obs, drop) if not d)
        new_obs = []
        n_dropped_this_iter = 0
        for o, d in zip(obs, drop):
            if d and kept_counts.get(o.cabinet_idx, 0) >= safety_floor:
                rejected_per_cab[o.cabinet_idx] = rejected_per_cab.get(o.cabinet_idx, 0) + 1
                n_dropped_this_iter += 1
            else:
                new_obs.append(o)
                if d:  # below the BA-safety floor: keep to keep the solve defined
                    kept_counts[o.cabinet_idx] = kept_counts.get(o.cabinet_idx, 0) + 1
        if n_dropped_this_iter == 0:
            break
        obs = new_obs
        result = model_constrained_ba(
            K=K, observations=obs, n_cameras=n_cameras, n_cabinets=n_cabinets,
            root_cabinet_idx=root_cabinet_idx, init_cameras=init_cameras,
            init_cabinets=init_cabinets, loss="huber", max_nfev=max_nfev)
    total = sum(rejected_per_cab.values())
    return result, rejected_per_cab, total, obs


def solve_with_view_rejection(*, K, observations, per_view_cab_corners,
                              n_cameras, n_cabinets, root_cabinet_idx,
                              make_inits, per_cabinet_min_points):
    """stage_b_robust_solve + one whole-view rejection retry (Stage C).

    A frame captured while the scene/lens state differed (bumped screen, AF
    focal drift, motion distortion) is internally consistent — homography clean
    and per-board PnP both pass — yet jointly inconsistent with the other
    views, so Stage B's point/group trims cannot reach it and the global rms
    fails BA_RMS_FATAL_PX (real dual-screen case: 2 bad frames in 11 → 2.21px
    fatal; without them 0.31px). When the gate would refuse: drop cameras whose
    median residual > max(2×global median, 1.5px), then RE-INITIALIZE from the
    surviving views (bridge + PnP via ``make_inits``) and re-solve — continuing
    from the polluted solution's init only walks back into its 2px basin.

    ``make_inits(pvcc, n_cams) -> (init_cameras, init_cabinets) | None`` (None =
    caller already emitted a fatal event). Guards: >=2 surviving cameras and
    every cabinet keeps >= per-cabinet floors, else the first result stands.
    Returns (result, rejected_per_cab, n_rejected, surviving_obs, max_nfev)
    or None when make_inits failed.
    """
    obs_cur = list(observations)
    pvcc_cur = dict(per_view_cab_corners)
    n_cams = n_cameras
    view_rej_per_cab: dict[int, int] = {}
    view_rej_cams: set[int] = set()  # original camera indexing (single round)
    for attempt in (1, 2):
        inits = make_inits(pvcc_cur, n_cams)
        if inits is None:
            return None
        init_cameras, init_cabinets = inits
        max_nfev = _ba_max_nfev(n_cabinets, n_cams)
        result, rej_cab, n_rej, surviving = stage_b_robust_solve(
            K=K, observations=obs_cur, n_cameras=n_cams, n_cabinets=n_cabinets,
            root_cabinet_idx=root_cabinet_idx, init_cameras=init_cameras,
            init_cabinets=init_cabinets,
            per_cabinet_min_points=per_cabinet_min_points, max_nfev=max_nfev)
        if attempt == 2 or result.rms_reprojection_px <= BA_RMS_FATAL_PX:
            break
        norms = _obs_residual_norms(K, result, surviving, root_cabinet_idx)
        per_cam: dict[int, list[float]] = {}
        for o, nrm in zip(surviving, norms):
            per_cam.setdefault(o.camera_idx, []).append(nrm)
        global_med = float(np.median(norms))
        bad_cams = {c for c, v in per_cam.items()
                    if float(np.median(v)) > max(2.0 * global_med, 1.5)}
        if not bad_cams or len(per_cam) - len(bad_cams) < 2:
            break
        keep = [o for o in obs_cur if o.camera_idx not in bad_cams]
        pts_per_cab = Counter(o.cabinet_idx for o in keep)
        views_per_cab: dict[int, set[int]] = {}
        for o in keep:
            views_per_cab.setdefault(o.cabinet_idx, set()).add(o.camera_idx)
        all_cabs = {o.cabinet_idx for o in obs_cur}
        if not all(pts_per_cab.get(c, 0) >= per_cabinet_min_points
                   and len(views_per_cab.get(c, set())) >= 2
                   for c in all_cabs):
            break
        write_event(WarningEvent(
            event="warning", code="view_rejected",
            message=(f"rejected {len(bad_cams)} rigidly-inconsistent view(s) "
                     f"(rms {result.rms_reprojection_px:.2f}px > "
                     f"{BA_RMS_FATAL_PX}px gate); re-initializing and "
                     f"re-solving from the remaining views")))
        view_rej_cams = set(bad_cams)
        for o in obs_cur:
            if o.camera_idx in bad_cams:
                view_rej_per_cab[o.cabinet_idx] = (
                    view_rej_per_cab.get(o.cabinet_idx, 0) + 1)
        remap = {c: i for i, c in enumerate(sorted({o.camera_idx for o in keep}))}
        obs_cur = [dataclasses.replace(o, camera_idx=remap[o.camera_idx])
                   for o in keep]
        pvcc_cur = {(remap[cam], cab): v
                    for (cam, cab), v in pvcc_cur.items() if cam in remap}
        n_cams = len(remap)
    for cab, n in view_rej_per_cab.items():
        rej_cab[cab] = rej_cab.get(cab, 0) + n
    n_rej += sum(view_rej_per_cab.values())
    return result, rej_cab, n_rej, surviving, max_nfev, view_rej_cams


def _undistort_obs(pix: np.ndarray, K: np.ndarray, dist: np.ndarray) -> np.ndarray:
    """Map a single (x, y) pixel through cv2.undistortPoints to its
    pinhole-equivalent pixel coordinate. Returns same shape (2,)."""
    pts = pix.reshape(1, 1, 2).astype(np.float32)
    undistorted_norm = cv2.undistortPoints(pts, K, dist)  # normalized cam
    norm = undistorted_norm.reshape(2)
    out = K @ np.array([norm[0], norm[1], 1.0])
    return out[:2] / out[2]


def pattern_hash(pattern_meta: "PatternMeta | VpqspPatternMeta") -> str:
    """Deterministic pattern hash scheme.

    SHA-256 over the canonical pydantic JSON dump of pattern_meta, truncated to
    16 hex chars. The fixture / pattern producer must set
    ScreenMapping.expected_pattern_hash with this exact scheme. Works for both the
    ChArUco PatternMeta and the VP-QSP VpqspPatternMeta (any pydantic model).
    """
    return hashlib.sha256(pattern_meta.model_dump_json().encode()).hexdigest()[:16]


def _photo_ignore_stats(all_paths, detections) -> tuple[list[str], int, int]:
    """Basenames of photos with no detections + used/total counts."""
    ignored = [pathlib.Path(p).name for p in all_paths if not detections.get(p)]
    total = len(all_paths)
    return ignored, total - len(ignored), total


def _cabinet_id(col: int, row: int) -> str:
    return f"V{col:03d}_R{row:03d}"


def _effective_project(cmd: ReconstructInput) -> ReconstructProject | None:
    if cmd.screens:
        return cmd.screens[0]
    return cmd.project


def _is_joint_vpqsp_mode(cmd: ReconstructInput, manifest) -> bool:
    if cmd.screens and len(cmd.screens) > 1:
        return True
    return bool(manifest.screens and len(manifest.screens) > 1)


def _resolve_joint_screen_projects(cmd: ReconstructInput, manifest) -> list[ReconstructProject]:
    if cmd.screens and len(cmd.screens) > 1:
        return list(cmd.screens)
    if not manifest.screens or len(manifest.screens) <= 1:
        raise ValueError("joint reconstruct requires multiple screens")
    template = _effective_project(cmd)
    if template is None:
        raise ValueError("project or screens is required for joint reconstruct")
    by_id = {s.screen_id: s for s in (cmd.screens or [])}
    projects: list[ReconstructProject] = []
    for ms in manifest.screens:
        override = by_id.get(ms.screen_id)
        if override is not None:
            projects.append(override.model_copy(update={
                "screen_id_code": override.screen_id_code or ms.screen_id_code,
                "pattern_meta_path": override.pattern_meta_path or ms.pattern_meta,
                "screen_mapping_path": override.screen_mapping_path or ms.screen_mapping,
            }))
        else:
            projects.append(ReconstructProject(
                screen_id=ms.screen_id,
                screen_id_code=ms.screen_id_code,
                cabinet_array=template.cabinet_array,
                shape_prior=template.shape_prior,
                pattern_meta_path=ms.pattern_meta,
                screen_mapping_path=ms.screen_mapping,
            ))
    return projects


def _active_surface_corners_mm(screen_mapping: ScreenMapping, cabinet_id: str) -> np.ndarray:
    """The 4 active-surface CORNERS in local mm (center origin), BL,BR,TR,TL
    (counter-clockwise starting from bottom-left).

    These are the physical panel corners (±w/2, ±h/2) — NOT the inner ChArUco
    corners — used to derive cabinet center / normal / corners in the report.

    NOTE: the BL,BR,TR,TL ordering is load-bearing — compare_known derives
    cabinet size from this order (width=‖c1-c0‖, height=‖c2-c1‖). Do not reorder
    the array without updating compare_known.compare_known accordingly.
    """
    cab = None
    for c in screen_mapping.cabinets:
        if c.cabinet_id == cabinet_id:
            cab = c
            break
    if cab is None:
        raise ScreenMappingError(f"cabinet '{cabinet_id}' not in screen_mapping")
    w, h = cab.active_size_mm
    hw, hh = w / 2.0, h / 2.0
    return np.array(
        [
            [-hw, -hh, 0.0],
            [hw, -hh, 0.0],
            [hw, hh, 0.0],
            [-hw, hh, 0.0],
        ],
        dtype=float,
    )


def _atomic_write_json(path: str, payload: str) -> None:
    """Write text to path atomically (temp file + os.replace)."""
    directory = os.path.dirname(os.path.abspath(path)) or "."
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=directory, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(payload)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


def _nominal_world_corners(
    cr: tuple[int, int],
    corners_local: np.ndarray,
    nominal_poses: "dict[tuple[int, int], tuple[np.ndarray, np.ndarray]]",
) -> np.ndarray:
    """Nominal design-frame corners (mm) for cabinet `cr`: `R @ corners_local
    + t_mm`, with (R, t) straight from nominal_cabinet_poses_model_frame (the
    single SE(3) truth source — no reconstruction of R from a normal). The
    model frame and the BA world share the SAME recon-native axes (X=cols,
    Y=up, Z=outward normal — see nominal.py's convention declaration), so
    aligning BA corners to these is a near-identity rotation — no Y/Z swap,
    no flip ambiguity.
    """
    r_nom, t_m = nominal_poses[cr]
    return (corners_local @ np.asarray(r_nom, dtype=float).T) + np.asarray(t_m, dtype=float) * 1000.0


def run_reconstruct(cmd: ReconstructInput) -> int:
    write_event(ProgressEvent(event="progress", stage="load", percent=0.0, message="loading capture manifest"))

    # --- 1. capture manifest ---
    try:
        manifest = load_capture_manifest(cmd.capture_manifest_path)
    except Exception as e:  # CaptureManifestError or IO error
        write_event(ErrorEvent(event="error", code="invalid_input", message=str(e), fatal=True))
        return 1
    if manifest.method == "vpqsp":
        return run_reconstruct_vpqsp(cmd, manifest)
    if manifest.method != "charuco":
        write_event(ErrorEvent(
            event="error", code="invalid_input",
            message=f"only charuco/vpqsp implemented; structured-light gated (method={manifest.method})",
            fatal=True,
        ))
        return 1

    if _is_joint_vpqsp_mode(cmd, manifest):
        write_event(ErrorEvent(
            event="error", code="invalid_input",
            message="multi-screen joint reconstruct is only supported for method=vpqsp",
            fatal=True,
        ))
        return 1

    project = _effective_project(cmd)
    if project is None:
        write_event(ErrorEvent(
            event="error", code="invalid_input",
            message="project or screens is required", fatal=True))
        return 1

    # --- 2. referenced files ---
    # screen_mapping: an explicit cmd.screen_mapping_path overrides the
    # manifest's reference (lets a caller swap in a corrected mapping without
    # editing the manifest); otherwise use the manifest-resolved path.
    # intrinsics: cmd.intrinsics_path (CLI override) > manifest reference. The
    # `auto` self-cal sentinel is vpqsp-only (charuco has no marker-grid target
    # assembled here), so reject it loud rather than silently loading a file
    # named "auto".
    intrinsics_spec = cmd.intrinsics_path or manifest.intrinsics
    if intrinsics_spec is None:
        write_event(ErrorEvent(event="error", code="invalid_input",
            message="no intrinsics: set the capture manifest's `intrinsics` field, or pass "
                    "--intrinsics <path>", fatal=True))
        return 1
    if intrinsics_spec == "auto":
        write_event(ErrorEvent(event="error", code="invalid_input",
            message="--intrinsics auto self-calibration is only supported for method=vpqsp; "
                    "this capture manifest is method=charuco", fatal=True))
        return 1
    sm_path = cmd.screen_mapping_path or manifest.screen_mapping
    try:
        screen_mapping = ScreenMapping.model_validate(
            json.loads(pathlib.Path(sm_path).read_text(encoding="utf-8"))
        )
        pattern_meta = PatternMeta.model_validate(
            json.loads(pathlib.Path(manifest.pattern_meta).read_text(encoding="utf-8"))
        )
        loaded = load_intrinsics_file(intrinsics_spec)
        K = loaded.K
        dist = loaded.dist
        if loaded.image_size is None:
            raise ValueError("intrinsics file missing required image_size")
        image_size = loaded.image_size
    except (OSError, json.JSONDecodeError, KeyError, ValueError) as e:
        write_event(ErrorEvent(event="error", code="invalid_input", message=f"failed to load manifest references: {e}", fatal=True))
        return 1

    # --- 3. preflight ---
    if screen_mapping.expected_pattern_hash is None:
        write_event(WarningEvent(
            event="warning", code="pattern_hash_unset",
            message="screen_mapping.expected_pattern_hash is not set; skipping the "
                    "capture↔pattern binding check. Set it to the generated pattern's "
                    "hash to verify the captured pattern matches this config."))
    try:
        screen_mapping.preflight(pattern_hash(pattern_meta))
    except ScreenMappingError as e:
        write_event(ErrorEvent(event="error", code="invalid_input", message=str(e), fatal=True))
        return 1

    # Per-cabinet board shape (v2): (col,row) -> (squares_x, squares_y, square_px).
    shape_by_cr = {(c.col, c.row): (c.squares_x, c.squares_y, c.square_px)
                   for c in pattern_meta.cabinets}

    # --- 4. boards + deterministic cabinet index map ---
    present = sorted(
        ((c.col, c.row) for c in pattern_meta.cabinets),
        key=lambda cr: (cr[1], cr[0]),  # (row, col) order
    )
    if ROOT_CABINET not in present:
        write_event(ErrorEvent(
            event="error", code="invalid_input",
            message=f"root cabinet {_cabinet_id(*ROOT_CABINET)} (0,0) not present in pattern_meta",
            fatal=True,
        ))
        return 1
    cab_to_idx: dict[tuple[int, int], int] = {cr: i for i, cr in enumerate(present)}
    root_idx = cab_to_idx[ROOT_CABINET]
    n_cabinets = len(present)

    boards = [
        {"cabinet": (c.col, c.row),
         "aruco_id_start": c.aruco_id_start, "aruco_id_end": c.aruco_id_end,
         "squares_x": c.squares_x, "squares_y": c.squares_y}
        for c in pattern_meta.cabinets
    ]

    # --- 5. detect + build observations ---
    write_event(ProgressEvent(event="progress", stage="detect_charuco", percent=0.2, message="detecting ChArUco corners"))
    view_images: list[list[str]] = [list(v.images) for v in manifest.views]
    all_paths = [p for imgs in view_images for p in imgs]
    detections = detect_charuco_corners(all_paths, boards=boards)
    ignored_photos, photos_used, photos_total = _photo_ignore_stats(all_paths, detections)
    if ignored_photos:
        write_event(WarningEvent(
            event="warning", code="dead_weight_image",
            message=(f"{len(ignored_photos)} image(s) have no markers "
                     f"(e.g. {', '.join(ignored_photos[:3])}"
                     f"{', …' if len(ignored_photos) > 3 else ''})")))

    observations: list[Observation] = []
    # camera_idx == view index; aggregate corners per (view, cabinet) for PnP.
    per_view_cab_corners: dict[tuple[int, int], list[tuple[np.ndarray, np.ndarray]]] = {}
    per_cabinet_views: dict[int, set[int]] = {}
    per_cabinet_points: dict[int, int] = {}
    for cam_idx, imgs in enumerate(view_images):
        for path in imgs:
            for det in detections.get(path, []):
                cab_cr = tuple(det["cabinet"])
                if cab_cr not in cab_to_idx:
                    continue
                cab_idx = cab_to_idx[cab_cr]
                charuco_id = int(det["charuco_id"])
                sx, sy, spx = shape_by_cr[cab_cr]
                p_local = screen_mapping.charuco_corner_local_mm(
                    _cabinet_id(*cab_cr), charuco_id,
                    squares_x=sx, squares_y=sy, square_px=spx,
                )
                pixel = _undistort_obs(np.array(det["corner_px"], dtype=float), K, dist)
                observations.append(Observation(
                    camera_idx=cam_idx, cabinet_idx=cab_idx,
                    p_local=p_local, pixel=pixel,
                ))
                per_view_cab_corners.setdefault((cam_idx, cab_idx), []).append((p_local, pixel))
                per_cabinet_views.setdefault(cab_idx, set()).add(cam_idx)
                per_cabinet_points[cab_idx] = per_cabinet_points.get(cab_idx, 0) + 1

    if not observations:
        write_event(ErrorEvent(
            event="error", code="detection_failed",
            message="no ChArUco corners detected across any view",
            fatal=True,
        ))
        return 1

    # --- 5b. Stage A pre-clean: per-(cam,cab) PnP-RANSAC inlier filter ---
    (observations, per_view_cab_corners, per_cabinet_views, per_cabinet_points,
     n_rej_stage_a, rej_per_cab_stage_a) = stage_a_prune(observations, per_view_cab_corners, K)

    # --- 6. observability ---
    try:
        check_observability(observations, n_cabinets, min_views=2, min_points=8)
    except ObservabilityError as e:
        write_event(ErrorEvent(event="error", code="observability_failed", message=str(e), fatal=True))
        return 1

    # --- 7. nominal model (kept here: needs project) ---
    try:
        nominal_poses = nominal_cabinet_poses_model_frame(
            project.cabinet_array, project.shape_prior)
    except ValueError as e:
        write_event(ErrorEvent(event="error", code="invalid_input", message=str(e), fatal=True))
        return 1

    return solve_and_emit(
        K=K, observations=observations, per_view_cab_corners=per_view_cab_corners,
        n_cameras=len(view_images), cab_to_idx=cab_to_idx, root_idx=root_idx,
        n_cabinets=n_cabinets, nominal_poses=nominal_poses,
        per_cabinet_views=per_cabinet_views, per_cabinet_points=per_cabinet_points,
        corners_local_provider=lambda cid: _active_surface_corners_mm(screen_mapping, cid),
        pose_report_path=cmd.pose_report_path,
        n_rejected_pre=n_rej_stage_a, rejected_per_cab_pre=rej_per_cab_stage_a,
        gauge_strategy="fix_root_cabinet",  # charuco unchanged; output stays in BA-local frame
        ignored_photos=ignored_photos, photos_used=photos_used, photos_total=photos_total,
    )


def _validated_image_size(view_images) -> tuple[int, int] | None:
    """(width, height) validated across ALL views (one frame per view sampled).
    Raises IntrinsicsRefused if views disagree on frame size — mixed resolution /
    landscape-portrait mix corrupts the principal-point origin and coverage
    normalisation silently (FIX-20, mirrors SL path sl_reconstruct.py:89-91)."""
    sizes: set[tuple[int, int]] = set()
    for imgs in view_images:
        for p in imgs:
            img = cv2.imread(p, cv2.IMREAD_GRAYSCALE)
            if img is not None:
                sizes.add((int(img.shape[1]), int(img.shape[0])))
                break  # one readable frame per view is enough
    if not sizes:
        return None
    if len(sizes) != 1:
        raise IntrinsicsRefused(
            "invalid_input",
            f"capture views disagree on frame size: {sorted(sizes)}; "
            "all views must use the same camera resolution and orientation")
    return sizes.pop()


def _board_homography_inliers(objp: list, imgp: list, thresh_px: float = 3.0):
    """RANSAC-clean one planar board before Zhang self-cal.

    A CRC-valid ghost detection (glossy-screen reflection / decode fluke) can
    land hundreds of px from its true grid position while every neighbour is
    sub-pixel; cv2.calibrateCamera has no robust loss, so a single ghost wrecks
    the whole solve (real case: one duplicated marker id → board RMS 90px →
    intrinsics gate refusal). A planar board must fit a homography, so drop
    outliers against the RANSAC consensus. Boards below 8 points pass through
    (calibration already requires >=8); a board whose consensus collapses is
    dropped entirely.
    """
    if len(objp) < 8:
        return objp, imgp
    obj = np.asarray([[p[0], p[1]] for p in objp], dtype=np.float32)
    img = np.asarray(imgp, dtype=np.float32)
    H, mask = cv2.findHomography(obj, img, cv2.RANSAC, thresh_px)
    if H is None or mask is None:
        return [], []
    keep = mask.ravel().astype(bool)
    if int(keep.sum()) < 8:
        return [], []
    return ([o for o, k in zip(objp, keep) if k],
            [i for i, k in zip(imgp, keep) if k])


def _emit_intrinsics_observability_warning(res, groups):
    """Warn (never refuse) when a self-cal solve is weakly observable PER BOARD:
    too little same-board view-axis tilt (focal/depth coupling) or too small a
    same-board standoff spread. Grouping by board isolates the fixed inter-screen
    fold, which reads as huge global diversity but adds no per-board tilt."""
    if not groups or len(res.rvecs) != len(groups):
        return  # no grouping supplied, or poses/groups fell out of sync -> skip
    view_axis = _grouped_view_axis_deg(res.rvecs, groups)
    standoff = _grouped_standoff_ratio(res.tvecs, groups)
    weak = []
    if view_axis < POSE_ROT_DIVERSITY_STRICT_DEG:
        weak.append(f"same-board view-axis span {view_axis:.1f}° < {POSE_ROT_DIVERSITY_STRICT_DEG:.0f}°")
    if standoff is not None and standoff < STANDOFF_RATIO_MIN:
        weak.append(f"same-board standoff ratio {standoff:.2f} < {STANDOFF_RATIO_MIN:.2f}")
    if weak:
        write_event(WarningEvent(
            event="warning", code="intrinsics_weak_observability",
            message=(
                "self-cal intrinsics are weakly observable (" + "; ".join(weak) + "). "
                "Focal length and standoff/depth are coupled under this capture, so a "
                "sub-percent focal error can fold into mm-level geometry. Remediation: "
                "shoot each screen from >=1.5× distance spread, add >=15° same-board "
                "pitch/yaw tilt, fill a single screen up close, or pass a master lens "
                "via --intrinsics-crosscheck to anchor the focal length.")))


def _load_crosscheck_anchor(path, image_size):
    """Load the --intrinsics-crosscheck anchor (mesh `K` or vpcal-flat fx/fy/cx/cy)
    or None when no path is given. A MALFORMED anchor -> IntrinsicsRefused(invalid_input)
    (unchanged semantics). An anchor whose image_size disagrees with the capture
    frame is IGNORED with a warning (a pixel-domain focal/distortion crosscheck is
    not comparable across resolutions) and None is returned, so the caller falls
    back to the no-anchor path — reconstruction is never blocked on this."""
    if not path:
        return None
    try:
        anchor = load_intrinsics_file(path)
    except (OSError, json.JSONDecodeError, ValueError) as e:
        raise IntrinsicsRefused("invalid_input", f"crosscheck intrinsics load failed: {e}")
    if anchor.image_size is not None and tuple(anchor.image_size) != tuple(image_size):
        write_event(WarningEvent(
            event="warning", code="intrinsics_anchor_size_mismatch",
            message=(f"crosscheck anchor image_size {tuple(anchor.image_size)} != capture frame "
                     f"{tuple(image_size)}; ignoring the anchor (a pixel-domain focal/distortion "
                     f"crosscheck is not comparable across resolutions)")))
        return None
    return anchor


def _solve_intrinsics_robust(object_points, image_points, image_size, *,
                             has_anchor: bool, pp_gate: float, pose_group_ids=None):
    """solve_sl_intrinsics + one robust board-trim pass.

    A motion-distorted (rolling-shutter-sheared) frame passes the per-board
    homography clean — the shear IS its consensus — yet cannot be explained by
    any rigid pose under the shared K, so it skews fx/fy/pp while the overall
    rms stays under the 1.5px gate. Score each board by solvePnP reprojection
    under the solved K; boards > max(3×median, 1.0px) are re-solved away (kept
    only if the retry does not worsen rms or trip a gate).

    ``pose_group_ids`` (parallel to object_points; group = board/cabinet) drives
    the per-board weak-observability WARNING (never a refusal) on the returned
    solve — filtered to the surviving poses when boards are trimmed.
    """
    def _solve(objs, imgs):
        return solve_sl_intrinsics(objs, imgs, image_size,
                                   max_rms_px=1.5, allow_full_distortion=has_anchor,
                                   max_pp_std_px=pp_gate, try_zero_distortion=True)

    res = _solve(object_points, image_points)
    errs = []
    for obj, img in zip(object_points, image_points):
        ok, rvec, tvec = cv2.solvePnP(obj, img, res.K, res.dist)
        if not ok:
            errs.append(float("inf"))
            continue
        proj, _ = cv2.projectPoints(obj, rvec, tvec, res.K, res.dist)
        errs.append(float(np.sqrt(np.mean(
            np.sum((proj.reshape(-1, 2) - img) ** 2, axis=1)))))
    med = float(np.median(errs))
    thr = max(3.0 * med, 1.0)
    bad = [i for i, e in enumerate(errs) if e > thr]
    if not bad or len(object_points) - len(bad) < 3:
        _emit_intrinsics_observability_warning(res, pose_group_ids)
        return res
    badset = set(bad)
    objs2 = [o for i, o in enumerate(object_points) if i not in badset]
    imgs2 = [m for i, m in enumerate(image_points) if i not in badset]
    groups2 = (None if pose_group_ids is None
               else [g for i, g in enumerate(pose_group_ids) if i not in badset])
    try:
        res2 = _solve(objs2, imgs2)
    except IntrinsicsRefused:
        _emit_intrinsics_observability_warning(res, pose_group_ids)
        return res
    if res2.rms <= res.rms:
        write_event(WarningEvent(
            event="warning", code="intrinsics_board_rejected",
            message=(f"self-cal dropped {len(bad)} inconsistent board(s) "
                     f"(> {thr:.2f}px under shared K); rms "
                     f"{res.rms:.2f}px → {res2.rms:.2f}px")))
        _emit_intrinsics_observability_warning(res2, groups2)
        return res2
    _emit_intrinsics_observability_warning(res, pose_group_ids)
    return res


def _self_calibrate_vpqsp(meta, detections, view_images, image_size, cmd):
    """Inline self-cal for VP-QSP `--intrinsics auto`. Each captured view is a
    photo of the KNOWN VP-QSP marker wall — a planar (flat) or per-cabinet-tilted
    (curved) calibration target whose metric geometry comes from the displayed
    pixel pitch. Assemble per-view (nominal world 3D, image px) from the SAME
    detections the reconstruction uses (frame-matched), then solve K + distortion
    via the shared Zhang solver (cv2.calibrateCamera).

    Unlike the SL path (sl_reconstruct._self_calibrate_inline), a FLAT wall WITHOUT
    an anchor is ADMITTED here, not refused: the provided pixel pitch IS the metric
    scale that fixes the focal/scale ambiguity, so a known flat target + angularly
    diverse shots is a well-posed Zhang problem. solve_sl_intrinsics's own
    conditioning gates (>=5deg rotation diversity, >=20% coverage, focal/principal-
    point stddev caps) still refuse an ill-posed capture (e.g. all shots fronto-
    parallel) with a clear message. The unguarded residual — anisotropic screen
    pitch / a non-1:1-driven wall corrupting fx/fy aspect — is surfaced as a
    no_intrinsics_anchor warning; pass --intrinsics-crosscheck to validate it.

    Returns (K, dist) or raises IntrinsicsRefused (code maps to the error event).
    """
    from lmt_vba_sidecar.vpqsp_layout import marker_local_mm

    grid_by_cr = {
        (c.col, c.row): (c.markers_x, c.markers_y, c.marker_px,
                         (c.resolution_px[0], c.resolution_px[1]),
                         (c.pixel_pitch_mm[0], c.pixel_pitch_mm[1]))
        for c in meta.cabinets
    }

    # One calibrateCamera "pose" per (VIEW, CABINET). Each cabinet is a genuine
    # flat plane; grouping by cabinet avoids assuming cabinets are coplanar (they
    # aren't for a desktop dual-monitor test setup, and may tilt on curved walls).
    # Use LOCAL mm coords (z=0, center-origin) — world coords would bake in the
    # flat-wall layout assumption, which is irrelevant for intrinsics.
    object_points, image_points, pose_groups = [], [], []
    for imgs in view_images:
        per_cab: dict[tuple[int, int], tuple[list, list]] = {}
        for path in imgs:
            for det in detections.get(path, []):
                cab_cr = (int(det["cabinet"][0]), int(det["cabinet"][1]))
                if cab_cr not in grid_by_cr:
                    continue
                mx, my, mpx, res_px, pitch = grid_by_cr[cab_cr]
                p_local = marker_local_mm(
                    int(det["local_id"]), markers_x=mx, markers_y=my, marker_px=mpx,
                    resolution_px=res_px, pixel_pitch_mm=pitch)
                per_cab.setdefault(cab_cr, ([], []))
                per_cab[cab_cr][0].append(p_local)
                per_cab[cab_cr][1].append([det["corner_px"][0], det["corner_px"][1]])
        for cab_key, (objp, imgp) in per_cab.items():
            objp, imgp = _board_homography_inliers(objp, imgp)
            # FIX-21: require ≥8 points per pose (4 is barely determined for
            # a planar target's 6 DOF — 8 gives 16 constraints, much stabler).
            if len(objp) >= 8:
                object_points.append(np.asarray(objp, dtype=np.float32))
                image_points.append(np.asarray(imgp, dtype=np.float32))
                pose_groups.append(cab_key)

    # FIX-21: cap pose count to avoid minute-level calibrateCamera on large walls.
    MAX_CAL_POSES = 200
    if len(object_points) > MAX_CAL_POSES:
        rng = np.random.default_rng(0)
        idx = rng.choice(len(object_points), MAX_CAL_POSES, replace=False)
        idx.sort()
        object_points = [object_points[i] for i in idx]
        image_points = [image_points[i] for i in idx]
        pose_groups = [pose_groups[i] for i in idx]

    # Load + validate the master-lens anchor BEFORE solving: has_anchor gates
    # allow_full_distortion, so a broken/mismatched anchor must be resolved first.
    anchor = _load_crosscheck_anchor(cmd.crosscheck_intrinsics_path, image_size)
    has_anchor = anchor is not None
    # Per-cabinet poses have fewer points than full-view poses, so pp uncertainty
    # is slightly higher. Scale the pp gate by image size (default 3px @ 4000px).
    pp_gate = max(5.0, 3.0 * max(image_size) / 4000)
    res = _solve_intrinsics_robust(object_points, image_points, image_size,
                                   has_anchor=has_anchor, pp_gate=pp_gate,
                                   pose_group_ids=pose_groups)
    if has_anchor:
        refusal = crosscheck_intrinsics(res, anchor_K=anchor.K, anchor_dist=anchor.dist)
        if refusal is not None:
            raise refusal
    else:
        # No anchor: trust the displayed screen geometry as the metric target (the
        # flat-wall conditioning is already guarded by solve_sl_intrinsics). Warn
        # that anisotropic pitch / non-1:1 drive is unvalidated.
        write_event(WarningEvent(event="warning", code="no_intrinsics_anchor",
            message="VP-QSP auto intrinsics solved from the displayed marker wall without an "
                    "independent anchor; assumes the screen is driven pixel-exact (1:1). "
                    "Anisotropic pitch / non-1:1 scaling is unguarded — pass "
                    "--intrinsics-crosscheck <anchor.json> to validate."))
    return res.K, res.dist


def run_reconstruct_vpqsp(cmd: ReconstructInput, manifest) -> int:
    """VP-QSP reconstruct front-end: self-encoding marker detect → Observation →
    shared solve_and_emit. Mirrors run_reconstruct (charuco) but the marker
    decode yields (screen_id, col, row, local_id) directly — no ArUco routing
    table — and p_local comes from the VP-QSP marker grid (vpqsp pattern_meta),
    +y-up center-origin mm. Intrinsics come from a file OR `--intrinsics auto`
    self-calibration (the captured markers are themselves the calibration target);
    everything from observability onward is shared.
    """
    if _is_joint_vpqsp_mode(cmd, manifest):
        return run_reconstruct_vpqsp_joint(cmd, manifest)

    from lmt_vba_sidecar.vpqsp_detect import detect_vpqsp_markers
    from lmt_vba_sidecar.vpqsp_layout import marker_local_mm

    # --- 2. referenced files (screen_mapping reused for active-surface corners).
    #         Intrinsics are resolved AFTER detection (step 3c) so `--intrinsics
    #         auto` can self-calibrate from the same detected markers. ---
    sm_path = cmd.screen_mapping_path or manifest.screen_mapping
    try:
        screen_mapping = ScreenMapping.model_validate(
            json.loads(pathlib.Path(sm_path).read_text(encoding="utf-8"))
        )
        meta = VpqspPatternMeta.model_validate(
            json.loads(pathlib.Path(manifest.pattern_meta).read_text(encoding="utf-8"))
        )
    except (OSError, json.JSONDecodeError, KeyError, ValueError) as e:
        write_event(ErrorEvent(event="error", code="invalid_input",
            message=f"failed to load manifest references: {e}", fatal=True))
        return 1

    # --- 3. preflight (pattern hash + rotation/mirror + active_size scale) ---
    fatal = _vpqsp_preflight_screen_mapping(screen_mapping, meta)
    if fatal is not None:
        return fatal

    # Per-cabinet VP-QSP grid: (col,row) -> (markers_x, markers_y, resolution_px, pitch).
    # The displayed pattern is the single source of truth for marker positions.
    grid_by_cr = {
        (c.col, c.row): (c.markers_x, c.markers_y, c.marker_px,
                         (c.resolution_px[0], c.resolution_px[1]),
                         (c.pixel_pitch_mm[0], c.pixel_pitch_mm[1]))
        for c in meta.cabinets
    }

    # --- 4. deterministic cabinet index map ---
    present = sorted(((c.col, c.row) for c in meta.cabinets), key=lambda cr: (cr[1], cr[0]))
    if ROOT_CABINET not in present:
        write_event(ErrorEvent(event="error", code="invalid_input",
            message=f"root cabinet {_cabinet_id(*ROOT_CABINET)} (0,0) not present in pattern_meta",
            fatal=True))
        return 1
    cab_to_idx: dict[tuple[int, int], int] = {cr: i for i, cr in enumerate(present)}
    root_idx = cab_to_idx[ROOT_CABINET]
    n_cabinets = len(present)

    # --- 5. detect + build observations ---
    write_event(ProgressEvent(event="progress", stage="detect_vpqsp", percent=0.2,
                              message="detecting VP-QSP markers"))
    view_images: list[list[str]] = [list(v.images) for v in manifest.views]
    all_paths = [p for imgs in view_images for p in imgs]
    detections = detect_vpqsp_markers(all_paths, screen_id_code=meta.screen_id_code)
    ignored_photos, photos_used, photos_total = _photo_ignore_stats(all_paths, detections)
    if ignored_photos:
        write_event(WarningEvent(
            event="warning", code="dead_weight_image",
            message=(f"{len(ignored_photos)} image(s) have no markers "
                     f"(e.g. {', '.join(ignored_photos[:3])}"
                     f"{', …' if len(ignored_photos) > 3 else ''})")))

    # --- 3c. resolve intrinsics: CLI override (cmd.intrinsics_path) > manifest
    #         reference. The reserved value "auto" self-calibrates K + distortion
    #         from the SAME detected markers (frame-matched); else load a file. ---
    intrinsics_spec = cmd.intrinsics_path or manifest.intrinsics
    if intrinsics_spec is None:
        write_event(ErrorEvent(event="error", code="invalid_input",
            message="no intrinsics: set the capture manifest's `intrinsics` field, or pass "
                    "--intrinsics <path|auto>", fatal=True))
        return 1
    if intrinsics_spec == "auto":
        try:
            image_size = _validated_image_size(view_images)
        except IntrinsicsRefused as e:
            write_event(ErrorEvent(event="error", code=e.code, message=e.message, fatal=True))
            return 1
        if image_size is None:
            write_event(ErrorEvent(event="error", code="invalid_input",
                message="--intrinsics auto: cannot read any capture image to determine frame size",
                fatal=True))
            return 1
        try:
            K, dist = _self_calibrate_vpqsp(meta, detections, view_images, image_size, cmd)
            intrinsics_source = "auto_self_calibrated"
        except IntrinsicsRefused as e:
            write_event(ErrorEvent(event="error", code=e.code, message=e.message, fatal=True))
            return 1
    else:
        try:
            loaded = load_intrinsics_file(intrinsics_spec)
            K = loaded.K
            dist = loaded.dist
            intrinsics_source = "file"
        except (OSError, json.JSONDecodeError, KeyError, ValueError) as e:
            write_event(ErrorEvent(event="error", code="intrinsics_invalid",
                message=f"intrinsics load failed: {e}", fatal=True))
            return 1

    observations: list[Observation] = []
    per_view_cab_corners: dict[tuple[int, int], list[tuple[np.ndarray, np.ndarray]]] = {}
    per_cabinet_views: dict[int, set[int]] = {}
    per_cabinet_points: dict[int, int] = {}
    for cam_idx, imgs in enumerate(view_images):
        for path in imgs:
            for det in detections.get(path, []):
                cab_cr = tuple(det["cabinet"])
                if cab_cr not in cab_to_idx or cab_cr not in grid_by_cr:
                    continue
                cab_idx = cab_to_idx[cab_cr]
                mx, my, mpx, res_px, pitch = grid_by_cr[cab_cr]
                p_local = marker_local_mm(
                    int(det["local_id"]), markers_x=mx, markers_y=my, marker_px=mpx,
                    resolution_px=res_px, pixel_pitch_mm=pitch,
                )
                pixel = _undistort_obs(np.array(det["corner_px"], dtype=float), K, dist)
                sigma = float(det.get("sigma_px", 1.0))
                observations.append(Observation(
                    camera_idx=cam_idx, cabinet_idx=cab_idx, p_local=p_local, pixel=pixel,
                    sigma_px=sigma))
                per_view_cab_corners.setdefault((cam_idx, cab_idx), []).append((p_local, pixel))
                per_cabinet_views.setdefault(cab_idx, set()).add(cam_idx)
                per_cabinet_points[cab_idx] = per_cabinet_points.get(cab_idx, 0) + 1

    if not observations:
        write_event(ErrorEvent(event="error", code="detection_failed",
            message="no VP-QSP markers detected across any view", fatal=True))
        return 1

    # --- 5b. Stage A pre-clean (shared) ---
    (observations, per_view_cab_corners, per_cabinet_views, per_cabinet_points,
     n_rej_stage_a, rej_per_cab_stage_a) = stage_a_prune(observations, per_view_cab_corners, K)

    # --- 6. observability (shared) ---
    try:
        check_observability(observations, n_cabinets, min_views=2, min_points=8)
    except ObservabilityError as e:
        write_event(ErrorEvent(event="error", code="observability_failed", message=str(e), fatal=True))
        return 1

    # --- 7. nominal model (shared) ---
    project = _effective_project(cmd)
    if project is None:
        write_event(ErrorEvent(
            event="error", code="invalid_input",
            message="project or screens is required", fatal=True))
        return 1
    try:
        nominal_poses = nominal_cabinet_poses_model_frame(
            project.cabinet_array, project.shape_prior)
    except ValueError as e:
        write_event(ErrorEvent(event="error", code="invalid_input", message=str(e), fatal=True))
        return 1

    return solve_and_emit(
        K=K, observations=observations, per_view_cab_corners=per_view_cab_corners,
        n_cameras=len(view_images), cab_to_idx=cab_to_idx, root_idx=root_idx,
        n_cabinets=n_cabinets, nominal_poses=nominal_poses,
        per_cabinet_views=per_cabinet_views, per_cabinet_points=per_cabinet_points,
        corners_local_provider=lambda cid: _active_surface_corners_mm(screen_mapping, cid),
        pose_report_path=cmd.pose_report_path,
        n_rejected_pre=n_rej_stage_a, rejected_per_cab_pre=rej_per_cab_stage_a,
        gauge_strategy="fix_root_cabinet",  # fast-mode marker, same gauge as charuco
        intrinsics_source=intrinsics_source,
        ignored_photos=ignored_photos, photos_used=photos_used, photos_total=photos_total,
    )


def _vpqsp_preflight_screen_mapping(screen_mapping: ScreenMapping, meta: VpqspPatternMeta) -> int | None:
    """Cross-source VP-QSP preflight. Returns an exit code on fatal error, else None.

    Charuco gets rotation/mirror + scale guards via screen_mapping.charuco_corner_local_mm;
    VP-QSP sources p_local scale from pattern_meta but pose-report corners from
    active_size_mm — re-assert both here (plus pattern_hash binding).
    """
    if screen_mapping.expected_pattern_hash is None:
        write_event(WarningEvent(
            event="warning", code="pattern_hash_unset",
            message="screen_mapping.expected_pattern_hash is not set; skipping the "
                    "capture↔pattern binding check. Set it to the generated pattern's "
                    "hash to verify the captured pattern matches this config."))
    try:
        screen_mapping.preflight(pattern_hash(meta))
    except ScreenMappingError as e:
        write_event(ErrorEvent(event="error", code="invalid_input", message=str(e), fatal=True))
        return 1

    sm_by_id = {c.cabinet_id: c for c in screen_mapping.cabinets}
    for c in meta.cabinets:
        cid = _cabinet_id(c.col, c.row)
        sm_cab = sm_by_id.get(cid)
        if sm_cab is None:
            continue
        if sm_cab.rotation != 0 or sm_cab.mirror_x or sm_cab.mirror_y:
            write_event(ErrorEvent(event="error", code="invalid_input",
                message=(f"cabinet '{cid}' has rotation={sm_cab.rotation}, "
                         f"mirror_x={sm_cab.mirror_x}, mirror_y={sm_cab.mirror_y}; "
                         "rotation/mirror not yet supported in VP-QSP local-mm mapping "
                         "(fail loud, not silent)"), fatal=True))
            return 1
        for axis, name in ((0, "width"), (1, "height")):
            implied = c.resolution_px[axis] * c.pixel_pitch_mm[axis]
            active = sm_cab.active_size_mm[axis]
            if abs(implied - active) > 0.01 * active:
                write_event(ErrorEvent(event="error", code="invalid_input",
                    message=(f"cabinet '{cid}' {name} scale mismatch: vpqsp pattern_meta "
                             f"resolution_px {c.resolution_px[axis]} x pixel_pitch_mm "
                             f"{c.pixel_pitch_mm[axis]} = {implied:.3f}mm, but screen_mapping "
                             f"active_size_mm = {active}mm (>1% apart). These set the BA scale "
                             "and the pose-report corner scale respectively and must agree."),
                    fatal=True))
                return 1
    return None


def _joint_nominal_poses_idx(
    per_screen_nominal: list[dict[tuple[int, int], tuple[np.ndarray, np.ndarray]]],
    cab_idx_to_screen: dict[int, int],
    cab_idx_to_cr: dict[int, tuple[int, int]],
) -> dict[int, tuple[np.ndarray, np.ndarray]]:
    """Nominal SE(3) per global cabinet idx for init / disambiguation.

    Screen-0 cabinets use model-frame nominal directly (joint frame = screen-0
    root). Other screens use pose relative to that screen's root — sufficient
    for normal-based IPPE disambiguation (translation only used on fallback).
    """
    out: dict[int, tuple[np.ndarray, np.ndarray]] = {}
    for idx, cr in cab_idx_to_cr.items():
        si = cab_idx_to_screen[idx]
        nom = per_screen_nominal[si]
        if si == 0:
            if cr in nom:
                out[idx] = nom[cr]
        elif cr in nom:
            out[idx] = _nominal_init_root_frame(nom, ROOT_CABINET, cr)
    return out


def _joint_init_cabinet_pose(
    idx: int,
    cr: tuple[int, int],
    si: int,
    *,
    gauge_idx: int,
    screen_root_indices: dict[int, int],
    init_cabinets: dict[int, tuple[np.ndarray, np.ndarray]],
    bridge: dict[int, tuple[np.ndarray, np.ndarray]],
    per_screen_nominal: list[dict[tuple[int, int], tuple[np.ndarray, np.ndarray]]],
    idx_to_cr: dict[int, tuple[int, int]],
) -> tuple[np.ndarray, np.ndarray]:
    if idx == gauge_idx:
        return np.eye(3), np.zeros(3)
    if idx in bridge:
        return bridge[idx]
    nom = per_screen_nominal[si]
    if cr not in nom:
        return np.eye(3), np.zeros(3)
    if si == 0:
        gauge_cr = idx_to_cr[gauge_idx]
        return _nominal_init_root_frame(nom, gauge_cr, cr)
    R_loc, t_loc = _nominal_init_root_frame(nom, ROOT_CABINET, cr)
    R_sr, t_sr = init_cabinets.get(screen_root_indices[si], (np.eye(3), np.zeros(3)))
    return R_sr @ R_loc, R_sr @ t_loc + t_sr


def run_reconstruct_vpqsp_joint(cmd: ReconstructInput, manifest) -> int:
    """Joint multi-screen VP-QSP reconstruct: shared cameras + K, screen-0 root gauge."""
    from lmt_vba_sidecar.vpqsp_detect import detect_vpqsp_markers
    from lmt_vba_sidecar.vpqsp_layout import marker_local_mm

    try:
        screen_projects = _resolve_joint_screen_projects(cmd, manifest)
    except ValueError as e:
        write_event(ErrorEvent(event="error", code="invalid_input", message=str(e), fatal=True))
        return 1

    if not cmd.screen_transforms_path:
        write_event(ErrorEvent(
            event="error", code="invalid_input",
            message="screen_transforms_path is required for joint multi-screen reconstruct",
            fatal=True))
        return 1

    n_screens = len(screen_projects)
    code_to_screen: dict[int, int] = {
        sp.screen_id_code: si for si, sp in enumerate(screen_projects)
    }
    target_codes = set(code_to_screen)

    screen_metas: list[VpqspPatternMeta] = []
    screen_mappings: list[ScreenMapping] = []
    grid_by_screen: list[dict[tuple[int, int], tuple]] = []
    per_screen_nominal: list[dict[tuple[int, int], tuple[np.ndarray, np.ndarray]]] = []

    for si, sp in enumerate(screen_projects):
        sm_path = sp.screen_mapping_path or cmd.screen_mapping_path
        pm_path = sp.pattern_meta_path
        if not sm_path or not pm_path:
            write_event(ErrorEvent(
                event="error", code="invalid_input",
                message=f"screen '{sp.screen_id}' missing pattern_meta_path or screen_mapping_path",
                fatal=True))
            return 1
        try:
            screen_mapping = ScreenMapping.model_validate(
                json.loads(pathlib.Path(sm_path).read_text(encoding="utf-8")))
            meta = VpqspPatternMeta.model_validate(
                json.loads(pathlib.Path(pm_path).read_text(encoding="utf-8")))
            nominal_poses = nominal_cabinet_poses_model_frame(
                sp.cabinet_array, sp.shape_prior)
        except (OSError, json.JSONDecodeError, KeyError, ValueError, ScreenMappingError) as e:
            write_event(ErrorEvent(event="error", code="invalid_input",
                message=f"failed to load screen '{sp.screen_id}': {e}", fatal=True))
            return 1

        fatal = _vpqsp_preflight_screen_mapping(screen_mapping, meta)
        if fatal is not None:
            return fatal

        screen_metas.append(meta)
        screen_mappings.append(screen_mapping)
        per_screen_nominal.append(nominal_poses)
        grid_by_screen.append({
            (c.col, c.row): (c.markers_x, c.markers_y, c.marker_px,
                             (c.resolution_px[0], c.resolution_px[1]),
                             (c.pixel_pitch_mm[0], c.pixel_pitch_mm[1]))
            for c in meta.cabinets
        })

    # Global cabinet index: (screen_idx, col, row) -> idx; screen-0 (0,0) is gauge.
    cab_to_idx: dict[tuple[int, int, int], int] = {}
    cab_idx_to_screen: dict[int, int] = {}
    cab_idx_to_cr: dict[int, tuple[int, int]] = {}
    screen_root_indices: dict[int, int] = {}
    idx = 0
    for si in range(n_screens):
        present = sorted(
            ((c.col, c.row) for c in screen_metas[si].cabinets),
            key=lambda cr: (cr[1], cr[0]),
        )
        if ROOT_CABINET not in present:
            write_event(ErrorEvent(
                event="error", code="invalid_input",
                message=(f"root cabinet {_cabinet_id(*ROOT_CABINET)} not present on "
                         f"screen '{screen_projects[si].screen_id}'"),
                fatal=True))
            return 1
        for cr in present:
            cab_to_idx[(si, cr[0], cr[1])] = idx
            cab_idx_to_screen[idx] = si
            cab_idx_to_cr[idx] = cr
            if cr == ROOT_CABINET:
                screen_root_indices[si] = idx
            idx += 1
    root_idx = cab_to_idx[(0, ROOT_CABINET[0], ROOT_CABINET[1])]
    n_cabinets = idx

    write_event(ProgressEvent(event="progress", stage="detect_vpqsp", percent=0.2,
                              message="detecting VP-QSP markers (joint multi-screen)"))
    view_images: list[list[str]] = [list(v.images) for v in manifest.views]
    all_paths = [p for imgs in view_images for p in imgs]
    detections = detect_vpqsp_markers(all_paths, screen_id_code=None)

    # Dead-weight views + unknown screen_id codes.
    paths_with_target = set()
    n_unknown_code = 0
    for path, dets in detections.items():
        for det in dets:
            sid_code = int(det.get("screen_id", -1))
            if sid_code in target_codes:
                paths_with_target.add(path)
            else:
                n_unknown_code += 1
    if n_unknown_code:
        write_event(WarningEvent(
            event="warning", code="unknown_screen_id",
            message=(f"discarded {n_unknown_code} marker(s) with screen_id not in the "
                     f"target set {sorted(target_codes)}")))
    dead_paths = [path for path in all_paths if path not in paths_with_target]
    ignored_photos = [pathlib.Path(p).name for p in dead_paths]
    photos_total = len(all_paths)
    photos_used = photos_total - len(ignored_photos)
    if dead_paths:
        sample = dead_paths[:3]
        sample_txt = ", ".join(sample)
        more = len(dead_paths) - len(sample)
        if more > 0:
            sample_txt += f", … (+{more} more)"
        write_event(WarningEvent(
            event="warning", code="dead_weight_image",
            message=(f"{len(dead_paths)} image(s) have no markers for any target screen "
                     f"(e.g. {sample_txt})")))

    # Two-round runner: round 1 on all views; if the solve is refused by the
    # rms gate with Stage C having identified rigidly-inconsistent views, redo
    # EVERYTHING (self-cal K included — its boards are polluted too) without
    # those views. Mirrors the manually-verified trim (11 views 2.21px fatal →
    # 9 views 0.31px); re-init alone stays in the polluted-K 2px regime.
    excluded_views: set[int] = set()
    code = 1
    for solve_round in (1, 2):
        round_view_images = [imgs for i, imgs in enumerate(view_images)
                             if i not in excluded_views]
        gate_retry: dict | None = {} if solve_round == 1 else None
        intrinsics_spec = cmd.intrinsics_path or manifest.intrinsics
        if intrinsics_spec is None:
            write_event(ErrorEvent(event="error", code="invalid_input",
                message="no intrinsics: set the capture manifest's `intrinsics` field, or pass "
                        "--intrinsics <path|auto>", fatal=True))
            return 1

        # Self-cal uses all screens' marker geometry.
        if intrinsics_spec == "auto":
            try:
                image_size = _validated_image_size(round_view_images)
            except IntrinsicsRefused as e:
                write_event(ErrorEvent(event="error", code=e.code, message=e.message, fatal=True))
                return 1
            if image_size is None:
                write_event(ErrorEvent(event="error", code="invalid_input",
                    message="--intrinsics auto: cannot read any capture image to determine frame size",
                    fatal=True))
                return 1
            try:
                # Use first screen meta for self-cal grid lookup; detections carry screen_id.
                K, dist = _self_calibrate_vpqsp_joint(
                    screen_metas, grid_by_screen, code_to_screen, detections,
                    round_view_images, image_size, cmd)
                intrinsics_source = "auto_self_calibrated"
            except IntrinsicsRefused as e:
                write_event(ErrorEvent(event="error", code=e.code, message=e.message, fatal=True))
                return 1
        else:
            try:
                loaded = load_intrinsics_file(intrinsics_spec)
                K = loaded.K
                dist = loaded.dist
                intrinsics_source = "file"
            except (OSError, json.JSONDecodeError, KeyError, ValueError) as e:
                write_event(ErrorEvent(event="error", code="intrinsics_invalid",
                    message=f"intrinsics load failed: {e}", fatal=True))
                return 1

        observations: list[Observation] = []
        per_view_cab_corners: dict[tuple[int, int], list[tuple[np.ndarray, np.ndarray]]] = {}
        per_cabinet_views: dict[int, set[int]] = {}
        per_cabinet_points: dict[int, int] = {}
        for cam_idx, imgs in enumerate(round_view_images):
            for path in imgs:
                for det in detections.get(path, []):
                    sid_code = int(det.get("screen_id", -1))
                    if sid_code not in code_to_screen:
                        continue
                    si = code_to_screen[sid_code]
                    cab_cr = tuple(det["cabinet"])
                    key = (si, cab_cr[0], cab_cr[1])
                    if key not in cab_to_idx or cab_cr not in grid_by_screen[si]:
                        continue
                    cab_idx = cab_to_idx[key]
                    mx, my, mpx, res_px, pitch = grid_by_screen[si][cab_cr]
                    p_local = marker_local_mm(
                        int(det["local_id"]), markers_x=mx, markers_y=my, marker_px=mpx,
                        resolution_px=res_px, pixel_pitch_mm=pitch,
                    )
                    pixel = _undistort_obs(np.array(det["corner_px"], dtype=float), K, dist)
                    sigma = float(det.get("sigma_px", 1.0))
                    observations.append(Observation(
                        camera_idx=cam_idx, cabinet_idx=cab_idx, p_local=p_local, pixel=pixel,
                        sigma_px=sigma))
                    per_view_cab_corners.setdefault((cam_idx, cab_idx), []).append((p_local, pixel))
                    per_cabinet_views.setdefault(cab_idx, set()).add(cam_idx)
                    per_cabinet_points[cab_idx] = per_cabinet_points.get(cab_idx, 0) + 1

        if not observations:
            write_event(ErrorEvent(event="error", code="detection_failed",
                message="no VP-QSP markers detected for any target screen", fatal=True))
            return 1

        (observations, per_view_cab_corners, per_cabinet_views, per_cabinet_points,
         n_rej_stage_a, rej_per_cab_stage_a) = stage_a_prune(observations, per_view_cab_corners, K)

        try:
            check_observability(observations, n_cabinets, min_views=2, min_points=8,
                                check_connectivity=False)
        except ObservabilityError as e:
            write_event(ErrorEvent(event="error", code="observability_failed", message=str(e), fatal=True))
            return 1

        try:
            conn = check_screen_connectivity(
                observations, cab_idx_to_screen, n_screens,
                screen_labels=[sp.screen_id for sp in screen_projects],
            )
        except ScreenConnectivityError as e:
            write_event(ErrorEvent(event="error", code="screens_disconnected", message=str(e), fatal=True))
            return 1

        per_screen_pose_paths: dict[int, str | None] = {
            si: sp.pose_report_path for si, sp in enumerate(screen_projects)
        }

        corners_providers = {
            si: (lambda cid, sm=screen_mappings[si]: _active_surface_corners_mm(sm, cid))
            for si in range(n_screens)
        }

        code = joint_solve_and_emit(
            K=K,
            observations=observations,
            per_view_cab_corners=per_view_cab_corners,
            n_cameras=len(round_view_images),
            root_idx=root_idx,
            n_cabinets=n_cabinets,
            cab_idx_to_screen=cab_idx_to_screen,
            cab_idx_to_cr=cab_idx_to_cr,
            screen_root_indices=screen_root_indices,
            screen_projects=screen_projects,
            per_screen_nominal=per_screen_nominal,
            corners_local_providers=corners_providers,
            per_screen_pose_paths=per_screen_pose_paths,
            screen_transforms_path=cmd.screen_transforms_path,
            conn_info=conn,
            n_rejected_pre=n_rej_stage_a,
            rejected_per_cab_pre=rej_per_cab_stage_a,
            intrinsics_source=intrinsics_source,
            ignored_photos=ignored_photos,
            photos_used=photos_used,
            photos_total=photos_total,
            gate_retry_out=gate_retry,
        )

        if code == 0 or gate_retry is None or not gate_retry.get("bad_views"):
            return code
        excluded_views = set(gate_retry["bad_views"])
        write_event(WarningEvent(
            event="warning", code="view_excluded_retry",
            message=(f"re-running joint reconstruct without {len(excluded_views)} "
                     f"rejected view(s) (self-cal + solve redo)")))
    return code


def _self_calibrate_vpqsp_joint(
    screen_metas, grid_by_screen, code_to_screen, detections, view_images, image_size, cmd,
):
    """Self-cal for joint VP-QSP: route each detection to its screen's grid."""
    from lmt_vba_sidecar.vpqsp_layout import marker_local_mm

    object_points, image_points, pose_groups = [], [], []
    for imgs in view_images:
        per_cab: dict[tuple[int, int, int], tuple[list, list]] = {}
        for path in imgs:
            for det in detections.get(path, []):
                sid_code = int(det.get("screen_id", -1))
                if sid_code not in code_to_screen:
                    continue
                si = code_to_screen[sid_code]
                cab_cr = (int(det["cabinet"][0]), int(det["cabinet"][1]))
                if cab_cr not in grid_by_screen[si]:
                    continue
                mx, my, mpx, res_px, pitch = grid_by_screen[si][cab_cr]
                p_local = marker_local_mm(
                    int(det["local_id"]), markers_x=mx, markers_y=my, marker_px=mpx,
                    resolution_px=res_px, pixel_pitch_mm=pitch)
                key = (si, cab_cr[0], cab_cr[1])
                per_cab.setdefault(key, ([], []))
                per_cab[key][0].append(p_local)
                per_cab[key][1].append([det["corner_px"][0], det["corner_px"][1]])
        for cab_key, (objp, imgp) in per_cab.items():
            objp, imgp = _board_homography_inliers(objp, imgp)
            if len(objp) >= 8:
                object_points.append(np.asarray(objp, dtype=np.float32))
                image_points.append(np.asarray(imgp, dtype=np.float32))
                pose_groups.append(cab_key)

    MAX_CAL_POSES = 200
    if len(object_points) > MAX_CAL_POSES:
        rng = np.random.default_rng(0)
        idx = rng.choice(len(object_points), MAX_CAL_POSES, replace=False)
        idx.sort()
        object_points = [object_points[i] for i in idx]
        image_points = [image_points[i] for i in idx]
        pose_groups = [pose_groups[i] for i in idx]

    anchor = _load_crosscheck_anchor(cmd.crosscheck_intrinsics_path, image_size)
    has_anchor = anchor is not None
    pp_gate = max(5.0, 3.0 * max(image_size) / 4000)
    res = _solve_intrinsics_robust(object_points, image_points, image_size,
                                   has_anchor=has_anchor, pp_gate=pp_gate,
                                   pose_group_ids=pose_groups)
    if has_anchor:
        refusal = crosscheck_intrinsics(res, anchor_K=anchor.K, anchor_dist=anchor.dist)
        if refusal is not None:
            raise refusal
    else:
        write_event(WarningEvent(event="warning", code="no_intrinsics_anchor",
            message="VP-QSP auto intrinsics solved from the displayed marker wall without an "
                    "independent anchor; assumes the screen is driven pixel-exact (1:1). "
                    "Anisotropic pitch / non-1:1 scaling is unguarded — pass "
                    "--intrinsics-crosscheck <anchor.json> to validate."))
    return res.K, res.dist


def joint_solve_and_emit(
    *,
    K: np.ndarray,
    observations: list[Observation],
    per_view_cab_corners: dict[tuple[int, int], list[tuple[np.ndarray, np.ndarray]]],
    n_cameras: int,
    root_idx: int,
    n_cabinets: int,
    cab_idx_to_screen: dict[int, int],
    cab_idx_to_cr: dict[int, tuple[int, int]],
    screen_root_indices: dict[int, int],
    screen_projects: list[ReconstructProject],
    per_screen_nominal: list[dict[tuple[int, int], tuple[np.ndarray, np.ndarray]]],
    corners_local_providers: dict[int, Callable[[str], np.ndarray]],
    per_screen_pose_paths: dict[int, str | None],
    screen_transforms_path: str,
    conn_info: dict,
    n_rejected_pre: int = 0,
    rejected_per_cab_pre: dict[int, int] | None = None,
    intrinsics_source: str = "file",
    ignored_photos: list[str] | None = None,
    photos_used: int = 0,
    photos_total: int = 0,
    gate_retry_out: dict | None = None,
) -> int:
    """Joint multi-screen BA + per-screen pose reports + screen transforms.

    ``gate_retry_out``: when provided and the solve would be refused by the rms
    gate AFTER Stage C identified rigidly-inconsistent views, report the bad
    view indices there and return 1 WITHOUT emitting the fatal event — the
    runner then redoes everything (self-cal K included; its boards are polluted
    too) without those views, mirroring the verified manual trim.
    """
    write_event(ProgressEvent(event="progress", stage="bundle_adjustment", percent=0.5,
                              message="initializing joint multi-screen solve"))
    gauge_idx = root_idx
    nominal_poses_idx = _joint_nominal_poses_idx(
        per_screen_nominal, cab_idx_to_screen, cab_idx_to_cr)

    def make_inits(pvcc, n_cams):
        bridge, undecidable_cabs = estimate_nonroot_cabinet_init(
            pvcc, gauge_idx, K, nominal_poses=nominal_poses_idx)
        if undecidable_cabs:
            ids = sorted(_cabinet_id(*cab_idx_to_cr[j]) for j in undecidable_cabs)
            write_event(ErrorEvent(
                event="error", code="observability_failed",
                message=(f"convex/concave undecidable for cabinet(s) {ids}: planar-PnP "
                         f"mirror branches equally match nominal and no redundant view "
                         f"breaks the tie; add a camera that sees these cabinets"),
                fatal=True))
            return None

        init_cabinets: dict[int, tuple[np.ndarray, np.ndarray]] = {}
        fallback_ids: list[str] = []
        for idx in range(n_cabinets):
            cr = cab_idx_to_cr[idx]
            si = cab_idx_to_screen[idx]
            if idx == gauge_idx:
                init_cabinets[idx] = (np.eye(3), np.zeros(3))
            elif idx in bridge:
                init_cabinets[idx] = bridge[idx]
            else:
                init_cabinets[idx] = _joint_init_cabinet_pose(
                    idx, cr, si, gauge_idx=gauge_idx,
                    screen_root_indices=screen_root_indices,
                    init_cabinets=init_cabinets, bridge=bridge,
                    per_screen_nominal=per_screen_nominal, idx_to_cr=cab_idx_to_cr)
                fallback_ids.append(_cabinet_id(*cr))
        if fallback_ids:
            write_event(WarningEvent(
                event="warning", code="init_fallback_nominal",
                message=(f"{len(fallback_ids)} cabinet(s) share no bridged view chain with the "
                         f"root; initialized from the nominal model (BA must absorb any "
                         f"as-built deviation): {', '.join(sorted(fallback_ids))}")))

        init_cameras: list[tuple[np.ndarray, np.ndarray]] = []
        for cam_idx in range(n_cams):
            init_cameras.append(
                _pnp_camera(cam_idx, gauge_idx, init_cabinets, pvcc, K))
        return init_cameras, init_cabinets

    solved = solve_with_view_rejection(
        K=K, observations=observations,
        per_view_cab_corners=per_view_cab_corners,
        n_cameras=n_cameras, n_cabinets=n_cabinets,
        root_cabinet_idx=gauge_idx, make_inits=make_inits,
        per_cabinet_min_points=8)
    if solved is None:
        return 1
    result, rejected_per_cab_stage_b, n_rej_stage_b, surviving_observations, max_nfev, view_rej_cams = solved

    rejected_per_cab_pre = rejected_per_cab_pre or {}
    n_used = len(surviving_observations)
    n_rej = n_rejected_pre + n_rej_stage_b
    n_total = n_used + n_rej

    write_event(ProgressEvent(event="progress", stage="output", percent=0.9,
                              message="building joint multi-screen output"))
    per_cabinet_views: dict[int, set[int]] = {}
    per_cabinet_points: dict[int, int] = {}
    for o in surviving_observations:
        per_cabinet_views.setdefault(o.cabinet_idx, set()).add(o.camera_idx)
        per_cabinet_points[o.cabinet_idx] = per_cabinet_points.get(o.cabinet_idx, 0) + 1

    for idx in range(n_cabinets):
        n_pts = per_cabinet_points.get(idx, 0)
        n_views = len(per_cabinet_views.get(idx, set()))
        if n_pts < 8 or n_views < 2:
            cid = _cabinet_id(*cab_idx_to_cr[idx])
            write_event(ErrorEvent(
                event="error", code="observability_failed",
                message=(f"after rejecting {n_rej_stage_b} outliers, cabinet {cid} "
                         f"has only {n_pts} observations across {n_views} view(s) "
                         f"(needs >=8 points and >=2 views)"),
                fatal=True))
            return 1

    if (gate_retry_out is not None and view_rej_cams
            and result.rms_reprojection_px > BA_RMS_FATAL_PX):
        gate_retry_out["bad_views"] = sorted(view_rej_cams)
        return 1
    if _ba_acceptance_failed(result, max_nfev):
        return 1

    per_cabinet_rms = _per_cabinet_reproj_rms(
        K, result.camera_poses, result.cabinet_poses, surviving_observations)

    n_screens = len(screen_projects)
    screen_cab_indices: dict[int, list[int]] = {si: [] for si in range(n_screens)}
    for idx in range(n_cabinets):
        screen_cab_indices[cab_idx_to_screen[idx]].append(idx)

    measured_points: list[MeasuredPoint] = []
    screen_summaries: list[ScreenResultSummary] = []
    transform_entries: list[ScreenTransformEntry] = []
    quality_issues: list[tuple[str, str]] = []

    for si in range(n_screens):
        sp = screen_projects[si]
        screen_root_idx = screen_root_indices[si]
        screen_result = _reexpress_result_in_cabinet_frame(result, screen_root_idx)

        cabinet_poses: list[CabinetPose] = []
        corners_provider = corners_local_providers[si]
        for idx in screen_cab_indices[si]:
            col, row = cab_idx_to_cr[idx]
            cid = _cabinet_id(col, row)
            R, t = screen_result.cabinet_poses[idx]
            corners_local = corners_provider(cid)
            center, normal, _size, world_corners = reconstruct_cabinet_geometry(R, t, corners_local)
            n_views = len(per_cabinet_views.get(idx, set()))
            n_points = per_cabinet_points.get(idx, 0)
            cab_rms = per_cabinet_rms[idx]
            quality = _classify_cabinet_quality(n_views, cab_rms)
            rejected_points = rejected_per_cab_pre.get(idx, 0) + rejected_per_cab_stage_b.get(idx, 0)

            cov_mm = result.cabinet_covariances.get(idx)
            cov_ok = cov_mm is not None and np.isfinite(cov_mm).all()
            cabinet_poses.append(CabinetPose(
                cabinet_id=cid,
                position_mm=center.tolist(),
                rotation_matrix=R.tolist(),
                normal=normal.tolist(),
                corners_mm=[c.tolist() for c in world_corners],
                reprojection_rms_px=cab_rms,
                observed_views=n_views,
                observed_points=n_points,
                rejected_points=rejected_points,
                quality=quality,
                covariance_mm2=np.asarray(cov_mm, dtype=float).tolist() if cov_ok else None,
            ))
            if quality != "ok":
                quality_issues.append((f"{sp.screen_id}/{cid}", quality))

            if cov_ok:
                cov_m = np.asarray(cov_mm, dtype=float) / 1.0e6
                uncertainty = Uncertainty(covariance=cov_m.tolist())
            else:
                uncertainty = Uncertainty(isotropic=FALLBACK_ISOTROPIC_M)
            measured_points.append(MeasuredPoint(
                name=f"MAIN_{sp.screen_id}_{cid}",
                position=(center / 1000.0).tolist(),
                uncertainty=uncertainty,
                source=PointSource(visual_ba=PointSourceVisualBa(camera_count=max(1, n_views))),
            ))

        pose_path = per_screen_pose_paths.get(si)
        if pose_path:
            report = CabinetPoseReport(
                schema_version="visual_pose_report.v1",
                frame=FrameSpec(gauge_strategy="fix_root_cabinet", root_cabinet=list(ROOT_CABINET)),
                cabinet_poses=cabinet_poses,
            )
            _atomic_write_json(pose_path, report.model_dump_json(indent=2))

        screen_cab_rms = [per_cabinet_rms[i] for i in screen_cab_indices[si]]
        screen_rms = float(np.sqrt(np.mean(np.square(screen_cab_rms)))) if screen_cab_rms else 0.0
        bridge_views = int(conn_info.get("bridge_views", {}).get(si, 0))
        screen_summaries.append(ScreenResultSummary(
            screen_id=sp.screen_id,
            pose_report_path=pose_path,
            ba_rms_px=screen_rms,
            cabinet_count=len(screen_cab_indices[si]),
            bridge_views=bridge_views,
        ))

        if si == 0:
            transform_entries.append(ScreenTransformEntry(
                screen_id=sp.screen_id,
                R=np.eye(3).tolist(),
                t_mm=[0.0, 0.0, 0.0],
                rms_px=screen_rms,
                bridge_views=bridge_views,
            ))
        else:
            R_joint, t_joint = result.cabinet_poses[screen_root_idx]
            transform_entries.append(ScreenTransformEntry(
                screen_id=sp.screen_id,
                R=np.asarray(R_joint, dtype=float).tolist(),
                t_mm=np.asarray(t_joint, dtype=float).tolist(),
                rms_px=screen_rms,
                bridge_views=bridge_views,
            ))

    _emit_cabinet_quality_summary(quality_issues)

    transforms_report = ScreenTransformsReport(
        schema_version="visual_screen_transforms.v1",
        frame_screen_id=screen_projects[0].screen_id,
        transforms=transform_entries,
    )
    _atomic_write_json(screen_transforms_path, transforms_report.model_dump_json(indent=2))
    wv = _run_withheld_validation(
        K=K, result=result, observations=surviving_observations,
        n_cabinets=n_cabinets, root_idx=root_idx, cab_idx_to_screen=cab_idx_to_screen,
        screen_ids=[sp.screen_id for sp in screen_projects],
        screen_root_indices=screen_root_indices,
        screen_transforms_path=screen_transforms_path)

    write_event(ResultEvent(
        event="result",
        data=ResultData(
            measured_points=measured_points,
            ba_stats=BaStats(
                rms_reprojection_px=float(result.rms_reprojection_px),
                iterations=int(result.iterations),
                converged=bool(result.converged),
                n_observations_total=n_total,
                n_observations_used=n_used,
                n_rejected=n_rej,
            ),
            frame_strategy_used="nominal_anchoring",
            procrustes_align_rms_m=0.0,
            intrinsics_source=intrinsics_source,
            screen_transforms_path=screen_transforms_path,
            screens=screen_summaries,
            ignored_photos=list(ignored_photos or []),
            photos_used=photos_used,
            photos_total=photos_total,
            withheld=_withheld_summary_from_wv(wv),
        ),
    ))
    return 0


def _reexpress_result_in_cabinet_frame(result: "BAResult", frame_idx: int) -> "BAResult":
    """Rigidly re-express a BAResult in cabinet `frame_idx`'s frame (FIX-3.3:
    the BA gauge sits at the wall-center cabinet for conditioning, but reports
    keep the external root cabinet's frame). x_new = R0.T @ (x_old - t0) with
    (R0, t0) = the frame cabinet's solved pose. Cameras compose the inverse
    change (reprojection invariant); translation covariances rotate R0.T S R0
    so the uncertainty ellipsoids stay attached to their cabinets."""
    R0, t0 = result.cabinet_poses[frame_idx]
    return BAResult(
        camera_poses=[(Rc @ R0, tc + Rc @ t0) for Rc, tc in result.camera_poses],
        cabinet_poses={j: (R0.T @ Rj, R0.T @ (tj - t0))
                       for j, (Rj, tj) in result.cabinet_poses.items()},
        rms_reprojection_px=result.rms_reprojection_px,
        iterations=result.iterations,
        converged=result.converged,
        cabinet_covariances={
            j: (R0.T @ np.asarray(S, dtype=float) @ R0
                if S is not None and np.ndim(S) == 2 else S)
            for j, S in result.cabinet_covariances.items()},
    )


def _nominal_init_root_frame(
    nominal_poses: "dict[tuple[int, int], tuple[np.ndarray, np.ndarray]]",
    root_cr: tuple[int, int],
    cr: tuple[int, int],
) -> tuple[np.ndarray, np.ndarray]:
    """world_from_cab init for `cr` from the nominal wall, expressed in the
    ROOT cabinet's frame (= the BA world): T_root^-1 . T_cr, i.e.
    R = R_root.T @ R_cr and t_mm = R_root.T @ (t_cr - t_root).

    FIX-3: the pre-fix fallback used identity rotation and an UNROTATED
    model-frame translation delta — at the far end of a long arc that is up to
    a ~90 deg rotation error plus a bent translation, which BA cannot recover
    from (divergence or the mirror local minimum)."""
    R_root, t_root = nominal_poses[root_cr]
    R_cr, t_cr = nominal_poses[cr]
    R_root = np.asarray(R_root, dtype=float)
    R = R_root.T @ np.asarray(R_cr, dtype=float)
    t_mm = R_root.T @ ((np.asarray(t_cr, dtype=float) - np.asarray(t_root, dtype=float)) * 1000.0)
    return R, t_mm


def solve_and_emit(
    *,
    K: np.ndarray,
    observations: list[Observation],
    per_view_cab_corners: dict[tuple[int, int], list[tuple[np.ndarray, np.ndarray]]],
    n_cameras: int,
    cab_to_idx: dict[tuple[int, int], int],
    root_idx: int,
    n_cabinets: int,
    nominal_poses: "dict[tuple[int, int], tuple[np.ndarray, np.ndarray]]",
    per_cabinet_views: dict[int, set[int]],
    per_cabinet_points: dict[int, int],
    corners_local_provider: Callable[[str], np.ndarray],
    pose_report_path: str | None,
    n_rejected_pre: int = 0,
    rejected_per_cab_pre: dict[int, int] | None = None,
    gauge_strategy: str = "fix_root_cabinet",
    intrinsics_source: str = "file",
    ignored_photos: list[str] | None = None,
    photos_used: int = 0,
    photos_total: int = 0,
) -> int:
    """Shared init -> model_constrained_ba -> per-cabinet geometry -> report ->
    ResultEvent. Used by both run_reconstruct (charuco) and
    sl_reconstruct.run_reconstruct_structured_light. corners_local_provider maps
    a cabinet_id string to its (4,3) active-surface corners in local mm.

    gauge_strategy:
      - "fix_root_cabinet" (default): world frame = root cabinet's frame (R=I,t=0).
        Output geometry is left in that BA-local frame. Charuco path uses this;
        its report/measured.yaml are byte-identical to before.
      - "align_to_nominal": after BA, a SINGLE rigid transform (Procrustes over
        ALL cabinet corners vs the nominal design grid) places the whole wall into
        the nominal design frame, so downstream export lands drop-in without
        guessing orientation. Recon-native axes match nominal, so this never flips.
    """
    # --- 7. init ---
    write_event(ProgressEvent(event="progress", stage="bundle_adjustment", percent=0.5, message="initializing"))
    if ROOT_CABINET not in nominal_poses:
        write_event(ErrorEvent(
            event="error", code="invalid_input",
            message="root cabinet (0,0) missing from nominal model (absent_cells?)",
            fatal=True,
        ))
        return 1
    idx_to_cab = {idx: cr for cr, idx in cab_to_idx.items()}
    # idx-keyed nominal SE(3) poses for branch disambiguation.
    nominal_poses_idx = {cab_to_idx[cr]: rt for cr, rt in nominal_poses.items()
                         if cr in cab_to_idx}
    # BA gauge = the CENTER-most cabinet (FIX-3.3): on a wide segmented wall this
    # halves the transitive-bridging chain length (and so the init drift) vs the
    # corner root. OUTPUT frame semantics are unchanged: after the solve the whole
    # solution is rigidly re-expressed in the external root cabinet's frame.
    center_m = np.mean([np.asarray(nominal_poses[cr][1], dtype=float)
                        for cr in cab_to_idx], axis=0)
    gauge_idx = min(
        cab_to_idx.values(),
        key=lambda i: (float(np.linalg.norm(np.asarray(nominal_poses[idx_to_cab[i]][1], dtype=float) - center_m)),
                       idx_to_cab[i][1], idx_to_cab[i][0]))
    gauge_cr = idx_to_cab[gauge_idx]
    # Bridge-camera init: estimate each non-gauge cabinet's world pose from view
    # chains that connect it to the gauge (transitive co-visibility), resolving the
    # IPPE convex/concave mirror against nominal model-frame normals. Cabinets with
    # no chain fall back to the nominal pose rotated into the gauge frame (warned).
    def make_inits(pvcc, n_cams):
        bridge, undecidable_cabs = estimate_nonroot_cabinet_init(
            pvcc, gauge_idx, K,
            nominal_poses=nominal_poses_idx,
        )
        if undecidable_cabs:
            ids = sorted(_cabinet_id(*idx_to_cab[j]) for j in undecidable_cabs)
            write_event(ErrorEvent(
                event="error", code="observability_failed",
                message=(f"convex/concave undecidable for cabinet(s) {ids}: planar-PnP "
                         f"mirror branches equally match nominal and no redundant view "
                         f"breaks the tie; add a camera that sees these cabinets"),
                fatal=True))
            return None
        init_cabinets: dict[int, tuple[np.ndarray, np.ndarray]] = {}
        fallback_ids: list[str] = []
        for cr, idx in cab_to_idx.items():
            if idx == gauge_idx:
                init_cabinets[idx] = (np.eye(3), np.zeros(3))
            elif idx in bridge:
                init_cabinets[idx] = bridge[idx]
            elif cr in nominal_poses:
                init_cabinets[idx] = _nominal_init_root_frame(nominal_poses, gauge_cr, cr)
                fallback_ids.append(_cabinet_id(*cr))
            else:
                init_cabinets[idx] = (np.eye(3), np.zeros(3))
                fallback_ids.append(_cabinet_id(*cr))
        if fallback_ids:
            write_event(WarningEvent(
                event="warning", code="init_fallback_nominal",
                message=(f"{len(fallback_ids)} cabinet(s) share no bridged view chain with the "
                         f"root; initialized from the nominal model (BA must absorb any "
                         f"as-built deviation): {', '.join(sorted(fallback_ids))}")))

        # Camera init via PnP. Object points are local mm; the root cabinet frame is
        # world, so PnP against the root gives camera_from_world directly. For views
        # that don't see the root well, PnP against any seen cabinet, then compose
        # with that cabinet's nominal world pose: T_cam_world = T_cam_cab @ T_cab_world.
        init_cameras: list[tuple[np.ndarray, np.ndarray]] = []
        for cam_idx in range(n_cams):
            pose = _pnp_camera(cam_idx, gauge_idx, init_cabinets, pvcc, K)
            init_cameras.append(pose)
        return init_cameras, init_cabinets

    # --- 8. BA (Stage B robust-residual trim — PRIMARY geometric authority;
    #     Stage C whole-view rejection retry on gate failure) ---
    solved = solve_with_view_rejection(
        K=K, observations=observations,
        per_view_cab_corners=per_view_cab_corners,
        n_cameras=n_cameras, n_cabinets=n_cabinets,
        root_cabinet_idx=gauge_idx, make_inits=make_inits,
        per_cabinet_min_points=8)
    if solved is None:
        return 1
    result, rejected_per_cab_stage_b, n_rej_stage_b, surviving_observations, max_nfev, view_rej_cams = solved
    # Re-express the solution in the EXTERNAL root cabinet's frame (the gauge sat
    # at the wall center purely for conditioning; reports keep V000_R000 frame
    # semantics).
    if gauge_idx != root_idx:
        result = _reexpress_result_in_cabinet_frame(result, root_idx)
    # Rejection accounting: Stage A removed n_rejected_pre observations before
    # this function got `observations`; Stage B trimmed n_rej_stage_b more.
    # n_used = surviving obs the final solve ran on; n_total folds both stages.
    rejected_per_cab_pre = rejected_per_cab_pre or {}
    n_used = len(surviving_observations)
    n_rej = n_rejected_pre + n_rej_stage_b
    n_total = n_used + n_rej

    # --- 9. per-cabinet geometry ---
    write_event(ProgressEvent(event="progress", stage="output", percent=0.9, message="building pose report"))
    # recompute per-cabinet indices from the trimmed (surviving) observations
    per_cabinet_views = {}
    per_cabinet_points = {}
    for o in surviving_observations:
        per_cabinet_views.setdefault(o.cabinet_idx, set()).add(o.camera_idx)
        per_cabinet_points[o.cabinet_idx] = per_cabinet_points.get(o.cabinet_idx, 0) + 1
    # post-trim observability: trimming an outlier-heavy cabinet below the floor
    # is a hard stop (no silent wrong measured.yaml). Re-enforce BOTH dimensions
    # of the pre-trim check_observability(min_views=2, min_points=8): a coherent
    # mis-decode in one of only two views gets its (cam,cab) group trimmed,
    # leaving the cabinet with a single view — geometrically under-determined, so
    # this must hard-stop rather than emit a 1-view "result".
    for idx in range(n_cabinets):
        n_pts = per_cabinet_points.get(idx, 0)
        n_views = len(per_cabinet_views.get(idx, set()))
        if n_pts < 8 or n_views < 2:
            cid = _cabinet_id(*idx_to_cab[idx])
            write_event(ErrorEvent(
                event="error", code="observability_failed",
                message=(f"after rejecting {n_rej_stage_b} outliers, cabinet {cid} "
                         f"has only {n_pts} observations across {n_views} view(s) "
                         f"(needs >=8 points and >=2 views)"),
                fatal=True))
            return 1
    # After post-trim observability so amputated cabinets surface as
    # observability_failed, not a generic ba_diverged.
    if _ba_acceptance_failed(result, max_nfev):
        return 1
    # Per-cabinet reprojection RMS from the solved poses (same projection as BA).
    # NOTE: computed from the ORIGINAL BA poses, before any align_to_nominal rigid
    # transform — reprojection is invariant under a world rigid motion, and the
    # camera poses are not transformed, so this stays correct.
    per_cabinet_rms = _per_cabinet_reproj_rms(
        K, result.camera_poses, result.cabinet_poses, surviving_observations
    )

    # --- 9a. align_to_nominal: one rigid transform (BA world -> nominal design
    #         frame) fitted over ALL cabinet corners (√N robust). ---
    align_r = np.eye(3)
    align_t = np.zeros(3)
    align_rms_mm = 0.0
    if gauge_strategy == "align_to_nominal":
        src_rows: list[np.ndarray] = []
        dst_rows: list[np.ndarray] = []
        for idx in range(n_cabinets):
            cr = idx_to_cab[idx]
            cid = _cabinet_id(*cr)
            r_idx, t_idx = result.cabinet_poses[idx]
            corners_local = corners_local_provider(cid)
            _c, _n, _s, world_corners = reconstruct_cabinet_geometry(r_idx, t_idx, corners_local)
            src_rows.append(world_corners)
            dst_rows.append(_nominal_world_corners(cr, corners_local, nominal_poses))
        try:
            align_r, align_t, align_rms_mm = procrustes_rigid(np.vstack(src_rows), np.vstack(dst_rows))
        except ValueError as e:
            write_event(ErrorEvent(
                event="error", code="procrustes_failed",
                message=f"align_to_nominal alignment failed: {e}", fatal=True))
            return 1
        # A large rigid-fit residual is the NON-absorbable pitch/shape class (P5): a global
        # isotropic pitch scale or genuine shape deviation rigid Procrustes cannot absorb.
        # Warn (not refuse) — the model is still emitted, but the as-built ≠ nominal signal
        # matters. (fix_root_cabinet/charuco keeps align_rms_mm == 0, so it never triggers.)
        if align_rms_mm > NOMINAL_MISFIT_WARN_MM:
            write_event(WarningEvent(
                event="warning", code="nominal_misfit",
                message=(f"align_to_nominal residual {align_rms_mm:.1f}mm > {NOMINAL_MISFIT_WARN_MM}mm: "
                         "suspected screen pitch scale / shape deviation, NOT a pose error")))

    cabinet_poses: list[CabinetPose] = []
    measured_points: list[MeasuredPoint] = []
    quality_issues: list[tuple[str, str]] = []
    for idx in range(n_cabinets):
        col, row = idx_to_cab[idx]
        cid = _cabinet_id(col, row)
        R, t = result.cabinet_poses[idx]
        corners_local = corners_local_provider(cid)
        center, normal, _size, world_corners = reconstruct_cabinet_geometry(R, t, corners_local)
        if gauge_strategy == "align_to_nominal":
            center = align_r @ center + align_t
            normal = align_r @ normal
            world_corners = (world_corners @ align_r.T) + align_t
            R = align_r @ R  # rotation_matrix expressed in the aligned (design) frame
        n_views = len(per_cabinet_views.get(idx, set()))
        n_points = per_cabinet_points.get(idx, 0)
        # Direct index (not .get): observability upstream guarantees every
        # cabinet has observations, so a missing entry is a broken invariant we
        # want surfaced as a loud KeyError, not masked as a fake 0.0 RMS.
        cab_rms = per_cabinet_rms[idx]
        quality = _classify_cabinet_quality(n_views, cab_rms)
        rejected_points = rejected_per_cab_pre.get(idx, 0) + rejected_per_cab_stage_b.get(idx, 0)

        # FIX-13 ④: 协方差迁移进 pose report 持久化（mm²，原样不换单位）。
        cov_mm = result.cabinet_covariances.get(idx)
        # FIX-19②: align_to_nominal rotates geometry; covariance must follow.
        if gauge_strategy == "align_to_nominal" and cov_mm is not None and np.ndim(cov_mm) == 2:
            cov_mm = align_r @ np.asarray(cov_mm, dtype=float) @ align_r.T
        cov_ok = cov_mm is not None and np.isfinite(cov_mm).all()
        cabinet_poses.append(CabinetPose(
            cabinet_id=cid,
            position_mm=center.tolist(),
            rotation_matrix=R.tolist(),
            normal=normal.tolist(),
            corners_mm=[c.tolist() for c in world_corners],
            reprojection_rms_px=cab_rms,
            observed_views=n_views,
            observed_points=n_points,
            rejected_points=rejected_points,
            quality=quality,
            covariance_mm2=np.asarray(cov_mm, dtype=float).tolist() if cov_ok else None,
        ))
        if quality != "ok":
            quality_issues.append((cid, quality))
        if rejected_points and rejected_points / (rejected_points + n_points) > 0.30:
            write_event(WarningEvent(
                event="warning", code="high_rejection",
                message=f"cabinet {cid}: rejected {rejected_points}/{rejected_points+n_points} observations",
                cabinet=cid,
            ))

        # MeasuredPoint position is in METERS.
        if cov_ok:
            cov_m = np.asarray(cov_mm, dtype=float) / 1.0e6  # mm^2 -> m^2
            uncertainty = Uncertainty(covariance=cov_m.tolist())
        else:
            write_event(WarningEvent(
                event="warning", code="missing_covariance",
                message=f"cabinet {cid} has no usable BA covariance; falling back to isotropic 5mm",
                cabinet=cid,
            ))
            uncertainty = Uncertainty(isotropic=FALLBACK_ISOTROPIC_M)
        measured_points.append(MeasuredPoint(
            name=f"MAIN_{cid}",
            position=(center / 1000.0).tolist(),
            uncertainty=uncertainty,
            source=PointSource(visual_ba=PointSourceVisualBa(camera_count=max(1, n_views))),
        ))

    _emit_cabinet_quality_summary(quality_issues)

    # --- 10. write pose report ---
    if pose_report_path:
        report = CabinetPoseReport(
            schema_version="visual_pose_report.v1",
            frame=FrameSpec(gauge_strategy=gauge_strategy, root_cabinet=list(ROOT_CABINET)),
            cabinet_poses=cabinet_poses,
        )
        _atomic_write_json(pose_report_path, report.model_dump_json(indent=2))

    # --- 11. result ---
    write_event(ResultEvent(
        event="result",
        data=ResultData(
            measured_points=measured_points,
            ba_stats=BaStats(
                rms_reprojection_px=float(result.rms_reprojection_px),
                iterations=int(result.iterations),
                converged=bool(result.converged),  # FIX-4: report truthfully (was hardcoded True)
                n_observations_total=n_total,
                n_observations_used=n_used,
                n_rejected=n_rej,
            ),
            frame_strategy_used="nominal_anchoring",  # vestigial label; see gauge_strategy
            procrustes_align_rms_m=align_rms_mm / 1000.0,  # mm -> m (0.0 for fix_root_cabinet)
            intrinsics_source=intrinsics_source,
            ignored_photos=list(ignored_photos or []),
            photos_used=int(photos_used),
            photos_total=int(photos_total),
        ),
    ))
    return 0


def _solve_pnp_branches(corners, K):
    """corners: list[(p_local_mm, pixel_undistorted)] ->
    (branches, inlier_mask) or None.

    branches: list of 1-2 (R, t) camera_from_obj poses. The planar PnP mirror
    ambiguity (IPPE) yields up to two near-equal-reprojection branches; both
    are returned so the model-frame assembly can disambiguate (Part C). Branch
    order is OpenCV's (ascending reprojection error).
    inlier_mask: bool ndarray (len(corners),) from solvePnPRansac — gross
    outliers are False (Part C disambiguation + Stage A both consume this).

    Returns None for < 4 correspondences and for geometrically degenerate sets
    (near-collinear -> cv2.error). tvec is reshaped to (3,).
    """
    if len(corners) < MIN_PNP_CORNERS:
        return None
    obj = np.array([p for p, _ in corners], dtype=np.float64)
    img = np.array([px for _, px in corners], dtype=np.float64)
    # Primary path: solvePnP(ITERATIVE) on all points. DLT with many well-
    # distributed coplanar points overwhelms the planar mirror ambiguity that
    # causes RANSAC's 4-point subsets to consistently pick the wrong branch.
    mask = np.zeros(len(corners), dtype=bool)
    try:
        ok, rvec, tvec = cv2.solvePnP(
            obj, img, K, None, flags=cv2.SOLVEPNP_ITERATIVE)
    except cv2.error:
        ok = False
    if ok:
        projected, _ = cv2.projectPoints(obj, rvec, tvec, K, None)
        errors = np.linalg.norm(projected.reshape(-1, 2) - img, axis=1)
        mask = errors < PNP_RANSAC_REPROJ_PX
    # Fallback to RANSAC when solvePnP fails or finds few inliers (e.g., true
    # outlier contamination where RANSAC's subset sampling is correct).
    if int(mask.sum()) < MIN_PNP_CORNERS:
        try:
            ok_r, _rv, _tv, inliers = cv2.solvePnPRansac(
                obj, img, K, None, iterationsCount=PNP_RANSAC_ITERS,
                reprojectionError=PNP_RANSAC_REPROJ_PX,
                confidence=PNP_RANSAC_CONFIDENCE,
                flags=cv2.SOLVEPNP_ITERATIVE)
        except cv2.error:
            return None
        if not ok_r:
            return None
        mask[:] = False
        if inliers is not None:
            mask[inliers.reshape(-1)] = True
        else:
            mask[:] = True
    if int(mask.sum()) < MIN_PNP_CORNERS:
        return None
    in_obj = obj[mask]
    in_img = img[mask]
    # Two-branch planar solve on the inliers (IPPE needs coplanar z=0 points).
    try:
        retval, rvecs, tvecs = cv2.solvePnPGeneric(
            in_obj, in_img, K, None, flags=cv2.SOLVEPNP_IPPE
        )[:3]
    except cv2.error:
        return None
    if retval < 1:
        return None
    branches = []
    for i in range(retval):
        rvec = np.asarray(rvecs[i], dtype=float)
        tvec = np.asarray(tvecs[i], dtype=float).reshape(3)
        # Near-collinear / degenerate inputs let solvePnPRansac "succeed" but make
        # solvePnPGeneric(IPPE) emit NaN poses; reject those to preserve the
        # degenerate -> None contract (legacy _solve_pnp returned None here).
        if not (np.isfinite(rvec).all() and np.isfinite(tvec).all()):
            continue
        R, _ = cv2.Rodrigues(rvec)
        branches.append((R, tvec))
    if not branches:
        return None
    return branches, mask


def _solve_pnp(corners, K):
    """corners: list[(p_local_mm, pixel_undistorted)] -> (R, t) or None.

    Backward-compatible single-pose form: the RANSAC+IPPE best branch (branch 0,
    lowest reprojection). Used by callers that don't disambiguate (camera init).
    Returns None on the same degenerate / too-few conditions as
    _solve_pnp_branches.
    """
    res = _solve_pnp_branches(corners, K)
    if res is None:
        return None
    branches, _mask = res
    return branches[0]


def stage_a_prune(observations, per_view_cab_corners, K):
    """Stage A pre-clean: per-(cam,cab) PnP-RANSAC inlier filter. Drops gross /
    random-far and independent near-neighbor mis-IDs whose reprojection exceeds
    PNP_RANSAC_REPROJ_PX. NOT authoritative for coherent shifts (those pass to
    Stage B). Groups with < MIN_PNP_CORNERS are kept whole. Rebuilds the
    observation list + per_view_cab_corners + per-cabinet view/point indices
    from the inliers. Returns (obs_out, pvcc_out, per_cabinet_views,
    per_cabinet_points, n_rejected_total, rejected_per_cab) where
    rejected_per_cab: dict[int,int] is the per-cabinet Stage-A reject count
    (Task 6 stats + Task 7 tests consume it)."""
    # Map each (cam,cab) corner index back to its source so we can keep aligned
    # Observation objects (assembly appends to both lists in lockstep).
    keep_mask: dict[tuple[int, int], list[bool]] = {}
    n_rejected_total = 0
    rejected_per_cab: dict[int, int] = {}
    for key, corners in per_view_cab_corners.items():
        _cam_idx, cab_idx = key
        if len(corners) < MIN_PNP_CORNERS:
            keep_mask[key] = [True] * len(corners)
            continue
        res = _solve_pnp_branches(corners, K)
        if res is None:
            keep_mask[key] = [True] * len(corners)  # degenerate -> defer to Stage B
            continue
        _branches, mask = res
        keep_mask[key] = list(mask)
        n_rej = int((~mask).sum())
        n_rejected_total += n_rej
        if n_rej:
            rejected_per_cab[cab_idx] = rejected_per_cab.get(cab_idx, 0) + n_rej

    # Rebuild aligned outputs. Walk observations in order, consuming each
    # group's mask in the same append order assembly used.
    cursor: dict[tuple[int, int], int] = {}
    obs_out = []
    pvcc_out: dict[tuple[int, int], list] = {}
    views_out: dict[int, set] = {}
    pts_out: dict[int, int] = {}
    for o in observations:
        key = (o.camera_idx, o.cabinet_idx)
        i = cursor.get(key, 0)
        cursor[key] = i + 1
        if not keep_mask[key][i]:
            continue
        obs_out.append(o)
        pvcc_out.setdefault(key, []).append((o.p_local, o.pixel))
        views_out.setdefault(o.cabinet_idx, set()).add(o.camera_idx)
        pts_out[o.cabinet_idx] = pts_out.get(o.cabinet_idx, 0) + 1
    return obs_out, pvcc_out, views_out, pts_out, n_rejected_total, rejected_per_cab


def _avg_rotation(rotations):
    """SVD-average a set of rotation matrices; result is orthonormal with det=+1."""
    if not rotations:
        raise ValueError("_avg_rotation needs at least one rotation")
    S = sum(rotations)
    U, _, Vt = np.linalg.svd(S)
    R = U @ Vt
    if np.linalg.det(R) < 0:
        U[:, -1] *= -1
        R = U @ Vt
    return R


# Branch disambiguation thresholds (sidecar internal): a branch is "well
# separated" only when its model-frame normal is meaningfully closer to nominal
# than the other; reproj ratio is the secondary tiebreak.
DISAMBIG_NORMAL_MARGIN_RAD = np.deg2rad(8.0)


def _disambiguate_world_branch(world_branches, nominal_normal):
    """world_branches: list of (R_world_from_cab, t) candidate poses.
    nominal_normal: (3,) expected model-frame surface normal.
    Returns the chosen (R, t), or the string "undecidable" when the two
    branches are equally consistent with nominal (no redundancy to break it)."""
    nn = np.asarray(nominal_normal, dtype=float)
    nn = nn / (np.linalg.norm(nn) + 1e-12)
    angs = []
    for R, _t in world_branches:
        n = R @ np.array([0.0, 0.0, 1.0])
        angs.append(float(np.arccos(np.clip(n @ nn, -1.0, 1.0))))
    order = np.argsort(angs)
    if len(world_branches) == 1:
        return world_branches[0]
    best, second = order[0], order[1]
    if angs[second] - angs[best] < DISAMBIG_NORMAL_MARGIN_RAD:
        return "undecidable"
    return world_branches[best]


def estimate_nonroot_cabinet_init(
    per_view_cab_corners: dict[tuple[int, int], list[tuple[np.ndarray, np.ndarray]]],
    root_idx: int,
    K: np.ndarray,
    *,
    nominal_poses: "dict[int, tuple[np.ndarray, np.ndarray]]",
    min_corners: int = MIN_PNP_CORNERS,
) -> tuple[dict[int, tuple[np.ndarray, np.ndarray]], set[int]]:
    """Non-root cabinet_idx -> (R_world_from_cab, t_mm) via TRANSITIVE bridge
    cameras (co-visibility waves out from the root), with IPPE two-branch
    disambiguation against nominal model-frame normals.

    Any view that sees an already-bridged cabinet (an ANCHOR — the root in wave
    one) together with unknown cabinets extends the chain (FIX-3; pre-fix only
    direct root<->non-root bridging existed, so on a segmented wide-wall capture
    everything beyond the root's own views fell into the nominal fallback):

    1. The view's camera pose comes from its anchors: every IPPE branch of every
       anchor yields a camera_from_world candidate (cam_from_anchor composed
       with the anchor's known world pose); the candidate that best reprojects
       ALL anchors in the view wins (with one near-fronto-parallel anchor the
       branches tie harmlessly — they differ by a tilt that small).
    2. Each unknown cabinet's two IPPE branches compose to world_from_cab
       candidates via that camera pose:
           R = R_cw.T @ Rc1 ,  t = R_cw.T @ (tc1 - t_cw)
       When reprojection clearly separates the branches it decides; otherwise
       the branch whose model-frame normal (R @ [0,0,1]) best matches the
       cabinet's nominal arc normal (expressed in the ROOT frame) is kept.
    3. Newly bridged cabinets become anchors; waves repeat until no view gains
       an anchor. Estimates accumulate per cabinet across all processed views:
       rotations SVD-averaged, translation component-wise median.

    Returns (out, undecidable): `out` maps each bridged cabinet to its chosen
    world pose; `undecidable` is the set of cabinet_idx whose convex/concave
    branch could not be resolved from nominal (no redundant view broke the tie)
    so the caller must hard-stop. A cabinet resolved by at least one view is
    removed from `undecidable`. Cabinets with no view chain to the root are
    absent from both (caller falls back to the nominal init, rotated into the
    root frame, with a WarningEvent).
    """
    by_view: dict[int, dict[int, list]] = {}
    for (cam_idx, cab_idx), corners in per_view_cab_corners.items():
        by_view.setdefault(cam_idx, {})[cab_idx] = corners

    # The reconstruction world frame is the ROOT cabinet's frame (root fixed at
    # identity), but `nominal_poses` are in the global nominal MODEL frame. For a
    # curved arc whose root is NOT at the arc centre, the two frames differ by the
    # root's nominal rotation, so disambiguating a non-root branch against an
    # untransformed model-frame nominal can select the IPPE mirror (the convex/
    # concave flip). Take the root's nominal rotation straight from its SE(3)
    # pose (flat -> identity) and express every cabinet's nominal normal in the
    # root frame before comparing.
    root_pose = nominal_poses.get(root_idx) if nominal_poses else None
    R_root_nominal = np.asarray(root_pose[0], dtype=float) if root_pose is not None else np.eye(3)

    branch_cache: dict[tuple[int, int], "tuple[list, np.ndarray] | None"] = {}

    def _branches(cam_idx: int, cab_idx: int):
        key = (cam_idx, cab_idx)
        if key not in branch_cache:
            corners = by_view[cam_idx][cab_idx]
            branch_cache[key] = (_solve_pnp_branches(corners, K)
                                 if len(corners) >= min_corners else None)
        return branch_cache[key]

    def _iterative_pose(corners):
        """Plain all-points ITERATIVE PnP. For a near-fronto-parallel ANCHOR the
        two IPPE branches are both small-tilt-wrong (degenerate zone) while the
        homography-initialised iterative solve stays exact — and since the
        anchor's world pose is already known, no branch disambiguation is needed
        here, only accuracy."""
        obj = np.array([p for p, _ in corners], dtype=np.float64)
        img = np.array([px for _, px in corners], dtype=np.float64)
        try:
            ok, rvec, tvec = cv2.solvePnP(obj, img, K, None, flags=cv2.SOLVEPNP_ITERATIVE)
        except cv2.error:
            return None
        if not ok:
            return None
        rvec = np.asarray(rvec, dtype=float)
        tvec = np.asarray(tvec, dtype=float).reshape(3)
        if not (np.isfinite(rvec).all() and np.isfinite(tvec).all()):
            return None
        return cv2.Rodrigues(rvec)[0], tvec

    def _rms_via_campose(R_cw, t_cw, world_pose, corners):
        """Mean reprojection RMS of a KNOWN cabinet through a candidate camera."""
        R_w, t_w = world_pose
        obj = np.array([p for p, _ in corners], dtype=np.float64)
        img = np.array([px for _, px in corners], dtype=np.float64)
        xc = (obj @ R_w.T + t_w) @ R_cw.T + t_cw
        if np.any(xc[:, 2] <= 1e-6):
            return np.inf
        uv = xc @ K.T
        uv = uv[:, :2] / uv[:, 2:3]
        return float(np.sqrt(((uv - img) ** 2).sum(axis=1).mean()))

    known: dict[int, tuple[np.ndarray, np.ndarray]] = {root_idx: (np.eye(3), np.zeros(3))}
    est_R: dict[int, list] = {}
    est_t: dict[int, list] = {}
    undecidable: set[int] = set()
    processed: set[int] = set()

    while True:
        progressed = False
        for cam_idx, cabs in by_view.items():
            if cam_idx in processed:
                continue
            anchors = [ci for ci in cabs
                       if ci in known and len(cabs[ci]) >= min_corners
                       and _branches(cam_idx, ci) is not None]
            if not anchors:
                continue
            # Camera pose: candidates are, per anchor, the all-points ITERATIVE
            # pose first and then the IPPE branches; scored by total reprojection
            # over all anchors. Strict-improvement comparison keeps the iterative
            # candidate on ties (IPPE's fronto-parallel degenerate zone reprojects
            # its small-tilt-wrong branches just as well).
            best = None
            for ci in anchors:
                cand = []
                it_pose = _iterative_pose(cabs[ci])
                if it_pose is not None:
                    cand.append(it_pose)
                branches_a, _m = _branches(cam_idx, ci)
                cand.extend(branches_a)
                for Rb, tb in cand:
                    R_cw = Rb @ known[ci][0].T
                    t_cw = tb - R_cw @ known[ci][1]
                    score = sum(_rms_via_campose(R_cw, t_cw, known[ck], cabs[ck])
                                for ck in anchors)
                    if best is None or score < best[0] - 1e-9:
                        best = (score, R_cw, t_cw)
            # Joint multi-anchor refinement: stack every anchor's (world, pixel)
            # correspondences (world = the anchor's known pose applied to its
            # locals) and solve ONE PnP over the combined — wider, generally
            # non-planar — target. On a curved wall two adjacent anchors already
            # break planarity, pinning the camera far better than any single
            # cabinet; this keeps chained init drift from compounding into a BA
            # local minimum on long segmented captures.
            obj_w: list[np.ndarray] = []
            img_w: list[np.ndarray] = []
            for ck in anchors:
                R_w, t_w = known[ck]
                for p_l, px in cabs[ck]:
                    obj_w.append(R_w @ p_l + t_w)
                    img_w.append(px)
            if len(obj_w) >= 6:
                try:
                    ok_j, rvec_j, tvec_j = cv2.solvePnP(
                        np.asarray(obj_w, dtype=np.float64),
                        np.asarray(img_w, dtype=np.float64),
                        K, None, flags=cv2.SOLVEPNP_SQPNP)
                except cv2.error:
                    ok_j = False
                if ok_j and np.isfinite(rvec_j).all() and np.isfinite(tvec_j).all():
                    R_cw_j = cv2.Rodrigues(np.asarray(rvec_j, dtype=float))[0]
                    t_cw_j = np.asarray(tvec_j, dtype=float).reshape(3)
                    score = sum(_rms_via_campose(R_cw_j, t_cw_j, known[ck], cabs[ck])
                                for ck in anchors)
                    if best is None or score < best[0] - 1e-9:
                        best = (score, R_cw_j, t_cw_j)
            if best is None or not np.isfinite(best[0]):
                continue
            processed.add(cam_idx)
            progressed = True
            _score, R_cw, t_cw = best
            for cab_idx, corners in cabs.items():
                # Skip cabinets already promoted to anchors (their pose is set);
                # same-wave views still accumulate freely so the SVD-average /
                # median aggregation keeps its multi-view redundancy.
                if cab_idx in known or len(corners) < min_corners:
                    continue
                res = _branches(cam_idx, cab_idx)
                if res is None:
                    continue
                branches, _mask = res
                world_branches = [(R_cw.T @ Rc1, R_cw.T @ (tc1 - t_cw)) for Rc1, tc1 in branches]
                # When branches have very different reprojection quality (one is the
                # correct pose, the other the IPPE mirror), reprojection dominates the
                # nominal-normal angle check.  Project inlier corners through each
                # camera_from_cab branch: the correct one reprojects well, the mirror
                # has ~100px error.  Skip the normal-based disambiguation (which can
                # fail when the cabinet is far from nominal, e.g. desktop monitors at
                # arbitrary angles) when reproj clearly resolves the ambiguity.
                obj_in = np.array([p for p, _ in corners], dtype=np.float64)[_mask]
                img_in = np.array([px for _, px in corners], dtype=np.float64)[_mask]
                branch_rms = []
                for Rc1, tc1 in branches:
                    proj, _ = cv2.projectPoints(obj_in, *cv2.Rodrigues(Rc1)[0:1],
                                                tc1.reshape(3,1), K, None)
                    branch_rms.append(float(np.sqrt(
                        ((proj.reshape(-1,2) - img_in)**2).sum(axis=1).mean())))
                if len(branch_rms) >= 2 and max(branch_rms) - min(branch_rms) > 10.0:
                    chosen = world_branches[int(np.argmin(branch_rms))]
                else:
                    n_nominal = np.asarray(nominal_poses[cab_idx][0], dtype=float) @ np.array([0.0, 0.0, 1.0])
                    chosen = _disambiguate_world_branch(world_branches, R_root_nominal.T @ n_nominal)
                if chosen == "undecidable":
                    undecidable.add(cab_idx)
                    continue
                est_R.setdefault(cab_idx, []).append(chosen[0])
                est_t.setdefault(cab_idx, []).append(chosen[1])
        newly = [ci for ci in est_R if ci not in known]
        for ci in newly:
            known[ci] = (_avg_rotation(est_R[ci]),
                         np.median(np.array(est_t[ci]), axis=0))
        if not newly and not progressed:
            break

    out: dict[int, tuple] = {}
    for cab_idx, rotations in est_R.items():
        undecidable.discard(cab_idx)  # at least one view resolved it
        t = np.median(np.array(est_t[cab_idx]), axis=0)
        out[cab_idx] = (_avg_rotation(rotations), t)
    return out, undecidable


def _pnp_camera(
    cam_idx: int,
    root_idx: int,
    init_cabinets: dict[int, tuple[np.ndarray, np.ndarray]],
    per_view_cab_corners: dict[tuple[int, int], list[tuple[np.ndarray, np.ndarray]]],
    K: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    """Initialize one camera's world-to-camera pose via PnP.

    Joint PnP over ALL cabinets this view sees (world points from each
    cabinet's init pose): a wider, usually non-planar target that avoids the
    single-cabinet IPPE branch-0 wobble near fronto-parallel (FIX-3: that
    wobble left segmented-capture end cameras ~20deg off; Huber BA then wrote
    their whole view off as outliers and Stage B amputated it). Falls back to
    root-only PnP, then single-cabinet composition, then a neutral guess.
    """
    obj_w: list[np.ndarray] = []
    img_w: list[np.ndarray] = []
    for (ci, cab_idx), corners in per_view_cab_corners.items():
        if ci != cam_idx or len(corners) < MIN_PNP_CORNERS:
            continue
        R_w, t_w = init_cabinets[cab_idx]
        for p_l, px in corners:
            obj_w.append(R_w @ p_l + t_w)
            img_w.append(px)
    if len(obj_w) >= MIN_PNP_CORNERS:
        try:
            ok_j, rvec_j, tvec_j = cv2.solvePnP(
                np.asarray(obj_w, dtype=np.float64), np.asarray(img_w, dtype=np.float64),
                K, None, flags=cv2.SOLVEPNP_SQPNP)
        except cv2.error:
            ok_j = False
        if ok_j and np.isfinite(rvec_j).all() and np.isfinite(tvec_j).all():
            return cv2.Rodrigues(np.asarray(rvec_j, dtype=float))[0], \
                   np.asarray(tvec_j, dtype=float).reshape(3)

    # Try root alone.
    root_corners = per_view_cab_corners.get((cam_idx, root_idx), [])
    if len(root_corners) >= MIN_PNP_CORNERS:
        pose = _solve_pnp(root_corners, K)
        if pose is not None:
            return pose

    # Fall back to any other cabinet this view sees, composing with the inverse
    # of its nominal world_from_cabinet pose: T_cam_world = T_cam_cab @ T_cab_world,
    # where T_cab_world = inverse(world_from_cabinet).
    for (ci, cab_idx), corners in per_view_cab_corners.items():
        if ci != cam_idx or cab_idx == root_idx or len(corners) < MIN_PNP_CORNERS:
            continue
        cam_from_cab = _solve_pnp(corners, K)
        if cam_from_cab is None:
            continue
        Rcc, tcc = cam_from_cab  # camera_from_cabinet: x_cam = Rcc·p_local + tcc
        # init_cabinets stores world_from_cabinet (BA: xw = R_wc·p_local + t_wc).
        # camera_from_world = camera_from_cabinet ∘ inverse(world_from_cabinet).
        R_wc, t_wc = init_cabinets[cab_idx]  # world_from_cabinet (nominal)
        R = Rcc @ R_wc.T
        t = tcc - R @ t_wc
        return R, t

    # Neutral fallback: identity rotation, pushed back along +z.
    return np.eye(3), np.array([0.0, 0.0, 2200.0])
