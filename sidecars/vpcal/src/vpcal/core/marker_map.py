"""Marker-map operations: world map, geometric validation, ground plane, rebase.

The marker map's coordinates ARE the (right-hand, Z-up) stage frame — see
``models/marker_map.py``.  This module builds the solver-facing world map
(:class:`PhysicalMarkerId` → 3D point), validates the map geometry before a
solve, fits the ground plane from ``on_ground`` markers (Phase B), and
provides the explicit ``rebase --to-ground`` transform (never applied
silently — the QA only reports the deviation).
"""

from __future__ import annotations

import numpy as np
from numpy.typing import NDArray

from vpcal.core.errors import PreconditionError
from vpcal.core.observations import PhysicalMarkerId
from vpcal.core.transforms import matrix_to_quat
from vpcal.models.marker_map import (
    MarkerMapDefinition,
    RebaseRecord,
    SurveyedMarker,
    collinearity_ratio,
    span_mm,
)

Array = NDArray[np.float64]

_MIN_POINTS = 6
_MIN_COLLINEARITY = 0.02          # σ2/σ1 below this ⇒ effectively collinear
_MIN_SPAN_MM = 200.0              # marker field smaller than this is degenerate
_COPLANARITY_TOLERANCE_MM = 2.0   # per-marker corner planarity tolerance
_GROUND_TOLERANCE_MM = 5.0        # default |plane offset| warning threshold
_GROUND_TOLERANCE_DEG = 0.2       # default plane tilt warning threshold


def physical_world_map(marker_map: MarkerMapDefinition) -> dict[PhysicalMarkerId, Array]:
    """Map every 2D-3D correspondence id to its stage-frame 3D point (mm).

    Quad markers contribute four corner points (corner 0..3); point-like
    markers contribute one centre point (corner -1).  Coordinates are already
    the internal right-hand stage frame — no UE conversion.
    """
    world: dict[PhysicalMarkerId, Array] = {}
    for m in marker_map.markers:
        corners = m.resolved_corners()
        if corners is not None:
            for k in range(4):
                world[PhysicalMarkerId(m.marker_id, k)] = corners[k]
        else:
            world[PhysicalMarkerId(m.marker_id, -1)] = m.resolved_center()
    return world


def validate_marker_map(marker_map: MarkerMapDefinition) -> dict:
    """Geometric / degeneracy checks; raises :class:`PreconditionError` on
    hard failures, returns a report with warnings otherwise.

    Hard failures (exit 6): duplicate ids, < 6 correspondence points, a
    collinear point field, no detectable marker.  Soft issues (warnings):
    small span, per-marker corner coplanarity beyond tolerance, quad markers
    with no resolvable numeric tag id.
    """
    warnings: list[str] = []

    ids = [m.marker_id for m in marker_map.markers]
    dupes = sorted({i for i in ids if ids.count(i) > 1})
    if dupes:
        raise PreconditionError(
            f"marker map has duplicate marker ids: {dupes}",
            details={"duplicates": dupes},
        )

    world = physical_world_map(marker_map)
    points = np.array(list(world.values()), dtype=np.float64)
    if len(points) < _MIN_POINTS:
        raise PreconditionError(
            f"marker map has only {len(points)} correspondence points; "
            f"need >= {_MIN_POINTS} non-collinear points",
            details={"points": len(points)},
        )
    ratio = collinearity_ratio(points)
    if ratio < _MIN_COLLINEARITY:
        raise PreconditionError(
            "marker map points are (near-)collinear — the registration is "
            "unobservable; spread markers over a 2D area",
            details={"collinearity_ratio": ratio},
        )

    detectable = marker_map.detectable_markers()
    if not detectable:
        raise PreconditionError(
            "marker map contains no detectable (aruco/apriltag) markers",
            details={"marker_types": sorted({m.marker_type for m in marker_map.markers})},
        )
    tag_owner: dict[tuple[str, int], str] = {}
    for m in detectable:
        if m.dictionary is None:
            warnings.append(f"marker {m.marker_id!r}: no dictionary declared")
        tag = m.resolved_tag_id()
        if tag is None:
            warnings.append(
                f"marker {m.marker_id!r}: no tag_id and marker_id has no trailing "
                "integer — the detector cannot match it"
            )
        elif m.dictionary is not None:
            # A (dictionary, tag_id) pair must be unique: the detector keys on
            # it, so a duplicate would silently bind the tag's pixels to the
            # wrong 3D geometry — a low-residual but WRONG calibration.
            key = (m.dictionary, tag)
            if key in tag_owner:
                raise PreconditionError(
                    f"markers {tag_owner[key]!r} and {m.marker_id!r} both resolve to "
                    f"tag {tag} in {m.dictionary} — the detector cannot tell them "
                    "apart; assign unique tag ids",
                    details={"dictionary": m.dictionary, "tag_id": tag,
                             "markers": [tag_owner[key], m.marker_id]},
                )
            tag_owner[key] = m.marker_id

    field_span = span_mm(points)
    if field_span < _MIN_SPAN_MM:
        warnings.append(
            f"marker field span is only {field_span:.0f} mm (< {_MIN_SPAN_MM:.0f}); "
            "registration leverage is poor"
        )
    for m in marker_map.markers:
        resid = m.coplanarity_residual_mm()
        if resid > _COPLANARITY_TOLERANCE_MM:
            warnings.append(
                f"marker {m.marker_id!r}: surveyed corners deviate {resid:.2f} mm "
                f"from a plane (> {_COPLANARITY_TOLERANCE_MM} mm) — check the survey"
            )

    return {
        "passed": True,
        "num_markers": len(marker_map.markers),
        "num_detectable": len(detectable),
        "num_points": len(points),
        "span_mm": field_span,
        "collinearity_ratio": ratio,
        "num_ground_markers": len(marker_map.ground_markers()),
        "warnings": warnings,
    }


