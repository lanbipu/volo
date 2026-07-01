/* Volo — Cache typed Tauri invoke core.
   The single transport seam between the Cache page (custom-CSS port) and the
   ~85 Rust `#[tauri::command]` handlers registered in src-tauri/src/lib.rs.

   Wiring rules (see CLAUDE.md · "Tauri v2 接线"):
   - JS arg keys are camelCase (Rust `machine_id` → JS `machineId`); a struct
     input is passed whole under one camelCase key, its inner fields stay
     snake_case (handled by the callers in ./commands).
   - Every command returns `Result<T, String>`; the `Err(String)` reaches JS as a
     thrown value. We normalize it to `VoloInvokeError` so callers get a stable
     `.command` + `.message`. */
import { invoke } from "@tauri-apps/api/core";

/** Normalized failure of a Tauri command (all handlers return `Result<_, String>`). */
export class VoloInvokeError extends Error {
  readonly command: string;
  constructor(command: string, message: string) {
    super(message);
    this.name = "VoloInvokeError";
    this.command = command;
  }
}

/** True only inside the Tauri runtime. In the vite browser preview (:1420) there
 *  is no backend, so callers should surface an error state rather than hang. */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function normalize(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/** Thin typed wrapper over Tauri `invoke`. Throws `VoloInvokeError` on failure
 *  (including "not running under Tauri"), never a bare string. */
export async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw new VoloInvokeError(command, "未运行在 Tauri 运行时（浏览器预览无后端）");
  }
  try {
    return await invoke<T>(command, args);
  } catch (e) {
    throw new VoloInvokeError(command, normalize(e));
  }
}
