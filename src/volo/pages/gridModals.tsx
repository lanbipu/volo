// @ts-nocheck
/* Volo — 网格校正工作区 · 弹层与对话框（gridModals.tsx）
   1:1 port of the Claude Design handoff `src/grid_modals.jsx`。
   测量类型选择器 · 指导卡预览（复用 calHistory.tsx 已验证的 generateInstructionCard
   真实 htmlContent 手法）· 重建进度（M1 走 CX.rebuildMesh）· 融合（mesh_fuse_run，
   同样沿用 calHistory.tsx 的 Fuse 真实接线）· 导出（exportObj，沿用 ExportBlock
   真实接线）。原「实时采集对话框」（M2）已被 calCaptureWindow.tsx 的共享采集单窗口
   取代，见 pages/gridTree.tsx / gridInsp.tsx 的「接入摄影机…」入口。 */
import * as React from "react";
import { pickFile, pickDirectory, revealPath } from "../api/commands";
import { generateInstructionCard, saveInstructionPdf, exportObj, listRuns, loadProjectYaml, saveProjectYaml } from "../api/meshCommands";
import { meshFuseRun } from "../api/meshFuseCommands";

(function () {
  const { Button, Switch } = window.Spectrum2DesignSystem_b6d1b3;
  const { useState, useEffect, useRef } = React;
  const h = React.createElement;
  const CX = window.VOLO_CAL2;

  const dhead = (icon, tone, title, sub, close) => h('div', { className: 'drawer-h' },
    h('span', { className: 'di ' + (tone || 'info') }, h(Icon, { name: icon, size: 17 })),
    h('div', { style: { minWidth: 0, flex: 1 } }, h('h2', null, title), sub ? h('div', { className: 'sub' }, sub) : null),
    close ? h('button', { className: 'iconbtn x', style: { width: 26, height: 26 }, onClick: close }, h(Icon, { name: 'x', size: 16 })) : null);

  /* ================= 1 · 测量类型选择器 ================= */
  function MeasSelector({ s, close }) {
    const proj = CX.useProj();
    const screenId = s.calActiveScreen;
    const m = proj.config && proj.config.screens[screenId];
    const req = {
      totalstation: proj.config && [proj.config.coordinate_system.origin_point, proj.config.coordinate_system.x_axis_point, proj.config.coordinate_system.xy_plane_point].every((n) => n && n.startsWith(screenId + '_V')),
      visual: !!(proj.patternGenByScreen && proj.patternGenByScreen[screenId]),
    };
    const has = { totalstation: !!proj.measurementsAbsPath, visual: !!(proj.visualSession && proj.visualSession.screenId === screenId) };
    const pick = (id) => { close(); s.setCalFlow(id); s.pushLog({ lv: 'info', cat: 'measure', msg: '打开测量流程 · <b>' + GRID_MEAS_TYPES.find((t) => t.id === id).label + '</b>' }); };
    return h('div', { className: 'drawer drawer--cal2cap' },
      dhead('download', 'info', '选择测量方式', '为屏幕重建采集真实数据', close),
      h('div', { className: 'drawer-b' },
        h('div', { className: 'gw-meas-grid' }, GRID_MEAS_TYPES.map((t) => {
          const disabled = t.id === 'visual' && m && t.disabledForShapes && t.disabledForShapes.includes(m.shape_prior.type);
          return h('button', { key: t.id, className: 'gw-meas-card' + (disabled ? ' is-disabled' : ''), disabled, title: disabled ? t.disabledMsg : '', onClick: () => !disabled && pick(t.id) },
            h('span', { className: 'gw-meas-ic' }, h(Icon, { name: t.icon, size: 22 })),
            h('h3', null, t.label),
            h('div', { className: 'gw-meas-desc' }, t.desc),
            h('div', { className: 'gw-meas-fit' }, disabled ? t.disabledMsg : t.fit),
            h('div', { className: 'gw-meas-status' },
              disabled ? h('span', { className: 'spill spill--neutral' }, h(Icon, { name: 'minus', size: 12 }), '暂不支持')
                : req[t.id]
                  ? h('span', { className: 'spill spill--positive' }, h(Icon, { name: 'check', size: 12 }), '前置条件已就绪')
                  : h('span', { className: 'spill spill--notice' }, h(Icon, { name: 'alert', size: 12 }), '前置条件未满足'),
              has[t.id] ? h('span', { className: 'gw-tmeta' }, '已有数据') : null,
              h('span', { className: 'gw-meas-go' }, h(Icon, { name: 'arrowr', size: 18 }))));
        }))));
  }
  const measSelector = (s, close) => h(MeasSelector, { s, close });

  /* ================= 2 · 指导卡预览（真 htmlContent，同 calHistory.tsx PreviewModal） ================= */
  function GuideCard({ s, close }) {
    const proj = CX.useProj();
    const screenId = s.calActiveScreen;
    const [html, setHtml] = useState(null);
    const [err, setErr] = useState(null);
    useEffect(() => {
      if (!proj.path) return undefined;
      generateInstructionCard(proj.path, screenId).then((card) => setHtml(card.htmlContent)).catch((e) => setErr(e && e.message ? e.message : String(e)));
    }, [proj.path, screenId]);
    const exportPdf = async () => {
      let dir;
      try { dir = await pickDirectory(); } catch (e) { return; }
      if (!dir) return;
      const dst = dir.replace(/[\\/]+$/, '') + '/' + screenId + '_instruction_card.pdf';
      s.runCmd({ domain: 'calibrate', action: '生成指导卡', target: screenId, chan: 'local' },
        () => saveInstructionPdf(proj.path, screenId, dst), { okMsg: (p) => `指导卡已保存 → <b>${p}</b>` }).catch(() => {});
    };
    return h('div', { className: 'drawer drawer--cal2cap' },
      dhead('doc', 'info', '全站仪指导卡预览', screenId + '_instruction_card.pdf', close),
      h('div', { className: 'drawer-b' },
        err ? h('div', { style: { color: 'var(--negative-visual)', fontSize: 12.5 } }, err)
          : html ? h('iframe', { srcDoc: html, style: { width: '100%', height: 420, border: 'none', display: 'block', background: '#f6f6f8', borderRadius: 8 }, title: 'guide-preview' })
          : h('div', { style: { fontSize: 12, color: 'var(--chrome-faint)' } }, '生成中…')),
      h('div', { className: 'drawer-f' },
        h(Button, { variant: 'secondary', size: 'M', onPress: close }, '关闭'),
        h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'download', size: 15 }), isDisabled: !html, onPress: exportPdf }, '导出 PDF')));
  }
  const guideCard = (s, close) => h(GuideCard, { s, close });

  /* ================= 3 · 重建进度（统一长任务；M1 走 CX.rebuildMesh 真实重建） ================= */
  function Reconstruct({ s, close }) {
    const proj = CX.useProj();
    const [phase, setPhase] = useState('run');
    const doneRef = useRef(null);
    useEffect(() => {
      let alive = true;
      CX.rebuildMesh(s, proj).then(() => { if (alive) { doneRef.current = { ok: true }; setPhase('done'); } })
        .catch(() => { if (alive) { doneRef.current = { ok: false }; setPhase('done'); } });
      return () => { alive = false; };
    }, []);
    if (phase === 'done' && doneRef.current && doneRef.current.ok) {
      const qm = proj.reconstruction && proj.reconstruction.quality_metrics;
      return h('div', { className: 'drawer drawer--preview' },
        dhead('check', 'ok', '重建完成', '新建网格已生成', close),
        h('div', { className: 'drawer-b' },
          qm ? h('div', { className: 'gw-stat4', style: { gridTemplateColumns: 'repeat(2,1fr)' } },
            h('div', { className: 'gw-metric' }, h('div', { className: 'k' }, 'estimated_rms'), h('div', { className: 'v', style: { color: 'var(--positive-visual)' } }, qm.estimated_rms_mm == null ? 'n/a' : qm.estimated_rms_mm.toFixed(2), qm.estimated_rms_mm == null ? null : h('span', { style: { fontSize: 11, marginLeft: 3, color: 'var(--chrome-faint)' } }, 'mm'))),
            h('div', { className: 'gw-metric' }, h('div', { className: 'k' }, '顶点数'), h('div', { className: 'v' }, ((proj.reconstruction.surface.vertices.length) / 1000).toFixed(1) + 'k')),
            h('div', { className: 'gw-metric' }, h('div', { className: 'k' }, 'measured/expected'), h('div', { className: 'v' }, qm.measured_count + '/' + qm.expected_count)),
            h('div', { className: 'gw-metric' }, h('div', { className: 'k' }, 'middle_max_dev'), h('div', { className: 'v' }, qm.middle_max_dev_mm.toFixed(2), h('span', { style: { fontSize: 11, marginLeft: 3, color: 'var(--chrome-faint)' } }, 'mm')))) : null),
        h('div', { className: 'drawer-f' },
          h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'eye', size: 15 }), onPress: () => { close(); s.setCalFlow(null); s.setCalMeshVersion('rebuilt'); } }, '在视口中查看')));
    }
    if (phase === 'done') {
      return h('div', { className: 'drawer drawer--preview' },
        dhead('alert', 'danger', '重建失败', null, close),
        h('div', { className: 'drawer-b' }, h('p', { style: { fontSize: 13, color: 'var(--chrome-dim)' } }, '详情见控制台日志。')),
        h('div', { className: 'drawer-f' }, h(Button, { variant: 'secondary', onPress: close }, '关闭')));
    }
    return h('div', { className: 'drawer drawer--preview' },
      dhead('cube3', 'info', '网格重建中', '统一长任务规格', null),
      h('div', { className: 'drawer-b' },
        h('div', { className: 'gw-pipe' },
          h('div', { className: 'gw-pipe-st active' },
            h('div', { className: 'gw-pipe-dot' }, h(Icon, { name: 'refresh', size: 12 })),
            h('div', { className: 'gw-pipe-lb' }, '后端重建执行中'))),
        h('div', { style: { fontSize: 12, color: 'var(--chrome-dim)' } },
          '当前 mesh-core 未提供阶段百分比或取消 hook；此处显示真实 indeterminate 状态。')),
      h('div', { className: 'drawer-f' },
        h(Button, { variant: 'secondary', size: 'M', icon: h(Icon, { name: 'minus', size: 15 }), onPress: close }, '最小化（后台继续）')));
  }
  const reconstruct = (s, close) => h(Reconstruct, { s, close });

  /* ================= 4 · 融合对话框（真 mesh_fuse_run，同 calHistory.tsx Fuse） ================= */
  function Fuse({ s, close }) {
    const proj = CX.useProj();
    const screenId = s.calActiveScreen;
    const [scale, setScale] = useState(false);
    const [result, setResult] = useState(null);
    const [err, setErr] = useState(null);
    const [running, setRunning] = useState(false);
    const runFuse = async () => {
      const measurementsPath = proj.measurementsAbsPath;
      if (!measurementsPath) { s.pushLog({ lv: 'warn', cat: 'fuse', msg: '融合失败 · 请先导入全站仪测量' }); return; }
      let poseReportPath;
      try { poseReportPath = await pickFile('M2 视觉重建 pose report', ['yaml', 'yml', 'json']); }
      catch (e) { return; }
      if (!poseReportPath) return;
      setRunning(true); setErr(null);
      try {
        const res = await meshFuseRun(proj.path, screenId, poseReportPath, measurementsPath, scale);
        setResult(res);
        s.pushLog({ lv: 'ok', cat: 'fuse', msg: `融合完成 · anchor RMS <b>${res.anchor_rms_mm.toFixed(2)} mm</b> · ${res.anchor_count} 锚点` });
      } catch (e) { setErr(e && e.message ? e.message : String(e)); } finally { setRunning(false); }
    };
    return h('div', { className: 'drawer drawer--cal2cap' },
      dhead('link', 'info', '融合数据', '全站仪锚定 + 视觉稠密化', close),
      h('div', { className: 'drawer-b' },
        h('div', { className: 'gw-field', style: { minHeight: 30 } }, h('span', { className: 'lb' }, '全站仪数据集'), h('span', { style: { fontFamily: 'var(--font-code)', fontSize: 12, color: 'var(--chrome-text)' } }, proj.measurementsAbsPath ? '已导入' : '未导入')),
        h('div', { className: 'gw-field', style: { minHeight: 30 } }, h('span', { className: 'lb' }, '视觉结果 pose report'), h('span', { style: { fontSize: 11.5, color: 'var(--chrome-faint)' } }, '点「开始融合」时选择')),
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 0', borderTop: '1px solid var(--chrome-line)', marginTop: 4 } },
          h('div', null, h('div', { style: { fontSize: 12.5, color: 'var(--chrome-dim)' } }, '允许尺度缩放'), h('div', { style: { fontSize: 10.5, color: 'var(--chrome-faint)', maxWidth: 300 } }, '默认关闭。开启后融合可微调整体尺度以吸收视觉标定的尺度漂移。')),
          h(Switch, { isSelected: scale, onChange: setScale })),
        err ? h('div', { style: { fontSize: 12, color: 'var(--negative-visual)', marginTop: 8 } }, err) : null,
        result ? h(React.Fragment, null,
          h('div', { className: 'gw-stat4', style: { gridTemplateColumns: 'repeat(3,1fr)', marginTop: 6 } },
            h('div', { className: 'gw-metric' }, h('div', { className: 'k' }, '锚点数'), h('div', { className: 'v' }, result.anchor_count)),
            h('div', { className: 'gw-metric' }, h('div', { className: 'k' }, '锚点 RMS'), h('div', { className: 'v', style: { color: 'var(--positive-visual)' } }, result.anchor_rms_mm.toFixed(2), h('span', { style: { fontSize: 11, marginLeft: 3, color: 'var(--chrome-faint)' } }, 'mm'))),
            h('div', { className: 'gw-metric' }, h('div', { className: 'k' }, '尺度因子'), h('div', { className: 'v' }, result.scale.toFixed(4)))),
          h('div', { style: { marginTop: 10, border: '1px solid var(--chrome-line)', borderRadius: 9, overflow: 'hidden' } },
            h('div', { className: 'cal2-res-head' }, h('span', null, '锚点'), h('span', null, '残差 mm'), h('span', null, 'Δ mm (x,y,z)')),
            result.anchor_residuals.map((a) => h('div', { key: a.point_name, className: 'cal2-res-row' + (a.residual_mm > 2 ? ' over' : '') },
              h('span', { className: 'mono' }, a.point_name),
              h('span', { className: 'mono' }, a.residual_mm.toFixed(2)),
              h('span', { className: 'mono dim' }, '[' + a.delta_mm.map((d) => d.toFixed(2)).join(', ') + ']'))))) : null),
      h('div', { className: 'drawer-f' },
        result
          ? h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'check', size: 15 }), onPress: close }, '完成')
          : h(Button, { variant: 'accent', size: 'M', isDisabled: running, icon: h(Icon, { name: 'link', size: 15 }), onPress: runFuse }, running ? '融合中…' : '开始融合')));
  }
  const fuse = (s, close) => h(Fuse, { s, close });

  /* ================= 5 · 导出对话框（真 exportObj，同 calHistory.tsx ExportBlock） ================= */
  function ExportDlg({ s, close }) {
    const proj = CX.useProj();
    const [target, setTarget] = useState('disguise');
    const [savePath, setSavePath] = useState('');
    const [done, setDone] = useState(null);
    const runId = proj.reconstruction && proj.reconstruction.run_id;
    const doExport = async () => {
      if (!runId) return;
      try {
        const p = await s.runCmd({ domain: 'calibrate', action: '导出网格', target, chan: 'local' },
          () => exportObj(runId, target, savePath.trim() || null), { okMsg: (path) => `导出完成 → <b>${path}</b>` });
        setDone(p);
      } catch (e) { /* runCmd 已记录失败 */ }
    };
    return h('div', { className: 'drawer drawer--cal2cap', style: { width: '100%' } },
      dhead('external', 'info', '导出网格', 'OBJ · 下游软件', close),
      h('div', { className: 'drawer-b' },
        done
          ? h('div', { className: 'cal2-switch-ok', style: { marginTop: 0 } }, h(Icon, { name: 'check', size: 15 }), h('span', null, '已导出 → ', h('b', null, done)))
          : h(React.Fragment, null,
              h('div', { style: { fontSize: 11, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--chrome-faint)', marginBottom: 8 } }, '目标'),
              h('div', { className: 'gw-export-targets' }, GRID_EXPORT_TARGETS.map((t) => h('button', { key: t.id, className: 'gw-etarget' + (t.id === target ? ' on' : ''), onClick: () => setTarget(t.id) },
                h('span', { className: 'rd' }), h('div', { className: 'm' }, h('b', null, t.label), h('span', null, t.desc))))),
              h('div', { className: 'gw-field', style: { minHeight: 30, marginTop: 12 } }, h('span', { className: 'lb' }, '导出源'), h('span', { style: { fontFamily: 'var(--font-code)', fontSize: 12, color: 'var(--chrome-text)' } }, runId ? 'run #' + runId + '（当前）' : '尚无重建结果')),
              h('div', { className: 'gw-field stack', style: { marginTop: 4 } }, h('span', { className: 'lb' }, '另存路径（可空）'), h('input', { className: 'gw-txt', value: savePath, placeholder: '留空使用默认路径', onChange: (e) => setSavePath(e.target.value) })))),
      h('div', { className: 'drawer-f between' },
        h(Button, { variant: 'secondary', size: 'M', icon: h(Icon, { name: 'doc', size: 14 }), onPress: () => s.setModal({ render: ({ close: c2 }) => guideCard(s, c2) }) }, '指导卡 PDF'),
        done
          ? h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'external', size: 15 }), onPress: () => revealPath(done).catch(() => {}) }, '打开所在文件夹')
          : h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'download', size: 15 }), isDisabled: !runId, onPress: doExport }, '导出 OBJ')));
  }
  const exportDlg = (s, close) => h(ExportDlg, { s, close });

  /* ================= 6 · nDisplay 输出拓扑 ================= */
  function validateOutputTopology(screen, nodes) {
    const pixels = screen.pixels_per_cabinet || [0, 0];
    const canvas = [screen.cabinet_count[0] * pixels[0], screen.cabinet_count[1] * pixels[1]];
    if (pixels[0] <= 0 || pixels[1] <= 0) {
      return { canvas, errors: ['请先在参数面板设置箱体像素密度'], warnings: [] };
    }
    const errors = [];
    const warnings = [];
    const ids = new Set();
    let primaryCount = 0;
    let totalArea = 0;
    nodes.forEach((node) => {
      const [x, y, w, height] = node.viewport_rect_px;
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(node.node_id)) errors.push(`节点 ${node.node_id || '（空）'}：ID 只能包含字母、数字、_、-`);
      if (ids.has(node.node_id)) errors.push(`节点 ID 重复：${node.node_id}`);
      ids.add(node.node_id);
      if (node.primary) primaryCount += 1;
      if (w <= 0 || height <= 0) errors.push(`${node.node_id}：crop 宽高必须大于 0`);
      else if (x < 0 || y < 0 || x + w > canvas[0] || y + height > canvas[1]) errors.push(`${node.node_id}：crop 超出 ${canvas[0]}×${canvas[1]} 画布`);
      else totalArea += w * height;
      if (node.window_px[0] !== w || node.window_px[1] !== height) errors.push(`${node.node_id}：窗口 ${node.window_px.join('×')} ≠ crop ${w}×${height}；像素 1:1 必须相等`);
    });
    if (primaryCount !== 1) errors.push(`必须且只能有一个 Primary；当前 ${primaryCount} 个`);
    for (let a = 0; a < nodes.length; a += 1) for (let b = a + 1; b < nodes.length; b += 1) {
      const A = nodes[a].viewport_rect_px; const B = nodes[b].viewport_rect_px;
      if (A[0] < B[0] + B[2] && B[0] < A[0] + A[2] && A[1] < B[1] + B[3] && B[1] < A[1] + A[3]) errors.push(`${nodes[a].node_id} 与 ${nodes[b].node_id} 的 crop 重叠`);
    }
    if (!errors.some((x) => x.includes('crop')) && totalArea !== canvas[0] * canvas[1]) warnings.push(`viewport 总面积 ${totalArea}，未完整覆盖画布 ${canvas[0] * canvas[1]}`);
    const identities = {};
    nodes.forEach((node) => [node.machine.hostname, node.machine.ip].filter(Boolean).forEach((key) => { identities[key.toLowerCase()] = (identities[key.toLowerCase()] || []).concat(node.node_id); }));
    Object.values(identities).filter((group) => group.length > 1).forEach((group) => warnings.push(`同一机器分配了多个节点：${group.join(', ')}`));
    return { canvas, errors: Array.from(new Set(errors)), warnings: Array.from(new Set(warnings)) };
  }

  function TopologyDialog({ s, close }) {
    const proj = CX.useProj();
    const screenId = s.calActiveScreen;
    const screen = proj.config.screens[screenId];
    const pixels = screen.pixels_per_cabinet || [0, 0];
    const canvas = [screen.cabinet_count[0] * pixels[0], screen.cabinet_count[1] * pixels[1]];
    const defaultNodes = [
      { node_id: 'LanNode', machine: { hostname: 'lanPC', ip: '' }, viewport_rect_px: [0, 0, Math.floor(canvas[0] / 2), canvas[1]], window_px: [Math.floor(canvas[0] / 2), canvas[1]], fullscreen: false, primary: true },
      { node_id: 'RazerNode', machine: { hostname: 'Razer', ip: '192.168.10.173' }, viewport_rect_px: [Math.floor(canvas[0] / 2), 0, canvas[0] - Math.floor(canvas[0] / 2), canvas[1]], window_px: [canvas[0] - Math.floor(canvas[0] / 2), canvas[1]], fullscreen: false, primary: false },
    ];
    const [nodes, setNodes] = useState(() => JSON.parse(JSON.stringify((screen.output_topology && screen.output_topology.nodes) || defaultNodes)).map((node) => Object.assign({}, node, { fullscreen: false })));
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState('');
    const validation = validateOutputTopology(screen, nodes);
    const patchNode = (index, patch) => setNodes((current) => current.map((node, i) => i === index ? Object.assign({}, node, patch) : node));
    const patchMachine = (index, patch) => patchNode(index, { machine: Object.assign({}, nodes[index].machine, patch) });
    const patchRect = (index, position, value) => { const next = nodes[index].viewport_rect_px.slice(); next[position] = Math.max(0, Number(value) || 0); patchNode(index, { viewport_rect_px: next }); };
    const patchWindow = (index, position, value) => { const next = nodes[index].window_px.slice(); next[position] = Math.max(0, Number(value) || 0); patchNode(index, { window_px: next }); };
    const setPrimary = (index) => setNodes((current) => current.map((node, i) => Object.assign({}, node, { primary: i === index })));
    const addNode = () => setNodes((current) => current.concat({ node_id: `Node${current.length + 1}`, machine: { hostname: '', ip: '' }, viewport_rect_px: [0, 0, canvas[0], canvas[1]], window_px: [canvas[0], canvas[1]], fullscreen: false, primary: current.length === 0 }));
    const save = async () => {
      if (validation.errors.length || saving) return;
      setSaving(true); setSaveError('');
      try {
        const latest = await loadProjectYaml(proj.path);
        const windowedNodes = nodes.map((node) => Object.assign({}, node, { fullscreen: false }));
        const nextScreen = Object.assign({}, latest.screens[screenId], { output_topology: { nodes: windowedNodes } });
        const next = Object.assign({}, latest, { screens: Object.assign({}, latest.screens, { [screenId]: nextScreen }) });
        await saveProjectYaml(proj.path, next);
        await CX.openProjectPath(proj.path, s);
        s.setCalReceipt({ tone: 'ok', text: `输出拓扑已保存 · ${nodes.length} 节点` });
        close();
      } catch (e) { setSaveError(e && e.message ? e.message : String(e)); }
      finally { setSaving(false); }
    };
    const preview = h('section', { className: 'topo-preview' },
      h('svg', { viewBox: `0 0 ${Math.max(1, validation.canvas[0])} ${Math.max(1, validation.canvas[1])}`, role: 'img', 'aria-label': 'nDisplay viewport crop 预览' },
        h('rect', { x: 0, y: 0, width: validation.canvas[0], height: validation.canvas[1], className: 'canvas' }),
        nodes.map((node, index) => h('g', { key: `${node.node_id}-${index}` },
          h('rect', { x: node.viewport_rect_px[0], y: node.viewport_rect_px[1], width: node.viewport_rect_px[2], height: node.viewport_rect_px[3], className: node.primary ? 'node primary' : 'node' }),
          h('text', { x: node.viewport_rect_px[0] + 12, y: node.viewport_rect_px[1] + 24 }, `${node.node_id}${node.primary ? ' · P' : ''}`)))),
      h('div', { className: 'topo-legend' },
        h('span', { className: 'cap-pill cap-pill--informative' }, h(Icon, { name: 'grid', size: 11 }), `${nodes.length} 节点`),
        h('span', null, 'crop 坐标基于完整测试图')));
    const editor = h('section', { className: 'topo-editor' },
      nodes.map((node, index) => h('div', { key: index, className: 'topo-node-card' },
        h('div', { className: 'topo-node-head' },
          h('label', null, h('input', { type: 'radio', name: 'topo-primary', checked: node.primary, onChange: () => setPrimary(index) }), ' Primary'),
          h('b', null, node.node_id || `节点 ${index + 1}`),
          h('button', { className: 'rm', disabled: nodes.length <= 1, onClick: () => setNodes((current) => current.filter((_, i) => i !== index)) }, h(Icon, { name: 'trash', size: 13 }), '移除')),
        h('div', { className: 'topo-fields' },
          h('label', null, '节点 ID', h('input', { className: 'gw-txt', value: node.node_id, onChange: (e) => patchNode(index, { node_id: e.target.value }) })),
          h('label', null, 'Hostname', h('input', { className: 'gw-txt', value: node.machine.hostname, onChange: (e) => patchMachine(index, { hostname: e.target.value }) })),
          h('label', null, 'IP', h('input', { className: 'gw-txt', value: node.machine.ip, onChange: (e) => patchMachine(index, { ip: e.target.value }) })),
          h('label', null, 'Crop x / y', h('span', { className: 'dual' }, [0, 1].map((position) => h('input', { key: position, className: 'gw-num', type: 'number', min: 0, value: node.viewport_rect_px[position], onChange: (e) => patchRect(index, position, e.target.value) })))),
          h('label', null, 'Crop w / h', h('span', { className: 'dual' }, [2, 3].map((position) => h('input', { key: position, className: 'gw-num', type: 'number', min: 1, value: node.viewport_rect_px[position], onChange: (e) => patchRect(index, position, e.target.value) })))),
          h('label', null, 'Window w / h', h('span', { className: 'dual' }, [0, 1].map((position) => h('input', { key: position, className: 'gw-num', type: 'number', min: 1, value: node.window_px[position], onChange: (e) => patchWindow(index, position, e.target.value) })))),
          h('label', { className: 'check', title: '一期仅窗口模式' }, h('input', { type: 'checkbox', checked: false, disabled: true }), '全屏输出（一期仅窗口模式）')))),
      h(Button, { variant: 'secondary', size: 'S', icon: h(Icon, { name: 'plus', size: 13 }), onPress: addNode }, '添加节点'));
    const validationView = h('section', { className: 'topo-validation' },
      h('h3', null, '校验'),
      !validation.errors.length && !validation.warnings.length ? h('div', { className: 'issue ok' }, h(Icon, { name: 'check', size: 13 }), '拓扑有效，可以保存') : null,
      validation.errors.map((message, index) => h('div', { key: `e${index}`, className: 'issue error' }, h(Icon, { name: 'alert', size: 13 }), message)),
      validation.warnings.map((message, index) => h('div', { key: `w${index}`, className: 'issue warning' }, h(Icon, { name: 'info', size: 13 }), message)),
      saveError ? h('div', { className: 'issue error' }, h(Icon, { name: 'alert', size: 13 }), saveError) : null);
    const footer = h('div', { className: 'drawer-f between' },
      h('span', { className: validation.errors.length ? 'topo-blocked' : 'topo-ready' }, validation.errors.length ? `${validation.errors.length} 项错误阻塞保存` : '像素 1:1 gate 已通过'),
      h('div', { className: 'gw-mrow' },
        h(Button, { variant: 'secondary', size: 'M', onPress: close }, '取消'),
        h(Button, { variant: 'accent', size: 'M', isDisabled: saving || !!validation.errors.length, icon: h(Icon, { name: 'check', size: 14 }), onPress: save }, saving ? '保存中…' : '保存拓扑')));
    return h('div', { className: 'drawer drawer--topology' },
      dhead('grid', 'info', '配置 nDisplay 输出拓扑', `${screenId} · 画布 ${validation.canvas[0]}×${validation.canvas[1]} px`, close),
      h('div', { className: 'drawer-b topo-body' }, preview, editor, validationView),
      footer);
  }
  const topology = (s, close) => h(TopologyDialog, { s, close });

  window.VOLO_GRID_MODALS = { measSelector, guideCard, reconstruct, fuse, exportDlg, topology };
})();
