/* 标签栏（ry-windowbar）：当前页的固定页签 + 在该页打开的对象页签；右侧密度 / 主题。
   设计：App.dc.html。页签不再承担一级导航（IA.dc.html）。 */
import { Icon, IconButton, Status } from "@/ui";
import { useNav, type ObjectTab } from "@/lib/nav";
import { findPage } from "./pages";
import { useShellStore } from "./shellStore";
import css from "./AppShell.module.css";

const NO_TABS: ObjectTab[] = [];

export function WindowBar({ onOpenPalette }: { onOpenPalette: () => void }) {
  const page = useNav((s) => s.page);
  const tabs = useNav((s) => s.tabs[s.page]) ?? NO_TABS;
  const active = useNav((s) => s.active[s.page] ?? null);
  const openObject = useNav((s) => s.openObject);
  const closeObject = useNav((s) => s.closeObject);
  const showList = useNav((s) => s.showList);
  const side = useShellStore((s) => s.side);
  const toggleSide = useShellStore((s) => s.toggleSide);
  const theme = useShellStore((s) => s.theme);
  const density = useShellStore((s) => s.density);
  const setTheme = useShellStore((s) => s.setTheme);
  const setDensity = useShellStore((s) => s.setDensity);
  const def = findPage(page);

  return (
    <div className="ry-windowbar" data-tauri-drag-region>
      {!side && (
        <>
          <span className={`ry-lights ${css.lightsWide}`} aria-hidden="true" data-native-lights>
            <i />
            <i />
            <i />
          </span>
          <IconButton icon="sidebar" label="展开导航" pressed={false} onClick={toggleSide} />
        </>
      )}
      <div className="ry-tabs" role="tablist" aria-label="已打开的对象">
        <button type="button" className="ry-tab ry-tab--pinned" role="tab" aria-selected={active == null} aria-label={def.label} data-tip={def.label} onClick={() => showList(page)}>
          <Icon name={def.icon} size="sm" />
        </button>
        {tabs.map((t) => (
          <button key={t.id} type="button" className="ry-tab ry-tab--object" role="tab" aria-selected={active === t.id} onClick={() => openObject(page, t)}>
            {t.status && <Status kind={t.status} label={t.statusLabel ?? ""} srOnly size="sm" />}
            <span className="ry-tab__label">{t.label}</span>
            <span
              className="ry-tab__close"
              aria-hidden="true"
              onClick={(e) => {
                e.stopPropagation();
                closeObject(page, t.id);
              }}
            >
              <Icon name="close" size="sm" />
            </span>
          </button>
        ))}
      </div>
      <IconButton icon="plus" label="打开对象" onClick={onOpenPalette} />
      <span className="ry-toolbar__spacer" data-tauri-drag-region />
      <IconButton icon="density" label="切换密度：舒适 / 紧凑" onClick={() => setDensity(density === "comfortable" ? "compact" : "comfortable")} />
      <IconButton icon="sun" label="切换主题：深色 / 浅色" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} />
    </div>
  );
}
