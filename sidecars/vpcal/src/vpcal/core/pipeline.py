"""quick.run pipeline orchestration (spec §3.1): validate → detect → solve → report.

Detection has two paths: when the session directory contains an
``observations.jsonl`` (exact correspondences, produced by ``vpcal simulate``)
it is used directly so the solver can be verified to < 0.01 px; otherwise the
real image detector runs on the captured frames.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from numpy.typing import NDArray

from vpcal.core.coordinates import m_rh_from_source
from vpcal.core.detector import detect_markers
from vpcal.core.errors import PreconditionError
from vpcal.core.observations import Observation, marker_id_from_dict
from vpcal.core.projection import CameraIntrinsics
from vpcal.core.screen_geometry import marker_world_map
from vpcal.core.solver import (
    MIN_OBSERVATIONS_SOFT,
    MIN_POSES_SOFT,
    cv2_bootstrap_lens,
    solve_calibration,
)
from vpcal.core.solver_scipy import LensFreedom, SolverResult
from vpcal.core.transforms import make_transform
from vpcal.core.validator import list_images, validate_session
from vpcal.io.frame_matching import match_frames
from vpcal.io.screen_io import load_screen
from vpcal.io.tracking_io import load_tracking, to_internal_pose, to_internal_poses
from vpcal.models.session import SessionConfig
from vpcal.qa.coverage import _pose_distribution, _sensor_coverage, coverage_report
from vpcal.qa.observability import determine_lens_freedom, validate_lens_estimate
from vpcal.qa.reprojection import reprojection_report

Array = NDArray[np.float64]
_M_UE = m_rh_from_source("unreal")[:3, :3]


def _resolve(session_dir: Path, p: str) -> Path:
    path = Path(p)
    return path if path.is_absolute() else session_dir / path


def _load_exact_observations(
    path: Path, world_map: dict, poses: dict[int, tuple[Array, Array]]
) -> list[Observation]:
    """Load exact correspondences; ``world_map`` values are already internal RH."""
    observations: list[Observation] = []
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        rec = json.loads(line)
        mid = marker_id_from_dict(rec["marker_id"])
        world = world_map.get(mid)
        pose = poses.get(rec["frame_id"])
        if world is None or pose is None:
            continue
        q, t = pose
        observations.append(
            Observation(
                pixel_u=float(rec["pixel_u"]),
                pixel_v=float(rec["pixel_v"]),
                world_rh=tuple(world),
                track_q=tuple(q),
                track_t=tuple(t),
                frame_id=int(rec["frame_id"]),
                marker_id=mid,
                sigma_px=float(rec.get("sigma_px", 1.0)),
            )
        )
    return observations


def _detect_observations(
    session: SessionConfig,
    session_dir: Path,
    images: list[str],
    world_map: dict,
    frames,
) -> tuple[list[Observation], dict]:
    """Detect markers in the matched images.

    Returns ``(observations, detection_report)``.  The report carries the QA
    counters: topology-rejected detections (A2.3) and whether normal−inverted
    differencing was active for every image (A2.4 — a missing inverted sibling
    is a warning, never a silent degradation).
    """
    import cv2
    import warnings as _warnings

    frame_ids = [f.frame_id for f in frames]
    if session.tracking.frame_matching == "timestamp":
        raise PreconditionError(
            "frame_matching='timestamp' needs per-image timestamps (EXIF), which "
            "Phase 1 cannot extract offline; use 'frame_id' or 'line_number'",
            details={"frame_matching": "timestamp"},
        )
    match = match_frames(
        images, frame_ids, strategy=session.tracking.frame_matching,
        timestamp_tolerance_s=session.tracking.timestamp_tolerance_s,
    )
    observations: list[Observation] = []
    rejected_topology = 0
    images_processed = 0
    images_differenced = 0
    report_warnings: list[str] = []
    for fm in match.matched:
        frame = frames[fm.tracking_index]
        img = cv2.imread(fm.image, cv2.IMREAD_GRAYSCALE)
        if img is None:
            continue
        images_processed += 1
        inv = None
        inv_path = fm.image.replace("/normal/", "/inverted/")
        if inv_path != fm.image and Path(inv_path).exists():
            inv = cv2.imread(inv_path, cv2.IMREAD_GRAYSCALE)
        if inv is None:
            msg = f"inverted frame not found for {fm.image}; differencing disabled for this image"
            report_warnings.append(msg)
            _warnings.warn(msg, stacklevel=2)
        else:
            images_differenced += 1
        # Use the pose of the exact matched record (frames[tracking_index]); a
        # frame_id lookup would pick the last duplicate, not the matched one.
        q, t = to_internal_pose(
            frame, session.tracking.coordinate_system, session.tracking.custom_transform
        )
        for det in detect_markers(img, frame_id=frame.frame_id, inverted=inv):
            if det.confidence < 1.0:
                # Topology-inconsistent detection: hard-reject (A2.3) — decode
                # may be valid but the position contradicts its neighbours.
                rejected_topology += 1
                continue
            world = world_map.get(det.marker_id)
            if world is None:
                continue
            observations.append(
                Observation(
                    pixel_u=det.pixel_u, pixel_v=det.pixel_v, world_rh=tuple(world),
                    track_q=tuple(q), track_t=tuple(t), frame_id=det.frame_id, marker_id=det.marker_id,
                    sigma_px=1.0,
                )
            )
    report = {
        "detection_rejected_topology": rejected_topology,
        "differencing_enabled": images_processed > 0 and images_differenced == images_processed,
        "images_processed": images_processed,
        "images_differenced": images_differenced,
        "warnings": report_warnings,
    }
    return observations, report


def _detect_observations_physical(
    session: SessionConfig,
    images: list[str],
    world_map: dict,
    marker_map,
    frames,
) -> tuple[list[Observation], dict]:
    """Detect physical ArUco/AprilTag markers in the matched images (AR path).

    Same contract as :func:`_detect_observations`; the report counts markers
    that were detected but absent from the map (warning, never solved) and
    map markers that were never seen (coverage gap).
    """
    import cv2

    from vpcal.core.detector_physical import detect_physical_markers

    frame_ids = [f.frame_id for f in frames]
    if session.tracking.frame_matching == "timestamp":
        raise PreconditionError(
            "frame_matching='timestamp' needs per-image timestamps (EXIF), which "
            "the offline pipeline cannot extract; use 'frame_id' or 'line_number'",
            details={"frame_matching": "timestamp"},
        )
    match = match_frames(
        images, frame_ids, strategy=session.tracking.frame_matching,
        timestamp_tolerance_s=session.tracking.timestamp_tolerance_s,
    )
    observations: list[Observation] = []
    images_processed = 0
    detected_total = 0
    unknown_total = 0
    observed_markers: set[str] = set()
    for fm in match.matched:
        frame = frames[fm.tracking_index]
        img = cv2.imread(fm.image, cv2.IMREAD_GRAYSCALE)
        if img is None:
            continue
        images_processed += 1
        q, t = to_internal_pose(
            frame, session.tracking.coordinate_system, session.tracking.custom_transform
        )
        dets, counters = detect_physical_markers(img, marker_map, frame_id=frame.frame_id)
        detected_total += counters["detected_markers"]
        unknown_total += counters["unknown_markers"]
        for det in dets:
            world = world_map.get(det.marker_id)
            if world is None:
                continue
            observed_markers.add(det.marker_id.marker)
            observations.append(
                Observation(
                    pixel_u=det.pixel_u, pixel_v=det.pixel_v, world_rh=tuple(world),
                    track_q=tuple(q), track_t=tuple(t), frame_id=det.frame_id, marker_id=det.marker_id,
                    # Four corners on one rigid tag are correlated; sigma=2
                    # gives the quad approximately one point's total weight.
                    sigma_px=2.0,
                )
            )
    never_detected = sorted(
        {m.marker_id for m in marker_map.detectable_markers()} - observed_markers
    )
    warnings = []
    if unknown_total:
        warnings.append(
            f"{unknown_total} detected marker(s) are not in the marker map — ignored"
        )
    report = {
        "images_processed": images_processed,
        "detected_markers": detected_total,
        "unknown_markers": unknown_total,
        "map_markers_never_detected": never_detected,
        "warnings": warnings,
        # Keys shared with the VP-QSP report so downstream consumers need no branch.
        "detection_rejected_topology": 0,
        "differencing_enabled": None,
        "images_differenced": 0,
    }
    return observations, report


def _handeye_initial(
    session: SessionConfig,
    raw_session: dict,
    observations: list[Observation],
    intr: CameraIntrinsics,
    init_C: tuple[Array, Array],
    *,
    force: bool = False,
) -> tuple[tuple[Array, Array], dict | None]:
    """Closed-form hand-eye initialisation of ``T_C_from_B`` (A3.1).

    The closed-form solution is APPLIED as the solve's ``init_C`` when the user
    forces it (``--handeye-init``) or when ``refine_tracker_to_camera`` is on
    without a user prior (refinement needs a starting point inside the LM
    convergence basin; identity is almost never the real rig geometry).

    Otherwise (default lens-fixed path, prior fully trusted) it runs as a
    DIAGNOSTIC only: the solution is reported and a large gap to the trusted
    prior raises a QA warning, but ``init_C`` is untouched — the Phase-1
    simulate→solve closure stays bit-exact.

    Degenerate capture (pure translation): forced mode raises
    :class:`PreconditionError` with re-shoot guidance; otherwise the report
    records the skip and the run continues on the existing prior.
    """
    from vpcal.core.errors import PreconditionError as _PE
    from vpcal.core.handeye import closed_form_handeye
    from vpcal.core.transforms import quat_multiply

    user_prior_given = "tracker_to_camera_prior" in (raw_session.get("solver") or {})
    apply = force or (session.solver.refine_tracker_to_camera and not user_prior_given)
    try:
        he = closed_form_handeye(observations, intr)
    except _PE as exc:
        if force:
            raise
        return init_C, {
            "applied": False,
            "reason": str(exc),
            "warnings": (
                [f"hand-eye initialisation skipped: {exc}"] if apply else []
            ),
        }
    report: dict = {"applied": apply, "warnings": [], **he.diagnostics}
    report["camera_from_tracker_q"] = [float(x) for x in he.camera_from_tracker_q]
    report["camera_from_tracker_t"] = [float(x) for x in he.camera_from_tracker_t]

    q_prior, t_prior = init_C
    q_inv = np.array([q_prior[0], -q_prior[1], -q_prior[2], -q_prior[3]])
    dq = quat_multiply(q_inv, np.asarray(he.camera_from_tracker_q))
    rot_diff_deg = float(np.degrees(2.0 * np.arccos(np.clip(abs(dq[0]), -1.0, 1.0))))
    t_diff_mm = float(np.linalg.norm(he.camera_from_tracker_t - np.asarray(t_prior)))
    report["prior_rotation_diff_deg"] = rot_diff_deg
    report["prior_translation_diff_mm"] = t_diff_mm
    if rot_diff_deg > 5.0 or t_diff_mm > 20.0:
        source = "user tracker_to_camera_prior" if user_prior_given else "identity default prior"
        report["warnings"].append(
            f"{source} differs from the closed-form hand-eye solution by "
            f"{rot_diff_deg:.1f}° / {t_diff_mm:.1f} mm — the prior is suspect"
            + ("" if apply else
               "; consider refine_tracker_to_camera=true or --handeye-init")
        )
    if not apply:
        return init_C, report
    return (np.asarray(he.camera_from_tracker_q), np.asarray(he.camera_from_tracker_t)), report


def _select_holdout(session: SessionConfig, observations: list[Observation]) -> set[int]:
    """Frame ids held out of the solve for independent validation (A4).

    Explicit ``holdout_frames`` wins; otherwise ``holdout_ratio`` of the sorted
    frame ids, evenly spaced (deterministic).  Raises when the remaining
    training frames would fall below the solver's hard minimum.
    """
    from vpcal.core.solver import MIN_POSES_HARD

    v = session.validation
    if v is None:
        return set()
    fids = sorted({o.frame_id for o in observations})
    if v.holdout_frames is not None:
        hold = set(v.holdout_frames) & set(fids)
    else:
        k = int(round(len(fids) * v.holdout_ratio))
        if k < 1:
            return set()
        idx = np.unique(np.round(np.linspace(0, len(fids) - 1, k)).astype(int))
        hold = {fids[i] for i in idx}
    if len(fids) - len(hold) < MIN_POSES_HARD:
        raise PreconditionError(
            f"holdout leaves {len(fids) - len(hold)} training poses "
            f"(< {MIN_POSES_HARD}); capture more poses or reduce the holdout",
            details={"total_frames": len(fids), "holdout_frames": sorted(hold)},
        )
    return hold


def _confidence(num_poses: int, total_obs: int, rms: float, validation_rms: float | None = None) -> str:
    if num_poses < MIN_POSES_SOFT or total_obs < MIN_OBSERVATIONS_SOFT:
        return "very_low"
    # Held-out validation RMS outranks in-sample RMS when available (A4):
    # in-sample self-consistency cannot certify the perspective.
    eff = validation_rms if validation_rms is not None else rms
    if eff < 0.5:
        return "high"
    if eff < 1.5:
        return "medium"
    return "low"


def _lens_profile_from_intr(intr: CameraIntrinsics, ref):
    """Build a LensProfile from estimated intrinsics, borrowing ref's sensor dims."""
    from vpcal.models.lens import BrownConradyDistortion, LensProfile

    w, h = ref.image_width_px, ref.image_height_px
    sw, sh = ref.sensor_width_mm, ref.sensor_height_mm
    return LensProfile(
        focal_length_mm=intr.fx * sw / w,
        sensor_width_mm=sw, sensor_height_mm=sh,
        principal_point_offset_mm=((intr.cx - w / 2.0) * sw / w, (intr.cy - h / 2.0) * sh / h),
        image_width_px=w, image_height_px=h,
        distortion=BrownConradyDistortion(k1=intr.k1, k2=intr.k2, k3=intr.k3, p1=intr.p1, p2=intr.p2),
        # QLE never estimates the entrance pupil — keep the nominal offset so
        # the exported lens matches what the solver actually used.
        entrance_pupil_offset_mm=ref.entrance_pupil_offset_mm,
    )


