import numpy as np

from lmt_vba_sidecar.ipc import CabinetArray
from lmt_vba_sidecar.capture_planner.geometry import expand_screen
from lmt_vba_sidecar.capture_planner.visibility import intrinsics_from_fov
from lmt_vba_sidecar.capture_planner.seed import Shell
from lmt_vba_sidecar.capture_planner.optimize import candidate_cameras


def _wall(cols, rows):
    cab = CabinetArray(cols=cols, rows=rows, cabinet_size_mm=[500.0, 500.0], absent_cells=[])
    return expand_screen(cab, "flat", sample_grid=(4, 4))


def test_candidates_lie_within_the_shell():
    K = intrinsics_from_fov((1920, 1080), hfov_deg=60.0)
    shell = Shell(2000.0, 6000.0, 400.0, 2400.0)
    geom = _wall(2, 2)
    cams = candidate_cameras(geom, K, (1920, 1080), shell,
                             n_standoff=2, n_height=3, n_azimuth=5)
    # 窄墙(1m << FOV 足迹)aim 池退化为仅中心 → 池规模与旧行为一致。
    assert len(cams) == 2 * 3 * 5
    cx = geom.total_width_mm / 2.0
    for cam in cams:
        pos = -cam.R.T @ cam.t            # camera center in world
        assert 400.0 - 1e-6 <= pos[1] <= 2400.0 + 1e-6      # height in shell
        standoff = np.linalg.norm([pos[0] - cx, pos[2]])    # radial dist in x-z
        assert 2000.0 - 1.0 <= standoff <= 6000.0 + 1.0     # standoff in shell
        assert pos[2] > 0                                    # in front of the wall


def test_aim_targets_adaptive_zones():
    from lmt_vba_sidecar.capture_planner.geometry import aim_targets
    K = intrinsics_from_fov((1920, 1080), hfov_deg=60.0)
    # 窄墙:1m 宽 @4m 站距(足迹 ~4.6m)→ 只剩全墙中心。
    narrow = _wall(2, 2)
    assert len(aim_targets(narrow, K, (1920, 1080), 4000.0)) == 1
    # 宽墙:15m 宽 → 中心 + 多个 zone 中心,zone 横跨整面墙(含边缘)。
    wide = _wall(30, 3)
    targets = aim_targets(wide, K, (1920, 1080), 4000.0)
    assert len(targets) >= 4
    xs = [float(t[0]) for t in targets[1:]]
    assert min(xs) < 0.15 * wide.total_width_mm, f"left zone missing: {xs}"
    assert max(xs) > 0.85 * wide.total_width_mm, f"right zone missing: {xs}"


def test_wide_wall_every_cabinet_covered_by_some_candidate():
    # FIX-15 验收:15m+ 平墙 + 标准 FOV,每个箱体必须能被至少一个候选覆盖
    # (≥ MIN_PNP_CORNERS 个采样点可见)。旧"全部瞄中心"候选池下边缘箱体对
    # 所有候选出画(子 agent 实测 49/49 候选 0 可见点)。
    from lmt_vba_sidecar.capture_planner import gates
    from lmt_vba_sidecar.capture_planner.visibility import vis_count
    K = intrinsics_from_fov((1920, 1080), hfov_deg=60.0)
    shell = Shell(3000.0, 8000.0, 400.0, 2400.0)
    geom = _wall(30, 3)          # 15m × 1.5m
    cams = candidate_cameras(geom, K, (1920, 1080), shell,
                             n_standoff=2, n_height=3, n_azimuth=5)
    uncoverable = []
    for cabg in geom.cabinets:
        best = max(vis_count(cam, cabg) for cam in cams)
        if best < gates.MIN_PNP_CORNERS:
            uncoverable.append((cabg.col, cabg.row, best))
    assert not uncoverable, (
        f"{len(uncoverable)} cabinets structurally uncoverable by ALL candidates "
        f"(first few: {uncoverable[:6]})"
    )


from lmt_vba_sidecar.capture_planner.seed import seed_cameras
from lmt_vba_sidecar.capture_planner.optimize import optimize, _score


def _score_kwargs():
    return dict(pixel_sigma=0.2, nominal_deviation_mm=0.5, trials=6,
               seed=0, target_p95_residual_mm=4.0)


