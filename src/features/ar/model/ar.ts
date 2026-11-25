/* 舞台 AR：标记真值（marker map）→ 摄影机延迟 → 空间求解（vpcal quick run）→ 验证叠加。
   project.yaml 里没有 AR 字段，所以每个 Stage 的 AR 工作区（真值文件、session 配置、求解目录、
   当前采用的求解、最近一次校验 / 延迟 / 验证结果）按 Stage 路径存在本机。
   求解记录不另建注册表：扫 <stage>/vpcal/ar-runs/ 下每个 run-NNN-<时间>/result.json（list_ar_runs）。
   所有 vpcal 命令都走流式子进程：verify overlay 的标注帧只有经流式通道解析出来才进图片白名单。 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { listArRuns, readArRun, readMarkerMap, type ArRunSummary } from "@/api/commands";
import { isTauri } from "@/api/invoke";
import { readImageAsDataUrl } from "@/api/lensCommands";
import { lensWorkspacePaths } from "@/api/lensWorkspace";
import { cancelSidecarTask, listenSidecarStream, spawnSidecarStreaming } from "@/api/sidecarStream";
import { persistOptions } from "@/lib/persist";

export type { ArRunSummary };

/** 验证叠加里平均偏差超过它就算需处理（px）。 */
export const VERIFY_LIMIT_PX = 1.0;
/** 验证叠加最多出几帧标注图。 */
export const VERIFY_FRAMES = 8;

export const arKeys = {
  runs: (root: string) => ["ar", "runs", root] as const,
  run: (resultPath: string) => ["ar", "run", resultPath] as const,
  map: (path: string) => ["ar", "marker-map", path] as const,
  frames: (key: string) => ["ar", "frames", key] as const,
};

/* ------------------------------ 路径 ------------------------------ */

const sepOf = (p: string) => (p.includes("\\") ? "\\" : "/");
export const joinPath = (dir: string, ...names: string[]) => names.reduce((d, n) => d.replace(/[\\/]+$/, "") + sepOf(dir) + n, dir);
export const baseName = (p: string | null | undefined) => (p ? (p.split(/[\\/]+/).filter(Boolean).pop() ?? p) : "");
export const dirOf = (p: string | null | undefined) => (p ? p.replace(/[\\/][^\\/]*$/, "") : null);
export const arRunsRoot = (stagePath: string) => joinPath(lensWorkspacePaths(stagePath).vpcalDir, "ar-runs");
export const arDelayDir = (stagePath: string) => joinPath(lensWorkspacePaths(stagePath).vpcalDir, "ar-delay");
export const markersDir = (stagePath: string) => joinPath(stagePath, "markers");

/** 把用户目录缩成 ~（只为显示）。 */
export function tildePath(p: string) {
  const m = p.match(/^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(.*)$/);
  return m ? `~${m[2]}` : p;
}

const stamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/* ------------------------------ 时间 ------------------------------ */

const toDate = (ts: string | number) => (typeof ts === "number" ? new Date(ts) : new Date(ts.includes("T") || ts.endsWith("Z") ? ts : ts.replace(" ", "T")));

export function shortTime(ts: string | number): string {
  const d = toDate(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  const now = new Date();
  const hm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff === 0) return hm;
  if (diff === 1) return `昨天 ${hm}`;
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hm}`;
}

/** 2026-11-25 15:02:40 UTC+8 */
export function fullTime(ts: string | number): string {
  const d = toDate(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset() / 60;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} UTC${off >= 0 ? "+" : ""}${+off.toFixed(1)}`;
}

