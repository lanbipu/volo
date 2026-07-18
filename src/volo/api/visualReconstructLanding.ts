/* Shared post-reconstruct landing for gridInsp / gridTree:
   persist solve digest → normalize screens → register runs → reload →
   load transforms → patch session → log. */
import {
  meshVisualLoadScreenTransforms,
  meshVisualPersistSolve,
  meshVisualRegisterEmptyRun,
  meshVisualRegisterRun,
} from "./meshVisualCommands";
import type {
  ScreenTransformsFile,
  VisualReconstructResult,
  VisualScreenSummary,
  WarningDto,
} from "./types";
import { transformDistanceMm } from "./visualSolveUi";

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** `视觉重建警告` / `BA 警告` */
export function formatReconstructWarning(
  label: "视觉重建" | "BA",
  w: { code?: string; message?: string; cabinet?: string | null },
): string {
  const cab = w.cabinet ? ` · ${w.cabinet}` : "";
  const head = label === "BA" ? "BA 警告" : "视觉重建警告";
  return `${head} · ${w.code || "warning"}${cab} · ${w.message || ""}`;
}

/** Codes already pushLog'd via mesh-visual-progress — skip re-log at done. */
const STREAMED_WARNING_CODES = new Set(["cabinet_quality", "dead_weight_image"]);

export function normalizeReconstructScreens(
  result: VisualReconstructResult,
  fallbackScreenId: string,
): VisualScreenSummary[] {
  if (result.screens && result.screens.length) {
    return result.screens;
  }
  return [{
    screen_id: result.screen_id || fallbackScreenId,
    pose_report_path: result.pose_report_path,
    ba_rms_px: result.ba_rms_px,
    cabinet_count: (result.cabinets || []).length,
    cabinets: result.cabinets || [],
  }];
}

function cabinetCount(sc: VisualScreenSummary): number {
  return (sc.cabinets && sc.cabinets.length) || sc.cabinet_count || 0;
}

export type ReconstructLandingOpts = {
  projectPath: string;
  /** Active screen (reloadRuns target). */
  screenId: string;
  result: VisualReconstructResult;
  label: "视觉重建" | "BA";
  pushLog: (entry: { lv: string; cat: string; msg: string }) => void;
  reloadRuns: (projectPath: string, screenId: string) => Promise<void>;
  reloadScreenReports: (
    projectPath: string,
    config: unknown,
    s: unknown,
  ) => Promise<void>;
  projConfig: unknown;
  s: unknown;
  patchVisualSession: (session: Record<string, unknown>) => void;
  /** gridInsp: capture session dir */
  sessionDir?: string | null;
  /** gridInsp: also store screenIds on visualSession */
  includeScreenIds?: boolean;
  /** gridInsp: multi-screen RMS + transform distance summary */
  richSummary?: boolean;
  setCalReceipt?: (receipt: { tone: string; text: string }) => void;
  /** After landing: select current run in inspector (reconstruct-complete CTA). */
  onSelectCurrentRun?: (runId: number) => void;
};

/** Receipt line uses meters; detail UI uses mm via relRowsFromTransforms. */
function transformDistanceSummary(screenTransforms: ScreenTransformsFile): string {
  const nonFrame = (screenTransforms.transforms || []).filter(
    (t) => t.screen_id !== screenTransforms.frame_screen_id,
  );
  if (!nonFrame.length) return "";
  const parts = nonFrame.map((t) => {
    const distM = transformDistanceMm(t.t_mm) / 1000;
    return `${screenTransforms.frame_screen_id}↔${t.screen_id} ${distM.toFixed(3)} m`;
  });
  return ` · ${parts.join(" · ")}`;
}

/**
 * After `mesh-visual-reconstruct-done` with a result: persist solve digest,
 * register screens sequentially (Db is Mutex-backed — Promise.all would not
 * parallelize), then reload / transforms / session / logs.
 */
