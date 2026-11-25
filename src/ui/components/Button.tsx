/* Button / IconButton / Kbd —— 对应 runyard.css 的 ry-btn / ry-iconbtn / ry-kbd。 */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cx } from "../cx";
import { Icon, type IconName } from "../icons/Icon";

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="ry-kbd">{children}</kbd>;
}

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  variant?: "default" | "primary" | "ghost" | "danger";
  icon?: IconName;
  /** 图标转圈（进行中）。 */
  busy?: boolean;
  kbd?: ReactNode;
  type?: "button" | "submit";
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "default", icon, busy, kbd, className, children, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx("ry-btn", variant !== "default" && `ry-btn--${variant}`, className)}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? <Icon name="spinner" spin /> : icon && <Icon name={icon} />}
      {children != null && <span>{children}</span>}
      {kbd != null && <Kbd>{kbd}</Kbd>}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type" | "aria-label"> {
  icon: IconName;
  label: string;
  size?: "md" | "sm";
  fill?: boolean;
  pressed?: boolean;
  iconSize?: "md" | "sm";
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, size = "md", fill, pressed, iconSize, className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={cx("ry-iconbtn", size === "sm" && "ry-iconbtn--sm", fill && "ry-iconbtn--fill", className)}
      aria-label={label}
      data-tip={label}
      aria-pressed={pressed}
      {...rest}
    >
      <Icon name={icon} size={iconSize ?? (size === "sm" ? "sm" : "md")} />
    </button>
  );
});