export function dur(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/* ------------------------------ vpcal 结果结构 ------------------------------ */

export interface MarkerDef {
  marker_id: string;
  marker_type: string;
  dictionary?: string | null;
  tag_id?: number | null;
  corners_stage_mm?: number[][] | null;
  center_stage_mm?: number[] | null;
  size_mm?: number | null;
  normal?: number[] | null;
  on_ground?: boolean;
  uncertainty_mm?: number | null;
  survey_source?: string | null;
}
export interface MarkerMap {
  name?: string | null;
  frame_name?: string;
  markers: MarkerDef[];
  rebase_history?: unknown[];
}

export interface ValidateData {
  validation: { num_markers: number; num_detectable: number; num_points: number; span_mm: number; collinearity_ratio: number; num_ground_markers: number; warnings: string[] };
  ground_plane: {
    available: boolean;
    num_ground_markers: number;
    reason?: string;
    residual_rms_mm?: number;
    tilt_from_z_deg?: number;
    offset_from_z0_mm?: number;
    tolerance_deg?: number;
    warnings?: string[];
  };
  world_alignment: { grade: string; max_uncertainty_mm: number | null; by_source: Record<string, { count: number; max_uncertainty_mm: number | null }> };
}

export interface LensParam {
  value: number;
  std?: number | null;
  observable?: boolean;
  locked_reason?: string | null;
}
export interface RunResult {
  timestamp?: string;
  quality?: {
    reprojection_rms_px?: number;
    validation_rms_px?: number | null;
    num_poses?: number;
    total_observations?: number;
    inlier_observations?: number;
    confidence?: string;
    warnings?: string[];
    lens_estimate?: {
      focal_length_mm?: LensParam | null;
      principal_point_offset_mm?: [LensParam, LensParam] | null;
      distortion_k1?: LensParam | null;
      distortion_k2?: LensParam | null;
      spatial_only_rms_px?: number;
      refined_rms_px?: number;
      confidence?: string;
      identifiability_flags?: string[];
    } | null;
  };
  inputs?: { image_count?: number; screen_definition?: string };
  solver_diagnostics?: { solver_backend?: string; num_outliers?: number };
}
export interface RunQa {
  validation?: { holdout_frames?: number[]; validation_rms_px?: number | null };
  coverage?: { sensor_coverage?: { percentage?: number }; marker_coverage?: { percentage?: number; missing?: string[] } };
  detection?: { detected_markers?: number; unknown_markers?: number; map_markers_never_detected?: string[] };
  handeye?: { applied?: boolean };
  ground_plane?: ValidateData["ground_plane"];
  world_alignment?: ValidateData["world_alignment"];
  reprojection?: { per_pose?: { frame_id: number; rms_px: number; num_observations: number; quality: string }[] };
}
export interface RunDetail {
  result: RunResult;
  qa: RunQa;
}

export interface DelayCam {
  delay_ms: number;
  sigma_ms: number | null;
  confidence: number;
  num_markers: number;
  num_frames: number;
  search_ms?: number;
  boundary_hit?: boolean;
  low_marker_count?: boolean;
}
export interface DelayData {
  cameras: DelayCam[];
  recommendation?: string;
}
export interface DelayRecord {
  at: number;
  camId: string | null;
  data: DelayData;
  /** delay_profile.json 路径（导出 OpenTrackIO 时用）。 */
  path: string;
  fps: number;
}

export interface VerifyMarker {
  marker_id: string;
  count: number;
  mean_px: number;
  max_px: number;
}
export interface VerifyData {
  global_rms_px: number;
  global_max_px: number;
  num_frames: number;
  num_observations: number;
  per_marker: VerifyMarker[];
  per_frame: { frame_id: number; image: string; num_markers: number; rms_px: number | null; max_px: number | null }[];
  annotated_images: string[];
}

/* ------------------------------ 工作区（按 Stage 存本机） ------------------------------ */

export interface ArWorkspace {
  markerMap: string | null;
  session: string | null;
  /** 当前采用的求解（run 目录名）。 */
  adopted: string | null;
  validate: { at: number; map: string; data: ValidateData } | null;
  delay: DelayRecord[];
  verify: { at: number; runId: string; data: VerifyData } | null;
  /** 本机发起的求解用时（run 目录名 → ms）。 */
  durations: Record<string, number>;
}

const EMPTY_WS: ArWorkspace = { markerMap: null, session: null, adopted: null, validate: null, delay: [], verify: null, durations: {} };

interface WsStore {
  byStage: Record<string, ArWorkspace>;
  patch: (stage: string, p: Partial<ArWorkspace> | ((w: ArWorkspace) => Partial<ArWorkspace>)) => void;
}

export const useArStore = create<WsStore>()(
  persist(
    (set) => ({
      byStage: {},
      patch: (stage, p) =>
        set((s) => {
          const cur = { ...EMPTY_WS, ...s.byStage[stage] };
          return { byStage: { ...s.byStage, [stage]: { ...cur, ...(typeof p === "function" ? p(cur) : p) } } };
        }),
    }),
    persistOptions<WsStore, Pick<WsStore, "byStage">>("ar.workspace", 1, (s) => ({ byStage: s.byStage })),
  ),
);

export function useArWorkspace(stage: string | null): ArWorkspace {
  const w = useArStore((s) => (stage ? s.byStage[stage] : undefined));
  return w ? { ...EMPTY_WS, ...w } : EMPTY_WS;
}
export const getWs = (stage: string): ArWorkspace => ({ ...EMPTY_WS, ...useArStore.getState().byStage[stage] });
export const patchWs = (stage: string, p: Partial<ArWorkspace> | ((w: ArWorkspace) => Partial<ArWorkspace>)) => useArStore.getState().patch(stage, p);

/* ------------------------------ 界面偏好 ------------------------------ */

export type MarkerFilter = "all" | "ground" | "wall" | "missing";
export type SpatialFilter = "all" | "adopted" | "low";
interface ArUi {
  markerInsp: "truth" | "marker" | "activity";
  markerSel: string | null;
  view: "persp" | "top";
  showGround: boolean;
  showLabels: boolean;
  spatialInsp: "result" | "poses" | "activity";
  verifyInsp: "marker" | "export" | "activity";
  verifySel: string | null;
  verifyMode: "overlay" | "plain";
  camTab: "delay" | "lens" | "source" | "history";
  camInsp: "delay" | "activity";
  delaySource: "live" | "recording";
  delaySecs: number;
  /** 已有录制：swing test 的帧目录、同一次的追踪 jsonl、帧率。 */
  delayVideo: string;
  delayTracking: string;
  delayFps: string;
  set: (p: Partial<Omit<ArUi, "set">>) => void;
}
export const useArUi = create<ArUi>()(
  persist(
    (set) => ({
      markerInsp: "truth",
      markerSel: null,
      view: "persp",
      showGround: true,
      showLabels: true,
      spatialInsp: "result",
      verifyInsp: "marker",
      verifySel: null,
      verifyMode: "overlay",
      camTab: "delay",
      camInsp: "delay",
      delaySource: "recording",
      delaySecs: 12,
      delayVideo: "",
      delayTracking: "",
      delayFps: "25",
      set: (p) => set(p),
    }),
    persistOptions("ar.ui", 1, (s: ArUi) => ({ view: s.view, showGround: s.showGround, showLabels: s.showLabels, verifyMode: s.verifyMode, delaySource: s.delaySource, delaySecs: s.delaySecs, delayFps: s.delayFps })),
  ),
);

/* ------------------------------ 活动（本次会话） ------------------------------ */

export interface ArEvent {
  key: string;
  at: number;
  area: "markers" | "spatial" | "verify" | "delay";
  kind: "success" | "failed" | "running" | "info";
  text: string;
}
export const useArLog = create<{ events: ArEvent[] }>()(() => ({ events: [] }));
let seq = 0;
export function logAr(area: ArEvent["area"], kind: ArEvent["kind"], text: string) {
  useArLog.setState((s) => ({ events: [{ key: String(++seq), at: Date.now(), area, kind, text }, ...s.events].slice(0, 100) }));
}

/* ------------------------------ vpcal 流式调用 ------------------------------ */

export class VpcalError extends Error {
  exitCode: number | null;
  constructor(message: string, exitCode: number | null) {
    super(message);
    this.exitCode = exitCode;
  }
}

interface Envelope {
  status?: string;
  data?: unknown;
  error?: { message?: string } | null;
}

/** 跑一条 vpcal 命令（--output json），等它退出，返回最后一个 envelope 的 data。 */
export async function runVpcal<T>(args: string[], onTask?: (taskId: string) => void): Promise<T> {
  const { task_id } = await spawnSidecarStreaming("vpcal", [...args, "--output", "json"]);
  onTask?.(task_id);
  return new Promise<T>((resolve, reject) => {
    let env: Envelope | null = null;
    let off: (() => void) | null = null;
    let done = false;
    void listenSidecarStream(task_id, (ev) => {
      if (ev.kind === "line") {
        const p = ev.parsed as Envelope | undefined;
        if (p && typeof p === "object" && (p.status === "ok" || p.status === "error")) env = p;
        return;
      }
      done = true;
      off?.();
      if (ev.cancelled) return reject(new VpcalError("已取消", null));
      if (env?.status === "ok") return resolve((env.data ?? {}) as T);
      const msg = env?.error?.message || ev.stderr_tail.trim().split("\n").pop() || `vpcal 异常退出（exit ${ev.exit_code}）`;
      reject(new VpcalError(msg, ev.exit_code));
    })
      .then((u) => {
        if (done) u();
        else off = u;
      })
      .catch((e: unknown) => {
        /* 订阅不上就收不到退出事件：停掉进程并报错，免得调用方一直等。 */
        done = true;
        void cancelSidecarTask(task_id).catch(() => undefined);
        reject(new VpcalError(`订阅 vpcal 输出失败：${e instanceof Error ? e.message : String(e)}`, null));
      });
  });
}

/* ------------------------------ 查询 ------------------------------ */

export function useArRuns(stage: string | null) {
  const root = stage ? arRunsRoot(stage) : null;
  return useQuery({
    queryKey: arKeys.runs(root ?? ""),
    enabled: !!root && isTauri(),
    queryFn: async () => {
      try {
        return await listArRuns(root!);
      } catch (e) {
        /* 还没求解过：目录不存在 */
        if (String(e).includes("not a directory")) return [] as ArRunSummary[];
        throw e;
      }
    },
  });
}

export function useArRun(resultPath: string | null | undefined) {
  return useQuery({
    queryKey: arKeys.run(resultPath ?? ""),
    enabled: !!resultPath && isTauri(),
    staleTime: Infinity,
    queryFn: async () => (await readArRun(resultPath!)) as RunDetail,
  });
}

export function useMarkerMap(path: string | null) {
  return useQuery({
    queryKey: arKeys.map(path ?? ""),
    enabled: !!path && isTauri(),
    queryFn: async () => (await readMarkerMap(path!)) as MarkerMap,
  });
}

/** 验证叠加的标注帧（只有本次运行解析出的路径能读）。 */
export function useVerifyFrames(paths: string[]) {
  const key = paths.join("|");
  return useQuery({
    queryKey: arKeys.frames(key),
    enabled: paths.length > 0 && isTauri(),
    staleTime: Infinity,
    retry: false,
    queryFn: () => Promise.all(paths.map((p) => readImageAsDataUrl(p).catch(() => null))),
  });
}

/* ------------------------------ 求解记录 ------------------------------ */

export const runNo = (r: Pick<ArRunSummary, "id">) => {
  const m = r.id.match(/^run-(\d+)/);
  return m ? Number(m[1]) : null;
};
export const runLabel = (r: Pick<ArRunSummary, "id">) => (runNo(r) != null ? `#${runNo(r)}` : r.id);
export const runTab = (r: ArRunSummary) => ({ id: `run:${r.id}`, label: `空间求解 ${runLabel(r)}`, status: "success" as const, statusLabel: "成功" });

export const CONF_LABEL: Record<string, string> = { high: "置信度高", medium: "置信度中", low: "置信度低", very_low: "置信度很低" };
export const isLowConf = (c: string | null | undefined) => c === "low" || c === "very_low";

/** 当前采用：工作区记下的那次；没记过就用最新一次。 */
export function adoptedRun(runs: ArRunSummary[] | undefined, ws: ArWorkspace) {
  if (!runs?.length) return null;
  return runs.find((r) => r.id === ws.adopted) ?? runs[0];
}

export function runTitle(r: ArRunSummary) {
  const poses = r.num_poses != null ? `${r.num_poses} 个机位` : "机位数不详";
  if (r.holdout_poses) return `${poses} · 留出 ${r.holdout_poses} 个做验证`;
  if (isLowConf(r.confidence)) return `${poses} · 观测不足，结果已写入`;
  return `${poses} · 没有留出验证机位`;
}

/* ------------------------------ 进行中的任务（本次会话） ------------------------------ */

export interface SpatialJob {
  key: string;
  /** 发起时的 Stage；会话内任务是全局的，按它过滤，换 Stage 后不串到别的 Stage。 */
  stagePath: string;
  no: number;
  state: "running" | "failed";
  startedAt: number;
  finishedAt?: number;
  task?: string;
  text: string;
}
interface Jobs {
  spatial: SpatialJob[];
  validating: boolean;
  leveling: boolean;
  importing: boolean;
  verifying: boolean;
  exporting: boolean;
  delaying: boolean;
}
export const useArJobs = create<Jobs>()(() => ({ spatial: [], validating: false, leveling: false, importing: false, verifying: false, exporting: false, delaying: false }));

/** 当前 Stage 的会话内空间求解任务。 */
export function useStageSpatialJobs(stage: string | null): SpatialJob[] {
  const jobs = useArJobs((s) => s.spatial);
  return useMemo(() => jobs.filter((j) => j.stagePath === stage), [jobs, stage]);
}

/* ------------------------------ 标记几何 ------------------------------ */

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(...a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** 四角（TL, TR, BR, BL，mm），按 vpcal 的约定由中心 + 边长 + 法线推出（models/marker_map.py resolved_corners）。 */
export function markerCorners(m: MarkerDef): V3[] | null {
  if (m.corners_stage_mm?.length === 4) return m.corners_stage_mm.map((c) => [c[0], c[1], c[2]] as V3);
  if (!m.center_stage_mm || !m.normal || !m.size_mm) return null;
  const c = m.center_stage_mm as V3;
  const n = norm(m.normal as V3);
  let hint: V3 = [0, 0, 1];
  if (Math.abs(dot(n, hint)) > 0.99) hint = [1, 0, 0];
  const up = norm(sub(hint, mul(n, dot(hint, n))));
  const right = cross(up, n);
  const h = m.size_mm / 2;
  return [sub(add(c, mul(up, h)), mul(right, h)), add(add(c, mul(up, h)), mul(right, h)), add(sub(c, mul(up, h)), mul(right, h)), sub(sub(c, mul(up, h)), mul(right, h))];
}

export function markerCenter(m: MarkerDef): V3 | null {
  if (m.center_stage_mm) return m.center_stage_mm as V3;
  const c = markerCorners(m);
  return c ? mul(c.reduce((a, b) => add(a, b), [0, 0, 0] as V3), 1 / 4) : null;
}

export function markerSize(m: MarkerDef): number | null {
  if (m.size_mm) return m.size_mm;
  const c = markerCorners(m);
  return c ? Math.hypot(...sub(c[1], c[0])) : null;
}

/** 显示用编号：末尾数字补到两位（M07 → 07），没有数字就原样。 */
export function markerNo(id: string) {
  const m = id.match(/(\d+)$/);
  return m ? m[1].padStart(2, "0") : id;
}

/** 立面标记按法线朝向粗分墙面（stage 系 X 右 Y 前 Z 上）。 */
export function markerPlace(m: MarkerDef | undefined): string {
  if (!m) return "—";
  if (m.on_ground) return "地面";
  const n = m.normal ?? (() => {
    const c = markerCorners(m);
    return c ? cross(sub(c[1], c[0]), sub(c[3], c[0])) : null;
  })();
  if (!n) return "立面";
  const [x, y] = norm(n as V3);
  if (Math.abs(x) >= Math.abs(y)) return x > 0 ? "立面 · 左墙" : "立面 · 右墙";
  return y < 0 ? "立面 · 后墙" : "立面 · 前墙";
}

/** 参照面（虚线框）：地面一块、每面墙一块，包住该处的标记再放宽一圈；墙面一直延到地面。略退到标记背后，不挡拾取。 */
export function referencePlanes(markers: MarkerDef[]): { key: string; ground: boolean; corners: V3[] }[] {
  const groups = new Map<string, MarkerDef[]>();
  markers.forEach((mk) => groups.set(markerPlace(mk), [...(groups.get(markerPlace(mk)) ?? []), mk]));
  const out: { key: string; ground: boolean; corners: V3[] }[] = [];
  groups.forEach((ms, key) => {
    const cs = ms.flatMap((mk) => markerCorners(mk) ?? []);
    if (!cs.length) return;
    if (key === "地面") {
      const mg = 600;
      const xs = cs.map((c) => c[0]), ys = cs.map((c) => c[1]);
      const z = cs.reduce((a, c) => a + c[2], 0) / cs.length - 5;
      const [x0, x1, y0, y1] = [Math.min(...xs) - mg, Math.max(...xs) + mg, Math.min(...ys) - mg, Math.max(...ys) + mg];
      out.push({ key, ground: true, corners: [[x0, y1, z], [x1, y1, z], [x1, y0, z], [x0, y0, z]] });
      return;
    }
    const mk0 = ms[0];
    const c0 = markerCorners(mk0)!;
    const n = norm(mk0.normal ? (mk0.normal as V3) : cross(sub(c0[1], c0[0]), sub(c0[3], c0[0])));
    let hint: V3 = [0, 0, 1];
    if (Math.abs(dot(n, hint)) > 0.99) hint = [1, 0, 0];
    const up = norm(sub(hint, mul(n, dot(hint, n))));
    const right = cross(up, n);
    const mean = mul(cs.reduce((a, c) => add(a, c), [0, 0, 0] as V3), 1 / cs.length);
    const o = sub(mean, mul(n, 5));
    const rs = cs.map((c) => dot(sub(c, o), right)), us = cs.map((c) => dot(sub(c, o), up));
    const mg = 500;
    const floorU = up[2] > 0.5 ? -o[2] / up[2] : Infinity;
    const [r0, r1, u1] = [Math.min(...rs) - mg, Math.max(...rs) + mg, Math.max(...us) + mg];
    const u0 = Math.min(Math.min(...us) - mg, floorU);
    const at = (r: number, u: number) => add(add(o, mul(right, r)), mul(up, u));
    out.push({ key, ground: false, corners: [at(r0, u1), at(r1, u1), at(r1, u0), at(r0, u0)] });
  });
  return out;
}

/** 标记右边中点（编号贴在这里）。 */
export function markerRightMid(m: MarkerDef): V3 | null {
  const c = markerCorners(m);
  return c ? mul(add(c[1], c[2]), 0.5) : null;
}

export const SOURCE_LABEL: Record<string, string> = { total_station: "全站仪实测", tape: "卷尺量测", cube: "立方体标定", generated: "按打印板生成", undeclared: "没有标注来源" };
export const GRADE_LABEL: Record<string, string> = { millimetre: "毫米级", centimetre: "厘米级", coarse: "粗略", "n/a": "没有声明精度" };

export function groundOver(g: ValidateData["ground_plane"] | undefined | null) {
  return !!(g?.available && g.tilt_from_z_deg != null && g.tolerance_deg != null && g.tilt_from_z_deg > g.tolerance_deg);
}

/* ------------------------------ 动作 ------------------------------ */

export async function validateMap(stage: string, map: string) {
  useArJobs.setState({ validating: true });
  try {
    const data = await runVpcal<ValidateData>(["marker-map", "validate", map]);
    patchWs(stage, { validate: { at: Date.now(), map, data } });
    logAr("markers", "success", `校验 ${baseName(map)} · ${data.validation.num_markers} 个标记`);
    return data;
  } catch (e) {
    logAr("markers", "failed", `校验 ${baseName(map)} 失败：${(e as Error).message}`);
    throw e;
  } finally {
    useArJobs.setState({ validating: false });
  }
}

/** 全站仪 CSV → marker map JSON（写到 <stage>/markers/），设为当前真值并校验。 */
export async function importSurvey(stage: string, csv: string) {
  useArJobs.setState({ importing: true });
  const out = joinPath(markersDir(stage), baseName(csv).replace(/\.[^.]+$/, "") + ".json");
  try {
    await runVpcal(["marker-map", "create", "--from-csv", csv, "--frame-name", "Stage frame · RH · Z up", "--out", out]);
    patchWs(stage, { markerMap: out, validate: null });
    logAr("markers", "success", `导入 ${baseName(csv)} → ${baseName(out)}`);
  } catch (e) {
    logAr("markers", "failed", `导入 ${baseName(csv)} 失败：${(e as Error).message}`);
    throw e;
  } finally {
    useArJobs.setState({ importing: false });
  }
  return validateMap(stage, out);
}

/** 校平到地面：写出 <原名>_leveled.json（原文件不改），改用它并重新校验。 */
export async function levelMap(stage: string, map: string) {
  useArJobs.setState({ leveling: true });
  let out = map.replace(/\.json$/i, "") + "_leveled.json";
  try {
    const data = await runVpcal<{ output?: string; audit?: { tilt_corrected_deg?: number } }>(["marker-map", "rebase", map, "--to-ground", "--out", out]);
    out = data.output ?? out;
    patchWs(stage, { markerMap: out, validate: null });
    logAr("markers", "success", `校平到地面 → ${baseName(out)}${data.audit?.tilt_corrected_deg != null ? `（修正 ${data.audit.tilt_corrected_deg.toFixed(2)}°）` : ""}`);
  } catch (e) {
    logAr("markers", "failed", `校平失败：${(e as Error).message}`);
    throw e;
  } finally {
    useArJobs.setState({ leveling: false });
  }
  return validateMap(stage, out);
}

/** 打印板（AprilTag 36h11 · 0–11）+ 测量模板。返回生成的文件数。 */
export async function generateBoards(outDir: string) {
  const data = await runVpcal<{ boards?: string[]; survey_template?: string }>(["marker-map", "board", "--dict", "DICT_APRILTAG_36h11", "--ids", "0-11", "--out-dir", outDir]);
  logAr("markers", "success", `生成打印板 ${data.boards?.length ?? 0} 张${data.survey_template ? " + 测量模板" : ""} → ${baseName(outDir)}`);
  return data;
}

/** 开始一次空间求解：vpcal quick run，输出到 ar-runs/run-NNN-<时间>/。 */
export async function startSpatialSolve(stage: string, session: string, runs: ArRunSummary[], onDone: () => void) {
  const jobs = useArJobs.getState().spatial.filter((j) => j.stagePath === stage);
  const no = Math.max(0, ...runs.map((r) => runNo(r) ?? 0), ...jobs.map((j) => j.no)) + 1;
  const id = `run-${String(no).padStart(3, "0")}-${stamp()}`;
  const outDir = joinPath(arRunsRoot(stage), id);
  const key = id;
  const startedAt = Date.now();
  const job: SpatialJob = { key, stagePath: stage, no, state: "running", startedAt, text: `用 ${baseName(dirOf(session))} 求解` };
  useArJobs.setState((s) => ({ spatial: [job, ...s.spatial] }));
  logAr("spatial", "running", `开始空间求解 #${no}`);
  const put = (p: Partial<SpatialJob>) => useArJobs.setState((s) => ({ spatial: s.spatial.map((j) => (j.key === key ? { ...j, ...p } : j)) }));
  try {
    await runVpcal(["quick", "run", "--config", session, "--per-marker", "--output-dir", outDir], (task) => put({ task }));
    patchWs(stage, (w) => ({ durations: { ...w.durations, [id]: Date.now() - startedAt } }));
    useArJobs.setState((s) => ({ spatial: s.spatial.filter((j) => j.key !== key) }));
    logAr("spatial", "success", `空间求解 #${no} 完成`);
    onDone();
  } catch (e) {
    const err = e as VpcalError;
    if (err.exitCode == null && err.message === "已取消") {
      useArJobs.setState((s) => ({ spatial: s.spatial.filter((j) => j.key !== key) }));
      logAr("spatial", "info", `取消了空间求解 #${no}`);
      return;
    }
    const why = err.exitCode === 6 ? `前提不满足：${err.message}` : err.message;
    put({ state: "failed", finishedAt: Date.now(), text: why, task: undefined });
    logAr("spatial", "failed", `空间求解 #${no} 失败：${why}`);
  }
}

export async function cancelSpatial(job: SpatialJob) {
  if (job.task) await cancelSidecarTask(job.task);
}

/** 生成验证叠加：把采用的求解投回采集帧。标注图写在该次求解目录的 overlay/ 里。 */
export async function runVerify(stage: string, session: string, run: ArRunSummary) {
  useArJobs.setState({ verifying: true });
  const out = joinPath(dirOf(run.result_path)!, "overlay");
  try {
    const data = await runVpcal<VerifyData>(["verify", "overlay", "--config", session, "--result", run.result_path, "--out", out, "--limit", String(VERIFY_FRAMES)]);
    patchWs(stage, { verify: { at: Date.now(), runId: run.id, data } });
    logAr("verify", "success", `验证叠加 · 基于 ${runLabel(run)} · 全局 RMS ${data.global_rms_px.toFixed(2)} px`);
    return data;
  } catch (e) {
    logAr("verify", "failed", `验证叠加失败：${(e as Error).message}`);
    throw e;
  } finally {
    useArJobs.setState({ verifying: false });
  }
}

/** 导出 OpenTrackIO（UE 坐标系）。delayPath 给了就让 vpcal 先扣掉延迟。 */
export async function exportOpenTrackIO(session: string, run: ArRunSummary, outPath: string, delayPath: string | null) {
  useArJobs.setState({ exporting: true });
  try {
    const args = ["export", "opentrackio", "--result", run.result_path, "--session", session, "--out", outPath, "--frame", "ue"];
    if (delayPath) args.push("--delay-profile", delayPath);
    const data = await runVpcal<{ output: string; samples?: number; applied_delay_ms?: number | null }>(args);
    logAr("verify", "success", `导出 OpenTrackIO · ${baseName(data.output ?? outPath)}${data.samples != null ? ` · ${data.samples} 个样本` : ""}`);
    return data;
  } catch (e) {
    logAr("verify", "failed", `导出失败：${(e as Error).message}`);
    throw e;
  } finally {
    useArJobs.setState({ exporting: false });
  }
}

/** 延迟校准（已有录制）：swing test 的帧目录 + 同一次的追踪 jsonl。 */
export async function runDelayCal(stage: string, o: { session: string; run: ArRunSummary; video: string; tracking: string; fps: number; camId: string | null }) {
  useArJobs.setState({ delaying: true });
  const out = joinPath(arDelayDir(stage), `delay_${stamp()}.json`);
  try {
    const data = await runVpcal<DelayData>(["capture", "delay-cal", "--config", o.session, "--result", o.run.result_path, "--video", o.video, "--tracking", o.tracking, "--fps", String(o.fps), "--out", out]);
    const rec: DelayRecord = { at: Date.now(), camId: o.camId, data, path: out, fps: o.fps };
    patchWs(stage, (w) => ({ delay: [rec, ...w.delay].slice(0, 30) }));
    const c = data.cameras[0];
    logAr("delay", "success", `延迟校准 ${c ? `${c.delay_ms >= 0 ? "+" : ""}${c.delay_ms.toFixed(1)} ms` : "完成"}`);
    return rec;
  } catch (e) {
    const err = e as VpcalError;
    const why = err.exitCode === 6 ? `摄影机动得太少：${err.message}` : err.message;
    logAr("delay", "failed", `延迟校准失败：${why}`);
    throw new VpcalError(why, err.exitCode);
  } finally {
    useArJobs.setState({ delaying: false });
  }
}

/* ------------------------------ 延迟显示 ------------------------------ */

export const signed = (v: number, d = 1) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}`;
export function peakLabel(conf: number) {
  if (conf >= 0.85) return { text: "高", note: "运动幅度足够" };
  if (conf >= 0.6) return { text: "中", note: "运动幅度一般" };
  return { text: "低", note: "动得太少，峰不明显" };
}
export function driftLabel(sigma: number | null) {
  if (sigma == null) return { text: "—", note: "" };
  return { text: sigma.toFixed(1), note: sigma <= 1 ? "稳定" : sigma <= 3 ? "略有波动" : "波动大" };
}
