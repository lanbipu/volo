"""Greedy capture-plan optimizer.

Warm-starts from the recipe seed, then repeatedly adds the shell candidate that
removes the most failing cabinets, until every cabinet passes or the station
budget / candidate pool is exhausted. Whatever still fails is reported as
`unreachable_regions` — honest 'no placement here meets target', not silence.
Add-only in M2 (prune/swap deferred).
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from lmt_vba_sidecar.capture_planner import gates
from lmt_vba_sidecar.capture_planner.geometry import ScreenGeometry, aim_targets
from lmt_vba_sidecar.capture_planner.visibility import Camera, coverage_report, look_at_camera
from lmt_vba_sidecar.capture_planner.seed import Shell
from lmt_vba_sidecar.capture_planner.scoring import score_screen


def candidate_cameras(geom: ScreenGeometry, K, image_size, shell: Shell, *,
                      n_standoff=2, n_height=3, n_azimuth=5, n_aim=None) -> list[Camera]:
    """FIX-15: 候选按 (position, aim-target) 双参数化。position 网格不变
    (standoff × azimuth × height);每个 position 对 `aim_targets`(全墙中心 +
    墙面分区 zone 中心)各出一个候选——宽墙边缘箱体由此获得能覆盖它们的候选,
    不再被"全部瞄中心"结构性排除。窄墙(墙宽 ≤ 一个 FOV 足迹)aim 池退化为
    仅中心,候选池与旧行为一致。"""
    cx = geom.total_width_mm / 2.0
    standoffs = np.linspace(shell.standoff_min_mm, shell.standoff_max_mm, n_standoff)
    heights = np.linspace(shell.height_min_mm, shell.height_max_mm, n_height)
    # azimuth spread chosen so extremes stay in front of the wall (|a| < 80deg)
    azimuths = np.deg2rad(np.linspace(-70.0, 70.0, n_azimuth))
    d_mid = 0.5 * (shell.standoff_min_mm + shell.standoff_max_mm)
    aims = aim_targets(geom, K, image_size, d_mid, n_aim=n_aim)
    cams: list[Camera] = []
    for d in standoffs:
        for a in azimuths:
            for hy in heights:
                pos = np.array([cx + d * np.sin(a), hy, d * np.cos(a)])
                for aim in aims:
                    cams.append(look_at_camera(K, pos, aim, image_size))
    return cams


@dataclass
class OptimizeResult:
    cameras: list          # final list[Camera]
    report: dict           # score_screen output for the final set
    unreachable: list      # [(col,row), ...] cabinets that never pass
    counts: dict           # per-(cam_idx, (col,row)) visible-point count for `cameras`


def _score(report, n_cabinets, *, min_views=gates.MIN_VIEWS,
           target_p95_mm=3.0) -> tuple:
    """Lexicographic greedy objective: failing cabinets first, then total view
    deficit (sum of how many covering views each cabinet still lacks to reach
    `min_views`), then continuous p95-excess (FIX-17 ①).

    The deficit term lets the optimizer make progress on a cabinet that needs
    TWO new views: the first addition lowers the deficit even though the
    cabinet isn't reconstructable yet, so the greedy doesn't dead-stop and
    falsely report a reachable region as unreachable.

    FIX-17 ①: the third component Σ max(0, p95 − target) gives a CONTINUOUS
    progress signal for `low_parallax` cabinets — a candidate that markedly
    improves p95 without crossing the target used to leave both discrete
    components unchanged, the greedy saw "no strict improvement" and dead-
    stopped with budget left, misreporting a reachable region as unreachable.

    `failing` stays pass-based (NOT view-count-based): `pass` already folds in the
    min_views requirement via coverage_report's reconstructable gate, AND still
    demands bridging + p95<=target, so a view-covered-but-low-parallax cabinet
    keeps driving the optimizer to add a wider-baseline view. Only the deficit
    tie-break is parameterized by min_views (default mirrors gates.MIN_VIEWS)."""
    if report is None:
        return (n_cabinets, min_views * n_cabinets, float("inf"))
    failing = sum(1 for v in report.values() if not v["pass"])
    deficit = sum(max(0, min_views - v["n_views"]) for v in report.values())
    excess = 0.0
    for v in report.values():
        p95 = v["p95_mm"]
        if p95 is not None and np.isfinite(p95):
            excess += max(0.0, float(p95) - float(target_p95_mm))
    return (failing, deficit, excess)


def optimize(geom: ScreenGeometry, K, image_size, shell: Shell, *, seed_cams=None,
             max_stations=24, n_standoff=2, n_height=3, n_azimuth=5, n_aim=None,
             score_kwargs=None) -> OptimizeResult:
    score_kwargs = dict(score_kwargs or {})
    # min_views rides score_kwargs (so score_screen->coverage_report sees it too); the
    # objective's deficit term must use the SAME value, so read it back here.
    min_views = int(score_kwargs.get("min_views", gates.MIN_VIEWS))
    # 同理:p95-excess 项(FIX-17 ①)必须用与 score_screen 相同的 target。
    target_p95 = float(score_kwargs.get("target_p95_residual_mm", 3.0))
    # The seed is part of the station budget: never return more than max_stations.
    cams = list(seed_cams or [])[:max_stations]
    pool = candidate_cameras(geom, K, image_size, shell, n_standoff=n_standoff,
                             n_height=n_height, n_azimuth=n_azimuth, n_aim=n_aim)
    n_cab = len(geom.cabinets)

    report = score_screen(geom, cams, **score_kwargs) if cams else None
    cur = _score(report, n_cab, min_views=min_views, target_p95_mm=target_p95)

    # Greedy: each round, add the unused pool candidate that most improves the
    # objective. Selected candidates are removed from the pool so the same pose
    # can't be re-added (duplicate poses share no baseline yet coverage_report
    # would count them as independent views, faking reconstructability).
    while cur[0] > 0 and len(cams) < max_stations and pool:
        best, best_cam, best_report, best_idx = cur, None, report, -1
        for idx, cand in enumerate(pool):
            r = score_screen(geom, cams + [cand], **score_kwargs)
            s = _score(r, n_cab, min_views=min_views, target_p95_mm=target_p95)
            if s < best:
                best, best_cam, best_report, best_idx = s, cand, r, idx
        if best_cam is None:        # no candidate improves the objective -> stop
            break
        cams.append(best_cam)
        pool.pop(best_idx)
        report, cur = best_report, best

    if report is None:
        # The no-camera fallback report MUST carry the same key schema score_screen
        # produces (cmd.py reads every field unconditionally, incl. fail_reason) — a
        # zero-view cabinet is low_coverage.
        report = score_screen(geom, cams, **score_kwargs) if cams else {
            (c.col, c.row): {"pass": False, "reconstructable": False,
                             "low_observation": False, "bridged": False,
                             "p95_mm": float("nan"), "median_mm": float("nan"),
                             "n_views": 0, "total_observations": 0,
                             "fail_reason": "low_coverage"}
            for c in geom.cabinets
        }
    # Final per-(cam, cabinet) visibility for the chosen cameras, so callers can
    # derive per-station covered-cabinet lists without re-running coverage.
    inc = score_kwargs.get("incidence_max_deg", 60.0)
    _, counts = coverage_report(geom, cams, incidence_max_deg=inc) if cams else ([], {})
    unreachable = [k for k, v in report.items() if not v["pass"]]
    return OptimizeResult(cams, report, unreachable, counts)
