/* Volo — pattern player window content (live-capture plan Phase 3a).
   Runs in the second webview window ("pattern-player", hash #/pattern-player).
   This is the raw LED-facing output surface, NOT a designed UI: black field,
   the pattern PNG rendered pixel-exact, nothing else (no chrome, no overlays —
   anything drawn here goes onto the wall). Driven entirely by Tauri events
   from commands/player.rs:

     player://show   { image_b64, mime, width, height, pattern, frame_index }
     player://clear  {}

   Pixel exactness: the image is laid out at `width / devicePixelRatio` CSS px
   so its physical size equals the pattern resolution 1:1, with
   image-rendering: pixelated to forbid resampling. Esc closes the window. */
import * as React from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface ShowPayload {
  image_b64: string;
  mime: string;
  width: number;
  height: number;
  pattern: string;
  frame_index: number | null;
}

export function PatternPlayer(): React.ReactElement {
  const [shown, setShown] = React.useState<ShowPayload | null>(null);

  React.useEffect(() => {
    const unlisteners: UnlistenFn[] = [];
    let disposed = false;
    void listen<ShowPayload>("player://show", (e) => setShown(e.payload)).then((fn) => {
      if (disposed) fn();
      else unlisteners.push(fn);
    });
    void listen("player://clear", () => setShown(null)).then((fn) => {
      if (disposed) fn();
      else unlisteners.push(fn);
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void getCurrentWindow().close();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      disposed = true;
      unlisteners.forEach((fn) => fn());
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const dpr = window.devicePixelRatio || 1;
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "#000",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "none",
        overflow: "hidden",
      }}
    >
      {shown ? (
        <img
          src={`data:${shown.mime};base64,${shown.image_b64}`}
          alt=""
          draggable={false}
          style={{
            width: `${shown.width / dpr}px`,
            height: `${shown.height / dpr}px`,
            imageRendering: "pixelated",
            userSelect: "none",
          }}
        />
      ) : null}
    </div>
  );
}
