"""FIX-10a: cold-init eval mode — the eval pipeline exercises the PRODUCTION
init path (transitive bridging + nominal fallback + joint-PnP cameras +
Stage-B) on realistic scenes (true arc walls, along-wall stations, FOV
clipping), instead of leaking truth into the initialisation.

The positive/negative pair is the FIX-3 acceptance contract: the same scene
that converges through the production init must blow up under the pre-FIX-3
init (direct-only bridging is gone; its observable behaviour — identity
rotations + unrotated nominal deltas for everything beyond the root's own
views — is reproduced by monkeypatch)."""
from __future__ import annotations

import numpy as np
import pytest

from lmt_vba_sidecar.ipc import CabinetArray, SimulateInput
from lmt_vba_sidecar.simulate import build_scene
from lmt_vba_sidecar.eval_runner import run_method


def _arc_scene_input(seed=5, sigma=0.1):
    """8x2 cabinets on a ~89deg arc; 7 along-wall stations at ~1.5m standoff;
    FOV clipping on -> each station sees only a few columns; most stations
    never see the corner cabinet (the segmented-capture regime). visibility
    0.4 thins the 64-corner boards to keep BA runtime test-friendly."""
    return SimulateInput.model_validate({
        "command": "simulate", "version": 1,
        "scene": {"cabinet_array": {"cols": 8, "rows": 2, "cabinet_size_mm": [500, 500]},
                  "shape_prior": {"curved": {"radius_mm": 2570.0}},
                  "inter_board_angle_deg": 0.0},
        "cameras": {"n_views": 7, "distance_mm_range": [1400, 1600],
                    "yaw_deg_range": [-3, 3], "pitch_deg_range": [-3, 3],
                    "trajectory": "along_wall"},
        "intrinsics": {"K": [[3000, 0, 2000], [0, 3000, 1500], [0, 0, 1]],
                       "dist_coeffs": [0, 0, 0, 0, 0], "image_size": [4000, 3000]},
        "noise": {"pixel_sigma": sigma, "visibility_frac": 0.4},
        "seed": seed})


def _design():
    return (CabinetArray(cols=8, rows=2, cabinet_size_mm=[500.0, 500.0]),
            {"curved": {"radius_mm": 2570.0}})


def test_cold_init_converges_on_segmented_arc():
    """Positive control: production init handles the segmented ~90deg arc;
    per-corner holdout stays sub-mm at 0.1px noise."""
    scene = build_scene(_arc_scene_input())
    m = run_method(scene, "charuco", init="cold", design=_design())
    assert m["holdout_rms_mm"] < 1.0, m
    assert m["holdout_max_mm"] < 3.0, m


def test_cold_init_scene_discriminates_pre_fix3_init(monkeypatch):
    """Negative control: with the pre-FIX-3 observable init behaviour (no
    transitive bridging; identity rotation + UNROTATED nominal translation for
    every non-gauge cabinet), the same scene must fail loudly — BA diverges or
    the per-corner holdout explodes. This pins that the 10a scene is hard
    enough to catch the FIX-3 bug class (an orbit-all-see-everything scene
    would pass either way)."""
    import lmt_vba_sidecar.eval_runner as er
    import lmt_vba_sidecar.reconstruct as rec
    monkeypatch.setattr(rec, "estimate_nonroot_cabinet_init",
                        lambda *a, **k: ({}, set()))
    # Cap the doomed solve: if a ~90deg-wrong init can't converge in 1500
    # evals it never will, and a mirror local minimum shows up in the holdout
    # either way. Keeps the negative control test-time friendly.
    orig_stage_b = rec.stage_b_robust_solve
    monkeypatch.setattr(rec, "stage_b_robust_solve",
                        lambda **kw: orig_stage_b(**{**kw, "max_nfev": 1500}))
    monkeypatch.setattr(rec, "_nominal_init_root_frame",
                        lambda poses, root_cr, cr: (
                            np.eye(3),
                            (np.asarray(poses[cr][1]) - np.asarray(poses[root_cr][1])) * 1000.0))
    scene = build_scene(_arc_scene_input())
    try:
        m = run_method(scene, "charuco", init="cold", design=_design())
    except ValueError:
        return  # BA did not converge — loud failure, acceptable refusal
    assert m["holdout_rms_mm"] > 20.0, (
        f"pre-FIX-3 init produced holdout_rms={m['holdout_rms_mm']:.2f}mm — "
        f"the scene no longer discriminates the FIX-3 bug class")


def test_cold_init_requires_design():
    scene = build_scene(_arc_scene_input())
    with pytest.raises(ValueError, match="design"):
        run_method(scene, "charuco", init="cold", design=None)


def test_cold_init_free_point_rejected():
    scene = build_scene(_arc_scene_input())
    with pytest.raises(ValueError, match="cold"):
        run_method(scene, "free_point", init="cold", design=_design())


def test_single_cabinet_dataset_still_evaluates_with_null_holdout():
    """Codex review P2: a 1-cabinet dataset was always evaluable (size error +
    camera sanity); the corner holdout is UNDEFINED there (no disjoint split)
    and must come back as None — not a fake 0.0, not a ValueError."""
    inp = SimulateInput.model_validate({
        "command": "simulate", "version": 1,
        "scene": {"cabinet_array": {"cols": 1, "rows": 1, "cabinet_size_mm": [600, 340]},
                  "shape_prior": "flat", "inter_board_angle_deg": 0.0},
        "cameras": {"n_views": 6, "distance_mm_range": [1200, 2000],
                    "yaw_deg_range": [-30, 30], "pitch_deg_range": [-15, 15]},
        "intrinsics": {"K": [[2000, 0, 960], [0, 2000, 540], [0, 0, 1]],
                       "dist_coeffs": [0, 0, 0, 0, 0], "image_size": [1920, 1080]},
        "noise": {"pixel_sigma": 0.2},
        "seed": 4})
    scene = build_scene(inp)
    m = run_method(scene, "charuco")
    assert m["holdout_rms_mm"] is None
    assert m["holdout_p95_mm"] is None
    assert m["holdout_max_mm"] is None
    # The legacy metrics are still produced (size error is per-cabinet).
    assert np.isfinite(m["max_size_error_mm"])
