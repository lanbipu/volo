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
