// @ts-nocheck
/* Volo — app shell (chrome + state + page-slot composition).
   1:1 port of the Claude Design handoff `src/shell.jsx`. The IIFE publishes
   App / Selector / CtxTitle / Stat onto `window`; we re-export App below. */
import * as React from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import "./ds";
import { loadCacheResources } from "./api/cacheData";
import { cancelUeJob } from "./api/commands";
import { call, isTauri, VoloInvokeError } from "./api/invoke";
import { fmtDetail, safeJson } from "./logDetail";

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
function Selector({ kpre, value, options, onChange, width = 188, variant = 'obj', align = 'right', popMin }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const popRef = useRef(null);
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
  const popStyle = Object.assign(
    {},
    align === 'left' ? { left: 0, right: 'auto' } : { right: 0, left: 'auto' },
    popMin != null ? { minWidth: popMin } : null,
  );
  return React.createElement('div', { ref, style: { position: 'relative' } },
    React.createElement('div', { className: cls, style: variant === 'obj' ? { minWidth: width } : null, onClick: () => setOpen((v) => !v) },
      variant === 'stage' && cur.pip ? React.createElement('span', { className: 'pip', style: { background: `var(--${cur.pip}-visual)`, boxShadow: 'none' } }) : null,
      React.createElement('div', { className: variant === 'stage' ? 'lbl' : 'col' },
        React.createElement('span', { className: 'k' }, kpre),
        React.createElement('span', { className: 'v' }, cur.label)),
      React.createElement('span', { className: 'chev', style: { marginLeft: 'auto', display: 'flex' } }, React.createElement(Icon, { name: 'chevd', size: 15 }))),
    open ? React.createElement('div', { ref: popRef, className: 'popover', style: popStyle },
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
/* panel toggle — show/hide the persistent inspector (right column) */
function DrawerToggle({ s, style }) {
  return h('button', {
    className: 'paneltgl' + (!s.rightCollapsed ? ' on' : ''),
    title: s.rightCollapsed ? '显示检查器' : '隐藏检查器',
    style,
    onClick: () => s.setRightCollapsed((v) => !v),
  }, h(Icon, { name: 'panel', size: 15 }), h('span', null, '检查器'));
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
    React.createElement('div', { className: 'pagetabs-right' },
      React.createElement('div', { className: 'meta' },
        React.createElement('span', { className: 'sdot bg-' + (s.cluster.health == null ? 'neutral' : s.cluster.health >= 85 ? 'positive' : s.cluster.health >= 60 ? 'notice' : 'negative') }),
        React.createElement('span', null, '缓存健康分 ' + (s.cluster.health == null ? '—' : s.cluster.health))),
      React.createElement(LogPanel, { s })));
}

/* ---------- clipboard helper (falls back to execCommand inside sandboxed frames) ---------- */
function copyToClipboard(text, done) {
  const finish = () => { if (done) done(); };
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(finish, () => execCopy(text, finish));
      return;
    }
  } catch (e) { /* fall through */ }
  execCopy(text, finish);
}
function execCopy(text, finish) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  try { document.execCommand('copy'); } catch (e) { /* ignore */ }
  document.body.removeChild(ta);
  finish();
}

