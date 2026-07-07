// @ts-nocheck
/* Volo — 校正 · 网格校正 · 测量导入（M1 全站仪 / M2 视觉）
   1:1 port of the Claude Design handoff `src/cal2_survey.jsx`：M1 计数 tile + 点表；
   M2 五步纵向流程 + BA 内联进度 + WIP 扩展位。

   真实数据接线沿用旧文件已验证过的逻辑，未重新发明：
   - M1：旧 pages/calibrate.tsx 的 doImportCsv/import_total_station_csv +
     load_measurements_yaml，以及「实测 vs fabricated」的既定启发式
     （FABRICATED_SIGMA_THRESHOLD_MM = 5.0，来自 crates/mesh-adapter-total-station
     的 report_builder.rs，非本页发明——后端没有逐点字段区分两者）。
   - M2：旧 pages/calLedExt.tsx 的 SurveyM2（真接 mesh_visual_generate_pattern /
     mesh_visual_reconstruct 流式重建，Tauri 事件 mesh-visual-progress /
     mesh-visual-reconstruct-done）。无后端时回退设计稿演示态，逻辑保持不变。 */
import * as React from "react";
import { pickFile } from "../api/commands";
import { isTauri } from "../api/invoke";
import { importTotalStationCsv, loadMeasurementsYaml } from "../api/meshCommands";
import { meshVisualGeneratePattern, meshVisualReconstruct } from "../api/meshVisualCommands";
import { listen } from "@tauri-apps/api/event";

