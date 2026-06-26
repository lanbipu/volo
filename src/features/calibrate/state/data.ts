// Volo · Calibrate —— mock 数据。移植自 Claude Design 原型 data.jsx 的 CAL_* 段
// 与 page_calibrate.jsx 内联常量（ROLE / CAB_STATE / SEVCAL / STEP_DETAIL）。第二期接真 mesh_* 命令时替换。
import type {
  CalScreen,
  CalStepDef,
  CalPoint,
  SurveyReport,
  CalRun,
  MeshMetrics,
  LensStage,
  CalRole,
  CabState,
  CalSev,
  Visual,
} from "./types";

export const CAL_SCREENS: CalScreen[] = [
  { id: "main", name: "主屏 · 前墙", cols: 16, rows: 9, panels: 1024, sub: "Volume A" },
  { id: "ceil", name: "顶屏", cols: 14, rows: 6, panels: 504, sub: "Volume A" },
  { id: "floor", name: "地屏", cols: 12, rows: 8, panels: 576, sub: "Volume A" },
];

export const CAL_STEPS: CalStepDef[] = [
  { id: "design", n: 1, label: "Design", cn: "网格设计", icon: "grid", group: "mesh", status: "done" },
  { id: "method", n: 2, label: "Method", cn: "重建方法", icon: "tools", group: "mesh", status: "done" },
  { id: "survey", n: 3, label: "Survey", cn: "测量导入", icon: "pin", group: "mesh", status: "done" },
  { id: "preview", n: 4, label: "Preview", cn: "网格预览", icon: "cube", group: "mesh", status: "active" },
  { id: "runs", n: 5, label: "Runs", cn: "重建历史", icon: "list", group: "mesh", status: "ready" },
  { id: "lens", n: 6, label: "Lens", cn: "镜头校正", icon: "camera", group: "lens", status: "pending" },
];

export const STEP_DETAIL: Record<string, string> = {
  design: "编辑 Cabinet 网格 — 遮罩、基线与参考点，定义重建范围与坐标系",
  method: "选择重建方法：M1 全站仪 或 M2 视觉（ChArUco + BA）",
  survey: "导入测量数据并核对：measured / fabricated / outlier / missing",
  preview: "检查重建网格 — 拓扑、顶点与质量偏差，旋转查看曲率",
  runs: "历史重建记录，按 RMS 与目标筛选，可展开报告",
  lens: "镜头校正：Validate → Detect → Solve → Report（7-DOF 变换）",
};

export const CAL_POINTS: CalPoint[] = [
  { id: "p_org", name: "REF_origin", role: "origin", xyz: [0.0, 0.0, 0.0], measured: true, sigma: 0.4, err: 0.31 },
  { id: "p_x", name: "REF_x_axis", role: "x_axis", xyz: [4.812, 0.004, -0.002], measured: true, sigma: 0.5, err: 0.44 },
  { id: "p_xy", name: "REF_xy_plane", role: "xy_plane", xyz: [4.806, 2.701, 0.011], measured: true, sigma: 0.6, err: 0.52 },
  { id: "p_01", name: "SURV_0142", role: null, xyz: [1.204, 1.882, 0.021], measured: true, sigma: 0.7, err: 0.58 },
  { id: "p_02", name: "SURV_0143", role: null, xyz: [2.418, 1.886, 0.018], measured: true, sigma: 0.7, err: 0.62 },
  { id: "p_03", name: "SURV_0211", role: null, xyz: [3.64, 2.61, 0.15], measured: false, sigma: 2.8, err: 2.41 },
  { id: "p_04", name: "SURV_0212", role: null, xyz: [3.012, 0.402, 0.009], measured: true, sigma: 0.8, err: 0.71 },
];

export const SURVEY_REPORT: SurveyReport = {
  measured: 1012,
  fabricated: 8,
  outlier: 3,
  missing: 1,
  warnings: [
    { lv: "warn", msg: "SURV_0211 偏差 2.41 mm，超出 2.0 mm 阈值，已标记离群" },
    { lv: "warn", msg: "1 个面板角点缺失，将由相邻面板插值填补" },
    { lv: "info", msg: "8 个点来自制造数据（fabricated），未实测" },
  ],
};

export const CAL_RUNS: CalRun[] = [
  { id: "r6", created: "今天 14:21", screen: "主屏 · 前墙", method: "M2 视觉", rms: 0.42, vertices: 33800, target: "mesh_v6", obj: true, metrics: { mid_max: 0.81, mid_mean: 0.29, est_rms: 0.42, est_p95: 0.74 } },
  { id: "r5", created: "今天 11:08", screen: "主屏 · 前墙", method: "M1 全站仪", rms: 2.9, vertices: 33800, target: "mesh_v5", obj: true, metrics: { mid_max: 5.12, mid_mean: 1.84, est_rms: 2.9, est_p95: 4.61 } },
  { id: "r4", created: "昨天 18:52", screen: "顶屏", method: "M1 全站仪", rms: 6.4, vertices: 16600, target: "mesh_v4", obj: true, metrics: { mid_max: 11.8, mid_mean: 4.12, est_rms: 6.4, est_p95: 9.92 } },
  { id: "r3", created: "昨天 16:30", screen: "地屏", method: "M2 视觉", rms: 9.1, vertices: 18900, target: "mesh_v3", obj: false, metrics: { mid_max: 18.4, mid_mean: 6.71, est_rms: 9.1, est_p95: 14.2 } },
  { id: "r2", created: "昨天 09:14", screen: "主屏 · 前墙", method: "M2 视觉", rms: null, vertices: 0, target: "mesh_v2", obj: false, metrics: null },
];

export const MESH_METRICS: MeshMetrics = {
  mid_max: 0.81,
  mid_mean: 0.29,
  est_rms: 0.42,
  est_p95: 0.74,
  vertices: 33800,
  cols: 64,
  rows: 16,
};

export const LENS_STAGES: LensStage[] = [
  { id: "validate", n: 1, label: "Validate", cn: "校验", status: "done" },
  { id: "detect", n: 2, label: "Detect", cn: "检测", status: "done" },
  { id: "solve", n: 3, label: "Solve", cn: "求解", status: "pending" },
  { id: "report", n: 4, label: "Report", cn: "报告", status: "pending" },
];

export const ROLE: Record<CalRole, { label: string; short: string; color: string }> = {
  origin: { label: "origin", short: "O", color: "var(--positive-visual)" },
  x_axis: { label: "x_axis", short: "X", color: "var(--volo-700)" },
  xy_plane: { label: "xy_plane", short: "XY", color: "var(--informative-visual)" },
};

export const CAB_STATE: Record<CabState, string> = {
  normal: "正常",
  masked: "遮罩",
  below: "基线以下",
  ref: "参考点",
};

export const SEVCAL: Record<CalSev, { visual: Visual; icon: string }> = {
  healthy: { visual: "positive", icon: "check" },
  warning: { visual: "notice", icon: "alert" },
  critical: { visual: "negative", icon: "alert" },
};
