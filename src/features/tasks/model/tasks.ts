/* 任务（设计：TaskList.dc.html / Tasks.dc.html）。
   后端没有统一的任务表：这里把各处已有的运行记录拼成一张列表——
   巡检（scan_runs）、PSO 预热（pso_warmup_runs）、重建（mesh 库 runs）、镜头标定（lens-captures 会话）、
   AR 空间求解（ar-runs），再加上本次会话里正在跑 / 刚失败的任务。
   编号用各自记录的 id（没有统一编号）；没有分步记录、日志的类型就不画步骤。 */
import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { listHealthResultsForRun, listMachines, listProjects, listPsoWarmupRuns, listRecentHealthRuns } from "@/api/commands";
import { isTauri } from "@/api/invoke";
import type { Machine, PsoWarmupRun, ScanRun } from "@/api/types";
import type { ObjectTab, PageId } from "@/lib/nav";
import { useArJobs, useArRuns, runLabel, runTab as arRunTab, isLowConf, CONF_LABEL, cancelSpatial, type ArRunSummary, type SpatialJob } from "@/features/ar";
import { parseTs } from "@/features/cache";
import { baseName, camTab, rebuildRunTab, runSource, useCapture, useLensSessions, useRebuildJobs, useRuns } from "@/features/led";
import { useCurrentStage } from "@/features/stage";

export type TaskState = "running" | "queued" | "failed" | "success";
export type TaskScope = "stage" | "cluster";

export const TASK_STATE_LABEL: Record<TaskState, string> = { running: "运行中", queued: "排队", failed: "失败", success: "成功" };
export const TASK_STATE_ORDER: TaskState[] = ["running", "queued", "failed", "success"];

export interface TaskStep {
  key: string;
  label: string;
  state: TaskState | "offline";
  stateLabel: string;
  end?: string | null;
}

export interface TaskLog {
  lvl: "INFO" | "WARN" | "ERR";
  text: string;
  at?: number | null;
}

export interface TaskProp {
  label: string;
  value: string | null;
  mono?: boolean;
  num?: boolean;
}

export interface TaskRow {
  /** 列表 / 页签里的 id：`health:12`、`pso:3`、`rebuild:5`、`lens:<dir>`、`ar:<run>`、`job:<key>`。 */
  id: string;
  no: string | null;
  title: string;
  /** Inspector 标题（短一点的对象名）。 */
  short: string;
  tag: string;
  scope: TaskScope;
  state: TaskState;
  stateLabel: string;
  /** 列表倒数第三列：进度或结论。 */
  progress: string | null;
  meter: { value: number; max: number; text: string; label: string } | null;
  startedAt: number | null;
  durationMs: number | null;
  /** 详情页头部的一句话现状。 */
  summary: string | null;
  steps: TaskStep[] | null;
  log: TaskLog[];
  props: TaskProp[];
  /** “打开”跳到的对象。 */
  target: { page: PageId; tab?: ObjectTab; label: string } | null;
  /** 巡检：详情里按需读每台机器的结果。 */
  healthRunId?: number;
  cancel?: () => Promise<void>;
}

export const taskKeys = {
  health: ["tasks", "health"] as const,
  healthRows: (id: number) => ["tasks", "health", id] as const,
  projects: ["cache", "projects"] as const,
  machines: ["cache", "machines"] as const,
  pso: (projectId: number) => ["tasks", "pso", projectId] as const,
};

/* ------------------------------ 时间 ------------------------------ */

export function tsMs(ts: string | null | undefined): number | null {
  if (!ts) return null;
  return parseTs(ts)?.getTime() ?? null;
}

