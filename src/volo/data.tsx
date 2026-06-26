// @ts-nocheck
/* Volo — mock data + inline SVG icon set (shared on window).
   1:1 port of the Claude Design handoff `src/data.jsx`. Symbols are published
   on `window` (as in the prototype) so the other ported modules reach them as
   bare globals at render time. */
import * as React from "react";

/* ---------- Icons (single-color line, inherit currentColor) ---------- */
const ICON_PATHS = {
  previz:   '<path d="M3 5.5h14M3 10h14M3 14.5h9" /><circle cx="15.5" cy="14.5" r="1.6" fill="currentColor" stroke="none"/>',
  calibrate:'<rect x="3" y="3" width="14" height="14" rx="1.5"/><path d="M3 8h14M3 12h14M8 3v14M12 3v14"/><circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  color:    '<path d="M10 3a7 7 0 1 0 0 14c1 0 1.6-.8 1.6-1.6 0-.5-.3-.9-.3-1.4 0-.6.5-1 1.1-1H14a3 3 0 0 0 3-3c0-3.6-3.1-6-7-6Z"/><circle cx="6.6" cy="9" r=".9" fill="currentColor" stroke="none"/><circle cx="10" cy="6.4" r=".9" fill="currentColor" stroke="none"/><circle cx="13.2" cy="8.6" r=".9" fill="currentColor" stroke="none"/>',
  cache:    '<rect x="3" y="3.5" width="14" height="5" rx="1.2"/><rect x="3" y="11.5" width="14" height="5" rx="1.2"/><circle cx="6" cy="6" r=".9" fill="currentColor" stroke="none"/><circle cx="6" cy="14" r=".9" fill="currentColor" stroke="none"/>',
  live:     '<circle cx="10" cy="10" r="2.4"/><path d="M5.4 5.4a6.5 6.5 0 0 0 0 9.2M14.6 5.4a6.5 6.5 0 0 1 0 9.2M3 3a9.5 9.5 0 0 0 0 14M17 3a9.5 9.5 0 0 1 0 14"/>',
  tools:    '<path d="M12.5 3.2a3.3 3.3 0 0 0-1.3 5.2L4 15.6 5.4 17l7.2-7.2a3.3 3.3 0 0 0 4.2-4.3l-2 2-1.8-.4-.4-1.8 2-2a3.3 3.3 0 0 0-1.3-.3Z"/>',
  node:     '<rect x="3" y="3" width="14" height="6" rx="1.4"/><rect x="3" y="11" width="14" height="6" rx="1.4"/><circle cx="6" cy="6" r="1" fill="currentColor" stroke="none"/><circle cx="6" cy="14" r="1" fill="currentColor" stroke="none"/>',
  cube:     '<path d="M10 2.6 17 6.3v7.4L10 17.4 3 13.7V6.3Z"/><path d="M3 6.3 10 10l7-3.7M10 10v7.4"/>',
  camera:   '<rect x="2.5" y="5.5" width="15" height="10" rx="1.8"/><circle cx="10" cy="10.5" r="3"/><path d="M6.5 5.5 7.6 3.5h4.8l1.1 2"/>',
  cpu:      '<rect x="5.5" y="5.5" width="9" height="9" rx="1.4"/><rect x="8" y="8" width="4" height="4" rx=".6"/><path d="M8 2.5v2M12 2.5v2M8 15.5v2M12 15.5v2M2.5 8h2M2.5 12h2M15.5 8h2M15.5 12h2"/>',
  thermo:   '<path d="M8 11V4.5a2 2 0 1 1 4 0V11a3.4 3.4 0 1 1-4 0Z"/><circle cx="10" cy="13.6" r="1.4" fill="currentColor" stroke="none"/>',
  net:      '<path d="M2.5 7a10 10 0 0 1 15 0M5 9.6a6.5 6.5 0 0 1 10 0M7.6 12.2a3 3 0 0 1 4.8 0"/><circle cx="10" cy="15" r="1.1" fill="currentColor" stroke="none"/>',
  folder:   '<path d="M2.6 5.5A1.5 1.5 0 0 1 4 4h3.2l1.4 1.7H16A1.5 1.5 0 0 1 17.4 7v7.5A1.5 1.5 0 0 1 16 16H4a1.5 1.5 0 0 1-1.4-1.5Z"/>',
  play:     '<path d="M6 4.5 15 10l-9 5.5Z" fill="currentColor" stroke="none"/>',
  plus:     '<path d="M10 4v12M4 10h12"/>',
  sync:     '<path d="M15.5 6.5A6.5 6.5 0 0 0 4.2 8M4 4v3.5h3.5M4.5 13.5A6.5 6.5 0 0 0 15.8 12M16 16v-3.5h-3.5"/>',
  more:     '<circle cx="5" cy="10" r="1.4" fill="currentColor" stroke="none"/><circle cx="10" cy="10" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="10" r="1.4" fill="currentColor" stroke="none"/>',
  chevd:    '<path d="M5.5 8 10 12.5 14.5 8"/>',
  chevr:    '<path d="M8 5.5 12.5 10 8 14.5"/>',
  search:   '<circle cx="9" cy="9" r="5.2"/><path d="m13 13 4 4"/>',
  settings: '<circle cx="10" cy="10" r="2.6"/><path d="M10 2.5v2.2M10 15.3v2.2M3.4 6.2l1.9 1.1M14.7 12.7l1.9 1.1M16.6 6.2l-1.9 1.1M5.3 12.7l-1.9 1.1"/>',
  check:    '<path d="M4.5 10.5 8 14l7.5-8"/>',
  alert:    '<path d="M10 3.5 17.5 16.5h-15Z"/><path d="M10 8.5v3.5"/><circle cx="10" cy="14.3" r=".9" fill="currentColor" stroke="none"/>',
  x:        '<path d="M5 5l10 10M15 5 5 15"/>',
  terminal: '<rect x="2.5" y="4" width="15" height="12" rx="1.6"/><path d="M5.5 8 8 10.5 5.5 13M10 13h4"/>',
  eye:      '<path d="M2.5 10S5.5 5 10 5s7.5 5 7.5 5-3 5-7.5 5-7.5-5-7.5-5Z"/><circle cx="10" cy="10" r="2.2"/>',
  target:   '<circle cx="10" cy="10" r="6.5"/><circle cx="10" cy="10" r="2.4"/><path d="M10 1.5v3M10 15.5v3M1.5 10h3M15.5 10h3"/>',
  power:    '<path d="M10 3v6"/><path d="M6 6a6 6 0 1 0 8 0"/>',
  restart:  '<path d="M15.5 6.5A6.5 6.5 0 1 0 16.5 11M16 3v4h-4"/>',
  trash:    '<path d="M4.5 6h11M8 6V4.5h4V6M6 6l.7 9.5h6.6L14 6"/>',
  flush:    '<path d="M3 7c1.5 1.4 3 1.4 4.5 0S10.5 5.6 12 7s3 1.4 4.5 0M3 12c1.5 1.4 3 1.4 4.5 0s3-1.4 4.5 0 3 1.4 4.5 0"/>',
  wave:     '<path d="M2.5 10c1-3 2-3 3 0s2 3 3 0 2-3 3 0 2 3 3 0"/>',
  layers:   '<path d="M10 3 17 6.5 10 10 3 6.5Z"/><path d="m3 10.5 7 3.5 7-3.5"/>',
  panel:    '<rect x="3" y="3" width="14" height="14" rx="1.5"/><path d="M7 3v14M11 3v14M15 3v14M3 7h14M3 11h14"/>',
  link:     '<path d="M8 12a3 3 0 0 0 4 0l2-2a3 3 0 0 0-4-4l-1 1M12 8a3 3 0 0 0-4 0l-2 2a3 3 0 0 0 4 4l1-1"/>',
  download: '<path d="M10 3v9M6.5 8.5 10 12l3.5-3.5M4 15.5h12"/>',
  bolt:     '<path d="M11 2.5 4.5 11H9l-1 6.5L15.5 9H11Z"/>',
  film:     '<rect x="3" y="4" width="14" height="12" rx="1.4"/><path d="M3 7.2h14M3 12.8h14M7 4v12M13 4v12"/>',
  /* --- added --- */
  pulse:    '<path d="M2.5 10h3l2-5 3 10 2-5h5"/>',
  shield:   '<path d="M10 2.5 16 5v4.5c0 4-2.6 6.7-6 8-3.4-1.3-6-4-6-8V5Z"/><path d="M7.4 10 9.3 12l3.3-3.6"/>',
  key:      '<circle cx="6.5" cy="10" r="3.2"/><path d="M9.6 10H17M14 10v3M16.4 10v2.2"/>',
  doc:      '<path d="M5 2.5h6l4 4V17a.5.5 0 0 1-.5.5h-9A.5.5 0 0 1 5 17Z"/><path d="M11 2.5V6.5h4M7.5 10h5M7.5 13h5"/>',
  reg:      '<ellipse cx="10" cy="5" rx="6" ry="2.3"/><path d="M4 5v10c0 1.3 2.7 2.3 6 2.3s6-1 6-2.3V5M4 10c0 1.3 2.7 2.3 6 2.3s6-1 6-2.3"/>',
  undo:     '<path d="M7 7 3.5 10 7 13M3.5 10H12a4 4 0 0 1 0 8h-1.5"/>',
  redo:     '<path d="M13 7l3.5 3L13 13M16.5 10H8a4 4 0 0 0 0 8h1.5"/>',
  rotate:   '<path d="M3.5 8.5A7 7 0 0 1 16 7M16 3.5V7h-3.5M16.5 11.5A7 7 0 0 1 4 13M4 16.5V13h3.5"/>',
  grid:     '<rect x="3" y="3" width="14" height="14" rx="1.4"/><path d="M3 7.7h14M3 12.3h14M7.7 3v14M12.3 3v14"/>',
  pin:      '<path d="M10 17.5c3-3.4 5-6 5-8.5a5 5 0 0 0-10 0c0 2.5 2 5.1 5 8.5Z"/><circle cx="10" cy="9" r="1.9" fill="currentColor" stroke="none"/>',
  ruler:    '<rect x="3" y="6.5" width="14" height="7" rx="1.2" transform="rotate(-45 10 10)"/><path d="M8 6 9 7M10.5 8.5l1 1M6 8l1 1M13 11l1 1"/>',
  cube3:    '<path d="M10 2.6 17 6.3v7.4L10 17.4 3 13.7V6.3Z"/><path d="M3 6.3 10 10l7-3.7M10 10v7.4"/>',
  list:     '<path d="M6.5 5.5h9M6.5 10h9M6.5 14.5h9"/><circle cx="3.6" cy="5.5" r="1" fill="currentColor" stroke="none"/><circle cx="3.6" cy="10" r="1" fill="currentColor" stroke="none"/><circle cx="3.6" cy="14.5" r="1" fill="currentColor" stroke="none"/>',
  sun:      '<circle cx="10" cy="10" r="3.6"/><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.6 4.6l1.4 1.4M14 14l1.4 1.4M15.4 4.6 14 6M6 14l-1.4 1.4"/>',
  moon:     '<path d="M16 11.2A6.5 6.5 0 1 1 8.8 4a5.2 5.2 0 0 0 7.2 7.2Z"/>',
  /* --- Windows window controls --- */
  wmin:     '<path d="M4 10h12"/>',
  wmax:     '<rect x="4.5" y="4.5" width="11" height="11" rx="1"/>',
  /* --- added for UECM cache redesign --- */
  minus:    '<path d="M4.5 10h11"/>',
  pause:    '<path d="M7 4.5v11M13 4.5v11"/>',
  filter:   '<path d="M3 4.5h14l-5.4 6.4V16L8.4 14v-3.1Z"/>',
  copy:     '<rect x="6.5" y="6.5" width="9" height="9" rx="1.4"/><path d="M4.5 11.5v-6A1 1 0 0 1 5.5 4.5h6"/>',
  arrowr:   '<path d="M4 10h11M11 6l4 4-4 4"/>',
  server:   '<rect x="3" y="4" width="14" height="5" rx="1.3"/><rect x="3" y="11" width="14" height="5" rx="1.3"/><circle cx="6" cy="6.5" r=".9" fill="currentColor" stroke="none"/><circle cx="6" cy="13.5" r=".9" fill="currentColor" stroke="none"/>',
};