(function () {
  const { Button, InlineAlert } = window.Spectrum2DesignSystem_b6d1b3;
  const { useState, useEffect, useRef } = React;
  const h = React.createElement;
  const CX = window.VOLO_CAL2;

  const ROLE = { origin: 'var(--positive-visual)', x_axis: 'var(--volo-600)', xy_plane: 'var(--informative-visual)' };

  /* =============== M1 · 全站仪 =============== */
  /* 后端没有逐点"实测 vs fabricated"字段（measured.yaml 的 source 恒为 total_station，
     两者只靠 sigma 大小区分——既定启发式，非本页发明）。 */
  const FABRICATED_SIGMA_THRESHOLD_MM = 5.0;
  function sigmaApproxMm(u) {
    if (!u) return null;
    if ('isotropic' in u) return u.isotropic;
    if ('covariance' in u) { const m = u.covariance; return Math.sqrt((m[0][0] + m[1][1] + m[2][2]) / 3); }
    return null;
  }
  async function doImportCsv(s, proj) {
    if (!proj.path) { s.pushLog({ lv: 'warn', cat: 'calibrate', msg: '导入失败 · 尚未打开项目' }); return; }
    let csvPath;
    try { csvPath = await pickFile('Total Station CSV', ['csv']); }
    catch (e) { s.pushLog({ lv: 'err', cat: 'calibrate', msg: `选择 CSV 失败 · ${e && e.message ? e.message : e}` }); return; }
    if (!csvPath) return;
    const screenId = s.calScreen;
    try {
      await s.runCmd({ domain: 'calibrate', action: '导入全站仪 CSV', target: screenId, chan: 'local' }, async () => {
        const report = await importTotalStationCsv(proj.path, csvPath, screenId);
        const absMeasured = proj.path.replace(/[\\/]+$/, '') + '/' + report.measurementsYamlPath;
        const measured = await loadMeasurementsYaml(absMeasured);
        CX.projStore.patch({ surveyReport: report, measured, measurementsAbsPath: absMeasured });
        return report;
      }, { okMsg: (r) => `导入完成 · 实测 ${r.measuredCount} · 制造 ${r.fabricatedCount} · 离群 ${r.outlierCount} · 缺失 ${r.missingCount}` });
    } catch (e) { /* runCmd 已记录失败 */ }
  }

  function M1({ s, proj }) {
    const rep = proj.surveyReport;
    const tiles = rep ? [
      ['实测', 'measuredCount', rep.measuredCount, 'positive'],
      ['制造', 'fabricatedCount', rep.fabricatedCount, 'neutral'],
      ['离群', 'outlierCount', rep.outlierCount, 'negative'],
      ['缺失', 'missingCount', rep.missingCount, 'notice'],
    ] : [];
    const coord = proj.config && proj.config.coordinate_system;
    const roleOf = (name) => !coord ? null : name === coord.origin_point ? 'origin' : name === coord.x_axis_point ? 'x_axis' : name === coord.xy_plane_point ? 'xy_plane' : null;
    const points = (proj.measured && proj.measured.points) || [];
    return h('div', { className: 'cal2-survey cal-scroll' },
      h('div', { className: 'cal2-imp-bar' },
        h('div', { className: 'cal2-imp-l' }, h(Icon, { name: 'download', size: 15 }),
          rep ? h(React.Fragment, null, h('span', null, '已导入 '), h('code', null, rep.measurementsYamlPath), h('span', { className: 'dim' }, ' · ' + points.length + ' 点')) : h('span', { className: 'dim' }, '尚未导入 CSV')),
        h(Button, { variant: 'accent', size: 'S', icon: h(Icon, { name: 'download', size: 14 }), onPress: () => doImportCsv(s, proj) }, '导入全站仪 CSV')),
      rep ? h('div', { className: 'cal2-tiles' }, tiles.map(([lab, key, n, tone]) => h('div', { className: 'cal2-tile', key },
        h('div', { className: 'cal2-tile-n s-' + tone }, n),
        h('div', { className: 'cal2-tile-l' }, h('span', { className: 'sdot bg-' + tone }), lab),
        h('div', { className: 'cal2-tile-k' }, key)))) : null,
      rep ? rep.warnings.map((w, i) => h('div', { key: i, style: { marginBottom: 8 } },
        h(InlineAlert, { variant: 'notice', title: '提示' }, w))) : null,
      h('div', { className: 'cal2-subh' }, '参考点 / 测量点' + (points.length ? '（' + points.length + '）' : '')),
      points.length ? h('div', { className: 'cal2-ptable' },
        h('div', { className: 'cal2-pt-head' }, h('span', null, 'name'), h('span', null, 'position [x, y, z] (m)'), h('span', null, '不确定度 σ (mm)'), h('span', null, '来源')),
        points.map((p) => {
          const isSel = s.calSel && s.calSel.type === 'point' && s.calSel.id === p.name;
          const role = roleOf(p.name);
          const sigma = sigmaApproxMm(p.uncertainty);
          const measuredReal = sigma == null || sigma < FABRICATED_SIGMA_THRESHOLD_MM;
          return h('div', { key: p.name, className: 'cal2-pt-row' + (isSel ? ' sel' : ''), onClick: () => s.setCalSel({ type: 'point', id: p.name }) },
            h('span', { className: 'cal2-pt-n' }, role ? h('span', { className: 'sdot', style: { background: ROLE[role] } }) : h('span', { className: 'sdot bg-neutral' }), h('span', { className: 'mono' }, p.name)),
            h('span', { className: 'mono dim' }, '[' + p.position.map((v) => v.toFixed(3)).join(', ') + ']'),
            h('span', { className: 'mono' }, sigma == null ? '—' : sigma.toFixed(1)),
            h('span', null, h('span', { className: 'cal2-src cal2-src--' + (measuredReal ? 'ts' : 'ba') }, measuredReal ? 'total_station' : '推测')));
        })) : h('div', { style: { fontSize: 12, color: 'var(--chrome-faint)' } }, '—'));
  }

  /* =============== M2 · 视觉（ChArUco + BA）五步纵向流程 =============== */
  function FlowStep({ n, title, cn, status, children }) {
    const done = status === 'done', active = status === 'active';
    return h('div', { className: 'cal2-flowstep' + (done ? ' done' : '') + (active ? ' active' : '') },
      h('div', { className: 'cal2-flow-rail' }, h('span', { className: 'cal2-flow-n' }, done ? h(Icon, { name: 'check', size: 13 }) : n)),
      h('div', { className: 'cal2-flow-body' },
        h('div', { className: 'cal2-flow-h' }, h('span', { className: 'cal2-flow-t' }, title), h('span', { className: 'cal2-flow-cn' }, cn)),
        children));
  }

  function M2({ s, proj }) {
    const [manifestPath, setManifestPath] = useState(null);
    const [intr, setIntr] = useState('auto');
    const [intrPath, setIntrPath] = useState(null);
    const [baState, setBaState] = useState('idle'); /* idle | running | done */
    const [baPct, setBaPct] = useState(0);
    const [baStage, setBaStage] = useState('');
    const [result, setResult] = useState(null); /* 真实 VisualReconstructResult */
    const [warns, setWarns] = useState([]);
    const [baErr, setBaErr] = useState(null);
    const timer = useRef(null);
    const jobRef = useRef(null);
    const unref = useRef([]);
    const hasBackend = isTauri() && proj && proj.path;

    const RC = result || M2_RECONSTRUCT;
    const isReal = !!result;
    const IN = M2_INTRINSICS;
    const intrOk = IN.rms_px <= IN.max_rms_px;

    useEffect(() => {
      if (!hasBackend) return undefined;
      let alive = true;
      const add = (fn) => { if (alive) unref.current.push(fn); else fn(); };
      listen('mesh-visual-progress', (e) => {
        const p = e.payload; if (!p || p.job_id !== jobRef.current) return;
        const ev = p.event || {};
        if (ev.event === 'progress') { setBaPct(Math.max(0, Math.min(100, ev.percent || 0))); setBaStage(ev.stage || ''); }
        else if (ev.event === 'warning') { setWarns((w) => w.concat([{ code: ev.code, message: ev.message, cabinet: ev.cabinet }])); }
      }).then(add);
      listen('mesh-visual-reconstruct-done', (e) => {
        const p = e.payload; if (!p || p.job_id !== jobRef.current) return;
        clearInterval(timer.current);
        if (p.result) {
          setResult(p.result); setBaState('done'); setBaPct(100); jobRef.current = null;
          if (p.result.warnings && p.result.warnings.length) setWarns((w) => w.concat(p.result.warnings));
          s.pushLog({ lv: 'ok', cat: 'survey', msg: `BA 重建完成 · ba_rms <b>${p.result.ba_rms_px.toFixed(2)} px</b> · ${p.result.cabinet_count} 箱体` });
        } else {
          setBaErr(p.error || '重建失败'); setBaState('idle'); jobRef.current = null;
          s.pushLog({ lv: 'err', cat: 'survey', msg: `BA 重建失败 · ${p.error || '未知错误'}` });
        }
      }).then(add);
      return () => { alive = false; unref.current.forEach((fn) => fn()); unref.current = []; };
    }, [hasBackend]);
    useEffect(() => () => clearInterval(timer.current), []);

    const pickManifest = async () => {
      try { const p = await pickFile('capture manifest (JSON/YAML)', ['json', 'yaml', 'yml']); if (p) { setManifestPath(p); s.pushLog({ lv: 'info', cat: 'survey', msg: `capture manifest · ${p.split(/[\\/]/).pop()}` }); } }
      catch (e) { s.pushLog({ lv: 'err', cat: 'survey', msg: `选择 manifest 失败 · ${e && e.message ? e.message : e}` }); }
    };
    const pickIntr = async () => {
      try { const p = await pickFile('相机内参 (YAML)', ['yaml', 'yml', 'json']); if (p) setIntrPath(p); }
      catch (e) { s.pushLog({ lv: 'err', cat: 'survey', msg: `选择内参失败 · ${e && e.message ? e.message : e}` }); }
    };
    const genPattern = async () => {
      if (!hasBackend) { s.pushLog({ lv: 'ok', cat: 'survey', msg: '生成 pattern（演示）· 全屏图 + 9 箱体 tile' }); return; }
      s.pushLog({ lv: 'info', cat: 'survey', msg: `生成 pattern · ${M2_PATTERN.method}` });
      try {
        const r = await meshVisualGeneratePattern(proj.path, s.calScreen, M2_PATTERN.method, 1, null);
        s.pushLog({ lv: 'ok', cat: 'survey', msg: `pattern 生成 · ${r.cabinet_count} 箱体 · ${r.total_markers} markers → ${r.output_dir}` });
      } catch (e) { s.pushLog({ lv: 'err', cat: 'survey', msg: `pattern 生成失败 · ${e && e.message ? e.message : e}` }); }
    };
    const runBa = async () => {
      setBaErr(null); setWarns([]); setResult(null); setBaStage('');
      if (!hasBackend) {
        setBaState('running'); setBaPct(4);
        s.pushLog({ lv: 'info', cat: 'survey', msg: 'BA 重建启动（演示）· ' + M2_RECONSTRUCT.ba_observations_total.toLocaleString() + ' 观测' });
        let p = 4; timer.current = setInterval(() => {
          p += 16; setBaPct(Math.min(100, p));
          if (p >= 100) { clearInterval(timer.current); setBaState('done'); s.pushLog({ lv: 'ok', cat: 'survey', msg: 'BA 重建完成（演示）· ba_rms <b>' + M2_RECONSTRUCT.ba_rms_px + ' px</b>' }); }
        }, 500);
        return;
      }
      if (!manifestPath) { await pickManifest(); return; }
      if (intr === 'chessboard' && !intrPath) { await pickIntr(); return; }
      setBaState('running'); setBaPct(0);
      s.pushLog({ lv: 'info', cat: 'survey', msg: `BA 重建 · mesh_visual_reconstruct · ${intr === 'auto' ? 'auto 自标定' : '外部内参'}` });
      try {
        const resp = await meshVisualReconstruct(proj.path, s.calScreen, manifestPath, intr === 'auto' ? null : intrPath, null);
        jobRef.current = resp.job_id;
      } catch (e) {
        setBaState('idle'); setBaErr(e && e.message ? e.message : String(e));
        s.pushLog({ lv: 'err', cat: 'survey', msg: `BA 重建启动失败 · ${e && e.message ? e.message : e}` });
      }
    };
    const cancelBa = () => { clearInterval(timer.current); jobRef.current = null; setBaState('idle'); setBaPct(0); s.pushLog({ lv: 'warn', cat: 'survey', msg: 'BA 重建已取消' }); };

    const Q = (k, v, u, vis) => h('div', { className: 'cal2-q' }, h('div', { className: 'cal2-q-k' }, k), h('div', { className: 'cal2-q-v s-' + (vis || '') }, v, u ? h('span', { className: 'cal2-q-u' }, u) : null));
    const allWarns = isReal ? warns : M2_RECONSTRUCT.warnings;

    return h('div', { className: 'cal2-survey cal-scroll' },
      h('div', { className: 'cal2-flow' },
        h(FlowStep, { n: 1, title: '生成 pattern', cn: 'ChArUco 全屏图', status: 'done' },
          h('div', { className: 'cal2-flow-fields' },
            h('div', { className: 'cal2-ff' }, h('span', { className: 'k' }, 'method'), h('span', { className: 'v' }, M2_PATTERN.method)),
            h('div', { className: 'cal2-ff' }, h('span', { className: 'k' }, 'screen_id'), h('span', { className: 'v' }, hasBackend ? (s.calScreen || '—') : M2_PATTERN.screen_id_code))),
          h('div', { className: 'cal2-m2tiles' },
            h('div', { className: 'cal2-m2full' }, h('div', { className: 'cal2-m2grid' }), h('span', null, '全屏图')),
            M2_PATTERN.tiles.slice(0, 6).map((t) => h('div', { key: t.cab, className: 'cal2-m2tile' + (t.ok ? '' : ' bad') }, h('div', { className: 'cal2-m2tp' }), h('span', null, t.cab.replace('cab_', '#'))))),
          h('div', { style: { marginTop: 10 } }, h(Button, { variant: 'secondary', size: 'S', icon: h(Icon, { name: 'sync', size: 14 }), onPress: genPattern }, '生成图案'))),
        h(FlowStep, { n: 2, title: '选择采集 manifest', cn: 'capture manifest', status: 'done' },
          hasBackend
            ? h('div', { className: 'cal2-manifest' },
                h('div', { className: 'cal2-mani-file' }, h(Icon, { name: 'folder', size: 14 }), manifestPath ? h('code', null, manifestPath.split(/[\\/]/).pop()) : h('span', { className: 'dim' }, '尚未选择'),
                  h(Button, { variant: 'secondary', size: 'S', icon: h(Icon, { name: 'folder', size: 14 }), onPress: pickManifest, style: { marginLeft: 'auto' } }, '选择 manifest')))
            : h('div', { className: 'cal2-manifest' },
                h('div', { className: 'cal2-mani-file' }, h(Icon, { name: 'doc', size: 14 }), h('code', null, 'manifest.json（演示）')),
                h('div', { className: 'cal2-mani-views' }, M2_MANIFEST.map((v) => h('span', { key: v.view, className: 'cal2-mani-v' }, h('span', { className: 'sdot bg-positive' }), h('span', { className: 'mono' }, v.view), ' · ' + v.imgs + ' 张'))))),
        h(FlowStep, { n: 3, title: '内参', cn: 'intrinsics', status: 'done' },
          h('div', { className: 'cap-seg', style: { marginBottom: 11 } },
            [['auto', '自标定 auto'], ['chessboard', '外部棋盘格 chessboard']].map(([k, l]) => h('button', { key: k, className: intr === k ? 'on' : '', onClick: () => setIntr(k) }, l))),
          hasBackend
            ? (intr === 'auto'
                ? h('div', { style: { fontSize: 12, color: 'var(--chrome-dim)' } }, 'BA 内联自标定（intrinsics_source = auto_self_calibrated）；无需外部内参文件')
                : h('div', { className: 'cal2-mani-file' }, h(Icon, { name: 'doc', size: 14 }), intrPath ? h('code', null, intrPath.split(/[\\/]/).pop()) : h('span', { className: 'dim' }, '尚未选择'),
                    h(Button, { variant: 'secondary', size: 'S', icon: h(Icon, { name: 'doc', size: 14 }), onPress: pickIntr, style: { marginLeft: 'auto' } }, '选择内参')))
            : h('div', { className: 'cal2-flow-fields' },
                h('div', { className: 'cal2-ff' }, h('span', { className: 'k' }, 'rms_px'), h('span', { className: 'v mono s-' + (intrOk ? 'positive' : 'negative') }, IN.rms_px.toFixed(2))),
                h('div', { className: 'cal2-ff' }, h('span', { className: 'k' }, 'max_rms_px 门'), h('span', { className: 'v mono' }, IN.max_rms_px.toFixed(2))),
                h('div', { className: 'cal2-ff' }, h('span', { className: 'k' }, '结果'), h('span', { className: 'v' }, intrOk ? h(CX.Pill, { tone: 'positive', icon: 'check' }, '通过') : h(CX.Pill, { tone: 'negative', icon: 'alert' }, '超限拒绝'))))),
        h(FlowStep, { n: 4, title: 'BA 重建', cn: 'bundle adjustment', status: baState === 'done' ? 'done' : baState === 'running' ? 'active' : 'ready' },
          baErr ? h('div', { style: { marginBottom: 10 } }, h(InlineAlert, { variant: 'negative', title: 'BA 重建失败' }, baErr)) : null,
          baState === 'idle'
            ? h('div', null, h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'cube', size: 15 }), onPress: runBa }, hasBackend && !manifestPath ? '选择 manifest 后开始' : '开始 BA 重建'))
            : h('div', { className: 'cal2-progbox' },
                h('div', { className: 'cal2-prog-top' },
                  h('span', { className: 'cal2-prog-stage' }, baState === 'done' ? '已完成' : (baStage || 'BA 重建中')),
                  h('span', { className: 'cal2-prog-pct mono' }, Math.round(baPct) + '%'),
                  baState === 'running' ? h('button', { className: 'cal2-prog-cancel', onClick: cancelBa }, h(Icon, { name: 'x', size: 12 }), '取消') : null),
                h('div', { className: 'vmeter vmeter--accent' }, h('div', { className: 'vmeter__fill', style: { width: baPct + '%' } })))),
        h(FlowStep, { n: 5, title: '结果摘要', cn: 'summary', status: baState === 'done' ? 'done' : 'ready' },
          baState !== 'done'
            ? h('div', { className: 'cal2-flow-wait' }, h(Icon, { name: 'info', size: 13 }), '完成 BA 重建后显示指标与 cabinet 表')
            : h(React.Fragment, null,
                h('div', { className: 'cal2-qbar' },
                  Q('ba_rms_px', RC.ba_rms_px.toFixed(2), 'px', 'positive'),
                  Q('ba_observations', RC.ba_observations_used.toLocaleString() + '/' + RC.ba_observations_total.toLocaleString(), '', ''),
                  Q('ba_rejected', RC.ba_rejected, '', 'notice'),
                  Q('procrustes_align_rms_m', (RC.procrustes_align_rms_m * 1000).toFixed(1), 'mm', 'positive'),
                  Q('intrinsics_source', RC.intrinsics_source, '', '')),
                allWarns.map((w, i) => h('div', { key: i, style: { marginBottom: 10 } },
                  h(InlineAlert, { variant: 'notice', title: w.code + (w.cabinet ? ' · ' + w.cabinet : '') }, w.message))),
                h('div', { className: 'cal2-cabtable' },
                  h('div', { className: 'cal2-cab-head' }, h('span', null, 'cabinet_id'), h('span', null, 'position_mm'), h('span', null, 'reproj_rms_px'), h('span', null, 'views'), h('span', null, 'quality')),
                  RC.cabinets.map((c) => { const qg = M2_QUALITY[c.quality] || M2_QUALITY.fair; return h('div', { key: c.cabinet_id, className: 'cal2-cab-row' + (c.quality === 'poor' ? ' bad' : '') },
                    h('span', { className: 'mono' }, c.cabinet_id),
                    h('span', { className: 'mono dim' }, '[' + c.position_mm.map((v) => Math.round(v)).join(', ') + ']'),
                    h('span', { className: 'mono' + (c.reprojection_rms_px >= 1 ? ' s-negative' : '') }, c.reprojection_rms_px.toFixed(2)),
                    h('span', { className: 'mono dim' }, c.observed_views),
                    h('span', null, h(CX.Pill, { tone: qg.tone, icon: qg.icon }, qg.label))); })))),
      ),
      h('div', { className: 'cal2-wip' },
        h('span', { className: 'cal2-wip-ic' }, h(Icon, { name: 'sliders', size: 15 })),
        h('div', { className: 'cal2-wip-m' }, h('div', { className: 'cal2-wip-t' }, '高级视觉工具（结构光 / 仿真评估）'), h('div', { className: 'cal2-wip-d' }, '结构光稠密重建与仿真评估将在后续批次接入')),
        h('span', { className: 'nav-tag' }, 'WIP')));
  }

  function Survey({ s }) {
    const proj = CX.useProj();
    const m2 = s.calMethod === 'm2';
    return h('div', { className: 'cal2-page' },
      h('div', { className: 'canvas-head' },
        h('span', { className: 't' }, '测量导入'),
        h('span', { className: 'toolchip' }, h(Icon, { name: m2 ? 'camera' : 'target', size: 14 }), m2 ? 'M2 视觉 · ChArUco + BA' : 'M1 全站仪'),
        h('div', { className: 'right' },
          h('div', { className: 'cap-phase-seg' },
            h('button', { className: m2 ? '' : 'on', onClick: () => s.setCalMethod('m1') }, 'M1'),
            h('button', { className: m2 ? 'on' : '', onClick: () => s.setCalMethod('m2') }, 'M2')))),
      m2 ? h(M2, { s, proj }) : h(M1, { s, proj }));
  }

  /* inspector（M1 点详情） */
  const KV = (k, v, mono) => h('div', { className: 'kv', key: k }, h('span', { className: 'k' }, k), h('span', { className: 'v' + (mono ? ' mono' : '') }, v));
  function surveyInspector(s, proj) {
    const sel = s.calSel;
    if (!sel || sel.type !== 'point') return CX.inspEmpty(s.calMethod === 'm2' ? 'M2 视觉流程无独立点选' : '选择测量点查看坐标 / 来源');
    const points = (proj.measured && proj.measured.points) || [];
    const p = points.find((x) => x.name === sel.id);
    if (!p) return null;
    const coord = proj.config && proj.config.coordinate_system;
    const role = !coord ? null : sel.id === coord.origin_point ? 'origin' : sel.id === coord.x_axis_point ? 'x_axis' : sel.id === coord.xy_plane_point ? 'xy_plane' : null;
    const sigma = sigmaApproxMm(p.uncertainty);
    const measuredReal = sigma == null || sigma < FABRICATED_SIGMA_THRESHOLD_MM;
    return h(React.Fragment, null,
      h('div', { className: 'insp-head' },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 } },
          h('span', { className: 'step-ico', style: { width: 30, height: 30, borderRadius: 8, background: 'var(--wash)', display: 'grid', placeItems: 'center' } }, h(Icon, { name: 'pin', size: 16 })),
          h('h2', { style: { margin: 0, fontSize: 15, fontWeight: 700, fontFamily: 'var(--font-code)' } }, p.name)),
        h('span', { className: 'cal2-src cal2-src--' + (measuredReal ? 'ts' : 'ba') }, measuredReal ? 'total_station' : '推测')),
      h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, '坐标 [x, y, z] (m)'),
        KV('x', p.position[0].toFixed(4), true), KV('y', p.position[1].toFixed(4), true), KV('z', p.position[2].toFixed(4), true)),
      h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, '质量'),
        KV('不确定度 σ', sigma == null ? 'n/a' : sigma.toFixed(1) + ' mm', true)),
      role ? h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, '角色'),
        h('span', { className: 'spill spill--positive' }, h(Icon, { name: 'pin', size: 12 }), role)) : null);
  }

  window.VOLO_CAL2 = Object.assign(window.VOLO_CAL2 || {}, { Survey, surveyInspector });
})();
