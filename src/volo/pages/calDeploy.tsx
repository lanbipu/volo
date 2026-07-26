// @ts-nocheck
/* Volo — 校正 · LED · 上屏部署页（calDeploy.tsx）
   1:1 移植自 Claude Design handoff `cal2_deploy.jsx`。
   部署方式二选：显示器直连 / nDisplay。复用拓扑对话框；本机走 player API，集群走 output_*。 */
import * as React from "react";
import { listMonitors, openPatternPlayer, closePatternPlayer, playerShowPattern, playerClear, preferPatternMonitor } from "../api/player";
import { listMachines, getMachineDetail, revealPath } from "../api/commands";
import {
  DEFAULT_NDISPLAY_OUTPUT_PATHS,
  outputPreflight, outputDeploy, outputStart, outputShow, outputStop, outputStatus,
  listenNDisplayOutputEvent,
} from "../api/ndisplayOutput";
import { generatedPatternImagePath } from "../api/meshVisualCommands";

/** Stage 层图案路径：优先 patternGenByScreen.output_dir，否则 project/patterns/<id>/… */
function stageLayerImagePath(projectPath, screenId, outputDir, inverted) {
  const variant = inverted ? 'inverted' : 'normal';
  if (outputDir) return generatedPatternImagePath(outputDir, variant);
  if (!projectPath || !screenId) return null;
  const sep = projectPath.includes('\\') ? '\\' : '/';
  const dir = [projectPath.replace(/[\\/]+$/, ''), 'patterns', screenId].join(sep);
  return generatedPatternImagePath(dir, variant);
}

/** 当前工程首个有 output_dir 的测试图目录（打开输出文件夹 / 本机播放器用）。 */
function firstPatternOutputDir() {
  const store = window.VOLO_CAL2 && window.VOLO_CAL2.projStore ? window.VOLO_CAL2.projStore.get() : null;
  const byScreen = store && store.patternGenByScreen;
  const first = byScreen && Object.keys(byScreen).find((id) => byScreen[id] && byScreen[id].output_dir);
  return first ? byScreen[first].output_dir : null;
}

