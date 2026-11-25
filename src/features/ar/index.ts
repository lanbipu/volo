/* 舞台 AR：标记 → 摄影机（延迟）→ 空间求解 → 验证。 */
export { MarkersPage } from "./ui/MarkersPage";
export { SpatialPage } from "./ui/SpatialPage";
export { VerifyPage } from "./ui/VerifyPage";
export { ArCameraPage } from "./ui/CameraPage";
/* 给概览 / 任务 / 待处理用的只读摘要。 */
export { useArWorkspace, useArRuns, useArJobs, useStageSpatialJobs, adoptedRun, runLabel, runTitle, runTab, VERIFY_LIMIT_PX, CONF_LABEL, isLowConf, cancelSpatial, type ArRunSummary, type SpatialJob } from "./model/ar";