function Icon({ name, size = 18, stroke = 1.6, style }) {
  const inner = ICON_PATHS[name] || '';
  return React.createElement('svg', {
    width: size, height: size, viewBox: '0 0 20 20', fill: 'none',
    stroke: 'currentColor', strokeWidth: stroke, strokeLinecap: 'round', strokeLinejoin: 'round',
    style, dangerouslySetInnerHTML: { __html: inner },
  });
}

/* ---------- Stages (LED volumes) ---------- */
const STAGES = [
  { id: 'st4', name: 'Stage 04', volume: 'Volume A', status: 'positive', state: '在线' },
  { id: 'st2', name: 'Stage 02', volume: 'Volume B', status: 'notice', state: '校准中' },
  { id: 'st1', name: 'Stage 01', volume: '插入墙', status: 'neutral', state: '空闲' },
];

const PAGES = [
  { id: 'previz',    label: '预演',  icon: 'previz',    skeleton: true,  title: '预可视化', sub: '场景布局与机位走位' },
  { id: 'calibrate', label: '校正',  icon: 'calibrate', skeleton: false, title: 'Calibrate', sub: 'LED 网格重建 → 镜头校正' },
  { id: 'color',     label: '调色',  icon: 'color',     skeleton: true,  title: '调色',     sub: '屏幕 LUT 与一级' },
  { id: 'live',      label: '现场',  icon: 'live',      skeleton: true,  title: '现场',     sub: '现场回放与录制' },
  { id: 'tools',     label: '工具',  icon: 'tools',     skeleton: false, title: '工具',     sub: '渲染缓存 · 诊断' },
];

