"""Entrance pupil offset modeling — architecture v2.2 §4.3 acceptance (W8).

Acceptance (architecture 4.3 original text): simulate injects a 30mm entrance
pupil offset; once modeled, validation RMS recovers to the zero-offset
baseline.  Runs on the scipy backend (deterministic, no C++ build dependency);
``tests/integration/test_backend_consistency.py`` covers Ceres/scipy residual
parity for the offset separately.
"""

from __future__ import annotations

import numpy as np

from vpcal.core.projection import CameraIntrinsics
from vpcal.core.simulator import (
    default_lens,
    forward_observations,
    generate_camera_poses,
    random_ground_truth,
)
from vpcal.core.solver import solve_calibration
from vpcal.models.screen import PlaneSection, ScreenDefinition
from vpcal.qa.reprojection import reprojection_report

OFFSET_MM = 30.0


def _screen() -> ScreenDefinition:
    return ScreenDefinition(
        name="w", unit="mm", cabinet_size=(500, 500), led_pixel_pitch_mm=2.8,
        markers_per_cabinet=4,
        sections=[PlaneSection(name="w", width_mm=4000, height_mm=3000, origin=[0, 0, 0])],
    )


def _solved_rms(
    intr_solve: CameraIntrinsics, intr_project: CameraIntrinsics, *, seed: int = 11, num_poses: int = 10
) -> float:
    """Simulate with ``intr_project`` (bakes pixels), solve fixed-lens with ``intr_solve``."""
    screen = _screen()
    rng = np.random.default_rng(seed)
    gt = random_ground_truth(rng)
    poses = generate_camera_poses(screen, num_poses, rng)
    obs, _tp, _vis = forward_observations(
        screen, intr_solve, gt, poses, markers_per_cabinet=4,
        ground_truth_intr=intr_project,
    )
    # prefer_cpp=False: deterministic scipy backend, independent of whether the
    # C++ module is built in this environment (see test_backend_consistency.py
    # for the Ceres/scipy residual-parity check of the offset term itself).
    result = solve_calibration(obs, intr_solve, prefer_cpp=False)
    t2s = (np.asarray(result.tracker_to_stage_q), np.asarray(result.tracker_to_stage_t))
    c2t = (np.asarray(result.camera_from_tracker_q), np.asarray(result.camera_from_tracker_t))
    return reprojection_report(obs, intr_solve, t2s, c2t)["global_rms_px"]


def test_zero_offset_baseline_closes_to_subpixel():
    """Sanity: with no injected offset, simulate→solve closes to << 1 px (spec §8)."""
    intr0 = CameraIntrinsics.from_lens(default_lens())
    assert _solved_rms(intr0, intr0) < 0.01


def test_unmodeled_entrance_pupil_offset_degrades_rms():
    """A 30mm offset baked into pixels but absent from the solve's lens is a
    genuine (non-degenerate) error source when tracker_to_camera is fixed
    (the default, non-refine_C path): it must NOT silently disappear."""
    lens0 = default_lens()
    intr0 = CameraIntrinsics.from_lens(lens0)
    lens30 = lens0.model_copy(update={"entrance_pupil_offset_mm": OFFSET_MM})
    intr30 = CameraIntrinsics.from_lens(lens30)
    assert _solved_rms(intr0, intr30) > 0.5


def test_modeled_entrance_pupil_offset_recovers_baseline_rms():
    """Architecture 4.3 acceptance: modeling the injected 30mm offset in the
    solve's lens recovers validation RMS to the zero-offset baseline."""
    lens0 = default_lens()
    intr0 = CameraIntrinsics.from_lens(lens0)
    lens30 = lens0.model_copy(update={"entrance_pupil_offset_mm": OFFSET_MM})
    intr30 = CameraIntrinsics.from_lens(lens30)

    baseline_rms = _solved_rms(intr0, intr0)
    modeled_rms = _solved_rms(intr30, intr30)

    assert modeled_rms < 0.01
    assert abs(modeled_rms - baseline_rms) < 0.01
