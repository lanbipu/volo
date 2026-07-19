/* Volo — Lens (vpcal) typed command bindings (Calibrate LED「镜头校正」单页).
   One wrapper per `#[tauri::command]` in src-tauri/src/commands/vpcal_runs.rs.
   Tracker-free / stills 走通用 spawn_sidecar(_streaming)，在此做 argv 封装。 */
import { call } from "./invoke";
import { spawnSidecar, spawnSidecarStreaming, sidecarStdinWrite, type SidecarOutput } from "./sidecarStream";

// ✅ wired: calLens「从已有 session 求解」弹窗 · 最近会话列表 →
// listLensSessions(sessionsRoot)（扫描目录下 session.json / fixed_run.json）
export interface LensSessionSummary {
  /** 会话标识 = session.json / fixed_run.json 所在目录名 */
  id: string;
  session_dir: string;
  session_json_path: string;
  /** "tracked" | "fixed" */
  mode: string;
  lens_ready: boolean;
  /** 从 tracking/poses.jsonl 或 captures/normal 统计；无法读取时为 null */
  poses_captured: number | null;
  modified_at: string | null;
  output_dir: string | null;
  /** fixed_run.json 损坏等：仍列出目录，供 UI 标错而非静默消失 */
  error?: string | null;
}
export const listLensSessions = (sessionsRoot: string) =>
  call<LensSessionSummary[]>("list_lens_sessions", { sessionsRoot });

/** Persist fixed-pose stills metadata (`fixed_run.json`) next to captures/normal/. */
export const writeFixedRunMeta = (sessionDir: string, meta: Record<string, unknown>) =>
  call<void>("write_fixed_run_meta", { sessionDir, meta });

// ✅ wired: calArVerify.tsx「验证叠加」标注帧查看器 → readImageAsDataUrl(path)
export const readImageAsDataUrl = (path: string) =>
  call<string>("read_image_as_data_url", { path });

export interface LensQaPose {
  frame_id: number;
  rms_px: number;
  num_observations: number;
  quality: string;
}
export interface LensQaOutlier {
  frame_id: number;
  marker_id: Record<string, unknown> | null;
  error_px: number;
  pixel_detected: [number, number];
}
export interface LensQaReport {
  global_rms_px: number;
  global_mean_px: number;
  global_max_px: number;
  per_pose: LensQaPose[];
  outliers_top10: LensQaOutlier[];
  lens_residual_check: {
    radial_pattern_detected: boolean;
    description: string;
  };
}

export const readLensQaReport = (runDir: string) =>
  call<LensQaReport>("read_lens_qa_report", { runDir });

export interface NetInterface {
  name: string;
  ipv4: string;
}
export const listNetInterfaces = () =>
  call<NetInterface[]>("list_net_interfaces");

/* ---------- tracker-free / stills（通用 sidecar 透传） ---------- */

function parseEnvelope(out: SidecarOutput): { status?: string; data?: any; error?: any } {
  const raw = (out.stdout || "").trim();
  if (!raw) throw new Error(out.stderr || `sidecar exit ${out.exit_code}`);
  try {
    return JSON.parse(raw);
  } catch (e) {
    /* NDJSON 时取最后一行 */
    const lines = raw.split(/\n/).map((l) => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try { return JSON.parse(lines[i]); } catch (_) { /* continue */ }
    }
    throw new Error(out.stderr || raw.slice(0, 400));
  }
}

export interface TrackerFreeLensCalResult {
  fx: number; fy: number; cx: number; cy: number;
  dist_coeffs: number[];
  rms: number;
  num_images: number;
  num_points: number;
  image_size: number[];
  lens_json: string;
}

/** `vpcal tracker-free lens-cal` → 写 lens.json，返回内参 + RMS。 */
export async function trackerFreeLensCal(opts: {
  imagesDir: string;
  screenPath: string;
  outLensJson: string;
  cabColOffset?: number;
  screenId?: number;
}): Promise<TrackerFreeLensCalResult> {
  const args = [
    "tracker-free", "lens-cal",
    "--images", opts.imagesDir,
    "--screen", opts.screenPath,
    "--cab-col-offset", String(opts.cabColOffset ?? 0),
    "--screen-id", String(opts.screenId ?? 0),
    "--out", opts.outLensJson,
    "--output", "json",
  ];
  const out = await spawnSidecar("vpcal", args);
  const env = parseEnvelope(out);
  if (env.status && env.status !== "ok") {
    throw new Error((env.error && env.error.message) || `tracker-free lens-cal failed (exit ${out.exit_code})`);
  }
  return Object.assign({}, env.data || {}, { lens_json: opts.outLensJson });
}

