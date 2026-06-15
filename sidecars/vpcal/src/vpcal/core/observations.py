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


@dataclass
class Detection:
    """A single detected marker in one image.

    ``differenced`` records whether the sub-pixel centroid was computed on the
    signed normal−inverted difference (True) or fell back to the raw normal
    frame (False) — the fallback is exposed so QA can flag the degraded path.
    """

    frame_id: int
    marker_id: MarkerId
    pixel_u: float
    pixel_v: float
    confidence: float = 1.0
    differenced: bool = False


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
    marker_id: MarkerId | None = None
