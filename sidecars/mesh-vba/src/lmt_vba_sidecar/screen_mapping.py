"""
screen_mapping.py — scale-trust anchor for the camera-only visual branch.

No total station → metric scale comes entirely from known pixel pitch / active
physical size.  This module:
  - defines the ScreenMapping pydantic model (screen + per-cabinet config),
  - converts charuco_id → local mm (active-surface-center origin, flat z=0),
  - runs a preflight hash/format check before reconstruct.

Physical ChArUco convention (pitch-based, pattern_meta v2)
----------------------------------------------------------
pattern.py builds CharucoBoard(size=(squares_x, squares_y)) rendered at an integer
`square_px` per cell (possibly non-square: squares_x != squares_y). Inner corner
(r, c) — with r, c = divmod(charuco_id, squares_x - 1) — sits at board-pixel
((c+1)*square_px, (r+1)*square_px). With a center origin, the cabinet's own
pixel pitch, and **+y up** (OpenCV's ChArUco board frame; larger r = lower on
the displayed pattern = smaller y), the signed mm coordinate is:

    x = ((c + 1) * square_px - (squares_x * square_px) / 2) * pitch_x
    y = ((squares_y * square_px) / 2 - (r + 1) * square_px) * pitch_y

Note the +y-up sign on y: feeding y-down object points to solvePnP recovers a
vertically-flipped / chirally mirrored board pose. This uses the cabinet's
measured pixel pitch directly, so mm is exact for any
per-cabinet size/pitch and any non-square board. (The pre-v2 formula
`active_size / (inner + 1)` assumed a single square `inner` and is obsolete.)
"""
from __future__ import annotations

from typing import Annotated, Literal

import numpy as np
from pydantic import BaseModel, Field

from lmt_vba_sidecar.ipc import PositiveIntPair, PositiveSizePair  # reuse validated types


class ScreenMappingError(Exception):
    """Raised when screen mapping config is invalid or an operation is unsupported."""


# ---------------------------------------------------------------------------
# Validated field aliases (inline to avoid over-abstraction)
# ---------------------------------------------------------------------------

_IntList4 = Annotated[list[int], Field(min_length=4, max_length=4)]


class ScreenMappingCabinet(BaseModel):
    """Per-cabinet geometry and display config."""

    cabinet_id: str

    # Physical pixel dimensions of this cabinet's LED canvas
    resolution_px: PositiveIntPair  # [width_px, height_px]

    # Physical active-area dimensions in millimetres
    active_size_mm: PositiveSizePair  # [width_mm, height_mm]

    # Physical pixel pitch in millimetres (may differ x/y for non-square pixels)
    pixel_pitch_mm: PositiveSizePair  # [pitch_x, pitch_y]

    # Only "center" is supported; non-center values are rejected at model
    # construction time by the Literal type (they never reach preflight).
    active_origin: Literal["center"]

    # Sub-rectangle of the input feed mapped onto this cabinet [x, y, w, h] in px
    input_rect_px: _IntList4

    # Physical rotation of the cabinet relative to the canonical board orientation.
    # Field bounds give a coarse range; model_post_init enforces {0,90,180,270}.
    rotation: Annotated[int, Field(ge=0, le=270)]

    # Horizontal / vertical mirror flags
    mirror_x: bool
    mirror_y: bool

    def model_post_init(self, __context: object) -> None:
        if self.rotation not in {0, 90, 180, 270}:
            raise ValueError(
                f"rotation must be one of {{0, 90, 180, 270}}, got {self.rotation}"
            )

        # Scale-consistency guard. local-mm derives metric scale from
        # pixel_pitch_mm, while the active-surface corners (pose report / size
        # checks) use active_size_mm. The two MUST agree (pitch = active/res) or
        # the reconstruction silently mixes scales. Reject >1% divergence — well
        # above pitch rounding noise (~0.05%), well below a data-entry error.
        for axis, name in ((0, "width"), (1, "height")):
            implied = self.resolution_px[axis] * self.pixel_pitch_mm[axis]
            if abs(implied - self.active_size_mm[axis]) > 0.01 * self.active_size_mm[axis]:
                raise ValueError(
                    f"cabinet '{self.cabinet_id}' {name} is inconsistent: "
                    f"resolution_px {self.resolution_px[axis]} × pixel_pitch_mm "
                    f"{self.pixel_pitch_mm[axis]} = {implied:.3f}mm, but "
                    f"active_size_mm = {self.active_size_mm[axis]}mm (>1% apart). "
                    f"These set the BA metric scale and must match — "
                    f"set pixel_pitch_mm = active_size_mm / resolution_px."
                )

        # 1:1 feed guard. The pitch-based board geometry assumes each cabinet
        # pixel maps 1:1 to the feed, i.e. input_rect_px width/height equal
        # resolution_px (only the x/y offset may differ, e.g. a gap between
        # monitors). A scaled feed (w/h != resolution) would put the displayed
        # board at a different size than local-mm assumes — fail loud.
        if (self.input_rect_px[2], self.input_rect_px[3]) != (
            self.resolution_px[0], self.resolution_px[1]
        ):
            raise ValueError(
                f"cabinet '{self.cabinet_id}' input_rect_px size "
                f"[{self.input_rect_px[2]}, {self.input_rect_px[3]}] must equal "
                f"resolution_px {self.resolution_px} (1:1 feed required; only the "
                f"[x, y] offset may differ). Scaled feeds are not supported."
            )


# ---------------------------------------------------------------------------
# Top-level mapping model
# ---------------------------------------------------------------------------

