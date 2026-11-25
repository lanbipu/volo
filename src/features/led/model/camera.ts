/* 舞台 LED · 摄影机：project.yaml cameras[]、采集配置（视频源）、镜头标定（多机位抓帧 → vpcal lens-cal）。
   镜头标定流程：导出屏幕定义 + 生成校正图案 → 推到上屏 → `vpcal capture stills` 自动抓帧 → 达到目标帧数自动 finish
   → `tracker-free lens-cal` 求内参 → `lens-info` 资格检查 → 合格且 RMS 低于阈值、不比现用的差 → 写回 cameras[].lens。
   每次标定一个目录：<stage>/vpcal/lens-captures/lens_<时间>/，lens.json 与 fixed_run.json（元数据）都在里面。 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { listCaptureProfiles, saveCaptureProfiles, enumerateVideoSources, type CaptureProfile, type VideoSourceInfo } from "@/api/captureProfiles";
import { isTauri } from "@/api/invoke";
import { listLensSessions, listNetInterfaces, stillsFinish, startCaptureStills, trackerFreeLensCal, trackerFreeLensInfo, writeFixedRunMeta, type LensSessionSummary, type TrackerFreeLensInfo } from "@/api/lensCommands";
import { ensureScreenPatterns, lensWorkspacePaths, type EnsureResult } from "@/api/lensWorkspace";
import { cancelSidecarTaskAwaitExit, listenSidecarStream, sidecarStdinWrite, spawnSidecarStreaming, type SidecarStreamEvent } from "@/api/sidecarStream";
import type { ProjectCamera, ProjectCameraLens, ProjectConfig } from "@/api/types";
import { persistOptions } from "@/lib/persist";
import { errText } from "@/lib/toast";
import { resolveTopology, showPicture, showStageImages, useOutputSession } from "./output";

/** 自动采用的 RMS 上限（px）。 */
export const RMS_ADOPT_PX = 0.5;
export const GRID_COLS = 6;
export const GRID_ROWS = 4;
export const GRID_CELLS = GRID_COLS * GRID_ROWS;

export const camKeys = {
  profiles: ["led", "capture-profiles"] as const,
  sessions: (path: string) => ["led", "lens-sessions", path] as const,
  lensInfo: (p: string) => ["led", "lens-info", p] as const,
  target: (path: string, screen: string) => ["led", "lens-target", path, screen] as const,
  sources: (backend: string) => ["led", "video-sources", backend] as const,
  nics: ["led", "nics"] as const,
};

/* ------------------------------ 路径 ------------------------------ */

const sepOf = (p: string) => (p.includes("\\") ? "\\" : "/");
export const joinPath = (dir: string, ...names: string[]) => names.reduce((d, n) => d.replace(/[\\/]+$/, "") + sepOf(dir) + n, dir);
export const lensRoot = (path: string) => joinPath(lensWorkspacePaths(path).vpcalDir, "lens-captures");
export const baseName = (p: string | null | undefined) => (p ? (p.split(/[\\/]+/).filter(Boolean).pop() ?? p) : "");

/* ------------------------------ 显示 ------------------------------ */

export const cameraLabel = (c: Pick<ProjectCamera, "name" | "lens">) => (c.lens?.focal_mm ? `${c.name} · ${+c.lens.focal_mm.toFixed(1)} mm` : c.name);
export const camTab = (c: ProjectCamera) => ({ id: `camera:${c.id}`, label: cameraLabel(c) });
export const PROTOCOL_LABEL: Record<string, string> = { freed: "FreeD", opentrackio: "OpenTrackIO" };
export const BACKENDS: { value: string; label: string }[] = [
  { value: "decklink", label: "采集卡" },
  { value: "ndi", label: "NDI" },
  { value: "uvc", label: "USB 摄像头" },
  { value: "synthetic", label: "合成测试源" },
];

