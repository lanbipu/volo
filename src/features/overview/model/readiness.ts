/* 概览 › 上场就绪（设计：Main.dc.html）。从左到右，前一步是后一步的前提。
   LED：屏幕建模 → 上屏输出 → 摄影机 → 网格重建 → 集群就绪；AR：标记 → 摄影机 → 空间求解 → 验证 → 集群就绪。
   每一步只看已有的数据：project.yaml、重建记录、上屏会话、AR 工作区、最近一次巡检。 */
import type { ProjectConfig } from "@/api/types";
import type { PageId } from "@/lib/nav";
import { adoptedRun, isLowConf, runLabel, useArRuns, useArWorkspace, VERIFY_LIMIT_PX } from "@/features/ar";
import { useMachines, type MachineView } from "@/features/cache";
import { currentRun, resolveTopology, RMS_ADOPT_PX, useOutputSession, useRuns, validateTopology } from "@/features/led";
import type { CurrentStage } from "@/features/stage";

export type StepKind = "success" | "failed" | "queued";

export interface ReadyStep {
  key: string;
  page: PageId;
  title: string;
  kind: StepKind;
  label: string;
  desc: string;
}

const joinNames = (names: string[]) => (names.length <= 3 ? names.join("、") : `${names.slice(0, 3).join("、")} 等 ${names.length} 块`);

function screensStep(cfg: ProjectConfig): ReadyStep {
  const ids = Object.keys(cfg.screens ?? {});
  return ids.length
    ? { key: "screens", page: "screens", title: "屏幕建模", kind: "success", label: "就绪", desc: `${ids.length} 块屏幕：${joinNames(ids)}` }
    : { key: "screens", page: "screens", title: "屏幕建模", kind: "queued", label: "未开始", desc: "还没有屏幕" };
}

const PHASE_TEXT: Record<string, string> = { idle: "未启动", standby: "黑场待机", showing: "正在上屏" };

function outputStep(cfg: ProjectConfig, phase: string): ReadyStep {
  const base = { key: "output", page: "output" as PageId, title: "上屏输出" };
  const topo = resolveTopology(cfg);
  if (!topo || !topo.nodes.length) return { ...base, kind: "queued", label: "未开始", desc: "还没有配置 nDisplay 节点" };
  const issues = validateTopology(topo, cfg);
  if (issues.length) return { ...base, kind: "failed", label: "需处理", desc: `${issues.length} 处拓扑问题：${issues[0].text}` };
  return { ...base, kind: "success", label: "就绪", desc: `nDisplay · ${topo.nodes.length} 节点 · ${PHASE_TEXT[phase] ?? phase}` };
}

function cameraStep(cfg: ProjectConfig): ReadyStep {
  const base = { key: "camera", page: "camera" as PageId, title: "摄影机" };
  const cams = cfg.cameras ?? [];
  if (!cams.length) return { ...base, kind: "queued", label: "未开始", desc: "还没有摄影机" };
  const name = (c: (typeof cams)[number]) => (c.lens?.focal_mm ? `${c.name} ${+c.lens.focal_mm.toFixed(1)} mm` : c.name);
  const bad = cams.filter((c) => c.lens?.calibration_rms_px != null && c.lens.calibration_rms_px >= RMS_ADOPT_PX);
  const todo = cams.filter((c) => c.lens?.calibration_rms_px == null);
  const ok = cams.filter((c) => !bad.includes(c) && !todo.includes(c));
  const tail = ok.length ? `；${ok.map((c) => c.name).join("、")}就绪` : "";
  if (bad.length) return { ...base, kind: "failed", label: "需处理", desc: `${bad.map(name).join("、")} 标定残差偏高${tail}` };
  if (todo.length) return { ...base, kind: "queued", label: `${ok.length} / ${cams.length} 已标定`, desc: `${todo.map((c) => c.name).join("、")} 还没标定${tail}` };
  return { ...base, kind: "success", label: "就绪", desc: `${cams.length} 台已标定：${cams.map(name).join("、")}` };
}

