// Volo · 窗口 chrome —— macOS 系统栏 / 标题栏、Windows 顶栏 + 副栏、文档面包屑、Stage 切换、平台 / 主题切换。
// 1:1 移植自原型 shell.jsx。节点/同步等为原型装饰性 chrome 文案（保持 1:1）；功能真相在缓存页。
import { Icon } from "../features/cache/ui/Icon";
import { Selector, type SelectorOption } from "../features/cache/ui/Selector";
import { useShell } from "./store";
import { STAGES, APP_MENUS } from "./data";

const stageOptions = (): SelectorOption[] =>
  STAGES.map((x) => ({ id: x.id, label: `${x.name} · ${x.volume}`, sub: x.state, pip: x.status }));

// 无边框窗口的窗口控制（红绿灯 / winctl）—— 只在 Tauri 宿主里生效，浏览器下 catch 掉。
async function winAction(action: "close" | "minimize" | "maximize") {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const w = getCurrentWindow();
    if (action === "close") await w.close();
    else if (action === "minimize") await w.minimize();
    else await w.toggleMaximize();
  } catch {
    /* not in tauri */
  }
}

const SyncPip = () => (
  <span
    className="pip"
    style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--positive-visual)" }}
  />
);

export function CtxTitle({ icon, title, sub }: { icon: string; title: string; sub?: string }) {
  return (
    <div className="ctx-title">
      <span className="ico">
        <Icon name={icon} size={17} />
      </span>
      <div>
        <h1>{title}</h1>
        {sub ? <div className="sub">{sub}</div> : null}
      </div>
    </div>
  );
}

function DocCrumb() {
  const { stage } = useShell();
  const st = STAGES.find((x) => x.id === stage) ?? STAGES[0];
  return (
    <div className="doc" data-tauri-drag-region="">
      <span>制作</span>
      <Icon name="chevr" size={13} />
      <b>Helios — Ep.204</b>
      <span style={{ color: "var(--chrome-faint)" }}>·</span>
      <span>{st.name}</span>
    </div>
  );
}

function ThemeToggle() {
  const { theme, toggleTheme } = useShell();
  return (
    <button className="iconbtn" title="切换主题" onClick={toggleTheme}>
      <Icon name={theme === "dark" ? "sun" : "moon"} size={17} />
    </button>
  );
}

function StageSwitch() {
  const { stage, setStage } = useShell();
  return (
    <Selector variant="stage" kpre="当前舞台" value={stage} options={stageOptions()} onChange={setStage} />
  );
}

/* macOS 窗口内标题栏：红绿灯改用系统原生的（titleBarStyle: Overlay，见 tauri.conf.json），
   原生框架同时给回 macOS 标准圆角 + 投影；菜单在系统菜单栏顶端（见 src-tauri build_macos_menu）。
   左上留给原生红绿灯，故无左侧元素；doc 居中、right 靠右，互不打架。 */
export function MacTitleBar() {
  return (
    <div className="titlebar" data-tauri-drag-region="">
      <DocCrumb />
      <div className="right">
        <span className="conn">
          <SyncPip />
          同步 23.976
        </span>
        <span className="conn">8 节点 · 6 在线</span>
        <StageSwitch />
        <ThemeToggle />
      </div>
    </div>
  );
}

/* Windows 顶栏 —— 菜单在窗口最顶（row 1） */
export function WinTopBar() {
  return (
    <div className="win-topbar" data-tauri-drag-region="">
      <div className="wt-left" data-tauri-drag-region="">
        <div className="brand-mark" style={{ width: 18, height: 18, fontSize: 11, borderRadius: 5 }}>
          V
        </div>
        <span className="brand-name">Volo</span>
      </div>
      <div className="wt-menus" data-tauri-drag-region="">
        {APP_MENUS.map((m) => (
          <div key={m} className="menu-item">
            {m}
          </div>
        ))}
      </div>
      <div className="wt-right">
        <ThemeToggle />
        <div className="winctl">
          <button className="wc-min" title="最小化" onClick={() => winAction("minimize")}>
            <Icon name="wmin" size={16} />
          </button>
          <button className="wc-max" title="最大化" onClick={() => winAction("maximize")}>
            <Icon name="wmax" size={14} />
          </button>
          <button className="wc-close" title="关闭" onClick={() => winAction("close")}>
            <Icon name="x" size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}

/* Windows 副栏 —— 文档 + 状态 + Stage（row 2） */
export function WinSubBar() {
  return (
    <div className="win-subbar" data-tauri-drag-region="">
      <DocCrumb />
      <span className="conn">
        <SyncPip />
        同步 23.976
      </span>
      <span className="conn">8 节点 · 6 在线</span>
      <div style={{ marginLeft: "auto" }}>
        <StageSwitch />
      </div>
    </div>
  );
}