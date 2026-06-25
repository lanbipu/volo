// Volo · 占位骨架页（预演 / 校正 / 调色 / 现场）—— 外壳已就绪、内容待建设，1:1 移植自原型 page_skeletons.jsx。
import { Icon, type IconName } from "../../features/cache/ui/Icon";
import { Button } from "../../features/cache/ui/Button";
import { Selector, type SelectorOption } from "../../features/cache/ui/Selector";
import type { ReactNode } from "react";
import { CtxTitle } from "../chrome";
import type { Page } from "./types";

interface SkeletonNav {
  icon: IconName;
  label: string;
  ct?: number;
}
interface SkeletonAction {
  label: string;
  icon: IconName;
  variant?: "accent" | "secondary";
}
export interface SkeletonCfg {
  icon: IconName;
  title: string;
  sub: string;
  objKpre: string;
  objOpts: SelectorOption[];
  navTitle: string;
  nav: SkeletonNav[];
  actions: SkeletonAction[];
  canvasTitle: string;
  intent: string;
}

function InlineNote({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div
      style={{
        border: "1px solid var(--informative-visual)",
        borderRadius: 10,
        padding: "12px 14px",
        background: "color-mix(in srgb, var(--informative-visual) 8%, transparent)",
        color: "var(--chrome-text)",
        fontSize: 13,
        display: "flex",
        gap: 10,
        alignItems: "flex-start",
        textAlign: "left",
      }}
    >
      <span style={{ color: "var(--informative-visual)", flex: "0 0 auto", marginTop: 1 }}>
        <Icon name="eye" size={16} />
      </span>
      <div>
        <div style={{ fontWeight: 700, marginBottom: 3 }}>{title}</div>
        <div style={{ color: "var(--chrome-dim)" }}>{children}</div>
      </div>
    </div>
  );
}

export function makeSkeleton(cfg: SkeletonCfg): Page {
  const Ctx = () => (
    <>
      <CtxTitle icon={cfg.icon} title={cfg.title} sub={cfg.sub} />
      <div className="ctx-div" />
      <Selector kpre={cfg.objKpre} value="o1" width={196} options={cfg.objOpts} />
      <div className="ctx-actions">
        {cfg.actions.map((a, i) => (
          <Button
            key={i}
            variant={a.variant || "secondary"}
            size="S"
            isDisabled
            icon={<Icon name={a.icon} size={15} />}
          >
            {a.label}
          </Button>
        ))}
      </div>
    </>
  );

  const Left = () => (
    <>
      <div className="sect">
        <div className="sect-h">
          <span className="t">{cfg.navTitle}</span>
        </div>
        {cfg.nav.map((n, i) => (
          <div key={i} className={"nav-i" + (i === 0 ? " on" : "")} style={{ cursor: "default" }}>
            <span className="nav-ico">
              <Icon name={n.icon} size={16} />
            </span>
            <span>{n.label}</span>
            {n.ct != null ? <span className="ct">{n.ct}</span> : null}
          </div>
        ))}
      </div>
      <div className="sect" style={{ marginTop: "auto" }}>
        <div className="skl-note">
          <Icon name="tools" size={14} />
          面板已接入外壳 — 内容待建设
        </div>
      </div>
    </>
  );

  const Center = () => (
    <>
      <div className="canvas-head">
        <span className="t">{cfg.canvasTitle}</span>
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
            <Icon name={cfg.icon} size={40} stroke={1.3} />
          </div>
          <div className="skl-title">{cfg.title}</div>
          <div className="skl-intent">{cfg.intent}</div>
          <div style={{ marginTop: 18, maxWidth: 420 }}>
            <InlineNote title="外壳预览">
              通用外壳已就绪。{cfg.title} 工作区尚未建设。
            </InlineNote>
          </div>
        </div>
      </div>
    </>
  );

  const Inspector = () => (
    <div className="insp-empty">
      <div className="ph">
        <Icon name={cfg.icon} size={30} />
      </div>
      <div>
        <div style={{ color: "var(--chrome-dim)", fontWeight: 600, marginBottom: 4 }}>Inspector</div>
        选中对象的详情显示在此
      </div>
    </div>
  );

  return { Ctx, Left, Center, Inspector };
}