def test_score_deficit_scales_with_min_views():
    # The view-deficit term (the greedy's tie-break that bootstraps a cabinet toward
    # min_views) must grow when min_views rises. The `failing` term stays pass-based —
    # `pass` already respects min_views via coverage_report's reconstructable gate (Task 2),
    # so only the deficit is parameterized here. (Include "pass" so failing is computable.)
    report = {(0, 0): {"n_views": 2, "pass": True, "p95_mm": 1.0},
              (1, 0): {"n_views": 4, "pass": True, "p95_mm": 1.0}}
    fails2, deficit2, _ = _score(report, 2, min_views=2)
    fails3, deficit3, _ = _score(report, 2, min_views=3)
    # `failing` is PASS-based and must NOT change with min_views (both cabinets pass=True),
    # else the optimizer would stop chasing p95 once view-counts are met (the forbidden
    # view-count-based `failing`). Only the deficit tie-break scales.
    assert fails2 == 0 and fails3 == 0
    assert deficit2 == 0            # both cabinets meet 2 views
    assert deficit3 == 1            # cabinet (0,0) is 1 view short of 3


def test_score_p95_excess_is_continuous_progress_signal():
    # FIX-17 ①: 两个 report 同 failing/deficit,p95 更低者目标值更小(连续进度);
    # NaN p95(不可重建)不计入 excess;低于 target 的 p95 excess=0。
    base = {"n_views": 2, "pass": False}
    r_hi = {(0, 0): dict(base, p95_mm=10.0), (1, 0): dict(base, p95_mm=float("nan"))}
    r_lo = {(0, 0): dict(base, p95_mm=6.0), (1, 0): dict(base, p95_mm=float("nan"))}
    s_hi = _score(r_hi, 2, min_views=2, target_p95_mm=3.0)
    s_lo = _score(r_lo, 2, min_views=2, target_p95_mm=3.0)
    assert s_hi[:2] == s_lo[:2], "discrete components identical by construction"
    assert s_lo < s_hi, "lower p95-excess must compare as strictly better"
    r_pass = {(0, 0): dict(base, p95_mm=2.0)}
    assert _score(r_pass, 1, min_views=2, target_p95_mm=3.0)[2] == 0.0


def test_optimize_no_dead_stop_on_pure_p95_improvement(monkeypatch):
    # FIX-17 ① 验收:可达但需要多个宽基线机位的场景——前几个候选只改善 p95
    # 而不改变 failing/deficit。旧二元组目标下贪心首轮就死停并误报 unreachable;
    # 连续 excess 项必须驱动它继续加机位直到通过。
    # 用 stub score_screen 把"p95 随机位数单调下降、跨线才 pass"钉成确定剧本。
    from lmt_vba_sidecar.capture_planner import optimize as opt_mod

    def fake_score_screen(geom, cams, **kwargs):
        n = len(cams)
        p95 = {0: float("nan"), 1: float("nan"), 2: 10.0, 3: 6.0}.get(n, 2.0)
        passed = n >= 4
        return {
            (c.col, c.row): {
                "pass": passed, "reconstructable": n >= 2, "low_observation": False,
                "bridged": n >= 2, "p95_mm": p95, "median_mm": p95,
                "n_views": n, "total_observations": 16 * n,
                "fail_reason": None if passed else ("low_parallax" if n >= 2 else "low_coverage"),
            }
            for c in geom.cabinets
        }

    monkeypatch.setattr(opt_mod, "score_screen", fake_score_screen)
    K = intrinsics_from_fov((1920, 1080), hfov_deg=60.0)
    shell = Shell(2000.0, 4000.0, 400.0, 2200.0)
    geom = _wall(2, 2)
    result = opt_mod.optimize(geom, K, (1920, 1080), shell, seed_cams=[],
                              max_stations=8, n_standoff=2, n_height=3, n_azimuth=5,
                              score_kwargs=dict(target_p95_residual_mm=3.0))
    # 2 机位后 failing/deficit 不再变化,只有 p95 在降 —— 不许死停。
    assert len(result.cameras) >= 4, (
        f"greedy dead-stopped at {len(result.cameras)} stations despite a "
        f"monotone p95 path to target"
    )
    assert result.unreachable == []


def test_optimize_covers_a_reachable_flat_wall():
    K = intrinsics_from_fov((1920, 1080), hfov_deg=60.0)
    shell = Shell(2000.0, 4000.0, 400.0, 2200.0)
    geom = _wall(2, 2)
    seed = [s.camera for s in seed_cameras(geom, K, (1920, 1080), shell, n_fan=5)]
    result = optimize(geom, K, (1920, 1080), shell, seed_cams=seed,
                      max_stations=16, n_standoff=2, n_height=3, n_azimuth=5,
                      score_kwargs=_score_kwargs())
    assert result.unreachable == []
    assert all(v["pass"] for v in result.report.values())
    assert len(result.cameras) >= len(seed)        # warm-started, add-only


