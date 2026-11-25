/* 舞台 LED：屏幕 → 上屏 → 摄影机 → 重建。 */
export { ScreensPage } from "./ui/ScreensPage";
export { OutputPage } from "./ui/OutputPage";
export { RebuildPage } from "./ui/RebuildPage";
export { CameraPage, CameraMore, type CameraVariant } from "./ui/CameraPage";
/* 给舞台 AR 复用：三维视口、摄影机页（AR 传入自己的详情）、信号源面板、Stage 读写。 */
export { Viewport, CameraRig, frame, type SceneEntry, type ViewportLabel } from "./viewport/Viewport";
export type { PickBox } from "./viewport/scene";
export { CameraSources } from "./ui/CameraInspector";
export { useLedStage, useSaveStage } from "./model/screens";
export { cameraLabel, useCaptureProfiles, profileFor } from "./model/camera";
/* 给概览 / 任务 / 待处理用的只读摘要。 */
export { useRuns, currentRun, runSource } from "./model/screens";
export { resolveTopology, validateTopology, useOutputSession, sessionIdFor } from "./model/output";
export { useLensSessions, useCapture, RMS_ADOPT_PX, baseName, camTab } from "./model/camera";
export { useRebuildJobs, runTab as rebuildRunTab, type RebuildJob } from "./model/rebuild";