export const PREVIZ_CFG: SkeletonCfg = {
  icon: "previz",
  title: "预可视化",
  sub: "场景布局与机位走位",
  objKpre: "场景",
  objOpts: [
    { id: "o1", label: "Helios — 沙漠外景", sub: "v12" },
    { id: "o2", label: "Helios — 座舱", sub: "v04" },
  ],
  navTitle: "场景",
  nav: [
    { icon: "cube", label: "布景物件", ct: 18 },
    { icon: "camera", label: "机位", ct: 3 },
    { icon: "layers", label: "图层", ct: 6 },
    { icon: "previz", label: "故事板" },
  ],
  actions: [
    { label: "导入", icon: "download" },
    { label: "添加机位", icon: "camera" },
    { label: "播放", icon: "play", variant: "accent" },
  ],
  canvasTitle: "预演视口",
  intent: "在拍摄日前，于虚拟场景中走位机位与布景。",
};

export const CALIBRATE_CFG: SkeletonCfg = {
  icon: "calibrate",
  title: "Calibrate",
  sub: "LED 网格重建 → 镜头校正",
  objKpre: "屏",
  objOpts: [
    { id: "o1", label: "主屏 · 前墙", sub: "Volume A" },
    { id: "o2", label: "顶屏", sub: "Volume A" },
  ],
  navTitle: "工作流",
  nav: [
    { icon: "grid", label: "网格设计" },
    { icon: "tools", label: "重建方法" },
    { icon: "pin", label: "测量导入" },
    { icon: "cube", label: "网格预览" },
    { icon: "camera", label: "镜头校正" },
  ],
  actions: [
    { label: "重建", icon: "bolt" },
    { label: "导出", icon: "download" },
    { label: "指导卡", icon: "doc", variant: "accent" },
  ],
  canvasTitle: "网格编辑",
  intent: "先重建 LED 屏网格，几何就绪后直接校镜头。",
};

export const COLOR_CFG: SkeletonCfg = {
  icon: "color",
  title: "调色",
  sub: "屏幕 LUT 与一级",
  objKpre: "目标",
  objOpts: [
    { id: "o1", label: "Volume A 墙", sub: "P3-D65" },
    { id: "o2", label: "节目输出", sub: "Rec.709" },
  ],
  navTitle: "管线",
  nav: [
    { icon: "layers", label: "屏幕 LUT", ct: 4 },
    { icon: "color", label: "一级调色" },
    { icon: "wave", label: "示波器" },
    { icon: "panel", label: "校色卡" },
  ],
  actions: [
    { label: "新建 LUT", icon: "plus" },
    { label: "对比", icon: "eye" },
    { label: "应用", icon: "check", variant: "accent" },
  ],
  canvasTitle: "调色管线",
  intent: "将 LED 墙匹配到相机，并用 LUT 与示波器塑造现场一级。",
};

export const LIVE_CFG: SkeletonCfg = {
  icon: "live",
  title: "现场",
  sub: "现场回放与录制",
  objKpre: "信号源",
  objOpts: [
    { id: "o1", label: "节目 — 机位 A", sub: "23.976" },
    { id: "o2", label: "同步 — 全局", sub: "已锁定" },
  ],
  navTitle: "播控",
  nav: [
    { icon: "camera", label: "信号源", ct: 4 },
    { icon: "film", label: "镜头", ct: 42 },
    { icon: "live", label: "录制" },
    { icon: "net", label: "同步锁相" },
  ],
  actions: [
    { label: "预备", icon: "play" },
    { label: "待命", icon: "target" },
    { label: "录制", icon: "live", variant: "accent" },
  ],
  canvasTitle: "节目输出",
  intent: "驱动现场回放、待命镜头，并将视锥画面实时录制到磁盘。",
};
