"""Pure helpers for per-cabinet ChArUco board layout, marker-id routing,
and canonical naming. No OpenCV, no IO — easy to unit test."""
from __future__ import annotations

DEFAULT_SQUARES_SHORT = 9   # squares on the cabinet's SHORT side (legacy 9x9 -> 40 markers)
MIN_SQUARE_PX = 60          # detectability FLOOR (6x6 marker @0.7 ratio ~6 px/bit), not the target
MARKER_LENGTH_RATIO = 0.7   # matches pattern.py board construction


def choose_board_shape(
    *,
    resolution_px: tuple[int, int],
    squares_short: int = DEFAULT_SQUARES_SHORT,
) -> tuple[int, int, int]:
    """Pick (squares_x, squares_y, square_px) for one cabinet.

    Square COUNT is anchored to the short side (`squares_short`) so a square
    cabinet reproduces the legacy 9x9/40-marker board and the 1000-marker
    dictionary ceiling (25 cabinets) is preserved. The long side scales by
    aspect ratio, so a non-square cabinet yields squares_x != squares_y. Each
    cell renders at an integer `square_px`, so cells stay perfectly square (no
    stretch). `MIN_SQUARE_PX` is only a detectability floor for tiny cabinets.
    """
    w_px, h_px = resolution_px
    short = min(w_px, h_px)
    square_px = max(MIN_SQUARE_PX, short // squares_short)
    squares_x = max(2, w_px // square_px)
    squares_y = max(2, h_px // square_px)
    return squares_x, squares_y, square_px


def markers_per_board(squares_x: int, squares_y: int) -> int:
    """ArUco markers on a squares_x × squares_y ChArUco board (alternating cells)."""
    return (squares_x * squares_y) // 2


def cabinet_name(col: int, row: int) -> str:
    return f"V{col:03d}_R{row:03d}"


def corner_name(screen_id: str, col: int, row: int, charuco_id: int) -> str:
    """Canonical measured-point / corner name. Reverse-routable by a tool."""
    return f"{screen_id}_{cabinet_name(col, row)}_C{charuco_id:03d}"


def build_marker_routing(blocks: list[dict]) -> dict[int, tuple[int, int]]:
    """Build marker_id -> (col, row). O(total markers) build, O(1) lookup.

    `blocks` items carry `aruco_id_start`/`aruco_id_end` (inclusive) plus the
    cabinet identity either as a `"cabinet": (col, row)` tuple (detect/reconstruct
    board descriptors) or as separate `"col"`/`"row"` keys (pattern_meta blocks).
    """
    route: dict[int, tuple[int, int]] = {}
    for b in blocks:
        if "cabinet" in b:
            col, row = b["cabinet"]
        else:
            col, row = b["col"], b["row"]
        for marker_id in range(b["aruco_id_start"], b["aruco_id_end"] + 1):
            route[marker_id] = (int(col), int(row))
    return route
