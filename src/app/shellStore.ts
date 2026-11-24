/* 外壳自己的状态：当前页、主题、密度。页面状态归各 feature 的 store，不放这里。 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { persistOptions } from "@/lib/persist";
import { DEFAULT_PAGE, isPageId, type PageId } from "./pages";

export type Theme = "dark" | "light";
export type Density = "comfortable" | "compact";

interface ShellState {
  page: PageId;
  theme: Theme;
  density: Density;
  setPage: (page: PageId) => void;
  setTheme: (theme: Theme) => void;
  setDensity: (density: Density) => void;
}

type ShellPrefs = Pick<ShellState, "page" | "theme" | "density">;

export const useShellStore = create<ShellState>()(
  persist(
    (set) => ({
      page: DEFAULT_PAGE,
      theme: "dark",
      density: "comfortable",
      setPage: (page) => set({ page }),
      setTheme: (theme) => set({ theme }),
      setDensity: (density) => set({ density }),
    }),
    {
      ...persistOptions<ShellState, ShellPrefs>("shell", 1, ({ page, theme, density }) => ({ page, theme, density })),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<ShellPrefs>;
        return {
          ...current,
          page: isPageId(p.page) ? p.page : current.page,
          theme: p.theme === "light" ? "light" : "dark",
          density: p.density === "compact" ? "compact" : "comfortable",
        };
      },
    },
  ),
);
