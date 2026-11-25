/* 浮层：Menu（ry-menu，fixed 定位贴着触发按钮）、Dialog（ry-scrim + ry-dialog）、Toast、Tooltip。
   Dialog / Toast 挂到外壳提供的 #volo-overlay（位于 ry-window 内，ry-scrim 的 absolute 以窗口为参照）。 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { cx } from "../cx";
import { Icon, type IconName } from "../icons/Icon";

export const OVERLAY_ID = "volo-overlay";

function overlayRoot(): HTMLElement {
  return document.getElementById(OVERLAY_ID) ?? document.body;
}

export function Portal({ children }: { children: ReactNode }) {
  return createPortal(children, overlayRoot());
}

/* ------------------------------- Menu ------------------------------- */

export interface MenuProps {
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  label: string;
  children: ReactNode;
  /** 菜单右缘对齐触发按钮右缘（默认左缘对齐）。 */
  alignEnd?: boolean;
  width?: number;
}

export function Menu({ anchor, onClose, label, children, alignEnd, width }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const a = anchor.current?.getBoundingClientRect();
    const m = ref.current?.getBoundingClientRect();
    if (!a || !m) return;
    const left = alignEnd ? a.right - m.width : a.left;
    const top = a.bottom + 4 + m.height > window.innerHeight ? a.top - 4 - m.height : a.bottom + 4;
    setPos({ top: Math.max(8, top), left: Math.max(8, Math.min(left, window.innerWidth - m.width - 8)) });
  }, [anchor, alignEnd]);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>(".ry-menu__item:not([aria-disabled='true'])")?.focus();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        anchor.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [anchor, onClose]);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>(".ry-menu__item:not([aria-disabled='true'])") ?? []);
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  return createPortal(
    <div
      ref={ref}
      className="ry ry-menu"
      role="menu"
      aria-label={label}
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width }}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>,
    overlayRoot(),
  );
}

export interface MenuItemProps {
  icon?: IconName;
  children: ReactNode;
  meta?: ReactNode;
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export function MenuItem({ icon, children, meta, checked, danger, disabled, onSelect }: MenuItemProps) {
  return (
    <button
      type="button"
      className={cx("ry-menu__item", danger && "ry-menu__item--danger")}
      role="menuitem"
      aria-disabled={disabled || undefined}
      onClick={() => !disabled && onSelect()}
    >
      {icon && <Icon name={icon} />}
      <span>{children}</span>
      {meta != null && <span className="ry-meta">{meta}</span>}
      {checked && <Icon name="check" size="sm" />}
    </button>
  );
}

export const MenuSep = ({ subtle }: { subtle?: boolean }) =>
  subtle ? <div role="separator" style={{ height: 1, margin: "6px 2px", background: "var(--border-subtle)" }} /> : <div className="ry-menu__sep" role="separator" />;

export const MenuLabel = ({ children }: { children: ReactNode }) => <div className="ry-menu__label">{children}</div>;


/* ------------------------------- Dialog ------------------------------- */

export interface DialogProps {
  title: ReactNode;
  onClose: () => void;
  children?: ReactNode;
  actions?: ReactNode;
  width?: number;
  role?: "dialog" | "alertdialog";
  /** 打开时聚焦的元素选择器（默认第一个 [data-autofocus]，否则第一个输入框）。 */
  initialFocus?: string;
}

export function Dialog({ title, onClose, children, actions, width, role = "dialog", initialFocus }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const root = ref.current;
    const target =
      root?.querySelector<HTMLElement>(initialFocus ?? "[data-autofocus]") ??
      root?.querySelector<HTMLElement>("input, select, textarea") ??
      root?.querySelector<HTMLElement>("button");
    target?.focus();
    return () => prev?.focus?.();
  }, [initialFocus]);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const f = Array.from(ref.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select, textarea, [tabindex='0']") ?? []);
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <Portal>
      <div className="ry-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div ref={ref} className="ry-dialog" role={role} aria-modal="true" aria-label={typeof title === "string" ? title : undefined} style={width ? { width } : undefined} onKeyDown={onKeyDown}>
          <h2 className="ry-dialog__title">{title}</h2>
          {children}
          {actions && <div className="ry-dialog__actions">{actions}</div>}
        </div>
      </div>
    </Portal>
  );
}

export function DialogBody({ children }: { children: ReactNode }) {
  return <p className="ry-dialog__body">{children}</p>;
}

/* ------------------------------- Toast ------------------------------- */

export function Toast({ children }: { children: ReactNode }) {
  return (
    <Portal>
      <div className="ry-toast" role="status">
        {children}
      </div>
    </Portal>
  );
}

/* ------------------------------- Tooltip ------------------------------- */

/** 全局 Tooltip：悬停 / 聚焦带 data-tip 的元素 500ms 后显示 ry-tooltip。外壳挂一次即可。 */
export function TooltipLayer() {
  const [tip, setTip] = useState<{ text: string; top: number; left: number } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const tipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const show = (el: HTMLElement) => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        const r = el.getBoundingClientRect();
        setTip({ text: el.dataset.tip ?? "", top: r.bottom + 6, left: r.left + r.width / 2 });
      }, 500);
    };
    const hide = () => {
      window.clearTimeout(timer.current);
      setTip(null);
    };
    const over = (e: Event) => {
      const el = (e.target as HTMLElement | null)?.closest?.<HTMLElement>("[data-tip]");
      if (el) show(el);
      else hide();
    };
    document.addEventListener("mouseover", over);
    document.addEventListener("focusin", over);
    document.addEventListener("mousedown", hide, true);
    document.addEventListener("keydown", hide, true);
    return () => {
      document.removeEventListener("mouseover", over);
      document.removeEventListener("focusin", over);
      document.removeEventListener("mousedown", hide, true);
      document.removeEventListener("keydown", hide, true);
      window.clearTimeout(timer.current);
    };
  }, []);

  useLayoutEffect(() => {
    const el = tipRef.current;
    if (!el || !tip) return;
    const w = el.offsetWidth;
    el.style.left = `${Math.max(8, Math.min(tip.left - w / 2, window.innerWidth - w - 8))}px`;
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <div ref={tipRef} className="ry ry-tooltip" role="tooltip" style={{ top: tip.top, left: tip.left }}>
      {tip.text}
    </div>,
    overlayRoot(),
  );
}