/* ============================================================
   CACHE — UECM (UE Cache Manager) · operator 单机操控渲染集群缓存
   IA: 任务中心(Playbooks) + 资产域(Resources) + 常驻任务抽屉
   ============================================================ */
/* status meta (color + icon + text) — shared by machines / health / tasks */
const NODE_STATUS = {
  healthy:  { label: '健康', variant: 'positive', visual: 'positive', icon: 'check' },
  warning:  { label: '警告', variant: 'notice',   visual: 'notice',   icon: 'alert' },
  critical: { label: '严重', variant: 'negative', visual: 'negative', icon: 'alert' },
  offline:  { label: '离线', variant: 'neutral',  visual: 'neutral',  icon: 'power' },
  na:       { label: '不适用', variant: 'neutral', visual: 'neutral', icon: 'minus' },
};

/* cluster snapshot — the "上次巡检缓存快照"，非实时轮询 */
const CLUSTER = { online: 6, total: 8, health: 72, lastRun: '14:08', lastRunAgo: '14 分钟前' };

/* config baseline (consistency-check 下钻用) */
const BASELINE = { driver: '552.22', ue: '5.4.4', psoPrecache: '1', tdrLevel: '0' };

/* remote channel — WinRM (pull 默认) vs 提权 SSH (UAC 过滤的操作) */
const CHANNEL = {
  winrm: { label: 'WinRM', short: 'WinRM', icon: 'net',   note: 'pull 默认通道' },
  ssh:   { label: '提权 SSH', short: 'SSH', icon: 'shield', note: 'UAC 过滤操作走此' },
};

/* ---- UI 左导航（概览与机器管理已合并为「集群总览」） ---- */
const CACHE_MODULES = [
  { id: 'home',     label: '集群总览', sub: 'Cluster',    icon: 'grid' },
  { id: 'ddc',      label: 'DDC 管理', sub: 'DDC',        icon: 'cache' },
];

/* ---- DDC 管理·折叠子菜单（父项仅折叠，不导航）---- */
const DDC_NAV = [
  { id: 'ddc_zen',    label: 'ZenServer',      icon: 'cube' },
  { id: 'ddc_legacy', label: '文件系统 DDC', icon: 'server' },
  { id: 'ddc_pak',    label: 'DDC PAK',       icon: 'cache' },
  { id: 'ddc_pso',    label: 'PSO 缓存',        icon: 'layers' },
];

/* ---- 机器管理 · 扫描发现的未纳管设备（按网段分组）---- */
const DISCOVERED = [
  { subnet: '10.20.8.0/24', hosts: [
    { ip: '10.20.8.21', name: 'DESKTOP-7K2', mac: '34:17:EB:9A:21:04', os: 'Windows 11', ue: '5.4.4', reach: 'ssh' },
    { ip: '10.20.8.22', name: 'DESKTOP-7K3', mac: '34:17:EB:9A:21:1C', os: 'Windows 11', ue: '5.4.4', reach: 'unreach' },
  ] },
  { subnet: '10.20.9.0/24', hosts: [
    { ip: '10.20.9.10', name: 'RACK-B-N1', mac: 'A0:36:9F:3D:00:11', os: 'Windows Server', ue: '5.4.3', reach: 'ssh' },
  ] },
];

/* ---- 新机开通 · 待开通裸机候选 ---- */
const ONBOARD_TARGETS = [
  { id: 'ob1', ip: '10.20.8.41', name: 'NEW-RIG-01', reach: 'ssh',  note: 'SSH 直连可达' },
  { id: 'ob2', ip: '10.20.8.42', name: 'NEW-RIG-02', reach: 'usb',  note: 'SSH 不通 · 需 U 盘兜底' },
];

