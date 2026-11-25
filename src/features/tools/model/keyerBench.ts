/* 键控基准测试：按 case 跑一遍引擎，和真值 matte / 前景比，出 7 项误差。
   测试集文件名：case<N>_<名>[_f<帧>].{input,gt,plate,fgpre}.png；manifest.json 可给每个 case 覆盖参数。
   算法与旧版 toolsKeyer 一致，只是搬出 UI。 */
import type { KeyerEngine } from "../keyer/engine";
import { alphaFlicker, backgroundResidue, coreLeakage, edgeBandSad, foregroundError, gradErr, mad } from "../keyer/metrics";
import { DEFAULTS, type KeyerParams } from "../keyer/params";

export interface BenchRow {
  id: string;
  mad: number;
  grad: number;
  edge: number;
  fgErr: number;
  bgResidue: number;
  coreLeak: number;
  flicker: number;
  ms: number;
}
export type BenchMetric = Exclude<keyof BenchRow, "id" | "ms">;
export const BENCH_METRICS: { key: BenchMetric; label: string }[] = [
  { key: "mad", label: "MAD" },
  { key: "grad", label: "梯度" },
  { key: "edge", label: "边缘" },
  { key: "fgErr", label: "前景" },
  { key: "bgResidue", label: "背景残留" },
  { key: "coreLeak", label: "主体漏抠" },
  { key: "flicker", label: "闪烁" },
];
export interface BenchManifestEntry {
  id: string;
  frames?: number;
  feed_plate?: boolean;
  dynamic_plate?: boolean;
  params?: Partial<KeyerParams>;
}
export interface BenchReport {
  version: 2;
  cases: Omit<BenchRow, "ms">[];
  aggregate: Record<BenchMetric, number>;
}

const bitmap = (f: Blob) => createImageBitmap(f, { colorSpaceConversion: "none" });
const srgbToLinear = (x: number) => (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));

async function pixels(file: Blob) {
  const bmp = await bitmap(file);
  const cnv = document.createElement("canvas");
  cnv.width = bmp.width;
  cnv.height = bmp.height;
  const c = cnv.getContext("2d")!;
  c.drawImage(bmp, 0, 0);
  const data = c.getImageData(0, 0, bmp.width, bmp.height).data;
  bmp.close();
  return { data, w: cnv.width, h: cnv.height };
}
async function decodeAlpha(file: Blob) {
  const { data, w, h } = await pixels(file);
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = data[i * 4] / 255;
  return { data: out, w, h };
}
async function decodePremultRgb(file: Blob) {
  const { data, w, h } = await pixels(file);
  const out = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    out[i * 3] = srgbToLinear(data[i * 4] / 255);
    out[i * 3 + 1] = srgbToLinear(data[i * 4 + 1] / 255);
    out[i * 3 + 2] = srgbToLinear(data[i * 4 + 2] / 255);
  }
  return { data: out, w, h };
}

interface CaseFiles {
  inputs: { f: File; idx: number }[];
  gt: File | null;
  frameGts: Record<number, File>;
  fgpre: File | null;
  plate: File | null;
}