export function dur(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 列表时间：今天 14:31；昨天 22:40；更早 11-23 09:12。 */
export function shortAt(ms: number | null): string {
  if (ms == null) return "—";
  const d = new Date(ms);
  const now = new Date();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (diff === 0) return hm;
  if (diff === 1) return `昨天 ${hm}`;
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
}

/** 完整时间：2026-11-25 14:40:12 UTC+8。 */
export function fullAt(ms: number | null): string | null {
  if (ms == null) return null;
  const d = new Date(ms);
  const off = -d.getTimezoneOffset() / 60;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} UTC${off >= 0 ? "+" : ""}${off}`;
}

/* ------------------------------ 巡检 ------------------------------ */

interface HealthSummary {
  healthy?: number;
  warning?: number;
  critical?: number;
  offline?: number;
  skipped?: number;
  total?: number;
}

function healthTask(r: ScanRun): TaskRow | null {
  if (r.id == null) return null;
  const s = (r.summary ?? {}) as HealthSummary;
  const n = r.machine_ids.length || s.total || 0;
  const bad = (s.critical ?? 0) + (s.warning ?? 0);
  const off = s.offline ?? 0;
  const running = !r.finished_at;
  const startedAt = tsMs(r.started_at);
  const finishedAt = tsMs(r.finished_at);
  const parts = [bad ? `${bad} 台未通过` : null, off ? `${off} 台离线` : null].filter(Boolean);
  const progress = running ? "巡检中" : parts.length ? parts.join(" · ") : "全部通过";
  return {
    id: `health:${r.id}`,
    no: `#${r.id}`,
    title: `巡检 ${n} 台机器`,
    short: `巡检 ${n} 台机器`,
    tag: "机器",
    scope: "cluster",
    state: running ? "running" : "success",
    stateLabel: running ? "运行中" : "成功",
    progress,
    meter: null,
    startedAt,
    durationMs: startedAt != null && finishedAt != null ? finishedAt - startedAt : null,
    summary: running ? "正在巡检" : progress,
    steps: null,
    log: [],
    props: [
      { label: "类型", value: "健康巡检" },
      { label: "机器", value: `${n} 台`, num: true },
      { label: "通过", value: s.healthy != null ? `${s.healthy} 台` : null, num: true },
      { label: "未通过", value: s.critical != null || s.warning != null ? `${bad} 台` : null, num: true },
      { label: "离线", value: s.offline != null ? `${off} 台` : null, num: true },
      { label: "跳过", value: s.skipped != null ? `${s.skipped} 台` : null, num: true },
      { label: "开始", value: fullAt(startedAt), num: true },
      { label: "结束", value: fullAt(finishedAt), num: true },
    ],
    target: { page: "machines", label: "机器" },
    healthRunId: r.id,
  };
}

/** 巡检详情：每台机器一步。 */
export function useHealthSteps(runId: number | undefined, machines: Machine[] | undefined): TaskStep[] | null {
  const q = useQuery({ queryKey: taskKeys.healthRows(runId ?? -1), queryFn: () => listHealthResultsForRun(runId as number), enabled: isTauri() && runId != null, staleTime: 30_000 });
  return useMemo(() => {
    if (runId == null || !q.data) return null;
    return q.data.map((row) => {
      const host = machines?.find((m) => m.id === row.machine_id)?.hostname ?? `#${row.machine_id}`;
      const outcomes = row.machine_results && typeof row.machine_results === "object" ? Object.values(row.machine_results as Record<string, { status?: string }>) : [];
      const st = outcomes.map((o) => (o?.status ?? "").toLowerCase());
      const fails = st.filter((x) => x === "critical" || x === "warning").length;
      const offline = st.length > 0 && st.every((x) => x === "offline");
      const state: TaskStep["state"] = offline ? "offline" : fails ? "failed" : "success";
      return {
        key: String(row.machine_id),
        label: host,
        state,
        stateLabel: offline ? "离线" : fails ? "未通过" : "通过",
        end: offline ? "连不上" : fails ? `${fails} 项未通过` : `${st.length} 项通过`,
      };
    });
  }, [runId, q.data, machines]);
}

/* ------------------------------ PSO 预热 ------------------------------ */

const PSO_STATE: Record<PsoWarmupRun["status"], [TaskState, string]> = {
  running: ["running", "运行中"],
  ok: ["success", "成功"],
  err: ["failed", "失败"],
  cancelled: ["failed", "已取消"],
  not_ready: ["failed", "失败"],
};

