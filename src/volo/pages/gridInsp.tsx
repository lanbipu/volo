// @ts-nocheck
/* Volo — 网格校正工作区 · 右侧上下文检查器（gridInsp.tsx）
   1:1 port of the Claude Design handoff `src/grid_insp.jsx`。
   屏幕建模表单读写真实 ScreenConfig（cabinet_count/cabinet_size_mm/
   pixels_per_cabinet/shape_prior/shape_mode/irregular_mask/bottom_completion/
   position_m/yaw_deg），本地草稿 + 显式保存（同 pages/calDesign.tsx 的既定手法：
   s.calDraftScreen 非 null = 有未保存改动，保存走 saveProjectYaml + 回读校验）。
   箱体选中/run 质量指标/阶段动作面板同样只读写真实数据，无自造 mock。 */
import * as React from "react";
import { saveProjectYaml, setRunCurrent, getRunReport } from "../api/meshCommands";
import { meshVisualGeneratePattern } from "../api/meshVisualCommands";

(function () {
  const { Button, Switch } = window.Spectrum2DesignSystem_b6d1b3;
  const { useState, useRef, useEffect } = React;
  const h = React.createElement;
  const CX = window.VOLO_CAL2;
  const ROLE = (window.VOLO_GRID && window.VOLO_GRID.ROLE) || {};

  /* ---------- 原子 ---------- */
  function Fold({ n, label, defOpen, children }) {
    const [open, setOpen] = useState(defOpen !== false);
    return h('div', { className: 'gw-grp' },
      h('button', { className: 'gw-grp-h', onClick: () => setOpen((v) => !v) },
        n ? h('span', { className: 'num' }, n) : null, h('span', null, label),
        h('span', { className: 'car' + (open ? '' : ' closed') }, h(Icon, { name: 'chevd', size: 14 }))),
      open ? h('div', { className: 'gw-grp-body' }, children) : null);
  }
  const Field = (lb, ctrl, opts) => h('div', { className: 'gw-field' + (opts && opts.err ? ' err' : '') + (opts && opts.stack ? ' stack' : '') },
    h('span', { className: 'lb' }, lb, opts && opts.hint ? h('span', { className: 'hint' }, opts.hint) : null), ctrl);

  function NumInput({ value, onChange, w, min, max, step }) {
    return h('input', { className: 'gw-num', type: 'number', value: value, min, max, step: step || 1, style: w ? { width: w } : null,
      onChange: (e) => { const v = e.target.value === '' ? 0 : (step && step < 1 ? parseFloat(e.target.value) : parseInt(e.target.value, 10)); onChange(v); } });
  }
  function Dual({ a, b, oa, ob, unit }) {
    return h('span', { className: 'gw-dual' }, h(NumInput, { value: a, onChange: oa }), h('span', { className: 'x' }, '×'), h(NumInput, { value: b, onChange: ob }), unit ? h('span', { className: 'gw-unit' }, unit) : null);
  }
  function Sel({ value, options, onChange, w }) {
    const [open, setOpen] = useState(false);
    const ref = useRef(null);
    useEffect(() => { if (!open) return undefined; const fn = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }; document.addEventListener('mousedown', fn); return () => document.removeEventListener('mousedown', fn); }, [open]);
    const cur = options.find((o) => o.id === value) || options[0];
    return h('div', { ref, style: { position: 'relative' } },
      h('button', { className: 'gw-selbtn', style: w ? { minWidth: w } : null, onClick: () => setOpen((v) => !v) }, h('span', null, cur ? cur.label : '—'), h(Icon, { name: 'chevd', size: 14 })),
      open ? h('div', { className: 'popover', style: { left: 0, right: 0, top: 'calc(100% + 4px)' } },
        options.map((o) => h('div', { key: o.id, className: 'pop-i' + (o.id === value ? ' on' : ''), onClick: () => { onChange(o.id); setOpen(false); } },
          h('span', { className: 'pop-l' }, o.label), o.id === value ? h('span', { style: { marginLeft: 'auto', color: 'var(--volo-500)', display: 'flex' } }, h(Icon, { name: 'check', size: 14 })) : null))) : null);
  }

  const head = (icon, title, sub, pill) => h('div', { className: 'gw-insp-head' },
    h('span', { className: 'gw-insp-ic' }, h(Icon, { name: icon, size: 16 })),
    h('div', { className: 'gw-insp-tt' }, h('h2', null, title), sub ? h('div', { className: 'sub' }, sub) : null),
    pill || null);

  /* ================= 屏幕建模参数表单 ================= */
  function ScreenForm({ s, noHead }) {
    const proj = CX.useProj();
    const screenId = s.calActiveScreen;
    const real = proj.config && proj.config.screens[screenId];
    /* 草稿在切屏 / 保存回读后清空（proj.config 引用变化即视为"已同步"）。 */
    useEffect(() => { s.setCalDraftScreen(null); }, [screenId, proj.config]);
    const [saving, setSaving] = useState(false);
    if (!real) return null;
    const m = s.calDraftScreen || real;
    const dirty = !!s.calDraftScreen;
    const set = (patch) => s.setCalDraftScreen(Object.assign({}, m, patch));
    const setShape = (patch) => set({ shape_prior: Object.assign({}, m.shape_prior, patch) });
    const cols = m.cabinet_count[0], rows = m.cabinet_count[1];
    const totalCols = cols;
    const shapeId = m.shape_prior.type;
    const shape = GRID_SHAPES.find((x) => x.id === shapeId) || GRID_SHAPES[0];

    const doSave = async () => {
      if (!proj.path || saving) return;
      setSaving(true);
      try {
        const nextConfig = Object.assign({}, proj.config, { screens: Object.assign({}, proj.config.screens, { [screenId]: m }) });
        await s.runCmd({ domain: 'calibrate', action: '保存屏幕设计', target: screenId, chan: 'local' },
          () => saveProjectYaml(proj.path, nextConfig), { okMsg: () => `已保存 <b>${screenId}</b> 的设计改动` });
        await CX.openProjectPath(proj.path, s);
      } catch (e) { /* runCmd 已记录失败 */ } finally { setSaving(false); }
    };

    /* L 形右面列数 / U 形中段列数：只读派生值 */
    let derivedNote = null;
    if (shapeId === 'l_shape') {
      const right = totalCols - (m.shape_prior.left_cols || 0) - (m.shape_prior.soften_cols || 0);
      derivedNote = Field('右面列数（派生）', h('span', { className: 'gw-unit', style: { fontFamily: 'var(--font-code)', fontSize: 12.5, color: right >= 1 ? 'var(--chrome-text)' : 'var(--negative-visual)' } }, right + ' 列'));
    } else if (shapeId === 'u_shape') {
      const center = totalCols - 2 * ((m.shape_prior.wing_cols || 0) + (m.shape_prior.soften_cols || 0));
      derivedNote = Field('中段列数（派生）', h('span', { className: 'gw-unit', style: { fontFamily: 'var(--font-code)', fontSize: 12.5, color: center >= 1 ? 'var(--chrome-text)' : 'var(--negative-visual)' } }, center + ' 列'));
    }

    const shapeFields = shape.fields.map((f) => React.cloneElement(Field(f.label,
      h(NumInput, { value: m.shape_prior[f.k] != null ? m.shape_prior[f.k] : 0, onChange: (v) => setShape({ [f.k]: v }), min: f.min, max: f.max, step: f.step })), { key: f.k }));

    const wM = (cols * m.cabinet_size_mm[0] / 1000), hM = (rows * m.cabinet_size_mm[1] / 1000);
    const maskedN = (m.irregular_mask || []).length;
    const cabTotal = cols * rows - maskedN;
    const pxW = m.pixels_per_cabinet ? m.pixels_per_cabinet[0] : 0, pxH = m.pixels_per_cabinet ? m.pixels_per_cabinet[1] : 0;

    return h(React.Fragment, null,
      noHead ? null : head('panel', screenId, cols + '×' + rows, h('span', { className: 'spill spill--informative' }, h(Icon, { name: 'check', size: 12 }), '对象')),
      h(Fold, { n: '①', label: '标识' },
        Field('屏幕名', h('span', { className: 'gw-unit', style: { fontFamily: 'var(--font-code)', fontSize: 12.5, color: 'var(--chrome-text)' } }, screenId), { hint: '重命名请在场景树右键屏幕节点' })),
      h(Fold, { n: '②', label: '箱体预设' },
        Field('预设', h(Sel, {
          value: m.__cabPreset || 'custom',
          options: GRID_CAB_PRESETS.map((p) => ({ id: p.id, label: p.label })),
          onChange: (id) => { const p = GRID_CAB_PRESETS.find((x) => x.id === id); set(id === 'custom' ? { __cabPreset: id } : { __cabPreset: id, cabinet_size_mm: [p.w, p.h], pixels_per_cabinet: [p.px, p.pxh] }); },
          w: 150,
        })),
        Field('尺寸', h(Dual, { a: m.cabinet_size_mm[0], b: m.cabinet_size_mm[1], oa: (v) => set({ cabinet_size_mm: [v, m.cabinet_size_mm[1]] }), ob: (v) => set({ cabinet_size_mm: [m.cabinet_size_mm[0], v] }), unit: 'mm' })),
        Field('像素', h(Dual, { a: pxW, b: pxH, oa: (v) => set({ pixels_per_cabinet: [v, pxH] }), ob: (v) => set({ pixels_per_cabinet: [pxW, v] }), unit: 'px' }))),
      h(Fold, { n: '③', label: '布局' },
        Field('列数', h(NumInput, { value: cols, onChange: (v) => set({ cabinet_count: [Math.max(1, v), rows] }), min: 1, max: 200 })),
        Field('行数', h(NumInput, { value: rows, onChange: (v) => set({ cabinet_count: [cols, Math.max(1, v)] }), min: 1, max: 100 }))),
      h(Fold, { n: '④', label: '形状' },
        h('div', { className: 'gw-shape-grid' }, GRID_SHAPES.map((sh) => h('button', { key: sh.id, className: 'gw-shape' + (shapeId === sh.id ? ' on' : ''), onClick: () => set({ shape_prior: defaultShapeFor(sh.id) }) },
          h(Icon, { name: sh.icon, size: 18 }), h('span', { className: 't' }, sh.label)))),
        shapeFields.length ? h('div', { style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 } }, shapeFields) : null,
        derivedNote,
        shapeId === 'custom_segments' ? h(SegEditor, { s, m, set, totalCols }) : null,
        shapeId === 'folded' ? h(FoldSeamEditor, { m, setShape, totalCols }) : null),
      h(Fold, { n: '⑤', label: '变换' },
        Field('位置 X', h('span', { className: 'gw-dual' }, h(NumInput, { value: m.position_m[0], onChange: (v) => set({ position_m: [v, m.position_m[1], m.position_m[2]] }), step: 0.1 }), h('span', { className: 'gw-unit' }, 'm'))),
        Field('位置 Y', h('span', { className: 'gw-dual' }, h(NumInput, { value: m.position_m[1], onChange: (v) => set({ position_m: [m.position_m[0], v, m.position_m[2]] }), step: 0.1 }), h('span', { className: 'gw-unit' }, 'm'))),
        Field('位置 Z', h('span', { className: 'gw-dual' }, h(NumInput, { value: m.position_m[2], onChange: (v) => set({ position_m: [m.position_m[0], m.position_m[1], v] }), step: 0.1 }), h('span', { className: 'gw-unit' }, 'm'))),
        Field('朝向角', h('span', { className: 'gw-dual' }, h(NumInput, { value: m.yaw_deg, onChange: (v) => set({ yaw_deg: v }), min: -180, max: 180 }), h('span', { className: 'gw-unit' }, '°')))),
      h(Fold, { n: '⑥', label: '派生信息 · 只读', defOpen: false },
        h('div', { className: 'gw-derived' },
          h('div', { className: 'gw-dcell' }, h('div', { className: 'k' }, '整屏尺寸'), h('div', { className: 'v' }, wM.toFixed(2) + ' × ' + hM.toFixed(2), h('span', { className: 'u' }, 'm'))),
          h('div', { className: 'gw-dcell' }, h('div', { className: 'k' }, '像素画布'), h('div', { className: 'v', style: { fontSize: 12.5 } }, (cols * pxW) + ' × ' + (rows * pxH))),
          h('div', { className: 'gw-dcell' }, h('div', { className: 'k' }, '箱体总数'), h('div', { className: 'v' }, cabTotal, maskedN ? h('span', { className: 'u' }, '（遮罩 ' + maskedN + '）') : null)),
          h('div', { className: 'gw-dcell' }, h('div', { className: 'k' }, '顶点网格规模'), h('div', { className: 'v', style: { fontSize: 13 } }, (cols + 1) + ' × ' + (rows + 1))))),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 2px 4px', borderTop: '1px solid var(--chrome-line)' } },
        dirty ? h('span', { style: { fontSize: 11, color: 'var(--notice-visual)', display: 'flex', alignItems: 'center', gap: 5 } }, h('span', { className: 'gw-dcell', style: { width: 6, height: 6, borderRadius: '50%', padding: 0, background: 'var(--notice-visual)' } }), '未保存') : null,
        h('div', { style: { flex: 1 } }),
        dirty ? h(Button, { variant: 'secondary', size: 'S', onPress: () => s.setCalDraftScreen(null) }, '撤销') : null,
        h(Button, { variant: dirty ? 'accent' : 'secondary', size: 'S', isDisabled: !dirty || saving, icon: h(Icon, { name: saving ? 'sync' : 'check', size: 13 }), onPress: doSave }, saving ? '保存中…' : '保存')));
  }

  function defaultShapeFor(id) {
    if (id === 'curved') return { type: 'curved', radius_mm: 10000, fold_seams_at_columns: [] };
    if (id === 'folded') return { type: 'folded', fold_seams_at_columns: [] };
    if (id === 'arc') return { type: 'arc', center_flat_cols: 2, angle_per_col_deg: 9 };
    if (id === 'l_shape') return { type: 'l_shape', left_cols: 4, soften_cols: 1, corner_angle_deg: 90 };
    if (id === 'u_shape') return { type: 'u_shape', wing_cols: 3, soften_cols: 1, corner_angle_deg: 90 };
    if (id === 'custom_segments') return { type: 'custom_segments', segments: [{ cols: 1, cum_angle_deg: 0 }] };
    return { type: 'flat' };
  }

  function SegEditor({ s, m, set, totalCols }) {
    const segs = m.shape_prior.segments || [];
    const segSum = segs.reduce((a, g) => a + (g.cols || 0), 0);
    const segOk = segSum === totalCols;
    const setSegs = (segments) => set({ shape_prior: Object.assign({}, m.shape_prior, { segments }) });
    const upd = (i, k, v) => setSegs(segs.map((g, j) => j === i ? Object.assign({}, g, { [k]: v }) : g));
    return h('div', { style: { marginTop: 8 } },
      h('div', { className: 'gw-seg-list' }, segs.map((g, i) => h('div', { key: i, className: 'gw-seg-row' },
        h('div', { className: 'fx' }, h('span', { className: 'k' }, '列数'), h(NumInput, { value: g.cols, onChange: (v) => upd(i, 'cols', v), w: 52, min: 1 })),
        h('div', { className: 'fx' }, h('span', { className: 'k' }, '累计转角°'), h(NumInput, { value: g.cum_angle_deg, onChange: (v) => upd(i, 'cum_angle_deg', v), w: 58 })),
        h('button', { className: 'rm', onClick: () => setSegs(segs.filter((_, j) => j !== i)), title: '删除段' }, h(Icon, { name: 'trash', size: 13 }))))),
      h(Button, { variant: 'secondary', size: 'S', icon: h(Icon, { name: 'plus', size: 13 }), onPress: () => setSegs([...segs, { cols: 1, cum_angle_deg: segs.length ? segs[segs.length - 1].cum_angle_deg : 0 }]) }, '加段'),
      h('div', { className: 'gw-seg-valid ' + (segOk ? 'ok' : 'bad') }, h(Icon, { name: segOk ? 'check' : 'alert', size: 12 }), '段列和 ' + segSum + ' / 总列数 ' + totalCols + (segOk ? ' · 一致' : ' · 不一致')));
  }

  function FoldSeamEditor({ m, setShape, totalCols }) {
    const seams = m.shape_prior.fold_seams_at_columns || [];
    const toggle = (c) => { const set_ = new Set(seams); set_.has(c) ? set_.delete(c) : set_.add(c); setShape({ fold_seams_at_columns: [...set_].sort((a, b) => a - b) }); };
    return h('div', { style: { marginTop: 8 } },
      h('div', { style: { fontSize: 11, color: 'var(--chrome-faint)', marginBottom: 6 } }, '折缝列（1..' + (totalCols - 1) + '）'),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4 } }, Array.from({ length: totalCols - 1 }, (_, i) => i + 1).map((c) => h('button', {
        key: c, className: 'gw-shape', style: { padding: '4px 8px', minWidth: 0 }, onClick: () => toggle(c),
        title: '列 ' + c,
      }, h('span', { className: seams.includes(c) ? 't' : '', style: { color: seams.includes(c) ? 'var(--volo-400)' : 'var(--chrome-faint)' } }, c)))));
  }

  /* ================= 箱体单选 / 多选 ================= */
  function BoxSingle({ s }) {
    const proj = CX.useProj();
    const sel = s.calSel;
    const screenId = s.calActiveScreen;
    const real = proj.config && proj.config.screens[screenId];
    const m = s.calDraftScreen || real;
    if (!m) return null;
    const key = sel.c + ',' + sel.r;
    const isMasked = (m.irregular_mask || []).some(([c, r]) => c === sel.c && r === sel.r);
    const coord = proj.config.coordinate_system;
    const role = window.VOLO_GRID.roleAtCabinet(coord, screenId, sel.c, sel.r);
    const rect = m.shape_mode !== 'irregular';
    const setMask = (v) => {
      const set_ = (m.irregular_mask || []).filter(([c, r]) => !(c === sel.c && r === sel.r));
      if (v) set_.push([sel.c, sel.r]);
      s.setCalDraftScreen(Object.assign({}, m, { irregular_mask: set_ }));
    };
    return h(React.Fragment, null,
      head('grid', 'Cabinet ' + sel.c + ',' + sel.r, 'V' + String(sel.c + 1).padStart(2, '0') + '_R' + String(sel.r + 1).padStart(2, '0'),
        h('span', { className: 'spill spill--' + (isMasked ? 'neutral' : role ? 'positive' : 'informative') }, h(Icon, { name: role ? 'pin' : isMasked ? 'panel' : 'check', size: 12 }), role ? '参考点' : isMasked ? '遮罩' : '正常')),
      h(Fold, { label: '位置' },
        Field('列 (col)', h('span', { className: 'gw-unit', style: { fontFamily: 'var(--font-code)', color: 'var(--chrome-text)', fontSize: 13 } }, sel.c)),
        Field('行 (row)', h('span', { className: 'gw-unit', style: { fontFamily: 'var(--font-code)', color: 'var(--chrome-text)', fontSize: 13 } }, sel.r))),
      !role ? h(Fold, { label: '遮罩' },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
          h('div', null, h('div', { style: { fontSize: 12.5, color: 'var(--chrome-dim)' } }, '遮罩此格'), h('div', { style: { fontSize: 10.5, color: 'var(--chrome-faint)' } }, isMasked ? '不参与重建' : '参与重建')),
          h(Switch, { isSelected: isMasked, isDisabled: rect, onChange: setMask })),
        rect ? h('div', { style: { fontSize: 11, color: 'var(--chrome-faint)', marginTop: 6 } }, '规则矩形屏遮罩不生效，需先在「形状」把「屏幕类别」相关 shape_mode 切到异形（此仓设计上 shape_mode 与遮罩联动，见箱体工具条提示）。') : null) : null,
      role ? h(Fold, { label: '坐标系角色 · coordinate_system' },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
          h('span', { style: { width: 11, height: 11, borderRadius: '50%', background: (ROLE[role] || {}).color } }),
          h('b', { style: { fontFamily: 'var(--font-code)', fontSize: 13 } }, (ROLE[role] || {}).label))) : null);
  }

  function BoxMulti({ s }) {
    const proj = CX.useProj();
    const sel = s.calSel;
    const real = proj.config && proj.config.screens[s.calActiveScreen];
    const m = s.calDraftScreen || real;
    const keys = sel.keys || [];
    const masked = new Set((m.irregular_mask || []).map(([c, r]) => c + ',' + r));
    const nMasked = keys.filter((k) => masked.has(k)).length;
    const batch = (on) => {
      const set_ = new Set(m.irregular_mask ? m.irregular_mask.map(([c, r]) => c + ',' + r) : []);
      keys.forEach((k) => on ? set_.add(k) : set_.delete(k));
      s.setCalDraftScreen(Object.assign({}, m, { irregular_mask: [...set_].map((k) => k.split(',').map(Number)) }));
    };
    return h(React.Fragment, null,
      head('grid', '已选 ' + keys.length + ' 个箱体', '批量操作', h('span', { className: 'spill spill--informative' }, h(Icon, { name: 'check', size: 12 }), '多选')),
      h(Fold, { label: '选区统计' },
        Field('已选', h('b', { style: { fontFamily: 'var(--font-code)' } }, keys.length)),
        Field('其中遮罩', h('b', { style: { fontFamily: 'var(--font-code)' } }, nMasked))),
      h(Fold, { label: '批量遮罩' },
        h('div', { style: { display: 'flex', gap: 8 } },
          h(Button, { variant: 'accent', size: 'S', icon: h(Icon, { name: 'panel', size: 13 }), isDisabled: m.shape_mode !== 'irregular', onPress: () => batch(true) }, '全部遮罩'),
          h(Button, { variant: 'secondary', size: 'S', icon: h(Icon, { name: 'x', size: 13 }), onPress: () => batch(false) }, '取消遮罩'))));
  }

  /* ================= 重建 run 质量 ================= */
  function RunInsp({ s }) {
    const proj = CX.useProj();
    const r = (proj.runs || []).find((x) => x.id === s.calSel.id);
    const [report, setReport] = useState(null);
    useEffect(() => {
      if (!s.calSel || s.calSel.type !== 'run') return undefined;
      let alive = true;
      getRunReport(s.calSel.id).then((rep) => { if (alive) setReport(rep); }).catch(() => {});
      return () => { alive = false; };
    }, [s.calSel && s.calSel.id]);
    if (!r) return CX.inspEmpty('选择一次重建查看报告');
    const qm = report ? report.quality_metrics : null;
    const metric = (k, v, unit, exp, tone) => h('div', { className: 'gw-metric' },
      h('div', { className: 'k' }, k), h('div', { className: 'v', style: tone ? { color: 'var(--' + tone + '-visual)' } : null }, v, unit ? h('span', { style: { fontSize: 11, color: 'var(--chrome-faint)', marginLeft: 3 } }, unit) : null), h('div', { className: 'exp' }, exp));
    const rms = r.estimated_rms_mm;
    const rtone = rms == null ? null : rms < 1 ? 'positive' : rms < 3 ? 'notice' : 'negative';
    const KV = (k, v) => h('div', { className: 'gw-field', style: { minHeight: 24 } }, h('span', { className: 'lb', style: { fontFamily: 'var(--font-code)', fontSize: 11.5 } }, k), h('span', { style: { fontSize: 12, color: 'var(--chrome-text)', fontFamily: 'var(--font-code)', textAlign: 'right' } }, v));
    const setCurrent = async () => {
      try {
        await s.runCmd({ domain: 'calibrate', action: '设为当前 run', target: 'run #' + r.id, chan: 'local' }, () => setRunCurrent(r.id), { okMsg: () => `run #${r.id} 已设为当前` });
        await CX.reloadRuns(proj.path, s.calActiveScreen);
      } catch (e) { /* runCmd 已记录失败 */ }
    };
    return h(React.Fragment, null,
      head('cube3', 'run #' + r.id, r.created_at, r.is_current ? h('span', { className: 'spill spill--positive' }, h(Icon, { name: 'check', size: 12 }), '当前') : null),
      h(Fold, { label: '质量指标' },
        qm ? h('div', { className: 'gw-metrics' },
          metric('RMS', rms == null ? 'n/a' : rms.toFixed(2), rms == null ? null : 'mm', '交叉验证真值：整体拟合优度', rtone),
          metric('middle_max_dev', qm.middle_max_dev_mm.toFixed(2), 'mm', '中段最大偏差'),
          metric('顶点数', r.vertex_count ? (r.vertex_count / 1000).toFixed(1) + 'k' : '—', null, '重建网格顶点规模'),
          metric('measured/expected', qm.measured_count + '/' + qm.expected_count, null, '实测/期望点数占比')) : h('div', { style: { fontSize: 11.5, color: 'var(--chrome-faint)' } }, '加载中…')),
      h(Fold, { label: '元信息' },
        KV('method', r.method), KV('screen', r.screen_id), KV('时间', r.created_at), KV('产物', r.output_obj_path || '未导出')),
      h(Fold, { label: '动作' },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          h('div', { style: { display: 'flex', gap: 8 } },
            h(Button, { variant: 'secondary', size: 'S', icon: h(Icon, { name: 'eye', size: 13 }), onPress: () => { CX.viewRunInPreview(s, proj, r.id); s.setCalMeshVersion('rebuilt'); } }, '在视口中查看'),
            h(Button, { variant: 'secondary', size: 'S', icon: h(Icon, { name: 'star', size: 13 }), isDisabled: r.is_current, onPress: setCurrent }, '设为当前')),
          h('div', { style: { display: 'flex', gap: 8 } },
            h(Button, { variant: 'secondary', size: 'S', icon: h(Icon, { name: 'layers', size: 13 }), onPress: () => s.setCalMeshVersion('overlay') }, '与另一 run 比对'),
            h(Button, { variant: 'accent', size: 'S', icon: h(Icon, { name: 'external', size: 13 }), onPress: () => s.setModal({ wide: true, render: ({ close }) => window.VOLO_GRID_MODALS.exportDlg(s, close) }) }, '导出')))));
  }

  /* ================= 测试图面板 ================= */
  function PatternPanel({ s }) {
    const proj = CX.useProj();
    const screenId = s.calActiveScreen;
    const [scheme, setScheme] = useState('charuco');
    const [prog, setProg] = useState(0);
    const hasPattern = !!(proj.patternGenByScreen && proj.patternGenByScreen[screenId]);
    const runGen = async () => {
      setProg(1);
      try {
        const r = await meshVisualGeneratePattern(proj.path, screenId, scheme, 1, null);
        CX.projStore.patch({ patternGenByScreen: Object.assign({}, proj.patternGenByScreen, { [screenId]: true }) });
        s.setCalReceipt({ tone: 'ok', text: `已生成测试图 · ${r.cabinet_count} 箱体` });
        setProg(100);
      } catch (e) { s.pushLog({ lv: 'err', cat: 'calibrate', msg: `测试图生成失败 · ${e && e.message ? e.message : e}` }); setProg(0); }
    };
    return h(React.Fragment, null,
      head('grid', '测试图', 'ChArUco 校正图案',
        hasPattern ? h('span', { className: 'spill spill--positive' }, h(Icon, { name: 'check', size: 12 }), '已生成') : null),
      h(Fold, { label: '参数' },
        Field('图案方案', h(Sel, { value: scheme, options: [{ id: 'charuco', label: 'ChArUco' }, { id: 'dense', label: '密集编码点' }], onChange: setScheme, w: 150 })),
        Field('目标屏幕', h('span', { style: { fontSize: 12.5, color: 'var(--chrome-text)', fontFamily: 'var(--font-code)' } }, screenId))),
      prog > 0 && prog < 100
        ? h('div', { className: 'gw-grp-body' }, h('div', { style: { fontSize: 11.5, color: 'var(--chrome-dim)', marginBottom: 6 } }, '生成中…'))
        : h('div', { className: 'gw-grp-body' }, h(Button, { variant: hasPattern ? 'secondary' : 'accent', size: 'M', icon: h(Icon, { name: hasPattern ? 'sync' : 'grid', size: 15 }), onPress: runGen }, hasPattern ? '重新生成测试图' : '生成测试图')),
      hasPattern ? h(Fold, { label: '去向' },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          h(Button, { variant: 'secondary', size: 'S', icon: h(Icon, { name: 'eye', size: 13 }), onPress: () => s.setCalDisplay(Object.assign({}, s.calDisplay, { pattern: true })) }, '在视口中预览'))) : null);
  }

  /* ================= 全局校正细节选项（无选中默认） ================= */
  function GlobalOptions({ s }) {
    return h(React.Fragment, null,
      head('sliders', '校正细节选项', '全局默认 · 可忽略'),
      h('div', { className: 'gw-optnote' }, h(Icon, { name: 'info', size: 13, style: { verticalAlign: '-2px', marginRight: 5 } }), '未选中任何对象。标定/重建方法在「测量导入」流程内按需选择，此处无需额外配置。'));
  }

  /* ================= 阶段动作面板（顶部重建方法 + 折叠子项） ================= */
  function StagePanel({ s }) {
    const proj = CX.useProj();
    const screenId = s.calActiveScreen;
    const m = proj.config && proj.config.screens[screenId];
    const built = s.calScreenReports && !!s.calScreenReports[screenId];
    const [method, setMethod] = useState('totalstation');
    const isTS = method === 'totalstation';
    const newShapeVisualBlocked = m && GRID_MEAS_TYPES.find((x) => x.id === 'visual').disabledForShapes.includes(m.shape_prior.type);
    const measured = isTS ? !!proj.measurementsAbsPath : !!(proj.visualSession && proj.visualSession.screenId === screenId);
    const [target, setTarget] = useState('disguise');

    return h('div', { className: 'gw-stages' },
      h('div', { className: 'gw-method' },
        h('div', { className: 'gw-method-h' }, h(Icon, { name: 'tools', size: 13 }), '重建方法'),
        h('div', { className: 'gw-method-seg' },
          GRID_MEAS_TYPES.map((t) => h('button', { key: t.id, className: method === t.id ? 'on' : '', disabled: t.id === 'visual' && newShapeVisualBlocked, title: t.id === 'visual' && newShapeVisualBlocked ? t.disabledMsg : '', onClick: () => setMethod(t.id) },
            h(Icon, { name: t.icon, size: 14 }), t.label))),
        h('div', { className: 'gw-method-note' }, isTS ? t_isTsNote() : (newShapeVisualBlocked ? GRID_MEAS_TYPES.find((x) => x.id === 'visual').disabledMsg : '屏幕显示测试图 + 摄影机多角度拍摄，自动稠密重建。')),
      ),
      h('div', { className: 'gw-stages-h' }, h(Icon, { name: 'bolt', size: 13 }), '阶段动作'),
      h(Fold, { label: '屏幕设计', defOpen: false }, h(ScreenForm, { s, noHead: true })),
      h(Fold, { label: '测量导入', defOpen: false },
        isTS ? (window.VOLO_GRID.flows ? window.VOLO_GRID.flows.total(s) : null) : (window.VOLO_GRID.flows ? window.VOLO_GRID.flows.visual(s) : null)),
      h(Fold, { label: '重建', defOpen: false },
        Field('方法', h('span', { style: { fontSize: 12.5, color: 'var(--chrome-text)', fontWeight: 700 } }, isTS ? '全站仪导入' : '视觉校正')),
        !measured ? h('div', { className: 'gw-stage-warn' }, h(Icon, { name: 'alert', size: 13 }), isTS ? '需先导入全站仪数据' : '需先完成视觉采集') : null,
        h(Button, { variant: 'accent', size: 'M', isDisabled: !measured, icon: h(Icon, { name: 'cube3', size: 15 }), onPress: () => s.setModal({ render: ({ close }) => window.VOLO_GRID_MODALS.reconstruct(s, close) }) }, '开始重建')),
      h(Fold, { label: '导出', defOpen: false },
        !built ? h('div', { className: 'gw-stage-warn' }, h(Icon, { name: 'alert', size: 13 }), '需先完成一次重建') : null,
        h(Button, { variant: 'accent', size: 'S', isDisabled: !built, icon: h(Icon, { name: 'external', size: 13 }), onPress: () => s.setModal({ wide: true, render: ({ close }) => window.VOLO_GRID_MODALS.exportDlg(s, close) }) }, '导出…')));
  }
  function t_isTsNote() { return '全站仪实测箱体角点，毫米级绝对精度；无需测试图。'; }

  function inspector(s) {
    const sel = s.calSel;
    const t = sel && sel.type;
    const body = t === 'cabinet' ? h(BoxSingle, { s })
      : t === 'cabinetMulti' ? h(BoxMulti, { s })
      : t === 'run' ? h(RunInsp, { s })
      : t === 'pattern' ? h(PatternPanel, { s })
      : null;
    return h('div', { className: 'gw-insp' }, h(StagePanel, { s }), body ? h('div', { className: 'gw-insp-sep' }) : null, body);
  }

  window.VOLO_GRID = Object.assign(window.VOLO_GRID || {}, { inspector, ScreenForm });
})();
