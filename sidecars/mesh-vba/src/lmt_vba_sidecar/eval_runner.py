"""Run a method end-to-end on a synthetic Scene and return gauge-invariant
metrics. 'charuco' = model-constrained BA; 'free_point' = legacy ba.py for
baseline comparison.

Phase 0 note: both methods receive near-truth initialisation (true camera
poses + true cabinet translations + identity cabinet rotations) so that the
comparison isolates the accuracy difference of the optimisation model itself,
not initialisation quality.
"""
from __future__ import annotations
from typing import Callable
import numpy as np
from lmt_vba_sidecar.ipc import SimulateInput
from lmt_vba_sidecar.simulate import build_scene
from lmt_vba_sidecar.model_constrained_ba import model_constrained_ba, Observation
from lmt_vba_sidecar.evaluate import gauge_invariant_metrics, se3_aligned_holdout_rms
from lmt_vba_sidecar.observability import check_observability
from lmt_vba_sidecar import ba as legacy_ba


def reconstruct_cabinet_geometry(
    R: np.ndarray,
    t: np.ndarray,
    corners_local: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, tuple[float, float], np.ndarray]:
    """Derive cabinet center, normal, size, and world corners from pose + local corners.

    Args:
        R: (3,3) rotation matrix (board frame -> world).
        t: (3,) translation (world position of board origin).
        corners_local: (M,3) corner positions in board-local mm coords.

    Returns:
        center: (3,) world centroid of corners.
        normal: (3,) unit board normal (rotated local +Z).
        size: (width_mm, height_mm) as x-span and y-span of local corners.
        world_corners: (M,3) corners in world frame.

    Note on size: it is read directly from the known local corner model, NOT
    from the estimated (R, t). The model-constrained BA treats the emitter
    surface dimensions as a fixed (known) constraint, so size does not change
    with pose — for the 'charuco' method true/est size are identical and the
    size error is structurally 0. A non-zero size error only arises when the
    pixel-pitch / panel-size input itself is wrong (covered by Task 3.1).
    """
    world = (corners_local @ R.T) + t
    center = world.mean(0)
    normal = R @ np.array([0.0, 0.0, 1.0])
    w = float(np.ptp(corners_local[:, 0]))
    h = float(np.ptp(corners_local[:, 1]))
    return center, normal, (w, h), world


def corner_holdout_metrics(true_corners: "dict[int, np.ndarray]",
                           est_corners: "dict[int, np.ndarray]") -> dict:
    """Per-corner SE(3)-holdout metrics over the whole wall (FIX-9 headline).

    Stacks every cabinet's world corners (cabinet-major, sorted ids), aligns on
    the corners of the EVEN-ranked cabinets and scores on the ODD-ranked ones
    (disjoint sets — se3_aligned_holdout_rms's no-self-scoring contract). Unlike
    the center/normal/size metrics, this catches per-cabinet roll about the
    normal and whole-wall normal rotations (which score 0.0 there).
    Returns {holdout_rms_mm, holdout_p95_mm, holdout_max_mm}.
    """
    ids = sorted(true_corners)
    if len(ids) < 2:
        raise ValueError("corner holdout needs >= 2 cabinets (disjoint align/score split)")
    true_pts = np.vstack([true_corners[j] for j in ids])
    est_pts = np.vstack([est_corners[j] for j in ids])
    align_idx, score_idx, base = [], [], 0
    for rank, j in enumerate(ids):
        m = len(true_corners[j])
        (align_idx if rank % 2 == 0 else score_idx).extend(range(base, base + m))
        base += m
    hold = se3_aligned_holdout_rms(true_pts, est_pts,
                                   np.asarray(align_idx), np.asarray(score_idx))
    return {"holdout_rms_mm": hold["rms_mm"], "holdout_p95_mm": hold["p95_mm"],
            "holdout_max_mm": hold["max_mm"]}


