/* Volo — Lens (vpcal) typed command bindings (Calibrate LED「镜头校正」单页).
   One wrapper per `#[tauri::command]` in src-tauri/src/commands/vpcal_runs.rs.
   See ./types for DTO conventions; ./invoke for the transport. */
import { call } from "./invoke";

// ✅ wired: calLens「从已有 session 求解」弹窗 · 最近会话列表 →
// listLensSessions(sessionsRoot)（扫描目录下 session.json，同 list_ar_runs 模式）
export interface LensSessionSummary {
  /** 会话标识 = session.json 所在目录名 */
  id: string;
  session_dir: string;
  session_json_path: string;
  lens_ready: boolean;
  /** 从 tracking/poses.jsonl 行数统计；无法读取时为 null */
  poses_captured: number | null;
  modified_at: string | null;
}
export const listLensSessions = (sessionsRoot: string) =>
  call<LensSessionSummary[]>("list_lens_sessions", { sessionsRoot });

// ✅ wired: calArVerify.tsx「验证叠加」标注帧查看器 → readImageAsDataUrl(path, baseDir)
// （本地图片读成 data: URL；verify overlay 的输出目录是运行时才知道的，没有静态
// asset-protocol scope 能覆盖，故用这条命令代替。baseDir 传 verify overlay 本次
// --out 的目录——后端会校验 path 确实落在这个目录下、是白名单图片扩展名、且不超
// 大小上限，不是任意路径读取，见 vpcal_runs.rs 的 read_image_as_data_url 注释）
export const readImageAsDataUrl = (path: string, baseDir: string) =>
  call<string>("read_image_as_data_url", { path, baseDir });
