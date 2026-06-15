"""Shared pytest fixtures."""
from __future__ import annotations

import hashlib
import json
import pathlib

import cv2
import numpy as np
import pytest

from lmt_vba_sidecar.board_layout import choose_board_shape, markers_per_board
from lmt_vba_sidecar.ipc import PatternMeta
from lmt_vba_sidecar.pattern import generate_cabinet_png


@pytest.fixture
def tmp_out(tmp_path: pathlib.Path) -> pathlib.Path:
    """Return a clean tmp path for sidecar outputs (no setup)."""
    return tmp_path


# ---------------------------------------------------------------------------
# synthetic_charuco_capture: a fully self-consistent two-cabinet capture set.
#
# Consistency chain (must stay intact, see reconstruct.py / screen_mapping.py):
#   Each board PNG is rendered to occupy the FULL active surface, so an inner
#   ChArUco corner detected at PNG pixel x ~= (c+1)/(inner+1)*W lands at local
#   mm x = active_w*((c+1)/(inner+1) - 0.5) — exactly the convention used by
#   ScreenMapping.charuco_corner_local_mm. Detection -> local mm -> BA therefore
#   recovers true geometry without any anchors / total station.
# ---------------------------------------------------------------------------

# True scene geometry (board frame -> world, world in mm).
# Board0 is the root (identity pose). Board1 is translated +700mm in x and
# yawed 10 deg about Y, so the inter-board normal angle is exactly 10 deg.
_INNER = 8
_BOARD_DISTANCE_MM = 700.0
_BOARD_ANGLE_DEG = 10.0
# Active surface is SQUARE so the (square) ChArUco board fills the whole PNG
# with no letterbox — that is what keeps the consistency chain exact (a
# non-square PNG centers the square board and breaks the local-mm convention
# in the wider axis). cv2.aruco.CharucoBoard(size=(9,9)) is intrinsically square.
_ACTIVE_W_MM = 600.0
_ACTIVE_H_MM = 600.0
_RES_PX = (630, 630)  # board PNG pixel size (also cabinet resolution_px)
_IMAGE_SIZE = (1920, 1080)


def _pattern_hash(pattern_meta: PatternMeta) -> str:
    """Deterministic pattern hash — MUST match reconstruct._pattern_hash."""
    return hashlib.sha256(pattern_meta.model_dump_json().encode()).hexdigest()[:16]


def _render_board_into(
    canvas: np.ndarray,
    board_png: np.ndarray,
    Rb: np.ndarray,
    tb: np.ndarray,
    K: np.ndarray,
    Rc: np.ndarray,
    tc: np.ndarray,
) -> None:
    """Warp one board PNG (full active surface) into the camera canvas.

    The PNG's four corner pixels map to the active-surface corners in local mm
    (center origin), through the board pose into world, then through the camera
    into image pixels. A mask composites the warp so board1 can overlay board0
    without painting the gray border over already-rendered content.
    """
    h_px, w_px = board_png.shape
    half_w, half_h = _ACTIVE_W_MM / 2.0, _ACTIVE_H_MM / 2.0
    # PNG corner pixels (TL, TR, BR, BL) and their local-mm counterparts.
    src = np.array([[0, 0], [w_px, 0], [w_px, h_px], [0, h_px]], dtype=np.float32)
    local_corners = np.array(
        [
            [-half_w, -half_h, 0.0],
            [half_w, -half_h, 0.0],
            [half_w, half_h, 0.0],
            [-half_w, half_h, 0.0],
        ],
        dtype=np.float64,
    )
    world = (local_corners @ Rb.T) + tb
    cam = (world @ Rc.T) + tc
    if (cam[:, 2] <= 0).any():
        raise ValueError("board projects behind camera")
    pix = (K @ cam.T).T
    dst = (pix[:, :2] / pix[:, 2:3]).astype(np.float32)

    H = cv2.getPerspectiveTransform(src, dst)
    warped = cv2.warpPerspective(
        board_png, H, _IMAGE_SIZE, flags=cv2.INTER_LINEAR, borderValue=0,
    )
    mask = np.full(board_png.shape, 255, dtype=np.uint8)
    warped_mask = cv2.warpPerspective(mask, H, _IMAGE_SIZE, flags=cv2.INTER_NEAREST)
    canvas[warped_mask > 0] = warped[warped_mask > 0]


