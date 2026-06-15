"""Error-budget sensitivity sweep (remediation B1).

Walks each error source over a range of magnitudes, runs the full
simulate → quick-run pipeline against known ground truth, and reports how the
solved ``T_S_from_O`` deviates.  The resulting table (CSV + docs/error-budget.md)
answers *which error source dominates* — the basis for every later precision
decision (and, for the timing source, the B3 TimeCal scoping call).

Each cell projects pixels from the *true* geometry but corrupts only the input
the solver is given (tracker poses, lens, pixel noise), so the measured
deviation is purely the solver's response to that one error source.
"""

from __future__ import annotations

import csv
import json
import tempfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from vpcal.core.simulator import SimulatorConfig, default_lens, simulate_from_config
from vpcal.models.screen import ScreenDefinition


@dataclass
class SweepCell:
    source: str
    magnitude: float
    unit: str
    trans_err_mm_mean: float
    trans_err_mm_std: float
    rot_err_deg_mean: float
    rot_err_deg_std: float
    validation_rms_px_mean: float
    n_seeds: int


# source key → (SimulatorConfig field, unit, default magnitude ladder, trajectory)
SWEEP_SOURCES: dict[str, tuple] = {
    "pixel_noise":      ("noise_px", "px", [0.0, 0.25, 0.5, 1.0, 2.0], False),
    "tracker_trans":    ("tracker_noise_mm", "mm", [0.0, 1.0, 2.0, 5.0, 10.0], False),
    "tracker_rot":      ("tracker_noise_deg", "deg", [0.0, 0.05, 0.1, 0.2, 0.5], False),
    "handeye_trans":    ("handeye", "mm", [0.0, 5.0, 10.0, 20.0, 40.0], False),
    "outliers":         ("outlier_ratio", "frac", [0.0, 0.05, 0.1, 0.2], False),
    "temporal_moving":  ("temporal_offset_frames", "frames", [0.0, 0.5, 1.0, 2.0, 4.0], True),
}

# A realistic ~1σ working magnitude per source, used to score sources on a COMMON,
# cross-comparable mm basis (raw per-unit slopes are NOT comparable across sources —
# a "frame" and a "deg" are different physical steps).  Tune to your rig.
REALISTIC_MAGNITUDE: dict[str, float] = {
    "pixel_noise": 0.5,     # px — typical sub-pixel detection noise
    "tracker_trans": 2.0,   # mm — prosumer tracker translation jitter
    "tracker_rot": 0.1,     # deg — tracker rotation jitter
    "handeye_trans": 10.0,  # mm — hand-measured hand-eye offset error
    "outliers": 0.05,       # 5% gross outliers
    "temporal_moving": 1.0,  # 1 frame — MOVING capture only (static main path ≈ 0)
}

# Sources that contribute to the DEFAULT static multi-pose main path.  Timing
# (temporal_moving) is excluded: it is constructively zero on the static path and
# only matters for the moving-scan path (see the B3 section), so ranking it
# alongside the static sources would be apples-to-oranges.
STATIC_MAIN_PATH_SOURCES = ["pixel_noise", "tracker_trans", "tracker_rot",
                            "handeye_trans", "outliers"]


def _rotation_error_deg(q_gt: list[float], q_est: list[float]) -> float:
    a = np.asarray(q_gt, dtype=np.float64)
    b = np.asarray(q_est, dtype=np.float64)
    a /= np.linalg.norm(a) or 1.0
    b /= np.linalg.norm(b) or 1.0
    return float(np.degrees(2.0 * np.arccos(np.clip(abs(np.dot(a, b)), 0.0, 1.0))))


def _config_for(source: str, magnitude: float, *, seed: int, num_poses: int,
                trajectory: bool, holdout_ratio: float | None) -> SimulatorConfig:
    field, _unit, _ladder, _traj = SWEEP_SOURCES[source]
    cfg = SimulatorConfig(
        num_poses=num_poses, seed=seed, render_images=False,
        trajectory=trajectory, holdout_ratio=holdout_ratio,
    )
    if field == "handeye":
        cfg.handeye_perturbation = (0.0, float(magnitude))  # pure-translation hand-eye offset
    else:
        setattr(cfg, field, float(magnitude))
    return cfg


