// Volo · 应用外壳 —— 1:1 还原 Volo.html 桌面窗口：.volo-cache>.viewport>.desktop>.win（chrome 行 +
// 上下文条 + 三列 body + 日志面板 + 底部页签）+ 浮层宿主。各页通过 PAGE_REGISTRY 向四区贡献组件。
import { useEffect } from "react";
import { useShell } from "./store";
import { LogPanel } from "../features/cache";
import { startResize } from "../features/cache/shell/resize";
import { MacTitleBar, WinTopBar, WinSubBar } from "./chrome";
import { PageTabs } from "./PageTabs";
import { PAGE_REGISTRY } from "./pages/registry";

export function Shell() {
  const { page, platform, theme, density, leftW, setLeftW, rightW, setRightW } = useShell();
  const pg = PAGE_REGISTRY[page];
  const mac = platform === "mac";

  // 桌面 App：禁掉浏览器右键菜单（reload / 检查 等二级菜单不该出现）。
  useEffect(() => {
    const prevent = (e: Event) => e.preventDefault();
    document.addEventListener("contextmenu", prevent);
    return () => document.removeEventListener("contextmenu", prevent);
  }, []);

  return (
    <div className="volo-cache" data-theme={theme}>
      <div className="viewport">
        <div className={"desktop is-" + platform + (density === "clean" ? " clean" : "")}>
          <div className={"win is-" + platform}>
            {mac ? (
              <MacTitleBar />
            ) : (
              <>
                <WinTopBar />
                <WinSubBar />
              </>
            )}

            <div className="ctxbar">
              <pg.Ctx />
            </div>

            <div
              className="body"
              style={{
                position: "relative",
                gridTemplateColumns: `${leftW}px 6px minmax(0,1fr) 6px ${rightW}px`,
              }}
            >
              <div className="leftcol">
                <pg.Left />
              </div>
              <div
                className="resizer resizer--col"
                title="拖动调整宽度"
                onPointerDown={(e) => startResize(e, "x", 1, leftW, setLeftW, 170, 380)}
              />
              <div className="center">
                <pg.Center />
              </div>
              <div
                className="resizer resizer--col"
                title="拖动调整宽度"
                onPointerDown={(e) => startResize(e, "x", -1, rightW, setRightW, 240, 480)}
              />
              <div className="inspector">
                <pg.Inspector />
              </div>
              {pg.Overlay ? <pg.Overlay /> : null}
            </div>

            <LogPanel />
            <PageTabs />
          </div>
        </div>
      </div>
    </div>
  );
}
