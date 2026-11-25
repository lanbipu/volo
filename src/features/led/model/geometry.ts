/* 屏幕几何（自旧版 gridView 迁入并加类型）：
   - 设计几何：镜像 mesh-core shape_grid.rs 的逐列朝向角骨架（curved 用闭式圆弧）。
   - 重建几何：读 ReconstructedSurface 顶点，按屏幕摆放（position / yaw / 底边离地）+ 舞台对齐（rebuilt_alignment）变换。
   世界坐标与 mesh-core 一致：Z-up（X = 列 / 横向、Y = 弯曲深度、Z = 行 / 竖直），单位 m。 */
import type { ProjectConfig, RebuiltAlignmentGroup, ReconstructedSurface, ScreenConfig } from "@/api/types";
import type { PickBox } from "../viewport/scene";

export interface P3 {
  x: number;
  y: number;
  z: number;
}

export interface Built {
  boxes: PickBox[];
  prov: Record<string, string> | null;
  cols: number;
  rows: number;
  bbox: { min: P3; max: P3 } | null;
}

const RAD = Math.PI / 180;

function columnHeadingsDeg(m: ScreenConfig, cols: number): number[] {
  const s = m.shape_prior;
  if (s.type === "arc") {
    const mid = (cols - 1) / 2;
    return Array.from({ length: cols }, (_, i) => {
      const d = i - mid;
      return Math.sign(d) * Math.max(0, Math.abs(d) - s.center_flat_cols / 2) * s.angle_per_col_deg;
    });
  }
  if (s.type === "l_shape") {
    const { left_cols: lc, soften_cols: soft, corner_angle_deg: ang } = s;
    return Array.from({ length: cols }, (_, i) => (i < lc ? 0 : i < lc + soft ? ang * ((i - lc + 1) / (soft + 1)) : ang));
  }
  if (s.type === "u_shape") {
    const { wing_cols: wc, soften_cols: soft, corner_angle_deg: ang } = s;
    return Array.from({ length: cols }, (_, i) => {
      if (i < wc) return ang;
      if (i < wc + soft) return ang * (1 - (i - wc + 1) / (soft + 1));
      if (i >= cols - wc) return -ang;
      if (i >= cols - wc - soft) return -ang * ((i - (cols - wc - soft) + 1) / (soft + 1));
      return 0;
    });
  }
  if (s.type === "custom_segments") {
    const out: number[] = [];
    s.segments.forEach((sg) => {
      for (let k = 0; k < sg.cols; k++) out.push(sg.cum_angle_deg);
    });
    while (out.length < cols) out.push(out.length ? out[out.length - 1] : 0);
    return out.slice(0, cols);
  }
  return new Array<number>(cols).fill(0);
}

function wallSeamsXY(m: ScreenConfig, cols: number, cwM: number): { x: number; y: number }[] {
  const s = m.shape_prior;
  if (s.type === "curved") {
    const rM = (s.radius_mm || 1) / 1000;
    const half = (cols * cwM) / (2 * rM);
    const ax = rM * Math.sin(-half);
    const ay = rM - rM * Math.cos(-half);
    return Array.from({ length: cols + 1 }, (_, c) => {
      const t = -half + (2 * half * c) / cols;
      return { x: rM * Math.sin(t) - ax, y: rM - rM * Math.cos(t) - ay };
    });
  }
  const h = columnHeadingsDeg(m, cols);
  const seams = [{ x: 0, y: 0 }];
  for (let c = 0; c < cols; c++) {
    const a = h[c] * RAD;
    const p = seams[c];
    seams.push({ x: p.x + cwM * Math.cos(a), y: p.y + cwM * Math.sin(a) });
  }
  return seams;
}

/** 屏幕摆放：yaw 绕竖直轴 Z 旋转弯曲平面，再平移（同 mesh-core apply_world_transform）。 */
function placer(m: ScreenConfig) {
  const [px, py, pz] = m.position_m ?? [0, 0, 0];
  const z0 = (pz || 0) + (m.height_offset_mm ?? 0) / 1000;
  const yaw = (m.yaw_deg || 0) * RAD;
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  return (x: number, y: number, z: number): P3 => ({ x: x * cy + y * sy + (px || 0), y: -x * sy + y * cy + (py || 0), z: z + z0 });
}

/** 该屏所在的 rebuilt_alignment 组（P_s = A ∘ B_s 的 A）；不在任何组 = 不变换。 */
export function alignmentFor(cfg: ProjectConfig, screenId: string): RebuiltAlignmentGroup | null {
  return cfg.rebuilt_alignment?.groups.find((g) => g.screens.includes(screenId)) ?? null;
}