def _run_cell(screen: ScreenDefinition, cfg: SimulatorConfig, *, prefer_cpp: bool) -> tuple[float, float, float]:
    """One simulate→solve run; returns (trans_err_mm, rot_err_deg, validation_rms_px)."""
    from vpcal.core.pipeline import run_quick
    from vpcal.models.session import SessionConfig

    with tempfile.TemporaryDirectory() as td:
        out = Path(td)
        simulate_from_config(screen, out, cfg, lens=default_lens(1920, 1080))
        raw = json.loads((out / "session.json").read_text())
        session = SessionConfig.model_validate(raw)
        result = run_quick(session, out, out / "output", raw_session=raw, prefer_cpp=prefer_cpp)
        gt = json.loads((out / "ground_truth.json").read_text())["tracker_to_stage"]
        est = result["result"]["tracker_to_stage"]
        trans = float(np.linalg.norm(np.array(gt["translation"]) - np.array(est["translation"])))
        rot = _rotation_error_deg(gt["rotation"], est["rotation"])
        val = result["result"]["quality"].get("validation_rms_px")
        return trans, rot, float(val) if val is not None else float("nan")


def run_sweep(
    screen: ScreenDefinition,
    *,
    sources: list[str] | None = None,
    seeds: int = 3,
    num_poses: int = 12,
    holdout_ratio: float | None = 0.25,
    prefer_cpp: bool = True,
    progress=None,
) -> list[SweepCell]:
    """Run the full sensitivity grid; returns one :class:`SweepCell` per (source, magnitude).

    Cells with an identical config (notably the magnitude-0 baseline shared by the
    static sources) are computed once and reused.  A cell whose simulate→solve
    raises (e.g. a degenerate holdout/outlier config tripping a solver
    precondition) is recorded as NaN and warned about — it never aborts the sweep.
    """
    import warnings

    sources = sources or list(SWEEP_SOURCES)
    cells: list[SweepCell] = []
    cache: dict[tuple, tuple[float, float, float]] = {}

    def run_cached(cfg: SimulatorConfig) -> tuple[float, float, float]:
        key = (cfg.seed, cfg.num_poses, cfg.trajectory, cfg.holdout_ratio, cfg.noise_px,
               cfg.tracker_noise_mm, cfg.tracker_noise_deg, cfg.temporal_offset_frames,
               cfg.outlier_ratio, cfg.handeye_perturbation, cfg.bake_dot_screen_space)
        if key not in cache:
            try:
                cache[key] = _run_cell(screen, cfg, prefer_cpp=prefer_cpp)
            except Exception as exc:  # isolate one bad cell — don't abort the sweep
                warnings.warn(f"sweep cell failed (seed={cfg.seed}): {exc}", stacklevel=2)
                cache[key] = (float("nan"), float("nan"), float("nan"))
        return cache[key]

    for source in sources:
        field, unit, ladder, trajectory = SWEEP_SOURCES[source]
        traj_poses = max(num_poses, 16) if trajectory else num_poses
        for mag in ladder:
            ts, rs, vs = [], [], []
            for s in range(seeds):
                cfg = _config_for(source, mag, seed=1000 * s + 7, num_poses=traj_poses,
                                  trajectory=trajectory, holdout_ratio=holdout_ratio)
                t, r, v = run_cached(cfg)
                if not np.isnan(t):
                    ts.append(t)
                if not np.isnan(r):
                    rs.append(r)
                if not np.isnan(v):
                    vs.append(v)
            cells.append(SweepCell(
                source=source, magnitude=float(mag), unit=unit,
                trans_err_mm_mean=float(np.mean(ts)) if ts else float("nan"),
                trans_err_mm_std=float(np.std(ts)) if ts else float("nan"),
                rot_err_deg_mean=float(np.mean(rs)) if rs else float("nan"),
                rot_err_deg_std=float(np.std(rs)) if rs else float("nan"),
                validation_rms_px_mean=float(np.mean(vs)) if vs else float("nan"),
                n_seeds=seeds,
            ))
            if progress is not None:
                progress(source, mag)
    return cells


