// Volo · Cache —— 通用下拉选择器（popover），从原型 shell.jsx 的 Selector 移植。
// 用在上下文条对象选择器、DDC 表单的机器 / 后端 / 分辨率等下拉。
//
// 下拉菜单通过 React portal 渲染到 document.body（position:fixed + 高 z-index），彻底跳出
// 标题栏 / body 的层叠上下文——否则在某些 WebView 里会被任务抽屉等已定位的同级内容盖住。
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";

export interface SelectorOption {
  id: string;
  label: string;
  sub?: string;
  pip?: string; // 状态点的 visual（stage 变体用）
}

export interface SelectorProps {
  kpre: string;
  value: string;
  options: SelectorOption[];
  onChange?: (id: string) => void;
  width?: number;
  variant?: "obj" | "stage";
}

export function Selector({
  kpre,
  value,
  options,
  onChange,
  width = 188,
  variant = "obj",
}: SelectorProps) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const ref = useRef<HTMLDivElement>(null); // 触发器外壳
  const popRef = useRef<HTMLDivElement>(null); // portal 出去的菜单

  // 打开时按触发器位置定位菜单（fixed 坐标）。
  useLayoutEffect(() => {
    if (open && ref.current) setRect(ref.current.getBoundingClientRect());
  }, [open]);

  // 点击触发器与菜单之外才关闭（菜单已 portal 出去，需单独判定，否则点选项会先被关掉）。
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const dismiss = () => setOpen(false);
    document.addEventListener("mousedown", h);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("mousedown", h);
      window.removeEventListener("resize", dismiss);
    };
  }, [open]);

  // 不静默回退到 options[0]：value 在选项里找不到时显示「请选择」占位，避免显示态与表单态脱节。
  const cur = options.find((o) => o.id === value) ?? null;
  const cls = variant === "stage" ? "stage-switch" : "obj-sel";

  // 必须 portal 进 .volo-cache（主题 CSS 变量的作用域根）——直接挂 document.body 会丢失
  // --chrome-* 变量导致背景 / 边框透明；.volo-cache 又是 .viewport(fixed) 的父级，z-index 同样能压住。
  const portalHost =
    (ref.current?.closest(".volo-cache") as HTMLElement | null) ?? document.body;

  const menu =
    open && rect
      ? createPortal(
          <div
            ref={popRef}
            className="popover"
            style={{
              position: "fixed",
              top: rect.bottom + 6,
              // 右对齐到触发器右缘
              right: Math.max(8, window.innerWidth - rect.right),
              left: "auto",
              zIndex: 1000,
            }}
          >
            {options.map((o) => (
              <div
                key={o.id}
                className={"pop-i" + (o.id === value ? " on" : "")}
                onClick={() => {
                  onChange?.(o.id);
                  setOpen(false);
                }}
              >
                {o.pip ? (
                  <span className="pop-pip" style={{ background: `var(--${o.pip}-visual)` }} />
                ) : null}
                <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.2 }}>
                  <span className="pop-l">{o.label}</span>
                  {o.sub ? <span className="pop-s">{o.sub}</span> : null}
                </div>
                {o.id === value ? (
                  <span style={{ marginLeft: "auto", color: "var(--volo-500)", display: "flex" }}>
                    <Icon name="check" size={15} />
                  </span>
                ) : null}
              </div>
            ))}
          </div>,
          portalHost,
        )
      : null;

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <div
        className={cls}
        style={variant === "obj" ? { minWidth: width } : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        {variant === "stage" && cur?.pip ? (
          <span
            className="pip"
            style={{ background: `var(--${cur.pip}-visual)`, boxShadow: "none" }}
          />
        ) : null}
        <div className={variant === "stage" ? "lbl" : "col"}>
          <span className="k">{kpre}</span>
          <span className="v">{cur?.label ?? "请选择"}</span>
        </div>
        <span className="chev" style={{ marginLeft: "auto", display: "flex" }}>
          <Icon name="chevd" size={15} />
        </span>
      </div>
      {menu}
    </div>
  );
}