# ── Ground plane (Phase B) ───────────────────────────────────────────


def fit_ground_plane(
    marker_map: MarkerMapDefinition,
    *,
    tolerance_mm: float = _GROUND_TOLERANCE_MM,
    tolerance_deg: float = _GROUND_TOLERANCE_DEG,
) -> dict:
    """Least-squares plane through the ``on_ground`` marker centres.

    Returns the QA block: fitted normal, per-point residual RMS, and the
    deviation from the stage Z=0 plane (tilt angle + offset at the centroid).
    Never mutates the map — a deviation past tolerance only yields a warning
    ("survey frame and floor disagree; AR ground contact will slide").
    """
    ground = marker_map.ground_markers()
    if len(ground) < 3:
        return {
            "available": False,
            "num_ground_markers": len(ground),
            "reason": "need >= 3 on_ground markers to fit a plane",
            "warnings": [],
        }
    pts = np.array([m.resolved_center() for m in ground], dtype=np.float64)
    centroid = pts.mean(axis=0)
    if collinearity_ratio(pts) < _MIN_COLLINEARITY:
        return {
            "available": False,
            "num_ground_markers": len(ground),
            "reason": "on_ground markers are (near-)collinear — the plane fit is "
                      "degenerate; spread ground markers over a 2D area",
            "warnings": [],
        }
    _u, _s, vt = np.linalg.svd(pts - centroid)
    normal = vt[2]
    if normal[2] < 0:
        normal = -normal
    residuals = (pts - centroid) @ normal
    rms = float(np.sqrt(np.mean(residuals**2)))
    tilt_deg = float(np.degrees(np.arccos(np.clip(normal[2], -1.0, 1.0))))
    offset_mm = float(centroid @ normal)  # signed distance of Z=0 origin plane

    warnings: list[str] = []
    if abs(offset_mm) > tolerance_mm or tilt_deg > tolerance_deg:
        warnings.append(
            f"ground plane deviates from stage Z=0 by {offset_mm:.2f} mm / "
            f"{tilt_deg:.3f}° (tolerance {tolerance_mm} mm / {tolerance_deg}°) — "
            "the survey frame and the physical floor disagree; AR content will "
            "slide on ground contact. Review the survey or run "
            "`vpcal marker-map rebase --to-ground` explicitly."
        )
    return {
        "available": True,
        "num_ground_markers": len(ground),
        "normal": [float(x) for x in normal],
        "residual_rms_mm": rms,
        "residual_max_mm": float(np.max(np.abs(residuals))),
        "tilt_from_z_deg": tilt_deg,
        "offset_from_z0_mm": offset_mm,
        "tolerance_mm": tolerance_mm,
        "tolerance_deg": tolerance_deg,
        "warnings": warnings,
    }


def _rotation_aligning(a: Array, b: Array) -> Array:
    """Minimal rotation matrix taking unit vector ``a`` onto unit vector ``b``."""
    a = a / np.linalg.norm(a)
    b = b / np.linalg.norm(b)
    v = np.cross(a, b)
    c = float(a @ b)
    if np.linalg.norm(v) < 1e-12:
        if c > 0:
            return np.eye(3)
        # 180°: rotate about any axis orthogonal to a
        axis = np.cross(a, [1.0, 0.0, 0.0])
        if np.linalg.norm(axis) < 1e-6:
            axis = np.cross(a, [0.0, 1.0, 0.0])
        axis = axis / np.linalg.norm(axis)
        return 2.0 * np.outer(axis, axis) - np.eye(3)
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx * ((1.0 - c) / float(v @ v))


