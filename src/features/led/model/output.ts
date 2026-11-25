/* 舞台 LED · 上屏：复合画布、输出拓扑与 nDisplay 输出会话。
   复合画布 = 各屏按 project.yaml 顺序、按像素尺寸横向排开（与后端拼图一致）；拓扑节点从画布上裁一块输出到自己机器的窗口。
   一个 Stage 一个会话（session_id = <stage 路径>::stage），状态以进程探测为准，不落盘。 */
import { useEffect } from "react";
import { create } from "zustand";
import { getMachineDetail, listMachines } from "@/api/commands";
import { generatedPatternImagePath } from "@/api/meshVisualCommands";
import { DEFAULT_NDISPLAY_OUTPUT_PATHS, listenNDisplayOutputEvent, outputDeploy, outputPreflight, outputShow, outputStart, outputStatus, outputStop } from "@/api/ndisplayOutput";
import { isTauri } from "@/api/invoke";
import type { GeneratePatternResult, Machine, OutputNode, OutputTopology, ProjectConfig, RuntimePaths, RuntimeRequest, ScreenConfig } from "@/api/types";
import { errText } from "@/lib/toast";

/* ------------------------------ 复合画布 ------------------------------ */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface CompositeScreen extends Rect {
  id: string;
}

export function composite(screens: Record<string, ScreenConfig> | undefined) {
  let x = 0;
  let H = 0;
  const rects: CompositeScreen[] = Object.entries(screens ?? {}).map(([id, sc]) => {
    const ppc = sc.pixels_per_cabinet ?? [176, 176];
    const w = Math.max(1, (sc.cabinet_count[0] || 1) * (ppc[0] || 1));
    const h = Math.max(1, (sc.cabinet_count[1] || 1) * (ppc[1] || 1));
    const r = { id, x, y: 0, w, h };
    x += w;
    H = Math.max(H, h);
    return r;
  });
  return { canvas: { w: x || 1, h: H || 1 }, screens: rects };
}

/** Stage 级拓扑优先；旧项目退回第一块带拓扑的屏幕。 */
export function resolveTopology(cfg: ProjectConfig | undefined): OutputTopology | null {
  if (!cfg) return null;
  if (cfg.output_topology?.nodes?.length) return cfg.output_topology;
  for (const sc of Object.values(cfg.screens)) if (sc.output_topology?.nodes?.length) return sc.output_topology;
  return null;
}

/** 每块屏幕一个节点，裁剪 = 该屏在画布上的区域，窗口 1:1。 */
export function topologyPerScreen(cfg: ProjectConfig, prev: OutputNode[] = []): OutputTopology {
  const comp = composite(cfg.screens);
  return {
    render_sync: cfg.output_topology?.render_sync ?? "ethernet_barrier",
    nodes: comp.screens.map((r, i) => ({
      node_id: prev[i]?.node_id ?? `node_${String.fromCharCode(97 + (i % 26))}`,
      machine: prev[i]?.machine ?? { hostname: "", ip: "" },
      viewport_rect_px: [r.x, r.y, r.w, r.h],
      window_px: [r.w, r.h],
      window_origin_px: prev[i]?.window_origin_px ?? [0, 0],
      fullscreen: false,
      primary: i === 0,
    })),
  };
}

export const rectOf = (n: OutputNode): Rect => ({ x: n.viewport_rect_px[0], y: n.viewport_rect_px[1], w: n.viewport_rect_px[2], h: n.viewport_rect_px[3] });
const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/** 节点裁剪区域落在哪几块屏幕上（按重叠面积）。 */
export function nodeScreens(n: OutputNode, comp: ReturnType<typeof composite>): string[] {
  const r = rectOf(n);
  return comp.screens.filter((s) => overlap(r, s) > 0).map((s) => s.id);
}

export interface TopoIssue {
  text: string;
}

