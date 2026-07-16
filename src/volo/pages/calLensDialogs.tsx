// @ts-nocheck
/* Volo — 校正 · 镜头校正 · 二级对话框 ×4
   1:1 port of the Claude Design handoff `src/cal2_lens_dialogs.jsx`, wired to real vpcal.
   ① 从已有 session 求解  ② 求解结果报告  ③ 导出 OpenTrackIO  ④ 播放器自检

   真实接线要点：
   - ①/② 复用 calLens.tsx 的 useLensSolve（同一份 `vpcal quick run` 发起/解析逻辑）。
   - ③ spawnSidecar('vpcal',['export','opentrackio',...]) 一次性阻塞调用（非流式，
     导出通常是秒级操作）；延迟档案只提供「不应用」这一项——AR 延迟校准本批未实现
     （calibrate.tsx arCenter() 仍是 WIP 占位），没有真实产物可复用，不臆造第二项。
   - ④ list_monitors + open_pattern_player 都是真命令；「分辨率校验」比较的是
     player 窗口物理尺寸 vs 该显示器自身列出的尺寸（两个独立真实来源），不是设计稿
     里的「pattern 分辨率 vs 窗口」——本页没有真实 pattern 图片可比对（vpcal pattern
     generate 是另一条独立子命令，未接线），如实调整对比对象而非借用假 pattern 尺寸。
   - 「打开文件夹」一律用真实 revealPath，不是 pushLog 假动作。 */
import * as React from "react";
import { pickFile, pickDirectory, revealPath } from "../api/commands";
import { listLensSessions, readImageAsDataUrl, readLensQaReport } from "../api/lensCommands";
import { spawnSidecar, spawnSidecarStreaming, useSidecarStream } from "../api/sidecarStream";
import { listMonitors, openPatternPlayer, closePatternPlayer } from "../api/player";

