// @ts-nocheck
/* Volo — mock data + inline SVG icon set (shared on window).
   1:1 port of the Claude Design handoff `src/data.jsx`. Symbols are published
   on `window` (as in the prototype) so the other ported modules reach them as
   bare globals at render time. */
import * as React from "react";
import { GRID_CAB_QUALITY, GRID_SOLVE_STATUS } from "./api/visualSolveUi";

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
  info:     '<circle cx="10" cy="10" r="7.5"/><circle cx="10" cy="6.5" r=".9" fill="currentColor" stroke="none"/><path d="M10 9.5v5"/>',
  x:        '<path d="M5 5l10 10M15 5 5 15"/>',
  terminal: '<rect x="2.5" y="4" width="15" height="12" rx="1.6"/><path d="M5.5 8 8 10.5 5.5 13M10 13h4"/>',
  eye:      '<path d="M2.5 10S5.5 5 10 5s7.5 5 7.5 5-3 5-7.5 5-7.5-5-7.5-5Z"/><circle cx="10" cy="10" r="2.2"/>',
  target:   '<circle cx="10" cy="10" r="6.5"/><circle cx="10" cy="10" r="2.4"/><path d="M10 1.5v3M10 15.5v3M1.5 10h3M15.5 10h3"/>',
  power:    '<path d="M10 3v6"/><path d="M6 6a6 6 0 1 0 8 0"/>',
  restart:  '<path d="M15.5 6.5A6.5 6.5 0 1 0 16.5 11M16 3v4h-4"/>',
  broom:    '<path d="M14.5 5 10 9.5"/><path d="M7.5 8 12 12.5"/><path d="M8.6 9.1 11 11.4"/><path d="M7.5 8 4 12 8 16 12 12.5"/><path d="M6 11 8.5 13.6M8 9.6 10.4 12"/>',
  star:     '<path d="M10 2.6 12.2 7.1 17.2 7.8 13.6 11.3 14.4 16.3 10 13.9 5.6 16.3 6.4 11.3 2.8 7.8 7.8 7.1Z"/>',
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
  wrestore: '<rect x="6.5" y="4" width="9" height="9" rx="1"/><path d="M4.5 7.5v8h8v-8z"/>',
  /* --- added for cache redesign --- */
  minus:    '<path d="M4.5 10h11"/>',
  pause:    '<path d="M7 4.5v11M13 4.5v11"/>',
  filter:   '<path d="M3 4.5h14l-5.4 6.4V16L8.4 14v-3.1Z"/>',
  sort:     '<path d="M5 5.5h10M5 9h6.5M5 12.5h3.5M13.5 6.5v9M13.5 15.5 11 13M13.5 15.5 16 13"/>',
  sliders:  '<path d="M3 6h7M14 6h3M3 14h3M10 14h7"/><circle cx="12" cy="6" r="1.9"/><circle cx="8" cy="14" r="1.9"/>',
  copy:     '<rect x="6.5" y="6.5" width="9" height="9" rx="1.4"/><path d="M4.5 11.5v-6A1 1 0 0 1 5.5 4.5h6"/>',
  arrowr:   '<path d="M4 10h11M11 6l4 4-4 4"/>',
  arrowl:   '<path d="M16 10H5M9 6l-4 4 4 4"/>',
  server:   '<rect x="3" y="4" width="14" height="5" rx="1.3"/><rect x="3" y="11" width="14" height="5" rx="1.3"/><circle cx="6" cy="6.5" r=".9" fill="currentColor" stroke="none"/><circle cx="6" cy="13.5" r=".9" fill="currentColor" stroke="none"/>',
  external: '<path d="M11 4h5v5M16 4l-7 7M13.5 11.5V15A1.5 1.5 0 0 1 12 16.5H5A1.5 1.5 0 0 1 3.5 15V8A1.5 1.5 0 0 1 5 6.5h3.5"/>',
  /* --- added for capture 采集设置 视频源卡片重设计 --- */
  usb:      '<rect x="5.5" y="7.5" width="9" height="6" rx="1.3"/><path d="M8.5 7.5V4a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v3.5"/><path d="M10 13.5v2.7M7.5 16.2h5"/>',
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
   CACHE — operator 单机操控渲染集群缓存
   IA: 任务中心(Playbooks) + 资产域(Resources) + 常驻任务抽屉
   ============================================================ */
