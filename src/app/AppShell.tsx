/* 新外壳骨架。**视觉尚未移植**：标题栏 / 页签 / 工作区框架要等 Runyard 布局在 Claude Design
   里出 handoff 后 1:1 落地（frontend-structure.md §7）。这里只有结构：主题 / 密度属性、
   页面切换、懒加载边界。临时页签是无样式的原生按钮，仅供开发期切页。 */
import { Suspense, useEffect } from "react";
import { PAGES, findPage } from "./pages";
import { useShellStore } from "./shellStore";

export function AppShell() {
  const page = useShellStore((s) => s.page);
  const theme = useShellStore((s) => s.theme);
  const density = useShellStore((s) => s.density);
  const setPage = useShellStore((s) => s.setPage);

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-theme", theme);
    root.setAttribute("data-ry-density", density);
  }, [theme, density]);

  const Page = findPage(page).component;

  return (
    <div data-shell="next">
      <nav aria-label="页面" data-tauri-drag-region>
        {PAGES.map((p) => (
          <button key={p.id} type="button" aria-current={p.id === page ? "page" : undefined} onClick={() => setPage(p.id)}>
            {p.label}
          </button>
        ))}
      </nav>
      <main>
        <Suspense fallback={null}>
          <Page />
        </Suspense>
      </main>
    </div>
  );
}
