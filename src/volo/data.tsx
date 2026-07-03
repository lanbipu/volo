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
/* CAL_SCREENS / CAL_POINTS / SURVEY_REPORT / CAL_RUNS / MESH_METRICS removed
   (W2: Calibrate M1 接线) — 屏幕/测量点/导入报告/重建历史/网格质量指标均已
   接真实 Tauri command（见 pages/calibrate.tsx 的 projStore + api/meshCommands），
   不再需要 mock。CAL_STEPS（还被 shell.tsx 的 calStep 默认值读取）与 LENS_STAGES
   （LensPanel 的 4 阶段进度条仍读它）保留。 */

/* mesh-reconstruct steps + lens（capture 步为 Claude Design 新增：实时采集） */
const CAL_STEPS = [
  { id: 'design',  n: 1, label: 'Design',  cn: '网格设计', icon: 'grid',   group: 'mesh', status: 'done' },
  { id: 'method',  n: 2, label: 'Method',  cn: '重建方法', icon: 'tools',  group: 'mesh', status: 'done' },
  { id: 'survey',  n: 3, label: 'Survey',  cn: '测量导入', icon: 'pin',    group: 'mesh', status: 'done' },
  { id: 'capture', n: 4, label: 'Capture', cn: '实时采集', icon: 'live',   group: 'mesh', status: 'ready' },
  { id: 'preview', n: 5, label: 'Preview', cn: '网格预览', icon: 'cube',   group: 'mesh', status: 'active' },
  { id: 'runs',    n: 6, label: 'Runs',    cn: '重建历史', icon: 'list',   group: 'mesh', status: 'ready' },
  { id: 'lens',    n: 7, label: 'Lens',    cn: '镜头校正', icon: 'camera', group: 'lens', status: 'pending' },
];

/* lens solve stages */
const LENS_STAGES = [
  { id: 'validate', n: 1, label: 'Validate', cn: '校验',  status: 'done' },
  { id: 'detect',   n: 2, label: 'Detect',   cn: '检测',  status: 'done' },
  { id: 'solve',    n: 3, label: 'Solve',    cn: '求解',  status: 'pending' },
  { id: 'report',   n: 4, label: 'Report',   cn: '报告',  status: 'pending' },
];

/* ============================================================
   CALIBRATE 增量常量（Claude Design handoff）—— 实时采集 / AR 分支 /
   LED 增量（Lens 报告 / Survey M2 / 融合）。这些是 1:1 移植的视图初值 / 演示
   数据；接真后端的段（Player / M2 / Fuse / vpcal Lens·AR）在渲染时由各模块用
   真实结果覆盖，纯展示段（如 report diff / session 构建器）保留为设计初值。
   字段名对齐后端 DTO（snake_case），供 pages/calCapture·calAr·calLedExt 以裸全局取用。
   ============================================================ */

