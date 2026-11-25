/* 键控实验的状态：参数、素材、干净背景、预设、活动。
   引擎（WebGPU）绑在页面的 canvas 上，挂载时 attach、卸载时 detach；这里只持有当前实例。
   参数顺序 = uniform 布局 = UE cbuffer 布局（见 ../keyer/params.ts），本文件只改值不改结构。 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { saveFileBytes } from "@/api/commands";
import { persistOptions } from "@/lib/persist";
import type { KeyerEngine } from "../keyer/engine";
import { DEFAULTS, type KeyerParams } from "../keyer/params";

export const cloneParams = (p: KeyerParams): KeyerParams => ({ ...p, keyColor: [p.keyColor[0], p.keyColor[1], p.keyColor[2]] });

/** 0 无 / 1 已加载 / 2 已估计 / 3 动态 */
export type PlateState = 0 | 1 | 2 | 3;
export type KeyerView = 0 | 1 | 2 | 3;

export interface KeyerSource {
  name: string;
  kind: "video" | "image";
  w: number;
  h: number;
  /** 秒；图片为 0 */
  duration: number;
}

export interface KeyerEvent {
  key: string;
  at: number;
  kind: "success" | "failed" | "info";
  text: string;
}

interface KeyerState {
  params: KeyerParams;
  plate: PlateState;
  preset: string | null;
  source: KeyerSource | null;
  playing: boolean;
  time: number;
  stats: { fps: number; frameMs: number } | null;
  sampling: boolean;
  log: KeyerEvent[];
  set: (p: Partial<Omit<KeyerState, "set">>) => void;
}

export const useKeyer = create<KeyerState>()((set) => ({
  params: cloneParams(DEFAULTS),
  plate: 0,
  preset: null,
  source: null,
  playing: false,
  time: 0,
  stats: null,
  sampling: false,
  log: [],
  set: (p) => set(p),
}));

let seq = 0;
export function logKeyer(kind: KeyerEvent["kind"], text: string) {
  const ev: KeyerEvent = { key: `k${++seq}`, at: Date.now(), kind, text };
  useKeyer.setState((s) => ({ log: [ev, ...s.log].slice(0, 100) }));
}

/* ------------------------------ 引擎 ------------------------------ */

let engine: KeyerEngine | null = null;
export const getEngine = () => engine;
export function attachEngine(e: KeyerEngine | null) {
  engine = e;
  if (e) e.setParams(useKeyer.getState().params);
}

/** 改参数并重画一帧（视频播放中下一帧自然会用新参数）。 */
export function setParams(next: KeyerParams, opts: { keepPreset?: boolean } = {}) {
  const p = cloneParams(next);
  useKeyer.setState((s) => ({ params: p, preset: opts.keepPreset ? s.preset : null }));
  if (engine) {
    engine.setParams(p);
    engine.renderOnce();
  }
}
export const setParam = <K extends keyof KeyerParams>(key: K, value: KeyerParams[K]) => setParams({ ...useKeyer.getState().params, [key]: value });
/** 只换视图 / 分割线位置，不算改参数（预设名保留）。 */
export const setView = (patch: Partial<Pick<KeyerParams, "viewMode" | "wipe">>) => setParams({ ...useKeyer.getState().params, ...patch }, { keepPreset: true });

function syncFromEngine() {
  if (engine) useKeyer.setState({ params: cloneParams(engine.getParams()) });
}

export function resetDefaults() {
  const view = useKeyer.getState().params;
  setParams({ ...DEFAULTS, viewMode: view.viewMode, wipe: view.wipe });
  logKeyer("info", "参数恢复默认");
}

export async function sampleAt(u: number, v: number) {
  if (!engine) return;
  await engine.sampleKeyColor(u, v);
  engine.renderOnce();
  syncFromEngine();
  useKeyer.setState({ preset: null, sampling: false });
  logKeyer("info", `取样幕布色 ${keyColorBytes(useKeyer.getState().params.keyColor).join(" · ")}`);
}

export async function autoKey() {
  if (!engine) return;
  const video = useKeyer.getState().source?.kind === "video";
  await engine.autoKey(video);
  engine.renderOnce();
  syncFromEngine();
  useKeyer.setState({ plate: video ? 3 : 2, preset: null });
  logKeyer("success", `自动键控：幕布色 ${keyColorBytes(useKeyer.getState().params.keyColor).join(" · ")}，${video ? "动态" : "估计"}干净背景`);
}

export function setPlate(next: PlateState, bitmap?: ImageBitmap) {
  if (!engine) return;
  if (next === 0) engine.clearPlate();
  else if (next === 1 && bitmap) engine.loadPlate(bitmap);
  else if (next === 2) engine.estimatePlate(false);
  else if (next === 3) engine.estimatePlate(true);
  else return;
  engine.renderOnce();
  syncFromEngine();
  useKeyer.setState({ plate: next });
  logKeyer("info", ["清除干净背景", "加载干净背景", "从画面估计干净背景", "改为动态干净背景"][next]);
}

export async function exportPng() {
  if (!engine) return;
  const blob = await engine.exportPng();
  if (!blob) return;
  const name = (useKeyer.getState().source?.name ?? "keyer").replace(/\.[^.]+$/, "");
  const path = await saveFileBytes(`${name}_key.png`, "PNG", ["png"], new Uint8Array(await blob.arrayBuffer()));
  if (path) logKeyer("success", `导出 ${path}`);
  return path;
}

/* ------------------------------ 显示换算 ------------------------------ */

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const linToSrgbByte = (v: number) => {
  const x = clamp01(v);
  const y = x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
  return Math.round(clamp01(y) * 255);
};
export const keyColorBytes = (c: [number, number, number]) => c.map(linToSrgbByte) as [number, number, number];
export const keyColorCss = (c: [number, number, number]) => `rgb(${keyColorBytes(c).join(", ")})`;
export const clock = (s: number) => {
  const t = Math.max(0, Math.floor(s));
  return [Math.floor(t / 3600), Math.floor(t / 60) % 60, t % 60].map((n) => String(n).padStart(2, "0")).join(":");
};

/* ------------------------------ 预设（本机） ------------------------------ */

interface Presets {
  items: Record<string, KeyerParams>;
  save: (name: string, p: KeyerParams) => void;
  remove: (name: string) => void;
}
export const useKeyerPresets = create<Presets>()(
  persist(
    (set) => ({
      items: {},
      save: (name, p) => set((s) => ({ items: { ...s.items, [name]: cloneParams(p) } })),
      remove: (name) =>
        set((s) => {
          const items = { ...s.items };
          delete items[name];
          return { items };
        }),
    }),
    persistOptions("tools.keyer.presets", 1, (s: Presets) => ({ items: s.items })),
  ),
);

export function applyPreset(name: string) {
  const p = useKeyerPresets.getState().items[name];
  if (!p) return;
  const view = useKeyer.getState().params;
  setParams({ ...DEFAULTS, ...p, viewMode: view.viewMode, wipe: view.wipe });
  useKeyer.setState({ preset: name });
  logKeyer("info", `载入预设「${name}」`);
}