export async function applyReconstructDone(opts: ReconstructLandingOpts): Promise<void> {
  const {
    projectPath,
    screenId,
    result,
    label,
    pushLog,
    reloadRuns,
    reloadScreenReports,
    projConfig,
    s,
    patchVisualSession,
    sessionDir,
    includeScreenIds,
    richSummary,
    setCalReceipt,
    onSelectCurrentRun,
  } = opts;

  const summaries = normalizeReconstructScreens(result, screenId);
  const totalPoses = summaries.reduce((sum, sc) => sum + cabinetCount(sc), 0);

  let solvePath: string | null = null;
  try {
    solvePath = await meshVisualPersistSolve(projectPath, result);
  } catch (e) {
    pushLog({
      lv: "warn",
      cat: "survey",
      msg: `写入重建摘要失败 · ${errMsg(e)}`,
    });
  }

  let lastRunId: number | null = null;
  for (const sc of summaries) {
    const nCab = cabinetCount(sc);
    if (nCab === 0) {
      const verb = label === "BA" ? "BA 重建" : "视觉重建";
      pushLog({
        lv: "warn",
        cat: "survey",
        msg: `${verb} · 屏 <b>${sc.screen_id}</b> 箱体姿位为 0（空结果）`,
      });
      if (solvePath) {
        try {
          const id = await meshVisualRegisterEmptyRun(projectPath, sc.screen_id, solvePath);
          if (sc.screen_id === screenId) lastRunId = id;
        } catch (e) {
          pushLog({
            lv: "err",
            cat: "survey",
            msg: `空结果 run 注册失败 · ${sc.screen_id} · ${errMsg(e)}`,
          });
        }
      }
      continue;
    }
    const posePath =
      sc.pose_report_path
      || (sc.screen_id === result.screen_id ? result.pose_report_path : null);
    if (!posePath) {
      if (label !== "BA") {
        pushLog({
          lv: "warn",
          cat: "survey",
          msg: `视觉重建 · 屏 <b>${sc.screen_id}</b> 无 pose report，跳过 run 注册`,
        });
      }
      continue;
    }
    try {
      const reg = await meshVisualRegisterRun(
        projectPath,
        sc.screen_id,
        posePath,
        solvePath,
      );
      if (sc.screen_id === screenId) lastRunId = reg.run_id;
    } catch (e) {
      const arrow = label === "BA" ? "BA → surface run 失败" : "视觉重建 → surface run 失败";
      pushLog({
        lv: "err",
        cat: "survey",
        msg: `${arrow} · ${sc.screen_id} · ${errMsg(e)}`,
      });
    }
  }

  try {
    await reloadRuns(projectPath, screenId);
    await reloadScreenReports(projectPath, projConfig, s);
  } catch (e) {
    pushLog({
      lv: "warn",
      cat: "survey",
      msg: `刷新重建报告失败 · ${errMsg(e)}`,
    });
  }

  let transformSummary = "";
  let screenTransforms: ScreenTransformsFile | null = null;
  if (result.screen_transforms_path) {
    try {
      screenTransforms = await meshVisualLoadScreenTransforms(result.screen_transforms_path);
      if (richSummary) {
        transformSummary = transformDistanceSummary(screenTransforms);
      }
    } catch (e) {
      pushLog({
        lv: "warn",
        cat: "survey",
        msg: `读取屏间变换失败 · ${errMsg(e)}`,
      });
    }
  }

  const session: Record<string, unknown> = {
    screenId,
    poses: totalPoses,
    posePath: result.pose_report_path,
    screenTransformsPath: result.screen_transforms_path || null,
    screenTransforms,
    visualSolvePath: solvePath,
  };
  if (includeScreenIds) {
    session.screenIds = summaries.map((sc) => sc.screen_id);
  }
  if (sessionDir !== undefined) {
    session.sessionDir = sessionDir;
  }
  patchVisualSession(session);

  (result.warnings || []).forEach((w: WarningDto) => {
    if (w.code && STREAMED_WARNING_CODES.has(w.code)) return;
    pushLog({
      lv: "warn",
      cat: "survey",
      msg: formatReconstructWarning(label, w),
    });
  });

  let rmsText: string;
  if (richSummary) {
    const rmsParts = summaries.map(
      (sc) => `${sc.screen_id} ${Number(sc.ba_rms_px).toFixed(2)} px`,
    );
    rmsText = rmsParts.length > 1
      ? rmsParts.join(" · ")
      : `${result.ba_rms_px.toFixed(2)} px`;
  } else {
    rmsText = `${result.ba_rms_px.toFixed(2)} px`;
  }

  const doneHead = label === "BA" ? "BA 重建完成" : "视觉重建完成";
  if (setCalReceipt) {
    setCalReceipt({
      tone: totalPoses === 0 ? "notice" : "ok",
      text: `${doneHead} · BA RMS ${rmsText}${transformSummary}`,
    });
  }
  pushLog({
    lv: totalPoses === 0 ? "warn" : "ok",
    cat: "survey",
    msg: `${doneHead} · ba_rms <b>${rmsText}</b>${transformSummary} · ${totalPoses} 姿位`,
  });

  if (onSelectCurrentRun && lastRunId != null) {
    onSelectCurrentRun(lastRunId);
  }
}
