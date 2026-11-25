/* 反馈块：空状态、失败横幅、后台刷新细进度条、说明块（volo-note）。 */
import { isValidElement, type CSSProperties, type ReactNode } from "react";
import { cx } from "../cx";
import { Icon, type IconName } from "../icons/Icon";

export function Empty({ icon, title, children, actions }: { icon: IconName; title: ReactNode; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="ry-empty">
      <Icon name={icon} />
      <b>{title}</b>
      {children && <p>{children}</p>}
      {actions && <div style={{ display: "flex", gap: 8 }}>{actions}</div>}
    </div>
  );
}

export function Banner({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="ry-banner" role="alert">
      <Icon name="failed" />
      <span>{children}</span>
      {actions}
    </div>
  );
}

/** 2px 不定进度条：后台刷新中。 */
export function Progress({ on }: { on: boolean }) {
  return <div className={cx("ry-progress", on && "is-on")} role="progressbar" aria-busy={on} aria-label="正在刷新" />;
}

export interface NoteProps {
  kind?: "default" | "failed" | "attention";
  icon?: IconName;
  children: ReactNode;
  actions?: ReactNode;
  style?: CSSProperties;
}

const NOTE_ICON: Record<NonNullable<NoteProps["kind"]>, IconName> = { default: "clock", failed: "failed", attention: "attention" };

export function Note({ kind = "default", icon, children, actions, style }: NoteProps) {
  return (
    <div className={cx("volo-note", kind !== "default" && `volo-note--${kind}`)} style={style}>
      <Icon name={icon ?? NOTE_ICON[kind]} />
      <div>
        {isValidElement(children) ? children : <p>{children}</p>}
        {actions && <div className="volo-note__actions">{actions}</div>}
      </div>
    </div>
  );
}
