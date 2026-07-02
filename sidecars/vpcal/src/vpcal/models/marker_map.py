"""Surveyed marker map definition — the AR-mode ground-truth source.

In the LED flow the screen definition supplies the marker 3D coordinates; in
the AR flow (no LED wall) that role is taken by a **measured marker map**: a
list of physical markers (ArUco / AprilTag / ChArUco corners / plain survey
points) whose stage-frame coordinates were established by survey (total
station, tape) or by manufacture (CAD, e.g. a calibration cube).

Frame convention: **the marker map's coordinate frame IS the stage frame**,
and it must be right-handed with Z up (the survey defines origin and axes;
``frame_name`` documents that definition).  Unlike the screen path (UE
left-hand, converted via ``M_rh_from_ue``), marker map coordinates are used
directly as the internal right-hand stage frame.

Corner orientation convention (centre + size + normal form): the tag's "up"
direction is the projection of stage +Z onto the tag plane; when the normal is
(near-)vertical (|n·Z| > 0.99, e.g. a floor/ceiling tag) the fallback up is
stage +X.  The printed tag must be mounted with its canonical top edge along
that direction, or the four-corner correspondence is rotated.  Surveying the
four corners explicitly (``corners_stage_mm``, order TL, TR, BR, BL in the
tag's canonical orientation) avoids the convention entirely and is preferred.
"""

from __future__ import annotations

import math
import re
from typing import Annotated, Literal, Optional

import numpy as np
from numpy.typing import NDArray
from pydantic import BaseModel, ConfigDict, Field, model_validator

Array = NDArray[np.float64]

MarkerType = Literal["aruco", "apriltag", "charuco_corner", "point"]

MARKER_MAP_SCHEMA_VERSION = "1.0"

_VERTICAL_NORMAL_DOT = 0.99


class SurveyedMarker(BaseModel):
    """One physical marker with measured (or CAD) stage-frame geometry."""

    model_config = ConfigDict(populate_by_name=True)

    marker_id: str
    """Globally unique id, e.g. ``"AT_36h11_17"`` / ``"CH_board2_c3"``."""
    marker_type: MarkerType
    dictionary: Optional[str] = None
    """cv2.aruco dictionary name, e.g. ``"DICT_APRILTAG_36h11"`` (aruco/apriltag)."""
    tag_id: Optional[int] = None
    """Numeric id within the dictionary; when omitted, the trailing integer of
    ``marker_id`` is used (``"AT_36h11_17"`` → 17)."""
    # Either the four surveyed corners (preferred) or centre + size + normal
    # (corners derived via the documented orientation convention).
    corners_stage_mm: Optional[
        Annotated[list[Annotated[list[float], Field(min_length=3, max_length=3)]],
                  Field(min_length=4, max_length=4)]
    ] = None
    """4×3 corner coordinates (mm), order TL, TR, BR, BL (canonical tag frame)."""
    center_stage_mm: Optional[Annotated[list[float], Field(min_length=3, max_length=3)]] = None
    size_mm: Optional[float] = Field(default=None, gt=0)
    normal: Optional[Annotated[list[float], Field(min_length=3, max_length=3)]] = None
    on_ground: bool = False
    """Participates in the ground-plane fit (marker lies on the stage floor)."""
    uncertainty_mm: Optional[float] = Field(default=None, ge=0)
    """Prior uncertainty of the survey method; None = unknown (report shows n/a)."""
    survey_source: Optional[str] = None
    """e.g. ``"total_station"`` / ``"tape"`` / ``"cad"`` / ``"cube_placement"``."""

    @model_validator(mode="after")
    def _check_geometry(self) -> "SurveyedMarker":
        if self.marker_type in ("charuco_corner", "point"):
            if self.center_stage_mm is None and self.corners_stage_mm is None:
                raise ValueError(
                    f"marker {self.marker_id!r}: point-like markers need center_stage_mm"
                )
            return self
        if self.corners_stage_mm is not None:
            return self
        missing = [
            n for n, v in (
                ("center_stage_mm", self.center_stage_mm),
                ("size_mm", self.size_mm),
                ("normal", self.normal),
            ) if v is None
        ]
        if missing:
            raise ValueError(
                f"marker {self.marker_id!r}: give corners_stage_mm (4×3) or all of "
                f"center_stage_mm + size_mm + normal (missing: {missing})"
            )
        return self

    def resolved_tag_id(self) -> Optional[int]:
        """Numeric dictionary id: explicit ``tag_id``, else trailing int of marker_id."""
        if self.tag_id is not None:
            return self.tag_id
        m = re.search(r"(\d+)$", self.marker_id)
        return int(m.group(1)) if m else None

    def resolved_center(self) -> Array:
        """Marker centre in the stage frame (mm)."""
        if self.center_stage_mm is not None:
            return np.asarray(self.center_stage_mm, dtype=np.float64)
        corners = np.asarray(self.corners_stage_mm, dtype=np.float64)
        return corners.mean(axis=0)

    def resolved_corners(self) -> Optional[Array]:
        """4×3 corner array (TL, TR, BR, BL) or None for point-like markers.

        Derivation from centre + size + normal follows the module-level
        orientation convention (tag up = stage +Z projected onto the plane;
        fallback +X for horizontal tags).
        """
        if self.corners_stage_mm is not None:
            return np.asarray(self.corners_stage_mm, dtype=np.float64)
        if self.marker_type in ("charuco_corner", "point"):
            return None
        c = np.asarray(self.center_stage_mm, dtype=np.float64)
        n = np.asarray(self.normal, dtype=np.float64)
        nn = np.linalg.norm(n)
        if nn == 0.0:
            raise ValueError(f"marker {self.marker_id!r}: zero-length normal")
        n = n / nn
        up_hint = np.array([0.0, 0.0, 1.0])
        if abs(float(n @ up_hint)) > _VERTICAL_NORMAL_DOT:
            up_hint = np.array([1.0, 0.0, 0.0])
        up = up_hint - (up_hint @ n) * n
        up = up / np.linalg.norm(up)
        # (right, up, normal) is a right-handed frame with the normal pointing
        # at the viewer, so right = up × normal — the tag's as-seen image-right.
        right = np.cross(up, n)
        h = 0.5 * float(self.size_mm)
        return np.array(
            [c + h * up - h * right, c + h * up + h * right,
             c - h * up + h * right, c - h * up - h * right],
            dtype=np.float64,
        )

    def coplanarity_residual_mm(self) -> float:
        """Max out-of-plane distance of the four corners (0 for point-like/derived)."""
        if self.corners_stage_mm is None:
            return 0.0
        corners = np.asarray(self.corners_stage_mm, dtype=np.float64)
        centroid = corners.mean(axis=0)
        _u, s, vt = np.linalg.svd(corners - centroid)
        normal = vt[2]
        return float(np.max(np.abs((corners - centroid) @ normal)))