/* NODE_STATUS / CHANNEL / ROLES / CACHE_MODULES / DDC_NAV (presentation config)
   moved to src/volo/api/uiConfig.ts — they are design maps, not backend data. */

/* CLUSTER removed — 概况条改为派生（shell deriveCluster → window.CLUSTER）：
   online/total 从机器数，health 从健康检查结果，lastRun/lastRunAgo 从最近一次巡检
   完成时间。data.tsx 自此再无 Cache 域 mock。 */

/* BASELINE removed — GPU 一致性 KPI 改用真实 get_gpu_consistency_matrix
   （window.GPU_MATRIX.baseline.driver + cells status），driver 有了后端来源；
   ue/psoPrecache/tdrLevel 无其它消费者，随 mock 一并移除。 */

/* CHANNEL / CACHE_MODULES / DDC_NAV moved to src/volo/api/uiConfig.ts. */

/* DISCOVERED removed — ScanWizard 改用真实 scan_network（cacheMachines scanResults，
   ProbedHost 只有 ip + 端口可达性；name/os/ue 无后端源，演示列已去掉）。
   ONBOARD_TARGETS removed — was dead (no consumer). */

/* DDC_BACKENDS → api/uiConfig.ts (presentation config — the 3 DDC strategies;
   page only reads id/icon/label/current).
   ZEN_ENDPOINTS removed — was dead (only `const zen = ZEN_ENDPOINTS[0]` in
   cache.tsx / cacheDdc.tsx, never read further). zen_list_endpoints stays bound
   in api/commands; the ZenServer view is deploy-oriented and surfaces no
   endpoint table yet (TODO when that view wires zen_status/zen_cache_stats). */

/* HEALTH_CHECKS / INI_FINDINGS removed — 改用真实数据：
   · 健康 = run_health_check + list_recent_health_runs + list_health_results_for_run
     （shell loadCacheResources → api/adapters.toHealthVMs，按 probe_keys.rs 字典聚合）；
   · INI  = scan_inis + list_findings（toIniVMs，携真实 findingId 供 apply_finding）。
   两者经 shell 镜像到 window.{HEALTH_CHECKS,INI_FINDINGS}，无 run 时为 []（诊断面板空态）。 */

/* UE_PROJECTS → loaded from the backend (list_projects + list_project_locations)
   by the shell, mirrored onto window.UE_PROJECTS via api/cacheData → toProjectVM.
   ue / size / hasPak / warn have no backend source → "—" / false / null (TODO). */

/* ARTIFACTS removed — PSO 文件列表随 collect/distribute 旧链路整体下线（链路证伪）；
   DDC pak 列表后端无「列举产物」命令（只有 generate/verify/distribute
   单产物），UI 也无 pak 列表（只按工程 verify_pak_output），故整条 mock 移除。 */

/* ============================================================
   CALIBRATE — LED mesh reconstruct → lens solve
   ============================================================ */
/* CAL_SCREENS / CAL_POINTS / SURVEY_REPORT / CAL_RUNS / MESH_METRICS removed
   (W2: Calibrate M1 接线) — 屏幕/测量点/导入报告/重建历史/网格质量指标均已
   接真实 Tauri command（见 pages/calibrate.tsx 的 projStore + api/meshCommands）。

   本轮（新 IA 重构）额外移除：CAL_STEPS / LENS_STAGES（旧 step-based 布局专用，
   新 calNav 用字面量数组，见 shell.tsx）、CAP_ 前缀 / AR_ 前缀 / LENS_RESULT ·
   LENS_HISTORY · LENS_SESSION（分别是旧实时采集页 / AR 六步页 / 旧 Lens 完整报告页
   的专属演示数据，三者随对应 page 一起删除，唯一消费者一并消失，非本次臆断裁剪）、
   CAL_PROJECTS（重构前就已是零消费的死 mock，见 W2 审计）。

   新增 CAL_NAV_STATUS/CAL_GRID_STATUS/CAL_LENS_STATUS/CAL_CONF：纯状态徽标的
   色 / 图标 / 文案映射表，不含任何工程数据，可以放心照抄设计稿。
   CAL_OVERVIEW（镜头概要占位数据）随占位 Lens 组件一起移除——真实实现见
   pages/calLens.tsx，唯一消费者已不存在。
   CAL_LED_PROJECTS（项目概览多项目表）与「切换项目」用的项目列表，本仓改为
   运行时从真实 list_recent_projects + 逐项目 load_project_yaml/list_runs 聚合
   （见 pages/calOverview.tsx），不作为静态 mock 常量搬运。 */

