// @ts-nocheck
/* Volo — app shell (chrome + state + page-slot composition).
   1:1 port of the Claude Design handoff `src/shell.jsx`. The IIFE publishes
   App / Selector / CtxTitle / Stat onto `window`; we re-export App below. */
import * as React from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import "./ds";
import { loadCacheResources } from "./api/cacheData";
import { isTauri, VoloInvokeError } from "./api/invoke";

(function () {
const { useState, useRef, useEffect } = React;
const { Button } = window.Spectrum2DesignSystem_b6d1b3;
const h = React.createElement;

/* Windows 自绘标题栏的窗口控制（原生标题栏已 set_decorations(false) 关掉）。
   在浏览器预览（vite :1420，无 Tauri runtime）下 getCurrentWindow() 会抛 —— 静默兜底。 */
function winCtl(action) {
  try {
    const w = getCurrentWindow();
    // 既兜底浏览器预览的同步抛错（getCurrentWindow），也兜底 Tauri 内 IPC 的异步
    // reject（否则冒成 uncaught promise rejection）。
    if (action === 'min') w.minimize().catch(() => {});
    else if (action === 'max') w.toggleMaximize().catch(() => {});
    else if (action === 'close') w.close().catch(() => {});
  } catch (e) { /* 非 Tauri 环境（浏览器预览）忽略 */ }
}

/* drag-to-resize: axis 'x'|'y', dir +1/-1, captures startVal at pointerdown */
function startResize(e, axis, dir, startVal, setVal, min, max) {
  e.preventDefault();
  const startPos = axis === 'x' ? e.clientX : e.clientY;
  const onMove = (ev) => {
    const cur = axis === 'x' ? ev.clientX : ev.clientY;
    let v = startVal + dir * (cur - startPos);
    v = Math.max(min, Math.min(max, v));
    setVal(Math.round(v));
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.body.style.webkitUserSelect = '';
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
  document.body.style.userSelect = 'none';
  document.body.style.webkitUserSelect = 'none'; // WKWebView (macOS) ignores bare user-select
}

/* CLUSTER 概况派生（替代旧 mock）：online/total 从机器数、health 从健康检查结果、
   lastRun/lastRunAgo 从最近一次巡检完成时间。 */
function formatRunTime(raw) {
  if (!raw) return { lastRun: '—', lastRunAgo: '从未巡检' };
  /* SQLite CURRENT_TIMESTAMP 是 UTC 空格分隔、无时区 → 补 'Z' 当 UTC 解析 */
  const hasTz = /[zZ]$|[+\-]\d\d:?\d\d$/.test(String(raw));
  const d = new Date(String(raw).replace(' ', 'T') + (hasTz ? '' : 'Z'));
  if (isNaN(d.getTime())) return { lastRun: String(raw), lastRunAgo: '' };
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const diff = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
  const ago = diff < 1 ? '刚刚' : diff < 60 ? (diff + ' 分钟前') : diff < 1440 ? (Math.round(diff / 60) + ' 小时前') : (Math.round(diff / 1440) + ' 天前');
  return { lastRun: hh + ':' + mm, lastRunAgo: ago };
}
function deriveCluster(machines, health, runAt) {
  const cluster = (machines || []).filter((n) => n.roleKey !== 'shared');
  const total = cluster.length;
  const online = cluster.filter((n) => n.status !== 'offline').length;
  let score = null;
  if (health && health.length) {
    const scored = health.filter((c) => c.status !== 'na');
    score = scored.length ? Math.round((100 * scored.filter((c) => c.status === 'healthy').length) / scored.length) : 100;
  }
  const t = formatRunTime(runAt);
  return { online, total, health: score, lastRun: t.lastRun, lastRunAgo: t.lastRunAgo };
}

/* 默认平台跟随运行 OS（仅在无持久化偏好时）；可在 Tweaks 手动覆盖 */
function detectPlatform() {
  try {
    const s = (navigator.userAgent || '') + ' ' + ((navigator as any).platform || '');
    return /Win/i.test(s) ? 'win' : 'mac';
  } catch (e) { return 'mac'; }
}

/* ---------- Generic selector / popover ---------- */
function Selector({ kpre, value, options, onChange, width = 188, variant = 'obj' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  /* fall back to a placeholder when the option list is empty (real backend data
     can yield empty pools — e.g. no credentials, or a project with no online
     source machines — where the mock always had entries). Prevents cur.label
     crashing the render. */
  const cur = options.find((o) => o.id === value) || options[0] || { id: value, label: '—' };
  const cls = variant === 'stage' ? 'stage-switch' : 'obj-sel';
  return React.createElement('div', { ref, style: { position: 'relative' } },
    React.createElement('div', { className: cls, style: variant === 'obj' ? { minWidth: width } : null, onClick: () => setOpen((v) => !v) },
      variant === 'stage' && cur.pip ? React.createElement('span', { className: 'pip', style: { background: `var(--${cur.pip}-visual)`, boxShadow: 'none' } }) : null,
      React.createElement('div', { className: variant === 'stage' ? 'lbl' : 'col' },
        React.createElement('span', { className: 'k' }, kpre),
        React.createElement('span', { className: 'v' }, cur.label)),
      React.createElement('span', { className: 'chev', style: { marginLeft: 'auto', display: 'flex' } }, React.createElement(Icon, { name: 'chevd', size: 15 }))),
    open ? React.createElement('div', { className: 'popover' },
      options.map((o) => React.createElement('div', {
        key: o.id, className: 'pop-i' + (o.id === cur.id ? ' on' : ''),
        onClick: () => { onChange && onChange(o.id); setOpen(false); },
      },
        o.pip ? React.createElement('span', { className: 'pop-pip', style: { background: `var(--${o.pip}-visual)` } }) : null,
        React.createElement('div', { style: { display: 'flex', flexDirection: 'column', lineHeight: 1.2 } },
          React.createElement('span', { className: 'pop-l' }, o.label),
          o.sub ? React.createElement('span', { className: 'pop-s' }, o.sub) : null),
        o.id === cur.id ? React.createElement('span', { style: { marginLeft: 'auto', color: 'var(--volo-500)', display: 'flex' } }, React.createElement(Icon, { name: 'check', size: 15 })) : null)))
      : null);
}

/* ---------- shared chrome bits ---------- */
const APP_MENUS = ['文件', '编辑', '视图', '舞台', '渲染', '现场', '窗口', '帮助'];
const SyncPip = () => h('span', { className: 'pip', style: { width: 7, height: 7, borderRadius: '50%', background: 'var(--positive-visual)' } });
function PlatformToggle({ s }) {
  return h('div', { className: 'plat-seg', title: '平台外观' },
    h('button', { className: s.platform === 'mac' ? 'on' : '', onClick: () => s.setPlatform('mac') }, 'Mac'),
    h('button', { className: s.platform === 'win' ? 'on' : '', onClick: () => s.setPlatform('win') }, 'Win'));
}
function ChromeIconButtons({ s }) {
  return h(React.Fragment, null,
    h('button', { className: 'iconbtn', title: '切换主题', onClick: s.toggleTheme }, h(Icon, { name: s.theme === 'dark' ? 'sun' : 'moon', size: 17 })));
}
/* panel toggle — show/hide the persistent task drawer (right column) */
function DrawerToggle({ s, style }) {
  return h('button', {
    className: 'paneltgl' + (!s.rightCollapsed ? ' on' : ''),
    title: s.rightCollapsed ? '显示任务抽屉' : '隐藏任务抽屉',
    style,
    onClick: () => s.setRightCollapsed((v) => !v),
  }, h(Icon, { name: 'list', size: 15 }), h('span', null, '任务抽屉'));
}

/* ---------- macOS system menu bar (outside the app window) ---------- */
function SysBar({ s }) {
  return h('div', { className: 'sysbar', 'data-tauri-drag-region': true },
    h('div', { className: 'brand-mark', style: { width: 16, height: 16, fontSize: 10, borderRadius: 4 } }, 'V'),
    h('span', { className: 'sys-app' }, 'Volo'),
    h('div', { className: 'sys-menus' }, APP_MENUS.map((m) => h('span', { key: m, className: 'sys-menu' }, m))),
    h('div', { className: 'sys-right' },
      h('span', null, '节点 6/8'),
      h('span', { className: 'clock' }, '14:22')));
}

/* ---------- macOS in-window title bar (traffic lights, no menus) ---------- */
function MacTitleBar({ s }) {
  return h('div', { className: 'titlebar', 'data-tauri-drag-region': true },
    /* 原生交通灯由 Tauri titleBarStyle:Overlay 提供（trafficLightPosition 13/20），
       不再渲染浏览器原型的自定义 .traffic，避免与原生关闭/最小化/放大按钮重复。
       面包屑 DocCrumb 与「当前舞台」Selector 已移除，左侧留给原生交通灯 + 拖拽区 */
    h('div', { className: 'right' },
      h('span', { className: 'conn' }, h(SyncPip), '同步 23.976'),
      h('span', { className: 'conn' }, s.cluster.total + ' 节点 · ' + s.cluster.online + ' 在线'),
      h(ChromeIconButtons, { s })));
}

/* ---------- Windows top menu/title bar — menus at the very top (row 1) ---------- */
function WinTopBar({ s }) {
  return h('div', { className: 'win-topbar', 'data-tauri-drag-region': true },
    h('div', { className: 'wt-left', 'data-tauri-drag-region': true },
      h('div', { className: 'brand-mark', style: { width: 18, height: 18, fontSize: 11, borderRadius: 5 } }, 'V'),
      h('span', { className: 'brand-name' }, 'Volo')),
    h('div', { className: 'wt-menus', 'data-tauri-drag-region': true }, APP_MENUS.map((m) => h('div', { key: m, className: 'menu-item' }, m))),
    h('div', { className: 'wt-right' },
      /* 「当前舞台」Selector 已移除 */
      h(ChromeIconButtons, { s }),
      /* 原生标题栏已在 Windows 关闭（src-tauri set_decorations(false)），由这套自绘
         winctl 接管最小化/最大化/关闭，调 Tauri window API（winCtl）。与 mac 的
         Overlay 原生交通灯对称 —— 各平台都只有一条标题栏。 */
      h('div', { className: 'winctl' },
        h('button', { className: 'wc-min', title: '最小化', onClick: () => winCtl('min') }, h(Icon, { name: 'wmin', size: 16 })),
        /* id="snap-btn" 让 tauri-plugin-snap-layout 在此按钮上叠透明 child HWND，
           还原 Win11 Snap Layouts + 接管点击（最大化/还原）。Windows 上点击走该
           overlay，此 onClick 仅浏览器预览 / 非 Windows 生效；图标 + 标题随
           s.maximized 切换（App 订阅窗口 onResized 更新），最大化时显示「还原」。 */
        h('button', { id: 'snap-btn', className: 'wc-max', title: s.maximized ? '还原' : '最大化', onClick: () => winCtl('max') }, h(Icon, { name: s.maximized ? 'wrestore' : 'wmax', size: 14 })),
        h('button', { className: 'wc-close', title: '关闭', onClick: () => winCtl('close') }, h(Icon, { name: 'x', size: 15 })))));
}

/* ---------- Page tabs ---------- */
function PageTabs({ s }) {
  return React.createElement('div', { className: 'pagetabs' },
    PAGES.map((p) => React.createElement('div', {
      key: p.id, className: 'ptab' + (p.id === s.page ? ' on' : ''), onClick: () => s.setPage(p.id),
    },
      React.createElement('span', { className: 'pico' }, React.createElement(Icon, { name: p.icon, size: 17 })),
      p.label,
      p.skeleton ? React.createElement('span', { className: 'skl' }, 'WIP') : null)),
    React.createElement('div', { className: 'meta' },
      React.createElement('span', { className: 'sdot bg-' + (s.cluster.health == null ? 'neutral' : s.cluster.health >= 85 ? 'positive' : s.cluster.health >= 60 ? 'notice' : 'negative') }),
      React.createElement('span', null, '缓存健康分 ' + (s.cluster.health == null ? '—' : s.cluster.health))));
}

/* ---------- Log panel — NDJSON stream (search · pause · channel) ---------- */
function LogPanel({ s }) {
  const allLogs = s.logs;
  const q = (s.logSearch || '').trim().toLowerCase();
  const strip = (html) => html.replace(/<[^>]+>/g, '');
  const counts = {
    all: allLogs.length,
    info: allLogs.filter((l) => l.lv === 'info' || l.lv === 'ok').length,
    warn: allLogs.filter((l) => l.lv === 'warn').length,
    err: allLogs.filter((l) => l.lv === 'err').length,
  };
  const byLevel = allLogs.filter((l) =>
    s.logFilter === 'all' ? true :
    s.logFilter === 'info' ? (l.lv === 'info' || l.lv === 'ok') :
    s.logFilter === 'warn' ? l.lv === 'warn' : l.lv === 'err');
  const rows = q ? byLevel.filter((l) => strip(l.msg).toLowerCase().includes(q) || (l.cat || '').includes(q) || (l.ch || '').includes(q)) : byLevel;
  const tabs = [['all', '全部'], ['info', '信息'], ['warn', '警告'], ['err', '错误']];
  const running = s.tasks ? s.tasks.filter((t) => t.state === 'running').length : 0;
  return React.createElement('div', { className: 'logpanel' },
    s.logOpen ? React.createElement('div', {
      className: 'resizer resizer--row',
      title: '拖动调整高度',
      onPointerDown: (e) => startResize(e, 'y', -1, s.logH, s.setLogH, 90, 440),
    }) : null,
    React.createElement('div', { className: 'log-head', onClick: (e) => { if (e.target.closest('.log-tab') || e.target.closest('.log-tools')) return; s.setLogOpen((v) => !v); } },
      React.createElement('span', { className: 'ttl' }, React.createElement(Icon, { name: 'terminal', size: 15 }), '控制台',
        React.createElement('span', { className: 'ndjson-tag' }, 'NDJSON')),
      React.createElement('div', { className: 'log-tabs' },
        tabs.map(([id, lbl]) => React.createElement('div', {
          key: id, className: 'log-tab' + (s.logFilter === id ? ' on' : ''),
          onClick: () => { s.setLogFilter(id); s.setLogOpen(true); },
        }, lbl, React.createElement('span', { className: 'n' }, counts[id])))),
      React.createElement('div', { className: 'right log-tools' },
        React.createElement('div', { className: 'log-search' },
          React.createElement(Icon, { name: 'search', size: 13 }),
          React.createElement('input', {
            value: s.logSearch || '', placeholder: '搜索流…',
            onChange: (e) => { s.setLogSearch(e.target.value); s.setLogOpen(true); },
            onClick: (e) => e.stopPropagation() })),
        React.createElement('button', {
          className: 'log-pause' + (s.logPaused ? ' on' : ''), title: s.logPaused ? '已暂停 — 点击恢复' : '暂停自动滚动',
          onClick: (e) => { e.stopPropagation(); s.setLogPaused((v) => !v); } },
          React.createElement(Icon, { name: s.logPaused ? 'play' : 'pause', size: 13 }), s.logPaused ? '已暂停' : '实时'),
        React.createElement('span', { className: 'rec-dot', style: { width: 7, height: 7, background: running ? 'var(--volo-600)' : 'var(--positive-visual)', animationPlayState: s.logPaused ? 'paused' : 'running' } }),
        running ? React.createElement('span', { style: { fontSize: 11, color: 'var(--volo-400)', fontWeight: 700 } }, running + ' 运行中') : null,
        React.createElement('button', { className: 'iconbtn', style: { width: 22, height: 22 } }, React.createElement(Icon, { name: s.logOpen ? 'chevd' : 'chevr', size: 15, style: { transform: s.logOpen ? 'rotate(180deg)' : 'none' } })))),
    s.logOpen ? React.createElement('div', { className: 'log-body' + (s.logPaused ? ' paused' : ''), style: { height: s.logH } },
      rows.length === 0 ? React.createElement('div', { className: 'log-empty' }, q ? `无匹配「${s.logSearch}」的流` : '暂无日志')
        : rows.map((l, i) => React.createElement('div', { key: i, className: 'log-row' },
        React.createElement('span', { className: 'ts' }, l.ts),
        React.createElement('span', { className: 'lv ' + l.lv }, l.lv === 'ok' ? 'OK' : l.lv.toUpperCase()),
        React.createElement('span', { className: 'ch' + (l.ch ? ' ch-' + l.ch : '') }, l.ch ? CHANNEL[l.ch].short : '·'),
        React.createElement('span', { className: 'msg', dangerouslySetInnerHTML: { __html: l.msg } }))))
      : null);
}

/* ---------- App ---------- */
function App() {
  const persisted = (() => { try { return JSON.parse(localStorage.getItem('volo2') || '{}'); } catch (e) { return {}; } })();
  const [theme, setTheme] = useState(() => document.documentElement.getAttribute('data-theme') || 'dark');
  const [platform, setPlatform] = useState(persisted.platform === 'win' || persisted.platform === 'mac' ? persisted.platform : detectPlatform());
  const [density, setDensity] = useState(persisted.density === 'rich' ? 'rich' : 'clean');
  const [toolsNav, setToolsNav] = useState(persisted.toolsNav === 'left' ? 'left' : 'top');
  const [leftW, setLeftW] = useState(typeof persisted.leftW === 'number' ? persisted.leftW : 214);
  const [rightW, setRightW] = useState(typeof persisted.rightW === 'number' ? persisted.rightW : 312);
  const [leftCollapsed, setLeftCollapsed] = useState(!!persisted.leftCollapsed);
  const [rightCollapsed, setRightCollapsed] = useState(!!persisted.rightCollapsed);
  const [logH, setLogH] = useState(typeof persisted.logH === 'number' ? persisted.logH : 150);
  const [page, setPage] = useState(() => PAGES.some((p) => p.id === persisted.page) ? persisted.page : 'tools');
  /* 舞台切换器 / 面包屑已移除，stage state 无消费者，随之删除 */
  const [logOpen, setLogOpen] = useState(persisted.logOpen !== undefined ? persisted.logOpen : true);
  const [logFilter, setLogFilter] = useState('all');
  const [logs, setLogs] = useState([]); /* NDJSON 流 —— 真实命令派发的事件后续批次接入 */
  const [selNode, setSelNode] = useState(persisted.selNode || null);
  /* Cache/UECM read-path resources, loaded from the backend (machines / creds /
     shares). Replaces the former hardcoded RENDER_NODES / CREDS / SHARES mocks. */
  const [machines, setMachines] = useState([]);
  const [shares, setShares] = useState([]);
  /* UE projects (list_projects + locations) — feeds the DDC PAK/PSO views. */
  const [projects, setProjects] = useState([]);
  /* GPU consistency matrix (get_gpu_consistency_matrix) — drives Overview GPU KPI. */
  const [gpuMatrix, setGpuMatrix] = useState(null);
  /* 最近一次健康巡检 / INI 扫描结果（映射成 HEALTH_CHECKS / INI_FINDINGS 形状）。 */
  const [healthChecks, setHealthChecks] = useState([]);
  const [iniFindings, setIniFindings] = useState([]);
  const [healthRunAt, setHealthRunAt] = useState(null);
  const [cacheLoading, setCacheLoading] = useState(true);
  const [cacheError, setCacheError] = useState(null);
  const CACHE_NAVS = ['home', 'ddc_zen', 'ddc_legacy', 'ddc_pak', 'ddc_pso',
    'diag_net', 'diag_sync', 'diag_thm', 'diag_term'];
  const [cacheNav, setCacheNav] = useState(CACHE_NAVS.includes(persisted.cacheNav) ? persisted.cacheNav : 'home');
  const [ddcOpen, setDdcOpen] = useState(persisted.ddcOpen != null ? persisted.ddcOpen : /^ddc_/.test(persisted.cacheNav || ''));
  const [drawer, setDrawer] = useState(null);
  /* task drawer + NDJSON console */
  const [tasks, setTasks] = useState([]);
  const taskSeq = useRef(1);
  const [taskTab, setTaskTab] = useState('active');
  const [logSearch, setLogSearch] = useState('');
  const [logPaused, setLogPaused] = useState(false);
  /* calibrate */
  const [calStep, setCalStep] = useState(CAL_STEPS.some((x) => x.id === persisted.calStep) ? persisted.calStep : 'design');
  const [calScreen, setCalScreen] = useState(persisted.calScreen || 'main');
  const [calMethod, setCalMethod] = useState(persisted.calMethod || 'm1');
  const [calSel, setCalSel] = useState(persisted.calSel || null);
  /* 集群总览：全新设置演示（无机器 → 引导扫描添加）+ 本会话已添加机器标记 */
  const [freshSetup, setFreshSetup] = useState(!!persisted.freshSetup);
  const [machinesAdded, setMachinesAdded] = useState(false);
  /* SSH-key 现场入网：本会话内已确认「已运行入网脚本 + 刷新通过」的机器 */
  const [enrolled, setEnrolled] = useState([]);
  /* 凭据管理（SecretStore）—— 仅共享 DDC 创建/接入用到；从后端 list_credentials 加载 */
  const [creds, setCreds] = useState([]);
  /* 窗口是否最大化 —— Windows 自绘标题栏的最大化按钮据此切「最大化/还原」图标。
     Windows 上点击走 Rust 子类化，React 不参与，故订阅窗口 onResized 反推状态。 */
  const [maximized, setMaximized] = useState(false);

  /* Load the Cache read-path resources (machines / creds / shares) from the
     backend. Drives the three-channel loading/error gate on the Cache page. */
  const reloadCache = React.useCallback(() => {
    setCacheLoading(true);
    setCacheError(null);
    loadCacheResources().then((r) => {
      setMachines(r.machines);
      setCreds(r.creds);
      setShares(r.shares);
      setProjects(r.projects);
      setGpuMatrix(r.gpuMatrix);
      setHealthChecks(r.health);
      setIniFindings(r.ini);
      setHealthRunAt(r.healthRunAt);
      setCacheLoading(false);
    }).catch((e) => {
      setCacheError(e && e.message ? e.message : String(e));
      setCacheLoading(false);
    });
  }, []);
  useEffect(() => { reloadCache(); }, [reloadCache]);

  /* debounce persistence so live drag-resize (leftW/rightW/logH change每帧) doesn't
     JSON.stringify + setItem synchronously on every pointermove frame */
  const persistTimer = useRef(0);
  useEffect(() => {
    clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      try { localStorage.setItem('volo2', JSON.stringify({ page, logOpen, selNode, cacheNav, ddcOpen, calStep, calScreen, calMethod, calSel, platform, density, toolsNav, leftW, rightW, logH, freshSetup, leftCollapsed, rightCollapsed })); } catch (e) {}
    }, 150);
    return () => clearTimeout(persistTimer.current);
  }, [page, logOpen, selNode, cacheNav, ddcOpen, calStep, calScreen, calMethod, calSel, platform, density, toolsNav, leftW, rightW, logH, freshSetup, leftCollapsed, rightCollapsed]);

  /* 禁掉桌面 WebView 的右键菜单（reload / 检查）；calibrate 画布另有本地 preventDefault */
  useEffect(() => {
    const block = (e) => e.preventDefault();
    document.addEventListener('contextmenu', block);
    return () => document.removeEventListener('contextmenu', block);
  }, []);

  /* 跟踪窗口最大化状态（驱动 Windows 自绘最大化/还原按钮图标）。浏览器预览无 Tauri
     runtime，getCurrentWindow() 同步抛错 → try/catch 静默。 */
  useEffect(() => {
    let unlisten;
    try {
      const w = getCurrentWindow();
      const sync = () => w.isMaximized().then(setMaximized).catch(() => {});
      sync();
      w.onResized(sync).then((f) => { unlisten = f; }).catch(() => {});
    } catch (e) { /* 非 Tauri 环境忽略 */ }
    return () => { if (unlisten) unlisten(); };
  }, []);

  const setThemeValue = (v) => {
    setTheme(v);
    document.documentElement.setAttribute('data-theme', v);
    try { localStorage.setItem('volo-theme', v); } catch (e) {}
  };

  const toggleTheme = () => setTheme((t) => {
    const next = t === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('volo-theme', next); } catch (e) {}
    return next;
  });

  const pushLog = (entry) => {
    const d = new Date();
    const ts = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
    setLogs((prev) => [{ ts, ...entry }, ...prev]);
  };
  const pushLogs = (entries) => entries.forEach((e, i) => setTimeout(() => pushLog(e), 60 * i));

  /* runTask — push an async task into the drawer + stream NDJSON to the console */
  const nowHM = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const runTask = ({ domain, action, target, chan = 'winrm', note, lines = [], fail = false }) => {
    const no = taskSeq.current++;
    const id = 't_' + no;
    setTasks((prev) => [{ id, no, domain, action, title: `${domain} ${action}`, state: 'running',
      pct: 4, chan, started: nowHM(), elapsed: '0s', target, note, stream: lines.length > 2 }, ...prev]);
    setTaskTab('active');
    setLogOpen(true);
    const n = Math.max(lines.length, 1);
    lines.forEach((ln, i) => setTimeout(() => {
      pushLog({ lv: ln.lv || 'info', cat: domain, ch: chan, task: no, msg: ln.msg });
      setTasks((prev) => prev.map((t) => t.id === id ? { ...t, pct: Math.min(96, Math.round(((i + 1) / n) * 100)), elapsed: (i + 1) + 's' } : t));
    }, 420 * (i + 1)));
    setTimeout(() => {
      setTasks((prev) => prev.map((t) => t.id === id
        ? { ...t, state: fail ? 'failed' : 'success', pct: 100, elapsed: n + 's', exit: fail ? 2 : 0 } : t));
      pushLog(fail
        ? { lv: 'err', cat: domain, ch: chan, task: no, msg: `<b>${domain} ${action} #${no}</b> 失败 · exit 2` }
        : { lv: 'ok', cat: domain, ch: chan, task: no, msg: `<b>${domain} ${action} #${no}</b> 完成` });
    }, 420 * (n + 1));
  };

  /* escape untrusted text before it reaches a task/log msg (LogPanel renders msg
     via dangerouslySetInnerHTML). Our own `<b>` wrappers are added outside esc. */
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>]/g, (c) => c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;');

  /* runCmd — dispatch ONE real backend command (no event stream) into the same
     task drawer + NDJSON console as runTask. meta.chan must be 'winrm'|'ssh'.
     exec is a thunk returning the typed command Promise (e.g. () => deleteShare(id)).
     opts.okMsg(res) builds the success line from the result. Rethrows on failure
     so callers can react (e.g. skip optimistic UI). */
  const runCmd = async (meta, exec, opts = {}) => {
    const { domain, action, target, chan = 'winrm', note } = meta;
    const no = taskSeq.current++;
    const id = 't_' + no;
    const title = `${domain} ${action}`;
    const t0 = Date.now();
    const secs = () => Math.max(1, Math.round((Date.now() - t0) / 1000)) + 's';
    setTasks((prev) => [{ id, no, domain, action, title, state: 'running', pct: 4, chan, started: nowHM(), elapsed: '0s', target, note, stream: false }, ...prev]);
    setTaskTab('active');
    setLogOpen(true);
    pushLog({ lv: 'info', cat: domain, ch: chan, task: no, msg: esc(opts.startMsg || `${title} …`) });
    try {
      const res = await exec();
      setTasks((prev) => prev.map((t) => t.id === id ? { ...t, state: 'success', pct: 100, exit: 0, elapsed: secs() } : t));
      pushLog({ lv: 'ok', cat: domain, ch: chan, task: no, msg: opts.okMsg ? esc(opts.okMsg(res)) : `<b>${title} #${no}</b> 完成` });
      return res;
    } catch (e) {
      const m = e && e.message ? e.message : String(e);
      setTasks((prev) => prev.map((t) => t.id === id ? { ...t, state: 'failed', pct: 100, exit: 2, elapsed: secs() } : t));
      pushLog({ lv: 'err', cat: domain, ch: chan, task: no, msg: `<b>${title} #${no}</b> 失败 · ${esc(m)}` });
      throw e;
    }
  };

  /* runStreamingCmd — dispatch a long-running command whose progress arrives as
     Tauri events. wiring.mode:
       'event' — kickoff returns a job_id;終止 from the stream (generate / pso /
                 distribute). Events before job_id is known are buffered + replayed.
       'await' — kickoff blocks to completion (events are pure side-channel
                 progress); finalize on resolve.
     wiring.reduce(eventName, payload, st) → { pct?, log?:{lv,msg}, done?, ok?, exit? }.
     Subscribes BEFORE kickoff to avoid losing early events; filters by job_id via
     wiring.isMine (ue-runner-progress is shared across concurrent jobs). */
  const runStreamingCmd = async (meta, kickoff, wiring) => {
    const { domain, action, target, chan = 'winrm', note } = meta;
    const no = taskSeq.current++;
    const id = 't_' + no;
    const title = `${domain} ${action}`;
    const t0 = Date.now();
    const secs = () => Math.max(1, Math.round((Date.now() - t0) / 1000)) + 's';
    setTasks((prev) => [{ id, no, domain, action, title, state: 'running', pct: 4, chan, started: nowHM(), elapsed: '0s', target, note, stream: true }, ...prev]);
    setTaskTab('active');
    setLogOpen(true);
    pushLog({ lv: 'info', cat: domain, ch: chan, task: no, msg: esc(note || `${title} …`) });

    /* 浏览器预览（无 Tauri runtime）：不能 listen，直接失败收尾，不挂起。 */
    if (!isTauri()) {
      setTasks((prev) => prev.map((t) => t.id === id ? { ...t, state: 'failed', pct: 100, exit: 2, elapsed: secs() } : t));
      pushLog({ lv: 'err', cat: domain, ch: chan, task: no, msg: `<b>${title} #${no}</b> 失败 · 浏览器预览无后端` });
      throw new VoloInvokeError('runStreamingCmd', '未运行在 Tauri 运行时');
    }

    let jobId = null, finished = false, timer = null;
    let uns = [];
    const buf = [];
    const st = {};
    const isMine = wiring.isMine || ((p, jid) => p && p.job_id === jid);
    const setPct = (p) => { if (p != null) setTasks((prev) => prev.map((t) => t.id === id ? { ...t, pct: Math.max(4, Math.min(99, Math.round(p))) } : t)); };
    const finalize = (ok, exit) => {
      if (finished) return;
      finished = true;
      if (timer) { clearTimeout(timer); timer = null; }
      const ex = ok ? 0 : (exit == null ? 2 : exit);
      setTasks((prev) => prev.map((t) => t.id === id ? { ...t, state: ok ? 'success' : 'failed', pct: 100, exit: ex, elapsed: secs() } : t));
      pushLog(ok
        ? { lv: 'ok', cat: domain, ch: chan, task: no, msg: `<b>${title} #${no}</b> 完成` }
        : { lv: 'err', cat: domain, ch: chan, task: no, msg: `<b>${title} #${no}</b> 失败 · exit ${ex}` });
      uns.forEach((u) => { try { u(); } catch (e) {} });
      if (wiring.onDone) { try { wiring.onDone(ok); } catch (e) {} } /* 完成回调（如收集后重载列表）*/
    };
    /* 空闲超时计时器：每收到一个真实事件就重置 → 持续出进度的健康长任务永不误判，
       只有真·timeoutMs 内零事件才触发；到点调 onTimeout(jobId)（如 cancelUeJob）避免孤儿进程。 */
    const armTimer = () => {
      if (!wiring.timeoutMs || finished) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (finished) return;
        pushLog({ lv: 'warn', cat: domain, ch: chan, task: no, msg: `超时 ${Math.round(wiring.timeoutMs / 60000)} 分钟无进度事件，停止等待` });
        if (wiring.onTimeout && jobId != null) { try { wiring.onTimeout(jobId); } catch (e) {} }
        finalize(false, 124);
      }, wiring.timeoutMs);
    };
    const apply = (ev, p) => {
      const r = wiring.reduce(ev, p, st) || {};
      if (r.log && r.log.msg) pushLog({ lv: r.log.lv || 'info', cat: domain, ch: chan, task: no, msg: esc(r.log.msg) });
      if (r.pct != null) setPct(r.pct);
      if (r.done) finalize(!!r.ok, r.exit);
      else armTimer(); /* 每个非终态事件重置空闲计时器 */
    };
    const handler = (ev) => (e) => {
      const p = e.payload;
      if (wiring.mode === 'event' && jobId == null) { buf.push([ev, p]); return; }
      if (isMine && !isMine(p, jobId)) return;
      apply(ev, p);
    };
    uns = await Promise.all((wiring.events || []).map((ev) => listen(ev, handler(ev))));

    let resp;
    try {
      resp = await kickoff();
    } catch (e) {
      const m = e && e.message ? e.message : String(e);
      setTasks((prev) => prev.map((t) => t.id === id ? { ...t, state: 'failed', pct: 100, exit: 2, elapsed: secs() } : t));
      pushLog({ lv: 'err', cat: domain, ch: chan, task: no, msg: `<b>${title} #${no}</b> 失败 · ${esc(m)}` });
      uns.forEach((u) => { try { u(); } catch (e2) {} });
      throw e;
    }

    if (wiring.mode === 'event') {
      jobId = wiring.jobIdOf(resp);
      if (wiring.total) st.total = wiring.total(resp); /* 分发流：reducer 数到 st.total 即收尾 */
      buf.forEach(([ev, p]) => { if (!isMine || isMine(p, jobId)) apply(ev, p); });
      if (st.total === 0) finalize(true, 0); /* 空 plan：无事件，立即收尾 */
      else armTimer(); /* 武装空闲超时兜底：generate_ddc_pak 等后端无 watchdog，UE 异常退出且
                          日志未命中终止串时后端永不发 completed → 任务卡 running。空闲超时到点
                          调 onTimeout(jobId) 取消后端 job + 标失败，避免僵任务（PSO 有 watchdog，此为双保险）。 */
    } else {
      finalize(true, 0); /* 'await' 模式：kickoff 已是终态 */
    }
    return resp;
  };

  const cluster = deriveCluster(machines, healthChecks, healthRunAt);

  const s = { theme, toggleTheme, platform, setPlatform, toolsNav, setToolsNav, page, setPage, logOpen, setLogOpen, logFilter, setLogFilter,
    logs, pushLog, pushLogs, logH, setLogH,
    selNode, setSelNode, cacheNav, setCacheNav, ddcOpen, setDdcOpen, drawer, setDrawer,
    freshSetup, setFreshSetup, machinesAdded, setMachinesAdded,
    enrolled, setEnrolled, creds, setCreds,
    tasks, setTasks, runTask, runCmd, runStreamingCmd, taskTab, setTaskTab, logSearch, setLogSearch, logPaused, setLogPaused,
    calStep, setCalStep, calScreen, setCalScreen, calMethod, setCalMethod, calSel, setCalSel,
    leftCollapsed, setLeftCollapsed, rightCollapsed, setRightCollapsed, maximized,
    machines, setMachines, shares, setShares, projects, setProjects, gpuMatrix, cluster, cacheLoading, cacheError, reloadCache };

  /* Mirror the loaded resources onto the bare globals the custom-CSS Cache page
     reads (RENDER_NODES / CREDS / SHARES / …). Done in render so each pass exposes
     the current state; initial state is [] so the first paint is crash-safe.
     CLUSTER is derived (no more mock): online/total from machines, health from the
     health checks, lastRun/ago from the latest health run timestamp. */
  Object.assign(window, { RENDER_NODES: machines, CREDS: creds, SHARES: shares, UE_PROJECTS: projects, GPU_MATRIX: gpuMatrix, HEALTH_CHECKS: healthChecks, INI_FINDINGS: iniFindings, CLUSTER: cluster });

  const { TweaksPanel, TweakSection, TweakRadio, TweakToggle } = window;
  const pg = window.VOLO_PAGES[page] || window.VOLO_PAGES.tools;
  const mac = platform === 'mac';
  return h('div', { className: 'desktop is-' + platform + (density === 'clean' ? ' clean' : '') },
    /* SysBar 隐藏：mac 原生系统菜单栏（src-tauri set_menu）已提供真实功能菜单，
       in-window SysBar 是浏览器原型对系统菜单栏的冗余模拟（SysBar 仍保留定义作设计参照） */
    null,
    h('div', { className: 'win is-' + platform },
      mac ? h(MacTitleBar, { s }) : h(WinTopBar, { s }),
      h('div', { className: 'ctxbar' }, pg.ctx(s), h(DrawerToggle, { s, style: { marginLeft: 'auto', flex: '0 0 auto' } })),
      h('div', { className: 'body', style: { gridTemplateColumns: `${leftCollapsed ? 0 : leftW}px ${leftCollapsed ? 0 : 6}px minmax(0,1fr) ${rightCollapsed ? 0 : 6}px ${rightCollapsed ? 0 : rightW}px` } },
        h('div', { className: 'leftcol' + (leftCollapsed ? ' is-collapsed' : '') }, pg.left(s)),
        h('div', { className: 'resizer resizer--col' + (leftCollapsed ? ' is-hidden' : ''), title: '拖动调整宽度',
          onPointerDown: (e) => { if (leftCollapsed) return; startResize(e, 'x', 1, leftW, setLeftW, 170, 380); } }),
        h('div', { className: 'center' }, pg.center(s)),
        h('div', { className: 'resizer resizer--col' + (rightCollapsed ? ' is-hidden' : ''), title: '拖动调整宽度',
          onPointerDown: (e) => { if (rightCollapsed) return; startResize(e, 'x', -1, rightW, setRightW, 240, 480); } }),
        h('div', { className: 'inspector' + (rightCollapsed ? ' is-collapsed' : '') }, pg.inspector(s)),
        s.drawer && pg.drawer ? h(React.Fragment, null,
          h('div', { className: 'scrim', onClick: () => s.setDrawer(null) }),
          pg.drawer(s)) : null),
      h(LogPanel, { s }),
      h(PageTabs, { s })),
    TweaksPanel ? h(TweaksPanel, { title: 'Tweaks' },
      h(TweakSection, { label: '集群总览 · Cluster' }),
      TweakToggle ? h(TweakToggle, { label: '全新设置（空集群）', value: freshSetup,
        onChange: (v) => { setFreshSetup(v); if (v) setMachinesAdded(false); } }) : null,
      h(TweakSection, { label: '工具页 · Tools' }),
      h(TweakRadio, { label: '区段导航', value: toolsNav,
        options: [{ value: 'top', label: '顶栏分类' }, { value: 'left', label: '左侧列表' }],
        onChange: setToolsNav }),
      h(TweakSection, { label: '外观 · Appearance' }),
      h(TweakRadio, { label: '显示密度', value: density,
        options: [{ value: 'clean', label: '简洁' }, { value: 'rich', label: '丰富' }],
        onChange: setDensity }),
      h(TweakRadio, { label: '平台', value: platform,
        options: [{ value: 'mac', label: 'Mac' }, { value: 'win', label: 'Windows' }],
        onChange: setPlatform }),
      h(TweakRadio, { label: '主题', value: theme,
        options: [{ value: 'dark', label: '深色' }, { value: 'light', label: '浅色' }],
        onChange: setThemeValue })) : null);
}

/* ---------- shared small chrome helpers for pages ---------- */
function CtxTitle({ icon, title, sub }) {
  return React.createElement('div', { className: 'ctx-title' },
    React.createElement('span', { className: 'ico' }, React.createElement(Icon, { name: icon, size: 17 })),
    React.createElement('div', null,
      React.createElement('h1', null, title),
      sub ? React.createElement('div', { className: 'sub' }, sub) : null));
}
function Stat({ k, v, pct, variant = 'informative' }) {
  return React.createElement('div', { className: 'statrow' },
    React.createElement('div', { className: 'top' }, React.createElement('span', { className: 'k' }, k), React.createElement('span', { className: 'v' }, v)),
    React.createElement('div', { className: 'vmeter vmeter--' + variant },
      React.createElement('div', { className: 'vmeter__fill', style: { width: pct + '%' } })));
}

Object.assign(window, { App, Selector, CtxTitle, Stat });
})();

export const App = (window as any).App;
