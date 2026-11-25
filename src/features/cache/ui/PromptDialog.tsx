/* 单字段编辑对话框（改名、更换 UE 运行用户）。沿用 Dialog + volo-field 的样式。 */
import { useState } from "react";
import { Button, Dialog, DialogBody, Field, TextInput } from "@/ui";

export function PromptDialog({
  title,
  body,
  label,
  initial,
  mono,
  submitLabel,
  busy,
  allowEmpty,
  onClose,
  onSubmit,
}: {
  title: string;
  body?: string;
  label: string;
  initial: string;
  mono?: boolean;
  submitLabel: string;
  busy?: boolean;
  allowEmpty?: boolean;
  onClose: () => void;
  onSubmit: (v: string) => void;
}) {
  const [v, setV] = useState(initial);
  const ok = (allowEmpty || v.trim() !== "") && v.trim() !== initial;
  const submit = () => ok && !busy && onSubmit(v.trim());
  return (
    <Dialog
      title={title}
      width={440}
      onClose={onClose}
      actions={
        <>
          <Button kbd="Esc" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" busy={busy} disabled={!ok} onClick={submit}>
            {submitLabel}
          </Button>
        </>
      }
    >
      {body && <DialogBody>{body}</DialogBody>}
      <div className="volo-fields" style={{ marginTop: 16 }}>
        <Field label={label} htmlFor="prompt-input">
          <TextInput id="prompt-input" mono={mono} value={v} onChange={setV} onKeyDown={(e) => e.key === "Enter" && submit()} />
        </Field>
      </div>
    </Dialog>
  );
}
