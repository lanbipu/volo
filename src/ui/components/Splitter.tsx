/* 分栏拖拽条（ry-splitter）：视觉 1px，热区 --splitter-hit。拖动改相邻面板宽度，←/→ 键每次 16px。 */
import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { cx } from "../cx";

export interface SplitterProps {
  label: string;
  value: number;
  min: number;
  max: number;
  /** 面板在拖拽条哪一侧：right = 往左拖变宽（Inspector）。 */
  side: "left" | "right";
  onChange: (v: number) => void;
}

export function Splitter({ label, value, min, max, side, onChange }: SplitterProps) {
  const start = useRef<{ x: number; v: number } | null>(null);
  const [drag, setDrag] = useState(false);
  const clamp = (v: number) => Math.round(Math.max(min, Math.min(max, v)));

  const onDown = (e: PointerEvent<HTMLButtonElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, v: value };
    setDrag(true);
  };
  const onMove = (e: PointerEvent<HTMLButtonElement>) => {
    if (!start.current) return;
    const dx = e.clientX - start.current.x;
    onChange(clamp(start.current.v + (side === "right" ? -dx : dx)));
  };
  const onUp = () => {
    start.current = null;
    setDrag(false);
  };
  const onKey = (e: KeyboardEvent) => {
    const d = e.key === "ArrowLeft" ? -16 : e.key === "ArrowRight" ? 16 : 0;
    if (!d) return;
    e.preventDefault();
    onChange(clamp(value + (side === "right" ? -d : d)));
  };

  return (
    <button
      type="button"
      className={cx("ry-splitter", drag && "is-dragging")}
      aria-label={label}
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onKeyDown={onKey}
    />
  );
}