/** 拓扑校验：每块屏幕被完整覆盖、恰好一个主节点、节点之间不重叠、节点名不重复、都绑定了机器。 */
export function validateTopology(topo: OutputTopology, cfg: ProjectConfig): TopoIssue[] {
  const comp = composite(cfg.screens);
  const out: TopoIssue[] = [];
  const nodes = topo.nodes;
  if (!nodes.length) return [{ text: "还没有节点" }];
  const primaries = nodes.filter((n) => n.primary).length;
  if (primaries !== 1) out.push({ text: primaries ? `有 ${primaries} 个主节点，只能有一个` : "还没有主节点" });
  const ids = new Set<string>();
  nodes.forEach((n) => {
    if (!n.node_id.trim()) out.push({ text: "有节点没有名字" });
    else if (ids.has(n.node_id)) out.push({ text: `节点名 ${n.node_id} 重复` });
    ids.add(n.node_id);
    if (!n.machine.hostname && !n.machine.ip) out.push({ text: `${n.node_id || "节点"} 还没有指定机器` });
    const [, , w, h] = n.viewport_rect_px;
    if (w <= 0 || h <= 0) out.push({ text: `${n.node_id} 的取图区域是空的` });
  });
  for (let i = 0; i < nodes.length; i++)
    for (let j = i + 1; j < nodes.length; j++) if (overlap(rectOf(nodes[i]), rectOf(nodes[j])) > 0) out.push({ text: `${nodes[i].node_id} 和 ${nodes[j].node_id} 的区域重叠` });
  comp.screens.forEach((s) => {
    const covered = nodes.reduce((a, n) => a + overlap(rectOf(n), s), 0);
    if (covered < s.w * s.h) out.push({ text: `${s.id} 有 ${Math.round((1 - covered / (s.w * s.h)) * 100)}% 没有节点输出` });
  });
  return out;
}

/** 后端只吃一块“屏幕”：用复合画布尺寸包一层，拓扑挂在上面。 */
export function stageScreenForOutput(cfg: ProjectConfig, topo: OutputTopology): ScreenConfig {
  const { canvas } = composite(cfg.screens);
  return {
    cabinet_count: [1, 1],
    cabinet_size_mm: [canvas.w, canvas.h],
    pixels_per_cabinet: [canvas.w, canvas.h],
    output_topology: topo,
    shape_prior: { type: "flat" },
    shape_mode: "rectangle",
    irregular_mask: [],
    bottom_completion: null,
    position_m: [0, 0, 0],
    yaw_deg: 0,
    height_offset_mm: 0,
    normal_flip: false,
    origin_aligned: false,
  };
}

/* ------------------------------ 机器匹配 ------------------------------ */

/** 节点 ↔ 纳管机器：优先稳定 uid；清单里有这个 uid 就只认 uid，否则回退 ip / 主机名。 */
export function machineFor(machines: Machine[] | undefined, n: OutputNode): Machine | null {
  const list = machines ?? [];
  const uid = n.machine.machine_uid;
  if (uid) {
    const hit = list.find((m) => m.uid === uid);
    if (hit) return hit;
  }
  const host = n.machine.hostname.trim().toLowerCase();
  const ip = n.machine.ip.trim().toLowerCase();
  return list.find((m) => (host && m.hostname.trim().toLowerCase() === host) || (ip && m.ip.trim().toLowerCase() === ip)) ?? null;
}

