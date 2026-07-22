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
  /** 具备求解条件（有 capture-time lens/intrinsics），不等于已求解 */
  lens_ready: boolean;
  /** 固定机位 Stage pose 已落盘（stage_pose.json 或 meta） */
  stage_pose_ready: boolean;
  /** 求解结果（RMS / inliers / camera_from_stage …）；未求解为 null */
  stage_pose?: TrackerFreeStagePoseResult | Record<string, unknown> | null;
  /** 从 tracking/poses.jsonl 或 captures/normal 统计；无法读取时为 null */
  poses_captured: number | null;
  modified_at: string | null;
  output_dir: string | null;
  /** fixed_run.json 损坏等：仍列出目录，供 UI 标错而非静默消失 */
  error?: string | null;
  camera_id?: string | null;
  lens_json?: string | null;
  intrinsics?: FixedPixelIntrinsics | null;
  intrinsics_error?: string | null;
  targets?: Array<{
    id?: string;
    screenJson?: string;
    path?: string;
    code?: number;
    screen_id?: number;
    offset?: number;
    cab_col_offset?: number;
  }> | null;
}
export const listLensSessions = (sessionsRoot: string) =>
  call<LensSessionSummary[]>("list_lens_sessions", { sessionsRoot });

/** Delete one session directory that lives under `sessionsRoot` (path-validated in Rust). */
export const deleteLensSession = (sessionsRoot: string, sessionDir: string) =>
  call<void>("delete_lens_session", { sessionsRoot, sessionDir });

/** Persist fixed-pose metadata and optionally snapshot an external lens file into the run. */
export const writeFixedRunMeta = (
  sessionDir: string,
  meta: Record<string, unknown>,
  lensSourcePath?: string | null,
) => call<void>("write_fixed_run_meta", { sessionDir, meta, lensSourcePath: lensSourcePath ?? null });

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

export interface TrackerFreeStagePoseResult {
  image: string;
  camera_from_stage: TrackerFreeVerifyPose & {
    ptr_deg: { pan: number; tilt: number; roll: number };
    matrix_4x4: number[][];
  };
  rms_reprojection_px: number;
  num_markers: number;
  num_inliers: number;
  markers_by_screen: Record<string, number>;
  visible_screens: string[];
  selected_screens: string[];
  partial_visibility_allowed: boolean;
}

export interface FixedPixelIntrinsics {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  dist_coeffs: number[];
  image_size: [number, number];
  source?: string;
  physical_snapshot?: Record<string, number | string | null>;
}

/** Strip Windows `\\?\` verbatim prefix — click.Path(exists=True) rejects mixed
 *  separators under that prefix (e.g. `\\?\C:\...\captures/normal\000000.png`). */
function forSidecarFsPath(path: string): string {
  return String(path || "").replace(/^\\\\\?\\/, "");
}

