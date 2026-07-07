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

// ✅ wired: calArVerify.tsx「验证叠加」标注帧查看器 → readImageAsDataUrl(path)
// （本地图片读成 data: URL；verify overlay 的输出目录是运行时才知道的，没有静态
// asset-protocol scope 能覆盖，故用这条命令代替。后端不接受调用方声明的"这是安全
// 目录"——那能被绕过（调用方能同时摆布 path 和它自己声称的 base）。真正的校验是
// path 必须出现在 Rust 自己从 verify overlay 真实子进程 stdout 里解析出的
// annotated_images 白名单里，见 vpcal_runs.rs / sidecar_stream.rs 的注释）
export const readImageAsDataUrl = (path: string) =>
  call<string>("read_image_as_data_url", { path });
