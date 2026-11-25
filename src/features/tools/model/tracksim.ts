/* 追踪模拟：tracksim sidecar 的设置、运行状态和实时位姿。
   发送目标（地址 / 端口 / 传输）tracksim 只从配置文件读：开始前把设置写成 app data/tools/tracksim.json 传 --config。
   运行走 ndjson 流：start → progress（每帧位姿）→ warning → result。 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { readTracksimTrack, writeTracksimConfig } from "@/api/commands";
import { cancelSidecarTask, listenSidecarStream, spawnSidecarStreaming } from "@/api/sidecarStream";
import { persistOptions } from "@/lib/persist";

export type TrackSource = "track" | "fbx" | "controller";
export type TrackProtocol = "freed" | "opentrackio";
export type TrackTransport = "udp" | "serial";

export interface TracksimSettings {
  source: TrackSource;
  file: string;
  camera: string;
  rate: string;
  protocol: TrackProtocol;
  transport: TrackTransport;
  ip: string;
  port: string;
  serial: string;
  loop: boolean;
}

interface SettingsStore extends TracksimSettings {
  set: (p: Partial<TracksimSettings>) => void;
}
export const useTracksimSettings = create<SettingsStore>()(
  persist(
    (set) => ({
      source: "track",
      file: "",
      camera: "",
      rate: "",
      protocol: "freed",
      transport: "udp",
      ip: "127.0.0.1",
      port: "6301",
      serial: "",
      loop: true,
      set: (p) => set(p),
    }),
    persistOptions("tools.tracksim", 1, (st: SettingsStore): TracksimSettings => ({ source: st.source, file: st.file, camera: st.camera, rate: st.rate, protocol: st.protocol, transport: st.transport, ip: st.ip, port: st.port, serial: st.serial, loop: st.loop })),
  ),
);

export interface Pose {
  pan: number;
  tilt: number;
  roll: number;
  x: number;
  y: number;
  z: number;
  focal_length: number;
  focus_distance: number;
  frame?: number;
  timestamp?: number;
}

export interface TrackEvent {
  key: string;
  at: number;
  kind: "success" | "failed" | "info" | "running";
  text: string;
}

export type RunPhase = "idle" | "starting" | "running" | "done" | "failed";

interface RunState {
  phase: RunPhase;
  taskId: string | null;
  startedAt: number | null;
  /** 本次运行的设置快照（运行中改 Inspector 不影响） */
  run: TracksimSettings | null;
  rate: number | null;
  pose: Pose | null;
  packets: number;
  warnings: number;
  /** 最近播过的位置（m），给“已播”轨迹用 */
  trail: [number, number, number][];
  reason: string | null;
  error: string | null;
  log: TrackEvent[];
  lines: string[];
}

export const useTracksim = create<RunState>()(() => ({
  phase: "idle",
  taskId: null,
  startedAt: null,
  run: null,
  rate: null,
  pose: null,
  packets: 0,
  warnings: 0,
  trail: [],
  reason: null,
  error: null,
  log: [],
  lines: [],
}));

let seq = 0;
export function logTrack(kind: TrackEvent["kind"], text: string) {
  const ev: TrackEvent = { key: `t${++seq}`, at: Date.now(), kind, text };
  useTracksim.setState((s) => ({ log: [ev, ...s.log].slice(0, 200) }));
}

export const PROTOCOL_LABEL: Record<TrackProtocol, string> = { freed: "FreeD", opentrackio: "OpenTrackIO" };
export const SOURCE_LABEL: Record<TrackSource, string> = { track: "轨迹文件", fbx: "FBX", controller: "手柄" };
export const isLive = (p: RunPhase) => p === "starting" || p === "running";

