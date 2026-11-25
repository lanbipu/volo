/* Toolbar（Location Bar / View Bar）、面包屑、Chip、Search、Tabs。 */
import { Fragment, forwardRef, type ReactNode, type InputHTMLAttributes } from "react";
import { cx } from "../cx";
import { Icon, type IconName } from "../icons/Icon";
import { Kbd } from "./Button";

export function Toolbar({ loc, label, children, className }: { loc?: boolean; label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cx("ry-toolbar", loc && "ry-toolbar--loc", className)} role="toolbar" aria-label={label}>
      {children}
    </div>
  );
}

export const Spacer = () => <span className="ry-toolbar__spacer" />;
export const Sep = () => <span className="ry-toolbar__sep" />;
export const Meta = ({ children, className }: { children: ReactNode; className?: string }) => (
  <span className={className ? `ry-meta ${className}` : "ry-meta"}>{children}</span>
);

export function Group({ label, fixed, children, className }: { label?: string; fixed?: boolean; children: ReactNode; className?: string }) {
  return (
    <div className={cx("ry-toolbar__group", fixed && "ry-toolbar__group--fixed", className)} role={label ? "group" : undefined} aria-label={label}>
      {children}
    </div>
  );
}

export interface Crumb {
  label: string;
  onClick?: () => void;
}

/** 面包屑：图标 + 若干可点上级 + 当前。 */
export function Crumbs({ icon, trail = [], current }: { icon: IconName; trail?: Crumb[]; current: ReactNode }) {
  return (
    <div className="ry-crumbs">
      <Icon name={icon} />
      {trail.map((c) => (
        <Fragment key={c.label}>
          <button type="button" className="ry-crumbs__link" onClick={c.onClick}>
            {c.label}
          </button>
          <Icon name="chevron-right" size="sm" />
        </Fragment>
      ))}
      <span className="ry-crumbs__current">{current}</span>
    </div>
  );
}

export function Chip({ pressed, count, onClick, children, disabled }: { pressed?: boolean; count?: number | string; onClick?: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <button type="button" className="ry-chip" aria-pressed={pressed ?? false} onClick={onClick} disabled={disabled}>
      {children}
      {count != null && <span className="ry-chip__count">{count}</span>}
    </button>
  );
}

export interface ChipOption<K extends string> {
  key: K;
  label: string;
  count?: number;
}

/** 一组互斥筛选 Chip（视图栏左侧）。 */
export function ChipFilter<K extends string>({ label, options, value, onChange }: { label: string; options: ChipOption<K>[]; value: K; onChange: (k: K) => void }) {
  return (
    <Group label={label} fixed>
      {options.map((o) => (
        <Chip key={o.key} pressed={o.key === value} count={o.count} onClick={() => onChange(o.key)}>
          {o.label}
        </Chip>
      ))}
    </Group>
  );
}

export interface SearchProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value"> {
  value: string;
  onChange: (v: string) => void;
  shortcut?: string;
  width?: number;
}

export const Search = forwardRef<HTMLInputElement, SearchProps>(function Search(
  { value, onChange, shortcut = "/", placeholder = "筛选…", width, ...rest },
  ref,
) {
  return (
    <label className="ry-search" style={width ? { width } : undefined}>
      <Icon name="search" />
      <input ref={ref} type="text" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} {...rest} />
      {shortcut && !value && <Kbd>{shortcut}</Kbd>}
    </label>
  );
});

export interface TabDef<K extends string> {
  key: K;
  label: ReactNode;
  /** 红色计数（未通过 / 失败项）。 */
  count?: number;
  countSr?: string;
  disabled?: boolean;
}

/** 工具页签（胶囊）：Inspector 内容切换、详情页内容切换。 */
export function ToolTabs<K extends string>({ label, tabs, value, onChange }: { label: string; tabs: TabDef<K>[]; value: K; onChange: (k: K) => void }) {
  return (
    <span className="ry-tabs ry-tabs--tool" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button key={t.key} type="button" className="ry-tab" role="tab" aria-selected={t.key === value} disabled={t.disabled} onClick={() => onChange(t.key)}>
          {t.label}
          {t.count ? (
            <span className="ry-tab__count">
              {t.count}
              {t.countSr && <span className="ry-sr"> {t.countSr}</span>}
            </span>
          ) : null}
        </button>
      ))}
    </span>
  );
}
