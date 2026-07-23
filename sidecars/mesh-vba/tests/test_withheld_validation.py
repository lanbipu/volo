"""Camera-view holdout validation producer (`_run_withheld_validation`).

Validates the mechanism both ways on synthetic two-screen scenes: consistent
geometry passes, inconsistent observations fail, and too few bridge views fails
closed. The formal export gate reads the emitted `.validation.json` pointer
`/withheld_validation/passed` (src-tauri/src/commands/mesh_export.rs)."""
import dataclasses
import json

import cv2
import numpy as np

import lmt_vba_sidecar.reconstruct as reconstruct
from lmt_vba_sidecar.model_constrained_ba import Observation, model_constrained_ba
from lmt_vba_sidecar.reconstruct import _run_withheld_validation

K = np.array([[2000.0, 0, 960], [0, 2000, 540], [0, 0, 1]])


def _grid(nx=5, ny=4, hw=300.0, hh=170.0):
    pts = []
    for iy in range(ny):
        for ix in range(nx):
            pts.append([-hw + 2 * hw * ix / (nx - 1), -hh + 2 * hh * iy / (ny - 1), 0.0])
    return np.array(pts, float)


def _project(Rc, tc, Rb, tb, p):
    q = K @ (Rc @ (Rb @ p + tb) + tc)  # same convention as _per_cabinet_reproj_rms
    return q[:2] / q[2]


def _two_screen_scene(*, n_bridge=5, n_single0=2, n_single1=2, noise=0.0, noisy_cams=None, seed=0):
    """Two flat screens (1 cabinet each) folded 15°, cab0 = gauge.

    ``noisy_cams`` (None = all) restricts pixel noise to those camera indices, so
    a test can corrupt only the held-out view."""
    rng = np.random.default_rng(seed)
    pts = _grid()
    boards = {
        0: (np.eye(3), np.zeros(3)),
        1: (cv2.Rodrigues(np.array([0.0, np.deg2rad(15), 0.0]))[0], np.array([700.0, 0.0, 0.0])),
    }
    plan = [(0, 1)] * n_bridge + [(0,)] * n_single0 + [(1,)] * n_single1
    cams = []
    for i in range(len(plan)):
        Rc = cv2.Rodrigues(np.array([0.04 * (i - 3), 0.06 * (i - 3), 0.0]))[0]
        tc = np.array([350.0 + 40.0 * (i - 4), -20.0 * (i - 4), 2500.0])
        cams.append((Rc, tc))
    obs, pvcc = [], {}
    for ci, (Rc, tc) in enumerate(cams):
        cam_noise = noise if (noisy_cams is None or ci in noisy_cams) else 0.0
        for cab in plan[ci]:
            Rb, tb = boards[cab]
            corners = []
            for p in pts:
                px = _project(Rc, tc, Rb, tb, p)
                if cam_noise:
                    px = px + rng.normal(0, cam_noise, 2)
                obs.append(Observation(camera_idx=ci, cabinet_idx=cab, p_local=p.copy(), pixel=px.copy()))
                corners.append((p.copy(), px.copy()))
            pvcc[(ci, cab)] = corners
    result = model_constrained_ba(
        K=K, observations=obs, n_cameras=len(cams), n_cabinets=2, root_cabinet_idx=0,
        init_cameras=list(cams), init_cabinets={1: (np.eye(3), boards[1][1].copy())},
        loss="linear", compute_covariance=False)
    return obs, pvcc, {0: 0, 1: 1}, result


def _run(tmp_path, obs, _pvcc, cab_idx_to_screen, result, screen_root_indices=None):
    # pvcc is now derived internally from the (reindexed, pruned) observations, so
    # the harness no longer supplies it — the third arg is kept for call-site parity.
    # Two flat screens, one cabinet each, so each screen's root cabinet == its index.
    if screen_root_indices is None:
        screen_root_indices = {0: 0, 1: 1}
    st = str(tmp_path / "st.json")
    wv = _run_withheld_validation(
        K=K, result=result, observations=obs,
        n_cabinets=2, root_idx=0, cab_idx_to_screen=cab_idx_to_screen,
        screen_ids=["S0", "S1"], screen_root_indices=screen_root_indices,
        screen_transforms_path=st)
    with open(st + ".validation.json") as fh:
        on_disk = json.load(fh)["withheld_validation"]
    assert on_disk == wv  # the returned dict IS the persisted product
    return wv


def test_clean_two_screen_geometry_passes(tmp_path):
    obs, pvcc, m, result = _two_screen_scene(noise=0.0)
    wv = _run(tmp_path, obs, pvcc, m, result)
    assert wv["passed"] is True, wv
    assert wv["combined_rms_px"] < 2.0
    # A bridge view must be held out, else the split cannot test cross-screen geometry.
    assert wv["withheld_bridge_views"], wv


def test_inconsistent_observations_fail(tmp_path):
    # Noise only the held-out bridge view (last bridge, index n_bridge-1 = 4): the
    # train re-solve stays on clean data and converges, but the withheld view
    # reprojects far past the gate, so it fails via the RMS path (not fail-closed).
    obs, pvcc, m, result = _two_screen_scene(noise=6.0, noisy_cams={4}, seed=1)
    wv = _run(tmp_path, obs, pvcc, m, result)
    assert wv["passed"] is False, wv
    assert wv["combined_rms_px"] > 2.0


