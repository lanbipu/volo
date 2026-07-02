// @ts-nocheck
/* Volo — Cache · DDC 管理 (§6) — 折叠子菜单分视图：ZenServer / 文件系统 DDC / DDC PAK / PSO.
   1:1 port of the Claude Design handoff `src/cache_ddc.jsx`（检查器重构版），接真实后端。

   ZenServer / 文件系统 DDC 仍是整页视图；DDC PAK 与 PSO 缓存改为
   「主视图(选工程) + 右侧检查器(操作)」的细节显示模式：
   - 主视图(center)只负责发现 / 选择工程（PAK 多选、PSO 单选），选择提到 shell（s.pakSel / s.psoSel）；
   - 选中工程、生成 / 校验 / 收集 / 分发等操作，全部在右侧检查器(inspector)里就地展开，不再弹滑窗。
   center 走 ddc(s)，inspector 走 detail(s)；两栏读同一份 shell 选择状态。 */
import * as React from "react";
import "../ds";
import "./cache";
import { deleteShare as deleteShareCmd, teardownShare, discoverProjects, createShare,
  generateDdcPak, verifyPakOutput,
  distributeDdcPak,
  startPsoWarmup, listPsoWarmupRuns, fixPsoCvars, verifyPsoPrecaching,
  setMachineEnvVar, getMachineEnvVar, createLocalCache,
  prepareManagedShareClients, unprepareManagedShareClients,
  prepareOpenShareClients, unprepareOpenShareClients,
  setMachineBackendField, removeMachineBackendField } from "../api/commands";