/* ---- 实时采集（Capture） ---- */
const CAP_VIDEO_BACKENDS = [
  { id: 'uvc',       label: 'UVC 摄像头',   avail: true,  note: '即插即用 · /dev/video 或 DirectShow' },
  { id: 'ndi',       label: 'NDI',          avail: false, note: '需本地 NDI 运行时，查看指引' },
  { id: 'decklink',  label: 'DeckLink SDI', avail: false, note: '需本地 DeckLink SDK，查看指引' },
  { id: 'synthetic', label: '合成测试源',   avail: true,  note: '内置图案发生器 · 无需硬件' },
];
const CAP_TRACK_LINK = {
  connected: { label: '已连接', tone: 'positive', icon: 'check' },
  waiting:   { label: '等待数据', tone: 'notice',  icon: 'sync' },
  lost:      { label: '信号丢失', tone: 'negative', icon: 'x' },
};
const CAP_TRACK_PROTOCOLS = [
  { id: 'freed',       label: 'FreeD' },
  { id: 'opentrackio', label: 'OpenTrackIO' },
];
const CAP_STATES = [
  { id: 'wait_tracking', label: '等待追踪信号…',      tone: 'notice',      icon: 'sync',   sub: '检查追踪设备与 UDP 端口' },
  { id: 'moving',        label: '移动到下一机位',     tone: 'informative', icon: 'arrowr', sub: '把相机对准 LED 墙，缓慢就位', dir: true },
  { id: 'settling',      label: '保持静止…',          tone: 'notice',      icon: 'target', sub: '静止约 0.3 秒即触发采集', settle: true },
  { id: 'capturing',     label: '采集中，别动',       tone: 'negative',    icon: 'camera', sub: '连拍中 · 反相双帧', pulse: true },
  { id: 'wait_move',     label: '本机位完成 · 请移动', tone: 'positive',    icon: 'check',  sub: '差分成功，可移动到下一机位' },
];
const CAP_POSES = [
  { pose_index: 1, marker_hits: 15, mean_confidence: 0.94, differenced: true,  inverted_captured: true,  position_mm: [-1820, 1420, 3160] },
  { pose_index: 2, marker_hits: 14, mean_confidence: 0.91, differenced: true,  inverted_captured: true,  position_mm: [-640,  1460, 3020] },
  { pose_index: 3, marker_hits: 12, mean_confidence: 0.86, differenced: true,  inverted_captured: true,  position_mm: [520,   1440, 3080] },
  { pose_index: 4, marker_hits: 0,  mean_confidence: null, differenced: false, inverted_captured: false, position_mm: [1680,  1400, 3210] },
  { pose_index: 5, marker_hits: 13, mean_confidence: 0.88, differenced: true,  inverted_captured: true,  position_mm: [1720,  240,  3040] },
];
const CAP_COVERAGE = {
  poses_captured: 5,
  sensor_coverage_pct: 78,
  sensor_missing_regions: ['左上', '右下'],
  sensor_grid: [
    [false, true,  true],
    [true,  true,  true],
    [true,  true,  false],
  ],
  screen_markers_seen: 14,
  screen_markers_total: 16,
  screen_coverage_pct: 87,
  pose_spatial_spread_mm: 3540,
  suggestions: [
    { tone: 'notice',   msg: '画面左上 / 右下未覆盖，建议补两个机位' },
    { tone: 'positive', msg: '屏幕 marker 覆盖达标（≥85%）' },
  ],
};
const CAP_WARNINGS = [
  { t: '14:22:31', msg: 'pose 4 无追踪配对，已丢弃' },
  { t: '14:22:08', msg: '追踪流短暂丢失（0.4s），已恢复' },
];
const CAP_RESULT = {
  poses_captured: 8,
  session_dir: 'D:\\Volo\\sessions\\2026-07-03_1422_capture',
  lens_ready: true,
  marker_total_hits: 112,
  rms: 0.47,
};
const CAP_PLAYER = {
  monitors: [
    { index: 1, name: 'DELL U2723QE', width: 3840, height: 2160, is_primary: true },
    { index: 2, name: 'LED-PROC HDMI', width: 1920, height: 1080, is_primary: false },
  ],
  pattern_width: 1920, pattern_height: 1080,
  window_width: 3840, window_height: 2160,
  resolution_mismatch: true,
  graycode_confirmed: true,
};
const CAP_OUTPUT_STATES = {
  black:    { label: '黑场',     tone: 'neutral' },
  normal:   { label: 'normal',   tone: 'informative' },
  inverted: { label: 'inverted', tone: 'notice' },
};

