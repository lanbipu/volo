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

from vpcal.models.screen import PlaneSection, ScreenDefinition

SRC = str(Path(__file__).resolve().parents[2] / "src")


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
            "num_images": 10, "num_points": 200, "image_size": [1920, 1080]}
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
    env = dict(os.environ, PYTHONPATH=SRC)
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
