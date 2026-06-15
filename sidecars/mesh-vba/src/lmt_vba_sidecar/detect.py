"""ChArUco marker detection across an image set.

Returns one observation list per image: each observation is a marker corner
pixel coordinate plus its ArUco ID, ready for bundle adjustment.
"""
from __future__ import annotations

import cv2
import numpy as np


def _aruco_dict():
    return cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_6X6_1000)


def _edge_cov(corners: np.ndarray) -> float:
    """Coefficient of variation of quad edge lengths — lower = more square."""
    pts = corners.reshape(4, 2)
    edges = np.array([np.linalg.norm(pts[i] - pts[(i + 1) % 4]) for i in range(4)])
    return float(np.std(edges) / (np.mean(edges) + 1e-12))


def _charuco_board(aruco_id_start: int, squares_x: int, squares_y: int) -> cv2.aruco.CharucoBoard:
    """Reconstruct the per-cabinet CharucoBoard generate_cabinet_png() produced.

    Mirrors pattern.py:
      - sub-dict slice: bytesList[start : start + markers_per_board]
      - board size: (squares_x, squares_y) — may be non-square
      - squareLength=1.0, markerLength=0.7
    The sub-dict re-indexes this cabinet's markers to local ids 0..n-1, so callers
    must localize global marker ids (global - aruco_id_start) before interpolation.
    """
    from lmt_vba_sidecar.board_layout import markers_per_board
    aruco_dict = _aruco_dict()
    n_markers = markers_per_board(squares_x, squares_y)
    sub_dict = cv2.aruco.Dictionary(
        aruco_dict.bytesList[aruco_id_start:aruco_id_start + n_markers],
        aruco_dict.markerSize,
    )
    return cv2.aruco.CharucoBoard(
        size=(squares_x, squares_y),
        squareLength=1.0,
        markerLength=0.7,
        dictionary=sub_dict,
    )


