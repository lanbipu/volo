"""Marker-field layout: grid identity → screen UV → 3D world point.

This is the single source of truth that ties the marker encoding (pattern.py),
the synthetic projection (simulator.py) and the 3D lookup in the solve stage
together.  A marker's :class:`~vpcal.core.observations.MarkerId`
``(screen_id, cab_col, cab_row, local_id)`` deterministically maps to a UV
on one screen section and thus to a 3D point in the UE/Stage frame.

Layout (VP-QSP cell-centred grid):
  * Each section is tiled by cabinets along its U and V extents.
  * ``cab_col`` is a global cabinet column with a running offset per section.
  * ``cab_row`` is the cabinet row (0 at the bottom).
  * ``local_id`` is the marker's row-major index within the cabinet.
  * With ``markers_per_cabinet == 1`` each cabinet holds one centred marker
    (``local_id == 0``).  With ``markers_per_cabinet > 1`` the cabinet is
    subdivided into sub-quadrants (legacy LED-wall mode).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

from vpcal.core.errors import PreconditionError
from vpcal.core.observations import MarkerId
from vpcal.models.screen import ScreenDefinition

# Sub-marker offsets within a cabinet cell, in cell-fraction coordinates.
_SUB_QUADRANTS = [(0.25, 0.25), (0.75, 0.25), (0.25, 0.75), (0.75, 0.75)]

from vpcal.core.pattern import MAX_COL, MAX_ROW, MAX_LOCAL, MAX_SCREEN

# The number of markers per cabinet must be identical across pattern generation,
# simulation, and the solve-stage 3D lookup, or marker ids resolve to the wrong
# world points.  This constant is the project-wide default.
DEFAULT_MARKERS_PER_CABINET = 4

_MIN_CABINETS_PER_AXIS = 3

# Marker-grid sizing ported from LED Mesh Toolkit (vpqsp_layout.py).
# Anchor marker count to the screen's SHORT side so density scales with
# physical size; the long side scales by aspect ratio to keep cells square.
_TARGET_MARKERS_SHORT = 6
_MIN_CELL_PX = 80
_DEFAULT_MARKER_FILL = 0.9


def auto_cabinet_size(
    sections: list,
    markers_per_cabinet: int = DEFAULT_MARKERS_PER_CABINET,
    led_pixel_pitch_mm: float | None = None,
) -> tuple[float, float]:
    """Derive cabinet size for adequate marker coverage.

    When *led_pixel_pitch_mm* is provided the algorithm anchors to the screen's
    pixel resolution (short-side-first, ported from LED Mesh Toolkit's
    ``choose_marker_grid``).  This produces denser, edge-reaching grids that
    work well for both LED walls and regular displays.

    Without pixel pitch info the legacy heuristic (min extent / 3) is used.
    """
    if not sections:
        return (500.0, 500.0)

    min_u = min(s.u_extent_mm() for s in sections)
    min_v = min(s.v_extent_mm() for s in sections)

    if led_pixel_pitch_mm is not None and led_pixel_pitch_mm > 0:
        w_px = min_u / led_pixel_pitch_mm
        h_px = min_v / led_pixel_pitch_mm
        short_px = min(w_px, h_px)
        long_px = max(w_px, h_px)
        is_landscape = w_px >= h_px

        best = None  # (nx, ny, squareness, count)
        for ms in range(_TARGET_MARKERS_SHORT, 1, -1):
            cell = short_px / ms
            if cell < _MIN_CELL_PX:
                continue
            ml = max(2, round(long_px / cell))
            if ml < 2 or long_px / ml < _MIN_CELL_PX:
                continue
            mx = ml if is_landscape else ms
            my = ms if is_landscape else ml
            cell_w = w_px / mx
            cell_h = h_px / my
            sq = min(cell_w, cell_h) / max(cell_w, cell_h)
            count = mx * my
            if best is None or sq > best[2] + 0.02 or (
                sq >= best[2] - 0.005 and count > best[3]
            ):
                best = (mx, my, sq, count)

        if best is not None:
            nx, ny = best[0], best[1]
            return (min_u / nx, min_v / ny)

    # Fallback: legacy heuristic.
    min_per_axis = _MIN_CABINETS_PER_AXIS if markers_per_cabinet <= 1 else 2
    return (min_u / min_per_axis, min_v / min_per_axis)


def cabinet_coverage_warning(
    screen: "ScreenDefinition", *, markers_per_cabinet: int = DEFAULT_MARKERS_PER_CABINET
) -> str | None:
    """Return a warning string if any section has fewer than _MIN_CABINETS_PER_AXIS
    cabinets on either axis, meaning marker coverage will be sparse."""
    sparse = []
    for section in screen.sections:
        n_rows, n_cols = section_grid(screen, section)
        if n_rows < 2 or n_cols < 2:
            sparse.append(
                f"section '{section.name}': {n_cols}×{n_rows} cabinets "
                f"({n_cols * n_rows * markers_per_cabinet} markers) — "
                f"marker coverage may be insufficient for lens calibration"
            )
    if not sparse:
        return None
    return "; ".join(sparse)


@dataclass(frozen=True)
class ScreenMarker:
    """A laid-out marker: identity + its UV on a section + its 3D world point."""

    marker_id: MarkerId
    section_name: str
    u: float
    v: float
    world: tuple[float, float, float]  # UE/Stage frame, mm


def _sub_offsets(markers_per_cabinet: int) -> list[tuple[float, float]]:
    if markers_per_cabinet <= 1:
        return [(0.5, 0.5)]
    return _SUB_QUADRANTS[: min(markers_per_cabinet, 4)]


def section_grid(screen: ScreenDefinition, section) -> tuple[int, int]:  # type: ignore[no-untyped-def]
    """Return ``(n_rows, n_cols)`` cabinet tiling for a section."""
    cw, ch = screen.cabinet_size
    n_cols = max(1, round(section.u_extent_mm() / cw))
    n_rows = max(1, round(section.v_extent_mm() / ch))
    return n_rows, n_cols


def enumerate_markers(
    screen: ScreenDefinition,
    *,
    markers_per_cabinet: int = 1,
    max_markers: int | None = None,
    screen_id: int = 0,
    cab_col_offset: int = 0,
) -> list[ScreenMarker]:
    """Enumerate every marker on the screen (deterministic order).

    With ``markers_per_cabinet == 1`` (default), each cabinet holds one marker
    at its centre (``local_id == 0``).  With ``markers_per_cabinet > 1`` the
    cabinet is subdivided into sub-quadrants and ``local_id`` indexes them.

    Raises :class:`PreconditionError` if the grid exceeds the VP-QSP encoding
    capacity.
    """
    subs = _sub_offsets(markers_per_cabinet)
    markers: list[ScreenMarker] = []
    col_offset = cab_col_offset
    for section in screen.sections:
        n_rows, n_cols = section_grid(screen, section)
        for c in range(n_cols):
            global_col = col_offset + c
            for r in range(n_rows):
                for s, (ou, ov) in enumerate(subs):
                    if (
                        screen_id > MAX_SCREEN
                        or global_col > MAX_COL
                        or r > MAX_ROW
                        or s > MAX_LOCAL
                    ):
                        raise PreconditionError(
                            "marker grid exceeds VP-QSP encoding capacity",
                            details={
                                "screen_id": screen_id,
                                "cab_col": global_col,
                                "cab_row": r,
                                "local_id": s,
                                "max": [MAX_SCREEN, MAX_COL, MAX_ROW, MAX_LOCAL],
                            },
                        )
                    u = (c + ou) / n_cols
                    v = (r + ov) / n_rows
                    world = section.uv_to_world(u, v)
                    markers.append(
                        ScreenMarker(
                            marker_id=MarkerId(screen_id, global_col, r, s),
                            section_name=section.name,
                            u=u,
                            v=v,
                            world=(float(world[0]), float(world[1]), float(world[2])),
                        )
                    )
                    if max_markers is not None and len(markers) >= max_markers:
                        return markers
        col_offset += n_cols
    return markers


def marker_world_map(
    screen: ScreenDefinition, *, markers_per_cabinet: int = 1
) -> dict[MarkerId, NDArray[np.float64]]:
    """Map every :class:`MarkerId` to its 3D world point (UE frame, mm)."""
    return {
        m.marker_id: np.asarray(m.world, dtype=np.float64)
        for m in enumerate_markers(screen, markers_per_cabinet=markers_per_cabinet)
    }


def uv_to_pattern_pixel(
    u: float, v: float, width_px: int, height_px: int
) -> tuple[float, float]:
    """Map a section UV position to a continuous pattern pixel coordinate.

    Pixel-centre convention: LED pixel index ``i`` has its physical centre at
    ``(i + 0.5) · pitch``, so UV position ``u`` lands at pixel coordinate
    ``u · width_px − 0.5`` (``v`` flipped — image row 0 is the section top).
    Pattern rendering and the marker world map (``uv_to_world``) must both go
    through this one mapping so the displayed dot and the 3D lookup agree
    (remediation A2.1).
    """
    return u * width_px - 0.5, (1.0 - v) * height_px - 0.5