/* 导航项状态三通道：done 已完成 / ready 可进行 / blocked 未就绪 */
const CAL_NAV_STATUS = {
  done:    { label: '已完成', tone: 'positive',    icon: 'check' },
  ready:   { label: '可进行', tone: 'informative', icon: 'arrowr' },
  blocked: { label: '未就绪', tone: 'neutral',     icon: 'minus' },
};
/* 交付物状态徽标 —— 网格 4 档 / 镜头 4 档（项目概览表格用） */
const CAL_GRID_STATUS = {
  none:     { label: '未开始',     tone: 'neutral',     icon: 'minus' },
  measured: { label: '测量已导入', tone: 'informative', icon: 'download' },
  rebuilt:  { label: '已重建',     tone: 'positive',    icon: 'cube' },
  exported: { label: '已导出',     tone: 'positive',    icon: 'check' },
};
const CAL_LENS_STATUS = {
  none:     { label: '未开始',    tone: 'neutral',     icon: 'minus' },
  session:  { label: '有 session', tone: 'informative', icon: 'camera' },
  solved:   { label: '已求解',    tone: 'positive',    icon: 'target' },
  exported: { label: '已导出',    tone: 'positive',    icon: 'check' },
  unknown:  { label: '未跟踪',    tone: 'neutral',     icon: 'minus' },
};
/* 置信度四档三通道（供镜头交付物用） */
const CAL_CONF = {
  high:     { label: 'high',     tone: 'positive' },
  medium:   { label: 'medium',   tone: 'notice' },
  low:      { label: 'low',      tone: 'notice' },
  very_low: { label: 'very_low', tone: 'negative' },
};
/* ---- LED 增量：Survey M2 视觉 ---- */
const M2_PATTERN = {
  method: 'charuco', screen_id_code: 'A1', full_preview: true,
  tiles: [
    { cab: 'cab_01', ok: true }, { cab: 'cab_02', ok: true }, { cab: 'cab_03', ok: true },
    { cab: 'cab_04', ok: true }, { cab: 'cab_05', ok: true }, { cab: 'cab_06', ok: true },
    { cab: 'cab_07', ok: false }, { cab: 'cab_08', ok: true }, { cab: 'cab_09', ok: true },
  ],
};
const M2_MANIFEST = [
  { view: 'cam_left',   imgs: 12 },
  { view: 'cam_center', imgs: 14 },
  { view: 'cam_right',  imgs: 11 },
];
const M2_INTRINSICS = { mode: 'chessboard', rms_px: 0.34, max_rms_px: 0.60, observability_warn: null };
const M2_RECONSTRUCT = {
  ba_rms_px: 0.48, ba_observations_used: 18240, ba_observations_total: 19010, ba_rejected: 770,
  procrustes_align_rms_m: 0.0021, intrinsics_source: 'chessboard',
  warnings: [{ code: 'W03', message: 'cabinet 7 观测视图不足（2 < 3），重建置信度低', cabinet: 'cab_07' }],
  cabinets: [
    { cabinet_id: 'cab_01', position_mm: [-3200, 0, 2800],  reprojection_rms_px: 0.41, observed_views: 6, quality: 'good' },
    { cabinet_id: 'cab_02', position_mm: [-1600, 0, 2820],  reprojection_rms_px: 0.44, observed_views: 6, quality: 'good' },
    { cabinet_id: 'cab_05', position_mm: [0, 0, 2850],       reprojection_rms_px: 0.63, observed_views: 5, quality: 'fair' },
    { cabinet_id: 'cab_07', position_mm: [1200, 400, 2900],  reprojection_rms_px: 1.24, observed_views: 2, quality: 'poor' },
    { cabinet_id: 'cab_09', position_mm: [3200, 0, 2810],    reprojection_rms_px: 0.52, observed_views: 5, quality: 'fair' },
  ],
};
const M2_QUALITY = {
  good: { label: 'good', tone: 'positive', icon: 'check' },
  fair: { label: 'fair', tone: 'notice',   icon: 'alert' },
  poor: { label: 'poor', tone: 'negative', icon: 'alert' },
};

