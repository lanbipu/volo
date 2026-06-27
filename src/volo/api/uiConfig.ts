/* Volo — Cache/UECM presentation config (NOT backend data).
   These are the status-three-channel maps (color + icon + text) and the static
   left-nav definitions. They were lifted out of data.tsx because they have no
   backend equivalent — they are design config, not mock payloads. Published on
   `window` (side-effect) so the custom-CSS Cache page reads them as bare globals,
   exactly as before. */

/* status meta (color + icon + text) — shared by machines / health / tasks */
export const NODE_STATUS = {
  healthy:  { label: "健康", variant: "positive", visual: "positive", icon: "check" },
  warning:  { label: "警告", variant: "notice",   visual: "notice",   icon: "alert" },
  critical: { label: "严重", variant: "negative", visual: "negative", icon: "alert" },
  offline:  { label: "离线", variant: "neutral",  visual: "neutral",  icon: "power" },
  na:       { label: "不适用", variant: "neutral", visual: "neutral", icon: "minus" },
};

/* remote channel — WinRM (pull 默认) vs 提权 SSH (UAC 过滤的操作) */
export const CHANNEL = {
  winrm: { label: "WinRM", short: "WinRM", icon: "net",    note: "pull 默认通道" },
  ssh:   { label: "提权 SSH", short: "SSH", icon: "shield", note: "UAC 过滤操作走此" },
};

/* roles for the unified machine selector */
export const ROLES = {
  shared:      { label: "共享上游", tag: "shared_upstream" },
  render:      { label: "渲染节点", tag: "render" },
  workstation: { label: "工作站",   tag: "workstation" },
  spare:       { label: "备用",     tag: "spare" },
};

/* 左导航（概览与机器管理已合并为「集群总览」） */
export const CACHE_MODULES = [
  { id: "home", label: "集群总览", sub: "Cluster", icon: "grid" },
  { id: "ddc",  label: "DDC 管理", sub: "DDC",     icon: "cache" },
];

/* DDC 管理·折叠子菜单（父项仅折叠，不导航） */
export const DDC_NAV = [
  { id: "ddc_zen",    label: "ZenServer",    icon: "cube" },
  { id: "ddc_legacy", label: "文件系统 DDC", icon: "server" },
  { id: "ddc_pak",    label: "DDC PAK",      icon: "cache" },
  { id: "ddc_pso",    label: "PSO 缓存",     icon: "layers" },
];

/* DDC 三种后端策略 — presentation config (the page only reads id/icon/label/
   current). `current` is a static UI default flag, NOT backend state
   (TODO: derive 已部署 from zen_status / list_shares when those views wire). */
export const DDC_BACKENDS = [
  { id: "zen",   icon: "cube",   label: "ZenServer 共享 DDC", current: true },
  { id: "smb",   icon: "folder", label: "共享 DDC（SMB）",     current: false },
  { id: "local", icon: "server", label: "本地 DDC",            current: false },
];

Object.assign(window, { NODE_STATUS, CHANNEL, ROLES, CACHE_MODULES, DDC_NAV, DDC_BACKENDS });