/* ---------- Log panel — NDJSON stream (search · pause · channel · 展开 · 复制) ---------- */
function LogPanel({ s }) {
  const allLogs = s.logs;
  const q = (s.logSearch || '').trim().toLowerCase();
  const strip = (html) => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  /* 展开的行（key = ts|msg）· 最近复制的目标（行 key 或 'ALL'）以便按钮回显 */
  const [expanded, setExpanded] = React.useState(() => new Set());
  const [copied, setCopied] = React.useState(null);
  const copyTimer = React.useRef(null);
  const flash = (key) => { setCopied(key); clearTimeout(copyTimer.current); copyTimer.current = setTimeout(() => setCopied(null), 1500); };
  React.useEffect(() => () => clearTimeout(copyTimer.current), []);
  const keyOf = (l) => l.ts + '|' + l.task + '|' + strip(l.msg);
  const toggle = (key) => setExpanded((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  /* 单行 → 纯文本（首行摘要 + 缩进的完整明细）*/
  const rowText = (l) => {
    const lv = l.lv === 'ok' ? 'OK' : l.lv.toUpperCase();
    const meta = [l.ch ? CHANNEL[l.ch].label : null, l.cat, l.task ? '#' + l.task : null, l.host].filter(Boolean).join(' · ');
    const head = `[${l.ts}] ${lv.padEnd(4)}  ${strip(l.msg)}    (${meta})`;
    return l.detail ? head + '\n' + l.detail + '\n' : head;
  };
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
  const allTasks = s.tasks || [];
  const running = allTasks.filter((t) => t.state === 'running').length;
  const activeTasks = allTasks.filter((t) => t.state === 'running' || t.state === 'queued');
  /* 状态框三态所需数据：最近完成（最多 3）· 失败任务（报警源，最多 6） */
  const doneTasks = allTasks.filter((t) => t.state === 'success' || t.state === 'failed' || t.state === 'canceled').slice(0, 3);
  const failedTasks = allTasks.filter((t) => t.state === 'failed').slice(0, 6);
  /* 报警 = 尚未查看的失败任务。LogPanel 挂载前已存在的失败视为“已知/已读”，
     只有挂载后新发生的失败才把状态框点红提示；查看后即标记已读。 */
  const [ackAlerts, setAckAlerts] = React.useState(() => new Set(allTasks.filter((t) => t.state === 'failed').map((t) => t.id)));
  const unreadFailed = failedTasks.filter((t) => !ackAlerts.has(t.id));
  const status = unreadFailed.length ? 'alert' : running ? 'running' : 'idle';
  const [runOpen, setRunOpen] = React.useState(false);
  const [popView, setPopView] = React.useState('running'); /* 打开时定格的视图：running|idle|alert */
  const openPop = () => {
    setPopView(status);
    if (unreadFailed.length) setAckAlerts((prev) => { const n = new Set(prev); failedTasks.forEach((t) => n.add(t.id)); return n; });
    setRunOpen(true);
  };
  /* 触发运行时自动弹出一次「运行中」气泡；用户再次点击或点击别处即关闭。quiet 任务
     （扫描/生成/分发/删除等有自己进度呈现的操作）通过 s.suppressRunPop 抑制这次自动弹起；
     Cache 页一律不自动弹气泡。 */
  const prevRunning = React.useRef(running);
  React.useEffect(() => {
    if (running > prevRunning.current && !(s.suppressRunPop && s.suppressRunPop.current) && s.page !== 'cache') { setPopView('running'); setRunOpen(true); }
    if (s.suppressRunPop) s.suppressRunPop.current = false;
    prevRunning.current = running;
  }, [running]);
  /* 任务完成 → 状态框上方弹出小提示（某某任务已完成/失败）· 不自动消失，点任意处才关；
     弹出的同时收起「任务进行中」二级弹窗。 */
  const [toast, setToast] = React.useState(null);
  const prevStatesRef = React.useRef(null);
  React.useEffect(() => {
    const map = {}; allTasks.forEach((t) => { map[t.id] = t.state; });
    if (prevStatesRef.current) {
      let done = null;
      allTasks.forEach((t) => {
        const ps = prevStatesRef.current[t.id];
        if ((ps === 'running' || ps === 'queued') && (t.state === 'success' || t.state === 'failed')) done = t;
      });
      if (done) { setToast({ id: done.id, title: done.title, no: done.no, ok: done.state === 'success' }); setRunOpen(false); }
    }
    prevStatesRef.current = map;
  }, [s.tasks]);
  React.useEffect(() => {
    if (!toast) return undefined;
    const onDown = () => setToast(null);
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [toast]);
  const histTasks = allTasks.filter((t) => t.state === 'success' || t.state === 'failed' || t.state === 'canceled');
  const TaskCard = window.VOLO_CX && window.VOLO_CX.TaskCard;
  const conTab = s.conTab || 'stream';
  /* 控制台 / 运行中弹窗均「点击穿透关闭」：不用挡点击的 backdrop，改在 document 捕获阶段
     监听 pointerdown —— 点击其他地方时弹层关闭的同时，被点的按钮/页面一次点击即生效。 */
  React.useEffect(() => {
    if (!runOpen) return undefined;
    const onDown = (e) => {
      if (e.target.closest && (e.target.closest('.log-run-pop') || e.target.closest('.log-trigger-stat'))) return;
      setRunOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [runOpen]);
  React.useEffect(() => {
    if (!s.logOpen) return undefined;
    const onDown = (e) => {
      if (e.target.closest && (e.target.closest('.log-window') || e.target.closest('.log-trigger-wrap'))) return;
      s.setLogOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [s.logOpen]);
  const stateLabel = { success: '完成', failed: '失败', canceled: '已取消' };
  const alertText = (t) => `[${t.title} #${t.no}] ${t.target || ''} · exit ${t.exit != null ? t.exit : 2}\n${t.err || t.note || '失败'}`;
  /* 悬停即变「清除」的计数徽标：只清空 alert/idle 这两个列表（success/failed/canceled
     任务），进行中任务不可清；记录仍完整留在控制台 NDJSON 流（pushLog 是独立状态），
     可回查——清的只是任务卡片视图。 */
  const clearList = (view) => {
    if (view === 'alert') s.setTasks((prev) => prev.filter((t) => t.state !== 'failed'));
    else s.setTasks((prev) => prev.filter((t) => !(t.state === 'success' || t.state === 'failed' || t.state === 'canceled')));
    setRunOpen(false);
  };
  const clearableN = (n, view) => React.createElement('button', {
    className: 'lrp-n lrp-n--clear', type: 'button', title: '清除此列表 · 记录仍可在控制台查看',
    onClick: (e) => { e.stopPropagation(); clearList(view); } },
    React.createElement('span', { className: 'lrp-n-num' }, n),
    React.createElement('span', { className: 'lrp-n-ico' }, React.createElement(Icon, { name: 'broom', size: 13 })));
  const runHead = popView === 'alert'
    ? React.createElement('div', { className: 'lrp-h lrp-h--alert' }, React.createElement(Icon, { name: 'alert', size: 13 }), '报警信息', clearableN(failedTasks.length, 'alert'))
    : popView === 'idle'
      ? React.createElement('div', { className: 'lrp-h' }, React.createElement(Icon, { name: 'check', size: 13 }), '最近完成', clearableN(doneTasks.length, 'idle'))
      : React.createElement('div', { className: 'lrp-h' }, React.createElement(Icon, { name: 'sync', size: 13 }), '进行中任务', React.createElement('span', { className: 'lrp-n' }, activeTasks.length));
  const runBody = popView === 'alert'
    ? (failedTasks.length === 0
        ? React.createElement('div', { className: 'lrp-empty' }, '当前没有报警')
        : React.createElement('div', { className: 'lrp-list' }, failedTasks.map((t) => React.createElement('button', {
            key: t.id, className: 'lrp-alert' + (copied === ('AL_' + t.id) ? ' copied' : ''),
            title: '点击复制这条报警信息',
            onClick: (e) => { e.stopPropagation(); copyToClipboard(alertText(t), () => flash('AL_' + t.id)); } },
            React.createElement('div', { className: 'lrp-top' },
              React.createElement('span', { className: 'lrp-title' }, t.title, React.createElement('span', { className: 'lrp-no' }, '#' + t.no)),
              React.createElement('span', { className: 'lrp-copyhint' }, React.createElement(Icon, { name: copied === ('AL_' + t.id) ? 'check' : 'copy', size: 12 }), copied === ('AL_' + t.id) ? '已复制' : '复制')),
            React.createElement('div', { className: 'lrp-errmsg' }, t.err || t.note || '失败'),
            React.createElement('div', { className: 'lrp-meta' },
              React.createElement('span', { className: 'lrp-target' }, t.target),
              React.createElement('span', { className: 'lrp-el' }, 'exit ' + (t.exit != null ? t.exit : 2)))))))
    : popView === 'idle'
      ? (doneTasks.length === 0
          ? React.createElement('div', { className: 'lrp-empty' }, '暂无最近完成的任务')
          : React.createElement('div', { className: 'lrp-list' }, doneTasks.map((t) => React.createElement('div', { key: t.id, className: 'lrp-row' },
              React.createElement('div', { className: 'lrp-top' },
                React.createElement('span', { className: 'lrp-title' }, t.title, React.createElement('span', { className: 'lrp-no' }, '#' + t.no)),
                React.createElement('span', { className: 'lrp-badge lrp-badge--' + t.state }, stateLabel[t.state] || t.state)),
              React.createElement('div', { className: 'lrp-meta' },
                React.createElement('span', { className: 'lrp-target' }, t.note || t.target),
                React.createElement('span', { className: 'lrp-el' }, t.elapsed))))))
      : (activeTasks.length === 0
          ? React.createElement('div', { className: 'lrp-empty' }, '当前没有运行中的任务')
          : React.createElement('div', { className: 'lrp-list' }, activeTasks.map((t) => React.createElement('div', { key: t.id, className: 'lrp-row' },
              React.createElement('div', { className: 'lrp-top' },
                React.createElement('span', { className: 'lrp-title' }, t.title, React.createElement('span', { className: 'lrp-no' }, '#' + t.no)),
                React.createElement('span', { className: 'lrp-pct' }, t.stream ? ((t.pct || 0) + '%') : '运行中')),
              /* 流式任务(runStreamingCmd)有真实逐步 pct → 确定进度；原子任务(runCmd)只有 4%→100% 两点，
                 无中间进度 → 用不确定动画条，不显冻结在 4% 的误导百分比。 */
              React.createElement('div', { className: 'lrp-bar' }, React.createElement('div', { className: 'lrp-fill' + (t.stream ? '' : ' indet'), style: t.stream ? { width: (t.pct || 0) + '%' } : null })),
              React.createElement('div', { className: 'lrp-meta' },
                React.createElement('span', { className: 'lrp-target' }, t.target),
                React.createElement('span', { className: 'lrp-el' }, t.elapsed),
                t.long && t.state === 'running' && s.cancelTask ? React.createElement('button', {
                  className: 'lrp-cancel', title: '终止远端 UE 进程并取消该长任务',
                  onClick: (e) => { e.stopPropagation(); s.cancelTask(t.id); } },
                  React.createElement(Icon, { name: 'x', size: 11 }), '取消') : null)))));
  const runPop = [
    React.createElement('div', { key: 'rpop', className: 'log-run-pop log-run-pop--' + popView, onClick: (e) => e.stopPropagation() },
      runHead, runBody),
  ];
  return React.createElement('div', { className: 'logpanel' + (s.logOpen ? ' is-open' : '') },
    toast ? React.createElement('div', { className: 'task-toast task-toast--' + (toast.ok ? 'ok' : 'fail'), onClick: () => setToast(null), title: '点击关闭' },
      React.createElement('span', { className: 'task-toast-ico' }, React.createElement(Icon, { name: toast.ok ? 'check' : 'alert', size: 14 })),
      React.createElement('span', { className: 'task-toast-tx' }, React.createElement('b', null, toast.title + ' #' + toast.no), toast.ok ? ' 已完成' : ' 执行失败'),
      React.createElement('button', { className: 'task-toast-x', type: 'button', title: '关闭', onClick: (e) => { e.stopPropagation(); setToast(null); } },
        React.createElement(Icon, { name: 'x', size: 12 }))) : null,
    React.createElement('div', { className: 'log-trigger-wrap' + (s.logOpen ? ' on' : '') },
      React.createElement('button', {
        className: 'log-trigger' + (s.logOpen ? ' on' : ''),
        title: s.logOpen ? '收起控制台' : '打开控制台',
        onClick: () => s.setLogOpen((v) => !v) },
        React.createElement(Icon, { name: 'terminal', size: 14 }),
        React.createElement('span', null, '控制台')),
      React.createElement('button', {
        className: 'log-trigger-stat' + (status === 'running' ? ' run' : '') + (status === 'alert' ? ' alert' : '') + (runOpen ? ' on' : ''),
        title: status === 'alert' ? '有报警 · 点击查看并复制' : status === 'running' ? '查看进行中任务' : '查看最近完成的任务',
        onClick: (e) => { e.stopPropagation(); if (runOpen) setRunOpen(false); else openPop(); } },
        React.createElement('span', { className: 'rec-dot', style: { width: 7, height: 7, background: status === 'alert' ? 'var(--negative-visual)' : status === 'running' ? 'var(--volo-600)' : 'var(--positive-visual)', animationPlayState: (status === 'idle' || s.logPaused) ? 'paused' : 'running' } }),
        status === 'alert' ? (unreadFailed.length + ' 报警') : status === 'running' ? (running + ' 运行中') : '空闲'),
      runOpen ? runPop : null),
    s.logOpen ? React.createElement('div', { className: 'log-window' },
      React.createElement('div', {
        className: 'resizer resizer--row',
        title: '拖动调整高度',
        onPointerDown: (e) => startResize(e, 'y', -1, s.logH, s.setLogH, 90, 440),
      }),
      React.createElement('div', { className: 'log-head' },
        React.createElement('span', { className: 'ttl' }, React.createElement(Icon, { name: 'terminal', size: 15 }), '控制台',
          React.createElement('span', { className: 'ndjson-tag' }, 'NDJSON')),
        React.createElement('div', { className: 'log-tabs' },
          tabs.map(([id, lbl]) => React.createElement('div', {
            key: id, className: 'log-tab' + (conTab === 'stream' && s.logFilter === id ? ' on' : ''),
            onClick: () => { s.setConTab('stream'); s.setLogFilter(id); },
          }, lbl, React.createElement('span', { className: 'n' }, counts[id]))),
          React.createElement('div', {
            className: 'log-tab log-tab--hist' + (conTab === 'hist' ? ' on' : ''),
            onClick: () => s.setConTab('hist'),
          }, React.createElement(Icon, { name: 'list', size: 12 }), '历史任务', React.createElement('span', { className: 'n' }, histTasks.length))),
        React.createElement('div', { className: 'right log-tools' },
          React.createElement('div', { className: 'log-search' },
            React.createElement(Icon, { name: 'search', size: 13 }),
            React.createElement('input', {
              value: s.logSearch || '', placeholder: '搜索流…',
              onChange: (e) => s.setLogSearch(e.target.value),
              onClick: (e) => e.stopPropagation() })),
          React.createElement('button', {
            className: 'log-pause' + (s.logPaused ? ' on' : ''), title: s.logPaused ? '已暂停 — 点击恢复' : '暂停自动滚动',
            onClick: (e) => { e.stopPropagation(); s.setLogPaused((v) => !v); } },
            React.createElement(Icon, { name: s.logPaused ? 'play' : 'pause', size: 13 }), s.logPaused ? '已暂停' : '实时'),
          conTab === 'stream' ? React.createElement('button', {
            className: 'log-copyall' + (copied === 'ALL' ? ' done' : ''),
            title: rows.length ? `复制当前 ${rows.length} 条日志（含明细）到剪贴板` : '当前没有可复制的日志',
            disabled: rows.length === 0,
            onClick: (e) => { e.stopPropagation(); if (!rows.length) return; copyToClipboard(rows.map(rowText).join('\n'), () => flash('ALL')); } },
            React.createElement(Icon, { name: copied === 'ALL' ? 'check' : 'copy', size: 13 }),
            copied === 'ALL' ? '已复制' : '复制全部') : null,
          React.createElement('button', { className: 'iconbtn', style: { width: 22, height: 22 }, title: '关闭控制台', onClick: (e) => { e.stopPropagation(); s.setLogOpen(false); } }, React.createElement(Icon, { name: 'x', size: 15 })))),
      React.createElement('div', { className: 'log-body' + (s.logPaused ? ' paused' : '') + (conTab === 'hist' ? ' log-body--hist' : ''), style: { height: s.logH } },
        conTab === 'hist'
          ? (histTasks.length === 0
              ? React.createElement('div', { className: 'log-empty' }, '暂无历史任务')
              : React.createElement('div', { className: 'log-hist' }, histTasks.map((t) => TaskCard ? React.createElement(TaskCard, { key: t.id, s, t }) : null)))
          : (rows.length === 0 ? React.createElement('div', { className: 'log-empty' }, q ? `无匹配「${s.logSearch}」的流` : '暂无日志')
          : rows.map((l) => {
              const key = keyOf(l);
              const isOpen = expanded.has(key);
              const hasDetail = !!l.detail;
              return React.createElement('div', { key, className: 'log-entry' + (isOpen ? ' is-open' : '') },
                React.createElement('div', {
                  className: 'log-row' + (hasDetail ? ' has-detail' : '') + (copied === key ? ' copied' : ''),
                  onClick: () => copyToClipboard(rowText(l), () => flash(key)),
                  title: '点击复制整条日志' + (hasDetail ? '（含明细）' : '') },
                  React.createElement('span', { className: 'ts' }, l.ts),
                  React.createElement('span', { className: 'lv ' + l.lv }, l.lv === 'ok' ? 'OK' : l.lv.toUpperCase()),
                  React.createElement('span', { className: 'ch' + (l.ch ? ' ch-' + l.ch : '') }, l.ch ? CHANNEL[l.ch].short : '·'),
                  React.createElement('span', { className: 'msg' },
                    hasDetail ? React.createElement('button', {
                      className: 'log-caret', style: { transform: isOpen ? 'rotate(90deg)' : 'none' },
                      title: isOpen ? '收起明细' : '展开明细',
                      onClick: (e) => { e.stopPropagation(); toggle(key); } },
                      React.createElement(Icon, { name: 'chevr', size: 12 })) : null,
                    React.createElement('span', { className: 'msg-tx', dangerouslySetInnerHTML: { __html: l.msg } })),
                  React.createElement('span', { className: 'log-copy' + (copied === key ? ' done' : '') },
                    React.createElement(Icon, { name: copied === key ? 'check' : 'copy', size: 12 }),
                    React.createElement('span', { className: 'log-copy-tx' }, copied === key ? '已复制' : '点击复制'))),
                isOpen ? React.createElement('pre', { className: 'log-detail' }, l.detail) : null);
            })))) : null);
}

/* ---------- 顶层渲染保护 ----------
   全应用此前无 error boundary：任一面板渲染抛错（如 cacheZen 那次 Hooks 顺序违规）
   都会让 React 卸载整棵树 → 纯黑屏。这里给每个渲染槽包一层，单个面板崩只显示局部错误卡，
   外壳 / 导航 / 其余面板照常可用。key 只随 page 变（切顶层页 remount 清错误）；cacheNav 改走
   resetKey：变化时仅清错误态、不 remount——key 带 cacheNav 会让每次 Cache 子页切换整槽卸载重挂，
   把 center 的 keep-alive（display 切换）整个架空，切页重跑全部挂载期远程回读。 */
class ErrBoundary extends React.Component {
  constructor(props) { super(props); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err: err }; }
  componentDidCatch(err, info) {
    try { console.error('[volo] 面板渲染异常 · ' + (this.props.slot || ''), err, info && info.componentStack); } catch (e) {}
  }
  componentDidUpdate(prevProps) {
    if (this.state.err && prevProps.resetKey !== this.props.resetKey) this.setState({ err: null });
  }
  render() {
    if (!this.state.err) return this.props.children;
    const msg = this.state.err && this.state.err.message ? this.state.err.message : String(this.state.err);
    return React.createElement('div', { className: 'res', style: { padding: 22, minWidth: 0 } },
      React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 9, maxWidth: 560 } },
        React.createElement('div', { style: { fontSize: 14, fontWeight: 700, color: 'var(--negative-visual)' } }, '这个面板渲染出错了'),
        React.createElement('div', { style: { fontSize: 12, lineHeight: 1.6, color: 'var(--chrome-dim)' } }, '其余面板与导航仍可正常使用 —— 切换到别的页面，或点下方「重试」即可恢复。'),
        React.createElement('div', { style: { fontSize: 11.5, fontFamily: 'var(--font-code)', wordBreak: 'break-all', color: 'var(--chrome-faint)', background: 'var(--sunken)', borderRadius: 8, padding: '8px 11px' } }, msg),
        React.createElement('button', { className: 'mini-btn', style: { alignSelf: 'flex-start' }, onClick: () => this.setState({ err: null }) }, '重试')));
  }
}
/* Slot：把渲染槽的「调用」也放进 boundary 子树内。若在 App render 里直接求值 pg.center(s)，
   函数同步抛错会逃出外层 ErrBoundary（错误发生在 App 自己的 render 期）；改由 Slot 子组件调用
   render thunk，则连「槽函数本身同步抛」也落在 boundary 子树内 → 能被捕获。 */
function Slot(props) { return props.render(); }

/* ---------- App ---------- */
function App() {
  const persisted = (() => { try { return JSON.parse(localStorage.getItem('volo2') || '{}'); } catch (e) { return {}; } })();
  const [theme, setTheme] = useState(() => document.documentElement.getAttribute('data-theme') || 'dark');
  const [platform, setPlatform] = useState(persisted.platform === 'win' || persisted.platform === 'mac' ? persisted.platform : detectPlatform());
  const [density, setDensity] = useState(persisted.density === 'rich' ? 'rich' : 'clean');
  const [toolsNav, setToolsNav] = useState(persisted.toolsNav === 'left' ? 'left' : 'top');
  const [leftW, setLeftW] = useState(typeof persisted.leftW === 'number' ? persisted.leftW : 214);
  const [rightW, setRightW] = useState(typeof persisted.rightW === 'number' ? persisted.rightW : 372);
  const [leftCollapsed, setLeftCollapsed] = useState(!!persisted.leftCollapsed);
  /* 检查器（右栏）每次打开 App 都从收起状态开始 —— 不做"记住上次开合"的持久化。
     所有页面都只允许用户点击顶栏「检查器」按钮展开；选中目标、切换阶段或打开详情/
     预览只更新检查器内容，不改变开合状态。 */
  const [rightCollapsed, setRightCollapsed] = useState(true);
  const [logH, setLogH] = useState(typeof persisted.logH === 'number' ? persisted.logH : 150);
  const [page, setPage] = useState(() => PAGES.some((p) => p.id === persisted.page) ? persisted.page : 'tools');
  /* 舞台切换器 / 面包屑已移除，stage state 无消费者，随之删除 */
  /* 控制台（底部日志面板）每次打开 App 都从收起状态开始 —— 不持久化开合。
     Cache 页：任何后台任务/搜索输入都不自动展开，只有用户点击控制台标题/标签或页内
     「查看日志」链才会弹起；其它顶层页仍可在运行任务时自动展开。 */
  const [logOpen, setLogOpen] = useState(false);
  const [logFilter, setLogFilter] = useState('all');
  const [logs, setLogs] = useState([]); /* NDJSON 流 —— 真实命令派发的事件后续批次接入 */
  const [selNode, setSelNode] = useState(persisted.selNode || null);
  /* Cache read-path resources, loaded from the backend (machines / creds /
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
  const cacheFirstLoaded = useRef(false);
  const CACHE_NAVS = ['home', 'ddc_zen', 'ddc_legacy', 'ddc_pak', 'ddc_pso',
    'diag_net', 'diag_sync', 'diag_thm', 'diag_term'];
  const initCacheNav = CACHE_NAVS.includes(persisted.cacheNav) ? persisted.cacheNav : 'home';
  const [cacheNav, setCacheNav] = useState(initCacheNav);
  const [ddcOpen, setDdcOpen] = useState(persisted.ddcOpen != null ? persisted.ddcOpen : /^ddc_/.test(persisted.cacheNav || ''));
  /* Cache keep-alive：在 goCacheNav（非 render）里置位，center/ddc 只读这些 flag 决定 display 切换 vs 卸载。 */
  const [cacheDdcEverOpened, setCacheDdcEverOpened] = useState(/^ddc_/.test(initCacheNav));
  const [ddcViewsSeen, setDdcViewsSeen] = useState(() => {
    const seen = { ddc_zen: false, ddc_legacy: false, ddc_pak: false, ddc_pso: false };
    if (/^ddc_/.test(initCacheNav)) seen[initCacheNav] = true;
    return seen;
  });
  const [drawer, setDrawer] = useState(null);
  /* 居中二级对话框（部署 / 修复 / 巡检走此，见 cache.tsx 的 ModalPreview / ModalLayer）。 */
  const [modal, setModal] = useState(null);
  /* PSO 工程选择（主视图勾选 · 检查器就地显示 + 操作）。DDC PAK 已改为主视图双栏自管选择/
     操作（cacheDdcPak.tsx 内部 state），不再经由 shell 的 pakSel/pakVerify。 */
  const [psoSel, setPsoSel] = useState(null);
  /* PSO 绿灯矩阵 / 预跑历史 / 驱动缓存快照 —— Dashboard(center) 与检查器(inspector) 是两棵独立
     渲染的子树（cacheDdc 的 ddc(s)/detail(s) 各自单独调用），靠 shell state 而非页面内 module
     变量才能让两边读到同一份数据（对齐 machines/gpuMatrix 的共享模式）；由 cachePsoDash.tsx 的
     loadPsoData(s) 按工程 fan-out 填充，不随 reloadCache 联动（比机器/工程列表更重，只在
     Dashboard 挂载或动作完成后按需刷新）。 */
  const [psoStatusByProject, setPsoStatusByProject] = useState({});
  const [psoRunsByProject, setPsoRunsByProject] = useState({});
  const [psoDriverSnapshots, setPsoDriverSnapshots] = useState({});
  /* 每工程持久化预跑设置（get_pso_project_settings，纯读库无 SSH）——配置巡检卡 / 预跑确认对话框
     的红线校验都要读全量，随 loadPsoData 一起 fan-out 加载，不单独维护第二套加载时序。 */
  const [psoSettingsByProject, setPsoSettingsByProject] = useState({});
  /* task drawer + NDJSON console */
  const [tasks, setTasks] = useState([]);
  const taskSeq = useRef(1);
  /* 可取消长任务注册表：taskId -> { requestCancel }（runStreamingCmd 注册，cancelTask 查用） */
  const streamCtl = useRef({});
  /* quiet 任务（meta.quiet=true）抑制「运行中」气泡自动弹起一次。控制台（log-window）
     不再由任何任务自动打开——只有用户手动点击「控制台」按钮，或页面内明确的
     「查看日志/看日志流」入口才会展开；noLogOpen 因此不再影响行为，调用方仍可传但
     已是历史参数。LogPanel 读到 suppressRunPop 后立即复位；任务仍照常 setTasks/pushLog。 */
  const suppressRunPop = useRef(false);
  const applyTaskLogPop = ({ quiet }) => {
    if (quiet) suppressRunPop.current = true;
  };
  /* 控制台标签页：stream(NDJSON 流) | hist(历史任务卡片)。检查器旧「进行中/历史」tab 已移除，
     原 taskTab 随之删除（无消费者）。 */
  const [conTab, setConTab] = useState('stream');
  const [logSearch, setLogSearch] = useState('');
  const [logPaused, setLogPaused] = useState(false);
  /* calibrate：概览 / 屏幕设计 / 测试图 / 上屏部署 / 重建 / 校正；后五页共用同一三维主视图。
     「网格已重建」派生自 projStore.proj.reconstruction。 */
  const CAL_SECTIONS = ['overview', 'screen', 'pattern', 'deploy', 'rebuild', 'lens'];
  const [calSection, setCalSection] = useState(CAL_SECTIONS.includes(persisted.calSection) ? persisted.calSection : 'overview');
  /* 当前激活屏幕（工作区视口高亮项 · 检查器/流程面板作用目标）。真实屏幕列表来自
     proj.config.screens（见 pages/calibrate.tsx 的 projStore），此处只存 id。 */
  const [calActiveScreen, setCalActiveScreen] = useState(persisted.calActiveScreen || 'main');
  /* 屏幕预设（父级分组）：{ id, name, screenIds[] }。屏幕实体仍存项目 YAML；
     预设只是 UI 分组，本地持久化到 volo2.calPresets。 */
  const [calPresets, setCalPresets] = useState(() => {
    const raw = persisted.calPresets;
    if (Array.isArray(raw) && raw.length) return raw;
    return structuredClone(GRID_SCREEN_PRESETS);
  });
  const [calActivePreset, setCalActivePreset] = useState(persisted.calActivePreset || 'preset_main');
  /* calSel 不持久化：检查器初始必收起（见上方 rightCollapsed 注释），若挂载时恢复选中，
     详情会卡在 0 宽列里不可见，且重点同一对象不产生上升沿、弹不开。 */
  const [calSel, setCalSel] = useState(null);
  const [calStageType, setCalStageType] = useState(persisted.calStageType === 'ar' ? 'ar' : 'led');
  /* 视口交互态：object/cabinet 两级拾取模式（Tab 切换）；箱体模式子工具
     select/mask/refs（V/M/R 快捷键）；refs 工具当前指派角色。 */
  const [calMode, setCalMode] = useState(persisted.calMode === 'cabinet' ? 'cabinet' : 'object');
  const [calBoxTool, setCalBoxTool] = useState('select');
  const [calRefRole, setCalRefRole] = useState('origin');
  /* 网格版本切换器（视口底部中央）：original ⇄ rebuilt，overlay 叠加幽灵线框对比。 */
  const [calMeshVersion, setCalMeshVersion] = useState(persisted.calMeshVersion === 'overlay' || persisted.calMeshVersion === 'original' ? persisted.calMeshVersion : 'rebuilt');
  const [calView, setCalView] = useState(persisted.calView || 'persp');
  const [calDisplay, setCalDisplay] = useState(() => Object.assign({}, GRID_DISPLAY_DEFAULT));
  /* 测量导入流程面板：null=大纲态 · 'totalstation'/'visual'=对应流程激活（占左栏停靠位）。 */
  const [calFlow, setCalFlow] = useState(null);
  /* 检查器里「与另一 run 比对」临时选中的第二个 run（退出后清空，不持久化）。 */
  const [calSurveyRun, setCalSurveyRun] = useState(null);
  /* 屏幕设计表单的未保存草稿（gridInsp.tsx 的 ScreenForm 拥有），供 gridView.tsx
     视口做「改参数即时预览」；null = 未编辑（视口读 proj.config.screens 的已保存值）。
     只覆盖当前激活屏幕——同一时刻只编辑一块屏幕，其余屏幕视口一律读已保存值。 */
  const [calDraftScreen, setCalDraftScreen] = useState(null);
  /* 多屏视口同时渲染需要每块屏幕各自的「最新重建」摘要（非仅当前激活屏）。
     Record<screenId, ReconstructionReport | null>，由 gridPages.tsx 的
     controller 在 proj.config 变化时按屏幕 fan-out listRuns+getRunReport 填充；
     与 projStore.reconstruction（历史/检查器用，仍只挂当前屏）是两条独立读路径。 */
  const [calScreenReports, setCalScreenReports] = useState({});
  /* 视口右下角操作回执（自动消隐），不持久化。 */
  const [calReceipt, setCalReceipt] = useState(null);
  /* AR 板块左栏导航 + 「空间校正」折叠组展开状态 —— 与上面 calSection 同一持久化模式 */
  const CAL_AR_NAVS = ['overview', 'markers', 'lens', 'spatial', 'delay', 'verify', 'runs'];
  const [calArNav, setCalArNav] = useState(CAL_AR_NAVS.includes(persisted.calArNav) ? persisted.calArNav : 'overview');
  const [calArToolsOpen, setCalArToolsOpen] = useState(persisted.calArToolsOpen != null ? persisted.calArToolsOpen : true);
  const [calLensState, setCalLensState] = useState(persisted.calLensState || 'idle');
  /* ---- 上屏部署 + 镜头校正二级流程（handoff cal_flow）---- */
  const [calOutTarget, setCalOutTarget] = useState(persisted.calOutTarget === 'cluster' ? 'cluster' : 'monitor');
  const [deployState, setDeployState] = useState('idle'); /* idle | standby | showing */
  const [deployMeta, setDeployMeta] = useState(null); /* { channel, target, monitorIndex?, nodeCount? } */
  const [lensFlow, setLensFlow] = useState(null); /* null | 'capture'：嵌套流程标记；主 UI 走 VOLO_CALFLOW 大窗 */
  const [lensCalMethod, setLensCalMethod] = useState('qsp'); /* qsp | charuco | sl */
  const [capState, setCapState] = useState('idle'); /* idle | capturing */
  const [capDetail, setCapDetail] = useState(null); /* null | { runId, poseId } */
  /* 勿默认演示机位 id（旧 CAL_CAMERAS 的 cam1）；否则采集窗会盖住项目 cam-01，
     把孤儿 camera_id 写进 fixed_run，求解时无法写回 Stage pose。 */
  const [capCam, setCapCam] = useState(null);
  const [capTrack, setCapTrack] = useState('fixed'); /* connected | fixed | lost — 默认无追踪=固定机位 */
  const [capArReq, setCapArReq] = useState(null); /* null | { cam } — 求解报告→回大窗打开 AR 叠加 */
  const [capSignalReady, setCapSignalReady] = useState(false); /* 由采集窗监看流 / Profile 驱动 */
  const [capScreenFile, setCapScreenFile] = useState(null); /* null | string path */
  const [capProfileId, setCapProfileId] = useState(null);
  const [capProfileLabel, setCapProfileLabel] = useState('');
  const [capOutDir, setCapOutDir] = useState('');
  const [calSlUnlock, setCalSlUnlock] = useState(false);

  /* deployStore 会话态镜像（测试图 / 采集前置共用） */
  useEffect(() => {
    if (window.deployStore && window.deployStore.syncFromShell) {
      window.deployStore.syncFromShell({ deployState, calOutTarget, deployMeta });
    }
  }, [deployState, calOutTarget, deployMeta]);
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
    /* 首次成功后改为 background refresh，不翻转 loading，避免 gate 替换整页造成黑屏闪烁。 */
    if (!cacheFirstLoaded.current) setCacheLoading(true);
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
      cacheFirstLoaded.current = true;
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
      try { localStorage.setItem('volo2', JSON.stringify({ page, selNode, cacheNav, ddcOpen, calSection, calActiveScreen, calPresets, calActivePreset, calStageType, calMode, calMeshVersion, calView, calArNav, calArToolsOpen, calLensState, platform, density, toolsNav, leftW, rightW, logH, freshSetup, leftCollapsed })); } catch (e) {}
    }, 150);
    return () => clearTimeout(persistTimer.current);
  }, [page, selNode, cacheNav, ddcOpen, calSection, calActiveScreen, calPresets, calActivePreset, calStageType, calMode, calMeshVersion, calView, calArNav, calArToolsOpen, calLensState, platform, density, toolsNav, leftW, rightW, logH, freshSetup, leftCollapsed]);

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
    /* 封顶：LogPanel 无虚拟化，每条日志都触发全量 filter+map 重渲染；
       任何事件洪泛下无上限数组会让渲染成本 O(n²) 累积直至 WebView 冻结 */
    setLogs((prev) => {
      const next = [{ ts, ...entry }, ...prev];
      return next.length > 800 ? next.slice(0, 800) : next;
    });
  };
  const pushLogs = (entries) => entries.forEach((e, i) => setTimeout(() => pushLog(e), 60 * i));

  /* runTask — push an async task into the drawer + stream NDJSON to the console */
  const nowHM = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const runTask = ({ domain, action, target, chan = 'winrm', note, lines = [], fail = false, quiet = false, noLogOpen = false }) => {
    const no = taskSeq.current++;
    const id = 't_' + no;
    setTasks((prev) => [{ id, no, domain, action, title: `${domain} ${action}`, state: 'running',
      pct: 4, chan, started: nowHM(), elapsed: '0s', target, note, stream: lines.length > 2 }, ...prev]);
    applyTaskLogPop({ quiet, noLogOpen });
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

  /* runCmd/runStreamingCmd 共用的 detail 公共字段（task/domain/action/target/channel/note），
     调用方只需追加各自特有的字段（elapsed/result/error/…）。 */
  const baseDetailFields = (no, domain, action, target, chan, note) =>
    [['task', '#' + no], ['domain', domain], ['action', action], ['target', target], ['channel', chan], ['note', note]];

  /* runCmd — dispatch ONE real backend command (no event stream) into the same
     task drawer + NDJSON console as runTask. meta.chan must be 'winrm'|'ssh'.
     exec is a thunk returning the typed command Promise (e.g. () => deleteShare(id)).
     opts.okMsg(res) builds the success line from the result. Rethrows on failure
     so callers can react (e.g. skip optimistic UI). */
  const runCmd = async (meta, exec, opts = {}) => {
    const { domain, action, target, chan = 'winrm', note, quiet, noLogOpen } = meta;
    const no = taskSeq.current++;
    const id = 't_' + no;
    const title = `${domain} ${action}`;
    const t0 = Date.now();
    const secs = () => Math.max(1, Math.round((Date.now() - t0) / 1000)) + 's';
    setTasks((prev) => [{ id, no, domain, action, title, state: 'running', pct: 4, chan, started: nowHM(), elapsed: '0s', target, note, stream: false }, ...prev]);
    applyTaskLogPop({ quiet, noLogOpen });
    pushLog({ lv: 'info', cat: domain, ch: chan, task: no, msg: esc(opts.startMsg || `${title} …`) });
    try {
      const res = await exec();
      setTasks((prev) => prev.map((t) => t.id === id ? { ...t, state: 'success', pct: 100, exit: 0, elapsed: secs() } : t));
      pushLog({ lv: 'ok', cat: domain, ch: chan, task: no, msg: opts.okMsg ? esc(opts.okMsg(res)) : `<b>${title} #${no}</b> 完成`,
        detail: fmtDetail([...baseDetailFields(no, domain, action, target, chan, note),
          ['elapsed', secs()], ['result', res == null ? undefined : safeJson(res)]]) });
      return res;
    } catch (e) {
      const m = e && e.message ? e.message : String(e);
      /* err 落在任务对象上（不止推日志流），供状态框报警卡「点击复制错误信息」读取 */
      setTasks((prev) => prev.map((t) => t.id === id ? { ...t, state: 'failed', pct: 100, exit: 2, elapsed: secs(), err: m } : t));
      pushLog({ lv: 'err', cat: domain, ch: chan, task: no, msg: `<b>${title} #${no}</b> 失败 · ${esc(m)}`,
        detail: fmtDetail([...baseDetailFields(no, domain, action, target, chan, note),
          ['command', e && e.command], ['elapsed', secs()], ['error', m]]) });
      /* Persist the failure to the operations table. Frontend-orchestrated ops
         (share join/leave, …) can fail BEFORE any backend command runs, so they
         leave no `logged(...)` row — without this the error has no DB trail.
         Best-effort: never let logging mask the real failure. */
      call<void>("record_operation", { actionType: `${domain}.${action}`, targetMachines: [], status: "err", logText: `${note || ""} · ${target || ""} · ${m}`.trim() }).catch(() => {});
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
    const { domain, action, target, chan = 'winrm', note, quiet, noLogOpen } = meta;
    const no = taskSeq.current++;
    const id = 't_' + no;
    const title = `${domain} ${action}`;
    const t0 = Date.now();
    const secs = () => Math.max(1, Math.round((Date.now() - t0) / 1000)) + 's';
    setTasks((prev) => [{ id, no, domain, action, title, state: 'running', pct: 4, chan, started: nowHM(), elapsed: '0s', target, note, stream: true, long: !!wiring.cancellable }, ...prev]);
    applyTaskLogPop({ quiet, noLogOpen });
    pushLog({ lv: 'info', cat: domain, ch: chan, task: no, msg: esc(note || `${title} …`) });

    /* 浏览器预览（无 Tauri runtime）：不能 listen，直接失败收尾，不挂起。 */
    if (!isTauri()) {
      setTasks((prev) => prev.map((t) => t.id === id ? { ...t, state: 'failed', pct: 100, exit: 2, elapsed: secs(), err: '浏览器预览无后端' } : t));
      pushLog({ lv: 'err', cat: domain, ch: chan, task: no, msg: `<b>${title} #${no}</b> 失败 · 浏览器预览无后端` });
      throw new VoloInvokeError('runStreamingCmd', '未运行在 Tauri 运行时');
    }

    let jobId = null, finished = false, timer = null;
    let cancelJobIds = null, cancelWanted = false; /* 用户取消：kickoff 前点了先记账，job_id 到手立即补发 */
    let uns = [];
    const buf = [];
    const st = {};
    const isMine = wiring.isMine || ((p, jid) => p && p.job_id === jid);
    const setPct = (p) => { if (p != null) setTasks((prev) => prev.map((t) => t.id === id ? { ...t, pct: Math.max(4, Math.min(99, Math.round(p))) } : t)); };
    const finalize = (ok, exit, payload, canceled, errMsg) => {
      if (finished) return;
      finished = true;
      if (timer) { clearTimeout(timer); timer = null; }
      delete streamCtl.current[id];
      const ex = ok ? 0 : (exit == null ? 2 : exit);
      const state = ok ? 'success' : canceled ? 'canceled' : 'failed';
      /* err 落在任务对象上（不止推日志流）：reducer 终态日志行通常就是真实失败原因，
         供状态框报警卡「点击复制错误信息」读取，而不是只能读到静态的 note 描述。 */
      setTasks((prev) => prev.map((t) => t.id === id ? { ...t, state, pct: 100, exit: ex, elapsed: secs(), note: canceled ? '已手动取消 · 远端 UE 进程已终止' : t.note, err: (!ok && !canceled) ? (errMsg || t.err) : t.err } : t));
      const detail = fmtDetail([...baseDetailFields(no, domain, action, target, chan, note),
        ['elapsed', secs()], ['exit', ex], ['event', payload === undefined ? undefined : safeJson(payload)]]);
      pushLog(ok
        ? { lv: 'ok', cat: domain, ch: chan, task: no, msg: `<b>${title} #${no}</b> 完成`, detail }
        : canceled
          ? { lv: 'warn', cat: domain, ch: chan, task: no, msg: `<b>${title} #${no}</b> 已取消 · 远端 UE 进程已终止`, detail }
          : { lv: 'err', cat: domain, ch: chan, task: no, msg: `<b>${title} #${no}</b> 失败 · exit ${ex}`, detail });
      uns.forEach((u) => { try { u(); } catch (e) {} });
      if (wiring.onDone) { try { wiring.onDone(ok); } catch (e) {} } /* 完成回调（如收集后重载列表）*/
    };
    /* 可取消长任务（UE runner 后端有 UeJobRegistry）：注册取消入口。取消 = 对全部 job_id
       发 cancel_ue_job（预热 fan-out 是每台一个 job），真正的 canceled 终态由事件流回传
      （runner 停进程 → Cancelled/finalized 事件 → reduce 标 canceled）。 */
    if (wiring.cancellable) {
      streamCtl.current[id] = {
        requestCancel: () => {
          if (finished || cancelWanted) return;
          cancelWanted = true;
          pushLog({ lv: 'warn', cat: domain, ch: chan, task: no, msg: `<b>${title} #${no}</b> 取消请求已发送 · 正在终止远端 UE 进程…` });
          (cancelJobIds || []).forEach((jid) => cancelUeJob(jid).catch(() => {}));
        },
      };
    }
    /* 空闲超时计时器：每收到一个真实事件就重置 → 持续出进度的健康长任务永不误判，
       只有真·timeoutMs 内零事件才触发；到点调 onTimeout(jobId)（如 cancelUeJob）避免孤儿进程。 */
    const armTimer = () => {
      if (!wiring.timeoutMs || finished) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (finished) return;
        const timeoutMsg = `超时 ${Math.round(wiring.timeoutMs / 60000)} 分钟无进度事件，停止等待`;
        pushLog({ lv: 'warn', cat: domain, ch: chan, task: no, msg: timeoutMsg });
        if (jobId != null) {
          try {
            if (wiring.onTimeout) wiring.onTimeout(jobId);
            else cancelUeJob(jobId).catch(() => {});
          } catch (e) {}
        }
        finalize(false, 124, undefined, false, timeoutMsg);
      }, wiring.timeoutMs);
    };
    const apply = (ev, p) => {
      const r = wiring.reduce(ev, p, st) || {};
      if (r.log && r.log.msg) pushLog({ lv: r.log.lv || 'info', cat: domain, ch: chan, task: no, msg: esc(r.log.msg) });
      if (r.pct != null) setPct(r.pct);
      /* 失败时把 reducer 这一步的终态日志文案（真实失败原因）带给 finalize 落到任务 err 字段上；
         canceled 只信 reducer 的判定：取消请求后先到达的真实 err 终态必须仍标 failed，不能被
         cancelWanted 盖成 canceled */
      if (r.done) finalize(!!r.ok, r.exit, p, !!r.canceled, (!r.ok && r.log) ? r.log.msg : undefined);
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
      setTasks((prev) => prev.map((t) => t.id === id ? { ...t, state: 'failed', pct: 100, exit: 2, elapsed: secs(), err: m } : t));
      pushLog({ lv: 'err', cat: domain, ch: chan, task: no, msg: `<b>${title} #${no}</b> 失败 · ${esc(m)}`,
        detail: fmtDetail([...baseDetailFields(no, domain, action, target, chan, note),
          ['command', e && e.command], ['elapsed', secs()], ['error', m]]) });
      uns.forEach((u) => { try { u(); } catch (e2) {} });
      throw e;
    }

    if (wiring.mode === 'event') {
      jobId = wiring.jobIdOf(resp);
      if (wiring.total) st.total = wiring.total(resp); /* 分发流：reducer 数到 st.total 即收尾 */
      /* 取消目标 job 集合就位（预热 fan-out 是每台一个 job_id）；kickoff 前已请求取消则立即补发 */
      cancelJobIds = wiring.cancelIds ? wiring.cancelIds(resp) : (jobId != null ? [jobId] : []);
      if (cancelWanted) (cancelJobIds || []).forEach((jid) => cancelUeJob(jid).catch(() => {}));
      buf.forEach(([ev, p]) => { if (!isMine || isMine(p, jobId)) apply(ev, p); });
      if (st.total === 0) finalize(true, 0); /* 空 plan：无事件，立即收尾 */
      else armTimer(); /* 武装空闲超时兜底：generate_ddc_pak 等后端无 watchdog，UE 异常退出且
                          日志未命中终止串时后端永不发 completed → 任务卡 running。空闲超时到点
                          调 onTimeout(jobId) 取消后端 job + 标失败，避免僵任务（PSO 有 watchdog，此为双保险）。 */
    } else {
      finalize(true, 0, resp); /* 'await' 模式：kickoff 已是终态，resp 即真实返回值 */
    }
    return resp;
  };

  /* cancelTask — 任务抽屉「取消」入口：查注册表转发给对应流式任务的 requestCancel */
  const cancelTask = (id) => {
    const ctl = streamCtl.current[id];
    if (ctl) ctl.requestCancel();
  };

  const cluster = deriveCluster(machines, healthChecks, healthRunAt);

  /* 检查器：目标消失时自动收起。屏幕设计 / 测试图 / 上屏部署 / 重建 页常显检查器。
     校正（镜头）页完全手动：选/不选屏幕都不自动弹出，空白点击不关闭（仅 DrawerToggle）。 */
  const inspectorHasTargetRef = useRef(false);
  useEffect(() => {
    /* 镜头校正页：不自动开合；ref 置 true，离开时若落到无目标页会走下降沿收起。 */
    if (page === 'calibrate' && calStageType === 'led' && calSection === 'lens') {
      inspectorHasTargetRef.current = true;
      return;
    }
    const calPinned = page === 'calibrate' && (calSection === 'rebuild' || calSection === 'pattern' || calSection === 'screen' || calSection === 'deploy');
    const hasTarget = !!drawer || !!psoSel || !!calSel || calPinned;
    if (!hasTarget && inspectorHasTargetRef.current) setRightCollapsed(true);
    /* 进入常显页时若检查器仍收起则展开一次（上升沿）。 */
    if (hasTarget && !inspectorHasTargetRef.current && calPinned) setRightCollapsed(false);
    inspectorHasTargetRef.current = hasTarget;
  }, [drawer, psoSel, calSel, page, calSection, calStageType]);

  /* 切缓存子页：清掉不属于目标子页的检查器目标（drawer），检查器保持收起。 */
  const goCacheNav = (v) => {
    setDrawer(null);
    if (v !== 'ddc_pso') setPsoSel(null);
    inspectorHasTargetRef.current = v === 'ddc_pso' ? !!psoSel : false;
    setRightCollapsed(true);
    if (/^ddc_/.test(v)) {
      setCacheDdcEverOpened(true);
      setDdcViewsSeen((prev) => (prev[v] ? prev : Object.assign({}, prev, { [v]: true })));
    }
    setCacheNav(v);
  };

  /* 切顶层页面：检查器目标都是页面私有的（工具页: drawer/psoSel · 校正页: calSel），
     离开即失效——全部清空并收起右栏（点到与检查器无关的页面时自动隐藏）；同样对齐 ref
     吞掉 effect 下降沿。回到原页面后重新选中对象，再由用户点击检查器查看。 */
  const goPage = (v) => {
    if (v !== page) {
      setDrawer(null); setPsoSel(null); setCalSel(null);
      inspectorHasTargetRef.current = false;
      setRightCollapsed(true);
      if (v === 'cache') setLogOpen(false);
    }
    setPage(v);
  };

  const s = { theme, toggleTheme, platform, setPlatform, toolsNav, setToolsNav, page, setPage: goPage, logOpen, setLogOpen, logFilter, setLogFilter,
    logs, pushLog, pushLogs, logH, setLogH,
    selNode, setSelNode, cacheNav, setCacheNav: goCacheNav, ddcOpen, setDdcOpen,
    cacheDdcEverOpened, ddcViewsSeen, drawer, setDrawer,
    modal, setModal,
    psoSel, setPsoSel,
    psoStatusByProject, setPsoStatusByProject, psoRunsByProject, setPsoRunsByProject,
    psoDriverSnapshots, setPsoDriverSnapshots, psoSettingsByProject, setPsoSettingsByProject,
    freshSetup, setFreshSetup, machinesAdded, setMachinesAdded,
    enrolled, setEnrolled, creds, setCreds,
    tasks, setTasks, runTask, runCmd, runStreamingCmd, cancelTask, suppressRunPop, conTab, setConTab, logSearch, setLogSearch, logPaused, setLogPaused,
    calSection, setCalSection, calActiveScreen, setCalActiveScreen, calSel, setCalSel,
    calPresets, setCalPresets, calActivePreset, setCalActivePreset,
    calStageType, setCalStageType, calMode, setCalMode, calBoxTool, setCalBoxTool, calRefRole, setCalRefRole,
    calMeshVersion, setCalMeshVersion, calView, setCalView, calDisplay, setCalDisplay,
    calFlow, setCalFlow, calSurveyRun, setCalSurveyRun, calReceipt, setCalReceipt,
    calDraftScreen, setCalDraftScreen, calScreenReports, setCalScreenReports,
    calArNav, setCalArNav, calArToolsOpen, setCalArToolsOpen,
    calLensState, setCalLensState,
    calOutTarget, setCalOutTarget, deployState, setDeployState, deployMeta, setDeployMeta,
    lensFlow, setLensFlow, lensCalMethod, setLensCalMethod,
    capState, setCapState, capDetail, setCapDetail, capCam, setCapCam,
    capTrack, setCapTrack, capArReq, setCapArReq,
    capSignalReady, setCapSignalReady, capScreenFile, setCapScreenFile,
    capProfileId, setCapProfileId, capProfileLabel, setCapProfileLabel,
    capOutDir, setCapOutDir, calSlUnlock, setCalSlUnlock,
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
  /* 把每个页面渲染槽包进 error boundary；render 是 thunk（在 Slot 子组件内调用，使槽函数本身的
     同步抛错也被捕获）；key 随 page 变 → 切顶层页即 remount 清错误；cacheNav 走 resetKey 只清
     错误态不 remount（否则 Cache keep-alive 失效，见 ErrBoundary 注释）。 */
  const guard = (slot, render) => h(ErrBoundary, { key: 'eb-' + slot + '-' + page, resetKey: cacheNav, slot: slot }, h(Slot, { render: render }));
  return h('div', { className: 'desktop is-' + platform + (density === 'clean' ? ' clean' : '') },
    /* SysBar 隐藏：mac 原生系统菜单栏（src-tauri set_menu）已提供真实功能菜单，
       in-window SysBar 是浏览器原型对系统菜单栏的冗余模拟（SysBar 仍保留定义作设计参照） */
    null,
    h('div', { className: 'win is-' + platform },
      mac ? h(MacTitleBar, { s }) : h(WinTopBar, { s }),
      h('div', { className: 'ctxbar' }, guard('ctx', () => pg.ctx(s)), h(DrawerToggle, { s, style: { marginLeft: 'auto', flex: '0 0 auto' } })),
      h('div', { className: 'body', style: { gridTemplateColumns: `${leftCollapsed ? 0 : leftW}px ${leftCollapsed ? 0 : 6}px minmax(0,1fr) ${rightCollapsed ? 0 : 6}px ${rightCollapsed ? 0 : Math.max(330, rightW)}px` } },
        h('div', { className: 'leftcol' + (leftCollapsed ? ' is-collapsed' : '') }, guard('left', () => pg.left(s))),
        h('div', { className: 'resizer resizer--col' + (leftCollapsed ? ' is-hidden' : ''), title: '拖动调整宽度',
          onPointerDown: (e) => { if (leftCollapsed) return; startResize(e, 'x', 1, leftW, setLeftW, 170, 380); } }),
        h('div', { className: 'center' }, guard('center', () => pg.center(s))),
        h('div', { className: 'resizer resizer--col' + (rightCollapsed ? ' is-hidden' : ''), title: '拖动调整宽度',
          onPointerDown: (e) => { if (rightCollapsed) return; startResize(e, 'x', -1, rightW, setRightW, 330, 620); } }),
        /* 检查器（右栏）= 就地细节显示：机器详情 / 操作预览 / 入网脚本 / 凭据 / DDC PAK·PSO 检查器
           都在 inspector 列内就地渲染（见 cache.tsx 的 inspector dispatcher），不再弹滑窗 + 遮罩。 */
        h('div', { className: 'inspector' + (rightCollapsed ? ' is-collapsed' : '') }, guard('inspector', () => pg.inspector(s)))),
      h(PageTabs, { s })),
    /* 居中二级对话框层（部署 / 修复 / 巡检的 preview→进度→成功/失败），挂在 .desktop 顶层覆盖全窗。
       包进 ErrBoundary（同其它渲染槽）：modal 渲染操作驱动的动态内容，是最易抛错的覆盖层，崩了不该黑屏整树。 */
    guard('modal', () => (window.VOLO_CACHE ? window.VOLO_CACHE.modalLayer(s) : null)),
    TweaksPanel ? h(TweaksPanel, { title: 'Tweaks' },
      h(TweakSection, { label: '集群总览 · Cluster' }),
      TweakToggle ? h(TweakToggle, { label: '全新设置（空集群）', value: freshSetup,
        onChange: (v) => { setFreshSetup(v); if (v) setMachinesAdded(false); } }) : null,
      h(TweakSection, { label: '工具页 · Tools' }),
      h(TweakRadio, { label: '区段导航', value: toolsNav,
        options: [{ value: 'top', label: '顶栏分类' }, { value: 'left', label: '左侧列表' }],
        onChange: setToolsNav }),
      h(TweakSection, { label: '校正 · Calibrate' }),
      h(TweakRadio, { label: '舞台类型', value: calStageType,
        options: [{ value: 'led', label: 'LED' }, { value: 'ar', label: 'AR' }],
        onChange: setCalStageType }),
      h(TweakSection, { label: '镜头校正流程 · Lens flow' }),
      TweakToggle ? h(TweakToggle, { label: '上屏已部署（黑场待机）', value: deployState !== 'idle', onChange: (v) => setDeployState(v ? 'standby' : 'idle') }) : null,
      TweakToggle ? h(TweakToggle, { label: '信号源就绪', value: capSignalReady, onChange: setCapSignalReady }) : null,
      TweakToggle ? h(TweakToggle, { label: '已选屏幕文件', value: !!capScreenFile, onChange: (v) => setCapScreenFile(v ? '<demo>' : null) }) : null,
      h(TweakRadio, { label: '追踪状态', value: capTrack,
        options: [{ value: 'connected', label: '已接入' }, { value: 'lost', label: '断流' }, { value: 'fixed', label: '固定机位' }], onChange: setCapTrack }),
      TweakToggle ? h(TweakToggle, { label: '结构光方式可选（演示播放采集态）', value: calSlUnlock, onChange: setCalSlUnlock }) : null,
      h(TweakRadio, { label: '输出目标', value: calOutTarget,
        options: [{ value: 'monitor', label: '本机显示器' }, { value: 'cluster', label: 'nDisplay 集群' }], onChange: setCalOutTarget }),
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
