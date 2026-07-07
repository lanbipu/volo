// @ts-nocheck
/* Volo — 校正 · AR 舞台校正（stage_type = "ar" · 无 LED 屏 · 实景叠加）骨架.
   1:1 port of the Claude Design handoff `src/cal2_ar.jsx`, wired to real vpcal
   （沿用 calLens.tsx 已确立的「设计稿 1:1 port + 真实接线」范式，而非照抄设计稿的
   React.createElement 字面结构）。

   本文件：AR 工作区 store（session/marker map/runs 根 三项路径 + 本会话「最近一次」
   结果快照，供概览页与各工具页共享）· 共享原子（gradeBadge/confBadge/pxBadge/wsDot）·
   通用一次性 vpcal 调用 hook（useVpcalRun，供 calArTools.tsx / calArVerify.tsx 复用）·
   左栏导航 · center/inspector 路由 · AR 概览页。

   数据规格核实自 docs/design/CALIBRATE-UX.md §4.1/§4.2 与 sidecars/vpcal CLI 源码；
   marker-map validate 不出逐 marker 列表、镜头与内参整页后端待接，均按文档如实处理，
   不用假数据冒充（data.tsx 仅新增三个纯状态徽标映射表 AR_GRADE/AR_CONF/AR_WS_STATUS，
   无工程数据 mock）。 */
import * as React from "react";
import "../ds";
import { pickFile, pickDirectory, revealPath } from "../api/commands";
import { spawnSidecarStreaming, useSidecarStream } from "../api/sidecarStream";

