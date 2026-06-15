"""Nominal cabinet SE(3) poses in the model/design coordinate frame.

THE coordinate-convention declaration (single source — every other module
defers to this; FIX-1/FIX-2 of docs/core-fixes-execution-plan.md):

* **Model/design frame** (right-handed): +x = increasing col (wall right as
  displayed), +y = UP, +z = outward surface normal (toward audience/cameras).
  Origin = the wall's bottom-left front corner (flat z=0 plane; curved walls
  bend x/z, see below). Cameras observe from the +z side.
* **Cabinet grid** ``(col, row)``: 0-based; col 0 = left, **row 0 = TOP of the
  wall** (pattern.py places cabinet (col,row) at canvas rect (col·cw, row·ch)
  and canvas v=0 is the displayed top). Cabinet (col,row) center is therefore
  ((col+0.5)·cw, (rows−row−0.5)·ch, 0) on a flat wall.
* **Cabinet-local frame**: center origin, +x right, +y UP, z=0 plane
  (sl_geometry.sl_local_mm / screen_mapping.charuco_corner_local_mm /
  vpqsp_layout.marker_local_mm all already use this). Composing
  ``world = t + R @ local`` needs NO sign flips anywhere.
* **M1 total-station vertex names** (Rust core, e.g. ``MAIN_V001_R001``) are a
  SEPARATE 1-based namespace where R001 = the BOTTOM vertex row, counting
  upward — operator-friendly and consistent with the +y-up model frame
  (vertex V001_R001 sits at the model-frame origin). Do not conflate it with
  the 0-based, top-down cabinet grid above.

Curved shape priors deflect cabinet centers off the XY plane via a constant-
radius arc x = R·sin a + W/2, z = R·(1−cos a) (concave toward the audience;
curvature center on the +z side). The tile rotation placing a rigid cabinet
tangent to that arc is R_y(−a), so the nominal surface normal is
R_y(−a)·ẑ = [−sin a, 0, cos a] — normals converge toward the curvature
center. Folded screens are not supported in M2 — they fail fast rather than
silently producing flat coordinates that look valid but encode the wrong
model frame.

``nominal_cabinet_poses_model_frame`` is the single SE(3) truth source;
centers and normals are derived from it (no independent normal formula —
the old one was mirrored, see FIX-1).
"""
from __future__ import annotations

import math
from typing import Any

from lmt_vba_sidecar.ipc import (
    CabinetArray,
    ShapePriorCurved,
    ShapePriorFolded,
)


CURVED_RADIUS_MIN_RATIO = 0.6  # radius must be ≥ this × screen-half-width


def _validate_curved_radius(radius_mm: float, screen_half_width_mm: float) -> None:
    if not math.isfinite(radius_mm):
        raise ValueError(f"curved.radius_mm must be finite, got {radius_mm}")
    if radius_mm <= 0:
        raise ValueError(f"curved.radius_mm must be positive, got {radius_mm}")
    # Half-cylinder geometry needs radius > screen half-width or the arc
    # angle exceeds 90° and chord_x / radius starts to alias.
    min_radius = CURVED_RADIUS_MIN_RATIO * screen_half_width_mm
    if radius_mm < min_radius:
        raise ValueError(
            f"curved.radius_mm={radius_mm} is too small for screen "
            f"half-width {screen_half_width_mm} (need ≥ {min_radius:.1f})"
        )


def _curved_radius(shape_prior: Any) -> float:
    if isinstance(shape_prior, ShapePriorCurved):
        return shape_prior.curved.radius_mm
    return shape_prior["curved"]["radius_mm"]


def _is_curved(shape_prior: Any) -> bool:
    return isinstance(shape_prior, ShapePriorCurved) or (
        isinstance(shape_prior, dict) and "curved" in shape_prior
    )


def _is_folded(shape_prior: Any) -> bool:
    return isinstance(shape_prior, ShapePriorFolded) or (
        isinstance(shape_prior, dict) and "folded" in shape_prior
    )


