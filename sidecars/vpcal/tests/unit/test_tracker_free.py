"""Tracker-free calibration unit tests.

Covers the core functions: quaternion math, planar remapping, match_detections,
lens_calibrate, spatial_solve, verify_pose, and export_obj — using synthetic
data (rendered markers or direct solvePnP inputs) without disk I/O.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from unittest.mock import patch

import cv2
import numpy as np
import pytest

from vpcal.core.observations import MarkerId
from vpcal.core.errors import LocalizationQualityFailed, ScreenGeometryInconsistent
from vpcal.core.screen_geometry import enumerate_markers
from vpcal.core.transforms import matrix_to_quat, quat_to_matrix
from vpcal.core.tracker_free import (
    ExportedScreen,
    LensCalResult,
    ScreenPose,
    StagePoseTarget,
    SpatialResult,
    _average_transforms,
    _build_world_map,
    _match_detections,
    _to_planar,
    export_obj,
    lens_calibrate,
    spatial_solve,
    solve_stage_pose,
    verify_pose,
)
from vpcal.models.screen import PlaneSection, ScreenDefinition


IMG_W, IMG_H = 1920, 1080


# ── Helpers ──────────────────────────────────────────────────────────


def _screen(width=5000, height=3000, cab_size=500, mpc=1) -> ScreenDefinition:
    return ScreenDefinition(
        name="TestScreen",
        unit="mm",
        cabinet_size=[cab_size, cab_size],
        led_pixel_pitch_mm=2.8,
        markers_per_cabinet=mpc,
        sections=[PlaneSection(name="wall", width_mm=width, height_mm=height, origin=[0, 0, 0])],
    )


def _screen_b(width=3000, height=2000, cab_size=500, mpc=1) -> ScreenDefinition:
    return ScreenDefinition(
        name="TestScreenB",
        unit="mm",
        cabinet_size=[cab_size, cab_size],
        led_pixel_pitch_mm=2.8,
        markers_per_cabinet=mpc,
        sections=[PlaneSection(name="wall", width_mm=width, height_mm=height, origin=[3000, 0, 0])],
    )


def _ideal_camera_matrix(fx=1200.0, fy=1200.0, cx=960.0, cy=540.0):
    return np.array([[fx, 0, cx], [0, fy, cy], [0, 0, 1]], dtype=np.float64)


def _lens_result(fx=1200.0, fy=1200.0, cx=960.0, cy=540.0):
    return LensCalResult(
        fx=fx, fy=fy, cx=cx, cy=cy,
        dist_coeffs=[0.0, 0.0, 0.0, 0.0, 0.0],
        rms=0.1, num_images=10, num_points=200,
        image_size=(1920, 1080),
    )


def _project_markers(
    world_map: dict[MarkerId, np.ndarray],
    R: np.ndarray,
    t: np.ndarray,
    K: np.ndarray,
) -> list:
    """Project 3D markers to 2D using given camera pose, return fake detections."""
    @dataclass
    class FakeDet:
        marker_id: MarkerId
        pixel_u: float
        pixel_v: float

    dets = []
    for mid, pt3d in world_map.items():
        pt_cam = R @ _to_planar(pt3d.reshape(1, 3)).ravel() + t
        if pt_cam[2] <= 0:
            continue
        px = K[0, 0] * pt_cam[0] / pt_cam[2] + K[0, 2]
        py = K[1, 1] * pt_cam[1] / pt_cam[2] + K[1, 2]
        if 0 <= px < 1920 and 0 <= py < 1080:
            dets.append(FakeDet(marker_id=mid, pixel_u=px, pixel_v=py))
    return dets


# ── Quaternion conversion (canonical transforms.py, used by _average_transforms) ──


class TestQuaternionConversion:
    """D4 removed tracker_free's private quaternion math; the averaging path now
    uses the single-source-of-truth conversions in ``transforms.py``."""

    def test_identity(self):
        R = np.eye(3)
        q = matrix_to_quat(R)
        assert abs(q[0]) > 0.99  # w ≈ ±1
        R2 = quat_to_matrix(q)
        np.testing.assert_allclose(R2, R, atol=1e-12)

    @pytest.mark.parametrize("axis,angle_deg", [
        ([1, 0, 0], 45),
        ([0, 1, 0], 90),
        ([0, 0, 1], 130),
        ([1, 1, 0], 60),
    ])
    def test_roundtrip(self, axis, angle_deg):
        axis = np.array(axis, dtype=np.float64)
        axis /= np.linalg.norm(axis)
        rvec = axis * np.radians(angle_deg)
        R, _ = cv2.Rodrigues(rvec)
        q = matrix_to_quat(R)
        R2 = quat_to_matrix(q)
        np.testing.assert_allclose(R2, R, atol=1e-10)

    def test_unit_norm(self):
        R, _ = cv2.Rodrigues(np.array([0.3, -0.5, 0.8]))
        q = matrix_to_quat(R)
        assert abs(np.linalg.norm(q) - 1.0) < 1e-12


# ── _to_planar ───────────────────────────────────────────────────────


class TestToPlanar:

    def test_xz_plane_remapped(self):
        pts = np.array([[100, 0, 200], [300, 0, 400], [500, 0, 600]], dtype=np.float64)
        out = _to_planar(pts)
        np.testing.assert_allclose(out[:, 0], [100, 300, 500])
        np.testing.assert_allclose(out[:, 1], [200, 400, 600])
        np.testing.assert_allclose(out[:, 2], 0.0)

    def test_non_planar_unchanged(self):
        pts = np.array([[1, 2, 3], [4, 5, 6]], dtype=np.float64)
        out = _to_planar(pts)
        np.testing.assert_array_equal(out, pts)

    def test_single_point_unchanged(self):
        pts = np.array([[1, 0, 2]], dtype=np.float64)
        out = _to_planar(pts)
        np.testing.assert_array_equal(out, pts)


# ── _average_transforms ─────────────────────────────────────────────


class TestAverageTransforms:

    def test_identity_average(self):
        Ms = [np.eye(4) for _ in range(5)]
        avg = _average_transforms(Ms, [1.0] * 5)
        np.testing.assert_allclose(avg, np.eye(4), atol=1e-12)

    def test_single_transform(self):
        M = np.eye(4)
        M[:3, 3] = [10, 20, 30]
        avg = _average_transforms([M], [1.0])
        np.testing.assert_allclose(avg, M, atol=1e-12)

    def test_weighted_translation(self):
        M1 = np.eye(4)
        M1[:3, 3] = [0, 0, 0]
        M2 = np.eye(4)
        M2[:3, 3] = [100, 0, 0]
        avg = _average_transforms([M1, M2], [1.0, 3.0])
        assert abs(avg[0, 3] - 75.0) < 1e-10  # weighted: (0*1 + 100*3)/4

    def test_small_rotation_average(self):
        angles = [0.05, -0.05]
        Ms = []
        for a in angles:
            R, _ = cv2.Rodrigues(np.array([0, a, 0], dtype=np.float64))
            M = np.eye(4)
            M[:3, :3] = R
            Ms.append(M)
        avg = _average_transforms(Ms, [1.0, 1.0])
        np.testing.assert_allclose(avg[:3, :3], np.eye(3), atol=0.01)


# ── _build_world_map ────────────────────────────────────────────────


class TestBuildWorldMap:

    def test_returns_dict(self):
        scr = _screen()
        wm = _build_world_map(scr)
        assert isinstance(wm, dict)
        assert len(wm) > 0
        for k, v in wm.items():
            assert isinstance(k, MarkerId)
            assert v.shape == (3,)

    def test_offset_shifts_ids(self):
        scr = _screen()
        wm0 = _build_world_map(scr, cab_col_offset=0)
        wm5 = _build_world_map(scr, cab_col_offset=5)
        cols_0 = {mid.cab_col for mid in wm0}
        cols_5 = {mid.cab_col for mid in wm5}
        assert min(cols_5) == min(cols_0) + 5


# ── _match_detections ────────────────────────────────────────────────


class TestMatchDetections:

    def test_matching(self):
        @dataclass
        class D:
            marker_id: MarkerId
            pixel_u: float
            pixel_v: float

        mid1 = MarkerId(0, 1, 1, 0)
        mid2 = MarkerId(0, 2, 2, 0)
        mid_unknown = MarkerId(0, 99, 99, 0)
        world_map = {
            mid1: np.array([100, 0, 200], dtype=np.float64),
            mid2: np.array([300, 0, 400], dtype=np.float64),
        }
        dets = [
            D(mid1, 500.0, 300.0),
            D(mid_unknown, 100.0, 100.0),
            D(mid2, 700.0, 400.0),
        ]
        obj, img = _match_detections(dets, world_map)
        assert obj.shape == (2, 3)
        assert img.shape == (2, 2)
        np.testing.assert_allclose(img[0], [500.0, 300.0])


# ── ScreenPose ───────────────────────────────────────────────────────


class TestScreenPose:

    def test_identity_pose(self):
        pose = ScreenPose(rvec=np.zeros((3, 1)), tvec=np.zeros((3, 1)))
        np.testing.assert_allclose(pose.rotation_matrix, np.eye(3), atol=1e-12)
        np.testing.assert_allclose(pose.matrix_4x4, np.eye(4), atol=1e-12)
        np.testing.assert_allclose(pose.camera_position_in_screen, [0, 0, 0], atol=1e-12)

    def test_inverse_roundtrip(self):
        rvec = np.array([[0.1], [-0.2], [0.3]])
        tvec = np.array([[100], [200], [500]])
        pose = ScreenPose(rvec=rvec, tvec=tvec)
        M = pose.matrix_4x4
        M_inv = pose.inverse_matrix_4x4
        np.testing.assert_allclose(M @ M_inv, np.eye(4), atol=1e-10)

    def test_camera_position(self):
        tvec = np.array([[0], [0], [1000]], dtype=np.float64)
        pose = ScreenPose(rvec=np.zeros((3, 1)), tvec=tvec)
        cam_pos = pose.camera_position_in_screen
        np.testing.assert_allclose(cam_pos, [0, 0, -1000], atol=1e-10)


# ── lens_calibrate (mock detection) ──────────────────────────────────


def _generate_views(screen, K, num_views=10, seed=42, offset=0, screen_id=0):
    """Generate synthetic camera poses and project markers to 2D.

    Returns a list of (image_name, detections_list) where each detection is a
    FakeDet with marker_id, pixel_u, pixel_v.
    """
    @dataclass
    class FakeDet:
        marker_id: MarkerId
        pixel_u: float
        pixel_v: float

    rng = np.random.default_rng(seed)
    world_map = _build_world_map(screen, cab_col_offset=offset, screen_id=screen_id)

    views = []
    for i in range(num_views):
        angle_y = rng.uniform(-0.3, 0.3)
        angle_x = rng.uniform(-0.15, 0.15)
        R_y, _ = cv2.Rodrigues(np.array([0, angle_y, 0], dtype=np.float64))
        R_x, _ = cv2.Rodrigues(np.array([angle_x, 0, 0], dtype=np.float64))
        R = R_x @ R_y
        t = np.array([rng.uniform(-200, 200), rng.uniform(-200, 200), rng.uniform(3000, 5000)])

        dets = []
        for mid, pt3d in world_map.items():
            pt_planar = _to_planar(pt3d.reshape(1, 3)).ravel()
            pt_cam = R @ pt_planar + t
            if pt_cam[2] <= 0:
                continue
            px = K[0, 0] * pt_cam[0] / pt_cam[2] + K[0, 2]
            py = K[1, 1] * pt_cam[1] / pt_cam[2] + K[1, 2]
            if 10 <= px < IMG_W - 10 and 10 <= py < IMG_H - 10:
                dets.append(FakeDet(marker_id=mid, pixel_u=float(px), pixel_v=float(py)))
        views.append((f"img_{i:03d}.png", dets))
    return views


class TestLensCalibrate:

    def test_calibrate_recovers_focal_length(self, tmp_path):
        screen = _screen(width=5000, height=3000, cab_size=1000, mpc=1)
        K = _ideal_camera_matrix(fx=1200, fy=1200, cx=960, cy=540)
        views = _generate_views(screen, K, num_views=10)

        # Write dummy images (detect_markers is mocked)
        for name, _ in views:
            cv2.imwrite(str(tmp_path / name), np.zeros((IMG_H, IMG_W), np.uint8))

        det_results = iter([dets for _, dets in views])

        with patch("vpcal.core.tracker_free.detect_markers", side_effect=lambda img, **kw: next(det_results)):
            result = lens_calibrate(tmp_path, screen)

        assert result.num_images >= 3
        assert result.rms < 2.0
        assert abs(result.fx - 1200) < 200
        assert abs(result.fy - 1200) < 200
        assert result.image_size == (IMG_W, IMG_H)

    def test_too_few_images_raises(self, tmp_path):
        screen = _screen()
        (tmp_path / "empty.png").write_bytes(b"")
        with pytest.raises(ValueError, match="No images found"):
            lens_calibrate(tmp_path, screen)

    def test_no_images_raises(self, tmp_path):
        screen = _screen()
        with pytest.raises(ValueError, match="No images found"):
            lens_calibrate(tmp_path, screen)

    def test_insufficient_usable_images(self, tmp_path):
        screen = _screen()
        for i in range(5):
            cv2.imwrite(str(tmp_path / f"img_{i}.png"), np.zeros((IMG_H, IMG_W), np.uint8))
        with patch("vpcal.core.tracker_free.detect_markers", return_value=[]):
            with pytest.raises(ValueError, match="Need >= 8 images"):
                lens_calibrate(tmp_path, screen)


class TestStagePose:

    def test_partial_visibility_fails_closed(self, tmp_path):
        screen_a = _screen(width=2000, height=1500, cab_size=500, mpc=4)
        screen_b = ScreenDefinition(
            name="B", unit="mm", cabinet_size=[500, 500],
            led_pixel_pitch_mm=2.8, markers_per_cabinet=4,
            sections=[PlaneSection(
                name="wall", width_mm=2000, height_mm=1500,
                origin=[2500, 0, 0],
            )],
        )
        target_a = StagePoseTarget(screen_a, screen_id=0, cab_col_offset=0, label="A")
        target_b = StagePoseTarget(screen_b, screen_id=1, cab_col_offset=16, label="B")
        world_b = _build_world_map(screen_b, cab_col_offset=16, screen_id=1)
        K = _ideal_camera_matrix()
        R = np.array([[1.0, 0.0, 0.0], [0.0, 0.0, -1.0], [0.0, 1.0, 0.0]])
        t = np.array([-3000.0, 500.0, 5000.0])

        @dataclass
        class FakeDet:
            marker_id: MarkerId
            pixel_u: float
            pixel_v: float

        detections = []
        for marker_id, point in world_b.items():
            point_cam = R @ point + t
            pixel = K @ point_cam
            pixel = pixel[:2] / pixel[2]
            if 0 <= pixel[0] < IMG_W and 0 <= pixel[1] < IMG_H:
                detections.append(FakeDet(marker_id, float(pixel[0]), float(pixel[1])))
        assert len(detections) >= 4
        image_path = tmp_path / "fixed.png"
        cv2.imwrite(str(image_path), np.zeros((IMG_H, IMG_W, 3), np.uint8))

        with patch("vpcal.core.tracker_free.detect_markers", return_value=detections):
            with pytest.raises(LocalizationQualityFailed) as exc:
                solve_stage_pose(image_path, [target_a, target_b], _lens_result())

        assert exc.value.code == "LOCALIZATION_QUALITY_FAILED"
        assert exc.value.details["markers_by_screen"]["A"] == 0

    @staticmethod
    def _two_screen_fixture(inconsistent: bool = False):
        screen_a = ScreenDefinition(
            name="A", unit="mm", cabinet_size=[500, 500], led_pixel_pitch_mm=2.8,
            markers_per_cabinet=4,
            sections=[PlaneSection(name="wall", width_mm=2000, height_mm=1500,
                                   origin=[-1100, 0, 0])],
        )
        angle = np.deg2rad(22.0) / 2.0
        screen_b = ScreenDefinition(
            name="B", unit="mm", cabinet_size=[500, 500], led_pixel_pitch_mm=2.8,
            markers_per_cabinet=4,
            sections=[PlaneSection(name="wall", width_mm=2000, height_mm=1500,
                                   origin=[1100, 450, 0],
                                   rotation=[float(np.cos(angle)), 0.0, 0.0, float(np.sin(angle))])],
        )
        targets = [
            StagePoseTarget(screen_a, screen_id=0, cab_col_offset=0, label="A"),
            StagePoseTarget(screen_b, screen_id=1, cab_col_offset=16, label="B"),
        ]
        K = _ideal_camera_matrix()
        R = np.array([[1.0, 0.0, 0.0], [0.0, 0.0, -1.0], [0.0, 1.0, 0.0]])
        t_a = np.array([0.0, 750.0, 5000.0])
        t_b = t_a + (np.array([350.0, -220.0, 0.0]) if inconsistent else 0.0)

        @dataclass
        class FakeDet:
            marker_id: MarkerId
            pixel_u: float
            pixel_v: float
            confidence: float = 1.0
            saturated: bool = False
            localization_rejected: bool = False

        detections = []
        for target, t in zip(targets, [t_a, t_b]):
            for marker_id, point in _build_world_map(
                target.screen, cab_col_offset=target.cab_col_offset, screen_id=target.screen_id,
            ).items():
                point_cam = R @ point + t
                pixel = K @ point_cam
                pixel = pixel[:2] / pixel[2]
                if 0 <= pixel[0] < IMG_W and 0 <= pixel[1] < IMG_H:
                    detections.append(FakeDet(marker_id, float(pixel[0]), float(pixel[1])))
        return targets, detections

    def test_correct_two_plane_geometry_passes_joint_preflight(self, tmp_path):
        targets, detections = self._two_screen_fixture()
        assert all(sum(d.marker_id.screen_id == i for d in detections) >= 12 for i in (0, 1))
        image_path = tmp_path / "fixed.png"
        cv2.imwrite(str(image_path), np.zeros((IMG_H, IMG_W, 3), np.uint8))
        with patch("vpcal.core.tracker_free.detect_markers", return_value=detections):
            result = solve_stage_pose(image_path, targets, _lens_result())
        assert result.preflight["passed"] is True
        assert result.preflight["joint_projective"]["rms_px"] < 1.0e-4
        assert result.rms_reprojection_px < 1.0e-4

    def test_independent_homographies_good_joint_geometry_bad(self, tmp_path):
        targets, detections = self._two_screen_fixture(inconsistent=True)
        image_path = tmp_path / "fixed.png"
        cv2.imwrite(str(image_path), np.zeros((IMG_H, IMG_W, 3), np.uint8))
        with patch("vpcal.core.tracker_free.detect_markers", return_value=detections):
            with pytest.raises(ScreenGeometryInconsistent) as exc:
                solve_stage_pose(image_path, targets, _lens_result())
        assert exc.value.code == "SCREEN_GEOMETRY_INCONSISTENT"
        assert all(v["rms_px"] < 1.0 for v in exc.value.details["homography_by_screen"].values())
        assert exc.value.details["joint_projective"]["rms_px"] >= 2.0


# ── spatial_solve (mock detection) ───────────────────────────────────


class TestSpatialSolve:

    def test_ambiguous_ippe_pose_fails_closed(self, tmp_path):
        from vpcal.core.tracker_free import ScreenPose

        cv2.imwrite(str(tmp_path / "view.png"), np.zeros((IMG_H, IMG_W), np.uint8))
        scr_a = _screen(width=2000, height=1500, cab_size=1000, mpc=1)
        scr_b = _screen(width=2000, height=1500, cab_size=1000, mpc=1)
        obj = np.array([[0., 0., 0.], [1., 0., 0.], [1., 1., 0.], [0., 1., 0.]])
        img = np.array([[10., 10.], [20., 10.], [20., 20.], [10., 20.]])
        ambiguous = ScreenPose(rvec=np.zeros((3, 1)), tvec=np.array([[0.], [0.], [10.]]),
                               ambiguous=True, candidate_error_ratio=1.01)
        with patch("vpcal.core.tracker_free.detect_markers", return_value=[]), \
             patch("vpcal.core.tracker_free._match_detections", return_value=(obj, img)), \
             patch("vpcal.core.tracker_free._solve_pnp", return_value=ambiguous):
            with pytest.raises(ValueError, match="No images with both screens"):
                spatial_solve(tmp_path, scr_a, scr_b, _lens_result())

    def test_spatial_solve_finds_relative_pose(self, tmp_path):
        scr_a = _screen(width=3000, height=2000, cab_size=1000, mpc=1)
        scr_b = ScreenDefinition(
            name="B", unit="mm",
            cabinet_size=[1000, 1000], led_pixel_pitch_mm=2.8,
            markers_per_cabinet=1,
            sections=[PlaneSection(name="wall", width_mm=3000, height_mm=2000,
                                   origin=[3500, 0, 0])],
        )
        K = _ideal_camera_matrix()
        lens = _lens_result()
        offset_a, offset_b = 0, 10

        views_a = _generate_views(scr_a, K, num_views=6, seed=42, offset=offset_a)
        views_b = _generate_views(scr_b, K, num_views=6, seed=42, offset=offset_b)
        merged = []
        for (name, dets_a), (_, dets_b) in zip(views_a, views_b):
            merged.append((name, dets_a + dets_b))

        for name, _ in merged:
            cv2.imwrite(str(tmp_path / name), np.zeros((IMG_H, IMG_W), np.uint8))

        det_results = iter([dets for _, dets in merged])

        with patch("vpcal.core.tracker_free.detect_markers", side_effect=lambda img, **kw: next(det_results)):
            result = spatial_solve(
                tmp_path, scr_a, scr_b, lens,
                cab_col_offset_a=offset_a, cab_col_offset_b=offset_b,
            )

        assert result.num_co_visible >= 1
        assert result.screen_a_name == "TestScreen"
        assert result.screen_b_name == "B"
        t = result.screen_b_pose.tvec.ravel()
        assert np.linalg.norm(t) > 0

    def test_consistent_across_views(self, tmp_path):
        """Multiple co-visible views should produce a stable relative transform."""
        scr_a = _screen(width=2000, height=1500, cab_size=1000, mpc=1)
        scr_b = ScreenDefinition(
            name="B", unit="mm",
            cabinet_size=[1000, 1000], led_pixel_pitch_mm=2.8,
            markers_per_cabinet=1,
            sections=[PlaneSection(name="wall", width_mm=2000, height_mm=1500,
                                   origin=[2500, 0, 0])],
        )
        K = _ideal_camera_matrix(fx=800, fy=800, cx=960, cy=540)
        lens = _lens_result(fx=800, fy=800)
        offset_a, offset_b = 0, 10

        world_a = _build_world_map(scr_a, cab_col_offset=offset_a)
        world_b = _build_world_map(scr_b, cab_col_offset=offset_b)

        @dataclass
        class FD:
            marker_id: MarkerId
            pixel_u: float
            pixel_v: float

        rng = np.random.default_rng(99)
        all_dets = []
        for i in range(8):
            R, _ = cv2.Rodrigues(np.array([
                rng.uniform(-0.03, 0.03),
                rng.uniform(-0.03, 0.03),
                0,
            ], dtype=np.float64))
            t = np.array([1250, 750, rng.uniform(4000, 5000)])

            dets = []
            for wm in [world_a, world_b]:
                for mid, pt3d in wm.items():
                    pt_planar = _to_planar(pt3d.reshape(1, 3)).ravel()
                    pt_cam = R @ pt_planar + t
                    if pt_cam[2] <= 0:
                        continue
                    px = K[0, 0] * pt_cam[0] / pt_cam[2] + K[0, 2]
                    py = K[1, 1] * pt_cam[1] / pt_cam[2] + K[1, 2]
                    if 0 <= px < IMG_W and 0 <= py < IMG_H:
                        dets.append(FD(marker_id=mid, pixel_u=float(px), pixel_v=float(py)))

            all_dets.append(dets)
            cv2.imwrite(str(tmp_path / f"img_{i:03d}.png"), np.zeros((IMG_H, IMG_W), np.uint8))

        det_iter = iter(all_dets)
        with patch("vpcal.core.tracker_free.detect_markers", side_effect=lambda img, **kw: next(det_iter)):
            result = spatial_solve(
                tmp_path, scr_a, scr_b, lens,
                cab_col_offset_a=offset_a, cab_col_offset_b=offset_b,
            )

        assert result.num_co_visible >= 4
        assert len(result.per_image_poses) == 8
        # Both screens share the same world coordinate system, so the relative
        # transform should be near identity (zero-noise synthetic projections).
        M_rel = result.screen_b_pose.matrix_4x4
        np.testing.assert_allclose(M_rel[:3, :3], np.eye(3), atol=1e-6)
        np.testing.assert_allclose(M_rel[:3, 3], 0.0, atol=1e-6)

    def test_no_covisible_raises(self, tmp_path):
        scr_a = _screen()
        scr_b = _screen_b()
        lens = _lens_result()
        cv2.imwrite(str(tmp_path / "blank.png"), np.zeros((IMG_H, IMG_W), np.uint8))

        with patch("vpcal.core.tracker_free.detect_markers", return_value=[]):
            with pytest.raises(ValueError, match="No images with both screens"):
                spatial_solve(tmp_path, scr_a, scr_b, lens)


# ── spatial QA: reprojection RMS / dispersion / outlier rejection (D4) ──


class TestSpatialQA:
    """D4: rms_reprojection_a/b populated, dispersion metric reported, and a
    disagreeing image rejected before averaging."""

    def _covisible_run(self, tmp_path, *, screen_b_shift_px=None):
        """8 co-visible images; ``screen_b_shift_px`` injects a pixel offset on
        screen B in the last image (a single outlier view)."""
        scr_a = _screen(width=2000, height=1500, cab_size=1000, mpc=1)
        scr_b = ScreenDefinition(
            name="B", unit="mm",
            cabinet_size=[1000, 1000], led_pixel_pitch_mm=2.8, markers_per_cabinet=1,
            sections=[PlaneSection(name="wall", width_mm=2000, height_mm=1500, origin=[2500, 0, 0])],
        )
        K = _ideal_camera_matrix(fx=800, fy=800, cx=960, cy=540)
        lens = _lens_result(fx=800, fy=800)
        offset_a, offset_b = 0, 10
        world_a = _build_world_map(scr_a, cab_col_offset=offset_a)
        world_b = _build_world_map(scr_b, cab_col_offset=offset_b)

        @dataclass
        class FD:
            marker_id: MarkerId
            pixel_u: float
            pixel_v: float

        rng = np.random.default_rng(99)
        all_dets = []
        for i in range(8):
            R, _ = cv2.Rodrigues(np.array(
                [rng.uniform(-0.03, 0.03), rng.uniform(-0.03, 0.03), 0], dtype=np.float64))
            t = np.array([1250, 750, rng.uniform(4000, 5000)])
            dets = []
            for which, wm in enumerate([world_a, world_b]):
                for mid, pt3d in wm.items():
                    pt_cam = R @ _to_planar(pt3d.reshape(1, 3)).ravel() + t
                    if pt_cam[2] <= 0:
                        continue
                    px = K[0, 0] * pt_cam[0] / pt_cam[2] + K[0, 2]
                    py = K[1, 1] * pt_cam[1] / pt_cam[2] + K[1, 2]
                    if which == 1 and screen_b_shift_px is not None and i == 7:
                        px += screen_b_shift_px  # corrupt screen B in the last view
                    if 0 <= px < IMG_W and 0 <= py < IMG_H:
                        dets.append(FD(marker_id=mid, pixel_u=float(px), pixel_v=float(py)))
            all_dets.append(dets)
            cv2.imwrite(str(tmp_path / f"img_{i:03d}.png"), np.zeros((IMG_H, IMG_W), np.uint8))

        det_iter = iter(all_dets)
        with patch("vpcal.core.tracker_free.detect_markers", side_effect=lambda img, **kw: next(det_iter)):
            return spatial_solve(tmp_path, scr_a, scr_b, lens,
                                 cab_col_offset_a=offset_a, cab_col_offset_b=offset_b)

    def test_reprojection_and_dispersion_reported(self, tmp_path):
        result = self._covisible_run(tmp_path)
        # Zero-noise projections → tiny but *computed* (no longer the 0.0 default).
        assert result.rms_reprojection_a < 1.0
        assert result.rms_reprojection_b < 1.0
        for key in ("rotation_deg_mean", "rotation_deg_max",
                    "translation_mm_mean", "translation_mm_max"):
            assert key in result.consistency
        assert result.consistency["translation_mm_max"] < 5.0
        assert result.num_rejected == 0  # clean set keeps every image

    def test_outlier_image_rejected(self, tmp_path):
        result = self._covisible_run(tmp_path, screen_b_shift_px=60.0)
        assert result.num_rejected >= 1
        rejected = [e for e in result.per_image_poses if e.get("rejected")]
        assert len(rejected) == result.num_rejected
        # Consensus preserved: with the outlier rejected, the averaged transform of
        # the (exact) inlier views is essentially identity — a tight bound here makes
        # the consensus-preservation claim load-bearing (a silently-disabled rejection
        # would leave the 60px-shifted view in and blow past this).
        M_rel = result.screen_b_pose.matrix_4x4
        np.testing.assert_allclose(M_rel[:3, :3], np.eye(3), atol=1e-4)
        np.testing.assert_allclose(M_rel[:3, 3], 0.0, atol=0.3)


# ── verify_pose ──────────────────────────────────────────────────────


class TestVerifyPose:

    def test_verify_no_markers(self, tmp_path):
        scr_a = _screen()
        scr_b = _screen_b()
        lens = _lens_result()
        img_path = tmp_path / "blank.png"
        cv2.imwrite(str(img_path), np.zeros((IMG_H, IMG_W), np.uint8))

        with patch("vpcal.core.tracker_free.detect_markers", return_value=[]):
            result = verify_pose(img_path, scr_a, scr_b, lens)
        assert result.num_markers_a == 0
        assert result.num_markers_b == 0
        assert result.camera_pose_from_a is None
        assert result.camera_pose_from_b is None

    def test_verify_with_markers(self, tmp_path):
        scr_a = _screen(width=3000, height=2000, cab_size=1000, mpc=1)
        scr_b = _screen_b(width=3000, height=2000, cab_size=1000, mpc=1)
        K = _ideal_camera_matrix()
        lens = _lens_result()

        views_a = _generate_views(scr_a, K, num_views=1, seed=10, offset=0)
        views_b = _generate_views(scr_b, K, num_views=1, seed=10, offset=10)
        merged_dets = views_a[0][1] + views_b[0][1]

        img_path = tmp_path / "verify.png"
        cv2.imwrite(str(img_path), np.zeros((IMG_H, IMG_W), np.uint8))

        with patch("vpcal.core.tracker_free.detect_markers", return_value=merged_dets):
            result = verify_pose(img_path, scr_a, scr_b, lens,
                                 cab_col_offset_a=0, cab_col_offset_b=10)

        assert result.num_markers_a > 0
        assert result.num_markers_b > 0
        if result.num_markers_a >= 4:
            assert result.camera_pose_from_a is not None
            dist = np.linalg.norm(result.camera_pose_from_a.camera_position_in_screen)
            assert dist > 100

    def test_bad_image_raises(self, tmp_path):
        scr_a = _screen()
        scr_b = _screen_b()
        lens = _lens_result()
        with pytest.raises(ValueError, match="Cannot read image"):
            verify_pose(tmp_path / "nonexistent.png", scr_a, scr_b, lens)


# ── export_obj ───────────────────────────────────────────────────────


class TestExportObj:

    def _spatial_json(self, tmp_path) -> Path:
        M_rel = np.eye(4)
        M_rel[:3, 3] = [3500, 0, 0]
        data = {
            "screen_a": "ScreenA",
            "screen_b": "ScreenB",
            "screen_b_relative": {
                "translation_mm": [3500, 0, 0],
                "rotation_matrix": np.eye(3).tolist(),
                "rvec": [0, 0, 0],
                "euler_deg": {"rx": 0, "ry": 0, "rz": 0},
                "matrix_4x4": M_rel.tolist(),
            },
            "num_co_visible": 5,
            "per_image": [],
        }
        p = tmp_path / "spatial.json"
        p.write_text(json.dumps(data))
        return p

    def test_export_creates_obj_files(self, tmp_path):
        scr_a = _screen(width=5000, height=3000)
        scr_b = _screen_b(width=3000, height=2000)
        sp = self._spatial_json(tmp_path)
        out_dir = tmp_path / "export"

        screens = export_obj(sp, scr_a, scr_b, out_dir, root="b")

        assert len(screens) == 2
        assert out_dir.exists()
        obj_files = list(out_dir.glob("*.obj"))
        assert len(obj_files) == 2

    def test_export_root_a(self, tmp_path):
        scr_a = _screen(width=5000, height=3000)
        scr_b = _screen_b(width=3000, height=2000)
        sp = self._spatial_json(tmp_path)
        out_dir = tmp_path / "export_a"

        screens = export_obj(sp, scr_a, scr_b, out_dir, root="a")

        assert len(screens) == 2
        a_verts = screens[0].vertices
        np.testing.assert_allclose(a_verts.mean(axis=0)[2], 0.0, atol=1e-6)

    def test_obj_content_valid(self, tmp_path):
        scr_a = _screen(width=5000, height=3000)
        scr_b = _screen_b(width=3000, height=2000)
        sp = self._spatial_json(tmp_path)
        out_dir = tmp_path / "export_v"

        export_obj(sp, scr_a, scr_b, out_dir)

        for obj_file in out_dir.glob("*.obj"):
            content = obj_file.read_text()
            assert "v " in content
            assert "f " in content
            v_lines = [l for l in content.split("\n") if l.startswith("v ")]
            assert len(v_lines) == 4

    def test_duplicate_name_handled(self, tmp_path):
        scr_same = _screen(width=5000, height=3000)
        sp = self._spatial_json(tmp_path)
        out_dir = tmp_path / "dup"

        screens = export_obj(sp, scr_same, scr_same, out_dir)

        obj_files = list(out_dir.glob("*.obj"))
        assert len(obj_files) == 2
        names = [f.stem for f in obj_files]
        assert len(set(names)) == 2
