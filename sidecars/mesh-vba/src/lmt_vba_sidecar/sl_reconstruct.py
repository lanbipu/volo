"""Structured-light multi-view reconstruction: N CorrespondenceFiles -> metric
per-cabinet model, via the SAME model_constrained_ba the ChArUco path uses.

The SL path differs from reconstruct.py only in observation SOURCE:
  - cabinet id    : sl_meta.dots[id].cabinet (already tagged at generation)
  - p_local mm    : sl_geometry.sl_local_mm(cabinet_rect, u, v, pitch)
  - camera pixel  : correspondence (x,y), undistorted via reconstruct._undistort_obs
Everything after observation assembly is reconstruct.solve_and_emit (shared).
"""
from __future__ import annotations

from lmt_vba_sidecar.ipc import CorrespondenceFile


def validate_sl_provenance(corr_files: list[CorrespondenceFile], *,
                           expected_sha: str, expected_screen_id: str) -> None:
    """Codex finding 4 gate: every pose file must share ONE screen_id + ONE
    sl_meta_sha256, that sha must equal the sl_meta.json actually being used,
    and the screen_id must match the project/screen. Any mismatch = stale/mixed
    capture -> ValueError (mapped to invalid_input upstream)."""
    screen_ids = {c.screen_id for c in corr_files}
    shas = {c.sl_meta_sha256 for c in corr_files}
    if len(screen_ids) != 1:
        raise ValueError(f"correspondence files disagree on screen_id: {sorted(screen_ids)}")
    if len(shas) != 1:
        raise ValueError(f"correspondence files disagree on sl_meta_sha256: {sorted(shas)}")
    (only_screen,) = screen_ids
    (only_sha,) = shas
    if only_sha != expected_sha:
        raise ValueError(
            f"sl_meta_sha256 mismatch: correspondences were decoded against "
            f"'{only_sha}' but the supplied sl_meta.json hashes to '{expected_sha}'")
    if only_screen != expected_screen_id:
        raise ValueError(
            f"screen_id '{only_screen}' in correspondences != project screen "
            f"'{expected_screen_id}'")
    # Each correspondence must be a DISTINCT camera pose. The same capture decoded
    # twice (identical source_input) would be enumerated as two cam_idx values,
    # inflating per-cabinet observed-views and bypassing the min_views=2
    # observability gate while feeding BA degenerate duplicate views.
    sources = [c.source_input for c in corr_files]
    if len(set(sources)) != len(sources):
        dupes = sorted({s for s in sources if sources.count(s) > 1})
        raise ValueError(f"duplicate correspondence source_input (same capture decoded twice?): {dupes}")


import hashlib
import json
import pathlib

import numpy as np

from lmt_vba_sidecar.io_utils import write_event
from lmt_vba_sidecar.intrinsics_io import load_intrinsics_file
from lmt_vba_sidecar.intrinsics_solve import (
    IntrinsicsRefused,
    crosscheck_intrinsics,
    solve_sl_intrinsics,
)
from lmt_vba_sidecar.ipc import (
    ErrorEvent, ProgressEvent, ReconstructStructuredLightInput, StructuredLightMeta, WarningEvent,
)
from lmt_vba_sidecar.model_constrained_ba import Observation
from lmt_vba_sidecar.nominal import (
    nominal_cabinet_poses_model_frame,
    nominal_dot_positions_world,
)
from lmt_vba_sidecar.observability import ObservabilityError, check_observability
from lmt_vba_sidecar.reconstruct import ROOT_CABINET, _undistort_obs, solve_and_emit, stage_a_prune
from lmt_vba_sidecar.sl_geometry import sl_cabinet_corners_mm, sl_local_mm


