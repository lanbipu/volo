/* 参数 schema —— 顺序 = uniform 布局 = UE cbuffer 布局，不得插队重排。 */
export interface KeyerParams {
  keyColor: [number, number, number]; balance: number;
  blackClip: number; whiteClip: number; softness: number; shrink: number;
  feather: number; despillStrength: number; despillBalance: number; lumaRestore: number;
  denoise: number; matteStab: number; plateMode: number; viewMode: number;
  wipe: number;
}
export const DEFAULTS: KeyerParams = {
  keyColor: [0.15, 0.6, 0.15], balance: 0.5,
  blackClip: 0.05, whiteClip: 0.95, softness: 1.0, shrink: 0,
  feather: 1.0, despillStrength: 0.8, despillBalance: 0.5, lumaRestore: 0.5,
  denoise: 0.4, matteStab: 0.5, plateMode: 0, viewMode: 0, wipe: 0.5,
};
export interface Knob { key: keyof KeyerParams; label: string; min: number; max: number; step: number; }
export const KNOBS: Knob[] = [
  { key: "balance",         label: "色差平衡",     min: 0,   max: 1, step: 0.01 },
  { key: "blackClip",       label: "黑位",         min: 0,   max: 0.5, step: 0.005 },
  { key: "whiteClip",       label: "白位",         min: 0.5, max: 1, step: 0.005 },
  { key: "softness",        label: "边缘软度",     min: 0.4, max: 3, step: 0.02 },
  { key: "shrink",          label: "收缩",         min: -3,  max: 3, step: 0.1 },
  { key: "feather",         label: "羽化",         min: 0,   max: 5, step: 0.1 },
  { key: "despillStrength", label: "despill 强度", min: 0,   max: 1, step: 0.01 },
  { key: "despillBalance",  label: "despill 平衡", min: 0,   max: 1, step: 0.01 },
  { key: "denoise",         label: "降噪",         min: 0,   max: 1, step: 0.01 },
  { key: "matteStab",       label: "matte 稳定",   min: 0,   max: 1, step: 0.01 },
];
export function packParams(p: KeyerParams): Float32Array {
  return new Float32Array([
    p.keyColor[0], p.keyColor[1], p.keyColor[2], p.balance,
    p.blackClip, p.whiteClip, p.softness, p.shrink,
    p.feather, p.despillStrength, p.despillBalance, p.lumaRestore,
    p.denoise, p.matteStab, p.plateMode, p.viewMode,
    p.wipe, 0, 0, 0,
  ]);
}