def rebase_to_ground(marker_map: MarkerMapDefinition) -> tuple[MarkerMapDefinition, dict]:
    """Return a copy of the map rigidly re-based so the fitted ground plane is Z=0.

    The transform is the minimal rotation aligning the fitted normal to +Z
    (XY heading preserved as far as possible) followed by the translation that
    puts the ground centroid at height 0.  The applied transform is appended
    to ``rebase_history`` (audit trail); reprojection residuals are invariant
    (only the stage frame *definition* moves).
    """
    fit = fit_ground_plane(marker_map)
    if not fit["available"]:
        raise PreconditionError(
            f"cannot rebase: {fit['reason']}",
            details={"num_ground_markers": fit["num_ground_markers"]},
        )
    normal = np.asarray(fit["normal"], dtype=np.float64)
    R = _rotation_aligning(normal, np.array([0.0, 0.0, 1.0]))
    ground = marker_map.ground_markers()
    centroid = np.array([m.resolved_center() for m in ground]).mean(axis=0)
    # After rotation, translate so the (rotated) ground centroid sits at z=0;
    # x/y are untouched (the rebase never moves the origin in-plane).
    rc = R @ centroid
    t = np.array([0.0, 0.0, -rc[2]])

    def _apply_point(p: list[float]) -> list[float]:
        return [float(x) for x in R @ np.asarray(p, dtype=np.float64) + t]

    def _apply_vec(v: list[float]) -> list[float]:
        return [float(x) for x in R @ np.asarray(v, dtype=np.float64)]

    markers: list[SurveyedMarker] = []
    for m in marker_map.markers:
        upd: dict = {}
        # Materialise derived quad corners BEFORE transforming: re-deriving them
        # from a rotated normal via the up-projection convention would slightly
        # re-orient the tag in-plane, breaking the "rebase moves only the frame
        # definition, never the geometry" invariant.
        corners = m.resolved_corners()
        if corners is not None:
            upd["corners_stage_mm"] = [_apply_point(c) for c in corners]
        if m.center_stage_mm is not None:
            upd["center_stage_mm"] = _apply_point(m.center_stage_mm)
        if m.normal is not None:
            upd["normal"] = _apply_vec(m.normal)
        markers.append(m.model_copy(update=upd))

    record = RebaseRecord(
        reason="rebase --to-ground: fitted ground plane aligned to stage Z=0",
        rotation=[float(x) for x in matrix_to_quat(R)],
        translation=[float(x) for x in t],
    )
    rebased = marker_map.model_copy(
        update={"markers": markers, "rebase_history": [*marker_map.rebase_history, record]}
    )
    audit = {
        "rotation": record.rotation,
        "translation": record.translation,
        "tilt_corrected_deg": fit["tilt_from_z_deg"],
        "offset_corrected_mm": fit["offset_from_z0_mm"],
    }
    return rebased, audit


# ── World-alignment uncertainty (Phase B3) ───────────────────────────


def world_alignment_uncertainty(marker_map: MarkerMapDefinition) -> dict:
    """Honest world-alignment uncertainty summary from the survey metadata.

    Groups markers by ``survey_source`` and aggregates the declared
    ``uncertainty_mm``.  No number is invented: markers without an
    uncertainty are counted and the overall grade falls back to ``"n/a"``
    when nothing was declared (measured-vs-guessed philosophy).
    """
    by_source: dict[str, dict] = {}
    declared: list[float] = []
    undeclared = 0
    for m in marker_map.markers:
        src = m.survey_source or "undeclared"
        entry = by_source.setdefault(src, {"count": 0, "max_uncertainty_mm": None})
        entry["count"] += 1
        if m.uncertainty_mm is not None:
            declared.append(m.uncertainty_mm)
            cur = entry["max_uncertainty_mm"]
            entry["max_uncertainty_mm"] = m.uncertainty_mm if cur is None else max(cur, m.uncertainty_mm)
        else:
            undeclared += 1
    overall = max(declared) if declared else None
    if overall is None:
        grade = "n/a"
    elif overall <= 2.0:
        grade = "millimetre"
    elif overall <= 20.0:
        grade = "centimetre"
    else:
        grade = "coarse"
    return {
        "by_source": by_source,
        "max_uncertainty_mm": overall,
        "markers_without_uncertainty": undeclared,
        "grade": grade,
    }