(function () {
  const { Button } = window.Spectrum2DesignSystem_b6d1b3;
  const { useState, useRef, useEffect, useMemo } = React;
  const h = React.createElement;
  const CX = () => window.VOLO_CAL2 || {};
  const toneVar = (t) => t === 'neutral' ? 'var(--chrome-faint)' : t === 'active' ? 'var(--volo-500)' : 'var(--' + t + '-visual)';
  const OUTPUT_PATHS = DEFAULT_NDISPLAY_OUTPUT_PATHS;

  /* 部署方式：两枚紧凑胶囊 + 一行说明（原大卡片在窄检查器里占掉整屏） */
  function TargetCards({ s }) {
    const cur = CAL_DEPLOY_TARGETS.find((t) => t.id === s.calOutTarget) || CAL_DEPLOY_TARGETS[0];
    return h(React.Fragment, null,
      h('div', { className: 'dep-targets dep-targets--compact' }, CAL_DEPLOY_TARGETS.map((t) => {
        const on = s.calOutTarget === t.id;
        return h('button', { key: t.id, className: 'gw-shape dep-tchip' + (on ? ' on' : ''), onClick: () => s.setCalOutTarget(t.id) },
          h('span', { className: 't' }, t.label));
      })),
      h('div', { className: 'dep-tnote' }, cur.desc));
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

  function MonitorBranch({ s, shell }) {
    const ui = shell === 'nd' ? 'nd' : 'dep';
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
      if (ui === 'nd') {
        return h('div', { className: 'nd-monitor' },
          h('div', { className: 'nd-guide-d', style: { textAlign: 'left' } }, '未检测到显示器（需在原生 App 内运行）。'));
      }
      return h('div', { className: 'dep-sec' },
        h('div', { className: 'dep-sec-h' }, h(Icon, { name: 'panel', size: 14 }), '输出显示器'),
        h('div', { style: { fontSize: 12.5, color: 'var(--chrome-faint)', lineHeight: 1.55 } }, '未检测到显示器（需在原生 App 内运行）。'));
    }

    if (ui === 'nd') {
      const playing = deployed && s.deployState === 'showing';
      const togglePlay = async () => {
        if (busy) return;
        if (!deployed) return deploy();
        setBusy(true);
        try {
          if (playing) {
            await closePatternPlayer();
            s.setDeployState('idle');
            s.setCalReceipt && s.setCalReceipt({ tone: 'ok', text: '已停止投放' });
          } else {
            const dir = firstPatternOutputDir();
            if (dir) await playerShowPattern(generatedPatternImagePath(dir), 'full_screen');
            else await playerClear();
            s.setDeployState('showing');
            s.setCalReceipt && s.setCalReceipt({ tone: 'ok', text: '已投放到显示器 · ' + (mon.name || mon.index) });
          }
        } catch (e) { s.pushLog({ lv: 'err', cat: 'deploy', msg: String(e && e.message || e) }); }
        finally { setBusy(false); }
      };
      const openOutputFolder = () => {
        const dir = firstPatternOutputDir();
        if (!dir) {
          s.pushLog({ lv: 'warn', cat: 'deploy', msg: '尚无测试图输出目录 · 请先生成测试图' });
          return;
        }
        revealPath(dir).catch((e) => s.pushLog({ lv: 'err', cat: 'deploy', msg: '打开输出文件夹失败 · ' + (e && e.message ? e.message : e) }));
      };
      return h('div', { className: 'nd-monitor' },
        h('div', { className: 'nd-mon-target' },
          h(Icon, { name: 'panel', size: 14 }),
          h('div', { className: 'nd-mon-m' }, h('b', null, mon.name || ('显示器 ' + mon.index)), h('span', null, mon.width + '×' + mon.height + ' · HDMI')),
          h(Icon, { name: 'external', size: 13, style: { color: 'var(--chrome-faint)' } })),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          h(Button, { variant: playing ? 'negative' : 'accent', size: 'S', isDisabled: busy,
            icon: h(Icon, { name: playing ? 'pause' : 'play', size: 13 }), onPress: togglePlay },
            busy ? '…' : (playing ? '停止投放' : '投放到显示器')),
          h(Button, { variant: 'secondary', size: 'S', icon: h(Icon, { name: 'external', size: 13 }), onPress: openOutputFolder }, '打开输出文件夹')));
    }

    return h('div', { className: 'dep-sec' },
      h('div', { className: 'dep-sec-h' }, h(Icon, { name: 'panel', size: 14 }), '输出显示器'),
      h('div', { className: 'dep-monlist dep-monlist--compact' }, mons.map((m) => h('button', { key: m.index, className: 'gw-shape dep-monchip' + (m.index === sel ? ' on' : ''), onClick: () => setSel(m.index) },
        h('span', { className: 't' }, m.name || ('显示器 ' + m.index))))),
      h('div', { className: 'dep-tnote' }, mon.width + '×' + mon.height + ' · 缩放 ' + ((mon.scale_factor || 1) * 100).toFixed(0) + '%' + (mon.is_primary ? ' · 主屏' : '')),
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
        const dir = firstPatternOutputDir();
        if (dir) {
          await playerShowPattern(generatedPatternImagePath(dir), 'full_screen');
        } else {
          /* 无测试图时仍进入显示中态（黑底网格由 CSS 示意）；不阻断流程 */
          await playerClear();
        }
        s.setDeployState('showing');
        s.pushLog({ lv: 'info', cat: 'deploy', msg: dir ? '显示测试图' : '显示中（尚无已生成测试图，保持输出通道）' });
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
          h('span', { className: 'spill spill--' + st.tone }, st.icon === 'minus' ? h('span', { style: { fontWeight: 800 } }, '—') : h(Icon, { name: st.icon, size: 12 }), st.label)),
        h('div', { className: 'dep-standby-d' }, target + ' · 通道已部署')),
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

  /* shell: 'dep' = 上屏部署页（cal2_deploy dep-*）；'nd' = OutputDelivery（grid_ndisplay nd-*） */
  function ClusterBranch({ s, shell, hideEmptyGuide, onlyPlayback }) {
    const ui = shell === 'nd' ? 'nd' : 'dep';
    const proj = CX().useProj ? CX().useProj() : { path: null, config: null, patternGenByScreen: null };
    const topology = useMemo(() => window.resolveProjectTopology && window.resolveProjectTopology(proj.config), [proj.config]);
    const topo = useMemo(() => normalizeTopo(topology, (proj.config && proj.config.screens) || {}), [topology, proj.config]);
    const [phase, setPhase] = useState(s.deployState !== 'idle' && s.calOutTarget === 'cluster' ? 'deployed' : 'idle');
    /* 逐节点逐步真实进度：{ [node_id]: { [step]: 'running'|'ok'|'error' } }，驱动部署矩阵格子 */
    const [stepStates, setStepStates] = useState({});
    const [busy, setBusy] = useState(false);
    const [nodeStates, setNodeStates] = useState({});
    const [runtimePaths, setRuntimePaths] = useState(OUTPUT_PATHS);
    const [logOpen, setLogOpen] = useState(false); /* nd-cluster 运行日志折叠（Rules of Hooks：无条件） */
    /* 切图选中态：normal | inverted | black；与 deployState 解耦，避免运行中恒为 normal */
    const [imgKind, setImgKind] = useState(s.deployState === 'showing' ? 'normal' : (s.deployState === 'standby' ? 'black' : null));
    /* 「检查」异步预检报告（含 getMachineDetail 的 ue_installs）；未检查时用同步轻量预检 */
    const [checkReport, setCheckReport] = useState(null);
    const sessionId = (proj.path || 'local') + '::stage';
    useEffect(() => {
      if (s.deployState === 'idle') setImgKind(null);
      else if (s.deployState === 'standby') setImgKind((k) => (k === 'normal' || k === 'inverted' ? 'black' : (k || 'black')));
    }, [s.deployState]);
    useEffect(() => {
      let alive = true; const cleanups = [];
      listenNDisplayOutputEvent((payload) => {
        if (!alive || payload.session_id !== sessionId) return;
        if (payload.step) {
          /* 逐子步进度事件（artifacts/project/session/verify）→ 点亮对应格子 */
          setStepStates((cur) => Object.assign({}, cur, {
            [payload.node_id]: Object.assign({}, cur[payload.node_id], { [payload.step]: payload.state }),
          }));
        } else {
          /* 节点级事件（最终 ok / error）→ 节点圆点 / 阶段徽标 */
          setNodeStates((cur) => Object.assign({}, cur, { [payload.node_id]: payload }));
        }
      }).then((fn) => alive ? cleanups.push(fn) : fn()).catch(() => {});
      return () => { alive = false; cleanups.forEach((fn) => fn()); };
    }, [sessionId]);

    /* App 重启后 deployState 不落盘：mount 时探测远端是否有本会话遗留的
       nDisplay 进程存活，有则自动恢复「黑场待机」状态（不向墙面发指令）。
       权威始终是进程探测，不持久化 deployState。 */
    const probedRef = useRef(false);
    useEffect(() => {
      if (!topo || probedRef.current) return;
      probedRef.current = true;
      if (s.deployState !== 'idle') return;   // 本会话已有权威状态
      let alive = true;
      const req = { session_id: sessionId, screen: window.stageScreenForOutput(proj.config, topology), paths: OUTPUT_PATHS, ssh_user: null };
      outputStatus(req)
        .then((res) => {
          if (!alive) return;
          const running = res.nodes.filter((n) => n.running);
          if (!running.length) return;
          setPhase('deployed');
          s.setDeployState('standby');
          s.setDeployMeta && s.setDeployMeta({ channel: 'WinRM', target: 'nDisplay 集群', nodeCount: topo.nodes.length });
          const partial = running.length < topo.nodes.length;
          s.pushLog({ lv: partial ? 'warn' : 'ok', cat: 'deploy',
            msg: '检测到上次会话的 nDisplay 部署仍在运行 · ' + running.length + '/' + topo.nodes.length +
                 ' 节点 · 已恢复待机状态' + (partial ? ' · 部分节点未运行，建议停止后重新部署' : '') });
        })
        .catch((e) => s.pushLog({ lv: 'info', cat: 'deploy',
          msg: '检测远端部署状态失败（按未部署处理） · ' + (e && e.message || e) }));
      return () => { alive = false; };
    }, [topo]);

    const openTopo = () => s.setModal({ xwide: true, render: ({ close }) => window.VOLO_GRID_MODALS.topology(s, close) });

    if (!topo) {
      if (hideEmptyGuide) return null;
      /* nd 壳（OutputDelivery）：handoff grid_ndisplay 空态引导卡 */
      if (ui === 'nd') {
        return h('div', { className: 'nd-guide' },
          h('div', { className: 'nd-guide-ic' }, h(Icon, { name: 'net', size: 26, stroke: 1.3 })),
          h('div', { className: 'nd-guide-t' }, '该 Stage 尚未配置输出拓扑'),
          h('div', { className: 'nd-guide-d' }, '整个 Stage 只有一份 nDisplay 集群配置：需先在复合画布上定义哪几台渲染服务器、各驱动哪个像素区域（可跨屏），才能把测试图上墙。'),
          h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'net', size: 15 }), onPress: openTopo }, '配置输出拓扑…'));
      }
      /* dep 壳（上屏部署检查器）：handoff cal2_deploy 仅一枚 secondary 按钮 */
      return h('div', { className: 'dep-sec' },
        h(Button, { variant: 'secondary', size: 'M', icon: h(Icon, { name: 'net', size: 15 }), onPress: openTopo }, '配置输出拓扑…'));
    }

    const NST = window.NDISPLAY_NODE_STATUS;
    const DSTEPS = window.NDISPLAY_DEPLOY_STEPS;
    const total = topo.nodes.length * DSTEPS.length;
    const deploying = phase === 'deploying';
    const deployed = phase === 'deployed';
    /* 矩阵格子真实状态：从逐子步事件读取（缺省 null=未开始） */
    const cellStep = (nodeId, stepId) => (stepStates[nodeId] || {})[stepId] || null;
    const doneCells = topo.nodes.reduce((acc, n) =>
      acc + DSTEPS.reduce((a, st) => a + (cellStep(n.id, st.id) === 'ok' ? 1 : 0), 0), 0);
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
      /* 矩阵格子由 ndisplay-output-event 的逐子步事件真实驱动（见上方 listener）；
         清空上一轮 stepStates 即可，不再用假步进 setInterval。 */
      setPhase('deploying'); setStepStates({}); setBusy(true);
      s.pushLog({ lv: 'info', cat: 'deploy', msg: '开始部署到 <b>' + topo.nodes.length + '</b> 个渲染节点' });
      try {
        await outputDeploy(Object.assign(runtimeRequest(paths), { ue_version: '5.8' }));
        await outputStart(runtimeRequest(paths));
        setPhase('deployed');
        s.setDeployState('standby');
        s.setDeployMeta && s.setDeployMeta({ channel: 'WinRM', target: 'nDisplay 集群', nodeCount: topo.nodes.length });
        s.pushLog({ lv: 'ok', cat: 'deploy', msg: '<b>部署完成</b> · ' + topo.nodes.length + ' 节点进入黑场待机' });
        s.setCalReceipt && s.setCalReceipt({ tone: 'ok', text: 'nDisplay 部署完成 · 黑场待机' });
      } catch (e) {
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

    const nodeStatus = (nd) => {
      const ev = nodeStates[nd.id];
      if (ev && ev.state === 'error') return 'error';
      const steps = stepStates[nd.id] || {};
      /* 逐子步 error 事件 → 节点标红；部署中与失败回到 idle 后都保留（stepStates 到下次
         startDeploy 才清空），保证「哪台/哪步挂了」在节点列可见，即便进度矩阵已卸载。 */
      if (DSTEPS.some((st) => steps[st.id] === 'error')) return 'error';
      if (deploying) {
        const okCount = DSTEPS.reduce((a, st) => a + (steps[st.id] === 'ok' ? 1 : 0), 0);
        if (okCount >= DSTEPS.length) return 'ready';
        if (okCount > 0 || DSTEPS.some((st) => steps[st.id] === 'running')) return 'deploying';
        return 'offline';
      }
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

    const buildStageShow = (inverted) => {
      const comp = window.buildStageComposite((proj.config && proj.config.screens) || {});
      const byScreen = proj.patternGenByScreen || {};
      return {
        project_path: proj.path,
        screens: (comp.screens || []).map((r) => {
          const layer = { screen_id: r.id, x: r.x, y: r.y };
          if (inverted) {
            const path = stageLayerImagePath(proj.path, r.id, byScreen[r.id] && byScreen[r.id].output_dir, true);
            if (path) layer.image_path = path;
          }
          return layer;
        }),
      };
    };
    const clusterStandby = {
      toBlack: async () => {
        setBusy(true);
        try {
          await outputShow(Object.assign(runtimeRequest(), { mode: 'clear', image_path: null }));
          s.setDeployState('standby');
          setImgKind('black');
          s.pushLog({ lv: 'info', cat: 'deploy', msg: '回到黑场待机' });
        } catch (e) { s.pushLog({ lv: 'err', cat: 'deploy', msg: String(e && e.message || e) }); }
        finally { setBusy(false); }
      },
      showPattern: async (kind) => {
        const polarity = kind === 'inverted' ? 'inverted' : 'normal';
        setBusy(true);
        try {
          await outputShow(Object.assign(runtimeRequest(), {
            mode: 'show', image_path: null, stage: buildStageShow(polarity === 'inverted'),
          }));
          s.setDeployState('showing');
          setImgKind(polarity);
          s.pushLog({ lv: 'info', cat: 'deploy', msg: polarity === 'inverted' ? '显示反相图' : '显示正常图' });
        } catch (e) { s.pushLog({ lv: 'err', cat: 'deploy', msg: String(e && e.message || e) }); }
        finally { setBusy(false); }
      },
      stop: async () => {
        setBusy(true);
        try {
          await outputStop(runtimeRequest());
          s.setDeployState('idle');
          setPhase('idle');
          setImgKind(null);
          s.pushLog({ lv: 'warn', cat: 'deploy', msg: '停止输出' });
        } catch (e) {
          s.setDeployState('idle'); setPhase('idle'); setImgKind(null);
          s.pushLog({ lv: 'warn', cat: 'deploy', msg: String(e && e.message || e) });
        } finally { setBusy(false); }
      },
    };

    const progressMatrix = deploying ? h('div', { className: 'nd-deploy', style: ui === 'dep' ? { marginTop: 2 } : null },
      h('div', { className: 'nd-deploy-h' }, '部署进度 ', h('b', null, Math.round(doneCells / total * 100) + '%'), h('span', { className: 'nd-deploy-sub' }, doneCells + ' / ' + total + ' 步')),
      h('div', { className: 'nd-deploy-grid', style: { gridTemplateColumns: '78px repeat(' + DSTEPS.length + ',1fr)' } },
        h('div', { className: 'nd-dg-corner' }),
        DSTEPS.map((st) => h('div', { key: st.id, className: 'nd-dg-col' }, st.short)),
        topo.nodes.map((n) => [
          h('div', { key: n.id + '_n', className: 'nd-dg-row' }, n.name),
          DSTEPS.map((st) => {
            const cs = cellStep(n.id, st.id); const done = cs === 'ok'; const active = cs === 'running';
            return h('div', { key: n.id + st.id, className: 'nd-dg-cell' + (done ? ' done' : active ? ' active' : '') }, done ? h(Icon, { name: 'check', size: 12 }) : active ? h(Icon, { name: 'sync', size: 12 }) : null);
          }),
        ]))) : null;

    /* ---------- handoff grid_ndisplay · nd-cluster 壳（OutputDelivery） ---------- */
    if (ui === 'nd') {
      const running = deployed && s.deployState === 'showing';
      const img = running ? (imgKind === 'inverted' ? 'inverted' : 'normal') : (deployed ? 'black' : null);
      const covered = topo.nodes.reduce((a, n) => a + n.w * n.h, 0) >= ((window.buildStageComposite(proj.config && proj.config.screens || {}) || {}).area || topo.canvas.w * topo.canvas.h);
      const topoNodes = { nodes: topo.nodes };
      const preflight = checkReport || (window.buildNdisplayPreflight
        ? window.buildNdisplayPreflight(topoNodes, s.calPreflightMode)
        : []);
      const blockingIds = new Set(preflight.filter((r) => r.issues.some((x) => (window.NDISPLAY_PREFLIGHT_KINDS[x.kind] || {}).blocking)).map((r) => r.node.id));
      const derive = (nd) => {
        const st = nodeStatus(nd);
        if (st === 'error') return 'error';
        if (deploying) return st === 'ready' ? 'ready' : 'deploying';
        if (running) return 'running';
        if (phase === 'blocked' && blockingIds.has(nd.id)) return 'error';
        return st === 'offline' ? 'offline' : 'ready';
      };
      const openNdPreflight = (report) => s.setModal({
        wide: true,
        render: ({ close }) => h(NdPreflightModal, {
          s, close, report: report || preflight,
          onDeploy: () => { close(); startDeployWithPreflight(); },
        }),
      });
      const runNdCheck = async () => {
        if (busy || deploying) return;
        setBusy(true);
        try {
          const RN = window.RENDER_NODES || [];
          const matchNode = window.matchRenderNode
            || ((m, nd) => {
              const host = (nd.machine && (nd.machine.ip || nd.machine.hostname)) || nd.machineId || nd.host || '';
              return m.id === nd.machineId || m.id === host
                || (nd.machine && ((m.ip && m.ip === nd.machine.ip) || (m.hostname && m.hostname === nd.machine.hostname)))
                || (host && (m.ip === host || m.hostname === host));
            });
          /* 只对拓扑用到的机器拉 detail；失败时保留原机（勿写空 ue_installs，否则三态 null 变假阻塞） */
          const enriched = await Promise.all(RN.map(async (m) => {
            const used = topo.nodes.some((nd) => matchNode(m, nd));
            const mid = m.id != null ? m.id : m.machineId;
            if (!used || mid == null) return m;
            try {
              const d = await getMachineDetail(mid);
              if (d && Array.isArray(d.ue_installs)) return Object.assign({}, m, { ue_installs: d.ue_installs });
              return m;
            } catch (e) {
              return m;
            }
          }));
          const report = window.buildNdisplayPreflight
            ? window.buildNdisplayPreflight(topoNodes, s.calPreflightMode, enriched)
            : [];
          setCheckReport(report);
          const blockedN = report.filter((r) => r.issues.some((x) => (window.NDISPLAY_PREFLIGHT_KINDS[x.kind] || {}).blocking)).length;
          setPhase(blockedN ? 'blocked' : 'checked');
          s.pushLog({ lv: blockedN ? 'warn' : 'ok', cat: 'ndisplay', msg: 'preflight 预检完成 · ' + (blockedN ? '<b>' + blockedN + '</b> 个节点阻塞' : '全部通过') });
          openNdPreflight(report);
        } catch (e) {
          s.pushLog({ lv: 'err', cat: 'ndisplay', msg: '预检失败 · ' + (e && e.message ? e.message : e) });
        } finally { setBusy(false); }
      };
      const sendImg = (m) => {
        if (m === 'black') return clusterStandby.toBlack();
        if (m === 'normal') return clusterStandby.showPattern('normal');
        if (m === 'inverted') return clusterStandby.showPattern('inverted');
      };
      const logLines = (n) => {
        if (running) return ['[cluster] node online · nodeName=' + n.name, '[render] displayClusterMode=' + (n.master ? 'master' : 'slave'), '[output] pattern=' + (img || 'normal') + ' -> wall OK'].join('\n');
        if (deployed) return ['[deploy] project pushed', '[deploy] session cfg written', '[verify] node ' + n.name + ' OK'].join('\n');
        return '[idle] awaiting deploy...';
      };
      const spill = (tone, icon, txt) => h('span', { className: 'spill spill--' + tone }, h(Icon, { name: icon, size: 12 }), txt);
      return h('div', { className: 'nd-cluster' },
        onlyPlayback ? null : h('button', { className: 'nd-summary', type: 'button', onClick: openTopo, title: '点击重新打开输出拓扑配置' },
          h('span', { className: 'nd-summary-ic' }, h(Icon, { name: 'panel', size: 15 })),
          h('div', { className: 'nd-summary-m' },
            h('div', { className: 'nd-summary-t' }, topo.nodes.length + ' 节点 · ' + topo.screenCount + ' 屏 · 复合画布 ' + topo.canvas.w + '×' + topo.canvas.h),
            h('div', { className: 'nd-summary-s' }, covered ? '完全覆盖' : '部分覆盖 · 有空缺')),
          covered ? spill('positive', 'check', '覆盖') : spill('notice', 'alert', '空缺'),
          h(Icon, { name: 'settings', size: 14, style: { color: 'var(--chrome-faint)' } })),
        h('div', { className: 'nd-flow' },
          onlyPlayback ? null : h('div', { className: 'nd-flow-row' },
            h(Button, { variant: 'secondary', size: 'S', isDisabled: deploying || busy, icon: h(Icon, { name: 'shield', size: 13 }), onPress: runNdCheck }, '检查'),
            h(Icon, { name: 'chevr', size: 13, style: { color: 'var(--chrome-faint)', flex: '0 0 auto' } }),
            h(Button, { variant: phase === 'checked' ? 'accent' : 'secondary', size: 'S', isDisabled: (phase !== 'checked' && !deployed) || deploying || busy, icon: h(Icon, { name: deploying ? 'sync' : 'download', size: 13 }), onPress: startDeployWithPreflight }, deploying ? '部署中' : '部署'),
            h(Icon, { name: 'chevr', size: 13, style: { color: 'var(--chrome-faint)', flex: '0 0 auto' } }),
            h(Button, { variant: deployed && !running ? 'accent' : 'secondary', size: 'S', isDisabled: !deployed || running || busy, icon: h(Icon, { name: 'play', size: 13 }), onPress: () => clusterStandby.showPattern('normal') }, running ? '显示中' : '启动集群')),
          h('div', { className: 'nd-imgseg' + (running ? '' : ' is-off') },
            h('span', { className: 'nd-imgseg-k' }, '切图'),
            h('button', { type: 'button', className: 'nd-imgbtn' + (img === 'normal' ? ' on' : ''), disabled: !running, onClick: () => sendImg('normal') }, '正常图'),
            h('button', { type: 'button', className: 'nd-imgbtn' + (img === 'inverted' ? ' on' : ''), disabled: !running, onClick: () => sendImg('inverted') }, '反相图'),
            h('button', { type: 'button', className: 'nd-imgbtn' + (img === 'black' ? ' on' : ''), disabled: !deployed || busy, onClick: () => sendImg('black') }, '清空'),
            h('button', { type: 'button', className: 'nd-stop', disabled: !deployed || busy, onClick: clusterStandby.stop, title: '停止集群输出' }, h(Icon, { name: 'x', size: 13 }), '停止'))),
        (deploying && !onlyPlayback) ? progressMatrix : null,
        onlyPlayback ? null : h('div', { className: 'nd-pills' }, topo.nodes.map((n) => {
          const st = derive(n); const meta = NST[st] || NST.ready;
          return h('div', { key: n.id, className: 'nd-pill nd-pill--' + meta.tone },
            h('span', { className: 'nd-pill-ic' }, h(Icon, { name: meta.icon, size: 13 })),
            h('div', { className: 'nd-pill-m' },
              h('span', { className: 'nd-pill-n' }, n.name, n.master ? h('span', { className: 'nd-pill-master' }, '主') : null),
              h('span', { className: 'nd-pill-h' }, n.host || n.machineId)),
            h('span', { className: 'nd-pill-st' }, meta.label));
        })),
        h('div', { className: 'nd-log' + (logOpen ? ' is-open' : '') },
          h('button', { type: 'button', className: 'nd-log-h', onClick: () => setLogOpen((v) => !v) },
            h(Icon, { name: 'terminal', size: 13 }), '运行日志',
            h('span', { className: 'nd-log-n' }, running ? '运行中' : deployed ? '已就绪' : '待部署'),
            h(Icon, { name: 'chevd', size: 14, style: { marginLeft: 'auto', transform: logOpen ? 'none' : 'rotate(-90deg)', transition: 'transform .12s' } })),
          logOpen ? h('div', { className: 'nd-log-body' }, topo.nodes.map((n) => h('div', { key: n.id, className: 'nd-log-node' },
            h('div', { className: 'nd-log-node-h' },
              h('span', { className: 'nd-log-dot', style: { background: toneVar((NST[derive(n)] || NST.ready).tone) } }),
              n.name,
              h('span', { className: 'nd-log-host' }, n.host || '')),
            h('pre', { className: 'nd-log-lines' }, logLines(n))))) : null));
    }

    /* ---------- handoff cal2_deploy · dep-* 壳（上屏部署页） ---------- */
    return h('div', { className: 'dep-sec' },
      h('div', { className: 'dep-topo' },
        h('button', { className: 'dep-topo-sum dep-topo-sum--slim', onClick: openTopo },
          h('span', { className: 'dep-topo-sum-t' }, topo.nodes.length + ' 节点 · ' + topo.screenCount + ' 屏 · ' + topo.canvas.w + '×' + topo.canvas.h),
          h('span', { className: 'dep-topo-edit' }, '编辑')),
        h('div', { className: 'dep-topo-nodes' }, topo.nodes.map((nd) => {
          const st = nodeStatus(nd), meta = NST[st] || NST.ready;
          return h('div', { key: nd.id, className: 'dep-node' },
            h('span', { className: 'dep-node-dot', style: { background: toneVar(meta.tone) } }),
            h('span', { className: 'dep-node-n' }, nd.name, nd.master ? h('span', { className: 'dep-node-master' }, '主') : null),
            h('span', { className: 'dep-node-h' }, nd.host + ' · ' + nd.w + '×' + nd.h),
            h('span', { className: 'dep-node-stage' }, stageLabel(st)));
        }))),
      h('div', { className: 'dep-flow' }, steps.flatMap((st, i) => [
        i > 0 ? h(Icon, { key: 'a' + i, name: 'chevr', size: 13, className: 'dep-flow-arrow' }) : null,
        h('span', { key: st.id, className: 'dep-step' + (st.done ? ' done' : st.active ? ' active' : '') },
          h('span', { className: 'n' }, st.done ? h(Icon, { name: 'check', size: 11 }) : (i + 1)), st.label),
      ])),
      progressMatrix,
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
          h('span', { className: 'spill spill--' + st.tone }, st.icon === 'minus' ? h('span', { style: { fontWeight: 800 } }, '—') : h(Icon, { name: st.icon, size: 12 }), st.label)),
        h('div', { className: 'dep-standby-d' }, target + ' · 通道已部署')),
      h('div', { className: 'dep-standby-acts' },
        showing
          ? h(Button, { variant: 'secondary', size: 'S', isDisabled: !!busy, icon: h(Icon, { name: 'minus', size: 13 }), onPress: actions.toBlack }, '回黑场')
          : h(Button, { variant: 'secondary', size: 'S', isDisabled: !!busy, icon: h(Icon, { name: 'grid', size: 13 }), onPress: actions.showPattern }, '显示测试图'),
        h(Button, { variant: 'secondary', size: 'S', isDisabled: !!busy, icon: h(Icon, { name: 'x', size: 13 }), onPress: actions.stop }, '停止输出')));
  }

  /* handoff grid_ndisplay PreflightModal · drawer--ndpf 壳（本地规则预检报告） */
  function NdPreflightModal({ s, close, report, onDeploy }) {
    const KIND = window.NDISPLAY_PREFLIGHT_KINDS || {};
    const spill = (tone, icon, txt) => h('span', { className: 'spill spill--' + tone }, h(Icon, { name: icon, size: 12 }), txt);
    const list = report || [];
    const blocking = list.filter((r) => r.issues.some((x) => (KIND[x.kind] || {}).blocking));
    const warnOnly = list.filter((r) => !r.issues.some((x) => (KIND[x.kind] || {}).blocking) && r.issues.length);
    const okCount = list.length - blocking.length - warnOnly.length;
    const canDeploy = blocking.length === 0;
    const issueRow = (r, i) => h('div', { key: (r.node && (r.node.id || r.node.name || r.node.node_id)) || ('nd-pf-' + i), className: 'nd-pf-node' },
      h('div', { className: 'nd-pf-node-h' },
        h('b', null, (r.node && (r.node.name || r.node.node_id)) || '—'),
        h('span', { className: 'nd-pf-mc' }, (r.machine && r.machine.host) || (r.node && r.node.machineId) || ''),
        r.issues.length === 0 ? spill('positive', 'check', '通过') : null),
      r.issues.map((iss, k) => {
        const K = KIND[iss.kind] || { label: iss.kind, tone: 'notice', icon: 'alert', blocking: false, fix: '' };
        return h('div', { key: k, className: 'nd-pf-iss nd-pf-iss--' + K.tone },
          h('div', { className: 'nd-pf-iss-h' }, h(Icon, { name: K.icon, size: 13 }),
            h('b', null, K.label), h('span', { className: 'nd-pf-tag' }, K.blocking ? '阻塞' : '警告 · 不阻止')),
          h('div', { className: 'nd-pf-detail mono' }, iss.detail),
          h('div', { className: 'nd-pf-fix' }, K.fix,
            K.goCache ? h('button', { type: 'button', className: 'nd-link', onClick: () => { close(); s.setPage('tools'); s.setCacheNav && s.setCacheNav('home'); } }, '去缓存扫描 →') : null));
      }));
    return h('div', { className: 'drawer drawer--ndpf' },
      h('div', { className: 'drawer-h' },
        h('span', { className: 'di ' + (canDeploy ? 'info' : 'danger') }, h(Icon, { name: canDeploy ? 'shield' : 'alert', size: 17 })),
        h('div', { style: { minWidth: 0, flex: 1 } }, h('h2', null, '部署预检'),
          h('div', { className: 'sub' }, 'preflight · ' + list.length + ' 个节点')),
        h('button', { className: 'iconbtn x', style: { width: 26, height: 26 }, onClick: close }, h(Icon, { name: 'x', size: 16 }))),
      h('div', { className: 'drawer-b' },
        h('div', { className: 'nd-pf-summary' },
          h('span', { className: 'nd-pf-chip nd-pf-chip--ok' }, okCount, ' 通过'),
          h('span', { className: 'nd-pf-chip nd-pf-chip--warn' }, warnOnly.length, ' 警告'),
          h('span', { className: 'nd-pf-chip nd-pf-chip--err' }, blocking.length, ' 阻塞')),
        canDeploy
          ? h('div', { className: 'nd-pf-banner nd-pf-banner--ok' }, h(Icon, { name: 'check', size: 14 }), '未发现阻塞项' + (warnOnly.length ? ' · 有非阻塞警告，可现场确认后继续部署' : ' · 可以部署'))
          : h('div', { className: 'nd-pf-banner nd-pf-banner--err' }, h(Icon, { name: 'alert', size: 14 }), '存在阻塞性错误，需先修复后才能部署'),
        h('div', { className: 'nd-pf-list' }, list.map(issueRow))),
      h('div', { className: 'drawer-f between' },
        h(Button, { variant: 'secondary', size: 'M', onPress: close }, '关闭'),
        h(Button, { variant: 'accent', size: 'M', isDisabled: !canDeploy, icon: h(Icon, { name: 'download', size: 15 }), onPress: onDeploy },
          warnOnly.length && canDeploy ? '确认警告并部署' : '开始部署')));
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
    return h('div', { className: 'drawer drawer--ndpf' },
      h('div', { className: 'drawer-h' },
        h('span', { className: 'di ' + (state === 'err' ? 'danger' : 'info') }, h(Icon, { name: 'shield', size: 17 })),
        h('div', { style: { minWidth: 0, flex: 1 } }, h('h2', null, '部署预检'), h('div', { className: 'sub' }, '核对节点在线、机器登记与 UE 路径')),
        h('button', { className: 'iconbtn x', style: { width: 26, height: 26 }, onClick: close }, h(Icon, { name: 'x', size: 16 }))),
      h('div', { className: 'drawer-b' },
        h('div', { className: 'nd-pf-banner nd-pf-banner--' + (state === 'err' ? 'err' : 'ok') },
          state === 'running' ? h(Icon, { name: 'sync', size: 14 }) : state === 'ok' ? h(Icon, { name: 'check', size: 14 }) : h(Icon, { name: 'alert', size: 14 }),
          msg),
        detail && detail.nodes ? h('div', { className: 'nd-pf-list' },
          detail.nodes.map((n, i) => h('div', { key: i, className: 'nd-pf-node' },
            h('div', { className: 'nd-pf-node-h' },
              h('b', null, n.node_id || n.id || ('#' + i)),
              h('span', { className: 'nd-pf-mc' }, n.message || n.state || 'ok'))))) : null),
      h('div', { className: 'drawer-f between' },
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
        ? h('div', { className: 'dep-sumnote ok' }, h(Icon, { name: 'check', size: 12 }), '已部署 · 可供测试图与采集引用')
        : h('div', { className: 'dep-sumnote' }, h(Icon, { name: 'info', size: 12 }), '未部署 · 采集被阻止'));
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

  /* 检查器分区：标题即折叠开关（窄栏里三段全展开会顶到屏外） */
  function DepSect({ title, cls, defOpen, children }) {
    const [open, setOpen] = useState(defOpen !== false);
    return h('div', { className: 'insp-sect dep-sect' + (cls ? ' ' + cls : '') + (open ? '' : ' is-closed') },
      h('button', { className: 'lh dep-sect-h', onClick: () => setOpen((v) => !v) },
        h('span', null, title),
        h(Icon, { name: 'chevd', size: 14, style: { marginLeft: 'auto', transform: open ? 'none' : 'rotate(-90deg)', transition: 'transform .12s' } })),
      open ? h('div', { className: 'dep-sect-b' }, children) : null);
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
      h(DepSect, { title: '部署方式', cls: 'dep-insp' },
        h(TargetCards, { s }),
        h('div', { style: { marginTop: 12 } }, s.calOutTarget === 'cluster' ? h(ClusterBranch, { s }) : h(MonitorBranch, { s }))),
      h(DepSect, { title: '当前部署状态' }, h(DeploySummaryRows, { s })));
  }

  function deployInspector(s) {
    return h(DeployInspectorBody, { s });
  }

  window.VOLO_DEPLOY = {
    deployInspector, DeploySummary, DeploySummaryRows,
    /* 供 gridNdisplay.OutputDelivery 复用真实部署分支（视觉壳在 nd-*，逻辑在此） */
    MonitorBranch, ClusterBranch, TargetCards, PreflightModal,
  };
})();