export function formatSource(s: VideoSourceInfo | null | undefined) {
  if (!s) return null;
  const fps = s.fps ? `${+Number(s.fps).toFixed(2)}p` : null;
  return [`${s.width} × ${s.height}`, fps].filter(Boolean).join(" · ");
}

/* ------------------------------ 界面偏好 ------------------------------ */

export type CamTab = "capture" | "result" | "history";
export type CamInspTab = "pre" | "source" | "params";

interface CameraUi {
  tab: CamTab;
  insp: CamInspTab;
  sel: string | null;
  /** 结果页看的那一次（session 目录）；null = 这台摄影机最新一次。 */
  session: string | null;
  screen: string | null;
  target: number;
  minMarkers: number;
  auto: boolean;
  heat: boolean;
  markers: boolean;
  set: (p: Partial<Omit<CameraUi, "set">>) => void;
}

export const useCameraUi = create<CameraUi>()(
  persist(
    (set) => ({ tab: "capture", insp: "pre", sel: null, session: null, screen: null, target: 18, minMarkers: 6, auto: true, heat: true, markers: false, set: (p) => set(p) }),
    persistOptions<CameraUi, Omit<CameraUi, "set" | "session">>("led.camera", 1, ({ tab, insp, sel, screen, target, minMarkers, auto, heat, markers }) => ({ tab, insp, sel, screen, target, minMarkers, auto, heat, markers })),
  ),
);

/* ------------------------------ 采集配置 / 摄影机 ------------------------------ */

export interface VideoProfile {
  backend: string;
  device: string;
  fmtMode: "auto" | "manual";
  width: number | null;
  height: number | null;
  fps: number | null;
  transferFunction: string;
}

export function videoOf(p: CaptureProfile | null | undefined): VideoProfile | null {
  if (!p) return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(+v) ? +v : null);
  return {
    backend: typeof p.videoBackend === "string" ? p.videoBackend : "uvc",
    device: p.device == null ? "" : String(p.device),
    fmtMode: p.fmtMode === "manual" ? "manual" : "auto",
    width: n(p.width),
    height: n(p.height),
    fps: n(p.fps),
    transferFunction: typeof p.transferFunction === "string" ? p.transferFunction : "sdr",
  };
}

export function useCaptureProfiles() {
  return useQuery({ queryKey: camKeys.profiles, queryFn: listCaptureProfiles, enabled: isTauri() });
}

export const profileFor = (cam: ProjectCamera | null, profiles: CaptureProfile[] | undefined) => (cam && profiles?.find((p) => p.id === cam.video_profile_id)) ?? null;

export function useSaveProfiles() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (profiles: CaptureProfile[]) => saveCaptureProfiles(profiles),
    onMutate: (profiles) => {
      qc.setQueryData(camKeys.profiles, (old: { profiles: CaptureProfile[]; initialized: boolean } | undefined) => ({ initialized: old?.initialized ?? true, profiles }));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: camKeys.profiles }),
  });
}

export function useVideoSources(backend: string | null) {
  return useQuery({ queryKey: camKeys.sources(backend ?? ""), queryFn: () => enumerateVideoSources(backend as string, 3), enabled: isTauri() && !!backend && backend !== "synthetic", staleTime: 60_000, retry: false });
}

export function useNics() {
  return useQuery({ queryKey: camKeys.nics, queryFn: listNetInterfaces, enabled: isTauri(), staleTime: 60_000 });
}

export function withCamera(cfg: ProjectConfig, id: string, fn: (c: ProjectCamera) => ProjectCamera): ProjectConfig {
  return { ...cfg, cameras: (cfg.cameras ?? []).map((c) => (c.id === id ? fn(c) : c)) };
}

export function newCamera(cfg: ProjectConfig): ProjectCamera {
  const n = (cfg.cameras?.length ?? 0) + 1;
  const letter = String.fromCharCode(64 + Math.min(n, 26));
  return { id: `cam-${String(n).padStart(2, "0")}-${Date.now().toString(36).slice(-4)}`, name: `${letter} 机`, lens: null, tracking: null, video_profile_id: null, manual_pose: null, solve_pose: null, active_run_id: null };
}