def _apply_lens_values(base: CameraIntrinsics, values: dict | None) -> CameraIntrinsics:
    """Return ``base`` with the estimated free-param values applied (QLE §5.4)."""
    import dataclasses

    values = values or {}
    over: dict = {}
    if "focal_scale" in values:
        over["fx"] = base.fx * values["focal_scale"]
        over["fy"] = base.fy * values["focal_scale"]
    for k in ("cx", "cy", "k1", "k2"):
        if k in values:
            over[k] = values[k]
    return dataclasses.replace(base, **over) if over else base


def _cross_subset_deltas(
    observations: list[Observation], seed_intr: CameraIntrinsics,
    lens_free: LensFreedom, solver_kwargs: dict,
) -> dict[str, float] | None:
    """Refine k1 on two disjoint pose halves; return ``{"k1": |Δk1|}`` (QLE §5.3 #3).

    Returns None when there are too few poses to split (< 3 per half) or either
    sub-solve fails to produce a k1 — the cross-subset gate is then skipped.
    """
    frame_ids = sorted({o.frame_id for o in observations})
    if len(frame_ids) < 6:
        return None
    mid = len(frame_ids) // 2
    a_ids, b_ids = set(frame_ids[:mid]), set(frame_ids[mid:])
    obs_a = [o for o in observations if o.frame_id in a_ids]
    obs_b = [o for o in observations if o.frame_id in b_ids]
    try:
        ra = solve_calibration(obs_a, seed_intr, lens_free=lens_free, **solver_kwargs)
        rb = solve_calibration(obs_b, seed_intr, lens_free=lens_free, **solver_kwargs)
    except Exception:  # noqa: BLE001
        return None
    k1a = (ra.lens_values or {}).get("k1")
    k1b = (rb.lens_values or {}).get("k1")
    if k1a is None or k1b is None:
        return None
    return {"k1": abs(float(k1a) - float(k1b))}


