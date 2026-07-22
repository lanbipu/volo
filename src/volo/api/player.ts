/* Volo — pattern player window bindings (live-capture plan Phase 3a).
   Frontend counterpart of src-tauri/src/commands/player.rs. The player window
   itself listens to `player://show` / `player://clear` (see
   pages/patternPlayer.tsx); the control side only calls these commands. */
import { call } from "./invoke";

export interface MonitorInfo {
  index: number;
  name: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  scale_factor: number;
  is_primary: boolean;
}

export interface PlayerWindowInfo {
  label: string;
  monitor_index: number;
  width: number;
  height: number;
  scale_factor: number;
}

export interface ShowPatternResult {
  pattern_width: number;
  pattern_height: number;
  window_width: number;
  window_height: number;
  /** True when window physical size ≠ pattern resolution (C0 1:1 warning). */
  resolution_mismatch: boolean;
}

export const listMonitors = () => call<MonitorInfo[]>("list_monitors");

export const openPatternPlayer = (monitorIndex: number) =>
  call<PlayerWindowInfo>("open_pattern_player", { monitorIndex });

export const closePatternPlayer = () => call<boolean>("close_pattern_player");

export const playerShowPattern = (
  imagePath: string,
  pattern: string,
  frameIndex?: number | null,
) =>
  call<ShowPatternResult>("player_show_pattern", {
    imagePath,
    pattern,
    frameIndex: frameIndex ?? null,
  });

export const playerClear = () => call<void>("player_clear");

/**
 * Pick the monitor that should host the LED/TV pattern player.
 *
 * Preference (VP bench assumption — Windows "Extend these displays"):
 * 1. Explicit deploy selection (caller passes through)
 * 2. Single non-primary monitor (operator primary is usually the ASUS desk panel;
 *    the LG/TV wall feed is extended as secondary)
 * 3. Largest-area non-primary when several exist
 * 4. Last enumerated monitor as last resort
 *
 * Limitation: if Windows is set to Duplicate, `available_monitors` collapses to
 * one entry and the TV cannot be targeted separately.
 */
export function preferPatternMonitor(
  monitors: MonitorInfo[],
): MonitorInfo | null {
  if (!monitors.length) return null;
  const secondary = monitors.filter((m) => !m.is_primary);
  if (secondary.length === 1) return secondary[0];
  if (secondary.length > 1) {
    return secondary.reduce((a, b) =>
      a.width * a.height >= b.width * b.height ? a : b,
    );
  }
  return monitors[monitors.length - 1] ?? monitors[0] ?? null;
}
