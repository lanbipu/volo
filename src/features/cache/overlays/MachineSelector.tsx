// Volo · Cache —— 统一机器选择器 + 逐机结果预测（preview 浮层「影响范围」用），移植自 page_cache.jsx。
// 适配真实 Machine（status: online/offline/unknown；role: host/render/dev/editor/unknown）。
import { useState } from "react";
import { Icon } from "../ui/Icon";
import { Dot, type Visual } from "../ui/status";
import { useMachines } from "../state/data";
import type { Machine, MachineRole } from "../api/types";

const ROLE_LABEL: Record<MachineRole, string> = {
  host: "宿主",
  render: "渲染",
  dev: "开发",
  editor: "编辑器",
  unknown: "未知",
};

export interface PredictRow {
  n: Machine;
  icon: string;
  vis: Visual;
  msg: string;
  skip?: boolean;
}

/** 对一组机器在某操作下的逐机预测（dry-run 影响范围）。 */
export function predict(machines: Machine[], ids: number[], destructive?: boolean): PredictRow[] {
  return ids
    .map((id) => machines.find((m) => m.id === id))
    .filter((m): m is Machine => !!m)
    .map((n) => {
      if (n.status === "offline")
        return { n, icon: "minus", vis: "neutral" as Visual, msg: "离线 · 跳过", skip: true };
      if (n.status === "unknown")
        return {
          n,
          icon: "alert",
          vis: "notice" as Visual,
          msg: destructive ? "状态未知 · 谨慎" : "状态未知 · 将尝试应用",
        };
      return { n, icon: "check", vis: "positive" as Visual, msg: "就绪 · 可应用" };
    });
}

export function MachineSelector({
  value,
  onChange,
}: {
  value: number[];
  onChange: (ids: number[]) => void;
}) {
  const { machines } = useMachines();
  const roleKeys = Array.from(new Set(machines.map((m) => m.role))) as MachineRole[];
  const [roleF, setRoleF] = useState<MachineRole | null>(null);
  const pool = machines.filter((n) => !roleF || n.role === roleF);
  const toggle = (id: number) =>
    onChange(value.includes(id) ? value.filter((x) => x !== id) : value.concat(id));
  const allOn = pool.length > 0 && pool.every((n) => n.id != null && value.includes(n.id));
  const toggleAll = () =>
    onChange(
      allOn
        ? value.filter((id) => !pool.some((n) => n.id === id))
        : Array.from(new Set(value.concat(pool.map((n) => n.id!).filter((x) => x != null)))),
    );

  return (
    <div className="mach-sel">
      <div className="mach-sel-bar">
        <span className={"mfilter" + (!roleF ? " on" : "")} onClick={() => setRoleF(null)}>
          全部
        </span>
        {roleKeys.map((rk) => (
          <span
            key={rk}
            className={"mfilter" + (roleF === rk ? " on" : "")}
            onClick={() => setRoleF(roleF === rk ? null : rk)}
          >
            {ROLE_LABEL[rk]}
          </span>
        ))}
        <span className="mfilter ghost" onClick={toggleAll} style={{ marginLeft: "auto" }}>
          {allOn ? "取消全选" : "全选"}
        </span>
      </div>
      <div className="mach-sel-list">
        {pool.map((n) => (
          <div
            key={n.id}
            className={
              "mach-opt" +
              (n.id != null && value.includes(n.id) ? " on" : "") +
              (n.status === "offline" ? " off" : "")
            }
            onClick={() => n.id != null && toggle(n.id)}
          >
            <span className="mck">
              {n.id != null && value.includes(n.id) ? <Icon name="check" size={12} /> : null}
            </span>
            <Dot visual={n.status === "online" ? "positive" : n.status === "offline" ? "neutral" : "notice"} />
            <span className="mh">{n.hostname}</span>
            <span className="mip">{n.ip}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
