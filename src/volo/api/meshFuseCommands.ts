/* Volo — W6 R1: M1(全站仪)+ M2(视觉 BA)融合 typed command binding.
   Wraps the `mesh_fuse_run` Tauri command (src-tauri/src/commands/mesh_fuse.rs).
   Arg keys are camelCase (Rust snake_case → JS camelCase). See ./types for the
   DTO shape; ./invoke for the transport.

   📝 no-ui —— 后端已就绪,UI 落地时把 wire-target 记在这里(本次仅后端+CLI,
   不接 src/volo/pages/)。 */
import { call } from "./invoke";
import type { FuseResult } from "./types";

// 📝 no-ui: 按 grid-vertex 名匹配对应点,Umeyama 对齐视觉重建到全站仪测点,
// 写出对齐后的 pose report 副本。allowScale=false(默认)锁 scale=1.0。
export const meshFuseRun = (
  projectPath: string,
  screenId: string,
  poseReportPath: string,
  measurementsPath: string,
  allowScale: boolean,
) =>
  call<FuseResult>("mesh_fuse_run", {
    projectPath, screenId, poseReportPath, measurementsPath, allowScale,
  });