def _estimate_lens(
    session: SessionConfig,
    observations: list[Observation],
    nominal_intr: CameraIntrinsics,
    poses: dict[int, tuple[Array, Array]],
    init_C: tuple[Array, Array],
    prefer_cpp: bool,
    holdout_obs: list[Observation] | None = None,
) -> dict:
    """Run the full Quick Lens Estimate flow (QLE §5.1 Steps A–E).

    Returns a dict with the final solver result, the effective intrinsics, the
    baseline/refined RMS, and the pre/post gate reports.

    With ``holdout_obs`` (A4), the post-gate "did it actually improve"
    criterion is evaluated on the held-out frames instead of in-sample —
    freed lens params absorbing screen/tracking error inflate the in-sample
    improvement but not the validation one (architecture discipline #3).
    """
    cfg = session.solver.lens_estimate
    refine_C = session.solver.refine_tracker_to_camera
    # Quick Lens Estimate runs on the scipy backend: the observability gates
    # require the full parameter covariance / correlation / condition number,
    # which scipy provides directly (QLE spec §4 / §5).  The Ceres backend stays
    # the fast primary for the default lens-fixed spatial solve.  ``prefer_cpp``
    # is intentionally ignored here.
    skw = dict(
        init_C=init_C, refine_C=refine_C,
        robust_scale=session.solver.robust_loss_scale,
        robust_loss=session.solver.robust_loss,
        prior_weight_rotation=session.solver.prior_weight_rotation,
        prior_weight_translation=session.solver.prior_weight_translation,
        max_iterations=session.solver.max_iterations,
        timeout_seconds=session.solver.timeout_seconds, prefer_cpp=False,
    )

    # Step A — spatial-only baseline (nominal lens, always recorded).
    baseline = solve_calibration(observations, nominal_intr, **skw)
    b_t2s = (np.asarray(baseline.tracker_to_stage_q), np.asarray(baseline.tracker_to_stage_t))
    b_c2t = (np.asarray(baseline.camera_from_tracker_q), np.asarray(baseline.camera_from_tracker_t))
    baseline_rms = reprojection_report(observations, nominal_intr, b_t2s, b_c2t)["global_rms_px"]
    baseline_val_rms = (
        reprojection_report(holdout_obs, nominal_intr, b_t2s, b_c2t)["global_rms_px"]
        if holdout_obs else None
    )

    seed_intr = cv2_bootstrap_lens(observations, nominal_intr) if cfg.cv2_bootstrap else nominal_intr
    sensor_regions = _sensor_coverage(observations, nominal_intr)["regions"]
    # Angular spread must come from the poses that ACTUALLY produced observations,
    # not every tracking record — extra unmatched frames would inflate the spread
    # and wrongly release cx/cy (QLE review P2).
    observed_poses = [poses[fid] for fid in {o.frame_id for o in observations} if fid in poses]
    angular = _pose_distribution(observed_poses)["angular_spread_deg"]

    # Step B — pre-solve gate.
    lens_free, pre = determine_lens_freedom(
        cfg, session.lens, observations, nominal_intr, refine_C=refine_C,
        baseline_rms_px=baseline_rms, condition_number=baseline.condition_number,
        angular_spread_deg=angular, sensor_regions=sensor_regions,
    )

    if not lens_free.any_free:
        return {
            "result": baseline, "intr": nominal_intr, "baseline_rms": baseline_rms,
            "refined_rms": baseline_rms, "pre": pre, "post": None, "lens_free": lens_free,
        }

    # Step C — joint solve.
    joint = solve_calibration(observations, seed_intr, lens_free=lens_free, **skw)
    j_intr = _apply_lens_values(seed_intr, joint.lens_values)
    j_t2s = (np.asarray(joint.tracker_to_stage_q), np.asarray(joint.tracker_to_stage_t))
    j_c2t = (np.asarray(joint.camera_from_tracker_q), np.asarray(joint.camera_from_tracker_t))
    refined_rms = reprojection_report(observations, j_intr, j_t2s, j_c2t)["global_rms_px"]

    cross = _cross_subset_deltas(observations, seed_intr, lens_free, skw) if lens_free.free_k1 else None

    # Step D — post-solve gate.  The improvement criterion runs on validation
    # RMS when a holdout exists (A4): in-sample improvement can come from the
    # lens absorbing screen/tracking error, which a holdout exposes.
    if baseline_val_rms is not None:
        refined_val_rms = reprojection_report(holdout_obs, j_intr, j_t2s, j_c2t)["global_rms_px"]
        gate_baseline, gate_refined = baseline_val_rms, refined_val_rms
        improvement_basis = "validation"
    else:
        gate_baseline, gate_refined = baseline_rms, refined_rms
        improvement_basis = "in_sample"
    post, surviving = validate_lens_estimate(
        lens_free, joint, cfg, baseline_rms_px=gate_baseline,
        refined_rms_px=gate_refined, cross_subset_deltas=cross,
    )
    post["improvement_basis"] = improvement_basis

    # Step E — re-solve with surviving freedom if anything reverted.
    if set(surviving.free_names) != set(lens_free.free_names):
        if surviving.any_free:
            final = solve_calibration(observations, seed_intr, lens_free=surviving, **skw)
            final_intr = _apply_lens_values(seed_intr, final.lens_values)
        else:
            final, final_intr = baseline, nominal_intr
    else:
        final, final_intr = joint, j_intr

    f_t2s = (np.asarray(final.tracker_to_stage_q), np.asarray(final.tracker_to_stage_t))
    f_c2t = (np.asarray(final.camera_from_tracker_q), np.asarray(final.camera_from_tracker_t))
    final_rms = reprojection_report(observations, final_intr, f_t2s, f_c2t)["global_rms_px"]

    return {
        "result": final, "intr": final_intr, "baseline_rms": baseline_rms,
        "refined_rms": final_rms, "pre": pre, "post": post, "lens_free": lens_free,
    }


