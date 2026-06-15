"""Error-budget simulator extensions + sensitivity sweep (remediation B1 / B3).

Covers the new SimulatorConfig error sources (tracker noise, temporal offset on
a trajectory, screen-space dot bake) and the sweep harness that tabulates how
each source perturbs the solved ``T_S_from_O``.
"""

from __future__ import annotations

import json

import numpy as np
import pytest

from vpcal.core.pipeline import run_quick
from vpcal.core.simulator import (
    SimulatorConfig,
    default_lens,
    generate_trajectory_poses,
    render_frame,
    simulate_dataset,
    simulate_from_config,
    GroundTruth,
)
from vpcal.core.projection import CameraIntrinsics
from vpcal.models.screen import PlaneSection, ScreenDefinition
from vpcal.models.session import SessionConfig


def _screen():
    return ScreenDefinition(
        name="budget_plane", unit="mm", cabinet_size=(500, 500), led_pixel_pitch_mm=2.8,
        markers_per_cabinet=4,
        sections=[PlaneSection(name="w", width_mm=2400, height_mm=1600, origin=[0, 0, 0])],
    )


def _solve_error(tmp_path, **sim_kwargs):
    """Simulate (exact path) → solve → return T_S_from_O translation error (mm)."""
    simulate_dataset(_screen(), tmp_path, lens=default_lens(1920, 1080),
                     render_images=False, **sim_kwargs)
    raw = json.loads((tmp_path / "session.json").read_text())
    session = SessionConfig.model_validate(raw)
    result = run_quick(session, tmp_path, tmp_path / "out", raw_session=raw, prefer_cpp=True)
    gt = json.loads((tmp_path / "ground_truth.json").read_text())["tracker_to_stage"]
    est = result["result"]["tracker_to_stage"]
    return float(np.linalg.norm(np.array(gt["translation"]) - np.array(est["translation"])))


# ── ① tracker noise ──────────────────────────────────────────────────


class TestTrackerNoise:

    def test_noise_inflates_solution_error(self, tmp_path):
        clean = _solve_error(tmp_path / "a", num_poses=12, seed=1, tracker_noise_mm=0.0)
        noisy = _solve_error(tmp_path / "b", num_poses=12, seed=1, tracker_noise_mm=10.0)
        assert clean < 0.01          # exact pixels + clean tracker → near-perfect
        assert noisy > 1.0           # 10 mm tracker noise propagates to mm-level error
        assert noisy > 10 * clean

    def test_noise_corrupts_only_tracker_not_pixels(self, tmp_path):
        # Pixels stay exact: with refine on, the solver could still drive RMS low,
        # but here we just assert the reported tracker stream actually changed.
        simulate_dataset(_screen(), tmp_path / "n", lens=default_lens(), render_images=False,
                         num_poses=6, seed=2, tracker_noise_mm=20.0)
        simulate_dataset(_screen(), tmp_path / "c", lens=default_lens(), render_images=False,
                         num_poses=6, seed=2, tracker_noise_mm=0.0)
        pn = (tmp_path / "n" / "tracking" / "poses.jsonl").read_text()
        pc = (tmp_path / "c" / "tracking" / "poses.jsonl").read_text()
        assert pn != pc


# ── ② temporal offset (moving vs static) ─────────────────────────────


class TestTemporalOffset:

    def test_moving_capture_timing_sensitive(self, tmp_path):
        synced = _solve_error(tmp_path / "s", num_poses=16, seed=3, trajectory=True,
                              temporal_offset_frames=0.0)
        offset = _solve_error(tmp_path / "o", num_poses=16, seed=3, trajectory=True,
                              temporal_offset_frames=4.0)
        assert offset > synced
        assert offset > 1.0          # a 4-frame lag on a moving sweep is clearly visible

    def test_static_capture_timing_immune(self, tmp_path):
        # trajectory=False ⇒ offset is ignored (warned) ⇒ identical to synced.
        with pytest.warns(UserWarning, match="temporal_offset_frames ignored"):
            simulate_dataset(_screen(), tmp_path / "x", lens=default_lens(), render_images=False,
                             num_poses=10, seed=4, temporal_offset_frames=4.0)
        off = (tmp_path / "x" / "tracking" / "poses.jsonl").read_text()
        simulate_dataset(_screen(), tmp_path / "y", lens=default_lens(), render_images=False,
                         num_poses=10, seed=4, temporal_offset_frames=0.0)
        synced = (tmp_path / "y" / "tracking" / "poses.jsonl").read_text()
        assert off == synced         # camera is stationary → timing has no effect


