/* Volo — Mesh (LMT) M2 visual-BA group typed command bindings.
   One wrapper per `mesh_visual_*` Tauri command (src-tauri/src/commands/mesh_visual.rs).
   Arg keys are camelCase (Rust snake_case → JS camelCase); optional Rust params
   (`Option<T>`) are passed as explicit `null` when omitted. See ./types for the
   DTO shapes; ./invoke for the transport.

   UI 接入状态：
     ✅ wired —— meshVisualReconstruct / meshVisualGeneratePattern 已由
       pages/gridTree.tsx 与 pages/gridInsp.tsx 承载。
     📝 no-ui —— 后端已就绪但当前没有产品 UI wire-target。
   取消命令仍未接 UI；其余同步命令维持下方逐项台账。

   `mesh_visual_reconstruct` 是唯一的流式命令：kickoff 立即返回 job_id，
   进度经 Tauri event `mesh-visual-progress`（payload: MeshVisualProgressPayload），
   完成经 `mesh-visual-reconstruct-done`（payload: MeshVisualReconstructDonePayload）。
   用 `mesh_visual_cancel(jobId)` 取消在飞的 job。 */
import { call } from "./invoke";
import type {
  CabinetPoseReportFile, CalibrateResult, CaptureCardResult, CapturePlan, CompareKnownResult,
  DecodeStructuredLightResult, EvalResult, ExportPoseObjResult, GeneratePatternResult,
  GenerateStructuredLightResult, MeshVisualJobResponse, ReconstructionResult, ScreenTransformsFile,
  SimulateResult, VisualReconstructResult, VisualSolveDigest,
} from "./types";

/* ----------------------------- reconstruct (streaming) + cancel ----------------------------- */
// ✅ wired: gridTree.tsx + gridInsp.tsx；进度/完成经 mesh-visual-progress / mesh-visual-reconstruct-done
export const meshVisualReconstruct = (
  projectPath: string,
  screenIds: string[],
  captureManifest: string,
  intrinsics?: string | null,
  intrinsicsCrosscheck?: string | null,
) =>
  call<MeshVisualJobResponse>("mesh_visual_reconstruct", {
    projectPath, screenIds, captureManifest,
    intrinsics: intrinsics ?? null,
    intrinsicsCrosscheck: intrinsicsCrosscheck ?? null,
  });
// 📝 no-ui: 取消 mesh_visual_reconstruct 在飞 job；job 已结束返回 false（非错误）
export const meshVisualCancel = (jobId: string) => call<boolean>("mesh_visual_cancel", { jobId });

/** pose report → MeasuredPoints → surface run（视口三态对比数据源） */
export const meshVisualRegisterRun = (
  projectPath: string,
  screenId: string,
  poseReportPath: string,
  visualSolvePath?: string | null,
) =>
  call<ReconstructionResult>("mesh_visual_register_run", {
    projectPath, screenId, poseReportPath,
    visualSolvePath: visualSolvePath ?? null,
  });

/** 读 visual_screen_transforms.v1（联合求解屏间 SE(3)） */
export const meshVisualLoadScreenTransforms = (path: string) =>
  call<ScreenTransformsFile>("mesh_visual_load_screen_transforms", { path });

/** Persist timestamped visual_solve_digest.v1 for reconstruct-records UI. */
export const meshVisualPersistSolve = (
  projectPath: string,
  result: VisualReconstructResult,
) => call<string>("mesh_visual_persist_solve", { projectPath, result });

export const meshVisualLoadSolve = (path: string) =>
  call<VisualSolveDigest>("mesh_visual_load_solve", { path });

/** Stub surface run for empty visual BA (zero cabinets). */
export const meshVisualRegisterEmptyRun = (
  projectPath: string,
  screenId: string,
  visualSolvePath: string,
) =>
  call<number>("mesh_visual_register_empty_run", {
    projectPath, screenId, visualSolvePath,
  });

/* ----------------------------- pattern / structured-light generation ----------------------------- */
/**
 * Stable VP-QSP 4-bit `screen_id` (0–15) for one project screen.
 * Markers bake this into every codeword; batch-generating multiple screens with
 * the same code produces visually identical patterns. Assignment is the sorted
 * index of `screenId` among `projectScreenIds` so ASUS/LG etc. stay distinct.
 */