def _cabinet_center_model_m(
    col: int, row: int, cab: CabinetArray, shape_prior: Any,
) -> tuple[float, float, float]:
    # +y UP, row 0 = wall top (see module docstring): row 0 has the LARGEST y.
    cw_mm, ch_mm = cab.cabinet_size_mm
    x_mm = (col + 0.5) * cw_mm
    y_mm = (cab.rows - row - 0.5) * ch_mm
    z_mm = 0.0

    if shape_prior == "flat":
        pass
    elif _is_curved(shape_prior):
        radius_mm = _curved_radius(shape_prior)
        total_w_mm = cab.cols * cw_mm
        _validate_curved_radius(radius_mm, total_w_mm / 2.0)
        chord_x_mm = x_mm - total_w_mm / 2.0
        angle = chord_x_mm / radius_mm
        x_mm = radius_mm * math.sin(angle) + total_w_mm / 2.0
        z_mm = radius_mm * (1.0 - math.cos(angle))
    elif _is_folded(shape_prior):
        raise ValueError(
            "shape_prior=folded is not supported in M2 (refinement deferred to M3); "
            "either approximate as flat or use a curved profile"
        )
    else:
        raise ValueError(f"unsupported shape_prior: {shape_prior!r}")

    return (x_mm / 1000.0, y_mm / 1000.0, z_mm / 1000.0)


def nominal_cabinet_poses_model_frame(
    cab: CabinetArray, shape_prior: Any,
) -> "dict[tuple[int, int], tuple[np.ndarray, np.ndarray]]":
    """(col, row) -> (R_model_from_cabinet (3,3), t_center_m (3,)) — the single
    SE(3) truth source for the nominal wall (module docstring has the frame
    declaration). Flat => R = I; curved => R = R_y(−a) for the cabinet's arc
    angle a (the rotation that lays a rigid tile tangent to the arc — see
    _cabinet_R_y_model). Normals are DERIVED as R @ [0,0,1]; centers as t.
    Raises ValueError on unsupported shape priors (mapped to invalid_input).
    """
    import numpy as np

    poses: dict[tuple[int, int], tuple[np.ndarray, np.ndarray]] = {}
    absent = set(tuple(c) for c in cab.absent_cells)
    for row in range(cab.rows):
        for col in range(cab.cols):
            if (col, row) in absent:
                continue
            R = _cabinet_R_y_model(col, row, cab, shape_prior)
            t = np.asarray(_cabinet_center_model_m(col, row, cab, shape_prior))
            poses[(col, row)] = (R, t)
    return poses


def nominal_cabinet_normals_model_frame(
    cab: CabinetArray, shape_prior: Any,
) -> dict[tuple[int, int], tuple[float, float, float]]:
    """(col, row) -> nominal unit surface normal in the model frame, derived
    from the SE(3) pose as R @ [0,0,1] (curved => [−sin a, 0, cos a]; normals
    converge toward the curvature center on the +z/audience side).

    Used by reconstruct's IPPE two-branch disambiguation (Part C): each
    cabinet's planar-PnP mirror ambiguity is resolved by picking the branch
    whose model-frame normal best matches this nominal arc orientation.
    """
    return {
        cr: tuple(float(v) for v in (R @ (0.0, 0.0, 1.0)))
        for cr, (R, _t) in nominal_cabinet_poses_model_frame(cab, shape_prior).items()
    }


def nominal_cabinet_centers_model_frame(
    cab: CabinetArray, shape_prior: Any,
) -> dict[tuple[int, int], tuple[float, float, float]]:
    """(col, row) → (x, y, z) cabinet center in model frame, meters.

    Reconstruct uses these as the per-cabinet translation seeds that
    initialise model-constrained BA (the root cabinet fixes the gauge and BA
    refines every other cabinet pose from these seeds). The earlier
    Procrustes alignment of BA centroids to these nominals has been removed.
    """
    centers: dict[tuple[int, int], tuple[float, float, float]] = {}
    absent = set(tuple(c) for c in cab.absent_cells)
    for row in range(cab.rows):
        for col in range(cab.cols):
            if (col, row) in absent:
                continue
            centers[(col, row)] = _cabinet_center_model_m(col, row, cab, shape_prior)
    return centers


def _cabinet_R_y_model(col: int, row: int, cab: CabinetArray, shape_prior: Any) -> "np.ndarray":
    """R_world_from_cabinet for this cabinet (rigid tile). Flat => I; curved =>
    R_y(-alpha) where alpha is the arc angle of the cabinet center.

    The center curve x = R·sin a, z = R·(1-cos a) has tangent [cos a, 0, +sin a].
    Rotating a flat tile's local +x axis [1,0,0] onto that tangent needs R_y(-a)
    (with R_y(a) = [[c,0,s],[0,1,0],[-s,0,c]], R_y(-a)·[1,0,0] = [c,0,s] = the
    tangent). R_y(+a) would tilt each tile the wrong way, opening visible gaps
    between adjacent cabinets at their shared boundary. This is THE tile-pose
    convention (nominal_cabinet_poses_model_frame wraps it); normals derive from
    it as R @ ẑ — the old independent normal formula was its mirror (FIX-1)."""
    import numpy as np
    if shape_prior == "flat":
        return np.eye(3)
    if _is_curved(shape_prior):
        cw_mm, _ch = cab.cabinet_size_mm
        radius_mm = _curved_radius(shape_prior)
        total_w_mm = cab.cols * cw_mm
        _validate_curved_radius(radius_mm, total_w_mm / 2.0)
        x_mm = (col + 0.5) * cw_mm
        angle = -(x_mm - total_w_mm / 2.0) / radius_mm
        c, s = math.cos(angle), math.sin(angle)
        return np.array([[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]])
    if _is_folded(shape_prior):
        raise ValueError("shape_prior=folded is not supported in M2")
    raise ValueError(f"unsupported shape_prior: {shape_prior!r}")