def test_too_few_bridges_fails_closed(tmp_path):
    obs, pvcc, m, result = _two_screen_scene(n_bridge=2, n_single0=3, n_single1=3)
    wv = _run(tmp_path, obs, pvcc, m, result)
    assert wv["passed"] is False
    assert wv["reason"] == "insufficient_bridge_views_for_holdout"


def _patch_train_ba(monkeypatch, *, converged, rms=None):
    """Wrap reconstruct.model_constrained_ba: call the real solver, then force the
    returned BAResult to the budget-exhausted shape (converged flag, iterations
    pinned to the passed max_nfev, optional rms override). Patched AFTER the scene
    is built, so only the _run_withheld_validation train re-solve is affected."""
    real = reconstruct.model_constrained_ba

    def wrapper(*args, **kwargs):
        res = real(*args, **kwargs)
        max_nfev = kwargs["max_nfev"]
        return dataclasses.replace(
            res, converged=converged, iterations=max_nfev,
            rms_reprojection_px=(res.rms_reprojection_px if rms is None else rms))

    monkeypatch.setattr(reconstruct, "model_constrained_ba", wrapper)


def test_budget_exhausted_good_rms_accepted(tmp_path, monkeypatch):
    # Clean scene -> real train re-solve rms ~0px; force scipy success=False with
    # iterations at the budget. The budget-accept path must still pass it.
    obs, pvcc, m, result = _two_screen_scene(noise=0.0)
    _patch_train_ba(monkeypatch, converged=False)
    wv = _run(tmp_path, obs, pvcc, m, result)
    assert wv["passed"] is True, wv


def test_budget_exhausted_bad_rms_still_fails(tmp_path, monkeypatch):
    # Budget exhausted AND rms above the accept threshold -> not a no-op放行.
    obs, pvcc, m, result = _two_screen_scene(noise=0.0)
    _patch_train_ba(monkeypatch, converged=False, rms=1.5)
    wv = _run(tmp_path, obs, pvcc, m, result)
    assert wv["passed"] is False, wv
    assert wv["reason"] == "train_resolve_did_not_converge"
    assert "train_rms_px" in wv


# --- D3: screen-to-screen relative-pose consistency ---------------------------

def _patch_train_shift(monkeypatch, shift_mm):
    """Wrap model_constrained_ba so the TRAIN re-solve returns cabinet 1 (screen 1)
    shifted by +shift_mm in x. Patched AFTER the full solve, so only the train
    geometry moves relative to the full solve -> a detectable inter-screen drift."""
    real = reconstruct.model_constrained_ba

    def wrapper(*args, **kwargs):
        res = real(*args, **kwargs)
        cp = dict(res.cabinet_poses)
        if 1 in cp:
            R, t = cp[1]
            cp[1] = (R, np.asarray(t, float) + np.array([shift_mm, 0.0, 0.0]))
        return dataclasses.replace(res, cabinet_poses=cp)

    monkeypatch.setattr(reconstruct, "model_constrained_ba", wrapper)


def test_clean_scene_screen_consistency_near_zero(tmp_path):
    # Noise floor: on a clean two-screen scene the full vs TRAIN relative pose must
    # agree to well under the mm/deg limits (this is the sensitivity baseline).
    obs, pvcc, m, result = _two_screen_scene(noise=0.0)
    wv = _run(tmp_path, obs, pvcc, m, result)
    s2s = wv["screen_to_screen_consistency"]
    assert s2s["passed"] is True, s2s
    assert len(s2s["pairs"]) == 1
    pair = s2s["pairs"][0]
    assert pair["screen_id"] == "S1" and pair["ref_screen_id"] == "S0"
    assert pair["delta_t_norm_mm"] < 0.5, pair
    assert pair["delta_rot_deg"] < 0.1, pair


def test_screen_consistency_detects_inter_screen_shift(tmp_path, monkeypatch):
    # A +3mm TRAIN-vs-full drift of screen 1 must be flagged (pair fail -> top fail).
    obs, pvcc, m, result = _two_screen_scene(noise=0.0)
    _patch_train_shift(monkeypatch, shift_mm=3.0)
    wv = _run(tmp_path, obs, pvcc, m, result)
    s2s = wv["screen_to_screen_consistency"]
    assert s2s["passed"] is False, s2s
    assert s2s["pairs"][0]["passed"] is False
    assert s2s["pairs"][0]["delta_t_norm_mm"] > 1.0
    assert wv["passed"] is False


def test_consistency_gate_anded_with_withheld(tmp_path, monkeypatch):
    # AND semantics: a small (1.5mm) inter-screen drift trips consistency while the
    # withheld reprojection RMS itself may still pass — top-level passed must be False.
    obs, pvcc, m, result = _two_screen_scene(noise=0.0)
    _patch_train_shift(monkeypatch, shift_mm=1.5)
    wv = _run(tmp_path, obs, pvcc, m, result)
    assert wv["screen_to_screen_consistency"]["passed"] is False
    assert wv["passed"] is False