/** 每个节点用哪份 UnrealEditor.exe（机器库里探测到的 UE 5.8）。 */
async function resolvePaths(topo: OutputTopology): Promise<RuntimePaths> {
  const machines = await listMachines();
  const editor_paths: Record<string, string> = {};
  for (const n of topo.nodes) {
    const m = machineFor(machines, n);
    if (!m || m.id == null) throw new Error(`${n.node_id}：机器库里找不到 ${n.machine.hostname || n.machine.ip || "目标机器"}`);
    const detail = await getMachineDetail(m.id);
    const install = detail.ue_installs.filter((u) => /^5\.8(?:\.|$)/.test(u.version)).sort((a, b) => Number(b.is_primary) - Number(a.is_primary))[0];
    if (!install) throw new Error(`${n.node_id}：${m.hostname} 上没有探测到 UE 5.8`);
    editor_paths[n.node_id] = `${install.install_path.replace(/[\\/]+$/, "")}\\Engine\\Binaries\\Win64\\UnrealEditor.exe`;
  }
  return { ...DEFAULT_NDISPLAY_OUTPUT_PATHS, editor_paths };
}

/* ------------------------------ 输出会话 ------------------------------ */

export type OutputPhase = "idle" | "standby" | "showing";
export type Picture = "black" | "pattern" | "sequence";
export type NodeRun = "queued" | "running" | "ok" | "error";

export interface LogLine {
  ts: number;
  node: string | null;
  text: string;
  tone: "info" | "ok" | "error";
}
export interface Preflight {
  at: number;
  error: string | null;
  nodes: { node_id: string; host: string; message: string }[];
}

interface OutputSession {
  session: string | null;
  phase: OutputPhase;
  busy: string | null;
  picture: Picture | null;
  startedAt: number | null;
  nodes: Record<string, { state: NodeRun; message: string; ts: number }>;
  log: LogLine[];
  preflight: Preflight | null;
  probed: string | null;
}

const blank = (session: string | null): OutputSession => ({ session, phase: "idle", busy: null, picture: null, startedAt: null, nodes: {}, log: [], preflight: null, probed: null });

export const useOutputSession = create<OutputSession>()(() => blank(null));

const patch = (p: Partial<OutputSession>) => useOutputSession.setState(p);
const log = (text: string, tone: LogLine["tone"] = "info", node: string | null = null) =>
  useOutputSession.setState((s) => ({ log: [{ ts: Date.now(), node, text, tone }, ...s.log].slice(0, 200) }));

export const sessionIdFor = (path: string) => `${path}::stage`;

/** 订阅 nDisplay 事件 + 首次进入时探测远端是否有本会话遗留的进程（有则恢复为黑场待机）。 */
export function useOutputRuntime(path: string | null, cfg: ProjectConfig | undefined, topo: OutputTopology | null) {
  const session = path ? sessionIdFor(path) : null;
  useEffect(() => {
    if (useOutputSession.getState().session !== session) useOutputSession.setState(blank(session));
    if (!session || !isTauri()) return;
    let alive = true;
    let off: (() => void) | null = null;
    listenNDisplayOutputEvent((e) => {
      if (e.session_id !== session) return;
      useOutputSession.setState((s) => ({ nodes: { ...s.nodes, [e.node_id]: { state: e.state, message: e.message, ts: e.timestamp_ms } } }));
      if (e.message) log(e.step ? `${e.step} · ${e.message}` : e.message, e.state === "error" ? "error" : e.state === "ok" ? "ok" : "info", e.node_id);
    })
      .then((fn) => (alive ? (off = fn) : fn()))
      .catch(() => undefined);
    return () => {
      alive = false;
      off?.();
    };
  }, [session]);

  useEffect(() => {
    const s = useOutputSession.getState();
    if (!session || !cfg || !topo || s.probed === session || s.phase !== "idle" || !isTauri()) return;
    patch({ probed: session });
    outputStatus({ session_id: session, screen: stageScreenForOutput(cfg, topo), paths: DEFAULT_NDISPLAY_OUTPUT_PATHS, ssh_user: null })
      .then((res) => {
        const running = res.nodes.filter((n) => n.running);
        if (!running.length) return;
        patch({ phase: "standby", picture: "black" });
        log(`检测到上次的输出仍在运行（${running.length}/${topo.nodes.length} 个节点），已恢复为黑场待机`, running.length < topo.nodes.length ? "error" : "ok");
      })
      .catch(() => undefined);
  }, [session, cfg, topo]);
}

