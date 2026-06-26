// Volo · Calibrate —— 类型定义（LED 网格重建 → 镜头校正）。移植自原型 page_calibrate.jsx / data.jsx 的 CAL_* 段。

export type CalStep = "design" | "method" | "survey" | "preview" | "runs" | "lens";
export type CalMethod = "m1" | "m2";
export type CalRole = "origin" | "x_axis" | "xy_plane";
export type CabState = "normal" | "masked" | "below" | "ref";
export type CalSev = "healthy" | "warning" | "critical";
export type Visual = "positive" | "notice" | "negative" | "neutral" | "informative" | "accent";

export interface CalScreen {
  id: string;
  name: string;
  cols: number;
  rows: number;
  panels: number;
  sub: string;
}

export interface CalStepDef {
  id: CalStep;
  n: number;
  label: string;
  cn: string;
  icon: string;
  group: "mesh" | "lens";
  status: "done" | "active" | "ready" | "pending";
}

export interface CalPoint {
  id: string;
  name: string;
  role: CalRole | null;
  xyz: [number, number, number];
  measured: boolean;
  sigma: number;
  err: number;
}

export interface SurveyWarning {
  lv: "warn" | "info";
  msg: string;
}

export interface SurveyReport {
  measured: number;
  fabricated: number;
  outlier: number;
  missing: number;
  warnings: SurveyWarning[];
}

export interface RunMetrics {
  mid_max: number;
  mid_mean: number;
  est_rms: number;
  est_p95: number;
}

export interface CalRun {
  id: string;
  created: string;
  screen: string;
  method: string;
  rms: number | null;
  vertices: number | null;
  target: string;
  obj: boolean;
  metrics: RunMetrics | null;
}

export interface MeshMetrics {
  mid_max: number;
  mid_mean: number;
  est_rms: number;
  est_p95: number;
  vertices: number;
  cols: number;
  rows: number;
}

export interface LensStage {
  id: string;
  n: number;
  label: string;
  cn: string;
  status: "done" | "active" | "pending";
}

// Inspector 选择对象（判别联合）。
export type CalSelection =
  | { type: "cabinet"; col: number; row: number; state: CabState; role: CalRole | null }
  | { type: "cabinetMulti"; count: number; bd: Record<CabState, number> }
  | { type: "point"; id: string }
  | { type: "run"; id: string };
