/** Framing-guidance match score (mirrors vpcal.core.framing_match). */

export type Cabinet = readonly [number, number];
export type BBox = readonly [number, number, number, number];

export const MATCH_HIT_WEIGHT = 0.75;
export const MATCH_BBOX_WEIGHT = 0.25;
export const MATCH_ENTER = 80;
export const MATCH_EXIT = 70;

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

function area(bbox: BBox | null | undefined): number {
  if (!bbox || bbox.length < 4) return 0;
  return Math.max(0, bbox[2] - bbox[0]) * Math.max(0, bbox[3] - bbox[1]);
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

export function missingCabinetsHint(
  expected: Iterable<Cabinet>,
  observed: Iterable<Cabinet>,
): string {
  const exp = Array.from(expected, ([c, r]) => [c | 0, r | 0] as Cabinet);
  const obs = new Set(Array.from(observed, ([c, r]) => `${c | 0},${r | 0}`));
  const miss = exp.filter(([c, r]) => !obs.has(`${c},${r}`))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (!miss.length) return "匹配达标 · 画面稳定即自动拍摄";
  const sample = miss.slice(0, 3).map(([c, r]) => `${c}×${r}`).join(", ");
  const more = miss.length > 3 ? ` 等 ${miss.length} 个` : ` · 共 ${miss.length} 个`;
  return `还差箱体 ${sample}${more}`;
}

export function roleLabel(role: string): string {
  const map: Record<string, string> = {
    fan: "扇形机位",
    top: "上沿",
    bottom: "下沿",
    added: "补位",
  };
  return map[role] || role || "机位";
}