# ── trajectory smoothness ────────────────────────────────────────────


def test_trajectory_is_smooth_and_ordered():
    rng = np.random.default_rng(0)
    poses = generate_trajectory_poses(_screen(), 16, rng)
    eyes = np.array([p[:3, 3] for p in poses])
    steps = np.linalg.norm(np.diff(eyes, axis=0), axis=1)
    spread = np.linalg.norm(eyes.max(axis=0) - eyes.min(axis=0))
    # consecutive standpoints are a small fraction of the overall sweep extent
    assert steps.max() < 0.5 * spread


# ── ④ screen-space dot bake ──────────────────────────────────────────


def test_bake_dot_changes_rendered_image():
    screen = _screen()
    intr = CameraIntrinsics.from_lens(default_lens(1280, 720))
    gt = GroundTruth([1, 0, 0, 0], [0, 0, 0], [1, 0, 0, 0], [0, 0, 0])
    rng = np.random.default_rng(0)
    from vpcal.core.simulator import generate_camera_poses, forward_observations
    poses = generate_camera_poses(screen, 1, rng)
    _, tracker_poses, _ = forward_observations(screen, intr, gt, poses, markers_per_cabinet=4)
    tp = tracker_poses[0]
    baked = render_frame(screen, intr, gt, tp, markers_per_cabinet=4, bake_dot_screen_space=True)
    splat = render_frame(screen, intr, gt, tp, markers_per_cabinet=4, bake_dot_screen_space=False)
    assert baked.shape == splat.shape
    assert np.any(baked != splat)    # the dot rendering path differs


# ── sweep harness ────────────────────────────────────────────────────