/* ---- DDC 管理 · 三种后端 ---- */
const DDC_BACKENDS = [
  { id: 'zen',   label: 'ZenServer 共享 DDC', tag: '主推', icon: 'cube', cli: 'zen register → … → enable',
    desc: '独立 Zen 服务器做共享缓存，链路在后台逐步执行。', current: true,
    state: '已部署 · render-zen-01', meta: ':1337 · D:\\ZenData · 命中 94%' },
  { id: 'smb',   label: '共享 DDC（SMB）', tag: null, icon: 'folder', cli: 'share create',
    desc: '局域网共享缓存盘，适合无独立服务器的小集群。', current: false,
    state: '可选', meta: '\\\\ddc01\\Volo\\DDC' },
  { id: 'local', label: '本地 DDC', tag: null, icon: 'server', cli: 'local-cache create',
    desc: '单机本地缓存，作为命中链路的回退层。', current: false,
    state: '各机默认开启', meta: 'D:\\UE_DDC\\Local' },
];

/* roles for the unified machine selector */
const ROLES = {
  shared:     { label: '共享上游', tag: 'shared_upstream' },
  render:     { label: '渲染节点', tag: 'render' },
  workstation:{ label: '工作站',   tag: 'workstation' },
  spare:      { label: '备用',     tag: 'spare' },
};

const RENDER_NODES = [
  { id: 'rn0', host: 'RENDER-ZEN-01', ip: '10.20.8.10', status: 'healthy', roleKey: 'shared', role: '共享上游 · ZenServer',
    last: '刚刚', chan: 'winrm', ddc: 100, pso: 100, gpu: '—（缓存服务器）', vendor: '—', driver: '—', vram: 64,
    ue: '5.4.4', uePath: 'D:\\UE_5.4\\Engine', user: 'svc-render', auth: '域账户', domain: 'VOLO',
    health: 98, zen: 'render-zen-01', share: null, proj: ['Helios'], tags: ['shared_upstream'],
    cfg: { driver: '—', ue: '5.4.4', psoPrecache: '1', tdrLevel: '0' } },
  { id: 'rn1', host: 'RNODE-01', ip: '10.20.8.11', status: 'healthy', roleKey: 'render', role: '渲染节点 · nDisplay 主控',
    last: '12 秒前', chan: 'winrm', ddc: 96, pso: 100, gpu: 'RTX 6000 Ada', vendor: 'NVIDIA', driver: '552.22', vram: 48,
    ue: '5.4.4', uePath: 'D:\\UE_5.4\\Engine', user: 'svc-render', auth: '域账户', domain: 'VOLO',
    health: 96, zen: 'render-zen-01', share: '\\\\ddc01\\Volo\\DDC', proj: ['Helios'], tags: ['render'],
    cfg: { driver: '552.22', ue: '5.4.4', psoPrecache: '1', tdrLevel: '0' } },
  { id: 'rn2', host: 'RNODE-02', ip: '10.20.8.12', status: 'healthy', roleKey: 'render', role: '渲染节点',
    last: '8 秒前', chan: 'winrm', ddc: 92, pso: 100, gpu: 'RTX 6000 Ada', vendor: 'NVIDIA', driver: '552.22', vram: 48,
    ue: '5.4.4', uePath: 'D:\\UE_5.4\\Engine', user: 'svc-render', auth: '域账户', domain: 'VOLO',
    health: 93, zen: 'render-zen-01', share: '\\\\ddc01\\Volo\\DDC', proj: ['Helios'], tags: ['render'],
    cfg: { driver: '552.22', ue: '5.4.4', psoPrecache: '1', tdrLevel: '0' } },
  { id: 'rn3', host: 'RNODE-03', ip: '10.20.8.13', status: 'healthy', roleKey: 'render', role: '渲染节点',
    last: '15 秒前', chan: 'winrm', ddc: 88, pso: 97, gpu: 'RTX A6000', vendor: 'NVIDIA', driver: '552.22', vram: 48,
    ue: '5.4.4', uePath: 'D:\\UE_5.4\\Engine', user: 'svc-render', auth: '域账户', domain: 'VOLO',
    health: 90, zen: 'render-zen-01', share: '\\\\ddc01\\Volo\\DDC', proj: ['Helios'], tags: ['render'],
    cfg: { driver: '552.22', ue: '5.4.4', psoPrecache: '1', tdrLevel: '0' } },
  { id: 'rn4', host: 'RNODE-04', ip: '10.20.8.14', status: 'warning', roleKey: 'render', role: '渲染节点', env: 'pending', remote: false,
    last: '40 秒前', chan: 'winrm', ddc: 61, pso: 74, gpu: 'RTX A6000', vendor: 'NVIDIA', driver: '551.86', vram: 48,
    ue: '5.4.4', uePath: 'D:\\UE_5.4\\Engine', user: 'svc-render', auth: '域账户', domain: 'VOLO',
    health: 68, zen: 'render-zen-01', share: '\\\\ddc01\\Volo\\DDC', proj: ['Helios'], tags: ['render'],
    cfg: { driver: '551.86', ue: '5.4.4', psoPrecache: '1', tdrLevel: '3' } },
  { id: 'rn5', host: 'RNODE-05', ip: '10.20.8.15', status: 'critical', roleKey: 'render', role: '渲染节点', env: 'pending', remote: true,
    last: '2 分钟前', chan: 'ssh', ddc: 34, pso: 18, gpu: 'RTX 5880 Ada', vendor: 'NVIDIA', driver: '552.22', vram: 48,
    ue: '5.4.3', uePath: 'D:\\UE_5.4\\Engine', user: 'render', auth: '本地账户', domain: '—',
    health: 34, zen: null, share: '\\\\ddc01\\Volo\\DDC', proj: ['Helios'], tags: ['render'],
    cfg: { driver: '552.22', ue: '5.4.3', psoPrecache: '0', tdrLevel: '0' } },
  { id: 'rn6', host: 'WS-ART-01', ip: '10.20.8.31', status: 'healthy', roleKey: 'workstation', role: '工作站 · 美术',
    last: '6 秒前', chan: 'winrm', ddc: 90, pso: 99, gpu: 'L40S', vendor: 'NVIDIA', driver: '552.22', vram: 48,
    ue: '5.4.4', uePath: 'C:\\UE_5.4\\Engine', user: 'svc-render', auth: '域账户', domain: 'VOLO',
    health: 91, zen: 'render-zen-01', share: null, proj: ['Helios'], tags: ['workstation'],
    cfg: { driver: '552.22', ue: '5.4.4', psoPrecache: '1', tdrLevel: '0' } },
  { id: 'rn7', host: 'RNODE-07', ip: '10.20.8.17', status: 'offline', roleKey: 'render', role: '渲染节点',
    last: '14 分钟前', chan: 'winrm', ddc: 0, pso: 0, gpu: 'RTX A6000', vendor: 'NVIDIA', driver: '—', vram: 48,
    ue: '—', uePath: '—', user: 'svc-render', auth: '域账户', domain: 'VOLO',
    health: 0, zen: null, share: null, proj: [], tags: ['render'], cfg: null },
  { id: 'rn8', host: 'RNODE-08', ip: '10.20.8.18', status: 'offline', roleKey: 'spare', role: '备用节点',
    last: '1 小时前', chan: 'winrm', ddc: 0, pso: 0, gpu: 'L40S', vendor: 'NVIDIA', driver: '—', vram: 48,
    ue: '—', uePath: '—', user: 'svc-render', auth: '域账户', domain: 'VOLO',
    health: 0, zen: null, share: null, proj: [], tags: ['spare'], cfg: null },
];

