// @ts-nocheck
/* Volo — Cache (UECM) · 任务中心 + 资产域 + 常驻任务抽屉.
   1:1 port of the Claude Design handoff `src/page_cache.jsx`. Owns the shared
   cache helpers (window.VOLO_CX), the dual-layer left nav, the context bar,
   the landing page, the center router, the task drawer (right column) and the
   overlay dispatch (preview / machine detail). Machine + DDC pages live in
   cacheMachines.tsx / cacheDdc.tsx. */
import * as React from "react";
import "../ds";

(function () {
  const { Button, Badge } = window.Spectrum2DesignSystem_b6d1b3;
  const { useState } = React;
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
  function openPreview(s, spec) { s.setDrawer(Object.assign({ kind: 'preview' }, spec)); }

  /* =================== cluster status + actions =================== */
  function refreshScan(s) {
    s.runTask({ domain: 'health', action: 'run', target: '集群 · 8 台', chan: 'winrm',
      note: 'zen probe → cache-stats → health run',
      lines: [
        { msg: 'zen probe render-zen-01 → HTTP 200 /health' },
        { msg: 'zen cache-stats → 命中 94% · 3.1 TB' },
        { lv: 'warn', msg: 'health run L1/L2/L3 → 7 项（1 critical / 4 warning）' },
      ] });
  }
  function clusterChips() {
    return h('div', { className: 'cluster-sum' },
      h('span', { className: 'sum-grp' }, dot('positive'), '在线 ',
        h('b', null, CLUSTER.online), h('span', { className: 'frac' }, '/' + CLUSTER.total)),
      h('span', { className: 'health-chip lv-' + (CLUSTER.health >= 85 ? 'pos' : CLUSTER.health >= 60 ? 'not' : 'neg') },
        h(Icon, { name: 'pulse', size: 14 }), '健康分 ', h('b', null, CLUSTER.health)));
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
      icon = d.icon; title = d.label; sub = 'UECM · DDC';
    } else {
      const m = MODULE(s.cacheNav); icon = m.icon; title = m.label; sub = 'UECM · ' + m.sub;
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
        h('div', { className: 'sect-h' }, h('span', { className: 't' }, 'UECM · 缓存')),
        CACHE_MODULES.map((m) => {
          if (m.id !== 'ddc') return leaf(m);
          return h(React.Fragment, { key: 'ddc' },
            h('div', { className: 'nav-i nav-mod nav-head' },
              h('span', { className: 'nav-ico' }, h(Icon, { name: m.icon, size: 17 })),
              h('span', { className: 'nav-lbl' }, m.label)),
            h('div', { className: 'nav-children' }, DDC_NAV.map(child)));
        })),
      h('div', { className: 'sect', style: { marginTop: 'auto' } },
        h('div', { className: 'nav-i nav-mod', onClick: () => s.setDrawer({ kind: 'creds' }) },
          h('span', { className: 'nav-ico' }, h(Icon, { name: 'key', size: 17 })),
          h('span', { className: 'nav-lbl' }, '凭据管理'),
          h('span', { className: 'nav-sub' }, 'SecretStore'))));
  }

  /* =================== 集群总览 (Cluster Overview) · 全局概览 + 机器管理 =================== */
  /* fresh-setup 判定：开启「全新设置」且本会话尚未加入机器 → 空集群引导 */
  const isFresh = (s) => s.freshSetup && !s.machinesAdded;

  function Overview({ s }) {
    const [scanOpen, setScanOpen] = useState(false);
    const onScan = () => setScanOpen(true);
    const fresh = isFresh(s);
    const wizard = scanOpen ? window.VOLO_CACHE_MACHINES.ScanWizard({ s, onClose: () => setScanOpen(false) }) : null;

    /* ---------- 空集群引导：先扫描添加机器，巡检才有意义 ---------- */
    if (fresh) {
      const step = (n, icon, title, desc, on) => h('div', { className: 'ce-step' + (on ? ' on' : '') },
        h('span', { className: 'ce-step-n' }, on ? h(Icon, { name: 'arrowr', size: 13 }) : n),
        h('span', { className: 'ce-step-ico' }, h(Icon, { name: icon, size: 18 })),
        h('div', { className: 'ce-step-txt' }, h('div', { className: 'ce-step-t' }, title), h('div', { className: 'ce-step-d' }, desc)));
      return h('div', { className: 'dash' },
        h('div', { className: 'cluster-empty' },
          h('div', { className: 'ce-ico' }, h(Icon, { name: 'node', size: 36, stroke: 1.3 })),
          h('div', { className: 'ce-t' }, '集群里还没有机器'),
          h('div', { className: 'ce-d' }, '先扫描局域网，发现并加入机器。没有机器，巡检与缓存管理都无从谈起 —— 添加机器是第一步。'),
          h('div', { className: 'ce-acts' },
            h(Button, { variant: 'accent', size: 'L', icon: h(Icon, { name: 'search', size: 16 }), onPress: onScan }, '扫描局域网…')),
          h('div', { className: 'ce-steps' },
            step(1, 'search',   '扫描网段',   '输入 IP 或 CIDR，探活发现未纳管设备', true),
            step(2, 'download', '选择并加入', '勾选要纳管的机器，加入机器列表', false),
            step(3, 'pulse',    '巡检与部署', '机器就位后，才能巡检健康、部署缓存', false))),
        wizard);
    }

    /* ---------- 已有机器：全局概览 + 机器管理 ---------- */
    const cluster = RENDER_NODES.filter((n) => n.roleKey !== 'shared');
    const online = cluster.filter((n) => n.status !== 'offline');
    const zen = ZEN_ENDPOINTS[0];
    const share = SHARES[0];
    const offlineCt = cluster.filter((n) => n.status === 'offline').length;
    const alerts = HEALTH_CHECKS.filter((c) => c.status === 'critical' || c.status === 'warning').length
      + INI_FINDINGS.filter((f) => f.sev !== 'info').length;
    const overall = HEALTH_CHECKS.some((c) => c.status === 'critical') ? 'critical'
      : HEALTH_CHECKS.some((c) => c.status === 'warning') ? 'warning' : 'healthy';
    const fixCheck = (c) => CX.openPreview(s, {
      title: '应用修复 · ' + c.label, icon: 'pulse', cli: 'health remediation', destructive: false, channel: 'winrm',
      steps: [c.remediation, '修复后自动重新巡检这一项，确认是否恢复正常'], scope: [],
      simpleScope: [{ host: c.label, ip: c.layer, msg: c.remediation }],
      task: { domain: 'health', action: 'remediate', target: c.label, chan: 'winrm', note: c.remediation, lines: [{ msg: c.remediation }, { lv: 'ok', msg: '已修复，' + c.label + ' → healthy' }] },
    });
    const fixIni = (f) => CX.openPreview(s, {
      title: '应用修复 · ' + f.id + ' · ' + f.machine, icon: 'pulse', cli: 'ini apply', destructive: false, channel: 'winrm',
      steps: [f.file + ' ' + f.section + '：' + f.cur + ' → ' + f.rec, '先创建 .bak.<时间戳> 备份，apply 后自动 re-scan 确认 warning 计数下降'], scope: [],
      simpleScope: [{ host: f.machine, ip: f.file, msg: f.rec }],
      task: { domain: 'ini', action: 'apply', target: f.machine + ' · ' + f.file, chan: 'winrm', note: f.id + ' ' + f.cur + ' → ' + f.rec, lines: [{ msg: 'ini apply ' + f.id + ' → ' + f.rec }, { lv: 'ok', msg: '已修复，re-scan warning 计数下降' }] },
    });

    /* 只列「巡检发现有问题、需要处理」的事项：健康调查结果 + INI 一致性检查，各带一键修复 */
    const sevRank = { critical: 0, warning: 1 };
    const healthProblems = HEALTH_CHECKS
      .filter((c) => c.status === 'critical' || c.status === 'warning')
      .map((c) => ({ key: 'h_' + c.id, src: '健康', tag: c.layer, sev: c.status,
        label: c.label, detail: c.desc || c.detail, onFix: () => fixCheck(c) }));
    const iniProblems = INI_FINDINGS
      .filter((f) => f.sev === 'critical' || f.sev === 'warning')
      .map((f) => ({ key: 'i_' + f.id, src: 'INI', tag: f.rule, sev: f.sev,
        label: f.summary, detail: f.why, onFix: () => fixIni(f) }));
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

    return h('div', { className: 'dash' },
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
        const gpuNodes  = online.filter((n) => n.driver && n.driver !== '—');
        const gpuTotal  = gpuNodes.length;
        const gpuMatch  = gpuNodes.filter((n) => n.driver === BASELINE.driver).length;
        const gpuOk     = gpuMatch === gpuTotal;
        const probTone  = problems.length === 0 ? 's-positive' : critCt ? 's-negative' : 's-notice';
        return h('div', { className: 'dash-kpis' },
          kpi('node', '节点在线',
            onlineCt + ' / ' + totalCt + ' 台',
            allOnline ? 's-positive' : 's-negative',
            allOnline ? '全部在线' : (offlineCt + ' 台离线 · ' + onlineCt + ' 台在线'),
            allOnline ? 's-positive' : 's-negative'),
          kpi('cpu', 'GPU 一致性',
            gpuMatch + ' / ' + gpuTotal + ' 匹配',
            gpuOk ? 's-positive' : 's-notice',
            gpuOk ? '驱动全部对齐基线' : ((gpuTotal - gpuMatch) + ' 台驱动偏离基线 ' + BASELINE.driver),
            gpuOk ? 's-positive' : 's-notice'),
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
                    h('div', { className: 'dl' }, p.label),
                    h('div', { className: 'dd' }, h('span', { className: 'diag-rule' }, p.tag), p.detail)),
                  h('button', { className: 'fix-btn', onClick: p.onFix }, h(Icon, { name: 'bolt', size: 12 }), '修复'));
              }))),
        h('div', { className: 'dash-col' },
          h('div', { className: 'dash-card' },
            h('div', { className: 'dc-h' }, h('span', { className: 't' }, h(Icon, { name: 'list', size: 14 }), '最近任务'),
              h('span', { className: 'dc-n', style: { cursor: 'pointer' }, onClick: () => s.setLogOpen(true) }, 'NDJSON 流 →')),
            h('div', { className: 'recent' },
              s.tasks.slice(0, 5).map((t) => h('div', { key: t.id, className: 'recent-row compact', onClick: () => { s.setLogSearch('#' + t.no); s.setLogOpen(true); } },
                h('span', { className: 'tk-state s-' + taskVis(t.state) }, taskIcon(t)),
                h('span', { className: 'tk-title' }, t.title, h('span', { className: 'no' }, '#' + t.no)),
                h(ChannelTag, { ch: t.chan, mini: true }),
                t.state === 'running' ? h('span', { className: 'tk-pct' }, t.pct + '%') : h('span', { className: 'tk-el' }, t.elapsed))))))),
      wizard);
  }

  /* =================== center router =================== */
  function center(s) {
    switch (s.cacheNav) {
      case 'ddc_zen': case 'ddc_legacy': case 'ddc_pak': case 'ddc_pso':
        return window.VOLO_CACHE_DDC.ddc(s);
      default:         return h(Overview, { s });
    }
  }

  /* =================== task drawer (right column) =================== */
  const taskVis = (st) => st === 'running' ? 'accent' : st === 'success' ? 'positive' : st === 'failed' ? 'negative' : 'neutral';
  const taskIcon = (t) => t.state === 'running' ? h('span', { className: 'spin' }, h(Icon, { name: 'sync', size: 13 }))
    : t.state === 'success' ? h(Icon, { name: 'check', size: 13 })
    : t.state === 'failed' ? h(Icon, { name: 'x', size: 13 }) : h(Icon, { name: 'pause', size: 13 });

  function TaskCard({ s, t }) {
    const [open, setOpen] = useState(false);
    const seeStream = () => { s.setLogSearch('#' + t.no); s.setLogFilter('all'); s.setLogOpen(true); };
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

  function inspector(s) {
    const active = s.tasks.filter((t) => t.state === 'running' || t.state === 'queued');
    const history = s.tasks.filter((t) => t.state === 'success' || t.state === 'failed');
    const list = s.taskTab === 'active' ? active : history;
    return h('div', { className: 'task-drawer' },
      h('div', { className: 'td-head' },
        h('div', { className: 'td-title' }, h(Icon, { name: 'list', size: 15 }), '任务抽屉'),
        h('div', { className: 'td-tabs' },
          h('button', { className: s.taskTab === 'active' ? 'on' : '', onClick: () => s.setTaskTab('active') }, '进行中', h('span', { className: 'n' }, active.length)),
          h('button', { className: s.taskTab === 'history' ? 'on' : '', onClick: () => s.setTaskTab('history') }, '历史', h('span', { className: 'n' }, history.length)))),
      h('div', { className: 'td-body' },
        list.length === 0
          ? h('div', { className: 'td-empty' }, h('div', { className: 'ph' }, h(Icon, { name: s.taskTab === 'active' ? 'sync' : 'list', size: 26 })),
              h('div', null, s.taskTab === 'active' ? '当前没有运行中的任务' : '暂无历史任务'))
          : list.map((t) => h(TaskCard, { key: t.id, s, t }))));
  }

  /* =================== overlay · machine detail (6.2) =================== */
  const KV = (k, v, mono) => h('div', { className: 'kv', key: k }, h('span', { className: 'k' }, k), h('span', { className: 'v' + (mono ? ' mono' : '') }, v));

  /* ⑥ 已读到的 DDC 相关配置 — 只展示两项能真实读到的：
     ① 环境变量（本地 / 共享缓存路径，get_machine_env_var）
     ② 项目 DefaultEngine.ini 的 [StorageServers]（read_ini_section）
     这是读到的配置，不是“多层有效配置解析”。离线机无法读取。 */
  function ddcReadConfig(n) {
    if (n.status === 'offline' || !n.cfg) return null;
    const drv = /^([A-Za-z]):/.test(n.uePath) ? n.uePath[0].toUpperCase() : 'D';
    const zf = INI_FINDINGS.find((f) => f.machine === n.host && f.section.indexOf('StorageServers') >= 0);
    const env = { local: drv + ':\\UE_DDC\\Local', shared: n.share || null };
    const ini = zf
      ? { ok: false, val: '[StorageServers] Shared 缺失', note: zf.id + ' · 未写入共享上游服务器' }
      : { ok: !!n.zen,
          val: n.zen ? '[StorageServers] Shared = render-zen-01:1337' : '[StorageServers] 未配置 Zen 上游',
          note: n.zen ? '随版本库下发' : '未配置共享上游' };
    return { env, ini, hasFix: !!zf };
  }

  /* SSH key 现场入网脚本（get_winrm_bootstrap_script 返回的脚本文本） */
  function bootstrapScript(n) {
    return [
      '# enable-ssh.ps1 — Volo 现场入网脚本（以管理员身份运行）',
      '# 目标机：' + n.host + '  (' + n.ip + ')',
      '',
      '# 1) 安装并启用 OpenSSH Server',
      'Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0',
      'Set-Service sshd -StartupType Automatic',
      'Start-Service sshd',
      '',
      '# 2) 放行防火墙 22 端口',
      'New-NetFirewallRule -Name sshd -DisplayName "OpenSSH Server" `',
      '  -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22',
      '',
      '# 3) 写入 Volo operator 的 SSH 公钥（免密登录）',
      '$key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA… uecm-operator"',
      '$f = "$Env:ProgramData\\ssh\\administrators_authorized_keys"',
      'Add-Content -Path $f -Value $key',
      'icacls $f /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F"',
      '',
      '# 完成后回到 Volo，点「刷新」确认入网状态',
    ].join('\n');
  }

  function ScriptPanel({ s, d }) {
    const n = node(d.id);
    const [copied, setCopied] = useState(false);
    if (!n) return null;
    const close = () => s.setDrawer(null);
    const script = bootstrapScript(n);
    const copy = () => { try { navigator.clipboard.writeText(script); } catch (e) {} setCopied(true); setTimeout(() => setCopied(false), 1500); };
    const refresh = () => {
      close();
      if (s.setEnrolled) s.setEnrolled((v) => v.includes(n.id) ? v : v.concat(n.id));
      s.runTask({ domain: 'machine', action: 'refresh', target: n.host, chan: 'ssh', note: '刷新入网状态（SSH 探活）',
        lines: [{ msg: 'refresh_machine ' + n.host + ' — 探 SSH:22 / UE / GPU' }, { lv: 'ok', msg: n.host + ' SSH 可达 · 已入网' }] });
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
        h('div', { className: 'dblock' },
          h('div', { className: 'dblock-h' }, h('span', { className: 'no' }, '1'), '操作步骤'),
          h('div', { className: 'steps-list' },
            step(1, '把脚本拷贝到目标机 ' + n.host + '（' + n.ip + '）'),
            step(2, '以管理员运行 enable-ssh.ps1'),
            step(3, '回到 Volo，点下方「刷新」确认入网'))),
        h('div', { className: 'dblock' },
          h('div', { className: 'dblock-h' }, h('span', { className: 'no' }, '2'), 'enable-ssh.ps1',
            h('button', { className: 'mini-btn script-copy', onClick: copy }, h(Icon, { name: copied ? 'check' : 'copy', size: 12 }), copied ? '已复制' : '复制')),
          h('pre', { className: 'script-code' }, script))),
      h('div', { className: 'drawer-f' },
        h(Button, { variant: 'secondary', size: 'M', onPress: close }, '关闭'),
        h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'sync', size: 15 }), onPress: refresh }, '已运行 · 刷新')));
  }
  function machineDetail(s, d) {
    const n = node(d.id);
    if (!n) return null;
    const off = n.status === 'offline';
    const close = () => s.setDrawer(null);
    const recentHealth = HEALTH_CHECKS.filter((c) => (c.detail || '').includes(n.host)).slice(0, 2);
    const cfg = ddcReadConfig(n);
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
              onPress: () => s.setDrawer({ kind: 'script', id: n.id }) }, '获取入网脚本'),
            h('div', { className: 'deploy-ok-note' }, 'SSH key 现场入网 · 拷到目标机运行后回来刷新'))) : null,
        h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, '① 身份'),
          KV('IP 地址', n.ip, true), KV('角色', n.role), KV('最后在线', n.last)),
        h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, '② UE 安装'),
          KV('版本', n.ue), KV('安装路径', n.uePath, true)),
        h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, '③ GPU（入网后自动采集 · 已过滤虚拟适配器）'),
          KV('型号', n.gpu), KV('驱动', n.driver, true), KV('显存', n.vram + ' GB'), KV('厂商', n.vendor)),
        h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, '④ 入网账户（SSH key · 现场入网）'),
          KV('登录账户', n.user, true), KV('认证方式', 'SSH 公钥'), KV('域', n.domain)),
        h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, '⑤ 关联（自动发现）'),
          h('div', { className: 'rev-links' },
            n.zen ? h('span', { className: 'rev', onClick: () => { s.setDrawer(null); s.setCacheNav('ddc_zen'); } }, h(Icon, { name: 'cube', size: 13 }), n.zen) : null,
            n.share ? h('span', { className: 'rev', onClick: () => { s.setDrawer(null); s.setCacheNav('ddc_zen'); } }, h(Icon, { name: 'folder', size: 13 }), '共享 DDC') : null,
            (n.proj || []).map((p) => h('span', { key: p, className: 'rev' }, h(Icon, { name: 'film', size: 13 }), p)),
            !n.zen && !n.share && !(n.proj || []).length ? h('span', { className: 'dim', style: { fontSize: 12 } }, '无关联资源') : null)),
        cfg ? h('div', { className: 'insp-sect' },
          h('div', { className: 'lh ddc-scan-h' }, h('span', { className: 'ddc-scan-title' }, '⑥ 已读到的 DDC 相关配置'),
            h('button', { className: 'mini-btn ddc-rescan', onClick: () => { close(); s.runTask({ domain: 'ddc', action: 'read-config', target: n.host, chan: 'ssh', note: '读取 DDC 相关配置（环境变量 + DefaultEngine.ini）',
              lines: [{ msg: 'get_machine_env_var ' + n.host + ' UE-LocalDataCachePath / UE-SharedDataCachePath' }, { msg: 'read_ini_section ' + n.host + ' DefaultEngine.ini [StorageServers]' }, { lv: 'ok', msg: '已读取 · 这是读到的配置，非有效配置解析' }] }); } },
              h(Icon, { name: 'search', size: 12 }), '重新读取')),
          h('div', { className: 'ddc-read-note' }, h(Icon, { name: 'eye', size: 12 }), '这是从这台机器读到的配置，不是有效配置解析。'),
          h('div', { className: 'ddc-read-row' },
            h('div', { className: 'ddc-read-h' }, h('span', { className: 'ddc-read-k' }, '① 环境变量'), h('code', { className: 'ddc-tfile' }, '系统环境变量')),
            KV('本地缓存路径', cfg.env.local, true),
            KV('共享缓存路径', cfg.env.shared || '未设', true)),
          h('div', { className: 'ddc-read-row' + (cfg.ini.ok ? '' : ' miss') },
            h('div', { className: 'ddc-read-h' }, h('span', { className: 'ddc-read-k' }, '② 项目配置'), h('code', { className: 'ddc-tfile' }, 'DefaultEngine.ini')),
            h('div', { className: 'ddc-read-val mono' + (cfg.ini.ok ? '' : ' empty') }, cfg.ini.val),
            h('div', { className: 'ddc-read-sub' + (cfg.ini.ok ? '' : ' warn') }, cfg.ini.note))) : null,
        recentHealth.length ? h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, '⑦ 最近健康'),
          recentHealth.map((c) => h('div', { key: c.id, className: 'mini-health' }, dot(SEV[c.status].visual), h('span', null, c.label), h('span', { className: 'd' }, c.detail)))) : null),
      h('div', { className: 'drawer-f between' },
        h(Button, { variant: 'secondary', size: 'M', icon: h(Icon, { name: 'search', size: 14 }), isDisabled: off,
          onPress: () => { close(); s.runTask({ domain: 'machine', action: 'refresh', target: n.host, chan: n.chan, note: '探 UE / GPU / last-seen', lines: [{ msg: `refresh ${n.host} …` }, { lv: 'ok', msg: '已更新 UE 安装与 GPU 信息' }] }); } }, '刷新'),
        h(Button, { variant: 'negative', size: 'M', icon: h(Icon, { name: 'trash', size: 14 }),
          onPress: () => openPreview(s, {
            title: '删除机器 · ' + n.host, icon: 'trash', cli: 'machine delete', destructive: true, channel: n.chan,
            steps: ['从集群中移除机器 ' + n.host, '解除它与共享缓存、ZenServer 的关联', '清除已保存的这台机器的登录凭据'],
            scope: [n.id], confirmInput: true,
            task: { domain: 'machine', action: 'delete', target: n.host, chan: n.chan, note: '已从集群移除', lines: [{ lv: 'warn', msg: `删除 ${n.host} … 解除关联` }, { lv: 'ok', msg: `${n.host} 已移除` }] },
          }) }, '删除机器')));
  }

  /* =================== overlay · preview→confirm→execute (5.1) =================== */
  function PreviewPanel({ s, d }) {
    const [scope, setScope] = useState(d.scope || []);
    const [confirmCk, setConfirmCk] = useState(false);
    const simple = d.simpleScope || null;
    const rows = simple ? [] : predict(scope, d.destructive);
    const willApply = simple ? simple.length : rows.filter((r) => !r.skip).length;
    const willSkip = simple ? 0 : rows.filter((r) => r.skip).length;
    const count = simple ? simple.length : scope.length;
    const blocked = d.destructive && d.confirmInput && count > 1 && !confirmCk;
    const close = () => s.setDrawer(null);
    const confirm = () => {
      close();
      if (d.task) s.runTask(Object.assign({}, d.task, { chan: d.channel || d.task.chan }));
      if (d.onConfirm) d.onConfirm();
    };
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
          h('div', { className: 'dblock-h' }, h('span', { className: 'no' }, d.diff ? '3' : '2'), simple ? '目标设备' : '影响范围 · 机器选择器',
            h('span', { className: 'aff-sum' }, simple ? (simple.length + ' 台') : (willApply + ' 应用 / ' + willSkip + ' 跳过'))),
          simple
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
          icon: h(Icon, { name: 'check', size: 15 }), onPress: confirm }, d.confirmLabel || '确认执行')));
  }

  function CredsPanel({ s }) {
    const close = () => s.setDrawer(null);
    const creds = s.creds || [];
    const [confirmDel, setConfirmDel] = useState(null);
    const [adding, setAdding] = useState(false);
    const [form, setForm] = useState({ name: '', kind: '域账户', username: '' });
    const KINDS = ['域账户', '服务账户', '本地账户'];
    const addCred = () => {
      const nm = form.name.trim();
      if (!nm) return;
      s.setCreds((cs) => cs.concat([{ id: 'c' + Date.now(), name: nm, kind: form.kind, domain: form.kind === '本地账户' ? '—' : 'VOLO', use: '共享 DDC', machines: 0, last: '刚刚' }]));
      s.runTask({ domain: 'cred', action: 'save', target: nm, chan: 'ssh', note: '写入 SecretStore（AES-GCM）', lines: [{ msg: 'save_credential ' + nm }, { lv: 'ok', msg: nm + ' 已写入 SecretStore' }] });
      setForm({ name: '', kind: '域账户', username: '' }); setAdding(false);
    };
    const delCred = (c) => {
      s.setCreds((cs) => cs.filter((x) => x.id !== c.id));
      s.runTask({ domain: 'cred', action: 'delete', target: c.name, chan: 'ssh', note: '从 SecretStore 删除', lines: [{ lv: 'warn', msg: 'delete_credential ' + c.name }, { lv: 'ok', msg: c.name + ' 已删除' }] });
      setConfirmDel(null);
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
              h('div', { className: 'cred-add-kinds' }, KINDS.map((k) => h('button', { key: k, className: 'cred-kind' + (form.kind === k ? ' on' : ''), onClick: () => setForm((f) => Object.assign({}, f, { kind: k })) }, k))),
              h('input', { className: 'dp-input mono', placeholder: '凭据名 / alias（如 zen-svc）', value: form.name, autoFocus: true, spellCheck: false, onChange: (e) => setForm((f) => Object.assign({}, f, { name: e.target.value })), onKeyDown: (e) => { if (e.key === 'Enter') addCred(); } }),
              h('div', { className: 'cred-add-acts' },
                h(Button, { variant: 'secondary', size: 'M', onPress: () => { setAdding(false); setForm({ name: '', kind: '域账户', username: '' }); } }, '取消'),
                h(Button, { variant: 'accent', size: 'M', isDisabled: !form.name.trim(), icon: h(Icon, { name: 'check', size: 14 }), onPress: addCred }, '保存凭据')))
          : h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'plus', size: 15 }), onPress: () => setAdding(true) }, '新增凭据')));
  }

  function drawer(s) {
    const d = s.drawer;
    if (!d) return null;
    if (d.kind === 'machine') return machineDetail(s, d);
    if (d.kind === 'preview') return h(PreviewPanel, { s, d });
    if (d.kind === 'script') return h(ScriptPanel, { s, d });
    if (d.kind === 'creds') return h(CredsPanel, { s });
    return null;
  }

  const isCacheNav = (nav) => CACHE_MODULES.some((m) => m.id === nav) || /^ddc_/.test(nav);

  /* shared helpers for the playbook + resource files */
  Object.assign(CX, { dot, StatusPill, SevPill, ChannelTag, SEV, healthVisual, ringStyle, node,
    MachineSelector, predict, openPreview, refreshScan, taskVis, taskIcon });

  window.VOLO_CACHE = { isCacheNav, left, ctx, actions, center, inspector, drawer };
})();

export {};
