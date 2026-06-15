import numpy as np

from lmt_vba_sidecar.ipc import CabinetArray
from lmt_vba_sidecar.capture_planner.geometry import expand_screen
from lmt_vba_sidecar.capture_planner.visibility import intrinsics_from_fov, look_at_camera
from lmt_vba_sidecar.capture_planner.scoring import score_screen


def _flat_grid():
    cab = CabinetArray(cols=2, rows=2, cabinet_size_mm=[500.0, 500.0], absent_cells=[])
    return expand_screen(cab, "flat", sample_grid=(4, 4))


def _ring(geom, K, n=4, span_deg=40.0, dist=4000.0):
    cx = geom.total_width_mm / 2.0
    cy = geom.total_height_mm / 2.0
    target = np.array([cx, cy, 0.0])
    cams = []
    for a in np.deg2rad(np.linspace(-span_deg / 2, span_deg / 2, n)):
        pos = target + np.array([dist * np.sin(a), 0.0, dist * np.cos(a)])
        cams.append(look_at_camera(K, pos, target, (1920, 1080)))
    return cams


def test_scorer_is_exact_under_zero_noise():
    # No detection noise, no as-built deviation -> estimated poses are exact and
    # triangulation must return the truth. Sub-micron residual proves the
    # Monte-Carlo geometry (observe -> PnP -> triangulate) is wired correctly.
    # (FIX-17 ② 的箱体级抖动也显式归零 —— 这是布线测试,不是噪声模型测试。)
    geom = _flat_grid()
    K = intrinsics_from_fov((1920, 1080), hfov_deg=60.0)
    cams = _ring(geom, K, n=4, span_deg=40.0)
    report = score_screen(geom, cams, pixel_sigma=0.0, nominal_deviation_mm=0.0,
                          cabinet_jitter_mm=0.0, cabinet_jitter_deg=0.0,
                          trials=3, seed=0)
    for cov in report.values():
        assert cov["reconstructable"] is True
        assert cov["p95_mm"] < 1e-3   # ~0 mm


def test_cabinet_correlated_jitter_raises_p95_vs_iid_only():
    # FIX-17 ② 回归锚:箱体级相关刚体抖动不会被多点平均掉,同一相机阵列下
    # p95 必须显著高于纯 i.i.d. 模型 —— 这正是旧模型系统性低估 p95 的缺口。
    geom = _flat_grid()
    K = intrinsics_from_fov((1920, 1080), hfov_deg=60.0)
    cams = _ring(geom, K, n=6, span_deg=50.0, dist=2000.0)
    common = dict(pixel_sigma=0.3, nominal_deviation_mm=0.5, trials=12, seed=0,
                  target_p95_residual_mm=3.0)
    iid_only = score_screen(geom, cams, cabinet_jitter_mm=0.0,
                            cabinet_jitter_deg=0.0, **common)
    with_jitter = score_screen(geom, cams, cabinet_jitter_mm=1.5,
                               cabinet_jitter_deg=0.1, **common)
    p95_iid = np.mean([v["p95_mm"] for v in iid_only.values()])
    p95_jit = np.mean([v["p95_mm"] for v in with_jitter.values()])
    assert p95_jit > p95_iid * 1.3, (
        f"correlated jitter must raise predicted p95 materially: "
        f"iid={p95_iid:.2f} jitter={p95_jit:.2f}"
    )


def test_well_covered_wall_passes_with_small_residual():
    # A genuinely good capture: 6 cameras on a 50-deg arc at 2 m, mild noise.
    # (A flat wall is the weakest geometry for planar PnP, so cameras are kept
    # close and plentiful — far/sparse rigs legitimately exceed a 3 mm target.)
    geom = _flat_grid()
    K = intrinsics_from_fov((1920, 1080), hfov_deg=60.0)
    cams = _ring(geom, K, n=6, span_deg=50.0, dist=2000.0)
    report = score_screen(geom, cams, pixel_sigma=0.3, nominal_deviation_mm=0.5,
                          cabinet_jitter_mm=0.5, cabinet_jitter_deg=0.05,
                          trials=12, seed=0, target_p95_residual_mm=3.0)
    for cov in report.values():
        assert cov["reconstructable"] is True
        assert cov["bridged"] is True
        assert cov["p95_mm"] < 3.0
        assert cov["pass"] is True


