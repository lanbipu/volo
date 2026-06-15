"""End-to-end pipeline tests: simulate → quick run → ground truth (spec §8.4).

The exact-correspondence path verifies the solver to < 0.01 px; the detector
path verifies the full image→solve pipeline to a realistic tolerance.
"""

from __future__ import annotations

import json

import numpy as np
import pytest

from vpcal.core.pipeline import run_quick
from vpcal.core.simulator import default_lens, simulate_dataset
from vpcal.models.screen import ArcSection, PlaneSection, ScreenDefinition
from vpcal.models.session import SessionConfig


def _plane_screen():
    return ScreenDefinition(
        name="plane_studio", unit="mm", cabinet_size=(500, 500), led_pixel_pitch_mm=2.8,
        markers_per_cabinet=4,
        sections=[PlaneSection(name="w", width_mm=2400, height_mm=1600, origin=[0, 0, 0])],
    )


def _arc_screen():
    return ScreenDefinition(
        name="arc_studio", unit="mm", cabinet_size=(500, 500), led_pixel_pitch_mm=2.8,
        markers_per_cabinet=4,
        sections=[ArcSection(name="back", arc_radius_mm=4000, arc_angle_deg=80, arc_center_angle_deg=180, height_mm=2000)],
    )


def _run_exact(tmp_path, screen, *, noise_px=0.0, outlier_ratio=0.0, num_poses=10, seed=0):
    simulate_dataset(
        screen, tmp_path, num_poses=num_poses, noise_px=noise_px, outlier_ratio=outlier_ratio,
        lens=default_lens(1920, 1080), seed=seed, render_images=False,
    )
    raw = json.loads((tmp_path / "session.json").read_text())
    session = SessionConfig.model_validate(raw)
    result = run_quick(session, tmp_path, tmp_path / "output", raw_session=raw, prefer_cpp=True)
    gt = json.loads((tmp_path / "ground_truth.json").read_text())["tracker_to_stage"]
    return result, gt


def _gt_diff(gt, est):
    dt = np.linalg.norm(np.array(gt["translation"]) - np.array(est["translation"]))
    qg, qe = np.array(gt["rotation"]), np.array(est["rotation"])
    dq = min(np.linalg.norm(qg - qe), np.linalg.norm(qg + qe))
    return dt, dq


def test_zero_noise_plane_recovers_ground_truth(tmp_path):
    result, gt = _run_exact(tmp_path, _plane_screen())
    q = result["result"]["quality"]
    assert q["reprojection_rms_px"] < 0.01  # spec §8.4
    dt, dq = _gt_diff(gt, result["result"]["tracker_to_stage"])
    assert dt < 0.01 and dq < 1e-3
    assert result["exit_code"] == 0
    assert q["confidence"] == "high"


def test_zero_noise_arc_recovers_ground_truth(tmp_path):
    result, gt = _run_exact(tmp_path, _arc_screen())
    assert result["result"]["quality"]["reprojection_rms_px"] < 0.01
    dt, dq = _gt_diff(gt, result["result"]["tracker_to_stage"])
    assert dt < 0.05 and dq < 1e-3


def test_gaussian_noise_rms_matches(tmp_path):
    result, gt = _run_exact(tmp_path, _plane_screen(), noise_px=0.5, seed=1)
    rms = result["result"]["quality"]["reprojection_rms_px"]
    # Per-axis sigma 0.5 px → 2D residual RMS ≈ sigma·√2 ≈ 0.71 px.
    assert 0.4 < rms < 0.9
    dt, _dq = _gt_diff(gt, result["result"]["tracker_to_stage"])
    assert dt < 20.0  # still close despite noise


def test_outliers_rejected(tmp_path):
    result, gt = _run_exact(tmp_path, _plane_screen(), outlier_ratio=0.05, num_poses=12, seed=2)
    diag = result["result"]["solver_diagnostics"]
    assert diag["num_outliers"] > 0
    dt, _dq = _gt_diff(gt, result["result"]["tracker_to_stage"])
    assert dt < 5.0  # robust loss keeps the estimate clean


def test_outputs_written(tmp_path):
    result, _gt = _run_exact(tmp_path, _plane_screen())
    out = tmp_path / "output"
    assert (out / "result.json").exists()
    assert (out / "qa" / "reprojection.json").exists()
    assert (out / "qa" / "coverage.json").exists()
    assert (out / "qa" / "validation.json").exists()
    assert (out / "export" / "tracking_calibrated.jsonl").exists()


def test_low_observation_count_partial_failure(tmp_path):
    # Few markers + few poses → < 50 observations → exit 9 (partial failure).
    screen = ScreenDefinition(
        name="tiny", unit="mm", cabinet_size=(500, 500), led_pixel_pitch_mm=2.8,
        markers_per_cabinet=4,
        sections=[PlaneSection(name="w", width_mm=500, height_mm=500, origin=[0, 0, 0])],
    )
    result, _gt = _run_exact(tmp_path, screen, num_poses=4)
    assert result["result"]["quality"]["total_observations"] < 50
    assert result["exit_code"] == 9
    assert result["confidence"] == "very_low"


def test_detector_path_end_to_end(tmp_path):
    # Render images, remove the exact-observations sidecar → force image detection.
    screen = ScreenDefinition(
        name="det", unit="mm", cabinet_size=(500, 500), led_pixel_pitch_mm=2.8,
        markers_per_cabinet=4,
        sections=[PlaneSection(name="w", width_mm=1200, height_mm=900, origin=[0, 0, 0])],
    )
    simulate_dataset(screen, tmp_path, num_poses=8, noise_px=0.0, lens=default_lens(1920, 1080), seed=4, render_images=True)
    (tmp_path / "observations.jsonl").unlink()
    raw = json.loads((tmp_path / "session.json").read_text())
    session = SessionConfig.model_validate(raw)
    result = run_quick(session, tmp_path, tmp_path / "output", raw_session=raw, prefer_cpp=True)
    q = result["result"]["quality"]
    assert result["detection_source"] == "detector"
    assert q["num_poses"] >= 3
    gt = json.loads((tmp_path / "ground_truth.json").read_text())["tracker_to_stage"]
    dt, dq = _gt_diff(gt, result["result"]["tracker_to_stage"])
    assert dt < 10.0 and dq < 0.02  # raster detection → mm-level recovery


def test_stage_validate_only(tmp_path):
    simulate_dataset(_plane_screen(), tmp_path, num_poses=8, noise_px=0.0,
                     lens=default_lens(1920, 1080), seed=0, render_images=False)
    raw = json.loads((tmp_path / "session.json").read_text())
    session = SessionConfig.model_validate(raw)
    result = run_quick(session, tmp_path, tmp_path / "output", raw_session=raw, stage="validate", prefer_cpp=False)
    assert result["stage"] == "validate"
    assert (tmp_path / "output" / "qa" / "validation.json").exists()