def compute_eval_metrics(true_poses, est_poses, corners_local) -> dict:
    """Combined eval metrics for per-cabinet SE(3) poses over known local
    corners: the legacy gauge-invariant center/normal/size set PLUS the FIX-9
    per-corner SE(3)-holdout headline (the legacy set scores 0.0 for a cabinet
    rolled about its own normal — corner error ~60mm at 10 deg on a 500mm
    cabinet — and for all-normals-rotated-together)."""
    true_c, true_n, true_s, true_w = {}, {}, {}, {}
    est_c, est_n, est_s, est_w = {}, {}, {}, {}
    for j in sorted(true_poses):
        R, t = true_poses[j]
        true_c[j], true_n[j], true_s[j], true_w[j] = reconstruct_cabinet_geometry(R, t, corners_local[j])
        R, t = est_poses[j]
        est_c[j], est_n[j], est_s[j], est_w[j] = reconstruct_cabinet_geometry(R, t, corners_local[j])
    metrics = gauge_invariant_metrics(true_c, true_n, true_s, est_c, est_n, est_s)
    metrics.update(_holdout_or_undefined(true_w, est_w))
    return metrics


def _holdout_or_undefined(true_w, est_w) -> dict:
    """Corner-holdout metrics, or None-valued keys when they are undefined.

    The disjoint align/score split needs >= 2 cabinets; a single-cabinet
    dataset was always evaluable (size error + camera sanity), so it must not
    start failing — but a fake 0.0 would read as "perfect". None -> JSON null
    states "undefined" honestly (Codex review P2)."""
    if len(true_w) < 2:
        return {"holdout_rms_mm": None, "holdout_p95_mm": None, "holdout_max_mm": None}
    return corner_holdout_metrics(true_w, est_w)


def run_method(scene, method: str, init: str = "near_truth", design=None) -> dict:
    """Run a reconstruction method on a Scene and return eval metrics.

    Args:
        scene: Scene from simulate.build_scene.
        method: 'charuco' (model-constrained BA) or 'free_point' (legacy BA).
        init: 'near_truth' (Phase-0: true camera poses + true cabinet
            translations) or 'cold' (FIX-10a: the PRODUCTION init path —
            transitive bridging + nominal fallback + joint-PnP cameras +
            Stage-B robust solve — no truth leaks into initialisation).
        design: (CabinetArray, shape_prior) the nominal wall the production
            init disambiguates against; required for init='cold'.

    Returns:
        dict with keys from gauge_invariant_metrics:
          max_size_error_mm, rms_size_error_mm,
          max_distance_error_mm, max_angle_error_deg
        plus the FIX-9 per-corner SE(3)-holdout headline:
          holdout_rms_mm, holdout_p95_mm, holdout_max_mm
    """
    if init not in ("near_truth", "cold"):
        raise ValueError(f"unknown init {init!r}")
    check_observability(scene.observations, scene.n_cabinets, min_views=2, min_points=8)

    if method == "charuco":
        if init == "cold":
            est_c, est_n, est_s, est_w = _charuco_geometry_cold(scene, design)
        else:
            est_c, est_n, est_s, est_w = _charuco_geometry(scene)
    elif method == "free_point":
        if init == "cold":
            raise ValueError("init='cold' is only implemented for method='charuco' "
                             "(the production path); free_point is the Phase-0 baseline")
        est_c, est_n, est_s, est_w = _free_point_geometry(scene)
    else:
        raise ValueError(f"unknown method {method!r}")

    # Build ground-truth geometry from true poses
    true_c, true_n, true_s, true_w = {}, {}, {}, {}
    for j in range(scene.n_cabinets):
        R, t = scene.true_cabinet_poses[j]
        c, n, s, w = reconstruct_cabinet_geometry(R, t, scene.cabinet_corners_local[j])
        true_c[j], true_n[j], true_s[j], true_w[j] = c, n, s, w

    metrics = gauge_invariant_metrics(true_c, true_n, true_s, est_c, est_n, est_s)
    metrics.update(_holdout_or_undefined(true_w, est_w))
    return metrics


