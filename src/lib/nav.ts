/* 导航状态：当前页、每页“已打开的对象”页签、每页 Inspector 开关与宽度。
   放在 lib/（而不是 app/）是因为 feature 页面要能打开对象页签、切页；外壳只负责渲染。
   设计：画布 App.dc.html —— 页签栏 = 当前页的固定页签 + 在该页打开过的对象。 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { persistOptions } from "./persist";

export type PageId =
  | "overview"
  | "inbox"
  | "tasks"
  | "screens"
  | "output"
  | "camera"
  | "rebuild"
  | "markers"
  | "spatial"
  | "verify"
  | "machines"
  | "projects"
  | "cache"
  | "pso"
  | "keyer"
  | "tracksim"
  | "settings";

export const PAGE_IDS: readonly PageId[] = [
  "overview", "inbox", "tasks", "screens", "output", "camera", "rebuild", "markers", "spatial", "verify",
  "machines", "projects", "cache", "pso", "keyer", "tracksim", "settings",
];

export type TabStatus = "running" | "success" | "failed" | "queued" | "attention" | "offline";

/** 一个已打开的对象页签。id 由页面自定（如 machine:12），页面据此渲染详情。 */
export interface ObjectTab {
  id: string;
  label: string;
  status?: TabStatus;
  statusLabel?: string;
}

export const INSPECTOR_DEFAULT = 340;
export const INSPECTOR_MIN = 300;
export const INSPECTOR_MAX = 520;

interface NavState {
  page: PageId;
  tabs: Partial<Record<PageId, ObjectTab[]>>;
  /** 每页当前激活的对象页签；null = 停在该页的列表（固定页签）。 */
  active: Partial<Record<PageId, string | null>>;
  inspector: Partial<Record<string, boolean>>;
  inspectorWidth: number;
  go: (page: PageId) => void;
  openObject: (page: PageId, tab: ObjectTab) => void;
  updateObject: (page: PageId, id: string, patch: Partial<ObjectTab>) => void;
  closeObject: (page: PageId, id: string) => void;
  showList: (page: PageId) => void;
  setInspector: (key: string, open: boolean) => void;
  setInspectorWidth: (w: number) => void;
}

type NavPrefs = Pick<NavState, "page" | "tabs" | "active" | "inspector" | "inspectorWidth">;

export function isPageId(v: unknown): v is PageId {
  return typeof v === "string" && (PAGE_IDS as readonly string[]).includes(v);
}

export const useNav = create<NavState>()(
  persist(
    (set) => ({
      page: "machines",
      tabs: {},
      active: {},
      inspector: {},
      inspectorWidth: INSPECTOR_DEFAULT,
      go: (page) => set({ page }),
      openObject: (page, tab) =>
        set((s) => {
          const list = s.tabs[page] ?? [];
          const has = list.some((t) => t.id === tab.id);
          return {
            page,
            tabs: { ...s.tabs, [page]: has ? list.map((t) => (t.id === tab.id ? { ...t, ...tab } : t)) : [...list, tab] },
            active: { ...s.active, [page]: tab.id },
          };
        }),
      updateObject: (page, id, patch) =>
        set((s) => ({ tabs: { ...s.tabs, [page]: (s.tabs[page] ?? []).map((t) => (t.id === id ? { ...t, ...patch } : t)) } })),
      closeObject: (page, id) =>
        set((s) => {
          const list = (s.tabs[page] ?? []).filter((t) => t.id !== id);
          const active = s.active[page] === id ? null : (s.active[page] ?? null);
          return { tabs: { ...s.tabs, [page]: list }, active: { ...s.active, [page]: active } };
        }),
      showList: (page) => set((s) => ({ page, active: { ...s.active, [page]: null } })),
      setInspector: (key, open) => set((s) => ({ inspector: { ...s.inspector, [key]: open } })),
      setInspectorWidth: (w) => set({ inspectorWidth: Math.round(Math.max(INSPECTOR_MIN, Math.min(INSPECTOR_MAX, w))) }),
    }),
    {
      ...persistOptions<NavState, NavPrefs>("nav", 1, ({ page, tabs, active, inspector, inspectorWidth }) => ({ page, tabs, active, inspector, inspectorWidth })),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<NavPrefs>;
        return {
          ...current,
          ...p,
          page: isPageId(p.page) ? p.page : current.page,
          inspectorWidth: typeof p.inspectorWidth === "number" ? p.inspectorWidth : current.inspectorWidth,
        };
      },
    },
  ),
);

/** 当前页的激活对象 id（没有则 null）。 */
export function useActiveObject(page: PageId): string | null {
  return useNav((s) => s.active[page] ?? null);
}

/** Inspector 开关：key 一般是页面 id，详情页可用 `${page}:detail`。默认打开。 */
export function useInspector(key: string): [boolean, (open: boolean) => void] {
  const open = useNav((s) => s.inspector[key] ?? true);
  const setInspector = useNav((s) => s.setInspector);
  return [open, (v: boolean) => setInspector(key, v)];
}