/* ---- LED 增量：M1+M2 融合 ---- */
const FUSE_RESULT = {
  anchor_count: 6, anchor_rms_mm: 1.42, scale: 1.0008, scale_locked: false,
  fused_pose_report_path: 'D:\\Projects\\Helios\\calib\\fused_pose_report.yaml',
  anchor_residuals: [
    { point_name: 'REF_origin',   residual_mm: 0.82, delta_mm: [0.31, -0.52, 0.44] },
    { point_name: 'REF_x_axis',   residual_mm: 1.14, delta_mm: [0.88, -0.42, 0.36] },
    { point_name: 'REF_xy_plane', residual_mm: 1.36, delta_mm: [0.94, 0.61, -0.72] },
    { point_name: 'SURV_0142',    residual_mm: 2.91, delta_mm: [1.82, -1.24, 1.61] },
    { point_name: 'SURV_0143',    residual_mm: 1.08, delta_mm: [0.62, 0.44, -0.58] },
    { point_name: 'SURV_0212',    residual_mm: 1.21, delta_mm: [0.71, -0.55, 0.68] },
  ],
};
const FUSE_SOURCE = {
  m1:    { label: 'M1 · 全站仪', tone: 'informative' },
  m2:    { label: 'M2 · 视觉',   tone: 'notice' },
  fused: { label: 'M1+M2 · 融合', tone: 'positive' },
};

/* ---- Preview 顶点来源图例 ---- */
const PROVENANCE = {
  measured:     { label: 'measured 实测',     tone: 'positive',    dot: 'rgba(70,200,130,.9)' },
  interpolated: { label: 'interpolated 插值', tone: 'informative', dot: 'rgba(120,180,255,.85)' },
  extrapolated: { label: 'extrapolated 外推', tone: 'notice',      dot: 'rgba(255,150,40,.95)' },
};

/* ---- AR 舞台校正：三通道状态映射表（不含工程数据，真实态直接读后端） ---- */
/* 世界对齐等级（marker-map validate 的 world_alignment.grade） */
const AR_GRADE = {
  millimetre: { label: 'millimetre', tone: 'positive', icon: 'check' },
  centimetre: { label: 'centimetre', tone: 'notice',   icon: 'alert' },
  coarse:     { label: 'coarse',     tone: 'notice',   icon: 'alert' },
  'n/a':      { label: 'n/a',        tone: 'neutral',  icon: 'minus' },
};
/* 置信度四档（quick run / delay-cal 的 confidence 字符串档），对齐 CAL_CONF */
const AR_CONF = CAL_CONF;
/* AR 工作区（session / marker map / runs 根目录）设置状态三态 */
const AR_WS_STATUS = {
  unset:   { label: '未设置',   tone: 'neutral',     icon: 'minus' },
  set:     { label: '已设置',   tone: 'informative', icon: 'check' },
  checked: { label: '校验通过', tone: 'positive',    icon: 'check' },
};

