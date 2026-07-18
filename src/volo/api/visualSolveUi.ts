/** Visual / total-station solve status helpers for the reconstruct-records UI.
 *
 * Unknown-status defaults (product; keep in sync with list + tree badges):
 * - Listed runs (`runStatus`): digest present → ok unless empty/failed/partial
 * - Digest key (`digestStatusKey`): unknown status → none
 * - Per-screen tree badge: sc.status not fail/warn → ok; missing screen falls
 *   back to session/global status for the active screen only
 */
import { meshVisualLoadSolve } from "./meshVisualCommands";
import type {
  ReconstructionRun,
  ScreenTransformsFile,
  VisualSolveCabinetDigest,
  VisualSolveDigest,
  VisualSolveScreenDigest,
} from "./types";

export const GRID_CAB_QUALITY = {
  ok: { label: "正常", tone: "positive", icon: "check" },
  warn: { label: "警告", tone: "notice", icon: "alert" },
  fail: { label: "失败", tone: "negative", icon: "x" },
} as const;

export const GRID_SOLVE_STATUS = {
  none: { label: "未求解", tone: "neutral", icon: "minus" },
  ok: { label: "求解成功", tone: "positive", icon: "check" },
  warn: { label: "部分箱体异常", tone: "notice", icon: "alert" },
  fail: { label: "失败", tone: "negative", icon: "x" },
} as const;

export type SolveStatusKey = keyof typeof GRID_SOLVE_STATUS;
export type CabQualityKey = keyof typeof GRID_CAB_QUALITY;

/** In-memory path → digest|null. Failures cache as null (one pushLog). */
const solveDigestCache = new Map<string, VisualSolveDigest | null>();
const solveDigestInflight = new Map<string, Promise<VisualSolveDigest | null>>();

/** `undefined` = never loaded; `null` = loaded and failed / empty path. */
export function peekSolveDigestCache(path: string): VisualSolveDigest | null | undefined {
  if (!solveDigestCache.has(path)) return undefined;
  return solveDigestCache.get(path);
}

export async function loadSolveDigestCached(
  path: string,
  opts?: {
    pushLog?: (entry: { lv: string; cat: string; msg: string }) => void;
    force?: boolean;
  },
): Promise<VisualSolveDigest | null> {
  if (!path) return null;
  if (!opts?.force) {
    if (solveDigestCache.has(path)) return solveDigestCache.get(path) ?? null;
    const inflight = solveDigestInflight.get(path);
    if (inflight) return inflight;
  }
  const task = meshVisualLoadSolve(path)
    .then((d) => {
      solveDigestCache.set(path, d);
      solveDigestInflight.delete(path);
      return d;
    })
    .catch((e: unknown) => {
      solveDigestCache.set(path, null);
      solveDigestInflight.delete(path);
      const msg = e instanceof Error ? e.message : String(e);
      opts?.pushLog?.({
        lv: "warn",
        cat: "survey",
        msg: `读取重建摘要失败 · ${msg}`,
      });
      return null;
    });
  solveDigestInflight.set(path, task);
  return task;
}

export function mapPoseQuality(q: string): CabQualityKey {
  if (q === "ok") return "ok";
  if (q === "high_residual" || q === "fail") return "fail";
  return "warn";
}

export function digestStatusKey(digest: VisualSolveDigest | null | undefined): SolveStatusKey {
  if (!digest) return "none";
  if (digest.empty || digest.status === "failed") return "fail";
  if (digest.status === "partial") return "warn";
  if (digest.status === "success") return "ok";
  return "none";
}