/* ------------------------------ 标定记录 ------------------------------ */

export function useLensSessions(path: string | null) {
  return useQuery({ queryKey: camKeys.sessions(path ?? ""), queryFn: () => listLensSessions(lensRoot(path as string)), enabled: isTauri() && !!path });
}

export function useLensInfo(lensPath: string | null | undefined) {
  return useQuery({ queryKey: camKeys.lensInfo(lensPath ?? ""), queryFn: () => trackerFreeLensInfo(lensPath as string), enabled: isTauri() && !!lensPath, staleTime: Infinity, retry: false });
}

/** 这台摄影机的标定记录，新的在前。 */
export function sessionsFor(all: LensSessionSummary[] | undefined, camId: string) {
  return (all ?? []).filter((s) => s.camera_id === camId).sort((a, b) => (b.modified_at ?? "").localeCompare(a.modified_at ?? ""));
}

/** 标定前置：导出屏幕定义 + 生成校正图案（幂等，新鲜就直接返回）。 */
export function useLensTarget(path: string | null, screen: string | null) {
  return useQuery({ queryKey: camKeys.target(path ?? "", screen ?? ""), queryFn: () => ensureScreenPatterns(path as string, screen as string), enabled: isTauri() && !!path && !!screen, staleTime: Infinity, retry: false });
}

export function lensPatch(lens: ProjectCameraLens | null | undefined, lensPath: string, info: TrackerFreeLensInfo): ProjectCameraLens {
  return {
    ...(lens ?? {}),
    profile_path: lensPath,
    is_master: info.qualified_master,
    calibration_kind: info.calibration_kind,
    image_size: info.image_size,
    calibration_rms_px: info.rms,
    calibration_poses: info.num_images,
    calibration_points: info.num_points,
    session_coupled: info.session_coupled,
  };
}

/** 一次标定结果的结论（结果页头部与 Inspector 共用）。 */
export function lensVerdict(cam: ProjectCamera, session: LensSessionSummary, info: TrackerFreeLensInfo | undefined, failed: boolean) {
  const adopted = !!session.lens_json && cam.lens?.profile_path === session.lens_json;
  if (!info) return { adopted, kind: failed ? ("failed" as const) : ("queued" as const), label: failed ? "需处理" : "读取中", title: failed ? "读不到这次的结果" : "正在读取结果" };
  if (adopted) return { adopted, kind: "success" as const, label: "已采用", title: "这次结果正在使用" };
  if (!info.qualified_master) return { adopted, kind: "failed" as const, label: "需处理", title: "没通过镜头资格检查" };
  if (info.rms >= RMS_ADOPT_PX) return { adopted, kind: "failed" as const, label: "需处理", title: "残差偏高，没有采用" };
  return { adopted, kind: "attention" as const, label: "未采用", title: "比现在采用的差，没有替换" };
}

/** 自动采用：合格、RMS 低于阈值、不比现用的差。 */
export function shouldAdopt(cam: ProjectCamera, info: TrackerFreeLensInfo) {
  const prev = cam.lens?.calibration_rms_px;
  return info.qualified_master && info.rms < RMS_ADOPT_PX && (prev == null || info.rms <= prev);
}

/* ------------------------------ 监看（空闲时的实时画面） ------------------------------ */

interface MonitorState {
  key: string | null;
  task: string | null;
  url: string | null;
  source: VideoSourceInfo | null;
  sig: "off" | "waiting" | "ok" | "lost";
  error: string | null;
}
export const useMonitor = create<MonitorState>()(() => ({ key: null, task: null, url: null, source: null, sig: "off", error: null }));
let monitorUnlisten: (() => void) | null = null;

const profileKey = (v: VideoProfile) => [v.backend, v.device, v.fmtMode, v.width, v.height, v.fps, v.transferFunction].join("|");