/* ---- AR 分支（stage_type = "ar"） ---- */
const AR_MARKER_MAPS = [
  { id: 'floor', name: 'StageFloor · Vicon', markers: 42, grade: 'millimetre', source: '全站仪实测', uncertainty_mm: 0.8 },
  { id: 'cubeA', name: '标定立方体 · Origin-A', markers: 5, grade: 'coarse', source: '制造公差', uncertainty_mm: 3.5 },
];
const AR_GRADE = {
  millimetre: { label: 'millimetre', tone: 'positive', icon: 'check' },
  centimetre: { label: 'centimetre', tone: 'notice',   icon: 'alert' },
  coarse:     { label: 'coarse',     tone: 'notice',   icon: 'alert' },
  'n/a':      { label: 'n/a',        tone: 'neutral',  icon: 'minus' },
};
const AR_STEPS = [
  { id: 'markers', n: 1, label: 'Markers', cn: '真值导入', icon: 'pin',    group: 'space',  status: 'done' },
  { id: 'lens',    n: 2, label: 'Lens',    cn: '镜头校正', icon: 'camera', group: 'space',  status: 'done' },
  { id: 'spatial', n: 3, label: 'Spatial', cn: '空间求解', icon: 'cube',   group: 'space',  status: 'active' },
  { id: 'delay',   n: 4, label: 'Delay',   cn: '延迟校准', icon: 'pulse',  group: 'ready',  status: 'ready' },
  { id: 'verify',  n: 5, label: 'Verify',  cn: '验证叠加', icon: 'eye',    group: 'ready',  status: 'ready' },
  { id: 'runs',    n: 6, label: 'Runs',    cn: '历史与导出', icon: 'list',  group: 'ready',  status: 'ready' },
];
const AR_OVERVIEW = { spatial_rms_px: 0.58, delay_ms: 39.6, delay_sigma: 1.2, verify_rms_px: 0.71, status: 'healthy' };
const AR_SPATIAL = {
  reprojection_rms_px: 0.58, validation_rms_px: 0.71, confidence: 'high',
  observations: 1840, poses: 32, inliers: 1788, outliers: 52,
  detected_markers: 40, unknown_markers: 1, map_markers_never_detected: [7, 19],
  marker_coverage: { percentage: 88, missing: ['id 7', 'id 19'] },
  handeye: { closed_form_applied: true, axis_spread: 0.42, prior_diff_mm: 6.2, prior_diff_deg: 0.9, warn: false },
};
const AR_MARKERS = {
  total: 42, detectable: 40, on_ground: 12, warnings: 1,
  span_mm: 8420, collinearity_ratio: 0.06, grade: 'millimetre',
  ground: { residual_rms_mm: 1.8, tilt_from_z_deg: 0.28, offset_from_z0_mm: 2.1, over: true },
  list: [
    { id: 0,  dict: 'AprilTag 36h11', on_ground: true,  uncertainty_mm: 0.7, survey_source: 'total_station', corners: [[-4020, 0, 3110], [-3820, 0, 3110], [-3820, 0, 2910], [-4020, 0, 2910]] },
    { id: 3,  dict: 'AprilTag 36h11', on_ground: true,  uncertainty_mm: 0.8, survey_source: 'total_station', corners: [[-1810, 0, 3120], [-1610, 0, 3120], [-1610, 0, 2920], [-1810, 0, 2920]] },
    { id: 7,  dict: 'AprilTag 36h11', on_ground: false, uncertainty_mm: 1.4, survey_source: 'cube_fab',      corners: [[240, 1420, 3080], [440, 1420, 3080], [440, 1420, 2880], [240, 1420, 2880]] },
    { id: 12, dict: 'AprilTag 36h11', on_ground: true,  uncertainty_mm: 0.9, survey_source: 'total_station', corners: [[1680, 0, 3060], [1880, 0, 3060], [1880, 0, 2860], [1680, 0, 2860]] },
    { id: 19, dict: 'AprilTag 36h11', on_ground: false, uncertainty_mm: 2.9, survey_source: 'cube_fab',      corners: [[1720, 240, 3040], [1920, 240, 3040], [1920, 240, 2840], [1720, 240, 2840]] },
  ],
};
const AR_LENS = { reprojection_rms_px: 0.42, validation_rms_px: 0.55, quick_estimate: true };
const AR_LENS_STAGES = [
  { id: 'validate', n: 1, label: 'Validate', cn: '校验', status: 'done' },
  { id: 'detect',   n: 2, label: 'Detect',   cn: '检测', status: 'done' },
  { id: 'solve',    n: 3, label: 'Solve',    cn: '求解', status: 'done' },
  { id: 'report',   n: 4, label: 'Report',   cn: '报告', status: 'done' },
];
const AR_CONF = {
  high:      { label: 'high',      tone: 'positive',    pct: 92 },
  medium:    { label: 'medium',    tone: 'notice',      pct: 66 },
  low:       { label: 'low',       tone: 'notice',      pct: 40 },
  very_low:  { label: 'very_low',  tone: 'negative',    pct: 16 },
};
const AR_DELAY = {
  delay_ms: 39.6, sigma_ms: 1.2, confidence: 0.94, num_markers: 38, num_frames: 210,
  suggestion: '在合成引擎设置 tracking delay = +39.6 ms',
};
const AR_VERIFY = {
  global_rms_px: 0.71, global_max_px: 2.4, frames: 24, points: 1520,
  markers: [
    { marker_id: 7,  count: 40, mean_px: 1.94, max_px: 3.42 },
    { marker_id: 19, count: 32, mean_px: 1.38, max_px: 2.61 },
    { marker_id: 12, count: 96, mean_px: 0.62, max_px: 1.81 },
    { marker_id: 3,  count: 88, mean_px: 0.54, max_px: 1.44 },
    { marker_id: 0,  count: 84, mean_px: 0.49, max_px: 1.22 },
  ],
};
const AR_RUNS = [
  { id: 'ar3', time: '今天 13:40', map: 'StageFloor', rms: 0.58, val_rms: 0.71, confidence: 'high',     delay: 39.6 },
  { id: 'ar2', time: '昨天 18:20', map: 'StageFloor', rms: 0.74, val_rms: 0.92, confidence: 'medium',   delay: 38.9 },
  { id: 'ar1', time: '昨天 09:12', map: 'Origin-A',   rms: null, val_rms: null, confidence: 'very_low', delay: null },
];
const AR_TRACKER_BACKFILL = {
  world_frame: 'vicon', rotation_convention: 'XYZ intrinsic · deg',
  camera: { x: 12.4, y: -3.1, z: 88.7, pan: 0.42, tilt: -1.08, roll: 0.03 },
  world:  { x: -1840.2, y: 2.4, z: 1420.9, pan: 179.62, tilt: 0.08, roll: -0.22 },
};

