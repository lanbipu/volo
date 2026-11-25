/* Data Row 表格：ry-table / ry-row / ry-group。列宽由 --cols（grid-template-columns）给出，每张表自己定。 */
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { cx } from "../cx";
import { Status, type StatusKind } from "./Status";

type ColsStyle = CSSProperties & { "--cols"?: string };

export function Table({ label, children, className, style }: { label: string; children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <div className={cx("ry-table", className)} role="grid" aria-label={label} style={style}>
      {children}
    </div>
  );
}

export function TableBody({ children, inbox, className, style }: { children: ReactNode; inbox?: boolean; className?: string; style?: CSSProperties }) {
  return <div className={cx("ry-table__body", inbox && "ry-table__body--inbox", className)} style={style}>{children}</div>;
}

export function HeadRow({ cols, children }: { cols: string; children: ReactNode }) {
  const style: ColsStyle = { "--cols": cols };
  return (
    <div className="ry-row ry-row--head" role="row" style={style}>
      {children}
    </div>
  );
}

export interface RowProps {
  cols?: string;
  selected?: boolean;
  disabled?: boolean;
  unread?: boolean;
  inbox?: boolean;
  onSelect?: () => void;
  onOpen?: () => void;
  children: ReactNode;
  className?: string;
}

/** 可选中的数据行：单击选中，双击 / ↵ 打开。 */
export function Row({ cols, selected, disabled, unread, inbox, onSelect, onOpen, children, className }: RowProps) {
  const style: ColsStyle | undefined = cols ? { "--cols": cols } : undefined;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" && onOpen) {
      e.preventDefault();
      onOpen();
    } else if (e.key === " " && onSelect) {
      e.preventDefault();
      onSelect();
    }
  };
  return (
    <div
      className={cx("ry-row", inbox && "ry-row--inbox", unread && "ry-row--unread", className)}
      role="row"
      aria-selected={selected ?? false}
      aria-disabled={disabled || undefined}
      tabIndex={onSelect ? 0 : undefined}
      style={style}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onKeyDown={onSelect || onOpen ? onKey : undefined}
    >
      {children}
    </div>
  );
}

/** 分组行（sticky）：状态 + 计数。 */
export function GroupRow({ kind, label, count }: { kind?: StatusKind; label: ReactNode; count?: number }) {
  return (
    <div className="ry-group" role="row">
      {kind ? <Status kind={kind} label={String(label)} /> : <span>{label}</span>}
      {count != null && <span className="ry-group__count">{count}</span>}
    </div>
  );
}

export function Tag({ children, flexNone = true }: { children: ReactNode; flexNone?: boolean }) {
  return (
    <span className="ry-tag" style={flexNone ? { flex: "none" } : undefined}>
      {children}
    </span>
  );
}

/** 行标题单元：主文字 + 可选标签。 */
export function RowTitle({ children, tags }: { children: ReactNode; tags?: ReactNode }) {
  return (
    <span className="ry-row__title">
      <span>{children}</span>
      {tags}
    </span>
  );
}

/** 收件箱样式的两行单元（标题 + 副标题）。 */
export function RowTwo({ title, sub, unread }: { title: ReactNode; sub?: ReactNode; unread?: boolean }) {
  return (
    <span role="gridcell" className="ry-row__two">
      <span className="ry-row__title">
        {unread && (
          <>
            <i className="ry-row__unread" aria-hidden="true" />
            <span className="ry-sr">未读 </span>
          </>
        )}
        <span>{title}</span>
      </span>
      {sub && <span className="ry-row__sub">{sub}</span>}
    </span>
  );
}

export function RowEnd({ children }: { children: ReactNode }) {
  return <span className="ry-row__end">{children}</span>;
}

/** 骨架条。circle=true 为 14px 圆点（状态图标位）；end=true 靠右（数字列）。 */
export function Skel({ width, circle, end }: { width?: number | string; circle?: boolean; end?: boolean }) {
  const style: CSSProperties = circle ? { width: 14, height: 14, borderRadius: "50%" } : { width, marginLeft: end ? "auto" : undefined };
  return <i className="ry-skel" style={style} />;
}