def _self_calibrate_inline(meta, corr_files, cmd):
    """Inline self-cal for --intrinsics auto: assemble per-pose object/image points
    from the reconstruct's own corr (each cabinet a nominal planar target), solve K,
    and run the anti-absorption cross-check. Returns (K, dist, image_size) or raises
    IntrinsicsRefused. When solved without an anchor on a curved wall it emits a
    no_intrinsics_anchor WarningEvent. Frame-matched (same shots as the reconstruction)."""
    # Stale sl_meta / edited layout / unsupported shape_prior surface as a ValueError
    # from nominal_dot_positions_world; map it to invalid_input (the file-intrinsics
    # branch classifies the identical condition at step 4), not an internal_error.
    try:
        dot_world = nominal_dot_positions_world(meta, cmd.project.cabinet_array, cmd.project.shape_prior)
    except ValueError as e:
        raise IntrinsicsRefused("invalid_input", f"nominal model build failed: {e}")
    # One camera: all poses must agree on camera_image_size BEFORE solving (the solver
    # keys coverage/K0/calibrate to a single size). The file branch checks this after
    # loading intrinsics; the auto branch must check it here.
    sizes = {tuple(int(v) for v in cf.camera_image_size) for cf in corr_files}
    if len(sizes) != 1:
        raise IntrinsicsRefused("invalid_input", f"correspondences disagree on camera_image_size: {sorted(sizes)}")
    object_points, image_points = [], []
    image_size = tuple(int(v) for v in corr_files[0].camera_image_size)
    for cf in corr_files:
        objp = [dot_world[int(p.id)] for p in cf.points if int(p.id) in dot_world]
        imgp = [[p.x, p.y] for p in cf.points if int(p.id) in dot_world]
        if len(objp) >= 4:
            object_points.append(np.asarray(objp, dtype=np.float32))
            image_points.append(np.asarray(imgp, dtype=np.float32))
    # Load + validate the anchor BEFORE solving: it gates allow_full_distortion, so a
    # broken/mismatched anchor must be resolved first (matching the vpqsp self-cal path).
    anchor = None
    if cmd.crosscheck_intrinsics_path:
        try:
            anchor = load_intrinsics_file(cmd.crosscheck_intrinsics_path)
        except (OSError, json.JSONDecodeError, ValueError) as e:
            # User-supplied anchor problems map to invalid_input, not an internal_error
            # traceback (the outer caller only catches IntrinsicsRefused).
            raise IntrinsicsRefused("invalid_input", f"crosscheck intrinsics load failed: {e}")
        if anchor.image_size is not None and tuple(anchor.image_size) != tuple(image_size):
            write_event(WarningEvent(event="warning", code="intrinsics_anchor_size_mismatch",
                message=(f"crosscheck anchor image_size {tuple(anchor.image_size)} != capture frame "
                         f"{tuple(image_size)}; ignoring the anchor (a pixel-domain crosscheck is "
                         f"not comparable across resolutions)")))
            anchor = None
    res = solve_sl_intrinsics(object_points, image_points, image_size, max_rms_px=1.5,
                              allow_full_distortion=anchor is not None)
    anchor_K = anchor.K if anchor is not None else None
    anchor_dist = anchor.dist if anchor is not None else None
    refusal = crosscheck_intrinsics(res, anchor_K=anchor_K, anchor_dist=anchor_dist)
    if refusal is not None:
        raise refusal
    # Without an anchor on a non-coplanar target the solve is admitted but anisotropic
    # pitch/1:1 is UNGUARDED (the flat-wall-no-anchor case was already refused above, so
    # reaching here anchorless means curved-wall). Emit a WarningEvent; the adapter collects
    # it off the event stream onto the result so it survives the headless CLI path.
    if anchor_K is None:
        write_event(WarningEvent(event="warning", code="no_intrinsics_anchor",
            message="auto intrinsics solved without an independent anchor; anisotropic pitch/1:1 "
                    "unguarded — pass --intrinsics-crosscheck <anchor.json> to validate"))
    return res.K, res.dist, image_size