def _charuco_geometry(scene):
    """Model-constrained BA: cabinet pose is parameterised as SE(3) over the
    known metric local corners. Root cabinet gauge is fixed at I,0."""
    # Phase 0 near-truth init: use true camera poses; reset cabinet rotations
    # to identity so the BA can correct any residual pose error freely.
    init_cams = scene.true_camera_poses
    init_cabs = {
        j: (np.eye(3), scene.true_cabinet_poses[j][1].copy())
        for j in range(scene.n_cabinets)
    }
    res = model_constrained_ba(
        K=scene.K,
        observations=scene.observations,
        n_cameras=scene.n_cameras,
        n_cabinets=scene.n_cabinets,
        root_cabinet_idx=0,
        init_cameras=init_cams,
        init_cabinets=init_cabs,
    )
    est_c, est_n, est_s, est_w = {}, {}, {}, {}
    for j in range(scene.n_cabinets):
        R, t = res.cabinet_poses[j]
        c, n, s, w = reconstruct_cabinet_geometry(R, t, scene.cabinet_corners_local[j])
        est_c[j], est_n[j], est_s[j], est_w[j] = c, n, s, w
    return est_c, est_n, est_s, est_w


def _charuco_geometry_cold(scene, design):
    """FIX-10a cold init: replicate solve_and_emit's production init exactly —
    center-cabinet gauge, transitive co-visibility bridging with IPPE
    disambiguation against the nominal design, rotated nominal fallback,
    joint-PnP camera init, then the Stage-B robust solve (the production
    primary authority). Truth is never consulted. The eval metrics are
    gauge-invariant / SE(3)-aligned, so no re-expression is needed."""
    # Lazy import: reconstruct.py imports reconstruct_cabinet_geometry from
    # THIS module at import time — a module-level import here would be a cycle.
    from lmt_vba_sidecar.nominal import nominal_cabinet_poses_model_frame
    from lmt_vba_sidecar.reconstruct import (
        _ba_max_nfev,
        _nominal_init_root_frame,
        _pnp_camera,
        estimate_nonroot_cabinet_init,
        stage_b_robust_solve,
    )

    if design is None:
        raise ValueError("init='cold' needs the dataset design (cols/rows/shape_prior); "
                         "re-run `visual simulate` to regenerate meta.json")
    cab_array, shape_prior = design
    if int(cab_array.cols) * int(cab_array.rows) != scene.n_cabinets:
        raise ValueError(f"design grid {cab_array.cols}x{cab_array.rows} does not match "
                         f"the dataset's {scene.n_cabinets} cabinets")
    poses_cr = nominal_cabinet_poses_model_frame(
        cab_array.model_copy(update={"absent_cells": []}), shape_prior)
    cols = int(cab_array.cols)
    cr_of = {j: (j % cols, j // cols) for j in range(scene.n_cabinets)}
    nominal_idx = {j: poses_cr[cr_of[j]] for j in range(scene.n_cabinets)}

    per_view: dict[tuple[int, int], list] = {}
    for o in scene.observations:
        per_view.setdefault((o.camera_idx, o.cabinet_idx), []).append((o.p_local, o.pixel))

    # Gauge = center-most cabinet (mirrors solve_and_emit).
    center_m = np.mean([np.asarray(t, float) for _R, t in nominal_idx.values()], axis=0)
    gauge_idx = min(
        range(scene.n_cabinets),
        key=lambda j: (float(np.linalg.norm(np.asarray(nominal_idx[j][1], float) - center_m)),
                       cr_of[j][1], cr_of[j][0]))
    bridge, undecidable = estimate_nonroot_cabinet_init(
        per_view, gauge_idx, scene.K, nominal_poses=nominal_idx)
    if undecidable:
        raise ValueError(f"cold init: convex/concave undecidable for cabinets {sorted(undecidable)}")
    init_cabs = {}
    for j in range(scene.n_cabinets):
        if j == gauge_idx:
            init_cabs[j] = (np.eye(3), np.zeros(3))
        elif j in bridge:
            init_cabs[j] = bridge[j]
        else:
            init_cabs[j] = _nominal_init_root_frame(poses_cr, cr_of[gauge_idx], cr_of[j])
    init_cams = [_pnp_camera(ci, gauge_idx, init_cabs, per_view, scene.K)
                 for ci in range(scene.n_cameras)]
    res, _rej, _n_rej, _surv = stage_b_robust_solve(
        K=scene.K, observations=scene.observations, n_cameras=scene.n_cameras,
        n_cabinets=scene.n_cabinets, root_cabinet_idx=gauge_idx,
        init_cameras=init_cams, init_cabinets=init_cabs,
        per_cabinet_min_points=8,
        max_nfev=_ba_max_nfev(scene.n_cabinets, scene.n_cameras))
    if not res.converged:
        raise ValueError(f"cold init: BA did not converge (rms={res.rms_reprojection_px:.2f}px)")
    est_c, est_n, est_s, est_w = {}, {}, {}, {}
    for j in range(scene.n_cabinets):
        R, t = res.cabinet_poses[j]
        c, n, sz, w = reconstruct_cabinet_geometry(R, t, scene.cabinet_corners_local[j])
        est_c[j], est_n[j], est_s[j], est_w[j] = c, n, sz, w
    return est_c, est_n, est_s, est_w


def _free_point_geometry(scene):
    """Legacy free-point BA baseline: each (cabinet, corner) is an independent
    free 3D point. Cabinet center = centroid, normal = smallest PCA singular
    vector (plane normal), size = principal-axis span.

    This deliberately ignores the known metric board model — the resulting
    accuracy is structurally lower than the model-constrained method, which
    is the whole point of the comparison.
    """
    # Map (cabinet_idx, rounded_local_coord) -> sequential point index
    pt_index: dict = {}
    init_pts: list[np.ndarray] = []
    for j in range(scene.n_cabinets):
        Rb, tb = scene.true_cabinet_poses[j]   # near-truth init only
        for p in scene.cabinet_corners_local[j]:
            key = (j, tuple(np.round(p, 6).tolist()))
            if key not in pt_index:
                pt_index[key] = len(init_pts)
                init_pts.append(Rb @ p + tb)

    init_points = np.array(init_pts, float)

    # Remap Observation objects to (cam_i, pt_i, pixel) tuples for legacy API
    obs_legacy = [
        (
            o.camera_idx,
            pt_index[(o.cabinet_idx, tuple(np.round(o.p_local, 6).tolist()))],
            o.pixel,
        )
        for o in scene.observations
    ]

    res = legacy_ba.bundle_adjust(
        K=scene.K,
        dist_coeffs=np.zeros(5),
        initial_points=init_points,
        initial_cam_poses=list(scene.true_camera_poses),
        observations=obs_legacy,
        compute_covariance=False,
    )

    est_c, est_n, est_s, est_w = {}, {}, {}, {}
    for j in range(scene.n_cabinets):
        idxs = [
            pt_index[(j, tuple(np.round(p, 6).tolist()))]
            for p in scene.cabinet_corners_local[j]
        ]
        pts = res.points[idxs]
        c = pts.mean(0)
        _, _, vt = np.linalg.svd(pts - c)
        # Smallest singular vector is the plane normal. Its sign is arbitrary
        # (SVD does not fix orientation), so disambiguate against a fixed
        # reference; otherwise two cabinets can pick opposite-sign normals and
        # the pairwise normal angle flips ~180 deg (garbage angle error).
        normal = vt[2]
        reference = np.array([0.0, 0.0, 1.0])
        if normal @ reference < 0:
            normal = -normal
        # Project onto first two principal axes to measure extent
        proj = (pts - c) @ vt[:2].T
        est_c[j] = c
        est_n[j] = normal
        est_s[j] = (float(np.ptp(proj[:, 0])), float(np.ptp(proj[:, 1])))
        est_w[j] = pts

    return est_c, est_n, est_s, est_w


def pitch_sweep(
    input_builder: Callable[[float], SimulateInput],
    pitches: list[float],
) -> list[dict]:
    """Sweep LED pixel-pitch error and measure the resulting reconstruction error.

    Physical model (Task 3.1): a pitch error means the TRUE panel pitch differs
    from the NOMINAL pitch that screen_mapping assumes. simulate.build_scene with
    pixel_pitch_error_frac=p scales each cabinet's local corner grid by (1+p) and
    projects pixels from that true (scaled) geometry. To make the error MANIFEST
    (rather than cancel — the Task 0.6 finding), we reconstruct telling the BA the
    corners are at their NOMINAL positions (the scene's scaled corners / (1+p)).
    The optimiser then shrinks the whole scene by ~1/(1+p) to fit the pixels, so
    the recovered inter-cabinet distance ≈ true_distance / (1+p), giving a
    distance error ≈ true_distance · p / (1+p) that grows monotonically with p.

    Args:
        input_builder: maps a pitch error fraction -> SimulateInput whose
            noise.pixel_pitch_error_frac equals that fraction. Use pixel_sigma=0
            so the pitch mismatch is the only error source.
        pitches: list of pixel-pitch error fractions to sweep (e.g. [0.0, 0.002]).

    Returns:
        one dict per pitch: {"pixel_pitch_error_frac": p, **gauge_invariant_metrics}.
        Metrics compare the TRUE (pitch-scaled) geometry against the
        NOMINAL-reconstructed geometry.
    """
    rows: list[dict] = []
    for pitch in pitches:
        scene = build_scene(input_builder(pitch))
        scale = 1.0 + pitch

        # Nominal local corners = scene's true (scaled) corners / (1+pitch).
        # Uniform scaling makes this the clean per-corner mapping.
        nominal_corners = {
            j: scene.cabinet_corners_local[j] / scale
            for j in range(scene.n_cabinets)
        }
        # Remap each observation's p_local to its nominal counterpart; keep pixel.
        obs_nominal = [
            Observation(
                camera_idx=o.camera_idx,
                cabinet_idx=o.cabinet_idx,
                p_local=o.p_local / scale,
                pixel=o.pixel,
            )
            for o in scene.observations
        ]

        check_observability(obs_nominal, scene.n_cabinets, min_views=2, min_points=8)

        # Near-truth init, but cabinet translations rescaled to the nominal frame
        # so the optimiser starts consistent with the shrunk geometry it must find.
        init_cams = scene.true_camera_poses
        init_cabs = {
            j: (np.eye(3), scene.true_cabinet_poses[j][1].copy() / scale)
            for j in range(scene.n_cabinets)
        }
        res = model_constrained_ba(
            K=scene.K,
            observations=obs_nominal,
            n_cameras=scene.n_cameras,
            n_cabinets=scene.n_cabinets,
            root_cabinet_idx=0,
            init_cameras=init_cams,
            init_cabinets=init_cabs,
            compute_covariance=False,  # no covariance needed for the scale-error sweep
        )

        # Estimated geometry: recovered poses over the NOMINAL corners.
        est_c, est_n, est_s = {}, {}, {}
        for j in range(scene.n_cabinets):
            R, t = res.cabinet_poses[j]
            c, n, s, _ = reconstruct_cabinet_geometry(R, t, nominal_corners[j])
            est_c[j], est_n[j], est_s[j] = c, n, s

        # True geometry: true poses over the TRUE (pitch-scaled) corners.
        true_c, true_n, true_s = {}, {}, {}
        for j in range(scene.n_cabinets):
            R, t = scene.true_cabinet_poses[j]
            c, n, s, _ = reconstruct_cabinet_geometry(
                R, t, scene.cabinet_corners_local[j]
            )
            true_c[j], true_n[j], true_s[j] = c, n, s

        metrics = gauge_invariant_metrics(
            true_c, true_n, true_s, est_c, est_n, est_s
        )
        rows.append({"pixel_pitch_error_frac": pitch, **metrics})
    return rows