class ScreenMapping(BaseModel):
    """Full screen → cabinet → mm mapping config for a single LED screen."""

    screen_id: str
    cabinets: list[ScreenMappingCabinet]
    # Optional: the pattern hash only exists AFTER generate-pattern writes
    # pattern_meta.json, so a freshly authored screen_mapping.json (used to DRIVE
    # generate-pattern) cannot know it yet. When omitted, generate-pattern works
    # and reconstruct's preflight skips the capture↔pattern binding check (the
    # reconstruct call site emits a pattern_hash_unset warning). Set it to the
    # generated pattern's hash to enable verification at reconstruct.
    expected_pattern_hash: str | None = None

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _cabinet(self, cabinet_id: str) -> ScreenMappingCabinet:
        """Return the cabinet with the given id, or raise ScreenMappingError."""
        for cab in self.cabinets:
            if cab.cabinet_id == cabinet_id:
                return cab
        raise ScreenMappingError(
            f"Cabinet '{cabinet_id}' not found in screen '{self.screen_id}'. "
            f"Known: {[c.cabinet_id for c in self.cabinets]}"
        )

    # ------------------------------------------------------------------
    # Core geometry
    # ------------------------------------------------------------------

    def charuco_corner_local_mm(
        self,
        cabinet_id: str,
        charuco_id: int,
        *,
        squares_x: int,
        squares_y: int,
        square_px: int,
    ) -> np.ndarray:
        """Local-mm of a ChArUco inner corner [x, y, 0], pitch-based.

        Origin = board center. +x right, **+y up** (so +z = x×y points outward,
        toward the viewer). This MUST match OpenCV's ChArUco board object-point
        frame (origin bottom-left, +y up): feeding y-down points (the displayed
        image convention) to solvePnP recovers a vertically-flipped / chirally
        mirrored board pose — low reprojection but physically mirrored, which
        silently corrupts every relative cabinet pose. Uses the cabinet's own
        pixel pitch so coordinates are exact for any per-cabinet size/pitch and
        any non-square (squares_x != squares_y) board.

        Parameters
        ----------
        cabinet_id : str
        charuco_id : int   0-based ChArUco inner-corner index (L-R, T-B)
        squares_x / squares_y / square_px : int
            The cabinet's board geometry from `pattern_meta` (v2). The board is
            squares_x x squares_y cells, each square_px pixels; inner corners per
            row = squares_x - 1.

        Raises
        ------
        ScreenMappingError
            - cabinet_id not found
            - cabinet has rotation != 0 or mirror_x/mirror_y set (deferred; MVP
              uses rotation=0 / no-mirror only — fail loud, not silent)
        """
        cab = self._cabinet(cabinet_id)

        # Guard: rotation and mirror handling is deferred.  Return wrong coords
        # silently would corrupt BA metric scale, so we raise instead.
        if cab.rotation != 0 or cab.mirror_x or cab.mirror_y:
            raise ScreenMappingError(
                "rotation/mirror not yet supported in local-mm mapping. "
                f"Cabinet '{cabinet_id}' has rotation={cab.rotation}, "
                f"mirror_x={cab.mirror_x}, mirror_y={cab.mirror_y}. "
                "MVP/monitor-bench requires rotation=0 and no mirror."
            )

        pitch_x, pitch_y = cab.pixel_pitch_mm
        inner_x = squares_x - 1             # inner corners per row
        # ChArUco numbers corners left-to-right, top-to-bottom.
        r, c = divmod(charuco_id, inner_x)

        # Corner (r, c) sits at board-pixel ((c+1)*square_px, (r+1)*square_px).
        # Subtract half the board pixel size to move from edge-origin to center,
        # then scale by the cabinet's own pixel pitch -> exact mm.
        board_w_px = squares_x * square_px
        board_h_px = squares_y * square_px
        x_px = (c + 1) * square_px
        y_px = (r + 1) * square_px
        # FIX-6 companion: pattern.py's _assemble_screen blits the board at
        # rect + (rect_size - board_size) // 2 — integer FLOOR centring. When
        # (rect - board) is ODD the painted board sits 0.5px left/up of the
        # rect centre this frame assumes; fold that parity offset into the
        # local coordinate so p_local matches the PAINTED corner (pre-fix this
        # was a constant <=0.5 LED px systematic bias on odd-slack cabinets).
        rx, ry, rw, rh = cab.input_rect_px
        off_x = (rw - board_w_px) // 2 - (rw - board_w_px) / 2.0   # 0.0 or -0.5
        off_y = (rh - board_h_px) // 2 - (rh - board_h_px) / 2.0
        x_mm = (x_px - board_w_px / 2.0 + off_x) * pitch_x
        # +y UP: larger y_px (lower on the displayed pattern) → smaller local y,
        # matching OpenCV's y-up ChArUco board frame. See docstring.
        y_mm = (board_h_px / 2.0 - y_px - off_y) * pitch_y
        return np.array([x_mm, y_mm, 0.0], dtype=float)

    # ------------------------------------------------------------------
    # Preflight check
    # ------------------------------------------------------------------

    def preflight(self, actual_pattern_hash: str) -> None:
        """Validate pattern hash before running reconstruct.

        Raises ScreenMappingError on hash mismatch. When
        self.expected_pattern_hash is None only the hash comparison is skipped
        (the reconstruct call site warns the operator).

        FIX-27: the old ``image_size`` parameter compared the *camera* frame
        size against *LED canvas* resolution_px — a conceptual error (they are
        unrelated quantities). All call sites already bypassed it; removed.
        """
        if (
            self.expected_pattern_hash is not None
            and actual_pattern_hash != self.expected_pattern_hash
        ):
            raise ScreenMappingError(
                f"Pattern hash mismatch: expected '{self.expected_pattern_hash}', "
                f"got '{actual_pattern_hash}'. "
                "Re-generate or re-import the expected hash."
            )