export async function startMonitor(v: VideoProfile) {
  const key = profileKey(v);
  const cur = useMonitor.getState();
  if (cur.key === key && cur.task) return;
  await stopMonitor();
  if (v.backend === "synthetic" || !v.device) return;
  useMonitor.setState({ key, sig: "waiting", url: null, source: null, error: null });
  const args = ["capture", "video", "--backend", v.backend, "--device", v.device, "--allow-hx", "--preview-port", "0", "--duration", "0", "--output", "json"];
  if (v.fmtMode === "manual" && v.width) args.push("--width", String(v.width));
  if (v.fmtMode === "manual" && v.height) args.push("--height", String(v.height));
  if (v.fmtMode === "manual" && v.fps) args.push("--fps", String(v.fps));
  args.push("--transfer-function", v.transferFunction);
  try {
    const { task_id } = await spawnSidecarStreaming("vpcal", args);
    if (useMonitor.getState().key !== key) {
      void cancelSidecarTaskAwaitExit(task_id);
      return;
    }
    useMonitor.setState({ task: task_id });
    monitorUnlisten = await listenSidecarStream(task_id, (ev) => {
      if (useMonitor.getState().task !== task_id) return;
      if (ev.kind === "exit") {
        useMonitor.setState({ task: null, url: null, sig: ev.cancelled ? "off" : "lost", error: ev.cancelled ? null : ev.stderr_tail || null });
        return;
      }
      const p = ev.parsed as Record<string, unknown> | undefined;
      if (p?.type === "preview_ready" && typeof p.mjpeg_url === "string") useMonitor.setState({ url: p.mjpeg_url });
      if (p?.type === "source_info") useMonitor.setState({ source: p as unknown as VideoSourceInfo, sig: "ok" });
    });
  } catch (e) {
    useMonitor.setState({ key: null, task: null, sig: "lost", error: errText(e) });
  }
}

export async function stopMonitor() {
  const { task } = useMonitor.getState();
  monitorUnlisten?.();
  monitorUnlisten = null;
  useMonitor.setState({ key: null, task: null, url: null, sig: "off" });
  if (task) await cancelSidecarTaskAwaitExit(task);
}

/* ------------------------------ 追踪监听 ------------------------------ */

export interface TrackPose {
  x: number;
  y: number;
  z: number;
  pan: number;
  tilt: number;
  roll: number;
  zoom: number | null;
  focus: number | null;
}

interface TrackState {
  task: string | null;
  label: string | null;
  pose: TrackPose | null;
  total: number;
  rate: number | null;
  cameraIds: number[];
  error: string | null;
}
export const useTracking = create<TrackState>()(() => ({ task: null, label: null, pose: null, total: 0, rate: null, cameraIds: [], error: null }));
let trackUnlisten: (() => void) | null = null;