/* ============================================================
   GRID — 网格校正单一工作区（新 IA）· 纯展示态数据
   真实工程状态（屏幕/测量/重建）经 calibrate.tsx 的 projStore 由真实 Tauri
   command 提供，此处只放跟后端 schema 对齐、但本身不含工程数据的静态表：
   形状档位定义、箱体预设库（后端无此能力，见 CALIBRATE-UX.md 附录 A G8）、
   测量类型卡片文案、导出目标文案、显示开关定义、重建阶段流水文案。 */

/* 屏幕曲率档位 —— 与 crates/volo-shared/src/dto.rs::ShapePriorConfig 的 7 个
   变体一一对应（tag=type，snake_case），fields 驱动检查器表单生成。 */
const GRID_SHAPES = [
  { id: 'flat', label: '平直', icon: 'panel', fields: [] },
  { id: 'curved', label: '曲面', icon: 'wave',
    fields: [ { k: 'radius_mm', label: '半径', min: 100, step: 10, unit: 'mm' } ] },
  { id: 'folded', label: '折叠', icon: 'grid',
    fields: [], seams: true /* 折缝列表用专门的分段编辑器（复用自定义分段的列表 UI） */ },
  { id: 'arc', label: '对称弧', icon: 'wave',
    fields: [ { k: 'center_flat_cols', label: '中心平直列数', min: 0, max: 60, unit: '列' },
              { k: 'angle_per_col_deg', label: '每列折角', min: -20, max: 20, step: 0.5, unit: '°' } ] },
  { id: 'l_shape', label: 'L 形', icon: 'grid',
    fields: [ { k: 'left_cols', label: '左面列数', min: 1, max: 120, unit: '列' },
              { k: 'soften_cols', label: '转角软化列数', min: 0, max: 8, unit: '列' },
              { k: 'corner_angle_deg', label: '转角角度', min: -170, max: 170, unit: '°' } ],
    derived: '右面列数' },
  { id: 'u_shape', label: 'U 形', icon: 'reg',
    fields: [ { k: 'wing_cols', label: '每翼列数', min: 1, max: 60, unit: '列' },
              { k: 'soften_cols', label: '每角软化列数', min: 0, max: 8, unit: '列' },
              { k: 'corner_angle_deg', label: '每角角度', min: -170, max: 170, unit: '°' } ],
    derived: '中段列数' },
  { id: 'custom_segments', label: '自定义分段', icon: 'sliders', fields: [] },
];
/* 新建屏幕类型菜单 —— 场景树底部「新建屏幕」，选中即生成对应 shape_prior 默认值 */
const GRID_SCREEN_TYPES = [
  { id: 'flat', label: '平面墙', icon: 'panel', shape: 'flat' },
  { id: 'arc', label: '弧形墙', icon: 'wave', shape: 'arc' },
  { id: 'l_shape', label: 'L 形墙', icon: 'grid', shape: 'l_shape' },
  { id: 'u_shape', label: 'U 形墙', icon: 'reg', shape: 'u_shape' },
  { id: 'custom_segments', label: '自定义分段墙', icon: 'sliders', shape: 'custom_segments' },
];
/* 屏幕预设（父级）：每个预设含一个或多个屏幕 id 集合。真实屏幕列表来自
   proj.config.screens；此处只提供默认空壳，打开项目后由 shell/检查器按屏同步填充。 */
const GRID_SCREEN_PRESETS = [
  { id: 'preset_main', name: '默认预设', screenIds: [] },
];
/* 箱体预设库（厂商尺寸/像素）—— 后端无此能力（CALIBRATE-UX.md G8），纯前端静态表，
   选中即回填 cabinet_size_mm / pixels_per_cabinet，改回「自定义」解锁手填。 */