def _reason_for(name: str, pre: dict, post: dict | None) -> str:
    """Human-readable reason a lens param was not kept (pre-lock or post-revert)."""
    if post and name in post.get("params_reverted", []):
        reasons = post["verdicts"].get(name, {}).get("reasons", [])
        return "; ".join(reasons) or "reverted post-solve"
    fam = "cx/cy" if name in ("cx", "cy") else ("k1/k2" if name in ("k1", "k2") else name)
    for f in pre.get("flags", []):
        if fam in f or name in f:
            return f
    return "locked (not freed)"


def _build_estimated_lens(session: SessionConfig, est: dict):
    """Assemble the :class:`EstimatedLens` block from the estimate result (QLE §6.1)."""
    from vpcal.models.calibration import EstimatedLens, EstimatedLensParam

    lens = session.lens
    cfg = session.solver.lens_estimate
    final, pre, post = est["result"], est["pre"], est["post"]
    kept = set((final.lens_values or {}).keys())
    val_map = final.lens_values or {}
    std_map = final.lens_std or {}
    nominal = CameraIntrinsics.from_lens(lens)
    w, h, sw, sh = lens.image_width_px, lens.image_height_px, lens.sensor_width_mm, lens.sensor_height_mm

    flags = list(pre.get("flags", []))
    if post:
        for n, v in post["verdicts"].items():
            if not v["kept"] and v["reasons"]:
                flags.append(f"{n} reverted: {'; '.join(v['reasons'])}")

    def make(name: str, nominal_value: float, kept_value, kept_std) -> EstimatedLensParam:
        if name in kept:
            return EstimatedLensParam(value=kept_value, std=kept_std, observable=True)
        return EstimatedLensParam(
            value=nominal_value, std=None, observable=False,
            locked_reason=_reason_for(name, pre, post),
        )

    focal = None
    if cfg.refine_focal:
        scale = val_map.get("focal_scale")
        sd = std_map.get("focal_scale")
        focal = make(
            "focal_scale", lens.focal_length_mm,
            (lens.focal_length_mm * scale) if scale is not None else lens.focal_length_mm,
            (lens.focal_length_mm * sd) if sd is not None else None,
        )

    pp = None
    if {"cx", "cy"} & cfg.params:
        cx_sd = std_map.get("cx")
        cy_sd = std_map.get("cy")
        cx_param = make(
            "cx", (nominal.cx - w / 2.0) * sw / w,
            ((val_map.get("cx", nominal.cx)) - w / 2.0) * sw / w,
            (cx_sd * sw / w) if cx_sd is not None else None,
        )
        cy_param = make(
            "cy", (nominal.cy - h / 2.0) * sh / h,
            ((val_map.get("cy", nominal.cy)) - h / 2.0) * sh / h,
            (cy_sd * sh / h) if cy_sd is not None else None,
        )
        pp = [cx_param, cy_param]

    k1 = make("k1", nominal.k1, val_map.get("k1", nominal.k1), std_map.get("k1")) if "k1" in cfg.params else None
    k2 = make("k2", nominal.k2, val_map.get("k2", nominal.k2), std_map.get("k2")) if "k2" in cfg.params else None

    return EstimatedLens(
        focal_length_mm=focal, principal_point_offset_mm=pp,
        distortion_k1=k1, distortion_k2=k2,
        spatial_only_rms_px=est["baseline_rms"], refined_rms_px=est["refined_rms"],
        identifiability_flags=flags,
        confidence=(post["confidence"] if post else "low"),
    )


