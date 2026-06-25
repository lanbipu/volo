// Volo · Cache —— 拖拽改尺寸（列宽 / 日志面板高），移植自 shell.jsx 的 startResize。
import type { PointerEvent } from "react";

export function startResize(
  e: PointerEvent,
  axis: "x" | "y",
  dir: 1 | -1,
  startVal: number,
  setVal: (v: number) => void,
  min: number,
  max: number,
) {
  e.preventDefault();
  const startPos = axis === "x" ? e.clientX : e.clientY;
  const onMove = (ev: globalThis.PointerEvent) => {
    const cur = axis === "x" ? ev.clientX : ev.clientY;
    let v = startVal + dir * (cur - startPos);
    v = Math.max(min, Math.min(max, v));
    setVal(Math.round(v));
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  document.body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
  document.body.style.userSelect = "none";
}
