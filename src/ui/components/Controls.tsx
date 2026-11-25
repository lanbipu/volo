/* Volo 扩展层表单控件（volo.css）：Field、Input、Select、Switch、Check / Radio、Segmented、Meter，
   以及“显示”选项弹层。只收 props，不碰业务。 */
import { useEffect, useId, useRef, useState, type CSSProperties, type InputHTMLAttributes, type ReactNode } from "react";
import { cx } from "../cx";
import { Icon } from "../icons/Icon";
import { Button } from "./Button";

/* ------------------------------- Field ------------------------------- */

export interface FieldProps {
  label: ReactNode;
  /** 标签后的灰色补充（small）。 */
  aside?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  inline?: boolean;
  htmlFor?: string;
  children: ReactNode;
  style?: CSSProperties;
}

export function Field({ label, aside, hint, error, inline, htmlFor, children, style }: FieldProps) {
  const Label = htmlFor ? "label" : "span";
  return (
    <div className={cx("volo-field", inline && "volo-field--inline")} style={style}>
      <Label className="volo-field__label" htmlFor={htmlFor}>
        {label}
        {aside && <small>{aside}</small>}
      </Label>
      {children}
      {error ? (
        <p className="volo-field__error">
          <Icon name="failed" />
          <span>{error}</span>
        </p>
      ) : (
        hint && <p className="volo-field__hint">{hint}</p>
      )}
    </div>
  );
}

export function Fields({ row, children, style }: { row?: boolean; children: ReactNode; style?: CSSProperties }) {
  return <div className={cx("volo-fields", row && "volo-fields--row")} style={style}>{children}</div>;
}

export const FieldsTitle = ({ children }: { children: ReactNode }) => <p className="volo-fields__title">{children}</p>;

/* ------------------------------- Input ------------------------------- */

export interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value"> {
  value: string;
  onChange: (v: string) => void;
  unit?: ReactNode;
  num?: boolean;
  mono?: boolean;
  invalid?: boolean;
  boxStyle?: CSSProperties;
}

export function TextInput({ value, onChange, unit, num, mono, invalid, disabled, boxStyle, ...rest }: TextInputProps) {
  return (
    <div className={cx("volo-input", num && "volo-input--num", mono && "volo-input--mono", invalid && "volo-input--invalid", disabled && "volo-input--disabled")} style={boxStyle}>
      <input type="text" value={value} disabled={disabled} aria-invalid={invalid || undefined} onChange={(e) => onChange(e.target.value)} {...rest} />
      {unit != null && <span className="volo-input__unit">{unit}</span>}
    </div>
  );
}