(function () {
  const { Button } = window.Spectrum2DesignSystem_b6d1b3;
  const { useState, useEffect, useRef } = React;
  const h = React.createElement;
  const CX = window.VOLO_CX;
  const Selector = window.Selector;

  /* 选生成/校验/收集的源机：检查器无源机选择器（按设计自动选源）。优先工程 primary，但 primary
     可能离线 → 回退到该工程任一在线机；都不可用返回 null（调用方据此给可见反馈）。 */
  const pickSrc = (p) => {
    if (!p) return null;
    const prim = CX.node(p.primary);
    if (prim && prim.status !== 'offline') return prim;
    return RENDER_NODES.find((n) => (p.machines || []).includes(n.id) && n.status !== 'offline') || prim || null;
  };
  /* 无可用源机时，派一个立即失败的任务给可见反馈，而不是静默 return（按钮点了像没反应）。 */
  const noSrcFail = (s, domain, action, p) =>
    s.runCmd({ domain, action, target: p.name, chan: 'ssh', note: domain + ' ' + action + ' · ' + p.name },
      () => Promise.reject(new Error('该工程没有可用的在线源机器')), {}).catch(() => {});

  const humanBytes = (b) => b == null ? '—'
    : b >= 1e9 ? (b / 1073741824).toFixed(1) + ' GB'
    : b >= 1e6 ? (b / 1048576).toFixed(0) + ' MB'
    : (b / 1024).toFixed(0) + ' KB';

  /* UeRunnerEvent reduce（generate_ddc_pak / start_pso_collection 共用进度流）.
     payload = {job_id, source_machine_id, project_id, event:UeRunnerEvent}，
     event 是 tag='kind' 的联合。pct 量纲不定（0..1 或 0..100），<=1 视为比例 *100。 */
  const ueLineLv = (pk) => pk && /error/i.test(pk) ? 'err' : pk && /warn/i.test(pk) ? 'warn' : 'info';
  const ueProgressReduce = (p, terminalOnCompleted) => {
    const e = p && p.event ? p.event : {};
    switch (e.kind) {
      case 'spawned':   return { pct: 8, log: { lv: 'info', msg: '已启动 · pid ' + e.pid } };
      case 'log_line':  return { log: { lv: ueLineLv(e.parsed_kind), msg: e.text } };
      case 'progress': {
        const pct = e.pct == null ? null : (e.pct <= 1 ? e.pct * 100 : e.pct);
        return { pct: terminalOnCompleted ? pct : (pct == null ? null : Math.min(96, pct)), log: e.label ? { lv: 'info', msg: e.label } : null };
      }
      case 'completed':
        return terminalOnCompleted
          ? { done: true, ok: e.exit_code === 0, exit: e.exit_code, log: { lv: e.exit_code === 0 ? 'ok' : 'err', msg: '退出码 ' + e.exit_code } }
          : { pct: 96, log: { lv: 'info', msg: 'UE 进程结束（退出码 ' + e.exit_code + '）· 汇总缓存…' } };
      case 'cancelled': return { done: true, ok: false, canceled: true, log: { lv: 'warn', msg: '已取消' } };
      case 'error':     return { done: true, ok: false, exit: 2, log: { lv: 'err', msg: e.message } };
      default:          return {};
    }
  };
  /* generate：ue-runner 'completed' 即终止；pak-verified 是次级校验事件（非终止）。
     注：pak-verified 在 completed 后才发，finalize 已同步 unlisten → 这行校验日志可能
     被吞（best-effort）；任务成败由 completed 的 exit_code 决定，用户可另点检查器「校验产物」。 */
  const genReduce = (ev, p) => ev === 'pak-verified'
    ? { log: { lv: p.verified ? 'ok' : 'warn', msg: '产物校验 ' + (p.verified ? '通过' : '未通过') + (p.output && p.output.path ? (' · ' + p.output.path) : '') } }
    : ueProgressReduce(p, true);
  /* pso warmup（fan-out）：kickoff 返回 {job_id(父), runs:[{machine_id,run_id,job_id}]}；
     事件 pso-warmup-progress 是各机 UeRunnerEvent 信封（带 machine_id / parent_job_id），
     真终态是每机一条 pso-warmup-finalized{status:'ok'|'cancelled'|'err', hitch_count}——
     数到 st.total 台终态即收尾；任一 err → 整体失败；无 err 但有 cancelled → 整体 canceled。
     log_line 只转发有 parsed_kind 的行（N 台机全量 UE 日志会淹没控制台流）。 */
  const warmupReduce = (hostOf, onNodeDone) => (ev, p, st) => {
    st.done = st.done || new Set();
    const host = hostOf(p && p.machine_id) || ('机器 ' + (p && p.machine_id));
    if (ev === 'pso-warmup-finalized') {
      st.done.add(p.machine_id);
      if (p.status === 'err') st.anyErr = true;
      if (p.status === 'cancelled') st.anyCancel = true;
      if (onNodeDone) { try { onNodeDone(); } catch (e) {} } /* 每台落定即刷新就绪矩阵 */
      const done = st.total != null && st.done.size >= st.total;
      return {
        pct: st.total ? (st.done.size / st.total * 100) : null,
        done,
        ok: done ? (!st.anyErr && !st.anyCancel) : undefined,
        canceled: done && !st.anyErr && !!st.anyCancel,
        exit: done && st.anyErr ? 2 : 0,
        log: p.status === 'ok'
          ? { lv: 'ok', msg: host + ' 预热验证完成 · hitch ' + (p.hitch_count == null ? '—' : p.hitch_count) }
          : p.status === 'cancelled'
            ? { lv: 'warn', msg: host + ' 已取消（未验证）' }
            : { lv: 'err', msg: host + ' 运行失败 · ' + (p.error_message || '') },
      };
    }
    const e = p && p.event ? p.event : {};
    switch (e.kind) {
      case 'spawned':  return { log: { lv: 'info', msg: host + ' 本机拉起 UE -game · pid ' + e.pid } };
      case 'log_line': return e.parsed_kind
        ? { log: { lv: e.parsed_kind === 'pso_hitch' ? 'warn' : ueLineLv(e.parsed_kind), msg: '[' + host + '] ' + e.text } }
        : {};
      case 'progress': return e.label ? { log: { lv: 'info', msg: '[' + host + '] ' + e.label } } : {};
      default:         return {}; /* 各机 completed/cancelled/error 由 finalized 事件收口 */
    }
  };

  /* 分发流（pak / pso-distribute-progress）共用：payload {…, event:BatchEvent}，
     BatchEvent {machine_id, status:'running'|'ok'|'err', message}。无「全部完成」哨兵事件
     → 数到 st.total（=plan 长度）个终态(ok|err)即收尾，期间任一 err 则整体失败。 */
  const batchReduce = (ev, p, st) => {
    const e = p && p.event ? p.event : {};
    st.terminal = st.terminal || new Set();
    const mid = e.machine_id;
    if (e.status === 'running') return { log: { lv: 'info', msg: '分发中 · 机器 ' + mid } };
    if (e.status === 'ok' || e.status === 'err') {
      st.terminal.add(mid);
      if (e.status === 'err') st.anyErr = true;
      const done = st.total != null && st.terminal.size >= st.total;
      const pct = st.total ? (st.terminal.size / st.total * 100) : null;
      return {
        pct, done,
        ok: done ? !st.anyErr : undefined,
        exit: done && st.anyErr ? 2 : 0,
        log: e.status === 'ok'
          ? { lv: 'ok', msg: '机器 ' + mid + ' 完成' }
          : { lv: 'err', msg: '机器 ' + mid + ' 失败 · ' + (e.message || '') },
      };
    }
    return {};
  };

  /* =================== 共享选项构造 =================== */
  const onlineNodes = () => RENDER_NODES.filter((n) => n.status !== 'offline');
  const scopeOpts = () => [{ id: 'all', label: '全部在线机' }]
    .concat(onlineNodes().map((n) => ({ id: n.id, label: n.host, sub: n.ip })));
  const resOpts = [{ id: '1920×1080', label: '1920 × 1080' }, { id: '2560×1440', label: '2560 × 1440' }, { id: '3840×2160', label: '3840 × 2160' }];
  const maxOpts = [{ id: '10', label: '10 分钟' }, { id: '20', label: '20 分钟' }, { id: '30', label: '30 分钟' }];

  /* =================== PSO · 上场就绪保障 helpers =================== */
  const READY_META = {
    ready:   { vis: 'positive',    icon: 'check' },
    hitch:   { vis: 'notice',      icon: 'alert' },
    never:   { vis: 'neutral',     icon: 'minus' },
    failed:  { vis: 'negative',    icon: 'x' },
    running: { vis: 'informative', icon: 'sync' },
  };
  const readyLabel = (r) => r.state === 'ready' ? '已就绪 · hitch 0'
    : r.state === 'hitch' ? ('有卡顿 · ' + r.hitches + ' 次')
    : r.state === 'failed' ? '运行失败'
    : r.state === 'running' ? '验证中' : '从未验证';
  const psoNodes = () => RENDER_NODES.filter((n) => n.roleKey === 'render');
  /* GPU 型号/驱动来自 GPU 一致性矩阵（DB 读，非实时 SSH）；NodeVM.gpu 列表态是占位。 */
  const gpuSigOf = (s, n) => {
    const cells = (s.gpuMatrix && s.gpuMatrix.cells) || [];
    const cell = cells.find((c) => c.machine_id === n.machineId);
    return (cell && cell.signature) || null;
  };
  const gpuText = (s, n) => {
    const sig = gpuSigOf(s, n);
    return sig ? (sig.model + (sig.driver ? ' · 驱动 ' + sig.driver : '')) : '—';
  };
  const majorityDriver = (s) => {
    const ct = {};
    psoNodes().forEach((n) => { const sig = gpuSigOf(s, n); if (sig && sig.driver) ct[sig.driver] = (ct[sig.driver] || 0) + 1; });
    return Object.keys(ct).sort((a, b) => ct[b] - ct[a])[0] || null;
  };
  /* SQLite CURRENT_TIMESTAMP 是 UTC「YYYY-MM-DD HH:MM:SS」→ 本地「MM-DD HH:MM」 */
  const fmtRunTime = (ts) => {
    if (!ts) return '—';
    const d = new Date(String(ts).replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return String(ts);
    const p = (x) => String(x).padStart(2, '0');
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  };
  const fmtDur = (secs) => secs == null ? '—' : secs >= 60 ? (Math.round(secs / 60) + ' 分钟') : (secs + ' 秒');
  /* 就绪状态派生：有 running 行 → 验证中；否则取最近一条非 cancelled 的 run
     （ok+hitch0=绿 / ok+hitch>0=黄 / err=红），一条都没有 = 从未验证。 */
  const readinessOf = (runs, machineId) => {
    const mine = (runs || []).filter((r) => r.machine_id === machineId);
    const running = mine.find((r) => r.status === 'running');
    if (running) return { state: 'running', verified: fmtRunTime(running.started_at) };
    const last = mine.find((r) => r.status !== 'cancelled'); /* list 按 started_at 倒序 */
    if (!last) return { state: 'never' };
    if (last.status === 'err') return { state: 'failed', verified: fmtRunTime(last.started_at), err: last.error_message };
    const hitches = last.hitch_count == null ? 0 : last.hitch_count;
    return hitches > 0
      ? { state: 'hitch', verified: fmtRunTime(last.started_at), hitches }
      : { state: 'ready', verified: fmtRunTime(last.started_at), hitches: 0 };
  };
  /* 长任务回填防串台：launchWarmup 捕获的 s 是启动时快照，切走工程后 s.psoSel 是旧值——
     reload 必须读「当前选中工程」的活值，否则 A 的 warmup 落定会覆盖 B 的矩阵/历史
     （旧实现用 projRef 防的就是这个）。PsoMaster/PsoDetail 每次渲染刷新。 */
  let psoSelLive = null;
  /* 运行记录加载（list_pso_warmup_runs）——主视图矩阵与检查器历史共读 s.psoRuns。
     失败保留旧值不闪空；未选工程清空。 */
  const loadWarmupRuns = (s, pid) => {
    if (pid == null) { s.setPsoRuns([]); return; }
    listPsoWarmupRuns(Number(pid), null).then(
      (rs) => s.setPsoRuns(Array.isArray(rs) ? rs : []),
      () => {});
  };
  /* 预热验证启动（共用：确认门批量 / 矩阵行内复跑）。max_minutes>=1 后端硬校验。 */
  const launchWarmup = (s, p, nodes, resStr, maxStr) => {
    const parts = String(resStr).split('×');
    const rw = Number(parts[0]) || 1920, rh = Number(parts[1]) || 1080;
    const mm = Math.max(1, parseInt(maxStr, 10) || 20);
    const hostOf = (mid) => { const n = RENDER_NODES.find((x) => x.machineId === mid); return n ? n.host : null; };
    const reload = () => loadWarmupRuns(s, psoSelLive);
    return s.runStreamingCmd(
      { domain: 'pso', action: 'warmup', target: p.name + ' · ' + nodes.length + ' 台', chan: 'ssh',
        note: '预热验证 · ' + p.name + '（长任务 · 可在任务抽屉取消）' },
      () => startPsoWarmup({ project_id: Number(p.id), target_machine_ids: nodes.map((n) => n.machineId),
        resolution_w: rw, resolution_h: rh, max_minutes: mm, ue_version: null }),
      { mode: 'event', events: ['pso-warmup-progress', 'pso-warmup-finalized'],
        jobIdOf: (r) => r.job_id,
        isMine: (pp, jid) => pp && pp.parent_job_id === jid,
        total: (r) => (r.runs || []).length,
        cancellable: true, cancelIds: (r) => (r.runs || []).map((x) => x.job_id),
        reduce: warmupReduce(hostOf, reload),
        timeoutMs: (mm + 10) * 60 * 1000,
        onDone: () => reload() })
      .then(() => reload(), () => {}); /* kickoff 落地即刷一次：矩阵立刻显示「验证中」 */
  };
  /* 运行预热验证 —— 多机操作，走确认门（核对节点清单后执行；长任务进度在任务抽屉） */
  const runWarmup = (s, p, nodes, resStr, maxStr) => {
    if (!nodes.length) return;
    const mm = Math.max(1, parseInt(maxStr, 10) || 20);
    CX.openModalPreview(s, {
      title: '运行预热验证 · ' + p.name, icon: 'bolt', cli: 'pso warmup', destructive: false, channel: 'ssh',
      confirmLabel: '核对无误 · 运行（' + nodes.length + ' 台）',
      liveProgress: false, /* 确认即关：进度在任务抽屉 / 控制台 NDJSON 流 */
      steps: [
        '在 ' + nodes.length + ' 台节点本机拉起 UE -game，按 ' + resStr + ' 遍历场景（每台上限 ' + mm + ' 分钟）',
        '填充各节点本机驱动缓存，实时统计 PSO 卡顿（hitch）次数',
        '回传每台节点的 hitch 统计，刷新节点就绪矩阵与运行历史'],
      simpleScope: nodes.map((n) => ({ host: n.host, ip: n.ip, msg: gpuText(s, n) })),
      run: () => launchWarmup(s, p, nodes, resStr, maxStr),
    });
  };
  /* 复跑验证 —— 单机直接执行（不走确认门） */
  const rerunNode = (s, p, n) => launchWarmup(s, p, [n], '1920×1080', '10');
  /* 查看日志 —— 跳到控制台流并按主机过滤 */
  const seeNodeLog = (s, host) => { s.setConTab && s.setConTab('stream'); s.setLogFilter('all'); s.setLogSearch(host); s.setLogOpen(true); };

  /* three-channel gate (色+图标+文字)：DDC 视图都建立在真实机器 id 上，后端读取路径
     未就绪时不渲染 mock 形状的 body（与 Overview gate 一致）。仅用于 master(center) 视图。 */
  function gate(s) {
    if (s.cacheError) return h('div', { className: 'res ddc' }, h('div', { className: 'ddc-body' },
      h('div', { className: 'gen-empty' },
        h('span', { className: 's-negative', style: { display: 'flex' } }, h(Icon, { name: 'alert', size: 22 })),
        h('span', null, '加载集群数据失败 · ' + s.cacheError),
        h(Button, { variant: 'secondary', size: 'M', icon: h(Icon, { name: 'sync', size: 14 }), onPress: s.reloadCache }, '重试'))));
    if (s.cacheLoading) return h('div', { className: 'res ddc' }, h('div', { className: 'ddc-body' },
      h('div', { className: 'gen-empty' },
        h('span', { className: 's-informative', style: { display: 'flex' } }, h('span', { className: 'spin' }, h(Icon, { name: 'sync', size: 20 }))),
        h('span', null, '正在加载集群数据…'))));
    if (!RENDER_NODES.length) return h('div', { className: 'res ddc' }, h('div', { className: 'ddc-body' },
      h('div', { className: 'gen-empty' }, h(Icon, { name: 'node', size: 22 }),
        h('span', null, '集群里还没有机器 — 先在「集群总览」扫描添加机器，再配置 DDC'))));
    return null;
  }

  /* =================== 真实动作（模块级，接 s）=================== */
  /* discover_projects：远程扫各机 .uproject（只发现不写盘）。命令只收单台 machineId，
     scope='all' 时对全部在线机 fan-out（allSettled 容部分失败）；rootsStr 分号串 split；
     发现写库后 reloadCache 刷新 window.UE_PROJECTS。 */
  const runDiscover = (s, scope, rootsStr) => {
    const roots = (rootsStr || '').split(';').map((r) => r.trim()).filter(Boolean);
    if (!roots.length) return;
    const targets = scope === 'all'
      ? RENDER_NODES.filter((n) => n.status !== 'offline').map((n) => n.machineId)
      : [CX.node(scope) ? CX.node(scope).machineId : null].filter((x) => x != null);
    if (!targets.length) return;
    const tgtLabel = scope === 'all' ? targets.length + ' 台在线机' : (CX.node(scope) || {}).host;
    s.runCmd({ domain: 'project', action: 'discover', target: tgtLabel, chan: 'ssh', note: '远程扫描 UE 工程（.uproject）' },
      () => Promise.allSettled(targets.map((mid) => discoverProjects(mid, roots, null))).then((rs) => {
        const ok = rs.filter((r) => r.status === 'fulfilled');
        if (!ok.length) throw new Error('全部目标扫描失败');
        const found = ok.reduce((a, r) => a + (Array.isArray(r.value) ? r.value.length : 0), 0);
        return { found, failed: rs.length - ok.length };
      }),
      { okMsg: (r) => '发现 ' + r.found + ' 个工程位置' + (r.failed ? ('（' + r.failed + ' 台失败）') : '') })
      .then(() => s.reloadCache(), () => {});
  };

  /* generate_ddc_pak（流式）：源机取工程 primary（检查器无 src 选择器）；invoke 的
     ExecutionLocation='remote' 是执行位置（远端源机 vs 操作员本机），与工程的缓存路由（zen/legacy_pak）
     无关——任意路由都直接生成 PAK，不再需要先切工程后端；ue_version null；
     ue-runner-progress 'completed' 即终止。 */
  const genPak = (s, p) => {
    const src = pickSrc(p);
    if (!src) { noSrcFail(s, 'ddc', 'generate', p); return; } /* 无可用在线源机：可见失败而非静默 */
    s.runStreamingCmd(
      { domain: 'ddc', action: 'generate', target: p.name, chan: 'ssh', note: '生成 DDC PAK · ' + p.name + '（长任务）· 源 ' + src.host },
      () => generateDdcPak('remote', Number(p.id), src.machineId, null, null, null, null),
      { mode: 'event', events: ['ue-runner-progress', 'pak-verified'], jobIdOf: (r) => r.job_id, reduce: genReduce, timeoutMs: 45 * 60 * 1000 });
  };

  /* verify_pak_output：返回 PakOutput{path,size_bytes}，产物不存在=后端抛 OperationFailed
     → .then(ok, fail) 把成功/失败映射成 {found,...}。源机取工程 primary。 */
  const verifyPak = (s, p) => {
    const src = pickSrc(p);
    if (!src) return Promise.resolve({ found: false });
    return s.runCmd({ domain: 'ddc', action: 'verify', target: p.name, chan: 'ssh', note: '校验 DDC PAK 产物 · ' + p.name },
      () => verifyPakOutput(src.machineId, Number(p.id), null),
      { okMsg: (r) => '找到 DDC.ddp · ' + r.path + ' · ' + humanBytes(r.size_bytes) })
      .then(
        (r) => ({ found: true, path: r.path, size: humanBytes(r.size_bytes), name: 'DDC_' + p.name, srcId: src.machineId }),
        () => ({ found: false }));
  };

  /* 真实分发（流式，仅 DDC PAK）：art.srcId(源机 machineId)+art.projId；目标机来自确认门里
     编辑后的选择（排除源机、转 numeric machineId）。PSO 分发已随「上场就绪保障」重设计下线
     ——未 cook 的 -game 不消费分发过去的 .upipelinecache（就绪靠各节点本机预热验证）。 */
  const distribute = (s, art) => {
    const srcId = art.srcId;
    if (srcId == null || art.projId == null) return;
    const scopeIds = RENDER_NODES.filter((n) => n.status !== 'offline' && n.roleKey === 'render').map((n) => n.id);
    CX.openPreview(s, {
      title: '分发 · ' + art.name, icon: 'download', cli: 'ddc distribute', destructive: false, channel: 'ssh',
      steps: ['把这份缓存包复制分发到选中的渲染机',
        '只传缺少的部分，已有的自动跳过',
        '逐台显示成功 / 失败'],
      scope: scopeIds,
      onConfirm: (sel) => {
        const targets = (sel || []).map((id) => (CX.node(id) || {}).machineId).filter((x) => x != null && x !== srcId);
        if (!targets.length) return;
        s.runStreamingCmd(
          { domain: 'ddc', action: 'distribute', target: art.name, chan: 'ssh', note: '分发 · ' + art.name + ' → ' + targets.length + ' 台' },
          () => distributeDdcPak(srcId, Number(art.projId), targets, null, null, null),
          { mode: 'event', events: ['pak-distribute-progress'], jobIdOf: (r) => r.job_id, total: (r) => (r.plan || []).length, reduce: batchReduce,
            timeoutMs: 30 * 60 * 1000 });  /* 空闲超时兜底：单台拷贝间隔超 30 分钟无任何 batch 事件才判超时 */
      },
    });
  };

  /* =================== 主视图共用工程行（master list）=================== */
  function projRow(p, selected, onClick) {
    return h('div', { key: p.id, className: 'proj-row' + (selected ? ' on' : ''), onClick: () => onClick(p) },
      h('span', { className: 'proj-mck' + (selected ? ' on' : '') }, selected ? h(Icon, { name: 'check', size: 12 }) : null),
      h('span', { className: 'proj-ico' }, h(Icon, { name: 'film', size: 17 })),
      h('div', { className: 'proj-main' },
        h('div', { className: 'proj-name' }, p.name),
        h('div', { className: 'proj-sub' }, p.root + '\\' + p.uproject)),
      h('div', { className: 'proj-tags' },
        h('span', { className: 'proj-tag ue' }, 'UE ' + p.ue),
        h('span', { className: 'proj-tag' }, p.size),
        h('span', { className: 'proj-tag' }, (p.machines || []).length + ' 台'),
        p.hasPak ? h('span', { className: 'proj-tag pak' }, h(Icon, { name: 'check', size: 10 }), '已有 PAK') : null,
        p.warn ? h('span', { className: 'proj-tag warn', title: p.warn }, h(Icon, { name: 'alert', size: 10 }), '版本不一致') : null));
  }

  /* =================== DDC PAK — master (center) =================== */
  function PakMaster({ s }) {
    const [scope, setScope] = useState('all');
    const [roots, setRoots] = useState('D:\\Projects;E:\\UEProjects');
    const g = gate(s); if (g) return g;
    /* 只算「仍存在于当前工程列表」的已选项：reloadCache 后被剔除的工程 id 不计入，与检查器(PakDetail
       同样 filter)计数一致；toggle 基于该剪枝后的数组写回 → 顺带把陈旧 id 清理掉。 */
    const sel = (s.pakSel || []).filter((id) => UE_PROJECTS.some((p) => p.id === id));
    const toggle = (p) => s.setPakSel(sel.includes(p.id) ? sel.filter((x) => x !== p.id) : sel.concat(p.id));

    return h('div', { className: 'res ddc' },
      h('div', { className: 'canvas-head' },
        h('span', { className: 't' }, 'DDC · DDC PAK'),
        h('div', { className: 'right' },
          h('span', { className: 'toolchip' }, h(Icon, { name: 'film', size: 14 }), '已选 ' + sel.length + ' 个工程'))),
      h('div', { className: 'ddc-body' },
        h('div', { className: 'ddc-sec-h' }, h('span', null, '扫描 UE 工程'), h('span', { className: 'dim' }, 'discover_projects · 远程扫 .uproject，只发现不写盘')),
        h('div', { className: 'pak-scan' },
          h('div', { className: 'pak-scan-fields' },
            h('div', { className: 'dp-field' }, h('label', null, '扫描范围'),
              h(Selector, { kpre: '范围', value: scope, options: scopeOpts(), width: 178, onChange: setScope })),
            h('div', { className: 'dp-field grow' }, h('label', null, '搜索根目录'),
              h('input', { className: 'dp-input mono', value: roots, spellCheck: false, onChange: (e) => setRoots(e.target.value) })),
            h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'search', size: 14 }), onPress: () => runDiscover(s, scope, roots) }, '扫描')),
          h('div', { className: 'pak-scan-meta' }, h(Icon, { name: 'check', size: 12 }), '已发现 ' + UE_PROJECTS.length + ' 个工程位置 · 远程扫 .uproject 只发现不写盘')),

        h('div', { className: 'ddc-sec-h' }, h('span', null, '选择工程'),
          h('span', { className: 'dim' }, sel.length ? ('已选 ' + sel.length + ' 个 · 在右侧检查器生成 / 校验') : '勾选要处理的工程，操作在右侧检查器中进行')),
        h('div', { className: 'proj-list' }, UE_PROJECTS.map((p) => projRow(p, sel.includes(p.id), toggle))),
        UE_PROJECTS.length === 0 ? h('div', { className: 'gen-empty' }, h(Icon, { name: 'film', size: 22 }), h('span', null, '尚未发现工程，先在上方扫描 UE 工程')) : null));
  }

  /* =================== DDC PAK — detail (inspector) =================== */
  function PakDetail({ s }) {
    const verify = s.pakVerify || {};   /* projId -> info（提到 shell：分发开 preview drawer 会卸载 PakDetail，本地态会丢）*/
    const sel = (s.pakSel || []).map((id) => UE_PROJECTS.find((p) => p.id === id)).filter(Boolean);
    const remove = (id) => s.setPakSel((s.pakSel || []).filter((x) => x !== id));
    const doVerify = (p) => verifyPak(s, p).then((info) => s.setPakVerify((m) => Object.assign({}, m, { [p.id]: info })));

    const projCard = (p) => {
      const v = verify[p.id];
      const src = pickSrc(p);
      return h('div', { key: p.id, className: 'id-proj' },
        h('div', { className: 'id-proj-top' },
          h('span', { className: 'id-proj-ico' }, h(Icon, { name: 'film', size: 16 })),
          h('div', { className: 'id-proj-meta' },
            h('div', { className: 'id-proj-name' }, p.name, h('span', { className: 'ue' }, 'UE ' + p.ue)),
            h('div', { className: 'id-proj-path' }, p.root + '\\' + p.uproject)),
          h('button', { className: 'id-proj-x', title: '从选择中移除', onClick: () => remove(p.id) }, h(Icon, { name: 'x', size: 14 }))),
        h('div', { className: 'id-proj-tags' },
          h('span', { className: 't' }, p.size),
          h('span', { className: 't' }, '源 · ' + ((src || {}).host || '—')),
          p.hasPak ? h('span', { className: 't pak' }, '已有 PAK') : null,
          p.warn ? h('span', { className: 't warn', title: p.warn }, '版本不一致') : null),
        v ? h('div', { className: 'id-verify' + (v.found ? ' ok' : ' miss') },
          h('div', { className: 'id-verify-h' },
            h('span', { className: 's-' + (v.found ? 'positive' : 'notice') }, h(Icon, { name: v.found ? 'check' : 'alert', size: 13 })),
            v.found ? 'DDC.ddp 存在' : '未找到 DDC.ddp'),
          v.found ? h('div', { className: 'id-verify-kv' }, h('span', null, '路径'), h('span', { className: 'v' }, v.path)) : null,
          v.found ? h('div', { className: 'id-verify-kv' }, h('span', null, '大小'), h('span', { className: 'v' }, v.size)) : null,
          v.found
            ? h(Button, { variant: 'secondary', size: 'S', icon: h(Icon, { name: 'download', size: 13 }), onPress: () => distribute(s, { kind: 'DDC pak', name: v.name, srcId: v.srcId, projId: p.id }) }, '分发到渲染机')
            : h('div', { className: 'id-note' }, h(Icon, { name: 'eye', size: 12 }), '该工程在源机上尚无 PAK 产物，先在下方生成。')) : null,
        h('div', { className: 'id-proj-acts' },
          h(Button, { variant: 'secondary', size: 'S', icon: h(Icon, { name: 'search', size: 13 }), onPress: () => doVerify(p) }, v ? '重新校验产物' : '校验产物')));
    };

    const body = sel.length === 0
      ? h('div', { className: 'id-empty' }, h('div', { className: 'ph' }, h(Icon, { name: 'film', size: 24 })),
          h('div', null, '在主视图勾选一个或多个工程'), h('div', { style: { fontSize: 11 } }, '选中的工程会列在这里，可生成 / 校验其 DDC PAK 产物'))
      : h(React.Fragment, null,
          h('div', { className: 'id-sec-h' }, '已选工程', h('span', { className: 'ct' }, sel.length + ' 个')),
          sel.map(projCard),
          h('div', { className: 'id-note' }, h(Icon, { name: 'eye', size: 12 }),
            '校验 = verify_pak_output 检查该工程在源机上的 PAK 是否存在（路径 / 大小 / 是否存在），不列举全部产物。'));

    return h('div', { className: 'insp-detail' },
      h('div', { className: 'insp-head' },
        h('span', { className: 'ico' }, h(Icon, { name: 'cache', size: 15 })),
        h('div', { style: { minWidth: 0 } }, h('div', { className: 'tt' }, '检查器 · DDC PAK'),
          h('div', { className: 'sub' }, 'generate_ddc_pak / verify_pak_output'))),
      h('div', { className: 'id-body' }, body),
      sel.length ? h('div', { className: 'id-foot' },
        h('div', { className: 'id-foot-scope' }, h(Icon, { name: 'info', size: 12 }),
          '仅处理工程级 Pak（DDC.ddp），不含引擎级 Pak'),
        h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'bolt', size: 14 }),
          onPress: () => sel.forEach((p) => genPak(s, p)) },
          '生成 DDC PAK（' + sel.length + '）')) : null);
  }

  /* =================== PSO 缓存 — master (center) · 选工程 + 节点就绪矩阵 =================== */
  function PsoMaster({ s }) {
    const g = gate(s); if (g) return g;
    const selId = s.psoSel;
    psoSelLive = selId; /* 长任务回填读活值（见 loadWarmupRuns 上方注释） */
    const p = UE_PROJECTS.find((x) => x.id === selId) || null; /* 选中工程被 reloadCache 剔除时回退「未选工程」，与检查器空态一致 */
    const pick = (x) => s.setPsoSel(selId === x.id ? null : x.id);
    const nodes = psoNodes();
    const maj = majorityDriver(s);
    const runs = s.psoRuns || [];
    const readyCt = p ? nodes.filter((n) => readinessOf(runs, n.machineId).state === 'ready').length : 0;

    const nmRow = (n) => {
      const r = readinessOf(runs, n.machineId);
      const off = n.status === 'offline';
      const meta = READY_META[r.state] || READY_META.never;
      const sig = gpuSigOf(s, n);
      const drift = !off && sig && sig.driver && maj && sig.driver !== maj;
      return h('div', { key: n.id, className: 'nm-row' + (off ? ' off' : '') },
        h('div', { className: 'nm-id' },
          CX.dot(NODE_STATUS[n.status].visual),
          h('div', { className: 'nm-meta' },
            h('div', { className: 'nm-host' }, n.host,
              off ? h('span', { className: 'nm-chip off' }, h(Icon, { name: 'power', size: 10 }), '离线') : null,
              drift ? h('span', { className: 'nm-chip warn', title: '本机驱动 ' + sig.driver + ' · 集群多数 ' + maj }, h(Icon, { name: 'alert', size: 10 }), '驱动版本不一致') : null),
            h('div', { className: 'nm-gpu' }, gpuText(s, n)))),
        h('span', { className: 'nm-time' }, r.verified || '—'),
        h('span', { className: 'nm-hitch' + (r.state === 'hitch' ? ' warn' : r.state === 'ready' ? '' : ' dim') },
          r.state === 'ready' ? '0' : r.state === 'hitch' ? String(r.hitches) : '—'),
        h('span', { className: 'spill spill--' + meta.vis, title: r.err || undefined },
          meta.icon === 'minus' ? h('span', { style: { fontWeight: 700 } }, '—')
            : meta.icon === 'sync' ? h('span', { className: 'spin', style: { display: 'flex' } }, h(Icon, { name: 'sync', size: 12 }))
            : h(Icon, { name: meta.icon, size: 12 }),
          readyLabel(r)),
        h('div', { className: 'nm-ops' },
          !off && r.state === 'hitch' ? h('button', { className: 'mini-btn', title: '在该节点复跑一次预热验证', onClick: () => rerunNode(s, p, n) }, h(Icon, { name: 'sync', size: 12 }), '复跑验证') : null,
          !off && r.state === 'failed' ? h('button', { className: 'mini-btn', title: '在控制台流中查看该节点的失败日志', onClick: () => seeNodeLog(s, n.host) }, h(Icon, { name: 'terminal', size: 12 }), '查看日志') : null));
    };

    return h('div', { className: 'res ddc' },
      h('div', { className: 'canvas-head' },
        h('span', { className: 't' }, 'DDC · PSO 缓存'),
        h('div', { className: 'right' },
          p ? h('span', { className: 'toolchip' }, h(Icon, { name: 'check', size: 14 }), '就绪 ' + readyCt + ' / ' + nodes.length + ' 台') : null,
          h('span', { className: 'toolchip' }, h(Icon, { name: 'layers', size: 14 }), p ? ('已选 · ' + p.name) : '未选工程'))),
      h('div', { className: 'ddc-body' },
        h('div', { className: 'ddc-sec-h' }, h('span', null, '选择工程'),
          h('span', { className: 'dim' }, '选中一个工程，预热验证 / 运行历史都在右侧检查器中进行')),
        h('div', { className: 'pak-scan-meta', style: { margin: '0 0 12px' } }, h(Icon, { name: 'check', size: 12 }), '已发现 ' + UE_PROJECTS.length + ' 个工程位置'),
        h('div', { className: 'proj-list' }, UE_PROJECTS.map((x) => projRow(x, selId === x.id, pick))),
        UE_PROJECTS.length === 0 ? h('div', { className: 'gen-empty' }, h(Icon, { name: 'film', size: 22 }), h('span', null, '尚未发现工程，先在右侧检查器扫描')) : null,

        /* 节点就绪矩阵 —— 选中工程后显示，每台 render 节点一行 */
        h('div', { className: 'ddc-sec-h', style: { marginTop: 18 } }, h('span', null, '节点就绪矩阵'),
          h('span', { className: 'dim' }, p ? (p.name + ' · 每台 render 节点本机的预热就绪情况') : '选中工程后按节点显示就绪状态')),
        p
          ? h('div', { className: 'nm-list' },
              h('div', { className: 'nm-head' },
                h('span', null, '节点 / GPU'), h('span', null, '最近验证'), h('span', null, 'hitch 数'), h('span', null, '就绪状态'), h('span', null)),
              nodes.map(nmRow))
          : h('div', { className: 'gen-empty' }, h(Icon, { name: 'grid', size: 22 }), h('span', null, '选中一个工程后，这里显示各 render 节点的就绪矩阵'))));
  }

  /* =================== PSO 缓存 — detail (inspector) · 扫描 / 预热验证 / 运行历史 / 配置合规 =================== */
  /* 合规卡规则展示元数据（真实规则语义：R008–R010 运行时预缓存 / R024 缓存加载；
     文件落点 DefaultEngine.ini [ConsoleVariables]，与后端 fix_pso_cvars / 巡检规则一致）。 */
  const PSO_RULES = [
    { id: 'R008', cvar: 'r.PSOPrecaching', expect: '1', label: '启用运行时 PSO 预缓存' },
    { id: 'R009', cvar: 'r.PSOPrecache.Mode', expect: '0', label: 'Full PSO 预缓存模式' },
    { id: 'R010', cvar: 'r.PSOPrecache.GlobalShaders', expect: '1', label: '预缓存全局 shader' },
    { id: 'R024', cvar: 'r.ShaderPipelineCache.Enabled', expect: '1', label: '启用 PSO 缓存加载' },
  ];
  const PSO_RULE_IDS = PSO_RULES.map((r) => r.id);

  function PsoDetail({ s }) {
    const [scope, setScope] = useState('all');
    const [roots, setRoots] = useState('D:\\Projects;E:\\UEProjects');
    const [targets, setTargets] = useState(null); /* null = 默认全选在线 render 机（机器列表异步加载，不能在挂载时定死） */
    const [res, setRes] = useState('1920×1080');
    const [max, setMax] = useState('20');
    const [cvarOpen, setCvarOpen] = useState(false);
    const [cvar, setCvar] = useState(null);       /* null=未校验 | { findings:[], at } */
    const [cvarBusy, setCvarBusy] = useState(false);
    const projId = s.psoSel;
    psoSelLive = projId; /* 长任务回填读活值（见 loadWarmupRuns 上方注释） */
    const p = UE_PROJECTS.find((x) => x.id === projId) || null;
    /* 切工程：重载运行记录 + 清空合规结果（合规按工程 INI 扫）。 */
    useEffect(() => { loadWarmupRuns(s, projId); setCvar(null); /* eslint-disable-line */ }, [projId]);

    const online = RENDER_NODES.filter((n) => n.roleKey === 'render' && n.status !== 'offline');
    /* 有效选择 = 用户点过就用点过的（剪掉已离线的），没点过默认全选在线 render 机。 */
    const effTargets = targets == null
      ? online.map((n) => n.id)
      : targets.filter((id) => online.some((n) => n.id === id));
    const toggleT = (id) => setTargets(effTargets.includes(id) ? effTargets.filter((x) => x !== id) : effTargets.concat(id));
    const allT = online.length > 0 && online.every((n) => effTargets.includes(n.id));

    /* ---- 目标节点多选（host + GPU）---- */
    const tgRow = (n) => {
      const on = effTargets.includes(n.id);
      return h('div', { key: n.id, className: 'wv-node' + (on ? ' on' : ''), onClick: () => toggleT(n.id) },
        h('span', { className: 'proj-mck' + (on ? ' on' : '') }, on ? h(Icon, { name: 'check', size: 11 }) : null),
        CX.dot(NODE_STATUS[n.status].visual),
        h('span', { className: 'wv-host mono' }, n.host),
        h('span', { className: 'wv-gpu' }, gpuText(s, n)));
    };

    /* ---- 运行历史（list_pso_warmup_runs，按节点分组；list 已按时间倒序）---- */
    const runs = p ? (s.psoRuns || []) : [];
    const histGroups = RENDER_NODES.filter((n) => runs.some((r) => r.machine_id === n.machineId))
      .map((n) => ({ n, list: runs.filter((r) => r.machine_id === n.machineId) }));
    const histRun = (r) => {
      const failed = r.status === 'err';
      const canceled = r.status === 'cancelled';
      const running = r.status === 'running';
      const hitches = r.hitch_count;
      return h('div', { key: r.id, className: 'hist-run' },
        h('span', { className: 'tm' }, fmtRunTime(r.started_at)),
        h('span', { className: 'rs mono' }, r.resolution_w + '×' + r.resolution_h),
        h('span', { className: 'du' }, running ? '进行中' : fmtDur(r.duration_secs)),
        h('span', { className: 'hh' + ((failed || canceled || running || hitches == null) ? ' dim' : hitches > 0 ? ' warn' : '') },
          hitches == null ? 'hitch —' : ('hitch ' + hitches)),
        h('span', { className: 'hist-state s-' + (failed ? 'negative' : canceled ? 'neutral' : running ? 'informative' : 'positive'), title: r.error_message || undefined },
          running ? h('span', { className: 'spin', style: { display: 'flex' } }, h(Icon, { name: 'sync', size: 11 })) : h(Icon, { name: failed ? 'x' : canceled ? 'minus' : 'check', size: 11 }),
          failed ? '失败' : canceled ? '已取消' : running ? '验证中' : '成功'));
    };

    /* ---- 配置合规（verify_pso_precaching → R008/R009/R010/R024 findings）---- */
    const findings = cvar ? cvar.findings : null;
    const openFindings = (rid) => (findings || []).filter((f) => f.rule_id === rid && !f.fixed_at && !f.skipped_at);
    const issues = findings == null ? null : PSO_RULE_IDS.reduce((a, rid) => a + openFindings(rid).length, 0);
    const hostOfMid = (mid) => { const n = RENDER_NODES.find((x) => x.machineId === mid); return n ? n.host : ('机器 ' + mid); };
    const cvarMachines = () => (p ? RENDER_NODES.filter((n) => (p.machines || []).includes(n.id) && n.status !== 'offline') : []);
    const recheckCvars = () => {
      const ms = cvarMachines();
      if (!p || !ms.length || cvarBusy) return;
      setCvarBusy(true);
      s.runCmd({ domain: 'pso', action: 'verify', target: p.name, chan: 'ssh', note: '校验 PSO CVar 合规（R008–R010 / R024）' },
        () => verifyPsoPrecaching({ machine_ids: ms.map((n) => n.machineId), credential_alias: '', project_paths: [p.root], user_profile_path: null }),
        { okMsg: (r) => {
            const open = (r.findings || []).filter((f) => PSO_RULE_IDS.includes(f.rule_id) && !f.fixed_at && !f.skipped_at);
            return open.length ? (open.length + ' 项 PSO CVar 不合规') : 'PSO CVar 全部合规';
          } })
        .then(
          (r) => { setCvar({ findings: (r.findings || []).filter((f) => PSO_RULE_IDS.includes(f.rule_id)), at: Date.now() }); setCvarBusy(false); },
          () => setCvarBusy(false));
    };
    const fixCvars = () => {
      if (!p || !issues || cvarBusy) return;
      const mids = Array.from(new Set(PSO_RULE_IDS.flatMap((rid) => openFindings(rid).map((f) => f.machine_id))));
      if (!mids.length) return;
      setCvarBusy(true);
      s.runCmd({ domain: 'pso', action: 'fix-cvars', target: mids.length + ' 台机器', chan: 'ssh',
        note: '一键修复 PSO CVar（写 DefaultEngine.ini [ConsoleVariables]，写后重新校验）' },
        () => Promise.allSettled(mids.map((mid) => fixPsoCvars(Number(p.id), mid))).then((rs) => {
          const failed = rs.filter((r) => r.status === 'rejected').length;
          if (failed === rs.length) throw new Error('全部机器修复失败');
          return { fixed: rs.length - failed, failed };
        }),
        { okMsg: (r) => '已写入 ' + r.fixed + ' 台' + (r.failed ? ('（' + r.failed + ' 台失败）') : '') })
        .then(() => { setCvarBusy(false); recheckCvars(); }, () => setCvarBusy(false));
    };
    const cvarRule = (r) => {
      const bad = openFindings(r.id);
      return h('div', { key: r.id, className: 'cvar-rule' },
        h('span', { className: 'rid' }, r.id),
        h('div', { className: 'cvar-main' },
          h('div', { className: 'cv mono' }, r.cvar + '=' + r.expect),
          h('div', { className: 'cvar-lb' }, r.label + (bad.length
            ? (' · ' + bad.map((f) => hostOfMid(f.machine_id) + '（当前 ' + (f.snippet_before || '未设置') + '）').join('、'))
            : ''))),
        h('span', { className: 'spill spill--' + (findings == null ? 'neutral' : bad.length ? 'notice' : 'positive'), style: { flex: '0 0 auto' } },
          findings == null ? h('span', { style: { fontWeight: 700 } }, '—') : h(Icon, { name: bad.length ? 'alert' : 'check', size: 12 }),
          findings == null ? '未校验' : bad.length ? (bad.length + ' 台不合规') : '合规'));
    };

    return h('div', { className: 'insp-detail' },
      h('div', { className: 'insp-head' },
        h('span', { className: 'ico' }, h(Icon, { name: 'layers', size: 15 })),
        h('div', { style: { minWidth: 0 } }, h('div', { className: 'tt' }, '检查器 · PSO 缓存'),
          h('div', { className: 'sub' }, 'discover_projects / pso warmup'))),
      h('div', { className: 'id-body' },
        /* 扫描 UE 工程（保持现状）*/
        h('div', { className: 'id-scan' },
          h('div', { className: 'id-sec-h' }, '扫描 UE 工程'),
          h('div', { className: 'id-field' }, h('label', null, '扫描范围'),
            h(Selector, { kpre: '范围', value: scope, options: scopeOpts(), width: 200, onChange: setScope })),
          h('div', { className: 'id-field' }, h('label', null, '搜索根目录'),
            h('input', { className: 'dp-input mono', value: roots, spellCheck: false, onChange: (e) => setRoots(e.target.value) })),
          h(Button, { variant: 'secondary', size: 'M', icon: h(Icon, { name: 'search', size: 14 }), onPress: () => runDiscover(s, scope, roots) }, '扫描工程'),
          h('div', { className: 'id-scan-meta' }, h(Icon, { name: 'check', size: 12 }), '已发现 ' + UE_PROJECTS.length + ' 个工程')),

        /* 预热验证（需已选工程）*/
        h('div', { className: 'id-sec-h', style: { marginTop: 4 } }, '预热验证',
          p ? h('span', { className: 'ct' }, p.name) : null),
        p ? h('div', { className: 'wv-block' },
            h('div', { className: 'wv-selbar' },
              h('button', { className: 'wv-all', onClick: () => setTargets(allT ? [] : online.map((n) => n.id)) },
                h('span', { className: 'proj-mck' + (allT ? ' on' : (effTargets.length ? ' part' : '')) },
                  allT ? h(Icon, { name: 'check', size: 11 }) : (effTargets.length ? h(Icon, { name: 'minus', size: 11 }) : null)),
                allT ? '取消全选' : '全选在线 render 机'),
              h('span', { className: 'wv-ct' }, '已选 ' + effTargets.length + ' / ' + online.length + ' 台')),
            h('div', { className: 'wv-list' }, online.map(tgRow)),
            h('div', { className: 'id-form' },
              h('div', { className: 'id-field' }, h('label', null, '渲染分辨率'),
                h(Selector, { kpre: '分辨率', value: res, options: resOpts, width: 180, onChange: setRes })),
              h('div', { className: 'id-field' }, h('label', null, '最长时长'),
                h(Selector, { kpre: '时长', value: max, options: maxOpts, width: 150, onChange: setMax }))),
            h('div', { className: 'id-note' }, h(Icon, { name: 'terminal', size: 12 }),
              '在每台节点本机跑 UE -game 遍历场景，填充本机驱动缓存并统计 PSO 卡顿次数 · 长任务'),
            h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'bolt', size: 14 }), isDisabled: effTargets.length === 0,
              onPress: () => runWarmup(s, p, effTargets.map((id) => CX.node(id)).filter(Boolean), res, max) },
              '运行预热验证（' + effTargets.length + ' 台）'))
          : h('div', { className: 'id-empty' }, h('div', { className: 'ph' }, h(Icon, { name: 'layers', size: 22 })),
              h('div', null, '在主视图选择一个工程'), h('div', { style: { fontSize: 11 } }, '选中后在这里配置目标节点并运行预热验证')),

        /* 运行历史（按节点分组）*/
        p ? h(React.Fragment, null,
          h('div', { className: 'id-sec-h', style: { marginTop: 4 } }, '运行历史', h('span', { className: 'ct' }, runs.length + ' 条')),
          runs.length === 0
            ? h('div', { className: 'id-note' }, h(Icon, { name: 'list', size: 12 }), '暂无运行记录 · 运行预热验证后按节点在此分组显示')
            : h('div', { className: 'hist-list' }, histGroups.map((g) => h('div', { key: g.n.id, className: 'hist-group' },
                h('div', { className: 'hist-node' },
                  CX.dot(NODE_STATUS[g.n.status].visual),
                  h('span', { className: 'host' }, g.n.host),
                  h('span', { className: 'gpu' }, gpuText(s, g.n)),
                  h('span', { className: 'ct' }, g.list.length + ' 次')),
                h('div', { className: 'hist-runs' }, g.list.map(histRun)))))) : null,

        /* 配置合规 —— 低视觉权重折叠卡，固定在检查器底部 */
        p ? h('div', { className: 'cvar-card' + (cvarOpen ? ' open' : '') },
          h('button', { className: 'cvar-h', onClick: () => setCvarOpen((v) => !v) },
            h(Icon, { name: 'chevr', size: 12, style: { transform: cvarOpen ? 'rotate(90deg)' : 'none', transition: 'transform .13s' } }),
            h('span', { className: 't' }, '配置合规 · CVar 巡检（R008–R010 / R024）'),
            cvarBusy
              ? h('span', { className: 'cvar-ct dim' }, h('span', { className: 'spin', style: { display: 'flex' } }, h(Icon, { name: 'sync', size: 10 })), '校验中')
              : issues == null
                ? h('span', { className: 'cvar-ct dim' }, '未校验')
                : issues
                  ? h('span', { className: 'cvar-ct warn' }, h(Icon, { name: 'alert', size: 10 }), issues + ' 项不合规')
                  : h('span', { className: 'cvar-ct ok' }, h(Icon, { name: 'check', size: 10 }), '全部合规')),
          cvarOpen ? h('div', { className: 'cvar-b' },
            PSO_RULES.map(cvarRule),
            h('div', { className: 'cvar-acts' },
              h('button', { className: 'mini-btn', disabled: cvarBusy, onClick: recheckCvars }, h(Icon, { name: 'sync', size: 12 }), findings == null ? '立即校验' : '重新校验'),
              h('button', { className: 'mini-btn accent', disabled: !issues || cvarBusy, onClick: fixCvars }, h(Icon, { name: 'bolt', size: 12 }), '一键修复'))) : null,
          h('div', { className: 'cvar-note' }, h(Icon, { name: 'info', size: 12 }),
            h('span', null, '仅打包模式下生效；当前 Editor 运行方式的防卡顿依赖 DDC 预热与本机预热验证。'))) : null));
  }

  /* =================== 文件系统 DDC（本地 + 共享）— 双列视图，接真实后端 ===================
     左列：① 共享 DDC（SMB）服务器部署 + 已纳管共享 + ② 其他服务器加入共享 DDC（写环境变量 + 工程 INI）。
     右列：③ 本地 DDC（统一路径一键 + 逐台 + 多选批量）。
     部署 / 加入类动作「直接执行」：点击即跑真实命令，期间显示「部署中…/加入中…」徽标，任务真正落地
     （promise resolve）后才翻状态——不再走 openPreview 确认门。① 服务器创建（create_share）/ 拆除
     （teardown_share）/ 解除纳管（delete_share）仍走确认门（破坏性、影响整集群）。
     localDeployed / shareJoined 无 NodeVM 字段，挂载时对在线机 fan-out 读 UE-Local/SharedDataCachePath
     得真实状态（statusLoading 期间徽标显示「读取中…」，不假报「未部署」）。 */
  function LegacyView({ s }) {
    const [srv, setSrv] = useState('rn0');
    const [localDirs, setLocalDirs] = useState(() => {
      const m = {};
      RENDER_NODES.forEach((n) => { const drv = /^([A-Za-z]):/.test(n.uePath) ? n.uePath[0].toUpperCase() : 'D'; m[n.id] = drv + ':\\UE_DDC\\Local'; });
      return m;
    });
    const [localDeployed, setLocalDeployed] = useState([]);   /* 节点 id：本地 DDC 已部署（真实 env 读得）*/
    const [shareJoined, setShareJoined] = useState({});       /* 节点 id -> 当前已指向的共享路径（真实 env 读得）*/
    const [statusLoading, setStatusLoading] = useState(true); /* 初始 env-var 状态读取中 */
    const [selLocal, setSelLocal] = useState([]);             /* 多选批量部署 / 取消部署的勾选集 */
    const [localPending, setLocalPending] = useState({});     /* 节点 id -> 'deploy' | 'undeploy' */
    const [joinPending, setJoinPending] = useState({});       /* 节点 id -> 'join' | 'leave' */
    const [joinTarget, setJoinTarget] = useState(null);       /* 选中要加入哪个共享服务器（share id）*/
    const [commonLocalDir, setCommonLocalDir] = useState('D:\\UE_DDC\\Local');
    /* 共享创建（create_share）表单：share_name + local_path + mode。 */
    const [shareName, setShareName] = useState('Volo_DDC');
    const [shareLocal, setShareLocal] = useState('D:\\Volo\\DDC');
    const [shareMode, setShareMode] = useState('open'); /* 'open'(Mode A) | 'managed'(Mode B) */
    /* 给 env-read 回填用：lpRef/jpRef 取最新 pending（对「取消部署/退出」进行中的机器跳过旧快照复活）；
       readGenRef 作代次令牌——只应用最新一次读取，丢弃被取代的旧读取（也兼作卸载守卫）。 */
    const lpRef = useRef(localPending); lpRef.current = localPending;
    const jpRef = useRef(joinPending); jpRef.current = joinPending;
    const readGenRef = useRef(0);

    /* 真实状态读取：对在线机 fan-out 读两个 env var → 已部署 / 已加入（NodeVM 不带这两个字段，
       adapter 注释：客户端是否已接入靠 get_machine_env_var 读 UE-SharedDataCachePath）。
       readStatus 同时被「挂载 / 机器集合变化」的 effect 与「刷新状态」按钮调用。 */
    const readStatus = () => {
      const online = RENDER_NODES.filter((n) => n.status !== 'offline' && n.machineId != null && n.machineId !== 0);
      /* online 为空（机器没加载到 / 全部离线）：仅落定 loading，不覆盖式清空——否则抹掉乐观更新；
         陈旧 id 不在 RENDER_NODES 里自然不渲染，无害。 */
      if (!online.length) { setStatusLoading(false); return; }
      const gen = ++readGenRef.current;
      setStatusLoading(true);
      Promise.allSettled(online.map((n) =>
        Promise.allSettled([
          getMachineEnvVar(n.machineId, 'UE-LocalDataCachePath'),
          getMachineEnvVar(n.machineId, 'UE-SharedDataCachePath'),
        ]).then((rs) => ({ id: n.id,
          local: rs[0].status === 'fulfilled' ? rs[0].value : null,
          shared: rs[1].status === 'fulfilled' ? rs[1].value : null }))
      )).then((rs) => {
        if (gen !== readGenRef.current) return; /* 被更新的读取取代（或已卸载）→ 丢弃 */
        const dep = []; const joined = {};
        rs.forEach((r) => { if (r.status === 'fulfilled') { const v = r.value; if (v.local) dep.push(v.id); if (v.shared) joined[v.id] = v.shared; } });
        /* 与乐观更新合并而非覆盖：保留读取期间用户「部署/加入」的乐观结果（prev），不被旧快照刷回；
           同时对「取消部署/退出」进行中的机器，剔除本次旧快照可能复活的项——对称保护两个方向。 */
        const lp = lpRef.current, jp = jpRef.current;
        setLocalDeployed((prev) => {
          const next = new Set(prev.concat(dep));
          Object.keys(lp).forEach((id) => { if (lp[id] === 'undeploy') next.delete(id); });
          return Array.from(next);
        });
        setShareJoined((prev) => {
          const next = Object.assign({}, joined, prev);
          Object.keys(jp).forEach((id) => { if (jp[id] === 'leave') delete next[id]; });
          return next;
        });
        setStatusLoading(false);
      });
    };
    /* 挂载 / 机器集合或在线态变化时自动重读；卸载或重跑时 bump 代次令牌作废在途读取。 */
    const midSig = RENDER_NODES.map((n) => n.id + ':' + n.status).join(',');
    useEffect(() => { readStatus(); return () => { readGenRef.current++; }; /* eslint-disable-line react-hooks/exhaustive-deps */ }, [midSig]);

    const g = gate(s); if (g) return g;

    /* IP 升序：按点分十进制数值比较（非字符串字典序），机器选择器 / 加入列表 / 本地 DDC 列表统一用此序。
       IP 缺失/不合法时排到末尾（Infinity），不与合法的 0.0.0.0 混为一谈排到最前。 */
    const ipVal = (ip) => {
      const octs = String(ip || '').split('.');
      if (octs.length !== 4 || octs.some((o) => o === '' || isNaN(o))) return Infinity;
      return octs.reduce((acc, o) => acc * 256 + parseInt(o, 10), 0);
    };
    const IP_SORTED_NODES = RENDER_NODES.slice().sort((a, b) => ipVal(a.ip) - ipVal(b.ip));

    /* resolve the chosen server to a real node — persisted `srv` may be a stale mock id
       now that machines come from the backend; fall back to an already-deployed shared
       server first（默认展示已部署的服务器，n.share 即 adapters.ts 用同一份 shares 算出的
       托管 unc_path，与「已纳管共享」判定同源），否则退到第一台非共享角色机器。 */
    const deployedNode = IP_SORTED_NODES.find((n) => n.share);
    const sharedNode = CX.node(srv) || deployedNode || IP_SORTED_NODES.find((n) => n.roleKey !== 'shared') || IP_SORTED_NODES[0];
    const srvOpts = IP_SORTED_NODES.map((n) => ({ id: n.id, label: n.host, sub: n.ip }));
    const onlineLocalTargets = IP_SORTED_NODES.filter((n) => n.status !== 'offline');
    const badge = (cls, icon, txt) => h('span', { className: 'cli-badge ' + cls }, h(Icon, { name: icon, size: 11 }), txt);

    /* ===== ① 共享 DDC（SMB）服务器：创建 / 解除纳管 / 拆除部署（破坏性，走确认门）===== */
    /* 真实 create_share：host=sharedNode.machineId，mode 序列化 'open'|'managed'；
       operator_credential_alias 传 null（SSH key 鉴权）；Mode B 的 svc_username 留空 → 后端默认 'ddc-svc'。 */
    const deploySMB = () => CX.openModalPreview(s, {
      title: '创建共享 DDC（SMB）', icon: 'folder', cli: 'create_share', destructive: false, channel: 'ssh', confirmLabel: '创建共享',
      doneTitle: '已成功部署', doneMsg: sharedNode.host + ' 已设为共享 DDC 服务器 · ' + shareLocal,
      steps: ['在 ' + sharedNode.host + ' 上新建共享缓存文件夹 ' + shareLocal,
        '共享名 ' + shareName + (shareMode === 'managed' ? '（Mode B · 专用账号 ddc-svc）' : '（Mode A · 开放）'),
        '集群缓存指向该共享，其余机器再到「② 其他服务器加入共享 DDC」逐台加入'],
      simpleScope: [{ host: sharedNode.host, ip: sharedNode.ip, msg: shareLocal }],
      run: () => {
        if (!sharedNode || !shareName.trim() || !shareLocal.trim()) return Promise.reject(new Error('缺少服务器机器 / 共享名 / 本地路径'));
        return s.runCmd({ domain: 'share', action: 'create', target: sharedNode.host, chan: 'ssh', note: 'SMB 共享 DDC（' + shareMode + '）' },
          () => createShare(sharedNode.machineId, shareMode, shareName.trim(), shareLocal.trim(), null, null),
          { okMsg: (r) => '共享已创建 · ' + r.unc_path })
          .then((r) => { s.reloadCache(); return r; });
      },
    });
    /* 解除共享 DDC 纳管：仅从 Volo 解除纳管，不删远端共享文件夹（后端暂不支持 also_remove_remote）*/
    const deleteShare = (sh) => CX.openModalPreview(s, {
      title: '解除共享纳管 · ' + sh.path, icon: 'trash', cli: 'delete_share', destructive: true, channel: 'ssh', confirmLabel: '解除纳管',
      doneTitle: '已解除纳管', doneMsg: sh.path + ' 已解除纳管 · 远端文件夹保留',
      steps: ['从 Volo 解除对该共享的纳管（不再分发 / 不再注入客户端）', '不会删除远端共享文件夹本身（后端暂不支持远端删共享）'],
      simpleScope: [{ host: sh.path, ip: sh.clients + ' 客户端', msg: '仅解除纳管' }],
      run: () => {
        if (!sh.shareConfigId) return Promise.reject(new Error('缺少 shareConfigId'));
        return s.runCmd({ domain: 'share', action: 'delete', target: sh.path, chan: 'ssh', note: '解除共享纳管（远端保留）' },
          () => deleteShareCmd(sh.shareConfigId, false), { okMsg: () => sh.path + ' 已解除纳管 · 远端文件夹保留' })
          .then((r) => { s.reloadCache(); return r; });
      },
    });
    /* 该服务器机器当前是否已部署共享（hostId = String(host_machine_id) 与 sharedNode.id 对齐）。 */
    const srvShare = (SHARES || []).find((x) => x.hostId === sharedNode.id);
    /* sharedNode 可能因「默认选已部署服务器」落在一台当前离线的机器上——三通道提示，避免用户在
       不知情时对不可达主机发起 SSH 操作（create_share / teardown_share 会直接失败）。 */
    const sharedOffline = sharedNode.status === 'offline';
    /* 取消该服务器部署（teardown_share）：停止 SMB 共享（Remove-SmbShare）+（Mode B）注销 ddc-svc，
       保留远端文件夹与缓存（keep_files=true）。删 SQLite 行后 reloadCache 把它从列表移除。
       区别于 deleteShare（仅解除纳管，不动远端共享服务）。 */
    const undeploySMB = (sh) => CX.openModalPreview(s, {
      title: '取消该服务器部署 · ' + (sh.host && sh.host !== '—' ? sh.host : sh.path), icon: 'trash', cli: 'teardown_share', destructive: true, channel: 'ssh', confirmLabel: '取消部署',
      doneTitle: '已取消部署', doneMsg: (sh.host && sh.host !== '—' ? sh.host : sh.path) + ' 共享 DDC 部署已取消 · 文件夹保留',
      steps: ['停止并移除该机上的 SMB 共享' + (/Mode B/.test(sh.mode || '') ? '（含注销专用账号 ddc-svc）' : '') + ' —— ' + sh.path,
        '从集群缓存图中摘除该上游，客户端回退到本地 / 其他上游',
        '保留远端共享文件夹与已有缓存文件，不做删除'],
      simpleScope: [{ host: sh.host && sh.host !== '—' ? sh.host : sh.path, ip: sh.clients + ' 客户端', msg: sh.path + ' · 保留文件夹' }],
      run: () => {
        if (!sh.shareConfigId) return Promise.reject(new Error('缺少 shareConfigId'));
        return s.runCmd({ domain: 'share', action: 'teardown', target: sh.host && sh.host !== '—' ? sh.host : sh.path, chan: 'ssh', note: '取消共享 DDC 服务器部署（文件夹保留）' },
          () => teardownShare(sh.shareConfigId, true),
          { okMsg: (r) => (r.host || sh.path) + ' 共享 DDC 部署已取消 · 文件夹保留' })
          .then((r) => { s.reloadCache(); return r; });
      },
    });

    const shareRow = (sh) => h('div', { key: sh.id, className: 'art-row' },
      h('span', { className: 'art-dot s-' + (sh.status === 'healthy' ? 'positive' : 'notice') }, h(Icon, { name: 'folder', size: 12 })),
      h('div', { className: 'art-meta' },
        h('div', { className: 'art-name mono' }, sh.path,
          sh.host && sh.host !== '—' ? h('span', { className: 'share-host' }, h(Icon, { name: 'server', size: 11 }), sh.host) : null),
        h('div', { className: 'art-sub' }, sh.mode + ' · ' + sh.clients + ' 客户端 · ' + sh.size)),
      h('button', { className: 'mini-btn danger', onClick: () => deleteShare(sh) }, h(Icon, { name: 'trash', size: 12 }), '取消服务器'));

    const smbPanel = h('div', { className: 'be-block' },
      h('div', { className: 'deploy-panel' },
        h('div', { className: 'dp-h' }, h(Icon, { name: 'folder', size: 15 }), '部署 共享 DDC（SMB）'),
        h('div', { className: 'dp-form' },
          h('div', { className: 'dp-field' }, h('label', null, '服务器机器'),
            h(Selector, { kpre: '机器', value: sharedNode.id, options: srvOpts, width: 240, onChange: setSrv })),
          h('div', { className: 'dp-field' }, h('label', null, '共享名'),
            h('input', { className: 'dp-input mono', value: shareName, spellCheck: false, onChange: (e) => setShareName(e.target.value) })),
          h('div', { className: 'dp-field' }, h('label', null, '本地路径'),
            h('input', { className: 'dp-input mono', value: shareLocal, spellCheck: false, onChange: (e) => setShareLocal(e.target.value) })),
          h('div', { className: 'dp-field' }, h('label', null, '模式'),
            h(Selector, { kpre: '模式', value: shareMode, width: 200, onChange: setShareMode,
              options: [{ id: 'open', label: 'Mode A · 开放' }, { id: 'managed', label: 'Mode B · 专用账号' }] })),
          h('div', { className: 'dp-go' },
            sharedOffline ? h('span', { className: 'dp-deployed', style: { color: 'var(--negative-visual)' } }, h(Icon, { name: 'power', size: 13 }), '离线') : null,
            srvShare ? h('span', { className: 'dp-deployed' }, h(Icon, { name: 'check', size: 13 }), '已部署于本机') : null,
            srvShare ? h(Button, { variant: 'negative', size: 'M', icon: h(Icon, { name: 'trash', size: 14 }), onPress: () => undeploySMB(srvShare) }, '取消该服务器部署') : null,
            h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'bolt', size: 14 }), onPress: deploySMB }, srvShare ? '重新部署' : '部署 共享 DDC'))),
        h('div', { className: 'dp-note' }, h(Icon, { name: 'shield', size: 13 }), srvShare
          ? ('该机器已作为共享 DDC 服务器 · ' + srvShare.path + '；可随时取消部署，取消后保留远端文件夹与缓存。')
          : '链路在后台逐步执行（进度进任务抽屉）；凭据 / urlacl / 服务安装全部自动处理。')));

    /* ===== ② 其他服务器加入共享 DDC（直接执行，真实 env + 工程 INI 写入）===== */
    const ENV_KEY = 'UE-SharedDataCachePath';
    /* 接入：对每台设环境变量 UE-SharedDataCachePath，并对该机已扫描到的工程写
       [DerivedDataBackendGraph] Shared 的 Path + EnvPathOverride（没有 EnvPathOverride 时 UE 会忽略环境变量）。 */
    const joinShareToMachines = (targets, unc, sh) => {
      let envOk = 0, iniProjOk = 0, iniProjExpected = 0, fail = 0;
      const okMachineIds = [];
      const errs = []; /* 收集每台机的真实错误——不再吞掉，否则只剩笼统的「全部目标设置失败」无从排查。 */
      return Promise.allSettled(targets.map((mid) =>
        setMachineEnvVar(mid, ENV_KEY, unc).then(() => {
          envOk++;
          const projs = (UE_PROJECTS || []).filter((p) => (p.machines || []).includes(String(mid)));
          iniProjExpected += projs.length;
          return Promise.allSettled(projs.map((p) => {
            const base = (p.locByMachine && p.locByMachine[String(mid)]) || p.root;
            const ini = String(base).replace(/\\+$/, '') + '\\Config\\DefaultEngine.ini';
            return Promise.all([
              setMachineBackendField(mid, ini, 'DerivedDataBackendGraph', 'Shared', 'Path', unc),
              setMachineBackendField(mid, ini, 'DerivedDataBackendGraph', 'Shared', 'EnvPathOverride', ENV_KEY),
            ]);
          })).then((rs) => {
            const okN = rs.filter((r) => r.status === 'fulfilled').length;
            iniProjOk += okN;
            /* 只有 env 变量 + 该机所有工程 INI 都写成功，才算这台「完整加入」、可做 guest 预连接 /
               凭据注入。否则 UE 没写上 EnvPathOverride，根本不会用共享 DDC，对它预连接是假成功。 */
            if (okN === projs.length) okMachineIds.push(mid);
            else errs.push('机器 ' + mid + '：工程 INI 部分写入失败（' + okN + '/' + projs.length + '）');
          });
        }, (e) => { fail++; errs.push('机器 ' + mid + '：' + (e && e.message ? e.message : String(e))); })
      )).then(() => {
        if (envOk === 0) throw new Error('全部目标设置失败' + (errs.length ? ' · ' + errs.join('；') : ''));
        if (iniProjExpected > 0 && iniProjOk === 0) {
          throw new Error('环境变量已设置，但工程 INI 写入全部失败' + (errs.length ? ' · ' + errs.join('；') : ''));
        }
        let managed = false;
        if (sh && sh.shareConfigId && sh.shareMode === 'managed' && okMachineIds.length) {
          managed = true;
          return prepareManagedShareClients(sh.shareConfigId, okMachineIds).then((prep) => {
            const prepFail = (prep || []).filter((r) => !r.ok);
            if (prepFail.length) {
              prepFail.forEach((r) => errs.push('机器 ' + r.client_machine_id + ' Mode B 预连接：' + (r.message || '失败')));
              throw new Error('Mode B 共享预连接失败 · ' + prepFail.length + ' 台' + (errs.length ? ' · ' + errs.join('；') : ''));
            }
            const managedWarn = prep.some((r) => r.message && r.message.indexOf('deferred') >= 0)
              ? '交互用户预连接将在下次登录时由计划任务重试'
              : null;
            return { envOk, iniProjOk, fail, okMachineIds, managed, managedWarn };
          });
        }
        if (sh && sh.shareMode === 'open' && sh.shareConfigId && okMachineIds.length) {
          /* Guest 预连接是「附加」步骤：env 变量 + 工程 INI 已写好（真正的「加入」已完成）。
             预连接失败（headless 节点 / MS 账号 / 主机慢）绝不能把已成功的 env/INI 当失败扔掉，
             只作为警告返回，不抛错。 */
          return prepareOpenShareClients(sh.shareConfigId, okMachineIds).then((prep) => {
            const prepFail = (prep || []).filter((r) => !r.ok);
            const guestWarn = prepFail.length
              ? 'Guest 预连接未即时确认 · ' + prepFail.length + '/' + (prep || []).length + ' 台（' + prepFail.map((r) => r.message || '失败').join('；') + '）'
              : null;
            return { envOk, iniProjOk, fail, okMachineIds, managed, guestPrep: !prepFail.length, guestWarn };
          }, (e) => ({ envOk, iniProjOk, fail, okMachineIds, managed, guestPrep: false, guestWarn: 'Guest 预连接调用失败（已设环境变量，登录时由计划任务重试）：' + (e && e.message ? e.message : String(e)) }));
        }
        return { envOk, iniProjOk, fail, okMachineIds, managed };
      });
    };
    const setJP = (id, kind) => setJoinPending((m) => Object.assign({}, m, { [id]: kind }));
    const clrJP = (id) => setJoinPending((m) => { const x = Object.assign({}, m); delete x[id]; return x; });
    const shareHostIds = (SHARES || []).map((sh) => sh.hostId);
    const shareSelOpts = (SHARES || []).map((sh) => ({ id: sh.id, label: sh.path, sub: sh.host }));
    const joinTargetShare = (SHARES || []).find((sh) => sh.id === joinTarget) || (SHARES || [])[0] || null;
    const joinCandidates = onlineLocalTargets.filter((n) => !shareHostIds.includes(n.id));
    const unjoinedCandidates = joinTargetShare
      ? joinCandidates.filter((n) => shareJoined[n.id] !== joinTargetShare.path && !joinPending[n.id]) : [];
    const joinShareOne = (n, sh) => {
      if (!sh || joinPending[n.id]) return;
      setJP(n.id, 'join');
      s.runCmd({ domain: 'share', action: 'join', target: n.host, chan: 'ssh', note: '加入共享 DDC · ' + sh.path },
        () => joinShareToMachines([n.machineId], sh.path, sh),
        { okMsg: (r) => n.host + ' 已加入 · 设系统环境变量' + (r.managed ? '，已预连接 Mode B 共享（交互用户+SYSTEM）' + (r.managedWarn ? '（' + r.managedWarn + '）' : '') : (r.guestPrep ? '，已预连接 Guest 共享（免凭据框）' : (r.guestWarn ? '，但 ' + r.guestWarn : ''))) })
        .then(() => { setShareJoined((m) => Object.assign({}, m, { [n.id]: sh.path })); clrJP(n.id); }, () => clrJP(n.id));
    };
    /* 退出时回滚加入写入的工程 INI——joinShareToMachines 对每台机每个工程写了
       Shared 的 Path + EnvPathOverride，退出 best-effort 移除这两个 key，避免 env 清空后
       INI 残留 dormant 共享配置。无加入前快照只能 remove（不恢复旧值）；远端 remove 是
       idempotent（缺字段/缺文件也成功）。单步失败用 allSettled 不阻断 env 清空，但返回失败
       计数供提示如实反映（不无条件宣称已回滚）。仅回滚当前 UE_PROJECTS 列出的工程——加入后被
       移出列表的工程不会被回滚（与 join 同一局限，无持久化的 join 工程快照）。 */
    const rollbackShareIni = (mid) => {
      const projs = (UE_PROJECTS || []).filter((p) => (p.machines || []).includes(String(mid)));
      /* 先删 Path 再删 EnvPathOverride：命令在 Tauri 主线程串行执行，若 Path 删成而 Override
         删败，残留「有 Override 无 Path」对 UE 安全（env 已空 → 回退本地）；反序则可能残留
         「有 Path 无 Override」，UE 会按字面 Path 继续读写共享缓存——与退出意图相反。 */
      return Promise.allSettled(projs.flatMap((p) => {
        const base = (p.locByMachine && p.locByMachine[String(mid)]) || p.root;
        const ini = String(base).replace(/\\+$/, '') + '\\Config\\DefaultEngine.ini';
        return [
          removeMachineBackendField(mid, ini, 'DerivedDataBackendGraph', 'Shared', 'Path'),
          removeMachineBackendField(mid, ini, 'DerivedDataBackendGraph', 'Shared', 'EnvPathOverride'),
        ];
      })).then((rs) => rs.filter((r) => r.status === 'rejected').length);
    };
    const leaveShareOne = (n) => {
      if (joinPending[n.id]) return;
      setJP(n.id, 'leave');
      const joinedPath = shareJoined[n.id];
      const sh = (SHARES || []).find((x) => x.path === joinedPath) || null;
      const isOpen = !!(sh && sh.shareMode === 'open' && sh.shareConfigId);
      const isManaged = !!(sh && sh.shareMode === 'managed' && sh.shareConfigId);
      s.runCmd({ domain: 'share', action: 'leave', target: n.host, chan: 'ssh', note: '退出共享 DDC' },
        /* 顺序：清 env（关键，UE 即刻回退本地）→ 回滚工程 INI（best-effort）→ 解除自动重连 +
           交互用户/SYSTEM 凭据清理（best-effort）。后两步失败不阻断「已退出」，但其真实结果会
           反映进提示，绝不无条件宣称已清理（清不掉时如实告警，避免用户误以为已彻底退出）。 */
        () => setMachineEnvVar(n.machineId, ENV_KEY, '')
          .then(() => rollbackShareIni(n.machineId))
          .then((iniFail) => {
            const unprep = isOpen ? unprepareOpenShareClients(sh.shareConfigId, [n.machineId])
              : isManaged ? unprepareManagedShareClients(sh.shareConfigId, [n.machineId])
              : Promise.resolve(null);
            return unprep.then((prep) => ({ iniFail, prep }), (e) => ({ iniFail, prepErr: e && e.message ? e.message : String(e) }));
          }),
        { okMsg: (r) => {
            let msg = n.host + ' 已退出 · 清空环境变量';
            msg += (r && r.iniFail) ? '（工程 INI 回滚 ' + r.iniFail + ' 项失败，需手动检查）' : ' · 已回滚工程 INI 接线';
            if (isManaged || isOpen) {
              const label = isManaged ? 'Mode B 凭据与自动重连' : 'Guest 自动重连';
              /* 计划任务已移除（自动重连必断），但交互用户当前会话的清理是 best-effort：
                 transport 失败 → 告警；Mode B 无交互会话时 cmdkey 残留 vault（脚本回 deferred /
                 manual cleanup），如实提示需手动清，不谎称已移除。 */
              const arr = r && Array.isArray(r.prep) ? r.prep : [];
              const failed = (r && r.prepErr) || arr.some((x) => x && !x.ok);
              const deferred = arr.some((x) => x && x.message && (x.message.indexOf('deferred') >= 0 || x.message.indexOf('manual cleanup') >= 0));
              msg += failed ? '；' + label + ' 清理未确认（best-effort，需手动检查）'
                : deferred ? '；自动重连已移除，但交互用户凭据未即时清理（无活动会话，需手动 cmdkey /delete）'
                : ' · 已移除 ' + label;
            }
            return msg;
          } })
        .then(() => { setShareJoined((m) => { const x = Object.assign({}, m); delete x[n.id]; return x; }); clrJP(n.id); }, () => clrJP(n.id));
    };
    const joinShareAll = () => {
      const sh = joinTargetShare;
      if (!sh || !unjoinedCandidates.length) return;
      const todo = unjoinedCandidates;
      const ids = todo.map((n) => n.id);
      ids.forEach((id) => setJP(id, 'join'));
      s.runCmd({ domain: 'share', action: 'join', target: ids.length + ' 台', chan: 'ssh', note: '批量加入共享 DDC · ' + sh.path },
        () => joinShareToMachines(todo.map((n) => n.machineId), sh.path, sh),
        { okMsg: (r) => '已加入 · ' + r.envOk + ' 台设环境变量' + (r.iniProjOk ? ('，写 ' + r.iniProjOk + ' 个工程 INI') : '') + (r.managed ? '，已预连接 Mode B 共享' : (r.guestPrep ? '，已预连接 Guest 共享（免凭据框）' : '')) + (r.fail ? ('，' + r.fail + ' 台失败') : '') })
        .then((r) => {
          const okSet = new Set(r.okMachineIds || []);
          setShareJoined((m) => { const x = Object.assign({}, m); todo.forEach((n) => { if (okSet.has(n.machineId)) x[n.id] = sh.path; }); return x; });
          ids.forEach(clrJP);
        }, () => ids.forEach(clrJP));
    };
    const joinRow = (n) => {
      const pend = joinPending[n.id];
      const cur = shareJoined[n.id];
      const onThis = joinTargetShare && cur === joinTargetShare.path;
      return h('div', { key: n.id, className: 'cli-row join' + (onThis ? ' on' : '') },
        CX.dot(NODE_STATUS[n.status].visual),
        h('div', { className: 'cli-meta' },
          h('div', { className: 'cli-host mono' }, n.host),
          h('div', { className: 'cli-sub' }, n.ip + ' · ' + n.role)),
        h('div', { className: 'cli-envvar mono' },
          h('span', { className: 'ev-k' }, ENV_KEY),
          h('span', { className: 'ev-eq' }, '='),
          h('span', { className: 'ev-v' + (cur ? '' : ' none') }, cur || (statusLoading ? '读取中…' : '未设置'))),
        h('div', { className: 'local-act' },
          pend === 'join' ? badge('pend', 'sync', '加入中…')
            : pend === 'leave' ? badge('pend', 'sync', '退出中…')
            : onThis ? badge('ok', 'check', '已加入')
            : cur ? badge('alt', 'link', '加入其他')
            : statusLoading ? badge('none', 'sync', '读取中…')
            : badge('none', 'minus', '未加入'),
          pend ? h('button', { className: 'mini-btn', disabled: true }, h(Icon, { name: 'sync', size: 12 }), '执行中')
            : onThis ? h('button', { className: 'mini-btn danger', onClick: () => leaveShareOne(n) }, h(Icon, { name: 'x', size: 12 }), '退出')
            : h('button', { className: 'mini-btn', onClick: () => joinShareOne(n, joinTargetShare) }, h(Icon, { name: 'link', size: 12 }), '加入')));
    };

    /* ===== ③ 本地 DDC（直接执行，真实 create_local_cache + 设 UE-LocalDataCachePath）===== */
    const setLocalDir = (id, v) => setLocalDirs((m) => Object.assign({}, m, { [id]: v }));
    /* localDirs 初值在 mount 时算（那会儿 RENDER_NODES 可能为空），机器异步到达后不会回填 →
       按机器盘符给默认值兜底，用户改过的覆盖优先。 */
    const localDirOf = (n) => localDirs[n.id] || ((/^([A-Za-z]):/.test(n.uePath || '') ? n.uePath[0].toUpperCase() : 'D') + ':\\UE_DDC\\Local');
    /* 真实本地 DDC：create_local_cache 远端建目录 + 设 ACL，再 set UE-LocalDataCachePath（Local backend
       默认带 EnvPathOverride，不必改工程 INI）；取消部署（keep_files）= 仅清空 env var，保留磁盘缓存。 */
    const deployLocalExec = (machineId, dir) =>
      createLocalCache(machineId, dir).then(() => setMachineEnvVar(machineId, 'UE-LocalDataCachePath', dir));
    const undeployLocalExec = (machineId) => setMachineEnvVar(machineId, 'UE-LocalDataCachePath', '');
    const markLP = (ids, kind) => setLocalPending((m) => { const x = Object.assign({}, m); ids.forEach((id) => { x[id] = kind; }); return x; });
    const clrLP = (ids) => setLocalPending((m) => { const x = Object.assign({}, m); ids.forEach((id) => { delete x[id]; }); return x; });
    const deployLocalOne = (n) => {
      if (localPending[n.id]) return;
      const dir = localDirOf(n);
      markLP([n.id], 'deploy');
      s.runCmd({ domain: 'local-cache', action: 'create', target: n.host, chan: 'ssh', note: '本地 DDC · ' + dir },
        () => deployLocalExec(n.machineId, dir)
          .then(() => getMachineEnvVar(n.machineId, 'UE-LocalDataCachePath').catch(() => null))
          .then((v) => ({ dir, verified: v === dir })),
        { okMsg: (r) => n.host + ' 本地 DDC 已部署 · ' + r.dir + (r.verified ? ' · 已回读校验' : '') })
        .then(() => { setLocalDeployed((d) => d.includes(n.id) ? d : d.concat(n.id)); clrLP([n.id]); }, () => clrLP([n.id]));
    };
    const undeployLocalOne = (n) => {
      if (localPending[n.id]) return;
      markLP([n.id], 'undeploy');
      s.runCmd({ domain: 'local-cache', action: 'remove', target: n.host, chan: 'ssh', note: '取消本地 DDC（缓存文件保留）· ' + n.host },
        () => undeployLocalExec(n.machineId)
          .then(() => getMachineEnvVar(n.machineId, 'UE-LocalDataCachePath').catch(() => null))
          .then((v) => ({ cleared: !v })),
        { okMsg: () => n.host + ' 本地 DDC 已取消部署 · 缓存文件保留' })
        .then(() => { setLocalDeployed((d) => d.filter((x) => x !== n.id)); clrLP([n.id]); }, () => clrLP([n.id]));
    };
    /* 多选批量（直接执行）：allSettled 容部分失败；全程 pending，落地后翻状态并清空选择。 */
    const runLocalBatch = (nodes, kind, note) => {
      const todo = nodes.filter((n) => !localPending[n.id]);
      if (!todo.length) return;
      const ids = todo.map((n) => n.id);
      markLP(ids, kind);
      const exec = kind === 'deploy'
        ? () => Promise.allSettled(todo.map((n) => deployLocalExec(n.machineId, localDirOf(n))))
        : () => Promise.allSettled(todo.map((n) => undeployLocalExec(n.machineId)));
      s.runCmd({ domain: 'local-cache', action: kind === 'deploy' ? 'create' : 'remove', target: todo.length + ' 台', chan: 'ssh', note },
        () => exec().then((rs) => { const ok = rs.filter((r) => r.status === 'fulfilled').length; if (!ok) throw new Error('全部目标失败'); return { ok, fail: rs.length - ok }; }),
        { okMsg: (r) => (kind === 'deploy' ? (r.ok + ' 台本地 DDC 已部署') : (r.ok + ' 台已取消部署 · 缓存文件保留')) + (r.fail ? ('，' + r.fail + ' 台失败') : '') })
        .then(() => { setLocalDeployed((d) => kind === 'deploy' ? Array.from(new Set(d.concat(ids))) : d.filter((x) => !ids.includes(x))); clrLP(ids); setSelLocal([]); },
              () => clrLP(ids));
    };
    /* 统一路径一键：弹居中 modal 确认 → 把全部在线机的本地路径设成 commonLocalDir，再批量部署。 */
    const applyCommonLocal = () => {
      const path = commonLocalDir.trim();
      const todo = onlineLocalTargets.filter((n) => !localPending[n.id]);
      if (!path || !todo.length) return;
      const ids = todo.map((n) => n.id);
      CX.openModalPreview(s, {
        title: '全选并统一部署本地 DDC · ' + todo.length + ' 台', icon: 'bolt', cli: 'create_local_cache --all-online', destructive: false, channel: 'ssh',
        confirmLabel: '统一部署 ' + todo.length + ' 台',
        /* run() resolve 出 {ok,fail}：部分失败也 resolve（非全挂不抛），据它如实显示，不把部分失败误报全绿 */
        doneTitle: '已部署', doneMsg: (r) => (r && r.ok != null) ? (r.ok + ' 台已统一部署 · ' + path + (r.fail ? ('，' + r.fail + ' 台失败') : '')) : (todo.length + ' 台已统一设置并部署 · ' + path),
        steps: ['把 ' + todo.length + ' 台在线机的本地 DDC 路径统一设为 ' + path, '在每台机器上创建本地缓存层（create_local_cache）', '写入后自动回读校验命中链路'],
        simpleScope: todo.map((n) => ({ host: n.host, ip: n.ip, msg: path })),
        run: () => {
          setLocalDirs((m) => { const x = Object.assign({}, m); ids.forEach((id) => { x[id] = path; }); return x; });
          markLP(ids, 'deploy');
          return s.runCmd({ domain: 'local-cache', action: 'create', target: todo.length + ' 台', chan: 'ssh', note: '统一本地 DDC 路径并部署（' + todo.length + ' 台）· ' + path },
            () => Promise.allSettled(todo.map((n) => deployLocalExec(n.machineId, path))).then((rs) => { const ok = rs.filter((r) => r.status === 'fulfilled').length; if (!ok) throw new Error('全部目标部署失败'); return { ok, fail: rs.length - ok }; }),
            { okMsg: (r) => r.ok + ' 台已统一部署 · ' + path + (r.fail ? ('，' + r.fail + ' 台失败') : '') })
            .then((r) => { setLocalDeployed((d) => Array.from(new Set(d.concat(ids)))); clrLP(ids); setSelLocal([]); return r; }, (e) => { clrLP(ids); throw e; });
        },
      });
    };
    const onlineIds = onlineLocalTargets.map((n) => n.id);
    const allSel = onlineIds.length > 0 && onlineIds.every((id) => selLocal.includes(id));
    const someSel = selLocal.length > 0;
    const toggleLocalSel = (id) => setSelLocal((sl) => sl.includes(id) ? sl.filter((x) => x !== id) : sl.concat(id));
    const toggleAllLocal = () => setSelLocal(allSel ? [] : onlineIds.slice());
    const selNodes = onlineLocalTargets.filter((n) => selLocal.includes(n.id));
    const selDeployedNodes = selNodes.filter((n) => localDeployed.includes(n.id));
    const selUndeployedNodes = selNodes.filter((n) => !localDeployed.includes(n.id));

    const localRow = (n) => {
      const dep = localDeployed.includes(n.id);
      const off = n.status === 'offline';
      const isSel = selLocal.includes(n.id);
      const pend = localPending[n.id];
      return h('div', { key: n.id, className: 'cli-row local' + (off ? ' off' : '') + (isSel ? ' sel' : (dep ? ' on' : '')) },
        off ? h('span', { className: 'lcheck dis' }, h('span', { className: 'proj-mck dis' }))
          : h('button', { className: 'lcheck', title: isSel ? '取消选择' : '选择', onClick: () => toggleLocalSel(n.id) },
              h('span', { className: 'proj-mck' + (isSel ? ' on' : '') }, isSel ? h(Icon, { name: 'check', size: 12 }) : null)),
        CX.dot(NODE_STATUS[n.status].visual),
        h('div', { className: 'cli-meta' },
          h('div', { className: 'cli-host mono' }, n.host),
          h('div', { className: 'cli-sub' }, n.ip + ' · ' + n.role)),
        h('input', { className: 'cli-pathin mono', value: localDirOf(n), disabled: off,
          spellCheck: false, onChange: (e) => setLocalDir(n.id, e.target.value) }),
        h('div', { className: 'local-act' },
          off ? badge('off', 'power', '离线')
            : pend === 'deploy' ? badge('pend', 'sync', '部署中…')
            : pend === 'undeploy' ? badge('pend', 'sync', '取消中…')
            : statusLoading ? badge('none', 'sync', '读取中…')
            : dep ? badge('ok', 'check', '已部署')
            : badge('none', 'minus', '未部署'),
          off ? null
            : pend ? h('button', { className: 'mini-btn', disabled: true }, h(Icon, { name: 'sync', size: 12 }), '执行中')
            : dep ? h(React.Fragment, null,
                h('button', { className: 'mini-btn', onClick: () => deployLocalOne(n) }, h(Icon, { name: 'sync', size: 12 }), '重新部署'),
                h('button', { className: 'mini-btn danger', onClick: () => undeployLocalOne(n) }, h(Icon, { name: 'trash', size: 12 }), '取消部署'))
              : h('button', { className: 'mini-btn', onClick: () => deployLocalOne(n) }, h(Icon, { name: 'bolt', size: 12 }), '部署')));
    };

    return h('div', { className: 'res ddc' },
      h('div', { className: 'canvas-head' },
        h('span', { className: 't' }, 'DDC · 文件系统 DDC'),
        h('div', { className: 'right' },
          h(Button, { variant: 'secondary', size: 'S', icon: h(Icon, { name: 'sync', size: 14 }), isDisabled: statusLoading, onPress: readStatus }, statusLoading ? '读取中…' : '刷新状态'))),
      h('div', { className: 'ddc-body' },
        h('div', { className: 'zen-2col' },
          /* 左列：① 共享 DDC 服务器部署 + 已纳管共享 + ② 其他服务器加入 */
          h('div', { className: 'zen-col' },
            h('div', { className: 'ddc-sec-h' }, h('span', null, '① 共享 DDC（SMB）'), h('span', { className: 'dim' }, '先立一台机器为共享 DDC 服务器 · 创建网络共享映射路径，其余机器再加入')),
            smbPanel,
            SHARES.length ? h(React.Fragment, null,
              h('div', { className: 'ddc-sec-h' }, h('span', null, '已纳管的共享服务器'), h('span', { className: 'dim' }, SHARES.length + ' 台 · 每台共享 DDC 服务器都可单独取消 · 取消不删除远端文件夹')),
              h('div', { className: 'art-list' }, SHARES.map(shareRow))) : null,
            SHARES.length ? h(React.Fragment, null,
              h('div', { className: 'ddc-sec-h' },
                h('span', null, '② 其他服务器加入共享 DDC'),
                h('span', { className: 'dim' }, joinCandidates.filter((n) => joinTargetShare && shareJoined[n.id] === joinTargetShare.path).length + ' / ' + joinCandidates.length + ' 已加入 · 写环境变量 ' + ENV_KEY + ' 指向共享路径')),
              h('div', { className: 'cli-panel' },
                h('div', { className: 'cli-top' },
                  h('div', { className: 'cli-server-chip' },
                    h('span', { className: 'csc-ico' }, h(Icon, { name: 'folder', size: 15 })),
                    h('div', { style: { minWidth: 0 } },
                      h('div', { className: 'csc-t' }, '加入目标 · ' + (joinTargetShare ? joinTargetShare.host : '—')),
                      h('div', { className: 'csc-s mono' }, joinTargetShare ? joinTargetShare.path : '—'))),
                  SHARES.length > 1 ? h('div', { className: 'dp-field' }, h('label', null, '共享服务器'),
                    h(Selector, { kpre: '共享', value: joinTargetShare ? joinTargetShare.id : null, options: shareSelOpts, width: 240, onChange: setJoinTarget })) : null,
                  h('div', { className: 'cli-go' },
                    h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'link', size: 14 }), isDisabled: unjoinedCandidates.length === 0, onPress: joinShareAll },
                      '全部加入（' + unjoinedCandidates.length + '）'))),
                h('div', { className: 'cli-note' }, h(Icon, { name: 'shield', size: 13 }),
                  '加入 = 在该机设机器级系统环境变量 ' + ENV_KEY + ' 指向共享路径；Mode A 会预存 Guest 空密码会话（cmdkey + net use，资源管理器直接输入 UNC 不再弹框）；Mode B 会为计算机名与 IP 注入 ddc-svc 凭据；运行中的 UE 需重启生效。退出仅清除变量（不撤销已预连接会话）。'),
                h('div', { className: 'cli-list' }, joinCandidates.map(joinRow)))) : null),
          /* 右列：③ 本地 DDC */
          h('div', { className: 'zen-col' },
            h('div', { className: 'ddc-sec-h' },
              h('span', null, '③ 本地 DDC'),
              h('span', { className: 'dim' }, localDeployed.length + ' / ' + RENDER_NODES.length + ' 已部署 · 可逐台设置，或用上方统一路径一键应用到全部')),
            h('div', { className: 'cli-panel' },
              h('div', { className: 'cli-top' },
                h('div', { className: 'local-hint' }, h(Icon, { name: 'server', size: 15 }), '逐台本地缓存回退层 · 命中链路兜底'),
                h('div', { className: 'cli-unify' },
                  h('label', null, '统一路径'),
                  h('input', { className: 'dp-input mono', value: commonLocalDir, spellCheck: false, onChange: (e) => setCommonLocalDir(e.target.value), style: { width: 188 } }),
                  h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'bolt', size: 14 }), isDisabled: !commonLocalDir.trim() || onlineLocalTargets.filter((n) => !localPending[n.id]).length === 0, onPress: applyCommonLocal },
                    '全选并统一部署（' + onlineLocalTargets.length + '）'))),
              h('div', { className: 'cli-note' }, h(Icon, { name: 'shield', size: 13 }),
                '本地 DDC 作为命中链路的回退层；部署链路在后台逐步执行，写入后自动回读校验。'),
              h('div', { className: 'local-selbar' + (someSel ? ' on' : '') },
                h('button', { className: 'lsb-all', onClick: toggleAllLocal },
                  h('span', { className: 'proj-mck' + (allSel ? ' on' : (someSel ? ' part' : '')) },
                    allSel ? h(Icon, { name: 'check', size: 12 }) : (someSel ? h(Icon, { name: 'minus', size: 12 }) : null)),
                  allSel ? '取消全选' : '全选在线机'),
                h('span', { className: 'lsb-ct' }, someSel
                  ? ('已选 ' + selLocal.length + ' 台 · ' + selDeployedNodes.length + ' 已部署 / ' + selUndeployedNodes.length + ' 未部署')
                  : '勾选机器后可批量部署或一键取消部署'),
                h('div', { className: 'lsb-acts' },
                  h(Button, { variant: 'secondary', size: 'S', icon: h(Icon, { name: 'bolt', size: 13 }), isDisabled: selUndeployedNodes.length === 0, onPress: () => runLocalBatch(selUndeployedNodes, 'deploy', '批量部署本地 DDC（' + selUndeployedNodes.length + ' 台）') }, '部署所选（' + selUndeployedNodes.length + '）'),
                  h(Button, { variant: 'negative', size: 'S', icon: h(Icon, { name: 'trash', size: 13 }), isDisabled: selDeployedNodes.length === 0, onPress: () => runLocalBatch(selDeployedNodes, 'undeploy', '批量取消本地 DDC（' + selDeployedNodes.length + ' 台）') }, '取消部署所选（' + selDeployedNodes.length + '）'))),
              h('div', { className: 'cli-list' }, IP_SORTED_NODES.map(localRow)))))));
  }

  /* =================== center router =================== */
  function ddc(s) {
    const view = /^ddc_/.test(s.cacheNav) ? s.cacheNav : 'ddc_zen';
    if (view === 'ddc_zen') return window.VOLO_CACHE_ZEN.view(s);
    if (view === 'ddc_legacy') return h(LegacyView, { s });
    if (view === 'ddc_pak') return h(PakMaster, { s });
    return h(PsoMaster, { s });
  }

  /* =================== inspector router (right column) =================== */
  function detail(s) {
    if (s.cacheNav === 'ddc_pak') return h(PakDetail, { s });
    if (s.cacheNav === 'ddc_pso') return h(PsoDetail, { s });
    return null;
  }

  window.VOLO_CACHE_DDC = { ddc, detail };
})();

export {};