def test_optimize_reports_unreachable_when_shell_too_tight():
    K = intrinsics_from_fov((1920, 1080), hfov_deg=60.0)
    # a degenerate shell collapsed to a single near-frontal pencil: no two views
    # can ever form a baseline -> nothing reconstructable -> all unreachable.
    shell = Shell(3000.0, 3000.0, 1249.0, 1251.0)
    geom = _wall(2, 2)
    result = optimize(geom, K, (1920, 1080), shell, seed_cams=[],
                      max_stations=4, n_standoff=1, n_height=1, n_azimuth=1,
                      score_kwargs=_score_kwargs())
    assert len(result.unreachable) > 0
    assert not all(v["pass"] for v in result.report.values())


def test_optimize_adds_cameras_to_a_single_camera_start():
    # one frontal camera alone -> every cabinet has 1 view -> all fail. The
    # greedy MUST add cameras (exercise the add path) and converge.
    K = intrinsics_from_fov((1920, 1080), hfov_deg=60.0)
    shell = Shell(2000.0, 4000.0, 400.0, 2200.0)
    geom = _wall(2, 2)
    cx, cy = geom.total_width_mm / 2.0, geom.total_height_mm / 2.0
    from lmt_vba_sidecar.capture_planner.visibility import look_at_camera
    lone = look_at_camera(K, [cx, cy, 2500.0], [cx, cy, 0.0], (1920, 1080))
    result = optimize(geom, K, (1920, 1080), shell, seed_cams=[lone],
                      max_stations=16, n_standoff=2, n_height=3, n_azimuth=5,
                      score_kwargs=_score_kwargs())
    assert len(result.cameras) > 1                  # greedy added at least one
    assert result.unreachable == []
    assert all(v["pass"] for v in result.report.values())


def test_optimize_bootstraps_two_views_from_empty_seed():
    # From an EMPTY seed, no single added camera makes any cabinet pass (each
    # cabinet needs 2 views). The old binary "failing count" objective would
    # dead-stop after round 1 (failing unchanged) and report everything
    # unreachable; the view-deficit objective must bootstrap to 2 views and pass.
    K = intrinsics_from_fov((1920, 1080), hfov_deg=60.0)
    shell = Shell(2000.0, 4000.0, 400.0, 2200.0)
    geom = _wall(2, 2)
    result = optimize(geom, K, (1920, 1080), shell, seed_cams=[],
                      max_stations=16, n_standoff=2, n_height=3, n_azimuth=5,
                      score_kwargs=_score_kwargs())
    assert len(result.cameras) >= 2
    assert result.unreachable == []
    assert all(v["pass"] for v in result.report.values())


def test_optimize_never_returns_duplicate_poses():
    # Selected candidates are removed from the pool, so no two chosen cameras
    # share the same pose (duplicate poses have no baseline yet would be counted
    # as independent views).
    K = intrinsics_from_fov((1920, 1080), hfov_deg=60.0)
    shell = Shell(2000.0, 4000.0, 400.0, 2200.0)
    geom = _wall(2, 2)
    result = optimize(geom, K, (1920, 1080), shell, seed_cams=[],
                      max_stations=16, n_standoff=2, n_height=3, n_azimuth=5,
                      score_kwargs=_score_kwargs())
    keys = {(c.R.tobytes(), c.t.tobytes()) for c in result.cameras}
    assert len(keys) == len(result.cameras), "duplicate camera pose in plan"


def test_optimize_respects_max_stations_below_seed_count():
    # max_stations smaller than the recipe seed (7 = 5 fan + top + bottom) must
    # still cap the returned plan at the budget.
    from lmt_vba_sidecar.capture_planner.seed import seed_cameras
    K = intrinsics_from_fov((1920, 1080), hfov_deg=60.0)
    shell = Shell(2000.0, 4000.0, 400.0, 2200.0)
    geom = _wall(2, 2)
    seed = [s.camera for s in seed_cameras(geom, K, (1920, 1080), shell, n_fan=5)]
    assert len(seed) == 7
    result = optimize(geom, K, (1920, 1080), shell, seed_cams=seed,
                      max_stations=3, n_standoff=2, n_height=3, n_azimuth=5,
                      score_kwargs=_score_kwargs())
    assert len(result.cameras) <= 3
