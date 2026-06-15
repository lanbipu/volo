"""Tracker-free end-to-end integration tests using real walkthrough data.

Uses photos from _walkthrough/lens_photos and _walkthrough/spatial_photos
(gitignored, only available on dev machines with real capture data).
All tests are skipped if the data directory is missing.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

WALKTHROUGH = Path(__file__).resolve().parents[2] / "_walkthrough"

pytestmark = pytest.mark.skipif(
    not (WALKTHROUGH / "lens_photos" / "060801").exists(),
    reason="walkthrough data not available (gitignored)",
)

SCREEN_ASUS = str(WALKTHROUGH / "screen_asus.json")
SCREEN_LG = str(WALKTHROUGH / "screen_lg.json")
LENS_PHOTOS = str(WALKTHROUGH / "lens_photos" / "060801")
SPATIAL_PHOTOS = str(WALKTHROUGH / "spatial_photos" / "060801")
REFERENCE_LENS = json.loads((WALKTHROUGH / "lens.json").read_text())
REFERENCE_SPATIAL = json.loads((WALKTHROUGH / "spatial.json").read_text())


# ── lens-cal ─────────────────────────────────────────────────────────


class TestLensCalWalkthrough:

    def test_recovers_known_intrinsics(self, tmp_path):
        from vpcal.core.tracker_free import lens_calibrate
        from vpcal.io.screen_io import load_screen

        screen_lg = load_screen(SCREEN_LG)
        result = lens_calibrate(
            Path(LENS_PHOTOS), screen_lg, cab_col_offset=16,
        )

        assert result.num_images == 9
        assert result.num_points == 394
        assert result.image_size == (8256, 5504)
        assert abs(result.rms - REFERENCE_LENS["rms"]) < 0.01
        assert abs(result.fx - REFERENCE_LENS["fx"]) < 1.0
        assert abs(result.fy - REFERENCE_LENS["fy"]) < 1.0
        assert abs(result.cx - REFERENCE_LENS["cx"]) < 5.0
        assert abs(result.cy - REFERENCE_LENS["cy"]) < 5.0

    def test_lens_output_matches_reference(self, tmp_path):
        from vpcal.core.tracker_free import lens_calibrate
        from vpcal.io.screen_io import load_screen

        screen_lg = load_screen(SCREEN_LG)
        result = lens_calibrate(
            Path(LENS_PHOTOS), screen_lg, cab_col_offset=16,
        )

        for i, (got, ref) in enumerate(zip(result.dist_coeffs, REFERENCE_LENS["dist_coeffs"])):
            assert abs(got - ref) < 0.001, f"dist_coeffs[{i}] mismatch: {got} vs {ref}"


# ── spatial ──────────────────────────────────────────────────────────


class TestSpatialSolveWalkthrough:

    @pytest.fixture
    def lens(self):
        from vpcal.core.tracker_free import LensCalResult
        d = REFERENCE_LENS
        return LensCalResult(
            fx=d["fx"], fy=d["fy"], cx=d["cx"], cy=d["cy"],
            dist_coeffs=d["dist_coeffs"], rms=d["rms"],
            num_images=d["num_images"], num_points=d["num_points"],
            image_size=tuple(d["image_size"]),
        )

    def test_spatial_solve_matches_reference(self, lens):
        from vpcal.core.tracker_free import spatial_solve
        from vpcal.io.screen_io import load_screen

        scr_a = load_screen(SCREEN_ASUS)
        scr_b = load_screen(SCREEN_LG)

        result = spatial_solve(
            Path(SPATIAL_PHOTOS), scr_a, scr_b, lens,
            cab_col_offset_a=0, cab_col_offset_b=16,
        )

        assert result.num_co_visible == REFERENCE_SPATIAL["num_co_visible"]
        assert result.screen_a_name == "ASUS PG279QE"
        assert result.screen_b_name == "LG OLED G3 55"

        ref_t = REFERENCE_SPATIAL["screen_b_relative"]["translation_mm"]
        got_t = result.screen_b_pose.tvec.ravel().tolist()
        np.testing.assert_allclose(got_t, ref_t, atol=0.1)

        ref_R = np.array(REFERENCE_SPATIAL["screen_b_relative"]["rotation_matrix"])
        got_R = result.screen_b_pose.rotation_matrix
        np.testing.assert_allclose(got_R, ref_R, atol=1e-4)

    def test_per_image_detection_counts(self, lens):
        from vpcal.core.tracker_free import spatial_solve
        from vpcal.io.screen_io import load_screen

        scr_a = load_screen(SCREEN_ASUS)
        scr_b = load_screen(SCREEN_LG)

        result = spatial_solve(
            Path(SPATIAL_PHOTOS), scr_a, scr_b, lens,
            cab_col_offset_a=0, cab_col_offset_b=16,
        )

        ref_by_name = {p["image"]: p for p in REFERENCE_SPATIAL["per_image"]}
        for entry in result.per_image_poses:
            ref = ref_by_name.get(entry["image"])
            if ref is not None:
                assert entry["markers_a"] == ref["markers_a"], f'{entry["image"]} markers_a mismatch'
                assert entry["markers_b"] == ref["markers_b"], f'{entry["image"]} markers_b mismatch'


# ── verify ───────────────────────────────────────────────────────────


class TestVerifyWalkthrough:

    @pytest.fixture
    def lens(self):
        from vpcal.core.tracker_free import LensCalResult
        d = REFERENCE_LENS
        return LensCalResult(
            fx=d["fx"], fy=d["fy"], cx=d["cx"], cy=d["cy"],
            dist_coeffs=d["dist_coeffs"], rms=d["rms"],
            num_images=d["num_images"], num_points=d["num_points"],
            image_size=tuple(d["image_size"]),
        )

    def test_verify_covisible_image(self, lens):
        from vpcal.core.tracker_free import verify_pose
        from vpcal.io.screen_io import load_screen

        scr_a = load_screen(SCREEN_ASUS)
        scr_b = load_screen(SCREEN_LG)
        # Image 15: 66 markers on A, 66 on B (best co-visible frame)
        img = Path(SPATIAL_PHOTOS) / "20260608-DSC_0000-15.JPG"

        result = verify_pose(
            img, scr_a, scr_b, lens,
            cab_col_offset_a=0, cab_col_offset_b=16,
        )

        assert result.num_markers_a == 66
        assert result.num_markers_b == 66
        assert result.camera_pose_from_a is not None
        assert result.camera_pose_from_b is not None

        dist_a = np.linalg.norm(result.camera_pose_from_a.camera_position_in_screen)
        dist_b = np.linalg.norm(result.camera_pose_from_b.camera_position_in_screen)
        # Camera is roughly 2.5m from both screens
        assert 1500 < dist_a < 4000
        assert 1500 < dist_b < 4000

    def test_verify_single_screen_image(self, lens):
        from vpcal.core.tracker_free import verify_pose
        from vpcal.io.screen_io import load_screen

        scr_a = load_screen(SCREEN_ASUS)
        scr_b = load_screen(SCREEN_LG)
        # Image 11: 64 markers on A, 0 on B
        img = Path(SPATIAL_PHOTOS) / "20260608-DSC_0000-11.JPG"

        result = verify_pose(
            img, scr_a, scr_b, lens,
            cab_col_offset_a=0, cab_col_offset_b=16,
        )

        assert result.num_markers_a == 64
        assert result.num_markers_b == 0
        assert result.camera_pose_from_a is not None
        assert result.camera_pose_from_b is None


# ── export ───────────────────────────────────────────────────────────


class TestExportWalkthrough:

    def test_export_matches_reference(self, tmp_path):
        from vpcal.core.tracker_free import export_obj
        from vpcal.io.screen_io import load_screen

        scr_a = load_screen(SCREEN_ASUS)
        scr_b = load_screen(SCREEN_LG)
        spatial_json = WALKTHROUGH / "spatial.json"
        out_dir = tmp_path / "export"

        screens = export_obj(spatial_json, scr_a, scr_b, out_dir, root="b")

        assert len(screens) == 2
        obj_files = sorted(out_dir.glob("*.obj"))
        assert len(obj_files) == 2

        # Compare against reference exports
        ref_dir = WALKTHROUGH / "export_disguise"
        for obj_file in obj_files:
            ref_file = ref_dir / obj_file.name
            if ref_file.exists():
                got_verts = _parse_obj_vertices(obj_file)
                ref_verts = _parse_obj_vertices(ref_file)
                np.testing.assert_allclose(got_verts, ref_verts, atol=0.001,
                                           err_msg=f"Vertex mismatch in {obj_file.name}")


def _parse_obj_vertices(path: Path) -> np.ndarray:
    verts = []
    for line in path.read_text().splitlines():
        if line.startswith("v "):
            parts = line.split()
            verts.append([float(parts[1]), float(parts[2]), float(parts[3])])
    return np.array(verts)