def _camera_poses() -> list[tuple[np.ndarray, np.ndarray]]:
    """Generate >=12 camera poses that view both boards from varied angles.

    World scene center is the midpoint between the two board origins. Cameras
    sit on a sphere around it looking inward (look-at basis), matching the
    world-to-camera convention used by model_constrained_ba (xc = Rc@xw + tc).
    """
    center = np.array([_BOARD_DISTANCE_MM / 2.0, 0.0, 0.0])
    poses: list[tuple[np.ndarray, np.ndarray]] = []
    dist = 2200.0
    yaws = [-25, -12, 0, 12, 25]
    pitches = [-12, 0, 12]
    for yaw_deg in yaws:
        for pitch_deg in pitches:
            yaw = np.deg2rad(yaw_deg)
            pitch = np.deg2rad(pitch_deg)
            # Camera sits in front of the boards (negative world z) looking +z.
            cam_pos = center + dist * np.array(
                [np.sin(yaw) * np.cos(pitch), np.sin(pitch), -np.cos(yaw) * np.cos(pitch)]
            )
            fwd = center - cam_pos
            fwd /= np.linalg.norm(fwd)
            up = np.array([0.0, -1.0, 0.0])  # image y points down
            right = np.cross(up, fwd)
            right /= np.linalg.norm(right)
            up2 = np.cross(fwd, right)
            Rc = np.stack([right, up2, fwd])  # world-to-camera rotation
            tc = -Rc @ cam_pos
            poses.append((Rc, tc))
    return poses


