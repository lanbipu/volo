// @ts-nocheck
/* Volo — Cache · PSO · 上场就绪保障 Dashboard + 设置
   1:1 port of the Claude Design handoff `src/pso_dash.jsx`，接真实后端替代其 mock 状态机。

   心智模型（设计稿原文，未变）：绿灯是实测出来的 · 绿灯会过期 · 预跑无人值守。
   本视图不呈现任何官方 PSO 指标（stat PSOPrecache / Validation / Missed / Too-late / 加载屏计数）
   ——编辑器 -game 形态下这些无数据源；也不呈现覆盖率百分比。完成度只由「收敛曲线走平」表达，
   禁止百分比进度条。长任务流式日志走页面底部控制台（s.pushLog / 任务抽屉）。

   真实数据源映射（对应设计稿 mock）：
     PNODES/PPROJ  → window.RENDER_NODES(过滤 roleKey==='render') / window.UE_PROJECTS
     GL_SEED       → list_pso_status（PsoStatusCell，ok/degraded/none 三态 + invalidation_reasons）
                      按工程 fan-out 存 s.psoStatusByProject；5 态由 glOf() 在 3 态基础上结合节点
                      在线态 + 失效原因分类现算（node_rebooted-only → 需复验，其余原因 → 已失效）
     CACHE_ROWS    → list_driver_cache_snapshots 批量读库（无 SSH），存 s.psoDriverSnapshots
     HIST_SEED     → list_pso_warmup_runs 按工程 fan-out 存 s.psoRunsByProject，跨工程合并时间倒序
     ALERTS        → 从 s.psoStatusByProject 里各 cell.invalidation_reasons 聚合，时间倒序取前 N
     CHECKS        → 真实巡检信号（预跑设置完整度 / DDC 就绪 zen_status / 遍历引擎地图路径配置度），
                      不含设计稿「附加参数与拍摄一致」那条——本仓没有「拍摄档」这个可比对的真实概念，
                      诚实起见不编造，见本文件 ChecksCard 注释
     CFG_SEED      → get/set_pso_project_settings 按工程持久化（新表 pso_project_settings）
     NDC_ASSETS    → discover_ndisplay_assets（SSH 递归扫 .ndisplay，选中工程时按需触发，不预加载）

   遍历引擎（RC WebSocket 驱动舞台扫场 + 收敛判定）设计稿标「只读」，但 TraversalRequest.map_path
   是必填才能启用——设计稿没给这个字段留输入框，本次移植在「设置 · 预跑范围」组新增了一个
   「地图包路径」输入（对预跑效果的必要补全，不是无中生有的新功能）；留空的工程预跑仍然完整可用，
   只是退化为固定机位、没有收敛 sparkline 数据（HistoryCard 运行态区块按此优雅降级，不伪造数据）。

   s.psoSel 语义（随此次改造从「选中的工程 id」改为「选中的绿灯矩阵单元格」）：{proj,node} | null，
   proj = ProjectVM.id，node = NodeVM.id（不是 machineId）。cacheDdc.tsx 的 ddc_pso 路由已改指向
   本文件导出的 window.VOLO_CACHE_PSO_DASH.{center,inspector}。 */
import * as React from "react";
import "../ds";
import "./cache";
import { listen } from "@tauri-apps/api/event";
import {
  listPsoStatus, listPsoWarmupRuns, startPsoWarmup, startPsoColdtest, cancelUeJob,
  listDriverCacheSnapshots, getPsoProjectSettings, setPsoProjectSettings,
  discoverNdisplayAssets, checkPsoConfigPreflight, discoverProjects, zenStatus,
} from "../api/commands";