export const vpqspScreenIdCode = (screenId: string, projectScreenIds: string[]): number => {
  const sorted = Array.from(new Set(projectScreenIds.filter(Boolean))).sort();
  const idx = sorted.indexOf(screenId);
  if (idx < 0) return 0;
  if (sorted.length > 16) {
    throw new Error(
      `VP-QSP 屏幕标识码仅 4 bit（0–15），项目内已有 ${sorted.length} 块屏幕，无法为每屏分配唯一码`,
    );
  }
  return idx;
};

// ✅ wired: gridTree.tsx + gridInsp.tsx 的视觉标定图案步骤
export const meshVisualGeneratePattern = (
  projectPath: string,
  screenId: string,
  method: string,
  screenIdCode: number,
  screenMappingPath?: string | null,
) =>
  call<GeneratePatternResult>("mesh_visual_generate_pattern", {
    projectPath, screenId, method, screenIdCode,
    screenMappingPath: screenMappingPath ?? null,
  });

// ✅ wired: calibrate.tsx openProjectPath —— App 重启后从磁盘恢复「已生成」状态
export const meshVisualScanPatterns = (projectPath: string) =>
  call<Record<string, GeneratePatternResult>>("mesh_visual_scan_patterns", { projectPath });

/**
 * Build the generated composite-image path without corrupting Windows verbatim
 * paths (`\\?\C:\...`). Those paths reject a `/` appended by string concatenation.
 */
export const generatedPatternImagePath = (outputDir: string) => {
  const separator = outputDir.includes("\\") ? "\\" : "/";
  return `${outputDir.replace(/[\\/]+$/, "")}${separator}full_screen.png`;
};

/** Read the exact generated PNG through the backend's Rust-owned-path allowlist. */
export const readGeneratedPatternAsDataUrl = (path: string) =>
  call<string>("read_image_as_data_url", { path });
// 📝 no-ui: 结构光点阵序列生成
export const meshVisualGenerateStructuredLight = (
  projectPath: string,
  screenId: string,
  dotSpacingPx: number | null,
  dotRadiusPx: number,
  marginPx: number | null,
  emitTiffSeq: boolean | null,
  screenMappingPath?: string | null,
) =>
  call<GenerateStructuredLightResult>("mesh_visual_generate_structured_light", {
    projectPath, screenId, dotSpacingPx, dotRadiusPx, marginPx, emitTiffSeq,
    screenMappingPath: screenMappingPath ?? null,
  });
// 📝 no-ui: 结构光录像/帧目录解码为屏幕↔相机对应文件
export const meshVisualDecodeStructuredLight = (
  inputPath: string,
  slMetaPath: string,
  outputPath: string,
  sentinelThreshold: number | null,
  screenRoi: [number, number, number, number] | null,
  emitDebugImage: boolean,
) =>
  call<DecodeStructuredLightResult>("mesh_visual_decode_structured_light", {
    inputPath, slMetaPath, outputPath, sentinelThreshold, screenRoi, emitDebugImage,
  });

/* ----------------------------- calibrate ----------------------------- */
// 📝 no-ui: 棋盘格图像 → 相机内参
export const meshVisualCalibrate = (
  projectPath: string,
  screenId: string,
  checkerboardDir: string,
  squareMm: number,
  inner: string,
) => call<CalibrateResult>("mesh_visual_calibrate", { projectPath, screenId, checkerboardDir, squareMm, inner });
// 📝 no-ui: 结构光多机位对应文件 → 相机内参
export const meshVisualCalibrateStructuredLight = (
  projectPath: string,
  screenId: string,
  slMeta: string,
  correspondences: string[],
  out: string | null,
  force: boolean,
  maxRmsPx: number,
  intrinsicsCrosscheck?: string | null,
) =>
  call<CalibrateResult>("mesh_visual_calibrate_structured_light", {
    projectPath, screenId, slMeta, correspondences, out, force, maxRmsPx,
    intrinsicsCrosscheck: intrinsicsCrosscheck ?? null,
  });

/* ----------------------------- reconstruct (structured-light, sync) ----------------------------- */
// 📝 no-ui: 与 meshVisualReconstruct 同一 BA 内核，多视角结构光路径；本期未走流式
// （与 charuco/vpqsp 路径同耗时量级，暂按原样同步暴露，见 mesh_visual.rs 注释）
export const meshVisualReconstructStructuredLight = (
  projectPath: string,
  screenId: string,
  slMeta: string,
  intrinsics: string,
  intrinsicsCrosscheck: string | null,
  correspondences: string[],
) =>
  call<VisualReconstructResult>("mesh_visual_reconstruct_structured_light", {
    projectPath, screenId, slMeta, intrinsics,
    intrinsicsCrosscheck: intrinsicsCrosscheck ?? null,
    correspondences,
  });

