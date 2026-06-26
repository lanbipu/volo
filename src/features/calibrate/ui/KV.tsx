// Volo · Calibrate —— 键值行（k / v，可选 mono）。Inspector 与 CabinetInspector 共用。
import type { ReactNode } from "react";

export function KV({ k, v, mono }: { k: string; v: ReactNode; mono?: boolean }) {
  return (
    <div className="kv">
      <span className="k">{k}</span>
      <span className={"v" + (mono ? " mono" : "")}>{v}</span>
    </div>
  );
}
