"""Unit tests for fixed single-observation joint solver (§9.1)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from vpcal.core.errors import (
    ScreenGeometryInconsistent,
    SingleViewUnobservable,
)
from vpcal.core.fixed_observation import (
    CameraStateFingerprint,
    KnownLens,
    fingerprint_stale,
    resolve_mode,
    solve_fixed_observation,
    write_fixed_observation_result,
)
from vpcal.core.fixed_observation_synth import (
    corrupt_relative_pose,
    make_planar_scene,
    make_two_plane_scene,
    run_synthetic_sweep,
    scene_to_input,
)


def test_resolve_mode_auto():
    assert resolve_mode("auto", has_qualified_master_lens=True) == "known-lens"
    assert resolve_mode("auto", has_qualified_master_lens=False) == "joint-session-lens"
    assert resolve_mode("joint-session-lens", has_qualified_master_lens=True) == "joint-session-lens"


def test_fingerprint_stale_ignores_attest():
    fp = CameraStateFingerprint(
        camera_id="cam1",
        resolution=(1920, 1080),
        transfer_path="decklink",
        focus_zoom_attested=True,
    )
    stored = fp.to_dict()
    assert not fingerprint_stale(stored, fp)
    other = CameraStateFingerprint(
        camera_id="cam1",
        resolution=(1920, 1080),
        transfer_path="decklink",
        focus_zoom_attested=False,  # attest change must NOT stale
    )
    assert other.machine_readable_hash() == fp.machine_readable_hash()
    assert not fingerprint_stale(stored, other)
    changed = CameraStateFingerprint(
        camera_id="cam1",
        resolution=(3840, 2160),
        transfer_path="decklink",
    )
    assert fingerprint_stale(stored, changed)


def test_two_plane_joint_recovers_focal():
    scene = make_two_plane_scene(nu=9, nv=7, noise_px=0.1, seed=0)
    assert len(scene.correspondences) >= 60
    result = solve_fixed_observation(scene_to_input(scene, weak_focal=1200.0))
    assert result.mode_resolved == "joint-session-lens"
    assert result.session_lens is not None
    assert result.session_lens.is_master is False
    assert result.session_lens.session_coupled is True
    assert abs(result.session_lens.fx - scene.gt_f) / scene.gt_f < 0.02
    assert result.rms_reprojection_px < 1.5
    assert result.qualification["passed"]


def test_planar_single_screen_unobservable():
    scene = make_planar_scene()
    with pytest.raises(SingleViewUnobservable):
        solve_fixed_observation(scene_to_input(scene))


def test_wrong_relative_pose_fails_geometry():
    scene = corrupt_relative_pose(make_two_plane_scene(nu=9, nv=7))
    with pytest.raises((ScreenGeometryInconsistent, SingleViewUnobservable)):
        solve_fixed_observation(scene_to_input(scene))


def test_wrong_focal_prior_still_converges():
    scene = make_two_plane_scene(nu=9, nv=7, seed=4)
    result = solve_fixed_observation(scene_to_input(scene, weak_focal=700.0))
    assert abs(result.session_lens.fx - scene.gt_f) / scene.gt_f < 0.03  # type: ignore[union-attr]


def test_planar_prior_cannot_qualify():
    scene = make_planar_scene()
    with pytest.raises(SingleViewUnobservable):
        solve_fixed_observation(scene_to_input(scene, weak_focal=scene.gt_f))


def test_known_lens_path():
    scene = make_two_plane_scene(nu=8, nv=6, seed=2)
    lens = KnownLens(
        fx=scene.gt_f,
        fy=scene.gt_f,
        cx=scene.gt_cx,
        cy=scene.gt_cy,
        dist_coeffs=[scene.gt_k1, scene.gt_k2, 0, 0, 0],
        image_size=scene.image_size,
        is_master=True,
    )
    result = solve_fixed_observation(
        scene_to_input(scene, mode="known-lens", known_lens=lens)
    )
    assert result.solve_kind == "fixed_extrinsics_only"
    assert result.model_level == "M0_pose_only"
    assert result.session_lens is not None
    assert result.session_lens.is_master is True
    assert result.rms_reprojection_px < 1.0


def test_known_lens_fails_sparse_detection_gates():
    """known-lens must fail closed like stage-pose (≥12/screen, ≥8 inliers/screen, ≥40 total)."""
    from vpcal.core.errors import DetectionQualityFailed, LocalizationQualityFailed
    from vpcal.core.fixed_observation import FixedObservationInput

    scene = make_two_plane_scene(nu=8, nv=6, seed=2)
    lens = KnownLens(
        fx=scene.gt_f,
        fy=scene.gt_f,
        cx=scene.gt_cx,
        cy=scene.gt_cy,
        dist_coeffs=[scene.gt_k1, scene.gt_k2, 0, 0, 0],
        image_size=scene.image_size,
        is_master=True,
    )
    # Keep only a few points — below trustworthy-per-screen gate.
    sparse = scene.correspondences[:6]
    assert len({c.screen_label for c in sparse}) >= 1
    with pytest.raises((DetectionQualityFailed, LocalizationQualityFailed)):
        solve_fixed_observation(
            FixedObservationInput(
                correspondences=sparse,
                image_size=scene.image_size,
                screen_normals=scene.screen_normals,
                mode_requested="known-lens",
                known_lens=lens,
                formal=True,
            )
        )


def test_correlation_lock_focal_depth_allows_m1_with_finite_std():
    from vpcal.core.fixed_observation import ModelLevel, _correlation_lock

    assert (
        _correlation_lock(
            {"correlation": {"f|tz": 0.95}, "param_std": {"f": 3.0}},
            ModelLevel.M1_FOCAL_POSE,
        )
        == ModelLevel.M1_FOCAL_POSE
    )


def test_correlation_lock_focal_depth_fails_m1_without_std():
    from vpcal.core.fixed_observation import ModelLevel, _correlation_lock

    with pytest.raises(SingleViewUnobservable):
        _correlation_lock(
            {"correlation": {"f|tz": 0.95}, "param_std": {}},
            ModelLevel.M1_FOCAL_POSE,
        )


def test_correlation_lock_focal_depth_signals_lock_f_at_m2():
    from vpcal.core.fixed_observation import ModelLevel, _correlation_lock

    assert (
        _correlation_lock(
            {"correlation": {"f|tx": -0.91}, "param_std": {"f": 2.0}},
            ModelLevel.M2_RADIAL_POSE,
        )
        is None
    )


def test_correlation_lock_pp_translation_locks_m3_to_m2():
    from vpcal.core.fixed_observation import ModelLevel, _correlation_lock

    assert (
        _correlation_lock(
            {"correlation": {"cx|tx": 0.88}},
            ModelLevel.M3_CENTER_RADIAL_POSE,
        )
        == ModelLevel.M2_RADIAL_POSE
    )


def test_write_artifact(tmp_path: Path):
    scene = make_two_plane_scene(nu=9, nv=7, seed=6)
    result = solve_fixed_observation(scene_to_input(scene))
    out = tmp_path / "fixed_observation_result.json"
    write_fixed_observation_result(result, str(out))
    payload = json.loads(out.read_text())
    assert payload["schema_version"] == "fixed_observation_result.v1"
    assert payload["session_lens"]["session_coupled"] is True
    assert payload["session_lens"]["is_master"] is False


def test_synthetic_sweep_report():
    report = run_synthetic_sweep()
    assert report["thresholds_ok"], report