export function TextArea({ value, onChange, id, rows = 3, placeholder }: { value: string; onChange: (v: string) => void; id?: string; rows?: number; placeholder?: string }) {
  return (
    <div className="volo-input volo-input--area">
      <textarea id={id} rows={rows} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

export interface SelectOption<V extends string> {
  value: V;
  label: string;
  disabled?: boolean;
}

export function Select<V extends string>({ value, options, onChange, disabled, labelledBy, placeholder = "选择…", mono }: { value: V | null; options: SelectOption<V>[]; onChange: (v: V) => void; disabled?: boolean; labelledBy?: string; placeholder?: string; mono?: boolean }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
  const cur = options.find((o) => o.value === value);
  return (
    <div ref={wrap} style={{ position: "relative" }}>
      <button
        type="button"
        className={cx("volo-input", "volo-input--select", mono && "volo-input--mono")}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={labelledBy}
        disabled={disabled}
        style={{ width: "100%" }}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={cx("volo-input__value", !cur && "volo-input__value--placeholder")}>{cur ? cur.label : placeholder}</span>
        <Icon name="chevron-down" size="sm" />
      </button>
      {open && (
        <div className="ry-menu" role="listbox" style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, maxWidth: "none", minWidth: 0 }}>
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              className="ry-menu__item"
              role="option"
              aria-selected={o.value === value}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              <span>{o.label}</span>
              {o.value === value && <Icon name="check" size="sm" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------- Switch / Check ------------------------------- */

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return <button type="button" className="volo-switch" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)} />;
}

/** 文字 + 说明 + 右侧开关的一行。 */
export function SwitchRow({ title, desc, checked, onChange, disabled }: { title: ReactNode; desc?: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="volo-switchrow">
      <span>
        {title}
        {desc && <small>{desc}</small>}
      </span>
      <Switch checked={checked} onChange={onChange} disabled={disabled} />
    </label>
  );
}

export function Check({ checked, onChange, children, disabled, radio, name, top }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; disabled?: boolean; radio?: boolean; name?: string; top?: boolean }) {
  return (
    <label className={cx("volo-check", radio && "volo-check--radio")} style={top ? { alignItems: "flex-start" } : undefined}>
      <input type={radio ? "radio" : "checkbox"} name={name} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="volo-check__box">{!radio && <Icon name="check" />}</span>
      <span>{children}</span>
    </label>
  );
}

/* ------------------------------- Segmented ------------------------------- */

export function Seg<V extends string>({ label, options, value, onChange, block, disabled }: { label: string; options: SelectOption<V>[]; value: V; onChange: (v: V) => void; block?: boolean; disabled?: boolean }) {
  return (
    <div className={cx("volo-seg", block && "volo-seg--block")} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" className="volo-seg__opt" role="radio" aria-checked={o.value === value} disabled={disabled || o.disabled} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------- Meter ------------------------------- */

export interface MeterProps {
  label: ReactNode;
  value: number;
  max: number;
  text?: ReactNode;
  extra?: ReactNode;
  tone?: "default" | "running" | "success" | "failed" | "attention";
  inline?: boolean;
  /** progress = 进行中的测量；meter = 静态用量。 */
  role?: "meter" | "progressbar";
}

export function Meter({ label, value, max, text, extra, tone = "default", inline, role = "meter" }: MeterProps) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div
      className={cx("volo-meter", tone !== "default" && `volo-meter--${tone}`, inline && "volo-meter--inline")}
      role={role}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-label={typeof label === "string" ? label : undefined}
    >
      {inline ? (
        <>
          <div className="volo-meter__track">
            <span className="volo-meter__bar" style={{ width: `${pct}%` }} />
          </div>
          {text != null && <span className="volo-meter__value">{text}</span>}
        </>
      ) : (
        <>
          <div className="volo-meter__head">
            <b>{label}</b>
            {extra}
            {text != null && <span className="volo-meter__value">{text}</span>}
          </div>
          <div className="volo-meter__track">
            <span className="volo-meter__bar" style={{ width: `${pct}%` }} />
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------- 显示选项 ------------------------------- */

export interface DisplayRow {
  label: string;
  control: ReactNode;
}

/** 视图栏的“显示”按钮 + 弹层（分组 / 排序 / 列 …）。弹层内容由页面给。 */
export function DisplayMenu({ rows, onReset }: { rows: DisplayRow[]; onReset?: () => void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
  return (
    <span ref={wrap} style={{ position: "relative", display: "inline-flex" }}>
      <Button variant="ghost" icon="sliders" aria-haspopup="dialog" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        显示
      </Button>
      {open && (
        <div className="volo-display" role="dialog" aria-label="显示选项" id={id}>
          {rows.map((r) => (
            <div className="volo-display__row" key={r.label}>
              <span className="volo-display__label">{r.label}</span>
              {r.control}
            </div>
          ))}
          <div className="volo-display__sep" />
          <div className="volo-display__foot">
            <span>每一页各自记住显示方式</span>
            {onReset && (
              <Button variant="ghost" className="ry-btn--sm" onClick={onReset}>
                恢复默认
              </Button>
            )}
          </div>
        </div>
      )}
    </span>
  );
}

/** 显示弹层里“列”那一行的开关 Chip 组。 */
export function DisplayChips<K extends string>({ label, options, value, onToggle }: { label: string; options: SelectOption<K>[]; value: Record<K, boolean>; onToggle: (k: K) => void }) {
  return (
    <div className="volo-display__chips" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" className="ry-chip" aria-pressed={value[o.value]} onClick={() => onToggle(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
