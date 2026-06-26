// Volo · Calibrate —— InlineAlert 行内提示（替代设计稿的 RS2 InlineAlert，仿 skeleton.tsx InlineNote）。
import type { ReactNode } from "react";
import { Icon } from "../../cache/ui/Icon";

export type AlertVariant = "informative" | "notice" | "positive" | "negative";

const ALERT_ICON: Record<AlertVariant, string> = {
  informative: "eye",
  notice: "alert",
  positive: "check",
  negative: "alert",
};

export function InlineAlert({
  variant = "informative",
  title,
  children,
}: {
  variant?: AlertVariant;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div
      style={{
        border: `1px solid var(--${variant}-visual)`,
        borderRadius: 10,
        padding: "12px 14px",
        background: `color-mix(in srgb, var(--${variant}-visual) 8%, transparent)`,
        color: "var(--chrome-text)",
        fontSize: 13,
        display: "flex",
        gap: 10,
        alignItems: "flex-start",
        textAlign: "left",
      }}
    >
      <span style={{ color: `var(--${variant}-visual)`, flex: "0 0 auto", marginTop: 1 }}>
        <Icon name={ALERT_ICON[variant]} size={16} />
      </span>
      <div>
        <div style={{ fontWeight: 700, marginBottom: 3 }}>{title}</div>
        {children != null ? <div style={{ color: "var(--chrome-dim)" }}>{children}</div> : null}
      </div>
    </div>
  );
}