export async function startTracking(protocol: string, host: string, port: number) {
  await stopTracking();
  useTracking.setState({ label: `${PROTOCOL_LABEL[protocol] ?? protocol} · UDP ${port}`, pose: null, total: 0, rate: null, cameraIds: [], error: null });
  try {
    const { task_id } = await spawnSidecarStreaming("vpcal", ["capture", "track", "--monitor", "--protocol", protocol, "--host", host, "--port", String(port), "--output", "ndjson"]);
    useTracking.setState({ task: task_id });
    let first: { t: number; total: number } | null = null;
    trackUnlisten = await listenSidecarStream(task_id, (ev) => {
      if (useTracking.getState().task !== task_id) return;
      if (ev.kind === "exit") {
        useTracking.setState({ task: null, error: ev.cancelled ? null : ev.stderr_tail || "监听已退出" });
        return;
      }
      const p = ev.parsed as Record<string, unknown> | undefined;
      if (p?.type !== "monitor") return;
      const pose = (p.pose ?? {}) as Record<string, unknown>;
      const pos = (pose.position ?? pose.translation ?? [0, 0, 0]) as number[];
      const rotation = (pose.rotation ?? {}) as { values?: number[] };
      const rot = (rotation.values ?? pose.euler_deg ?? []) as number[];
      const total = Number(p.total ?? 0);
      const now = Date.now();
      if (!first) first = { t: now, total };
      const dt = (now - first.t) / 1000;
      const camId = typeof p.camera_id === "number" ? p.camera_id : null;
      const ids = useTracking.getState().cameraIds;
      useTracking.setState({
        pose: {
          x: Number(pos[0] ?? 0) / 1000,
          y: Number(pos[1] ?? 0) / 1000,
          z: Number(pos[2] ?? 0) / 1000,
          pan: Number(rot[0] ?? 0),
          tilt: Number(rot[1] ?? 0),
          roll: Number(rot[2] ?? 0),
          zoom: (pose.zoom_raw ?? p.zoom_raw ?? null) as number | null,
          focus: (pose.focus_raw ?? p.focus_raw ?? null) as number | null,
        },
        total,
        rate: dt > 1 ? Math.round((total - first.total) / dt) : null,
        cameraIds: camId != null && !ids.includes(camId) ? [...ids, camId].sort((a, b) => a - b) : ids,
      });
    });
  } catch (e) {
    useTracking.setState({ task: null, error: errText(e) });
  }
}

export async function stopTracking() {
  const { task } = useTracking.getState();
  trackUnlisten?.();
  trackUnlisten = null;
  useTracking.setState({ task: null });
  if (task) await cancelSidecarTaskAwaitExit(task);
}

/* ------------------------------ 镜头标定（采集 + 求解） ------------------------------ */

export interface Snap {
  index: number;
  path: string;
  markers: number | null;
  auto: boolean;
}

export type CapturePhase = "idle" | "preparing" | "capturing" | "solving" | "done" | "failed";

interface CaptureState {
  camId: string | null;
  phase: CapturePhase;
  task: string | null;
  outDir: string | null;
  startedAt: number | null;
  target: number;
  snaps: Snap[];
  /** 画面 6 × 4 格是否有观测（按抓帧时检测到的标记范围累计）。 */
  cells: boolean[];
  preview: string | null;
  source: VideoSourceInfo | null;
  markers: number | null;
  warning: string | null;
  error: string | null;
  /** 刚完成的一次：lens.json 路径 + 是否已自动采用。 */
  done: { lensJson: string; info: TrackerFreeLensInfo; adopted: boolean } | null;
}

const idleCapture = (): CaptureState => ({ camId: null, phase: "idle", task: null, outDir: null, startedAt: null, target: 0, snaps: [], cells: Array(GRID_CELLS).fill(false), preview: null, source: null, markers: null, warning: null, error: null, done: null });
export const useCapture = create<CaptureState>()(() => idleCapture());
const cap = (p: Partial<CaptureState>) => useCapture.setState(p);

/** 每次标定的画面覆盖（只在本机记，求解结果里不带）。 */
export const useCoverage = create<{ byDir: Record<string, boolean[]>; put: (dir: string, cells: boolean[]) => void }>()(
  persist((set) => ({ byDir: {}, put: (dir, cells) => set((s) => ({ byDir: { ...s.byDir, [dir]: cells } })) }), persistOptions<{ byDir: Record<string, boolean[]>; put: (dir: string, cells: boolean[]) => void }, { byDir: Record<string, boolean[]> }>("led.lens-coverage", 1, ({ byDir }) => ({ byDir }))),
);