def nominal_dot_positions_world(meta: Any, cab: CabinetArray, shape_prior: Any) -> "dict[int, np.ndarray]":
    """dot_id -> [x,y,z] (meters) in the model/design frame.

    world_m = t + R @ local_m straight from nominal_cabinet_poses_model_frame:
    sl_local_mm is +y-UP and the model frame is +y-UP with row 0 at the wall
    top (module docstring), so a multi-row wall composes into ONE rigid plane
    with no sign flips (the old +y-DOWN center grid needed a local-y negation
    here; both are gone — FIX-2).

    Flat => R=I => pure translation. Used by Step-1 SL calibration as the
    known 3D target. Raises ValueError (mapped to invalid_input) on
    unsupported shape or a dot whose cabinet is absent / not in meta.cabinets.
    """
    import numpy as np
    from lmt_vba_sidecar.sl_geometry import sl_local_mm

    poses = nominal_cabinet_poses_model_frame(cab, shape_prior)  # present cells only
    rect_by_cr = {(c.col, c.row): tuple(int(v) for v in c.input_rect_px) for c in meta.cabinets}
    pitch_by_cr = {(c.col, c.row): (float(c.pixel_pitch_mm[0]), float(c.pixel_pitch_mm[1])) for c in meta.cabinets}

    out: dict[int, np.ndarray] = {}
    for d in meta.dots:
        cr = (int(d.cabinet[0]), int(d.cabinet[1]))
        if cr not in poses:
            raise ValueError(f"dot {d.id} references absent/unknown cabinet {cr}")
        if cr not in rect_by_cr:
            raise ValueError(f"dot {d.id} cabinet {cr} not in sl_meta.cabinets")
        local_m = sl_local_mm(rect_by_cr[cr], float(d.u), float(d.v), pitch_by_cr[cr][0], pitch_by_cr[cr][1]) / 1000.0
        R, t = poses[cr]
        out[int(d.id)] = t + R @ local_m
    return out


def nominal_marker_positions_world(
    meta: Any, cab: CabinetArray, shape_prior: Any,
) -> "dict[tuple[int, int, int], np.ndarray]":
    """(col, row, local_id) -> [x,y,z] (meters) in the model/design frame.

    VP-QSP analog of nominal_dot_positions_world: ``world = t + R @ local``
    straight from nominal_cabinet_poses_model_frame. marker_local_mm is +y-UP
    (same convention as sl_local_mm) and the model frame is +y-UP with row 0
    at the wall top (module docstring), so a multi-row wall composes into ONE
    rigid surface with no sign flips (FIX-2 removed the old local-y negation).

    Flat => R=I => pure translation. Used by VP-QSP reconstruct's
    --intrinsics auto self-calibration as the known 3D calibration target. Raises
    ValueError (mapped to invalid_input) on unsupported shape or a cabinet absent
    from the nominal model.
    """
    import numpy as np
    from lmt_vba_sidecar.vpqsp_layout import local_ids, marker_local_mm

    poses = nominal_cabinet_poses_model_frame(cab, shape_prior)  # present cells only

    out: dict[tuple[int, int, int], np.ndarray] = {}
    for c in meta.cabinets:
        cr = (int(c.col), int(c.row))
        if cr not in poses:
            raise ValueError(f"vpqsp cabinet {cr} absent/unknown in nominal model")
        R, t = poses[cr]
        for lid in local_ids(c.markers_x, c.markers_y):
            local_mm = marker_local_mm(
                lid, markers_x=c.markers_x, markers_y=c.markers_y,
                marker_px=c.marker_px,
                resolution_px=(c.resolution_px[0], c.resolution_px[1]),
                pixel_pitch_mm=(c.pixel_pitch_mm[0], c.pixel_pitch_mm[1]),
            )
            out[(cr[0], cr[1], int(lid))] = t + R @ (local_mm / 1000.0)
    return out
