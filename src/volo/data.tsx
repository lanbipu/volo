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
  info:     '<circle cx="10" cy="10" r="7.5"/><circle cx="10" cy="6.5" r=".9" fill="currentColor" stroke="none"/><path d="M10 9.5v5"/>',
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
  wrestore: '<rect x="6.5" y="4" width="9" height="9" rx="1"/><path d="M4.5 7.5v8h8v-8z"/>',
  /* --- added for cache redesign --- */
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

/* ARTIFACTS removed — PSO 列表改用真实 list_pso_cache_files（cacheDdc psoFiles，
   按选中工程加载）；DDC pak 列表后端无「列举产物」命令（只有 generate/verify/distribute
   单产物），UI 也无 pak 列表（只按工程 verify_pak_output），故整条 mock 移除。 */

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

Object.assign(window, {
  Icon, STAGES, PAGES,
  /* machines / creds / shares / projects are loaded from the backend by the
     shell and mirrored onto window.{RENDER_NODES,CREDS,SHARES,UE_PROJECTS};
     presentation maps (NODE_STATUS/…/DDC_BACKENDS) live in api/uiConfig；
     health/ini/cluster 经 shell 镜像 window.{HEALTH_CHECKS,INI_FINDINGS,CLUSTER}。
     Cache 域已无 mock；下列仅 Calibrate/Mesh 域。 */
  CAL_SCREENS, CAL_STEPS, CAL_POINTS, SURVEY_REPORT, CAL_RUNS, MESH_METRICS, LENS_STAGES,
});

export { Icon, STAGES, PAGES };