def detect_charuco_corners(
    image_paths: list[str],
    *,
    boards: list[dict] | None = None,
    board_lookup_for_test: bool = False,
) -> dict[str, list[dict]]:
    """Detect ChArUco corners across images with ONE detectMarkers pass per image.

    One `cv2.aruco.detectMarkers(img, DICT_6X6_1000)` per image; each detected
    marker is routed to its cabinet via a precomputed marker_id->cabinet map; then
    per cabinet `interpolateCornersCharuco` recovers sub-pixel checkerboard corners
    from the routed marker subset. Replaces the old O(N_cabinets) full-image
    detectBoard re-scan.

    Each returned observation:
      {"cabinet": (col, row), "charuco_id": int, "corner_px": [x, y]}

    Parameters
    ----------
    image_paths:
        Paths to input images (read as grayscale internally).
    boards:
        Board descriptors (from pattern_meta v2 via reconstruct):
          {"cabinet": (col, row), "aruco_id_start": int, "aruco_id_end": int,
           "squares_x": int, "squares_y": int}
    board_lookup_for_test:
        When True, ignore `boards` and substitute a single default 9x9 board
        for unit-test use without a real pattern_meta.json.

    Unreadable images yield an empty list (not an exception), matching the
    tolerance of detect_charuco_observations.
    """
    from lmt_vba_sidecar.board_layout import build_marker_routing
    if board_lookup_for_test:
        boards = [{"cabinet": (0, 0), "aruco_id_start": 0, "aruco_id_end": 39,
                   "squares_x": 9, "squares_y": 9}]
    if not boards:
        return {path: [] for path in image_paths}

    # interpolateCornersCharuco is the legacy (deprecated) aruco API. It is
    # present through OpenCV 4.x but could be dropped in a future build the pin
    # (opencv-contrib-python>=4.8,<5.0) allows. Fail with an actionable message
    # rather than a cryptic AttributeError mid-detection.
    if not hasattr(cv2.aruco, "interpolateCornersCharuco"):
        raise RuntimeError(
            f"cv2.aruco.interpolateCornersCharuco is unavailable in OpenCV "
            f"{cv2.__version__}; per-cabinet ChArUco interpolation requires it. "
            f"Pin opencv-contrib-python to a version that provides it (e.g. 4.11.x)."
        )

    routing = build_marker_routing(boards)  # global marker_id -> (col, row)
    # Per cabinet: a local board + the global id offset (to localize marker ids).
    cab_board: dict[tuple, dict] = {}
    for b in boards:
        cr = tuple(b["cabinet"])
        cab_board[cr] = {
            "board": _charuco_board(b["aruco_id_start"], b["squares_x"], b["squares_y"]),
            "offset": b["aruco_id_start"],
        }

    dictionary = _aruco_dict()
    params = cv2.aruco.DetectorParameters()
    # FIX-26: tune for LED panels (self-emissive, pixel grid, bloom-prone).
    params.cornerRefinementMethod = cv2.aruco.CORNER_REFINE_SUBPIX
    params.adaptiveThreshWinSizeMin = 5
    params.adaptiveThreshWinSizeMax = 23
    params.adaptiveThreshWinSizeStep = 4
    detector = cv2.aruco.ArucoDetector(dictionary, params)

    out: dict[str, list[dict]] = {}
    for path in image_paths:
        img = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
        if img is None:
            out[path] = []
            continue
        corners, ids, _ = detector.detectMarkers(img)  # ONE scan
        observations: list[dict] = []
        if ids is not None:
            # Bucket detected markers by cabinet using the routing map.
            # FIX-26: deduplicate (cabinet, marker_id) — keep the detection
            # with the smallest contour-area coefficient of variation (most
            # square = most confident). Duplicates from background false
            # positives or moiré ghosts would otherwise poison interpolation.
            buckets: dict[tuple, dict[int, np.ndarray]] = {}
            for mc, mid in zip(corners, ids.flatten()):
                cr = routing.get(int(mid))
                if cr is None:
                    continue
                local_id = int(mid) - cab_board[cr]["offset"]
                cab_bucket = buckets.setdefault(cr, {})
                if local_id in cab_bucket:
                    if _edge_cov(mc) < _edge_cov(cab_bucket[local_id]):
                        cab_bucket[local_id] = mc
                else:
                    cab_bucket[local_id] = mc
            for cr, lid_to_mc in buckets.items():
                mcs = list(lid_to_mc.values())
                lids = list(lid_to_mc.keys())
                board = cab_board[cr]["board"]
                _n, ch_corners, ch_ids = cv2.aruco.interpolateCornersCharuco(
                    mcs, np.array(lids, dtype=np.int32).reshape(-1, 1), img, board)
                if ch_ids is None:
                    continue
                for cid, (cx, cy) in zip(ch_ids.flatten(), ch_corners.reshape(-1, 2)):
                    observations.append({
                        "cabinet": cr,
                        "charuco_id": int(cid),
                        "corner_px": [float(cx), float(cy)],
                    })
        out[path] = observations
    return out


def detect_charuco_observations(
    image_paths: list[str],
) -> dict[str, list[dict]]:
    """For each image, return per-marker observations.

    Each observation:
      {"aruco_id": int, "corners_px": [[x0,y0],[x1,y1],[x2,y2],[x3,y3]]}

    Missing or unreadable images yield an empty list (not an exception);
    callers aggregate across the full set and decide via thresholds whether
    detection is sufficient.
    """
    dictionary = _aruco_dict()
    params = cv2.aruco.DetectorParameters()
    params.cornerRefinementMethod = cv2.aruco.CORNER_REFINE_SUBPIX
    params.adaptiveThreshWinSizeMin = 5
    params.adaptiveThreshWinSizeMax = 23
    params.adaptiveThreshWinSizeStep = 4
    detector = cv2.aruco.ArucoDetector(dictionary, params)

    out: dict[str, list[dict]] = {}
    for path in image_paths:
        img = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
        if img is None:
            out[path] = []
            continue
        corners, ids, _ = detector.detectMarkers(img)
        observations: list[dict] = []
        if ids is not None:
            criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 1e-3)
            for marker_corners, marker_id in zip(corners, ids.flatten()):
                refined = cv2.cornerSubPix(
                    img, marker_corners, (5, 5), (-1, -1), criteria,
                )
                observations.append({
                    "aruco_id": int(marker_id),
                    "corners_px": refined.reshape(-1, 2).tolist(),
                })
        out[path] = observations
    return out
