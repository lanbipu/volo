// Volo · Calibrate —— Badge 小徽章（替代设计稿的 RS2 Badge）。样式见 styles/calibrate.css。
import type { ReactNode } from "react";

export type BadgeVariant = "positive" | "notice" | "negative" | "neutral" | "accent";

export function Badge({
  variant = "neutral",
  size = "S",
  children,
}: {
  variant?: BadgeVariant;
  size?: "S" | "M";
  children: ReactNode;
}) {
  return (
    <span className={`cal-badge cal-badge--${variant} cal-badge--${size.toLowerCase()}`}>
      {children}
    </span>
  );
}
