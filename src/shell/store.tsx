// Volo · 应用外壳状态 —— 页面 / 平台 / 主题 / Stage / 布局（移植自原型 shell.jsx 的 App 状态）。
// 缓存域状态在 features/cache/state/store（useCache），与本 store 并存。
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { PAGES, type PageId } from "./data";

export type Platform = "mac" | "win";
export type Theme = "dark" | "light";
export type Density = "clean" | "rich";
export type ToolsNav = "top" | "left";

export interface ShellStore {
  page: PageId;
  setPage: (p: PageId) => void;
  platform: Platform;
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggleTheme: () => void;
  stage: string;
  setStage: (s: string) => void;
  density: Density;
  setDensity: (d: Density) => void;
  toolsNav: ToolsNav;
  setToolsNav: (t: ToolsNav) => void;
  leftW: number;
  setLeftW: (w: number) => void;
  rightW: number;
  setRightW: (w: number) => void;
}

const Ctx = createContext<ShellStore | null>(null);

interface Persisted {
  page?: PageId;
  density?: Density;
  toolsNav?: ToolsNav;
  leftW?: number;
  rightW?: number;
  stage?: string;
}

function readPersisted(): Persisted {
  try {
    return JSON.parse(localStorage.getItem("volo2") || "{}") as Persisted;
  } catch {
    return {};
  }
}

// 平台 chrome 按运行的操作系统决定（部署平台），不提供切换：
// macOS → Mac 版（系统菜单栏在窗口标题栏之上）；其余（Windows/Linux）→ Win 版（菜单在窗口最顶部）。
const detectPlatform = (): Platform =>
  typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent) ? "mac" : "win";

export function ShellProvider({ children }: { children: ReactNode }) {
  const p = readPersisted();
  const [page, setPage] = useState<PageId>(
    PAGES.some((x) => x.id === p.page) ? (p.page as PageId) : "tools",
  );
  const [platform] = useState<Platform>(detectPlatform);
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const t = localStorage.getItem("volo-theme");
      return t === "light" ? "light" : "dark";
    } catch {
      return "dark";
    }
  });
  const [stage, setStage] = useState<string>(p.stage || "st4");
  const [density, setDensity] = useState<Density>(p.density === "rich" ? "rich" : "clean");
  const [toolsNav, setToolsNav] = useState<ToolsNav>(p.toolsNav === "left" ? "left" : "top");
  const [leftW, setLeftW] = useState<number>(typeof p.leftW === "number" ? p.leftW : 214);
  const [rightW, setRightW] = useState<number>(typeof p.rightW === "number" ? p.rightW : 312);

  useEffect(() => {
    try {
      localStorage.setItem(
        "volo2",
        JSON.stringify({ page, density, toolsNav, leftW, rightW, stage }),
      );
    } catch {
      /* ignore */
    }
  }, [page, density, toolsNav, leftW, rightW, stage]);

  const applyTheme = useCallback((t: Theme) => {
    setTheme(t);
    try {
      localStorage.setItem("volo-theme", t);
    } catch {
      /* ignore */
    }
  }, []);
  const toggleTheme = useCallback(
    () => applyTheme(theme === "dark" ? "light" : "dark"),
    [theme, applyTheme],
  );

  const value = useMemo<ShellStore>(
    () => ({
      page,
      setPage,
      platform,
      theme,
      setTheme: applyTheme,
      toggleTheme,
      stage,
      setStage,
      density,
      setDensity,
      toolsNav,
      setToolsNav,
      leftW,
      setLeftW,
      rightW,
      setRightW,
    }),
    [page, platform, theme, applyTheme, toggleTheme, stage, density, toolsNav, leftW, rightW],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useShell(): ShellStore {
  const v = useContext(Ctx);
  if (!v) throw new Error("useShell must be used within ShellProvider");
  return v;
}