def run_quick(
    session: SessionConfig,
    session_dir: str | Path,
    output_dir: str | Path,
    *,
    raw_session: dict,
    stage: str | None = None,
    dry_run: bool = False,
    per_marker: bool = False,
    prefer_cpp: bool = True,
    handeye_init: bool = False,
) -> dict:
    """Execute the quick calibration pipeline; returns a structured result dict."""
    from vpcal import __version__

    session_dir = Path(session_dir)
    out = Path(output_dir)

    # ── Stage 0: validate ──────────────────────────────────────────
    validation = validate_session(session, session_dir, raw_session=raw_session)

    if dry_run:
        return {
            "exit_code": 0,
            "dry_run_plan": {
                "stages": ["validate", "detect", "solve", "report"],
                "validation": validation,
                "output_dir": str(out),
            },
        }

    if not stage or stage == "validate":
        (out / "qa").mkdir(parents=True, exist_ok=True)
        (out / "qa" / "validation.json").write_text(json.dumps(validation, indent=2))
        if stage == "validate":
            return {"exit_code": 0, "stage": "validate", "validation": validation}

    # ── Build shared inputs ────────────────────────────────────────
    # Marker 3D truth source: LED screen (VP-QSP path, UE frame → RH) or a
    # surveyed marker map (AR path, coordinates already the RH stage frame).
    # ``world_map`` values are internal-RH in both cases.
    screen = None
    marker_map = None
    if session.marker_map is not None:
        from vpcal.core.marker_map import physical_world_map
        from vpcal.io.marker_map_io import load_marker_map

        marker_map = load_marker_map(_resolve(session_dir, session.marker_map.path))
        world_map = physical_world_map(marker_map)
        truth_name = marker_map.name or marker_map.frame_name
    else:
        screen = load_screen(_resolve(session_dir, session.screen.path))
        world_map = {
            mid: _M_UE @ w
            for mid, w in marker_world_map(
                screen, markers_per_cabinet=screen.markers_per_cabinet
            ).items()
        }
        truth_name = screen.name
    intr = CameraIntrinsics.from_lens(session.lens)
    frames = load_tracking(_resolve(session_dir, session.tracking.path))
    poses = to_internal_poses(frames, session.tracking.coordinate_system, session.tracking.custom_transform)

    # ── Stage 1: detect ────────────────────────────────────────────
    exact = session_dir / "observations.jsonl"
    if exact.exists():
        # An exact-observations sidecar next to real capture images is
        # ambiguous (detection would be silently skipped): hard error unless
        # the dataset is simulator-generated, where both legitimately coexist.
        if not raw_session.get("_simulator"):
            real_images = list_images(_resolve(session_dir, session.images.path))
            if real_images:
                raise PreconditionError(
                    "both observations.jsonl and capture images are present; the "
                    "sidecar would silently bypass image detection — remove one",
                    details={"observations": str(exact), "image_count": len(real_images)},
                )
        observations = _load_exact_observations(exact, world_map, poses)
        detection_source = "exact"
        detection_report = {"detection_rejected_topology": 0, "differencing_enabled": None,
                            "images_processed": 0, "images_differenced": 0, "warnings": []}
    else:
        images = list_images(_resolve(session_dir, session.images.path))
        if marker_map is not None:
            observations, detection_report = _detect_observations_physical(
                session, images, world_map, marker_map, frames
            )
        else:
            observations, detection_report = _detect_observations(session, session_dir, images, world_map, frames)
        detection_source = "detector"
    detection_report["detection_source"] = detection_source

    if stage == "detect":
        return {
            "exit_code": 0,
            "stage": "detect",
            "num_observations": len(observations),
            "num_poses": len({o.frame_id for o in observations}),
            "detection_source": detection_source,
            "detection": detection_report,
        }

    tracker_internal = [(poses[f.frame_id][0], poses[f.frame_id][1]) for f in frames if f.frame_id in poses]

    # ── Held-out validation split (A4): holdout frames never enter the solve ──
    holdout_ids = _select_holdout(session, observations)
    holdout_obs = [o for o in observations if o.frame_id in holdout_ids]
    train_obs = [o for o in observations if o.frame_id not in holdout_ids]

    # ── Stage 2: solve (+ optional Quick Lens Estimate, QLE spec §5) ──
    prior = session.solver.tracker_to_camera_prior
    init_C = (np.asarray(prior.rotation), np.asarray(prior.translation))
    init_C, handeye_report = _handeye_initial(
        session, raw_session, train_obs, intr, init_C, force=handeye_init
    )

    estimated_lens = None
    lens_obs = None
    if session.solver.lens_estimate.enabled:
        est = _estimate_lens(session, train_obs, intr, poses, init_C, prefer_cpp,
                             holdout_obs=holdout_obs)
        solver_result = est["result"]
        eff_intr = est["intr"]
        estimated_lens = _build_estimated_lens(session, est)
        lens_obs = {
            "pre_solve": est["pre"],
            "post_solve": est["post"],
            "summary": {
                "params_kept": (est["post"] or {}).get("params_kept", []),
                "params_reverted": (est["post"] or {}).get("params_reverted", []),
                "identifiability_flags": estimated_lens.identifiability_flags,
                "confidence": estimated_lens.confidence,
                "spatial_only_rms_px": est["baseline_rms"],
                "refined_rms_px": est["refined_rms"],
                "recommendation": (
                    "Session-coupled quick lens estimate — NON-MASTER, not cross-stage "
                    "reusable. For a reusable master lens, run offline chart calibration "
                    "(Level 5)."
                ),
            },
        }
    else:
        solver_result = solve_calibration(
            train_obs, intr,
            init_C=init_C,
            refine_C=session.solver.refine_tracker_to_camera,
            robust_scale=session.solver.robust_loss_scale,
            robust_loss=session.solver.robust_loss,
            prior_weight_rotation=session.solver.prior_weight_rotation,
            prior_weight_translation=session.solver.prior_weight_translation,
            max_iterations=session.solver.max_iterations,
            timeout_seconds=session.solver.timeout_seconds,
            prefer_cpp=prefer_cpp,
        )
        eff_intr = intr

    if stage == "solve":
        return {
            "exit_code": 0,
            "stage": "solve",
            "tracker_to_stage": {
                "rotation": list(solver_result.tracker_to_stage_q),
                "translation": list(solver_result.tracker_to_stage_t),
            },
            "solver_backend": solver_result.solver_backend,
        }

    # ── Stage 3: report ────────────────────────────────────────────
    t2s = (np.asarray(solver_result.tracker_to_stage_q), np.asarray(solver_result.tracker_to_stage_t))
    c2t = (np.asarray(solver_result.camera_from_tracker_q), np.asarray(solver_result.camera_from_tracker_t))
    reproj = reprojection_report(train_obs, eff_intr, t2s, c2t, per_marker=per_marker)
    # Pixel semantics of the solver's inlier/outlier split (D5): an inlier is a
    # per-observation reprojection error <= 3 x robust_loss_scale, in pixels.
    reproj["inlier_threshold_px"] = 3.0 * session.solver.robust_loss_scale
    # Independent reprojection on the held-out frames (A4).
    validation_rms = None
    if holdout_obs:
        validation_rms = reprojection_report(holdout_obs, eff_intr, t2s, c2t)["global_rms_px"]
        reproj["validation"] = {
            "holdout_frames": sorted(holdout_ids),
            "validation_rms_px": validation_rms,
            "num_observations": len(holdout_obs),
        }
    else:
        reproj["validation"] = "none"
    coverage = coverage_report(train_obs, eff_intr, screen, tracker_internal, marker_map=marker_map)

    # ── AR-path QA: ground plane + world-alignment uncertainty (Phase B) ──
    ground_plane = None
    world_alignment = None
    if marker_map is not None:
        from vpcal.core.marker_map import fit_ground_plane, world_alignment_uncertainty

        ground_plane = fit_ground_plane(
            marker_map,
            tolerance_mm=session.marker_map.ground_tolerance_mm,
            tolerance_deg=session.marker_map.ground_tolerance_deg,
        )
        world_alignment = world_alignment_uncertainty(marker_map)

    # ── Tracker offset backfill block (Phase E3) ───────────────────
    from vpcal.core.tracker_offsets import tracker_offsets_block

    tracker_offsets = tracker_offsets_block(
        t2s, c2t, session.tracking.coordinate_system, session.tracking.custom_transform
    )

    if lens_obs is not None:
        reproj["spatial_vs_lens_refined"] = {
            "spatial_only_rms_px": lens_obs["summary"]["spatial_only_rms_px"],
            "refined_rms_px": lens_obs["summary"]["refined_rms_px"],
            "improvement_pct": (lens_obs["post_solve"] or {}).get("improvement_pct", 0.0),
        }

    num_poses = len({o.frame_id for o in train_obs})
    total_obs = len(train_obs)
    rms = reproj["global_rms_px"]
    confidence = _confidence(num_poses, total_obs, rms, validation_rms)

    result = _assemble_result(
        session, raw_session, truth_name, solver_result, reproj, confidence, num_poses, total_obs,
        __version__, estimated_lens=estimated_lens,
        validation_rms=validation_rms, validation_observations=len(holdout_obs),
    )
    export_lens = _lens_profile_from_intr(eff_intr, session.lens) if estimated_lens is not None else session.lens
    _write_outputs(
        out, result, reproj, coverage, validation, frames, poses, t2s, c2t, export_lens, lens_obs,
        session_estimate=estimated_lens is not None, detection_report=detection_report,
        handeye_report=handeye_report, ground_plane=ground_plane,
        world_alignment=world_alignment, tracker_offsets=tracker_offsets,
    )

    qa = {"reprojection": reproj, "coverage": coverage, "detection": detection_report,
          "handeye": handeye_report, "tracker_offsets": tracker_offsets}
    if ground_plane is not None:
        qa["ground_plane"] = ground_plane
    if world_alignment is not None:
        qa["world_alignment"] = world_alignment

    exit_code = 9 if total_obs < MIN_OBSERVATIONS_SOFT else 0
    return {
        "exit_code": exit_code,
        "result": result.model_dump(mode="json"),
        "qa": qa,
        "confidence": confidence,
        "solver_backend": solver_result.solver_backend,
        "detection_source": detection_source,
        "output_dir": str(out),
    }