/* ---- LED 增量：Lens 完整报告 / Session 构建器 ---- */
const LENS_RESULT = {
  tracker_to_stage: {
    translation: [0.284, -1.902, 3.418],
    rotation: [0.99863, 0.01230, -0.04810, 0.01772],
    matrix_4x4: [
      [0.99507, -0.03620, 0.09201, 0.284],
      [0.03498, 0.99927, 0.01490, -1.902],
      [-0.09248, -0.01161, 0.99565, 3.418],
      [0, 0, 0, 1],
    ],
    euler_deg: [0.61, -5.28, 2.07],
  },
  quality: {
    reprojection_rms_px: 0.62, total_observations: 2040, inlier_observations: 1974,
    outlier_ratio: 0.032, num_poses: 34, confidence: 'high',
    validation_rms_px: 0.78, validation_observations: 408,
  },
  qa: { reprojection: { global_mean_px: 0.59 } },
  handeye: { closed_form_mm: [12.4, -3.1, 88.7], prior_input_mm: [10.0, 0.0, 90.0], diff_mm: 6.2, diff_deg: 0.9, degenerate: false },
  coverage: { percentage: 82, suggest_regions: ['右上', '左下'] },
  qle: true,
};
const LENS_HISTORY = [
  { id: 'l3', time: '今天 13:40', trans: [0.284, -1.902, 3.418], rot_deg: [0.61, -5.28, 2.07], rms: 0.62, val: 0.78 },
  { id: 'l2', time: '昨天 18:10', trans: [0.281, -1.898, 3.421], rot_deg: [0.52, -5.19, 1.98], rms: 0.71, val: 0.90 },
  { id: 'l1', time: '昨天 09:32', trans: [0.276, -1.910, 3.402], rot_deg: [0.70, -5.44, 2.21], rms: 0.94, val: 1.30 },
];
const LENS_SESSION = {
  camera:   { ready: true,  label: '内参来源', value: 'ChArUco 自标定 · rms 0.34px' },
  tracking: { ready: true,  label: '追踪', value: 'FreeD · UDP 6301' },
  screen:   { ready: true,  label: '屏幕', value: '引用 Design · 主屏 · 前墙' },
  lens:     { ready: false, label: '镜头先验', value: '未提供（可后补）' },
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

/* ---- 项目上下文 chip + Preview 顶点来源图例 ---- */
const CAL_PROJECTS = [
  { id: 'helios', name: 'Helios — Ep.204', path: 'D:\\Projects\\Helios\\project.yaml', last: '今天 13:32' },
  { id: 'aurora', name: 'Aurora_Trailer',  path: 'D:\\Projects\\Aurora\\project.yaml', last: '昨天 20:14' },
  { id: 'nomad',  name: 'Nomad_Test',      path: 'E:\\UEProjects\\Nomad\\project.yaml', last: '昨天 18:52' },
];
const PROVENANCE = {
  measured:     { label: 'measured 实测',     tone: 'positive',    dot: 'rgba(70,200,130,.9)' },
  interpolated: { label: 'interpolated 插值', tone: 'informative', dot: 'rgba(120,180,255,.85)' },
  extrapolated: { label: 'extrapolated 外推', tone: 'notice',      dot: 'rgba(255,150,40,.95)' },
};

Object.assign(window, {
  Icon, STAGES, PAGES,
  /* machines / creds / shares / projects are loaded from the backend by the
     shell and mirrored onto window.{RENDER_NODES,CREDS,SHARES,UE_PROJECTS};
     presentation maps (NODE_STATUS/…/DDC_BACKENDS) live in api/uiConfig；
     health/ini/cluster 经 shell 镜像 window.{HEALTH_CHECKS,INI_FINDINGS,CLUSTER}。
     Cache 域已无 mock；Calibrate 域 LED-M1 主路径已接真实数据（CAL_SCREENS 等已删）。 */
  CAL_STEPS, LENS_STAGES,
  /* Claude Design 增量常量（实时采集 / AR / LED 增量）—— 供 calCapture / calAr /
     calLedExt 以裸全局取用；接真后端的段在渲染时由各模块覆盖为真实结果。 */
  CAP_VIDEO_BACKENDS, CAP_TRACK_LINK, CAP_TRACK_PROTOCOLS, CAP_STATES, CAP_POSES,
  CAP_COVERAGE, CAP_WARNINGS, CAP_RESULT, CAP_PLAYER, CAP_OUTPUT_STATES,
  AR_MARKER_MAPS, AR_GRADE, AR_STEPS, AR_OVERVIEW, AR_SPATIAL, AR_MARKERS, AR_LENS,
  AR_LENS_STAGES, AR_CONF, AR_DELAY, AR_VERIFY, AR_RUNS, AR_TRACKER_BACKFILL,
  LENS_RESULT, LENS_HISTORY, LENS_SESSION,
  M2_PATTERN, M2_MANIFEST, M2_INTRINSICS, M2_RECONSTRUCT, M2_QUALITY,
  FUSE_RESULT, FUSE_SOURCE, CAL_PROJECTS, PROVENANCE,
});

export { Icon, STAGES, PAGES };
