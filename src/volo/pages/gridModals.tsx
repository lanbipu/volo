// @ts-nocheck
/* Volo — 网格校正工作区 · 弹层与对话框（gridModals.tsx）
   1:1 port of the Claude Design handoff `src/grid_modals.jsx`。
   测量类型选择器 · 指导卡 · 重建 · 融合 · 导出 · 实时采集壳（gw-capdlg*）· 采集配置。
   采集真逻辑在 gridCaptureWindow；本文件保留 handoff 双栏 modal 骨架并桥接真窗口。 */
import * as React from "react";
import { pickFile, pickDirectory, revealPath } from "../api/commands";
import { generateInstructionCard, saveInstructionPdf, exportObj, listRuns, loadProjectYaml, saveProjectYaml } from "../api/meshCommands";
import { meshFuseRun } from "../api/meshFuseCommands";
import { visualSessionCoversScreen } from "../api/visualReconstructLanding";

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
    const has = { totalstation: !!proj.measurementsAbsPath, visual: visualSessionCoversScreen(proj.visualSession, screenId) };
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
    /* handoff：取消确认用 drawer--confirm（后端无取消 hook → 仅关闭进度 UI，任务仍可能后台继续） */
    const confirmCancel = () => s.setModal({ destructive: true, render: ({ close: c2 }) => h('div', { className: 'drawer drawer--confirm' },
      dhead('alert', 'danger', '取消重建？', null, c2),
      h('div', { className: 'drawer-b' }, h('p', { style: { fontSize: 13, color: 'var(--chrome-dim)', lineHeight: 1.6 } }, '确定要关闭重建进度吗？mesh-core 当前无取消 hook；已发起的任务可能仍在后台继续，可稍后在结果列表查看。')),
      h('div', { className: 'drawer-f' },
        h(Button, { variant: 'secondary', onPress: () => s.setModal({ render: ({ close: c3 }) => h(Reconstruct, { s, close: c3 }) }) }, '继续查看进度'),
        h(Button, { variant: 'negative', onPress: () => { s.setModal(null); } }, '关闭进度'))) });
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
          h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'eye', size: 15 }), onPress: () => {
            close();
            s.setCalFlow(null);
            s.setCalMeshVersion('rebuilt');
            const list = (CX.projStore.get().runs || []);
            const cur = list.find((r) => r.is_current) || list[0];
            if (cur) {
              s.setCalSurveyRun(cur.id);
              s.setCalSel({ type: 'run', id: cur.id });
            }
            const rmsTxt = cur && cur.estimated_rms_mm != null
              ? ' · RMS ' + cur.estimated_rms_mm.toFixed(2) + ' mm'
              : '';
            s.setCalReceipt({ tone: 'ok', text: '新建网格已就绪' + rmsTxt });
          } }, '查看重建摘要')));
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
        h('div', { className: 'vmeter vmeter--accent ar-indeterminate', style: { marginTop: 12 } }, h('div', { className: 'vmeter__fill' })),
        h('div', { style: { fontSize: 12, color: 'var(--chrome-dim)', marginTop: 8 } },
          '当前 mesh-core 未提供阶段百分比；进度条为真实 indeterminate 状态。')),
      h('div', { className: 'drawer-f' },
        h(Button, { variant: 'secondary', size: 'M', icon: h(Icon, { name: 'minus', size: 15 }), onPress: close }, '最小化（后台继续）'),
        h(Button, { variant: 'negative', size: 'M', onPress: confirmCancel }, '取消')));
  }
  const reconstruct = (s, close) => h(Reconstruct, { s, close });

  /* ================= 实时采集壳（handoff gw-capdlg* · 真采集进独立窗） ================= */
  function LiveCapture({ s, close }) {
    const openReal = () => {
      close();
      if (window.VOLO_GRID_CAPTURE && window.VOLO_GRID_CAPTURE.openGrid) {
        window.VOLO_GRID_CAPTURE.openGrid(s);
      } else {
        s.pushLog && s.pushLog({ lv: 'err', cat: 'capture', msg: '网格快拍采集窗未加载' });
      }
    };
    return h('div', { className: 'drawer drawer--cal2cap', style: { width: '100%' } },
      h('div', { className: 'drawer-h' },
        h('span', { className: 'di info' }, h(Icon, { name: 'live', size: 17 })),
        h('div', { style: { minWidth: 0, flex: 1 } }, h('h2', null, '实时采集'),
          h('div', { className: 'sub', style: { display: 'flex', alignItems: 'center', gap: 8 } }, '网格屏幕重建 · 快拍',
            h('span', { className: 'gw-connpill wait' }, h(Icon, { name: 'info', size: 12 }), '独立采集窗'))),
        h('button', { className: 'iconbtn', style: { width: 26, height: 26 }, onClick: close }, h(Icon, { name: 'x', size: 16 }))),
      h('div', { className: 'gw-capdlg' },
        h('div', { className: 'gw-capmain' },
          h('div', { className: 'gw-capfeed' },
            h('div', { className: 'capw-mid', style: { position: 'absolute', inset: 0 } },
              h(Icon, { name: 'camera', size: 30, style: { color: 'var(--chrome-faint)' } }),
              h('div', { className: 'capw-mid-t' }, '网格快拍采集窗'),
              h('div', { className: 'capw-mid-d' }, '现场画面、稳定度与自动快拍已迁至独立采集窗（真信号源，非本弹层 mock）')),
            h('div', { className: 'gw-capfeed-fb' }, h(Icon, { name: 'target', size: 13 }), h('span', null, 'handoff 双栏骨架'), h('span', { className: 'warn' }, '· 采集走真窗口'))),
          h('div', { style: { padding: '8px 14px', fontSize: 11, color: 'var(--chrome-faint)', borderTop: '1px solid var(--chrome-line)' } }, '图案联动 / 灰码同步在采集窗内与上屏部署通道对齐')),
        h('div', { className: 'gw-capside' },
          h('div', { className: 'gw-capside-h' }, h(Icon, { name: 'list', size: 14 }), '采集进度 —'),
          h('div', { className: 'gw-capside-b' },
            h('div', null, h('div', { style: { fontSize: 11, color: 'var(--chrome-faint)', marginBottom: 6 } }, '传感器覆盖度'),
              h('div', { className: 'gw-covgrid' }, Array.from({ length: 16 }, (_, i) => h('div', { key: i, className: 'gw-covcell' })))),
            h('div', null, h('div', { style: { fontSize: 11, color: 'var(--chrome-faint)', marginBottom: 6 } }, '逐姿位'),
              h('div', { className: 'gw-pose-row ok' },
                h('span', { className: 'n' }, '—'),
                h('div', { className: 'm' }, h('b', null, '打开采集窗后开始'), h('span', null, '稳定度门控 · 内容门 · 快门')),
                h('button', { className: 'redo', type: 'button', disabled: true }, '重拍')))))),
      h('div', { className: 'gw-capdlg-foot' },
        h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'camera', size: 15 }), onPress: openReal }, '打开采集窗'),
        h('div', { style: { flex: 1 } }),
        h(Button, { variant: 'negative', size: 'M', onPress: close }, '取消')));
  }
  const liveCapture = (s, close) => h(LiveCapture, { s, close });

  /* ================= 采集配置（handoff LiveConfig · 真 Profile 来自 loadProfiles） ================= */
  function LiveConfig({ s, close }) {
    const profiles = (CX.loadProfiles && CX.loadProfiles()) || [];
    const [sel, setSel] = useState(profiles[0] ? profiles[0].id : '');
    const p = profiles.find((x) => x.id === sel) || profiles[0] || null;
    const F = (k, v) => h('div', { className: 'gw-field', style: { minHeight: 26 } }, h('span', { className: 'lb' }, k), h('span', { style: { fontSize: 12, color: 'var(--chrome-text)', fontFamily: 'var(--font-code)', textAlign: 'right' } }, v == null || v === '' ? '—' : String(v)));
    const openEditor = () => { close(); if (CX.openCaptureModal) CX.openCaptureModal(s); };
    if (!p) {
      return h('div', { className: 'drawer drawer--cal2cap', style: { width: '100%' } },
        dhead('camera', 'info', '管理采集配置', 'Profile · 命名配置', close),
        h('div', { className: 'drawer-b' }, h('div', { style: { fontSize: 13, color: 'var(--chrome-faint)' } }, '尚无采集配置。')),
        h('div', { className: 'drawer-f' }, h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'plus', size: 14 }), onPress: openEditor }, '新建配置')));
    }
    return h('div', { className: 'drawer drawer--cal2cap', style: { width: '100%' } },
      dhead('camera', 'info', '管理采集配置', 'Profile · 命名配置', close),
      h('div', { className: 'drawer-b' },
        h('div', { style: { display: 'grid', gridTemplateColumns: '200px 1fr', gap: 14 } },
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            profiles.map((x) => h('button', { key: x.id, type: 'button', className: 'gw-etarget' + (x.id === sel ? ' on' : ''), style: { padding: '10px 12px' }, onClick: () => setSel(x.id) },
              h('div', { className: 'm' }, h('b', { style: { fontSize: 12.5 } }, x.name), h('span', null, (x.videoBackend || '—') + ' · ' + (x.poses != null ? x.poses : '—') + ' 姿位')))),
            h(Button, { variant: 'secondary', size: 'S', icon: h(Icon, { name: 'plus', size: 13 }), onPress: openEditor }, '新建 / 编辑…')),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
            F('名称', p.name), F('视频后端', p.videoBackend), F('设备', p.device), F('追踪协议', p.trackProtocol),
            F('端口', p.trackPort), F('姿位数', p.poses), F('稳定时间', (p.settleMs != null ? p.settleMs + ' ms' : null)), F('连拍数', p.burst),
            F('反相', p.inverted ? '开' : '关'), F('灰码同步', p.graycodeSync ? '开' : '关'), F('输出目录', p.outputRoot || '—')))),
      h('div', { className: 'drawer-f' },
        h(Button, { variant: 'secondary', size: 'M', icon: h(Icon, { name: 'settings', size: 14 }), onPress: openEditor }, '打开完整编辑器'),
        h('div', { style: { flex: 1 } }),
        h(Button, { variant: 'accent', size: 'M', onPress: close }, '完成')));
  }
  const liveConfig = (s, close) => h(LiveConfig, { s, close });

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

  /* ================= 6 · nDisplay 输出拓扑（Stage 级 · 见 gridNdisplay.tsx） ================= */
  const topology = (s, close) => (window.VOLO_NDISPLAY
    ? window.VOLO_NDISPLAY.openTopology(s, close)
    : h('div', { className: 'drawer' }, h('div', { className: 'drawer-b' }, 'nDisplay 模块未加载')));

  window.VOLO_GRID_MODALS = { measSelector, guideCard, reconstruct, liveCapture, liveConfig, fuse, exportDlg, topology };
})();