/* ----------------------------- simulate / eval / compare-known ----------------------------- */
// 📝 no-ui: 合成数据集生成（研发/回归用）
export const meshVisualSimulate = (configPath: string, outDir: string) =>
  call<SimulateResult>("mesh_visual_simulate", { configPath, outDir });
// 📝 no-ui: 方法 vs 真值评估（研发/回归用）
export const meshVisualEval = (datasetDir: string, method: string, seedMatrix: number[], init: string) =>
  call<EvalResult>("mesh_visual_eval", { datasetDir, method, seedMatrix, init });
// 📝 no-ui: 重建结果对账已知监视器几何
export const meshVisualCompareKnown = (
  reportPath: string,
  knownPath: string,
  maxSizeMm?: number | null,
  maxDistMm?: number | null,
  maxAngleDeg?: number | null,
) =>
  call<CompareKnownResult>("mesh_visual_compare_known", {
    reportPath, knownPath,
    maxSizeMm: maxSizeMm ?? null,
    maxDistMm: maxDistMm ?? null,
    maxAngleDeg: maxAngleDeg ?? null,
  });

/* ----------------------------- capture planning ----------------------------- */
/**
 * UI guide-session defaults for ``mesh_visual_plan_capture``.
 * CLI requires explicit ``--standoff`` / ``--height``; trials/seed/target-mm
 * CLI defaults are 20 / 0 / 3.0 — guide uses a wider search + more trials.
 */
export const DEFAULT_PLAN_CAPTURE = {
  standoff: "2000..12000",
  height: "500..3000",
  targetP95ResidualMm: 3.0,
  trials: 200,
  seed: 1,
  minViews: 2,
} as const;

// 📝 no-ui: 采集机位规划（逐箱体覆盖/残差）
export const meshVisualPlanCapture = (
  projectPath: string,
  screenId: string,
  imageSize: string,
  hfovDeg: number | null,
  vfovDeg: number | null,
  standoff: string = DEFAULT_PLAN_CAPTURE.standoff,
  height: string = DEFAULT_PLAN_CAPTURE.height,
  targetP95ResidualMm: number = DEFAULT_PLAN_CAPTURE.targetP95ResidualMm,
  trials: number = DEFAULT_PLAN_CAPTURE.trials,
  seed: number = DEFAULT_PLAN_CAPTURE.seed,
  minViews?: number | null,
) =>
  call<CapturePlan>("mesh_visual_plan_capture", {
    projectPath, screenId, imageSize, hfovDeg, vfovDeg, standoff, height,
    targetP95ResidualMm, trials, seed,
    minViews: minViews ?? DEFAULT_PLAN_CAPTURE.minViews,
  });
// 📝 no-ui: 采集指导 3D HTML 卡片渲染
export const meshVisualCaptureCard = (
  projectPath: string,
  screenId: string,
  imageSize: string,
  hfovDeg: number | null,
  vfovDeg: number | null,
  standoff: string = DEFAULT_PLAN_CAPTURE.standoff,
  height: string = DEFAULT_PLAN_CAPTURE.height,
  targetP95ResidualMm: number = DEFAULT_PLAN_CAPTURE.targetP95ResidualMm,
  trials: number = DEFAULT_PLAN_CAPTURE.trials,
  seed: number = DEFAULT_PLAN_CAPTURE.seed,
) =>
  call<CaptureCardResult>("mesh_visual_capture_card", {
    projectPath, screenId, imageSize, hfovDeg, vfovDeg, standoff, height,
    targetP95ResidualMm, trials, seed,
  });

/* ----------------------------- pose report / export ----------------------------- */
// 📝 no-ui: 读 cabinet_pose_report.json（重建产出）
export const meshVisualLoadPoseReport = (poseReportPath: string) =>
  call<CabinetPoseReportFile>("mesh_visual_load_pose_report", { poseReportPath });
// 📝 no-ui: pose report 合并导出 OBJ（disguise/neutral；unreal 显式不支持）
export const meshVisualExportPoseObj = (
  poseReportPath: string,
  target: string,
  outFile: string,
  root: string | null,
  ground: boolean,
  split: boolean,
  screenMapping?: string | null,
) =>
  call<ExportPoseObjResult>("mesh_visual_export_pose_obj", {
    poseReportPath, target, outFile, root, ground, split,
    screenMapping: screenMapping ?? null,
  });
