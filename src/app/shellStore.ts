/* 外壳自己的偏好：主题、密度、侧栏是否显示、侧栏分组折叠。页面路由在 lib/nav。 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { persistOptions } from "@/lib/persist";

export type Theme = "dark" | "light";
export type Density = "comfortable" | "compact";

interface ShellState {
  theme: Theme;
  /** 主题跟随系统（设置 › 外观）；手动切换主题时关掉。 */
  followSystem: boolean;
  density: Density;
  side: boolean;
  collapsed: Record<string, boolean>;
  setTheme: (theme: Theme) => void;
  setFollowSystem: (on: boolean) => void;
  setDensity: (density: Density) => void;
  toggleSide: () => void;
  toggleGroup: (g: string) => void;
}

type ShellPrefs = Pick<ShellState, "theme" | "followSystem" | "density" | "side" | "collapsed">;

export const useShellStore = create<ShellState>()(
  persist(
    (set) => ({
      theme: "dark",
      followSystem: false,
      density: "comfortable",
      side: true,
      collapsed: {},
      setTheme: (theme) => set({ theme, followSystem: false }),
      setFollowSystem: (followSystem) => set({ followSystem }),
      setDensity: (density) => set({ density }),
      toggleSide: () => set((s) => ({ side: !s.side })),
      toggleGroup: (g) => set((s) => ({ collapsed: { ...s.collapsed, [g]: !s.collapsed[g] } })),
    }),
    {
      ...persistOptions<ShellState, ShellPrefs>("shell", 2, ({ theme, followSystem, density, side, collapsed }) => ({ theme, followSystem, density, side, collapsed })),
      // v1 多存了 page（路由已移到 lib/nav）；字段校验统一在 merge 里做，迁移只需原样交出。
      migrate: (persisted) => persisted as ShellPrefs,
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<ShellPrefs>;
        return {
          ...current,
          theme: p.theme === "light" ? "light" : "dark",
          followSystem: p.followSystem === true,
          density: p.density === "compact" ? "compact" : "comfortable",
          side: p.side !== false,
          collapsed: p.collapsed && typeof p.collapsed === "object" ? p.collapsed : {},
        };
      },
    },
  ),
);