class TestSweep:

    def test_pixel_noise_sweep_monotonic(self):
        from vpcal.core.sweep import run_sweep
        cells = run_sweep(_screen(), sources=["pixel_noise"], seeds=1, num_poses=10,
                          holdout_ratio=0.25, prefer_cpp=True)
        by_mag = {c.magnitude: c.trans_err_mm_mean for c in cells}
        assert by_mag[0.0] < 0.01
        # error rises monotonically with pixel noise
        mags = sorted(by_mag)
        errs = [by_mag[m] for m in mags]
        assert all(errs[i] <= errs[i + 1] + 1e-6 for i in range(len(errs) - 1))
        assert errs[-1] > errs[0]

    def test_failing_cell_isolated_not_aborting(self, monkeypatch):
        # A cell that raises must yield a NaN cell + warning, not abort the sweep.
        import vpcal.core.sweep as sweep_mod
        calls = {"n": 0}
        real = sweep_mod._run_cell

        def flaky(screen, cfg, *, prefer_cpp):
            calls["n"] += 1
            if cfg.noise_px == 0.5:  # fail exactly one magnitude
                raise RuntimeError("simulated solver precondition failure")
            return real(screen, cfg, prefer_cpp=prefer_cpp)

        monkeypatch.setattr(sweep_mod, "_run_cell", flaky)
        with pytest.warns(UserWarning, match="sweep cell failed"):
            cells = sweep_mod.run_sweep(_screen(), sources=["pixel_noise"], seeds=1,
                                        num_poses=10, holdout_ratio=0.25, prefer_cpp=True)
        by_mag = {c.magnitude: c for c in cells}
        assert np.isnan(by_mag[0.5].trans_err_mm_mean)   # failed cell → NaN
        assert by_mag[0.0].trans_err_mm_mean < 0.01      # others still computed

    def test_baseline_cell_shared_across_static_sources(self, monkeypatch):
        # The magnitude-0 baseline is identical for the static sources → computed once.
        import vpcal.core.sweep as sweep_mod
        real = sweep_mod._run_cell
        configs = []

        def counting(screen, cfg, *, prefer_cpp):
            configs.append(cfg.seed)
            return real(screen, cfg, prefer_cpp=prefer_cpp)

        monkeypatch.setattr(sweep_mod, "_run_cell", counting)
        sweep_mod.run_sweep(_screen(), sources=["pixel_noise", "tracker_trans"], seeds=1,
                            num_poses=10, holdout_ratio=0.25, prefer_cpp=True)
        # pixel_noise(5 mags) + tracker_trans(5 mags) = 10 cells, but the two 0.0
        # baselines are identical → 9 actual solves, not 10.
        assert len(configs) == 9

    def test_error_budget_md_renders(self):
        from vpcal.core.sweep import SweepCell, format_error_budget_md
        cells = [
            SweepCell("pixel_noise", 0.0, "px", 0.0, 0.0, 0.0, 0.0, 0.0, 1),
            SweepCell("pixel_noise", 2.0, "px", 1.0, 0.1, 0.03, 0.0, 2.6, 1),
            SweepCell("tracker_trans", 0.0, "mm", 0.0, 0.0, 0.0, 0.0, 0.0, 1),
            SweepCell("tracker_trans", 10.0, "mm", 5.0, 0.2, 0.1, 0.0, 0.3, 1),
        ]
        md = format_error_budget_md(cells, meta={"num_poses": 12, "seeds": 1,
                                                  "holdout_ratio": 0.25, "backend": "ceres",
                                                  "screen_name": "x"})
        assert "误差预算" in md
        assert "主导误差源排名" in md
        # Ranked on a common mm basis (error at each source's realistic magnitude),
        # not raw per-unit slope — both static sources appear in the ranking.
        assert "`tracker_trans`" in md and "`pixel_noise`" in md

    def test_static_ranking_cross_comparable_excludes_timing(self):
        """Ranking is on a common mm basis (error at realistic magnitude), and the
        moving-only timing source is excluded from the static main-path ranking."""
        from vpcal.core.sweep import SweepCell, rank_static_sources
        cells = [
            SweepCell("handeye_trans", 0.0, "mm", 0.0, 0, 0, 0, 0, 1),
            SweepCell("handeye_trans", 10.0, "mm", 9.8, 0, 0, 0, 0, 1),
            SweepCell("pixel_noise", 0.0, "px", 0.0, 0, 0, 0, 0, 1),
            SweepCell("pixel_noise", 1.0, "px", 0.4, 0, 0, 0, 0, 1),
            # Native slope of temporal_moving is huge (20 mm/frame) but it must NOT
            # win the static ranking — it is constructively zero on the static path.
            SweepCell("temporal_moving", 0.0, "frames", 0.0, 0, 0, 0, 0, 1),
            SweepCell("temporal_moving", 1.0, "frames", 20.0, 0, 0, 0, 0, 1),
        ]
        ranked = rank_static_sources(cells)
        sources = [s for s, _, _ in ranked]
        assert "temporal_moving" not in sources
        assert ranked[0][0] == "handeye_trans"  # dominates at its realistic 10mm magnitude
        # errors are comparable mm values, descending
        errs = [e for _, _, e in ranked]
        assert errs == sorted(errs, reverse=True)

    def test_b3_timing_decision_requires_timecal_for_moving(self):
        """B3: a moving-capture timing sweep yields the TimeCal-scoping conclusion."""
        from vpcal.core.sweep import SweepCell, format_error_budget_md
        # Moving capture: 1-frame lag → 20 mm (≫ 1 mm target) ⇒ TimeCal required.
        cells = [
            SweepCell("temporal_moving", 0.0, "frames", 0.0, 0.0, 0.0, 0.0, 0.0, 1),
            SweepCell("temporal_moving", 1.0, "frames", 20.0, 5.0, 2.4, 0.1, 10.0, 1),
            SweepCell("temporal_moving", 2.0, "frames", 44.0, 9.0, 4.7, 0.1, 20.0, 1),
        ]
        md = format_error_budget_md(cells, meta={"num_poses": 16, "seeds": 1,
                                                  "holdout_ratio": 0.25, "backend": "ceres",
                                                  "screen_name": "x"})
        assert "B3 时序敏感性" in md
        assert "静态" in md and "运动" in md           # both arms present
        assert "TimeCal" in md and "不能整体裁掉" in md  # the scoping decision
        assert "mm / ms" in md                          # frames→ms conversion