export async function runBench(engine: KeyerEngine, files: File[], manifest: BenchManifestEntry[], onRow: (rows: BenchRow[]) => void): Promise<BenchReport> {
  const byCase: Record<string, CaseFiles> = {};
  for (const f of files) {
    const m = /^(case\d+_[a-z0-9]+)(?:_f(\d+))?\.(input|gt|plate|fgpre)\.png$/.exec(f.name);
    if (!m) continue;
    const c = (byCase[m[1]] ??= { inputs: [], gt: null, frameGts: {}, fgpre: null, plate: null });
    const idx = m[2] ? parseInt(m[2], 10) : null;
    if (m[3] === "gt") {
      if (idx === null) c.gt = f;
      else c.frameGts[idx] = f;
    } else if (m[3] === "fgpre") {
      if (idx === null) c.fgpre = f;
    } else if (m[3] === "plate") c.plate = f;
    else c.inputs.push({ f, idx: idx ?? 0 });
  }
  const meta = Object.fromEntries(manifest.map((e) => [e.id, e]));
  const out: BenchRow[] = [];
  for (const id of Object.keys(byCase).sort()) {
    const c = byCase[id];
    const mf = meta[id] ?? ({ id } as BenchManifestEntry);
    if (!c.gt || !c.fgpre || !c.inputs.length) continue;
    c.inputs.sort((a, b) => a.idx - b.idx);
    const t0 = performance.now();
    engine.setParams({ ...DEFAULTS, ...(mf.params ?? {}) });
    engine.clearPlate();
    const first = await bitmap(c.inputs[0].f);
    engine.loadImage(first);
    engine.resetHistory();
    if (c.plate && mf.feed_plate !== false) {
      const pb = await bitmap(c.plate);
      engine.loadPlate(pb);
      pb.close();
    }
    /* 自动取样主色：左上角 (10,10)（全部 case 幕布覆盖该角） */
    await engine.sampleKeyColor(10 / first.width, 10 / first.height);
    if (mf.dynamic_plate) engine.estimatePlate(true);
    const frames = [first];
    for (let i = 1; i < c.inputs.length; i++) frames.push(await bitmap(c.inputs[i].f));
    /* 单帧 case 重复渲染 8 次让时域项收敛；多帧 case 顺序喂满 */
    const N = Math.max(8, frames.length);
    const pred: Float32Array[] = [];
    const gts: Float32Array[] = [];
    for (let i = 0; i < N; i++) {
      const fi = Math.min(i, frames.length - 1);
      engine.loadImage(frames[fi]);
      engine.renderOnce();
      if (frames.length > 1) {
        const fm = await engine.readbackMatteFull();
        const gtFile = c.frameGts[c.inputs[fi].idx] ?? (fi === frames.length - 1 ? c.gt : null);
        if (fm && gtFile) {
          pred.push(fm.data);
          gts.push((await decodeAlpha(gtFile)).data);
        }
      }
    }
    frames.forEach((b) => b.close());
    const matte = await engine.readbackMatteFull();
    const fg = await engine.readbackFgFull();
    const gt = await decodeAlpha(c.gt);
    const gtFg = await decodePremultRgb(c.fgpre);
    const ms = performance.now() - t0;
    if (!matte || !fg || matte.w !== gt.w || matte.h !== gt.h || fg.w !== gtFg.w || fg.h !== gtFg.h) continue;
    out.push({
      id,
      mad: mad(matte.data, gt.data),
      grad: gradErr(matte.data, gt.data, gt.w, gt.h),
      edge: edgeBandSad(matte.data, gt.data, gt.w, gt.h),
      fgErr: foregroundError(fg.data, gtFg.data),
      bgResidue: backgroundResidue(matte.data, gt.data),
      coreLeak: coreLeakage(matte.data, gt.data),
      flicker: alphaFlicker(pred, gts),
      ms,
    });
    onRow([...out]);
  }
  const aggregate = Object.fromEntries(BENCH_METRICS.map(({ key }) => [key, out.reduce((s, r) => s + r[key], 0) / Math.max(1, out.length)])) as Record<BenchMetric, number>;
  return { version: 2, cases: out.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== "ms")) as Omit<BenchRow, "ms">), aggregate };
}

/** 开发时自动读仓库里的 testdata/keyer/testset（vite /@fs）。 */
export async function loadDevTestset(root: string): Promise<{ files: File[]; manifest: BenchManifestEntry[] }> {
  const res = await fetch(`${root}/manifest.json`);
  if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
  const manifest = (await res.json()) as BenchManifestEntry[];
  const names: string[] = [];
  for (const e of manifest) {
    const frames = e.frames ?? 1;
    if (frames > 1) {
      for (let i = 0; i < frames; i++) {
        const sfx = `_f${String(i).padStart(2, "0")}`;
        names.push(`${e.id}${sfx}.input.png`, `${e.id}${sfx}.gt.png`);
      }
    } else names.push(`${e.id}.input.png`);
    names.push(`${e.id}.gt.png`, `${e.id}.fgpre.png`);
    if (e.feed_plate !== false) names.push(`${e.id}.plate.png`);
  }
  const files = await Promise.all(
    names.map(async (name) => {
      const r = await fetch(`${root}/${name}`);
      if (!r.ok) throw new Error(`${name} HTTP ${r.status}`);
      return new File([await r.blob()], name, { type: "image/png" });
    }),
  );
  return { files, manifest };
}

export const devFsUrl = (path: string) =>
  "/@fs" +
  path
    .split("/")
    .map((part, i) => (i ? encodeURIComponent(part) : part))
    .join("/");
