/* 唯一的页面表（frontend-structure.md §5）。页面是普通组件，按需懒加载；
   不再有 window.VOLO_PAGES 和 import 顺序契约。 */
import { lazy, type ComponentType, type LazyExoticComponent } from "react";

export type PageId = "previz" | "calibrate" | "color" | "live" | "tools";

export interface PageDef {
  id: PageId;
  label: string;
  component: LazyExoticComponent<ComponentType>;
}

export const PAGES: readonly PageDef[] = [
  { id: "previz", label: "预演", component: lazy(() => import("@/features/previz")) },
  { id: "calibrate", label: "校正", component: lazy(() => import("@/features/calibrate")) },
  { id: "color", label: "调色", component: lazy(() => import("@/features/color")) },
  { id: "live", label: "现场", component: lazy(() => import("@/features/live")) },
  { id: "tools", label: "工具", component: lazy(() => import("@/features/tools")) },
];

export const DEFAULT_PAGE: PageId = "tools";

export function isPageId(v: unknown): v is PageId {
  return typeof v === "string" && PAGES.some((p) => p.id === v);
}

export function findPage(id: PageId): PageDef {
  return PAGES.find((p) => p.id === id) ?? PAGES.find((p) => p.id === DEFAULT_PAGE)!;
}
