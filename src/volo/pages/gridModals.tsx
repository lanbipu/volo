// @ts-nocheck
/* Volo — 网格校正工作区 · 弹层与对话框（gridModals.tsx）
   1:1 port of the Claude Design handoff `src/grid_modals.jsx`。
   测量类型选择器 · 指导卡预览（复用 calHistory.tsx 已验证的 generateInstructionCard
   真实 htmlContent 手法）· 重建进度（M1 走 CX.rebuildMesh）· 实时采集对话框（M2，
   新接线：复用 pages/devCapture.tsx 导出的 useCaptureSession/buildSessionArgs——
   该文件顶部注释明确写着"产品采集面板落地时，本页的数据流封装原样复用"，这里正是
   那个落地点）· 融合（mesh_fuse_run，同样沿用 calHistory.tsx 的 Fuse 真实接线）·
   导出（exportObj，沿用 ExportBlock 真实接线）。 */
import * as React from "react";
import { pickFile, pickDirectory, revealPath } from "../api/commands";
import { generateInstructionCard, saveInstructionPdf, exportObj, listRuns, exportVpcalScreen } from "../api/meshCommands";
import { meshFuseRun } from "../api/meshFuseCommands";
import { useCaptureSession } from "./devCapture";
import { listMonitors, openPatternPlayer, closePatternPlayer, playerShowPattern, playerClear } from "../api/player";

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

  /* ================= 4 · 实时采集对话框（M2，接 devCapture.tsx 的 useCaptureSession） ================= */
  function LiveCapture({ s, close, onManifest }) {
    const proj = CX.useProj();
    const screenId = s.calActiveScreen;
    const [screenPath, setScreenPath] = useState('');
    const [outDir, setOutDir] = useState('');
    const profiles = CX.loadProfiles ? CX.loadProfiles() : [];
    const [profileId, setProfileId] = useState(profiles[0] ? profiles[0].id : null);
    const profile = profiles.find((p) => p.id === profileId) || null;
    const [sourceNote, setSourceNote] = useState(null);
    const session = useCaptureSession();
    const handledPatterns = useRef(new Set());
    const pendingPatterns = useRef(new Set());
    const running = session.taskId !== null && session.state.exit === null;
    const preview = session.latest('preview_ready');
    const coverage = session.latest('coverage_update');
    const progress = session.latest('progress');
    const detect = session.latest('detect_feedback');
    const result = session.latest('result');
    const conn = running ? (preview && preview.mjpeg_url ? 'on' : 'wait') : (session.spawnError ? 'off' : 'wait');

    const pickScreen = async () => { try { const p = await pickFile('屏幕定义 (screen.json)', ['json']); if (p) setScreenPath(p); } catch (e) {} };
    const generateScreen = async () => { try { const r = await exportVpcalScreen(proj.path, screenId, null); setScreenPath(r.path); setSourceNote('fingerprint ' + r.fingerprint); } catch (e) { setSourceNote('生成失败 · ' + (e && e.message ? e.message : e)); } };
    const pickOut = async () => { try { const p = await pickDirectory(); if (p) setOutDir(p); } catch (e) {} };
    const start = async () => {
      if (!screenPath || !outDir) return;
      if (!profile) return;
      const canInvert = !!(profile.inverted && profile.patternsDir);
      if (profile.inverted && !profile.patternsDir) setSourceNote('该 legacy Profile 缺 patternsDir：本次已禁用 inverted / graycode，不会假回执。');
      handledPatterns.current.clear();
      pendingPatterns.current.clear();
      if (canInvert) {
        try {
          const monitors = await listMonitors();
          if (!monitors.length) throw new Error('未发现可用于图案播放器的显示器');
          await openPatternPlayer(monitors[monitors.length - 1].index);
        } catch (e) {
          setSourceNote('打开图案播放器失败 · ' + (e && e.message ? e.message : e));
          return;
        }
      }
      session.start({ screenPath, outDir, backend: profile.videoBackend, device: profile.device,
        trackProtocol: profile.trackProtocol, trackPort: Number(profile.trackPort), trackHost: profile.trackHost || '0.0.0.0',
        trackCameraId: profile.trackCameraId,
        poses: Number(profile.poses || 8), inverted: canInvert, graycodeSync: canInvert && !!profile.graycodeSync,
        lensPath: profile.lensPath || '', settleMs: Number(profile.settleMs || 300), burst: Number(profile.burst || 5),
        width: profile.fmtMode === 'manual' ? profile.width : null, height: profile.fmtMode === 'manual' ? profile.height : null,
        fps: profile.fmtMode === 'manual' ? profile.fps : null, transferFunction: profile.transferFunction || 'sdr' });
    };
    const finish = () => session.sendCmd({ cmd: 'finish' });
    const skip = () => session.sendCmd({ cmd: 'skip_pose' });
    useEffect(() => {
      for (const ev of session.events) {
        if (ev.type !== 'request_pattern' || typeof ev.sequence !== 'number'
          || handledPatterns.current.has(ev.sequence) || pendingPatterns.current.has(ev.sequence)) continue;
        if (!profile || !profile.patternsDir) { setSourceNote('收到 request_pattern，但 Profile 无 patternsDir；未发送假 pattern_ready。'); continue; }
        pendingPatterns.current.add(ev.sequence);
        const pattern = String(ev.pattern || 'normal'); const sep = String(profile.patternsDir).includes('\\') ? '\\' : '/';
        const path = String(profile.patternsDir).replace(/[\\/]+$/, '') + sep + pattern + '.png';
        const showAndAck = async () => {
          let lastError;
          for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
              await playerShowPattern(path, pattern, ev.frame_index == null ? null : ev.frame_index);
              await session.sendCmd({ cmd: 'pattern_ready', pattern });
              return;
            } catch (e) {
              lastError = e;
              if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 400));
            }
          }
          throw lastError;
        };
        showAndAck()
          .then(() => { pendingPatterns.current.delete(ev.sequence); handledPatterns.current.add(ev.sequence); })
          .catch((e) => { pendingPatterns.current.delete(ev.sequence); setSourceNote('播放器切图失败 · ' + (e && e.message ? e.message : e)); });
      }
    }, [session.events]);
    useEffect(() => () => { closePatternPlayer().catch(() => {}); }, []);
    const confirmAbort = () => s.setModal({ destructive: true, render: ({ close: closeConfirm }) => h('div', { className: 'drawer drawer--confirm' },
      dhead('alert', 'danger', '中止实时采集', '默认保留已拍姿位', closeConfirm),
      h('div', { className: 'drawer-b' }, h('p', { className: 'lens-confirm-tx' }, '中止会终止当前进程；已增量落盘的 poses.jsonl / session.partial.json 将保留，可稍后 finalize 恢复。')),
      h('div', { className: 'drawer-f' }, h(Button, { variant: 'secondary', onPress: closeConfirm }, '继续采集'),
        h(Button, { variant: 'negative', onPress: async () => { closeConfirm(); await session.cancel(); await closePatternPlayer().catch(() => {}); close(); s.setCalReceipt({ tone: 'notice', text: '采集已中止 · 已拍姿位保留' }); } }, '中止并保留已拍姿位'))) });

    if (result && result.data) {
      const poses = result.data.poses_captured || 0;
      return h('div', { className: 'drawer drawer--preview' },
        dhead('check', 'ok', '采集汇总', '会话已完成', close),
        h('div', { className: 'drawer-b' },
          h('div', { className: 'gw-stat4', style: { gridTemplateColumns: 'repeat(2,1fr)' } },
            h('div', { className: 'gw-metric' }, h('div', { className: 'k' }, '姿位'), h('div', { className: 'v' }, poses)),
            h('div', { className: 'gw-metric' }, h('div', { className: 'k' }, '输出目录'), h('div', { className: 'v', style: { fontSize: 12 } }, result.data.session_dir)))),
        h('div', { className: 'drawer-f' },
          h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'check', size: 15 }), onPress: () => {
            close(); CX.projStore.patch({ visualSession: { screenId, poses, sessionDir: result.data.session_dir } });
            if (onManifest) onManifest(result.data.session_dir);
            s.setCalReceipt({ tone: 'ok', text: '已保存采集会话 · ' + poses + ' 姿位' });
          } }, '保存会话')));
    }

    const headerBar = h('div', { className: 'drawer-h' },
      h('span', { className: 'di info' }, h(Icon, { name: 'live', size: 17 })),
      h('div', { style: { minWidth: 0, flex: 1 } }, h('h2', null, '实时采集'),
        h('div', { className: 'sub', style: { display: 'flex', alignItems: 'center', gap: 8 } }, screenId,
          h('span', { className: 'gw-connpill ' + conn },
            h(Icon, { name: conn === 'on' ? 'check' : conn === 'wait' ? 'sync' : 'x', size: 12 }),
            conn === 'on' ? '已连接' : conn === 'wait' ? '等待数据' : (session.spawnError || '信号丢失')))),
      h('button', { className: 'iconbtn', style: { width: 26, height: 26 }, onClick: close }, h(Icon, { name: 'x', size: 16 })));

    const idlePanel = h('div', { className: 'drawer-b' },
      h('div', { className: 'gw-field stack' },
        h('span', { className: 'lb' }, 'Capture Profile'),
        h('select', { className: 'ar-select', value: profileId || '', onChange: (e) => setProfileId(e.target.value || null) },
          profiles.length ? profiles.map((p) => h('option', { key: p.id, value: p.id }, p.name + ' · ' + p.videoBackend + '/' + p.device)) : h('option', { value: '' }, '尚无 Profile'))),
      h('div', { className: 'gw-field stack', style: { marginTop: 10 } },
        h('span', { className: 'lb' }, 'screen.json'),
        h('div', { className: 'gw-fileref' },
          h('span', { className: 'ic' }, h(Icon, { name: 'doc', size: 14 })),
          h('div', { className: 'm' }, h('div', { className: 'n' }, screenPath ? screenPath.split(/[\\/]/).pop() : '尚未选择')),
          h(Button, { variant: 'secondary', size: 'S', onPress: generateScreen }, '从当前屏幕生成'),
          h(Button, { variant: 'secondary', size: 'S', onPress: pickScreen }, '选择'))),
      sourceNote ? h('div', { className: 'lens-nanote' }, sourceNote) : null,
      h('div', { className: 'gw-field stack', style: { marginTop: 10 } },
        h('span', { className: 'lb' }, '输出目录'),
        h('div', { className: 'gw-fileref' },
          h('span', { className: 'ic' }, h(Icon, { name: 'folder', size: 14 })),
          h('div', { className: 'm' }, h('div', { className: 'n' }, outDir || '尚未选择')),
          h(Button, { variant: 'secondary', size: 'S', onPress: pickOut }, '选择'))),
      session.spawnError ? h('div', { style: { fontSize: 11.5, color: 'var(--negative-visual)', marginTop: 8 } }, session.spawnError) : null,
      h('div', { style: { marginTop: 14 } },
        h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'camera', size: 15 }), isDisabled: !profile || !screenPath || !outDir, onPress: start }, '开始采集')));

    const capMain = h('div', { className: 'gw-capmain' },
      h('div', { className: 'gw-capfeed' },
        preview && preview.mjpeg_url
          ? h('img', { src: preview.mjpeg_url, alt: '预览' })
          : h('div', { style: { color: '#6b7078', fontSize: 12, padding: 20 } }, '等待预览画面…'),
        h('div', { className: 'gw-capfeed-fb' },
          h(Icon, { name: 'target', size: 13 }),
          h('span', null, detect ? `pose ${detect.pose_index} · ${detect.marker_hits} markers` : '等待检测反馈'))),
      h('div', { style: { padding: '8px 14px', fontSize: 11, color: 'var(--chrome-faint)', borderTop: '1px solid var(--chrome-line)' } },
        '状态：' + (progress ? progress.state : '—') + ' · 已采集 ' + (progress ? progress.poses_captured || 0 : 0) + ' 姿位'));

    const capSide = h('div', { className: 'gw-capside' },
      h('div', { className: 'gw-capside-h' }, h(Icon, { name: 'list', size: 14 }), '覆盖度反馈'),
      h('div', { className: 'gw-capside-b' },
        coverage
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 11.5 } },
              h('span', null, '画面覆盖：' + Math.round((coverage.sensor_coverage_pct || 0) * 100) + '%'),
              h('span', null, '屏幕 marker：' + coverage.screen_markers_seen + '/' + coverage.screen_markers_total),
              (coverage.suggestions || []).map((sug, i) => h('span', { key: i, style: { color: 'var(--notice-visual)' } }, '→ ' + sug)))
          : h('div', { style: { fontSize: 11.5, color: 'var(--chrome-faint)' } }, '暂无（每个姿位采集后更新）')));

    const capFoot = h('div', { className: 'gw-capdlg-foot' },
      h(Button, { variant: 'secondary', size: 'M', onPress: skip }, '跳过此姿位'),
      h('div', { style: { flex: 1 } }),
      h(Button, { variant: 'secondary', size: 'M', icon: h(Icon, { name: 'check', size: 15 }), onPress: finish }, '完成'),
      h(Button, { variant: 'negative', size: 'M', onPress: confirmAbort }, '中止'));

    const capturingPanel = h('div', { className: 'gw-capdlg' }, capMain, capSide, capFoot);

    return h('div', { className: 'drawer drawer--cal2cap', style: { width: '100%' } },
      headerBar,
      running ? capturingPanel : idlePanel);
  }
  const liveCapture = (s, close, onManifest) => h(LiveCapture, { s, close, onManifest });

  /* ================= 6 · 融合对话框（真 mesh_fuse_run，同 calHistory.tsx Fuse） ================= */
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

  /* ================= 7 · 导出对话框（真 exportObj，同 calHistory.tsx ExportBlock） ================= */
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

  window.VOLO_GRID_MODALS = { measSelector, guideCard, reconstruct, liveCapture, fuse, exportDlg };
})();