function markCells(cells: boolean[], bbox: number[] | null): boolean[] {
  if (!bbox || bbox.length < 4) return cells;
  const [x0, y0, x1, y1] = bbox;
  const next = cells.slice();
  for (let r = 0; r < GRID_ROWS; r++)
    for (let c = 0; c < GRID_COLS; c++) {
      const cx0 = c / GRID_COLS, cx1 = (c + 1) / GRID_COLS, cy0 = r / GRID_ROWS, cy1 = (r + 1) / GRID_ROWS;
      const ox = Math.min(x1, cx1) - Math.max(x0, cx0);
      const oy = Math.min(y1, cy1) - Math.max(y0, cy0);
      if (ox > 0 && oy > 0 && (ox * oy) / ((cx1 - cx0) * (cy1 - cy0)) > 0.5) next[r * GRID_COLS + c] = true;
    }
  return next;
}

/** 覆盖缺口的口头描述：左上、右下… */
export function missingText(cells: boolean[]): string | null {
  const zones: [string, (r: number, c: number) => boolean][] = [
    ["左上", (r, c) => r < 2 && c < 3],
    ["右上", (r, c) => r < 2 && c >= 3],
    ["左下", (r, c) => r >= 2 && c < 3],
    ["右下", (r, c) => r >= 2 && c >= 3],
  ];
  const miss = zones.filter(([, inZone]) => cells.some((v, i) => !v && inZone(Math.floor(i / GRID_COLS), i % GRID_COLS))).map(([n]) => n);
  return miss.length ? miss.join("、") : null;
}

let captureUnlisten: (() => void) | null = null;
let lastBbox: number[] | null = null;
let finishing = false;

export interface StartLensOpts {
  path: string;
  cfg: ProjectConfig;
  cam: ProjectCamera;
  video: VideoProfile;
  screen: string;
  target: number;
  minMarkers: number;
  auto: boolean;
  save: (next: ProjectConfig) => Promise<unknown>;
  latestCfg: () => ProjectConfig | undefined;
  onSessions: () => void;
}

