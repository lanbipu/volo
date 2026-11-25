/* 各列表页的“显示”偏好（分组 / 排序 / 列 / 视图），每页各自记住（显示弹层脚注：每一页各自记住显示方式）。 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { persistOptions } from "@/lib/persist";

export interface ViewPrefs {
  group: string;
  sort: string;
  cols: Record<string, boolean>;
  view?: string;
}

interface ViewState {
  pages: Record<string, ViewPrefs>;
  set: (page: string, patch: Partial<ViewPrefs>) => void;
  reset: (page: string) => void;
}

export const useViewStore = create<ViewState>()(
  persist(
    (set) => ({
      pages: {},
      set: (page, patch) => set((s) => ({ pages: { ...s.pages, [page]: { ...(s.pages[page] ?? { group: "", sort: "", cols: {} }), ...patch } } })),
      reset: (page) =>
        set((s) => {
          const next = { ...s.pages };
          delete next[page];
          return { pages: next };
        }),
    }),
    persistOptions<ViewState, Pick<ViewState, "pages">>("cache.view", 1, ({ pages }) => ({ pages })),
  ),
);

/** 取某页的显示偏好（缺省值由页面给）；返回 [prefs, patch, reset]。 */
export function useViewPrefs(page: string, defaults: ViewPrefs): [ViewPrefs, (p: Partial<ViewPrefs>) => void, () => void] {
  const saved = useViewStore((s) => s.pages[page]);
  const setP = useViewStore((s) => s.set);
  const reset = useViewStore((s) => s.reset);
  const prefs: ViewPrefs = { ...defaults, ...saved, cols: { ...defaults.cols, ...(saved?.cols ?? {}) } };
  return [prefs, (p) => setP(page, p), () => reset(page)];
}