(function () {
  const { useState, useEffect, useSyncExternalStore } = React;
  const h = React.createElement;
  const CX = window.VOLO_CAL2 || {};

  /* ============================================================
     AR 工作区 store —— session / marker map / runs 根目录三项路径
     （localStorage 持久化，键名对齐设计文档 §4.1）+ 本会话「最近一次」结果快照
     + 各工具页运行态（供概览页「进行中任务」区据实渲染，不编造）。
     ============================================================ */
  const AR_LS_KEY = { session: 'volo-ar-session', markermap: 'volo-ar-markermap', runsroot: 'volo-ar-runsroot' };
  function loadArPath(key) { try { return localStorage.getItem(AR_LS_KEY[key]); } catch (e) { return null; } }
  function saveArPath(key, p) { try { p ? localStorage.setItem(AR_LS_KEY[key], p) : localStorage.removeItem(AR_LS_KEY[key]); } catch (e) {} }
  function baseName(p) { return p ? p.split(/[\\/]/).pop() : null; }
  function dirName(p) { return p ? p.replace(/[\\/][^\\/]*$/, '') : null; }

  const arStore = (() => {
    let st = {
      sessionPath: loadArPath('session'), markerMapPath: loadArPath('markermap'), runsRoot: loadArPath('runsroot'),
      /* 本会话「最近一次」结果——各存完整 envelope data（不是精简摘要），这样切换工具页
         再切回来时（组件会卸载/重挂载，本地 useVpcalRun 状态会丢）仍能看到上次真实结果，
         同时概览页的四张状态卡也从这里派生，不用另外维护一份摘要。无历史注册表，重开 app
         即清空，概览页据此显示「未校验/未求解/…」空态。 */
      lastValidate: null, /* marker-map validate 的 data：{ validation, ground_plane, world_alignment } */
      lastSpatial: null,  /* quick run 的 data：{ result:{quality,tracker_to_stage,...}, qa, confidence, solver_backend, output_dir } */
      lastDelay: null,    /* capture delay-cal 的 data：{ cameras:[{delay_ms,sigma_ms,confidence,num_markers,num_frames}], recommendation } */
      lastVerify: null,   /* verify overlay 的 data：{ global_rms_px, global_max_px, num_frames, num_observations, per_marker, annotated_images, legend } */
      running: {},         /* { markers|spatial|delay|verify: true } —— 各工具页发起真实调用时置位 */
    };
    const listeners = new Set();
    const notify = () => listeners.forEach((l) => l());
    return {
      get: () => st,
      patch: (p) => { st = { ...st, ...p }; notify(); },
      setRunning: (key, v) => { st = { ...st, running: { ...st.running, [key]: v } }; notify(); },
      subscribe: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    };
  })();
  function useArWorkspace() { return useSyncExternalStore(arStore.subscribe, arStore.get); }

  const arField = (key) => key === 'markermap' ? 'markerMapPath' : key === 'runsroot' ? 'runsRoot' : 'sessionPath';
  /* 切换某个工作区路径时，连带清空依赖它的「最近一次」结果快照——否则新路径会顶着旧
     路径的 grade / RMS 继续展示为「已校验 / 已求解」，后续校平、export 等判断也会拿
     旧快照当真（实测复现：校验 map A 后换成 map B，工作区仍显示 A 的世界对齐等级）。
     runsroot 只是扫描目录，不对应任何 last* 快照，无需清。 */
  const STALE_ON_PATH_CHANGE = {
    session: ['lastSpatial', 'lastDelay', 'lastVerify'],
    markermap: ['lastValidate'],
    runsroot: [],
  };
  /* 直接设置工作区路径（已知路径，如校平后的输出文件），不弹选择框 */
  function setArPath(key, p) {
    saveArPath(key, p);
    const patch = { [arField(key)]: p };
    for (const k of STALE_ON_PATH_CHANGE[key] || []) patch[k] = null;
    arStore.patch(patch);
  }
  /* 更换工作区路径：exts 传数组走 pickFile，传 null 走 pickDirectory（runs 根目录） */
  async function pickArPath(key, exts, label) {
    let p;
    try { p = exts ? await pickFile(label, exts) : await pickDirectory(); } catch (e) { return null; }
    if (!p) return null;
    setArPath(key, p);
    return p;
  }

  /* ============================================================
     通用一次性 vpcal 调用 hook（--output json，单条 envelope）。
     供 calArTools.tsx / calArVerify.tsx 的 markers/spatial/delay/verify 四个真实
     接线的工具页共用；成功/失败判定与 calLens.tsx 的 useLensSolve 同一套路。
     ============================================================ */
  function useVpcalRun() {
    const [taskId, setTaskId] = useState(null);
    const [data, setData] = useState(null);
    const [err, setErr] = useState(null);
    const [running, setRunning] = useState(false);
    const { state, cancel: cancelStream } = useSidecarStream(taskId);
    useEffect(() => {
      if (!state.exit) return;
      const last = state.lines[state.lines.length - 1];
      const env = last && last.parsed && typeof last.parsed === 'object' ? last.parsed : null;
      if (env && env.status === 'ok') { setData(env.data || {}); setErr(null); }
      else {
        const msg = (env && env.error && env.error.message) || state.exit.stderr_tail || `进程异常退出（exit ${state.exit.exit_code}）`;
        setErr({ exitCode: state.exit.exit_code, msg });
      }
      setRunning(false); setTaskId(null);
    }, [state.exit]);
    const run = async (argv) => {
      setErr(null); setData(null); setRunning(true);
      try { const resp = await spawnSidecarStreaming('vpcal', argv.concat(['--output', 'json'])); setTaskId(resp.task_id); }
      catch (e) { setRunning(false); setErr({ exitCode: null, msg: e && e.message ? e.message : String(e) }); }
    };
    const cancel = () => { cancelStream(); setTaskId(null); setRunning(false); };
    const reset = () => { setData(null); setErr(null); };
    return { run, data, err, running, cancel, reset };
  }

  /* 一次性 spawnSidecar 输出解析（--output json，stdout 最后一条 JSON 行 = envelope）。
     供不需要流式进度的短命令用（marker-map board/cube、export opentrackio）。 */
  function parseEnvelope(out) {
    if (!out || !out.stdout) return null;
    const lines = out.stdout.trim().split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try { const o = JSON.parse(lines[i]); if (o && (o.status === 'ok' || o.status === 'error')) return o; } catch (e) {}
    }
    return null;
  }

  /* 页壳：canvas-head + 滚动 dash（1:1 移植自 cal2_ar_pages.jsx 的 Page） */
  function Page({ title, chip, right, children }) {
    return h('div', { className: 'cal2-page' },
      h('div', { className: 'canvas-head' },
        h('span', { className: 't' }, title),
        chip ? h('span', { className: 'toolchip' }, chip) : null,
        h('div', { className: 'right' }, right)),
      h('div', { className: 'dash', style: { paddingTop: 14 } }, children));
  }
  const gm = (k, v, mono) => h('div', { className: 'ar-gm', key: k }, h('span', { className: 'k' }, k), h('span', { className: 'v' + (mono ? ' mono' : '') }, v));

  /* ---------- 共享原子（1:1 逻辑移植自 cal2_ar.jsx） ---------- */
  function gradeBadge(g) {
    const m = AR_GRADE[g] || AR_GRADE['n/a'];
    return h('span', { className: 'cap-pill cap-pill--' + m.tone },
      m.icon === 'minus' ? h('span', { style: { fontWeight: 700 } }, '—') : h(Icon, { name: m.icon, size: 12 }), m.label);
  }
  const confKey = (c) => typeof c === 'number' ? (c >= 0.85 ? 'high' : c >= 0.6 ? 'medium' : c >= 0.35 ? 'low' : 'very_low') : c;
  function confBadge(c) {
    const k = confKey(c), m = AR_CONF[k] || AR_CONF.medium;
    return h('span', { className: 'cap-pill cap-pill--' + m.tone },
      h(Icon, { name: m.tone === 'positive' ? 'check' : 'alert', size: 12 }), m.label);
  }
  /* 置信度 → 环形进度百分比（仅用于视觉进度环；字符串档取代表性中位值，数值档原样换算） */
  const CONF_PCT = { high: 92, medium: 66, low: 40, very_low: 16 };
  const confPct = (c) => typeof c === 'number' ? Math.round(c * 100) : (CONF_PCT[confKey(c)] || 50);
  function pxBadge(px, lim) {
    lim = lim || [1, 2];
    const { Badge } = window.Spectrum2DesignSystem_b6d1b3;
    if (px == null) return h(Badge, { variant: 'neutral', size: 'S' }, 'n/a');
    const v = px < lim[0] ? 'positive' : px < lim[1] ? 'notice' : 'negative';
    return h(Badge, { variant: v, size: 'S' }, px.toFixed(2) + ' px');
  }
  function wsDot(status) {
    const m = AR_WS_STATUS[status] || AR_WS_STATUS.unset;
    return h('span', { className: 'ar-ws-dot ar-ws-dot--' + m.tone, title: m.label },
      m.icon === 'check' ? h(Icon, { name: 'check', size: 10 }) : null);
  }

  /* ---------- 左栏 ---------- */
  const AR_ITEMS = [
    { id: 'markers', icon: 'pin',    label: '真值导入与检查' },
    { id: 'lens',    icon: 'camera', label: '镜头与内参', tag: '待接' },
    { id: 'spatial', icon: 'cube',   label: '空间求解' },
    { id: 'delay',   icon: 'pulse',  label: '延迟校准' },
    { id: 'verify',  icon: 'eye',    label: '验证叠加' },
    { id: 'runs',    icon: 'list',   label: '历史与导出' },
  ];
  /* ws 由调用方（calibrate.tsx 的 left(s)）在 calStageType 分支判断之前无条件调用
     一次 window.VOLO_CAL_AR.useArWorkspace() 后传入 —— arLeft 本身以纯函数形式被
     直接调用（不是 h(ArLeft,{s}) 元素），若在这里面再调 hook 会在 LED/AR 之间改变
     left() 这个 Slot 的 hook 调用次序（Rules of Hooks 违规，实测触发过 React 报错）。 */
  function arLeft(s, ws) {
    const nav = s.calArNav || 'overview';
    const go = (id) => s.setCalArNav(id);
    const child = (it) => h('div', {
      key: it.id, className: 'nav-i nav-child cal2-nav' + (nav === it.id ? ' on' : ''),
      onClick: () => go(it.id),
    },
      h('span', { className: 'nav-ico' }, h(Icon, { name: it.icon, size: 15 })),
      h('span', { className: 'nav-lbl' }, it.label),
      it.tag ? h('span', { className: 'nav-tag' }, it.tag) : null);
    const spatialRms = ws.lastSpatial ? ws.lastSpatial.result.quality.validation_rms_px : null;
    const delayMs = ws.lastDelay && ws.lastDelay.cameras[0] ? ws.lastDelay.cameras[0].delay_ms : null;
    const verifyRms = ws.lastVerify ? ws.lastVerify.global_rms_px : null;
    const roll = (label, v, fmt) => h(React.Fragment, { key: label },
      h('div', { className: 'top', style: label === '空间 RMS' ? null : { marginTop: 10 } }, h('span', null, label), h('span', { className: 'mono' }, v != null ? fmt(v) : '—')),
      h('div', { className: 'vmeter vmeter--' + (v != null ? 'positive' : 'neutral') }, h('div', { className: 'vmeter__fill', style: { width: v != null ? '82%' : '0%' } })));
    return h(React.Fragment, null,
      h('div', { className: 'sect' },
        h('div', { className: 'sect-h' }, h('span', { className: 't' }, 'AR · 舞台校正')),
        h('div', { className: 'nav-i nav-mod cal2-nav' + (nav === 'overview' ? ' on' : ''), onClick: () => go('overview') },
          h('span', { className: 'nav-ico' }, h(Icon, { name: 'grid', size: 17 })),
          h('span', { className: 'nav-lbl' }, '概览'),
          h('span', { className: 'nav-sub' }, 'AR')),
        h('div', { className: 'nav-i nav-mod nav-head cal2-grouphd', onClick: () => s.setCalArToolsOpen((v) => !v) },
          h('span', { className: 'nav-ico' }, h(Icon, { name: 'cube', size: 17 })),
          h('span', { className: 'nav-lbl' }, '空间校正'),
          h('span', { className: 'cal2-caret', style: { transform: s.calArToolsOpen ? 'none' : 'rotate(-90deg)' } }, h(Icon, { name: 'chevd', size: 14 }))),
        s.calArToolsOpen ? h('div', { className: 'nav-children' }, AR_ITEMS.map(child)) : null),
      h('div', { className: 'sect', style: { marginTop: 'auto' } },
        h('div', { className: 'farm-roll' },
          roll('空间 RMS', spatialRms, (v) => v.toFixed(2) + ' px'),
          roll('延迟', delayMs, (v) => '+' + v.toFixed(1) + ' ms'),
          roll('验证 RMS', verifyRms, (v) => v.toFixed(2) + ' px'))));
  }

  /* ---------- center / inspector 路由 ---------- */
  function arCenter(s) {
    const AR = window.VOLO_CAL_AR || {};
    switch (s.calArNav) {
      case 'markers': return AR.Markers ? h(AR.Markers, { s }) : null;
      case 'lens':    return AR.Lens ? h(AR.Lens, { s }) : null;
      case 'spatial': return AR.Spatial ? h(AR.Spatial, { s }) : null;
      case 'delay':   return AR.Delay ? h(AR.Delay, { s }) : null;
      case 'verify':  return AR.Verify ? h(AR.Verify, { s }) : null;
      case 'runs':    return AR.Runs ? h(AR.Runs, { s }) : null;
      default:        return h(Overview, { s });
    }
  }
  /* 纯函数，内部不调用 hook：本函数只在 s.calStageType === 'ar' 时才会被
     calibrate.tsx 的 inspector(s) 调用，若在这里面调 useArWorkspace() 会导致该
     hook 只在 AR 态渲染时才执行，切 LED/AR 之间会改变 Slot 的 hook 调用次序
     （Rules of Hooks 违规）。ws 由调用方在分支判断之前无条件调用一次
     window.VOLO_CAL_AR.useArWorkspace() 后传入（同 calLens.tsx 的 lensInspector(s, live) 写法）。 */
  function arInspector(s, ws) {
    const AR = window.VOLO_CAL_AR || {};
    if (s.calArNav === 'verify' && AR.verifyInspector) return AR.verifyInspector(s, ws);
    return CX.inspEmpty ? CX.inspEmpty('AR 校正细节在各工具页内查看') : null;
  }

  /* =================== AR 概览（默认落点） =================== */
  function WorkspaceRow({ icon, label, kind, path, statusKey, onSwap }) {
    return h('div', { className: 'ar-ws-row' },
      h('span', { className: 'ar-ws-ic' }, h(Icon, { name: icon, size: 16 })),
      h('div', { className: 'ar-ws-m' },
        h('div', { className: 'ar-ws-lbl' }, label, h('span', { className: 'ar-ws-kind' }, kind)),
        h('div', { className: 'ar-ws-file' },
          path
            ? h(React.Fragment, null, h('b', null, baseName(path)), h('span', { className: 'ar-ws-path' }, dirName(path)))
            : h('span', { className: 'ar-ws-path' }, '未设置'))),
      h('span', { className: 'ar-ws-st' }, wsDot(statusKey), h('span', null, (AR_WS_STATUS[statusKey] || AR_WS_STATUS.unset).label)),
      path ? h('button', { className: 'cal2-folderbtn', onClick: () => revealPath(path).catch(() => {}) }, h(Icon, { name: 'external', size: 13 }), '打开') : null,
      h('button', { className: 'ar-ws-swap', onClick: onSwap }, path ? '更换' : '设置'));
  }
  function WorkspaceCard() {
    const ws = useArWorkspace();
    return h('div', { className: 'dash-card' },
      h('div', { className: 'dc-h' },
        h('span', { className: 't' }, h(Icon, { name: 'sliders', size: 14 }), 'AR 工作区'),
        h('span', { className: 'dc-n' }, '三项设置一处管理 · 全部工具共享')),
      h('div', { className: 'ar-ws' },
        h(WorkspaceRow, {
          icon: 'doc', label: 'session 配置', kind: 'session.json', path: ws.sessionPath,
          statusKey: ws.sessionPath ? (ws.lastSpatial || ws.lastDelay || ws.lastVerify ? 'checked' : 'set') : 'unset',
          onSwap: () => pickArPath('session', ['json'], 'session 配置'),
        }),
        h(WorkspaceRow, {
          icon: 'pin', label: 'marker map', kind: '真值 JSON', path: ws.markerMapPath,
          statusKey: ws.markerMapPath ? (ws.lastValidate ? 'checked' : 'set') : 'unset',
          onSwap: () => pickArPath('markermap', ['json'], 'marker map JSON'),
        }),
        h(WorkspaceRow, {
          icon: 'folder', label: 'runs 根目录', kind: '目录', path: ws.runsRoot,
          statusKey: ws.runsRoot ? 'set' : 'unset',
          onSwap: () => pickArPath('runsroot', null),
        })));
  }

  function StatusCards({ s }) {
    const ws = useArWorkspace();
    const go = (id) => s.setCalArNav(id);
    const card = (id, icon, title, body, empty) => h('button', { key: id, className: 'ar-ovcard', onClick: () => go(id) },
      h('div', { className: 'ar-ovcard-h' }, h('span', { className: 'ar-ovcard-ic' }, h(Icon, { name: icon, size: 15 })), h('span', { className: 'ar-ovcard-t' }, title), h('span', { className: 'ar-ovcard-go' }, h(Icon, { name: 'chevr', size: 13 }))),
      empty ? h('div', { className: 'ar-ovcard-empty' }, empty) : body);
    const V = ws.lastValidate, SP = ws.lastSpatial, D = ws.lastDelay && ws.lastDelay.cameras[0], VF = ws.lastVerify;
    const spq = SP && SP.result.quality;
    return h('div', { className: 'ar-ovcards' },
      card('markers', 'pin', '真值', V && h('div', { className: 'ar-ovcard-b' }, gradeBadge(V.world_alignment.grade),
        h('div', { className: 'ar-ovcard-meta' }, V.validation.num_markers + ' markers')), !V ? '未校验' : null),
      card('spatial', 'cube', '空间求解', spq && h('div', { className: 'ar-ovcard-b' },
        h('div', { className: 'ar-ovcard-num' }, spq.validation_rms_px != null ? spq.validation_rms_px.toFixed(2) : 'n/a', h('span', null, ' px')),
        h('div', { className: 'ar-ovcard-meta' }, 'validation_rms_px · ', confBadge(spq.confidence))), !spq ? '未求解' : null),
      card('delay', 'pulse', '延迟', D && h('div', { className: 'ar-ovcard-b' },
        h('div', { className: 'ar-ovcard-num' }, D.delay_ms != null ? ('+' + D.delay_ms.toFixed(1)) : 'n/a', h('span', null, ' ms ± ' + (D.sigma_ms != null ? D.sigma_ms.toFixed(1) : 'n/a'))),
        h('div', { className: 'ar-ovcard-meta' }, 'delay_ms · ', confBadge(D.confidence))), !D ? '未校准' : null),
      card('verify', 'eye', '验证', VF && h('div', { className: 'ar-ovcard-b' },
        h('div', { className: 'ar-ovcard-num' }, VF.global_rms_px != null ? VF.global_rms_px.toFixed(2) : 'n/a', h('span', null, ' px')),
        h('div', { className: 'ar-ovcard-meta' }, 'global_rms · max ' + (VF.global_max_px != null ? VF.global_max_px.toFixed(2) : 'n/a') + ' px')), !VF ? '未验证' : null));
  }

  /* 建议下一步：真值 → 空间求解 → 延迟 → 验证 → 历史与导出（「镜头与内参」后端待接，
     不是可完成项，跳过该步不纳入自动引导链，避免建议永远卡在一个禁用页上）。 */
  function NextStep({ s }) {
    const ws = useArWorkspace();
    const { Button } = window.Spectrum2DesignSystem_b6d1b3;
    let target, text;
    if (!ws.lastValidate) { target = 'markers'; text = '先运行真值校验，确认 marker map 的世界对齐等级。'; }
    else if (!ws.lastSpatial) { target = 'spatial'; text = '真值已就绪，建议进行空间求解。'; }
    else if (!ws.lastDelay) { target = 'delay'; text = '空间求解已完成，建议校准 tracking↔video 延迟。'; }
    else if (!ws.lastVerify) { target = 'verify'; text = '真值、空间求解、延迟均已就绪，建议生成验证叠加复核整体精度。'; }
    else { target = 'runs'; text = '全部校正项均已就绪，可前往历史与导出生成 OpenTrackIO。'; }
    const item = AR_ITEMS.find((x) => x.id === target) || { icon: 'arrowr', label: '历史与导出' };
    return h('div', { className: 'ar-next' },
      h('span', { className: 'ar-next-ic' }, h(Icon, { name: 'arrowr', size: 15 })),
      h('div', { className: 'ar-next-m' },
        h('div', { className: 'ar-next-t' }, '建议下一步'),
        h('div', { className: 'ar-next-d' }, text)),
      h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: target === 'runs' ? 'download' : item.icon, size: 15 }), onPress: () => s.setCalArNav(target) },
        target === 'runs' ? '前往历史与导出' : '前往' + item.label));
  }

  function Jobs() {
    const ws = useArWorkspace();
    const running = Object.keys(ws.running).filter((k) => ws.running[k]);
    const label = { markers: '真值导入与检查', spatial: '空间求解', delay: '延迟校准', verify: '验证叠加' };
    return h('div', { className: 'dash-card' },
      h('div', { className: 'dc-h' }, h('span', { className: 't' }, h(Icon, { name: 'sync', size: 14 }), '进行中任务'), h('span', { className: 'dc-n' }, running.length + ' 个')),
      running.length
        ? h('div', { className: 'cal2-jobs' }, running.map((k) => h('div', { key: k, className: 'cal2-job' },
            h('div', { className: 'cal2-job-top' },
              h('span', { className: 'cal2-job-n' }, label[k] || k),
              h('span', { className: 'cal2-job-st' }, '进行中'),
              h('span', { className: 'cal2-job-pct' }, '···')),
            h('div', { className: 'vmeter vmeter--accent ar-indeterminate' }, h('div', { className: 'vmeter__fill' })))))
        : h('div', { style: { fontSize: 12, color: 'var(--chrome-faint)', padding: '8px 2px' } }, '当前没有进行中的校正任务'));
  }

  function Overview({ s }) {
    return h('div', { className: 'dash' },
      h(WorkspaceCard),
      h(StatusCards, { s }),
      h(NextStep, { s }),
      h(Jobs));
  }

  window.VOLO_CAL_AR = Object.assign(window.VOLO_CAL_AR || {}, {
    left: arLeft, center: arCenter, inspector: arInspector, Overview,
    arStore, useArWorkspace, pickArPath, setArPath, useVpcalRun, parseEnvelope, Page, gm,
    gradeBadge, confBadge, confKey, confPct, pxBadge, wsDot, baseName, dirName,
  });
})();

export {};