def _assemble_result(
    session, raw_session, truth_name, sr, reproj, confidence, num_poses, total_obs, version,
    *, estimated_lens=None, validation_rms=None, validation_observations=0,
):
    from vpcal.models.calibration import (
        CalibrationResult, CameraFromTracker, CovarianceStd, Inputs,
        ParameterCovariance, Quality, RigidTransform, SolverDiagnostics,
    )

    T_S = make_transform(np.asarray(sr.tracker_to_stage_q), np.asarray(sr.tracker_to_stage_t))
    cov = None
    if sr.covariance_std:
        cov = ParameterCovariance(available=True, tracker_to_stage_std=CovarianceStd(**sr.covariance_std))
    config_hash = "sha256:" + hashlib.sha256(json.dumps(raw_session, sort_keys=True).encode()).hexdigest()
    outlier_ratio = sr.num_outliers / max(total_obs, 1)
    return CalibrationResult(
        vpcal_version=version,
        timestamp=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        tracker_to_stage=RigidTransform(
            translation=list(sr.tracker_to_stage_t), rotation=list(sr.tracker_to_stage_q),
            matrix_4x4=[[float(x) for x in row] for row in T_S],
        ),
        tracker_to_camera=CameraFromTracker(
            translation=list(sr.camera_from_tracker_t), rotation=list(sr.camera_from_tracker_q),
            refined=session.solver.refine_tracker_to_camera,
        ),
        quality=Quality(
            reprojection_rms_px=reproj["global_rms_px"], total_observations=total_obs,
            inlier_observations=sr.num_inliers, outlier_ratio=outlier_ratio, num_poses=num_poses,
            confidence=confidence,
            validation_rms_px=validation_rms,
            validation_observations=validation_observations,
            lens_residual_pattern="radial" if reproj["lens_residual_check"]["radial_pattern_detected"] else "none",
            lens_estimate=estimated_lens,
            lens_observability_warning=estimated_lens is not None,
        ),
        inputs=Inputs(
            session_config_hash=config_hash, image_count=num_poses, screen_definition=truth_name
        ),
        solver_diagnostics=SolverDiagnostics(
            num_iterations=sr.num_iterations, initial_cost=sr.initial_cost, final_cost=sr.final_cost,
            termination_type=sr.termination_type, termination_message=sr.termination_message,
            num_residual_blocks=total_obs, num_inliers=sr.num_inliers, num_outliers=sr.num_outliers,
            outlier_ratio=outlier_ratio, solver_backend=sr.solver_backend,
            parameter_covariance=cov or ParameterCovariance(available=False),
        ),
    )