/** One fixed-frame Stage pose. Any subset of selected screen targets may be visible. */
export async function trackerFreeStagePose(opts: {
  imagePath: string;
  targets: Array<{ screenJson: string; code: number; offset: number }>;
  intrinsics?: FixedPixelIntrinsics | null;
  focalMm?: number;
  sensorWidthMm?: number;
  sensorHeightMm?: number;
  principalXmm?: number | null;
  principalYmm?: number | null;
  k1?: number | null;
  k2?: number | null;
  k3?: number | null;
  lensPath?: string | null;
  outPath?: string | null;
}): Promise<TrackerFreeStagePoseResult> {
  if (!opts.targets.length) throw new Error("tracker-free pose requires at least one screen target");
  const args = ["tracker-free", "pose", "--image", forSidecarFsPath(opts.imagePath)];
  for (const target of opts.targets) {
    args.push(
      "--screen-target", forSidecarFsPath(target.screenJson),
      String(target.code), String(target.offset),
    );
  }
  if (opts.lensPath && opts.intrinsics) {
    throw new Error("tracker-free pose accepts one intrinsics source per run");
  }
  if (opts.lensPath) {
    args.push("--lens", forSidecarFsPath(opts.lensPath));
  } else if (opts.intrinsics) {
    const intr = opts.intrinsics;
    args.push(
      "--fx", String(intr.fx), "--fy", String(intr.fy),
      "--cx", String(intr.cx), "--cy", String(intr.cy),
      "--k1", String(intr.dist_coeffs[0] ?? 0),
      "--k2", String(intr.dist_coeffs[1] ?? 0),
      "--k3", String(intr.dist_coeffs[4] ?? 0),
    );
  } else {
    if (!opts.focalMm || !opts.sensorWidthMm || !opts.sensorHeightMm) {
      throw new Error("tracker-free pose requires capture-time pixel intrinsics or a lens snapshot");
    }
    args.push(
      "--focal-mm", String(opts.focalMm),
      "--sensor-width-mm", String(opts.sensorWidthMm),
      "--sensor-height-mm", String(opts.sensorHeightMm),
      "--principal-x-mm", String(opts.principalXmm ?? 0),
      "--principal-y-mm", String(opts.principalYmm ?? 0),
      "--k1", String(opts.k1 ?? 0),
      "--k2", String(opts.k2 ?? 0),
      "--k3", String(opts.k3 ?? 0),
    );
  }
  if (opts.outPath) args.push("--out", forSidecarFsPath(opts.outPath));
  args.push("--output", "json");
  const out = await spawnSidecar("vpcal", args);
  const env = parseEnvelope(out);
  if (env.status && env.status !== "ok") {
    throw new Error((env.error && env.error.message) || `tracker-free pose failed (exit ${out.exit_code})`);
  }
  return env.data as TrackerFreeStagePoseResult;
}

export interface GridOverlayScreen {
  label: string;
  /** Normalised segments `[x1,y1,x2,y2]` in 0–1 image space. */
  segments: Array<[number, number, number, number] | number[]>;
  /** Normalised marker points `[x,y]`. */
  markers: Array<[number, number] | number[]>;
}

export interface TrackerFreeGridResult {
  screens: GridOverlayScreen[];
  image_size: [number, number] | number[];
}

/** `vpcal tracker-free grid` — project cabinet wireframes through a Stage pose. */
export async function trackerFreeGrid(opts: {
  targets: Array<{ screenJson: string; code: number; offset: number }>;
  posePath: string;
  intrinsics?: FixedPixelIntrinsics | null;
  lensPath?: string | null;
  includeMarkers?: boolean;
}): Promise<TrackerFreeGridResult> {
  if (!opts.targets.length) throw new Error("tracker-free grid requires at least one screen target");
  const args = ["tracker-free", "grid", "--pose", forSidecarFsPath(opts.posePath)];
  for (const target of opts.targets) {
    args.push(
      "--screen-target", forSidecarFsPath(target.screenJson),
      String(target.code), String(target.offset),
    );
  }
  if (opts.lensPath && opts.intrinsics) {
    throw new Error("tracker-free grid accepts one intrinsics source per run");
  }
  if (opts.lensPath) {
    args.push("--lens", forSidecarFsPath(opts.lensPath));
  } else if (opts.intrinsics) {
    const intr = opts.intrinsics;
    args.push(
      "--fx", String(intr.fx), "--fy", String(intr.fy),
      "--cx", String(intr.cx), "--cy", String(intr.cy),
      "--k1", String(intr.dist_coeffs[0] ?? 0),
      "--k2", String(intr.dist_coeffs[1] ?? 0),
      "--k3", String(intr.dist_coeffs[4] ?? 0),
    );
  } else {
    throw new Error("tracker-free grid requires --lens or capture-time pixel intrinsics");
  }
  if (opts.includeMarkers === false) args.push("--no-markers");
  args.push("--output", "json");
  const out = await spawnSidecar("vpcal", args);
  const env = parseEnvelope(out);
  if (env.status && env.status !== "ok") {
    throw new Error((env.error && env.error.message) || `tracker-free grid failed (exit ${out.exit_code})`);
  }
  return env.data as TrackerFreeGridResult;
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
