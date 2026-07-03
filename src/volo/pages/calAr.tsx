// @ts-nocheck
import * as React from "react";
import "../ds";
import { spawnSidecar, spawnSidecarStreaming, useSidecarStream } from "../api/sidecarStream";
import { pickFile, pickDirectory, listArRuns } from "../api/commands";
import { isTauri } from "../api/invoke";
/* Volo — Calibrate · AR 分支（stage_type = "ar"）
   无 LED 屏：实景舞台叠加 AR。真值来自实测 marker map / 标定立方体。
   沿用现有 Calibrate 骨架、组件语言与密度。字段对齐 vpcal 真实 DTO。
   接真：marker-map validate/rebase · quick run（spatial）· capture delay-cal ·
   verify overlay · export opentrackio —— 均走 sidecars/vpcal，envelope {status,data,error}；
   无后端 / 缺输入 artefact 时回退设计演示（AR_* 常量），诚实标注 demo。 */
(function () {
  const { Button, Badge, InlineAlert, Switch } = window.Spectrum2DesignSystem_b6d1b3;
  const { useState, useEffect, useRef } = React;
  const h = React.createElement;
  const Selector = window.Selector;

  /* 共享：一次性 vpcal 调用（--output json，单条 envelope）。返回 {run,data,err,running,reset}。 */
  function useVpcalRun(s, cat) {
    const [taskId, setTaskId] = useState(null);
    const [data, setData] = useState(null);
    const [err, setErr] = useState(null);
    const [running, setRunning] = useState(false);
    const { state } = useSidecarStream(taskId);
    useEffect(() => {
      if (!state || !state.exit) return;
      const last = state.lines[state.lines.length - 1];
      const env = last && last.parsed && typeof last.parsed === 'object' ? last.parsed : null;
      if (env && env.status === 'ok') { setData(env.data || {}); }
      else { setErr(env && env.status === 'error' ? (env.error && env.error.message) : (state.exit.stderr_tail || `进程异常退出（exit ${state.exit.exit_code}）`)); }
      setRunning(false); setTaskId(null);
    }, [state && state.exit]);
    const run = async (argv) => {
      setErr(null); setData(null); setRunning(true);
      try { const resp = await spawnSidecarStreaming('vpcal', argv.concat(['--output', 'json'])); setTaskId(resp.task_id); }
      catch (e) { setErr(e && e.message ? e.message : String(e)); setRunning(false); s.pushLog && s.pushLog({ lv: 'err', cat, msg: `vpcal 启动失败 · ${e && e.message ? e.message : e}` }); }
    };
    return { run, data, err, running, reset: () => { setData(null); setErr(null); } };
  }

  /* 共享：AR session 配置路径（localStorage，跨步复用），供 quick run / delay-cal / verify 引用。 */
  function useArPath(key, label, exts) {
    const lsk = 'volo-ar-' + key;
    const [path, setPath] = useState(() => { try { return localStorage.getItem(lsk); } catch (e) { return null; } });
    const pick = async () => {
      try { const p = exts ? await pickFile(label, exts) : await pickDirectory(); if (p) { setPath(p); try { localStorage.setItem(lsk, p); } catch (e) {} return p; } }
      catch (e) {}
      return null;
    };
    return [path, pick];
  }
  const baseName = (p) => (p ? p.split(/[\\/]/).pop() : null);
  /* 解析一次性 spawnSidecar 输出（--output json，stdout 最后一条 JSON 行 = envelope）。 */
  function parseEnvelope(out) {
    if (!out || !out.stdout) return null;
    const lines = out.stdout.trim().split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try { const o = JSON.parse(lines[i]); if (o && (o.status === 'ok' || o.status === 'error')) return o; } catch (e) {}
    }
    return null;
  }
  function PathChip({ path, onPick, label }) {
    return h('span', { className: 'toolchip', onClick: onPick, style: { cursor: 'pointer' }, title: path || undefined },
      h(Icon, { name: 'doc', size: 14 }), path ? baseName(path) : label);
  }

  const SEV = {
    healthy:  { visual: 'positive', icon: 'check' },
    warning:  { visual: 'notice',   icon: 'alert' },
    critical: { visual: 'negative', icon: 'alert' },
  };
  function Pill({ tone, icon, children }) {
    return h('span', { className: 'cap-pill cap-pill--' + tone }, icon ? h(Icon, { name: icon, size: 13 }) : null, h('span', null, children));
  }
  function pxBadge(px, warn) {
    if (px == null) return h(Badge, { variant: 'neutral', size: 'S' }, 'n/a');
    const v = px < (warn || 1.0) ? 'positive' : px < (warn || 1.0) * 2 ? 'notice' : 'negative';
    return h(Badge, { variant: v, size: 'S' }, px.toFixed(2) + ' px');
  }
  function copyText(str, done) {
    const fin = () => done && done();
    try { if (navigator.clipboard) { navigator.clipboard.writeText(str).then(fin, fin); return; } } catch (e) {}
    const ta = document.createElement('textarea'); ta.value = str; ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch (e) {} document.body.removeChild(ta); fin();
  }

  /* =================== ctx marker-map selector =================== */
  function markerMapSelector(s) {
    const cur = AR_MARKER_MAPS.find((x) => x.id === (s.calArMap || 'floor')) || AR_MARKER_MAPS[0];
    return h(Selector, { kpre: 'Marker Map', value: cur.id, width: 236,
      options: AR_MARKER_MAPS.map((m) => ({ id: m.id, label: m.name, sub: `${m.markers} markers · ${AR_GRADE[m.grade].label}` })),
      onChange: (id) => s.setCalArMap ? s.setCalArMap(id) : null });
  }

  /* =================== left nav =================== */
  function ArStepItem({ st, s }) {
    const on = s.calArStep === st.id;
    const done = st.status === 'done';
    const statusTxt = done ? '已完成' : st.status === 'active' ? '进行中' : st.status === 'ready' ? '可用' : '待运行';
    return h('div', { className: 'cstep' + (on ? ' on' : '') + (done ? ' done' : ''), onClick: () => s.setCalArStep(st.id) },
      h('span', { className: 'cstep-ico' }, done ? h(Icon, { name: 'check', size: 13 }) : st.n),
      h('div', { className: 'cstep-main' },
        h('div', { className: 'cstep-t' }, st.label, h('span', { className: 'cn' }, ' · ' + st.cn)),
        h('div', { className: 'cstep-s' }, statusTxt),
        on ? h('div', { className: 'step-d' }, AR_STEP_DETAIL[st.id]) : null));
  }
  const AR_STEP_DETAIL = {
    markers: '导入真值 marker map（全站仪实测 CSV）或标定立方体，核对地面平面与世界对齐',
    lens: '镜头校正：Validate → Detect → Solve → Report（刚体 6-DOF）',
    spatial: 'hand-eye + 世界对齐求解，检出 / 覆盖率 / 退化诊断',
    delay: '摆动测试估计 tracking↔video 延迟（1ms ≈ 0.59mm 滑动）',
    verify: '标注帧眼见为实：绿十字=检测 · 红圈=重投影，逐 marker 误差',
    runs: '历史求解记录 + OpenTrackIO 导出 + Tracker 回填偏移块',
  };
  function left(s) {
    const space = AR_STEPS.filter((x) => x.group === 'space');
    const ready = AR_STEPS.filter((x) => x.group === 'ready');
    return h(React.Fragment, null,
      h('div', { className: 'sect' },
        h('div', { className: 'sect-h' }, h('span', { className: 't' }, '空间校正')),
        h('div', { className: 'cal-list' }, space.map((st) => h(ArStepItem, { key: st.id, st, s })))),
      h('div', { className: 'sect' },
        h('div', { className: 'sect-h' }, h('span', { className: 't' }, '拍摄就绪')),
        h('div', { className: 'cal-list' }, ready.map((st) => h(ArStepItem, { key: st.id, st, s })))),
      h('div', { className: 'sect', style: { marginTop: 'auto' } },
        h('div', { className: 'farm-roll' },
          h('div', { className: 'top' }, h('span', null, '空间求解'), h('span', null, AR_SPATIAL.validation_rms_px.toFixed(2) + ' px')),
          h('div', { className: 'vmeter vmeter--accent' }, h('div', { className: 'vmeter__fill', style: { width: '82%' } })),
          h('div', { className: 'top', style: { marginTop: 10 } }, h('span', null, '延迟'), h('span', null, '+' + AR_OVERVIEW.delay_ms + ' ms')),
          h('div', { className: 'vmeter vmeter--positive' }, h('div', { className: 'vmeter__fill', style: { width: '94%' } })))));
  }

  /* =================== overview band =================== */
  function overview(s) {
    const o = AR_OVERVIEW;
    const sev = SEV[o.status];
    return h('div', { className: 'land-status hero-' + o.status },
      h('div', { className: 'ls-badge s-' + sev.visual }, h(Icon, { name: sev.icon, size: 24 })),
      h('div', { className: 'ls-main' },
        h('div', { className: 'ls-line' },
          h('span', { className: 'dim' }, '空间 RMS '), h('b', null, o.spatial_rms_px.toFixed(2) + ' px'),
          h('span', { className: 'dim' }, ' · 延迟 '), h('b', null, '+' + o.delay_ms.toFixed(1) + ' ms'),
          h('span', { className: 'dim' }, ' ± ' + o.delay_sigma.toFixed(1)),
          h('span', { className: 'dim' }, ' · 上次验证 RMS '), h('b', null, o.verify_rms_px.toFixed(2) + ' px')),
        h('div', { className: 'ls-sub' }, 'AR 舞台 · Marker Map StageFloor · 42 markers · millimetre 级世界对齐')),
      h(Pill, { tone: 'positive', icon: 'check' }, '就绪'));
  }

  /* =================== 1 · Markers =================== */
  /* 接真 vpcal marker-map validate（真值 grade / 地面平面 / span / collinearity）+ rebase（重定基到地面）+ board/cube（生成打印件）。
     真实 data.{validation,ground_plane,world_alignment}；marker-map validate 不直出逐 marker 列表，真实态列表诚实标注 n/a。
     无后端 / 未选 map 用 AR_MARKERS 演示。 */
  function markersView({ s }) {
    const vp = useVpcalRun(s, 'markers');
    const vpRebase = useVpcalRun(s, 'markers');
    const [mapPath, pickMap] = useArPath('markermap', 'marker map JSON', ['json']);
    const d = vp.data;
    const val = d && d.validation, gp = d && d.ground_plane, wa = d && d.world_alignment;
    const isReal = !!val;
    let M, gradeKey;
    if (isReal) {
      const over = !!(gp && gp.available && gp.tolerance_deg != null && gp.tilt_from_z_deg != null && gp.tilt_from_z_deg > gp.tolerance_deg);
      gradeKey = (wa && wa.grade) || 'n/a';
      M = {
        total: val.num_markers, detectable: val.num_detectable, on_ground: val.num_ground_markers,
        warnings: (val.warnings || []).length, span_mm: val.span_mm, collinearity_ratio: val.collinearity_ratio,
        grade: gradeKey,
        ground: gp && gp.available ? { residual_rms_mm: gp.residual_rms_mm, tilt_from_z_deg: gp.tilt_from_z_deg, offset_from_z0_mm: gp.offset_from_z0_mm, over, tolerance_deg: gp.tolerance_deg }
          : { residual_rms_mm: null, tilt_from_z_deg: null, offset_from_z0_mm: null, over: false },
        list: null, warningsList: val.warnings || [],
      };
    } else { M = AR_MARKERS; gradeKey = M.grade; }
    const g = AR_GRADE[gradeKey] || AR_GRADE['n/a'];
    const fx1 = (v) => (v == null ? 'n/a' : v.toFixed(1));
    const na = (v) => (v == null ? 'n/a' : v);
    const tiles = [['markers 总数', na(M.total), 'informative'], ['可检测', na(M.detectable), 'positive'], ['地面 marker', na(M.on_ground), 'neutral'], ['告警数', na(M.warnings), M.warnings ? 'notice' : 'positive']];
    const Q = (k, v, u, vis) => h('div', { className: 'qmetric' }, h('div', { className: 'qk' }, k), h('div', { className: 'qv s-' + (vis || '') }, v, u ? h('span', { className: 'u' }, u) : null));

    const runValidate = async () => {
      if (!isTauri()) { s.pushLog && s.pushLog({ lv: 'ok', cat: 'markers', msg: 'marker-map validate（演示）· grade millimetre' }); return; }
      let mp = mapPath; if (!mp) { mp = await pickMap(); if (!mp) return; }
      s.setLogOpen && s.setLogOpen(true);
      s.pushLog && s.pushLog({ lv: 'info', cat: 'markers', msg: `真值校验 · <b>vpcal marker-map validate</b> · ${baseName(mp)}` });
      vp.run(['marker-map', 'validate', mp]);
    };
    const runRebase = async () => {
      if (!isTauri()) { s.pushLog && s.pushLog({ lv: 'warn', cat: 'markers', msg: 'rebase（演示）· 重定基到地面（已记录审计）' }); return; }
      if (!mapPath) { await pickMap(); return; }
      const out = await pickFile('重定基后 marker map 输出', ['json']).catch(() => null);
      /* pickFile 是打开选择；这里用目录+默认名更合适，但沿用文件选择器选输出路径 */
      const outPath = out || (mapPath.replace(/\.json$/i, '') + '_rebased.json');
      s.pushLog && s.pushLog({ lv: 'info', cat: 'markers', msg: '重定基 · <b>vpcal marker-map rebase --to-ground</b>' });
      vpRebase.run(['marker-map', 'rebase', mapPath, '--to-ground', '--out', outPath]);
    };
    const runBoard = async () => {
      if (!isTauri()) { s.pushLog && s.pushLog({ lv: 'ok', cat: 'markers', msg: '生成打印板（演示）→ apriltag_board.png + survey_template.csv' }); return; }
      const outDir = await pickDirectory(); if (!outDir) return;
      s.pushLog && s.pushLog({ lv: 'info', cat: 'markers', msg: '生成打印板 · <b>vpcal marker-map board</b>' });
      try { const r = await spawnSidecar('vpcal', ['marker-map', 'board', '--dict', 'DICT_APRILTAG_36h11', '--ids', '0-11', '--out-dir', outDir, '--output', 'json']);
        const env = parseEnvelope(r); const rd = env && env.data;
        if (env && env.status === 'error') throw new Error(env.error && env.error.message);
        s.pushLog && s.pushLog({ lv: 'ok', cat: 'markers', msg: rd ? `打印板生成 · ${(rd.boards || []).length} 板 + survey_template.csv` : '打印板生成完成' });
      } catch (e) { s.pushLog && s.pushLog({ lv: 'err', cat: 'markers', msg: `生成打印板失败 · ${e && e.message ? e.message : e}` }); }
    };
    const runCube = async () => {
      if (!isTauri()) { s.pushLog && s.pushLog({ lv: 'ok', cat: 'markers', msg: '生成立方体贴纸（演示）→ cube 5 面 + cube_map.json' }); return; }
      const outDir = await pickDirectory(); if (!outDir) return;
      s.pushLog && s.pushLog({ lv: 'info', cat: 'markers', msg: '生成立方体 · <b>vpcal marker-map cube</b>' });
      try { const r = await spawnSidecar('vpcal', ['marker-map', 'cube', '--dict', 'DICT_APRILTAG_36h11', '--out-dir', outDir, '--output', 'json']);
        const env = parseEnvelope(r); const rd = env && env.data;
        if (env && env.status === 'error') throw new Error(env.error && env.error.message);
        s.pushLog && s.pushLog({ lv: 'ok', cat: 'markers', msg: rd ? `立方体生成 · ${(rd.faces || []).length} 面 + ${rd.marker_map ? baseName(rd.marker_map) : 'cube_map.json'}` : '立方体生成完成' });
      } catch (e) { s.pushLog && s.pushLog({ lv: 'err', cat: 'markers', msg: `生成立方体失败 · ${e && e.message ? e.message : e}` }); }
    };

    return h(React.Fragment, null,
      h('div', { className: 'canvas-head' },
        h('span', { className: 't' }, '真值导入'),
        isTauri()
          ? h(React.Fragment, null,
              h(PathChip, { path: mapPath, onPick: pickMap, label: '选择 marker map' }),
              h(Button, { variant: 'accent', size: 'S', isDisabled: vp.running, icon: h(Icon, { name: 'check', size: 14 }), onPress: runValidate }, vp.running ? '校验中…' : '校验真值'))
          : h('span', { className: 'toolchip' }, h(Icon, { name: 'pin', size: 14 }), 'StageFloor · 全站仪实测'),
        h('div', { className: 'right' },
          h('button', { className: 'ar-tool', onClick: runBoard }, h(Icon, { name: 'download', size: 14 }), '生成打印板'),
          h('button', { className: 'ar-tool', onClick: runCube }, h(Icon, { name: 'download', size: 14 }), '生成立方体贴纸'))),
      h('div', { className: 'surv cal-scroll' },
        vp.err ? h('div', { style: { marginBottom: 12 } }, h(InlineAlert, { variant: 'negative', title: '真值校验失败' }, vp.err)) : null,
        vpRebase.err ? h('div', { style: { marginBottom: 12 } }, h(InlineAlert, { variant: 'negative', title: '重定基失败' }, vpRebase.err)) : null,
        (vpRebase.data && vpRebase.data.output) ? h('div', { style: { marginBottom: 12 } }, h(InlineAlert, { variant: 'positive', title: '重定基完成' }, '已写出 ' + baseName(vpRebase.data.output) + '（审计：tilt/offset 已校正）')) : null,
        /* 两条入口 */
        h('div', { className: 'ar-entry' },
          [{ id: 'cube', icon: 'cube', t: '快速路径 · 标定立方体', tag: '分钟级 · 精度 = 制造公差', d: '生成打印稿（5 面 tag）→ 摆放到期望原点。无需测量员。' },
           { id: 'map',  icon: 'target', t: '精密路径 · 实测 marker map', tag: '小时级 · 毫米级', d: '打印 tag 板 → 全站仪实测 → 导入 CSV。当前已导入。', on: true }].map((e) =>
            h('div', { key: e.id, className: 'mcard' + (e.on ? ' on' : ''), style: { padding: 15 } },
              h('div', { className: 'mc-top' },
                h('span', { className: 'mc-ic' }, h(Icon, { name: e.icon, size: 20 })),
                h('div', { style: { flex: 1 } }, h('h3', { style: { fontSize: 14 } }, e.t), h('div', { className: 'mc-tag' }, e.tag)),
                e.on ? h(Badge, { variant: 'accent', size: 'S' }, '已导入') : null),
              h('div', { className: 'mc-desc' }, e.d)))),
        /* 导入报告 */
        h('div', { className: 'surv-sub' }, '导入报告'),
        h('div', { className: 'surv-tiles' }, tiles.map(([l, n, v]) => h('div', { className: 'stile', key: l },
          h('div', { className: 'n s-' + v }, n), h('div', { className: 'l' }, h('span', { className: 'sdot bg-' + v }), l)))),
        h('div', { className: 'qbar', style: { marginBottom: 14 } },
          Q('span_mm', M.span_mm != null ? M.span_mm.toLocaleString() : 'n/a', M.span_mm != null ? 'mm' : '', 'positive'),
          Q('collinearity_ratio', M.collinearity_ratio != null ? M.collinearity_ratio.toFixed(2) : 'n/a', '', (M.collinearity_ratio != null && M.collinearity_ratio < 0.2) ? 'positive' : 'notice'),
          h('div', { className: 'qmetric' }, h('div', { className: 'qk' }, 'grade'), h('div', { className: 'qv', style: { paddingTop: 2 } }, h(Pill, { tone: g.tone, icon: g.icon }, g.label)))),
        /* 地面平面卡 */
        h('div', { className: 'ar-card' },
          h('div', { className: 'ar-card-h' }, h(Icon, { name: 'ruler', size: 15 }), '地面平面'),
          h('div', { className: 'ar-ground' },
            h('div', { className: 'ar-gm' }, h('span', { className: 'k' }, 'residual_rms_mm'), h('span', { className: 'v mono' }, fx1(M.ground.residual_rms_mm))),
            h('div', { className: 'ar-gm' }, h('span', { className: 'k' }, 'tilt_from_z_deg'), h('span', { className: 'v mono s-negative' }, M.ground.tilt_from_z_deg != null ? M.ground.tilt_from_z_deg.toFixed(2) : 'n/a')),
            h('div', { className: 'ar-gm' }, h('span', { className: 'k' }, 'offset_from_z0_mm'), h('span', { className: 'v mono' }, fx1(M.ground.offset_from_z0_mm)))),
          M.ground.over ? h('div', { style: { marginTop: 12 } },
            h(InlineAlert, { variant: 'notice', title: 'survey 坐标系与地面不一致' },
              h('div', null, 'tilt ' + (M.ground.tilt_from_z_deg != null ? M.ground.tilt_from_z_deg.toFixed(2) : '—') + '° 超阈值（' + (M.ground.tolerance_deg != null ? M.ground.tolerance_deg : 0.2) + '°），AR 踩地会滑。重定基是显式操作且有审计记录，绝不自动执行。'),
              h('div', { style: { marginTop: 10 } },
                h(Button, { variant: 'secondary', size: 'S', isDisabled: vpRebase.running, icon: h(Icon, { name: 'sync', size: 14 }),
                  onPress: runRebase }, vpRebase.running ? '重定基中…' : '重定基到地面（rebase）'))) ) : null),
        /* marker 列表 */
        h('div', { className: 'surv-sub' }, 'marker 列表'),
        M.list
          ? h('div', { className: 'ptable' },
              M.list.map((m) => {
                const sel = s.calSel && s.calSel.type === 'armarker' && s.calSel.id === m.id;
                return h('div', { key: m.id, className: 'prow' + (sel ? ' sel' : ''), style: { gridTemplateColumns: '90px 1fr 90px 80px' }, onClick: () => s.setCalSel({ type: 'armarker', id: m.id }) },
                  h('div', { className: 'pn' }, h('span', { className: 'sdot bg-' + (m.on_ground ? 'positive' : 'neutral') }), 'id ' + m.id),
                  h('div', { className: 'xyz' }, m.dict),
                  h('div', { style: { fontSize: 11, color: 'var(--chrome-dim)' } }, m.on_ground ? '地面' : '非地面'),
                  h('div', { className: 'er s-' + (m.uncertainty_mm < 1 ? 'positive' : m.uncertainty_mm < 2 ? 'notice' : 'negative') }, '±' + m.uncertainty_mm.toFixed(1)));
              }))
          : h('div', { style: { fontSize: 11.5, color: 'var(--chrome-faint)', padding: '4px 2px' } },
              'marker-map validate 不直出逐 marker 列表（' + (M.warningsList && M.warningsList.length ? M.warningsList.length + ' 条校验告警见日志' : '无告警') + '）。逐 marker 明细需 marker-map create 的 CSV 源。')));
  }

  /* =================== 2 · Lens =================== */
  function lensView({ s }) {
    const L = AR_LENS;
    return h(React.Fragment, null,
      h('div', { className: 'canvas-head' }, h('span', { className: 't' }, '镜头校正'),
        h('div', { className: 'right' }, pxBadge(L.validation_rms_px))),
      h('div', { className: 'lwrap cal-scroll' },
        h('div', { className: 'lstages' },
          AR_LENS_STAGES.map((st) => h('div', { key: st.id, className: 'lstage done' },
            h('div', { className: 'ln' }, h(Icon, { name: 'check', size: 14 })),
            h('div', { className: 'lt' }, st.label), h('div', { className: 'lc' }, st.cn + ' · 已完成')))),
        h('div', { style: { marginBottom: 14 } },
          h(InlineAlert, { variant: 'informative', title: '标定屏' }, 'AR 分支无 LED 屏，标定屏可用「标定板打印件或电视/投影」。')),
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 } },
          h('div', { className: 'ar-card' }, h('div', { className: 'ar-rms-k' }, '拟合 RMS'), h('div', { className: 'ar-rms-v' }, L.reprojection_rms_px.toFixed(2), h('span', null, ' px')), h('div', { className: 'ar-rms-s' }, 'reprojection_rms_px · in-sample')),
          h('div', { className: 'ar-card ar-card--hl' }, h('div', { className: 'ar-rms-k' }, '验证 RMS'), h('div', { className: 'ar-rms-v' }, L.validation_rms_px.toFixed(2), h('span', null, ' px')), h('div', { className: 'ar-rms-s' }, 'validation_rms_px · held-out · 置信度以此为准'))),
        L.quick_estimate ? h(InlineAlert, { variant: 'notice', title: 'Quick Lens Estimate · SESSION-COUPLED / NON-MASTER' },
          '快速估计结果与本次 session 耦合，不可作为 master 镜头资产复用。') : null));
  }

  /* =================== 3 · Spatial =================== */
  /* 接真 vpcal quick run（--config session.json）：validate→detect→solve→report 同进程。
     真实 data.result.quality + data.qa.{detection,handeye,coverage} 映射到 S；无后端 / 未跑用 AR_SPATIAL 演示。 */
  function spatialView({ s }) {
    const vp = useVpcalRun(s, 'spatial');
    const [cfgPath, pickCfg] = useArPath('session', 'quick run session 配置', ['json']);
    const d = vp.data;
    const isReal = !!(d && d.result && d.result.quality);
    let S;
    if (isReal) {
      const q = d.result.quality; const det = (d.qa && d.qa.detection) || {}; const he = (d.qa && d.qa.handeye) || {};
      const mc = (d.qa && d.qa.coverage && d.qa.coverage.marker_coverage) || {};
      const tot = q.total_observations, inl = q.inlier_observations;
      S = {
        reprojection_rms_px: q.reprojection_rms_px, validation_rms_px: q.validation_rms_px != null ? q.validation_rms_px : q.reprojection_rms_px,
        observations: tot != null ? tot : 0, poses: q.num_poses != null ? q.num_poses : 0,
        inliers: inl != null ? inl : 0, outliers: (tot != null && inl != null) ? tot - inl : 0,
        confidence: q.confidence || 'low',
        detected_markers: det.detected_markers != null ? det.detected_markers : 0,
        unknown_markers: det.unknown_markers != null ? det.unknown_markers : 0,
        map_markers_never_detected: det.map_markers_never_detected || [],
        marker_coverage: { percentage: mc.percentage != null ? mc.percentage : 0, missing: mc.missing || [] },
        handeye: {
          closed_form_applied: !!he.applied, axis_spread: he.axis_spread != null ? he.axis_spread : 0,
          prior_diff_mm: he.prior_translation_diff_mm != null ? he.prior_translation_diff_mm : 0,
          prior_diff_deg: he.prior_rotation_diff_deg != null ? he.prior_rotation_diff_deg : 0,
          warn: !he.applied,
        },
      };
    } else { S = AR_SPATIAL; }
    const conf = AR_CONF[S.confidence] || AR_CONF.low;
    const fx = (v, dg) => (v == null ? 'n/a' : v.toFixed(dg == null ? 2 : dg));
    const runSpatial = async () => {
      if (!isTauri()) { s.pushLogs([{ lv: 'info', cat: 'spatial', msg: '空间求解（演示）· validate → detect → solve → report' }, { lv: 'ok', cat: 'spatial', msg: '求解收敛（演示）· validation RMS <b>0.71 px</b> · confidence high' }]); return; }
      let cfg = cfgPath; if (!cfg) { cfg = await pickCfg(); if (!cfg) return; }
      s.setLogOpen && s.setLogOpen(true);
      s.pushLog && s.pushLog({ lv: 'info', cat: 'spatial', msg: `空间求解 · <b>vpcal quick run</b> · ${baseName(cfg)}` });
      vp.run(['quick', 'run', '--config', cfg, '--per-marker']);
    };
    const Q = (k, v, u, vis) => h('div', { className: 'qmetric' }, h('div', { className: 'qk' }, k), h('div', { className: 'qv s-' + (vis || '') }, v, u ? h('span', { className: 'u' }, u) : null));
    return h(React.Fragment, null,
      h('div', { className: 'canvas-head' }, h('span', { className: 't' }, '空间求解'),
        h('span', { className: 'toolchip' }, 'hand-eye + 世界对齐'),
        isTauri() ? h(PathChip, { path: cfgPath, onPick: pickCfg, label: '选择 session 配置' }) : null,
        h('div', { className: 'right' },
          vp.running ? h('span', { className: 'toolchip' }, h(Icon, { name: 'sync', size: 13 }), '求解中…') : null,
          h(Button, { variant: 'accent', size: 'S', icon: h(Icon, { name: 'target', size: 14 }), isDisabled: vp.running,
            onPress: runSpatial }, '重新求解'))),
      h('div', { className: 'lwrap cal-scroll' },
        vp.err ? h('div', { style: { marginBottom: 12 } }, h(InlineAlert, { variant: 'negative', title: '空间求解失败' }, vp.err)) : null,
        h('div', { className: 'lstages' },
          ['Validate', 'Detect', 'Solve', 'Report'].map((l, i) => h('div', { key: l, className: 'lstage' + (isReal || !isTauri() ? ' done' : '') },
            h('div', { className: 'ln' }, (isReal || !isTauri()) ? h(Icon, { name: 'check', size: 14 }) : (i + 1)), h('div', { className: 'lt' }, l), h('div', { className: 'lc' }, (isReal || !isTauri()) ? '已完成' : '待运行')))),
        /* 主次 RMS */
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 } },
          h('div', { className: 'ar-card' }, h('div', { className: 'ar-rms-k' }, '拟合 RMS'), h('div', { className: 'ar-rms-v sm' }, fx(S.reprojection_rms_px), h('span', null, ' px')), h('div', { className: 'ar-rms-s' }, 'reprojection_rms_px')),
          h('div', { className: 'ar-card ar-card--hl' }, h('div', { className: 'ar-rms-k' }, '验证 RMS · held-out'), h('div', { className: 'ar-rms-v' }, fx(S.validation_rms_px), h('span', null, ' px')),
            h('div', { className: 'ar-rms-s' }, 'validation_rms_px · confidence ', h(Pill, { tone: conf.tone, icon: conf.tone === 'positive' ? 'check' : 'alert' }, conf.label)))),
        h('div', { className: 'qbar', style: { marginBottom: 14 } },
          Q('观测数', S.observations.toLocaleString(), '', ''), Q('位姿数', S.poses, '', ''),
          Q('inlier', S.inliers.toLocaleString(), '', 'positive'), Q('outlier', S.outliers, '', 'notice')),
        /* 检测计数 */
        h('div', { className: 'ar-card', style: { marginBottom: 14 } },
          h('div', { className: 'ar-card-h' }, h(Icon, { name: 'eye', size: 15 }), '检测计数'),
          h('div', { className: 'ar-det' },
            h('div', { className: 'ar-gm' }, h('span', { className: 'k' }, 'detected_markers'), h('span', { className: 'v mono s-positive' }, S.detected_markers)),
            h('div', { className: 'ar-gm' }, h('span', { className: 'k' }, 'unknown_markers'), h('span', { className: 'v mono s-notice' }, S.unknown_markers)),
            h('div', { className: 'ar-gm' }, h('span', { className: 'k' }, 'coverage'), h('span', { className: 'v mono' }, S.marker_coverage.percentage + '%'))),
          S.unknown_markers ? h('div', { className: 'ar-inline-warn' }, h(Icon, { name: 'alert', size: 13 }), S.unknown_markers + ' 个 marker 检出但不在 map 里') : null,
          h('div', { className: 'ar-never' }, 'map_markers_never_detected：',
            S.map_markers_never_detected.map((id) => h('code', { key: id, className: 'ar-chip' }, 'id ' + id)),
            h('span', { className: 'ar-miss' }, ' · 覆盖缺失 ' + S.marker_coverage.missing.join('、')))),
        /* hand-eye 诊断 */
        h('div', { className: 'ar-card' },
          h('div', { className: 'ar-card-h' }, h(Icon, { name: 'link', size: 15 }), 'hand-eye 诊断'),
          h('div', { className: 'ar-det' },
            h('div', { className: 'ar-gm' }, h('span', { className: 'k' }, '闭式初始化'), h('span', { className: 'v' }, S.handeye.closed_form_applied ? h(Pill, { tone: 'positive', icon: 'check' }, '已应用') : h(Pill, { tone: 'notice', icon: 'alert' }, '未应用'))),
            h('div', { className: 'ar-gm' }, h('span', { className: 'k' }, 'axis_spread'), h('span', { className: 'v mono' }, S.handeye.axis_spread.toFixed(2))),
            h('div', { className: 'ar-gm' }, h('span', { className: 'k' }, '与先验差异'), h('span', { className: 'v mono' }, '±' + S.handeye.prior_diff_mm.toFixed(1) + ' mm · ' + S.handeye.prior_diff_deg.toFixed(1) + '°'))),
          S.handeye.warn
            ? h('div', { style: { marginTop: 12 } }, h(InlineAlert, { variant: 'negative', title: '旋转多样性不足（exit 6）' }, '请增加 pan / tilt 变化重拍。'))
            : h('div', { className: 'ar-ok-note' }, h(Icon, { name: 'check', size: 13 }), '旋转多样性充足 · axis_spread 达标'))));
  }

  /* =================== 4 · Delay =================== */
  /* 接真 vpcal capture delay-cal（--config --result --video --tracking）：摆动测试估计 tracking↔video 延迟。
     真实 data.cameras[0].{delay_ms,sigma_ms,confidence,num_markers,num_frames} + data.recommendation；
     无后端 / 未跑用 AR_DELAY 演示。confidence 真实为字符串档，演示为 0-1 数值。 */
  function delayView({ s }) {
    const vp = useVpcalRun(s, 'delay');
    const [cfgPath, pickCfg] = useArPath('session', 'quick run session 配置', ['json']);
    const [copied, setCopied] = useState(false);
    const d = vp.data;
    const cam = d && d.cameras && d.cameras[0];
    const isReal = !!cam;
    const D = isReal
      ? { delay_ms: cam.delay_ms, sigma_ms: cam.sigma_ms, confidence: cam.confidence, num_markers: cam.num_markers, num_frames: cam.num_frames, suggestion: d.recommendation || '—' }
      : AR_DELAY;
    const ran = isReal || !isTauri();
    const confNum = typeof D.confidence === 'number' ? Math.round(D.confidence * 100) : null;
    const fx = (v, dg) => (v == null ? 'n/a' : (v >= 0 ? '+' : '') + v.toFixed(dg == null ? 1 : dg));

    const runDelay = async () => {
      if (!isTauri()) { s.pushLog && s.pushLog({ lv: 'ok', cat: 'delay', msg: '摆动测试（演示）· 延迟 +39.6 ms · confidence high' }); return; }
      let cfg = cfgPath; if (!cfg) { cfg = await pickCfg(); if (!cfg) return; }
      const result = await pickFile('quick run result.json', ['json']); if (!result) return;
      const video = await pickDirectory(); if (!video) return;
      const tracking = await pickFile('tracking poses (jsonl)', ['jsonl', 'json']); if (!tracking) return;
      s.setLogOpen && s.setLogOpen(true);
      s.pushLog && s.pushLog({ lv: 'info', cat: 'delay', msg: '延迟校准 · <b>vpcal capture delay-cal</b>（摆动扫描）' });
      vp.run(['capture', 'delay-cal', '--config', cfg, '--result', result, '--video', video, '--tracking', tracking]);
    };

    if (!ran) {
      return h(React.Fragment, null,
        h('div', { className: 'canvas-head' }, h('span', { className: 't' }, '延迟校准'),
          isTauri() ? h(PathChip, { path: cfgPath, onPick: pickCfg, label: '选择 session 配置' }) : null),
        h('div', { className: 'lwrap cal-scroll' },
          vp.err ? h('div', { style: { marginBottom: 12 } }, h(InlineAlert, { variant: 'negative', title: '延迟校准失败' }, vp.err)) : null,
          h('div', { className: 'hatch', style: { minHeight: 320 } },
            h('div', { className: 'hi' },
              h('span', { className: 'hic' }, h(Icon, { name: vp.running ? 'sync' : 'wave', size: 26 })),
              h('span', { className: 'ht' }, vp.running ? '正在估计延迟…' : '摆动测试'),
              h('span', { className: 'hd' }, '相机对着 marker 场左右摆动 3–5 秒。双流合成下 1ms ≈ 0.59mm 滑动，日常开机需重跑。依次选 session / result.json / video 帧目录 / tracking jsonl。'),
              h('div', { style: { marginTop: 6 } }, h(Button, { variant: 'accent', size: 'M', isDisabled: vp.running, icon: h(Icon, { name: 'wave', size: 15 }), onPress: runDelay }, '开始摆动测试'))))));
    }
    return h(React.Fragment, null,
      h('div', { className: 'canvas-head' }, h('span', { className: 't' }, '延迟校准'),
        h('span', { className: 'toolchip' }, 'AR 特有 · 日常开机跑'),
        h('div', { className: 'right' }, h(Button, { variant: 'secondary', size: 'S', isDisabled: vp.running, icon: h(Icon, { name: 'sync', size: 14 }), onPress: runDelay }, '重拍'))),
      h('div', { className: 'lwrap cal-scroll' },
        vp.err ? h('div', { style: { marginBottom: 12 } }, h(InlineAlert, { variant: 'negative', title: '延迟校准失败' }, vp.err)) : null,
        h('div', { className: 'ar-delay-hero' },
          h('div', { className: 'ar-delay-big' },
            h('span', { className: 'ar-delay-num' }, fx(D.delay_ms)),
            h('span', { className: 'ar-delay-unit' }, 'ms'),
            h('span', { className: 'ar-delay-sig' }, '± ' + (D.sigma_ms != null ? D.sigma_ms.toFixed(1) : 'n/a'))),
          h('div', { className: 'ar-delay-note' }, '正 = tracking 领先视频'),
          h('div', { className: 'ar-delay-conf' },
            confNum != null
              ? h('div', { className: 'ar-conf-ring', style: { '--p': confNum + '%' } }, h('span', null, confNum + '%'))
              : h('div', { className: 'ar-conf-ring', style: { '--p': '75%' } }, h('span', { style: { fontSize: 12 } }, D.confidence || 'n/a')),
            h('div', null, h('div', { className: 'ar-conf-l' }, 'confidence'),
              h('div', { className: 'ar-conf-meta' }, (D.num_markers != null ? D.num_markers : 'n/a') + ' markers · ' + (D.num_frames != null ? D.num_frames : 'n/a') + ' frames')))),
        h('div', { className: 'ar-copyrow' },
          h('code', null, D.suggestion),
          h('button', { className: 'ar-copy-btn' + (copied ? ' done' : ''), onClick: () => copyText(D.suggestion, () => { setCopied(true); setTimeout(() => setCopied(false), 1400); }) },
            h(Icon, { name: copied ? 'check' : 'copy', size: 13 }), copied ? '已复制' : '复制')),
        h('div', { style: { marginTop: 14 } },
          h(InlineAlert, { variant: 'informative', title: '失败态引导' }, '运动不足 → 提示「请摆动相机」重拍（exit 6）；无空间校正结果 → 引导先跑 Spatial。'))));
  }

  /* =================== 5 · Verify =================== */
  /* 接真 vpcal verify overlay（--config --result --out --limit）：标注帧重投影叠加 + 逐 marker 误差。
     真实 data.{global_rms_px,global_max_px,num_frames,num_observations,per_marker[],annotated_images[]}；
     标注帧图片走后端渲染（annotated_images PNG，本地路径加载需 asset 协议，暂用 SVG 占位示意）；无后端 / 未跑用 AR_VERIFY 演示。 */
  function verifyView({ s }) {
    const vp = useVpcalRun(s, 'verify');
    const [cfgPath, pickCfg] = useArPath('session', 'quick run session 配置', ['json']);
    const [frame, setFrame] = useState(0);
    const d = vp.data;
    const isReal = !!(d && d.global_rms_px != null);
    const V = isReal
      ? { global_rms_px: d.global_rms_px, global_max_px: d.global_max_px, frames: d.num_frames, points: d.num_observations,
          markers: (d.per_marker || []).map((m) => ({ marker_id: m.marker_id, count: m.count, mean_px: m.mean_px, max_px: m.max_px })),
          annotated: d.annotated_images || [] }
      : AR_VERIFY;
    const sorted = V.markers.slice().sort((a, b) => b.mean_px - a.mean_px);
    const runVerify = async () => {
      if (!isTauri()) { s.pushLog && s.pushLog({ lv: 'ok', cat: 'verify', msg: '验证叠加（演示）· global RMS 0.62 px' }); return; }
      let cfg = cfgPath; if (!cfg) { cfg = await pickCfg(); if (!cfg) return; }
      const result = await pickFile('quick run result.json', ['json']); if (!result) return;
      const outDir = await pickDirectory(); if (!outDir) return;
      s.setLogOpen && s.setLogOpen(true);
      s.pushLog && s.pushLog({ lv: 'info', cat: 'verify', msg: '验证叠加 · <b>vpcal verify overlay</b>' });
      vp.run(['verify', 'overlay', '--config', cfg, '--result', result, '--out', outDir, '--limit', '8']);
    };
    return h(React.Fragment, null,
      h('div', { className: 'canvas-head' }, h('span', { className: 't' }, '验证叠加'),
        h('span', { className: 'toolchip' }, h(Icon, { name: 'eye', size: 14 }), '所见即所校'),
        isTauri() ? h(PathChip, { path: cfgPath, onPick: pickCfg, label: '选择 session 配置' }) : null,
        h('div', { className: 'right' },
          h(Button, { variant: 'accent', size: 'S', isDisabled: vp.running, icon: h(Icon, { name: 'eye', size: 14 }), onPress: runVerify }, vp.running ? '渲染中…' : '运行验证'),
          h(Button, { variant: 'secondary', size: 'S', icon: h(Icon, { name: 'reg', size: 14 }), onPress: () => s.pushLog({ lv: 'info', cat: 'verify', msg: '与上次结果对比 · daily check（历史 diff 待接后端）' }) }, '漂移对比'))),
      h('div', { className: 'ar-verify cal-scroll' },
        vp.err ? h('div', { style: { marginBottom: 12, gridColumn: '1/-1' } }, h(InlineAlert, { variant: 'negative', title: '验证失败' }, vp.err)) : null,
        h('div', { className: 'ar-verify-main' },
          h('div', { className: 'ar-thumbs' },
            [0, 1, 2, 3].map((i) => h('button', { key: i, className: 'ar-thumb' + (i === frame ? ' on' : ''), onClick: () => setFrame(i) },
              h(AnnotatedFrame, { seed: i, mini: true }), h('span', null, 'f' + (i + 1))))),
          h('div', { className: 'ar-frame-big' },
            h(AnnotatedFrame, { seed: frame }),
            h('div', { className: 'ar-legend' },
              h('span', null, h('i', { className: 'lg-cross' }, '＋'), '检测位置'),
              h('span', null, h('i', { className: 'lg-circle' }), '重投影位置'),
              h('span', null, h('i', { className: 'lg-line' }), 'px 误差')))),
        h('div', { className: 'ar-verify-side' },
          h('div', { className: 'qbar', style: { flexWrap: 'wrap' } },
            h('div', { className: 'qmetric' }, h('div', { className: 'qk' }, 'global_rms_px'), h('div', { className: 'qv s-positive' }, V.global_rms_px != null ? V.global_rms_px.toFixed(2) : 'n/a')),
            h('div', { className: 'qmetric' }, h('div', { className: 'qk' }, 'global_max_px'), h('div', { className: 'qv s-notice' }, V.global_max_px != null ? V.global_max_px.toFixed(2) : 'n/a')),
            h('div', { className: 'qmetric' }, h('div', { className: 'qk' }, 'frames'), h('div', { className: 'qv' }, V.frames != null ? V.frames : 'n/a')),
            h('div', { className: 'qmetric' }, h('div', { className: 'qk' }, 'points'), h('div', { className: 'qv' }, V.points != null ? V.points.toLocaleString() : 'n/a'))),
          h('div', { className: 'surv-sub' }, '逐 marker 误差（按 mean 降序）'),
          h('div', { className: 'ar-mtable' },
            h('div', { className: 'ar-mt-head' }, h('span', null, 'marker_id'), h('span', null, 'count'), h('span', null, 'mean_px'), h('span', null, 'max_px')),
            sorted.map((m) => { const bad = m.mean_px >= 1.0; return h('div', { key: m.marker_id, className: 'ar-mt-row' + (bad ? ' bad' : '') },
              h('span', { className: 'mono' }, 'id ' + m.marker_id), h('span', { className: 'mono dim' }, m.count),
              h('span', { className: 'mono' + (bad ? ' s-negative' : '') }, m.mean_px.toFixed(2)), h('span', { className: 'mono dim' }, m.max_px.toFixed(2))); })))));
  }
  /* rendered-into-image annotation stand-in (后端渲染，UI 只展示图片) */
  function AnnotatedFrame({ seed, mini }) {
    const pts = [[180, 120, 0.4], [420, 100, 1.9], [300, 260, 0.6], [560, 300, 1.3], [200, 340, 0.5], [480, 200, 0.7]];
    const off = seed * 14;
    return h('svg', { viewBox: '0 0 720 420', width: '100%', height: '100%', preserveAspectRatio: 'xMidYMid slice', style: { display: 'block' } },
      h('rect', { x: 0, y: 0, width: 720, height: 420, fill: '#14161c' }),
      h('rect', { x: 0, y: 300, width: 720, height: 120, fill: '#1a1d25' }),
      !mini ? pts.map((p, i) => { const bad = p[2] >= 1.0; const cx = p[0] + off, cy = p[1];
        return h('g', { key: i },
          h('line', { x1: cx, y1: cy, x2: cx + p[2] * 10, y2: cy - p[2] * 6, stroke: bad ? '#ff5b5b' : '#8aa0b8', strokeWidth: 1.5 }),
          h('g', { stroke: '#37d67a', strokeWidth: 2 }, h('line', { x1: cx - 9, y1: cy, x2: cx + 9, y2: cy }), h('line', { x1: cx, y1: cy - 9, x2: cx, y2: cy + 9 })),
          h('circle', { cx: cx + p[2] * 10, cy: cy - p[2] * 6, r: 7, fill: 'none', stroke: bad ? '#ff5b5b' : '#f0a030', strokeWidth: 2 })); }) : null,
      mini ? h('g', null, h('line', { x1: 300, y1: 200, x2: 320, y2: 190, stroke: '#37d67a', strokeWidth: 3 })) : null);
  }

  /* =================== 6 · Runs + export =================== */
  /* 导出接真 vpcal export opentrackio（--result --session --out --frame ue [--delay-profile]）：
     应用延迟补偿走 --delay-profile（防双重补偿由 vpcal 在 tracker.notes 打标）。
     求解历史接真 list_ar_runs（Rust 扫 runs 根目录下 result.json，零新格式）；未选目录用 AR_RUNS 演示。
     Tracker 回填偏移块数值取自结果，暂用 AR_TRACKER_BACKFILL 演示。 */
  function runsView({ s }) {
    const [compDelay, setCompDelay] = useState(true);
    const [copied, setCopied] = useState(false);
    const [exporting, setExporting] = useState(false);
    const [runsRoot, pickRunsRoot] = useArPath('runsroot', 'runs 根目录', null);
    const [realRuns, setRealRuns] = useState(null);
    const [loadingRuns, setLoadingRuns] = useState(false);
    const [runsErr, setRunsErr] = useState(null);
    const B = AR_TRACKER_BACKFILL;
    /* 从 runs 根目录扫描真实 result.json（listArRuns）。 */
    const loadRuns = async (root) => {
      if (!root) return;
      setLoadingRuns(true); setRunsErr(null);
      try { const rows = await listArRuns(root); setRealRuns(rows || []); }
      catch (e) { setRunsErr(e && e.message ? e.message : String(e)); setRealRuns(null); }
      finally { setLoadingRuns(false); }
    };
    useEffect(() => { if (isTauri() && runsRoot) loadRuns(runsRoot); }, [runsRoot]);
    const pickRuns = async () => { const p = await pickRunsRoot(); if (p) loadRuns(p); };
    /* 真实行 → 表格列（map/delay 不在 result.json，诚实 n/a）。 */
    const rows = realRuns
      ? realRuns.map((r) => ({ id: r.result_path, time: r.timestamp || r.id, map: null, rms: r.reprojection_rms_px, val_rms: r.validation_rms_px, confidence: r.confidence || 'low', delay: null }))
      : AR_RUNS;
    const isRealRuns = !!realRuns;
    const runExport = async () => {
      if (!isTauri()) { s.pushLog({ lv: 'ok', cat: 'export', msg: '导出（演示）<b>OpenTrackIO JSONL</b>' + (compDelay ? ' · 延迟已补偿' : '') }); return; }
      const result = await pickFile('quick run result.json', ['json']); if (!result) return;
      const session = await pickFile('session.json', ['json']); if (!session) return;
      const outDir = await pickDirectory(); if (!outDir) return;
      const outPath = outDir + '/tracking_calibrated.jsonl';
      let delayProfile = null;
      if (compDelay) { delayProfile = await pickFile('delay profile JSON（capture delay-cal 输出）', ['json']); if (!delayProfile) return; }
      const argv = ['export', 'opentrackio', '--result', result, '--session', session, '--out', outPath, '--frame', 'ue'];
      if (delayProfile) argv.push('--delay-profile', delayProfile);
      setExporting(true); s.setLogOpen && s.setLogOpen(true);
      s.pushLog({ lv: 'info', cat: 'export', msg: '导出 · <b>vpcal export opentrackio</b>' + (delayProfile ? ' · --delay-profile' : '') });
      try {
        const r = await spawnSidecar('vpcal', argv.concat(['--output', 'json']));
        const env = parseEnvelope(r); if (env && env.status === 'error') throw new Error(env.error && env.error.message);
        const dd = env && env.data;
        s.pushLog({ lv: 'ok', cat: 'export', msg: dd ? `导出完成 · ${dd.samples} 样本${dd.applied_delay_ms != null ? ` · 延迟补偿 ${dd.applied_delay_ms.toFixed(1)} ms` : ''} → ${baseName(dd.output || outPath)}` : '导出完成' });
      } catch (e) { s.pushLog({ lv: 'err', cat: 'export', msg: `导出失败 · ${e && e.message ? e.message : e}` }); }
      finally { setExporting(false); }
    };
    const fmt = (t) => `X ${t.x}  Y ${t.y}  Z ${t.z}\nPan ${t.pan}  Tilt ${t.tilt}  Roll ${t.roll}`;
    const blockText = `# frame=${B.world_frame} · ${B.rotation_convention}\n[camera transform · hand-eye]\n${fmt(B.camera)}\n[world transform · alignment]\n${fmt(B.world)}`;
    return h(React.Fragment, null,
      h('div', { className: 'canvas-head' }, h('span', { className: 't' }, '历史与导出'),
        isTauri() ? h(PathChip, { path: runsRoot, onPick: pickRuns, label: '选择 runs 根目录' }) : null,
        h('div', { className: 'right' },
          loadingRuns ? h('span', { className: 'toolchip' }, h(Icon, { name: 'sync', size: 13 }), '扫描中…') : null,
          h('span', { className: 'toolchip' }, rows.length + ' 次求解' + (isRealRuns ? '' : '（示例）')))),
      h('div', { className: 'lwrap cal-scroll' },
        runsErr ? h('div', { style: { marginBottom: 10 } }, h(InlineAlert, { variant: 'negative', title: '扫描 runs 失败' }, runsErr)) : null,
        (isTauri() && !isRealRuns) ? h('div', { style: { marginBottom: 10 } },
          h(InlineAlert, { variant: 'informative', title: '当前为示例历史' },
            'vpcal quick run 无 runs 注册表——选一个「runs 根目录」，将扫描其下各 output_dir/result.json 汇总真实求解历史（map / 延迟不在 result.json 内，显示 n/a）。')) : null,
        (isRealRuns && !rows.length) ? h('div', { style: { marginBottom: 10 } },
          h(InlineAlert, { variant: 'notice', title: '该目录下无求解' }, '未在所选目录（含直接子目录）找到 result.json。')) : null,
        /* 历史表 */
        h('div', { className: 'ar-runtable' },
          h('div', { className: 'ar-rt-head' }, h('span', null, '时间'), h('span', null, 'marker map'), h('span', null, 'RMS'), h('span', null, 'validation'), h('span', null, 'confidence'), h('span', null, '延迟')),
          rows.map((r) => { const c = AR_CONF[r.confidence] || AR_CONF.low || { tone: 'notice', label: r.confidence }; return h('div', { key: r.id, className: 'ar-rt-row' },
            h('span', { className: 'dim' }, r.time), h('span', { className: 'mono' }, r.map || 'n/a'),
            h('span', null, pxBadge(r.rms)), h('span', null, pxBadge(r.val_rms)),
            h('span', null, h(Pill, { tone: c.tone, icon: c.tone === 'positive' ? 'check' : c.tone === 'negative' ? 'x' : 'alert' }, c.label)),
            h('span', { className: 'mono dim' }, r.delay != null ? '+' + r.delay.toFixed(1) + ' ms' : 'n/a')); })),
        /* 导出面板 */
        h('div', { className: 'surv-sub' }, '导出'),
        h('div', { className: 'ar-export' },
          h('div', { className: 'ar-exp-main' },
            h('div', { className: 'ar-exp-h' }, h(Icon, { name: 'download', size: 15 }), 'OpenTrackIO JSONL', h('span', { className: 'ar-exp-tag' }, '主导出')),
            h('div', { className: 'ar-exp-toggle' },
              h('div', null, h('div', { className: 'cap-tg-t' }, '应用延迟补偿'),
                h('div', { className: 'cap-tg-s' }, compDelay ? '--delay-profile · 时间戳已补偿 · vpcal 打防双重补偿标记' : '导出原始时间戳')),
              h(Switch, { isSelected: compDelay, onChange: setCompDelay })),
            h(Button, { variant: 'accent', size: 'S', isDisabled: exporting, icon: h(Icon, { name: 'download', size: 14 }),
              onPress: runExport }, exporting ? '导出中…' : '导出 JSONL'),
            h('div', { className: 'ar-exp-hidden' }, h(Icon, { name: 'info', size: 13 }), 'nDisplay 导出在 AR 模式隐藏（无屏可导）')),
          /* Tracker 回填偏移块 */
          h('div', { className: 'ar-backfill' },
            h('div', { className: 'ar-bf-h' },
              h('div', null, h(Icon, { name: 'copy', size: 15 }), ' Tracker 回填偏移块',
                h('span', { className: 'ar-bf-sub' }, 'frame=' + B.world_frame + ' · ' + B.rotation_convention)),
              h('button', { className: 'ar-copy-btn' + (copied ? ' done' : ''), onClick: () => copyText(blockText, () => { setCopied(true); setTimeout(() => setCopied(false), 1400); }) },
                h(Icon, { name: copied ? 'check' : 'copy', size: 13 }), copied ? '已复制' : '复制全部')),
            h('div', { className: 'ar-bf-grid' },
              [['camera transform · hand-eye', B.camera], ['world transform · alignment', B.world]].map(([t, tr]) =>
                h('div', { key: t, className: 'ar-bf-col' },
                  h('div', { className: 'ar-bf-t' }, t),
                  h('div', { className: 'ar-bf-nums' },
                    [['X', tr.x, 'mm'], ['Y', tr.y, 'mm'], ['Z', tr.z, 'mm'], ['Pan', tr.pan, '°'], ['Tilt', tr.tilt, '°'], ['Roll', tr.roll, '°']].map(([k, v, u]) =>
                      h('div', { key: k, className: 'ar-bf-n' }, h('span', { className: 'bk' }, k), h('span', { className: 'bv' }, v), h('span', { className: 'bu' }, u))))))),
            h('div', { className: 'ar-bf-foot' }, '现场直接抄进 FreeD 追踪设备（EZtrack 等），让追踪输出自带校正。')))));
  }

  /* =================== center router =================== */
  function center(s) {
    const map = { markers: markersView, lens: lensView, spatial: spatialView, delay: delayView, verify: verifyView, runs: runsView };
    const View = map[s.calArStep] || markersView;
    return h('div', { className: 'dash cal-dash' },
      overview(s),
      h('div', { className: 'dash-card cal-stage-card' }, h(View, { s })));
  }

  /* =================== inspector =================== */
  function inspector(s) {
    const sel = s.calSel;
    if (sel && sel.type === 'armarker') {
      const m = AR_MARKERS.list.find((x) => x.id === sel.id);
      if (m) return h(React.Fragment, null,
        h('div', { className: 'insp-head' },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 } },
            h('span', { className: 'step-ico' }, h(Icon, { name: 'pin', size: 16 })),
            h('h2', { style: { margin: 0, fontSize: 15, fontWeight: 700, fontFamily: 'var(--font-code)' } }, 'marker id ' + m.id)),
          h('span', { className: 'cap-pill cap-pill--' + (m.on_ground ? 'positive' : 'neutral') }, h(Icon, { name: m.on_ground ? 'check' : 'minus', size: 13 }), m.on_ground ? 'on_ground' : '非地面')),
        h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, '类型'),
          h('div', { className: 'kv' }, h('span', { className: 'k' }, 'dict'), h('span', { className: 'v mono' }, m.dict)),
          h('div', { className: 'kv' }, h('span', { className: 'k' }, 'survey_source'), h('span', { className: 'v mono' }, m.survey_source)),
          h('div', { className: 'kv' }, h('span', { className: 'k' }, 'uncertainty_mm'), h('span', { className: 'v mono' }, '±' + m.uncertainty_mm.toFixed(1)))),
        h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, '四角坐标 (mm)'),
          m.corners.map((c, i) => h('div', { key: i, className: 'kv' }, h('span', { className: 'k' }, 'c' + i), h('span', { className: 'v mono' }, '[' + c.join(', ') + ']')))));
    }
    return h('div', { className: 'insp-empty' },
      h('div', { className: 'ph' }, h(Icon, { name: 'target', size: 30 })),
      h('div', null, h('div', { style: { color: 'var(--chrome-dim)', fontWeight: 600, marginBottom: 4 } }, 'AR 校正'), '在 Markers 步选择 marker 查看真值详情'));
  }

  window.VOLO_CAL_AR = { markerMapSelector, left, center, inspector };
})();