/* ---- 资产域 · Credentials (AES-GCM SecretStore) ---- */
const CREDS = [
  { id: 'c1', name: 'svc-render', kind: '域账户', domain: 'VOLO', use: '部署 / 远程执行', machines: 7, last: '今天 14:08' },
  { id: 'c2', name: 'zen-svc',    kind: '服务账户', domain: 'VOLO', use: 'ZenServer 服务身份', machines: 1, last: '昨天 18:30' },
  { id: 'c3', name: 'render（本地）', kind: '本地账户', domain: '—', use: 'RNODE-05 回退登录', machines: 1, last: '3 天前' },
];

/* ---- 资产域 · Shares (SMB 共享 DDC) ---- */
const SHARES = [
  { id: 's1', path: '\\\\ddc01\\Volo\\DDC', mode: 'Mode A · 开放', clients: 5, size: '4.8 / 8 TB', gc: '已暂停', status: 'healthy' },
  { id: 's2', path: '\\\\ddc02\\Volo\\Backup', mode: 'Mode B · 专用账号', clients: 0, size: '0.2 / 4 TB', gc: '运行中', status: 'warning' },
];

/* ---- 资产域 · Zen endpoints (独立 ZenServer) ---- */
const ZEN_ENDPOINTS = [
  { id: 'z1', name: 'render-zen-01', host: 'RENDER-ZEN-01', ip: '10.20.8.10', port: 1337, dataDir: 'D:\\ZenData',
    version: 'Zen 5.4.4', service: '运行中', urlacl: '已注册', clients: 5, hit: 94, size: '3.1 TB', status: 'healthy' },
];

/* ---- ZenServer 服务端 10 步链路（搭共享缓存 → Zen 向导）---- */
const ZEN_STEPS = [
  { id: 'zs1', n: 1, label: '选服务器机器', cli: 'machine（选择）',   status: 'done',
    summary: '已选 RENDER-ZEN-01 · 10.20.8.10', destructive: false },
  { id: 'zs2', n: 2, label: '选凭据',       cli: 'cred（选择）',     status: 'done',
    summary: '已选 zen-svc（域账户 VOLO）', destructive: false },
  { id: 'zs3', n: 3, label: '注册 endpoint', cli: 'zen register',    status: 'active',
    summary: 'endpoint: render-zen-01 · port 1337 · data-dir D:\\ZenData', destructive: false,
    preview: ['zen detect-binary → 定位 ZenServer.exe', 'zen register --name render-zen-01 --port 1337 --data-dir D:\\ZenData'],
    readback: { key: '[Endpoint] render-zen-01', expected: 'registered', actual: '—' } },
  { id: 'zs4', n: 4, label: 'apply-config', cli: 'zen apply-config', status: 'ready',
    summary: '写入 zen.lua + SHA256 校验', destructive: false,
    preview: ['生成 zen.lua（StorageDir=D:\\ZenData, Port=1337）', '写入后回读并校验 SHA256'],
    readback: { key: 'zen.lua SHA256', expected: 'a91f…7c2d', actual: '—' } },
  { id: 'zs5', n: 5, label: 'urlacl add',   cli: 'zen urlacl add',   status: 'pending',
    summary: 'netsh http add urlacl（需提权 SSH）', destructive: false, channel: 'ssh',
    preview: ['netsh http add urlacl url=http://+:1337/ user=zen-svc'],
    readback: { key: 'urlacl :1337', expected: 'reserved', actual: '—' } },
  { id: 'zs6', n: 6, label: '安装服务',     cli: 'zen service install', status: 'pending',
    summary: '注册 Windows 服务 ZenServer（需提权 SSH）', destructive: false, channel: 'ssh',
    preview: ['sc create ZenServer binPath=…ZenServer.exe', '设置 startup=auto，服务账户 zen-svc'],
    readback: { key: 'service ZenServer', expected: 'installed', actual: '—' } },
  { id: 'zs7', n: 7, label: '启动 + probe', cli: 'zen service start → probe', status: 'pending',
    summary: '启动服务并探活 endpoint', destructive: false,
    preview: ['sc start ZenServer', 'zen probe render-zen-01 → 期望 HTTP 200 /health'],
    readback: { key: 'probe /health', expected: '200 OK', actual: '—' } },
  { id: 'zs8', n: 8, label: 'enable 工作站', cli: 'zen enable', status: 'pending',
    summary: '写 [StorageServers] Shared，回读确证', destructive: true,
    preview: ['ini set [StorageServers] Shared (Host="render-zen-01"; Port=1337)', '回读 expected vs actual 对比'],
    readback: { key: '[StorageServers] Shared', expected: 'Host=render-zen-01;Port=1337', actual: '—' } },
];