const GRID_CAB_PRESETS = [
  { id: 'roe_bp2', label: 'ROE Black Pearl BP2', w: 500, h: 500, px: 176, pxh: 176 },
  { id: 'roe_rb15', label: 'ROE Ruby RB1.5', w: 600, h: 337.5, px: 384, pxh: 216 },
  { id: 'absen_p2', label: 'Absen PL2.5 Pro', w: 500, h: 500, px: 192, pxh: 192 },
  { id: 'unilumin', label: 'Unilumin Upad III', w: 500, h: 500, px: 208, pxh: 208 },
  { id: 'custom', label: '自定义', w: 500, h: 500, px: 176, pxh: 176 },
];
/* 视口显示开关（右上叠加）默认值 + 定义 */
const GRID_DISPLAY_DEFAULT = {
  points: true, pointLabels: false, pattern: false, provenance: false, normals: false,
  ground: true, maskStyle: 'cutout',
};
const GRID_DISPLAY_ITEMS = [
  { k: 'points', label: '测量点', icon: 'pin', child: 'pointLabels', childLabel: '点名标签' },
  { k: 'pattern', label: '测试图贴合预览', icon: 'grid' },
  { k: 'provenance', label: '来源着色', icon: 'layers' },
  { k: 'normals', label: '法线朝向', icon: 'arrowr' },
  { k: 'ground', label: '地面网格与坐标轴', icon: 'cube' },
];
const GRID_VIEWS = [
  { id: 'persp', label: '自由', icon: 'cube3' },
  { id: 'front', label: '正', icon: 'panel' },
  { id: 'top', label: '顶', icon: 'grid' },
  { id: 'side', label: '侧', icon: 'reg' },
];
/* 顶部工具栏「阶段动作」四主流程 —— 始终可见，前置条件不满足则禁用不隐藏 */
const GRID_STAGE_ACTIONS = [
  { id: 'pattern', label: '测试图', icon: 'grid', need: null },
  { id: 'measure', label: '测量导入', icon: 'download', need: null },
  { id: 'rebuild', label: '重建', icon: 'cube3', need: 'measure', blockedMsg: '需先导入测量数据（全站仪导入或视觉校正）' },
  { id: 'export', label: '导出', icon: 'external', need: 'rebuilt', blockedMsg: '需先完成一次重建，产生新建网格' },
];
/* 两种测量方式（术语硬约束：只叫「全站仪导入」「视觉校正」）；reqDisabledShapes 对齐
   crates/mesh-adapter-visual-ba 的已知边界（M2 sidecar 尚不支持新曲率，见 G14）。 */
const GRID_MEAS_TYPES = [
  { id: 'visual', label: '视觉校正', icon: 'camera',
    desc: '屏幕显示测试图 + 摄影机多角度拍摄，自动稠密重建。',
    fit: '适合无全站仪、追求快速稠密重建的场景。',
    disabledForShapes: ['arc', 'l_shape', 'u_shape', 'custom_segments'],
    disabledMsg: '新曲率类型（对称弧/L 形/U 形/自定义分段）暂仅支持全站仪导入' },
  { id: 'totalstation', label: '全站仪导入', icon: 'target',
    desc: '全站仪实测箱体角点，毫米级绝对精度。',
    fit: '适合已架设全站仪、需要绝对尺度基准与最高精度的场景。' },
];
/* 重建进度阶段（统一长任务规格，与 mesh-visual-progress 事件的 stage 文案对齐） */
const GRID_RECON_STAGES = ['载入', '检测', '精化', '平差', '对齐', '输出'];
/* 导出目标（各附一句差异说明） */
const GRID_EXPORT_TARGETS = [
  { id: 'disguise', label: 'Disguise', desc: '毫米单位 · Y 向上 · 适配 d3 空间对齐工作流' },
  { id: 'unreal', label: 'Unreal', desc: '厘米单位 · Z 向上 · 左手坐标系，直接导入 nDisplay' },
  { id: 'neutral', label: '中性', desc: '米单位 · 不做引擎特定转换，通用交换' },
];

/* Stage 复合像素画布：多屏按各自像素尺寸横向排布；area = 屏幕像素并集（覆盖校验基准）。
   screensMap: Record<screenId, ScreenConfig>（项目 config.screens）。 */