def write_csv(cells: list[SweepCell], path: str | Path) -> None:
    path = Path(path)
    with path.open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["source", "magnitude", "unit", "trans_err_mm_mean", "trans_err_mm_std",
                    "rot_err_deg_mean", "rot_err_deg_std", "validation_rms_px_mean", "n_seeds"])
        for c in cells:
            w.writerow([c.source, c.magnitude, c.unit,
                        round(c.trans_err_mm_mean, 4), round(c.trans_err_mm_std, 4),
                        round(c.rot_err_deg_mean, 5), round(c.rot_err_deg_std, 5),
                        round(c.validation_rms_px_mean, 4), c.n_seeds])


def _sensitivity_slope(cells: list[SweepCell], source: str) -> float:
    """Δ(translation error mm) per unit magnitude, in the source's NATIVE unit.

    ⚠ Per-source diagnostic only — NOT comparable across sources (frames, deg, mm
    and frac are different physical steps).  Use :func:`rank_static_sources` for a
    cross-source dominance ordering on a common mm basis.
    """
    pts = [(c.magnitude, c.trans_err_mm_mean) for c in cells if c.source == source]
    pts.sort()
    if len(pts) < 2 or pts[-1][0] == pts[0][0]:
        return 0.0
    return (pts[-1][1] - pts[0][1]) / (pts[-1][0] - pts[0][0])


def rank_static_sources(cells: list[SweepCell]) -> list[tuple[str, float, float]]:
    """Cross-comparable dominance ranking for the static main path.

    Returns ``[(source, realistic_magnitude, trans_err_mm)]`` sorted descending by
    the translation error each source induces *at its realistic working magnitude*
    — a common mm basis, unlike the per-unit slope.  ``temporal_moving`` is
    deliberately excluded (constructively zero on the static path).
    """
    present = [s for s in STATIC_MAIN_PATH_SOURCES if any(c.source == s for c in cells)]
    scored = []
    for s in present:
        mag = REALISTIC_MAGNITUDE.get(s, 0.0)
        err = _interpolate_trans_err(cells, s, mag) or 0.0
        scored.append((s, mag, err))
    scored.sort(key=lambda x: -x[2])
    return scored


def _interpolate_trans_err(cells: list[SweepCell], source: str, magnitude: float) -> float | None:
    """Linear-interpolated translation error (mm) for ``source`` at ``magnitude``."""
    pts = sorted((c.magnitude, c.trans_err_mm_mean) for c in cells if c.source == source)
    if not pts:
        return None
    for (m0, e0), (m1, e1) in zip(pts, pts[1:]):
        if m0 <= magnitude <= m1:
            if m1 == m0:
                return e0
            return e0 + (e1 - e0) * (magnitude - m0) / (m1 - m0)
    return pts[-1][1] if magnitude > pts[-1][0] else pts[0][1]


