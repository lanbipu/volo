// @ts-nocheck
/* Volo — app shell (chrome + state + page-slot composition).
   1:1 port of the Claude Design handoff `src/shell.jsx`. The IIFE publishes
   App / Selector / CtxTitle / Stat onto `window`; we re-export App below. */
import * as React from "react";
import "./ds";

(function () {
const { useState, useRef, useEffect } = React;
const { Button } = window.Spectrum2DesignSystem_b6d1b3;
const h = React.createElement;

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
  const cur = options.find((o) => o.id === value) || options[0];
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
const stageOptions = () => STAGES.map((x) => ({ id: x.id, label: `${x.name} · ${x.volume}`, sub: x.state, pip: x.status }));
const SyncPip = () => h('span', { className: 'pip', style: { width: 7, height: 7, borderRadius: '50%', background: 'var(--positive-visual)' } });
function DocCrumb({ s, style }) {
  const stage = STAGES.find((x) => x.id === s.stage);
  return h('div', { className: 'doc', style, 'data-tauri-drag-region': true },
    h('span', null, '制作'), h(Icon, { name: 'chevr', size: 13 }),
    h('b', null, 'Helios — Ep.204'), h('span', { style: { color: 'var(--chrome-faint)' } }, '·'),
    h('span', null, stage.name));
}
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
       不再渲染浏览器原型的自定义 .traffic，避免与原生关闭/最小化/放大按钮重复 */
    h(DocCrumb, { s }),
    h('div', { className: 'right' },
      h('span', { className: 'conn' }, h(SyncPip), '同步 23.976'),
      h('span', { className: 'conn' }, '8 节点 · 6 在线'),
      h(Selector, { variant: 'stage', kpre: '当前舞台', value: s.stage, options: stageOptions(), onChange: s.setStage }),
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
      h(Selector, { variant: 'stage', kpre: '当前舞台', value: s.stage, options: stageOptions(), onChange: s.setStage }),
      /* 窗口最小化/最大化/关闭由 Windows 原生标题栏提供（与 mac 同策略：用原生、不画自定义），
         不再渲染自定义 .winctl，避免与原生标题栏按钮重复 */
      h(ChromeIconButtons, { s })));
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
      React.createElement('span', { className: 'sdot bg-notice' }),
      React.createElement('span', null, '缓存健康分 72')));
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
  const [stage, setStage] = useState(STAGES.some((x) => x.id === persisted.stage) ? persisted.stage : 'st4');
  const [logOpen, setLogOpen] = useState(persisted.logOpen !== undefined ? persisted.logOpen : true);
  const [logFilter, setLogFilter] = useState('all');
  const [logs, setLogs] = useState(LOGS);
  const [selNode, setSelNode] = useState(RENDER_NODES.some((n) => n.id === persisted.selNode) ? persisted.selNode : 'rn4');
  const CACHE_NAVS = ['home', 'ddc_zen', 'ddc_legacy', 'ddc_pak', 'ddc_pso',
    'diag_net', 'diag_sync', 'diag_thm', 'diag_term'];
  const [cacheNav, setCacheNav] = useState(CACHE_NAVS.includes(persisted.cacheNav) ? persisted.cacheNav : 'home');
  const [ddcOpen, setDdcOpen] = useState(persisted.ddcOpen != null ? persisted.ddcOpen : /^ddc_/.test(persisted.cacheNav || ''));
  const [drawer, setDrawer] = useState(null);
  /* task drawer + NDJSON console */
  const [tasks, setTasks] = useState(TASKS);
  const taskSeq = useRef(TASK_SEQ);
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
  /* 凭据管理（SecretStore）—— 仅共享 DDC 创建/接入用到 */
  const [creds, setCreds] = useState(CREDS);

  /* debounce persistence so live drag-resize (leftW/rightW/logH change每帧) doesn't
     JSON.stringify + setItem synchronously on every pointermove frame */
  const persistTimer = useRef(0);
  useEffect(() => {
    clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      try { localStorage.setItem('volo2', JSON.stringify({ page, stage, logOpen, selNode, cacheNav, ddcOpen, calStep, calScreen, calMethod, calSel, platform, density, toolsNav, leftW, rightW, logH, freshSetup, leftCollapsed, rightCollapsed })); } catch (e) {}
    }, 150);
    return () => clearTimeout(persistTimer.current);
  }, [page, stage, logOpen, selNode, cacheNav, ddcOpen, calStep, calScreen, calMethod, calSel, platform, density, toolsNav, leftW, rightW, logH, freshSetup, leftCollapsed, rightCollapsed]);

  /* 禁掉桌面 WebView 的右键菜单（reload / 检查）；calibrate 画布另有本地 preventDefault */
  useEffect(() => {
    const block = (e) => e.preventDefault();
    document.addEventListener('contextmenu', block);
    return () => document.removeEventListener('contextmenu', block);
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

  const s = { theme, toggleTheme, platform, setPlatform, toolsNav, setToolsNav, page, setPage, stage, setStage, logOpen, setLogOpen, logFilter, setLogFilter,
    logs, pushLog, pushLogs, logH, setLogH,
    selNode, setSelNode, cacheNav, setCacheNav, ddcOpen, setDdcOpen, drawer, setDrawer,
    freshSetup, setFreshSetup, machinesAdded, setMachinesAdded,
    enrolled, setEnrolled, creds, setCreds,
    tasks, setTasks, runTask, taskTab, setTaskTab, logSearch, setLogSearch, logPaused, setLogPaused,
    calStep, setCalStep, calScreen, setCalScreen, calMethod, setCalMethod, calSel, setCalSel,
    leftCollapsed, setLeftCollapsed, rightCollapsed, setRightCollapsed };

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
