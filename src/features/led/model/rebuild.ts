/* 舞台 LED · 重建：重建记录（mesh 库 runs 表）、设为当前采用、导出、全站仪导入并重建。
   进行中 / 失败的重建不落库，只有本次会话里发起的才看得到（见 useRebuildJobs）。 */
import { useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import { pickFile } from "@/api/commands";
import { exportObj, importTotalStationCsv, reconstructSurface, setRunCurrent } from "@/api/meshCommands";
import type { ReconstructionReport, ReconstructionRun } from "@/api/types";
import { ledKeys } from "./screens";

export type ExportTarget = "disguise" | "unreal" | "neutral";
export const EXPORT_TARGETS: { value: ExportTarget; label: string; desc: string }[] = [
  { value: "disguise", label: "Disguise", desc: "毫米 · Y 向上" },
  { value: "unreal", label: "Unreal", desc: "厘米 · Z 向上 · 直接导入 nDisplay" },
  { value: "neutral", label: "中性", desc: "米 · 不做引擎转换" },
];

export const runTab = (r: ReconstructionRun) => ({ id: `run:${r.id}`, label: `重建 #${r.id} ${r.screen_id}`, status: "success" as const, statusLabel: "成功" });

export function useSetCurrent(path: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: number) => setRunCurrent(runId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ledKeys.runs(path ?? "") }),
  });
}

export function useExportRun() {
  return useMutation({ mutationFn: ({ runId, target }: { runId: number; target: ExportTarget }) => exportObj(runId, target, null) });
}

/* ------------------------------ 会话内的重建任务 ------------------------------ */

export interface RebuildJob {
  key: string;
  /** 发起时的 Stage；会话内任务是全局的，按它过滤，换 Stage 后不串到别的 Stage。 */
  stagePath: string;
  screen: string;
  method: string;
  text: string;
  state: "running" | "failed";
  startedAt: number;
  finishedAt?: number;
}

export const useRebuildJobs = create<{ jobs: RebuildJob[] }>()(() => ({ jobs: [] }));
const upsert = (j: RebuildJob) => useRebuildJobs.setState((s) => ({ jobs: [j, ...s.jobs.filter((x) => x.key !== j.key)] }));
const drop = (key: string) => useRebuildJobs.setState((s) => ({ jobs: s.jobs.filter((x) => x.key !== key) }));

/** 当前 Stage 的会话内重建任务。 */
export function useStageRebuildJobs(path: string | null): RebuildJob[] {
  const jobs = useRebuildJobs((s) => s.jobs);
  return useMemo(() => jobs.filter((j) => j.stagePath === path), [jobs, path]);
}

/** 全站仪：选 CSV → 导入测点 → 重建。成功的结果落库成一条新记录。 */
export function useTotalStationRebuild(path: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (screen: string) => {
      if (!path) throw new Error("还没有打开 Stage");
      const csv = await pickFile("全站仪测量 CSV", ["csv", "txt"]);
      if (!csv) return null;
      const key = `ts-${Date.now()}`;
      const job: RebuildJob = { key, stagePath: path, screen, method: "全站仪", text: `${screen} · 正在导入测点`, state: "running", startedAt: Date.now() };
      upsert(job);
      try {
        const imp = await importTotalStationCsv(path, csv, screen);
        upsert({ ...job, text: `${screen} · 已导入 ${imp.measuredCount} 个实测点，正在重建` });
        const sep = path.includes("\\") ? "\\" : "/";
        const res = await reconstructSurface(path, screen, `${path.replace(/[\\/]+$/, "")}${sep}${imp.measurementsYamlPath}`);
        drop(key);
        qc.invalidateQueries({ queryKey: ledKeys.runs(path) });
        return res.run_id;
      } catch (e) {
        upsert({ ...job, state: "failed", text: `${screen} · ${e instanceof Error ? e.message : String(e)}`, finishedAt: Date.now() });
        throw e;
      }
    },
  });
}

/* ------------------------------ 报告摘要 ------------------------------ */

export function provCounts(rep: ReconstructionReport | undefined) {
  const pv = rep?.surface.vertex_provenance ?? [];
  if (!pv.length) return null;
  const c = { measured: 0, interpolated: 0, extrapolated: 0 };
  pv.forEach((p) => (c[p] += 1));
  return c;
}

/** 今天 14:40 / 昨天 19:30 / 11-23 21:14。 */
export function shortTime(ts: string): string {
  const d = new Date(ts.includes("T") || ts.endsWith("Z") ? ts : ts.replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return ts;
  const now = new Date();
  const hm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff === 0) return hm;
  if (diff === 1) return `昨天 ${hm}`;
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hm}`;
}

export function fullTime(ts: string): string {
  const d = new Date(ts.includes("T") || ts.endsWith("Z") ? ts : ts.replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString("zh-CN", { hour12: false });
}

export const dirOf = (p: string | null | undefined) => (p ? p.replace(/[\\/][^\\/]*$/, "") : null);

export function dur(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}
