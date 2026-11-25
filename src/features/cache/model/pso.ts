/* PSO 预热的数据层：每个工程的预跑设置（get/set_pso_project_settings）、nDisplay 配置与地图发现、
   发起预跑（start_pso_warmup / start_pso_coldtest）。“跑完再做冷启动验证”后端没有存储字段，
   记在本机偏好里（每个工程各自记住）。 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  discoverNdisplayAssets,
  discoverProjectMaps,
  getPsoProjectSettings,
  listPsoWarmupRuns,
  setPsoProjectSettings,
  startPsoColdtest,
  startPsoWarmup,
} from "@/api/commands";
import { isTauri } from "@/api/invoke";
import type { PsoProjectSettings } from "@/api/types";
import { useTauriEvent } from "@/lib/events";
import { persistOptions } from "@/lib/persist";

export const psoKeys = {
  settings: (projectId: number) => ["cache", "pso", "settings", projectId] as const,
  assets: (machineId: number, root: string) => ["cache", "pso", "assets", machineId, root] as const,
  maps: (machineId: number, root: string) => ["cache", "pso", "maps", machineId, root] as const,
  runs: (projectId: number) => ["cache", "pso", "runs", projectId] as const,
};

export function emptySettings(projectId: number): PsoProjectSettings {
  return {
    project_id: projectId,
    dc_cfg_source: "asset",
    dc_cfg_asset: null,
    dc_cfg_manual_path: "",
    extra_args: "",
    offscreen: true,
    target_machine_ids: "[]",
    max_minutes: 20,
    probe_interval_secs: 30,
    map_path: "",
    dc_node: "",
    updated_at: null,
  };
}

export function targetIds(s: PsoProjectSettings | null | undefined): number[] {
  try {
    const a: unknown = JSON.parse(s?.target_machine_ids || "[]");
    return Array.isArray(a) ? a.filter((x): x is number => typeof x === "number") : [];
  } catch {
    return [];
  }
}

export function dcPath(s: PsoProjectSettings | null | undefined): string | null {
  if (!s) return null;
  return (s.dc_cfg_source === "asset" ? s.dc_cfg_asset : s.dc_cfg_manual_path) || null;
}

export function usePsoSettings(projectId: number) {
  return useQuery({ queryKey: psoKeys.settings(projectId), queryFn: () => getPsoProjectSettings(projectId), enabled: isTauri() });
}

/** 改动立即保存：传入完整设置，乐观写入缓存，失败回滚。 */
export function useSavePsoSettings(projectId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (s: PsoProjectSettings) => setPsoProjectSettings({ ...s, project_id: projectId, updated_at: null }),
    onMutate: async (s) => {
      await qc.cancelQueries({ queryKey: psoKeys.settings(projectId) });
      const prev = qc.getQueryData<PsoProjectSettings | null>(psoKeys.settings(projectId));
      qc.setQueryData(psoKeys.settings(projectId), s);
      return { prev };
    },
    onError: (_e, _s, ctx) => qc.setQueryData(psoKeys.settings(projectId), ctx?.prev ?? null),
    onSuccess: (saved) => qc.setQueryData(psoKeys.settings(projectId), saved),
  });
}

export function useNdisplayAssets(machineId: number | null, root: string | null) {
  return useQuery({
    queryKey: psoKeys.assets(machineId ?? 0, root ?? ""),
    queryFn: () => discoverNdisplayAssets(machineId as number, root as string),
    enabled: isTauri() && machineId != null && !!root,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useProjectMaps(machineId: number | null, root: string | null) {
  return useQuery({
    queryKey: psoKeys.maps(machineId ?? 0, root ?? ""),
    queryFn: () => discoverProjectMaps(machineId as number, root as string),
    enabled: isTauri() && machineId != null && !!root,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function usePsoRuns(projectId: number) {
  return useQuery({ queryKey: psoKeys.runs(projectId), queryFn: () => listPsoWarmupRuns(projectId), enabled: isTauri() });
}

/* ---------------------------- 冷启动验证偏好 ---------------------------- */

interface PsoPrefs {
  coldVerify: Record<string, boolean>;
  setCold: (projectId: number, on: boolean) => void;
}

export const usePsoPrefs = create<PsoPrefs>()(
  persist(
    (set) => ({ coldVerify: {}, setCold: (id, on) => set((s) => ({ coldVerify: { ...s.coldVerify, [String(id)]: on } })) }),
    persistOptions<PsoPrefs, Pick<PsoPrefs, "coldVerify">>("cache.pso", 1, ({ coldVerify }) => ({ coldVerify })),
  ),
);

/* ------------------------------- 发起预跑 ------------------------------- */

export function useStartWarmup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ settings, machineIds, ue, cold }: { settings: PsoProjectSettings; machineIds: number[]; ue: string | null; cold: boolean }) => {
      const path = dcPath(settings);
      if (!path) throw new Error("还没有选 nDisplay 配置：先在预跑设置里选一份");
      if (!machineIds.length) throw new Error("没有选择要跑的机器");
      const req = {
        project_id: settings.project_id,
        target_machine_ids: machineIds,
        resolution_w: 1920,
        resolution_h: 1080,
        max_minutes: Math.max(1, settings.max_minutes || 20),
        dc_cfg_path: path,
        dc_node: settings.dc_node?.trim() || "Node_0",
        offscreen: settings.offscreen,
        extra_args: (settings.extra_args || "").split(/\s+/).filter(Boolean),
        traversal: settings.map_path?.trim() ? { map_path: settings.map_path.trim(), probe_interval_secs: settings.probe_interval_secs || 30 } : null,
        ue_version: ue,
      };
      return cold ? startPsoColdtest(req) : startPsoWarmup(req);
    },
    onSettled: () => invalidatePso(qc),
  });
}

/* 任务页按 ["tasks","pso",工程] 另读一份运行记录，和这里的缓存分开，两边都要失效。 */
function invalidatePso(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ["cache"] });
  void qc.invalidateQueries({ queryKey: ["tasks", "pso"] });
}

/** 预跑结束就重读运行记录与工程的 PSO 状态。外壳常驻调用一次。每台机器结束时各发一条：
    普通预跑发 pso-warmup-finalized，带冷启动验证的发 pso-coldtest-finalized。
    过程中的 *-progress 是逐行日志，太密，不用它刷新。 */
export function usePsoLiveSync() {
  const qc = useQueryClient();
  useTauriEvent("pso-warmup-finalized", () => invalidatePso(qc));
  useTauriEvent("pso-coldtest-finalized", () => invalidatePso(qc));
}