(function () {
  const { Button } = window.Spectrum2DesignSystem_b6d1b3;
  const { useState, useRef, useEffect } = React;
  const h = React.createElement;
  const CX = window.VOLO_CX;
  const Selector = window.Selector;
  const mono = (t) => h('span', { className: 'mono' }, t);
  /* 惰性引用 window.VOLO_CACHE_DDC——本文件与 cacheDdc.tsx 都在 index.tsx 里 import，模块级顶层
     不能假定加载顺序；延到调用时才取，避免顶层 const 捕获到 undefined。 */
  const humanBytes = (b) => window.VOLO_CACHE_DDC.humanBytes(b);

  /* =================== 真实数据源 helper（每次渲染直读全局，跟随 reloadCache 自动刷新）=== */
  const PNODES = () => (window.RENDER_NODES || []).filter((n) => n.roleKey === 'render');
  const PPROJ = () => window.UE_PROJECTS || [];
  const NODE = (id) => (window.RENDER_NODES || []).find((n) => n.id === id);
  const PROJ = (id) => (window.UE_PROJECTS || []).find((p) => String(p.id) === String(id));
  const gpuSigOf = (s, machineId) => {
    const cells = (s.gpuMatrix && s.gpuMatrix.cells) || [];
    const cell = cells.find((c) => c.machine_id === machineId);
    return (cell && cell.signature) || null;
  };
  const gpuText = (sig) => sig ? (sig.model + (sig.driver ? ' · 驱动 ' + sig.driver : '')) : '—';

  /* 五态：色 + 图标 + 文字三通道表达（对齐设计稿 GLS） */
  const GLS = {
    ready:   { label: '已就绪', vis: 'positive', icon: 'check', cell: 'ready' },
    stale:   { label: '需复验', vis: 'notice',   icon: 'sync',  cell: 'stale' },
    invalid: { label: '已失效', vis: 'negative', icon: 'alert', cell: 'invalid' },
    never:   { label: '未预跑', vis: 'neutral',  icon: 'minus', cell: 'never' },
    offline: { label: '离线',   vis: 'neutral',  icon: 'power', cell: 'off' },
  };
  const REASON_LABEL = {
    gpu_driver_changed: '显卡驱动已升级',
    cache_shrunk: '缓存目录疑似被清理',
    cache_directory_missing: '缓存目录已消失',
    interactive_user_changed: '交互账户已变更',
    node_rebooted: '节点已重启',
  };
  const MODE_LABEL = { ndisplay_offscreen: '后台', ndisplay_fullscreen: '窗口', coldtest: '冷启动' };
  const RES_META = {
    ok:        { label: '成功',   vis: 'positive',    icon: 'check' },
    running:   { label: '进行中', vis: 'informative', icon: 'sync' },
    cancelled: { label: '已取消', vis: 'neutral',     icon: 'minus' },
    err:       { label: '失败',   vis: 'negative',     icon: 'x' },
    not_ready: { label: '未达标', vis: 'notice',      icon: 'alert' },
  };

  /* =================== 时间格式化 =================== */
  const parseTs = (ts) => {
    if (!ts) return null;
    const iso = String(ts).includes('T') || /Z$/.test(String(ts)) ? String(ts) : String(ts).replace(' ', 'T') + 'Z';
    const d = new Date(iso);
    return isNaN(d.getTime()) ? null : d;
  };
  const fmtRel = (ts) => {
    const d = parseTs(ts); if (!d) return null;
    const mins = Math.max(0, Math.floor((Date.now() - d.getTime()) / 60000));
    if (mins < 1) return '刚刚验证';
    if (mins < 60) return mins + ' 分钟前验证';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + ' 小时前验证';
    const days = Math.floor(hrs / 24);
    return (days === 1 ? '昨天' : days + ' 天前') + '验证';
  };
  const fmtWhen = (ts) => {
    const d = parseTs(ts); if (!d) return '—';
    const now = new Date();
    const p = (x) => String(x).padStart(2, '0');
    const hm = p(d.getHours()) + ':' + p(d.getMinutes());
    if (d.toDateString() === now.toDateString()) return '今天 ' + hm;
    const yest = new Date(now); yest.setDate(now.getDate() - 1);
    if (d.toDateString() === yest.toDateString()) return '昨天 ' + hm;
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + hm;
  };
  const fmtDur = (secs) => secs == null ? '—' : secs >= 60 ? (Math.round(secs / 60) + ' 分钟') : (secs + ' 秒');

  /* =================== 绿灯五态映射（3 态后端 + 在线态 + 失效原因分类 → 5 态）=================== */
  const glOf = (s, projId, node) => {
    if (!node || node.status === 'offline') return { state: 'offline' };
    const cells = (s.psoStatusByProject && s.psoStatusByProject[projId]) || [];
    const cell = cells.find((c) => c.machine_id === node.machineId);
    if (!cell || cell.status === 'none') return { state: 'never', cell: cell || null };
    if (cell.status === 'ok') return { state: 'ready', verified: fmtRel(cell.green_verified_at), cell };
    const reasons = (cell.invalidation_reasons || []);
    const onlyReboot = reasons.length > 0 && reasons.every((r) => r.reason === 'node_rebooted');
    const primary = reasons[0];
    return {
      state: onlyReboot ? 'stale' : 'invalid',
      verified: fmtRel(cell.green_verified_at),
      reason: primary ? (REASON_LABEL[primary.reason] || primary.detail) : null,
      cell,
    };
  };
  const readyCount = (s) => {
    let ok = 0, tot = 0;
    PPROJ().forEach((p) => PNODES().forEach((n) => {
      if (n.status === 'offline') return;
      tot += 1;
      if (glOf(s, p.id, n).state === 'ready') ok += 1;
    }));
    return { ok, tot };
  };
  const lastRunFor = (s, projId, machineId) => ((s.psoRunsByProject && s.psoRunsByProject[projId]) || []).find((r) => r.machine_id === machineId) || null;
  const runById = (s, projId, runId) => ((s.psoRunsByProject && s.psoRunsByProject[projId]) || []).find((r) => r.id === runId) || null;

  /* =================== 驱动缓存异常标注：从各工程 cell 的失效事件里找该机最近一次 cache_shrunk /
     interactive_user_changed（不需要「之前值」——事件 detail 文本里已经带着 "X -> Y" 的对比）=== */
  const driverAnomalyFor = (s, machineId) => {
    let shrunk = null, account = null;
    Object.keys(s.psoStatusByProject || {}).forEach((pid) => {
      (s.psoStatusByProject[pid] || []).forEach((cell) => {
        if (cell.machine_id !== machineId) return;
        (cell.invalidation_reasons || []).forEach((ev) => {
          if (ev.reason === 'cache_shrunk' && (!shrunk || (ev.detected_at || '') > (shrunk.detected_at || ''))) shrunk = ev;
          if (ev.reason === 'interactive_user_changed' && (!account || (ev.detected_at || '') > (account.detected_at || ''))) account = ev;
        });
      });
    });
    return { shrunk, account };
  };

  /* =================== 数据加载：按工程 fan-out（互不阻塞，单工程失败不拖垮整体）=================== */
  const loadPsoData = (s) => {
    const projs = PPROJ();
    if (!projs.length) { s.setPsoStatusByProject({}); s.setPsoRunsByProject({}); return Promise.resolve(); }
    const machineIds = PNODES().map((n) => n.machineId);
    return Promise.all(projs.map((p) => Promise.all([
      listPsoStatus(Number(p.id), machineIds).catch(() => []),
      listPsoWarmupRuns(Number(p.id), null).catch(() => []),
    ]).then(([status, runs]) => ({ id: p.id, status, runs })))).then((rows) => {
      const st = {}, rn = {};
      rows.forEach((r) => { st[r.id] = r.status; rn[r.id] = r.runs; });
      s.setPsoStatusByProject(st);
      s.setPsoRunsByProject(rn);
    });
  };
  const loadDriverSnapshots = (s) => {
    const ids = PNODES().map((n) => n.machineId);
    if (!ids.length) { s.setPsoDriverSnapshots({}); return Promise.resolve(); }
    return listDriverCacheSnapshots(ids).then((rows) => {
      const m = {}; (rows || []).forEach((r) => { m[r.machine_id] = r; });
      s.setPsoDriverSnapshots(m);
    }).catch(() => {});
  };
  const loadPsoSettings = (s) => {
    const projs = PPROJ();
    if (!projs.length) { s.setPsoSettingsByProject({}); return Promise.resolve(); }
    return Promise.all(projs.map((p) => getPsoProjectSettings(Number(p.id))
      .then((r) => ({ id: p.id, settings: r }))
      .catch(() => ({ id: p.id, settings: null }))))
      .then((rows) => { const m = {}; rows.forEach((r) => { m[r.id] = r.settings; }); s.setPsoSettingsByProject(m); });
  };
  const refreshAll = (s) => Promise.all([loadPsoData(s), loadDriverSnapshots(s), loadPsoSettings(s)]);

  /* =================== 设置读取 helper =================== */
  const settingsOf = (s, projId) => (s.psoSettingsByProject || {})[projId] || null;
  const cfgHasSource = (settings) => !settings ? false
    : settings.dc_cfg_source === 'asset' ? !!(settings.dc_cfg_asset && settings.dc_cfg_asset.trim())
    : !!(settings.dc_cfg_manual_path && settings.dc_cfg_manual_path.trim());
  const cfgTargetIds = (settings) => { try { const a = JSON.parse((settings && settings.target_machine_ids) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } };
  const cfgComplete = (settings) => cfgHasSource(settings) && cfgTargetIds(settings).length > 0;
  const cfgDcPath = (settings) => settings.dc_cfg_source === 'asset' ? settings.dc_cfg_asset : settings.dc_cfg_manual_path;

  /* =================== 跨工程合并历史（时间倒序）=================== */
  const histAll = (s) => {
    const all = [];
    Object.keys(s.psoRunsByProject || {}).forEach((pid) => {
      (s.psoRunsByProject[pid] || []).forEach((r) => all.push(Object.assign({ __proj: pid }, r)));
    });
    all.sort((a, b) => String(b.started_at || '').localeCompare(String(a.started_at || '')));
    return all;
  };

  /* =================== 预跑 / 复验：真实 start_pso_warmup + runStreamingCmd =================== */
  const warmupReduce = (hostOf) => (ev, p, st) => {
    st.done = st.done || new Set();
    const host = hostOf(p && p.machine_id) || ('机器 ' + (p && p.machine_id));
    if (ev === 'pso-warmup-finalized') {
      st.done.add(p.machine_id);
      if (p.status === 'err') st.anyErr = true;
      if (p.status === 'cancelled') st.anyCancel = true;
      if (p.status === 'not_ready') st.anyNotReady = true;
      const done = st.total != null && st.done.size >= st.total;
      return {
        pct: st.total ? (st.done.size / st.total * 100) : null,
        done,
        ok: done ? (!st.anyErr && !st.anyCancel && !st.anyNotReady) : undefined,
        canceled: done && !st.anyErr && !st.anyNotReady && !!st.anyCancel,
        exit: done && st.anyErr ? 2 : 0,
        log: p.status === 'ok'
          ? { lv: 'ok', msg: host + ' 预跑并验证完成 · 验证段 hitch 0 · 绿灯已点亮' }
          : p.status === 'not_ready'
            ? { lv: 'warn', msg: host + ' 验证未达标 · 验证段 hitch ' + (p.verify_hitch_count == null ? '—' : p.verify_hitch_count) }
            : p.status === 'cancelled' ? { lv: 'warn', msg: host + ' 已取消（未验证）' }
              : { lv: 'err', msg: host + ' 运行失败 · ' + (p.error_message || '') },
      };
    }
    const e = p && p.event ? p.event : {};
    switch (e.kind) {
      case 'spawned': return { log: { lv: 'info', msg: host + ' 本机拉起 UE -game · pid ' + e.pid } };
      case 'log_line': return e.parsed_kind ? { log: { lv: e.parsed_kind === 'pso_hitch' ? 'warn' : 'info', msg: '[' + host + '] ' + e.text } } : {};
      default: return {};
    }
  };
  /* 单工程一次预跑（多机 fan-out 在同一个 start_pso_warmup 请求里完成）。jobsRef（可选）收集
     真实 {jobId,parentJobId}，供 Dashboard 运行态卡的取消按钮 / 事件过滤白名单使用；不传则只走
     runStreamingCmd 自带的任务抽屉 + 控制台流（复验场景不需要这层实时可视化）。 */
  const launchWarmupOne = (s, p, nodes, opts, jobsRef) => {
    const settings = settingsOf(s, p.id);
    const dcPath = settings ? cfgDcPath(settings) : null;
    if (!dcPath) return Promise.reject(new Error(p.name + ' 未配置 nDisplay 配置来源，请先在「设置」中配置'));
    /* dc_node 是 nDisplay 集群节点 id（-dc_node/-StageFriendlyName），必须与 dc_cfg 指向的
       .ndisplay 配置内定义的节点名一致——不能从配置文件路径/文件名派生（两者语义无关）。 */
    const dcNode = (settings.dc_node && settings.dc_node.trim()) || 'Node_0';
    const extraArgs = (settings.extra_args || '').split(/\s+/).filter(Boolean);
    const traversal = settings.map_path && settings.map_path.trim()
      ? { map_path: settings.map_path.trim(), probe_interval_secs: settings.probe_interval_secs || 30 } : null;
    const hostOf = (mid) => { const n = PNODES().find((x) => x.machineId === mid); return n ? n.host : null; };
    return new Promise((resolve, reject) => {
      let started = false;
      s.runStreamingCmd(
        { domain: 'pso', action: 'prerun', target: p.name + ' · ' + nodes.length + ' 台', chan: 'ssh',
          note: '预跑并验证 · ' + p.name + '（长任务 · 可在任务抽屉取消）' },
        () => startPsoWarmup({ project_id: Number(p.id), target_machine_ids: nodes.map((n) => n.machineId),
          resolution_w: 1920, resolution_h: 1080, max_minutes: opts.maxMinutes || settings.max_minutes || 20,
          dc_cfg_path: dcPath, dc_node: dcNode, offscreen: opts.headless !== false,
          extra_args: extraArgs, traversal, ue_version: null }).then((r) => {
            started = true;
            if (jobsRef) (r.runs || []).forEach((run) => jobsRef.current.push({ jobId: run.job_id, parentJobId: r.job_id }));
            resolve(r);
            return r;
          }),
        { mode: 'event', events: ['pso-warmup-progress', 'pso-warmup-finalized', 'pso-traversal-progress'],
          jobIdOf: (r) => r.job_id,
          isMine: (pp, jid) => pp && pp.parent_job_id === jid,
          total: (r) => (r.runs || []).length,
          cancellable: true, cancelIds: (r) => (r.runs || []).map((x) => x.job_id),
          reduce: warmupReduce(hostOf),
          timeoutMs: ((opts.maxMinutes || settings.max_minutes || 20) + 15) * 60 * 1000,
          onDone: () => { loadPsoData(s); loadDriverSnapshots(s); } })
        .catch((err) => { if (!started) reject(err); });
    });
  };
  /* 复验（单格 / 批量，跨工程会按工程分组分别起请求）*/
  const revalidate = (s, pairs, opts) => {
    if (!pairs.length) return Promise.resolve();
    const byProj = {};
    pairs.forEach(({ projId, node }) => { (byProj[projId] = byProj[projId] || []).push(node); });
    return Promise.allSettled(Object.keys(byProj).map((pid) => {
      const p = PROJ(pid);
      return p ? launchWarmupOne(s, p, byProj[pid], opts || {}, null) : Promise.reject(new Error('工程不存在'));
    })).then((rs) => {
      const anyOk = rs.some((r) => r.status === 'fulfilled');
      loadPsoData(s); loadDriverSnapshots(s);
      if (!anyOk) throw new Error('复验全部失败，详见控制台日志');
    });
  };

  /* =================== 收敛 sparkline（同设计稿 svg 折线，真实数据驱动）=================== */
  function Spark({ data, color, peak }) {
    const W = 132, H = 34, pad = 2;
    const n = data.length;
    const max = Math.max(peak || 1, ...data, 0.001);
    const step = n > 1 ? (W - pad * 2) / (n - 1) : 0;
    const pts = data.map((v, i) => {
      const x = pad + i * step;
      const y = H - pad - (v / max) * (H - pad * 2);
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    const area = n > 1 ? ('M' + pts.split(' ').join(' L') + ' L' + (pad + (n - 1) * step).toFixed(1) + ',' + (H - pad) + ' L' + pad + ',' + (H - pad) + ' Z') : '';
    return h('svg', { className: 'pso-spark', viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none' },
      area ? h('path', { d: area, fill: color, opacity: 0.12 }) : null,
      n > 1 ? h('polyline', { points: pts, fill: 'none', stroke: color, strokeWidth: 1.6, strokeLinejoin: 'round', strokeLinecap: 'round' }) : null,
      n > 0 ? h('circle', { cx: pad + (n - 1) * step, cy: H - pad - (data[n - 1] / max) * (H - pad * 2), r: 2.4, fill: color }) : null);
  }

  /* =================== 卡片 1 · 绿灯矩阵 =================== */
  function MatrixCard({ s }) {
    const projs = PPROJ(), nodes = PNODES();
    const sel = s.psoSel && s.psoSel.proj ? s.psoSel : null;
    const pickCell = (proj, node) => {
      const cur = s.psoSel;
      if (cur && cur.proj === proj && cur.node === node) s.setPsoSel(null);
      else { s.setPsoSel({ proj, node }); CX.showInspector(s); }
    };
    const cell = (p, n) => {
      const g = glOf(s, p.id, n);
      const m = GLS[g.state] || GLS.never;
      const on = sel && sel.proj === p.id && sel.node === n.id;
      const canReval = g.state === 'stale' || g.state === 'invalid';
      return h('div', { key: n.id, className: 'glc glc--' + m.cell + (on ? ' is-sel' : '') + (g.state === 'offline' ? ' is-off' : ''),
          onClick: () => (g.state === 'offline' ? null : pickCell(p.id, n.id)),
          title: g.state === 'offline' ? '节点离线' : '查看检查器详情' },
        h('div', { className: 'glc-top' },
          h('span', { className: 'spill spill--' + m.vis },
            m.icon === 'minus' ? h('span', { style: { fontWeight: 800 } }, '—') : h(Icon, { name: m.icon, size: 12 }), m.label)),
        h('div', { className: 'glc-time' }, g.state === 'offline' ? '—' :
          (g.verified || '从未预跑') + (g.state === 'ready' ? ' · 验证段 0 卡顿' : g.reason ? ' · ' + g.reason : '')),
        canReval ? h('button', { className: 'glc-reval', title: '在该节点复验（重跑预跑并验证）',
            onClick: (e) => { e.stopPropagation(); revalidate(s, [{ projId: p.id, node: n }], {}).catch((err) => s.pushLog({ lv: 'err', cat: 'pso', ch: 'ssh', msg: '复验失败 · ' + (err && err.message ? err.message : err) })); } },
          h(Icon, { name: 'sync', size: 11 }), '复验') : null);
    };
    const cnt = readyCount(s);
    return h('div', { className: 'dash-card pso-matrix' },
      h('div', { className: 'dc-h' },
        h('span', { className: 't' }, h(Icon, { name: 'grid', size: 14 }), '绿灯矩阵'),
        h('span', { className: 'dc-n' }, '就绪 ' + cnt.ok + ' / ' + cnt.tot + ' 格（在线节点）· 绿灯 = 实测出来的、会过期')),
      projs.length === 0 || nodes.length === 0
        ? h('div', { className: 'gen-empty' }, h(Icon, { name: 'grid', size: 22 }),
            h('span', null, projs.length === 0 ? '尚未发现工程 · 先在「设置」扫描添加' : '没有可用的渲染节点'))
        : h(React.Fragment, null,
            h('div', { className: 'glm', style: { gridTemplateColumns: '168px repeat(' + nodes.length + ', minmax(132px, 1fr))' } },
              h('div', { className: 'glm-corner' }, '工程 \\ 节点'),
              nodes.map((n) => h('div', { key: n.id, className: 'glm-col' + (n.status !== 'offline' ? '' : ' off') },
                h('span', { className: 'glm-host mono' }, CX.dot(NODE_STATUS[n.status].visual), n.host),
                h('span', { className: 'glm-gpu' }, n.status !== 'offline' ? gpuText(gpuSigOf(s, n.machineId)) : '离线'))),
              projs.map((p) => h(React.Fragment, { key: p.id },
                h('div', { className: 'glm-row' },
                  h('span', { className: 'glm-proj' }, h(Icon, { name: 'film', size: 14 }), p.name),
                  h('span', { className: 'glm-ue mono' }, 'UE ' + p.ue + ' · ' + p.uproject)),
                nodes.map((n) => cell(p, n))))),
            h('div', { className: 'glm-legend' },
              Object.keys(GLS).map((k) => h('span', { key: k, className: 'glm-lg' },
                h('span', { className: 'glm-lg-dot glc--' + GLS[k].cell }), GLS[k].label)))));
  }

  /* =================== 卡片 2 · 驱动缓存状态 =================== */
  function CacheCard({ s }) {
    const nodes = PNODES();
    const snaps = s.psoDriverSnapshots || {};
    const users = nodes.map((n) => snaps[n.machineId] && snaps[n.machineId].interactive_user).filter(Boolean);
    const ct = {}; users.forEach((u) => { ct[u] = (ct[u] || 0) + 1; });
    const majUser = Object.keys(ct).sort((a, b) => ct[b] - ct[a])[0] || null;
    const row = (n) => {
      if (n.status === 'offline') return h('div', { key: n.id, className: 'dcr dcr--off' },
        h('span', { className: 'dcr-host mono' }, CX.dot('neutral'), n.host),
        h('span', { className: 'dcr-off-tx' }, '离线 · 无法读取驱动缓存'));
      const snap = snaps[n.machineId];
      if (!snap) return h('div', { key: n.id, className: 'dcr' },
        h('span', { className: 'dcr-host mono' }, CX.dot('neutral'), n.host),
        h('span', { className: 'dcr-off-tx' }, '尚未探测 · 首次预跑后自动写入'));
      const anomaly = driverAnomalyFor(s, n.machineId);
      const acctOk = !majUser || !snap.interactive_user || snap.interactive_user === majUser;
      const warn = !!anomaly.shrunk || !acctOk;
      return h('div', { key: n.id, className: 'dcr' + (warn ? ' dcr--warn' : '') },
        h('span', { className: 'dcr-host mono' }, CX.dot(warn ? 'notice' : 'positive'), n.host),
        h('span', { className: 'dcr-v mono' + (anomaly.shrunk ? ' bad' : '') }, humanBytes(snap.total_bytes),
          anomaly.shrunk ? h('span', { className: 'dcr-was' }, '← ' + anomaly.shrunk.detail) : null),
        h('span', { className: 'dcr-v mono' }, snap.total_file_count + ' 文件'),
        h('span', { className: 'dcr-when' }, fmtWhen(snap.captured_at)),
        h('span', { className: 'dcr-v mono' }, snap.gpu_driver_version || '—'),
        acctOk
          ? h('span', { className: 'spill spill--positive dcr-acct' }, h(Icon, { name: 'check', size: 11 }), '账户一致')
          : h('span', { className: 'spill spill--notice dcr-acct' }, h(Icon, { name: 'alert', size: 11 }), '账户不符'));
    };
    return h('div', { className: 'dash-card' },
      h('div', { className: 'dc-h' },
        h('span', { className: 't' }, h(Icon, { name: 'cache', size: 14 }), '驱动缓存状态'),
        h('span', { className: 'dc-n' }, '每台节点显卡驱动缓存实况')),
      h('div', { className: 'dcr-head' },
        h('span', null, '节点'), h('span', null, '缓存大小'), h('span', null, '文件数'),
        h('span', null, '最新写入'), h('span', null, '驱动版本'), h('span', null, '账户一致性')),
      h('div', { className: 'dcr-list' }, nodes.map(row)));
  }

  /* =================== 卡片 3 · 预跑历史 + 运行态 =================== */
  const STAGES = ['启动', '遍历中', '收敛判定', '验证跑'];
  function HistoryCard({ s, run, onCancel }) {
    const hist = histAll(s);
    const histRow = (r) => {
      const m = RES_META[r.status] || RES_META.err;
      const hitches = r.verify_hitch_count != null ? r.verify_hitch_count : r.hitch_count;
      const p = PROJ(r.__proj); const n = (window.RENDER_NODES || []).find((x) => x.machineId === r.machine_id);
      return h('div', { key: r.id, className: 'ph-row' + (r.status === 'cancelled' ? ' ph-row--cancel' : ''), title: r.error_message || '' },
        h('span', { className: 'ph-when' }, fmtWhen(r.started_at)),
        h('span', { className: 'ph-proj' }, p ? p.name : ('工程 ' + r.__proj)),
        h('span', { className: 'ph-node mono' }, n ? n.host : ('机器 ' + r.machine_id)),
        h('span', { className: 'ph-mode' }, MODE_LABEL[r.mode] || r.mode),
        h('span', { className: 'ph-dur mono' }, r.status === 'running' ? '进行中' : fmtDur(r.duration_secs)),
        h('span', { className: 'ph-hitch mono' + (hitches > 0 ? ' warn' : hitches === 0 ? ' ok' : ' dim') }, hitches == null ? '卡顿 —' : (hitches + ' 卡顿')),
        h('span', { className: 'ph-growth mono' }, r.driver_cache_growth_bytes != null ? ('+' + humanBytes(r.driver_cache_growth_bytes)) : '—'),
        h('span', { className: 'spill spill--' + m.vis + ' ph-res' },
          m.icon === 'minus' ? h('span', { style: { fontWeight: 800 } }, '—') : h(Icon, { name: m.icon, size: 11 }), m.label,
          r.status === 'cancelled' ? h('span', { className: 'ph-nogreen' }, '不算绿灯') : null));
    };
    return h('div', { className: 'dash-card' },
      h('div', { className: 'dc-h' },
        h('span', { className: 't' }, h(Icon, { name: 'list', size: 14 }), '预跑历史', run ? h('span', { className: 'ph-live-dot' }) : null,
          run ? h('span', { className: 'ph-live-tag' }, '进行中') : null),
        h('span', { className: 'dc-n', style: { cursor: 'pointer' }, onClick: () => { s.setLogSearch('pso'); s.setLogOpen(true); } }, '完整 NDJSON 流 →')),
      run ? h('div', { className: 'pso-run' },
        h('div', { className: 'pso-run-h' },
          h('span', { className: 'pso-run-t' }, h('span', { className: 'spin' }, h(Icon, { name: 'sync', size: 13 })),
            '预跑并验证进行中 · ', run.proj.map((id) => (PROJ(id) || { name: id }).name).join('、'), ' · ', run.mode),
          h('button', { className: 'pso-run-cancel', onClick: onCancel }, h(Icon, { name: 'x', size: 12 }), '取消预跑')),
        h('div', { className: 'pso-run-nodes' }, run.nodes.map((rn) => {
          const st = Math.min(rn.stage, STAGES.length - 1);
          const node = NODE(rn.id);
          return h('div', { key: rn.projId + '|' + rn.id, className: 'prn' },
            h('span', { className: 'prn-host mono' }, node ? node.host : rn.id),
            h('div', { className: 'prn-stages' }, STAGES.map((sg, i) => h('span', { key: i,
                className: 'prn-stage' + (i < st ? ' done' : i === st ? ' active' : '') }, sg))),
            h('span', { className: 'prn-el mono' }, Math.max(0, Math.round((Date.now() - rn.startedAt) / 1000)) + 's / 上限 ' + rn.limit + '分'));
        })),
        run.traversal ? h('div', { className: 'pso-run-sparks' },
          h('div', { className: 'psk' },
            h('div', { className: 'psk-h' }, h('span', null, '卡顿新增速率'),
              h('span', { className: 'psk-v mono' }, (run.hitch[run.hitch.length - 1] || 0).toFixed(1) + ' /采样')),
            h(Spark, { data: run.hitch, color: 'var(--notice-visual)', peak: 4 }),
            h('div', { className: 'psk-foot' }, run.converged.hitch ? h('span', { className: 'psk-flat' }, h(Icon, { name: 'check', size: 10 }), '已走平') : '趋近 0 即收敛')),
          h('div', { className: 'psk' },
            h('div', { className: 'psk-h' }, h('span', null, '缓存增长速率'),
              h('span', { className: 'psk-v mono' }, (run.growth[run.growth.length - 1] || 0).toFixed(1) + ' MB/采样')),
            h(Spark, { data: run.growth, color: 'var(--informative-visual)', peak: 4 }),
            h('div', { className: 'psk-foot' }, run.converged.growth ? h('span', { className: 'psk-flat' }, h(Icon, { name: 'check', size: 10 }), '已走平') : '趋近 0 即收敛')))
          : h('div', { className: 'pso-run-note' }, h(Icon, { name: 'info', size: 12 }),
              '本次预跑未配置遍历引擎地图路径（设置 · 预跑范围），为固定机位——无收敛曲线，以验证段 hitch 结果为准。'),
        h('div', { className: 'pso-run-note' }, h(Icon, { name: 'info', size: 12 }),
          '两条收敛曲线同时走平 = 缓存已填满、无新卡顿，随即进入验证跑并点亮绿灯。')) : null,
      h('div', { className: 'ph-head' },
        h('span', null, '时间'), h('span', null, '工程'), h('span', null, '节点'), h('span', null, '模式'),
        h('span', null, '时长'), h('span', null, '卡顿'), h('span', null, '缓存增长'), h('span', null, '终态')),
      h('div', { className: 'ph-list' }, hist.length === 0
        ? h('div', { className: 'gen-empty', style: { padding: '18px 0' } }, h(Icon, { name: 'list', size: 20 }), h('span', null, '暂无预跑记录'))
        : hist.slice(0, 9).map(histRow)));
  }

  /* =================== 卡片 4 · 失效告警（跨工程聚合 invalidation_reasons，时间倒序）=================== */
  function AlertCard({ s }) {
    const KIND_ICON = { gpu_driver_changed: 'cpu', cache_shrunk: 'broom', cache_directory_missing: 'broom', interactive_user_changed: 'user', node_rebooted: 'power' };
    const events = [];
    Object.keys(s.psoStatusByProject || {}).forEach((pid) => (s.psoStatusByProject[pid] || []).forEach((cell) => {
      (cell.invalidation_reasons || []).forEach((ev) => events.push(Object.assign({ __proj: pid, __machine: cell.machine_id }, ev)));
    }));
    events.sort((a, b) => String(b.detected_at || '').localeCompare(String(a.detected_at || '')));
    const top = events.slice(0, 8);
    const doReval = (ev) => {
      const p = PROJ(ev.__proj); const n = (window.RENDER_NODES || []).find((x) => x.machineId === ev.__machine);
      if (!p || !n) return;
      revalidate(s, [{ projId: p.id, node: n }], {}).catch((err) => s.pushLog({ lv: 'err', cat: 'pso', ch: 'ssh', msg: '复验失败 · ' + (err && err.message ? err.message : err) }));
    };
    return h('div', { className: 'dash-card' },
      h('div', { className: 'dc-h' },
        h('span', { className: 't' }, h(Icon, { name: 'alert', size: 14 }), '失效告警'),
        h('span', { className: 'dc-n' }, top.length + ' 条 · 时间倒序')),
      top.length === 0
        ? h('div', { className: 'gen-empty', style: { padding: '18px 0' } }, h(Icon, { name: 'check', size: 20 }), h('span', null, '暂无失效事件'))
        : h('div', { className: 'fa-list' }, top.map((a) => {
            const p = PROJ(a.__proj); const n = (window.RENDER_NODES || []).find((x) => x.machineId === a.__machine);
            return h('div', { key: a.id || (a.__proj + '|' + a.__machine + '|' + a.reason + '|' + a.detected_at), className: 'fa-row' },
              h('span', { className: 'fa-ico s-' + (a.reason === 'node_rebooted' ? 'notice' : 'negative') }, h(Icon, { name: KIND_ICON[a.reason] || 'alert', size: 14 })),
              h('div', { className: 'fa-main' },
                h('div', { className: 'fa-msg' }, mono(n ? n.host : ('机器 ' + a.__machine)), ' ', REASON_LABEL[a.reason] || a.detail),
                h('div', { className: 'fa-scope' }, h('span', { className: 'fa-time mono' }, fmtWhen(a.detected_at)), h('span', { className: 'fa-scope-tx' }, p ? p.name : ('工程 ' + a.__proj)))),
              h('button', { className: 'mini-btn fa-reval', title: '对该组合复验', onClick: () => doReval(a) },
                h(Icon, { name: 'sync', size: 12 }), '复验'));
          })));
  }

  /* =================== 卡片 5 · 配置巡检 ===================
     设计稿原有 4 项里「附加参数与拍摄一致」在本仓没有对应的真实数据源（没有「拍摄档」这个可比对
     概念，Rust 侧也未采集），诚实起见不编造这一项；换成「遍历引擎地图路径」——直接呼应 HistoryCard
     运行态里「未配置则退化为固定机位」的说明，让操作员看到覆盖率而不是被动发现。 */
  function ChecksCard({ s }) {
    const projs = PPROJ();
    const configured = projs.filter((p) => cfgComplete(settingsOf(s, p.id)));
    const withMap = projs.filter((p) => { const st = settingsOf(s, p.id); return st && st.map_path && st.map_path.trim(); });
    const [zen, setZen] = useState(null);
    useEffect(() => { zenStatus(null).then(setZen, () => setZen([])); }, []);
    const zenReady = Array.isArray(zen) && zen.some((z) => z.reachable);
    const rows = [
      { id: 'c1', label: '预跑设置完整', vis: projs.length === 0 ? 'neutral' : configured.length === projs.length ? 'positive' : configured.length > 0 ? 'notice' : 'negative',
        note: projs.length === 0 ? '尚未发现工程' : configured.length + ' / ' + projs.length + ' 个工程已配置 nDisplay 配置来源 + 目标节点', fix: configured.length < projs.length },
      { id: 'c2', label: 'DDC 就绪', vis: zen == null ? 'neutral' : zenReady ? 'positive' : 'notice',
        note: zen == null ? '巡检中…' : zenReady ? 'Zen 端点可达，预跑不会因缺资源反复重编译' : '未探测到可达的 Zen 端点，预跑首次编译可能显著变慢', fix: false },
      { id: 'c3', label: '遍历引擎地图路径', vis: projs.length === 0 ? 'neutral' : withMap.length === projs.length ? 'positive' : withMap.length > 0 ? 'notice' : 'neutral',
        note: projs.length === 0 ? '—' : withMap.length + ' / ' + projs.length + ' 个工程已配置 · 未配置的工程预跑仍可用，仅退化为固定机位（无收敛曲线）', fix: false },
    ];
    return h('div', { className: 'dash-card' },
      h('div', { className: 'dc-h' },
        h('span', { className: 't' }, h(Icon, { name: 'sliders', size: 14 }), '配置巡检'),
        h('span', { className: 'dc-n' }, '预跑的前置条件')),
      h('div', { className: 'ck-list' }, rows.map((c) => h('div', { key: c.id, className: 'ck-row' },
        h('span', { className: 'spill spill--' + c.vis + ' ck-chip' }, h(Icon, { name: c.vis === 'positive' ? 'check' : c.vis === 'neutral' ? 'minus' : 'alert', size: 11 }),
          c.vis === 'positive' ? '通过' : c.vis === 'neutral' ? '—' : '需处理'),
        h('div', { className: 'ck-main' }, h('div', { className: 'ck-label' }, c.label), h('div', { className: 'ck-note' }, c.note)),
        c.fix ? h('button', { className: 'mini-btn', onClick: () => { const s2 = window.VOLO_GO_PSO_SETTINGS; if (s2) s2(); } }, h(Icon, { name: 'bolt', size: 12 }), '去设置') : null))),
      h('div', { className: 'ck-foot' }, h(Icon, { name: 'info', size: 13 }),
        'UE 官方 PSO Precaching 在编辑器 -game 形态下不生效（源码级确认），本板块采用驱动缓存预跑方案。'));
  }

  /* =================== 预跑并验证 · 确认对话框 =================== */
  function PrerunConfirm({ s, onStart, close }) {
    const online = PNODES().filter((n) => n.status !== 'offline');
    const projs = PPROJ();
    const [proj, setProj] = useState(() => projs.length ? [projs[0].id] : []);
    const initialNodes = () => {
      const set = new Set();
      proj.forEach((pid) => online.forEach((n) => { if (glOf(s, pid, n).state !== 'ready') set.add(n.id); }));
      return Array.from(set.size ? set : new Set(online.map((n) => n.id)));
    };
    const [nodes, setNodes] = useState(initialNodes);
    const [mode, setMode] = useState('后台');
    const toggleProj = (id) => setProj((v) => v.includes(id) ? v.filter((x) => x !== id) : v.concat(id));
    const toggleNode = (id) => setNodes((v) => v.includes(id) ? v.filter((x) => x !== id) : v.concat(id));
    const incomplete = proj.map((id) => PROJ(id)).filter(Boolean).filter((p) => !cfgComplete(settingsOf(s, p.id)));
    const pairs = [];
    proj.forEach((pid) => nodes.forEach((nid) => pairs.push({ proj: pid, node: nid })));
    const canStart = pairs.length > 0 && incomplete.length === 0;
    return h('div', { className: 'drawer drawer--preview pso-confirm' },
      h('div', { className: 'drawer-h' },
        h('span', { className: 'di info' }, h(Icon, { name: 'bolt', size: 17 })),
        h('div', { style: { minWidth: 0 } },
          h('h2', null, '预跑并验证'),
          h('div', { className: 'sub' }, h('span', { className: 'cli-pill' }, 'pso prerun'), h('span', null, ' · 无人值守 · 收敛判定 + 验证跑'))),
        h('button', { className: 'iconbtn x', onClick: close }, h(Icon, { name: 'x', size: 16 }))),
      h('div', { className: 'drawer-b' },
        h('div', { className: 'dblock' },
          h('div', { className: 'dblock-h' }, h('span', { className: 'no' }, '1'), '工程'),
          h('div', { className: 'pc-chips' }, projs.map((p) => h('button', { key: p.id,
              className: 'pc-chip' + (proj.includes(p.id) ? ' on' : ''), onClick: () => toggleProj(p.id) },
            h('span', { className: 'pc-ck' }, proj.includes(p.id) ? h(Icon, { name: 'check', size: 11 }) : null),
            p.name, h('span', { className: 'pc-ue mono' }, 'UE ' + p.ue)))),
          incomplete.length ? h('div', { className: 'pset-block', style: { marginTop: 10 } }, h(Icon, { name: 'alert', size: 14 }),
            h('div', null, h('b', null, '配置未完整：' + incomplete.map((p) => p.name).join('、')),
              h('div', { className: 'pset-block-d' }, '请先在「设置」子视图为这些工程配置 nDisplay 配置来源与目标节点。'))) : null,
          h('div', { className: 'dblock-h', style: { marginTop: 14 } }, h('span', { className: 'no' }, '2'), '节点 · 仅在线'),
          h('div', { className: 'pc-nodes' }, online.map((n) => h('button', { key: n.id,
              className: 'pc-node' + (nodes.includes(n.id) ? ' on' : ''), onClick: () => toggleNode(n.id) },
            h('span', { className: 'pc-ck' }, nodes.includes(n.id) ? h(Icon, { name: 'check', size: 11 }) : null),
            CX.dot('positive'), h('span', { className: 'mono' }, n.host), h('span', { className: 'pc-gpu' }, gpuText(gpuSigOf(s, n.machineId)))))),
          h('div', { className: 'dblock-h', style: { marginTop: 14 } }, h('span', { className: 'no' }, '3'), '模式'),
          h('div', { className: 'pc-mode' }, ['后台', '窗口'].map((m) => h('button', { key: m,
              className: 'pc-mbtn' + (mode === m ? ' on' : ''), onClick: () => setMode(m) },
            h(Icon, { name: m === '后台' ? 'server' : 'panel', size: 12 }), m,
            h('span', { className: 'pc-mnote' }, m === '后台' ? '无人值守 · 不占桌面' : '可现场肉眼看遍历')))),
          h('div', { className: 'pc-note' }, h(Icon, { name: 'info', size: 12 }),
            '在每台节点本机拉起 UE -game 遍历场景，填满显卡驱动缓存；以收敛曲线走平判完成，再做验证跑实测零卡顿后点亮绿灯。'))),
      h('div', { className: 'drawer-f' },
        h('span', { className: 'pc-sum' }, pairs.length + ' 个 工程×节点 组合'),
        h(Button, { variant: 'secondary', size: 'M', onPress: close }, '取消'),
        h(Button, { variant: 'accent', size: 'M', isDisabled: !canStart, icon: h(Icon, { name: 'bolt', size: 15 }),
          onPress: () => { onStart(proj.slice(), nodes.slice(), mode); close(); } }, '开始预跑并验证')));
  }

  /* =================== Dashboard（center）=================== */
  function Dashboard({ s }) {
    const [sub, setSub] = useState('dash');
    const [run, setRun] = useState(null);
    const runRef = useRef(null); runRef.current = run;
    const jobsRef = useRef([]); /* 本次批量启动收集的 {jobId, parentJobId} 供取消/事件过滤 */
    const tickRef = useRef(null);
    const [, forceTick] = useState(0);

    useEffect(() => { refreshAll(s); }, []); /* eslint-disable-line react-hooks/exhaustive-deps */
    /* ChecksCard「去设置」按钮的跳转入口——两者是同一 Dashboard 渲染树下的兄弟组件，没有 props
       通道，走 window 挂一个当前渲染实例的 setter（同文件其余处 window.VOLO_* 挂载同一惯例）。 */
    useEffect(() => {
      window.VOLO_GO_PSO_SETTINGS = () => setSub('settings');
      return () => { delete window.VOLO_GO_PSO_SETTINGS; };
    }, []);

    useEffect(() => {
      if (!run) { clearInterval(tickRef.current); return; }
      tickRef.current = setInterval(() => forceTick((t) => t + 1), 1000);
      return () => clearInterval(tickRef.current);
    }, [!!run]);

    /* 真事件驱动阶段/收敛曲线：按 (project_id, machine_id) 是否属于本批 run.nodes 过滤（不用
       parent_job_id——jobsRef 里的真实 job id 要等 start_pso_warmup 的 Promise resolve 才写入，
       这个 effect 在 setRun() 后同步触发时 jobsRef 可能还是空的，会漏订阅；run.nodes 的
       (projId,machineId) 组合在 startRun 里是同步给定的，没有这个时序坑）。批内节点集合在 run
       生命周期内不变，可放心闭包捕获一次。同一机器可能同时跑多个 project 的 job（多选工程预跑），
       仅按 machineId 过滤/patch 会把 A 工程的事件误算到 B 工程头上——尤其是 finalized 事件，会把
       B 的节点提前标 done，导致整批 run 在 B 还在跑的时候就被判完清空。 */
    useEffect(() => {
      if (!run) return;
      const key = (projId, machineId) => projId + ':' + machineId;
      const nodeKeys = new Set(run.nodes.map((n) => key(n.projId, n.machineId)));
      const sampleAgg = { hitch: {}, cache: {} }; /* machineId -> 最新累计值（遍历事件无 project_id，仍按机器聚合） */
      const applyNodePatch = (projId, machineId, patch) => setRun((r) => {
        if (!r) return r;
        const nodes = r.nodes.map((n) => (n.projId === projId && n.machineId === machineId) ? Object.assign({}, n, patch) : n);
        return Object.assign({}, r, { nodes });
      });
      const pushSpark = () => setRun((r) => {
        if (!r) return r;
        const hitchSum = Object.values(sampleAgg.hitch).reduce((a, b) => a + b, 0);
        const cacheSum = Object.values(sampleAgg.cache).reduce((a, b) => a + b, 0);
        const lastH = r.hitch[r.hitch.length - 1] || 0, lastC = r.growth[r.growth.length - 1] || 0;
        const hDelta = Math.max(0, hitchSum - (r.__lastHitchSum || 0));
        const cDelta = Math.max(0, (cacheSum - (r.__lastCacheSum || 0)) / 1048576);
        const hitch = r.hitch.concat(hDelta).slice(-22);
        const growth = r.growth.concat(cDelta).slice(-22);
        const converged = { hitch: hDelta < 0.5 && lastH < 0.5, growth: cDelta < 0.5 && lastC < 0.5 };
        return Object.assign({}, r, { hitch, growth, converged, __lastHitchSum: hitchSum, __lastCacheSum: cacheSum });
      });
      const unWarmup = listen('pso-warmup-progress', (evt) => {
        const p = evt.payload; if (!nodeKeys.has(key(p.project_id, p.machine_id))) return;
        if (p.phase === 'verify') applyNodePatch(p.project_id, p.machine_id, { stage: 3 });
        else applyNodePatch(p.project_id, p.machine_id, { stage: 1 });
      });
      const unFinal = listen('pso-warmup-finalized', (evt) => {
        const p = evt.payload; if (!nodeKeys.has(key(p.project_id, p.machine_id))) return;
        applyNodePatch(p.project_id, p.machine_id, { stage: 3, done: true });
        const r = runRef.current;
        if (r && r.nodes.every((n) => (n.projId === p.project_id && n.machineId === p.machine_id) || n.done)) {
          setRun(null); loadPsoData(s); loadDriverSnapshots(s);
        }
      });
      const unTrav = listen('pso-traversal-progress', (evt) => {
        const p = evt.payload; if (!nodeKeys.has(key(p.project_id, p.machine_id))) return;
        /* TraversalEvent 无 #[serde(tag=...)]，走 serde 默认外部标签：{Sample:{...}} / {Converged:{...}}
           / {Info:"..."} / {Error:"..."}（不是 UeRunnerEvent 那种内部 {kind,...} 形状，两个事件枚举
           标签方式不同，混用会静默匹配不上——已核对 crates/cache-core/src/core/pso_traversal.rs）。 */
        const e = p.event || {};
        if (e.Sample) {
          sampleAgg.hitch[p.machine_id] = e.Sample.hitch_count || 0;
          sampleAgg.cache[p.machine_id] = e.Sample.cache_bytes || 0;
          applyNodePatch(p.project_id, p.machine_id, { stage: 2 });
          pushSpark();
        } else if (e.Converged) {
          applyNodePatch(p.project_id, p.machine_id, { stage: 3, traversalDone: true });
        }
      });
      return () => { Promise.all([unWarmup, unFinal, unTrav]).then((fns) => fns.forEach((f) => f())); };
    }, [run && run.__batchId]); /* eslint-disable-line react-hooks/exhaustive-deps */

    const startRun = (projIds, nodeIds, mode) => {
      if (run) return;
      const nodes = nodeIds.map((id) => NODE(id)).filter(Boolean);
      const anyTraversal = projIds.some((pid) => { const st = settingsOf(s, pid); return st && st.map_path && st.map_path.trim(); });
      const batchId = 'b' + Date.now();
      jobsRef.current = [];
      setRun({ __batchId: batchId, proj: projIds, mode, traversal: anyTraversal,
        nodes: projIds.flatMap((pid) => nodes.map((n) => ({ projId: pid, id: n.id, machineId: n.machineId, stage: 0, startedAt: Date.now(), limit: (settingsOf(s, pid) || {}).max_minutes || 20, done: false }))),
        hitch: [0], growth: [0], converged: { hitch: false, growth: false } });
      Promise.allSettled(projIds.map((pid) => {
        const p = PROJ(pid); if (!p) return Promise.reject(new Error('工程不存在'));
        return launchWarmupOne(s, p, nodes, { headless: mode !== '窗口' }, jobsRef);
      })).then((rs) => {
        const anyOk = rs.some((r) => r.status === 'fulfilled');
        if (!anyOk) {
          s.pushLog({ lv: 'err', cat: 'pso', ch: 'ssh', msg: '预跑并验证全部启动失败，详见控制台日志' });
          setRun(null);
        }
      });
    };
    const cancelRun = () => {
      const ids = jobsRef.current.map((j) => j.jobId);
      Promise.allSettled(ids.map((id) => cancelUeJob(id))).then(() => {
        setRun(null);
        s.pushLog({ lv: 'warn', cat: 'pso', ch: 'ssh', task: null, msg: '<b>pso prerun</b> 已取消 · 远端 UE 进程已终止 · 本次不点亮绿灯' });
      });
    };
    const openConfirm = () => s.setModal({ wide: true, render: ({ s: ss, close }) => h(PrerunConfirm, { s: ss, close, onStart: startRun }) });

    const cnt = readyCount(s);
    return h('div', { className: 'res pso-dash' },
      h('div', { className: 'canvas-head' },
        h('div', { className: 'pso-subswitch' },
          h('button', { className: 'pss' + (sub === 'dash' ? ' on' : ''), onClick: () => setSub('dash') }, h(Icon, { name: 'grid', size: 13 }), 'Dashboard'),
          h('button', { className: 'pss' + (sub === 'settings' ? ' on' : ''), onClick: () => { setSub('settings'); s.setPsoSel(null); } }, h(Icon, { name: 'settings', size: 13 }), '设置')),
        h('div', { className: 'right' },
          h('span', { className: 'toolchip' }, h(Icon, { name: 'check', size: 14 }), '就绪 ' + cnt.ok + ' / ' + cnt.tot),
          run ? h('span', { className: 'toolchip pso-running' }, h('span', { className: 'spin' }, h(Icon, { name: 'sync', size: 13 })), '预跑中') : null,
          h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'bolt', size: 15 }), isDisabled: !!run, onPress: openConfirm }, '预跑并验证'))),
      sub === 'settings'
        ? h(SettingsView, { s })
        : h('div', { className: 'dash pso-body' },
            h(MatrixCard, { s }),
            h('div', { className: 'pso-2col' },
              h(CacheCard, { s }),
              h(ChecksCard, { s })),
            h(HistoryCard, { s, run, onCancel: cancelRun }),
            h(AlertCard, { s })));
  }
  /* =================== 设置子视图 —— 左右双栏 master/detail =================== */
  function SettingsView({ s }) {
    const projs = PPROJ();
    const [selProj, setSelProj] = useState(() => (projs[0] && projs[0].id) || null);
    const [scanning, setScanning] = useState(false);
    const empty = { dc_cfg_source: 'manual', dc_cfg_asset: null, dc_cfg_manual_path: '', extra_args: '', offscreen: true,
      target_machine_ids: '[]', max_minutes: 20, probe_interval_secs: 30, map_path: '', dc_node: '' };
    const load = (id) => { const raw = settingsOf(s, id); return raw ? Object.assign({}, empty, raw, { project_id: Number(id) }) : Object.assign({}, empty, { project_id: Number(id) }); };
    const [form, setForm] = useState(() => load(selProj));
    const [saved, setSaved] = useState(() => load(selProj));
    const [flash, setFlash] = useState(false);
    const [assets, setAssets] = useState([]);
    const [assetsLoading, setAssetsLoading] = useState(false);
    const [coldNode, setColdNode] = useState(null);
    const ft = useRef(null);
    useEffect(() => () => clearTimeout(ft.current), []);

    const pickProj = (id) => { const c = load(id); setSelProj(id); setForm(c); setSaved(JSON.parse(JSON.stringify(c))); setAssets([]); };
    const set = (patch) => setForm((f) => Object.assign({}, f, patch));
    const dirty = JSON.stringify(form) !== JSON.stringify(saved);
    const proj = PROJ(selProj);

    /* nDisplay 资产发现：切工程时对该工程的主机器（primary，回退任一在线机）SSH 扫一次。 */
    useEffect(() => {
      if (!proj) return;
      const nodeId = proj.primary || (proj.machines || [])[0];
      const node = nodeId ? NODE(String(nodeId)) : null;
      if (!node || node.status === 'offline' || !proj.root) { setAssets([]); return; }
      setAssetsLoading(true);
      discoverNdisplayAssets(node.machineId, proj.root).then((a) => setAssets(Array.isArray(a) ? a : []), () => setAssets([])).finally(() => setAssetsLoading(false));
    }, [selProj]); /* eslint-disable-line react-hooks/exhaustive-deps */

    /* Selector 在未选值时会回退显示 assets[0]（纯 UI 兜底），但那不会写回 form——不补这一步，
       用户会看到「已选中第一个配置资产」，保存的却仍是 dc_cfg_asset: null，cfgHasSource 继续判失败。 */
    useEffect(() => {
      if (form.dc_cfg_source !== 'asset' || form.dc_cfg_asset || assetsLoading || !assets.length) return;
      set({ dc_cfg_asset: assets[0] });
    }, [form.dc_cfg_source, form.dc_cfg_asset, assetsLoading, assets]); /* eslint-disable-line react-hooks/exhaustive-deps */

    /* 三通道 gate 必须在全部 Hooks 之后才能早退——否则加载态/完成态两次渲染的 Hook 调用数不一致，
       React 会抛 "Rendered more hooks than during the previous render"（同 cacheDdc.tsx 里
       PsoMaster 缩略图加载 effect 的注释同一坑）。 */
    const g = window.VOLO_CACHE_DDC.gate(s); if (g) return g;

    const save = () => {
      const payload = Object.assign({}, form, { project_id: Number(selProj), updated_at: null });
      setPsoProjectSettings(payload).then((saved2) => {
        s.setPsoSettingsByProject((prev) => Object.assign({}, prev, { [selProj]: saved2 }));
        /* 用服务端返回的 saved2 直接刷新表单——不能重新调 load(selProj)，它读的是本次 render
           闭包里的旧 s.psoSettingsByProject（setPsoSettingsByProject 还没落地），会把刚保存的
           改动当场打回旧值，界面显示「已保存」但表单其实回退了。 */
        const c = Object.assign({}, empty, saved2, { project_id: Number(selProj) });
        setForm(c); setSaved(JSON.parse(JSON.stringify(c)));
        setFlash(true); clearTimeout(ft.current); ft.current = setTimeout(() => setFlash(false), 2200);
        s.pushLog({ lv: 'ok', cat: 'pso', ch: 'ssh', task: null, msg: '<b>pso config save</b> · ' + (proj ? proj.name : selProj) + ' 预跑设置已保存' });
      }, (err) => s.pushLog({ lv: 'err', cat: 'pso', ch: 'ssh', msg: '保存失败 · ' + (err && err.message ? err.message : err) }));
    };
    const scan = () => {
      if (scanning) return;
      const online = PNODES().filter((n) => n.status !== 'offline');
      if (!online.length) return;
      setScanning(true);
      window.VOLO_CACHE_DDC.runDiscover(s, 'all', 'D:\\Projects;E:\\UEProjects').finally(() => setScanning(false));
    };
    const addManual = () => s.pushLog({ lv: 'info', cat: 'project', ch: 'ssh', task: null, msg: '<b>手动添加</b> · 工程通过「扫描」自动发现，暂无手动添加入口' });

    const hasSource = cfgHasSource(form);
    const complete = cfgComplete(form);
    const online = PNODES().filter((n) => n.status !== 'offline');
    const formNodes = cfgTargetIds(form);
    const cn = formNodes.includes(coldNode) ? coldNode : formNodes[0];

    /* ---- 冷启动验证：二次确认（破坏性）---- */
    const coldRun = (nodeId) => {
      const node = NODE(String(nodeId)); if (!node || !proj) return;
      const dcPath = cfgDcPath(form);
      if (!dcPath) { s.pushLog({ lv: 'err', cat: 'pso', ch: 'ssh', msg: '冷启动验证需要先配置 nDisplay 配置来源' }); return; }
      const extraArgs = (form.extra_args || '').split(/\s+/).filter(Boolean);
      s.runStreamingCmd(
        { domain: 'pso', action: 'cold-verify', target: node.host + ' · ' + proj.name, chan: 'ssh',
          note: '冷启动验证 · 清空驱动缓存后全流程冷跑 · ' + node.host },
        () => startPsoColdtest({ project_id: Number(proj.id), target_machine_ids: [node.machineId],
          resolution_w: 1920, resolution_h: 1080, max_minutes: form.max_minutes || 20,
          dc_cfg_path: dcPath, dc_node: (form.dc_node && form.dc_node.trim()) || 'Node_0',
          offscreen: form.offscreen !== false, extra_args: extraArgs, traversal: null, ue_version: null }),
        { mode: 'event', events: ['pso-coldtest-progress', 'pso-coldtest-finalized'], jobIdOf: (r) => r.job_id,
          isMine: (pp, jid) => pp && pp.parent_job_id === jid, total: (r) => (r.runs || []).length,
          cancellable: true, cancelIds: (r) => (r.runs || []).map((x) => x.job_id).filter(Boolean),
          reduce: (ev, p, st) => {
            if (ev === 'pso-coldtest-finalized') return { done: true, ok: p.status === 'ok', exit: p.status === 'ok' ? 0 : 2,
              log: { lv: p.status === 'ok' ? 'ok' : 'err', msg: node.host + ' 冷启动验证 ' + (p.status === 'ok' ? '通过 · 从零证明成功' : '未通过 · ' + (p.error_message || '')) } };
            const e = p && p.event ? p.event : {};
            return e.kind === 'log_line' && e.parsed_kind ? { log: { lv: 'info', msg: e.text } } : {};
          },
          timeoutMs: ((form.max_minutes || 20) + 15) * 60 * 1000,
          onDone: () => { loadPsoData(s); loadDriverSnapshots(s); } }).catch(() => {});
    };
    const coldConfirm = (nodeId) => {
      const node = NODE(String(nodeId)); if (!node) return;
      const snap = (s.psoDriverSnapshots || {})[node.machineId];
      s.setModal({ render: ({ close }) => h('div', { className: 'drawer drawer--preview danger' },
        h('div', { className: 'drawer-h' },
          h('span', { className: 'di' }, h(Icon, { name: 'alert', size: 17 })),
          h('div', { style: { minWidth: 0 } }, h('h2', null, '冷启动验证 · ' + node.host),
            h('div', { className: 'sub' }, h('span', { className: 'cli-pill' }, 'pso cold-verify'), h('span', { className: 'danger-note' }, ' · 破坏性操作，需确认'))),
          h('button', { className: 'iconbtn x', onClick: close }, h(Icon, { name: 'x', size: 16 }))),
        h('div', { className: 'drawer-b' },
          h('div', { className: 'pset-cold-impact' },
            h('div', { className: 'pset-cold-h' }, h(Icon, { name: 'trash', size: 14 }), '将执行以下影响'),
            h('ul', { className: 'pset-cold-list' },
              h('li', null, '删除节点 ', h('b', { className: 'mono' }, node.host), ' 的全部 DX shader 缓存（当前 ',
                h('b', { className: 'mono' }, (snap ? snap.total_file_count : 0) + ' 个文件'), ' / ', h('b', { className: 'mono' }, snap ? humanBytes(snap.total_bytes) : '—'), '）'),
              h('li', null, '该机所有应用首次运行将重新编译着色器，可能出现明显卡顿'),
              h('li', null, '随后以拍摄形态从零全流程冷跑并验证，用于从零证明绿灯'))),
          h('div', { className: 'pset-cold-note' }, h(Icon, { name: 'info', size: 12 }), '冷启动验证耗时显著长于常规预跑，请在有充足时间窗口时执行。')),
        h('div', { className: 'drawer-f' },
          h(Button, { variant: 'secondary', size: 'M', onPress: close }, '取消'),
          h(Button, { variant: 'negative', size: 'M', icon: h(Icon, { name: 'flush', size: 14 }), onPress: () => { close(); coldRun(nodeId); } }, '清空缓存并冷跑'))) });
    };

    /* ---- 左栏 · 工程列表（复用 window.VOLO_CACHE_DDC.projRow）---- */
    const pRow = (p) => {
      const cc = cfgComplete(settingsOf(s, p.id));
      return h('div', { key: p.id, className: 'pset-proj' + (selProj === p.id ? ' on' : ''), onClick: () => pickProj(p.id) },
        h('span', { className: 'pset-proj-thumb' }, h(Icon, { name: 'film', size: 17 })),
        h('div', { className: 'pset-proj-meta' },
          h('div', { className: 'pset-proj-name' }, p.name),
          h('div', { className: 'pset-proj-sub' }, h('span', { className: 'pset-ue mono' }, 'UE ' + p.ue), h('span', { className: 'pset-proj-file mono' }, p.uproject))),
        h('span', { className: 'pset-proj-st', title: cc ? '配置完整' : '配置待补全' }, CX.dot(cc ? 'positive' : 'notice')));
    };
    const master = h('div', { className: 'pset-master' },
      h('div', { className: 'pset-scan' },
        h('span', { className: 'pset-scan-info' }, scanning ? h('span', { className: 'spin' }, h(Icon, { name: 'sync', size: 13 })) : h(Icon, { name: 'search', size: 13 }),
          scanning ? '正在扫描网络…' : ('已发现 ' + projs.length + ' 个工程')),
        h('div', { className: 'pset-scan-acts' },
          h('button', { className: 'mini-btn', disabled: scanning, onClick: scan }, h(Icon, { name: 'search', size: 12 }), '扫描'),
          h('button', { className: 'mini-btn', onClick: addManual }, h(Icon, { name: 'plus', size: 12 }), '手动添加'))),
      h('div', { className: 'pset-plist' }, projs.length === 0
        ? h('div', { className: 'gen-empty', style: { padding: '18px 0' } }, h(Icon, { name: 'film', size: 20 }), h('span', null, '尚未发现工程'))
        : projs.map(pRow)));

    if (!proj) return h('div', { className: 'pset' }, master, h('div', { className: 'pset-detail' },
      h('div', { className: 'id-empty' }, h('div', { className: 'ph' }, h(Icon, { name: 'layers', size: 22 })), h('div', null, '在左侧选择一个工程'))));

    /* ---- 表单小工具 ---- */
    const field = (label, control, hint) => h('div', { className: 'pset-field' },
      h('label', { className: 'pset-lbl' }, label), control, hint ? h('div', { className: 'pset-hint' }, hint) : null);
    const group = (title, sub, kids) => h('div', { className: 'pset-group' },
      h('div', { className: 'pset-group-h' }, h('span', { className: 'pset-group-t' }, title), sub ? h('span', { className: 'pset-group-s' }, sub) : null),
      h('div', { className: 'pset-group-b' }, kids));

    const assetControl = assetsLoading
      ? h('div', { className: 'pset-noasset' }, h('span', { className: 'spin' }, h(Icon, { name: 'sync', size: 13 })), '正在扫描工程内 .ndisplay 资产…')
      : assets.length
        ? h(Selector, { kpre: '配置资产', value: form.dc_cfg_asset || assets[0], options: assets.map((a) => ({ id: a, label: a.split(/[\\/]/).pop() })), width: 320, align: 'left', onChange: (v) => set({ dc_cfg_asset: v }) })
        : h('div', { className: 'pset-noasset' }, h(Icon, { name: 'alert', size: 13 }), '工程内未发现 nDisplay 配置资产');
    const manualControl = h('input', { className: 'dp-input mono pset-path', placeholder: '例如 D:\\Projects\\Helios\\Config\\Stage.ndisplay',
      value: form.dc_cfg_manual_path || '', spellCheck: false, onChange: (e) => set({ dc_cfg_manual_path: e.target.value }) });
    const radioRow = (val, label, subControl) => h('div', { className: 'pset-rrow' + (form.dc_cfg_source === val ? ' on' : '') },
      h('button', { className: 'pset-radio-btn', onClick: () => set({ dc_cfg_source: val }) },
        h('span', { className: 'pset-radio-dot' + (form.dc_cfg_source === val ? ' on' : '') }), label),
      form.dc_cfg_source === val ? h('div', { className: 'pset-rsub' }, subControl) : null);

    const nodeChips = h('div', { className: 'pset-nodes' }, online.map((n) => {
      const on = formNodes.includes(n.machineId);
      return h('button', { key: n.id, className: 'pc-node' + (on ? ' on' : ''),
          onClick: () => set({ target_machine_ids: JSON.stringify(on ? formNodes.filter((x) => x !== n.machineId) : formNodes.concat(n.machineId)) }) },
        h('span', { className: 'pc-ck' }, on ? h(Icon, { name: 'check', size: 11 }) : null),
        CX.dot('positive'), h('span', { className: 'mono' }, n.host), h('span', { className: 'pc-gpu' }, gpuText(gpuSigOf(s, n.machineId))));
    }));
    const numField = (label, val, unit, onCh, hint) => field(label,
      h('div', { className: 'pset-num' }, h('input', { type: 'number', className: 'mono', value: val, min: 1, onChange: (e) => onCh(parseInt(e.target.value || '0', 10) || 0) }), h('span', { className: 'pset-num-u' }, unit)), hint);

    const detail = h('div', { className: 'pset-detail' },
      h('div', { className: 'pset-detail-head' },
        h('span', { className: 'pset-dh-thumb' }, h(Icon, { name: 'film', size: 20 })),
        h('div', { style: { minWidth: 0 } },
          h('div', { className: 'pset-dh-name' }, proj.name),
          h('div', { className: 'pset-dh-sub mono' }, 'UE ' + proj.ue + ' · ' + proj.uproject)),
        h('span', { className: 'spill spill--' + (complete ? 'positive' : 'notice') }, h(Icon, { name: complete ? 'check' : 'alert', size: 12 }), complete ? '配置完整' : '配置待补全')),

      h('div', { className: 'pset-form' },
        group('启动形态', 'PSO 绿灯的关键 —— 必须与正式拍摄完全一致', [
          h('div', { className: 'pset-field', key: 'src' },
            h('label', { className: 'pset-lbl' }, 'nDisplay 配置来源'),
            h('div', { className: 'pset-radio' }, radioRow('asset', '工程内自动发现的配置资产', assetControl), radioRow('manual', '手动指定 .ndisplay 文件', manualControl)),
            h('div', { className: 'pset-redline' }, h(Icon, { name: 'alert', size: 12 }),
              '必须与正式拍摄使用同一 nDisplay 配置，否则预跑填充的缓存与拍摄形态不一致，绿灯不可信。'),
            !hasSource ? h('div', { className: 'pset-block' }, h(Icon, { name: 'alert', size: 14 }),
              h('div', null, h('b', null, '缺少有效的 nDisplay 配置'), h('div', { className: 'pset-block-d' }, '预跑无法以拍摄形态启动 —— 请选择工程内配置资产或指定 .ndisplay 文件后再保存。'))) : null),
          field('nDisplay 节点 ID（dc_node）',
            h('input', { className: 'dp-input mono', placeholder: '例如 Node_0', value: form.dc_node || '', spellCheck: false, onChange: (e) => set({ dc_node: e.target.value }) }),
            '必须与上方 nDisplay 配置内定义的节点名完全一致，与配置文件路径无关；留空默认 Node_0。当前为工程级单值，多节点集群逐台预跑/冷启动验证前请手动切换。'),
          field('附加启动参数',
            h('input', { className: 'dp-input mono', value: form.extra_args || '', spellCheck: false, onChange: (e) => set({ extra_args: e.target.value }) }),
            '与拍摄一致的画质 / 自定义参数，保证编译出同一批 shader。'),
          field('headless 后台预跑',
            h('button', { className: 'pset-toggle' + (form.offscreen ? ' on' : ''), onClick: () => set({ offscreen: !form.offscreen }) },
              h('span', { className: 'pset-toggle-track' }, h('span', { className: 'pset-toggle-knob' })),
              h('span', { className: 'pset-toggle-lbl' }, form.offscreen ? '开启' : '关闭')),
            '后台静默运行，不投放到屏幕。'),
        ]),

        group('预跑范围', '在哪些节点、跑多久、如何判完成', [
          field('预跑节点集合', nodeChips, '默认全选在线渲染节点。'),
          h('div', { className: 'pset-num-row', key: 'nums' },
            numField('遍历时长上限', form.max_minutes, '分钟', (v) => set({ max_minutes: v }), '单节点遍历的硬上限，到点即停。'),
            numField('收敛窗口', form.probe_interval_secs, '秒', (v) => set({ probe_interval_secs: v }), '收敛采样间隔；仅在下方地图包路径已配置（启用遍历引擎）时生效。')),
          field('地图包路径（遍历引擎）',
            h('input', { className: 'dp-input mono', placeholder: '例如 /Game/InCamVFXBP/Maps/LED_CurvedStage（留空 = 不启用遍历，固定机位）',
              value: form.map_path || '', spellCheck: false, onChange: (e) => set({ map_path: e.target.value }) }),
            '设计稿把「遍历驱动方式」标为只读，但启用遍历引擎必须知道当前加载的地图包——本仓暂未采集，需手填；留空预跑仍完整可用，只是没有收敛曲线。'),
          field('遍历驱动方式',
            h('div', { className: 'pset-ro' }, h(Icon, { name: 'live', size: 14 }), h('span', { className: 'mono' }, '舞台扫描 + RC WebSocket 走位'), h('span', { className: 'pset-ro-tag' }, '只读')),
            '与拍摄一致的走位驱动遍历场景，覆盖真实机位路径。'),
        ]),

        h('div', { className: 'pset-danger' },
          h('div', { className: 'pset-danger-h' }, h(Icon, { name: 'alert', size: 14 }), '危险区'),
          h('div', { className: 'pset-danger-body' },
            h('div', { className: 'pset-danger-main' },
              h('div', { className: 'pset-danger-t' }, '冷启动验证'),
              h('div', { className: 'pset-danger-d' }, '清空该节点显卡驱动缓存后全流程冷跑，用于从零证明 —— 不依赖任何既有缓存。')),
            h('div', { className: 'pset-danger-act' },
              formNodes.length
                ? h(Selector, { kpre: '目标节点', value: cn, options: formNodes.map((id) => { const n = (window.RENDER_NODES || []).find((x) => x.machineId === id); return { id, label: n ? n.host : String(id) }; }), width: 168, align: 'left', onChange: setColdNode })
                : h('span', { className: 'pset-hint' }, '先在上方选择预跑节点'),
              h(Button, { variant: 'negative', size: 'M', icon: h(Icon, { name: 'flush', size: 14 }), isDisabled: !formNodes.length, onPress: () => coldConfirm(cn) }, '冷启动验证')))),

        h('div', { className: 'pset-cvar-note' }, h(Icon, { name: 'info', size: 12 }),
          '此处不提供官方 PSO Precaching 的任何 CVar 开关 —— 该系统在编辑器 -game 形态下不生效，避免「开关是绿的所以有保护」的错觉。防卡顿完全依赖上面的驱动缓存预跑。')),

      h('div', { className: 'pset-foot' },
        h('span', { className: 'pset-save-st ' + (flash ? 'ok' : dirty ? 'dirty' : 'idle') },
          flash ? h(React.Fragment, null, h(Icon, { name: 'check', size: 13 }), '已保存')
            : dirty ? h(React.Fragment, null, h('span', { className: 'pset-dot' }), '有未保存更改')
              : h(React.Fragment, null, h(Icon, { name: 'check', size: 13 }), '配置已同步')),
        h(Button, { variant: 'accent', size: 'M', isDisabled: !dirty, icon: h(Icon, { name: 'check', size: 14 }), onPress: save }, '保存设置')));

    return h('div', { className: 'pset' }, master, detail);
  }

  /* =================== 检查器 · 绿灯单元格详情 =================== */
  function Inspector({ s }) {
    const sel = s.psoSel && s.psoSel.proj ? s.psoSel : null;
    if (!sel) return h('div', { className: 'insp-empty' },
      h('div', { className: 'ph' }, h(Icon, { name: 'grid', size: 30 })),
      h('div', null,
        h('div', { style: { color: 'var(--chrome-dim)', fontWeight: 600, marginBottom: 4 } }, '未选择单元格'),
        '点绿灯矩阵里的任一格，这里就地展开最近运行、卡顿归因与失效事件链'));
    const p = PROJ(sel.proj), n = NODE(sel.node);
    if (!p || !n) return h('div', { className: 'insp-empty' }, h('div', { className: 'ph' }, h(Icon, { name: 'grid', size: 30 })), h('div', null, '数据已变化，请重新选择'));
    const g = glOf(s, sel.proj, n);
    const m = GLS[g.state] || GLS.never;
    const canReval = g.state === 'stale' || g.state === 'invalid';
    const last = g.cell && g.cell.green_run_id ? runById(s, sel.proj, g.cell.green_run_id) : lastRunFor(s, sel.proj, n.machineId);
    const KV = (k, v) => h('div', { className: 'kv' }, h('span', { className: 'k' }, k), h('span', { className: 'v' }, v));
    const doReval = () => revalidate(s, [{ projId: sel.proj, node: n }], {}).catch((err) => s.pushLog({ lv: 'err', cat: 'pso', ch: 'ssh', msg: '复验失败 · ' + (err && err.message ? err.message : err) }));
    return h('div', { className: 'insp-detail' },
      h('div', { className: 'insp-head' },
        h('span', { className: 'ico' }, h(Icon, { name: 'grid', size: 15 })),
        h('div', { style: { minWidth: 0 } }, h('div', { className: 'tt' }, p.name + ' × ' + n.host),
          h('div', { className: 'sub mono' }, n.status !== 'offline' ? gpuText(gpuSigOf(s, n.machineId)) : '离线')),
        h('button', { className: 'iconbtn x', onClick: () => s.setPsoSel(null) }, h(Icon, { name: 'x', size: 16 }))),
      h('div', { className: 'id-body' },
        h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, '当前绿灯状态'),
          h('div', { className: 'pin-state' },
            h('span', { className: 'spill spill--' + m.vis },
              m.icon === 'minus' ? h('span', { style: { fontWeight: 800 } }, '—') : h(Icon, { name: m.icon, size: 12 }), m.label),
            h('span', { className: 'pin-verified' }, g.state === 'ready' ? (g.verified + ' · 验证段实测 0 卡顿') : g.reason ? (g.verified || '—') + ' · ' + g.reason : (g.verified || '从未预跑')))),
        last ? h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, '最近运行'),
          KV('时间', fmtWhen(last.started_at)),
          KV('模式', (MODE_LABEL[last.mode] || last.mode) + '（' + (last.offscreen === false ? '窗口' : '无人值守') + '）'),
          KV('时长', fmtDur(last.duration_secs)),
          KV('缓存增长', last.driver_cache_growth_bytes != null ? ('+' + humanBytes(last.driver_cache_growth_bytes)) : '—')) : null,
        h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, '卡顿归因'),
          g.state === 'ready'
            ? h('div', { className: 'pin-attr ok' }, h(Icon, { name: 'check', size: 13 }), '验证跑实测 0 卡顿 —— 缓存已按拍摄形态填满，可上场')
            : g.state === 'never'
              ? h('div', { className: 'pin-attr dim' }, h(Icon, { name: 'minus', size: 13 }), '该组合尚未预跑，无卡顿数据 —— 上场前需先预跑并验证')
              : g.state === 'stale'
                ? h('div', { className: 'pin-attr warn' }, h(Icon, { name: 'sync', size: 13 }), '节点重启后驱动缓存虽在盘，但无法保证仍命中，需复验')
                : h('div', { className: 'pin-attr bad' }, h(Icon, { name: 'alert', size: 13 }), (g.reason || '缓存已失效') + ' —— 现在上场会反复卡顿，必须复验')),
        g.cell && g.cell.invalidation_reasons && g.cell.invalidation_reasons.length
          ? h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, '失效事件链'),
              h('div', { className: 'pin-chain' }, g.cell.invalidation_reasons.slice().sort((a, b) => String(b.detected_at || '').localeCompare(String(a.detected_at || ''))).map((c, i) => h('div', { key: c.id || i, className: 'pin-ev' },
                h('span', { className: 'pin-ev-dot s-' + (c.reason === 'node_rebooted' ? 'notice' : 'negative') }),
                h('div', { className: 'pin-ev-main' },
                  h('div', { className: 'pin-ev-tx' }, REASON_LABEL[c.reason] || c.detail),
                  h('div', { className: 'pin-ev-t mono' }, fmtWhen(c.detected_at))))))) : null),
      h('div', { className: 'drawer-f' },
        h('button', { className: 'mini-btn', onClick: () => { s.setLogSearch(n.host); s.setLogOpen(true); } }, h(Icon, { name: 'terminal', size: 13 }), '看该节点日志流'),
        n.status === 'offline' ? null
          : canReval
            ? h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'sync', size: 14 }), onPress: doReval }, '复验此格')
            : g.state === 'never'
              ? h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'bolt', size: 14 }), onPress: doReval }, '预跑并验证')
              : h(Button, { variant: 'secondary', size: 'M', icon: h(Icon, { name: 'sync', size: 14 }), onPress: doReval }, '重新验证')));
  }

  window.VOLO_CACHE_PSO_DASH = {
    center: (s) => h(Dashboard, { s }),
    inspector: (s) => h(Inspector, { s }),
  };
})();
