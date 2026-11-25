/* 当前 Stage：一个 Stage = 一个 Calibrate 项目目录（project.yaml，带 stage_id / stage_type）。
   切换器列出“最近打开的项目”（list_recent_projects），当前选择按域持久化。 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { addRecentProject, listRecentProjects, loadProjectYaml, saveProjectYaml } from "@/api/meshCommands";
import { assignMachineToStage, ensureProjectStageId } from "@/api/stageCommands";
import { pickDirectory } from "@/api/commands";
import { isTauri, VoloInvokeError } from "@/api/invoke";
import { errText } from "@/lib/toast";
import type { ProjectConfig, RecentProject, StageType } from "@/api/types";
import { persistOptions } from "@/lib/persist";

interface StageSel {
  path: string | null;
  setPath: (p: string | null) => void;
}

export const useStageSel = create<StageSel>()(
  persist((set) => ({ path: null, setPath: (path) => set({ path }) }), persistOptions<StageSel, Pick<StageSel, "path">>("stage", 1, ({ path }) => ({ path }))),
);

export const stageKeys = {
  recent: ["stage", "recent"] as const,
  config: (path: string) => ["stage", "config", path] as const,
  id: (path: string) => ["stage", "id", path] as const,
};

export function useRecentStages() {
  return useQuery({ queryKey: stageKeys.recent, queryFn: listRecentProjects, enabled: isTauri() });
}

export function useStageConfig(path: string | null) {
  return useQuery({ queryKey: stageKeys.config(path ?? ""), queryFn: () => loadProjectYaml(path as string), enabled: isTauri() && !!path });
}

export interface CurrentStage {
  path: string;
  name: string;
  type: StageType;
  stageId: string | null;
  config: ProjectConfig | undefined;
}

export function stageName(rec: RecentProject | undefined, cfg: ProjectConfig | undefined): string {
  return cfg?.project?.name || rec?.display_name || rec?.abs_path.split(/[\\/]/).pop() || "未命名 Stage";
}

/** 当前 Stage：持久化的选择不在最近列表里时，退回最近一个。 */
export function useCurrentStage(): { stage: CurrentStage | null; recent: RecentProject[]; loading: boolean } {
  const recentQ = useRecentStages();
  const saved = useStageSel((s) => s.path);
  const recent = recentQ.data ?? [];
  const path = saved && recent.some((r) => r.abs_path === saved) ? saved : (recent[0]?.abs_path ?? null);
  const cfgQ = useStageConfig(path);
  const idQ = useQuery({ queryKey: stageKeys.id(path ?? ""), queryFn: () => ensureProjectStageId(path as string), enabled: isTauri() && !!path, staleTime: Infinity });
  if (!path) return { stage: null, recent, loading: recentQ.isLoading };
  const rec = recent.find((r) => r.abs_path === path);
  return {
    stage: { path, name: stageName(rec, cfgQ.data), type: cfgQ.data?.stage_type ?? "led", stageId: idQ.data ?? cfgQ.data?.stage_id ?? null, config: cfgQ.data },
    recent,
    loading: recentQ.isLoading || cfgQ.isLoading,
  };
}

/** “打开文件夹里的 Stage…”：选目录 → 读 project.yaml → 记入最近 → 设为当前。 */
export function useOpenStageFolder() {
  const qc = useQueryClient();
  const setPath = useStageSel((s) => s.setPath);
  return async (): Promise<string | null> => {
    const dir = await pickDirectory();
    if (!dir) return null;
    const cfg = await loadProjectYaml(dir);
    await addRecentProject(dir, cfg.project?.name || dir.split(/[\\/]/).pop() || dir);
    await qc.invalidateQueries({ queryKey: stageKeys.recent });
    setPath(dir);
    return cfg.project?.name || dir;
  };
}

/* ------------------------------ 新建 Stage ------------------------------ */

export interface NewStageInput {
  name: string;
  type: "led" | "ar";
  dir: string;
  machineIds: number[];
}

/** 空的 project.yaml：没有屏幕 / 摄影机；坐标系测点等建了屏幕再定。 */
function blankConfig(name: string, type: "led" | "ar"): ProjectConfig {
  return {
    stage_type: type,
    project: { name, unit: "mm" },
    screens: {},
    coordinate_system: { origin_point: "", x_axis_point: "", xy_plane_point: "" },
    output: { target: "disguise", obj_filename: "{screen_id}_mesh.obj", weld_vertices_tolerance_mm: 1, triangulate: true },
    cameras: [],
  };
}

/** 新建：写 project.yaml → 分配 stage_id → 登记机器归属 → 记入最近 → 设为当前。目录里已有 Stage 时拒绝。 */
export function useCreateStage() {
  const qc = useQueryClient();
  const setPath = useStageSel((s) => s.setPath);
  return async (v: NewStageInput): Promise<{ failedMachines: number }> => {
    /* 只有“没有 project.yaml”才能新建；读得出来或读不出来（格式坏了、没权限）都不能覆盖。 */
    const probe = await loadProjectYaml(v.dir).then(
      () => "exists" as const,
      (e: unknown) => (e instanceof VoloInvokeError && e.kind === "not_found" ? ("absent" as const) : e),
    );
    if (probe === "exists") throw new Error("这个文件夹里已经有 Stage 了，换一个，或用“打开文件夹里的 Stage…”");
    if (probe !== "absent") throw new Error(`这个文件夹里已有的 project.yaml 读不出来，不会覆盖它：${errText(probe)}`);
    await saveProjectYaml(v.dir, blankConfig(v.name, v.type));
    const id = await ensureProjectStageId(v.dir);
    const res = await Promise.allSettled(v.machineIds.map((m) => assignMachineToStage(id, m)));
    await addRecentProject(v.dir, v.name);
    await qc.invalidateQueries({ queryKey: stageKeys.recent });
    setPath(v.dir);
    return { failedMachines: res.filter((r) => r.status === "rejected").length };
  };
}