/* ---- 资产域 · Health · L1/L2/L3 三层（每条 critical 带 remediation）---- */
const HEALTH_CHECKS = [
  { id: 'h_port', layer: 'L1', label: '端口可达 · ZenServer :1337', status: 'healthy', weight: 12,
    detail: 'RENDER-ZEN-01 :1337 响应 200，5 客户端连通', remediation: null },
  { id: 'h_hb',  layer: 'L1', label: '心跳 / 在线', status: 'warning', weight: 14,
    detail: '6 / 8 节点在线，RNODE-07 / 08 无心跳', remediation: '重新远程引导这台机器，或检查它的远程管理服务',
    desc: 'RNODE-07 和 08 连不上了，可能已关机或远程管理服务挂了。' },
  { id: 'h_zen', layer: 'L2', label: 'zen_reachable', status: 'na', weight: 10,
    detail: 'probe 过期，已按 DESIGN-1 降级为不适用（先跑 zen probe 再判定）', remediation: null,
    naReason: 'probe 结果过期 · 非缺陷（F-043）' },
  { id: 'h_drv', layer: 'L2', label: '驱动一致性', status: 'warning', weight: 12,
    detail: 'RNODE-04 驱动 551.86 偏离基线 552.22', remediation: '分发驱动 552.22 并重启 RNODE-04',
    desc: 'RNODE-04 的显卡驱动和集群其他机器不一致，可能导致渲染表现差异。' },
  { id: 'h_ue',  layer: 'L2', label: 'UE 版本一致', status: 'warning', weight: 12,
    detail: 'RNODE-05 为 5.4.3，落后基线 5.4.4', remediation: '在 RNODE-05 升级 UE 至 5.4.4',
    desc: 'RNODE-05 的虚幻引擎版本比集群基线旧，建议升级后再参与生成。' },
  { id: 'h_pso', layer: 'L3', label: 'PSO 就绪', status: 'critical', weight: 18,
    detail: 'RNODE-05 预热 18% — r.PSOPrecache 未启用', remediation: '开启 RNODE-05 的着色器预热（PSO 预缓存），然后重新收集一次',
    desc: 'RNODE-05 的着色器预热远未完成，现在去渲染会反复卡顿。' },
  { id: 'h_ddc', layer: 'L3', label: 'DDC 命中率 / 失衡', status: 'healthy', weight: 12,
    detail: '集群均值 78%，本地 vs 共享 DDC 无失衡', remediation: null },
  { id: 'h_cred',layer: 'L2', label: '凭据有效性', status: 'warning', weight: 10,
    detail: 'RNODE-05 仍用本地账户，建议切域账户 svc-render', remediation: '把 RNODE-05 切换为域账户 svc-render，重新登录后校验',
    desc: 'RNODE-05 还在用本地账户登录，建议换成统一的域账户以免授权出问题。' },
];

/* ---- INI 扫描 findings（每条带 recommendation）---- */
const INI_FINDINGS = [
  { id: 'R015', rule: 'R015', sev: 'critical', machine: 'RNODE-05', file: 'DefaultEngine.ini',
    section: '[/Script/Engine.RendererSettings]', cur: 'r.PSOPrecache=0', rec: 'r.PSOPrecache=1',
    summary: 'RNODE-05 的着色器预缓存被关闭',
    why: 'PSO 预缓存关闭会导致运行时编译卡顿与重复 shader 编译。', auto: true },
  { id: 'R022', rule: 'R022', sev: 'warning', machine: 'RNODE-05', file: 'DefaultEngine.ini',
    section: '[/Script/Engine.RendererSettings]', cur: 'r.PSOPrecache.Resources=0', rec: 'r.PSOPrecache.Resources=1',
    summary: 'RNODE-05 的资源着色器未预缓存',
    why: '资源 PSO 未预缓存，建议跟 R015 一起修复。', auto: true },
  { id: 'R008', rule: 'R008', sev: 'warning', machine: 'RNODE-04', file: 'DefaultEngine.ini',
    section: '[StorageServers]', cur: 'Shared 缺失', rec: 'Host=render-zen-01; Port=1337',
    summary: 'RNODE-04 缺少共享缓存服务器配置',
    why: '未写入共享存储服务器，DDC 不会命中 Zen 上游。', auto: true },
  { id: 'R031', rule: 'R031', sev: 'info', machine: 'RNODE-01', file: 'DefaultEngine.ini',
    section: '[Core.System]', cur: 'DerivedDataBackendGraph 顺序待优化', rec: 'Zen 优先于本地 Pak',
    summary: 'RNODE-01 的缓存查找顺序建议调优',
    why: 'backend-graph 顺序影响命中链路，建议 Zen 优先。', auto: false },
  { id: 'R044', rule: 'R044', sev: 'warning', machine: 'RNODE-04', file: 'GraphicsDrivers（注册表）',
    section: 'HKLM\\…\\GraphicsDrivers', cur: 'TdrLevel=3', rec: 'TdrLevel=0',
    summary: 'RNODE-04 的驱动超时保护未关闭',
    why: '长任务渲染建议禁用 TDR，避免驱动超时重置。', auto: true },
];

