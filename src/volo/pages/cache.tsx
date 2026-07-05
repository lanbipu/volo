// @ts-nocheck
/* Volo — Cache · 任务中心 + 资产域 + 常驻任务抽屉.
   1:1 port of the Claude Design handoff `src/page_cache.jsx`. Owns the shared
   cache helpers (window.VOLO_CX), the dual-layer left nav, the context bar,
   the landing page, the center router, the task drawer (right column) and the
   overlay dispatch (preview / machine detail). Machine + DDC pages live in
   cacheMachines.tsx / cacheDdc.tsx. */
import * as React from "react";
import "../ds";
import { saveCredential, deleteCredential, deleteMachine, refreshMachine,
  getWinrmBootstrapScript, getMachineDetail, scanNetwork, addDiscoveredMachine,
  runHealthCheck, scanInis, applyFinding, getMachineEnvVar, readIniSection,
  packageSshBootstrap, pickDirectory, revealPath, setUeRuntimeUser } from "../api/commands";

(function () {
  const { Button, Badge } = window.Spectrum2DesignSystem_b6d1b3;
  const { useState, useEffect } = React;
  const h = React.createElement;
  /* CX is published as window.VOLO_CX; bind a stable reference up-front so the
     page's own `CX.openPreview(...)` calls (and cacheMachines/cacheDdc which
     read window.VOLO_CX) all share one object. Populated via Object.assign at
     the end of this module. */
  const CX = (window.VOLO_CX = window.VOLO_CX || {});

  /* =================== shared primitives =================== */
  const dot = (visual) => h('span', { className: 'sdot bg-' + visual });
  const healthVisual = (v) => v >= 85 ? 'positive' : v >= 60 ? 'notice' : 'negative';
  const SEV = {
    critical: { visual: 'negative', label: '严重', icon: 'alert' },
    warning:  { visual: 'notice',   label: '警告', icon: 'alert' },
    info:     { visual: 'informative', label: '提示', icon: 'eye' },
    healthy:  { visual: 'positive', label: '正常', icon: 'check' },
    na:       { visual: 'neutral',  label: '不适用', icon: 'minus' },
  };
  function StatusPill({ status }) {
    const m = NODE_STATUS[status] || SEV[status];
    return h('span', { className: 'spill spill--' + m.variant },
      m.icon === 'minus' ? h('span', { style: { fontWeight: 700 } }, '—') : h(Icon, { name: m.icon, size: 13 }), m.label);
  }
  function SevPill({ sev }) {
    const m = SEV[sev];
    return h('span', { className: 'spill spill--' + m.visual },
      m.icon === 'minus' ? h('span', { style: { fontWeight: 700 } }, '—') : h(Icon, { name: m.icon, size: 12 }), m.label);
  }
  function ChannelTag({ ch, mini }) {
    const c = CHANNEL[ch] || CHANNEL.winrm;
    return h('span', { className: 'chan-tag chan-' + ch + (mini ? ' mini' : ''), title: c.note },
      h(Icon, { name: c.icon, size: mini ? 11 : 12 }), c.label);
  }
  function ringStyle(v, deg) {
    const col = `var(--${healthVisual(v)}-visual)`;
    return { background: `conic-gradient(${col} ${v * 3.6}deg, var(--track) 0)` };
  }
  const node = (id) => RENDER_NODES.find((n) => n.id === id);

  /* ---- unified machine selector (pattern 5.3) ---- */
  function MachineSelector({ value, onChange }) {
    const roleKeys = Object.keys(ROLES);
    const [roleF, setRoleF] = useState(null);
    const pool = RENDER_NODES.filter((n) => !roleF || n.roleKey === roleF);
    const toggle = (id) => onChange(value.includes(id) ? value.filter((x) => x !== id) : value.concat(id));
    const allOn = pool.every((n) => value.includes(n.id));
    const toggleAll = () => onChange(allOn ? value.filter((id) => !pool.some((n) => n.id === id)) : Array.from(new Set(value.concat(pool.map((n) => n.id)))));
    return h('div', { className: 'mach-sel' },
      h('div', { className: 'mach-sel-bar' },
        h('span', { className: 'mfilter' + (!roleF ? ' on' : ''), onClick: () => setRoleF(null) }, '全部'),
        roleKeys.map((rk) => h('span', { key: rk, className: 'mfilter' + (roleF === rk ? ' on' : ''), onClick: () => setRoleF(roleF === rk ? null : rk) }, ROLES[rk].label)),
        h('span', { className: 'mfilter ghost', onClick: toggleAll, style: { marginLeft: 'auto' } }, allOn ? '取消全选' : '全选')),
      h('div', { className: 'mach-sel-list' },
        pool.map((n) => h('div', { key: n.id, className: 'mach-opt' + (value.includes(n.id) ? ' on' : '') + (n.status === 'offline' ? ' off' : ''), onClick: () => toggle(n.id) },
          h('span', { className: 'mck' }, value.includes(n.id) ? h(Icon, { name: 'check', size: 12 }) : null),
          dot(NODE_STATUS[n.status].visual),
          h('span', { className: 'mh' }, n.host),
          h('span', { className: 'mip' }, n.ip)))));
  }

  /* predicted per-machine outcome for an op over a scope */
  function predict(ids, destructive) {
    return ids.map((id) => {
      const n = node(id);
      if (!n) return null;
      if (n.status === 'offline') return { n, icon: 'minus', vis: 'neutral', msg: '离线 · 跳过', skip: true };
      if (n.status === 'critical') return { n, icon: 'alert', vis: 'negative', msg: destructive ? '冲突 · 需先修' : '将先修复后应用' };
      if (n.status === 'warning') return { n, icon: 'sync', vis: 'notice', msg: '待应用 · 可能需重启' };
      return { n, icon: 'check', vis: 'positive', msg: '就绪 · 可应用' };
    }).filter(Boolean);
  }

  /* open the preview→confirm→execute overlay (pattern 5.1) */
  function showInspector(s) { if (s.setRightCollapsed) s.setRightCollapsed(false); }
  function openPreview(s, spec) { showInspector(s); s.setDrawer(Object.assign({ kind: 'preview' }, spec)); }
  /* same spec, but as a centered modal dialog (preview → 实时进度 → 成功/失败) instead of
     the inspector drawer. 部署 / 修复 / 巡检类操作走此（见 ModalPreview）。 */
  function openModalPreview(s, spec) { s.setModal(Object.assign({ kind: 'preview' }, spec)); }

  /* =================== cluster status + actions =================== */
  /* 真实「立即巡检」：顺序跑 scan_inis → run_health_check（后端已改 async，不冻结 UI）。
     machine_ids 取在线非共享机；credential_alias 走 SSH key 传 ''；project_paths 从已加载
     工程的 root 取（避免无 UE 安装机 scan_inis 报 0 文件）。完成后 reloadCache 拉新结果。
     · 串行而非并行：健康检查的 ini_consistency 探测读 DB 里最新 INI 结果，先扫 INI 再巡检才不读旧数据；
       两条都对同批机器开远程会话，串行更稳。
     · 局部失败不掩成全绿：记录失败项，仅两条全挂才整体失败，否则 okMsg 显式标「部分完成 + 原因」。 */
  /* 真实健康巡检的执行体（scan_inis → run_health_check），返回 runCmd promise（成功后 reloadCache）。
     供「立即巡检」modal 与健康项「处理」modal 复用——不直接弹 modal，由调用方包进 openModalPreview。 */
  function healthScanRun(s) {
    const nodes = RENDER_NODES.filter((n) => n.roleKey !== 'shared' && n.status !== 'offline');
    const ids = nodes.map((n) => n.machineId).filter((x) => x != null && x !== 0);
    if (!ids.length) return Promise.reject(new Error('没有在线机器可巡检'));
    const roots = Array.from(new Set((window.UE_PROJECTS || []).map((p) => p.root).filter((r) => r && r !== '—')));
    return s.runCmd({ domain: 'health', action: 'run', target: ids.length + ' 台', chan: 'winrm', note: '健康巡检 + INI 一致性检查' },
      async () => {
        const fail = [];
        try { await scanInis({ machine_ids: ids, credential_alias: '', project_paths: roots, user_profile_path: null }); }
        catch (e) { fail.push('INI 检查（' + (e && e.message ? e.message : String(e)) + '）'); }
        try { await runHealthCheck({ machine_ids: ids, credential_alias: '', project_paths: roots, expected_local_path: null, expected_shared_path: null }); }
        catch (e) { fail.push('健康巡检（' + (e && e.message ? e.message : String(e)) + '）'); }
        if (fail.length === 2) throw new Error('巡检与 INI 检查均失败');
        return fail;
      },
      { okMsg: (fail) => fail.length ? ('部分完成 · ' + fail.join(' / ') + ' 失败，其余结果已更新') : '巡检完成 · 已更新健康与 INI 结果' })
      .then((fail) => { s.reloadCache(); return fail; });
  }
  /* 「立即巡检」改弹居中二级对话框（autostart：点击即进进度阶段），进度 / 成功 / 失败都在对话框内呈现。 */
  function refreshScan(s) {
    const nodes = RENDER_NODES.filter((n) => n.roleKey !== 'shared' && n.status !== 'offline');
    if (!nodes.map((n) => n.machineId).filter((x) => x != null && x !== 0).length) return;
    openModalPreview(s, {
      title: '立即巡检集群', icon: 'sync', cli: 'scan_inis → run_health_check', destructive: false, channel: 'winrm', autostart: true,
      /* healthScanRun resolve 出 fail 数组：部分失败也 resolve（非全挂不抛），故据它如实区分全绿 / 部分完成 */
      doneTitle: '巡检完成', doneMsg: (fail) => (fail && fail.length) ? ('部分完成 · ' + fail.join(' / ') + ' 失败，其余结果已更新') : '已更新集群健康与 INI 一致性结果',
      steps: ['扫描各机 INI 配置一致性（scan_inis）', '运行 L1 / L2 / L3 健康巡检并汇总（run_health_check）', '回填集群健康与待处理问题'],
      run: () => healthScanRun(s),
    });
  }
  function clusterChips() {
    const hv = CLUSTER.health;
    const lv = hv == null ? 'not' : hv >= 85 ? 'pos' : hv >= 60 ? 'not' : 'neg';
    return h('div', { className: 'cluster-sum' },
      h('span', { className: 'sum-grp' }, dot('positive'), '在线 ',
        h('b', null, CLUSTER.online), h('span', { className: 'frac' }, '/' + CLUSTER.total)),
      h('span', { className: 'health-chip lv-' + lv },
        h(Icon, { name: 'pulse', size: 14 }), '健康分 ', h('b', null, hv == null ? '—' : hv)));
  }
  function actions(s) {
    const fresh = s.freshSetup && !s.machinesAdded;
    if (fresh) return h('div', { className: 'ctx-actions' },
      h('span', { className: 'snap-note', title: '集群里还没有机器，巡检无从谈起' },
        h(Icon, { name: 'node', size: 13 }), '空集群 · 先添加机器'),
      h(Button, { variant: 'secondary', size: 'S', icon: h(Icon, { name: 'sync', size: 15 }), isDisabled: true }, '立即巡检'));
    return h('div', { className: 'ctx-actions' },
      clusterChips(),
      h('span', { className: 'snap-note', title: '状态为上次巡检的缓存快照，非实时轮询' },
        h(Icon, { name: 'eye', size: 13 }), '快照 · ' + CLUSTER.lastRunAgo));
  }
  const MODULE = (nav) => CACHE_MODULES.find((m) => m.id === nav) || CACHE_MODULES[0];
  function ctx(s) {
    let icon, title, sub;
    if (/^ddc_/.test(s.cacheNav)) {
      const d = DDC_NAV.find((x) => x.id === s.cacheNav) || DDC_NAV[0];
      icon = d.icon; title = d.label; sub = 'Cache · DDC';
    } else {
      const m = MODULE(s.cacheNav); icon = m.icon; title = m.label; sub = 'Cache · ' + m.sub;
    }
    return h(React.Fragment, null,
      h(CtxTitle, { icon, title, sub }),
      h('div', { className: 'ctx-div' }),
      actions(s));
  }

  /* =================== left · nav（4 模块 · DDC 管理为折叠菜单）=================== */
  function left(s) {
    const leaf = (m) => h('div', { key: m.id, className: 'nav-i nav-mod' + (s.cacheNav === m.id ? ' on' : ''), onClick: () => s.setCacheNav(m.id) },
      h('span', { className: 'nav-ico' }, h(Icon, { name: m.icon, size: 17 })),
      h('span', { className: 'nav-lbl' }, m.label),
      h('span', { className: 'nav-sub' }, m.sub));
    const child = (d) => h('div', { key: d.id, className: 'nav-i nav-child' + (s.cacheNav === d.id ? ' on' : ''), onClick: () => s.setCacheNav(d.id) },
      h('span', { className: 'nav-ico' }, h(Icon, { name: d.icon, size: 15 })),
      h('span', { className: 'nav-lbl' }, d.label));
    return h(React.Fragment, null,
      h('div', { className: 'sect' },
        h('div', { className: 'sect-h' }, h('span', { className: 't' }, 'Cache · 缓存')),
        CACHE_MODULES.map((m) => {
          if (m.id !== 'ddc') return leaf(m);
          return h(React.Fragment, { key: 'ddc' },
            h('div', { className: 'nav-i nav-mod nav-head' },
              h('span', { className: 'nav-ico' }, h(Icon, { name: m.icon, size: 17 })),
              h('span', { className: 'nav-lbl' }, m.label)),
            h('div', { className: 'nav-children' }, DDC_NAV.map(child)));
        })));
  }

  /* =================== 集群总览 (Cluster Overview) · 全局概览 + 机器管理 =================== */
  /* fresh-setup 判定：开启「全新设置」且本会话尚未加入机器 → 空集群引导 */
  const isFresh = (s) => s.freshSetup && !s.machinesAdded;

  function Overview({ s }) {
    const [scanOpen, setScanOpen] = useState(false);
    const onScan = () => setScanOpen(true);
    /* 扫描向导挂在所有分支（error / loading / 空集群 / 已有机器）共享的稳定兄弟位上：加入机器时
       confirmAdd 会触发 setMachinesAdded + reloadCache，外层因此在「空集群引导 ↔ 加载态 ↔ 总览」
       间切换。若向导跟着某一分支的子树渲染，分支一变就被 React 卸载重挂，done 步（已加入 N 台）状态
       丢失、对话框瞬间消失。用 Fragment 把它固定在 index 1，分支只换 index 0 的 body，向导不重挂。 */
    const wizard = scanOpen ? window.VOLO_CACHE_MACHINES.ScanWizard({ s, onClose: () => setScanOpen(false) }) : null;
    const wrap = (content) => h(React.Fragment, null, content, wizard);
    /* three-channel gate (色 + 图标 + 文字) over the backend read-path load */
    if (s.cacheError) return wrap(h('div', { className: 'dash' },
      h('div', { className: 'dash-card', style: { padding: 22, display: 'flex', gap: 14, alignItems: 'center' } },
        h('span', { className: 's-negative', style: { display: 'flex' } }, h(Icon, { name: 'alert', size: 22 })),
        h('div', { style: { minWidth: 0, flex: 1 } },
          h('div', { style: { fontWeight: 700, marginBottom: 3 } }, '加载集群数据失败'),
          h('div', { style: { fontSize: 12, color: 'var(--chrome-dim)', wordBreak: 'break-word' } }, s.cacheError)),
        h(Button, { variant: 'secondary', size: 'M', icon: h(Icon, { name: 'sync', size: 15 }), onPress: s.reloadCache }, '重试'))));
    if (s.cacheLoading) return wrap(h('div', { className: 'dash' },
      h('div', { className: 'dash-card', style: { padding: 22, display: 'flex', gap: 14, alignItems: 'center' } },
        h('span', { className: 's-informative', style: { display: 'flex' } }, h('span', { className: 'spin' }, h(Icon, { name: 'sync', size: 20 }))),
        h('div', null,
          h('div', { style: { fontWeight: 700, marginBottom: 3 } }, '正在加载集群数据…'),
          h('div', { style: { fontSize: 12, color: 'var(--chrome-dim)' } }, '从后端读取 机器 / 凭据 / 共享')))));
    const fresh = isFresh(s);

    /* ---------- 空集群引导：先扫描添加机器，巡检才有意义 ---------- */
    if (fresh) {
      const step = (n, icon, title, desc, on) => h('div', { className: 'ce-step' + (on ? ' on' : '') },
        h('span', { className: 'ce-step-n' }, on ? h(Icon, { name: 'arrowr', size: 13 }) : n),
        h('span', { className: 'ce-step-ico' }, h(Icon, { name: icon, size: 18 })),
        h('div', { className: 'ce-step-txt' }, h('div', { className: 'ce-step-t' }, title), h('div', { className: 'ce-step-d' }, desc)));
      return wrap(h('div', { className: 'dash' },
        h('div', { className: 'cluster-empty' },
          h('div', { className: 'ce-ico' }, h(Icon, { name: 'node', size: 36, stroke: 1.3 })),
          h('div', { className: 'ce-t' }, '集群里还没有机器'),
          h('div', { className: 'ce-d' }, '先扫描局域网，发现并加入机器。没有机器，巡检与缓存管理都无从谈起 —— 添加机器是第一步。'),
          h('div', { className: 'ce-acts' },
            h(Button, { variant: 'accent', size: 'L', icon: h(Icon, { name: 'search', size: 16 }), onPress: onScan }, '扫描局域网…')),
          h('div', { className: 'ce-steps' },
            step(1, 'search',   '扫描网段',   '输入 IP 或 CIDR，探活发现未纳管设备', true),
            step(2, 'download', '选择并加入', '勾选要纳管的机器，加入机器列表', false),
            step(3, 'pulse',    '巡检与部署', '机器就位后，才能巡检健康、部署缓存', false)))));
    }

    /* ---------- 已有机器：全局概览 + 机器管理 ---------- */
    const cluster = RENDER_NODES.filter((n) => n.roleKey !== 'shared');
    const online = cluster.filter((n) => n.status !== 'offline');
    const offlineCt = cluster.filter((n) => n.status === 'offline').length;
    const alerts = HEALTH_CHECKS.filter((c) => c.status === 'critical' || c.status === 'warning').length
      + INI_FINDINGS.filter((f) => f.sev !== 'info').length;
    const overall = HEALTH_CHECKS.some((c) => c.status === 'critical') ? 'critical'
      : HEALTH_CHECKS.some((c) => c.status === 'warning') ? 'warning' : 'healthy';
    /* 健康项无「一键修复」后端命令（remediation 是建议文案）：弹 modal 展示建议，确认后重新巡检验证。 */
    const fixCheck = (c) => CX.openModalPreview(s, {
      title: '处理 · ' + c.label, icon: 'pulse', cli: 'scan_inis → run_health_check', destructive: false, channel: 'winrm', confirmLabel: '重新巡检',
      doneTitle: '已重新巡检', doneMsg: (fail) => (fail && fail.length) ? ('部分完成 · ' + fail.join(' / ') + ' 失败，已尽力重新评估该项') : '已重新评估该项 · 请在「待处理问题」中确认是否恢复',
      steps: [c.remediation || '按提示在目标机处理后重新巡检', '巡检会重新评估这一项是否恢复'],
      simpleScope: [{ host: c.label, ip: c.layer, msg: c.remediation || '—' }],
      run: () => healthScanRun(s),
    });
    /* 真实 apply_finding：写远端 INI（先备份）；需真实数字 findingId（来自 list_findings）。改弹居中 modal。 */
    const fixIni = (f) => CX.openModalPreview(s, {
      title: '应用修复 · ' + f.rule + ' · ' + f.machine, icon: 'pulse', cli: 'apply_finding', destructive: false, channel: 'ssh', confirmLabel: '应用修复',
      doneTitle: '修复完成', doneMsg: f.id + ' 已修复 · ' + f.cur + ' → ' + f.rec,
      steps: [f.file + ' ' + f.section + '：' + f.cur + ' → ' + f.rec, '后端先创建 .bak.<时间戳> 备份再写，应用后自动 re-scan'],
      simpleScope: [{ host: f.machine, ip: f.file, msg: f.rec }],
      run: () => {
        if (f.findingId == null) return Promise.reject(new Error('缺少 findingId（请先重新巡检以获取可修复项）'));
        return s.runCmd({ domain: 'ini', action: 'apply', target: f.machine + ' · ' + f.file, chan: 'ssh', note: f.rule + ' ' + f.cur + ' → ' + f.rec },
          () => applyFinding(f.findingId, ''), { okMsg: (backup) => '已修复 · 备份 ' + backup })
          .then((r) => { s.reloadCache(); return r; });
      },
    });

    /* 只列「巡检发现有问题、需要处理」的事项：健康调查结果 + INI 一致性检查，各带一键修复 */
    const sevRank = { critical: 0, warning: 1 };
    const healthProblems = HEALTH_CHECKS
      .filter((c) => c.status === 'critical' || c.status === 'warning')
      .map((c) => ({ key: 'h_' + c.id, src: '健康', tech: c.tech, sev: c.status,
        label: c.label, detail: c.hint || c.detail, affected: c.detail, onFix: () => fixCheck(c) }));
    const iniProblems = INI_FINDINGS
      .filter((f) => f.sev === 'critical' || f.sev === 'warning')
      .map((f) => ({ key: 'i_' + f.id, src: '配置', tech: f.rule, sev: f.sev,
        label: f.summary, detail: f.why, affected: f.machine, onFix: () => fixIni(f) }));
    const problems = [...healthProblems, ...iniProblems].sort((a, b) => sevRank[a.sev] - sevRank[b.sev]);
    const critCt = problems.filter((p) => p.sev === 'critical').length;
    const warnCt = problems.length - critCt;
    const kpi = (icon, k, big, bigTone, note, noteTone) => h('div', { className: 'kpi' },
      h('div', { className: 'kpi-h' }, h('span', { className: 'kpi-ico' }, h(Icon, { name: icon, size: 15 })), h('span', { className: 'kpi-k' }, k)),
      h('div', { className: 'kpi-v' + (bigTone ? ' ' + bigTone : '') }, big),
      h('div', { className: 'kpi-note' + (noteTone ? ' ' + noteTone : '') }, note));
    const meter = (k, v, pct, variant) => h('div', { className: 'im' },
      h('div', { className: 'im-top' }, h('span', null, k), h('span', null, v)),
      h('div', { className: 'vmeter vmeter--' + variant }, h('div', { className: 'vmeter__fill', style: { width: pct + '%' } })));

    return wrap(h('div', { className: 'dash' },
      /* 1 · 集群健康总览条 */
      h('div', { className: 'land-status hero-' + overall },
        h('div', { className: 'ls-badge s-' + SEV[overall].visual }, h(Icon, { name: SEV[overall].icon, size: 24 })),
        h('div', { className: 'ls-main' },
          h('div', { className: 'ls-line' },
            h('b', null, CLUSTER.online + ' 台在线'), h('span', { className: 'dim' }, ' / '),
            h('span', null, offlineCt + ' 台离线'), h('span', { className: 'dim' }, ' · '),
            h('b', { className: 's-' + (alerts ? 'notice' : 'positive') }, alerts + ' 项告警')),
          h('div', { className: 'ls-sub' }, '后台自动巡检 · 上次 ' + CLUSTER.lastRun + '（' + CLUSTER.lastRunAgo + '）· 缓存快照，非实时轮询')),
        h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'sync', size: 15 }), onPress: () => refreshScan(s) }, '立即巡检')),

      /* 2 · 关键指标小卡 —— 一律给“准确台数 / 计数”，无 per-机命中率（后端无此指标） */
      (() => {
        const totalCt   = cluster.length;
        const onlineCt  = online.length;
        const allOnline = offlineCt === 0;
        /* GPU 一致性来自 get_gpu_consistency_matrix（DB 读，无 SSH）。NodeVM.driver 是
           占位 '—'，不可作来源；signature===null 的机器=无 GPU 数据，不计入分母。 */
        const gm        = window.GPU_MATRIX;
        const gpuCells  = gm && Array.isArray(gm.cells) ? gm.cells.filter((c) => c.signature) : [];
        const gpuTotal  = gpuCells.length;
        const gpuMatch  = gpuCells.filter((c) => c.status === 'match').length;
        const gpuOk     = gpuTotal > 0 && gpuMatch === gpuTotal;
        const baseDriver = gm && gm.baseline ? gm.baseline.driver : '—';
        const probTone  = problems.length === 0 ? 's-positive' : critCt ? 's-negative' : 's-notice';
        return h('div', { className: 'dash-kpis' },
          kpi('node', '节点在线',
            onlineCt + ' / ' + totalCt + ' 台',
            allOnline ? 's-positive' : 's-negative',
            allOnline ? '全部在线' : (offlineCt + ' 台离线 · ' + onlineCt + ' 台在线'),
            allOnline ? 's-positive' : 's-negative'),
          kpi('cpu', 'GPU 一致性',
            gpuTotal ? (gpuMatch + ' / ' + gpuTotal + ' 匹配') : '—',
            gpuTotal === 0 ? null : gpuOk ? 's-positive' : 's-notice',
            gpuTotal === 0 ? '暂无 GPU 数据' : gpuOk ? ('驱动全部对齐基线 ' + baseDriver) : ((gpuTotal - gpuMatch) + ' 台驱动偏离基线 ' + baseDriver),
            gpuTotal === 0 ? null : gpuOk ? 's-positive' : 's-notice'),
          kpi('alert', '待处理问题',
            problems.length + ' 项',
            probTone,
            problems.length === 0 ? '全部检查通过' : (critCt + ' 严重 · ' + warnCt + ' 警告'),
            probTone),
          kpi('eye', '上次巡检快照',
            CLUSTER.lastRun,
            null,
            CLUSTER.lastRunAgo + ' · 缓存快照',
            null));
      })(),

      /* 3 · 机器管理（扫描 / 加入 / 列表 / 部署环境） */
      window.VOLO_CACHE_MACHINES.section(s, onScan),

      /* 4 · 诊断健康面板 | 缓存状态 + 最近任务 */
      h('div', { className: 'dash-grid dash-grid--diag' },
        h('div', { className: 'dash-card diag-card' },
          h('div', { className: 'dc-h' },
            h('span', { className: 't' }, h(Icon, { name: 'pulse', size: 14 }), '诊断与健康 · 待处理问题'),
            h('span', { className: 'dc-n' }, '上次 ' + CLUSTER.lastRun)),
          h('div', { className: 'diag-sub' },
            critCt ? h('span', { className: 'diag-cnt s-negative' }, critCt + ' 严重') : null,
            warnCt ? h('span', { className: 'diag-cnt s-notice' }, warnCt + ' 警告') : null,
            h('span', { className: 'diag-cnt-src' }, '健康巡检 + INI 一致性')),
          problems.length === 0
            ? h('div', { className: 'diag-clear' }, h(Icon, { name: 'check', size: 15 }), '全部检查通过，暂无待处理问题')
            : h('div', { className: 'diag-list' },
              problems.map((p) => {
                const m = SEV[p.sev];
                return h('div', { key: p.key, className: 'diag-row' },
                  h('span', { className: 'diag-ico s-' + m.visual }, h(Icon, { name: m.icon, size: 13 })),
                  h('span', { className: 'diag-layer' }, p.src),
                  h('div', { className: 'diag-meta' },
                    h('div', { className: 'dl', title: p.tech || undefined }, p.label),
                    h('div', { className: 'dd' }, p.detail,
                      p.affected && p.affected !== '全部正常' ? h('span', { className: 'diag-aff' }, ' · ' + p.affected) : null)),
                  h('button', { className: 'fix-btn', onClick: p.onFix }, h(Icon, { name: 'bolt', size: 12 }), '修复'));
              }))),
        h('div', { className: 'dash-col' },
          h('div', { className: 'dash-card' },
            h('div', { className: 'dc-h' }, h('span', { className: 't' }, h(Icon, { name: 'list', size: 14 }), '最近任务'),
              h('span', { className: 'dc-n', style: { cursor: 'pointer' }, onClick: () => { s.setConTab('stream'); s.setLogOpen(true); } }, 'NDJSON 流 →')),
            h('div', { className: 'recent' },
              s.tasks.slice(0, 5).map((t) => h('div', { key: t.id, className: 'recent-row compact', onClick: () => { s.setConTab('stream'); s.setLogSearch('#' + t.no); s.setLogOpen(true); } },
                h('span', { className: 'tk-state s-' + taskVis(t.state) }, taskIcon(t)),
                h('span', { className: 'tk-title' }, t.title, h('span', { className: 'no' }, '#' + t.no)),
                h(ChannelTag, { ch: t.chan, mini: true }),
                t.state === 'running' ? h('span', { className: 'tk-pct' }, t.pct + '%') : h('span', { className: 'tk-el' }, t.elapsed)))))))));
  }

  /* =================== center router ===================
     keep-alive：首次进入任一 DDC 子页后，集群总览与 DDC 路由各自常驻挂载、用 display
     切换可见性，避免 home ↔ ZenServer 来回切时整页卸载重挂 + 重跑挂载期 SSH fan-out。 */
  const cacheViewShell = { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' };
  function center(s) {
    const onDdc = /^ddc_/.test(s.cacheNav);
    return h('div', { className: 'cache-views', style: cacheViewShell },
      h('div', { style: Object.assign({}, cacheViewShell, { display: onDdc ? 'none' : 'flex' }) }, h(Overview, { s })),
      s.cacheDdcEverOpened
        ? h('div', { style: Object.assign({}, cacheViewShell, { display: onDdc ? 'flex' : 'none' }) }, window.VOLO_CACHE_DDC.ddc(s))
        : null);
  }

  /* =================== task drawer (right column) =================== */
  const taskVis = (st) => st === 'running' ? 'accent' : st === 'success' ? 'positive' : st === 'failed' ? 'negative' : 'neutral';
  const taskIcon = (t) => t.state === 'running' ? h('span', { className: 'spin' }, h(Icon, { name: 'sync', size: 13 }))
    : t.state === 'success' ? h(Icon, { name: 'check', size: 13 })
    : t.state === 'failed' ? h(Icon, { name: 'x', size: 13 })
    : t.state === 'canceled' ? h(Icon, { name: 'minus', size: 13 }) : h(Icon, { name: 'pause', size: 13 });

  function TaskCard({ s, t }) {
    const [open, setOpen] = useState(false);
    const seeStream = () => { s.setConTab && s.setConTab('stream'); s.setLogSearch('#' + t.no); s.setLogFilter('all'); s.setLogOpen(true); };
    return h('div', { className: 'tcard tcard--' + t.state },
      h('div', { className: 'tcard-h' },
        h('span', { className: 'tk-state s-' + taskVis(t.state) }, taskIcon(t)),
        h('span', { className: 'tcard-title' }, t.title, h('span', { className: 'no' }, '#' + t.no)),
        h('span', { className: 'tcard-time' }, t.started)),
      h('div', { className: 'tcard-meta' },
        h(ChannelTag, { ch: t.chan, mini: true }),
        h('span', { className: 'tk-target' }, t.target),
        h('span', { className: 'sp' }),
        h('span', { className: 'tk-el' }, t.elapsed)),
      t.state === 'running'
        ? h('div', { className: 'tcard-bar' }, h('div', { className: 'vmeter vmeter--accent' }, h('div', { className: 'vmeter__fill', style: { width: t.pct + '%' } })), h('span', { className: 'pct' }, t.pct + '%'))
        : h('div', { className: 'tcard-note' }, t.note),
      h('div', { className: 'tcard-f' },
        h('button', { className: 'tk-btn', onClick: seeStream }, h(Icon, { name: 'terminal', size: 13 }), '看日志流'),
        t.state === 'failed' ? h('button', { className: 'tk-btn err', onClick: () => setOpen((v) => !v) }, h(Icon, { name: 'alert', size: 13 }), '看错误') : null,
        t.state === 'failed' && t.channelFail ? h('button', { className: 'tk-btn fix', onClick: () => s.runTask({ domain: t.domain, action: t.action, target: t.target, chan: 'ssh', note: '改走提权 SSH 重试', lines: [{ msg: '切换通道 → 提权 SSH（绕过 UAC 过滤）' }, { msg: 'netsh / sc 写操作执行中…' }, { lv: 'ok', msg: '重试成功' }] }) }, h(Icon, { name: 'shield', size: 13 }), '切提权 SSH 重试') : null),
      open && t.state === 'failed' ? h('div', { className: 'tcard-err' },
        h('div', { className: 'er-line' }, h('span', { className: 'k' }, 'exit'), h('span', { className: 'v' }, t.exit)),
        h('div', { className: 'er-line' }, h('span', { className: 'k' }, '通道'), h(ChannelTag, { ch: t.chan, mini: true })),
        h('div', { className: 'er-std' }, t.stderr)) : null);
  }

  /* =================== 检查器 (right column · detail-display) ===================
     选中机器/工程或预览操作时，内容直接在右侧检查器中就地展开（不再弹出滑窗）。
     无选中时只显示「未选择对象」空闲态 —— 进行中走控制台「运行中」气泡，历史走控制台「历史任务」标签。 */
  function inspIdle(s) {
    return h('div', { className: 'insp-empty' },
      h('div', { className: 'ph' }, h(Icon, { name: 'panel', size: 30 })),
      h('div', null,
        h('div', { style: { color: 'var(--chrome-dim)', fontWeight: 600, marginBottom: 4 } }, '未选择对象'),
        '选择机器或工程，相关细节与操作会在此就地展开'));
  }

  /* inspector dispatcher（就地细节显示）：
     · 选中机器 / 预览操作 / 入网脚本 / 凭据 → 在检查器列内就地渲染对应 drawer；
     · DDC PAK / PSO 子页 → 渲染该子页的检查器（已选工程 + 操作）；
     · 其余 → 检查器空闲态（任务与活动列表）。 */
  function inspector(s) {
    const d = s.drawer;
    /* drawer 指向的机器/脚本目标若已被 reloadCache 剔除（node 找不到），回落到检查器空闲态，
       避免检查器永久空白（如详情开着时「立即巡检」刚好移除了该机）。 */
    const stale = d && (d.kind === 'machine' || d.kind === 'script') && !node(d.id);
    if (d && !stale && (d.kind === 'machine' || d.kind === 'preview' || d.kind === 'script' || d.kind === 'creds' || d.kind === 'usb')) {
      return drawer(s);
    }
    if (/^ddc_p(ak|so)$/.test(s.cacheNav) && window.VOLO_CACHE_DDC && window.VOLO_CACHE_DDC.detail) {
      return window.VOLO_CACHE_DDC.detail(s);
    }
    return inspIdle(s);
  }

  /* =================== overlay · machine detail (6.2) =================== */
  const KV = (k, v, mono) => h('div', { className: 'kv', key: k }, h('span', { className: 'k' }, k), h('span', { className: 'v' + (mono ? ' mono' : '') }, v));

  /* 推导某机的项目 DefaultEngine.ini 路径：必须取「这台机自己」的工程目录（locByMachine[mid]），
     与 cacheZen ② 客户端指向写入路径一致；不能用 proj.root（可能是别的机器上的路径）。 */
  const projectDefaultEngineIniPath = (mid) => {
    const key = String(mid);
    const proj = (window.UE_PROJECTS || []).find((p) => p.locByMachine && p.locByMachine[key]);
    return proj ? (proj.locByMachine[key] + '\\Config\\DefaultEngine.ini') : null;
  };
  /* ⑤ 已读到的 DDC 相关配置 — 真实读三项（离线机不读，由调用方门控）：
     ① 环境变量 UE-LocalDataCachePath / UE-SharedDataCachePath（get_machine_env_var）
     ② 项目 DefaultEngine.ini 的 [StorageServers]（read_ini_section）——与 Zen ② 写入路径一致，
        按 locByMachine 推导；读显式声明值，不是「多层有效配置解析」。 */
  function loadDdcConfig(mid) {
    const iniPath = projectDefaultEngineIniPath(mid);
    return Promise.allSettled([
      getMachineEnvVar(mid, 'UE-LocalDataCachePath'),
      getMachineEnvVar(mid, 'UE-SharedDataCachePath'),
      iniPath ? readIniSection(mid, iniPath, 'StorageServers') : Promise.resolve(null),
    ]).then((rs) => {
      const envLocal = rs[0].status === 'rejected' ? '读取失败' : (rs[0].value || '未设');
      const envShared = rs[1].status === 'rejected' ? '读取失败' : (rs[1].value || '未设');
      let ini;
      if (!iniPath) ini = { ok: false, val: '该机未发现 UE 工程', note: '未扫描到工程目录，无法读取 DefaultEngine.ini [StorageServers]', plain: '还没在这台机器上发现 UE 工程，读不到项目配置，因此无法判断是否连上了团队共享缓存。请先在「集群总览」扫描发现工程。', path: null };
      else if (rs[2].status === 'rejected') ini = { ok: false, val: '读取失败', note: (rs[2].reason && rs[2].reason.message) ? rs[2].reason.message : '远程读取 INI 失败', plain: '没能读到这台机器的项目配置，暂时无法判断是否连上了团队共享缓存。', path: iniPath };
      else {
        const sh = (rs[2].value || []).find((k) => k.name && k.name.toLowerCase() === 'shared');
        ini = sh
          ? { ok: true, val: '[StorageServers] Shared = ' + sh.value, note: '已配置共享上游', plain: '这台机器已连上团队共享缓存服务器（' + sh.value + '），渲染时可以直接复用团队已经算好的缓存，不用从头重算。', path: iniPath }
          : { ok: false, val: '[StorageServers] 未配置 Shared', note: '未写入共享上游服务器', plain: '这台机器还没连上团队共享缓存服务器，渲染结果只存在本地，不能复用别人已经算好的缓存，也无法共享给其他机器。', path: iniPath };
      }
      return { envLocal, envShared, ini };
    });
  }

  function ScriptPanel({ s, d }) {
    const n = node(d.id);
    const [copied, setCopied] = useState(false);
    /* 真实 get_winrm_bootstrap_script：脚本与机器无关（后端 include_str! 固定文本），
       打开面板时异步拉一次。 */
    const [script, setScript] = useState(null);
    const [scriptErr, setScriptErr] = useState(null);
    useEffect(() => {
      let alive = true;
      getWinrmBootstrapScript().then(
        (txt) => { if (alive) setScript(txt); },
        (e) => { if (alive) setScriptErr(e && e.message ? e.message : String(e)); });
      return () => { alive = false; };
    }, []);
    if (!n) return null;
    const close = () => s.setDrawer(null);
    const copy = () => { if (!script) return; try { navigator.clipboard.writeText(script); } catch (e) {} setCopied(true); setTimeout(() => setCopied(false), 1500); };
    const refresh = () => {
      close();
      if (s.setEnrolled) s.setEnrolled((v) => v.includes(n.id) ? v : v.concat(n.id));
      /* 真实 refresh_machine：软失败=Ok+.error（不抛）；成败都 reloadCache 回填。 */
      s.runCmd({ domain: 'machine', action: 'refresh', target: n.host, chan: 'winrm', note: '刷新入网状态（探 SSH / UE / GPU）' },
        () => refreshMachine(n.machineId).then((r) => { if (r && r.error) throw new Error(r.error); return r; }),
        { okMsg: (r) => n.host + ' 已刷新 · UE ' + ((r.ue_installs || []).length) + ' · GPU ' + ((r.gpus || []).length) })
        .then(() => s.reloadCache(), () => s.reloadCache());
    };
    const step = (i, tx) => h('div', { className: 'step-line', key: i }, h('span', { className: 'sn' }, i), h('span', { className: 'step-tx' }, tx));
    return h('div', { className: 'drawer drawer--script' },
      h('div', { className: 'drawer-h' },
        h('span', { className: 'di info' }, h(Icon, { name: 'doc', size: 17 })),
        h('div', { style: { minWidth: 0 } },
          h('h2', null, '获取入网脚本'),
          h('div', { className: 'sub' }, h('span', { className: 'cli-pill' }, 'get_winrm_bootstrap_script'), h('span', null, ' · ' + n.host))),
        h('button', { className: 'iconbtn x', onClick: close }, h(Icon, { name: 'x', size: 16 }))),
      h('div', { className: 'drawer-b' },
        h('div', { className: 'script-intro' }, h(Icon, { name: 'shield', size: 14 }),
          '全栈已统一 SSH key 现场入网，后端不再远程推送配置。把下面脚本拷到目标机、以管理员运行，回来点「刷新」。'),
        h('div', { className: 'script-usb-hint' }, h(Icon, { name: 'usb', size: 14 }),
          h('span', null, '这里只复制单个脚本文本。完整入网（含公钥 + PsExec64 + 双击入口）请用顶部「制作入网 U 盘」。')),
        h('div', { className: 'dblock' },
          h('div', { className: 'dblock-h' }, h('span', { className: 'no' }, '1'), '操作步骤'),
          h('div', { className: 'steps-list' },
            step(1, '把脚本拷贝到目标机 ' + n.host + '（' + n.ip + '）'),
            step(2, '以管理员运行 enable-ssh.ps1'),
            step(3, '回到 Volo，点下方「刷新」确认入网'))),
        h('div', { className: 'dblock' },
          h('div', { className: 'dblock-h' }, h('span', { className: 'no' }, '2'), 'enable-ssh.ps1',
            h('button', { className: 'mini-btn script-copy', onClick: copy }, h(Icon, { name: copied ? 'check' : 'copy', size: 12 }), copied ? '已复制' : '复制')),
          h('pre', { className: 'script-code' }, scriptErr ? ('加载脚本失败 · ' + scriptErr) : (script == null ? '加载脚本…' : script)))),
      h('div', { className: 'drawer-f' },
        h(Button, { variant: 'secondary', size: 'M', onPress: close }, '关闭'),
        h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'sync', size: 15 }), onPress: refresh }, '已运行 · 刷新')));
  }
  function MachineDetail({ s, d }) {
    const n = node(d.id);
    /* 真实 get_machine_detail：抽屉打开时异步拉 UE 安装 / GPU（NodeVM 列表里这些是
       占位 '—'，详情才有真实值）。账户/关联段暂仍占位（Machine DTO 无 user/domain 源）。 */
    const [detail, setDetail] = useState(null);
    const [detailErr, setDetailErr] = useState(null);
    /* ⑥ DDC 配置真实读取（环境变量 + [StorageServers]）。 */
    const [ddc, setDdc] = useState(null);
    useEffect(() => {
      const mid = n ? n.machineId : null;
      if (mid == null || mid === 0) return;
      let alive = true;
      setDetail(null); setDetailErr(null);
      getMachineDetail(mid).then(
        (md) => { if (alive) setDetail(md); },
        (e) => { if (alive) setDetailErr(e && e.message ? e.message : String(e)); });
      return () => { alive = false; };
    }, [n ? n.machineId : null]);
    useEffect(() => {
      const mid = n ? n.machineId : null;
      if (mid == null || mid === 0 || (n && n.status === 'offline')) { setDdc(null); return; }
      let alive = true;
      setDdc({ loading: true });
      loadDdcConfig(mid).then((v) => { if (alive) setDdc(v); }, () => { if (alive) setDdc({ err: true }); });
      return () => { alive = false; };
    }, [n ? n.machineId : null]);
    /* ①「UE 运行用户」内联编辑：Zen 用户全局指向 / 本地端口 / 本地缓存目录都靠它定位
       C:\Users\<用户>\…；这是它在 App 内唯一的写入口（原先只有 CLI machine set-ue-user，
       全新环境会卡死）。保存 = DB 本地写（无远程副作用），成功后 reloadCache 即时生效。 */
    const savedUeUser = n && n.user !== '—' ? n.user : '';
    const [ueUserDraft, setUeUserDraft] = useState(savedUeUser);
    const [ueUserSt, setUeUserSt] = useState(null); /* null | 'saving' | 'ok' | {err} */
    useEffect(() => { setUeUserDraft(savedUeUser); setUeUserSt(null); }, [n ? n.machineId : null, savedUeUser]);
    const ueUserDirty = ueUserDraft.trim() !== savedUeUser;
    const saveUeUser = () => {
      if (!ueUserDirty || ueUserSt === 'saving') return;
      setUeUserSt('saving');
      setUeRuntimeUser(n.machineId, ueUserDraft.trim()).then(
        () => { setUeUserSt('ok'); s.reloadCache(); },
        (e) => setUeUserSt({ err: e && e.message ? e.message : String(e) }));
    };
    if (!n) return null;
    const off = n.status === 'offline';
    const close = () => s.setDrawer(null);
    const recentHealth = HEALTH_CHECKS.filter((c) => (c.detail || '').includes(n.host)).slice(0, 2);
    const reloadDdc = () => { const mid = n.machineId; if (mid == null || mid === 0 || off) return; setDdc({ loading: true }); loadDdcConfig(mid).then(setDdc, () => setDdc({ err: true })); };
    /* UE / GPU 视图：优先真实 detail，未到/失败回退占位 */
    const ueInst = detail && detail.ue_installs ? (detail.ue_installs.find((u) => u.is_primary) || detail.ue_installs[0]) : null;
    const gpu0 = detail && detail.gpus && detail.gpus.length ? detail.gpus[0] : null;
    const ph = detailErr ? '读取失败' : (detail ? '—' : '加载中…');
    const ueVer = ueInst ? ueInst.version : ph;
    const uePath = ueInst ? ueInst.install_path : ph;
    const gpuModel = gpu0 ? gpu0.gpu_model : ph;
    const gpuDriver = gpu0 ? gpu0.driver_version : ph;
    const gpuVram = gpu0 && gpu0.vram_mb != null ? ((gpu0.vram_mb / 1024).toFixed(0) + ' GB') : ph;
    const gpuVendor = gpu0 ? gpu0.vendor : ph;
    return h('div', { className: 'drawer drawer--detail' },
      h('div', { className: 'drawer-h detail' },
        h('span', { className: 'di info' }, dot(NODE_STATUS[n.status].visual)),
        h('div', { style: { minWidth: 0 } },
          h('h2', { style: { fontFamily: 'var(--font-code)' } }, n.host),
          h('div', { className: 'sub' }, n.role)),
        h('div', { style: { marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' } }, h(StatusPill, { status: n.status })),
        h('button', { className: 'iconbtn x', onClick: close }, h(Icon, { name: 'x', size: 16 }))),
      h('div', { className: 'drawer-b' },
        n.env === 'pending' && !(s.enrolled || []).includes(n.id) ? h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, '入网'),
          h('div', { className: 'deploy-block' },
            h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'doc', size: 14 }),
              onPress: () => { s.setDrawer({ kind: 'script', id: n.id }); showInspector(s); } }, '获取入网脚本'),
            h('div', { className: 'deploy-ok-note' }, 'SSH key 现场入网 · 拷到目标机运行后回来刷新'))) : null,
        h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, '① 身份'),
          KV('IP 地址', n.ip, true), KV('角色', n.role), KV('最后在线', n.last),
          h('div', { className: 'ueuser-edit' },
            h('div', { className: 'ueuser-row' },
              h('span', { className: 'k' }, 'UE 运行用户'),
              h('input', { className: 'ss-input mono ueuser-input', value: ueUserDraft, spellCheck: false,
                placeholder: '该机跑 UE 的 Windows 用户名',
                onChange: (e) => { setUeUserDraft(e.target.value); setUeUserSt(null); },
                onKeyDown: (e) => { if (e.key === 'Enter') saveUeUser(); } }),
              h('button', { className: 'mini-btn', disabled: !ueUserDirty || ueUserSt === 'saving', onClick: saveUeUser },
                ueUserSt === 'saving' ? '保存中…' : '保存')),
            ueUserSt && ueUserSt.err
              ? h('div', { className: 'ueuser-note s-negative' }, h(Icon, { name: 'alert', size: 11 }), '保存失败 · ' + ueUserSt.err)
              : ueUserSt === 'ok'
                ? h('div', { className: 'ueuser-note s-positive' }, h(Icon, { name: 'check', size: 11 }), '已保存 · 即时生效')
                : h('div', { className: 'ueuser-note' },
                    'Zen 的「用户全局」指向、本地端口、本地缓存目录都需要它来定位 C:\\Users\\<用户>\\… 配置；留空保存 = 清除。'))),
        h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, '② UE 安装'),
          KV('版本', ueVer), KV('安装路径', uePath, true)),
        h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, '③ GPU（入网后自动采集 · 已过滤虚拟适配器）'),
          KV('型号', gpuModel), KV('驱动', gpuDriver, true), KV('显存', gpuVram), KV('厂商', gpuVendor)),
        h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, '④ 关联（自动发现）'),
          h('div', { className: 'rev-links' },
            n.zen ? h('span', { className: 'rev', onClick: () => { s.setDrawer(null); s.setCacheNav('ddc_zen'); } }, h(Icon, { name: 'cube', size: 13 }), n.zen) : null,
            n.share ? h('span', { className: 'rev', title: n.share, onClick: () => { s.setDrawer(null); s.setCacheNav('ddc_legacy'); } }, h(Icon, { name: 'folder', size: 13 }), '共享 DDC 宿主') : null,
            (n.proj || []).map((p) => h('span', { key: p, className: 'rev' }, h(Icon, { name: 'film', size: 13 }), p)),
            !n.zen && !n.share && !(n.proj || []).length ? h('span', { className: 'dim', style: { fontSize: 12 } }, '无关联资源') : null)),
        !off ? h('div', { className: 'insp-sect' },
          h('div', { className: 'lh ddc-scan-h' }, h('span', { className: 'ddc-scan-title' }, '⑤ 已读到的 DDC 相关配置'),
            h('button', { className: 'mini-btn ddc-rescan', onClick: reloadDdc }, h(Icon, { name: 'search', size: 12 }), '重新读取')),
          h('div', { className: 'ddc-read-note' }, h(Icon, { name: 'eye', size: 12 }), '以下是从这台机器实际读到的设置（用大白话说明），不是有效配置的综合解析。'),
          (!ddc || ddc.loading)
            ? h('div', { className: 'ddc-read-row' }, h('span', { className: 'dim', style: { fontSize: 12 } }, '读取中…'))
            : ddc.err
              ? h('div', { className: 'ddc-read-row miss' }, h('span', { className: 'dim', style: { fontSize: 12 } }, '读取失败'))
              : h(React.Fragment, null,
                  h('div', { className: 'ddc-read-row' },
                    h('div', { className: 'ddc-read-h' }, h('span', { className: 'ddc-read-k' }, '① 缓存目录在哪'), h('code', { className: 'ddc-tfile' }, '系统环境变量')),
                    KV('本机缓存目录', ddc.envLocal, true),
                    KV('团队共享缓存目录', ddc.envShared === '未设' ? '未设置（不使用团队共享缓存）' : ddc.envShared, ddc.envShared !== '未设' && ddc.envShared !== '读取失败')),
                  h('div', { className: 'ddc-read-row' + (ddc.ini.ok ? '' : ' miss') },
                    h('div', { className: 'ddc-read-h' }, h('span', { className: 'ddc-read-k' }, '② 是否连上共享缓存'), h('code', { className: 'ddc-tfile' }, 'DefaultEngine.ini')),
                    h('div', { className: 'ddc-read-plain' + (ddc.ini.ok ? '' : ' warn') }, ddc.ini.plain),
                    h('div', { className: 'ddc-read-sub' }, ddc.ini.note),
                    h('details', { className: 'ddc-read-tech' },
                      h('summary', null, '查看配置原文与文件位置'),
                      ddc.ini.path ? h('div', { className: 'ddc-read-tline' },
                        h('span', { className: 'ddc-read-tlabel' }, '配置文件位置'),
                        h('div', { className: 'ddc-read-path mono' }, ddc.ini.path),
                        h('div', { className: 'ddc-read-thint' }, '这是这台机器上已扫描 UE 工程的项目配置文件，与 Zen ②「指向此服务器」写入的是同一文件。')) : null,
                      h('div', { className: 'ddc-read-tline' },
                        h('span', { className: 'ddc-read-tlabel' }, '当前配置原文'),
                        h('div', { className: 'ddc-read-val mono' + (ddc.ini.ok ? '' : ' empty') }, ddc.ini.val),
                        h('div', { className: 'ddc-read-thint' }, ddc.ini.ok ? 'Shared 这一项指明了团队共享缓存服务器的地址和端口。' : '缺少 Shared 这一项，引擎就不知道去哪里找团队共享缓存。')))))) : null,
        recentHealth.length ? h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, '⑥ 最近健康'),
          recentHealth.map((c) => h('div', { key: c.id, className: 'mini-health' }, dot(SEV[c.status].visual), h('span', null, c.label), h('span', { className: 'd' }, c.detail)))) : null),
      h('div', { className: 'drawer-f between' },
        h(Button, { variant: 'secondary', size: 'M', icon: h(Icon, { name: 'search', size: 14 }), isDisabled: off,
          /* 真实 refresh_machine：阻塞 SSH（probe→UE→GPU），返回 RefreshResult。
             软失败是 Ok+.error（不抛），抛出后标任务失败；无论成败都 reloadCache 回填。 */
          onPress: () => { close(); s.runCmd({ domain: 'machine', action: 'refresh', target: n.host, chan: 'winrm', note: '探 UE / GPU / last-seen' },
            () => refreshMachine(n.machineId).then((r) => { if (r && r.error) throw new Error(r.error); return r; }),
            { okMsg: (r) => n.host + ' 已刷新 · UE ' + ((r.ue_installs || []).length) + ' · GPU ' + ((r.gpus || []).length) })
            .then(() => s.reloadCache(), () => s.reloadCache()); } }, '刷新'),
        h(Button, { variant: 'negative', size: 'M', icon: h(Icon, { name: 'trash', size: 14 }),
          onPress: () => openPreview(s, {
            title: '删除机器 · ' + n.host, icon: 'trash', cli: 'machine delete', destructive: true, channel: 'ssh',
            steps: ['从集群中移除机器 ' + n.host, '解除它与共享缓存、ZenServer 的关联', '清除已保存的这台机器的登录凭据'],
            scope: [n.id], confirmInput: true,
            /* 真实 delete_machine：用 numeric machineId（非 string n.id），成功后 reloadCache。 */
            onConfirm: () => { s.runCmd({ domain: 'machine', action: 'delete', target: n.host, chan: 'ssh', note: '从集群移除' },
              () => deleteMachine(n.machineId), { okMsg: () => n.host + ' 已从集群移除' })
              .then(() => s.reloadCache(), () => {}); },
          }) }, '删除机器')));
  }

  /* =================== overlay · preview→confirm→execute (5.1) ===================
     close/onConfirm 可由调用方覆盖（ModalPreview 的 preview 阶段复用此面板，自带居中关闭与确认）。 */
  function PreviewPanel({ s, d, close: closeProp, onConfirm: onConfirmProp }) {
    const [scope, setScope] = useState(d.scope || []);
    const [confirmCk, setConfirmCk] = useState(false);
    const simple = d.simpleScope || null;
    const selCand = d.selectableScope || null; /* 可选目标设备：{ id, host, ip, msg }，默认全选 */
    const [picked, setPicked] = useState(() => (selCand ? selCand.map((r) => r.id) : []));
    const rows = (simple || selCand) ? [] : predict(scope, d.destructive);
    const willApply = selCand ? picked.length : simple ? simple.length : rows.filter((r) => !r.skip).length;
    const willSkip = (simple || selCand) ? 0 : rows.filter((r) => r.skip).length;
    const count = selCand ? picked.length : simple ? simple.length : scope.length;
    const allPicked = !!selCand && picked.length === selCand.length && selCand.length > 0;
    const somePicked = !!selCand && picked.length > 0 && !allPicked;
    const togglePick = (id) => setPicked((v) => (v.includes(id) ? v.filter((x) => x !== id) : v.concat(id)));
    const toggleAllPick = () => setPicked(allPicked ? [] : selCand.map((r) => r.id));
    const blocked = d.destructive && d.confirmInput && count > 1 && !confirmCk;
    const close = closeProp || (() => s.setDrawer(null));
    const confirm = onConfirmProp || ((pickedIds) => {
      close();
      if (d.task) s.runTask(Object.assign({}, d.task, { chan: d.channel || d.task.chan }));
      if (d.onConfirm) d.onConfirm(selCand ? pickedIds : scope); /* 把编辑后的目标机选择传出（分发流要用） */
    });
    return h('div', { className: 'drawer drawer--preview' + (d.destructive ? ' danger' : '') },
      h('div', { className: 'drawer-h' },
        h('span', { className: 'di' + (d.destructive ? '' : ' info') }, h(Icon, { name: d.icon || 'eye', size: 17 })),
        h('div', { style: { minWidth: 0 } },
          h('h2', null, d.title),
          h('div', { className: 'sub' },
            h('span', { className: 'cli-pill' }, d.cli),
            d.destructive ? h('span', { className: 'danger-note' }, ' · 破坏性操作，需确认') : h('span', null, ' · 预览（dry-run）'))),
        h('button', { className: 'iconbtn x', onClick: close }, h(Icon, { name: 'x', size: 16 }))),
      h('div', { className: 'drawer-b' },
        /* ① steps */
        h('div', { className: 'dblock' },
          h('div', { className: 'dblock-h' }, h('span', { className: 'no' }, '1'), '将执行的步骤',
            h(ChannelTag, { ch: d.channel || 'winrm', mini: true })),
          h('div', { className: 'steps-list' },
            (d.steps || []).map((st, i) => h('div', { key: i, className: 'step-line' }, h('span', { className: 'sn' }, i + 1), h('span', { className: 'step-tx' }, st))))),
        /* optional diff */
        d.diff ? h('div', { className: 'dblock' },
          h('div', { className: 'dblock-h' }, h('span', { className: 'no' }, '2'), '变更对比 (diff)'),
          h('div', { className: 'diff' },
            d.ctx ? h('div', { className: 'diff-ctx' }, d.ctx) : null,
            d.diff.map((ln, i) => h('div', { key: i, className: 'diff-line diff-' + ln[0] }, h('span', { className: 'sign' }, ln[0] === 'del' ? '−' : '+'), h('span', null, ln[1]))))) : null,
        /* ② affected scope */
        h('div', { className: 'dblock' },
          h('div', { className: 'dblock-h' }, h('span', { className: 'no' }, d.diff ? '3' : '2'),
            (simple || selCand) ? '目标设备' : '影响范围 · 机器选择器',
            h('span', { className: 'aff-sum' }, selCand ? (picked.length + ' / ' + selCand.length + ' 台')
              : simple ? (simple.length + ' 台') : (willApply + ' 应用 / ' + willSkip + ' 跳过'))),
          selCand
            ? h(React.Fragment, null,
                h('button', { type: 'button', className: 'sel-all-row' + (allPicked ? ' on' : somePicked ? ' part' : ''), onClick: toggleAllPick },
                  h('span', { className: 'sel-ck' }, allPicked ? h(Icon, { name: 'check', size: 12 }) : somePicked ? h(Icon, { name: 'minus', size: 12 }) : null),
                  h('span', { className: 'sel-all-tx' }, allPicked ? '取消全选' : '全选'),
                  h('span', { className: 'sel-all-ct' }, '共 ' + selCand.length + ' 台可选')),
                h('div', { className: 'afflist' }, selCand.map((r) => {
                  const on = picked.includes(r.id);
                  return h('button', { key: r.id, type: 'button', className: 'affrow selectable' + (on ? ' on' : ''), onClick: () => togglePick(r.id) },
                    h('span', { className: 'sel-ck' }, on ? h(Icon, { name: 'check', size: 12 }) : null),
                    h('div', { className: 'aff-id' },
                      h('span', { className: 'host' }, r.host),
                      h('span', { className: 'ip' }, r.ip)),
                    r.msg ? h('span', { className: 'aff-gpu' }, r.msg) : null);
                })))
            : simple
            ? h('div', { className: 'afflist' }, simple.map((r, i) => h('div', { key: i, className: 'affrow' },
                h('span', { className: 'ai s-positive' }, h(Icon, { name: 'check', size: 15 })),
                h('span', { className: 'host' }, r.host),
                h('span', { className: 'ip' }, r.ip),
                h('span', { className: 'msg s-positive' }, r.msg || '就绪'))))
            : h(React.Fragment, null,
              h(MachineSelector, { value: scope, onChange: setScope }),
              rows.length ? h('div', { className: 'afflist' },
                rows.map((r) => h('div', { key: r.n.id, className: 'affrow' + (r.skip ? ' skip' : '') },
                  h('span', { className: 'ai s-' + r.vis }, r.icon === 'minus' ? h('span', null, '—') : h(Icon, { name: r.icon, size: 15 })),
                  h('span', { className: 'host' }, r.n.host),
                  h('span', { className: 'ip' }, r.n.ip),
                  h('span', { className: 'msg s-' + r.vis }, r.msg)))) : null)),
        /* ③ channel + backup + readback */
        (d.backup || d.readback) ? h('div', { className: 'dblock' },
          h('div', { className: 'dblock-h' }, h('span', { className: 'no' }, d.diff ? '4' : '3'), '安全 / 回读'),
          d.backup ? h('div', { className: 'backup' },
            h(Icon, { name: 'folder', size: 16, style: { color: 'var(--chrome-faint)', flex: '0 0 auto' } }),
            h('div', null, h('div', { className: 'path' }, d.backup), h('div', { style: { fontSize: 11, color: 'var(--chrome-faint)', marginTop: 3 } }, '应用前自动备份，可回滚'))) : null,
          d.readback ? h('div', { className: 'readback' },
            h('div', { className: 'rb-h' }, h(Icon, { name: 'check', size: 13 }), '写入后回读确证'),
            h('div', { className: 'rb-row' }, h('span', { className: 'k' }, d.readback.key), h('span', { className: 'exp' }, 'expected ' + d.readback.expected))) : null) : null,
        d.destructive && d.confirmInput && count > 1 ? h('label', { className: 'confirm-ck' },
          h('input', { type: 'checkbox', checked: confirmCk, onChange: (e) => setConfirmCk(e.target.checked) }),
          h('span', null, '我确认对 ', h('b', null, count), ' 台机器执行此破坏性操作')) : null),
      h('div', { className: 'drawer-f' },
        h(Button, { variant: 'secondary', size: 'M', onPress: close }, '取消'),
        h(Button, { variant: d.destructive ? 'negative' : 'accent', size: 'M', isDisabled: blocked || count === 0,
          icon: h(Icon, { name: 'check', size: 15 }), onPress: () => confirm(selCand ? picked.slice() : undefined) },
          d.confirmLabelFn ? d.confirmLabelFn(count) : (d.confirmLabel || '确认执行'))));
  }

  /* =================== centered modal: preview → 实时进度 → 成功 / 失败 ===================
     与原型不同：进度 / 成败由真实后端命令（d.run() 返回的 runCmd promise）驱动，不是 setTimeout 模拟。
     - d.run(): () => Promise —— 真实操作（自带 runCmd + 成功后 reloadCache）；resolve→成功阶段，reject→失败阶段。
     - d.liveProgress === false：preview 阶段确认即 close + 后台跑 d.run()（进度在页面别处呈现，如 Zen 步骤器）。
     - d.autostart：跳过 preview 直接进进度阶段（如「立即巡检」）。
     running 阶段的步骤勾选是「随真实命令在跑」的视觉提示（命令是原子的，无逐步进度）：定时推进但封顶在末步，
     只有真实 promise 落定才翻成功 / 失败。 */
  function ModalPreview({ s, d, close, busyRef }) {
    const [phase, setPhase] = useState(d.autostart ? 'running' : 'preview'); /* preview | running | done | failed */
    const [done, setDone] = useState(0);
    const [doneResult, setDoneResult] = useState(null); /* run() 的 resolve 值 → 供动态 doneMsg 显示真实 ok/fail */
    const [errMsg, setErrMsg] = useState(null);
    const timer = React.useRef(null);
    const started = React.useRef(false);
    const pickedRef = React.useRef(null); /* 选中的目标设备（selectableScope 可选分发）*/
    const steps = d.steps || [];
    const total = Math.max(steps.length, 1);

    const start = (picked) => {
      if (started.current) return;
      started.current = true;
      pickedRef.current = picked;
      setPhase('running'); setDone(0); setErrMsg(null);
      /* 视觉推进：随命令在跑逐步点亮，封顶在末步（total-1）；真实 promise 落定才翻成功 / 失败 */
      let i = 0;
      const tick = () => { if (i < total - 1) { i += 1; setDone(i); timer.current = setTimeout(tick, 520); } };
      timer.current = setTimeout(tick, 520);
      Promise.resolve().then(() => (d.run ? d.run(picked) : (d.onConfirm && d.onConfirm(picked)))).then(
        (r) => { if (timer.current) clearTimeout(timer.current); setDoneResult(r); setDone(total); setPhase('done'); },
        (e) => { if (timer.current) clearTimeout(timer.current); setErrMsg(e && e.message ? e.message : String(e)); setPhase('failed'); });
    };

    /* dispatchDone：确认=下发命令；kickoff（invoke）落定即翻「OK · 已开始分发」完成态——
       后台任务已启动，真实执行进度由右下角「运行中」任务进度条承担，对话框不再滞留等待。
       kickoff 被拒（如 preflight 失败）仍走 failed 分支显示真实原因。 */
    const dispatch = (picked) => {
      if (started.current) return;
      started.current = true;
      pickedRef.current = picked;
      setPhase('running'); setErrMsg(null);
      Promise.resolve().then(() => (d.run ? d.run(picked) : (d.onConfirm && d.onConfirm(picked)))).then(
        (r) => { setDoneResult(r); setDone(total); setPhase('done'); },
        (e) => { setErrMsg(e && e.message ? e.message : String(e)); setPhase('failed'); });
    };

    useEffect(() => {
      if (d.autostart) start();
      return () => { if (timer.current) clearTimeout(timer.current); };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    if (phase === 'preview') {
      /* liveProgress:false → 确认即关闭对话框 + 后台执行（进度在页面别处）；否则进对话框内进度阶段 */
      const plainConfirm = (picked) => { pickedRef.current = picked; close(); if (d.run) d.run(picked); else if (d.onConfirm) d.onConfirm(picked); };
      return h(PreviewPanel, { s, d, close, onConfirm: d.dispatchDone ? dispatch : (d.liveProgress === false ? plainConfirm : start) });
    }

    const fail = phase === 'failed';
    /* running 阶段不可被遮罩点击关闭（无 X 按钮，命令仍在跑）；preview/done/failed 可关 */
    if (busyRef) busyRef.current = (phase === 'running');
    const pct = phase === 'done' ? 100 : Math.min(92, Math.round(((done + 0.6) / total) * 100));
    /* doneMsg 可为 (runResult, picked)=>string，据真实 ok/fail 结果 + 实际勾选目标显示（避免 partial-failure 误报全绿）*/
    const okMsg = (typeof d.doneMsg === 'function' ? d.doneMsg(doneResult, pickedRef.current) : d.doneMsg) || '操作已完成';
    const okTitle = d.doneTitle || (d.destructive ? '已完成' : '已成功部署');
    const failTitle = d.failTitle || '执行失败';

    /* dispatchDone 完成态：不展示进度/步骤——只报「已开始」+ 指引到右下角任务进度条 */
    if (d.dispatchDone && phase === 'done') {
      return h('div', { className: 'drawer drawer--preview' },
        h('div', { className: 'drawer-h' },
          h('span', { className: 'di ok' }, h(Icon, { name: 'check', size: 17 })),
          h('div', { style: { minWidth: 0 } },
            h('h2', null, okTitle),
            h('div', { className: 'sub' },
              h('span', { className: 'cli-pill' }, d.cli),
              h('span', null, ' · 已下发'))),
          h('button', { className: 'iconbtn x', onClick: close }, h(Icon, { name: 'x', size: 16 }))),
        h('div', { className: 'drawer-b' },
          h('div', { className: 'dblock' },
            h('div', { className: 'mdone' },
              h('span', { className: 'mdone__ic' }, h(Icon, { name: 'check', size: 16 })),
              h('span', null, okMsg)),
            h('div', { className: 'dispatch-hint' },
              h(Icon, { name: 'info', size: 13 }),
              h('span', null, '实际分发进度不在此对话框展示 —— 请到页面右下角「运行中」任务进度条查看')))),
        h('div', { className: 'drawer-f' },
          h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'check', size: 15 }), onPress: close }, 'OK')));
    }
    return h('div', { className: 'drawer drawer--preview' + (d.destructive ? ' danger' : '') },
      h('div', { className: 'drawer-h' },
        h('span', { className: 'di' + (phase === 'done' ? ' ok' : fail ? ' err' : d.destructive ? '' : ' info') },
          h(Icon, { name: phase === 'done' ? 'check' : fail ? 'alert' : (d.icon || 'eye'), size: 17 })),
        h('div', { style: { minWidth: 0 } },
          h('h2', null, phase === 'done' ? okTitle : fail ? failTitle : d.title),
          h('div', { className: 'sub' },
            h('span', { className: 'cli-pill' }, d.cli),
            h('span', null, phase === 'done' ? ' · 完成' : fail ? ' · 失败' : ' · 执行中…'))),
        (phase === 'done' || fail) ? h('button', { className: 'iconbtn x', onClick: close }, h(Icon, { name: 'x', size: 16 })) : null),
      h('div', { className: 'drawer-b' },
        h('div', { className: 'dblock' },
          h('div', { className: 'dblock-h' }, h('span', { className: 'no' }, '1'),
            phase === 'done' ? '已执行' : fail ? '执行中断' : '正在执行',
            h(ChannelTag, { ch: d.channel || 'winrm', mini: true }),
            h('span', { className: 'aff-sum' }, pct + '%')),
          h('div', { className: 'mprog' }, h('div', { className: 'mprog__fill' + (phase === 'done' ? ' is-done' : fail ? ' is-fail' : ''), style: { width: pct + '%' } })),
          h('div', { className: 'steps-list run', style: { marginTop: 12 } },
            steps.map((st, i) => {
              /* 仅成功阶段或运行中已点亮的步骤才算「完成」；失败阶段不伪造成功勾——
                 命令是原子的，失败时此前步骤并未真正完成。 */
              const finn = phase === 'done' || (phase === 'running' && i < done);
              const active = i === done && phase === 'running';
              const failedStep = fail && i === done;
              return h('div', { key: i, className: 'step-line' + (finn ? ' ok' : failedStep ? ' fail' : active ? ' active' : ' pending') },
                h('span', { className: 'sn' }, finn ? h(Icon, { name: 'check', size: 12 }) : failedStep ? h(Icon, { name: 'alert', size: 12 }) : (i + 1)),
                h('span', { className: 'step-tx' }, st));
            }))),
        phase === 'done' ? h('div', { className: 'dblock' },
          h('div', { className: 'mdone' },
            h('span', { className: 'mdone__ic' }, h(Icon, { name: 'check', size: 16 })),
            h('span', null, okMsg))) : null,
        fail ? h('div', { className: 'dblock' },
          h('div', { className: 'mfail' },
            h('span', { className: 'mfail__ic' }, h(Icon, { name: 'alert', size: 16 })),
            h('span', null, errMsg || '操作失败 · 详见控制台日志流'))) : null),
      h('div', { className: 'drawer-f' },
        phase === 'done'
          ? h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'check', size: 15 }), onPress: close }, 'OK')
          : fail
            ? h(React.Fragment, null,
                h(Button, { variant: 'secondary', size: 'M', onPress: close }, '关闭'),
                h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'sync', size: 15 }), onPress: () => { started.current = false; start(); } }, '重试'))
            : h(Button, { variant: 'secondary', size: 'M', isDisabled: true }, '执行中…')));
  }

  function ModalLayer({ s }) {
    /* busyRef 由 ModalPreview 在 running 阶段置 true → 此时点遮罩不关闭（命令仍在跑、无 X 按钮）。
       useRef 必须在条件 return 之前（Rules of Hooks）。d.render 是自定义模态（如 cacheZen
       工程级「选工程」二级菜单）——没有 running 态，遮罩点击直接关，不受 busyRef 影响。 */
    const busyRef = React.useRef(false);
    const d = s.modal;
    if (!d) return null;
    const close = () => s.setModal(null);
    const tryClose = () => { if (!busyRef.current) close(); };
    return h('div', { className: 'modal-scrim', onClick: d.render ? close : tryClose },
      h('div', { className: 'modal-host' + (d.destructive ? ' danger' : '') + (d.wide ? ' wide' : '') + (d.xwide ? ' xwide' : ''), onClick: (e) => e.stopPropagation() },
        d.render ? d.render({ s, close }) : h(ModalPreview, { s, d, close, busyRef })));
  }

  function CredsPanel({ s }) {
    const close = () => s.setDrawer(null);
    const creds = s.creds || [];
    const [confirmDel, setConfirmDel] = useState(null);
    const [adding, setAdding] = useState(false);
    /* kind 用后端 CredentialKind 二态（winrm|share），与列表侧 toCredVM 渲染一致；
       旧三态(域/服务/本地账户)是账户类型、后端无此分类，故弃用。 */
    const [form, setForm] = useState({ name: '', kind: 'winrm', username: '', password: '' });
    const KINDS = [{ id: 'winrm', label: 'WinRM（远程执行）' }, { id: 'share', label: '共享 DDC' }];
    const addCred = () => {
      const alias = form.name.trim();
      if (!alias || !form.password) return;
      /* 真实 save_credential：password 是 SecretStore 存的 secret 本体（UI 端非空校验）；
         不再 optimistic 追加假 VM，成功后 reloadCache 取真实列表。 */
      s.runCmd({ domain: 'cred', action: 'save', target: alias, chan: 'ssh', note: '写入 SecretStore（AES-GCM）' },
        () => saveCredential(alias, form.kind, form.username.trim(), form.password),
        { okMsg: () => alias + ' 已写入 SecretStore' })
        .then(() => s.reloadCache(), () => {});
      setForm({ name: '', kind: 'winrm', username: '', password: '' }); setAdding(false);
    };
    const delCred = (c) => {
      setConfirmDel(null);
      /* 真实 delete_credential：不再 optimistic 删本地，成功后 reloadCache 同步后端；
         失败则保留列表（runCmd 已把错误打进任务抽屉）。 */
      s.runCmd({ domain: 'cred', action: 'delete', target: c.alias, chan: 'ssh', note: '从 SecretStore 删除' },
        () => deleteCredential(c.alias), { okMsg: () => c.alias + ' 已从 SecretStore 删除' })
        .then(() => s.reloadCache(), () => {});
    };
    return h('div', { className: 'drawer drawer--creds' },
      h('div', { className: 'drawer-h' },
        h('span', { className: 'di info' }, h(Icon, { name: 'key', size: 17 })),
        h('div', { style: { minWidth: 0 } },
          h('h2', null, '凭据管理'),
          h('div', { className: 'sub' }, h('span', { className: 'cli-pill' }, 'list / save / delete_credential'), h('span', null, ' · SecretStore'))),
        h('button', { className: 'iconbtn x', onClick: close }, h(Icon, { name: 'x', size: 16 }))),
      h('div', { className: 'drawer-b' },
        h('div', { className: 'creds-note' }, h(Icon, { name: 'shield', size: 13 }),
          '凭据仅用于共享 DDC 的创建 / 接入；其余远程操作走 SSH key，不再逐操作选凭据。'),
        h('div', { className: 'creds-list' }, creds.length === 0
          ? h('div', { className: 'creds-empty' }, h(Icon, { name: 'key', size: 22 }), h('span', null, '还没有凭据，点下方新增'))
          : creds.map((c) => h('div', { key: c.id, className: 'cred-row' + (confirmDel === c.id ? ' danger' : '') },
              h('span', { className: 'cred-ico' }, h(Icon, { name: 'key', size: 15 })),
              h('div', { className: 'cred-meta' },
                h('div', { className: 'cred-name mono' }, c.name),
                h('div', { className: 'cred-sub' }, c.kind + ' · ' + (c.domain === '—' ? '本地' : c.domain) + ' · ' + c.use + ' · ' + c.machines + ' 台')),
              confirmDel === c.id
                ? h('div', { className: 'cred-confirm' },
                    h('span', { className: 'cc-q' }, '删除？'),
                    h('button', { className: 'mini-btn', onClick: () => setConfirmDel(null) }, '取消'),
                    h('button', { className: 'mini-btn danger', onClick: () => delCred(c) }, h(Icon, { name: 'trash', size: 12 }), '确认删除'))
                : h('button', { className: 'iconbtn cred-del', title: '删除凭据', onClick: () => setConfirmDel(c.id) }, h(Icon, { name: 'trash', size: 14 })))))),
      h('div', { className: 'drawer-f' },
        adding
          ? h('div', { className: 'cred-add' },
              h('div', { className: 'cred-add-kinds' }, KINDS.map((k) => h('button', { key: k.id, className: 'cred-kind' + (form.kind === k.id ? ' on' : ''), onClick: () => setForm((f) => Object.assign({}, f, { kind: k.id })) }, k.label))),
              h('input', { className: 'dp-input mono', placeholder: '凭据名 / alias（如 zen-svc）', value: form.name, autoFocus: true, spellCheck: false, onChange: (e) => setForm((f) => Object.assign({}, f, { name: e.target.value })) }),
              h('input', { className: 'dp-input mono', placeholder: '用户名（如 VOLO\\svc-render，可空）', value: form.username, spellCheck: false, onChange: (e) => setForm((f) => Object.assign({}, f, { username: e.target.value })) }),
              h('input', { className: 'dp-input mono', type: 'password', placeholder: '密码（存入 SecretStore · 必填）', value: form.password, onChange: (e) => setForm((f) => Object.assign({}, f, { password: e.target.value })), onKeyDown: (e) => { if (e.key === 'Enter') addCred(); } }),
              h('div', { className: 'cred-add-acts' },
                h(Button, { variant: 'secondary', size: 'M', onPress: () => { setAdding(false); setForm({ name: '', kind: 'winrm', username: '', password: '' }); } }, '取消'),
                h(Button, { variant: 'accent', size: 'M', isDisabled: !form.name.trim() || !form.password, icon: h(Icon, { name: 'check', size: 14 }), onPress: addCred }, '保存凭据')))
          : h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'plus', size: 15 }), onPress: () => setAdding(true) }, '新增凭据')));
  }

  /* =================== 制作入网 U 盘（导出 SSH 入网包 · package_ssh_bootstrap）===================
     全局动作：包与机器无关，做一次即可入网所有节点。复用右侧 drawer + dblock / step-line / cli-pill。
     真接后端：packageSshBootstrap（Windows-only）/ pickDirectory（原生目录选择器）/ revealPath。 */
  const USB_FILE_USE = {
    'UECM-Bootstrap.cmd': '双击入口，自动以管理员提权运行',
    'README.txt':          '中文使用说明',
    'enable-ssh.ps1':      '开 OpenSSH · 授权公钥 · 写节点配置',
    'uecm.pub':            'Volo 传输公钥（明文）',
    'PsExec64.exe':        '凭据注入工具',
  };
  const USB_FAILS = {
    dep:     { title: '缺少打包依赖', msg: '安装包未随附 PsExec64.exe，无法生成完整入网包。', fix: '重新安装 Volo 或联系管理员补齐打包组件，然后重试。' },
    nowrite: { title: '输出目录不可写', msg: '无法写入所选目录，U 盘可能已被拔出、处于写保护或空间不足。', fix: '确认 U 盘已插好、未写保护、有剩余空间，换个目录后重试。' },
    badpw:   { title: '密码含非法字符', msg: 'uecm-svc 密码包含 % " ^，cmd 解析会损坏密码。', fix: '回到输入区移除这些字符后重新生成。' },
  };
  const USB_PW_BAD = ['%', '"', '^'];
  /* 把后端错误消息归到设计稿的三类卡片；认不出的回落到「其他」并原样显示后端消息。 */
  function classifyUsbFail(msg) {
    const m = (msg || '').toLowerCase();
    if (m.includes('mangle') || m.includes('cmd.exe')) return 'badpw';
    if (m.includes('psexec')) return 'dep';
    if (m.includes('denied') || m.includes('not enough space') || m.includes('read-only') ||
        m.includes('cannot') || m.includes('could not find') || m.includes('access to the path')) return 'nowrite';
    return 'other';
  }

  function UsbPackPanel({ s }) {
    const winOk = s.platform === 'win';
    const [phase, setPhase] = useState('idle');   /* idle | gen | done | fail */
    const [path, setPath] = useState('');
    const [pw, setPw] = useState('');
    const [advOpen, setAdvOpen] = useState(false);
    const [copied, setCopied] = useState(false);
    const [result, setResult] = useState(null);   /* PackageBootstrapResult（真实输出路径 + 文件列表） */
    const [failReason, setFailReason] = useState('dep');
    const [failMsg, setFailMsg] = useState('');

    const close = () => s.setDrawer(null);
    const badChars = USB_PW_BAD.filter((c) => pw.includes(c));
    const pwBad = badChars.length > 0;
    const outPath = path.trim();
    const donePath = (result && result.output_directory) || outPath;
    const canGen = winOk && phase === 'idle' && !!outPath && !pwBad;

    const browse = () => { pickDirectory().then((p) => { if (p) setPath(p); }, () => {}); };
    const copyPath = () => { try { navigator.clipboard.writeText(donePath); } catch (e) {} setCopied(true); setTimeout(() => setCopied(false), 1400); };
    const showFolder = () => { revealPath(donePath).catch(() => {}); };

    const generate = () => {
      if (!canGen) return;
      setResult(null);
      setPhase('gen');
      s.runCmd({ domain: 'usb', action: 'package-bootstrap', target: outPath, chan: 'ssh', note: '生成入网 U 盘包' },
        () => packageSshBootstrap(outPath, pw.trim() || null),
        { okMsg: (r) => '入网包已生成 · ' + r.output_directory + '（' + ((r.files || []).length) + ' 个文件）' })
        .then(
          (r) => { setResult(r); setPhase('done'); },
          (e) => { const msg = e && e.message ? e.message : String(e); setFailMsg(msg); setFailReason(classifyUsbFail(msg)); setPhase('fail'); });
    };

    const step = (i, tx) => h('div', { className: 'step-line', key: i }, h('span', { className: 'sn' }, i), h('span', { className: 'step-tx' }, tx));

    /* ---- body ---- */
    let body;
    if (!winOk) {
      body = h('div', { className: 'usb-unavail' },
        h('div', { className: 'usb-unavail-ico' }, h(Icon, { name: 'alert', size: 22 })),
        h('div', { className: 'usb-unavail-t' }, '该功能仅 Windows 可用'),
        h('div', { className: 'usb-unavail-d' }, '制作入网 U 盘依赖 PowerShell 打包，请在 Windows 上的 Volo 中操作。'));
    } else if (phase === 'gen') {
      body = h('div', { className: 'usb-gen' },
        h('span', { className: 'spin usb-gen-spin' }, h(Icon, { name: 'sync', size: 22 })),
        h('div', { className: 'usb-gen-t' }, '正在生成入网包…'),
        h('div', { className: 'usb-gen-d' }, h('span', { className: 'mono' }, 'package_bootstrap'), ' → ', h('span', { className: 'mono' }, outPath)),
        h('div', { className: 'usb-gen-bar' }, h('span', null)));
    } else if (phase === 'done') {
      const files = (result && result.files) || [];
      body = h(React.Fragment, null,
        h('div', { className: 'usb-done' },
          h('div', { className: 'usb-done-ico' }, h(Icon, { name: 'check', size: 26 })),
          h('div', { className: 'usb-done-t' }, '入网包已生成'),
          h('div', { className: 'usb-done-d' }, '这个包全局通用 —— 做一次即可入网所有节点。')),
        h('div', { className: 'usb-out' },
          h('div', { className: 'usb-out-h' }, h(Icon, { name: 'folder', size: 13 }), '输出位置'),
          h('div', { className: 'usb-out-row' },
            h('code', { className: 'usb-out-path mono' }, donePath),
            h('button', { className: 'mini-btn', onClick: copyPath }, h(Icon, { name: copied ? 'check' : 'copy', size: 12 }), copied ? '已复制' : '复制'),
            h('button', { className: 'mini-btn', onClick: showFolder }, h(Icon, { name: 'eye', size: 12 }), '在文件夹中显示'))),
        h('div', { className: 'dblock' },
          h('div', { className: 'dblock-h' }, h('span', { className: 'no' }, '1'), '包内文件', h('span', { className: 'aff-sum' }, files.length + ' 个')),
          h('div', { className: 'usb-files' }, files.map((name) => h('div', { key: name, className: 'usb-file' },
            h('span', { className: 'usb-file-ico' }, h(Icon, { name: 'doc', size: 14 })),
            h('div', { className: 'usb-file-meta' },
              h('div', { className: 'usb-file-n mono' }, name),
              h('div', { className: 'usb-file-u' }, USB_FILE_USE[name] || '')))))),
        h('div', { className: 'dblock' },
          h('div', { className: 'dblock-h' }, h('span', { className: 'no' }, '2'), '接下来三步'),
          h('div', { className: 'steps-list' },
            step(1, '插 U 盘到目标机'),
            step(2, '双击 UECM-Bootstrap.cmd，按提示以管理员运行'),
            step(3, '回到 Volo 点该机器「刷新」，确认已入网'))));
    } else if (phase === 'fail') {
      const fr = USB_FAILS[failReason] || { title: '生成失败', msg: failMsg || '未知错误', fix: '检查上面的输出位置与权限后重试；若反复失败，用 voloctl cache ssh package-bootstrap 在命令行排查。' };
      body = h(React.Fragment, null,
        h('div', { className: 'usb-fail' },
          h('div', { className: 'usb-fail-ico' }, h(Icon, { name: 'alert', size: 24 })),
          h('div', { className: 'usb-fail-t' }, fr.title),
          h('div', { className: 'usb-fail-d' }, fr.msg)),
        h('div', { className: 'usb-fix' }, h(Icon, { name: 'bolt', size: 13 }), h('span', null, fr.fix)));
    } else {
      /* idle — 输入区 */
      body = h(React.Fragment, null,
        h('div', { className: 'usb-field' },
          h('div', { className: 'usb-lbl' }, '输出位置', h('span', { className: 'usb-req' }, '必填')),
          h('div', { className: 'usb-dirpick' },
            h('span', { className: 'usb-dir-ico' }, h(Icon, { name: 'folder', size: 15 })),
            h('input', { className: 'usb-input mono', value: path, autoFocus: true, spellCheck: false,
              placeholder: '选择 U 盘所在文件夹，例如 E:\\Volo-SSH-Bootstrap',
              onChange: (e) => setPath(e.target.value) }),
            h('button', { className: 'mini-btn usb-browse', onClick: browse }, h(Icon, { name: 'folder', size: 12 }), '浏览…')),
          h('div', { className: 'usb-hint' }, '可直接选 U 盘盘符，生成的文件会落在这里。')),
        h('div', { className: 'usb-adv' },
          h('button', { className: 'usb-adv-h' + (advOpen ? ' on' : ''), onClick: () => setAdvOpen((v) => !v) },
            h(Icon, { name: 'chevr', size: 13, style: { transform: advOpen ? 'rotate(90deg)' : 'none' } }),
            '高级 · uecm-svc 密码（可选）'),
          advOpen ? h('div', { className: 'usb-adv-b' },
            h('input', { type: 'password', className: 'usb-input' + (pwBad ? ' bad' : ''), value: pw, spellCheck: false,
              placeholder: 'uecm-svc 密码（留空则现场人工填写）',
              onChange: (e) => setPw(e.target.value) }),
            pwBad
              ? h('div', { className: 'usb-err' }, h(Icon, { name: 'alert', size: 13 }),
                  h('span', null, '密码不能包含 ', h('b', null, badChars.join(' ')), ' —— cmd 解析会损坏密码，请移除。'))
              : h('div', { className: 'usb-hint' }, '填了会烤进入网包，目标机双击即自动创建账户；留空则需现场人工填写。')) : null),
        h('div', { className: 'usb-warn' }, h(Icon, { name: 'shield', size: 14 }),
          h('span', null, '入网包内含明文公钥，若填了密码也会以明文写入。U 盘属敏感物料，请妥善保管。')));
    }

    /* ---- footer ---- */
    let foot;
    if (!winOk) {
      foot = h('div', { className: 'drawer-f' },
        h(Button, { variant: 'secondary', size: 'M', onPress: close }, '关闭'),
        h(Button, { variant: 'accent', size: 'M', isDisabled: true, icon: h(Icon, { name: 'usb', size: 15 }) }, '生成入网包'));
    } else if (phase === 'gen') {
      foot = h('div', { className: 'drawer-f' },
        h(Button, { variant: 'secondary', size: 'M', isDisabled: true }, '生成中…'));
    } else if (phase === 'done') {
      foot = h('div', { className: 'drawer-f' },
        h(Button, { variant: 'secondary', size: 'M', icon: h(Icon, { name: 'usb', size: 14 }), onPress: () => { setResult(null); setPhase('idle'); } }, '再做一个'),
        h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'check', size: 15 }), onPress: close }, '完成'));
    } else if (phase === 'fail') {
      foot = h('div', { className: 'drawer-f' },
        h(Button, { variant: 'secondary', size: 'M', onPress: close }, '关闭'),
        h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'sync', size: 15 }), onPress: () => setPhase('idle') }, '重新生成'));
    } else {
      foot = h('div', { className: 'drawer-f' },
        h(Button, { variant: 'secondary', size: 'M', onPress: close }, '取消'),
        h(Button, { variant: 'accent', size: 'M', isDisabled: !canGen, icon: h(Icon, { name: 'usb', size: 15 }), onPress: generate }, '生成入网包'));
    }

    return h('div', { className: 'drawer drawer--usb' },
      h('div', { className: 'drawer-h' },
        h('span', { className: 'di info' }, h(Icon, { name: 'usb', size: 18 })),
        h('div', { style: { minWidth: 0 } },
          h('h2', null, '制作入网 U 盘'),
          h('div', { className: 'sub' }, h('span', { className: 'cli-pill' }, 'ssh package-bootstrap'),
            h('span', null, ' · 全局通用'))),
        h('button', { className: 'iconbtn x', onClick: close }, h(Icon, { name: 'x', size: 16 }))),
      h('div', { className: 'drawer-b' }, body),
      foot);
  }

  function drawer(s) {
    const d = s.drawer;
    if (!d) return null;
    if (d.kind === 'machine') return h(MachineDetail, { s, d });
    if (d.kind === 'preview') return h(PreviewPanel, { s, d });
    if (d.kind === 'script') return h(ScriptPanel, { s, d });
    if (d.kind === 'creds') return h(CredsPanel, { s });
    if (d.kind === 'usb') return h(UsbPackPanel, { s });
    return null;
  }

  const isCacheNav = (nav) => CACHE_MODULES.some((m) => m.id === nav) || /^ddc_/.test(nav);

  /* shared helpers for the playbook + resource files */
  Object.assign(CX, { dot, StatusPill, SevPill, ChannelTag, SEV, healthVisual, ringStyle, node,
    MachineSelector, predict, showInspector, openPreview, openModalPreview, refreshScan, taskVis, taskIcon, TaskCard });

  window.VOLO_CACHE = { isCacheNav, left, ctx, actions, center, inspector, drawer, modalLayer: (s) => h(ModalLayer, { s }) };
})();

export {};
