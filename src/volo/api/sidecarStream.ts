/* Volo — streaming sidecar bridge (W3.1).
   Frontend counterpart of src-tauri/src/commands/sidecar_stream.rs:
   spawn_sidecar_streaming / sidecar_stdin_write / cancel_sidecar_task, plus
   the per-task Tauri event channel `sidecar://<task_id>` those commands emit
   `SidecarStreamEvent` on. Field names below are snake_case to match the
   Rust `Serialize` shape (see ./invoke's wiring-rules comment). */
import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { call } from "./invoke";

/* ------------------------------- types ------------------------------- */

export interface SidecarStreamLineEvent {
  kind: "line";
  task_id: string;
  raw: string;
  /** Present when `raw` parsed as JSON; absent for tolerated non-JSON lines. */
  parsed?: unknown;
}

export interface SidecarStreamExitEvent {
  kind: "exit";
  task_id: string;
  exit_code: number | null;
  /** Last 4KB of the sidecar's stderr, for diagnostics. */
  stderr_tail: string;
  /** True for a non-zero/missing exit code that was NOT the result of our
   *  own cancel_sidecar_task call. */
  fatal: boolean;
  /** True iff cancel_sidecar_task triggered the shutdown (graceful or killed). */
  cancelled: boolean;
}

export type SidecarStreamEvent = SidecarStreamLineEvent | SidecarStreamExitEvent;

export interface SpawnStreamingResponse {
  task_id: string;
  channel: string;
}

/* ----------------------------- commands ----------------------------- */

/** One-shot argv sidecar run (`commands::sidecars::spawn_sidecar`): blocks
 *  until the child exits, returns its captured stdout/stderr/exit code in one
 *  shot. For long-running tasks that need live progress, use
 *  `spawnSidecarStreaming` instead. */
export interface SidecarOutput {
  exit_code: number;
  stdout: string;
  stderr: string;
}

export const spawnSidecar = (name: string, args: string[]) =>
  call<SidecarOutput>("spawn_sidecar", { name, args });

export const spawnSidecarStreaming = (name: string, args: string[]) =>
  call<SpawnStreamingResponse>("spawn_sidecar_streaming", { name, args });

/** Returns false when task_id is unknown (task already exited). */
export const sidecarStdinWrite = (taskId: string, line: string) =>
  call<boolean>("sidecar_stdin_write", { taskId, line });

/** Returns false when task_id is unknown (task already exited). */
export const cancelSidecarTask = (taskId: string) =>
  call<boolean>("cancel_sidecar_task", { taskId });

/** Orphan sweep: cancel every running task of one sidecar program. Page
 *  reloads lose all task handles, so previous-generation tasks (e.g. a
 *  DeckLink monitor holding the device exclusively) can never be cancelled
 *  individually — call this once at page load. Returns the count cancelled. */
export const cancelSidecarTasksByProgram = (program: string) =>
  call<number>("cancel_sidecar_tasks_by_program", { program });

/** Subscribe to a running task's event channel directly (no React). Callers
 *  own the returned unlisten fn. */
export const listenSidecarStream = (
  taskId: string,
  onEvent: (event: SidecarStreamEvent) => void,
): Promise<UnlistenFn> =>
  listen<SidecarStreamEvent>(`sidecar://${taskId}`, (e) => onEvent(e.payload));

/** Cancel then wait for the real exit event (DeckLink/UVC exclusive devices).
 *  `cancel_sidecar_task` only posts Cancel — the process may linger up to ~3s.
 *  Subscribe to exit *before* cancel so the event cannot race past us. */
export async function cancelSidecarTaskAwaitExit(
  taskId: string,
  timeoutMs = 5000,
): Promise<void> {
  await new Promise<void>((resolve) => {
    let un: UnlistenFn | null = null;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (un) un();
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    void (async () => {
      try {
        const fn = await listenSidecarStream(taskId, (ev) => {
          if (ev.kind === "exit") finish();
        });
        if (done) fn();
        else un = fn;
      } catch {
        finish();
        return;
      }
      try {
        const alive = await cancelSidecarTask(taskId);
        if (!alive || !un) finish();
      } catch {
        finish();
      }
    })();
  });
}

/* -------------------------------- hook -------------------------------- */

export interface UseSidecarStreamState {
  lines: SidecarStreamLineEvent[];
  exit: SidecarStreamExitEvent | null;
  /** Set when the event subscription itself fails (e.g. not running under
   *  Tauri) — distinct from a sidecar-reported failure, which surfaces via
   *  `exit.fatal`. */
  subscribeError: string | null;
}

const EMPTY_STATE: UseSidecarStreamState = { lines: [], exit: null, subscribeError: null };

/** Subscribes to `sidecar://<taskId>` for the lifetime of `taskId` (re-subscribes
 *  when it changes, unsubscribes on unmount), accumulating line/exit events.
 *  `taskId=null` means "nothing to subscribe to yet" (e.g. before the caller's
 *  `spawnSidecarStreaming` resolves). */
export function useSidecarStream(taskId: string | null) {
  const [state, setState] = useState<UseSidecarStreamState>(EMPTY_STATE);

  useEffect(() => {
    setState(EMPTY_STATE);
    if (!taskId) return;

    let cancelled = false;
    let unlisten: UnlistenFn | null = null;

    listenSidecarStream(taskId, (event) => {
      if (cancelled) return;
      setState((prev) =>
        event.kind === "line"
          ? { ...prev, lines: [...prev.lines, event] }
          : { ...prev, exit: event },
      );
    })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setState((prev) => ({ ...prev, subscribeError: String(e) }));
        }
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [taskId]);

  const taskIdRef = useRef(taskId);
  taskIdRef.current = taskId;

  const writeLine = useCallback((line: string) => {
    const id = taskIdRef.current;
    if (!id) return Promise.resolve(false);
    return sidecarStdinWrite(id, line);
  }, []);

  const cancel = useCallback(() => {
    const id = taskIdRef.current;
    if (!id) return Promise.resolve(false);
    return cancelSidecarTask(id);
  }, []);

  return { state, writeLine, cancel };
}
