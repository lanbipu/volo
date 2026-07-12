// @ts-nocheck
/* Volo — Cache · PSO 缓存（合并页 · 借鉴 DDC PAK 双栏形式）
   ------------------------------------------------------------------
   原「Dashboard | 设置」两个子页合并为一页，左右双栏：
     · 左栏「预跑就绪状态」—— 只显示已预跑并验证过的工程（hero + 节点色条 + 工程卡片/节点药丸），
       不再逐一铺开每个工程×节点的矩阵/驱动缓存/告警/巡检细节卡片。
     · 右栏「工程扫描与预跑」—— UI/板块设置借鉴 DDC PAK「工程扫描与生成」，但扫描控制面独立：
       走 cacheProjectScan.runDiscover（不经 window.VOLO_CACHE_DDC），自有搜索根/收藏
       （volo.psoFavRoots）；扫描范围 + 多个可编辑搜索根目录 + 列表工具条 + 三视图；
       点工程打开「工程预跑设置」模态。
   检查器不再承载任何内容（同 DDC PAK 页的处理），只给说明性空状态。

   心智模型不变：绿灯是实测出来的 · 绿灯会过期 · 预跑无人值守。禁止官方 PSO 指标 / 覆盖率百分比。

   真实数据源映射（对应设计稿 mock）：
     PNODES/PPROJ  → window.RENDER_NODES(过滤 roleKey==='render') / window.UE_PROJECTS
                     （集群工程清单是共享资源；PSO 与 DDC PAK 都能独立发起扫描并刷新它；
                      缩略图经 cacheProjectThumbs 共用探测缓存）
     GL_SEED       → list_pso_status（PsoStatusCell，ok/degraded/none 三态 + invalidation_reasons）
                      按工程 fan-out 存 s.psoStatusByProject；四态由 glOf() 在 3 态基础上结合节点
                      在线态 + 失效原因分类现算（node_rebooted-only → 需复验，其余原因 → 已失效）
     CACHE_ROWS    → list_driver_cache_snapshots 批量读库（无 SSH），存 s.psoDriverSnapshots
                      （仅在「工程预跑设置」模态的冷启动确认门里展示影响范围，不再单列驱动缓存卡片）
     HIST_SEED     → list_pso_warmup_runs 按工程 fan-out 存 s.psoRunsByProject，跨工程合并时间倒序
     CFG_SEED      → get/set_pso_project_settings 按工程持久化（pso_project_settings 表）
     NDC_ASSETS    → discover_ndisplay_assets（打开设置模态时按需触发）
     MAP_PATHS     → discover_project_maps（同模态并行扫 Content/**/*.umap → /Game/...）
     常用地址收藏   → 纯前端 localStorage（volo.psoFavRoots），与 DDC PAK 的 volo.pakFavRoots 独立

   遍历引擎（RC WebSocket 驱动舞台扫场 + 收敛判定）设计稿标「只读」，但 TraversalRequest.map_path
   是必填才能启用——「地图包路径」从工程 Content/**/*.umap 扫描成 /Game/... 列表供选择
   （可选手动保留旧路径）；留空 = 不启用遍历，预跑仍完整可用，只是没有收敛曲线。「收敛窗口」
   字段沿用既有 probe_interval_secs（遍历采样间隔），不是新概念、不新增后端字段。

   s.psoSel（绿灯矩阵选中单元格）随本次改造一并下线——矩阵视图已移除，检查器不再承载任何选中态。 */
import * as React from "react";
import "../ds";
import "./cache";
import { listen } from "@tauri-apps/api/event";
import {
  listPsoStatus, listPsoWarmupRuns, startPsoWarmup, startPsoColdtest, cancelUeJob,
  listDriverCacheSnapshots, getPsoProjectSettings, setPsoProjectSettings,
  discoverNdisplayAssets, discoverProjectMaps, listRemoteDirectories,
} from "../api/commands";
import {
  humanBytes, pickSrc, scopeOpts, runDiscover, openFolder, clusterGate,
} from "./cacheProjectScan";
import { useProjectThumbs } from "./cacheProjectThumbs";

