// Volo · Calibrate —— Stat 指标行（k/v + vmeter 进度条）。移植自设计稿 shell.jsx 的 Stat。
import type { Visual } from "../state/types";

export function Stat({
  k,
  v,
  pct,
  variant = "informative",
}: {
  k: string;
  v: string;
  pct: number;
  variant?: Visual;
}) {
  return (
    <div className="statrow">
      <div className="top">
        <span className="k">{k}</span>
        <span className="v">{v}</span>
      </div>
      <div className={"vmeter vmeter--" + variant}>
        <div className="vmeter__fill" style={{ width: pct + "%" }} />
      </div>
    </div>
  );
}
