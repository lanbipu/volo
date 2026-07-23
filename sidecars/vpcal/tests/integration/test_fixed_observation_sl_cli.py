"""Integration tests for ``vpcal tracker-free fixed-observation-sl``.

Builds a synthetic two-screen (non-coplanar) structured-light observation
entirely through the file formats the real pipeline produces:
  - ``.screen.json``  (vpcal ScreenDefinition, same as VP-QSP path)
  - ``sl_meta.json``  (mesh-vba structured_light.py output: dot id -> screen
    PIXEL u,v)
  - ``corr.json``     (mesh-vba sl_decode.py output: dot id -> camera pixel x,y)

and drives the CLI as a subprocess (mirrors ``test_tracker_free_cli.py``).
Ground-truth recovery (focal, camera position, near-zero distortion) proves
the pixel -> world_mm bridge (screen_geometry.uv_to_pattern_pixel, inverted)
lands points in the SAME world frame VP-QSP's enumerate_markers uses — not
mesh-vba's own un-placed nominal reconstruction frame.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np
import pytest

from vpcal.core.screen_geometry import uv_to_pattern_pixel
from vpcal.models.screen import PlaneSection, ScreenDefinition

SRC = str(Path(__file__).resolve().parents[2] / "src")
_BOOTSTRAP = str(Path(__file__).resolve().parents[1] / "_bootstrap")

CANVAS_W, CANVAS_H = 3400, 2200  # SL pattern render canvas (mesh-vba screen_resolution)
CAMERA_W, CAMERA_H = 1920, 1080
K = np.array([[1600.0, 0.0, 960.0], [0.0, 1600.0, 540.0], [0.0, 0.0, 1.0]])
DIST = np.zeros(5)


def _quat_axis_angle(axis, deg) -> list[float]:
    axis = np.asarray(axis, dtype=float)
    axis = axis / np.linalg.norm(axis)
    rad = math.radians(deg)
    w = math.cos(rad / 2)
    xyz = axis * math.sin(rad / 2)
    return [float(w), float(xyz[0]), float(xyz[1]), float(xyz[2])]


def _plane_screen(name: str, width_mm: float, height_mm: float, origin, axis, deg: float) -> ScreenDefinition:
    return ScreenDefinition(
        name=name, unit="mm",
        cabinet_size=[width_mm, height_mm], led_pixel_pitch_mm=2.8,
        markers_per_cabinet=1,
        sections=[PlaneSection(name="wall", width_mm=width_mm, height_mm=height_mm,
                                origin=origin, rotation=_quat_axis_angle(axis, deg))],
    )


def _dot_grid(nu: int, nv: int) -> list[tuple[float, float]]:
    return [(i / (nu - 1), j / (nv - 1)) for i in range(nu) for j in range(nv)]


def _project(world_pts, rvec, tvec) -> np.ndarray:
    obj = np.asarray(world_pts, dtype=np.float64).reshape(-1, 1, 3)
    img, _ = cv2.projectPoints(obj, rvec, tvec, K, DIST)
    return img.reshape(-1, 2)


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


class _TwoScreenScene:
    """A ~50deg dihedral two-screen fixed observation with known ground truth."""

    def __init__(self, seed: int = 0, noise_px: float = 0.1):
        self.screen_a = _plane_screen("A", 3400.0, 2200.0, [0, 0, 0], [0, 0, 1], 0.0)
        self.screen_b = _plane_screen("B", 3400.0, 2200.0, [1400, 900, 0], [0, 0, 1], 50.0)

        self.camera_center = np.array([0.0, -2600.0, 500.0])
        self.R_cw = np.array([[1, 0, 0], [0, 0, -1], [0, 1, 0]], dtype=float)
        self.tvec = (-self.R_cw @ self.camera_center).reshape(3, 1)
        self.rvec, _ = cv2.Rodrigues(self.R_cw)
        self.gt_fx = float(K[0, 0])

        uv = _dot_grid(8, 8)
        self.uv_by_screen = {"A": uv, "B": uv}
        self.world_by_screen = {
            "A": [self.screen_a.sections[0].uv_to_world(u, v) for (u, v) in uv],
            "B": [self.screen_b.sections[0].uv_to_world(u, v) for (u, v) in uv],
        }
        rng = np.random.default_rng(seed)
        self.pixel_by_screen = {
            label: _project(pts, self.rvec, self.tvec) + rng.normal(0, noise_px, size=(len(pts), 2))
            for label, pts in self.world_by_screen.items()
        }

    def write_screen_target(self, tmp_path: Path, label: str, screen: ScreenDefinition, *,
                             corrupt_sha: bool = False, wrong_screen_id: bool = False):
        scr_path = tmp_path / f"{label}.screen.json"
        scr_path.write_text(screen.model_dump_json(indent=2))

        uv_pts = self.uv_by_screen[label]
        dots = []
        for i, (u, v) in enumerate(uv_pts):
            u_px, v_px = uv_to_pattern_pixel(u, v, CANVAS_W, CANVAS_H)
            dots.append({"id": i, "u": u_px, "v": v_px, "cabinet": [0, 0]})
        sl_meta = {
            "schema_version": 1,
            "screen_id": label,
            "screen_resolution": [CANVAS_W, CANVAS_H],
            "dot_radius_px": 6,
            "code": {"data_bits": 8, "total_bits": 9, "parity": "even", "encoding": "binary"},
            "sequence": {"sentinel": "white_full", "anchor": "all_on", "n_code_frames": 9,
                         "hold_ms": 500, "fps": 30},
            "cabinets": [{"col": 0, "row": 0, "input_rect_px": [0, 0, CANVAS_W, CANVAS_H],
                          "pixel_pitch_mm": [1.0, 1.0]}],
            "dots": dots,
        }
        sl_meta_path = tmp_path / f"{label}.sl_meta.json"
        sl_meta_bytes = json.dumps(sl_meta, indent=2).encode()
        sl_meta_path.write_bytes(sl_meta_bytes)
        sha = hashlib.sha256(sl_meta_bytes).hexdigest()
        if corrupt_sha:
            sha = "0" * 64

        px = self.pixel_by_screen[label]
        points = [{"id": i, "u": dots[i]["u"], "v": dots[i]["v"],
                   "x": float(px[i, 0]), "y": float(px[i, 1])} for i in range(len(uv_pts))]
        corr = {
            "schema_version": 1,
            "screen_id": "WRONG" if wrong_screen_id else label,
            "sl_meta_sha256": sha,
            "screen_resolution": [CANVAS_W, CANVAS_H],
            "camera_image_size": [CAMERA_W, CAMERA_H],
            "source_input": f"{label}.mp4",
            "screen_roi": [0, 0, CAMERA_W, CAMERA_H],
            "points": points,
        }
        corr_path = tmp_path / f"{label}.corr.json"
        corr_path.write_text(json.dumps(corr, indent=2))
        return scr_path, sl_meta_path, corr_path


class TestFixedObservationSlCLI:

    def test_joint_pass_recovers_ground_truth(self, tmp_path):
        scene = _TwoScreenScene()
        a = scene.write_screen_target(tmp_path, "A", scene.screen_a)
        b = scene.write_screen_target(tmp_path, "B", scene.screen_b)
        out_path = tmp_path / "fixed_observation_result.json"

        result = _run_ok(
            "--output", "json",
            "tracker-free", "fixed-observation-sl",
            "--screen-target", str(a[0]), str(a[1]), str(a[2]),
            "--screen-target", str(b[0]), str(b[1]), str(b[2]),
            "--camera-id", "test-cam",
            "--out", str(out_path),
        )["data"]

        assert result["mode_resolved"] == "joint-session-lens"
        assert result["formal"] is True
        assert result["qualification"]["passed"] is True
        assert result["num_correspondences"] == 128
        assert result["detection"]["per_screen"] == {"A": 64, "B": 64}

        session_lens = result["session_lens"]
        fx = session_lens["K"][0][0]
        assert fx == pytest.approx(scene.gt_fx, rel=0.01)
        assert result["rms_reprojection_px"] < 0.5

        camera_pos = result["camera_from_stage"]["position_mm"]
        assert np.allclose(camera_pos, scene.camera_center, atol=5.0)

        assert out_path.exists()
        on_disk = json.loads(out_path.read_text())
        assert on_disk["schema_version"] == "fixed_observation_result.v1"

    def test_dry_run_reports_per_screen_correspondence_counts(self, tmp_path):
        scene = _TwoScreenScene()
        a = scene.write_screen_target(tmp_path, "A", scene.screen_a)
        b = scene.write_screen_target(tmp_path, "B", scene.screen_b)

        result = _run_ok(
            "--output", "json",
            "tracker-free", "fixed-observation-sl",
            "--screen-target", str(a[0]), str(a[1]), str(a[2]),
            "--screen-target", str(b[0]), str(b[1]), str(b[2]),
            "--out", str(tmp_path / "out.json"),
            "--dry-run",
        )

        plan = result["data"]["dry_run_plan"]
        assert plan["correspondences"] == 128
        assert plan["correspondences_per_screen"] == {"A": 64, "B": 64}
        assert not (tmp_path / "out.json").exists()

    def test_sl_meta_sha_mismatch_is_rejected(self, tmp_path):
        scene = _TwoScreenScene()
        a = scene.write_screen_target(tmp_path, "A", scene.screen_a, corrupt_sha=True)
        b = scene.write_screen_target(tmp_path, "B", scene.screen_b)

        r = _run(
            "--output", "json",
            "tracker-free", "fixed-observation-sl",
            "--screen-target", str(a[0]), str(a[1]), str(a[2]),
            "--screen-target", str(b[0]), str(b[1]), str(b[2]),
            "--out", str(tmp_path / "out.json"),
        )
        assert r.returncode != 0
        envelope = json.loads(r.stdout)
        assert envelope["status"] == "error"
        assert "sha256 mismatch" in envelope["error"]["message"]

    def test_screen_id_mismatch_is_rejected(self, tmp_path):
        scene = _TwoScreenScene()
        a = scene.write_screen_target(tmp_path, "A", scene.screen_a, wrong_screen_id=True)
        b = scene.write_screen_target(tmp_path, "B", scene.screen_b)

        r = _run(
            "--output", "json",
            "tracker-free", "fixed-observation-sl",
            "--screen-target", str(a[0]), str(a[1]), str(a[2]),
            "--screen-target", str(b[0]), str(b[1]), str(b[2]),
            "--out", str(tmp_path / "out.json"),
        )
        assert r.returncode != 0
        envelope = json.loads(r.stdout)
        assert envelope["status"] == "error"
        assert "screen_id" in envelope["error"]["message"]

    def test_single_screen_is_unobservable_without_master_lens(self, tmp_path):
        """A single flat screen, no lens: geometric degeneracy must fail-closed
        (mirrors the VP-QSP acceptance case in the sibling spec)."""
        scene = _TwoScreenScene()
        a = scene.write_screen_target(tmp_path, "A", scene.screen_a)

        r = _run(
            "--output", "json",
            "tracker-free", "fixed-observation-sl",
            "--screen-target", str(a[0]), str(a[1]), str(a[2]),
            "--out", str(tmp_path / "out.json"),
        )
        assert r.returncode != 0
        envelope = json.loads(r.stdout)
        assert envelope["error"]["code"] == "SINGLE_VIEW_UNOBSERVABLE"

    def test_mismatched_camera_image_size_is_rejected(self, tmp_path):
        scene = _TwoScreenScene()
        a = scene.write_screen_target(tmp_path, "A", scene.screen_a)
        b = scene.write_screen_target(tmp_path, "B", scene.screen_b)
        # Corrupt B's corr.json camera_image_size to simulate a mismatched capture.
        corr_path = b[2]
        corr = json.loads(corr_path.read_text())
        corr["camera_image_size"] = [1280, 720]
        corr_path.write_text(json.dumps(corr))

        r = _run(
            "--output", "json",
            "tracker-free", "fixed-observation-sl",
            "--screen-target", str(a[0]), str(a[1]), str(a[2]),
            "--screen-target", str(b[0]), str(b[1]), str(b[2]),
            "--out", str(tmp_path / "out.json"),
        )
        assert r.returncode != 0
        envelope = json.loads(r.stdout)
        assert "camera_image_size" in envelope["error"]["message"]
