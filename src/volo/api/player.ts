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
