/* 图案播放窗口（第二个 webview 窗口 "pattern-player"，hash #/pattern-player；commands/player.rs 打开）。
   这是打到 LED 墙上的原始输出面，不是设计过的界面：纯黑底 + 逐像素的图案 PNG，别的什么都不画
   （画在这里的任何东西都会上墙）。完全由 Tauri 事件驱动：
     player://show   { image_b64, mime, width, height, pattern, frame_index }
     player://clear  {}
   逐像素：图片按 width / devicePixelRatio 个 CSS 像素排版，物理尺寸等于图案分辨率，并禁止重采样。Esc 关窗。 */
import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTauriEvent } from "@/lib/events";
import css from "./PatternPlayer.module.css";

interface ShowPayload {
  image_b64: string;
  mime: string;
  width: number;
  height: number;
  pattern: string;
  frame_index: number | null;
}

export function PatternPlayer() {
  const [shown, setShown] = useState<ShowPayload | null>(null);
  useTauriEvent<ShowPayload>("player://show", setShown);
  useTauriEvent("player://clear", () => setShown(null));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void getCurrentWindow().close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const dpr = window.devicePixelRatio || 1;
  return (
    <div className={css.field}>
      {shown && <img className={css.img} src={`data:${shown.mime};base64,${shown.image_b64}`} alt="" draggable={false} style={{ width: `${shown.width / dpr}px`, height: `${shown.height / dpr}px` }} />}
    </div>
  );
}
