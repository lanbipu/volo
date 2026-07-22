"""Cabinet-grid wireframe generation + projection (AR overlay)."""

from __future__ import annotations

import numpy as np

from vpcal.core.grid_overlay import (
    cabinet_grid_polylines,
    opencv_T_from_stage_pose,
    project_grid_overlay,
)
from vpcal.core.projection import CameraIntrinsics
from vpcal.core.screen_geometry import section_grid
from vpcal.models.screen import ArcSection, PlaneSection, ScreenDefinition


def _plane_screen(width=2000, height=1000, cab=500) -> ScreenDefinition:
    return ScreenDefinition(
        name="wall",
        unit="mm",
        cabinet_size=(cab, cab),
        led_pixel_pitch_mm=2.8,
        markers_per_cabinet=1,
        sections=[PlaneSection(name="wall", width_mm=width, height_mm=height, origin=[0, 0, 0])],
    )


def test_plane_grid_seam_counts():
    screen = _plane_screen()
    n_rows, n_cols = section_grid(screen, screen.sections[0])
    assert (n_rows, n_cols) == (2, 4)
    polylines, markers = cabinet_grid_polylines(screen, include_markers=True)
    # vertical seams (n_cols+1) + horizontal seams (n_rows+1)
    assert len(polylines) == (n_cols + 1) + (n_rows + 1)
    # each plane seam is 2 endpoints
    assert all(len(pl) == 2 for pl in polylines)
    # cabinet corners (5×3) + cell centres (8)
    assert len(markers) == (n_cols + 1) * (n_rows + 1) + n_cols * n_rows


def test_plane_outer_extents():
    screen = _plane_screen()
    polylines, _ = cabinet_grid_polylines(screen, include_markers=False)
    pts = np.vstack(polylines)
    # PlaneSection: u=0 → x=-1000, u=1 → x=+1000, v=0 → z=0, v=1 → z=1000
    assert abs(float(np.min(pts[:, 0])) - (-1000.0)) < 1e-6
    assert abs(float(np.max(pts[:, 0])) - 1000.0) < 1e-6
    assert abs(float(np.min(pts[:, 2])) - 0.0) < 1e-6
    assert abs(float(np.max(pts[:, 2])) - 1000.0) < 1e-6


def test_arc_horizontal_seams_are_sampled():
    screen = ScreenDefinition(
        name="curve",
        unit="mm",
        cabinet_size=(1000, 1000),
        led_pixel_pitch_mm=2.8,
        markers_per_cabinet=1,
        sections=[
            ArcSection(
                name="arc",
                arc_radius_mm=5000,
                arc_angle_deg=60,
                arc_center_angle_deg=180,
                height_mm=2000,
            )
        ],
    )
    polylines, _ = cabinet_grid_polylines(screen, include_markers=False)
    n_rows, n_cols = section_grid(screen, screen.sections[0])
    # vertical seams stay 2-pt; horizontal seams sample along U
    vertical = [pl for pl in polylines if len(pl) == 2]
    horizontal = [pl for pl in polylines if len(pl) > 2]
    assert len(vertical) == n_cols + 1
    assert len(horizontal) == n_rows + 1
    assert all(len(pl) == 24 for pl in horizontal)


def test_project_frontal_camera_keeps_segments_in_frame():
    screen = _plane_screen()
    # Camera in front of the wall looking +Y (OpenCV: +Z forward).
    # Place camera at (0, -3000, 500), looking toward +Y → rotate so cam +Z = Stage +Y.
    R = np.array(
        [
            [1.0, 0.0, 0.0],
            [0.0, 0.0, -1.0],
            [0.0, 1.0, 0.0],
        ],
        dtype=np.float64,
    )
    t = -R @ np.array([0.0, -3000.0, 500.0])
    T = np.eye(4)
    T[:3, :3] = R
    T[:3, 3] = t
    intr = CameraIntrinsics(fx=1200, fy=1200, cx=960, cy=540, width=1920, height=1080)
    out = project_grid_overlay([("wall", screen)], T, intr)
    assert out["image_size"] == [1920, 1080]
    assert len(out["screens"]) == 1
    segs = out["screens"][0]["segments"]
    assert len(segs) >= 8  # outer frame + seams
    for x1, y1, x2, y2 in segs:
        for v in (x1, y1, x2, y2):
            assert -0.05 <= v <= 1.05


def test_opencv_T_from_stage_pose_roundtrip():
    # Identity OpenCV pose → Volo matrix via the same basis flip as the pose CLI.
    R_cv = np.eye(3)
    t_cv = np.array([100.0, 200.0, 3000.0])
    cam_pos = -R_cv.T @ t_cv
    cv_from_volo = np.diag([1.0, -1.0, -1.0])
    R_volo = R_cv.T @ cv_from_volo
    M = np.eye(4)
    M[:3, :3] = R_volo
    M[:3, 3] = cam_pos
    pose = {"camera_from_stage": {"matrix_4x4": M.tolist()}}
    T = opencv_T_from_stage_pose(pose)
    assert np.allclose(T[:3, :3], R_cv, atol=1e-9)
    assert np.allclose(T[:3, 3], t_cv, atol=1e-9)
