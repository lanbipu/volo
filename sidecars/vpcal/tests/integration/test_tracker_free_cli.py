"""Tracker-free CLI integration tests.

Tests CLI envelope format, dry-run, verify, and export commands via subprocess.
lens-cal and spatial solve logic is tested in unit tests with mocked detection.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np
import pytest

from vpcal.cli.tracker_free import _rotation_to_ptr, _volo_camera_rotation
from vpcal.models.screen import PlaneSection, ScreenDefinition

SRC = str(Path(__file__).resolve().parents[2] / "src")
# sitecustomize strips skbuild editable redirects so worktree PYTHONPATH wins.
_BOOTSTRAP = str(Path(__file__).resolve().parents[1] / "_bootstrap")


def _screen(name="Wall_A", width=3000, height=2000, cab_size=1000) -> ScreenDefinition:
    return ScreenDefinition(
        name=name, unit="mm",
        cabinet_size=[cab_size, cab_size], led_pixel_pitch_mm=2.8,
        markers_per_cabinet=1,
        sections=[PlaneSection(name="wall", width_mm=width, height_mm=height, origin=[0, 0, 0])],
    )


def _screen_b(name="Wall_B", width=3000, height=2000, cab_size=1000) -> ScreenDefinition:
    return ScreenDefinition(
        name=name, unit="mm",
        cabinet_size=[cab_size, cab_size], led_pixel_pitch_mm=2.8,
        markers_per_cabinet=1,
        sections=[PlaneSection(name="wall", width_mm=width, height_mm=height, origin=[3500, 0, 0])],
    )


def _write_screen(screen: ScreenDefinition, path: Path) -> Path:
    path.write_text(screen.model_dump_json(indent=2))
    return path


def _write_lens(path: Path) -> Path:
    lens = {"fx": 1200, "fy": 1200, "cx": 960, "cy": 540,
            "dist_coeffs": [0, 0, 0, 0, 0], "rms": 0.1,
            "num_images": 10, "num_points": 200, "image_size": [1920, 1080],
            "calibration_kind": "multi_view_intrinsics", "is_master": True,
            "session_coupled": False}
    path.write_text(json.dumps(lens))
    return path


def _write_spatial(path: Path, translation=None) -> Path:
    if translation is None:
        translation = [3500, 0, 0]
    M_rel = np.eye(4)
    M_rel[:3, 3] = translation
    data = {
        "screen_a": "Wall_A",
        "screen_b": "Wall_B",
        "screen_b_relative": {
            "translation_mm": translation,
            "rotation_matrix": np.eye(3).tolist(),
            "rvec": [0, 0, 0],
            "euler_deg": {"rx": 0, "ry": 0, "rz": 0},
            "matrix_4x4": M_rel.tolist(),
        },
        "num_co_visible": 5,
        "per_image": [],
    }
    path.write_text(json.dumps(data))
    return path


def _run(*args):
    env = dict(os.environ, PYTHONPATH=os.pathsep.join([_BOOTSTRAP, SRC]))
    return subprocess.run(
        [sys.executable, "-m", "vpcal.cli.main", *args],
        capture_output=True, text=True, env=env,
    )


def _run_ok(*args) -> dict:
    r = _run(*args)
    assert r.returncode == 0, f"exit {r.returncode}:\n{r.stdout}\n{r.stderr}"
    return json.loads(r.stdout)


# ── lens-cal ─────────────────────────────────────────────────────────


class TestLensCalCLI:

    def test_dry_run(self, tmp_path):
        scr_path = _write_screen(_screen(), tmp_path / "screen.json")
        img_dir = tmp_path / "images"
        img_dir.mkdir()
        cv2.imwrite(str(img_dir / "dummy.png"), np.zeros((100, 100), np.uint8))

        result = _run_ok(
            "--output", "json",
            "tracker-free", "lens-cal",
            "--images", str(img_dir),
            "--screen", str(scr_path),
            "--out", str(tmp_path / "lens.json"),
            "--dry-run",
        )

        assert result["status"] == "ok"
        assert result["data"]["exit_code"] == 0
        assert "dry_run_plan" in result["data"]

    def test_error_envelope_on_failure(self, tmp_path):
        scr_path = _write_screen(_screen(), tmp_path / "screen.json")
        img_dir = tmp_path / "images"
        img_dir.mkdir()

        r = _run(
            "--output", "json",
            "tracker-free", "lens-cal",
            "--images", str(img_dir),
            "--screen", str(scr_path),
            "--out", str(tmp_path / "lens.json"),
        )

        assert r.returncode != 0
        envelope = json.loads(r.stdout)
        assert envelope["status"] == "error"
        assert envelope["operation_id"] == "tracker_free.lens_cal"


# ── one-shot Stage pose ──────────────────────────────────────────────


class TestPoseCLI:

    def _fixture(self, tmp_path):
        screen = _write_screen(_screen(), tmp_path / "screen.json")
        image = tmp_path / "capture.png"
        cv2.imwrite(str(image), np.zeros((1080, 1920), np.uint8))
        return screen, image

    def test_dry_run_accepts_capture_domain_pixel_intrinsics(self, tmp_path):
        screen, image = self._fixture(tmp_path)

        result = _run_ok(
            "--output", "json",
            "tracker-free", "pose",
            "--image", str(image),
            "--screen-target", str(screen), "0", "0",
            "--fx", "1500", "--fy", "1500",
            "--cx", "970", "--cy", "535",
            "--debug-unqualified",
            "--dry-run",
        )

        intrinsics = result["data"]["dry_run_plan"]["intrinsics"]
        assert intrinsics == {
            "fx": 1500.0, "fy": 1500.0,
            "cx": 970.0, "cy": 535.0,
            "image_size": [1920, 1080],
            "active_sensor_mm": None,
            "crop_mode": None,
        }

    def test_infers_center_crop_for_sensor_aspect_mismatch(self, tmp_path):
        screen, image = self._fixture(tmp_path)

        result = _run_ok(
            "--output", "json",
            "tracker-free", "pose",
            "--image", str(image),
            "--screen-target", str(screen), "0", "0",
            "--focal-mm", "50",
            "--sensor-width-mm", "36", "--sensor-height-mm", "24",
            "--debug-unqualified",
            "--dry-run",
        )

        intrinsics = result["data"]["dry_run_plan"]["intrinsics"]
        assert intrinsics["fx"] == pytest.approx(2666.6666667)
        assert intrinsics["fy"] == pytest.approx(2666.6666667)
        assert intrinsics["cx"] == pytest.approx(960.0)
        assert intrinsics["cy"] == pytest.approx(540.0)
        assert intrinsics["active_sensor_mm"] == pytest.approx([36.0, 20.25])
        assert intrinsics["crop_mode"] == "center_crop_height"

    def test_physical_intrinsics_apply_principal_point_offsets(self, tmp_path):
        screen, image = self._fixture(tmp_path)

        result = _run_ok(
            "--output", "json",
            "tracker-free", "pose",
            "--image", str(image),
            "--screen-target", str(screen), "0", "0",
            "--focal-mm", "50",
            "--sensor-width-mm", "36", "--sensor-height-mm", "20.25",
            "--principal-x-mm", "0.3", "--principal-y-mm", "-0.2",
            "--debug-unqualified",
            "--dry-run",
        )

        intrinsics = result["data"]["dry_run_plan"]["intrinsics"]
        assert intrinsics["fx"] == pytest.approx(2666.6666667)
        assert intrinsics["fy"] == pytest.approx(2666.6666667)
        assert intrinsics["cx"] == pytest.approx(976.0)
        assert intrinsics["cy"] == pytest.approx(529.3333333)
        assert intrinsics["active_sensor_mm"] == pytest.approx([36.0, 20.25])
        assert intrinsics["crop_mode"] == "none"

    def test_default_intrinsics_are_rejected_for_formal_solve(self, tmp_path):
        screen, image = self._fixture(tmp_path)
        result = _run(
            "--output", "json", "tracker-free", "pose",
            "--image", str(image),
            "--screen-target", str(screen), "0", "0",
            "--focal-mm", "50", "--sensor-width-mm", "36", "--sensor-height-mm", "24",
            "--dry-run",
        )
        assert result.returncode != 0
        envelope = json.loads(result.stdout)
        assert envelope["error"]["code"] == "MASTER_LENS_REQUIRED"

    def test_unanchored_screen_geometry_is_rejected_for_formal_solve(self, tmp_path):
        screen, image = self._fixture(tmp_path)
        lens = _write_lens(tmp_path / "master-lens.json")
        result = _run(
            "--output", "json", "tracker-free", "pose",
            "--image", str(image),
            "--screen-target", str(screen), "0", "0",
            "--lens", str(lens), "--dry-run",
        )
        assert result.returncode != 0
        envelope = json.loads(result.stdout)
        assert envelope["error"]["code"] == "SCREEN_GEOMETRY_INCONSISTENT"
        assert "geometry provenance missing" in envelope["error"]["details"]["screens"]["screen"]

    def test_opencv_basis_converts_to_zero_volo_ptr(self):
        stage_from_cv = np.diag([1.0, -1.0, -1.0])

        stage_from_volo = _volo_camera_rotation(stage_from_cv)

        np.testing.assert_allclose(stage_from_volo, np.eye(3), atol=1e-12)
        np.testing.assert_allclose(_rotation_to_ptr(stage_from_volo), (0, 0, 0), atol=1e-12)


# ── spatial ──────────────────────────────────────────────────────────


class TestSpatialCLI:

    def test_dry_run(self, tmp_path):
        scr_a_p = _write_screen(_screen(), tmp_path / "screen_a.json")
        scr_b_p = _write_screen(_screen_b(), tmp_path / "screen_b.json")
        lens_p = _write_lens(tmp_path / "lens.json")
        img_dir = tmp_path / "images"
        img_dir.mkdir()
        cv2.imwrite(str(img_dir / "dummy.png"), np.zeros((100, 100), np.uint8))

        result = _run_ok(
            "--output", "json",
            "tracker-free", "spatial",
            "--images", str(img_dir),
            "--screen-a", str(scr_a_p),
            "--screen-b", str(scr_b_p),
            "--lens", str(lens_p),
            "--out", str(tmp_path / "spatial.json"),
            "--dry-run",
        )

        assert result["status"] == "ok"
        assert "dry_run_plan" in result["data"]

    def test_error_on_no_covisible(self, tmp_path):
        scr_a_p = _write_screen(_screen(), tmp_path / "screen_a.json")
        scr_b_p = _write_screen(_screen_b(), tmp_path / "screen_b.json")
        lens_p = _write_lens(tmp_path / "lens.json")
        img_dir = tmp_path / "images"
        img_dir.mkdir()
        cv2.imwrite(str(img_dir / "blank.png"), np.zeros((1080, 1920), np.uint8))

        r = _run(
            "--output", "json",
            "tracker-free", "spatial",
            "--images", str(img_dir),
            "--screen-a", str(scr_a_p),
            "--screen-b", str(scr_b_p),
            "--lens", str(lens_p),
            "--out", str(tmp_path / "spatial.json"),
        )

        assert r.returncode != 0
        envelope = json.loads(r.stdout)
        assert envelope["status"] == "error"
        assert "No images with both screens" in envelope["error"]["message"]


# ── verify ───────────────────────────────────────────────────────────


class TestVerifyCLI:

    def test_blank_image(self, tmp_path):
        scr_a_p = _write_screen(_screen(), tmp_path / "screen_a.json")
        scr_b_p = _write_screen(_screen_b(), tmp_path / "screen_b.json")
        lens_p = _write_lens(tmp_path / "lens.json")
        img_p = tmp_path / "blank.png"
        cv2.imwrite(str(img_p), np.zeros((1080, 1920), np.uint8))

        result = _run_ok(
            "--output", "json",
            "tracker-free", "verify",
            "--image", str(img_p),
            "--screen-a", str(scr_a_p),
            "--screen-b", str(scr_b_p),
            "--lens", str(lens_p),
        )

        assert result["status"] == "ok"
        assert result["data"]["markers_a"] == 0
        assert result["data"]["markers_b"] == 0

    def test_json_envelope_format(self, tmp_path):
        scr_a_p = _write_screen(_screen(), tmp_path / "screen_a.json")
        scr_b_p = _write_screen(_screen_b(), tmp_path / "screen_b.json")
        lens_p = _write_lens(tmp_path / "lens.json")
        img_p = tmp_path / "blank.png"
        cv2.imwrite(str(img_p), np.zeros((1080, 1920), np.uint8))

        result = _run_ok(
            "--output", "json",
            "tracker-free", "verify",
            "--image", str(img_p),
            "--screen-a", str(scr_a_p),
            "--screen-b", str(scr_b_p),
            "--lens", str(lens_p),
        )

        assert "schema_version" in result
        assert "operation_id" in result
        assert result["operation_id"] == "tracker_free.verify"
        assert "meta" in result


# ── export ───────────────────────────────────────────────────────────


class TestExportCLI:

    def test_export_creates_obj(self, tmp_path):
        scr_a_p = _write_screen(_screen(), tmp_path / "screen_a.json")
        scr_b_p = _write_screen(_screen_b(), tmp_path / "screen_b.json")
        sp_path = _write_spatial(tmp_path / "spatial.json")
        out_dir = tmp_path / "meshes"

        result = _run_ok(
            "--output", "json",
            "tracker-free", "export",
            "--spatial", str(sp_path),
            "--screen-a", str(scr_a_p),
            "--screen-b", str(scr_b_p),
            "--out-dir", str(out_dir),
        )

        assert result["status"] == "ok"
        assert result["data"]["root"] == "Wall_B"
        obj_files = list(out_dir.glob("*.obj"))
        assert len(obj_files) == 2

    def test_export_root_a(self, tmp_path):
        scr_a_p = _write_screen(_screen(), tmp_path / "screen_a.json")
        scr_b_p = _write_screen(_screen_b(), tmp_path / "screen_b.json")
        sp_path = _write_spatial(tmp_path / "spatial.json")

        result = _run_ok(
            "--output", "json",
            "tracker-free", "export",
            "--spatial", str(sp_path),
            "--screen-a", str(scr_a_p),
            "--screen-b", str(scr_b_p),
            "--root", "a",
            "--out-dir", str(tmp_path / "out"),
        )

        assert result["data"]["root"] == "Wall_A"

    def test_dry_run(self, tmp_path):
        scr_a_p = _write_screen(_screen(), tmp_path / "screen_a.json")
        scr_b_p = _write_screen(_screen_b(), tmp_path / "screen_b.json")
        sp_path = _write_spatial(tmp_path / "spatial.json")

        result = _run_ok(
            "--output", "json",
            "tracker-free", "export",
            "--spatial", str(sp_path),
            "--screen-a", str(scr_a_p),
            "--screen-b", str(scr_b_p),
            "--out-dir", str(tmp_path / "out"),
            "--dry-run",
        )

        assert result["status"] == "ok"
        assert "dry_run_plan" in result["data"]


# ── cabinet grid overlay ─────────────────────────────────────────────


def _write_stage_pose(path: Path) -> Path:
    """Minimal Volo Stage←camera matrix looking at origin from −Y."""
    R_cv = np.array(
        [
            [1.0, 0.0, 0.0],
            [0.0, 0.0, -1.0],
            [0.0, 1.0, 0.0],
        ],
        dtype=np.float64,
    )
    t_cv = -R_cv @ np.array([0.0, -3000.0, 1000.0])
    cam_pos = -R_cv.T @ t_cv
    cv_from_volo = np.diag([1.0, -1.0, -1.0])
    R_volo = R_cv.T @ cv_from_volo
    M = np.eye(4)
    M[:3, :3] = R_volo
    M[:3, 3] = cam_pos
    path.write_text(json.dumps({
        "schema_version": "volo_stage_pose.v2",
        "solve_kind": "fixed_extrinsics_only",
        "formal": True,
        "image_size": [1920, 1080],
        "camera_from_stage": {
            "position_mm": cam_pos.tolist(),
            "matrix_4x4": M.tolist(),
        },
        "rms_reprojection_px": 0.5,
        "num_markers": 8,
        "num_inliers": 8,
        "preflight": {"passed": True},
        "qualification": {"passed": True, "master_lens": True, "fail_closed": True},
    }))
    return path


class TestGridCLI:

    def test_dry_run(self, tmp_path):
        screen = _write_screen(_screen(), tmp_path / "screen.json")
        pose = _write_stage_pose(tmp_path / "stage_pose.json")
        lens = _write_lens(tmp_path / "lens.json")

        result = _run_ok(
            "--output", "json",
            "tracker-free", "grid",
            "--screen-target", str(screen), "0", "0",
            "--pose", str(pose),
            "--lens", str(lens),
            "--dry-run",
        )
        assert result["status"] == "ok"
        assert result["operation_id"] == "tracker_free.grid"
        assert "dry_run_plan" in result["data"]

    def test_smoke_projects_segments(self, tmp_path):
        screen = _write_screen(_screen(), tmp_path / "screen.json")
        pose = _write_stage_pose(tmp_path / "stage_pose.json")
        lens = _write_lens(tmp_path / "lens.json")

        result = _run_ok(
            "--output", "json",
            "tracker-free", "grid",
            "--screen-target", str(screen), "0", "0",
            "--pose", str(pose),
            "--lens", str(lens),
        )
        assert result["status"] == "ok"
        data = result["data"]
        assert data["image_size"] == [1920, 1080]
        assert len(data["screens"]) == 1
        assert len(data["screens"][0]["segments"]) >= 4

    def test_explicit_intrinsics_require_real_image_size(self, tmp_path):
        screen = _write_screen(_screen(), tmp_path / "screen.json")
        pose = _write_stage_pose(tmp_path / "stage_pose.json")
        result = _run_ok(
            "--output", "json", "tracker-free", "grid",
            "--screen-target", str(screen), "0", "0", "--pose", str(pose),
            "--fx", "1200", "--fy", "1200", "--cx", "970", "--cy", "535",
            "--image-width", "1920", "--image-height", "1080",
            "--debug-unqualified",
        )
        assert result["data"]["image_size"] == [1920, 1080]

    def test_legacy_pose_cannot_generate_formal_overlay(self, tmp_path):
        screen = _write_screen(_screen(), tmp_path / "screen.json")
        pose = tmp_path / "legacy-stage-pose.json"
        pose.write_text(json.dumps({
            "camera_from_stage": {"position_mm": [0, -3000, 1000], "matrix_4x4": np.eye(4).tolist()},
            "rms_reprojection_px": 0.5,
        }))
        lens = _write_lens(tmp_path / "lens.json")
        result = _run(
            "--output", "json", "tracker-free", "grid",
            "--screen-target", str(screen), "0", "0",
            "--pose", str(pose), "--lens", str(lens),
        )
        assert result.returncode != 0
        envelope = json.loads(result.stdout)
        assert envelope["error"]["code"] == "FORMAL_STAGE_POSE_REQUIRED"