/* ---- 资产域 · UE 工程（discover_projects 远程扫 .uproject 的结果）---- */
/* machines: 在哪些机器上发现了这个工程（机器 id）；primary: 推荐作为生成源的机器 */
const UE_PROJECTS = [
  { id: 'helios', name: 'Helios', uproject: 'Helios.uproject', ue: '5.4.4', size: '184 GB',
    root: 'D:\\Projects\\Helios', last: '今天 13:32', machines: ['rn1', 'rn2', 'rn3', 'rn4', 'rn6'], primary: 'rn1', hasPak: true },
  { id: 'aurora', name: 'Aurora_Trailer', uproject: 'Aurora.uproject', ue: '5.4.4', size: '92 GB',
    root: 'D:\\Projects\\Aurora', last: '今天 13:32', machines: ['rn6', 'rn1'], primary: 'rn6', hasPak: false },
  { id: 'nomad', name: 'Nomad_Test', uproject: 'Nomad.uproject', ue: '5.4.3', size: '37 GB',
    root: 'E:\\UEProjects\\Nomad', last: '昨天 20:14', machines: ['rn5'], primary: 'rn5', hasPak: false,
    warn: 'UE 版本 5.4.3 与集群基线 5.4.4 不一致' },
];

/* ---- 资产域 · Artifacts (DDC pak / PSO 列表) ---- */
const ARTIFACTS = [
  { id: 'a1', kind: 'DDC pak', name: 'DDC_Helios_5.4.4_zen', size: '62 GB', built: '今天 13:40', backend: 'zen', verified: true, status: 'healthy' },
  { id: 'a2', kind: 'DDC pak', name: 'DDC_Helios_5.4.4_legacy', size: '58 GB', built: '昨天 22:10', backend: 'legacy', verified: true, status: 'healthy' },
  { id: 'a3', kind: 'PSO', name: 'PSO_main_5.4.4_d92f', size: '418 MB', built: '今天 11:25', backend: '—', verified: true, status: 'warning' },
  { id: 'a4', kind: 'PSO', name: 'PSO_seq204_5.4.4_a17c', size: '286 MB', built: '昨天 19:02', backend: '—', verified: false, status: 'warning' },
];

/* ---- 常驻任务抽屉 · 异步任务（含历史 / 失败留痕）---- */
const TASKS = [
  { id: 't_3', no: 3, domain: 'ddc', action: 'generate', title: 'ddc generate', state: 'running',
    pct: 62, chan: 'winrm', started: '14:19', elapsed: '3m 02s', target: 'RENDER-ZEN-01',
    note: '编译 shader · 灌共享 DDC（可达 30+ 分钟）', stream: true },
  { id: 't_7', no: 7, domain: 'ini', action: 'apply', title: 'ini apply', state: 'success',
    pct: 100, chan: 'winrm', started: '14:11', elapsed: '6s', target: 'RNODE-05',
    note: 'R015 已修复 · warning 4 → 2', stream: false },
  { id: 't_6', no: 6, domain: 'zen', action: 'probe', title: 'zen probe', state: 'success',
    pct: 100, chan: 'winrm', started: '14:08', elapsed: '2s', target: 'render-zen-01',
    note: 'HTTP 200 /health · 5 客户端连通', stream: false },
  { id: 't_5', no: 5, domain: 'share', action: 'create', title: 'share create', state: 'failed',
    pct: 100, chan: 'winrm', started: '13:52', elapsed: '4s', target: 'RNODE-04',
    note: 'WinRM 被 UAC 过滤', exit: 2, channelFail: true,
    stderr: 'Access is denied. (0x80070005) — Machine-scope 写操作被 WinRM/UAC 过滤', stream: false },
];

/* monotonic task counter seed (next #) */
const TASK_SEQ = 8;

/* ============================================================
   CALIBRATE — LED mesh reconstruct → lens solve
   ============================================================ */
const CAL_SCREENS = [
  { id: 'main',  name: '主屏 · 前墙', cols: 16, rows: 9,  panels: 1024, sub: 'Volume A' },
  { id: 'ceil',  name: '顶屏',        cols: 14, rows: 6,  panels: 504,  sub: 'Volume A' },
  { id: 'floor', name: '地屏',        cols: 12, rows: 8,  panels: 576,  sub: 'Volume A' },
];

/* mesh-reconstruct steps + lens */
const CAL_STEPS = [
  { id: 'design',  n: 1, label: 'Design',  cn: '网格设计', icon: 'grid',   group: 'mesh', status: 'done' },
  { id: 'method',  n: 2, label: 'Method',  cn: '重建方法', icon: 'tools',  group: 'mesh', status: 'done' },
  { id: 'survey',  n: 3, label: 'Survey',  cn: '测量导入', icon: 'pin',    group: 'mesh', status: 'done' },
  { id: 'preview', n: 4, label: 'Preview', cn: '网格预览', icon: 'cube',   group: 'mesh', status: 'active' },
  { id: 'runs',    n: 5, label: 'Runs',    cn: '重建历史', icon: 'list',   group: 'mesh', status: 'ready' },
  { id: 'lens',    n: 6, label: 'Lens',    cn: '镜头校正', icon: 'camera', group: 'lens', status: 'pending' },
];

/* survey points — measured vs guessed, with reference roles */
const CAL_POINTS = [
  { id: 'p_org', name: 'REF_origin',  role: 'origin',   xyz: [0.000, 0.000, 0.000],  measured: true,  sigma: 0.4, err: 0.31 },
  { id: 'p_x',   name: 'REF_x_axis',  role: 'x_axis',   xyz: [4.812, 0.004, -0.002], measured: true,  sigma: 0.5, err: 0.44 },
  { id: 'p_xy',  name: 'REF_xy_plane',role: 'xy_plane', xyz: [4.806, 2.701, 0.011],  measured: true,  sigma: 0.6, err: 0.52 },
  { id: 'p_01',  name: 'SURV_0142',   role: null,       xyz: [1.204, 1.882, 0.021],  measured: true,  sigma: 0.7, err: 0.58 },
  { id: 'p_02',  name: 'SURV_0143',   role: null,       xyz: [2.418, 1.886, 0.018],  measured: true,  sigma: 0.7, err: 0.62 },
  { id: 'p_03',  name: 'SURV_0211',   role: null,       xyz: [3.640, 2.610, 0.150],  measured: false, sigma: 2.8, err: 2.41 },
  { id: 'p_04',  name: 'SURV_0212',   role: null,       xyz: [3.012, 0.402, 0.009],  measured: true,  sigma: 0.8, err: 0.71 },
];

