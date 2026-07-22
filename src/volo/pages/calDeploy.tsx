// @ts-nocheck
/* Volo — 校正 · LED · 上屏部署页（calDeploy.tsx）
   1:1 移植自 Claude Design handoff `cal2_deploy.jsx`。
   部署方式二选：显示器直连 / nDisplay。复用拓扑对话框；本机走 player API，集群走 output_*。 */
import * as React from "react";
import { listMonitors, openPatternPlayer, closePatternPlayer, playerShowPattern, playerClear, preferPatternMonitor } from "../api/player";
import { listMachines, getMachineDetail } from "../api/commands";
import {
  DEFAULT_NDISPLAY_OUTPUT_PATHS,
  outputPreflight, outputDeploy, outputStart, outputShow, outputStop,
  listenNDisplayOutputEvent,
} from "../api/ndisplayOutput";
import { generatedPatternImagePath } from "../api/meshVisualCommands";

(function () {
  const { Button } = window.Spectrum2DesignSystem_b6d1b3;
  const { useState, useRef, useEffect, useMemo } = React;
  const h = React.createElement;
  const CX = () => window.VOLO_CAL2 || {};
  const toneVar = (t) => t === 'neutral' ? 'var(--chrome-faint)' : t === 'active' ? 'var(--volo-500)' : 'var(--' + t + '-visual)';
  const OUTPUT_PATHS = DEFAULT_NDISPLAY_OUTPUT_PATHS;

  function TargetCards({ s }) {
    return h('div', { className: 'dep-targets' }, CAL_DEPLOY_TARGETS.map((t) => {
      const on = s.calOutTarget === t.id;
      return h('button', { key: t.id, className: 'dep-tcard' + (on ? ' on' : ''), onClick: () => s.setCalOutTarget(t.id) },
        h('div', { className: 'dep-tcard-h' },
          h('span', { className: 'dep-tcard-ic' }, h(Icon, { name: t.icon, size: 18 })),
          h('span', { className: 'dep-tcard-t' }, t.label),
          h('span', { className: 'dep-tcard-ck' }, on ? h(Icon, { name: 'check', size: 12 }) : null)),
        h('div', { className: 'dep-tcard-d' }, t.desc),
        h('div', { className: 'dep-tcard-scene' }, h(Icon, { name: 'info', size: 12 }), t.scene));
    }));
  }

  function useMonitors() {
    const proj = CX().useProj ? CX().useProj() : { patternGenByScreen: null };
    const [mons, setMons] = useState([]);
    const patternSize = useMemo(() => {
      const by = proj.patternGenByScreen || {};
      const id = Object.keys(by).find((k) => by[k] && (by[k].image_width || by[k].width));
      if (id) {
        const res = by[id];
        return { w: res.image_width || res.width || 1920, h: res.image_height || res.height || 1080 };
      }
      return { w: 1920, h: 1080 };
    }, [proj.patternGenByScreen]);
    useEffect(() => {
      let alive = true;
      listMonitors().then((list) => { if (alive && Array.isArray(list)) setMons(list); }).catch(() => {});
      return () => { alive = false; };
    }, []);
    return { mons, patternSize };
  }

  function MonitorBranch({ s }) {
    const { mons, patternSize } = useMonitors();
    const [sel, setSel] = useState(null);
    const [busy, setBusy] = useState(false);
    useEffect(() => {
      if (!mons.length) return;
      if (sel == null) {
        /* Prefer non-primary (TV/LED wall) over "last in enumeration" — on
           Razer dual-head the ASUS desk panel is often last/primary while the
           LG G3 is the extended output we actually need for the chart. */
        const prefer = preferPatternMonitor(mons) || mons[0];
        setSel(prefer.index);
      }
    }, [mons, sel]);
    const mon = mons.find((m) => m.index === sel) || mons[0];
    const deployed = s.deployState !== 'idle';
    const mismatch = mon && (mon.width !== patternSize.w || mon.height !== patternSize.h);

    const deploy = async () => {
      if (!mon || busy) return;
      setBusy(true);
      try {
        await openPatternPlayer(mon.index);
        await playerClear();
        s.setDeployState('standby');
        s.setDeployMeta && s.setDeployMeta({ channel: 'HDMI · 本机', target: mon.name || ('显示器 ' + mon.index), monitorIndex: mon.index });
        s.pushLog({ lv: 'ok', cat: 'deploy', msg: '显示器直连部署完成 · <b>' + (mon.name || mon.index) + '</b> · 黑场待机' });
        s.setCalReceipt && s.setCalReceipt({ tone: 'ok', text: '已部署 · 黑场待机' });
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        s.pushLog({ lv: 'err', cat: 'deploy', msg: '部署到显示器失败 · ' + msg });
        s.setCalReceipt && s.setCalReceipt({ tone: 'err', text: '部署失败 · ' + msg });
      } finally { setBusy(false); }
    };

    if (!mons.length) {
      return h('div', { className: 'dep-sec' },
        h('div', { className: 'dep-sec-h' }, h(Icon, { name: 'panel', size: 14 }), '输出显示器'),
        h('div', { style: { fontSize: 12.5, color: 'var(--chrome-faint)', lineHeight: 1.55 } }, '未检测到显示器（需在原生 App 内运行）。'));
    }

    return h('div', { className: 'dep-sec' },
      h('div', { className: 'dep-sec-h' }, h(Icon, { name: 'panel', size: 14 }), '输出显示器'),
      h('div', { className: 'dep-monlist' }, mons.map((m) => h('button', { key: m.index, className: 'dep-mon' + (m.index === sel ? ' on' : ''), onClick: () => setSel(m.index) },
        h('span', { className: 'dep-mon-ck' }, m.index === sel ? h(Icon, { name: 'check', size: 12 }) : null),
        h('span', { className: 'dep-mon-ic' }, h(Icon, { name: 'panel', size: 15 })),
        h('div', { className: 'dep-mon-m' },
          h('div', { className: 'dep-mon-n' }, m.name || ('显示器 ' + m.index), m.is_primary ? h('span', { className: 'dep-mon-primary' }, '主屏') : null),
          h('div', { className: 'dep-mon-s' }, m.width + '×' + m.height + ' · 缩放 ' + ((m.scale_factor || 1) * 100).toFixed(0) + '%'))))),
      deployed ? h(React.Fragment, null,
        h(StandbyCard, { s, target: mon.name || ('显示器 ' + mon.index), busy, setBusy }),
        mismatch ? h('div', { className: 'dep-warn' }, h(Icon, { name: 'alert', size: 14 }),
          h('div', null, h('b', null, '窗口物理分辨率与图案分辨率不一致'), '（不阻断）：窗口 ',
            h('code', null, mon.width + '×' + mon.height), '，图案 ', h('code', null, patternSize.w + '×' + patternSize.h),
            ' —— 图案将按 1:1 居中显示，边缘留黑，不影响校正采集。')) : null)
      : h('div', { style: { display: 'flex' } }, h(Button, { variant: 'accent', size: 'M', isDisabled: busy, icon: h(Icon, { name: 'external', size: 15 }), onPress: deploy }, busy ? '部署中…' : '部署到显示器')));
  }

  function StandbyCard({ s, target, busy, setBusy }) {
    const showing = s.deployState === 'showing';
    const st = CAL_DEPLOY_STATE[s.deployState] || CAL_DEPLOY_STATE.standby;
    const toBlack = async () => {
      setBusy && setBusy(true);
      try {
        if (s.calOutTarget === 'cluster') {
          /* 集群清空由 ClusterBranch 处理；此处仅本机 */
        } else {
          await playerClear();
        }
        s.setDeployState('standby');
        s.pushLog({ lv: 'info', cat: 'deploy', msg: '回到黑场待机' });
      } catch (e) {
        s.pushLog({ lv: 'err', cat: 'deploy', msg: '回黑场失败 · ' + (e && e.message ? e.message : e) });
      } finally { setBusy && setBusy(false); }
    };
    const showPattern = async () => {
      setBusy && setBusy(true);
      try {
        const store = CX().projStore ? CX().projStore.get() : null;
        const byScreen = store && store.patternGenByScreen;
        const first = byScreen && Object.keys(byScreen).find((id) => byScreen[id] && byScreen[id].output_dir);
        if (first) {
          await playerShowPattern(generatedPatternImagePath(byScreen[first].output_dir), 'full_screen');
        } else {
          /* 无测试图时仍进入显示中态（黑底网格由 CSS 示意）；不阻断流程 */
          await playerClear();
        }
        s.setDeployState('showing');
        s.pushLog({ lv: 'info', cat: 'deploy', msg: first ? '显示测试图' : '显示中（尚无已生成测试图，保持输出通道）' });
      } catch (e) {
        s.pushLog({ lv: 'err', cat: 'deploy', msg: '显示测试图失败 · ' + (e && e.message ? e.message : e) });
      } finally { setBusy && setBusy(false); }
    };
    const stop = async () => {
      setBusy && setBusy(true);
      try {
        if (s.calOutTarget === 'monitor') await closePatternPlayer();
        s.setDeployState('idle');
        s.pushLog({ lv: 'warn', cat: 'deploy', msg: '停止输出' });
      } catch (e) {
        s.setDeployState('idle');
        s.pushLog({ lv: 'warn', cat: 'deploy', msg: '停止输出 · ' + (e && e.message ? e.message : e) });
      } finally { setBusy && setBusy(false); }
    };
    return h('div', { className: 'dep-standby' },
      h('div', { className: 'dep-standby-scr' + (showing ? ' showing' : '') }, h('span', { className: 'lb' }, showing ? '测试图' : 'BLACK')),
      h('div', { className: 'dep-standby-m' },
        h('div', { className: 'dep-standby-t' },
          h('h4', null, showing ? '显示中' : '黑场待机'),
          h('span', { className: 'spill spill--' + st.tone }, h(Icon, { name: st.icon, size: 12 }), st.label)),
        h('div', { className: 'dep-standby-d' }, target + ' · 通道已部署，可供测试图与校正采集统一使用')),
      h('div', { className: 'dep-standby-acts' },
        showing
          ? h(Button, { variant: 'secondary', size: 'S', isDisabled: !!busy, icon: h(Icon, { name: 'minus', size: 13 }), onPress: toBlack }, '回黑场')
          : h(Button, { variant: 'secondary', size: 'S', isDisabled: !!busy, icon: h(Icon, { name: 'grid', size: 13 }), onPress: showPattern }, '显示测试图'),
        h(Button, { variant: 'secondary', size: 'S', isDisabled: !!busy, icon: h(Icon, { name: 'x', size: 13 }), onPress: stop }, '停止输出')));
  }

  function normalizeTopo(topo, screensMap) {
    if (!topo || !topo.nodes || !topo.nodes.length) return null;
    const screenCount = screensMap ? Object.keys(screensMap).length : 0;
    const comp = window.buildStageComposite ? window.buildStageComposite(screensMap || {}) : { canvas: { w: 0, h: 0 } };
    const nodes = topo.nodes.map((nd, i) => {
      const vp = nd.viewport_rect_px || [0, 0, (nd.window_px && nd.window_px[0]) || 1920, (nd.window_px && nd.window_px[1]) || 1080];
      return {
        id: nd.node_id || ('Node' + i),
        name: nd.node_id || ('Node' + i),
        machineId: (nd.machine && (nd.machine.ip || nd.machine.hostname)) || '',
        host: (nd.machine && (nd.machine.ip || nd.machine.hostname)) || '—',
        w: vp[2] || 1920, h: vp[3] || 1080,
        master: !!nd.primary,
        raw: nd,
      };
    });
    return { nodes, canvas: (topo.canvas || comp.canvas || { w: 0, h: 0 }), screenCount, raw: topo };
  }

  function ClusterBranch({ s }) {
    const proj = CX().useProj ? CX().useProj() : { path: null, config: null, patternGenByScreen: null };
    const topology = useMemo(() => window.resolveProjectTopology && window.resolveProjectTopology(proj.config), [proj.config]);
    const topo = useMemo(() => normalizeTopo(topology, (proj.config && proj.config.screens) || {}), [topology, proj.config]);
    const [phase, setPhase] = useState(s.deployState !== 'idle' && s.calOutTarget === 'cluster' ? 'deployed' : 'idle');
    const [dep, setDep] = useState({ done: 0 });
    const [busy, setBusy] = useState(false);
    const [nodeStates, setNodeStates] = useState({});
    const [runtimePaths, setRuntimePaths] = useState(OUTPUT_PATHS);
    const timer = useRef(null);
    const sessionId = (proj.path || 'local') + '::stage';
    useEffect(() => () => clearInterval(timer.current), []);
    useEffect(() => {
      let alive = true; const cleanups = [];
      listenNDisplayOutputEvent((payload) => {
        if (!alive || payload.session_id !== sessionId) return;
        setNodeStates((cur) => Object.assign({}, cur, { [payload.node_id]: payload }));
      }).then((fn) => alive ? cleanups.push(fn) : fn()).catch(() => {});
      return () => { alive = false; cleanups.forEach((fn) => fn()); };
    }, [sessionId]);

    const openTopo = () => s.setModal({ xwide: true, render: ({ close }) => window.VOLO_GRID_MODALS.topology(s, close) });

    if (!topo) {
      return h('div', { className: 'dep-sec' },
        h('div', { className: 'dep-topo', style: { alignItems: 'flex-start', gap: 10 } },
          h('div', { style: { fontSize: 13, fontWeight: 800, color: 'var(--chrome-text)' } }, '该 Stage 尚未配置输出拓扑'),
          h('div', { style: { fontSize: 12, color: 'var(--chrome-faint)', lineHeight: 1.55 } }, '需先在复合画布上定义由哪几台渲染服务器、各驱动哪个像素区域，才能把通道部署上墙。'),
          h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'net', size: 15 }), onPress: openTopo }, '配置输出拓扑…')));
    }

    const NST = window.NDISPLAY_NODE_STATUS;
    const DSTEPS = window.NDISPLAY_DEPLOY_STEPS;
    const total = topo.nodes.length * DSTEPS.length;
    const deploying = phase === 'deploying';
    const deployed = phase === 'deployed';
    const screen = window.stageScreenForOutput(proj.config, topology);
    const runtimeRequest = (paths) => ({ session_id: sessionId, screen, paths: paths || runtimePaths, ssh_user: null });

    const resolveEditorPaths = async () => {
      const machines = await listMachines();
      const resolved = {};
      for (const node of topo.nodes) {
        const raw = node.raw;
        const hostname = (raw.machine.hostname || '').trim().toLowerCase();
        const ip = (raw.machine.ip || '').trim().toLowerCase();
        const machine = machines.find((c) =>
          (hostname && (c.hostname || '').trim().toLowerCase() === hostname) ||
          (ip && (c.ip || '').trim().toLowerCase() === ip));
        if (!machine || machine.id == null) throw new Error(node.name + '：机器库中找不到 ' + (raw.machine.ip || raw.machine.hostname || '目标'));
        const detail = await getMachineDetail(machine.id);
        const install = detail.ue_installs
          .filter((item) => /^5\.8(?:\.|$)/.test(item.version))
          .sort((a, b) => Number(b.is_primary) - Number(a.is_primary))[0];
        if (!install) throw new Error(node.name + '：机器库未探测到 UE 5.8');
        resolved[node.id] = install.install_path.replace(/[\\/]+$/, '') + '\\Engine\\Binaries\\Win64\\UnrealEditor.exe';
      }
      const paths = Object.assign({}, OUTPUT_PATHS, { editor_paths: resolved });
      setRuntimePaths(paths);
      return paths;
    };

    const runCheck = () => {
      s.setModal({
        wide: true,
        render: ({ close }) => h(PreflightModal, {
          s, close, sessionId, runtimeRequest, resolveEditorPaths,
          onDeploy: (paths) => { close(); startDeploy(paths); },
        }),
      });
    };

    /* paths 必须显式传入：setRuntimePaths 更新不到本轮 render 已捕获的闭包，
       只靠 state 会让 deploy/start 拿到默认 editor_path（预检过、启动挂）。 */
    const startDeploy = async (paths) => {
      if (busy) return;
      setPhase('deploying'); setDep({ done: 0 }); setBusy(true);
      clearInterval(timer.current);
      /* UI 进度矩阵与真实 outputDeploy 并行：假步进只做视觉，完成以 API 为准 */
      timer.current = setInterval(() => setDep((d) => {
        const nd = Math.min(total, d.done + 1);
        return { done: nd };
      }), 180);
      s.pushLog({ lv: 'info', cat: 'deploy', msg: '开始部署到 <b>' + topo.nodes.length + '</b> 个渲染节点' });
      try {
        await outputDeploy(Object.assign(runtimeRequest(paths), { ue_version: '5.8' }));
        await outputStart(runtimeRequest(paths));
        clearInterval(timer.current);
        setDep({ done: total });
        setPhase('deployed');
        s.setDeployState('standby');
        s.setDeployMeta && s.setDeployMeta({ channel: 'WinRM', target: 'nDisplay 集群', nodeCount: topo.nodes.length });
        s.pushLog({ lv: 'ok', cat: 'deploy', msg: '<b>部署完成</b> · ' + topo.nodes.length + ' 节点进入黑场待机' });
        s.setCalReceipt && s.setCalReceipt({ tone: 'ok', text: 'nDisplay 部署完成 · 黑场待机' });
      } catch (e) {
        clearInterval(timer.current);
        setPhase('idle');
        const msg = e && e.message ? e.message : String(e);
        s.pushLog({ lv: 'err', cat: 'deploy', msg: 'nDisplay 部署失败 · ' + msg });
        s.setCalReceipt && s.setCalReceipt({ tone: 'err', text: '部署失败 · ' + msg });
      } finally { setBusy(false); }
    };

    /* 「预检并部署」：先 outputPreflight，通过后再走 startDeploy（与独立预检对齐）。 */
    const startDeployWithPreflight = async () => {
      if (busy || deploying) return;
      setBusy(true);
      let paths;
      try {
        paths = await resolveEditorPaths();
        await outputPreflight(runtimeRequest(paths));
        s.pushLog({ lv: 'ok', cat: 'deploy', msg: 'nDisplay 预检通过 · 开始部署' });
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        s.pushLog({ lv: 'err', cat: 'deploy', msg: '预检失败 · ' + msg });
        s.setCalReceipt && s.setCalReceipt({ tone: 'err', text: '预检失败 · ' + msg });
        setBusy(false);
        return;
      }
      /* 预检已占用 busy；交给 startDeploy 前清掉，避免其入口 `if (busy)` 误拒 */
      setBusy(false);
      await startDeploy(paths);
    };

    const nodeStatus = (nd, i) => {
      const ev = nodeStates[nd.id];
      if (ev && ev.state === 'error') return 'error';
      if (deploying) return dep.done >= (i + 1) * DSTEPS.length ? 'ready' : dep.done > i * DSTEPS.length ? 'deploying' : 'offline';
      if (deployed) return s.deployState === 'showing' ? 'running' : 'ready';
      const mc = (window.RENDER_NODES || []).find((m) =>
        (m.ip && nd.host && m.ip === nd.host) || (m.hostname && nd.host && m.hostname === nd.host));
      return mc && mc.status === 'offline' ? 'offline' : 'ready';
    };
    const stageLabel = (st) => st === 'deploying' ? '部署中' : st === 'running' ? '显示中' : st === 'ready' ? (deployed ? '黑场待机' : '就绪') : st === 'error' ? '错误' : '离线';

    const steps = [
      { id: 'check', label: '预检', done: phase !== 'idle', active: phase === 'idle' },
      { id: 'deploy', label: '部署', done: deployed, active: deploying },
      { id: 'start', label: '启动 · 待机', done: deployed, active: false },
    ];

    const clusterStandby = {
      toBlack: async () => {
        setBusy(true);
        try {
          await outputShow(Object.assign(runtimeRequest(), { mode: 'clear', image_path: null }));
          s.setDeployState('standby');
          s.pushLog({ lv: 'info', cat: 'deploy', msg: '回到黑场待机' });
        } catch (e) { s.pushLog({ lv: 'err', cat: 'deploy', msg: String(e && e.message || e) }); }
        finally { setBusy(false); }
      },
      showPattern: async () => {
        setBusy(true);
        try {
          const comp = window.buildStageComposite((proj.config && proj.config.screens) || {});
          const stage = { project_path: proj.path, screens: comp.screens.map((r) => ({ screen_id: r.id, x: r.x, y: r.y })) };
          await outputShow(Object.assign(runtimeRequest(), { mode: 'show', image_path: null, stage }));
          s.setDeployState('showing');
          s.pushLog({ lv: 'info', cat: 'deploy', msg: '显示测试图' });
        } catch (e) { s.pushLog({ lv: 'err', cat: 'deploy', msg: String(e && e.message || e) }); }
        finally { setBusy(false); }
      },
      stop: async () => {
        setBusy(true);
        try {
          await outputStop(runtimeRequest());
          s.setDeployState('idle');
          setPhase('idle');
          s.pushLog({ lv: 'warn', cat: 'deploy', msg: '停止输出' });
        } catch (e) {
          s.setDeployState('idle'); setPhase('idle');
          s.pushLog({ lv: 'warn', cat: 'deploy', msg: String(e && e.message || e) });
        } finally { setBusy(false); }
      },
    };

    return h('div', { className: 'dep-sec' },
      h('div', { className: 'dep-topo' },
        h('button', { className: 'dep-topo-sum', onClick: openTopo },
          h('span', { className: 'dep-topo-sum-ic' }, h(Icon, { name: 'panel', size: 15 })),
          h('div', { className: 'dep-topo-sum-m' },
            h('div', { className: 'dep-topo-sum-t' }, topo.nodes.length + ' 节点 · ' + topo.screenCount + ' 屏 · 复合画布 ' + topo.canvas.w + '×' + topo.canvas.h),
            h('div', { className: 'dep-topo-sum-s' }, '点击编辑输出拓扑')),
          h('span', { className: 'spill spill--informative' }, h(Icon, { name: 'settings', size: 12 }), '编辑拓扑')),
        h('div', { className: 'dep-topo-nodes' }, topo.nodes.map((nd, i) => {
          const st = nodeStatus(nd, i), meta = NST[st] || NST.ready;
          return h('div', { key: nd.id, className: 'dep-node' },
            h('span', { className: 'dep-node-dot', style: { background: toneVar(meta.tone) } }),
            h('span', { className: 'dep-node-n' }, nd.name, nd.master ? h('span', { className: 'dep-node-master' }, '主') : null),
            h('span', { className: 'dep-node-h' }, nd.host + ' · ' + nd.w + '×' + nd.h),
            h('span', { className: 'dep-node-stage' }, h('span', { className: 'spill spill--' + meta.tone, style: { fontSize: 10.5 } }, h(Icon, { name: meta.icon, size: 11 }), stageLabel(st))));
        }))),
      h('div', { className: 'dep-flow' }, steps.flatMap((st, i) => [
        i > 0 ? h(Icon, { key: 'a' + i, name: 'chevr', size: 13, className: 'dep-flow-arrow' }) : null,
        h('span', { key: st.id, className: 'dep-step' + (st.done ? ' done' : st.active ? ' active' : '') },
          h('span', { className: 'n' }, st.done ? h(Icon, { name: 'check', size: 11 }) : (i + 1)), st.label),
      ])),
      deploying ? h('div', { className: 'nd-deploy', style: { marginTop: 2 } },
        h('div', { className: 'nd-deploy-h' }, '部署进度 ', h('b', null, Math.round(dep.done / total * 100) + '%'), h('span', { className: 'nd-deploy-sub' }, dep.done + ' / ' + total + ' 步')),
        h('div', { className: 'nd-deploy-grid', style: { gridTemplateColumns: '78px repeat(' + DSTEPS.length + ',1fr)' } },
          h('div', { className: 'nd-dg-corner' }),
          DSTEPS.map((st) => h('div', { key: st.id, className: 'nd-dg-col' }, st.short)),
          topo.nodes.map((n, ni) => [
            h('div', { key: n.id + '_n', className: 'nd-dg-row' }, n.name),
            DSTEPS.map((st, si) => {
              const idx = ni * DSTEPS.length + si; const done = dep.done > idx; const active = dep.done === idx;
              return h('div', { key: n.id + st.id, className: 'nd-dg-cell' + (done ? ' done' : active ? ' active' : '') }, done ? h(Icon, { name: 'check', size: 12 }) : active ? h(Icon, { name: 'sync', size: 12 }) : null);
            }),
          ]))) : null,
      deployed
        ? h(ClusterStandbyCard, { s, target: topo.nodes.length + ' 节点 · nDisplay 集群', busy, actions: clusterStandby })
        : h('div', { style: { display: 'flex', gap: 10 } },
            h(Button, { variant: 'secondary', size: 'M', isDisabled: deploying || busy, icon: h(Icon, { name: 'shield', size: 15 }), onPress: runCheck }, '预检'),
            h(Button, { variant: 'accent', size: 'M', isDisabled: deploying || busy, icon: h(Icon, { name: deploying ? 'sync' : 'download', size: 15 }), onPress: startDeployWithPreflight }, deploying ? '部署中…' : '预检并部署')));
  }

  function ClusterStandbyCard({ s, target, busy, actions }) {
    const showing = s.deployState === 'showing';
    const st = CAL_DEPLOY_STATE[s.deployState] || CAL_DEPLOY_STATE.standby;
    return h('div', { className: 'dep-standby' },
      h('div', { className: 'dep-standby-scr' + (showing ? ' showing' : '') }, h('span', { className: 'lb' }, showing ? '测试图' : 'BLACK')),
      h('div', { className: 'dep-standby-m' },
        h('div', { className: 'dep-standby-t' },
          h('h4', null, showing ? '显示中' : '黑场待机'),
          h('span', { className: 'spill spill--' + st.tone }, h(Icon, { name: st.icon, size: 12 }), st.label)),
        h('div', { className: 'dep-standby-d' }, target + ' · 通道已部署，可供测试图与校正采集统一使用')),
      h('div', { className: 'dep-standby-acts' },
        showing
          ? h(Button, { variant: 'secondary', size: 'S', isDisabled: !!busy, icon: h(Icon, { name: 'minus', size: 13 }), onPress: actions.toBlack }, '回黑场')
          : h(Button, { variant: 'secondary', size: 'S', isDisabled: !!busy, icon: h(Icon, { name: 'grid', size: 13 }), onPress: actions.showPattern }, '显示测试图'),
        h(Button, { variant: 'secondary', size: 'S', isDisabled: !!busy, icon: h(Icon, { name: 'x', size: 13 }), onPress: actions.stop }, '停止输出')));
  }

  function PreflightModal({ s, close, runtimeRequest, resolveEditorPaths, onDeploy }) {
    const [state, setState] = useState('running'); /* running | ok | err */
    const [msg, setMsg] = useState('正在预检节点与 UE 路径…');
    const [detail, setDetail] = useState(null);
    const pathsRef = useRef(null); /* 「继续部署」须复用预检解析的 paths，不能靠外层 state */
    useEffect(() => {
      let alive = true;
      (async () => {
        try {
          const paths = await resolveEditorPaths();
          pathsRef.current = paths;
          const result = await outputPreflight(runtimeRequest(paths));
          if (!alive) return;
          setDetail(result);
          setState('ok');
          setMsg('预检通过 · ' + ((result && result.nodes && result.nodes.length) || 0) + ' 节点');
          s.pushLog({ lv: 'ok', cat: 'deploy', msg: 'nDisplay 预检通过' });
        } catch (e) {
          if (!alive) return;
          setState('err');
          setMsg(e && e.message ? e.message : String(e));
          s.pushLog({ lv: 'err', cat: 'deploy', msg: '预检失败 · ' + (e && e.message ? e.message : e) });
        }
      })();
      return () => { alive = false; };
    }, []);
    return h('div', { className: 'drawer' },
      h('div', { className: 'drawer-h' },
        h('span', { className: 'di info' }, h(Icon, { name: 'shield', size: 17 })),
        h('div', { style: { minWidth: 0, flex: 1 } }, h('h2', null, 'nDisplay 预检'), h('div', { className: 'sub' }, '核对节点在线、机器登记与 UE 路径')),
        h('button', { className: 'iconbtn x', onClick: close }, h(Icon, { name: 'x', size: 16 }))),
      h('div', { className: 'drawer-b', style: { padding: 18 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 } },
          state === 'running' ? h(Icon, { name: 'sync', size: 16 }) : state === 'ok' ? h(Icon, { name: 'check', size: 16 }) : h(Icon, { name: 'alert', size: 16 }),
          h('span', { style: { fontSize: 13, fontWeight: 700, color: state === 'err' ? 'var(--negative-visual)' : 'var(--chrome-text)' } }, msg)),
        detail && detail.nodes ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          detail.nodes.map((n, i) => h('div', { key: i, className: 'dep-node' },
            h('span', { className: 'dep-node-n' }, n.node_id || n.id || ('#' + i)),
            h('span', { className: 'dep-node-h' }, n.message || n.state || 'ok')))) : null),
      h('div', { className: 'drawer-f', style: { display: 'flex', gap: 10, justifyContent: 'flex-end', padding: '12px 16px' } },
        h(Button, { variant: 'secondary', size: 'M', onPress: close }, '关闭'),
        h(Button, { variant: 'accent', size: 'M', isDisabled: state !== 'ok', icon: h(Icon, { name: 'download', size: 15 }), onPress: () => onDeploy(pathsRef.current) }, '继续部署')));
  }

  function DeploySummaryRows({ s }) {
    const st = CAL_DEPLOY_STATE[s.deployState] || CAL_DEPLOY_STATE.idle;
    const target = (s.deployMeta && s.deployMeta.target) || (s.calOutTarget === 'cluster' ? 'nDisplay 集群' : '显示器直连');
    const chan = (s.deployMeta && s.deployMeta.channel) || (s.calOutTarget === 'cluster' ? 'WinRM' : 'HDMI · 本机');
    const row = (k, v) => h('div', { className: 'kv' }, h('span', { className: 'k' }, k), h('span', { className: 'v' }, v));
    return h('div', { className: 'dep-sumrows' },
      row('通道', h('span', { className: 'mono' }, chan)),
      h('div', { className: 'kv' }, h('span', { className: 'k' }, '状态'),
        h('span', { className: 'v' }, h('span', { className: 'spill spill--' + st.tone }, st.icon === 'minus' ? h('span', { style: { fontWeight: 800 } }, '—') : h(Icon, { name: st.icon, size: 12 }), st.label))),
      row('目标', target),
      s.deployState !== 'idle'
        ? h('div', { className: 'dep-sumnote ok' }, h(Icon, { name: 'check', size: 12 }), '通道已部署 · 可供测试图与校正采集引用')
        : h('div', { className: 'dep-sumnote' }, h(Icon, { name: 'info', size: 12 }), '未部署 · 镜头校正采集将被阻止'));
  }

  function DeploySummary({ s }) {
    const st = CAL_DEPLOY_STATE[s.deployState] || CAL_DEPLOY_STATE.idle;
    const target = (s.deployMeta && s.deployMeta.target) || (s.calOutTarget === 'cluster' ? 'nDisplay 集群' : '显示器直连');
    const chan = (s.deployMeta && s.deployMeta.channel) || (s.calOutTarget === 'cluster' ? 'WinRM' : 'HDMI · 本机');
    return h('div', { className: 'dep-summary' },
      h('div', { className: 'dep-sm-cell' }, h('span', { className: 'dep-sm-k' }, '当前部署状态')),
      h('div', { className: 'dep-sm-cell' }, h('span', { className: 'dep-sm-k' }, '通道'), h('span', { className: 'dep-sm-v mono' }, chan)),
      h('div', { className: 'dep-sm-cell' }, h('span', { className: 'dep-sm-k' }, '状态'),
        h('span', { className: 'dep-sm-v' }, h('span', { className: 'spill spill--' + st.tone }, st.icon === 'minus' ? h('span', { style: { fontWeight: 800 } }, '—') : h(Icon, { name: st.icon, size: 12 }), st.label))),
      h('div', { className: 'dep-sm-cell' }, h('span', { className: 'dep-sm-k' }, '目标'), h('span', { className: 'dep-sm-v' }, target)),
      h('div', { className: 'dep-sm-r' }, s.deployState !== 'idle'
        ? h('span', { className: 'spill spill--positive' }, h(Icon, { name: 'check', size: 12 }), '可供采集引用')
        : h('span', { className: 'spill spill--neutral' }, h('span', { style: { fontWeight: 700 } }, '—'), '采集将被阻止')));
  }

  function DeployInspectorBody({ s }) {
    /* 订一次项目 store，供子分支读 patternGen / topology（Rules of Hooks：无条件） */
    CX().useProj();
    const st = CAL_DEPLOY_STATE[s.deployState] || CAL_DEPLOY_STATE.idle;
    return h(React.Fragment, null,
      h('div', { className: 'insp-head' },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 9, marginBottom: 6 } },
          h('span', { className: 'step-ico', style: { width: 30, height: 30, borderRadius: 8 } }, h(Icon, { name: 'external', size: 16 })),
          h('h2', { style: { margin: 0, fontSize: 15, fontWeight: 700 } }, '上屏部署')),
        h('span', { className: 'spill spill--' + st.tone }, st.icon === 'minus' ? h('span', { style: { fontWeight: 700 } }, '—') : h(Icon, { name: st.icon, size: 12 }), st.label)),
      h('div', { className: 'insp-sect' },
        h('div', { className: 'dep-lead', style: { marginBottom: 0 } },
          '将 LED 屏输出通道部署到 ', h('b', null, '黑屏待机'), '，供 ', h('b', null, '测试图上墙'), ' 与 ', h('b', null, '镜头校正采集'), ' 统一复用。')),
      h('div', { className: 'insp-sect dep-insp' },
        h('div', { className: 'lh' }, '部署方式'),
        h(TargetCards, { s }),
        h('div', { style: { marginTop: 12 } }, s.calOutTarget === 'cluster' ? h(ClusterBranch, { s }) : h(MonitorBranch, { s }))),
      h('div', { className: 'insp-sect' },
        h('div', { className: 'lh' }, '当前部署状态'),
        h(DeploySummaryRows, { s })));
  }

  function deployInspector(s) {
    return h(DeployInspectorBody, { s });
  }

  window.VOLO_DEPLOY = { deployInspector, DeploySummary, DeploySummaryRows };
})();
