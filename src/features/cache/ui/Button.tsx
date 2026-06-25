// Volo · 自定义按钮 —— 1:1 复刻原型 Spectrum-2 风格按钮（pill 形 · accent=Volo 橙），不依赖 RS2。
// 保持原型调用形态：<Button variant size icon onPress isDisabled>label</Button>。
import type { ReactNode } from "react";

export interface CacheButtonProps {
  variant?: "primary" | "secondary" | "accent" | "negative";
  size?: "S" | "M" | "L" | "XL";
  icon?: ReactNode;
  onPress?: () => void;
  isDisabled?: boolean;
  children?: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "M",
  icon,
  onPress,
  isDisabled,
  children,
}: CacheButtonProps) {
  return (
    <button
      type="button"
      className={`s2btn s2btn--${variant} s2btn--${size}`}
      disabled={isDisabled}
      onClick={() => {
        if (!isDisabled) onPress?.();
      }}
    >
      {icon}
      {children}
    </button>
  );
}