/* CSV import report (method M1 = total station) */
const SURVEY_REPORT = {
  measured: 1012, fabricated: 8, outlier: 3, missing: 1,
  warnings: [
    { lv: 'warn', msg: 'SURV_0211 偏差 2.41 mm，超出 2.0 mm 阈值，已标记离群' },
    { lv: 'warn', msg: '1 个面板角点缺失，将由相邻面板插值填补' },
    { lv: 'info', msg: '8 个点来自制造数据（fabricated），未实测' },
  ],
};

/* reconstruction history */
const CAL_RUNS = [
  { id: 'r6', created: '今天 14:21', screen: '主屏 · 前墙', method: 'M2 视觉', rms: 0.42, vertices: 33800, target: 'mesh_v6', obj: true,
    metrics: { mid_max: 0.81, mid_mean: 0.29, est_rms: 0.42, est_p95: 0.74 } },
  { id: 'r5', created: '今天 11:08', screen: '主屏 · 前墙', method: 'M1 全站仪', rms: 2.90, vertices: 33800, target: 'mesh_v5', obj: true,
    metrics: { mid_max: 5.12, mid_mean: 1.84, est_rms: 2.90, est_p95: 4.61 } },
  { id: 'r4', created: '昨天 18:52', screen: '顶屏',        method: 'M1 全站仪', rms: 6.40, vertices: 16600, target: 'mesh_v4', obj: true,
    metrics: { mid_max: 11.8, mid_mean: 4.12, est_rms: 6.40, est_p95: 9.92 } },
  { id: 'r3', created: '昨天 16:30', screen: '地屏',        method: 'M2 视觉', rms: 9.10, vertices: 18900, target: 'mesh_v3', obj: false,
    metrics: { mid_max: 18.4, mid_mean: 6.71, est_rms: 9.10, est_p95: 14.2 } },
  { id: 'r2', created: '昨天 09:14', screen: '主屏 · 前墙', method: 'M2 视觉', rms: null, vertices: 0, target: 'mesh_v2', obj: false,
    metrics: null },
];

/* preview quality metrics for current mesh (mm) */
const MESH_METRICS = { mid_max: 0.81, mid_mean: 0.29, est_rms: 0.42, est_p95: 0.74, vertices: 33800, cols: 64, rows: 16 };

/* lens solve stages */
const LENS_STAGES = [
  { id: 'validate', n: 1, label: 'Validate', cn: '校验',  status: 'done' },
  { id: 'detect',   n: 2, label: 'Detect',   cn: '检测',  status: 'done' },
  { id: 'solve',    n: 3, label: 'Solve',    cn: '求解',  status: 'pending' },
  { id: 'report',   n: 4, label: 'Report',   cn: '报告',  status: 'pending' },
];

/* ---------- Console log (NDJSON 流 · dynamic seed) ----------
   ch = 通道（winrm / ssh）；task = 关联任务 #；lv = info/ok/warn/err */
const LOGS = [
  { ts: '14:22:07.118', lv: 'info', cat: 'ddc',   ch: 'winrm', task: 3, msg: '<b>ddc generate #3</b> · 编译 shader 4128 / 6650（62%）' },
  { ts: '14:22:05.902', lv: 'info', cat: 'ddc',   ch: 'winrm', task: 3, msg: 'Materials/MI_Sand_Wet → 命中共享 DDC，跳过编译' },
  { ts: '14:21:58.440', lv: 'warn', cat: 'health',ch: 'winrm', task: null, msg: '<b>RNODE-04</b> 驱动 551.86 偏离基线 552.22（remediation 可用）' },
  { ts: '14:21:40.013', lv: 'info', cat: 'calibrate', ch: null, task: null, msg: '网格预览：顶点 <b>33,800</b>，拓扑 64 × 16' },
  { ts: '14:21:12.221', lv: 'err',  cat: 'health', ch: 'winrm', task: null, msg: '<b>RNODE-05</b> PSO 预热 18% — r.PSOPrecache 未启用（finding R015）' },
  { ts: '14:11:06.330', lv: 'ok',   cat: 'ini',   ch: 'winrm', task: 7, msg: '<b>ini apply #7</b> 完成 · R015 修复，re-scan warning 4 → 2' },
  { ts: '14:08:31.004', lv: 'ok',   cat: 'zen',   ch: 'winrm', task: 6, msg: '<b>zen probe #6</b> · render-zen-01 → HTTP 200 /health' },
  { ts: '13:52:19.880', lv: 'err',  cat: 'share', ch: 'winrm', task: 5, msg: '<b>share create #5</b> 失败 · exit 2 — WinRM 被 UAC 过滤，建议切提权 SSH' },
  { ts: '13:40:09.510', lv: 'info', cat: 'ddc',   ch: 'winrm', task: null, msg: 'auto 模式：Zen 可达，generate 已智能跳过 legacy 分支' },
  { ts: '13:38:02.118', lv: 'info', cat: 'health',ch: 'winrm', task: null, msg: '集群快照刷新 — 6/8 在线 · 健康分 72 · 上次巡检 14:08' },
];

Object.assign(window, {
  Icon, STAGES, PAGES,
  NODE_STATUS, CLUSTER, BASELINE, CHANNEL, ROLES,
  CACHE_MODULES, DDC_NAV, DISCOVERED, ONBOARD_TARGETS, DDC_BACKENDS, RENDER_NODES,
  CREDS, SHARES, ZEN_ENDPOINTS, ZEN_STEPS, HEALTH_CHECKS, INI_FINDINGS, ARTIFACTS, UE_PROJECTS,
  TASKS, TASK_SEQ,
  CAL_SCREENS, CAL_STEPS, CAL_POINTS, SURVEY_REPORT, CAL_RUNS, MESH_METRICS, LENS_STAGES,
  LOGS,
});

export { Icon, STAGES, PAGES };