function align(p: P3, a: RebuiltAlignmentGroup | null | undefined): P3 {
  if (!a?.rotation) return p;
  const R = a.rotation;
  const t = a.t_m ?? [0, 0, 0];
  return {
    x: R[0][0] * p.x + R[0][1] * p.y + R[0][2] * p.z + (t[0] || 0),
    y: R[1][0] * p.x + R[1][1] * p.y + R[1][2] * p.z + (t[1] || 0),
    z: R[2][0] * p.x + R[2][1] * p.y + R[2][2] * p.z + (t[2] || 0),
  };
}

function bboxOf(boxes: PickBox[]): Built["bbox"] {
  if (!boxes.length) return null;
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const b of boxes)
    for (const p of b.corners) {
      min.x = Math.min(min.x, p.x);
      min.y = Math.min(min.y, p.y);
      min.z = Math.min(min.z, p.z);
      max.x = Math.max(max.x, p.x);
      max.y = Math.max(max.y, p.y);
      max.z = Math.max(max.z, p.z);
    }
  return { min, max };
}

export function designBoxes(m: ScreenConfig): Built {
  const cols = Math.max(1, m.cabinet_count[0] | 0);
  const rows = Math.max(1, m.cabinet_count[1] | 0);
  const cwM = (m.cabinet_size_mm[0] || 500) / 1000;
  const chM = (m.cabinet_size_mm[1] || 500) / 1000;
  const seams = wallSeamsXY(m, cols, cwM);
  const place = placer(m);
  const masked = new Set((m.irregular_mask ?? []).map(([c, r]) => `${c},${r}`));
  const boxes: PickBox[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const s0 = seams[c];
      const s1 = seams[c + 1];
      const zb = r * chM;
      const zt = zb + chM;
      const key = `${c},${r}`;
      boxes.push({ key, c, r, corners: [place(s0.x, s0.y, zb), place(s1.x, s1.y, zb), place(s1.x, s1.y, zt), place(s0.x, s0.y, zt)], masked: masked.has(key) });
    }
  return { boxes, prov: null, cols, rows, bbox: bboxOf(boxes) };
}

export function rebuiltBoxes(surface: ReconstructedSurface, m: ScreenConfig, alignment?: RebuiltAlignmentGroup | null): Built {
  const { cols, rows } = surface.topology;
  const place = placer(m);
  const vi = (c: number, r: number) => r * (cols + 1) + c;
  const at = (c: number, r: number) => {
    const v = surface.vertices[vi(c, r)] ?? [0, 0, 0];
    return align(place(v[0], v[1], v[2]), alignment);
  };
  const pv = surface.vertex_provenance ?? [];
  const boxes: PickBox[] = [];
  const prov: Record<string, string> = {};
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const key = `${c},${r}`;
      boxes.push({ key, c, r, corners: [at(c, r), at(c + 1, r), at(c + 1, r + 1), at(c, r + 1)], masked: false });
      const ps = [pv[vi(c, r)], pv[vi(c + 1, r)], pv[vi(c, r + 1)], pv[vi(c + 1, r + 1)]].map((x) => String(x ?? ""));
      prov[key] = ps.includes("extrapolated") ? "extrapolated" : ps.includes("interpolated") ? "interpolated" : ps[0] || "measured";
    }
  return { boxes, prov: pv.length ? prov : null, cols, rows, bbox: bboxOf(boxes) };
}

export function unionBox(list: (Built["bbox"] | null)[]): Built["bbox"] {
  const bs = list.filter((b): b is NonNullable<Built["bbox"]> => !!b);
  if (!bs.length) return null;
  return {
    min: { x: Math.min(...bs.map((b) => b.min.x)), y: Math.min(...bs.map((b) => b.min.y)), z: Math.min(...bs.map((b) => b.min.z)) },
    max: { x: Math.max(...bs.map((b) => b.max.x)), y: Math.max(...bs.map((b) => b.max.y)), z: Math.max(...bs.map((b) => b.max.z)) },
  };
}

/* ------------------------------ 尺寸 / 分辨率 ------------------------------ */

export function screenSize(m: ScreenConfig) {
  const [cols, rows] = m.cabinet_count;
  const [cw, ch] = m.cabinet_size_mm;
  const px = m.pixels_per_cabinet;
  const widthM = (cols * cw) / 1000;
  const heightM = (rows * ch) / 1000;
  const res = px ? [cols * px[0], rows * px[1]] : null;
  const pitch = px && px[0] > 0 ? cw / px[0] : null;
  const s = m.shape_prior;
  const angle = s.type === "curved" && s.radius_mm > 0 ? (widthM / (s.radius_mm / 1000)) / RAD : null;
  return { widthM, heightM, res, pitch, angle };
}

export const SHAPE_LABEL: Record<string, string> = {
  flat: "平面",
  folded: "折线",
  curved: "弧形",
  arc: "分段弧形",
  l_shape: "L 形",
  u_shape: "U 形",
  custom_segments: "自定义",
};
