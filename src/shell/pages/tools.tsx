// Volo · 工具页 —— 顶部「缓存 / 诊断」两类目；缓存类目挂 UECM 控制台四区，诊断类目为占位骨架。
// 1:1 移植自原型 page_skeletons.jsx 的 tools 包装（top 模式）。
import { Icon, type IconName } from "../../features/cache/ui/Icon";
import { Button } from "../../features/cache/ui/Button";
import { useCache } from "../../features/cache/state/store";
import { LeftNav, TaskDrawer, CacheActions, CacheCenter, CacheOverlay } from "../../features/cache";
import { DIAG, isCacheNav } from "../../features/cache/state/nav";
import type { Page } from "./types";

const CATS: { id: "cache" | "diag"; label: string; icon: IconName }[] = [
  { id: "cache", label: "缓存", icon: "cache" },
  { id: "diag", label: "诊断", icon: "tools" },
];
const FIRST = { cache: "home", diag: "diag_net" } as const;
const catOf = (nav: string): "cache" | "diag" => (isCacheNav(nav) ? "cache" : "diag");
const curDiag = (nav: string) => DIAG.find((d) => d.id === nav) ?? DIAG[0];

function DiagActions() {
  return (
    <div className="ctx-actions">
      <Button variant="secondary" size="S" isDisabled icon={<Icon name="play" size={15} />}>
        运行
      </Button>
      <Button variant="accent" size="S" isDisabled icon={<Icon name="download" size={15} />}>
        导出
      </Button>
    </div>
  );
}

function ToolsCtx() {
  const { nav, setNav } = useCache();
  const cat = catOf(nav);
  return (
    <>
      <div className="ctxnav">
        {CATS.map((c) => (
          <div
            key={c.id}
            className={"ctxnav-i" + (cat === c.id ? " on" : "")}
            onClick={() => {
              if (catOf(nav) !== c.id) setNav(FIRST[c.id]);
            }}
          >
            <span className="ctxnav-ico">
              <Icon name={c.icon} size={16} />
            </span>
            <span>{c.label}</span>
          </div>
        ))}
      </div>
      {cat === "cache" ? <CacheActions /> : <DiagActions />}
    </>
  );
}

function DiagSection() {
  const { nav, setNav } = useCache();
  return (
    <div className="sect">
      <div className="sect-h">
        <span className="t">诊断工具</span>
      </div>
      {DIAG.map((d) => (
        <div
          key={d.id}
          className={"nav-i" + (nav === d.id ? " on" : "")}
          onClick={() => setNav(d.id)}
        >
          <span className="nav-ico">
            <Icon name={d.icon} size={16} />
          </span>
          <span>{d.label}</span>
          <span className="ct">WIP</span>
        </div>
      ))}
    </div>
  );
}

function ToolsLeft() {
  const { nav } = useCache();
  return catOf(nav) === "cache" ? <LeftNav /> : <DiagSection />;
}

function DiagCenter() {
  const { nav } = useCache();
  const t = curDiag(nav);
  return (
    <>
      <div className="canvas-head">
        <span className="t">{t.label}</span>
        <div className="right">
          <div className="seg">
            <button className="on">
              <Icon name="eye" size={14} />
            </button>
            <button>
              <Icon name="settings" size={14} />
            </button>
          </div>
        </div>
      </div>
      <div className="canvas-stage skl-stage">
        <div className="skl-grid" />
        <div className="skl-ph">
          <div className="skl-ico">
            <Icon name={t.icon} size={40} stroke={1.3} />
          </div>
          <div className="skl-title">{t.label}</div>
          <div className="skl-intent">{t.intent}</div>
          <div
            style={{
              marginTop: 18,
              maxWidth: 440,
              border: "1px solid var(--informative-visual)",
              borderRadius: 10,
              padding: "12px 14px",
              background: "color-mix(in srgb, var(--informative-visual) 8%, transparent)",
              fontSize: 13,
              textAlign: "left",
              color: "var(--chrome-dim)",
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 3, color: "var(--chrome-text)" }}>
              诊断工具
            </div>
            {t.label} 工作区尚未建设。渲染缓存集群管理（UECM）已并入本页「缓存」类别。
          </div>
        </div>
      </div>
    </>
  );
}

function ToolsCenter() {
  const { nav } = useCache();
  return isCacheNav(nav) ? <CacheCenter /> : <DiagCenter />;
}

function ToolsInspector() {
  const { nav } = useCache();
  if (isCacheNav(nav)) return <TaskDrawer />;
  const t = curDiag(nav);
  return (
    <div className="insp-empty">
      <div className="ph">
        <Icon name={t.icon} size={30} />
      </div>
      <div>
        <div style={{ color: "var(--chrome-dim)", fontWeight: 600, marginBottom: 4 }}>Inspector</div>
        选中对象的详情显示在此
      </div>
    </div>
  );
}

export const toolsPage: Page = {
  Ctx: ToolsCtx,
  Left: ToolsLeft,
  Center: ToolsCenter,
  Inspector: ToolsInspector,
  Overlay: CacheOverlay,
};