function buildStageComposite(screensMap) {
  const ids = screensMap ? Object.keys(screensMap) : [];
  let x = 0, H = 0; const rects = [];
  ids.forEach((id) => {
    const sc = screensMap[id];
    const ppc = (sc && sc.pixels_per_cabinet) || [176, 176];
    const cc = (sc && sc.cabinet_count) || [1, 1];
    const w = Math.max(1, (cc[0] || 1) * (ppc[0] || 1));
    const h = Math.max(1, (cc[1] || 1) * (ppc[1] || 1));
    rects.push({ id, x, y: 0, w, h });
    x += w; H = Math.max(H, h);
  });
  return { canvas: { w: x || 1, h: H || 1 }, screens: rects, area: rects.reduce((a, r) => a + r.w * r.h, 0) };
}

/* Stage 级默认拓扑：每屏一节点，crop = 该屏在复合画布上的区域，window = crop 1:1。 */
function buildStageNdisplayTopo(screensMap) {
  const comp = buildStageComposite(screensMap);
  const nodes = comp.screens.map((r, i) => ({
    node_id: 'Node' + i,
    machine: { hostname: '', ip: '' },
    viewport_rect_px: [r.x, r.y, r.w, r.h],
    window_px: [r.w, r.h],
    window_origin_px: [40, 40],
    fullscreen: false,
    primary: i === 0,
  }));
  return { nodes, canvas: comp.canvas };
}

function resolveProjectTopology(config) {
  if (!config) return null;
  if (config.output_topology && config.output_topology.nodes && config.output_topology.nodes.length)
    return config.output_topology;
  const screens = config.screens || {};
  for (const id of Object.keys(screens)) {
    const t = screens[id] && screens[id].output_topology;
    if (t && t.nodes && t.nodes.length) return t;
  }
  return null;
}

function stageScreenForOutput(config, topology) {
  const comp = buildStageComposite(config && config.screens);
  const topo = topology || resolveProjectTopology(config);
  return {
    cabinet_count: [1, 1],
    cabinet_size_mm: [comp.canvas.w, comp.canvas.h],
    pixels_per_cabinet: [comp.canvas.w, comp.canvas.h],
    output_topology: topo,
    shape_prior: { type: 'flat' },
    shape_mode: 'rectangle',
    irregular_mask: [],
    bottom_completion: null,
    position_m: [0, 0, 0],
    yaw_deg: 0,
    height_offset_mm: 0,
    normal_flip: false,
    origin_aligned: false,
  };
}

/* 重建记录 · 求解状态 / 箱体质量三通道 — single source: api/visualSolveUi */

Object.assign(window, {
  GRID_SHAPES, GRID_SCREEN_TYPES, GRID_SCREEN_PRESETS, GRID_CAB_PRESETS, GRID_DISPLAY_DEFAULT, GRID_DISPLAY_ITEMS,
  GRID_VIEWS, GRID_STAGE_ACTIONS, GRID_MEAS_TYPES, GRID_RECON_STAGES, GRID_EXPORT_TARGETS,
  GRID_CAB_QUALITY, GRID_SOLVE_STATUS,
  buildStageComposite, buildStageNdisplayTopo, resolveProjectTopology, stageScreenForOutput,
  Icon, STAGES, PAGES,
  /* machines / creds / shares / projects are loaded from the backend by the
     shell and mirrored onto window.{RENDER_NODES,CREDS,SHARES,UE_PROJECTS};
     presentation maps (NODE_STATUS/…/DDC_BACKENDS) live in api/uiConfig；
     health/ini/cluster 经 shell 镜像 window.{HEALTH_CHECKS,INI_FINDINGS,CLUSTER}。
     Cache 域已无 mock；Calibrate 域 LED-M1 主路径已接真实数据（CAL_SCREENS 等已删）。 */
  /* 校正板块（新 IA）：三通道状态映射表 */
  CAL_NAV_STATUS, CAL_GRID_STATUS, CAL_LENS_STATUS, CAL_CONF,
  M2_PATTERN, M2_MANIFEST, M2_INTRINSICS, M2_RECONSTRUCT, M2_QUALITY,
  FUSE_RESULT, FUSE_SOURCE, PROVENANCE,
  /* AR 舞台校正：三通道状态映射表 */
  AR_GRADE, AR_CONF, AR_WS_STATUS,
});

export { Icon, STAGES, PAGES };