def _timing_decision_md(cells: list[SweepCell], *, fps: int = 30) -> list[str]:
    """B3: static-vs-moving timing study + TimeCal (4.5) scoping, from sweep data."""
    lines: list[str] = []
    lines.append("## 解读与决策 · B3 时序敏感性 → TimeCal（4.5）范围")
    lines.append("")
    moving = [c for c in cells if c.source == "temporal_moving"]
    if not moving:
        lines.append("> （本次 sweep 未含 `temporal_moving` 源，跳过时序结论。）")
        lines.append("")
        return lines
    ms_per_frame = 1000.0 / fps
    e1 = _interpolate_trans_err(cells, "temporal_moving", 1.0) or 0.0
    per_ms = e1 / ms_per_frame
    lines.append(f"**对照设置**——")
    lines.append(f"- **静态采集**（多机位定点 hold，`trajectory=False`）：相机在曝光与 tracker 采样之间"
                 f"静止，时序偏移**按构造无几何效应**（模型假设 + 单测 `test_static_capture_timing_immune` "
                 f"验证：注入任意 offset，tracker 流逐字节不变）。此臂为构造性零，非 sweep 实测量。")
    lines.append(f"- **运动采集**（平滑扫掠，`trajectory=True`）：tracker 在 `frame_id+offset` 处采样，"
                 f"偏移→空间错位∝路径速度。**仅此臂为下表的 sweep 实测量。**")
    lines.append("")
    lines.append(f"**运动采集时序敏感度**（@ {fps} fps，1 frame = {ms_per_frame:.1f} ms；"
                 f"⚠ 结果按 fps 缩放——同一 1 帧延迟在 60 fps 下位移约减半）：")
    lines.append("")
    lines.append("| 偏移 | ≈延迟 | 平移误差 mm | 旋转误差 ° |")
    lines.append("|---|---|---|---|")
    for c in moving:
        lines.append(f"| {c.magnitude:g} frame | {c.magnitude * ms_per_frame:.1f} ms "
                     f"| {c.trans_err_mm_mean:.2f} | {c.rot_err_deg_mean:.3f} |")
    lines.append("")
    lines.append(f"- 折算 **≈{per_ms:.2f} mm / ms**（1 frame ≈ {e1:.1f} mm @ {fps} fps）；旋转 ≈"
                 f"{(_rot_at(moving,1.0)):.2f}°/frame。运动采集对时序**高度敏感**。")
    lines.append("")
    # Decision: gate on whether 1-frame moving error breaches a typical precision target.
    target_mm = 1.0
    if e1 > target_mm:
        lines.append(f"**结论（裁剪 4.5 TimeCal）**：静态多机位主流程对时序**不敏感**（架构纪律二的"
                     f"论断在静态构型下成立），但运动扫掠采集对时序**极敏感**（≈{per_ms:.2f} mm/ms，"
                     f"1 frame ≈ {e1:.0f} mm @ {fps} fps ≫ {target_mm:g} mm 目标）。因此 TimeCal **不能整体裁掉**：")
        lines.append("")
        lines.append("  1. **静态多机位路径**：TimeCal 降级为可选信息项（不 gate 准入）；")
        lines.append("  2. **运动采集路径（C1 视频流）**：TimeCal 为**硬前置**——genlock/PTP/timecode "
                     "完备度直接决定可达精度，须按架构原设计的分级 gate 实现；")
        lines.append("  3. temporal delay 仍**永不**作为 BA 自由变量（纪律保持）；改由 TimeCal 前置门控。")
    else:
        lines.append(f"**结论**：即使运动采集，1 frame 偏移仅 ≈{e1:.2f} mm（< {target_mm:g} mm 目标），"
                     f"时序整体不主导 → TimeCal 可缩水为运动模式的轻量前置检查。")
    lines.append("")
    # Secondary signal worth surfacing: validation RMS vs outliers.
    outl = [c for c in cells if c.source == "outliers" and c.magnitude > 0]
    if outl and not np.isnan(outl[0].validation_rms_px_mean):
        lines.append(f"**附带观察（validation RMS 的价值）**：outlier 对 `T_S_from_O` 平移影响小"
                     f"（robust loss 吸收），但 held-out validation RMS 在 {outl[0].magnitude:g} outlier 比例下"
                     f"即飙升至 ~{outl[0].validation_rms_px_mean:.0f} px——证明 validation RMS 能抓住"
                     f"robust in-sample RMS 掩盖的坏数据污染（A4 的设计意图）。")
        lines.append("")
    return lines


