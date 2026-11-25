/* 危险操作确认（设计：Confirm.dc.html）：标题问句 + 后果一段话 + 影响 / 通道 / 可恢复 + 等效命令 + 先试运行 / 保留 / 危险动作。 */
import type { CSSProperties, ReactNode } from "react";
import { copyText } from "@/lib/clipboard";
import type { IconName } from "../icons/Icon";
import { Button, IconButton } from "./Button";
import { Props, type PropItem } from "./Inspector";
import { Dialog, DialogBody } from "./Overlay";
import css from "./Confirm.module.css";

/** 一行等效命令 + 复制按钮（凹陷底）。 */
export function CommandLine({ command, style }: { command: string; style?: CSSProperties }) {
  return (
    <div className={css.cmd} style={style}>
      <span className="ry-mono">{command}</span>
      <IconButton size="sm" icon="copy" label="复制等效命令" onClick={() => copyText(command)} />
    </div>
  );
}

export interface ConfirmDialogProps {
  title: string;
  body: ReactNode;
  props?: PropItem[];
  command?: string;
  onDryRun?: () => void;
  safeLabel: string;
  dangerLabel: string;
  dangerIcon?: IconName;
  busy?: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

export function ConfirmDialog({ title, body, props, command, onDryRun, safeLabel, dangerLabel, dangerIcon, busy, onClose, onConfirm }: ConfirmDialogProps) {
  return (
    <Dialog
      title={title}
      role="alertdialog"
      width={460}
      onClose={onClose}
      initialFocus="[data-safe]"
      actions={
        <>
          {onDryRun && (
            <Button variant="ghost" className={css.push} onClick={onDryRun}>
              先试运行
            </Button>
          )}
          <Button data-safe kbd="Esc" onClick={onClose}>
            {safeLabel}
          </Button>
          <Button variant="danger" icon={dangerIcon} busy={busy} onClick={onConfirm}>
            {dangerLabel}
          </Button>
        </>
      }
    >
      <DialogBody>{body}</DialogBody>
      {props && props.length > 0 && <Props items={props} className={css.props} />}
      {command && <CommandLine command={command} />}
    </Dialog>
  );
}