function psoTask(r: PsoWarmupRun, projectName: string, host: string): TaskRow | null {
  if (r.id == null) return null;
  const [state, stateLabel] = PSO_STATE[r.status] ?? ["success", "成功"];
  const startedAt = tsMs(r.started_at);
  const verdict =
    r.status === "running"
      ? "预热中"
      : r.status === "err"
        ? (r.error_message ?? "出错")
        : r.status === "cancelled"
          ? "已取消"
          : r.status === "not_ready"
            ? `验证段仍有 ${r.verify_hitch_count ?? "?"} 次卡顿`
            : r.verify_hitch_count === 0
              ? "验证段无卡顿"
              : "完成";
  const log: TaskLog[] = r.error_message ? [{ lvl: "ERR", text: r.error_message, at: null }] : [];
  return {
    id: `pso:${r.id}`,
    no: `#${r.id}`,
    title: `PSO 预热 · ${projectName} · ${host}`,
    short: `PSO 预热 · ${projectName}`,
    tag: "PSO 预热",
    scope: "cluster",
    state,
    stateLabel,
    progress: verdict,
    meter: null,
    startedAt,
    durationMs: r.duration_secs != null ? r.duration_secs * 1000 : null,
    summary: verdict,
    steps: null,
    log,
    props: [
      { label: "工程", value: projectName },
      { label: "机器", value: host, mono: true },
      { label: "分辨率", value: `${r.resolution_w} × ${r.resolution_h}`, num: true },
      { label: "方式", value: r.traversal ? `${r.mode} · 遍历扫场` : r.mode },
      { label: "时长上限", value: `${r.max_minutes} 分钟`, num: true },
      { label: "预跑卡顿", value: r.hitch_count != null ? `${r.hitch_count} 次` : null, num: true },
      { label: "验证卡顿", value: r.verify_hitch_count != null ? `${r.verify_hitch_count} 次` : null, num: true },
      { label: "开始", value: fullAt(startedAt), num: true },
      { label: "耗时", value: r.duration_secs != null ? dur(r.duration_secs * 1000) : null, num: true },
    ],
    target: { page: "pso", label: "PSO 预热" },
  };
}

/* ------------------------------ 舞台：重建 / 标定 / 空间求解 ------------------------------ */

function arTask(r: ArRunSummary): TaskRow {
  const at = tsMs(r.timestamp) ?? (r.timestamp ? Date.parse(r.timestamp) : null);
  const low = isLowConf(r.confidence);
  const rms = r.reprojection_rms_px != null ? `RMS ${r.reprojection_rms_px.toFixed(2)} px` : null;
  const progress = [rms, low ? "观测不足" : null].filter(Boolean).join("，") || null;
  return {
    id: `ar:${r.id}`,
    no: runLabel(r).startsWith("#") ? runLabel(r) : null,
    title: `空间求解 ${runLabel(r)}${r.num_poses != null ? ` · ${r.num_poses} 个机位` : ""}`,
    short: `空间求解 ${runLabel(r)}`,
    tag: "空间求解",
    scope: "stage",
    state: "success",
    stateLabel: "成功",
    progress,
    meter: null,
    startedAt: Number.isFinite(at) ? at : null,
    durationMs: null,
    summary: progress,
    steps: null,
    log: [],
    props: [
      { label: "求解", value: r.id, mono: true },
      { label: "机位", value: r.num_poses != null ? `${r.num_poses} 个` : null, num: true },
      { label: "留出验证", value: r.holdout_poses != null ? `${r.holdout_poses} 个` : null, num: true },
      { label: "重投影", value: rms, num: true },
      { label: "验证残差", value: r.validation_rms_px != null ? `${r.validation_rms_px.toFixed(2)} px` : null, num: true },
      { label: "置信度", value: r.confidence ? (CONF_LABEL[r.confidence] ?? r.confidence) : null },
      { label: "完成", value: fullAt(Number.isFinite(at) ? at : null), num: true },
    ],
    target: { page: "spatial", tab: arRunTab(r), label: "空间求解" },
  };
}

function spatialJobTask(j: SpatialJob): TaskRow {
  return {
    id: `job:${j.key}`,
    no: `#${j.no}`,
    title: `空间求解 #${j.no}`,
    short: `空间求解 #${j.no}`,
    tag: "空间求解",
    scope: "stage",
    state: j.state,
    stateLabel: TASK_STATE_LABEL[j.state],
    progress: j.text,
    meter: null,
    startedAt: j.startedAt,
    durationMs: (j.finishedAt ?? Date.now()) - j.startedAt,
    summary: j.text,
    steps: null,
    log: j.state === "failed" ? [{ lvl: "ERR", text: j.text, at: j.finishedAt ?? null }] : [],
    props: [
      { label: "类型", value: "AR 空间求解" },
      { label: "开始", value: fullAt(j.startedAt), num: true },
      { label: "发起", value: "手动 · 来自“空间求解”页" },
    ],
    target: { page: "spatial", label: "空间求解" },
    cancel: j.state === "running" && j.task ? () => cancelSpatial(j) : undefined,
  };
}

/* ------------------------------ 汇总 ------------------------------ */