def _rot_at(cells: list[SweepCell], magnitude: float) -> float:
    for c in cells:
        if abs(c.magnitude - magnitude) < 1e-9:
            return c.rot_err_deg_mean
    return 0.0


def format_error_budget_md(cells: list[SweepCell], *, meta: dict) -> str:
    """Render docs/error-budget.md from sweep cells."""
    sources = list(dict.fromkeys(c.source for c in cells))
    lines: list[str] = []
    lines.append("# vpcal 误差预算（error budget）")
    lines.append("")
    lines.append("> 自动生成自 `vpcal simulate sweep`（B1/B3）。每个误差源单独扫参数，"
                 "其余源保持基线 0，度量解出的 `T_S_from_O` 相对 ground truth 的偏差。"
                 "重新生成：`vpcal simulate sweep --screen <screen.json> --out-csv docs/error-budget.csv "
                 "--out-md docs/error-budget.md`。CSV（`error-budget.csv`）可外部绘图。")
    lines.append("> 像素由**真实几何**投影，只有交给求解器的输入（tracker 位姿 / 镜头 / 像素噪声）被污染——"
                 "因此偏差纯粹是求解器对该误差源的响应。")
    lines.append("")
    lines.append(f"- 采集构型：`num_poses={meta.get('num_poses')}`，"
                 f"每格 `seeds={meta.get('seeds')}`，`holdout_ratio={meta.get('holdout_ratio')}`，"
                 f"backend=`{meta.get('backend')}`。")
    lines.append(f"- 屏幕：`{meta.get('screen_name')}`。")
    lines.append("")

    # Dominance ranking on a COMMON mm basis: translation error each source induces
    # at its realistic ~1σ working magnitude (raw per-unit slopes are not comparable
    # across sources).  temporal_moving is excluded — see the B3 section.
    lines.append("## 主导误差源排名（静态主路径，按现实工作量级下的平移误差）")
    lines.append("")
    lines.append("> 跨源可比：各源在其**现实工作量级**（~1σ）下注入，度量同一个 mm 平移误差。"
                 "（原始 per-unit 斜率 frame/deg/mm/px 量纲不同，**不可**跨源比大小，仅作各源内部灵敏度参考。）"
                 "运动采集时序 `temporal_moving` 不进本排名——它在静态主路径构造性为 0，单独见下方 B3 节。")
    lines.append("")
    lines.append("| 排名 | 误差源 | 现实工作量级 | 该量级平移误差 (mm) |")
    lines.append("|---|---|---|---|")
    ranked = rank_static_sources(cells)
    for i, (s, mag, err) in enumerate(ranked, 1):
        unit = next(c.unit for c in cells if c.source == s)
        lines.append(f"| {i} | `{s}` | {mag:g} {unit} | {err:.3f} |")
    lines.append("")
    if ranked:
        lines.append(f"- **静态主路径主导误差源：`{ranked[0][0]}`**"
                     f"（{ranked[0][1]:g} 工作量级 → {ranked[0][2]:.3f} mm）。")
        lines.append("")

    # B3 timing interpretation + TimeCal decision.
    lines.extend(_timing_decision_md(cells))

    # Per-source detail tables.
    for s in sources:
        scs = [c for c in cells if c.source == s]
        unit = scs[0].unit
        lines.append(f"## `{s}`（单位 {unit}）")
        lines.append("")
        lines.append("| 量级 | 平移误差 mm (mean±std) | 旋转误差 ° (mean±std) | validation RMS px |")
        lines.append("|---|---|---|---|")
        for c in scs:
            val = "—" if np.isnan(c.validation_rms_px_mean) else f"{c.validation_rms_px_mean:.3f}"
            lines.append(
                f"| {c.magnitude:g} | {c.trans_err_mm_mean:.3f}±{c.trans_err_mm_std:.3f} "
                f"| {c.rot_err_deg_mean:.4f}±{c.rot_err_deg_std:.4f} | {val} |"
            )
        lines.append("")
    return "\n".join(lines)
