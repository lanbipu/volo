/* 舞台 LED · 屏幕页的数据：当前 Stage 的 project.yaml（屏幕配置）、重建记录与当前网格报告、测试图。
   写回统一走 saveProjectYaml（整份 config 回写），成功后让 Stage 配置查询重新读盘。 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { getRunReport, listRuns, saveProjectYaml } from "@/api/meshCommands";
import { generatedPatternImagePath, meshVisualGeneratePattern, meshVisualScanPatterns, readGeneratedPatternAsDataUrl, vpqspScreenIdCode } from "@/api/meshVisualCommands";
import { closePatternPlayer, listMonitors, openPatternPlayer, playerClear, playerShowPattern, preferPatternMonitor } from "@/api/player";
import { isTauri } from "@/api/invoke";
import type { ProjectConfig, ReconstructionRun, ScreenConfig, ShapePriorConfig } from "@/api/types";
import { persistOptions } from "@/lib/persist";
import { stageKeys, useCurrentStage } from "@/features/stage";

export const ledKeys = {
  runs: (path: string) => ["led", "runs", path] as const,
  report: (runId: number) => ["led", "report", runId] as const,
  patterns: (path: string) => ["led", "patterns", path] as const,
  patternImg: (p: string) => ["led", "pattern-img", p] as const,
};

/* ------------------------------ 界面偏好 ------------------------------ */

export type MeshVersion = "design" | "rebuilt" | "overlay";
export type PickMode = "screen" | "cabinet";
export type ScreenTab = "params" | "transform" | "pattern";

interface ScreensUi {
  /** 聚焦的屏幕；null = 全部。 */
  sel: string | null;
  version: MeshVersion;
  pick: PickMode;
  ghost: boolean;
  isolate: boolean;
  pattern: boolean;
  ground: boolean;
  tab: ScreenTab;
  set: (p: Partial<Omit<ScreensUi, "set">>) => void;
}
type ScreensPrefs = Omit<ScreensUi, "set">;

export const useScreensUi = create<ScreensUi>()(
  persist(
    (set) => ({ sel: null, version: "rebuilt", pick: "screen", ghost: false, isolate: false, pattern: false, ground: true, tab: "params", set: (p) => set(p) }),
    persistOptions<ScreensUi, ScreensPrefs>("led.screens", 1, ({ sel, version, pick, ghost, isolate, pattern, ground, tab }) => ({ sel, version, pick, ghost, isolate, pattern, ground, tab })),
  ),
);

/* ------------------------------ Stage 配置 ------------------------------ */

export function useLedStage() {
  const { stage, loading } = useCurrentStage();
  return { stage, config: stage?.config, loading };
}

/** 整份 config 回写；乐观更新查询缓存，避免视口在写盘期间回跳。 */
export function useSaveStage(path: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (next: ProjectConfig) => {
      if (!path) throw new Error("还没有打开 Stage");
      await saveProjectYaml(path, next);
      return next;
    },
    onMutate: (next) => {
      if (!path) return undefined;
      const prev = qc.getQueryData<ProjectConfig>(stageKeys.config(path));
      qc.setQueryData(stageKeys.config(path), next);
      return { prev };
    },
    onError: (_e, _n, ctx) => {
      if (path && ctx?.prev) qc.setQueryData(stageKeys.config(path), ctx.prev);
    },
    onSettled: () => path && qc.invalidateQueries({ queryKey: stageKeys.config(path) }),
  });
}

export function withScreen(cfg: ProjectConfig, id: string, screen: ScreenConfig): ProjectConfig {
  return { ...cfg, screens: { ...cfg.screens, [id]: screen } };
}

/* ------------------------------ 新建屏幕 ------------------------------ */

export type NewShape = "flat" | "folded" | "curved" | "arc" | "l_shape" | "u_shape";

export function defaultShape(kind: NewShape, cols: number): ShapePriorConfig {
  switch (kind) {
    case "folded":
      return { type: "folded", fold_seams_at_columns: [Math.max(1, Math.floor(cols / 2))] };
    case "curved":
      return { type: "curved", radius_mm: 5000, fold_seams_at_columns: [] };
    case "arc":
      return { type: "arc", center_flat_cols: 2, angle_per_col_deg: 9 };
    case "l_shape":
      return { type: "l_shape", left_cols: Math.max(1, Math.floor(cols / 2)), soften_cols: 1, corner_angle_deg: 90 };
    case "u_shape":
      return { type: "u_shape", wing_cols: Math.max(1, Math.floor(cols / 4)), soften_cols: 1, corner_angle_deg: 90 };
    default:
      return { type: "flat" };
  }
}

