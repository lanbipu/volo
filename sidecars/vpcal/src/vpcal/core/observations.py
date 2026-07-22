"""Data structures for calibration observations (2D-3D correspondences).

Three levels:
  * :class:`MarkerId`   — the decoded VP-QSP identity
    ``(screen_id, cab_col, cab_row, local_id)``.
  * :class:`Detection`  — what the detector emits per image: a marker id at a
    sub-pixel location, with a confidence.
  * :class:`Observation`— what the solver consumes: a pixel paired with the
    marker's right-hand world point and that frame's tracker pose (T_O_from_B,
    already in the internal right-hand frame).  This mirrors the C++
    ``vpcal::Observation`` struct in ``solver.h``.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class MarkerId:
    """A VP-QSP marker's full self-encoded identity.

    ``screen_id`` selects the screen within a Volume; ``(cab_col, cab_row)``
    is the cabinet address; ``local_id`` is the marker's index within that
    cabinet's marker grid (row-major).
    """

    screen_id: int
    cab_col: int
    cab_row: int
    local_id: int

    def to_dict(self) -> dict[str, int]:
        return {
            "screen_id": self.screen_id,
            "cab_col": self.cab_col,
            "cab_row": self.cab_row,
            "local_id": self.local_id,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "MarkerId":
        if "screen_id" in d:
            return cls(
                int(d["screen_id"]),
                int(d["cab_col"]),
                int(d["cab_row"]),
                int(d["local_id"]),
            )
        # Legacy format: {row, col, sub_index}
        return cls(0, int(d["col"]), int(d["row"]), int(d["sub_index"]))


@dataclass(frozen=True)
class PhysicalMarkerId:
    """Identity of one 2D-3D correspondence on a *physical* marker (AR mode).

    ``marker`` is the marker map's string id (e.g. ``"AT_36h11_17"``);
    ``corner`` indexes the tag corner 0..3 (TL, TR, BR, BL in the tag's
    canonical orientation), or -1 for point-like markers (charuco corner /
    survey point) that contribute a single centre correspondence.
    """

    marker: str
    corner: int = -1

    def to_dict(self) -> dict:
        return {"marker": self.marker, "corner": self.corner}

    @classmethod
    def from_dict(cls, d: dict) -> "PhysicalMarkerId":
        return cls(str(d["marker"]), int(d.get("corner", -1)))


def marker_id_from_dict(d: dict) -> "MarkerId | PhysicalMarkerId":
    """Parse a serialised marker id, dispatching on the schema.

    ``{"marker": ...}`` → :class:`PhysicalMarkerId` (marker-map path);
    anything else → :class:`MarkerId` (VP-QSP screen path, incl. legacy form).
    """
    if "marker" in d:
        return PhysicalMarkerId.from_dict(d)
    return MarkerId.from_dict(d)


@dataclass
class Detection:
    """A single detected marker in one image.

    ``differenced`` records whether the sub-pixel centroid was computed on the
    signed normal−inverted difference (True) or fell back to the raw normal
    frame (False) — the fallback is exposed so QA can flag the degraded path.
    """

    frame_id: int
    marker_id: "MarkerId | PhysicalMarkerId"
    pixel_u: float
    pixel_v: float
    confidence: float = 1.0
    differenced: bool = False
    # Compatibility name: this is a brightness/clipping *warning*, not a
    # trustworthy localization rejection.  VP-QSP intentionally contains
    # white cells, so an absolute high-pixel fraction cannot prove clipping.
    saturated: bool = False
    localization_quality: float = 1.0
    localization_rejected: bool = False
    localization_reasons: tuple[str, ...] = ()


@dataclass
class Observation:
    """A 2D-3D correspondence + the frame's tracker pose, ready for the solver.

    ``world_rh`` is the marker 3D point already converted to the right-hand
    internal frame (``M_rh_from_ue @ P_stage_ue``).  ``track_q`` / ``track_t``
    are the tracker SDK output ``T_O_from_B`` (rotation quaternion w,x,y,z and
    translation), already in the internal right-hand frame.
    """

    pixel_u: float
    pixel_v: float
    world_rh: tuple[float, float, float]
    track_q: tuple[float, float, float, float]
    track_t: tuple[float, float, float]
    frame_id: int = -1
    marker_id: "MarkerId | PhysicalMarkerId | None" = None
    sigma_px: float = 1.0
    """Per-correspondence pixel uncertainty used to whiten solver residuals."""
