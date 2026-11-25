/* Inspector：右侧详情面板。头部 = 工具页签 + 关闭 / 元信息 / 标题 / 操作；主体 = 属性表、活动、说明。 */
import type { CSSProperties, ReactNode } from "react";
import { Icon, type IconName } from "../icons/Icon";
import { IconButton } from "./Button";
import { Spacer } from "./Bars";

export function Inspector({ width, children, overlay }: { width: number; children: ReactNode; overlay?: boolean }) {
  return (
    <aside className="ry-inspector" aria-label="Inspector" style={{ width }} data-overlay={overlay || undefined}>
      {children}
    </aside>
  );
}

export interface InspectorHeadProps {
  tabs?: ReactNode;
  onClose?: () => void;
  meta?: ReactNode;
  title?: ReactNode;
  actions?: ReactNode;
}

export function InspectorHead({ tabs, onClose, meta, title, actions }: InspectorHeadProps) {
  return (
    <div className="ry-inspector__head">
      <div className="ry-toolbar" style={{ padding: 0, height: "auto" }}>
        {tabs}
        <Spacer />
        {onClose && <IconButton icon="close" label="关闭 Inspector" onClick={onClose} />}
      </div>
      {meta && <div className="ry-detail__meta">{meta}</div>}
      {title && <h2 className="ry-inspector__title">{title}</h2>}
      {actions && (
        <div className="ry-toolbar__group" style={{ gap: 8 }}>
          {actions}
        </div>
      )}
    </div>
  );
}

export function InspectorBody({ children }: { children: ReactNode }) {
  return <div className="ry-inspector__body">{children}</div>;
}

export interface PropItem {
  label: string;
  value: ReactNode;
  /** 值右侧悬停出现的小按钮（复制等）。 */
  action?: ReactNode;
}

/** 属性表（dl）。值为 null / undefined / "" 时显示「—」（画布约定：没有数据源的字段显示 —）。 */
export function Props({ items, style, className }: { items: PropItem[]; style?: CSSProperties; className?: string }) {
  return (
    <dl className={className ? `ry-props ${className}` : "ry-props"} style={style}>
      {items.map((it) => (
        <PropRow key={it.label} {...it} />
      ))}
    </dl>
  );
}

function PropRow({ label, value, action }: PropItem) {
  const empty = value == null || value === "";
  return (
    <>
      <dt>{label}</dt>
      <dd>
        {empty ? <span>—</span> : typeof value === "string" || typeof value === "number" ? <span>{value}</span> : value}
        {action}
      </dd>
    </>
  );
}

export interface ActivityItem {
  key: string;
  icon: IconName;
  iconColor?: string;
  text: ReactNode;
  time?: ReactNode;
}

export function Activity({ items, style }: { items: ActivityItem[]; style?: CSSProperties }) {
  return (
    <ol className="ry-activity" style={style}>
      {items.map((it) => (
        <li key={it.key}>
          <Icon name={it.icon} size="sm" style={it.iconColor ? { color: it.iconColor } : undefined} />
          <span>{it.text}</span>
          {it.time != null ? <time>{it.time}</time> : <span />}
        </li>
      ))}
    </ol>
  );
}