def _build_synthetic_charuco_capture(
    tmp_path: pathlib.Path, cab1_view_limit: int | None = None
) -> dict:
    """Build a 2-cabinet ChArUco capture set with known truth.

    Returns a dict with file paths (capture manifest, screen_mapping, a
    pose_report output path) plus the known truth (distance 700mm, angle 10deg).

    ``cab1_view_limit``: if set, the non-root board (V001_R000) is composited
    into ONLY the first ``cab1_view_limit`` camera views; the root board stays in
    all views. Keep it >=2 so V001 still clears the HARD observability gate but
    falls below QUALITY_MIN_VIEWS, exercising the soft "low_observation" path.
    """
    cap_dir = tmp_path / "capture"
    cap_dir.mkdir()

    # --- render the two board PNGs (full active surface each) ---
    # v2: pick the board shape exactly as production does. For the square
    # _RES_PX=(630,630) this yields (9, 9, 70) -> 630x630 board filling the
    # active surface, so the pitch-based local-mm matches the rendered geometry.
    _sx, _sy, _spx = choose_board_shape(resolution_px=_RES_PX)
    board0_path = cap_dir / "board0.png"
    board1_path = cap_dir / "board1.png"
    next_id0 = generate_cabinet_png(
        out_path=board0_path, aruco_id_start=0,
        squares_x=_sx, squares_y=_sy, square_px=_spx,
    )
    next_id1 = generate_cabinet_png(
        out_path=board1_path, aruco_id_start=next_id0,
        squares_x=_sx, squares_y=_sy, square_px=_spx,
    )
    board0 = cv2.imread(str(board0_path), cv2.IMREAD_GRAYSCALE)
    board1 = cv2.imread(str(board1_path), cv2.IMREAD_GRAYSCALE)

    # --- true board poses (board frame -> world, mm) ---
    R0, t0 = np.eye(3), np.zeros(3)
    R1, _ = cv2.Rodrigues(np.array([0.0, np.deg2rad(_BOARD_ANGLE_DEG), 0.0]))
    t1 = np.array([_BOARD_DISTANCE_MM, 0.0, 0.0])

    # --- intrinsics (zero distortion) ---
    fx = fy = 2400.0
    cx, cy = _IMAGE_SIZE[0] / 2.0, _IMAGE_SIZE[1] / 2.0
    K = np.array([[fx, 0, cx], [0, fy, cy], [0, 0, 1]], dtype=float)

    # --- render each camera view, compositing both boards ---
    views = []
    for i, (Rc, tc) in enumerate(_camera_poses()):
        canvas = np.full((_IMAGE_SIZE[1], _IMAGE_SIZE[0]), 64, dtype=np.uint8)
        _render_board_into(canvas, board0, R0, t0, K, Rc, tc)
        # Board1 (V001_R000) only in the first cab1_view_limit views if limited.
        if cab1_view_limit is None or i < cab1_view_limit:
            _render_board_into(canvas, board1, R1, t1, K, Rc, tc)
        img_path = cap_dir / f"cam_{i:03d}.png"
        cv2.imwrite(str(img_path), canvas)
        views.append({"view_id": f"cam_{i:03d}", "images": [img_path.name]})

    # --- pattern_meta.json (v2: per-cabinet geometry) ---
    assert (next_id0 - 0) == markers_per_board(_sx, _sy)  # 40 markers per 9x9 board
    _pitch = [_ACTIVE_W_MM / _RES_PX[0], _ACTIVE_H_MM / _RES_PX[1]]

    def _meta_cab(col: int, row: int, id_start: int, id_end: int) -> dict:
        return {
            "col": col, "row": row, "aruco_id_start": id_start, "aruco_id_end": id_end,
            "squares_x": _sx, "squares_y": _sy, "square_px": _spx, "pixel_pitch_mm": _pitch,
        }

    pattern_meta = PatternMeta.model_validate(
        {
            "schema_version": 2,
            "aruco_dict": "DICT_6X6_1000",
            "cabinets": [
                _meta_cab(0, 0, 0, next_id0 - 1),
                _meta_cab(1, 0, next_id0, next_id1 - 1),
            ],
        }
    )
    pattern_meta_path = cap_dir / "pattern_meta.json"
    pattern_meta_path.write_text(pattern_meta.model_dump_json(indent=2))

    # --- intrinsics.json ---
    intrinsics_path = cap_dir / "intrinsics.json"
    intrinsics_path.write_text(
        json.dumps(
            {
                "K": K.tolist(),
                "dist_coeffs": [0.0, 0.0, 0.0, 0.0, 0.0],
                "image_size": list(_IMAGE_SIZE),
            }
        )
    )

    # --- screen_mapping.json ---
    pitch_x = _ACTIVE_W_MM / _RES_PX[0]
    pitch_y = _ACTIVE_H_MM / _RES_PX[1]

    def _cab(cabinet_id: str) -> dict:
        return {
            "cabinet_id": cabinet_id,
            "resolution_px": list(_RES_PX),
            "active_size_mm": [_ACTIVE_W_MM, _ACTIVE_H_MM],
            "pixel_pitch_mm": [pitch_x, pitch_y],
            "active_origin": "center",
            "input_rect_px": [0, 0, _RES_PX[0], _RES_PX[1]],
            "rotation": 0,
            "mirror_x": False,
            "mirror_y": False,
        }

    screen_mapping_path = cap_dir / "screen_mapping.json"
    screen_mapping_path.write_text(
        json.dumps(
            {
                "screen_id": "S",
                "cabinets": [_cab("V000_R000"), _cab("V001_R000")],
                "expected_pattern_hash": _pattern_hash(pattern_meta),
            }
        )
    )

    # --- capture.json (charuco manifest) ---
    capture_path = cap_dir / "capture.json"
    capture_path.write_text(
        json.dumps(
            {
                "method": "charuco",
                "intrinsics": "intrinsics.json",
                "pattern_meta": "pattern_meta.json",
                "screen_mapping": "screen_mapping.json",
                "views": views,
            }
        )
    )

    return {
        "capture": str(capture_path),
        "screen_mapping": str(screen_mapping_path),
        "pose_report": str(tmp_path / "cabinet_pose_report.json"),
        "distance_mm": _BOARD_DISTANCE_MM,
        "angle_deg": _BOARD_ANGLE_DEG,
    }


@pytest.fixture
def synthetic_charuco_capture(tmp_path: pathlib.Path) -> dict:
    """Full-visibility 2-cabinet ChArUco capture (both boards in every view)."""
    return _build_synthetic_charuco_capture(tmp_path)


@pytest.fixture
def synthetic_charuco_capture_underobserved(tmp_path: pathlib.Path) -> dict:
    """Like synthetic_charuco_capture, but the non-root board (V001_R000) is only
    in the first 3 views — still >=2 (clears observability) but below
    QUALITY_MIN_VIEWS (4), so it should be flagged "low_observation"."""
    return _build_synthetic_charuco_capture(tmp_path, cab1_view_limit=3)
