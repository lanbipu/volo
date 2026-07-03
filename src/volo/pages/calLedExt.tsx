// @ts-nocheck
import * as React from "react";
import "../ds";
import { meshFuseRun } from "../api/meshFuseCommands";
import { meshVisualReconstruct, meshVisualGeneratePattern } from "../api/meshVisualCommands";
import { pickFile } from "../api/commands";
import { isTauri } from "../api/invoke";
import { spawnSidecarStreaming, useSidecarStream } from "../api/sidecarStream";
import { listen } from "@tauri-apps/api/event";

/* Volo — Calibrate LED 分支增量（块2 Lens 完整报告 + Session 构建器 / 块3 Survey M2 视觉 / 块4 M1+M2 融合）
   沿用既有组件语言与字段名（真实后端 DTO，snake_case）。三通道状态 + 诚实 n/a。 */
(function () {
  const { Button, Badge, InlineAlert, Switch } = window.Spectrum2DesignSystem_b6d1b3;
  const { useState, useEffect, useRef } = React;
  const h = React.createElement;

  function Pill({ tone, icon, children }) {
    return h('span', { className: 'cap-pill cap-pill--' + tone }, icon ? h(Icon, { name: icon, size: 13 }) : null, h('span', null, children));
  }
  function pxBadge(px, warn) {
    if (px == null) return h(Badge, { variant: 'neutral', size: 'S' }, 'n/a');
    const t = warn || 1.0;
    const v = px < t ? 'positive' : px < t * 2 ? 'notice' : 'negative';
    return h(Badge, { variant: v, size: 'S' }, px.toFixed(2) + ' px');
  }
  function mmBadge(mm, label) {
    if (mm == null) return h(Badge, { variant: 'neutral', size: 'S' }, 'n/a');
    const v = mm < 3 ? 'positive' : mm < 8 ? 'notice' : 'negative';
    return h(Badge, { variant: v, size: 'S' }, mm.toFixed(2) + ' mm' + (label ? ' · ' + label : ''));
  }
  function copyText(str, done) {
    const fin = () => done && done();
    try { if (navigator.clipboard) { navigator.clipboard.writeText(str).then(fin, fin); return; } } catch (e) {}
    const ta = document.createElement('textarea'); ta.value = str; ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch (e) {} document.body.removeChild(ta); fin();
  }
  const CONF = { high: 'positive', medium: 'notice', low: 'notice', very_low: 'negative' };

  /* ============================================================
     块2 · Lens 完整报告 + Session 构建器
     ============================================================ */
  /* 四元数(w,x,y,z) → 欧拉 XYZ(deg) / 变换矩阵，供真实 vpcal 结果补齐分解视图。 */
  function quatToEulerDeg(qt) {
    const [w, x, y, z] = qt;
    const sinr = 2 * (w * x + y * z), cosr = 1 - 2 * (x * x + y * y);
    const rx = Math.atan2(sinr, cosr);
    const sinp = 2 * (w * y - z * x);
    const ry = Math.abs(sinp) >= 1 ? Math.sign(sinp) * (Math.PI / 2) : Math.asin(sinp);
    const siny = 2 * (w * z + x * y), cosy = 1 - 2 * (y * y + z * z);
    const rz = Math.atan2(siny, cosy);
    return [rx, ry, rz].map((r) => (r * 180) / Math.PI);
  }
  function matFromTransQuat(t, qt) {
    const [w, x, y, z] = qt;
    const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
    return [
      [1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy), t[0]],
      [2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx), t[1]],
      [2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy), t[2]],
      [0, 0, 0, 1],
    ];
  }

  /* 块2 · Lens 完整报告 —— 接真 vpcal quick-run（validate→detect→solve→report 同进程）。
     真实结果直出 tracker_to_stage / 双 RMS / 观测 / QLE；hand-eye / coverage / report diff /
     session 构建器 vpcal quick-run 不直出，真实态下诚实显示 n/a / 需扩展。浏览器无后端时保留设计演示。 */
  function LensView({ s }) {
    const state = s.calLensState || 'idle';
    const [runStage, setRunStage] = useState(0);
    const [failed, setFailed] = useState(false);
    const [errorMsg, setErrorMsg] = useState(null);
    const [diffA, setDiffA] = useState('l3');
    const [diffB, setDiffB] = useState('l2');
    const [sessDone, setSessDone] = useState(false);
    const [sessionPath, setSessionPath] = useState(() => { try { return localStorage.getItem('volo-vpcal-session-path'); } catch (e) { return null; } });
    const [taskId, setTaskId] = useState(null);
    const [envelope, setEnvelope] = useState(null);
    const timer = useRef(null);
    const { state: stream } = useSidecarStream(taskId);

    /* 真实 vpcal 结果到达（--output json，单条 envelope）*/
    useEffect(() => {
      if (!stream || !stream.exit) return;
      const last = stream.lines[stream.lines.length - 1];
      const env = last && last.parsed && typeof last.parsed === 'object' ? last.parsed : null;
      if (env && env.status === 'ok') {
        setEnvelope(env); setFailed(false); s.setCalLensState('done');
        const qy = env.data && env.data.result && env.data.result.quality;
        s.pushLog && s.pushLog({ lv: 'ok', cat: 'lens', msg: qy
          ? `镜头求解完成 · confidence <b>${env.data.confidence}</b> · 验证 RMS ${qy.validation_rms_px != null ? qy.validation_rms_px.toFixed(3) : 'n/a'} px`
          : '镜头求解完成' });
      } else {
        setEnvelope(null); setFailed(true); s.setCalLensState('idle');
        const msg = env && env.status === 'error' ? (env.error && env.error.message) : (stream.exit.stderr_tail || `进程异常退出（exit ${stream.exit.exit_code}）`);
        setErrorMsg(msg); s.pushLog && s.pushLog({ lv: 'err', cat: 'lens', msg: `镜头求解失败 · ${msg}` });
      }
      setTaskId(null);
    }, [stream && stream.exit]);

    const pickSession = async () => {
      try { const p = await pickFile('vpcal session 配置', ['json']); if (p) { setSessionPath(p); try { localStorage.setItem('volo-vpcal-session-path', p); } catch (e) {} } }
      catch (e) { s.pushLog && s.pushLog({ lv: 'err', cat: 'lens', msg: `选择 session 配置失败 · ${e && e.message ? e.message : e}` }); }
    };

    const run = async () => {
      setFailed(false); setErrorMsg(null); setEnvelope(null); setRunStage(0);
      /* 真实路径：Tauri + 已选 session → vpcal quick run */
      if (isTauri()) {
        if (!sessionPath) { await pickSession(); return; }
        s.setCalLensState('running'); s.setLogOpen && s.setLogOpen(true);
        s.pushLog && s.pushLog({ lv: 'info', cat: 'lens', msg: `运行 <b>vpcal quick run</b> · ${sessionPath}` });
        try {
          const resp = await spawnSidecarStreaming('vpcal', ['quick', 'run', '--config', sessionPath, '--output', 'json']);
          setTaskId(resp.task_id);
        } catch (e) {
          setFailed(true); setErrorMsg(e && e.message ? e.message : String(e)); s.setCalLensState('idle');
          s.pushLog && s.pushLog({ lv: 'err', cat: 'lens', msg: `镜头求解启动失败 · ${e && e.message ? e.message : e}` });
        }
        return;
      }
      /* 浏览器演示：无后端时按设计跑一次假流水线 */
      s.setCalLensState('running'); s.setLogOpen && s.setLogOpen(true);
      s.pushLogs && s.pushLogs([{ lv: 'info', cat: 'lens', msg: '镜头求解（演示）· validate → detect → solve → report' }]);
      let i = 0;
      timer.current = setInterval(() => {
        i++; setRunStage(i);
        if (i >= 4) { clearInterval(timer.current); s.setCalLensState('done'); s.pushLog && s.pushLog({ lv: 'ok', cat: 'lens', msg: '镜头求解完成（演示）· validation RMS <b>0.78 px</b> · confidence high' }); }
      }, 700);
    };
    useEffect(() => () => clearInterval(timer.current), []);
    const fail = () => { clearInterval(timer.current); setFailed(true); s.setCalLensState('idle'); s.pushLog && s.pushLog({ lv: 'err', cat: 'lens', msg: '镜头求解失败（演示）· exit 6 · 旋转多样性不足' }); };

    /* 结果对象 R：真实 vpcal envelope 优先，缺失分解字段用四元数补齐；无真实结果时用设计演示值。
       he / cov 真实态下可能为 null（vpcal quick-run 不直出 hand-eye / coverage）。 */
    const rr = envelope && envelope.data && envelope.data.result;
    const isReal = !!rr;
    let R, he, cov;
    if (isReal) {
      const t2 = rr.tracker_to_stage || {};
      const trans = t2.translation || [0, 0, 0];
      const quat = t2.rotation || [1, 0, 0, 0];
      const qq = rr.quality || {};
      const total = qq.total_observations, inl = qq.inlier_observations;
      R = {
        tracker_to_stage: { translation: trans, rotation: quat, euler_deg: quatToEulerDeg(quat), matrix_4x4: t2.matrix_4x4 || matFromTransQuat(trans, quat) },
        quality: {
          reprojection_rms_px: qq.reprojection_rms_px, validation_rms_px: qq.validation_rms_px,
          total_observations: total, inlier_observations: inl,
          outlier_ratio: (total && inl != null) ? (total - inl) / total : null,
          num_poses: qq.num_poses, confidence: qq.confidence || 'low',
        },
        qa: { reprojection: { global_mean_px: envelope.data.qa && envelope.data.qa.reprojection ? envelope.data.qa.reprojection.global_mean_px : null } },
        qle: !!qq.lens_estimate,
      };
      he = rr.handeye || null; cov = rr.coverage || null;
    } else {
      R = LENS_RESULT; he = LENS_RESULT.handeye; cov = LENS_RESULT.coverage;
    }
    const fx = (v, d) => (v == null ? 'n/a' : v.toFixed(d == null ? 2 : d));

    const stages = LENS_STAGES.map((st, i) => {
      const cls = state === 'done' ? 'done' : state === 'running' ? (i < runStage ? 'done' : i === runStage ? 'active' : '') : '';
      return h('div', { key: st.id, className: 'lstage' + (cls ? ' ' + cls : '') },
        h('div', { className: 'ln' }, cls === 'done' ? h(Icon, { name: 'check', size: 14 }) : st.n),
        h('div', { className: 'lt' }, st.label),
        h('div', { className: 'lc' }, st.cn + ' · ' + (cls === 'done' ? '已完成' : cls === 'active' ? '运行中' : '待运行')));
    });

    const head = h('div', { className: 'canvas-head' },
      h('span', { className: 't' }, '镜头校正'),
      h('span', { className: 'toolchip' }, '刚体 6-DOF · 无 scale'),
      isTauri() ? h('span', { className: 'toolchip', onClick: pickSession, style: { cursor: 'pointer' }, title: sessionPath || undefined },
        h(Icon, { name: 'doc', size: 14 }), sessionPath ? sessionPath.split(/[\\/]/).pop() : '选择 session 配置') : null,
      h('div', { className: 'right' },
        (state === 'done' && !isReal) ? h('button', { className: 'ar-tool', onClick: fail, title: '演示失败态' }, '模拟失败') : null,
        state === 'done' ? pxBadge(R.quality.validation_rms_px) : null,
        h(Button, { variant: 'accent', size: 'S', icon: h(Icon, { name: 'target', size: 14 }), isDisabled: state === 'running', onPress: run }, state === 'done' ? '重新求解' : '运行求解')));

    if (state !== 'done') {
      return h(React.Fragment, null, head,
        h('div', { className: 'lwrap cal-scroll' },
          h('div', { className: 'lstages' }, stages),
          failed
            ? h(InlineAlert, { variant: 'negative', title: '求解失败' }, errorMsg || 'stderr: rotation diversity insufficient — axis_spread 0.08 < 0.30。请增加 pan / tilt 变化后重拍。')
            : state === 'running'
              ? h('div', { className: 'hatch', style: { minHeight: 260 } }, h('div', { className: 'hi' },
                  h('span', { className: 'hic' }, h(Icon, { name: 'sync', size: 24 })),
                  h('span', { className: 'ht' }, '正在跑完整 pipeline…'),
                  h('span', { className: 'hd' }, '当前阶段 ' + (LENS_STAGES[Math.min(runStage, 3)].label) + ' · 一次跑满 validate → detect → solve → report')))
              : h('div', { className: 'hatch', style: { minHeight: 260 } }, h('div', { className: 'hi' },
                  h('span', { className: 'hic' }, h(Icon, { name: 'camera', size: 24 })),
                  h('span', { className: 'ht' }, '镜头校正未运行'),
                  h('span', { className: 'hd' }, '运行后生成 6-DOF 变换、拟合 / 验证 RMS、hand-eye 与 coverage 报告。')))));
    }

    const q = R.quality;
    const hA = LENS_HISTORY.find((x) => x.id === diffA), hB = LENS_HISTORY.find((x) => x.id === diffB);
    const Q = (k, v, u, vis) => h('div', { className: 'qmetric' }, h('div', { className: 'qk' }, k), h('div', { className: 'qv s-' + (vis || '') }, v, u ? h('span', { className: 'u' }, u) : null));

    return h(React.Fragment, null, head,
      h('div', { className: 'lwrap cal-scroll' },
        h('div', { className: 'lstages' }, stages),
        /* 双 RMS：拟合 vs 验证（置信度以验证为准） */
        h('div', { className: 'lens-rms2' },
          h('div', { className: 'ar-card' }, h('div', { className: 'ar-rms-k' }, '拟合 RMS'), h('div', { className: 'ar-rms-v sm' }, fx(q.reprojection_rms_px), h('span', null, ' px')), h('div', { className: 'ar-rms-s' }, 'reprojection_rms_px · in-sample')),
          h('div', { className: 'ar-card ar-card--hl' }, h('div', { className: 'ar-rms-k' }, '验证 RMS · HELD-OUT'), h('div', { className: 'ar-rms-v' }, fx(q.validation_rms_px), h('span', null, ' px')),
            h('div', { className: 'ar-rms-s' }, 'validation_rms_px · confidence ', h(Pill, { tone: CONF[q.confidence] || 'notice', icon: q.confidence === 'high' ? 'check' : 'alert' }, q.confidence), ' · 权重更高')),
          h('span', { className: 'lens-rms-edu' }, '拟合 RMS 只看训练观测；验证 RMS 用留出帧背书泛化，置信度以后者为准。')),
        h('div', { className: 'qbar', style: { marginBottom: 14 } },
          Q('total_observations', q.total_observations != null ? q.total_observations.toLocaleString() : 'n/a', '', ''),
          Q('inlier_observations', q.inlier_observations != null ? q.inlier_observations.toLocaleString() : 'n/a', '', 'positive'),
          Q('outlier_ratio', q.outlier_ratio != null ? (q.outlier_ratio * 100).toFixed(1) : 'n/a', q.outlier_ratio != null ? '%' : '', 'notice'),
          Q('num_poses', q.num_poses != null ? q.num_poses : 'n/a', '', ''),
          Q('global_mean_px', R.qa.reprojection.global_mean_px != null ? R.qa.reprojection.global_mean_px.toFixed(2) : 'n/a', R.qa.reprojection.global_mean_px != null ? 'px' : '', 'positive')),
        /* hand-eye 一级展示（vpcal quick-run 不直出时诚实 n/a，需 report generate 扩展） */
        he
          ? h('div', { className: 'ar-card lens-he', style: { marginBottom: 14 } },
              h('div', { className: 'ar-card-h' }, h(Icon, { name: 'link', size: 15 }), 'hand-eye · 头号误差源（1:1 直通最终结果）'),
              h('div', { className: 'ar-det' },
                h('div', { className: 'ar-gm' }, h('span', { className: 'k' }, '闭式初始化 (mm)'), h('span', { className: 'v mono' }, '[' + he.closed_form_mm.join(', ') + ']')),
                h('div', { className: 'ar-gm' }, h('span', { className: 'k' }, '与先验差异'), h('span', { className: 'v mono s-notice' }, '±' + he.diff_mm.toFixed(1) + ' mm · ' + he.diff_deg.toFixed(1) + '°')),
                h('div', { className: 'ar-gm' }, h('span', { className: 'k' }, '退化'), h('span', { className: 'v' }, he.degenerate ? h(Pill, { tone: 'negative', icon: 'alert' }, '退化') : h(Pill, { tone: 'positive', icon: 'check' }, '正常')))),
              h('div', { className: 'lens-he-note' }, '用户先验 [' + he.prior_input_mm.join(', ') + '] mm · 闭式解已应用'))
          : h('div', { className: 'ar-card lens-he', style: { marginBottom: 14 } },
              h('div', { className: 'ar-card-h' }, h(Icon, { name: 'link', size: 15 }), 'hand-eye 诊断'),
              h('div', { className: 'ar-ok-note', style: { marginTop: 0, color: 'var(--chrome-faint)' } }, h(Icon, { name: 'info', size: 13 }), 'vpcal quick-run 未直出 hand-eye 明细，需 report generate 扩展（n/a）')),
        /* 变换双视图 */
        h('div', { className: 'surv-sub' }, 'tracker_to_stage · 变换（矩阵 / 分解双视图）'),
        h('div', { className: 'lens-tf' },
          h('div', { className: 'ar-card' }, h('div', { className: 'ar-card-h' }, 'matrix_4x4'),
            h('div', { className: 'lens-mat' }, R.tracker_to_stage.matrix_4x4.map((row, ri) => row.map((v, ci) =>
              h('div', { key: ri + '_' + ci, className: 'lens-mcell' }, v.toFixed(ri === 3 ? 0 : 3)))))),
          h('div', { className: 'ar-card' }, h('div', { className: 'ar-card-h' }, '平移 / 旋转'),
            h('div', { className: 'ar-det', style: { gridTemplateColumns: '1fr' } },
              h('div', { className: 'ar-gm' }, h('span', { className: 'k' }, 'translation (m)'), h('span', { className: 'v mono' }, '[' + R.tracker_to_stage.translation.map((v) => v.toFixed(3)).join(', ') + ']')),
              h('div', { className: 'ar-gm' }, h('span', { className: 'k' }, 'rotation (quat wxyz)'), h('span', { className: 'v mono', style: { fontSize: 12 } }, '[' + R.tracker_to_stage.rotation.map((v) => v.toFixed(4)).join(', ') + ']')),
              h('div', { className: 'ar-gm' }, h('span', { className: 'k' }, 'euler (deg)'), h('span', { className: 'v mono' }, '[' + R.tracker_to_stage.euler_deg.map((v) => v.toFixed(2)).join(', ') + ']'))))),
        /* coverage 建议（vpcal quick-run 不直出时诚实 n/a） */
        cov
          ? h('div', { className: 'lens-cov' },
              h('div', { className: 'lens-cov-h' }, h(Icon, { name: 'grid', size: 14 }), 'coverage ', h('b', null, cov.percentage + '%')),
              cov.percentage < 90
                ? h('div', { className: 'lens-cov-sug' }, h(Icon, { name: 'alert', size: 13 }), '建议补拍区域：', cov.suggest_regions.join('、'), '（观测覆盖不足）')
                : h('div', { className: 'ar-ok-note' }, h(Icon, { name: 'check', size: 13 }), '覆盖充足'))
          : h('div', { className: 'lens-cov' },
              h('div', { className: 'lens-cov-h' }, h(Icon, { name: 'grid', size: 14 }), 'coverage ', h('b', null, 'n/a')),
              h('span', { style: { fontSize: 11.5, color: 'var(--chrome-faint)' } }, 'vpcal quick-run 未直出 coverage')),
        /* QLE 警示（不得视觉弱化） */
        R.qle ? h('div', { style: { marginBottom: 14 } },
          h(InlineAlert, { variant: 'notice', title: 'Quick Lens Estimate · SESSION-COUPLED / NON-MASTER' },
            '镜头快速估计结果与本次 session 耦合，不可作为 master 镜头资产复用。')) : null,
        /* Session 构建器 + report diff：vpcal quick-run 不直出 session 编排 / 历史 diff，
           真实态诚实提示；浏览器演示态保留设计的构建器与 diff 表。 */
        !isReal
          ? h(React.Fragment, null,
              h('div', { className: 'surv-sub' }, 'Session 构建器 → session.json'),
              h('div', { className: 'lens-sess' },
                Object.keys(LENS_SESSION).map((k) => { const g = LENS_SESSION[k]; return h('div', { key: k, className: 'lens-sess-card' + (g.ready ? '' : ' pending') },
                  h('div', { className: 'lens-sess-top' },
                    h('span', { className: 'lens-sess-l' }, k),
                    g.ready ? h(Pill, { tone: 'positive', icon: 'check' }, '就绪') : h(Pill, { tone: 'notice', icon: 'alert' }, '待补')),
                  h('div', { className: 'lens-sess-lbl' }, g.label),
                  h('div', { className: 'lens-sess-v' }, g.value)); })),
              h('div', { className: 'lens-sess-foot' },
                h(Button, { variant: sessDone ? 'secondary' : 'accent', size: 'S', icon: h(Icon, { name: sessDone ? 'check' : 'doc', size: 14 }),
                  onPress: () => { setSessDone(true); s.pushLog && s.pushLog({ lv: 'ok', cat: 'lens', msg: '生成 <b>session.json</b>（camera / tracking / screen / lens）' }); } }, sessDone ? '已生成 session.json' : '生成 session.json'),
                h('span', { className: 'lens-sess-hint' }, 'lens 组可缺省（后补）；camera / tracking / screen 必填')),
              h('div', { className: 'surv-sub' }, 'report diff · daily drift check'),
              h('div', { className: 'lens-diff' },
                h('div', { className: 'lens-diff-sel' },
                  h('select', { value: diffA, onChange: (e) => setDiffA(e.target.value) }, LENS_HISTORY.map((x) => h('option', { key: x.id, value: x.id }, x.time))),
                  h(Icon, { name: 'arrowr', size: 14 }),
                  h('select', { value: diffB, onChange: (e) => setDiffB(e.target.value) }, LENS_HISTORY.map((x) => h('option', { key: x.id, value: x.id }, x.time)))),
                h('div', { className: 'lens-diff-table' },
                  h('div', { className: 'lens-diff-head' }, h('span', null, '项'), h('span', null, hA.time), h('span', null, hB.time), h('span', null, 'Δ')),
                  [['t.x (m)', hA.trans[0], hB.trans[0], 0.005], ['t.y (m)', hA.trans[1], hB.trans[1], 0.005], ['t.z (m)', hA.trans[2], hB.trans[2], 0.005],
                   ['r.x (°)', hA.rot_deg[0], hB.rot_deg[0], 0.2], ['r.y (°)', hA.rot_deg[1], hB.rot_deg[1], 0.2], ['r.z (°)', hA.rot_deg[2], hB.rot_deg[2], 0.2],
                   ['RMS (px)', hA.rms, hB.rms, 0.15], ['val (px)', hA.val, hB.val, 0.2]].map((row) => {
                    const d = row[1] - row[2]; const over = Math.abs(d) > row[3];
                    return h('div', { key: row[0], className: 'lens-diff-row' + (over ? ' over' : '') },
                      h('span', { className: 'dim' }, row[0]), h('span', { className: 'mono' }, row[1].toFixed(3)), h('span', { className: 'mono' }, row[2].toFixed(3)),
                      h('span', { className: 'mono' + (over ? ' s-negative' : '') }, (d >= 0 ? '+' : '') + d.toFixed(3)));
                  }))))
          : h('div', { className: 'lens-cov', style: { flexDirection: 'column', alignItems: 'flex-start', gap: 6 } },
              h('span', { style: { fontSize: 11.5, color: 'var(--chrome-faint)', lineHeight: 1.5 } },
                'Session 构建器 / report diff：quick-run 复用已选 session 配置（' + (sessionPath ? sessionPath.split(/[\\/]/).pop() : '—') + '）；独立 session 编排与 vpcal report diff 历史比对待接后端。'))));
  }

  /* ============================================================
     块3 · Survey M2 视觉测量流程
     ============================================================ */
  /* 块3 · Survey M2 视觉 —— 接真 mesh_visual_*（proj 由 calibrate.tsx surveyView 透传）。
     BA 重建走流式 mesh_visual_reconstruct + mesh-visual-progress / -done 事件（真实 stage/percent/warning）；
     pattern 生成走 mesh_visual_generate_pattern。结果 VisualReconstructResult 与设计 mock 1:1。
     无后端 / 无项目时回退设计演示（M2_* 常量 + 定时器假进度）。 */
  function SurveyM2({ s, proj }) {
    const [baState, setBaState] = useState('idle'); /* idle|running|done */
    const [baPct, setBaPct] = useState(0);
    const [baStage, setBaStage] = useState('');
    const [intr, setIntr] = useState('auto');
    const [manifestPath, setManifestPath] = useState(null);
    const [intrPath, setIntrPath] = useState(null);
    const [result, setResult] = useState(null);   /* 真实 VisualReconstructResult */
    const [warns, setWarns] = useState([]);        /* 流式 warning 事件累积 */
    const [baErr, setBaErr] = useState(null);
    const timer = useRef(null);
    const jobRef = useRef(null);
    const unref = useRef([]);
    const hasBackend = isTauri() && proj && proj.path;

    /* 真实态用 result，缺失时用设计演示常量 */
    const RC = result || M2_RECONSTRUCT;
    const isReal = !!result;
    const IN = M2_INTRINSICS;
    const intrOk = IN.rms_px <= IN.max_rms_px;

    /* 流式监听：进度（stage/percent）+ 完成（result/error），按 job_id 甄别 */
    useEffect(() => {
      if (!hasBackend) return;
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
          s.pushLog && s.pushLog({ lv: 'ok', cat: 'survey', msg: `BA 重建完成 · ba_rms <b>${p.result.ba_rms_px.toFixed(2)} px</b> · ${p.result.cabinet_count} 箱体` });
        } else {
          setBaErr(p.error || '重建失败'); setBaState('idle'); jobRef.current = null;
          s.pushLog && s.pushLog({ lv: 'err', cat: 'survey', msg: `BA 重建失败 · ${p.error || '未知错误'}` });
        }
      }).then(add);
      return () => { alive = false; unref.current.forEach((fn) => fn()); unref.current = []; };
    }, [hasBackend]);
    useEffect(() => () => clearInterval(timer.current), []);

    const pickManifest = async () => {
      try { const p = await pickFile('capture manifest (JSON/YAML)', ['json', 'yaml', 'yml']); if (p) { setManifestPath(p); s.pushLog && s.pushLog({ lv: 'info', cat: 'survey', msg: `capture manifest · ${p.split(/[\\/]/).pop()}` }); } }
      catch (e) { s.pushLog && s.pushLog({ lv: 'err', cat: 'survey', msg: `选择 manifest 失败 · ${e && e.message ? e.message : e}` }); }
    };
    const pickIntr = async () => {
      try { const p = await pickFile('相机内参 (YAML)', ['yaml', 'yml', 'json']); if (p) { setIntrPath(p); } }
      catch (e) { s.pushLog && s.pushLog({ lv: 'err', cat: 'survey', msg: `选择内参失败 · ${e && e.message ? e.message : e}` }); }
    };

    const genPattern = async () => {
      if (!hasBackend) { s.pushLog && s.pushLog({ lv: 'ok', cat: 'survey', msg: '生成 pattern（演示）· 全屏图 + 9 箱体 tile' }); return; }
      s.pushLog && s.pushLog({ lv: 'info', cat: 'survey', msg: `生成 pattern · ${M2_PATTERN.method}` });
      try {
        const r = await meshVisualGeneratePattern(proj.path, s.calScreen, M2_PATTERN.method, 1, null);
        s.pushLog && s.pushLog({ lv: 'ok', cat: 'survey', msg: `pattern 生成 · ${r.cabinet_count} 箱体 · ${r.total_markers} markers → ${r.output_dir}` });
      } catch (e) { s.pushLog && s.pushLog({ lv: 'err', cat: 'survey', msg: `pattern 生成失败 · ${e && e.message ? e.message : e}` }); }
    };

    const runBa = async () => {
      setBaErr(null); setWarns([]); setResult(null); setBaStage('');
      if (!hasBackend) {
        setBaState('running'); setBaPct(4); s.setLogOpen && s.setLogOpen(true);
        s.pushLogs && s.pushLogs([{ lv: 'info', cat: 'survey', msg: 'BA 重建启动（演示）· ' + M2_RECONSTRUCT.ba_observations_total.toLocaleString() + ' 观测' }]);
        let p = 4; timer.current = setInterval(() => {
          p += 16; setBaPct(Math.min(100, p));
          if (p >= 100) { clearInterval(timer.current); setBaState('done'); s.pushLog && s.pushLog({ lv: 'ok', cat: 'survey', msg: 'BA 重建完成（演示）· ba_rms <b>' + M2_RECONSTRUCT.ba_rms_px + ' px</b>' }); }
        }, 500);
        return;
      }
      if (!manifestPath) { await pickManifest(); return; }
      if (intr === 'chessboard' && !intrPath) { await pickIntr(); return; }
      setBaState('running'); setBaPct(0); s.setLogOpen && s.setLogOpen(true);
      s.pushLog && s.pushLog({ lv: 'info', cat: 'survey', msg: `BA 重建 · mesh_visual_reconstruct · ${intr === 'auto' ? 'auto 自标定' : '外部内参'}` });
      try {
        const resp = await meshVisualReconstruct(proj.path, s.calScreen, manifestPath, intr === 'auto' ? null : intrPath, null);
        jobRef.current = resp.job_id;
      } catch (e) {
        setBaState('idle'); setBaErr(e && e.message ? e.message : String(e));
        s.pushLog && s.pushLog({ lv: 'err', cat: 'survey', msg: `BA 重建启动失败 · ${e && e.message ? e.message : e}` });
      }
    };
    const cancelBa = () => {
      clearInterval(timer.current); jobRef.current = null;
      setBaState('idle'); setBaPct(0);
      s.pushLog && s.pushLog({ lv: 'warn', cat: 'survey', msg: 'BA 重建已取消' });
    };

    const Q = (k, v, u, vis) => h('div', { className: 'qmetric' }, h('div', { className: 'qk' }, k), h('div', { className: 'qv s-' + (vis || '') }, v, u ? h('span', { className: 'u' }, u) : null));
    const allWarns = isReal ? warns : M2_RECONSTRUCT.warnings;

    return h(React.Fragment, null,
      h('div', { className: 'canvas-head' }, h('span', { className: 't' }, '测量导入 · M2 视觉'),
        h('span', { className: 'toolchip' }, h(Icon, { name: 'camera', size: 14 }), 'ChArUco + BA')),
      h('div', { className: 'surv cal-scroll' },
        /* 1 Pattern 生成 */
        h('div', { className: 'surv-sub', style: { marginTop: 0 } }, '1 · Pattern 生成'),
        h('div', { className: 'ar-card' },
          h('div', { className: 'm2-pat-row' },
            h('div', { className: 'm2-field' }, h('span', { className: 'cap-lbl' }, 'method'), h('span', { className: 'm2-val' }, M2_PATTERN.method)),
            h('div', { className: 'm2-field' }, h('span', { className: 'cap-lbl' }, 'screen_id'), h('span', { className: 'm2-val' }, hasBackend ? (s.calScreen || '—') : M2_PATTERN.screen_id_code)),
            h(Button, { variant: 'secondary', size: 'S', icon: h(Icon, { name: 'sync', size: 14 }), onPress: genPattern }, '生成图案')),
          h('div', { className: 'm2-tiles' },
            h('div', { className: 'm2-full' }, h('div', { className: 'm2-full-grid' }), h('span', null, '全屏图')),
            M2_PATTERN.tiles.map((t) => h('div', { key: t.cab, className: 'm2-tile' + (t.ok ? '' : ' bad') },
              h('div', { className: 'm2-tile-p' }), h('span', null, t.cab.replace('cab_', '#')))))),
        /* 2 Capture manifest */
        h('div', { className: 'surv-sub' }, '2 · Capture manifest 构建器'),
        h('div', { className: 'ar-card' },
          h('div', { className: 'm2-manifest-h' },
            h('div', null, h(Icon, { name: 'folder', size: 13 }), hasBackend ? (manifestPath ? ' ' + manifestPath.split(/[\\/]/).pop() : ' 选择 manifest 文件（BA 重建输入）') : ' 手动兜底 · 目录扫描 / 文件选择'),
            h(Button, { variant: manifestPath ? 'secondary' : 'accent', size: 'S', icon: h(Icon, { name: 'folder', size: 14 }), onPress: hasBackend ? pickManifest : () => s.pushLog && s.pushLog({ lv: 'info', cat: 'survey', msg: '扫描目录（演示）· 组织为视图列表' }) }, hasBackend ? '选择 manifest' : '扫描目录')),
          hasBackend
            ? (manifestPath
                ? h('div', { className: 'm2-views' }, h('div', { className: 'm2-view' }, h('span', { className: 'sdot bg-positive' }), h('span', { className: 'm2-view-n mono' }, manifestPath.split(/[\\/]/).pop())))
                : h('div', { style: { fontSize: 11.5, color: 'var(--chrome-faint)' } }, '尚未选择 capture manifest（视图列表由 manifest 内容决定）'))
            : h('div', { className: 'm2-views' }, M2_MANIFEST.map((v) => h('div', { key: v.view, className: 'm2-view' },
                h('span', { className: 'sdot bg-positive' }), h('span', { className: 'm2-view-n mono' }, v.view), h('span', { className: 'm2-view-c' }, v.imgs + ' 张'))))),
        /* 3 内参标定 */
        h('div', { className: 'surv-sub' }, '3 · 内参标定'),
        h('div', { className: 'ar-card' },
          h('div', { className: 'cap-seg', style: { marginBottom: 12 } },
            [['auto', 'auto 自标定'], ['chessboard', '外部内参文件']].map(([k, l]) => h('button', { key: k, className: intr === k ? 'on' : '', onClick: () => setIntr(k) }, l))),
          hasBackend
            ? (intr === 'auto'
                ? h('div', { className: 'ar-ok-note', style: { marginTop: 0 } }, h(Icon, { name: 'info', size: 13 }), 'BA 内联自标定（intrinsics_source = auto_self_calibrated）；无需外部内参文件')
                : h('div', { className: 'm2-manifest-h', style: { marginBottom: 0 } },
                    h('div', null, h(Icon, { name: 'doc', size: 13 }), intrPath ? ' ' + intrPath.split(/[\\/]/).pop() : ' 选择相机内参 YAML'),
                    h(Button, { variant: intrPath ? 'secondary' : 'accent', size: 'S', icon: h(Icon, { name: 'doc', size: 14 }), onPress: pickIntr }, '选择内参')))
            : h(React.Fragment, null,
                h('div', { className: 'm2-intr' },
                  h('div', { className: 'ar-gm' }, h('span', { className: 'k' }, 'rms_px'), h('span', { className: 'v mono s-' + (intrOk ? 'positive' : 'negative') }, IN.rms_px.toFixed(2))),
                  h('div', { className: 'ar-gm' }, h('span', { className: 'k' }, 'max_rms_px 门'), h('span', { className: 'v mono' }, IN.max_rms_px.toFixed(2))),
                  h('div', { className: 'ar-gm' }, h('span', { className: 'k' }, '结果'), h('span', { className: 'v' }, intrOk ? h(Pill, { tone: 'positive', icon: 'check' }, '通过') : h(Pill, { tone: 'negative', icon: 'alert' }, '超限拒绝')))),
                IN.observability_warn ? h('div', { className: 'ar-inline-warn' }, h(Icon, { name: 'alert', size: 13 }), IN.observability_warn) : null)),
        /* 4 BA 重建进度 */
        h('div', { className: 'surv-sub' }, '4 · BA 重建'),
        baErr ? h('div', { style: { marginBottom: 10 } }, h(InlineAlert, { variant: 'negative', title: 'BA 重建失败' }, baErr)) : null,
        baState === 'idle'
          ? h('div', { className: 'ar-card', style: { textAlign: 'center', padding: 20 } },
              h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'cube', size: 15 }), onPress: runBa }, hasBackend && !manifestPath ? '选择 manifest 后开始' : '开始 BA 重建'))
          : h('div', { className: 'ar-card' },
              h('div', { className: 'm2-ba-top' }, h('span', null, baState === 'done' ? 'BA 重建完成' : 'BA 重建中 · 长任务' + (baStage ? ' · ' + baStage : '')), h('span', { className: 'mono' }, Math.round(baPct) + '%'),
                baState === 'running' ? h('button', { className: 'ar-tool', onClick: cancelBa }, h(Icon, { name: 'x', size: 12 }), '取消') : null),
              h('div', { className: 'vmeter vmeter--accent', style: { marginTop: 8 } }, h('div', { className: 'vmeter__fill', style: { width: baPct + '%' } }))),
        /* 5 重建结果摘要 */
        baState === 'done' ? h(React.Fragment, null,
          h('div', { className: 'surv-sub' }, '5 · 重建结果摘要'),
          h('div', { className: 'qbar', style: { marginBottom: 12 } },
            Q('ba_rms_px', RC.ba_rms_px.toFixed(2), 'px', 'positive'),
            Q('observations', RC.ba_observations_used.toLocaleString() + '/' + RC.ba_observations_total.toLocaleString(), '', ''),
            Q('ba_rejected', RC.ba_rejected, '', 'notice'),
            Q('procrustes_align', (RC.procrustes_align_rms_m * 1000).toFixed(1), 'mm', 'positive'),
            Q('intrinsics_source', RC.intrinsics_source, '', '')),
          allWarns.map((w, i) => h('div', { key: i, style: { marginBottom: 10 } },
            h(InlineAlert, { variant: 'notice', title: w.code + (w.cabinet ? ' · ' + w.cabinet : '') }, w.message))),
          h('div', { className: 'm2-cabtable' },
            h('div', { className: 'm2-cab-head' }, h('span', null, 'cabinet_id'), h('span', null, 'position_mm'), h('span', null, 'reproj_rms_px'), h('span', null, 'views'), h('span', null, 'quality')),
            RC.cabinets.map((c) => { const qg = M2_QUALITY[c.quality] || M2_QUALITY.fair; return h('div', { key: c.cabinet_id, className: 'm2-cab-row' + (c.quality === 'poor' ? ' bad' : '') },
              h('span', { className: 'mono' }, c.cabinet_id),
              h('span', { className: 'mono dim' }, '[' + c.position_mm.map((v) => Math.round(v)).join(', ') + ']'),
              h('span', { className: 'mono' + (c.reprojection_rms_px >= 1 ? ' s-negative' : '') }, c.reprojection_rms_px.toFixed(2)),
              h('span', { className: 'mono dim' }, c.observed_views),
              h('span', null, h(Pill, { tone: qg.tone, icon: qg.icon }, qg.label))); }))) : null));
  }

  /* ============================================================
     块4 · M1+M2 融合面板（挂在 Runs 顶部）
     ============================================================ */
  /* 块4 · M1+M2 融合 —— 接真 mesh_fuse_run（proj 由 calibrate.tsx stepView 透传）。
     无后端 / 无项目时回退设计演示（FUSE_RESULT + 模拟错误态）。 */
  function FusePanel({ s, proj }) {
    const [open, setOpen] = useState(false);
    const [err, setErr] = useState(false);
    const [result, setResult] = useState(null);
    const [running, setRunning] = useState(false);
    const hasBackend = isTauri() && proj && proj.path;
    const F = result || FUSE_RESULT;
    const anchorTone = F.anchor_rms_mm < 3 ? 'positive' : F.anchor_rms_mm < 8 ? 'notice' : 'negative';
    const scaleDevPct = ((F.scale - 1) * 100);

    const runFuse = async () => {
      if (open) { setOpen(false); return; }
      if (!hasBackend) {
        setOpen(true); setErr(false);
        s.pushLog && s.pushLog({ lv: 'ok', cat: 'fuse', msg: '融合完成（演示）· anchor RMS <b>1.42 mm</b> · 6 锚点' });
        return;
      }
      const measurementsPath = proj.measurementsAbsPath;
      if (!measurementsPath) { s.pushLog && s.pushLog({ lv: 'warn', cat: 'fuse', msg: '融合失败 · 请先在 Survey 步导入 M1 全站仪测量' }); return; }
      let poseReportPath;
      try { poseReportPath = await pickFile('M2 视觉重建 pose report', ['yaml', 'yml', 'json']); }
      catch (e) { s.pushLog && s.pushLog({ lv: 'err', cat: 'fuse', msg: `选择 pose report 失败 · ${e && e.message ? e.message : e}` }); return; }
      if (!poseReportPath) return;
      setRunning(true); setErr(false);
      s.setLogOpen && s.setLogOpen(true);
      s.pushLog && s.pushLog({ lv: 'info', cat: 'fuse', msg: '融合运行 · mesh_fuse_run（scale 锁定 1.0）' });
      try {
        const res = await meshFuseRun(proj.path, s.calScreen, poseReportPath, measurementsPath, false);
        setResult(res); setOpen(true);
        s.pushLog && s.pushLog({ lv: 'ok', cat: 'fuse', msg: `融合完成 · anchor RMS <b>${res.anchor_rms_mm.toFixed(2)} mm</b> · ${res.anchor_count} 锚点` });
      } catch (e) {
        setResult(null); setErr(true); setOpen(true);
        s.pushLog && s.pushLog({ lv: 'err', cat: 'fuse', msg: `融合失败 · ${e && e.message ? e.message : e}` });
      } finally { setRunning(false); }
    };

    return h('div', { className: 'fuse-panel' },
      h('div', { className: 'fuse-entry' },
        h('div', { className: 'fuse-entry-l' },
          h('span', { className: 'fuse-ico' }, h(Icon, { name: 'link', size: 16 })),
          h('div', null,
            h('div', { className: 'fuse-t' }, '融合 · 全站仪锚定 + 视觉稠密化'),
            h('div', { className: 'fuse-s' }, hasBackend ? '选择 M2 pose report，与当前项目 M1 measured.yaml 按点名对齐' : '主屏 · 前墙 同时存在 M1 measured.yaml 与 M2 pose report'))),
        h('div', { className: 'fuse-entry-r' },
          h('span', { className: 'cap-pill cap-pill--' + FUSE_SOURCE.m1.tone }, FUSE_SOURCE.m1.label),
          h('span', { className: 'cap-pill cap-pill--' + FUSE_SOURCE.m2.tone }, FUSE_SOURCE.m2.label),
          h(Button, { variant: open ? 'secondary' : 'accent', size: 'S', isDisabled: running, icon: h(Icon, { name: 'sync', size: 14 }),
            onPress: runFuse }, running ? '融合中…' : open ? '收起' : '融合'))),
      open ? h('div', { className: 'fuse-body' },
        err
          ? h(InlineAlert, { variant: 'negative', title: '融合失败 · 锚点不足 / ID 匹配失败' },
              h('div', null, hasBackend ? '有效锚点 < 3，或两侧 grid-vertex 点名不匹配。请补齐后重试（不静默降级）。' : '有效锚点 2 < 3，或点名不匹配：缺失 REF_xy_plane、SURV_0212。请补齐后重试，不静默降级。'))
          : h(React.Fragment, null,
              h('div', { className: 'fuse-sum' },
                h('div', { className: 'fuse-badge' }, h('span', { className: 'fuse-badge-k' }, '锚点 RMS · 实测'), mmBadge(F.anchor_rms_mm)),
                h('div', { className: 'fuse-badge' }, h('span', { className: 'fuse-badge-k' }, '来源'), h('span', { className: 'cap-pill cap-pill--' + FUSE_SOURCE.fused.tone }, h(Icon, { name: 'check', size: 13 }), FUSE_SOURCE.fused.label)),
                h('div', { className: 'fuse-badge' }, h('span', { className: 'fuse-badge-k' }, 'anchor_count'), h('span', { className: 'fuse-num mono' }, F.anchor_count)),
                h('div', { className: 'fuse-badge' }, h('span', { className: 'fuse-badge-k' }, 'scale' + (F.scale_locked ? ' · locked' : '')),
                  F.scale_locked ? h('span', { className: 'fuse-num mono' }, F.scale.toFixed(4))
                    : h('span', { className: 'fuse-num mono ' + (Math.abs(scaleDevPct) > 0.5 ? 's-negative' : 's-notice') }, F.scale.toFixed(4), h('span', { className: 'fuse-dev' }, ' ' + (scaleDevPct >= 0 ? '+' : '') + scaleDevPct.toFixed(2) + '%')))),
              !F.scale_locked && Math.abs(scaleDevPct) > 0.05 ? h('div', { className: 'ar-inline-warn', style: { marginBottom: 10 } }, h(Icon, { name: 'alert', size: 13 }), 'scale 未锁定，偏离 1.0 ' + scaleDevPct.toFixed(2) + '%（阈值 ±0.5%）') : null,
              h('div', { className: 'fuse-rtable' },
                h('div', { className: 'fuse-rt-head' }, h('span', null, 'point_name'), h('span', null, 'residual_mm'), h('span', null, 'Δ x/y/z (mm)')),
                F.anchor_residuals.map((r) => { const over = r.residual_mm > 2.5; return h('div', { key: r.point_name, className: 'fuse-rt-row' + (over ? ' over' : '') },
                  h('span', { className: 'mono' }, r.point_name),
                  h('span', { className: 'mono' + (over ? ' s-negative' : '') }, r.residual_mm.toFixed(2)),
                  h('span', { className: 'mono dim' }, '[' + r.delta_mm.map((v) => v.toFixed(2)).join(', ') + ']')); })),
              h('div', { className: 'fuse-foot' },
                h('code', null, F.fused_pose_report_path),
                !hasBackend ? h('button', { className: 'ar-tool', onClick: () => setErr(true), title: '演示错误态' }, '模拟错误态') : null)) ) : null);
  }

  window.VOLO_CAL_LED = { LensView, SurveyM2, FusePanel };
})();