class RebaseRecord(BaseModel):
    """Audit record of a ``marker-map rebase`` transform application."""

    model_config = ConfigDict(populate_by_name=True)

    reason: str
    rotation: Annotated[list[float], Field(min_length=4, max_length=4)]
    """Quaternion (w, x, y, z) of the applied rigid transform."""
    translation: Annotated[list[float], Field(min_length=3, max_length=3)]
    timestamp: Optional[str] = None


class MarkerMapDefinition(BaseModel):
    """Top-level marker map: the measured stage-frame ground truth (AR mode)."""

    model_config = ConfigDict(populate_by_name=True)

    schema_version: str = MARKER_MAP_SCHEMA_VERSION
    name: Optional[str] = None
    frame_name: str
    """Semantic description of the stage frame this map defines (origin, axes;
    must be right-handed, Z up)."""
    markers: list[SurveyedMarker]
    rebase_history: list[RebaseRecord] = Field(default_factory=list)
    """Applied rebase transforms, newest last (audit trail)."""

    def marker_by_id(self, marker_id: str) -> SurveyedMarker | None:
        for m in self.markers:
            if m.marker_id == marker_id:
                return m
        return None

    def detectable_markers(self) -> list[SurveyedMarker]:
        """Markers the physical detector can find (aruco/apriltag quads)."""
        return [m for m in self.markers if m.marker_type in ("aruco", "apriltag")]

    def ground_markers(self) -> list[SurveyedMarker]:
        return [m for m in self.markers if m.on_ground]


def span_mm(points: Array) -> float:
    """Bounding-box diagonal of an (N, 3) point array."""
    if len(points) == 0:
        return 0.0
    return float(np.linalg.norm(points.max(axis=0) - points.min(axis=0)))


def collinearity_ratio(points: Array) -> float:
    """σ2/σ1 of the centred point cloud — ~0 when all points are collinear."""
    if len(points) < 3:
        return 0.0
    centred = points - points.mean(axis=0)
    s = np.linalg.svd(centred, compute_uv=False)
    return float(s[1] / s[0]) if s[0] > 0 else 0.0


def coplanarity_extent_ratio(points: Array) -> float:
    """σ3/σ1 of the centred cloud — ~0 when all points lie in one plane."""
    if len(points) < 4:
        return 0.0
    centred = points - points.mean(axis=0)
    s = np.linalg.svd(centred, compute_uv=False)
    return float(s[2] / s[0]) if s[0] > 0 else 0.0


def is_unit_angle_deg(v: Array, w: Array) -> float:
    """Angle between two vectors in degrees."""
    a = np.asarray(v, dtype=np.float64)
    b = np.asarray(w, dtype=np.float64)
    cos = float(a @ b / ((np.linalg.norm(a) * np.linalg.norm(b)) or 1.0))
    return math.degrees(math.acos(max(-1.0, min(1.0, cos))))
