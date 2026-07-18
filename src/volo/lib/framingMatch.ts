/** Framing match score/hysteresis mirrors vpcal.core.framing_match; UI copy is frontend-owned. */

export type Cabinet = readonly [number, number];
/** Axis-aligned [x0, y0, x1, y1] normalized 0..1. */
export type BBox = readonly [number, number, number, number];

export const MATCH_HIT_WEIGHT = 0.75;
export const MATCH_BBOX_WEIGHT = 0.25;
export const MATCH_ENTER = 80;
export const MATCH_EXIT = 70;
export const FRAMING_MATCHED_HINT = "匹配达标 · 画面稳定即自动拍摄";

const ZONE_DIFF: Record<string, string> = {
  左半: "还差左侧区域",
  右半: "还差右侧区域",
  顶边: "构图偏低，向上抬镜",
  底边: "构图偏高，向下压镜",
  全景: "再退后一步收全景",
  中央: "还差中央区域",
};

export function cabinetsNormBBox(
  cabinets: Iterable<Cabinet>,
  cols: number,
  rows: number,
): BBox | null {
  const cN = Math.max(1, cols | 0);
  const rN = Math.max(1, rows | 0);
  const items = Array.from(cabinets);
  if (!items.length) return null;
  let c0 = Infinity, c1 = -Infinity, r0 = Infinity, r1 = -Infinity;
  for (const [c, r] of items) {
    if (c < c0) c0 = c;
    if (c > c1) c1 = c;
    if (r < r0) r0 = r;
    if (r > r1) r1 = r;
  }
  return [c0 / cN, r0 / rN, (c1 + 1) / cN, (r1 + 1) / rN];
}

/** [x0,y0,x1,y1] → handoff GuideThumb [x,y,w,h]; null if empty. */
export function bboxToXywh(bbox: BBox | null): readonly [number, number, number, number] | null {
  if (!bbox) return null;
  const w = bbox[2] - bbox[0];
  const h = bbox[3] - bbox[1];
  if (w <= 0 || h <= 0) return null;
  return [bbox[0], bbox[1], w, h];
}

function area(bbox: BBox | null | undefined): number {
  if (!bbox) return 0;
  return Math.max(0, bbox[2] - bbox[0]) * Math.max(0, bbox[3] - bbox[1]);
}

function zoneOfBBox(bbox: BBox): string {
  const cx = (bbox[0] + bbox[2]) / 2;
  const cy = (bbox[1] + bbox[3]) / 2;
  const w = bbox[2] - bbox[0];
  const h = bbox[3] - bbox[1];
  if (w >= 0.7 && h >= 0.7) return "全景";
  if (cy < 0.35) return "顶边";
  if (cy > 0.65) return "底边";
  if (cx < 0.4) return "左半";
  if (cx > 0.6) return "右半";
  return "中央";
}

function roleLabel(role: string): string {
  const map: Record<string, string> = {
    fan: "扇形机位",
    top: "上沿",
    bottom: "下沿",
    added: "补位",
  };
  return map[role] || role || "机位";
}

export function computeFramingScore(
  expected: Iterable<Cabinet>,
  observed: Iterable<Cabinet>,
  expectedBbox?: BBox | null,
  observedBbox?: BBox | null,
): number {
  const exp = new Set(Array.from(expected, ([c, r]) => `${c | 0},${r | 0}`));
  const obs = new Set(Array.from(observed, ([c, r]) => `${c | 0},${r | 0}`));
  let hit = 0;
  if (!exp.size) hit = obs.size ? 0 : 1;
  else {
    let n = 0;
    for (const k of exp) if (obs.has(k)) n += 1;
    hit = n / exp.size;
  }

  const ea = area(expectedBbox);
  const oa = area(observedBbox);
  let bboxS = hit;
  if (ea > 1e-9 && oa > 1e-9) {
    const ratio = oa / ea;
    if (ratio >= 0.6 && ratio <= 1.5) bboxS = 1;
    else bboxS = Math.max(0, 1 - Math.abs(Math.log(ratio)) / Math.log(3));
  }
  return Math.round((100 * (MATCH_HIT_WEIGHT * hit + MATCH_BBOX_WEIGHT * bboxS)) * 100) / 100;
}

export function applyMatchHysteresis(
  score: number,
  matched: boolean,
  enter = MATCH_ENTER,
  exit = MATCH_EXIT,
): boolean {
  return matched ? score >= exit : score >= enter;
}

/** Region chip under guide thumb. Pass `box` when already computed for the station. */
export function stationRegionLabel(
  role: string | undefined,
  covers: Iterable<Cabinet>,
  cols: number,
  rows: number,
  box?: BBox | null,
): string {
  const b = box === undefined ? cabinetsNormBBox(covers, cols, rows) : box;
  const zone = b ? zoneOfBBox(b) : "";
  const base = roleLabel(role || "");
  return zone ? `${base} · ${zone}` : base;
}

/**
 * Unmatched diff copy for match badge + guide side.
 * Empty when expected cabinets are all observed (caller uses FRAMING_MATCHED_HINT).
 */
export function framingDiffHint(
  expected: Iterable<Cabinet>,
  observed: Iterable<Cabinet>,
  cols: number,
  rows: number,
): string {
  const exp = Array.from(expected, ([c, r]) => [c | 0, r | 0] as Cabinet);
  const obs = new Set(Array.from(observed, ([c, r]) => `${c | 0},${r | 0}`));
  const miss = exp.filter(([c, r]) => !obs.has(`${c},${r}`));
  if (!miss.length) return "";
  const missBox = cabinetsNormBBox(miss, cols, rows);
  if (!missBox) return "还差推荐覆盖区域";
  return ZONE_DIFF[zoneOfBBox(missBox)] || "还差推荐覆盖区域";
}