/** 设置能不能开始；不能时给出原因。 */
export function settingsProblem(s: TracksimSettings): string | null {
  if (s.source !== "controller" && !s.file.trim()) return s.source === "fbx" ? "先选 FBX 文件" : "先选轨迹文件";
  if (s.rate.trim() && !(Number(s.rate) > 0)) return "频率要大于 0";
  if (s.transport === "serial") {
    if (s.protocol !== "freed") return "串口只支持 FreeD";
    if (!s.serial.trim()) return "填串口设备";
  } else {
    if (!s.ip.trim()) return "填目标地址";
    const port = Number(s.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return "端口要在 1–65535";
  }
  return null;
}

function configFor(s: TracksimSettings): Record<string, unknown> {
  const rate = Number(s.rate) > 0 ? Number(s.rate) : undefined;
  if (s.protocol === "freed") {
    return {
      protocols: { freed: true, opentrackio: false },
      freed: {
        transport: s.transport === "serial" ? "serial" : "udp_unicast",
        target_ip: s.ip.trim(),
        port: Number(s.port),
        serial_device: s.transport === "serial" ? s.serial.trim() : null,
        ...(rate ? { rate_hz: rate } : {}),
      },
    };
  }
  return {
    protocols: { freed: false, opentrackio: true },
    opentrackio: { transport: "unicast", ip: s.ip.trim(), port: Number(s.port), ...(rate ? { rate_hz: rate } : {}) },
  };
}

export const targetLabel = (s: TracksimSettings) => (s.transport === "serial" ? `串口 ${s.serial}` : `${s.ip}:${s.port}`);

export async function startTracksim(s: TracksimSettings) {
  const problem = settingsProblem(s);
  if (problem) throw new Error(problem);
  useTracksim.setState({ phase: "starting", run: { ...s }, startedAt: Date.now(), pose: null, packets: 0, warnings: 0, trail: [], reason: null, error: null, lines: [], rate: null });
  try {
    const cfg = await writeTracksimConfig(configFor(s));
    const args = ["run", "--config", cfg, "--source", s.source, "--protocol", s.protocol, "-o", "ndjson"];
    if (s.source !== "controller") args.push(s.file.trim());
    if (s.source === "fbx" && s.camera.trim()) args.push("--camera", s.camera.trim());
    if (Number(s.rate) > 0) args.push("--rate", String(Number(s.rate)));
    if (s.loop && s.source !== "controller") args.push("--loop");
    const { task_id } = await spawnSidecarStreaming("tracksim", args);
    useTracksim.setState({ taskId: task_id });
    logTrack("running", `开始发送 ${PROTOCOL_LABEL[s.protocol]} → ${targetLabel(s)}`);
    let off: (() => void) | null = null;
    let exited = false;
    let lastFlush = 0;
    let pending: Partial<RunState> | null = null;
    const flush = () => {
      if (pending) useTracksim.setState(pending);
      pending = null;
    };
    void listenSidecarStream(task_id, (ev) => {
      if (ev.kind === "line") {
        const p = ev.parsed as Record<string, unknown> | undefined;
        if (!p || typeof p !== "object") {
          useTracksim.setState((st) => ({ lines: [...st.lines, ev.raw].slice(-500) }));
          return;
        }
        if (p.type === "start") {
          useTracksim.setState({ phase: "running", rate: typeof p.rate === "number" ? p.rate : null });
        } else if (p.type === "progress") {
          const pose = p.pose as Pose;
          const st = useTracksim.getState();
          const last = st.trail[st.trail.length - 1];
          const pt: [number, number, number] = [pose.x, pose.y, pose.z];
          const moved = !last || Math.hypot(pt[0] - last[0], pt[1] - last[1], pt[2] - last[2]) > 0.01;
          pending = { pose, packets: Number(p.packets_sent) || 0, trail: moved ? [...(pending?.trail ?? st.trail), pt].slice(-4000) : (pending?.trail ?? st.trail) };
          const now = performance.now();
          if (now - lastFlush > 66) {
            lastFlush = now;
            flush();
          }
        } else if (p.type === "warning") {
          useTracksim.setState((st) => ({ warnings: st.warnings + 1, lines: [...st.lines, `warning: ${String(p.message)}`].slice(-500) }));
          logTrack("failed", `发送失败：${String(p.message)}`);
        } else if (p.type === "result") {
          flush();
          if (p.status === "error") {
            const err = (p.error as { message?: string } | undefined)?.message ?? "tracksim 出错";
            useTracksim.setState({ error: err });
          } else useTracksim.setState({ reason: typeof p.reason === "string" ? p.reason : null, packets: Number(p.total_packets) || useTracksim.getState().packets });
        }
        if (p.type !== "progress") useTracksim.setState((st) => ({ lines: [...st.lines, ev.raw].slice(-500) }));
        return;
      }
      exited = true;
      off?.();
      flush();
      const st = useTracksim.getState();
      if (ev.cancelled) {
        useTracksim.setState({ phase: "done", taskId: null, reason: "stopped" });
        logTrack("info", `已停止，共发 ${st.packets} 包`);
      } else if (ev.exit_code === 0 && !st.error) {
        useTracksim.setState({ phase: "done", taskId: null });
        logTrack("success", `播完，共发 ${st.packets} 包`);
      } else {
        const msg = st.error ?? (ev.stderr_tail.trim().split("\n").pop() || `tracksim 异常退出（exit ${ev.exit_code}）`);
        useTracksim.setState({ phase: "failed", taskId: null, error: msg });
        logTrack("failed", msg);
      }
    }).then((u) => {
      if (exited) u();
      else off = u;
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    useTracksim.setState({ phase: "failed", error: msg, taskId: null });
    logTrack("failed", msg);
    throw e;
  }
}

export async function stopTracksim() {
  const id = useTracksim.getState().taskId;
  if (id) await cancelSidecarTask(id);
}

/* ------------------------------ 轨迹预览 ------------------------------ */

export interface TrackPreview {
  rate: number;
  camera: string;
  duration: number;
  points: [number, number, number][];
}

/** 读轨迹 JSON 给预览用；CSV / FBX 不预览（返回 null）。 */
export async function loadTrackPreview(path: string): Promise<TrackPreview | null> {
  if (!/\.json$/i.test(path)) return null;
  const v = (await readTracksimTrack(path)) as { rate?: number; camera?: string; frames: { t: number; pose: Partial<Pose> }[] };
  const frames = v.frames ?? [];
  const pts = frames.map((f) => [f.pose.x ?? 0, f.pose.y ?? 0, f.pose.z ?? 0] as [number, number, number]);
  const duration = frames.length > 1 ? frames[frames.length - 1].t - frames[0].t : 0;
  return { rate: Number(v.rate) || 0, camera: v.camera ?? "", duration, points: pts };
}

export const pathLength = (pts: [number, number, number][]) => pts.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1], p[2] - pts[i - 1][2]) : 0), 0);

/* ------------------------------ 手柄映射 ------------------------------ */

/** tracksim 内置默认映射（sidecars/tracksim/src/tracksim/config.py DEFAULT_CONTROLLER_MAPPING），配置里没写映射时生效。 */
export const DEFAULT_MAPPING: { input: string; channel: string; note: string }[] = [
  { input: "左摇杆 左右", channel: "X", note: "±10 m" },
  { input: "左摇杆 上下", channel: "Y", note: "±10 m · 反向" },
  { input: "左扳机 / 右扳机", channel: "Z", note: "下降 / 上升 · 0–10 m" },
  { input: "右摇杆 左右", channel: "水平", note: "60°/s" },
  { input: "右摇杆 上下", channel: "俯仰", note: "60°/s · ±90°" },
  { input: "左肩键 / 右肩键", channel: "横滚", note: "30°/s · ±30°" },
  { input: "上排拨片 P1 / P3", channel: "焦距", note: "50 mm/s · 12–300 mm" },
  { input: "下排拨片 P2 / P4", channel: "对焦", note: "1 m/s · 0.1–100 m" },
];
