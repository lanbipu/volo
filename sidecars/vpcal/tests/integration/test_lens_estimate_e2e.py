"""Quick Lens Estimate end-to-end integration tests (QLE spec §10.2)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from vpcal.cli.quick import _load_session
from vpcal.core.pipeline import run_quick
from vpcal.core.simulator import default_lens, simulate_dataset
from vpcal.models.lens import BrownConradyDistortion, LensProfile
from vpcal.models.screen import PlaneSection, ScreenDefinition


def _screen() -> ScreenDefinition:
    return ScreenDefinition(
        name="t", unit="mm", cabinet_size=[500, 500], led_pixel_pitch_mm=2.8,
        markers_per_cabinet=4,
        sections=[PlaneSection(name="w", width_mm=5000, height_mm=3000, origin=[0, 0, 0])],
    )


def _simulate(tmp_path: Path, *, gt_lens: LensProfile | None, lens_estimate: dict | None) -> Path:
    nominal = default_lens(1920, 1080)
    simulate_dataset(
        _screen(), tmp_path, num_poses=14, noise_px=0.0, lens=nominal,
        ground_truth_lens=gt_lens, seed=7, render_images=False,
    )
    sp = tmp_path / "session.json"
    raw = json.loads(sp.read_text())
    if lens_estimate is not None:
        raw["solver"]["lens_estimate"] = lens_estimate
    sp.write_text(json.dumps(raw, indent=2))
    return sp


def test_quick_run_estimate_lens_end_to_end(tmp_path):
    gt_lens = LensProfile(
        focal_length_mm=24.0, sensor_width_mm=36.0, sensor_height_mm=24.0,
        principal_point_offset_mm=(0.0, 0.0), image_width_px=1920, image_height_px=1080,
        distortion=BrownConradyDistortion(k1=-0.06),
    )
    sp = _simulate(
        tmp_path, gt_lens=gt_lens,
        lens_estimate={"enabled": True, "params": ["k1", "k2", "cx", "cy"], "min_edge_obs_fraction": 0.15},
    )
    session, raw, sdir = _load_session(str(sp))
    res = run_quick(session, sdir, tmp_path / "output", raw_session=raw, prefer_cpp=False)

    assert res["exit_code"] == 0
    q = res["result"]["quality"]
    assert q["lens_observability_warning"] is True
    est = q["lens_estimate"]
    assert est is not None
    assert est["is_master"] is False and est["session_coupled"] is True
    # k1 is observable here and should be recovered; cx/cy revert (single-plane confound).
    assert est["distortion_k1"]["observable"] is True
    assert abs(est["distortion_k1"]["value"] - (-0.06)) < 0.01
    assert est["refined_rms_px"] < est["spatial_only_rms_px"]
    assert (tmp_path / "output" / "qa" / "lens_observability.json").exists()


def test_quick_run_disabled_no_lens_estimate(tmp_path):
    sp = _simulate(tmp_path, gt_lens=None, lens_estimate=None)
    session, raw, sdir = _load_session(str(sp))
    res = run_quick(session, sdir, tmp_path / "output", raw_session=raw, prefer_cpp=False)

    assert res["exit_code"] in (0, 9)
    q = res["result"]["quality"]
    assert q["lens_estimate"] is None
    assert q["lens_observability_warning"] is False
    assert not (tmp_path / "output" / "qa" / "lens_observability.json").exists()


def test_quick_run_cx_cy_reverted_single_plane(tmp_path):
    """Single-plane geometry confounds cx/cy with pose → they must revert."""
    gt_lens = LensProfile(
        focal_length_mm=24.0, sensor_width_mm=36.0, sensor_height_mm=24.0,
        principal_point_offset_mm=(0.4, -0.25), image_width_px=1920, image_height_px=1080,
        distortion=BrownConradyDistortion(),
    )
    sp = _simulate(
        tmp_path, gt_lens=gt_lens,
        lens_estimate={"enabled": True, "params": ["cx", "cy"]},
    )
    session, raw, sdir = _load_session(str(sp))
    res = run_quick(session, sdir, tmp_path / "output", raw_session=raw, prefer_cpp=False)
    est = res["result"]["quality"]["lens_estimate"]
    assert est is not None
    pp = est["principal_point_offset_mm"]
    assert pp[0]["observable"] is False and pp[1]["observable"] is False
    assert est["confidence"] == "low"  # nothing kept


def test_openlensio_distortion_conversion(tmp_path):
    """OpenLensIO export: centered principal point → ∆P≈0; coefficients mm-normalised."""
    import numpy as np

    from vpcal.io.export.opentrackio import export_opentrackio

    centered = LensProfile(
        focal_length_mm=24.0, sensor_width_mm=36.0, sensor_height_mm=24.0,
        principal_point_offset_mm=(0.0, 0.0), image_width_px=1920, image_height_px=1080,
        distortion=BrownConradyDistortion(k1=-0.06, k2=0.01),
    )
    poses = [(0, 0.0, np.array([1.0, 0, 0, 0]), np.zeros(3))]
    ident = (np.array([1.0, 0, 0, 0]), np.zeros(3))
    out = tmp_path / "otio.jsonl"
    export_opentrackio(poses, ident, ident, centered, out, session_estimate=True)
    sample = json.loads(out.read_text().splitlines()[0])
    lens = sample["lens"]
    assert abs(lens["projectionOffset"]["x"]) < 1e-9
    assert abs(lens["projectionOffset"]["y"]) < 1e-9
    assert abs(lens["distortion"][0]["radial"][0] - (-0.06 / 24.0**2)) < 1e-12
    # Coefficients are the OpenCV forward model → "U-D" per OpenCV_to_OpenTrackIO.md.
    assert lens["distortion"][0]["model"] == "Brown-Conrady U-D"
    # Schema forbids custom lens keys; the non-master flag lives in tracker.notes.
    assert "sessionEstimate" not in lens
    assert "session-coupled quick lens estimate" in sample["tracker"]["notes"]

    offset = LensProfile(
        focal_length_mm=24.0, sensor_width_mm=36.0, sensor_height_mm=24.0,
        principal_point_offset_mm=(0.4, -0.25), image_width_px=1920, image_height_px=1080,
        distortion=BrownConradyDistortion(),
    )
    out2 = tmp_path / "otio2.jsonl"
    export_opentrackio(poses, ident, ident, offset, out2, session_estimate=False)
    sample2 = json.loads(out2.read_text().splitlines()[0])
    lens2 = sample2["lens"]
    assert abs(lens2["projectionOffset"]["x"] - 0.4) < 1e-9
    assert abs(lens2["projectionOffset"]["y"] - (-0.25)) < 1e-9
    # Not a session estimate → no notes key at all (schema: notes must be a
    # non-blank string when present).
    assert "notes" not in sample2["tracker"]


def test_gate_angular_spread_ignores_unobserved_frames():
    """Angular-spread gate input must come from observed frames only (review P2)."""
    import numpy as np

    from vpcal.core.projection import CameraIntrinsics
    from vpcal.core.simulator import (
        forward_observations,
        generate_camera_poses,
        random_ground_truth,
    )
    from vpcal.core.pipeline import _estimate_lens
    from vpcal.qa.coverage import _pose_distribution
    from vpcal.models.session import (
        ImagesConfig,
        LensEstimateConfig,
        ScreenConfig,
        SessionConfig,
        SolverConfig,
        TrackingConfig,
    )

    screen = _screen()
    nominal = default_lens(1920, 1080)
    intr = CameraIntrinsics.from_lens(nominal)
    rng = np.random.default_rng(11)
    gt = random_ground_truth(rng)
    cam_poses = generate_camera_poses(screen, 10, rng)
    obs, tracker_poses, _v = forward_observations(
        screen, intr, gt, cam_poses, markers_per_cabinet=4, rng=rng,
    )
    observed_poses = {i: tracker_poses[i] for i in range(len(tracker_poses))}
    expected = _pose_distribution(list(observed_poses.values()))["angular_spread_deg"]

    # Add unobserved extra frames with a wild orientation that would inflate spread.
    poses = dict(observed_poses)
    wild_q = np.array([0.5, 0.5, 0.5, 0.5])
    for k in range(50, 56):
        poses[k] = (wild_q, np.array([5000.0, 5000.0, 5000.0]))

    session = SessionConfig(
        images=ImagesConfig(path="x"), tracking=TrackingConfig(path="x"),
        screen=ScreenConfig(path="x"), lens=nominal,
        solver=SolverConfig(lens_estimate=LensEstimateConfig(enabled=True, params={"cx", "cy"})),
    )
    init_C = (np.array([1.0, 0, 0, 0]), np.zeros(3))
    est = _estimate_lens(session, obs, intr, poses, init_C, prefer_cpp=False)
    assert abs(est["pre"]["signals"]["angular_spread_deg"] - expected) < 1e-6


def test_standalone_export_propagates_estimate(tmp_path):
    """`vpcal export opentrackio` on an --estimate-lens result tags + emits the estimate."""
    from click.testing import CliRunner

    from vpcal.cli.main import cli

    gt_lens = LensProfile(
        focal_length_mm=24.0, sensor_width_mm=36.0, sensor_height_mm=24.0,
        principal_point_offset_mm=(0.0, 0.0), image_width_px=1920, image_height_px=1080,
        distortion=BrownConradyDistortion(k1=-0.06),
    )
    sp = _simulate(
        tmp_path, gt_lens=gt_lens,
        lens_estimate={"enabled": True, "params": ["k1", "k2"], "min_edge_obs_fraction": 0.15},
    )
    session, raw, sdir = _load_session(str(sp))
    run_quick(session, sdir, tmp_path / "output", raw_session=raw, prefer_cpp=False)
    result_json = tmp_path / "output" / "result.json"

    out = tmp_path / "reexport.jsonl"
    runner = CliRunner()
    res = runner.invoke(
        cli,
        ["export", "opentrackio", "--result", str(result_json), "--session", str(sp), "--out", str(out)],
    )
    assert res.exit_code == 0, res.output
    sample = json.loads(out.read_text().splitlines()[0])
    assert "session-coupled quick lens estimate" in sample["tracker"]["notes"]
    # The exported radial reflects the kept estimated k1 (≈ -0.06 / F²), not nominal 0.
    assert abs(sample["lens"]["distortion"][0]["radial"][0] - (-0.06 / 24.0**2)) < 5e-5


def test_precondition_still_exit6_in_lens_mode(tmp_path):
    """< 3 poses with --estimate-lens still fails the hard pose precondition."""
    gt_lens = default_lens(1920, 1080)
    nominal = default_lens(1920, 1080)
    simulate_dataset(
        _screen(), tmp_path, num_poses=2, noise_px=0.0, lens=nominal,
        ground_truth_lens=gt_lens, seed=1, render_images=False,
    )
    sp = tmp_path / "session.json"
    raw = json.loads(sp.read_text())
    raw["solver"]["lens_estimate"] = {"enabled": True}
    sp.write_text(json.dumps(raw, indent=2))
    session, raw2, sdir = _load_session(str(sp))
    from vpcal.core.errors import PreconditionError

    with pytest.raises(PreconditionError):
        run_quick(session, sdir, tmp_path / "output", raw_session=raw2, prefer_cpp=False)