export function runStatus(
  run: ReconstructionRun,
  digest: VisualSolveDigest | null | undefined,
): (typeof GRID_SOLVE_STATUS)[SolveStatusKey] {
  /* Listed runs: only empty/failed/partial downgrade; unknown → ok. */
  if (digest) {
    if (digest.empty || digest.status === "failed") return GRID_SOLVE_STATUS.fail;
    if (digest.status === "partial") return GRID_SOLVE_STATUS.warn;
    return GRID_SOLVE_STATUS.ok;
  }
  if (run.vertex_count === 0 && run.visual_solve_path) return GRID_SOLVE_STATUS.fail;
  const rms = run.estimated_rms_mm;
  if (rms == null) return GRID_SOLVE_STATUS.ok;
  return GRID_SOLVE_STATUS[rms < 3 ? "ok" : "warn"];
}

export function runMethodLabel(run: ReconstructionRun): string {
  if (run.visual_solve_path || (run.method && run.method.includes("visual"))) return "视觉校正";
  return "全站仪导入";
}

export function runLabel(run: ReconstructionRun): string {
  return `run #${run.id}`;
}

/** Yaw (°) from row-major R — matches handoff「旋转角」vs design yaw. */
export function rotationYawDeg(R: [[number, number, number], [number, number, number], [number, number, number]]): number {
  return (Math.atan2(R[0][2], R[2][2]) * 180) / Math.PI;
}

export function transformDistanceMm(t_mm: [number, number, number]): number {
  return Math.hypot(t_mm[0], t_mm[1], t_mm[2]);
}

export type RelRow = {
  id: string;
  name: string;
  key: string;
  dist: number;
  rot: number;
};

export function relRowsFromTransforms(
  xf: ScreenTransformsFile | null | undefined,
  screenName?: (id: string) => string,
): RelRow[] {
  if (!xf || !xf.transforms) return [];
  return xf.transforms
    .filter((t) => t.screen_id !== xf.frame_screen_id)
    .map((t) => ({
      id: t.screen_id,
      name: screenName ? screenName(t.screen_id) : t.screen_id,
      key: t.screen_id,
      dist: transformDistanceMm(t.t_mm),
      rot: rotationYawDeg(t.R),
    }));
}

export type ScreenSolveStatusOpts = {
  /** Active session screen — when digest lacks this screen, fall back to global status. */
  sessionScreenId?: string;
  /** When digest is missing, treat screens that already have a visual run as ok. */
  hasVisualRun?: boolean;
};

export function screenSolveStatusFromDigest(
  meshBuilt: boolean,
  digest: VisualSolveDigest | null | undefined,
  screenId: string,
  opts?: ScreenSolveStatusOpts,
): SolveStatusKey {
  if (!meshBuilt) return "none";
  if (!digest) return opts?.hasVisualRun ? "ok" : "none";
  if (digest.empty) return "fail";
  const sc = (digest.screens || []).find((s) => s.screen_id === screenId);
  if (!sc) {
    if (opts?.sessionScreenId && screenId === opts.sessionScreenId) {
      if (digest.status === "failed") return "fail";
      if (digest.status === "partial") return "warn";
      return "ok";
    }
    return "none";
  }
  if (sc.status === "fail") return "fail";
  if (sc.status === "warn") return "warn";
  return "ok";
}

/** Visual-session row badge (tree). Session present + mesh built; digest missing → ok. */
export function sessionSolveStatus(
  meshBuilt: boolean,
  digest: VisualSolveDigest | null | undefined,
  hasVisualSession = true,
): SolveStatusKey {
  if (!hasVisualSession || !meshBuilt) return "none";
  if (!digest) return "ok";
  if (digest.empty || digest.status === "failed") return "fail";
  if (digest.status === "partial") return "warn";
  return "ok";
}

export type UiSolveScreen = VisualSolveScreenDigest & {
  name: string;
  cabs: VisualSolveCabinetDigest[];
};

export function uiScreensFromDigest(
  digest: VisualSolveDigest,
  screenName?: (id: string) => string,
): UiSolveScreen[] {
  return digest.screens.map((sc) => ({
    ...sc,
    name: screenName ? screenName(sc.screen_id) : sc.screen_id,
    cabs: sc.cabinets,
  }));
}