export async function startLensCapture(o: StartLensOpts) {
  const topo = resolveTopology(o.cfg);
  if (!topo) throw new Error("还没有输出拓扑，先在「上屏」里配置。");
  if (useOutputSession.getState().phase === "idle") throw new Error("上屏还没开始输出。先到「上屏」开始输出。");
  useCapture.setState({ ...idleCapture(), camId: o.cam.id, phase: "preparing", target: o.target });
  let t: EnsureResult;
  try {
    t = await ensureScreenPatterns(o.path, o.screen);
    await showStageImages(o.path, o.cfg, topo, { [o.screen]: joinPath(t.patternsDir, "normal.png") }, "校正图案");
    await stopMonitor();
  } catch (e) {
    cap({ phase: "failed", error: errText(e) });
    throw e;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = joinPath(lensRoot(o.path), `lens_${stamp}`);
  lastBbox = null;
  finishing = false;
  try {
    const { task_id } = await startCaptureStills({
      backend: o.video.backend,
      device: o.video.device,
      outDir,
      auto: o.auto,
      minMarkers: o.minMarkers,
      width: o.video.fmtMode === "manual" ? o.video.width : null,
      height: o.video.fmtMode === "manual" ? o.video.height : null,
      fps: o.video.fmtMode === "manual" ? o.video.fps : null,
      transferFunction: o.video.transferFunction,
    });
    cap({ phase: "capturing", task: task_id, outDir, startedAt: Date.now() });
    captureUnlisten = await listenSidecarStream(task_id, (ev) => onCaptureEvent(ev, task_id, o, t, outDir));
  } catch (e) {
    cap({ phase: "failed", task: null, error: errText(e) });
    throw e;
  }
}

function onCaptureEvent(ev: SidecarStreamEvent, task: string, o: StartLensOpts, t: EnsureResult, outDir: string) {
  if (useCapture.getState().task !== task) return;
  if (ev.kind === "exit") {
    captureUnlisten?.();
    captureUnlisten = null;
    const s = useCapture.getState();
    if (s.phase === "capturing") cap({ task: null, phase: ev.cancelled ? "idle" : "failed", error: ev.cancelled ? null : ev.stderr_tail || `采集进程退出（${ev.exit_code}）` });
    return;
  }
  const p = ev.parsed as Record<string, unknown> | undefined;
  if (!p || typeof p.type !== "string") return;
  switch (p.type) {
    case "preview_ready":
      if (typeof p.mjpeg_url === "string") cap({ preview: p.mjpeg_url });
      break;
    case "source_info":
      cap({ source: p as unknown as VideoSourceInfo });
      break;
    case "detect_state":
      if (!p.stale) {
        lastBbox = Array.isArray(p.bbox_frac) ? (p.bbox_frac as number[]) : null;
        cap({ markers: typeof p.markers === "number" ? p.markers : null });
      }
      break;
    case "warning":
      cap({ warning: typeof p.message === "string" ? p.message : null });
      break;
    case "snap_saved": {
      const s = useCapture.getState();
      const snap: Snap = { index: Number(p.index ?? s.snaps.length), path: String(p.path ?? ""), markers: typeof p.markers === "number" ? p.markers : null, auto: !!p.auto };
      const snaps = [...s.snaps.filter((x) => x.index !== snap.index), snap];
      cap({ snaps, cells: markCells(s.cells, lastBbox) });
      if (snaps.length >= s.target && !finishing) {
        finishing = true;
        void stillsFinish(task);
      }
      break;
    }
    case "result":
      void solve(o, t, outDir, Number((p.data as Record<string, unknown> | undefined)?.frames_captured ?? useCapture.getState().snaps.length));
      break;
  }
}

async function solve(o: StartLensOpts, t: EnsureResult, outDir: string, frames: number) {
  captureUnlisten?.();
  captureUnlisten = null;
  cap({ phase: "solving", task: null });
  useCoverage.getState().put(outDir, useCapture.getState().cells);
  const topo = resolveTopology(o.cfg);
  if (topo) void showPicture(o.path, o.cfg, topo, "black", undefined).catch(() => {});
  const lensJson = joinPath(outDir, "lens.json");
  try {
    await trackerFreeLensCal({ imagesDir: joinPath(outDir, "captures", "normal"), screenPath: t.screenJson, outLensJson: lensJson, cabColOffset: t.offset, screenId: t.code });
    const info = await trackerFreeLensInfo(lensJson);
    await writeFixedRunMeta(outDir, { mode: "fixed", purpose: "master_lens", camera_id: o.cam.id, frames_captured: frames, screen: o.screen, lens_json: lensJson, rms: info.rms, coverage: useCapture.getState().cells });
    const cfg = o.latestCfg() ?? o.cfg;
    const cam = cfg.cameras?.find((c) => c.id === o.cam.id) ?? o.cam;
    const adopted = shouldAdopt(cam, info);
    if (adopted) await o.save(withCamera(cfg, cam.id, (c) => ({ ...c, lens: lensPatch(c.lens, lensJson, info) })));
    cap({ phase: "done", done: { lensJson, info, adopted } });
  } catch (e) {
    cap({ phase: "failed", error: `求解失败：${errText(e)}。采到的帧保留在 ${outDir}` });
  } finally {
    o.onSessions();
  }
}

export async function finishLensCapture() {
  const { task } = useCapture.getState();
  if (!task || finishing) return;
  finishing = true;
  await stillsFinish(task);
}

export async function snapNow() {
  const { task } = useCapture.getState();
  if (task) await sidecarStdinWrite(task, JSON.stringify({ cmd: "snap" }));
}

export async function abortLensCapture(path: string, cfg: ProjectConfig) {
  const { task } = useCapture.getState();
  captureUnlisten?.();
  captureUnlisten = null;
  useCapture.setState(idleCapture());
  if (task) await cancelSidecarTaskAwaitExit(task);
  const topo = resolveTopology(cfg);
  if (topo && useOutputSession.getState().phase === "showing") await showPicture(path, cfg, topo, "black", undefined).catch(() => {});
}

export const resetCapture = () => useCapture.setState(idleCapture());