(function () {
  const { Button, Badge, InlineAlert } = window.Spectrum2DesignSystem_b6d1b3;
  const { useState, useEffect } = React;
  const h = React.createElement;
  const CX = window.VOLO_CAL2;

  const head = (icon, tone, title, pill, close) => h('div', { className: 'drawer-h' },
    h('span', { className: 'di ' + (tone || 'info') }, h(Icon, { name: icon, size: 17 })),
    h('div', { style: { minWidth: 0 } }, h('h2', null, title),
      h('div', { className: 'sub' }, h('span', { className: 'cli-pill' }, pill))),
    h('button', { className: 'iconbtn x', onClick: close }, h(Icon, { name: 'x', size: 16 })));

  const openFolder = (s, dir) => revealPath(dir).catch((e) => s.pushLog({ lv: 'err', cat: 'lens', msg: `打开文件夹失败 · ${e && e.message ? e.message : e}` }));
  const KV = (k, v, mono, tone) => h('div', { className: 'kv', key: k }, h('span', { className: 'k' }, k),
    h('span', { className: 'v' + (mono ? ' mono' : '') + (tone ? ' s-' + tone : '') }, v));

  /* ============ 求解结果报告 · 主体（对话框 ② + ① 完成态共用） ============ */
  function ReportBody({ s }) {
    const live = CX.useLensLive();
    const R = live.solveResult;
    const [mOpen, setMOpen] = useState(false);
    const [qa, setQa] = useState(null);
    const [qaErr, setQaErr] = useState(null);
    const [overlayTask, setOverlayTask] = useState(null);
    const [overlayUrls, setOverlayUrls] = useState([]);
    const overlay = useSidecarStream(overlayTask);
    useEffect(() => {
      if (!R || !R.output_dir) return undefined;
      let alive = true;
      readLensQaReport(R.output_dir).then((v) => { if (alive) setQa(v); }).catch((e) => { if (alive) setQaErr(e && e.message ? e.message : String(e)); });
      return () => { alive = false; };
    }, [R && R.output_dir]);
    useEffect(() => {
      if (!overlay.state.exit || overlay.state.exit.fatal) return;
      const env = [...overlay.state.lines].reverse().map((l) => l.parsed).find((v) => v && v.status === 'ok');
      const paths = (env && env.data && env.data.annotated_images) || [];
      Promise.all(paths.map((p) => readImageAsDataUrl(p).catch(() => null))).then((urls) => setOverlayUrls(urls.filter(Boolean)));
      setOverlayTask(null);
    }, [overlay.state.exit]);
    if (!R) return h('div', { className: 'drawer-b' }, h('div', { style: { fontSize: 12.5, color: 'var(--chrome-faint)' } }, '尚无求解结果'));
    const q = R.quality;
    const runOverlay = async () => {
      const out = await pickDirectory().catch(() => null); if (!out) return;
      const resp = await spawnSidecarStreaming('vpcal', ['verify', 'overlay', '--config', R.session_path, '--result', R.result_path, '--out', out, '--limit', '8', '--output', 'json']);
      setOverlayUrls([]); setOverlayTask(resp.task_id);
    };
    return h('div', { className: 'drawer-b lens-report' },
      /* tracker_to_stage */
      h('div', { className: 'lens-rsec' },
        h('div', { className: 'lens-rsec-h' }, h(Icon, { name: 'cube', size: 14 }), 'tracker_to_stage', h('span', { className: 'lens-rsec-tag' }, '刚体 6-DOF · 无 scale')),
        h('div', { className: 'lens-rgrid' },
          h('div', { className: 'lens-rcol' }, h('div', { className: 'lens-rcol-h' }, 'translation (mm)'),
            KV('x', R.translation[0].toFixed(4), true), KV('y', R.translation[1].toFixed(4), true), KV('z', R.translation[2].toFixed(4), true)),
          h('div', { className: 'lens-rcol' }, h('div', { className: 'lens-rcol-h' }, 'rotation quaternion (w,x,y,z)'),
            KV('w', R.rotation[0].toFixed(5), true), KV('x', R.rotation[1].toFixed(5), true), KV('y', R.rotation[2].toFixed(5), true), KV('z', R.rotation[3].toFixed(5), true))),
        h('div', { className: 'lens-rcol', style: { marginTop: 10 } }, h('div', { className: 'lens-rcol-h' }, 'euler 分解 XYZ (deg)'),
          h('div', { className: 'lens-euler' }, R.euler_deg.map((v, i) => h('span', { key: i, className: 'lens-euler-c' }, h('span', { className: 'ax' }, ['rx', 'ry', 'rz'][i]), h('span', { className: 'mono' }, v.toFixed(2)))))),
        h('button', { className: 'lens-fold', onClick: () => setMOpen((v) => !v) },
          h(Icon, { name: 'chevr', size: 12, style: { transform: mOpen ? 'rotate(90deg)' : 'none' } }), 'matrix_4x4'),
        mOpen ? h('div', { className: 'lmatrix', style: { marginTop: 10 } }, R.matrix_4x4.flat().map((v, i) => h('div', { key: i, className: 'lmcell' }, v.toFixed(4)))) : null),
      /* quality */
      h('div', { className: 'lens-rsec' },
        h('div', { className: 'lens-rsec-h' }, h(Icon, { name: 'pulse', size: 14 }), 'quality'),
        h('div', { className: 'lens-qgrid' },
          KV('reprojection_rms_px', q.reprojection_rms_px.toFixed(2), true, 'positive'),
          h('div', { className: 'kv lens-kv-hi' }, h('span', { className: 'k' }, 'validation_rms_px'), h('span', { className: 'v' }, CX.rmsBadge(q.validation_rms_px, 'px'), h('span', { className: 'lens-kv-tag' }, '主指标'))),
          KV('total_observations', q.total_observations.toLocaleString(), true),
          KV('inlier_observations', q.inlier_observations.toLocaleString(), true),
          KV('outlier_ratio', (q.outlier_ratio * 100).toFixed(1) + '%', true),
          KV('num_poses', String(q.num_poses), true),
          h('div', { className: 'kv' }, h('span', { className: 'k' }, 'confidence'), h('span', { className: 'v' }, CX.confBadge(q.confidence))),
          KV('validation_observations', q.validation_observations.toLocaleString(), true))),
      /* solver + output */
      h('div', { className: 'lens-rsec' },
        h('div', { className: 'lens-rsec-h' }, h(Icon, { name: 'settings', size: 14 }), 'solver'),
        R.degraded_backend ? h('div', { className: 'ar-degen ar-degen--notice' }, h(Icon, { name: 'alert', size: 14 }), h('div', null, h('b', null, '求解器使用了 fallback / degraded path'))) : null,
        R.parameter_covariance ? h('div', { className: 'kv' }, h('span', { className: 'k' }, 'parameter_covariance'),
          h('span', { className: 'v mono' }, R.parameter_covariance.available ? 'available' : 'unavailable')) : null,
        h('div', { className: 'kv' }, h('span', { className: 'k' }, 'solver_backend'),
          h('span', { className: 'v' }, R.solver_backend ? h('span', { className: 'mono' }, R.solver_backend) : h(Badge, { variant: 'neutral', size: 'S' }, 'n/a'))),
        h('div', { className: 'lens-outrow' },
          h('div', { style: { minWidth: 0 } }, h('div', { className: 'k', style: { fontSize: 11, color: 'var(--chrome-faint)', fontWeight: 700 } }, 'output_dir'),
            h('div', { className: 'mono', style: { fontSize: 12, color: 'var(--chrome-dim)', wordBreak: 'break-all' } }, R.output_dir)),
          h('button', { className: 'cal2-folderbtn', onClick: () => openFolder(s, R.output_dir) }, h(Icon, { name: 'external', size: 13 }), '打开文件夹'))),
      q.lens_estimate ? h('div', { className: 'lens-rsec' },
        h('div', { className: 'lens-rsec-h' }, h(Icon, { name: 'bolt', size: 14 }), 'QLE · session-coupled'),
        h('div', { className: 'lens-nanote' }, h(Icon, { name: 'alert', size: 13 }), '不是 master lens，不可跨 session / stage 复用。'),
        KV('confidence', q.lens_estimate.confidence, true),
        KV('RMS', q.lens_estimate.spatial_only_rms_px.toFixed(3) + ' → ' + q.lens_estimate.refined_rms_px.toFixed(3) + ' px', true),
        ['focal_length_mm', 'distortion_k1', 'distortion_k2'].map((k) => q.lens_estimate[k] ? KV(k, q.lens_estimate[k].observable ? String(q.lens_estimate[k].value) : 'reverted · ' + (q.lens_estimate[k].locked_reason || 'gate'), true) : null),
        (q.lens_estimate.identifiability_flags || []).map((f, i) => h('div', { key: i, className: 'lens-warn' }, h(Icon, { name: 'alert', size: 12 }), h('span', null, f)))) : null,
      h('div', { className: 'lens-rsec' },
        h('div', { className: 'lens-rsec-h' }, h(Icon, { name: 'pulse', size: 14 }), 'reprojection QA'),
        qaErr ? h('div', { className: 'lens-nanote' }, '读取 qa/reprojection.json 失败 · ' + qaErr) : null,
        qa ? h(React.Fragment, null,
          qa.lens_residual_check && qa.lens_residual_check.radial_pattern_detected ? h('div', { className: 'ar-degen ar-degen--notice' }, h(Icon, { name: 'alert', size: 14 }), h('div', null, h('b', null, '畸变参数可疑'), h('div', { className: 'ar-degen-d' }, qa.lens_residual_check.description))) : null,
          h('div', { style: { display: 'grid', gap: 5 } }, (qa.per_pose || []).map((p) => h('div', { key: p.frame_id, style: { display: 'grid', gridTemplateColumns: '70px 1fr 58px', gap: 8, alignItems: 'center', fontSize: 11.5 } },
            h('span', { className: 'mono' }, 'pose ' + p.frame_id), h('span', { className: 'vmeter vmeter--' + CX.rmsTone(p.rms_px, 'px') }, h('span', { className: 'vmeter__fill', style: { width: Math.min(100, p.rms_px / Math.max(qa.global_max_px || 1, 1) * 100) + '%' } })), h('span', { className: 'mono' }, p.rms_px.toFixed(2) + ' px')))),
          h('div', { className: 'lens-mon-table', style: { marginTop: 10 } },
            h('div', { className: 'lens-mon-head', style: { gridTemplateColumns: '70px 1fr 80px' } }, h('span', null, 'frame'), h('span', null, 'marker'), h('span', null, 'error')),
            (qa.outliers_top10 || []).map((o, i) => h('div', { key: i, className: 'lens-mon-row', style: { gridTemplateColumns: '70px 1fr 80px' } }, h('span', { className: 'mono' }, o.frame_id), h('span', { className: 'mono dim' }, JSON.stringify(o.marker_id)), h('span', { className: 'mono' }, o.error_px.toFixed(2) + ' px'))))
        ) : h('div', { className: 'dim' }, '正在读取 QA…'),
        h(Button, { variant: 'secondary', size: 'S', icon: h(Icon, { name: 'eye', size: 13 }), isDisabled: !!overlayTask, onPress: runOverlay }, overlayTask ? '生成验证叠加中…' : '验证叠加'),
        overlayUrls.length ? h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 8, marginTop: 10 } }, overlayUrls.map((u, i) => h('img', { key: i, src: u, alt: '验证叠加帧 ' + (i + 1), style: { width: '100%', background: '#0e0f13' } }))) : null),
      /* hand-eye + coverage —— CalibrationResult schema 里不存在这两块字段
         （sidecars/vpcal/src/vpcal/models/calibration.py 核实），quick run 恒不输出。 */
      h('div', { className: 'lens-rsec' },
        h('div', { className: 'lens-rsec-h' }, h(Icon, { name: 'info', size: 14 }), 'hand-eye / coverage'),
        h('div', { className: 'lens-nanote' }, h(Icon, { name: 'info', size: 13 }), 'quick run 不输出 hand-eye 标定与覆盖度分析，如需请走 tracker-free 独立求解路径。'),
        h('div', { className: 'kv' }, h('span', { className: 'k' }, 'handeye.closed_form'), h('span', { className: 'v' }, h(Badge, { variant: 'neutral', size: 'S' }, 'n/a'))),
        h('div', { className: 'kv' }, h('span', { className: 'k' }, 'coverage.percentage'), h('span', { className: 'v' }, h(Badge, { variant: 'neutral', size: 'S' }, 'n/a')))));
  }

  /* ============ ① 从已有 session 求解 ============ */
  function SolveFromSession({ s, close }) {
    const proj = CX.useProj();
    const live = CX.useLensLive();
    const profiles = CX.loadProfiles ? CX.loadProfiles() : [];
    const activeProfile = profiles.find((p) => p.id === live.profileId) || null;
    const [root, setRoot] = useState(() => (activeProfile && activeProfile.outputRoot) || CX.loadSessRoot(proj.path));
    const [sessions, setSessions] = useState([]);
    const [scanErr, setScanErr] = useState(null);
    const [sel, setSel] = useState(null);
    const [manualPath, setManualPath] = useState(null); /* 「浏览文件…」直选的单个 session.json，绕过扫描 */
    const [phase, setPhase] = useState('pick'); /* pick | solving | report | error */
    const [err, setErr] = useState(null);
    const [estimateLens, setEstimateLens] = useState(!!live.estimateLens);
    const solve = CX.useLensSolve();

    const scan = (r) => {
      if (!r) { setSessions([]); return; }
      listLensSessions(r).then((list) => { setSessions(list); setScanErr(null); if (list.length && !sel) setSel(list[0].id); })
        .catch((e) => { setSessions([]); setScanErr(e && e.message ? e.message : String(e)); });
    };
    useEffect(() => { scan(root); }, [root]); // eslint-disable-line react-hooks/exhaustive-deps

    const changeRoot = async () => {
      try { const d = await pickDirectory(); if (d) { setRoot(d); CX.saveSessRoot(proj.path, d); } }
      catch (e) { s.pushLog({ lv: 'err', cat: 'lens', msg: `选择扫描目录失败 · ${e && e.message ? e.message : e}` }); }
    };
    const browseFile = async () => {
      try { const p = await pickFile('vpcal session 配置 (session.json)', ['json']); if (p) { setManualPath(p); setSel(null); } }
      catch (e) { s.pushLog({ lv: 'err', cat: 'lens', msg: `选择 session.json 失败 · ${e && e.message ? e.message : e}` }); }
    };
    const cur = manualPath ? { id: '__manual__', session_json_path: manualPath, session_dir: manualPath.replace(/[\\/][^\\/]*$/, '') }
      : sessions.find((x) => x.id === sel);

    /* SessionConfig.lens 必填（models/session.py:243）——扫描到的 session 明确 lens_ready===false
       时求解必然 validation fail，禁用而不是让用户点了才看到必然失败的报错。手选文件（manualPath）
       没有扫描出的 lens_ready 信息，无法预判，不在此拦截。 */
    const noLens = cur && cur.lens_ready === false;
    const start = () => {
      if (!cur || noLens) return;
      setPhase('solving'); setErr(null);
      s.pushLog({ lv: 'info', cat: 'lens', msg: '从 session 求解 · <b>' + CX.baseName(cur.session_json_path) + '</b>' });
      CX.lensStore.patch({ estimateLens });
      solve.run(cur.session_json_path, estimateLens);
    };
    useEffect(() => {
      if (phase !== 'solving' || !solve.outcome) return;
      const { env, exit } = solve.outcome;
      if (env && env.status === 'ok') {
        const rp = CX.deriveResultPath(cur.session_dir);
        const result = CX.buildSolveResult(env, cur.session_json_path, rp);
        CX.lensStore.patch({ phase: 'solved', solveResult: result, solveError: null });
        s.pushLog({ lv: 'ok', cat: 'lens', msg: 'lens solve 收敛 · validation_rms <b>' + (result.quality.validation_rms_px != null ? result.quality.validation_rms_px.toFixed(2) : 'n/a') + ' px</b>' });
        setPhase('report');
      } else {
        const e = CX.classifySolveFailure(env, exit);
        setErr(e); setPhase('error');
        s.pushLog({ lv: 'err', cat: 'lens', msg: 'lens solve 失败 · ' + e.title + ' · exit ' + e.exitCode });
      }
    }, [phase, solve.outcome]); // eslint-disable-line react-hooks/exhaustive-deps

    if (phase === 'report') {
      return h('div', { className: 'drawer drawer--lens' }, head('doc', 'ok', '求解完成 · 结果报告', 'lens solve · ' + CX.baseName(cur.session_json_path), close),
        h(ReportBody, { s }),
        h('div', { className: 'drawer-f' },
          h(Button, { variant: 'secondary', size: 'M', onPress: close }, '关闭'),
          h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'download', size: 15 }), onPress: () => { close(); CX.openExport(s); } }, '导出 OpenTrackIO')));
    }

    return h('div', { className: 'drawer drawer--lens' }, head('doc', 'info', '从已有 session 求解', 'lens solve --config', close),
      h('div', { className: 'drawer-b' },
        h('div', { className: 'lens-subh' }, '扫描目录', root ? h('span', { className: 'mono dim' }, ' · ' + root) : null),
        scanErr ? h('div', { style: { marginBottom: 10 } }, h(InlineAlert, { variant: 'notice', title: '扫描失败' }, scanErr)) : null,
        !root ? h('div', { style: { fontSize: 12, color: 'var(--chrome-faint)', marginBottom: 10 } }, '尚未设置扫描目录（默认取当前采集配置的输出根目录）') : null,
        sessions.length ? h('div', { className: 'lens-sess-list' }, sessions.map((x) => h('button', {
          key: x.id, className: 'lens-sess' + (x.id === sel && !manualPath ? ' on' : ''), disabled: phase === 'solving', onClick: () => { setSel(x.id); setManualPath(null); } },
          h('span', { className: 'lens-sess-rd' }, x.id === sel && !manualPath ? h('span', { className: 'dot' }) : null),
          h('div', { className: 'lens-sess-meta' }, h('div', { className: 'lens-sess-n mono' }, x.id),
            h('div', { className: 'lens-sess-s' }, (x.modified_at || '—') + ' · ' + (x.poses_captured == null ? 'n/a' : x.poses_captured + ' pose')),
            !x.lens_ready ? h('span', { className: 'spill spill--notice' }, h(Icon, { name: 'alert', size: 11 }), '无 lens profile') : null)))) : null,
        manualPath ? h('div', { className: 'lens-sess on', style: { marginTop: sessions.length ? 8 : 0 } },
          h('span', { className: 'lens-sess-rd' }, h('span', { className: 'dot' })),
          h('div', { className: 'lens-sess-meta' }, h('div', { className: 'lens-sess-n mono' }, CX.baseName(manualPath)), h('div', { className: 'lens-sess-s' }, manualPath))) : null,
        h('div', { style: { display: 'flex', gap: 8, marginTop: 10 } },
          h('button', { className: 'lens-browse', disabled: phase === 'solving', onClick: changeRoot }, h(Icon, { name: 'folder', size: 14 }), '更换扫描目录…'),
          h('button', { className: 'lens-browse', disabled: phase === 'solving', onClick: browseFile }, h(Icon, { name: 'doc', size: 14 }), '浏览 session.json 文件…')),
        phase === 'solving' ? h('div', { className: 'lens-inline-solve' },
          h('div', { className: 'lens-indet' }, h('div', { className: 'lens-indet-bar' })),
          h('div', { className: 'lens-ov-note' }, '正在求解 ' + (cur ? CX.baseName(cur.session_json_path) : '') + ' …')) : null,
        phase === 'error' && err ? h('div', { style: { marginTop: 14 } },
          h(InlineAlert, { variant: err.tone === 'negative' ? 'negative' : 'notice', title: err.title + ' · exit ' + err.exitCode }, err.msg)) : null,
        noLens && phase === 'pick' ? h('div', { style: { marginTop: 10, fontSize: 12, color: 'var(--notice-visual)' } }, '该 session 缺 lens profile，需先补上才能求解。') : null,
        phase === 'pick' ? h('label', { className: 'cap-toggle-row', style: { marginTop: 12 } },
          h('input', { type: 'checkbox', checked: estimateLens, onChange: (e) => setEstimateLens(e.target.checked) }),
          h('div', null, h('div', { className: 'cap-tg-t' }, '联合估计镜头（QLE）'), h('div', { className: 'cap-tg-s' }, '--estimate-lens · session-coupled，非 master lens'))) : null),
      h('div', { className: 'drawer-f' },
        h(Button, { variant: 'secondary', size: 'M', onPress: close }, phase === 'error' ? '关闭' : '取消'),
        phase !== 'error' ? h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: phase === 'solving' ? 'sync' : 'target', size: 15 }), isDisabled: !cur || noLens || phase === 'solving', onPress: start }, phase === 'solving' ? '求解中…' : '开始求解')
          : h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'sync', size: 15 }), onPress: () => { setErr(null); setPhase('pick'); } }, '重新选择')));
  }

  /* ============ ③ 导出 OpenTrackIO ============ */
  function ExportDialog({ s, close }) {
    const live = CX.useLensLive();
    const R = live.solveResult;
    const [busy, setBusy] = useState(false);
    const [done, setDone] = useState(null); /* {samples, applied_delay_ms, output} */
    const [error, setError] = useState(null);
    const [delayProfile, setDelayProfile] = useState(null);
    if (!R) return h('div', { className: 'drawer drawer--lens' }, head('download', 'info', '导出 OpenTrackIO', 'export opentrackio', close),
      h('div', { className: 'drawer-b' }, h('div', { style: { fontSize: 12.5, color: 'var(--chrome-faint)' } }, '尚无可导出的求解结果')),
      h('div', { className: 'drawer-f' }, h(Button, { variant: 'secondary', size: 'M', onPress: close }, '关闭')));
    const outPath = CX.joinPath(R.output_dir, 'opentrackio_lens.json');
    const run = async () => {
      setBusy(true); setError(null);
      try {
        const args = ['export', 'opentrackio', '--result', R.result_path, '--session', R.session_path, '--out', outPath, '--frame', 'ue'];
        if (delayProfile) args.push('--delay-profile', delayProfile);
        args.push('--output', 'json');
        const out = await spawnSidecar('vpcal', args);
        if (out.exit_code !== 0) throw new Error(out.stderr || ('exit ' + out.exit_code));
        let env = null;
        try { env = JSON.parse(out.stdout.trim()); } catch (e) { /* 非 JSON 输出兜底显示原文 */ }
        const data = (env && env.data) || {};
        setDone({ samples: data.samples ?? null, applied_delay_ms: data.applied_delay_ms ?? null, output: data.output || outPath });
        s.pushLog({ lv: 'ok', cat: 'lens', msg: '导出 OpenTrackIO · <b>' + CX.baseName(outPath) + '</b> · frame ue' });
      } catch (e) {
        setError(e && e.message ? e.message : String(e));
        s.pushLog({ lv: 'err', cat: 'lens', msg: `导出 OpenTrackIO 失败 · ${e && e.message ? e.message : e}` });
      } finally { setBusy(false); }
    };
    return h('div', { className: 'drawer drawer--lens' }, head('download', 'info', '导出 OpenTrackIO', 'export opentrackio --frame ue', close),
      h('div', { className: 'drawer-b' },
        h('div', { className: 'lens-exp-field' }, h('span', { className: 'lens-exp-k' }, '输出路径'),
          h('div', { className: 'lens-exp-path mono' }, outPath)),
        h('div', { className: 'lens-exp-field' }, h('span', { className: 'lens-exp-k' }, '坐标系'),
          h('div', { className: 'lens-exp-ro' }, h('span', { className: 'mono' }, '--frame ue'), h(Badge, { variant: 'neutral', size: 'S' }, '固定 · 只读'))),
        h('div', { className: 'lens-exp-field' }, h('span', { className: 'lens-exp-k' }, '延迟档案'),
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
            h('span', { className: 'lens-exp-path mono', style: { flex: 1 } }, delayProfile ? CX.baseName(delayProfile) : '不应用（导出原始时间戳）'),
            h('button', { className: 'lens-browse', onClick: async () => { const p = await pickFile('delay profile JSON（capture delay-cal 输出）', ['json']).catch(() => null); if (p) setDelayProfile(p); } }, h(Icon, { name: 'folder', size: 13 }), '选择…'),
            delayProfile ? h('button', { className: 'vs-manual-x', onClick: () => setDelayProfile(null), title: '不应用延迟' }, h(Icon, { name: 'x', size: 13 })) : null),
          h('div', { className: 'lens-nanote', style: { marginBottom: 0 } }, h(Icon, { name: 'info', size: 13 }), delayProfile ? '将传入 --delay-profile；vpcal 重定时并在 tracker.notes 标记。' : '不传延迟参数；由下游系统另行补偿。')),
        error ? h('div', { style: { marginTop: 10 } }, h(InlineAlert, { variant: 'negative', title: '导出失败' }, error)) : null,
        done ? h('div', { className: 'lens-exp-result' },
          h('div', { className: 'lens-exp-rh' }, h(Icon, { name: 'check', size: 14 }), '导出成功'),
          KV('samples', done.samples == null ? 'n/a' : String(done.samples), true),
          KV('applied_delay_ms', done.applied_delay_ms == null ? 'not applied' : done.applied_delay_ms.toFixed(1), true),
          h('div', { className: 'lens-outrow', style: { marginTop: 4 } },
            h('div', { style: { minWidth: 0 } }, h('div', { className: 'mono', style: { fontSize: 12, color: 'var(--chrome-dim)', wordBreak: 'break-all' } }, done.output)),
            h('button', { className: 'cal2-folderbtn', onClick: () => openFolder(s, R.output_dir) }, h(Icon, { name: 'external', size: 13 }), '打开文件夹'))) : null),
      h('div', { className: 'drawer-f' },
        h(Button, { variant: 'secondary', size: 'M', onPress: close }, done ? '关闭' : '取消'),
        h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: done ? 'check' : 'download', size: 15 }), isDisabled: busy || !!done, onPress: run }, busy ? '导出中…' : done ? '已导出' : '导出')));
  }

  /* ============ W1 · 实时回填验证 ============ */
  function LiveVerify({ s, close }) {
    const live = CX.useLensLive();
    const R = live.solveResult;
    const profiles = CX.loadProfiles ? CX.loadProfiles() : [];
    const profile = profiles.find((p) => p.id === live.profileId) || profiles[0] || null;
    const [taskId, setTaskId] = useState(null);
    const [starting, setStarting] = useState(false);
    const [launchError, setLaunchError] = useState(null);
    const stream = useSidecarStream(taskId);
    const events = stream.state.lines.map((l) => l.parsed).filter(Boolean);
    const preview = [...events].reverse().find((e) => e.type === 'preview_ready');
    const stats = [...events].reverse().find((e) => e.type === 'live_stats');
    const start = async () => {
      if (!R || !profile) return;
      setStarting(true); setLaunchError(null);
      const args = ['verify', 'live', '--config', R.session_path, '--result', R.result_path,
        '--backend', profile.videoBackend || 'uvc', '--device', String(profile.device || '0'),
        '--track-protocol', profile.trackProtocol || 'freed', '--track-host', profile.trackHost || '0.0.0.0',
        '--track-port', String(profile.trackPort || 6301), '--tolerance', '0.05', '--preview-port', '0', '--duration', '0'];
      if (profile.fmtMode === 'manual' && profile.width) args.push('--width', String(profile.width));
      if (profile.fmtMode === 'manual' && profile.height) args.push('--height', String(profile.height));
      if (profile.fmtMode === 'manual' && profile.fps) args.push('--fps', String(profile.fps));
      args.push('--transfer-function', profile.transferFunction || 'sdr', '--output', 'ndjson');
      try {
        const r = await spawnSidecarStreaming('vpcal', args); setTaskId(r.task_id);
        s.pushLog({ lv: 'info', cat: 'lens', msg: '启动实时回填验证 · <b>vpcal verify live</b>' });
      } catch (e) {
        const message = e && e.message ? e.message : String(e);
        setLaunchError(message);
        s.pushLog({ lv: 'err', cat: 'lens', msg: '实时回填验证启动失败 · ' + message });
      } finally { setStarting(false); }
    };
    const stop = async () => { await stream.cancel(); setTaskId(null); };
    useEffect(() => () => { if (taskId) void stream.cancel(); }, [taskId]);
    return h('div', { className: 'drawer drawer--lens' }, head('live', 'info', '实时回填验证', 'vpcal verify live', close),
      h('div', { className: 'drawer-b' },
        !profile ? h(InlineAlert, { variant: 'notice', title: '缺少采集配置' }, '先选择一个 Capture Profile，实时验证会复用其 video / tracking source。') : null,
        launchError ? h(InlineAlert, { variant: 'negative', title: '实时验证启动失败' }, launchError) : null,
        preview && preview.mjpeg_url ? h('img', { src: preview.mjpeg_url, alt: '实时重投影验证', style: { width: '100%', minHeight: 260, objectFit: 'contain', background: '#08090c' } })
          : h('div', { className: 'cal2-cap-empty', style: { minHeight: 240 } }, h('div', { className: 'ce-t' }, taskId ? '等待首个标注帧…' : '尚未开始'), h('div', { className: 'ce-d' }, '绿十字为检测点，红圈为当前标定的实时重投影。')),
        stats ? h('div', { className: 'gw-stat4', style: { marginTop: 10 } },
          [['frames', stats.frames], ['paired', stats.paired], ['observations', stats.observations], ['RMS', stats.rms_px == null ? 'n/a' : Number(stats.rms_px).toFixed(2) + ' px']].map(([k, v]) => h('div', { key: k, className: 'gw-statcell' }, h('div', { className: 'n' }, v), h('div', { className: 'l' }, k))),
          h('div', { className: 'lens-nanote', style: { gridColumn: '1/-1' } }, h(Icon, { name: stats.tracking_connected ? 'check' : 'alert', size: 13 }), stats.tracking_connected ? 'tracking 已连接' : 'tracking 未连接')) : null,
        stream.state.exit && stream.state.exit.fatal ? h(InlineAlert, { variant: 'negative', title: '实时验证失败' }, stream.state.exit.stderr_tail || ('exit ' + stream.state.exit.exit_code)) : null),
      h('div', { className: 'drawer-f' },
        h(Button, { variant: 'secondary', size: 'M', onPress: close }, '关闭'),
        taskId ? h(Button, { variant: 'negative', size: 'M', onPress: stop }, '停止验证')
          : h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'live', size: 15 }), isDisabled: !R || !profile || starting, onPress: start }, starting ? '正在启动…' : '开始实时验证')));
  }

  /* ============ ④ 播放器自检 ============ */
  function PlayerCheck({ s, close }) {
    const [monitors, setMonitors] = useState([]);
    const [loadErr, setLoadErr] = useState(null);
    const [openOn, setOpenOn] = useState(null);
    const [winInfo, setWinInfo] = useState(null);
    const [running, setRunning] = useState(false);
    useEffect(() => {
      listMonitors().then(setMonitors).catch((e) => setLoadErr(e && e.message ? e.message : String(e)));
      /* deps=[]，这个 cleanup 只会在 unmount 时跑一次——`running` 在闭包里恒等于挂载时的初始值
         false，永远不是最新值，必须无条件调用（close_pattern_player 本身是幂等的，没开着也
         安全）。否则用户开了播放器直接点 X/「完成」关弹窗，borderless player window 会残留。 */
      return () => { closePatternPlayer().catch(() => {}); };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps
    const openPlayer = async (m) => {
      try {
        const info = await openPatternPlayer(m.index);
        setOpenOn(m.index); setWinInfo(info); setRunning(true);
        s.pushLog({ lv: 'info', cat: 'lens', msg: '在显示器 <b>' + (m.name || m.index) + '</b>（#' + m.index + '）打开图案播放器' });
      } catch (e) { s.pushLog({ lv: 'err', cat: 'lens', msg: `打开播放器失败 · ${e && e.message ? e.message : e}` }); }
    };
    const closePlayer = async () => {
      try { await closePatternPlayer(); } catch (e) {}
      setRunning(false); setOpenOn(null); setWinInfo(null);
      s.pushLog({ lv: 'info', cat: 'lens', msg: '关闭图案播放器' });
    };
    const mon = monitors.find((m) => m.index === openOn);
    const mismatch = winInfo && mon ? (winInfo.width !== mon.width || winInfo.height !== mon.height) : false;
    return h('div', { className: 'drawer drawer--lens' }, head('panel', 'info', '播放器自检', 'player self-check', close),
      h('div', { className: 'drawer-b' },
        loadErr ? h(InlineAlert, { variant: 'negative', title: '枚举显示器失败' }, loadErr) : null,
        h('div', { className: 'lens-subh' }, '显示器'),
        h('div', { className: 'lens-mon-table' },
          h('div', { className: 'lens-mon-head' }, h('span', null, '#'), h('span', null, 'name'), h('span', null, 'width×height'), h('span', null, 'scale'), h('span', null, '')),
          monitors.map((m) => h('div', { key: m.index, className: 'lens-mon-row' + (m.index === openOn ? ' on' : '') },
            h('span', { className: 'mono' }, m.index),
            h('span', null, m.name || '未命名', m.is_primary ? h('span', { className: 'lens-mon-primary' }, '主屏') : null),
            h('span', { className: 'mono dim' }, m.width + '×' + m.height),
            h('span', { className: 'mono dim' }, m.scale_factor.toFixed(2) + '×'),
            h('span', { style: { textAlign: 'right' } }, h('button', { className: 'lens-mon-open', disabled: m.index === openOn && running, onClick: () => openPlayer(m) },
              m.index === openOn && running ? '播放中' : '在此打开'))))),
        running && mon && winInfo ? h('div', { className: 'lens-pc-result' },
          h('div', { className: 'lens-subh', style: { marginTop: 2 } }, '输出窗口分辨率校验'),
          h('div', { className: 'lens-pc-cmp' },
            h('div', { className: 'lens-pc-c' }, h('span', { className: 'k' }, 'monitor #' + mon.index), h('span', { className: 'v mono' }, mon.width + '×' + mon.height)),
            h(Icon, { name: mismatch ? 'x' : 'check', size: 15, style: { color: mismatch ? 'var(--negative-visual)' : 'var(--positive-visual)' } }),
            h('div', { className: 'lens-pc-c' }, h('span', { className: 'k' }, 'player window'), h('span', { className: 'v mono' }, winInfo.width + '×' + winInfo.height))),
          mismatch
            ? h('div', { className: 'spill spill--negative', style: { marginTop: 4 } }, h(Icon, { name: 'alert', size: 12 }), 'resolution_mismatch · 播放窗口未按显示器物理分辨率打开')
            : h('div', { className: 'spill spill--positive', style: { marginTop: 4 } }, h(Icon, { name: 'check', size: 12 }), 'resolution 匹配 · 播放窗口已按显示器物理分辨率打开'))
          : h('div', { className: 'lens-pc-hint' }, h(Icon, { name: 'info', size: 13 }), '在目标显示器打开播放器后，此处显示分辨率校验结果。')),
      h('div', { className: 'drawer-f between' },
        running ? h('span', { className: 'spill spill--informative' }, h(Icon, { name: 'play', size: 12 }), '播放器运行中 · ' + (mon ? (mon.name || ('#' + mon.index)) : '')) : h('span'),
        h('div', { style: { display: 'flex', gap: 10 } },
          running ? h(Button, { variant: 'negative', size: 'M', icon: h(Icon, { name: 'x', size: 15 }), onPress: closePlayer }, '关闭播放器') : null,
          h(Button, { variant: 'secondary', size: 'M', onPress: close }, '完成'))));
  }

  /* ---------- openers ---------- */
  const openSolveFromSession = (s) => s.setModal({ wide: true, render: ({ s: st, close }) => h(SolveFromSession, { s: st, close }) });
  const openReport = (s) => s.setModal({ wide: true, render: ({ s: st, close }) => h('div', { className: 'drawer drawer--lens' },
    head('doc', 'info', '求解结果报告', 'lens report', close), h(ReportBody, { s: st }),
    h('div', { className: 'drawer-f' },
      h(Button, { variant: 'secondary', size: 'M', onPress: close }, '关闭'),
      h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'download', size: 15 }), onPress: () => { close(); CX.openExport(st); } }, '导出 OpenTrackIO'))) });
  const openExport = (s) => s.setModal({ render: ({ s: st, close }) => h(ExportDialog, { s: st, close }) });
  const openLiveVerify = (s) => s.setModal({ wide: true, render: ({ s: st, close }) => h(LiveVerify, { s: st, close }) });
  const openPlayerCheck = (s) => s.setModal({ wide: true, render: ({ s: st, close }) => h(PlayerCheck, { s: st, close }) });

  window.VOLO_CAL2 = Object.assign(window.VOLO_CAL2 || {}, { openSolveFromSession, openReport, openExport, openLiveVerify, openPlayerCheck });
})();