def run_reconstruct_structured_light(cmd: ReconstructStructuredLightInput) -> int:
    write_event(ProgressEvent(event="progress", stage="load", percent=0.0, message="loading sl_meta + correspondences"))

    # --- 1. sl_meta: SCHEMA-validate (not raw json), so malformed meta -> invalid_input
    #         instead of an internal_error traceback. screen_id is a system-boundary
    #         check (sl_meta is an external file). ---
    meta_path = pathlib.Path(cmd.sl_meta_path)
    try:
        meta = StructuredLightMeta.model_validate_json(meta_path.read_text())
        expected_sha = hashlib.sha256(meta_path.read_bytes()).hexdigest()
    except (OSError, ValueError) as e:
        write_event(ErrorEvent(event="error", code="invalid_input", message=f"sl_meta load/validate failed: {e}", fatal=True))
        return 1
    if meta.screen_id != cmd.project.screen_id:
        write_event(ErrorEvent(event="error", code="invalid_input",
            message=f"sl_meta screen_id '{meta.screen_id}' != project screen '{cmd.project.screen_id}'", fatal=True))
        return 1

    rect_by_cr = {(c.col, c.row): tuple(int(v) for v in c.input_rect_px) for c in meta.cabinets}
    pitch_by_cr = {(c.col, c.row): (float(c.pixel_pitch_mm[0]), float(c.pixel_pitch_mm[1])) for c in meta.cabinets}
    # CANONICAL screen coords come from sl_meta, NOT the correspondence file. The
    # screen-coordinate invariant (one id -> one fixed (u,v)) must be STRUCTURAL: a
    # stale/edited corr that kept id+sha but moved (u,v) must not shift p_local.
    cab_by_id = {d.id: (tuple(d.cabinet), float(d.u), float(d.v)) for d in meta.dots}

    # --- 2. correspondence files + provenance gate ---
    from lmt_vba_sidecar.ipc import CorrespondenceFile
    corr_files: list[CorrespondenceFile] = []
    for p in cmd.correspondence_paths:
        try:
            corr_files.append(CorrespondenceFile.model_validate_json(pathlib.Path(p).read_text()))
        except (OSError, ValueError) as e:
            write_event(ErrorEvent(event="error", code="invalid_input", message=f"correspondence '{p}' unreadable: {e}", fatal=True))
            return 1
    try:
        validate_sl_provenance(corr_files, expected_sha=expected_sha, expected_screen_id=cmd.project.screen_id)
    except ValueError as e:
        write_event(ErrorEvent(event="error", code="invalid_input", message=str(e), fatal=True))
        return 1

    # --- 3. intrinsics (file path OR inline self-cal via the "auto" sentinel) ---
    if cmd.intrinsics_path == "auto":
        try:
            K, dist, image_size = _self_calibrate_inline(meta, corr_files, cmd)
            intrinsics_source = "auto_self_calibrated"
        except IntrinsicsRefused as e:
            write_event(ErrorEvent(event="error", code=e.code, message=e.message, fatal=True))
            return 1
    else:
        try:
            # The shared loader validates K by the SAME rule the cross-check applies to
            # the anchor: a non-3x3 or negative-focal file K (hand-edited / sign-flipped
            # export) would otherwise feed straight into BA and silently produce a
            # mirror-image or divergent result instead of a clean error.
            loaded = load_intrinsics_file(cmd.intrinsics_path)
            K = loaded.K
            dist = loaded.dist
            if loaded.image_size is None:
                raise ValueError("intrinsics file missing required image_size")
            image_size = loaded.image_size
            intrinsics_source = "file"
        except (OSError, json.JSONDecodeError, KeyError, ValueError) as e:
            write_event(ErrorEvent(event="error", code="intrinsics_invalid", message=f"intrinsics load failed: {e}", fatal=True))
            return 1
    for c in corr_files:
        if tuple(c.camera_image_size) != image_size:
            write_event(ErrorEvent(event="error", code="invalid_input",
                message=f"correspondence camera_image_size {tuple(c.camera_image_size)} != intrinsics image_size {image_size}",
                fatal=True))
            return 1

    # --- 4. nominal model (project) + cabinet-set match. nominal_poses.keys() IS
    #         the project present-cell set (nominal.py skips absent_cells), so this
    #         ties the sl_meta universe to the project: a stale sl_meta or an edited
    #         project layout (same screen_id+sha) is rejected instead of silently
    #         reconstructing the wrong cabinet universe. ---
    try:
        nominal_poses = nominal_cabinet_poses_model_frame(cmd.project.cabinet_array, cmd.project.shape_prior)
    except ValueError as e:
        write_event(ErrorEvent(event="error", code="invalid_input", message=str(e), fatal=True))
        return 1
    present = sorted(rect_by_cr.keys(), key=lambda cr: (cr[1], cr[0]))
    if set(present) != set(nominal_poses.keys()):
        write_event(ErrorEvent(event="error", code="invalid_input",
            message=f"sl_meta cabinet set {present} != project present cells "
                    f"{sorted(nominal_poses.keys())} (stale sl_meta or edited project layout)", fatal=True))
        return 1
    if ROOT_CABINET not in present:
        write_event(ErrorEvent(event="error", code="invalid_input",
            message="root cabinet V000_R000 (0,0) not present in sl_meta cabinets", fatal=True))
        return 1
    cab_to_idx = {cr: i for i, cr in enumerate(present)}
    root_idx = cab_to_idx[ROOT_CABINET]
    n_cabinets = len(present)

    # --- 5. assemble observations (one camera per correspondence file). p_local uses
    #         CANONICAL (cu,cv) from sl_meta; ONLY the camera pixel (pt.x,pt.y) comes
    #         from the correspondence file. ---
    write_event(ProgressEvent(event="progress", stage="subpixel_refine", percent=0.3, message="assembling observations"))
    observations: list[Observation] = []
    per_view_cab_corners: dict[tuple[int, int], list[tuple[np.ndarray, np.ndarray]]] = {}
    per_cabinet_views: dict[int, set[int]] = {}
    per_cabinet_points: dict[int, int] = {}
    for cam_idx, cf in enumerate(corr_files):
        for pt in cf.points:
            info = cab_by_id.get(int(pt.id))
            if info is None:
                continue  # decoded id not in this sl_meta (defensive)
            cr, cu, cv = info
            cab_idx = cab_to_idx.get(cr)
            if cab_idx is None:
                continue  # dot references a cabinet not in meta.cabinets (hand-edited meta)
            p_local = sl_local_mm(rect_by_cr[cr], cu, cv, pitch_by_cr[cr][0], pitch_by_cr[cr][1])
            pixel = _undistort_obs(np.array([pt.x, pt.y], dtype=float), K, dist)
            observations.append(Observation(camera_idx=cam_idx, cabinet_idx=cab_idx, p_local=p_local, pixel=pixel))
            per_view_cab_corners.setdefault((cam_idx, cab_idx), []).append((p_local, pixel))
            per_cabinet_views.setdefault(cab_idx, set()).add(cam_idx)
            per_cabinet_points[cab_idx] = per_cabinet_points.get(cab_idx, 0) + 1

    if not observations:
        write_event(ErrorEvent(event="error", code="detection_failed",
            message="no usable correspondences across any pose", fatal=True))
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

    # --- 7-11. shared solve + emit ---
    def corners_provider(cabinet_id: str) -> np.ndarray:
        col, row = int(cabinet_id[1:4]), int(cabinet_id[6:9])  # V{col:03d}_R{row:03d}
        return sl_cabinet_corners_mm(rect_by_cr[(col, row)], *pitch_by_cr[(col, row)])

    return solve_and_emit(
        K=K, observations=observations, per_view_cab_corners=per_view_cab_corners,
        n_cameras=len(corr_files), cab_to_idx=cab_to_idx, root_idx=root_idx,
        n_cabinets=n_cabinets, nominal_poses=nominal_poses,
        per_cabinet_views=per_cabinet_views, per_cabinet_points=per_cabinet_points,
        corners_local_provider=corners_provider, pose_report_path=cmd.pose_report_path,
        n_rejected_pre=n_rej_stage_a, rejected_per_cab_pre=rej_per_cab_stage_a,
        gauge_strategy="align_to_nominal",  # SL output lands in the nominal design frame
        intrinsics_source=intrinsics_source)
