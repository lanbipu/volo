import { IconButton } from "../components/Button";

export function InspectorToggle({ open, onChange }: { open: boolean; onChange: (open: boolean) => void }) {
  return <IconButton icon="inspector" label={open ? "关闭 Inspector" : "打开 Inspector"} pressed={open} onClick={() => onChange(!open)} />;
}