def _write_outputs(out, result, reproj, coverage, validation, frames, poses, t2s, c2t, lens, lens_obs=None,
                   *, session_estimate=False, detection_report=None, handeye_report=None,
                   ground_plane=None, world_alignment=None, tracker_offsets=None):
    from vpcal.io.export.opentrackio import export_opentrackio

    (out / "qa").mkdir(parents=True, exist_ok=True)
    (out / "export").mkdir(parents=True, exist_ok=True)
    (out / "result.json").write_text(json.dumps(result.model_dump(mode="json"), indent=2))
    (out / "qa" / "reprojection.json").write_text(json.dumps(reproj, indent=2))
    (out / "qa" / "coverage.json").write_text(json.dumps(coverage, indent=2))
    (out / "qa" / "validation.json").write_text(json.dumps(validation, indent=2))
    if detection_report is not None:
        (out / "qa" / "detection.json").write_text(json.dumps(detection_report, indent=2))
    if handeye_report is not None:
        (out / "qa" / "handeye.json").write_text(json.dumps(handeye_report, indent=2))
    if ground_plane is not None:
        (out / "qa" / "ground_plane.json").write_text(json.dumps(ground_plane, indent=2))
    if world_alignment is not None:
        (out / "qa" / "world_alignment.json").write_text(json.dumps(world_alignment, indent=2))
    if tracker_offsets is not None:
        (out / "qa" / "tracker_offsets.json").write_text(json.dumps(tracker_offsets, indent=2))
    if lens_obs is not None:
        (out / "qa" / "lens_observability.json").write_text(json.dumps(lens_obs, indent=2))
    tracker_poses = [
        (f.frame_id, f.timestamp_s, poses[f.frame_id][0], poses[f.frame_id][1])
        for f in frames if f.frame_id in poses
    ]
    export_opentrackio(
        tracker_poses, t2s, c2t, lens, out / "export" / "tracking_calibrated.jsonl",
        session_estimate=session_estimate,
    )