export function newScreenConfig(kind: NewShape, cab: [number, number], grid: [number, number], pitchMm: number | null): ScreenConfig {
  const px: [number, number] | null = pitchMm && pitchMm > 0 ? [Math.round(cab[0] / pitchMm), Math.round(cab[1] / pitchMm)] : null;
  return {
    cabinet_count: grid,
    cabinet_size_mm: cab,
    pixels_per_cabinet: px,
    shape_prior: defaultShape(kind, grid[0]),
    shape_mode: "rectangle",
    irregular_mask: [],
    bottom_completion: null,
    position_m: [0, 0, 0],
    yaw_deg: 0,
    origin_aligned: false,
  };
}

/** 屏幕标识即 project.yaml 里的 key，也是测点名前缀（{screen}_V001_R001）→ 不允许空白与路径分隔符。 */
export function screenIdError(id: string, cfg: ProjectConfig | undefined): string | null {
  if (!id) return "填一个名称";
  if (/[\s\\/]/.test(id)) return "名称里不能有空格或斜杠";
  if (cfg?.screens[id]) return "已经有同名的屏幕";
  return null;
}

/* ------------------------------ 重建 ------------------------------ */

export function useRuns(path: string | null) {
  return useQuery({ queryKey: ledKeys.runs(path ?? ""), queryFn: () => listRuns(path as string, null), enabled: isTauri() && !!path });
}

/** 当前采用的重建：显式置为当前的，否则同屏最新一次。 */
export function currentRun(runs: ReconstructionRun[] | undefined, screenId: string): ReconstructionRun | null {
  const list = (runs ?? []).filter((r) => r.screen_id === screenId);
  return list.find((r) => r.is_current) ?? [...list].sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null;
}

export function useRunReport(runId: number | null) {
  return useQuery({ queryKey: ledKeys.report(runId ?? -1), queryFn: () => getRunReport(runId as number), enabled: isTauri() && runId != null, staleTime: Infinity });
}

/** 重建来源（run.method 记的是插值算法名，来源要看 visual_solve_path / 方法名）。 */
export function runSource(run: ReconstructionRun): string {
  const m = run.method ?? "";
  if (run.visual_solve_path || m.includes("visual")) return "视觉校正";
  if (m.includes("structured") || m.startsWith("sl")) return "结构光";
  return "全站仪";
}

/* ------------------------------ 测试图 ------------------------------ */

export type PatternScheme = "vpqsp" | "charuco";

export function usePatterns(path: string | null) {
  return useQuery({ queryKey: ledKeys.patterns(path ?? ""), queryFn: () => meshVisualScanPatterns(path as string), enabled: isTauri() && !!path });
}

export function usePatternImage(outputDir: string | null) {
  const p = outputDir ? generatedPatternImagePath(outputDir) : null;
  return useQuery({ queryKey: ledKeys.patternImg(p ?? ""), queryFn: () => readGeneratedPatternAsDataUrl(p as string), enabled: isTauri() && !!p, staleTime: Infinity });
}

export function useGeneratePattern(path: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ screenId, scheme, allIds }: { screenId: string; scheme: PatternScheme; allIds: string[] }) =>
      meshVisualGeneratePattern(path as string, screenId, scheme, vpqspScreenIdCode(screenId, allIds), null),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ledKeys.patterns(path ?? "") });
      qc.invalidateQueries({ queryKey: ledKeys.patternImg(generatedPatternImagePath(res.output_dir)) });
    },
  });
}

/** 在本机显示器上全屏播放测试图（播放器选非主屏）。 */
export async function playPatternLocal(outputDir: string): Promise<string> {
  const mons = await listMonitors();
  const mon = preferPatternMonitor(mons);
  if (!mon) throw new Error("没有可用的显示器");
  await openPatternPlayer(mon.index);
  await playerShowPattern(generatedPatternImagePath(outputDir), "full_screen");
  return mon.name || `显示器 ${mon.index + 1}`;
}

export async function stopPatternLocal() {
  await playerClear().catch(() => undefined);
  await closePatternPlayer();
}