(function () {
  const { Button } = window.Spectrum2DesignSystem_b6d1b3;
  const { useState, useRef, useEffect } = React;
  const h = React.createElement;
  const CX = window.VOLO_CX;
  const Selector = window.Selector;

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

  /* 四态：色 + 图标 + 文字三通道表达（对齐设计稿 GLS） */
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
  const STAGES = ['启动', '遍历中', '收敛判定', '验证跑'];
  const shortGamePathLabel = (path) => path.split('/').filter(Boolean).slice(-2).join('/');
  const buildMapPathOptions = (maps, savedPath) => {
    const saved = (savedPath || '').trim();
    const opts = [{ id: '', label: '不启用遍历（固定机位）' }]
      .concat(maps.map((m) => ({ id: m, label: shortGamePathLabel(m) })));
    if (saved && maps.indexOf(saved) < 0) {
      opts.push({ id: saved, label: saved + '（工程内未找到）' });
    }
    return opts;
  };
  const loadDiscoveredList = (invoke, setItems, setLoading) => {
    setLoading(true);
    invoke()
      .then((v) => setItems(Array.isArray(v) ? v : []), () => setItems([]))
      .finally(() => setLoading(false));
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

  /* =================== 绿灯四态映射（3 态后端 + 在线态 + 失效原因分类 → 4 态）=================== */
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

  /* 工程在其配置节点上的就绪计数（仅在线节点） */
  const projReady = (s, p) => {
    const ids = cfgTargetIds(settingsOf(s, p.id));
    const nodes = ids.map((mid) => PNODES().find((n) => n.machineId === mid)).filter((n) => n && n.status !== 'offline');
    const ok = nodes.filter((n) => glOf(s, p.id, n).state === 'ready').length;
    return { ok, tot: nodes.length };
  };
  /* 工程是否已预跑并验证过（至少一个在线配置节点有实测结果：就绪/需复验/已失效，不含未预跑）*/
  const hasResults = (s, p) => {
    const ids = cfgTargetIds(settingsOf(s, p.id));
    return ids.some((mid) => {
      const n = PNODES().find((x) => x.machineId === mid);
      if (!n || n.status === 'offline') return false;
      const st = glOf(s, p.id, n).state;
      return st === 'ready' || st === 'stale' || st === 'invalid';
    });
  };
  const shownProjects = (s) => PPROJ().filter((p) => hasResults(s, p));

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
     真实 {jobId,parentJobId}，供运行态卡的取消按钮 / 事件过滤白名单使用；不传则只走
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

  /* =================== 预跑并验证 · 确认对话框（全局批量，跨工程统一节点集合）=================== */
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
    proj.forEach((pid) => nodes.forEach((nid) => { const n = NODE(nid); if (n) pairs.push({ projId: pid, machineId: n.machineId }); }));
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
              h('div', { className: 'pset-block-d' }, '请先点该工程「设置」配置 nDisplay 配置来源与目标节点。'))) : null,
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
          onPress: () => { onStart(pairs, mode); close(); } }, '开始预跑并验证')));
  }

  /* =========================================================================
     工程预跑设置 · 二级页面（模态）—— 迁移自原「设置」页右栏表单，字段 0 改动
     ========================================================================= */
  function ProjectSettingsDialog({ s, projId, close, onPrerun }) {
    const proj = PROJ(projId);
    const empty = { dc_cfg_source: 'manual', dc_cfg_asset: null, dc_cfg_manual_path: '', extra_args: '', offscreen: true,
      target_machine_ids: '[]', max_minutes: 20, probe_interval_secs: 30, map_path: '', dc_node: '' };
    const load = () => { const raw = settingsOf(s, projId); return raw ? Object.assign({}, empty, raw, { project_id: Number(projId) }) : Object.assign({}, empty, { project_id: Number(projId) }); };
    const [form, setForm] = useState(load);
    const [saved, setSaved] = useState(load);
    const [flash, setFlash] = useState(false);
    const [assets, setAssets] = useState([]);
    const [assetsLoading, setAssetsLoading] = useState(false);
    const [maps, setMaps] = useState([]);
    const [mapsLoading, setMapsLoading] = useState(false);
    const [coldNode, setColdNode] = useState(null);
    const [coldConfirm, setColdConfirm] = useState(false);
    const ft = useRef(null);
    useEffect(() => () => clearTimeout(ft.current), []);

    const set = (patch) => setForm((f) => Object.assign({}, f, patch));
    const dirty = JSON.stringify(form) !== JSON.stringify(saved);

    useEffect(() => {
      if (!proj) return;
      const node = pickSrc(proj);
      if (!node || node.status === 'offline' || !proj.root) {
        setAssets([]); setMaps([]); return;
      }
      loadDiscoveredList(() => discoverNdisplayAssets(node.machineId, proj.root), setAssets, setAssetsLoading);
      loadDiscoveredList(() => discoverProjectMaps(node.machineId, proj.root), setMaps, setMapsLoading);
    }, [projId]); // eslint-disable-line react-hooks/exhaustive-deps

    /* Selector 在未选值时会回退显示 assets[0]（纯 UI 兜底），但那不会写回 form——不补这一步，
       用户会看到「已选中第一个配置资产」，保存的却仍是 dc_cfg_asset: null，cfgHasSource 继续判失败。 */
    useEffect(() => {
      if (form.dc_cfg_source !== 'asset' || form.dc_cfg_asset || assetsLoading || !assets.length) return;
      set({ dc_cfg_asset: assets[0] });
    }, [form.dc_cfg_source, form.dc_cfg_asset, assetsLoading, assets]); // eslint-disable-line react-hooks/exhaustive-deps

    if (!proj) return h('div', { className: 'drawer drawer--preview pso-set-dialog' },
      h('div', { className: 'drawer-h' },
        h('div', { style: { minWidth: 0 } }, h('h2', null, '工程不存在或已被移除')),
        h('button', { className: 'iconbtn x', onClick: close }, h(Icon, { name: 'x', size: 16 }))));

    const savePromise = () => {
      const payload = Object.assign({}, form, { project_id: Number(projId), updated_at: null });
      return setPsoProjectSettings(payload).then((saved2) => {
        s.setPsoSettingsByProject((prev) => Object.assign({}, prev, { [projId]: saved2 }));
        /* 用服务端返回的 saved2 直接刷新表单——不能重新调 load()，它读的是本次 render
           闭包里的旧 s.psoSettingsByProject（setPsoSettingsByProject 还没落地），会把刚保存的
           改动当场打回旧值，界面显示「已保存」但表单其实回退了。 */
        const c = Object.assign({}, empty, saved2, { project_id: Number(projId) });
        setForm(c); setSaved(JSON.parse(JSON.stringify(c)));
        return saved2;
      });
    };
    const save = () => {
      savePromise().then(() => {
        setFlash(true); clearTimeout(ft.current); ft.current = setTimeout(() => setFlash(false), 2200);
        s.pushLog({ lv: 'ok', cat: 'pso', ch: 'ssh', task: null, msg: '<b>pso config save</b> · ' + proj.name + ' 预跑设置已保存' });
      }, (err) => s.pushLog({ lv: 'err', cat: 'pso', ch: 'ssh', msg: '保存失败 · ' + (err && err.message ? err.message : err) }));
    };
    const saveAndPrerun = () => {
      savePromise().then((saved2) => {
        const pairs = cfgTargetIds(saved2).map((mid) => ({ projId: Number(projId), machineId: mid }));
        close();
        onPrerun(pairs, saved2.offscreen !== false ? '后台' : '窗口');
      }, (err) => s.pushLog({ lv: 'err', cat: 'pso', ch: 'ssh', msg: '保存失败 · ' + (err && err.message ? err.message : err) }));
    };

    const hasSource = cfgHasSource(form);
    const complete = cfgComplete(form);
    const online = PNODES().filter((n) => n.status !== 'offline');
    const formNodes = cfgTargetIds(form);
    const cn = formNodes.includes(coldNode) ? coldNode : formNodes[0];

    /* ---- 冷启动验证：清空该节点驱动缓存后全流程冷跑（危险操作，模态内就地展开红色确认门，
       同 DDC PAK 页删除确认的模式——不再嵌套弹另一个 s.setModal，避免顶掉当前设置模态）---- */
    const coldRun = (machineId) => {
      const node = PNODES().find((n) => n.machineId === machineId); if (!node) return;
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

    /* ---- 表单小工具 ---- */
    const field = (label, control, hint, key) => h('div', { className: 'pset-field', key },
      h('label', { className: 'pset-lbl' }, label), control, hint ? h('div', { className: 'pset-hint' }, hint) : null);
    const group = (title, sub, kids) => h('div', { className: 'pset-group' },
      h('div', { className: 'pset-group-h' }, h('span', { className: 'pset-group-t' }, title), sub ? h('span', { className: 'pset-group-s' }, sub) : null),
      h('div', { className: 'pset-group-b' }, kids));

    const assetControl = assetsLoading
      ? h('div', { className: 'pset-noasset' }, h('span', { className: 'spin' }, h(Icon, { name: 'sync', size: 13 })), '正在扫描工程内 nDisplay 配置…')
      : assets.length
        ? h(Selector, { kpre: '配置资产', value: form.dc_cfg_asset || assets[0], options: assets.map((a) => ({ id: a, label: a.split(/[\\/]/).pop() })), width: 300, align: 'left', onChange: (v) => set({ dc_cfg_asset: v }) })
        : h('div', { className: 'pset-noasset' }, h(Icon, { name: 'alert', size: 13 }), '工程内未发现 nDisplay 配置（*.ndisplay / Content/nDisplay_*.uasset）');
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
      h('div', { className: 'pset-num' }, h('input', { type: 'number', className: 'mono', value: val, min: 1, onChange: (e) => onCh(parseInt(e.target.value || '0', 10) || 0) }), h('span', { className: 'pset-num-u' }, unit)), hint, 'n_' + label);

    return h('div', { className: 'drawer drawer--preview pso-set-dialog' },
      h('div', { className: 'drawer-h' },
        h('span', { className: 'pset-dh-thumb' }, h(Icon, { name: 'film', size: 17 })),
        h('div', { style: { minWidth: 0 } },
          h('h2', null, proj.name, ' · 工程预跑设置'),
          h('div', { className: 'sub' }, h('span', { className: 'cli-pill' }, 'pso config'), h('span', { className: 'mono' }, ' · UE ' + proj.ue + ' · ' + proj.uproject))),
        h('span', { className: 'spill spill--' + (complete ? 'positive' : 'notice'), style: { marginLeft: 'auto', flex: '0 0 auto' } }, h(Icon, { name: complete ? 'check' : 'alert', size: 12 }), complete ? '配置完整' : '配置待补全'),
        h('button', { className: 'iconbtn x', onClick: close }, h(Icon, { name: 'x', size: 16 }))),
      h('div', { className: 'drawer-b' },
        h('div', { className: 'pset-form pset-form--modal' },
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
              '必须与上方 nDisplay 配置内定义的节点名完全一致，与配置文件路径无关；留空默认 Node_0。'),
            field('附加启动参数',
              h('input', { className: 'dp-input mono', value: form.extra_args || '', spellCheck: false, onChange: (e) => set({ extra_args: e.target.value }) }),
              '与拍摄一致的画质 / 自定义参数，保证编译出同一批 shader。'),
            field('headless 后台预跑',
              h('button', { className: 'pset-toggle' + (form.offscreen ? ' on' : ''), onClick: () => set({ offscreen: !form.offscreen }) },
                h('span', { className: 'pset-toggle-track' }, h('span', { className: 'pset-toggle-knob' })),
                h('span', { className: 'pset-toggle-lbl' }, form.offscreen ? '开启' : '关闭')),
              '后台静默运行，不投放到屏幕；失败自动回退窗口模式。'),
          ]),
          group('预跑范围', '在哪些节点、跑多久、如何判完成', [
            field('预跑节点集合', nodeChips, '默认全选在线渲染节点。'),
            h('div', { className: 'pset-num-row', key: 'nums' },
              numField('遍历时长上限', form.max_minutes, '分钟', (v) => set({ max_minutes: v }), '单节点遍历的硬上限，到点即停。'),
              numField('收敛窗口', form.probe_interval_secs, '秒', (v) => set({ probe_interval_secs: v }), '收敛采样间隔；仅在下方地图包路径已配置（启用遍历引擎）时生效。')),
            field('地图包路径（遍历引擎）',
              mapsLoading
                ? h('div', { className: 'pset-noasset' }, h('span', { className: 'spin' }, h(Icon, { name: 'sync', size: 13 })), '正在扫描工程内地图…')
                : h(Selector, {
                    kpre: '地图',
                    value: form.map_path || '',
                    options: buildMapPathOptions(maps, form.map_path),
                    width: 300, align: 'left',
                    onChange: (v) => set({ map_path: v || '' }),
                  }),
              mapsLoading ? null
                : (maps.length
                  ? '从工程 Content 扫描到的 .umap；选「不启用遍历」则固定机位预跑，无收敛曲线。'
                  : '工程内未发现 .umap —— 可保持「不启用遍历」，或检查 Content 是否有地图。')),
            field('遍历驱动方式',
              h('div', { className: 'pset-ro' }, h(Icon, { name: 'live', size: 14 }), h('span', { className: 'mono' }, '舞台扫描 + RC WebSocket 走位'), h('span', { className: 'pset-ro-tag' }, '只读')),
              '与拍摄一致的走位驱动遍历场景，覆盖真实机位路径。'),
          ]),
          /* 危险区 · 冷启动验证 */
          h('div', { className: 'pset-danger', key: 'danger' },
            h('div', { className: 'pset-danger-h' }, h(Icon, { name: 'alert', size: 14 }), '危险区'),
            coldConfirm
              ? h('div', { className: 'pset-danger-body', style: { flexDirection: 'column', alignItems: 'stretch', gap: 12 } },
                  h('div', { className: 'pset-cold-impact' },
                    h('div', { className: 'pset-cold-h' }, h(Icon, { name: 'trash', size: 14 }), '将清空 ' + ((PNODES().find((n) => n.machineId === cn) || {}).host || '') + ' 的全部 DX shader 缓存并从零冷跑'),
                    h('ul', { className: 'pset-cold-list' },
                      h('li', null, '删除节点 ', h('b', { className: 'mono' }, (PNODES().find((n) => n.machineId === cn) || {}).host || '—'), ' 的全部驱动缓存（当前 ',
                        h('b', { className: 'mono' }, ((s.psoDriverSnapshots || {})[cn] ? ((s.psoDriverSnapshots[cn].total_file_count || 0) + ' 个文件') : '—')), ' / ',
                        h('b', { className: 'mono' }, (s.psoDriverSnapshots || {})[cn] ? humanBytes(s.psoDriverSnapshots[cn].total_bytes) : '—'), '）'),
                      h('li', null, '该机所有应用首次运行将重新编译着色器，可能出现明显卡顿'),
                      h('li', null, '随后以拍摄形态从零全流程冷跑并验证，用于从零证明绿灯'))),
                  h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
                    h('button', { className: 'mini-btn', onClick: () => setColdConfirm(false) }, '取消'),
                    h('button', { className: 'mini-btn danger', onClick: () => { setColdConfirm(false); coldRun(cn); } }, h(Icon, { name: 'flush', size: 12 }), '清空缓存并冷跑')))
              : h('div', { className: 'pset-danger-body' },
                  h('div', { className: 'pset-danger-main' },
                    h('div', { className: 'pset-danger-t' }, '冷启动验证'),
                    h('div', { className: 'pset-danger-d' }, '清空该节点显卡驱动缓存后全流程冷跑，用于从零证明 —— 不依赖任何既有缓存。')),
                  h('div', { className: 'pset-danger-act' },
                    formNodes.length
                      ? h(Selector, { kpre: '目标节点', value: cn, options: formNodes.map((mid) => { const n = PNODES().find((x) => x.machineId === mid); return { id: mid, label: n ? n.host : String(mid) }; }), width: 168, align: 'left', onChange: setColdNode })
                      : h('span', { className: 'pset-hint' }, '先在上方选择预跑节点'),
                    h(Button, { variant: 'negative', size: 'M', icon: h(Icon, { name: 'flush', size: 14 }), isDisabled: !formNodes.length, onPress: () => setColdConfirm(true) }, '冷启动验证')))),
          h('div', { className: 'pset-cvar-note', key: 'note' }, h(Icon, { name: 'info', size: 12 }),
            '此处不提供官方 PSO Precaching 的任何 CVar 开关 —— 该系统在编辑器 -game 形态下不生效，防卡顿完全依赖上面的驱动缓存预跑。'))),
      h('div', { className: 'drawer-f' },
        h('span', { className: 'pset-save-st ' + (flash ? 'ok' : dirty ? 'dirty' : 'idle') },
          flash ? h(React.Fragment, null, h(Icon, { name: 'check', size: 13 }), '已保存')
            : dirty ? h(React.Fragment, null, h('span', { className: 'pset-dot' }), '有未保存更改')
              : h(React.Fragment, null, h(Icon, { name: 'check', size: 13 }), '配置已同步')),
        h(Button, { variant: 'secondary', size: 'M', isDisabled: !dirty, icon: h(Icon, { name: 'check', size: 14 }), onPress: save }, '保存'),
        h(Button, { variant: 'accent', size: 'M', isDisabled: !complete, icon: h(Icon, { name: 'bolt', size: 14 }), onPress: saveAndPrerun }, '保存并预跑验证')));
  }

  /* =========================================================================
     右栏 · 工程扫描与预跑（UI 借鉴 DDC PAK；扫描走 cacheProjectScan，不经 VOLO_CACHE_DDC）
     ========================================================================= */
  const VIEW_OPTS = [
    { id: 'flat', label: '列表', icon: 'list', hint: '平铺矩形模块' },
    { id: 'grouped', label: '文件夹', icon: 'folder', hint: '按父目录分组' },
    { id: 'machine', label: '按机器', icon: 'server', hint: '按每台机器持有的工程分组' },
  ];
  const SORT_OPTS = [{ id: 'updated', label: '更新时间' }, { id: 'name', label: '名称' }, { id: 'path', label: '路径' }];

  function ScanPanel({ s, sel, setSel, openSettings, onPrerun, run }) {
    const [scope, setScope] = useState('all');
    const ridRef = useRef(0);
    const [roots, setRoots] = useState(() => [{ id: ++ridRef.current, val: 'D:\\Unreal Projects' }]);
    const [rootDraft, setRootDraft] = useState('');
    /* 逐级路径提示：当前展开的字段（'add' 或某行 id）+ 高亮项 + 真实查询到的目录项（按
       machineId+parentPath 缓存，避免同一目录反复发起 SSH 往返） */
    const [acOpen, setAcOpen] = useState(false);
    const [acHi, setAcHi] = useState(0);
    const [acField, setAcField] = useState(null);
    const acCacheRef = useRef(new Map());
    /* 常用地址（收藏的搜索根目录）· 持久化到 localStorage，与 DDC PAK 页的收藏各自独立存储 */
    const [favs, setFavs] = useState(() => {
      try { return JSON.parse(localStorage.getItem('volo.psoFavRoots') || '[]'); } catch (e) { return []; }
    });
    useEffect(() => {
      try { localStorage.setItem('volo.psoFavRoots', JSON.stringify(favs)); } catch (e) { /* ignore */ }
    }, [favs]);
    const [query, setQuery] = useState('');
    const [view, setView] = useState('flat');
    const [sort, setSort] = useState('updated');
    const [tileScale, setTileScale] = useState(150);
    const [toolsOpen, setToolsOpen] = useState(false);
    const [openMenu, setOpenMenu] = useState(null);
    const [filters, setFilters] = useState({ machine: null, cfg: null, warnOnly: false });
    const toolsRef = useRef(null);
    useEffect(() => {
      if (!toolsOpen && !openMenu) return undefined;
      const onDown = (e) => { if (toolsRef.current && !toolsRef.current.contains(e.target)) { setToolsOpen(false); setOpenMenu(null); } };
      document.addEventListener('mousedown', onDown);
      return () => document.removeEventListener('mousedown', onDown);
    }, [toolsOpen, openMenu]);
    const [searchOpen, setSearchOpen] = useState(false);
    const searchRef = useRef(null);
    const searchInRef = useRef(null);
    useEffect(() => { if (searchOpen && searchInRef.current) searchInRef.current.focus(); }, [searchOpen]);
    useEffect(() => {
      if (!searchOpen) return undefined;
      const closeIfNoQuery = () => { if (!query.trim()) setSearchOpen(false); };
      const onDown = (e) => { if (searchRef.current && !searchRef.current.contains(e.target)) closeIfNoQuery(); };
      const onKey = (e) => { if (e.key === 'Escape') closeIfNoQuery(); };
      document.addEventListener('mousedown', onDown);
      document.addEventListener('keydown', onKey);
      return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
    }, [searchOpen, query]);
    const [scanning, setScanning] = useState(false);
    const [lastScan, setLastScan] = useState(null);
    const projsForThumb = PPROJ();
    const { thumbs, withThumb, invalidate: invalidateThumbs } = useProjectThumbs(projsForThumb, { includeSize: false });

    /* ---- 搜索根目录：可编辑行 + 一次添加多个 + 常用地址 ---- */
    const rootVals = roots.map((r) => r.val.trim()).filter(Boolean);
    const rootsStr = rootVals.join(';');
    const addRoots = (str) => {
      const parts = String(str || '').split(/[;\n]+/).map((x) => x.trim()).filter(Boolean);
      if (!parts.length) return;
      setRoots((rs) => rs.concat(parts.filter((p) => !rs.some((r) => r.val === p)).map((p) => ({ id: ++ridRef.current, val: p }))));
    };
    const addRoot = (v) => addRoots(v);
    const updateRoot = (id, v) => setRoots((rs) => rs.map((r) => r.id === id ? { id, val: v } : r));
    const removeRoot = (id) => setRoots((rs) => rs.filter((r) => r.id !== id));
    const commitDraft = () => { addRoots(rootDraft.replace(/\\+$/, '')); setRootDraft(''); setAcOpen(false); };
    const normRoot = (v) => String(v || '').replace(/\\+$/, '').trim();
    const isFav = (v) => favs.includes(normRoot(v));
    const toggleFav = (v) => { const val = normRoot(v); if (!val) return; setFavs((f) => f.includes(val) ? f.filter((x) => x !== val) : f.concat(val)); };
    const removeFav = (v) => setFavs((f) => f.filter((x) => x !== v));

    /* ---- 地址栏逐级路径提示：真实查询所选机器的盘符 / 子目录 ---- */
    const acNodes = scope !== 'all' ? [NODE(scope)].filter(Boolean) : PNODES().filter((n) => n.status !== 'offline');
    const acMachineIds = acNodes.map((n) => n.machineId);
    const acMachineKey = acMachineIds.slice().sort((a, b) => a - b).join(',');
    const acScopeLabel = scope !== 'all' ? (acNodes[0] ? acNodes[0].host : null) : (acNodes.length ? ('跨 ' + acNodes.length + ' 台在线机') : null);
    const acText = acField === 'add' ? rootDraft : ((roots.find((r) => r.id === acField) || {}).val || '');
    const splitRootPath = (text) => {
      const t = text || '';
      if (t.indexOf('\\') === -1) return { parentPath: null, typed: t.trim() };
      const segs = t.split('\\');
      const typed = segs.pop();
      return { parentPath: segs.join('\\'), typed: typed.trim() };
    };
    const { parentPath, typed } = splitRootPath(acText);
    const openAc = (field) => { setAcField(field); setAcOpen(true); setAcHi(0); };
    const toSshPath = (p) => (/^[A-Za-z]:$/.test(p) ? p + '\\' : p);
    const fetchDirs = (machineIds, path) => {
      const normPath = path == null ? null : toSshPath(path);
      const idKey = machineIds.slice().sort((a, b) => a - b).join(',');
      const key = idKey + '|' + (normPath || '');
      if (acCacheRef.current.has(key)) return Promise.resolve(acCacheRef.current.get(key));
      return Promise.allSettled(machineIds.map((id) => listRemoteDirectories(id, normPath))).then((results) => {
        const ok = results.filter((r) => r.status === 'fulfilled');
        if (!ok.length) throw new Error('all machines failed to list directories');
        const merged = Array.from(new Set(ok.flatMap((r) => r.value))).sort((a, b) => a.localeCompare(b));
        if (ok.length === machineIds.length) acCacheRef.current.set(key, merged);
        return merged;
      });
    };
    const [siblings, setSiblings] = useState([]);
    const [siblingsLoading, setSiblingsLoading] = useState(false);
    const [siblingsFailed, setSiblingsFailed] = useState(false);
    useEffect(() => {
      if (!acOpen || !acMachineIds.length) return undefined;
      let cancelled = false;
      setSiblingsLoading(true); setSiblingsFailed(false);
      fetchDirs(acMachineIds, parentPath).then((entries) => {
        if (cancelled) return;
        setSiblings(entries); setSiblingsLoading(false);
      }).catch(() => { if (!cancelled) { setSiblings([]); setSiblingsLoading(false); setSiblingsFailed(true); } });
      return () => { cancelled = true; };
    }, [acOpen, acMachineKey, parentPath]);
    const exactName = typed ? (siblings.find((x) => x.toLowerCase() === typed.toLowerCase()) || null) : null;
    const deeperPath = exactName ? (parentPath == null ? exactName : parentPath + '\\' + exactName) : null;
    const [deeperEntries, setDeeperEntries] = useState([]);
    const [deeperLoading, setDeeperLoading] = useState(false);
    const [deeperFailed, setDeeperFailed] = useState(false);
    useEffect(() => {
      if (!acOpen || !acMachineIds.length || deeperPath == null) return undefined;
      let cancelled = false;
      setDeeperLoading(true); setDeeperFailed(false);
      fetchDirs(acMachineIds, deeperPath).then((entries) => {
        if (cancelled) return;
        setDeeperEntries(entries); setDeeperLoading(false);
      }).catch(() => { if (!cancelled) { setDeeperEntries([]); setDeeperLoading(false); setDeeperFailed(true); } });
      return () => { cancelled = true; };
    }, [acOpen, acMachineKey, deeperPath]);
    const acDrilled = !!deeperPath;
    const acBase = acDrilled ? (deeperPath + '\\') : (parentPath == null ? '' : parentPath + '\\');
    const acLoading = acDrilled ? deeperLoading : siblingsLoading;
    const acFailed = acDrilled ? deeperFailed : siblingsFailed;
    const acOpts = acDrilled ? deeperEntries : siblings.filter((c) => !typed || c.toLowerCase().startsWith(typed.toLowerCase()));
    const confirmSeg = (opt) => {
      const next = acBase + opt + '\\';
      if (acField === 'add') setRootDraft(next); else updateRoot(acField, next);
      setAcHi(0); setAcOpen(true);
    };
    const makeAcKey = (field) => (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (!acOpen) openAc(field); else setAcHi((hI) => acOpts.length ? (hI + 1) % acOpts.length : 0); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (!acOpen) openAc(field); else setAcHi((hI) => acOpts.length ? (hI - 1 + acOpts.length) % acOpts.length : 0); }
      else if (e.key === 'Tab') { if (acOpen && acOpts.length) { e.preventDefault(); confirmSeg(acOpts[Math.max(0, acHi)]); } }
      else if (e.key === 'Enter') { e.preventDefault(); if (field === 'add') commitDraft(); else setAcOpen(false); }
      else if (e.key === 'Escape') { setAcOpen(false); }
    };
    const renderAc = () => h('div', { className: 'root-ac' },
      h('div', { className: 'root-ac-h' }, !acMachineIds.length ? '选择根目录' : ('在 ' + acScopeLabel + (parentPath == null ? ' 选择盘符' : (' 的 ' + acBase + ' 下选择文件夹')))),
      !acMachineIds.length
        ? h('div', { className: 'root-ac-empty' }, '当前无在线机器可浏览 · 可直接输入完整路径')
        : acLoading
          ? h('div', { className: 'root-ac-empty' }, h(Icon, { name: 'sync', size: 12 }), ' 查询中…')
          : acFailed
            ? h('div', { className: 'root-ac-empty' }, '无法连接 ' + acScopeLabel + ' · 可直接输入完整路径')
            : acOpts.length
              ? h('div', { className: 'root-ac-list' }, acOpts.map((opt, i) => h('button', {
                  key: opt, type: 'button', className: 'root-ac-opt' + (i === acHi ? ' hi' : ''),
                  onMouseEnter: () => setAcHi(i), onMouseDown: (e) => e.preventDefault(), onClick: () => confirmSeg(opt) },
                  h('span', { className: 'root-ac-ic' }, h(Icon, { name: parentPath == null ? 'server' : 'folder', size: 13 })),
                  h('span', { className: 'root-ac-tx' }, opt),
                  h('span', { className: 'root-ac-kbd' }, i === acHi ? 'Tab 使用' : ''))))
              : h('div', { className: 'root-ac-empty' }, acText.replace(/\\+$/, '').trim() ? '已到末级 · 无更多子文件夹' : '无匹配项'),
      h('div', { className: 'root-ac-foot' }, '↑↓ 选择 · Tab / 单击 确认使用 · 回车确认'));
    useEffect(() => {
      if (!acOpen) return undefined;
      const onDown = (e) => { if (!e.target.closest('.root-add') && !e.target.closest('.root-row')) setAcOpen(false); };
      document.addEventListener('mousedown', onDown);
      return () => document.removeEventListener('mousedown', onDown);
    }, [acOpen]);

    /* gate 必须在【全部】Hooks 之后才能条件 return——否则 reloadCache 让 s.cacheLoading 翻转时
       两次渲染的 Hook 数量不一致，React 抛 "Rendered fewer hooks than expected"（同
       cacheDdcPak.tsx 的既有注释同一坑）。 */
    const g = clusterGate(s, '集群里还没有机器 — 先在「集群总览」扫描添加机器，再做 PSO 预跑'); if (g) return g;

    const doScan = () => {
      setScanning(true);
      const scanned = runDiscover(s, scope, rootsStr);
      if (!scanned) { setScanning(false); setLastScan(new Date()); return; }
      scanned.finally(() => { setScanning(false); setLastScan(new Date()); });
      scanned.then(() => {
        invalidateThumbs();
        refreshAll(s).catch(() => {});
      }, () => {});
    };

    /* ---- 过滤 / 排序 / 分组 ---- */
    const projs = PPROJ();
    const q = query.trim().toLowerCase();
    const inScope = (p) => scope === 'all' || p.machines.includes(scope);
    const isCfg = (p) => cfgComplete(settingsOf(s, p.id));
    const notGreen = (p) => { const r = projReady(s, p); return r.tot === 0 || r.ok < r.tot; };
    const activeFilterCount = (filters.machine ? 1 : 0) + (filters.cfg ? 1 : 0) + (filters.warnOnly ? 1 : 0);
    const passFilters = (p) => {
      if (filters.machine && !p.machines.includes(filters.machine)) return false;
      if (filters.cfg === 'has' && !isCfg(p)) return false;
      if (filters.cfg === 'none' && isCfg(p)) return false;
      if (filters.warnOnly && !notGreen(p)) return false;
      return true;
    };
    const clearFilters = () => setFilters({ machine: null, cfg: null, warnOnly: false });
    const matched = projs.filter((p) => inScope(p) && passFilters(p)
      && (!q || p.name.toLowerCase().includes(q) || (p.root + '\\' + p.uproject).toLowerCase().includes(q)));
    const projMachines = PNODES().filter((n) => projs.some((p) => p.machines.includes(n.id)));
    const machineProjCount = (id) => projs.filter((p) => p.machines.includes(id)).length;
    const mtimeOf = (p) => (thumbs[p.id] && thumbs[p.id].mtime) || '';
    const sorters = {
      updated: (a, b) => {
        const ma = mtimeOf(a), mb = mtimeOf(b);
        if (ma || mb) return mb.localeCompare(ma);
        return String(b.last).localeCompare(String(a.last));
      },
      name: (a, b) => a.name.localeCompare(b.name),
      path: (a, b) => (a.root + '\\' + a.uproject).localeCompare(b.root + '\\' + b.uproject),
    };
    const sorted = matched.slice().sort(sorters[sort]);
    const parentDir = (p) => { const parts = p.root.split('\\'); parts.pop(); return parts.join('\\') || p.root; };
    const toggleSel = (p) => setSel((v) => v.includes(p.id) ? v.filter((x) => x !== p.id) : v.concat(p.id));

    const visibleIds = sorted.map((p) => p.id);
    const visibleSelectedCount = visibleIds.filter((id) => sel.includes(id)).length;
    const allSelected = visibleIds.length > 0 && visibleSelectedCount === visibleIds.length;
    const someSelected = visibleSelectedCount > 0 && !allSelected;
    const toggleAll = () => setSel((v) => allSelected ? v.filter((id) => !visibleIds.includes(id)) : Array.from(new Set(v.concat(visibleIds))));

    /* ---- 工程行 / 平铺卡片：就绪徽标 + 缩略图（与 DDC PAK 共用探测缓存） ---- */
    const psoRow = (raw) => {
      const p = withThumb(raw);
      const rd = projReady(s, p);
      const cc = cfgComplete(settingsOf(s, p.id));
      const readyTone = rd.tot === 0 ? 'neutral' : rd.ok === rd.tot ? 'positive' : rd.ok === 0 ? 'negative' : 'notice';
      const selected = sel.includes(p.id);
      const src = pickSrc(p);
      const path = (src && p.locByMachine && p.locByMachine[String(src.machineId)]) || p.root;
      return h('div', { key: p.id, className: 'proj-row' + (selected ? ' on' : ''), onClick: () => openSettings(p) },
        h('span', { className: 'proj-mck' + (selected ? ' on' : ''), title: '选入批量预跑',
            onClick: (e) => { e.stopPropagation(); toggleSel(p); } }, selected ? h(Icon, { name: 'check', size: 12 }) : null),
        h('span', { className: 'proj-ico' + (p.thumb ? ' has-thumb' : ''),
            title: p.thumb ? ('缩略图来源 · ' + (p.thumbFrom || '') + '\n' + (p.thumbSrc || '')) : null },
          p.thumb
            ? h('img', { className: 'proj-thumb', src: p.thumb, alt: '', draggable: false })
            : h(Icon, { name: 'film', size: 17 })),
        h('div', { className: 'proj-main' },
          h('div', { className: 'proj-name' }, p.name),
          h('button', { type: 'button', className: 'proj-sub proj-sub-open mono', title: '在文件资源管理器中打开工程文件夹',
              onClick: (e) => { e.stopPropagation(); openFolder(s, path, p.name, src, 'pso'); } },
            h('span', { className: 'proj-sub-tx' }, path + '\\' + p.uproject),
            h('span', { className: 'proj-sub-ico' }, h(Icon, { name: 'folder', size: 12 })))),
        h('div', { className: 'proj-tags' },
          h('span', { className: 'proj-tag ue' }, 'UE ' + p.ue),
          h('span', { className: 'proj-tag' }, p.machines.length + ' 台'),
          h('span', { className: 'proj-tag', title: '配置节点上的就绪情况' }, CX.dot(readyTone), '就绪 ' + rd.ok + '/' + rd.tot),
          cc ? h('span', { className: 'proj-tag pak' }, h(Icon, { name: 'check', size: 10 }), '已配置')
             : h('span', { className: 'proj-tag warn' }, h(Icon, { name: 'alert', size: 10 }), '待配置')));
    };
    const psoTile = (raw) => {
      const p = withThumb(raw);
      const rd = projReady(s, p);
      const cc = cfgComplete(settingsOf(s, p.id));
      const selected = sel.includes(p.id);
      const src = pickSrc(p);
      const path = (src && p.locByMachine && p.locByMachine[String(src.machineId)]) || p.root;
      return h('div', { key: p.id, className: 'proj-tile' + (selected ? ' on' : ''), title: p.name + '  ·  ' + path + '\\' + p.uproject, onClick: () => openSettings(p) },
        h('span', { className: 'proj-tile-mck' + (selected ? ' on' : ''), title: '选入批量预跑',
            onClick: (e) => { e.stopPropagation(); toggleSel(p); } }, selected ? h(Icon, { name: 'check', size: 11 }) : null),
        h('div', { className: 'proj-tile-media' + (p.thumb ? ' has-thumb' : '') },
          p.thumb
            ? h('img', { className: 'proj-tile-thumb', src: p.thumb, alt: '', draggable: false })
            : h(Icon, { name: 'film', size: 22 }),
          h('div', { className: 'proj-tile-badges' },
            cc ? h('span', { className: 'proj-tile-badge pak', title: '已配置预跑' }, h(Icon, { name: 'check', size: 10 }), '已配置')
               : h('span', { className: 'proj-tile-badge warn', title: '待配置预跑' }, h(Icon, { name: 'alert', size: 10 })))),
        h('div', { className: 'proj-tile-info' },
          h('div', { className: 'proj-tile-name' }, p.name),
          h('div', { className: 'proj-tile-nrow' },
            h('div', { className: 'proj-tile-sub' }, 'UE ' + p.ue + ' · 就绪 ' + rd.ok + '/' + rd.tot),
            h('button', { type: 'button', className: 'proj-tile-open', title: '打开工程文件夹',
                onClick: (e) => { e.stopPropagation(); openFolder(s, path, p.name, src, 'pso'); } }, h(Icon, { name: 'folder', size: 14 })))));
    };

    const groupBlock = (key, icon, title, items) => h('div', { key, className: 'pak-group' },
      h('div', { className: 'pak-group-h' }, h(Icon, { name: icon, size: 13 }), h('span', { className: 'mono' }, title), h('span', { className: 'ct' }, items.length + ' 个')),
      h('div', { className: 'proj-list' }, items.map(psoRow)));
    const listBody = sorted.length === 0
      ? h('div', { className: 'pak-list-empty' }, h(Icon, { name: 'search', size: 22 }),
          h('span', null, q ? ('无匹配「' + query + '」的工程')
            : activeFilterCount ? '当前筛选无匹配工程 · 调整或清除筛选' : '当前范围内尚未发现工程，点上方「扫描」'))
      : view === 'grouped'
        ? (() => {
            const groups = [];
            sorted.forEach((p) => { const dir = parentDir(p); let grp = groups.find((x) => x.dir === dir); if (!grp) { grp = { dir, items: [] }; groups.push(grp); } grp.items.push(p); });
            return h(React.Fragment, null, groups.map((grp) => groupBlock(grp.dir, 'folder', grp.dir, grp.items)));
          })()
        : view === 'machine'
          ? (() => {
              const rows = projMachines.map((n) => ({ n, items: sorted.filter((p) => p.machines.includes(n.id)) })).filter((gg) => gg.items.length);
              return rows.length === 0
                ? h('div', { className: 'pak-list-empty' }, h(Icon, { name: 'server', size: 22 }), h('span', null, '当前范围下没有机器持有工程'))
                : h(React.Fragment, null, rows.map((gg) => groupBlock(gg.n.id, 'server', gg.n.host, gg.items)));
            })()
          : h('div', { className: 'proj-grid', style: { '--tile-w': tileScale + 'px' } }, sorted.map(psoTile));

    /* ---- 列表工具条：全选（左）+ 搜索 + 合并的「显示 / 排序 / 筛选」图标组（右） · 1:1 借鉴 DDC PAK ---- */
    const viewMenu = h('div', { className: 'pak-tool-menu' },
      h('div', { className: 'ptm-h' }, '显示方式'),
      VIEW_OPTS.map((o) => h('button', { key: o.id, type: 'button', className: 'ptm-i' + (view === o.id ? ' on' : ''), onClick: () => setView(o.id) },
        h('span', { className: 'ptm-ic' }, h(Icon, { name: o.icon, size: 14 })),
        h('div', { className: 'ptm-mm' }, h('span', { className: 'ptm-l' }, o.label), h('span', { className: 'ptm-s' }, o.hint)),
        view === o.id ? h(Icon, { name: 'check', size: 14, style: { marginLeft: 'auto', color: 'var(--volo-400)' } }) : null)));
    const sortMenu = h('div', { className: 'pak-tool-menu' },
      h('div', { className: 'ptm-h' }, '排序方式'),
      SORT_OPTS.map((o) => h('button', { key: o.id, type: 'button', className: 'ptm-i' + (sort === o.id ? ' on' : ''), onClick: () => setSort(o.id) },
        h('span', { className: 'ptm-l' }, o.label),
        sort === o.id ? h(Icon, { name: 'check', size: 14, style: { marginLeft: 'auto', color: 'var(--volo-400)' } }) : null)));
    const setCfgFilter = (v) => setFilters((f) => Object.assign({}, f, { cfg: f.cfg === v ? null : v }));
    const filterMenu = h('div', { className: 'pak-tool-menu pak-filter-menu' },
      h('div', { className: 'ptm-h' }, '筛选策略',
        activeFilterCount ? h('button', { type: 'button', className: 'ptm-clear', onClick: clearFilters }, '清除 ' + activeFilterCount) : null),
      h('div', { className: 'ptm-group' },
        h('div', { className: 'ptm-group-h' }, h(Icon, { name: 'server', size: 12 }), '按机器筛选', h('span', { className: 'ptm-group-s' }, '只显示相关工程')),
        projMachines.map((n) => h('button', { key: n.id, type: 'button', className: 'ptm-i' + (filters.machine === n.id ? ' on' : ''),
            onClick: () => setFilters((f) => Object.assign({}, f, { machine: f.machine === n.id ? null : n.id })) },
          h('span', { className: 'ptm-dot', style: { background: n.status === 'offline' ? 'var(--chrome-faint)' : 'var(--positive-visual)' } }),
          h('div', { className: 'ptm-mm' }, h('span', { className: 'ptm-l mono' }, n.host), h('span', { className: 'ptm-s' }, machineProjCount(n.id) + ' 个工程')),
          filters.machine === n.id ? h(Icon, { name: 'check', size: 14, style: { marginLeft: 'auto', color: 'var(--volo-400)' } }) : null))),
      h('div', { className: 'ptm-group' },
        h('div', { className: 'ptm-group-h' }, h(Icon, { name: 'filter', size: 12 }), '常用策略'),
        h('button', { type: 'button', className: 'ptm-i' + (filters.cfg === 'has' ? ' on' : ''), onClick: () => setCfgFilter('has') },
          h('span', { className: 'ptm-l' }, '仅已配置预跑'), filters.cfg === 'has' ? h(Icon, { name: 'check', size: 14, style: { marginLeft: 'auto', color: 'var(--volo-400)' } }) : null),
        h('button', { type: 'button', className: 'ptm-i' + (filters.cfg === 'none' ? ' on' : ''), onClick: () => setCfgFilter('none') },
          h('span', { className: 'ptm-l' }, '仅未配置'), filters.cfg === 'none' ? h(Icon, { name: 'check', size: 14, style: { marginLeft: 'auto', color: 'var(--volo-400)' } }) : null),
        h('button', { type: 'button', className: 'ptm-i' + (filters.warnOnly ? ' on' : ''), onClick: () => setFilters((f) => Object.assign({}, f, { warnOnly: !f.warnOnly })) },
          h('span', { className: 'ptm-l' }, '仅未全绿'), filters.warnOnly ? h(Icon, { name: 'check', size: 14, style: { marginLeft: 'auto', color: 'var(--volo-400)' } }) : null)));

    const toolBtn = (id, label, iconName, menu, badge) => h('div', { className: 'pak-tool', key: id },
      h('button', { type: 'button', className: 'pak-tool-ic' + (openMenu === id ? ' on' : ''), 'data-tip': label, 'aria-label': label,
          onClick: () => setOpenMenu((m) => (m === id ? null : id)) },
        h(Icon, { name: iconName, size: 15 }),
        badge ? h('span', { className: 'pak-tool-badge' }, badge) : null),
      openMenu === id ? menu : null);

    const listBar = sorted.length === 0 && !activeFilterCount && !q && !searchOpen ? null
      : h('div', { className: 'pak-list-bar' },
          h('button', { type: 'button', className: 'pak-selall' + (allSelected ? ' on' : someSelected ? ' part' : ''), onClick: toggleAll,
              title: allSelected ? '取消全选' : '选择全部可见工程' },
            h('span', { className: 'pak-selall-box' }, allSelected ? h(Icon, { name: 'check', size: 12 }) : someSelected ? h(Icon, { name: 'minus', size: 12 }) : null),
            h('span', { className: 'pak-selall-tx' }, allSelected ? '取消全选' : '全选'),
            h('span', { className: 'pak-selall-ct' }, visibleSelectedCount ? (visibleSelectedCount + ' / ' + sorted.length) : (sorted.length + ' 个工程'))),
          h('div', { className: 'pak-list-actions' },
            h('div', { className: 'pak-search-wrap', ref: searchRef },
              h('button', { type: 'button', className: 'pak-search-btn' + (q ? ' has-query' : ''),
                  'data-tip': '按工程名 / 路径过滤', 'aria-label': '搜索工程',
                  onClick: () => setSearchOpen((v) => !v) },
                h(Icon, { name: 'search', size: 15 }),
                q ? h('span', { className: 'pak-search-badge' }, matched.length) : null),
              searchOpen ? h('div', { className: 'pak-search-pop' },
                h(Icon, { name: 'search', size: 14 }),
                h('input', { ref: searchInRef, value: query, placeholder: '按工程名 / 路径过滤…', spellCheck: false, onChange: (e) => setQuery(e.target.value) }),
                q ? h('span', { className: 'pak-search-ct' }, '匹配 ' + matched.length + ' / ' + projs.length) : null,
                q ? h('button', { className: 'pak-search-clear', title: '清除搜索', onClick: () => setQuery('') }, h(Icon, { name: 'x', size: 13 })) : null) : null),
            h('div', { className: 'pak-list-tools' + (toolsOpen ? ' open' : ''), ref: toolsRef },
              toolsOpen ? h(React.Fragment, null,
                toolBtn('view', '显示方式', VIEW_OPTS.find((o) => o.id === view).icon, viewMenu),
                toolBtn('sort', '排序方式', 'sort', sortMenu),
                toolBtn('filter', '筛选策略', 'filter', filterMenu, activeFilterCount || null)) : null,
              h('button', { type: 'button', className: 'pak-tools-toggle' + (toolsOpen ? ' on' : '') + (activeFilterCount ? ' has-filter' : ''),
                  'data-tip': toolsOpen ? '收起' : '显示 · 排序 · 筛选', 'aria-label': toolsOpen ? '收起工具' : '显示 · 排序 · 筛选',
                  onClick: () => { setToolsOpen((v) => !v); setOpenMenu(null); } },
                h(Icon, { name: toolsOpen ? 'x' : 'sliders', size: 16 }),
                !toolsOpen && activeFilterCount ? h('span', { className: 'pak-tools-badge' }, activeFilterCount) : null))),
          view === 'flat' ? h('div', { className: 'pak-zoom pak-zoom--bar' },
              h('span', { className: 'pak-zoom-ic sm' }, h(Icon, { name: 'grid', size: 12 })),
              h('input', { type: 'range', className: 'pak-zoom-range', min: 118, max: 220, step: 1, value: tileScale, 'aria-label': '显示比例', onChange: (e) => setTileScale(+e.target.value) }),
              h('span', { className: 'pak-zoom-ic lg' }, h(Icon, { name: 'grid', size: 17 }))) : null);

    /* 批量预跑的实际可跑组合——勾选的工程里没配置目标节点的（"待配置"）贡献 0 个 pair；
       只有存在真正可跑的组合时按钮才可点，避免点了以后 startRun 因 pairs 为空静默 return、
       选择却已被清空的"点了没反应"体验。mode 传 null 让 startRun 按各工程自己的 offscreen
       设置分别决定 headless，不强行把整批工程都压成同一种启动形态。 */
    const batchPairs = [];
    sel.forEach((id) => { const st = settingsOf(s, id); cfgTargetIds(st).forEach((mid) => batchPairs.push({ projId: id, machineId: mid })); });

    return h('section', { className: 'pak2-col pak2-right' },
      h('div', { className: 'pak2-h' },
        h('span', { className: 'pak2-ico' }, h(Icon, { name: 'search', size: 15 })),
        h('div', { style: { minWidth: 0 } },
          h('div', { className: 'pak2-tt' }, '工程扫描与预跑'),
          h('div', { className: 'pak2-sub' }, 'discover_projects · 点工程设定预跑 · 预跑验证后结果进入左栏')),
        h('div', { className: 'right' }, sel.length ? h('span', { className: 'toolchip' }, h(Icon, { name: 'check', size: 14 }), '已选 ' + sel.length) : null)),
      h('div', { className: 'pak2-b' },
        h('div', { className: 'pak-controls' },
          h('div', { className: 'pak-ctl scan' }, h('label', null, '扫描范围'),
            h(Selector, { kpre: '范围', value: scope, options: scopeOpts(), width: 176, align: 'left', onChange: setScope })),
          h('div', { className: 'pak-ctl' }, h('label', { style: { visibility: 'hidden' } }, '扫描'),
            h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: scanning ? 'sync' : 'search', size: 14 }), isDisabled: scanning, onPress: doScan }, scanning ? '扫描中…' : '扫描'))),
        h('div', { className: 'pak-roots' },
          h('div', { className: 'pak-roots-h' }, h('span', { className: 't' }, '搜索根目录'),
            h('span', { className: 'dim' }, '可多个 · 点击地址栏逐级选择盘符 / 文件夹')),
          h('div', { className: 'pak-root-rows' },
            roots.map((r) => h('div', { key: r.id, className: 'root-row' + (acOpen && acField === r.id ? ' ac-active' : '') },
              h('span', { className: 'root-row-ic' }, h(Icon, { name: 'folder', size: 13 })),
              h('input', { className: 'root-in', value: r.val, spellCheck: false, autoComplete: 'off', placeholder: '输入工程根目录…',
                onChange: (e) => { updateRoot(r.id, e.target.value); openAc(r.id); }, onFocus: () => openAc(r.id), onClick: () => openAc(r.id), onKeyDown: makeAcKey(r.id) }),
              h('button', { className: 'root-row-fav' + (isFav(r.val) ? ' on' : ''), type: 'button',
                title: isFav(r.val) ? '已设为常用 · 点击取消' : '设为常用', disabled: !normRoot(r.val), onClick: () => toggleFav(r.val) }, h(Icon, { name: 'star', size: 13 })),
              h('button', { className: 'root-row-x', title: '移除', onClick: () => removeRoot(r.id) }, h(Icon, { name: 'x', size: 13 })),
              acOpen && acField === r.id ? renderAc() : null))),
          h('div', { className: 'root-add' + (acOpen && acField === 'add' ? ' open' : '') },
            h(Icon, { name: 'plus', size: 13 }),
            h('input', { value: rootDraft, spellCheck: false, autoComplete: 'off', placeholder: '点击选择盘符，或直接输入根目录…',
              onChange: (e) => { setRootDraft(e.target.value); openAc('add'); }, onFocus: () => openAc('add'), onClick: () => openAc('add'), onKeyDown: makeAcKey('add') }),
            h('button', { className: 'root-add-btn', disabled: !rootDraft.trim(), onClick: commitDraft }, '添加'),
            acOpen && acField === 'add' ? renderAc() : null),
          favs.length ? h('div', { className: 'pak-favs' },
            h('span', { className: 'pf-label' }, h(Icon, { name: 'star', size: 12 }), '常用地址'),
            h('div', { className: 'pf-chips' }, favs.map((f) => h('div', { key: f, className: 'pf-chip' + (rootVals.includes(f) ? ' added' : '') },
              h('button', { className: 'pf-chip-use', type: 'button', disabled: rootVals.includes(f),
                title: rootVals.includes(f) ? '已在搜索根目录中' : '点击加入搜索根目录', onClick: () => addRoot(f) },
                h(Icon, { name: rootVals.includes(f) ? 'check' : 'folder', size: 11 }), f),
              h('button', { className: 'pf-chip-x', type: 'button', title: '从常用中移除', onClick: () => removeFav(f) }, h(Icon, { name: 'x', size: 11 })))))) : null),
        h('div', { className: 'pak-scan-meta' }, h(Icon, { name: 'check', size: 12 }),
          lastScan ? ('上次扫描 ' + lastScan.toLocaleTimeString().slice(0, 5) + ' · 已发现 ' + projs.length + ' 个工程') : ('已发现 ' + projs.length + ' 个工程')),
        listBar,
        listBody),
      h('div', { className: 'pak2-foot' },
        h('span', { className: 'pak-genbar-info' }, h(Icon, { name: 'info', size: 12 }),
          sel.length ? h(React.Fragment, null, '已选 ', h('b', null, sel.length), ' 个工程 · 按各自设置的节点预跑并验证，跑完后显示在左栏')
            : h(React.Fragment, null, '点工程打开设置 · 或勾选后批量预跑验证')),
        h('span', { className: 'pak-genbar-spacer' }),
        h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'bolt', size: 14 }), isDisabled: batchPairs.length === 0 || !!run,
          onPress: () => { onPrerun(batchPairs, null); setSel([]); } }, '预跑并验证' + (sel.length ? '（' + sel.length + '）' : ''))));
  }

  /* =========================================================================
     左栏 · 预跑就绪状态（只显示已预跑并验证过的工程 · hero + 节点色条 + 工程卡片/节点药丸）
     ========================================================================= */
  function StatusPanel({ s, run, onCancel, openSettings, onPrerun }) {
    const per = shownProjects(s).map((p) => {
      const settings = settingsOf(s, p.id);
      const ids = cfgTargetIds(settings);
      const nodes = ids.map((mid) => PNODES().find((n) => n.machineId === mid)).filter((n) => n && n.status !== 'offline');
      const states = nodes.map((n) => ({ n, g: glOf(s, p.id, n) }));
      const ready = states.filter((x) => x.g.state === 'ready').length;
      const pend = states.filter((x) => x.g.state !== 'ready');
      const allReady = nodes.length > 0 && ready === nodes.length;
      /* r.__proj 来自 Object.keys(s.psoRunsByProject)，恒为 string；p.id（ProjectVM.id）是
         number——严格相等永远不命中，历史记录会全数落空，卡片一律显示"尚未预跑"。 */
      const lastRun = histAll(s).find((r) => String(r.__proj) === String(p.id)) || null;
      return { p, settings, nodes, states, ready, tot: nodes.length, pend, allReady,
        last: lastRun ? fmtWhen(lastRun.started_at) : null, configured: cfgComplete(settings) };
    });
    const totReady = per.reduce((a, x) => a + x.ready, 0);
    const totNodes = per.reduce((a, x) => a + x.tot, 0);
    const allGreen = per.length > 0 && per.every((x) => x.allReady);
    const pendNodes = totNodes - totReady;
    const bd = { ready: 0, stale: 0, invalid: 0, never: 0 };
    per.forEach((x) => x.states.forEach((st) => { if (bd[st.g.state] != null) bd[st.g.state] += 1; }));
    const segs = ['ready', 'stale', 'invalid', 'never'].map((k) => ({ k, v: bd[k] })).filter((x) => x.v > 0);

    const prerunProj = (x) => onPrerun(x.nodes.map((n) => ({ projId: x.p.id, machineId: n.machineId })), (x.settings && x.settings.offscreen) !== false ? '后台' : '窗口');

    const nodePill = (x, st) => {
      const g = st.g; const m = GLS[g.state] || GLS.never;
      const can = g.state === 'stale' || g.state === 'invalid' || g.state === 'never';
      const tail = st.n.host.replace(/^RENDER-?/i, '');
      return h('button', { key: st.n.id, className: 'psL2-node glc--' + m.cell + (can ? ' can' : ''),
          title: st.n.host + ' · ' + m.label + (g.state === 'ready' ? ' · 验证段实测 0 卡顿' : g.reason ? ' · ' + g.reason : '') + (can ? '（点击复验）' : ''),
          onClick: can && !run ? () => revalidate(s, [{ projId: x.p.id, node: st.n }], {}).catch((err) => s.pushLog({ lv: 'err', cat: 'pso', ch: 'ssh', msg: '复验失败 · ' + (err && err.message ? err.message : err) })) : undefined },
        h('span', { className: 'psL2-node-dot' }),
        h('span', { className: 'psL2-node-tx mono' }, tail),
        g.state === 'ready' ? h(Icon, { name: 'check', size: 10 }) : can ? h(Icon, { name: 'sync', size: 10 }) : null);
    };

    return h('section', { className: 'pak2-col pak2-left pso-status' },
      h('div', { className: 'pak2-h' },
        h('span', { className: 'pak2-ico' }, h(Icon, { name: 'film', size: 15 })),
        h('div', { style: { minWidth: 0 } },
          h('div', { className: 'pak2-tt' }, '预跑就绪状态'),
          h('div', { className: 'pak2-sub' }, '仅显示已预跑并验证过的工程 · 绿灯 = 实测 0 卡顿的跑完结果')),
        h('div', { className: 'right' },
          run ? h('span', { className: 'toolchip pso-running' }, h('span', { className: 'spin' }, h(Icon, { name: 'sync', size: 13 })), '预跑中') : null)),
      h('div', { className: 'pak2-b' },
        /* 运行态卡片独立于"是否已有预跑验证过的工程"渲染——首次给全新工程预跑时 per 还是空
           （shownProjects 要等实测结果落地才会收进该工程），若把它塞进 per.length>0 分支，
           这一批唯一的运行中反馈就是 header 里一个不可操作的"预跑中"徽标，主视图完全看不到
           进度、也点不到取消。 */
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
                '本次预跑未配置遍历引擎地图路径（点「设置」补全），为固定机位——无收敛曲线，以验证段 hitch 结果为准。')) : null,

        per.length === 0
          ? h('div', { className: 'psL2-empty' },
              h('div', { className: 'psL2-empty-ico' }, h(Icon, { name: 'film', size: 26 })),
              h('div', { className: 'psL2-empty-t' }, '尚无已预跑验证的工程'),
              h('div', { className: 'psL2-empty-d' }, '到右栏选择本次拍摄要用的工程并「预跑并验证」，跑完并验证过的工程结果会显示在这里。'),
              h('div', { className: 'psL2-empty-hint' }, h(Icon, { name: 'arrowr', size: 13 }), '右栏「工程扫描与预跑」'))
          : h(React.Fragment, null,
              h('div', { className: 'psL2-hero ' + (allGreen ? 'is-ready' : 'is-warn') },
                h('span', { className: 'psL2-hero-ico' }, h(Icon, { name: allGreen ? 'check' : 'alert', size: 25 })),
                h('div', { className: 'psL2-hero-main' },
                  h('div', { className: 'psL2-hero-tt' }, allGreen ? '上场就绪 · 无卡顿' : (pendNodes + ' 个节点待预跑 / 复验')),
                  h('div', { className: 'psL2-hero-sub' }, allGreen
                    ? per.length + ' 个关联工程预跑完成，各节点验证跑实测 0 卡顿'
                    : '绿灯需实测 0 卡顿 —— 处理下方待办节点后方可上场')),
                h('div', { className: 'psL2-hero-metric' },
                  h('span', { className: 'psL2-hero-frac' }, h('span', { className: 'mono big' }, totReady), h('span', { className: 'psL2-hero-den mono' }, '/' + totNodes)),
                  h('span', { className: 'psL2-hero-metric-lbl' }, '节点就绪'))),
              h('div', { className: 'psL2-bar' }, segs.map((x) => h('span', { key: x.k, className: 'psL2-seg glc--' + GLS[x.k].cell, style: { flexGrow: x.v }, title: GLS[x.k].label + ' · ' + x.v }))),
              h('div', { className: 'psL2-legend' }, [['ready', '就绪·无卡顿'], ['stale', '需复验'], ['invalid', '已失效'], ['never', '未预跑']].map(([k, lbl]) => bd[k]
                ? h('span', { key: k, className: 'psL2-lg' }, h('span', { className: 'psL2-lg-dot glc--' + GLS[k].cell }), lbl, h('span', { className: 'psL2-lg-ct mono' }, bd[k])) : null)),

              h('div', { className: 'psL2-projs' }, per.map((x) => h('div', { key: x.p.id, className: 'psL2-proj' + (x.allReady ? ' ready' : '') },
                h('div', { className: 'psL2-proj-head' },
                  h('span', { className: 'psL2-proj-thumb' }, h(Icon, { name: 'film', size: 15 })),
                  h('div', { className: 'psL2-proj-meta' },
                    h('div', { className: 'psL2-proj-name' }, x.p.name),
                    h('div', { className: 'psL2-proj-sub mono' }, 'UE ' + x.p.ue + ' · ' + x.p.uproject)),
                  x.allReady
                    ? h('span', { className: 'spill spill--positive psL2-proj-st' }, h(Icon, { name: 'check', size: 12 }), '就绪 · 无卡顿')
                    : h('span', { className: 'spill spill--' + (x.ready === 0 ? 'negative' : 'notice') + ' psL2-proj-st' }, h(Icon, { name: 'alert', size: 12 }), x.pend.length + ' 台待处理')),
                x.states.length ? h('div', { className: 'psL2-nodes' }, x.states.map((st) => nodePill(x, st)))
                  : h('div', { className: 'psL2-noconf' }, h(Icon, { name: 'alert', size: 12 }), '尚未配置预跑节点 · 点「设置」补全'),
                h('div', { className: 'psL2-proj-foot' },
                  h('span', { className: 'psL2-proj-last' }, h(Icon, { name: x.allReady ? 'check' : 'clock', size: 11 }),
                    x.last ? ('最近预跑 ' + x.last) : '尚未预跑', x.allReady ? ' · 实测 0 卡顿' : ''),
                  h('div', { className: 'psL2-proj-acts' },
                    h('button', { className: 'mini-btn', title: '打开工程预跑设置', onClick: () => openSettings(x.p) }, h(Icon, { name: 'sliders', size: 12 }), '设置'),
                    h('button', { className: 'mini-btn psL2-go' + (x.allReady ? ' ghost' : ''), disabled: !x.configured || !!run, onClick: () => prerunProj(x) },
                      h(Icon, { name: x.allReady ? 'sync' : 'bolt', size: 12 }), x.allReady ? '复跑验证' : '预跑并验证')))))))));
  }

  /* =========================================================================
     合并页 · 顶栏 + 双栏
     ========================================================================= */
  function PsoPage({ s }) {
    const [run, setRun] = useState(null);
    const runRef = useRef(null); runRef.current = run;
    const jobsRef = useRef([]); /* 本次批量启动收集的 {jobId, parentJobId} 供取消/事件过滤 */
    const tickRef = useRef(null);
    const [, forceTick] = useState(0);
    const [sel, setSel] = useState([]); /* 右栏批量预跑选择 */

    useEffect(() => { refreshAll(s); }, []); /* eslint-disable-line react-hooks/exhaustive-deps */

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

    /* pairs: [{projId, machineId}]（同一批可能覆盖多个工程，各自节点集合不同，逐工程分组
       fan-out，不能对全部 pairs 做工程×节点交叉积——否则会把 A 工程的节点错误地也发给 B 工程）。
       mode 是 '后台' | '窗口' | null：非空时对本批全部工程强制该启动形态（PrerunConfirm 里
       用户显式选的场景，蓄意覆盖）；传 null 表示不强制，按各工程自己保存的 offscreen 设置分别
       决定 headless（ScanPanel 批量按钮场景——不该把已经手动关掉 headless 的工程悄悄压成后台）。 */
    const startRun = (pairs, mode) => {
      if (run || !pairs.length) return;
      const projIds = Array.from(new Set(pairs.map((x) => x.projId)));
      const anyTraversal = projIds.some((pid) => { const st = settingsOf(s, pid); return st && st.map_path && st.map_path.trim(); });
      const batchId = 'b' + Date.now();
      jobsRef.current = [];
      setRun({ __batchId: batchId, proj: projIds, mode: mode || '按各工程设置', traversal: anyTraversal,
        nodes: pairs.map(({ projId, machineId }) => {
          const n = PNODES().find((x) => x.machineId === machineId);
          return { projId, id: n ? n.id : String(machineId), machineId, stage: 0, startedAt: Date.now(),
            limit: (settingsOf(s, projId) || {}).max_minutes || 20, done: false };
        }),
        hitch: [0], growth: [0], converged: { hitch: false, growth: false } });
      const byProj = {};
      pairs.forEach(({ projId, machineId }) => { (byProj[projId] = byProj[projId] || []).push(machineId); });
      Promise.allSettled(Object.keys(byProj).map((pid) => {
        const p = PROJ(pid); if (!p) return Promise.reject(new Error('工程不存在'));
        const nodes = byProj[pid].map((mid) => PNODES().find((n) => n.machineId === mid)).filter(Boolean);
        const headless = mode == null ? (settingsOf(s, pid) || {}).offscreen !== false : mode !== '窗口';
        return launchWarmupOne(s, p, nodes, { headless }, jobsRef);
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
    const openSettings = (p) => s.setModal({ wide: true, render: ({ s: ss, close }) => h(ProjectSettingsDialog, { s: ss, projId: p.id, close, onPrerun: startRun }) });

    /* canvas-head 就绪计数：与左栏 hero 同一口径（仅已预跑验证过的关联工程 × 其配置的在线节点），
       不是全量工程×全量节点——两处数字必须一致，否则用户会疑惑「顶栏说就绪 3/5，左栏却显示别的」。 */
    const shown = shownProjects(s);
    let aOk = 0, aTot = 0;
    shown.forEach((p) => {
      cfgTargetIds(settingsOf(s, p.id)).forEach((mid) => {
        const n = PNODES().find((x) => x.machineId === mid);
        if (!n || n.status === 'offline') return;
        aTot += 1; if (glOf(s, p.id, n).state === 'ready') aOk += 1;
      });
    });
    const aReady = aTot > 0 && aOk === aTot;

    return h('div', { className: 'res pso-merged' },
      h('div', { className: 'canvas-head' },
        h('span', { className: 't' }, 'DDC · PSO 缓存'),
        h('div', { className: 'right' },
          h('span', { className: 'toolchip' + (aReady ? ' pso-running' : '') }, h(Icon, { name: aReady ? 'check' : 'film', size: 14 }), aTot ? ('就绪 ' + aOk + ' / ' + aTot) : '尚无预跑结果'),
          run ? h('span', { className: 'toolchip pso-running' }, h('span', { className: 'spin' }, h(Icon, { name: 'sync', size: 13 })), '预跑中') : null,
          h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'bolt', size: 15 }), isDisabled: !!run, onPress: openConfirm }, '预跑并验证'))),
      h('div', { className: 'pak2 pso2' },
        h(StatusPanel, { s, run, onCancel: cancelRun, openSettings, onPrerun: startRun }),
        h(ScanPanel, { s, sel, setSel, openSettings, onPrerun: startRun, run })));
  }

  /* =================== 检查器（合并页不再使用右侧检查器，同 DDC PAK 页的处理）=================== */
  function Inspector() {
    return h('div', { className: 'insp-empty' },
      h('div', { className: 'ph' }, h(Icon, { name: 'panel', size: 30 })),
      h('div', null,
        h('div', { style: { color: 'var(--chrome-dim)', fontWeight: 600, marginBottom: 4 } }, 'PSO 缓存已整合到主视图'),
        '预跑就绪状态与工程扫描 / 预跑设置都在左右双栏中就地完成，无需检查器'));
  }

  window.VOLO_CACHE_PSO_DASH = {
    center: (s) => h(PsoPage, { s }),
    inspector: (s) => h(Inspector, { s }),
  };
})();