def test_score_screen_min_views_flips_pass_on_two_view_wall():
    # A 2-camera arc covers every cabinet with exactly 2 views: reconstructable + passing at
    # the default min_views=2 (p95 well under target), but NOT reconstructable (so not passing)
    # at the precision profile's min_views=3 — proving min_views threads score_screen ->
    # coverage_report end-to-end (the path the optimizer drives via score_kwargs).
    geom = _flat_grid()
    K = intrinsics_from_fov((1920, 1080), hfov_deg=60.0)
    cams = _ring(geom, K, n=2, span_deg=50.0, dist=2000.0)
    common = dict(pixel_sigma=0.3, nominal_deviation_mm=0.5,
                  cabinet_jitter_mm=0.5, cabinet_jitter_deg=0.05, trials=12, seed=0,
                  target_p95_residual_mm=3.0)
    rep2 = score_screen(geom, cams, min_views=2, **common)
    rep3 = score_screen(geom, cams, min_views=3, **common)
    assert all(v["n_views"] == 2 for v in rep2.values())
    assert all(v["reconstructable"] and v["pass"] for v in rep2.values())
    assert all(not v["reconstructable"] and not v["pass"] for v in rep3.values())


def test_fail_reason_distinguishes_parallax_from_coverage():
    # Codex #4 observability diagnostic: WHY a cabinet fails, without a new gate.
    #  - 2 near-duplicate views: count-reconstructable but p95 >> target -> low_parallax
    #  - 1 view: not reconstructable -> low_coverage
    #  - 6 wide views: passes -> None
    geom = _flat_grid()
    K = intrinsics_from_fov((1920, 1080), hfov_deg=60.0)
    common = dict(pixel_sigma=0.3, nominal_deviation_mm=0.5,
                  cabinet_jitter_mm=0.5, cabinet_jitter_deg=0.05, trials=10, seed=0,
                  target_p95_residual_mm=3.0)
    near_dup = score_screen(geom, _ring(geom, K, n=2, span_deg=5.0, dist=4000.0), **common)
    for v in near_dup.values():
        assert v["reconstructable"] and not v["pass"]
        assert v["fail_reason"] == "low_parallax"
    one_view = score_screen(geom, _ring(geom, K, n=1, span_deg=0.0), **common)
    for v in one_view.values():
        assert not v["reconstructable"]
        assert v["fail_reason"] == "low_coverage"
    good = score_screen(geom, _ring(geom, K, n=6, span_deg=50.0, dist=2000.0), **common)
    for v in good.values():
        assert v["pass"]
        assert v["fail_reason"] is None


def test_under_observed_cabinet_is_flagged_not_scored():
    geom = _flat_grid()
    K = intrinsics_from_fov((1920, 1080), hfov_deg=60.0)
    # only ONE camera -> every cabinet has 1 covering view -> not reconstructable
    cams = _ring(geom, K, n=1, span_deg=0.0)
    report = score_screen(geom, cams, trials=5, seed=0, target_p95_residual_mm=3.0)
    for cov in report.values():
        assert cov["reconstructable"] is False
        assert cov["pass"] is False
        assert np.isnan(cov["p95_mm"])     # not scored, not an optimistic number


def test_strong_arc_far_end_not_optimistically_covered():
    # A strong wide arc with only frontal-ish cameras: the far ends must NOT all
    # pass (self-occlusion + grazing make them under-observed), proving the
    # planner is honest rather than optimistic about strong curves.
    from lmt_vba_sidecar.ipc import CabinetArray
    cab = CabinetArray(cols=10, rows=1, cabinet_size_mm=[500.0, 500.0], absent_cells=[])
    geom = expand_screen(cab, {"curved": {"radius_mm": 2200.0}}, sample_grid=(4, 4))
    K = intrinsics_from_fov((3840, 2160), hfov_deg=60.0)
    cams = _ring(geom, K, n=3, span_deg=30.0, dist=4000.0)
    report = score_screen(geom, cams, pixel_sigma=0.3, nominal_deviation_mm=1.0,
                          trials=6, seed=0, target_p95_residual_mm=3.0)
    assert not all(v["pass"] for v in report.values())   # far ends not all covered
