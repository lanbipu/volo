/* ry-icon：16px 网格的描边图标。size="sm" 对应 ry-icon--sm（14px）。 */
import type { CSSProperties } from "react";
import { ICONS, type IconName } from "./paths";

export type { IconName };

export interface IconProps {
  name: IconName;
  size?: "md" | "sm";
  spin?: boolean;
  className?: string;
  style?: CSSProperties;
}

export function Icon({ name, size = "md", spin, className, style }: IconProps) {
  const cls = ["ry-icon", size === "sm" && "ry-icon--sm", spin && "ry-spin", className].filter(Boolean).join(" ");
  return (
    <svg className={cls} viewBox="0 0 16 16" aria-hidden="true" style={style}>
      {ICONS[name]}
    </svg>
  );
}

/** 侧栏分组标题的小三角（8×8，实心）。 */
export function Caret() {
  return (
    <svg viewBox="0 0 8 8" aria-hidden="true">
      <path d="M1 2.5h6L4 6.5z" />
    </svg>
  );
}