function rebuildStep(cfg: ProjectConfig, runs: Parameters<typeof currentRun>[0]): ReadyStep {
  const base = { key: "rebuild", page: "rebuild" as PageId, title: "网格重建" };
  const ids = Object.keys(cfg.screens ?? {});
  if (!ids.length) return { ...base, kind: "queued", label: "未开始", desc: "先建屏幕" };
  const done = ids.map((id) => [id, currentRun(runs, id)] as const);
  const with_ = done.filter(([, r]) => r);
  const without = done.filter(([, r]) => !r).map(([id]) => id);
  if (!without.length) return { ...base, kind: "success", label: "就绪", desc: `全部采用实测网格：${with_.map(([id, r]) => `${id} #${r!.id}`).join("、")}` };
  const head = with_.length ? `${with_.map(([id, r]) => `${id} 采用 #${r!.id}`).join("、")}；` : "";
  return { ...base, kind: "queued", label: `${with_.length} / ${ids.length} 已重建`, desc: `${head}${joinNames(without)}仍是设计网格` };
}

export function clusterStep(views: MachineView[], loading: boolean): ReadyStep {
  const base = { key: "cluster", page: "machines" as PageId, title: "集群就绪" };
  if (loading) return { ...base, kind: "queued", label: "读取中", desc: "正在读取机器" };
  if (!views.length) return { ...base, kind: "queued", label: "未开始", desc: "还没有机器" };
  const online = views.filter((v) => v.state !== "offline");
  const failed = views.filter((v) => v.state === "failed");
  const offline = views.length - online.length;
  const unchecked = views.filter((v) => v.state === "queued");
  const head = `${online.length} 台在线${offline ? `、${offline} 台离线` : ""}`;
  if (failed.length) return { ...base, kind: "failed", label: "需处理", desc: `${head}；${failed[0].host} ${failed[0].summary}${failed.length > 1 ? `，另有 ${failed.length - 1} 台` : ""}` };
  if (unchecked.length) return { ...base, kind: "queued", label: "未巡检", desc: `${head}；${unchecked.length} 台还没巡检` };
  if (offline) return { ...base, kind: "failed", label: "需处理", desc: `${head}` };
  return { ...base, kind: "success", label: "就绪", desc: `${head}，巡检全部通过` };
}

export function useReadiness(stage: CurrentStage | null) {
  const path = stage?.path ?? null;
  const cfg = stage?.config;
  const machines = useMachines();
  const runs = useRuns(path);
  const phase = useOutputSession((s) => (path && s.session?.startsWith(path) ? s.phase : "idle"));
  const ws = useArWorkspace(path);
  const arRuns = useArRuns(path);
  const cluster = clusterStep(machines.views, machines.loading);

  let steps: ReadyStep[] = [];
  if (cfg && stage?.type === "ar") {
    const mapName = ws.markerMap ? ws.markerMap.split(/[\\/]/).pop() : null;
    const run = adoptedRun(arRuns.data, ws);
    const verify = ws.verify;
    steps = [
      mapName
        ? { key: "markers", page: "markers", title: "标记", kind: "success", label: "就绪", desc: `标记图 ${mapName}${ws.validate ? " · 已校验" : ""}` }
        : { key: "markers", page: "markers", title: "标记", kind: "queued", label: "未开始", desc: "还没有载入标记图" },
      cameraStep(cfg),
      !run
        ? { key: "spatial", page: "spatial", title: "空间求解", kind: "queued", label: "未开始", desc: "还没有求解结果" }
        : isLowConf(run.confidence)
          ? { key: "spatial", page: "spatial", title: "空间求解", kind: "failed", label: "需处理", desc: `采用 ${runLabel(run)}，观测不足` }
          : { key: "spatial", page: "spatial", title: "空间求解", kind: "success", label: "就绪", desc: `采用 ${runLabel(run)}${run.reprojection_rms_px != null ? ` · RMS ${run.reprojection_rms_px.toFixed(2)} px` : ""}` },
      !verify
        ? { key: "verify", page: "verify", title: "验证", kind: "queued", label: "未开始", desc: "还没有验证" }
        : verify.data.global_rms_px > VERIFY_LIMIT_PX
          ? { key: "verify", page: "verify", title: "验证", kind: "failed", label: "需处理", desc: `残差 ${verify.data.global_rms_px.toFixed(2)} px，高于 ${VERIFY_LIMIT_PX.toFixed(1)} px` }
          : { key: "verify", page: "verify", title: "验证", kind: "success", label: "就绪", desc: `残差 ${verify.data.global_rms_px.toFixed(2)} px · ${verify.data.num_frames} 帧` },
      cluster,
    ];
  } else if (cfg) {
    steps = [screensStep(cfg), outputStep(cfg, phase), cameraStep(cfg), rebuildStep(cfg, runs.data), cluster];
  }

  const blocked = steps.filter((s) => s.kind === "failed").length;
  const todo = steps.filter((s) => s.kind === "queued").length;
  const head: { kind: StepKind; label: string } = blocked ? { kind: "failed", label: `未就绪 · ${blocked} 项阻塞` } : todo ? { kind: "queued", label: `未就绪 · ${todo} 项待完成` } : { kind: "success", label: "可以上场" };
  return { steps, head, cluster, machines };
}
