"""Held-out validation pose acceptance tests (remediation A4)."""

from __future__ import annotations

import json

import numpy as np

from vpcal.core.pipeline import _confidence, _estimate_lens, run_quick
from vpcal.core.projection import CameraIntrinsics
from vpcal.core.simulator import (
    default_lens,
    forward_observations,
    generate_camera_poses,
    random_ground_truth,
    simulate_dataset,
)
from vpcal.models.screen import PlaneSection, ScreenDefinition
from vpcal.models.session import SessionConfig


def _screen(width=4000, height=3000):
    return ScreenDefinition(
        name="w", unit="mm", cabinet_size=(500, 500), led_pixel_pitch_mm=2.8,
        markers_per_cabinet=4,
        sections=[PlaneSection(name="w", width_mm=width, height_mm=height, origin=[0, 0, 0])],
    )


def test_validation_rms_healthy_close_to_training(tmp_path):
    """Healthy synthetic closure: training and validation RMS within 30%."""
    simulate_dataset(_screen(), tmp_path, num_poses=12, noise_px=0.3,
                     lens=default_lens(1920, 1080), seed=3, render_images=False)
    raw = json.loads((tmp_path / "session.json").read_text())
    raw["validation"] = {"holdout_ratio": 0.25}
    session = SessionConfig.model_validate(raw)
    result = run_quick(session, tmp_path, tmp_path / "out", raw_session=raw, prefer_cpp=False)

    q = result["result"]["quality"]
    assert q["validation_rms_px"] is not None
    assert q["validation_observations"] > 0
    train_rms = q["reprojection_rms_px"]
    val_rms = q["validation_rms_px"]
    assert abs(val_rms - train_rms) / train_rms < 0.30, (train_rms, val_rms)

    reproj = json.loads((tmp_path / "out" / "qa" / "reprojection.json").read_text())
    assert isinstance(reproj["validation"], dict)
    assert reproj["validation"]["validation_rms_px"] == val_rms
    # Holdout frames must not have entered the solve.
    hold = set(reproj["validation"]["holdout_frames"])
    assert q["num_poses"] == 12 - len(hold)


def test_validation_rms_sensitive_to_bad_tracking(tmp_path):
    """Corrupting the held-out frames' tracking inflates the validation RMS
    far above the training RMS — the metric actually measures independence."""
    simulate_dataset(_screen(), tmp_path, num_poses=10, noise_px=0.1,
                     lens=default_lens(1920, 1080), seed=4, render_images=False)
    raw = json.loads((tmp_path / "session.json").read_text())
    hold = [1, 4, 7]
    raw["validation"] = {"holdout_frames": hold}

    tracking_path = tmp_path / "tracking" / "poses.jsonl"
    lines = [json.loads(ln) for ln in tracking_path.read_text().splitlines() if ln.strip()]
    for rec in lines:
        if rec["frame_id"] in hold:
            rec["position"] = [p + 30.0 for p in rec["position"]]
    tracking_path.write_text("\n".join(json.dumps(r) for r in lines) + "\n")

    session = SessionConfig.model_validate(raw)
    result = run_quick(session, tmp_path, tmp_path / "out", raw_session=raw, prefer_cpp=False)
    q = result["result"]["quality"]
    assert q["validation_rms_px"] > 3.0 * q["reprojection_rms_px"], (
        q["reprojection_rms_px"], q["validation_rms_px"],
    )


def test_no_holdout_reports_none(tmp_path):
    """Without a validation config the legacy behaviour is untouched and the
    report explicitly states validation: none."""
    simulate_dataset(_screen(), tmp_path, num_poses=8, noise_px=0.0,
                     lens=default_lens(1920, 1080), seed=0, render_images=False)
    raw = json.loads((tmp_path / "session.json").read_text())
    session = SessionConfig.model_validate(raw)
    result = run_quick(session, tmp_path, tmp_path / "out", raw_session=raw, prefer_cpp=False)
    assert result["result"]["quality"]["validation_rms_px"] is None
    reproj = json.loads((tmp_path / "out" / "qa" / "reprojection.json").read_text())
    assert reproj["validation"] == "none"


def test_confidence_prefers_validation_rms():
    """The confidence grade follows the held-out RMS when available."""
    assert _confidence(10, 100, rms=0.3) == "high"
    assert _confidence(10, 100, rms=0.3, validation_rms=2.0) == "low"
    assert _confidence(10, 100, rms=2.0, validation_rms=0.3) == "high"


def test_qle_validation_gate_reverts_overfit():
    """Lens-overfit scenario (few poses, strong noise, freed k1/k2): the
    in-sample improvement gate passes, the validation-based gate reverts —
    freed lens params absorbing noise/error is exactly what the holdout
    exposes (architecture discipline #3)."""
    intr = CameraIntrinsics(fx=1244.4, fy=1244.4, cx=640.0, cy=360.0)
    screen = _screen(1200, 900)
    rng = np.random.default_rng(2)
    gt = random_ground_truth(rng)
    poses = generate_camera_poses(screen, 6, rng)
    obs, _tp, _vis = forward_observations(
        screen, intr, gt, poses, markers_per_cabinet=4, noise_px=1.2, rng=rng
    )
    fids = sorted({o.frame_id for o in obs})
    hold_ids = set(fids[4:])
    train = [o for o in obs if o.frame_id not in hold_ids]
    hold = [o for o in obs if o.frame_id in hold_ids]

    raw = {
        "images": {"path": "x"}, "tracking": {"path": "x"}, "screen": {"path": "x"},
        "lens": default_lens(1280, 720).model_dump(mode="json", exclude={"fx", "fy", "cx", "cy"}),
        "solver": {"lens_estimate": {
            "enabled": True, "params": ["k1", "k2"],
            "min_poses": 3, "min_observations": 20, "min_edge_obs_fraction": 0.0,
            "max_spatial_rms_px_for_center": 50.0, "max_spatial_rms_px_for_k": 50.0,
            "condition_number_limit": 1e9, "correlation_limit": 0.999,
            "min_improvement_pct": 1.0,
            "cross_subset_k_abs_delta": 99.0, "cross_subset_k_rel_delta": 99.0,
        }},
    }
    session = SessionConfig.model_validate(raw)
    ident = (np.array([1.0, 0, 0, 0]), np.zeros(3))
    pm = {o.frame_id: (np.asarray(o.track_q), np.asarray(o.track_t)) for o in obs}

    est_in = _estimate_lens(session, train, intr, pm, ident, False, holdout_obs=None)
    post_in = est_in["post"]
    assert post_in["improvement_basis"] == "in_sample"
    assert post_in["params_kept"], "in-sample gate should (wrongly) keep the overfit params"

    est_val = _estimate_lens(session, train, intr, pm, ident, False, holdout_obs=hold)
    post_val = est_val["post"]
    assert post_val["improvement_basis"] == "validation"
    assert set(post_val["params_reverted"]) == {"k1", "k2"}
    assert not post_val["params_kept"]