export function useTasks() {
  const on = isTauri();
  const { stage } = useCurrentStage();
  const path = stage?.path ?? null;
  const health = useQuery({ queryKey: taskKeys.health, queryFn: () => listRecentHealthRuns(30), enabled: on });
  const projects = useQuery({ queryKey: taskKeys.projects, queryFn: listProjects, enabled: on });
  const machines = useQuery({ queryKey: taskKeys.machines, queryFn: listMachines, enabled: on });
  const pso = useQueries({ queries: (projects.data ?? []).map((p) => ({ queryKey: taskKeys.pso(p.id), queryFn: () => listPsoWarmupRuns(p.id), enabled: on })) });
  const runs = useRuns(path);
  const lens = useLensSessions(path);
  const ar = useArRuns(path);
  const rebuildJobs = useRebuildJobs((s) => s.jobs);
  const spatialJobs = useArJobs((s) => s.spatial);
  const capture = useCapture();
  const psoData = pso.map((q) => q.data);

  const rows = buildRows();
  function buildRows(): TaskRow[] {
    const out: TaskRow[] = [];
    const host = (id: number) => machines.data?.find((m) => m.id === id)?.hostname ?? `#${id}`;
    for (const r of health.data ?? []) {
      const t = healthTask(r);
      if (t) out.push(t);
    }
    (projects.data ?? []).forEach((p, i) => {
      for (const r of psoData[i] ?? []) {
        const t = psoTask(r, p.display_name || p.uproject_name, host(r.machine_id));
        if (t) out.push(t);
      }
    });
    if (stage) {
      const cams = stage.config?.cameras ?? [];
      for (const r of runs.data ?? []) {
        const at = tsMs(r.created_at) ?? Date.parse(r.created_at);
        const src = runSource(r);
        const rms = r.estimated_rms_mm != null ? `RMS ${r.estimated_rms_mm.toFixed(2)} mm` : null;
        out.push({
          id: `rebuild:${r.id}`,
          no: `#${r.id}`,
          title: `重建 ${r.screen_id} · ${src}`,
          short: `重建 ${r.screen_id}`,
          tag: "重建",
          scope: "stage",
          state: "success",
          stateLabel: "成功",
          progress: rms,
          meter: null,
          startedAt: Number.isFinite(at) ? at : null,
          durationMs: null,
          summary: [rms, r.is_current ? "当前采用" : null].filter(Boolean).join(" · ") || null,
          steps: null,
          log: [],
          props: [
            { label: "对象", value: `重建 #${r.id} · ${r.screen_id}` },
            { label: "来源", value: src },
            { label: "插值", value: r.method, mono: true },
            { label: "残差", value: rms, num: true },
            { label: "顶点", value: String(r.vertex_count), num: true },
            { label: "采用", value: r.is_current ? "当前采用" : "未采用" },
            { label: "网格", value: r.output_obj_path ? baseName(r.output_obj_path) : null, mono: true },
            { label: "完成", value: fullAt(Number.isFinite(at) ? at : null), num: true },
          ],
          target: { page: "rebuild", tab: rebuildRunTab(r), label: "重建" },
        });
      }
      for (const s of lens.data ?? []) {
        const cam = cams.find((c) => c.id === s.camera_id);
        const camName = cam ? cam.name : (s.camera_id ?? "未知摄影机");
        const at = tsMs(s.modified_at) ?? (s.modified_at ? Date.parse(s.modified_at) : null);
        const failed = !!s.error;
        const done = !!s.lens_json;
        out.push({
          id: `lens:${s.id}`,
          no: null,
          title: `镜头标定 · ${camName}`,
          short: `镜头标定 · ${camName}`,
          tag: "摄影机",
          scope: "stage",
          state: failed ? "failed" : "success",
          stateLabel: failed ? "失败" : "成功",
          progress: failed ? (s.error ?? "记录损坏") : done ? (s.poses_captured != null ? `${s.poses_captured} 帧` : "已求解") : "只有采集，没有求解",
          meter: null,
          startedAt: at != null && Number.isFinite(at) ? at : null,
          durationMs: null,
          summary: failed ? s.error ?? null : done ? "已求解" : "只有采集，没有求解",
          steps: null,
          log: failed && s.error ? [{ lvl: "ERR", text: s.error, at: null }] : [],
          props: [
            { label: "摄影机", value: camName },
            { label: "方法", value: s.mode === "tracked" ? "跟踪机位" : "单次校正（固定机位）" },
            { label: "采集", value: s.poses_captured != null ? `${s.poses_captured} 帧` : null, num: true },
            { label: "会话", value: s.id, mono: true },
            { label: "结果", value: s.lens_json ? baseName(s.lens_json) : null, mono: true },
            { label: "完成", value: fullAt(at != null && Number.isFinite(at) ? at : null), num: true },
          ],
          target: cam ? { page: "camera", tab: camTab(cam), label: "摄影机" } : { page: "camera", label: "摄影机" },
        });
      }
      for (const r of ar.data ?? []) out.push(arTask(r));
      for (const j of rebuildJobs) {
        out.push({
          id: `job:${j.key}`,
          no: null,
          title: `重建 ${j.screen} · ${j.method}`,
          short: `重建 ${j.screen}`,
          tag: "重建",
          scope: "stage",
          state: j.state,
          stateLabel: TASK_STATE_LABEL[j.state],
          progress: j.text,
          meter: null,
          startedAt: j.startedAt,
          durationMs: (j.finishedAt ?? Date.now()) - j.startedAt,
          summary: j.text,
          steps: null,
          log: j.state === "failed" ? [{ lvl: "ERR", text: j.text, at: j.finishedAt ?? null }] : [],
          props: [
            { label: "屏幕", value: j.screen, mono: true },
            { label: "来源", value: j.method },
            { label: "开始", value: fullAt(j.startedAt), num: true },
            { label: "发起", value: "手动 · 来自“重建”页" },
          ],
          target: { page: "rebuild", label: "重建" },
        });
      }
      for (const j of spatialJobs) out.push(spatialJobTask(j));
      if (capture.phase !== "idle" && capture.phase !== "done" && capture.startedAt) {
        const cam = cams.find((c) => c.id === capture.camId);
        const camName = cam?.name ?? "摄影机";
        const failed = capture.phase === "failed";
        const phase = capture.phase === "preparing" ? "准备" : capture.phase === "capturing" ? "采集" : capture.phase === "solving" ? "求解" : "失败";
        out.push({
          id: "job:lens-capture",
          no: null,
          title: `镜头标定 · ${camName} · ${phase}中`,
          short: `镜头标定 · ${camName}`,
          tag: "摄影机",
          scope: "stage",
          state: failed ? "failed" : "running",
          stateLabel: failed ? "失败" : "运行中",
          progress: failed ? (capture.error ?? "失败") : `${capture.snaps.length} / ${capture.target || "?"} 帧`,
          meter: !failed && capture.target ? { value: capture.snaps.length, max: capture.target, text: `${capture.snaps.length} / ${capture.target} 帧`, label: phase } : null,
          startedAt: capture.startedAt,
          durationMs: Date.now() - capture.startedAt,
          summary: failed ? capture.error : `${phase}中`,
          steps: [
            { key: "prep", label: "1 · 准备图案与信号", state: capture.phase === "preparing" ? "running" : "success", stateLabel: capture.phase === "preparing" ? "运行中" : "成功" },
            { key: "cap", label: "2 · 采集", state: capture.phase === "capturing" ? "running" : capture.phase === "preparing" ? "queued" : "success", stateLabel: capture.phase === "capturing" ? "运行中" : capture.phase === "preparing" ? "排队" : "成功", end: `${capture.snaps.length} 帧` },
            { key: "solve", label: "3 · 求解", state: capture.phase === "solving" ? "running" : failed ? "failed" : "queued", stateLabel: capture.phase === "solving" ? "运行中" : failed ? "失败" : "排队" },
          ],
          log: failed && capture.error ? [{ lvl: "ERR", text: capture.error, at: null }] : capture.warning ? [{ lvl: "WARN", text: capture.warning, at: null }] : [],
          props: [
            { label: "摄影机", value: camName },
            { label: "开始", value: fullAt(capture.startedAt), num: true },
            { label: "发起", value: "手动 · 来自“摄影机”页" },
          ],
          target: cam ? { page: "camera", tab: camTab(cam), label: "摄影机" } : { page: "camera", label: "摄影机" },
        });
      }
    }
    return out.sort((a, b) => TASK_STATE_ORDER.indexOf(a.state) - TASK_STATE_ORDER.indexOf(b.state) || (b.startedAt ?? 0) - (a.startedAt ?? 0));
  }

  const loading = on && (health.isLoading || projects.isLoading);
  const fetching = health.isFetching || pso.some((q) => q.isFetching) || runs.isFetching || lens.isFetching || ar.isFetching;
  const refetch = () => {
    void health.refetch();
    void projects.refetch();
    pso.forEach((q) => void q.refetch());
    void runs.refetch();
    void lens.refetch();
    void ar.refetch();
  };
  return { rows, loading, fetching, refetch, machines: machines.data, updatedAt: health.dataUpdatedAt || null, error: on ? health.error : new Error("浏览器预览没有后端：在原生 App 里打开才能读到任务") };
}