export interface TrackerFreeVerifyPose {
  position_mm: number[];
  euler_deg: { rx: number; ry: number; rz: number };
  distance_mm: number;
}

export interface TrackerFreeVerifyResult {
  image: string;
  markers_a: number;
  markers_b: number;
  camera_from_a?: TrackerFreeVerifyPose;
  camera_from_b?: TrackerFreeVerifyPose;
}

/** `vpcal tracker-free verify` — 单屏时可把 screenA/B 指同一 screen.json。 */
export async function trackerFreeVerify(opts: {
  imagePath: string;
  screenA: string;
  screenB: string;
  lensJson: string;
  offsetA?: number;
  offsetB?: number | null;
  screenId?: number;
}): Promise<TrackerFreeVerifyResult> {
  const args = [
    "tracker-free", "verify",
    "--image", opts.imagePath,
    "--screen-a", opts.screenA,
    "--screen-b", opts.screenB,
    "--lens", opts.lensJson,
    "--offset-a", String(opts.offsetA ?? 0),
    "--screen-id", String(opts.screenId ?? 0),
    "--output", "json",
  ];
  if (opts.offsetB != null) args.push("--offset-b", String(opts.offsetB));
  const out = await spawnSidecar("vpcal", args);
  const env = parseEnvelope(out);
  if (env.status && env.status !== "ok") {
    throw new Error((env.error && env.error.message) || `tracker-free verify failed (exit ${out.exit_code})`);
  }
  return env.data as TrackerFreeVerifyResult;
}

/** 启动 `vpcal capture stills` 流式会话（固定机位）。 */
export function startCaptureStills(opts: {
  backend: string;
  device: string;
  outDir: string;
  width?: number | null;
  height?: number | null;
  fps?: number | null;
  transferFunction?: string;
  auto?: boolean;
  minMarkers?: number;
  previewPort?: number;
}) {
  const args = [
    "capture", "stills",
    "--backend", opts.backend,
    "--device", String(opts.device),
    "--preview-port", String(opts.previewPort ?? 0),
    "--out", opts.outDir,
    "--min-markers", String(opts.minMarkers ?? 4),
    "--output", "ndjson",
  ];
  if (opts.auto === false) args.push("--no-auto");
  else args.push("--auto");
  if (opts.width) args.push("--width", String(opts.width));
  if (opts.height) args.push("--height", String(opts.height));
  if (opts.fps) args.push("--fps", String(opts.fps));
  if (opts.transferFunction) args.push("--transfer-function", opts.transferFunction);
  return spawnSidecarStreaming("vpcal", args);
}

export const stillsFinish = (taskId: string) =>
  sidecarStdinWrite(taskId, JSON.stringify({ cmd: "finish" }));

/** px RMS 阈值：[ok 上限, warn 上限)，与 `calibrate.tsx` `RMS_THRESHOLDS.px` 同源。 */
export const RMS_PX_THRESHOLDS = Object.freeze([1, 2] as const);

/** 质量灯：RMS → ok / warn / fail（与 handoff CAL_QUALITY_LIGHT 对齐）。 */
export function qualityFromRms(rms: number | null | undefined): "ok" | "warn" | "fail" {
  if (rms == null || Number.isNaN(rms)) return "fail";
  if (rms < RMS_PX_THRESHOLDS[0]) return "ok";
  if (rms < RMS_PX_THRESHOLDS[1]) return "warn";
  return "fail";
}

/** 未知 / 空标签返回 null，调用方用 `qualityFromLabel(q) || qualityFromRms(rms)` 回退。 */
export function qualityFromLabel(q: string | null | undefined): "ok" | "warn" | "fail" | null {
  const s = String(q || "").toLowerCase();
  if (!s) return null;
  if (s === "good" || s === "ok" || s === "high") return "ok";
  if (s === "fair" || s === "warn" || s === "medium") return "warn";
  if (s === "poor" || s === "fail" || s === "bad") return "fail";
  return null;
}