async function run<T>(label: string, fn: () => Promise<T>): Promise<T> {
  patch({ busy: label });
  try {
    return await fn();
  } catch (e) {
    log(`${label}失败：${errText(e)}`, "error");
    throw e;
  } finally {
    patch({ busy: null });
  }
}

function req(path: string, cfg: ProjectConfig, topo: OutputTopology, paths: RuntimePaths = DEFAULT_NDISPLAY_OUTPUT_PATHS): RuntimeRequest {
  return { session_id: sessionIdFor(path), screen: stageScreenForOutput(cfg, topo), paths, ssh_user: null };
}

export async function runPreflight(path: string, cfg: ProjectConfig, topo: OutputTopology) {
  return run("预检", async () => {
    try {
      const paths = await resolvePaths(topo);
      const res = await outputPreflight(req(path, cfg, topo, paths));
      patch({ preflight: { at: Date.now(), error: null, nodes: res.nodes } });
      log("预检通过", "ok");
      return paths;
    } catch (e) {
      patch({ preflight: { at: Date.now(), error: errText(e), nodes: [] } });
      throw e;
    }
  });
}

/** 开始输出：预检 → 部署 → 启动（进入黑场待机）。 */
export async function startOutput(path: string, cfg: ProjectConfig, topo: OutputTopology) {
  const paths = await runPreflight(path, cfg, topo);
  await run("部署", async () => {
    patch({ nodes: {} });
    await outputDeploy({ ...req(path, cfg, topo, paths), ue_version: "5.8" });
    await outputStart(req(path, cfg, topo, paths));
    patch({ phase: "standby", picture: "black", startedAt: Date.now() });
    log(`部署完成，${topo.nodes.length} 个节点黑场待机`, "ok");
  });
}

export async function showPicture(path: string, cfg: ProjectConfig, topo: OutputTopology, pic: "black" | "pattern", patterns: Record<string, GeneratePatternResult> | undefined) {
  await run(pic === "black" ? "切到黑场" : "切到测试图", async () => {
    if (pic === "black") {
      await outputShow({ ...req(path, cfg, topo), mode: "clear", image_path: null });
      patch({ phase: "standby", picture: "black" });
      log("回到黑场");
      return;
    }
    const comp = composite(cfg.screens);
    await outputShow({
      ...req(path, cfg, topo),
      mode: "show",
      image_path: null,
      stage: {
        project_path: path,
        screens: comp.screens.map((r) => ({ screen_id: r.id, x: r.x, y: r.y, image_path: patterns?.[r.id] ? generatedPatternImagePath(patterns[r.id].output_dir) : null })),
      },
    });
    patch({ phase: "showing", picture: "pattern" });
    log("显示测试图", "ok");
  });
}

/** 按屏推指定图片（镜头标定的校正图案等）；没给图片的屏留黑。 */
export async function showStageImages(path: string, cfg: ProjectConfig, topo: OutputTopology, images: Record<string, string>, what: string) {
  await run(`显示${what}`, async () => {
    const comp = composite(cfg.screens);
    await outputShow({
      ...req(path, cfg, topo),
      mode: "show",
      image_path: null,
      stage: { project_path: path, screens: comp.screens.map((r) => ({ screen_id: r.id, x: r.x, y: r.y, image_path: images[r.id] ?? null })) },
    });
    patch({ phase: "showing", picture: "pattern" });
    log(`显示${what}`, "ok");
  });
}

export async function stopOutput(path: string, cfg: ProjectConfig, topo: OutputTopology) {
  await run("停止输出", async () => {
    await outputStop(req(path, cfg, topo));
    patch({ phase: "idle", picture: null, startedAt: null, nodes: {} });
    log("已停止输出");
  });
}

export const RENDER_SYNC_LABEL: Record<string, string> = { ethernet_barrier: "以太网屏障", none: "不同步" };
