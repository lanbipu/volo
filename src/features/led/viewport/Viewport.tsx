/* 三维视口外壳（volo-viewport）：three 场景 + 鼠标交互 + 屏幕名标签，HUD 由页面作为 children 叠上来。
   操作沿用旧视口约定：滚轮缩放（锚定光标）、左键拖拽转台（绕光标下的点）、右键 / Shift+左键平移、左键单击拾取。
   相机由页面持有（useState(() => new CameraRig())），框住全部 / 聚焦所选等按钮直接调 rig。 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { cx } from "@/ui";
import { CameraRig, pickBoxAt, SceneCanvas, worldPointAt, type PickHit, type SceneEntry, type ScenePalette, type SceneStore } from "./scene";
import type { P3 } from "../model/geometry";

export { CameraRig };
export type { PickHit, SceneEntry };

export interface ViewportLabel {
  id: string;
  text: string;
  at: P3;
  selected?: boolean;
  /** 纯文字标签（无框），贴在 at 点右侧，用于标记编号这类密集小标注。 */
  plain?: boolean;
}

/* ---------------- 主题取色：读当前 data-theme 根上的 CSS 变量 ---------------- */

const VARS: Record<keyof ScenePalette, string> = {
  fill: "--surface-raised",
  selFill: "--surface-selected",
  edge: "--border-strong",
  selEdge: "--text-primary",
  mask: "--border",
  ghost: "--accent",
  hover: "--surface-hover",
  grid: "--border",
  axis: "--text-tertiary",
};
const KEYS = Object.keys(VARS) as (keyof ScenePalette)[];

function subscribeTheme(cb: () => void) {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ["data-theme"] });
  return () => mo.disconnect();
}
function themeSnapshot(): string {
  const root = document.querySelector("[data-theme]") ?? document.documentElement;
  const cs = getComputedStyle(root);
  return KEYS.map((k) => cs.getPropertyValue(VARS[k]).trim() || "#808080").join("|");
}

export function useScenePalette(): ScenePalette {
  const snap = useSyncExternalStore(subscribeTheme, themeSnapshot);
  return useMemo(() => {
    const v = snap.split("|");
    return Object.fromEntries(KEYS.map((k, i) => [k, v[i]])) as unknown as ScenePalette;
  }, [snap]);
}

/* ---------------------------------- 视口 ---------------------------------- */

export interface ViewportProps {
  rig: CameraRig;
  entries: SceneEntry[];
  ground?: boolean;
  labels?: ViewportLabel[];
  label: string;
  /** 单击（未拖动）：命中的箱体或 null（点到空白）。 */
  onPick?: (hit: PickHit | null) => void;
  /** 悬停高亮箱体（箱体模式开）。 */
  hover?: boolean;
  flush?: boolean;
  children?: ReactNode;
}

const DRAG_PX = 3;

export function Viewport({ rig, entries, ground = true, labels = [], label, onPick, hover, flush, children }: ViewportProps) {
  const host = useRef<HTMLDivElement>(null);
  const labelEls = useRef(new Map<string, HTMLSpanElement>());
  const palette = useScenePalette();
  const [store] = useState<SceneStore>(() => ({ pickMeshes: [], setHover: () => undefined, invalidate: () => undefined }));
  const data = useMemo(() => ({ entries, showGround: ground, palette }), [entries, ground, palette]);
  const pickRef = useRef(onPick);
  const hoverRef = useRef(hover);
  useEffect(() => {
    pickRef.current = onPick;
    hoverRef.current = hover;
    if (!hover) store.setHover(null);
  }, [onPick, hover, store]);

  /* 屏幕名标签：跟着相机逐帧重投影，直接改 DOM（不走 React 渲染）。 */
  useEffect(() => {
    const place = () =>
      labels.forEach((l) => {
        const el = labelEls.current.get(l.id);
        if (!el) return;
        const p = rig.project(l.at);
        el.style.display = p ? "" : "none";
        if (p) el.style.transform = l.plain ? `translate(${p[0]}px, ${p[1]}px) translate(6px, -50%)` : `translate(${p[0]}px, ${p[1]}px) translate(-50%, -100%)`;
      });
    place();
    return rig.onChange(place);
  }, [rig, labels]);

  /* 鼠标：滚轮需要非 passive 监听才能 preventDefault。 */
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const ndcOf = (e: MouseEvent) => {
      const r = el.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -(((e.clientY - r.top) / r.height) * 2 - 1) };
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      rig.zoomStep(e.deltaY > 0 ? 1 : -1, ndcOf(e));
    };
    let drag: { mode: "orbit" | "pan"; x: number; y: number; moved: boolean; pivot: P3 | null; id: number } | null = null;
    const onDown = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest(".volo-viewport__hud")) return;
      const pan = e.button === 2 || e.button === 1 || (e.button === 0 && e.shiftKey);
      if (e.button !== 0 && !pan) return;
      const r = el.getBoundingClientRect();
      const p = pan ? null : worldPointAt(rig, store, r, e.clientX, e.clientY);
      drag = { mode: pan ? "pan" : "orbit", x: e.clientX, y: e.clientY, moved: false, pivot: p ? { x: p.x, y: p.y, z: p.z } : null, id: e.pointerId };
      el.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!drag) {
        if (hoverRef.current) store.setHover(pickBoxAt(rig, store, el.getBoundingClientRect(), e.clientX, e.clientY));
        return;
      }
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < DRAG_PX) return;
      drag.moved = true;
      drag.x = e.clientX;
      drag.y = e.clientY;
      if (drag.mode === "pan") rig.pan(dx, dy);
      else rig.orbit(dx, dy, drag.pivot);
    };
    const onUp = (e: PointerEvent) => {
      if (!drag) return;
      const d = drag;
      drag = null;
      if (el.hasPointerCapture(d.id)) el.releasePointerCapture(d.id);
      if (!d.moved && d.mode === "orbit") pickRef.current?.(pickBoxAt(rig, store, el.getBoundingClientRect(), e.clientX, e.clientY));
    };
    const onLeave = () => store.setHover(null);
    const noMenu = (e: MouseEvent) => e.preventDefault();
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("pointerleave", onLeave);
    el.addEventListener("contextmenu", noMenu);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("pointerleave", onLeave);
      el.removeEventListener("contextmenu", noMenu);
    };
  }, [rig, store]);

  return (
    <div ref={host} className={cx("volo-viewport", flush && "volo-viewport--flush")}>
      <div className="volo-viewport__canvas" role="img" aria-label={label}>
        <SceneCanvas rig={rig} data={data} store={store} />
      </div>
      {labels.map((l) => (
        <span
          key={l.id}
          ref={(n) => {
            if (n) labelEls.current.set(l.id, n);
            else labelEls.current.delete(l.id);
          }}
          className={cx("volo-viewport__label", l.plain && "volo-viewport__label--text", l.selected && "is-selected")}
          style={{ left: 0, top: 0 }}
          aria-hidden="true"
        >
          {l.text}
        </span>
      ))}
      {children}
    </div>
  );
}

/** 平滑取景到包围盒。 */
export function frame(rig: CameraRig, box: { min: P3; max: P3 } | null, smooth = true) {
  if (!box) return;
  if (!smooth) return rig.fit(box.min, box.max);
  const v = rig.fitView(box.min, box.max);
  rig.smoothTo({ target: v.target, dist: v.dist });
}
