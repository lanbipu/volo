/* Status Badge —— 状态三通道：色 + 图标 + 文字。
   运行态（running/success/failed/queued）来自 Runyard；资源态 attention（已过期 / 需注意）与 offline 来自 volo 扩展。 */
import { cx } from "../cx";
import { Icon, type IconName } from "../icons/Icon";

export type StatusKind = "running" | "success" | "failed" | "queued" | "attention" | "offline" | "clock";

const ICON: Record<StatusKind, IconName> = {
  running: "spinner",
  success: "success",
  failed: "failed",
  queued: "queued",
  attention: "attention",
  offline: "offline",
  clock: "clock",
};

const CLASS: Record<StatusKind, string | false> = {
  running: "ry-status--running",
  success: "ry-status--success",
  failed: "ry-status--failed",
  queued: false,
  attention: "volo-status--attention",
  offline: "volo-status--offline",
  clock: false,
};

export interface StatusProps {
  kind: StatusKind;
  /** 文字。srOnly 时只给读屏器。 */
  label: string;
  srOnly?: boolean;
  pill?: boolean;
  /** 图标尺寸；默认 pill / 有可见文字时用 sm，纯图标用 md。 */
  size?: "md" | "sm";
  className?: string;
}

export function Status({ kind, label, srOnly, pill, size, className }: StatusProps) {
  const iconSize = size ?? (srOnly ? "md" : "sm");
  return (
    <span className={cx("ry-status", CLASS[kind], pill && "ry-status--pill", className)}>
      <Icon name={ICON[kind]} size={iconSize} spin={kind === "running"} />
      <span className={srOnly ? "ry-sr" : undefined}>{label}</span>
    </span>
  );
}
