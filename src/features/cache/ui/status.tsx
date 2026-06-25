// Volo · Cache —— 状态三通道（色 + 图标 + 文字）元数据 + 小组件。
// 区分两套状态：① 机器连通状态（Machine.status: online/offline/unknown，实测仅这三值）；
// ② 健康 / 严重度 tone（healthy|warning|critical|info|offline|unknown|na|progress），来自健康巡检 /
// INI findings / GPU 矩阵，对应 WIREFRAMES 的 tone 枚举（= 原型 SEV）。
import { Icon } from "./Icon";
import type { MachineStatus } from "../api/types";

export type Visual =
  | "positive"
  | "notice"
  | "negative"
  | "neutral"
  | "informative"
  | "accent";

export type Tone =
  | "healthy"
  | "warning"
  | "critical"
  | "info"
  | "offline"
  | "unknown"
  | "na"
  | "progress";

interface Meta {
  label: string;
  visual: Visual;
  icon: string;
}

/** 机器连通状态（list_machines 的真实枚举）。 */
export const MACHINE_STATUS_META: Record<MachineStatus, Meta> = {
  online: { label: "在线", visual: "positive", icon: "check" },
  offline: { label: "离线", visual: "neutral", icon: "power" },
  unknown: { label: "未知", visual: "notice", icon: "alert" },
};

/** 健康 / 严重度 tone。 */
export const TONE_META: Record<Tone, Meta> = {
  healthy: { label: "正常", visual: "positive", icon: "check" },
  warning: { label: "警告", visual: "notice", icon: "alert" },
  critical: { label: "严重", visual: "negative", icon: "alert" },
  info: { label: "提示", visual: "informative", icon: "eye" },
  offline: { label: "离线", visual: "neutral", icon: "power" },
  unknown: { label: "未知", visual: "neutral", icon: "minus" },
  na: { label: "不适用", visual: "neutral", icon: "minus" },
  progress: { label: "进行中", visual: "accent", icon: "sync" },
};

/** 远程通道（任务卡 / 日志用；§4：per-node channel 无数据源，全栈已统一 SSH key）。 */
export const CHANNEL = {
  winrm: { label: "WinRM", short: "WinRM", icon: "net", note: "pull 默认通道" },
  ssh: { label: "提权 SSH", short: "SSH", icon: "shield", note: "UAC 过滤操作走此" },
} as const;
export type ChannelKey = keyof typeof CHANNEL;

export const healthVisual = (v: number): Visual =>
  v >= 85 ? "positive" : v >= 60 ? "notice" : "negative";

/** 集群健康分公式（实测自 UECM HealthCheck.vue）。 */
export const clusterHealthScore = (
  healthy: number,
  critical: number,
  warning: number,
  total: number,
): number =>
  total <= 0
    ? 0
    : Math.max(0, Math.round(((healthy - critical * 0.75 - warning * 0.35) / total) * 100));

/* ---------- 小组件 ---------- */

export const Dot = ({ visual }: { visual: Visual }) => (
  <span className={"sdot bg-" + visual} />
);

export function StatusPill({ status }: { status: MachineStatus }) {
  const m = MACHINE_STATUS_META[status];
  return (
    <span className={"spill spill--" + m.visual}>
      <Icon name={m.icon} size={13} />
      {m.label}
    </span>
  );
}

export function TonePill({ tone }: { tone: Tone }) {
  const m = TONE_META[tone];
  return (
    <span className={"spill spill--" + m.visual}>
      {m.icon === "minus" ? (
        <span style={{ fontWeight: 700 }}>—</span>
      ) : (
        <Icon name={m.icon} size={12} />
      )}
      {m.label}
    </span>
  );
}

export function ChannelTag({ ch, mini }: { ch: ChannelKey; mini?: boolean }) {
  const c = CHANNEL[ch] || CHANNEL.ssh;
  return (
    <span className={"chan-tag chan-" + ch + (mini ? " mini" : "")} title={c.note}>
      <Icon name={c.icon} size={mini ? 11 : 12} />
      {c.label}
    </span>
  );
}
