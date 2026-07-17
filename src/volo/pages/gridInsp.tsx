// @ts-nocheck
/* Volo — 网格校正工作区 · 右侧上下文检查器（gridInsp.tsx）
   1:1 port of the Claude Design handoff `src/grid_insp.jsx`。
   屏幕建模表单读写真实 ScreenConfig（cabinet_count/cabinet_size_mm/
   pixels_per_cabinet/shape_prior/shape_mode/irregular_mask/bottom_completion/
   position_m/yaw_deg），本地草稿 + 显式保存（同 pages/calDesign.tsx 的既定手法：
   s.calDraftScreen 非 null = 有未保存改动，保存走 saveProjectYaml + 回读校验）。
   箱体选中/run 质量指标/阶段动作面板同样只读写真实数据，无自造 mock。 */
import * as React from "react";
import { saveProjectYaml, setRunCurrent, getRunReport, exportObj } from "../api/meshCommands";
import { generatedPatternImagePath, meshVisualGeneratePattern, meshVisualReconstruct } from "../api/meshVisualCommands";
import { getMachineDetail, listMachines, pickDirectory, pickFile, revealPath } from "../api/commands";
import { listMonitors, openPatternPlayer, closePatternPlayer, playerShowPattern, playerClear } from "../api/player";
import {
  listenNDisplayOutputEvent, listenNDisplayOutputRunner, outputDeploy,
  outputPreflight, outputShow, outputStart, outputStop,
} from "../api/ndisplayOutput";
import { listen } from "@tauri-apps/api/event";

(function () {
  const { Button, Switch } = window.Spectrum2DesignSystem_b6d1b3;
  const { useState, useRef, useEffect, useMemo } = React;
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

  /* ================= 屏幕预设（多屏列表 · 切换/重命名/删除/新建） ================= */
  function ScreenPresets({ s, proj, editingId, setEditingId }) {
    const screens = Object.keys(proj.config.screens);
    const active = s.calActiveScreen;
    const selectedIds = (window.VOLO_GRID && window.VOLO_GRID.selectedScreenIds)
      ? window.VOLO_GRID.selectedScreenIds(s) : [];
    const switchTo = (id, e) => {
      if (e && (e.ctrlKey || e.metaKey)) { window.VOLO_GRID.toggleScreenSel(s, id); return; }
      s.setCalActiveScreen(id); s.setCalDraftScreen(null); s.setCalSel({ type: 'screen' });
    };
    const renameScreen = async (oldId, rawName) => {
      const name = (rawName || '').trim();
      setEditingId(null);
      if (!name || name === oldId) return;
      if (proj.config.screens[name]) { s.setCalReceipt({ tone: 'notice', text: '已存在同名屏幕 · ' + name }); return; }
      const nextScreens = {};
      Object.entries(proj.config.screens).forEach(([k, v]) => { nextScreens[k === oldId ? name : k] = v; });
      /* 参考点名以 <screenId>_Vxxx_Rxxx 编码，重命名须同步改写 coordinate_system。 */
      const ren = (p) => (p && p.indexOf(oldId + '_') === 0) ? name + p.slice(oldId.length) : p;
      const coord = proj.config.coordinate_system;
      const nextConfig = Object.assign({}, proj.config, { screens: nextScreens },
        coord ? { coordinate_system: Object.assign({}, coord, { origin_point: ren(coord.origin_point), x_axis_point: ren(coord.x_axis_point), xy_plane_point: ren(coord.xy_plane_point) }) } : null);
      try {
        await s.runCmd({ domain: 'calibrate', action: '重命名屏幕', target: oldId + ' → ' + name, chan: 'local' },
          () => saveProjectYaml(proj.path, nextConfig), { okMsg: () => `已重命名屏幕 <b>${oldId}</b> → <b>${name}</b>` });
        await CX.openProjectPath(proj.path, s);
        if (s.calActiveScreen === oldId) s.setCalActiveScreen(name);
        s.setCalDraftScreen(null);
      } catch (e) { /* runCmd 已记录失败 */ }
    };
    const delScreen = async (id) => {
      if (screens.length <= 1) { s.setCalReceipt({ tone: 'notice', text: '至少保留一块屏幕' }); return; }
      const nextScreens = Object.assign({}, proj.config.screens);
      delete nextScreens[id];
      const nextId = Object.keys(nextScreens)[0];
      try {
        await s.runCmd({ domain: 'calibrate', action: '删除屏幕', target: id, chan: 'local' },
          () => saveProjectYaml(proj.path, Object.assign({}, proj.config, { screens: nextScreens })),
          { okMsg: () => `已删除屏幕 <b>${id}</b>` });
        await CX.openProjectPath(proj.path, s);
        if (s.calActiveScreen === id) s.setCalActiveScreen(nextId);
        s.setCalDraftScreen(null);
      } catch (e) { /* runCmd 已记录失败 */ }
    };
    const createScreen = async () => {
      let id = 'SCREEN'; let n = 1;
      while (proj.config.screens[id]) { n += 1; id = 'SCREEN' + n; }
      const cfg = {
        cabinet_count: [8, 3], cabinet_size_mm: [500, 500], pixels_per_cabinet: [176, 176],
        shape_prior: { type: 'flat' }, shape_mode: 'rectangle', irregular_mask: [], bottom_completion: null,
        position_m: [Object.keys(proj.config.screens).length * 3.2, 0, 0], yaw_deg: 0, height_offset_mm: 0,
        origin_aligned: false,
      };
      const nextConfig = Object.assign({}, proj.config, { screens: Object.assign({}, proj.config.screens, { [id]: cfg }) });
      try {
        await s.runCmd({ domain: 'calibrate', action: '新建屏幕', target: id, chan: 'local' },
          () => saveProjectYaml(proj.path, nextConfig), { okMsg: () => `已新建屏幕 <b>${id}</b>` });
        await CX.openProjectPath(proj.path, s);
        s.setCalActiveScreen(id); s.setCalDraftScreen(null); s.setCalSel({ type: 'screen' });
        s.setCalReceipt({ tone: 'ok', text: '已新建屏幕预设 · ' + id });
        setEditingId(id);
      } catch (e) { /* runCmd 已记录失败 */ }
    };
    return h('div', { className: 'gw-parent' },
      h('div', { className: 'gw-parent-h' }, h(Icon, { name: 'panel', size: 14 }), '屏幕预设'),
      h('div', { className: 'gw-presets' }, screens.map((id) => {
        const sc = proj.config.screens[id];
        const on = selectedIds.includes(id) || id === active;
        return h('div', { key: id, className: 'gw-preset' + (on ? ' on' : ''), onClick: (e) => switchTo(id, e), onDoubleClick: () => setEditingId(id) },
          h('span', { className: 'ic' }, h(Icon, { name: 'panel', size: 14 })),
          editingId === id
            ? h('input', { className: 'gw-preset-edit', autoFocus: true, defaultValue: id, onClick: (e) => e.stopPropagation(),
                onKeyDown: (e) => { if (e.key === 'Enter') renameScreen(id, e.target.value); else if (e.key === 'Escape') setEditingId(null); },
                onBlur: (e) => renameScreen(id, e.target.value) })
            : h('span', { className: 'nm', title: '双击或 F2 重命名 · Ctrl/⌘ 多选' }, id),
          h('span', { className: 'mt' }, sc.cabinet_count[0] + '×' + sc.cabinet_count[1]),
          screens.length > 1 ? h('button', { className: 'rm', title: '删除预设', onClick: (e) => { e.stopPropagation(); delScreen(id); } }, h(Icon, { name: 'trash', size: 12 })) : null);
      })),
      h(Button, { variant: 'secondary', size: 'S', icon: h(Icon, { name: 'plus', size: 13 }), onPress: createScreen }, '新建预设'));
  }

  /* ================= 屏幕建模参数表单 ================= */
  function ScreenForm({ s, noHead }) {
    const proj = CX.useProj();
    const screenId = s.calActiveScreen;
    const real = proj.config && proj.config.screens[screenId];
    /* 草稿在切屏 / 保存回读后清空（proj.config 引用变化即视为"已同步"）。 */
    useEffect(() => { s.setCalDraftScreen(null); }, [screenId, proj.config]);
    const [saving, setSaving] = useState(false);
    const [editingId, setEditingId] = useState(null);
    useEffect(() => {
      const onKey = (e) => {
        if (e.key !== 'F2') return;
        const tn = (e.target || {}).tagName || '';
        if (!/^(INPUT|TEXTAREA)$/.test(tn)) { e.preventDefault(); setEditingId(s.calActiveScreen); }
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [s.calActiveScreen]);
    if (!real) return null;
    const m = s.calDraftScreen || real;
    const dirty = !!s.calDraftScreen;
    const set = (patch) => {
      const invalidatesAlignment = ['position_m', 'yaw_deg', 'height_offset_mm', 'shape_prior', 'cabinet_count', 'cabinet_size_mm']
        .some((key) => Object.prototype.hasOwnProperty.call(patch, key));
      s.setCalDraftScreen(Object.assign({}, m, invalidatesAlignment ? { origin_aligned: false } : {}, patch));
    };
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
        /* 屏幕参数变更 → 已生成的测试图标记「已过期」（只标注，不删除产物）。 */
        if (proj.patternGenByScreen && proj.patternGenByScreen[screenId]) {
          CX.projStore.patch({ patternStaleByScreen: Object.assign({}, CX.projStore.get().patternStaleByScreen, { [screenId]: true }) });
        }
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
      h(ScreenPresets, { s, proj, editingId, setEditingId }),
      h(Fold, { n: '①', label: '箱体' },
        Field('预设', h(Sel, {
          value: m.__cabPreset || 'custom',
          options: GRID_CAB_PRESETS.map((p) => ({ id: p.id, label: p.label })),
          onChange: (id) => { const p = GRID_CAB_PRESETS.find((x) => x.id === id); set(id === 'custom' ? { __cabPreset: id } : { __cabPreset: id, cabinet_size_mm: [p.w, p.h], pixels_per_cabinet: [p.px, p.pxh] }); },
          w: 150,
        })),
        Field('尺寸', h(Dual, { a: m.cabinet_size_mm[0], b: m.cabinet_size_mm[1], oa: (v) => set({ cabinet_size_mm: [v, m.cabinet_size_mm[1]] }), ob: (v) => set({ cabinet_size_mm: [m.cabinet_size_mm[0], v] }), unit: 'mm' })),
        Field('像素', h(Dual, { a: pxW, b: pxH, oa: (v) => set({ pixels_per_cabinet: [v, pxH] }), ob: (v) => set({ pixels_per_cabinet: [pxW, v] }), unit: 'px' }))),
      h(Fold, { n: '②', label: '布局' },
        Field('列数', h(NumInput, { value: cols, onChange: (v) => set({ cabinet_count: [Math.max(1, v), rows] }), min: 1, max: 200 })),
        Field('行数', h(NumInput, { value: rows, onChange: (v) => set({ cabinet_count: [cols, Math.max(1, v)] }), min: 1, max: 100 })),
        Field('离地高度', h('span', { className: 'gw-dual' }, h(NumInput, { value: m.height_offset_mm || 0, onChange: (v) => set({ height_offset_mm: v }), min: 0, max: 5000, step: 10 }), h('span', { className: 'gw-unit' }, 'mm')))),
      h(Fold, { n: '③', label: '形状' },
        /* 设计稿形状档为 5 档（平直/对称弧/L 形/U 形/自定义分段）；curved/folded 是
           后端 shape_prior 的历史变体，仅当当前屏幕已是该形状时才显示（否则隐藏）。 */
        h('div', { className: 'gw-shape-grid' }, GRID_SHAPES.filter((sh) => (sh.id !== 'curved' && sh.id !== 'folded') || shapeId === sh.id).map((sh) => h('button', { key: sh.id, className: 'gw-shape' + (shapeId === sh.id ? ' on' : ''), onClick: () => set({ shape_prior: defaultShapeFor(sh.id) }) },
          h(Icon, { name: sh.icon, size: 18 }), h('span', { className: 't' }, sh.label)))),
        shapeFields.length ? h('div', { style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 } }, shapeFields) : null,
        derivedNote,
        shapeId === 'custom_segments' ? h(SegEditor, { s, m, set, totalCols }) : null),
      h(Fold, { n: '④', label: '变换' },
        Field('位置 X', h('span', { className: 'gw-dual' }, h(NumInput, { value: m.position_m[0], onChange: (v) => set({ position_m: [v, m.position_m[1], m.position_m[2]] }), step: 0.1 }), h('span', { className: 'gw-unit' }, 'm'))),
        Field('位置 Y', h('span', { className: 'gw-dual' }, h(NumInput, { value: m.position_m[1], onChange: (v) => set({ position_m: [m.position_m[0], v, m.position_m[2]] }), step: 0.1 }), h('span', { className: 'gw-unit' }, 'm'))),
        Field('位置 Z', h('span', { className: 'gw-dual' }, h(NumInput, { value: m.position_m[2], onChange: (v) => set({ position_m: [m.position_m[0], m.position_m[1], v] }), step: 0.1 }), h('span', { className: 'gw-unit' }, 'm'))),
        Field('朝向角', h('span', { className: 'gw-dual' }, h(NumInput, { value: m.yaw_deg, onChange: (v) => set({ yaw_deg: v }), min: -180, max: 180 }), h('span', { className: 'gw-unit' }, '°')))),
      h(Fold, { n: '⑤', label: '派生信息 · 只读', defOpen: false },
        h('div', { className: 'gw-derived' },
          h('div', { className: 'gw-dcell' }, h('div', { className: 'k' }, '整屏尺寸'), h('div', { className: 'v' }, wM.toFixed(2) + ' × ' + hM.toFixed(2), h('span', { className: 'u' }, 'm'))),
          h('div', { className: 'gw-dcell' }, h('div', { className: 'k' }, '像素画布'), h('div', { className: 'v', style: { fontSize: 12.5 } }, (cols * pxW) + ' × ' + (rows * pxH))),
          h('div', { className: 'gw-dcell' }, h('div', { className: 'k' }, '箱体总数'), h('div', { className: 'v' }, cabTotal, maskedN ? h('span', { className: 'u' }, '（遮罩 ' + maskedN + '）') : null)),
          h('div', { className: 'gw-dcell' }, h('div', { className: 'k' }, '顶点网格规模'), h('div', { className: 'v', style: { fontSize: 13 } }, (cols + 1) + ' × ' + (rows + 1))))),
      h(Fold, { n: '⑥', label: '高级', defOpen: false },
        /* 弯折缝列：schema 上是逐列多值（fold_seams_at_columns），仅曲面/折叠形状支持。 */
        h('div', { className: 'gw-field stack' },
          h('span', { className: 'lb' }, '弯折缝列', h('span', { className: 'hint' }, '在指定列插入弯折缝')),
          (shapeId === 'folded' || shapeId === 'curved')
            ? h(FoldSeamEditor, { m, setShape, totalCols })
            : h('div', { style: { fontSize: 11, color: 'var(--chrome-faint)' } }, '当前形状不支持弯折缝（仅「曲面 / 折叠」形状可用）。')),
        h('div', { className: 'cap-toggle-row', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingTop: 4 } },
          h('div', null,
            h('div', { style: { fontSize: 12.5, color: 'var(--chrome-dim)' } }, '底部补全'),
            h('div', { style: { fontSize: 10.5, color: 'var(--chrome-faint)' } }, '异形屏底部空缺自动补齐')),
          h(Switch, { isSelected: !!m.bottom_completion, onChange: (v) => set({ bottom_completion: v ? { lowest_measurable_row: 2, fallback_method: 'vertical', assumed_height_mm: m.cabinet_size_mm[1] } : null }) })),
        m.bottom_completion ? h('div', { style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 } },
          Field('最低可测行', h(NumInput, { value: m.bottom_completion.lowest_measurable_row, onChange: (v) => set({ bottom_completion: Object.assign({}, m.bottom_completion, { lowest_measurable_row: Math.max(1, v) }) }), min: 1, max: rows })),
          Field('假定高度', h('span', { className: 'gw-dual' }, h(NumInput, { value: m.bottom_completion.assumed_height_mm, onChange: (v) => set({ bottom_completion: Object.assign({}, m.bottom_completion, { assumed_height_mm: v }) }), min: 0, step: 10 }), h('span', { className: 'gw-unit' }, 'mm'))),
          Field('补全方式', h('span', { className: 'gw-unit', style: { fontFamily: 'var(--font-code)', fontSize: 12.5, color: 'var(--chrome-text)' } }, 'vertical'))) : null,
        h('div', { className: 'cap-toggle-row', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingTop: 4 } },
          h('div', null,
            h('div', { style: { fontSize: 12.5, color: 'var(--chrome-dim)' } }, '翻转法线朝向'),
            h('div', { style: { fontSize: 10.5, color: 'var(--chrome-faint)' } }, '将箱体前表面外法线整体反向（需开启「法线朝向」显示）')),
          h(Switch, { isSelected: !!m.normal_flip, onChange: (v) => set({ normal_flip: v }) }))),
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
    const dragFrom = useRef(null);
    const reorder = (from, to) => { if (from == null || to == null || from === to) return; const nx = segs.slice(); const [g] = nx.splice(from, 1); nx.splice(to, 0, g); setSegs(nx); };
    return h('div', { style: { marginTop: 8 } },
      h('div', { className: 'gw-seg-list' }, segs.map((g, i) => h('div', {
        key: i, className: 'gw-seg-row',
        onDragOver: (e) => e.preventDefault(),
        onDrop: (e) => { e.preventDefault(); reorder(dragFrom.current, i); dragFrom.current = null; },
      },
        h('span', { className: 'drag', title: '拖拽排序', draggable: true, style: { cursor: 'grab' },
          onDragStart: (e) => { dragFrom.current = i; e.dataTransfer.effectAllowed = 'move'; } }, h(Icon, { name: 'more', size: 14 })),
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
      role ? h(Fold, { label: '坐标系角色 · 只读' },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
          h('span', { style: { width: 11, height: 11, borderRadius: '50%', background: (ROLE[role] || {}).color } }),
          h('b', { style: { fontFamily: 'var(--font-code)', fontSize: 13 } }, (ROLE[role] || {}).label)),
        h(Button, { variant: 'secondary', size: 'S', icon: h(Icon, { name: 'x', size: 13 }), onPress: async () => {
          /* 清空该角色点名并切到参考点工具重指（三点未齐前重建校验会拦截，允许中间态）。 */
          const coord = proj.config.coordinate_system;
          if (!coord) return;
          const field = role === 'origin' ? 'origin_point' : role === 'x_axis' ? 'x_axis_point' : 'xy_plane_point';
          const nextScreens = role === 'origin'
            ? Object.assign({}, proj.config.screens, { [screenId]: Object.assign({}, m, { origin_aligned: false }) })
            : proj.config.screens;
          const nextConfig = Object.assign({}, proj.config, {
            screens: nextScreens,
            coordinate_system: Object.assign({}, coord, { [field]: '' }),
          });
          try {
            await s.runCmd({ domain: 'calibrate', action: '清除参考点', target: (ROLE[role] || {}).label || role, chan: 'local' },
              () => saveProjectYaml(proj.path, nextConfig), { okMsg: () => `已清除 ${(ROLE[role] || {}).label}，请在视口重新指派` });
            await CX.openProjectPath(proj.path, s);
            s.setCalBoxTool('refs'); s.setCalRefRole(role);
          } catch (e) { /* runCmd 已记录失败 */ }
        } }, '清除并重指')) : null);
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
    const [compareId, setCompareId] = useState(null);
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
    const rtone = rms == null ? null : CX.rmsTone(rms, 'mm');
    const compare = (proj.runs || []).find((x) => x.id === Number(compareId));
    const delta = (a, b, digits) => a == null || b == null ? 'n/a' : ((a - b) >= 0 ? '+' : '') + (a - b).toFixed(digits == null ? 2 : digits);
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
      h(Fold, { label: 'Run A/B 指标对比' },
        h('div', { className: 'lens-nanote' }, h(Icon, { name: 'info', size: 13 }), '仅比较 run 质量指标与产物状态，不是几何叠加对比。'),
        h('div', { className: 'cap-field' }, h('span', { className: 'cap-lbl' }, 'Run B'),
          h('select', { className: 'ar-select', value: compareId || '', onChange: (e) => setCompareId(e.target.value || null) },
            h('option', { value: '' }, '选择另一 run…'), (proj.runs || []).filter((x) => x.id !== r.id).map((x) => h('option', { key: x.id, value: x.id }, 'run #' + x.id)))),
        compare ? h('div', { className: 'lens-mon-table' },
          h('div', { className: 'lens-mon-head', style: { gridTemplateColumns: '1fr repeat(3,80px)' } }, h('span', null, '指标'), h('span', null, 'Run A'), h('span', null, 'Run B'), h('span', null, 'A−B')),
          [['RMS mm', r.estimated_rms_mm, compare.estimated_rms_mm, 2], ['vertices', r.vertex_count, compare.vertex_count, 0]].map(([k, a, b, d]) => h('div', { key: k, className: 'lens-mon-row', style: { gridTemplateColumns: '1fr repeat(3,80px)' } }, h('span', null, k), h('span', { className: 'mono' }, a == null ? 'n/a' : Number(a).toFixed(d)), h('span', { className: 'mono' }, b == null ? 'n/a' : Number(b).toFixed(d)), h('span', { className: 'mono' }, delta(a, b, d)))),
          h('div', { className: 'lens-mon-row', style: { gridTemplateColumns: '1fr repeat(3,80px)' } }, h('span', null, 'OBJ'), h('span', null, r.output_obj_path ? '有' : '无'), h('span', null, compare.output_obj_path ? '有' : '无'), h('span', null, '—'))) : null),
      h(Fold, { label: '动作' },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          h('div', { style: { display: 'flex', gap: 8 } },
            h(Button, { variant: 'secondary', size: 'S', icon: h(Icon, { name: 'eye', size: 13 }), onPress: () => { CX.viewRunInPreview(s, proj, r.id); s.setCalMeshVersion('rebuilt'); } }, '在视口中查看'),
            h(Button, { variant: 'secondary', size: 'S', icon: h(Icon, { name: 'star', size: 13 }), isDisabled: r.is_current, onPress: setCurrent }, '设为当前')),
          h('div', { style: { display: 'flex', gap: 8 } },
            h(Button, { variant: 'secondary', size: 'S', icon: h(Icon, { name: 'layers', size: 13 }), onPress: () => s.setCalMeshVersion('overlay') }, '与另一 run 比对'),
            h(Button, { variant: 'accent', size: 'S', icon: h(Icon, { name: 'external', size: 13 }), onPress: () => s.setModal({ wide: true, render: ({ close }) => window.VOLO_GRID_MODALS.exportDlg(s, close) }) }, '导出')))));
  }

  /* ================= 测试图（共享状态：PatternPanel 与 StagePanel「测试图」折叠共用） ================= */
  const SCREEN_ID_CODE = 1; /* 单屏采集会话固定标识码，与 meshVisualGeneratePattern 调用一致 */
  /* 后端 run_generate_pattern 只认 charuco | vpqsp；handoff 里的「密集编码点」即 VP-QSP */
  const PATTERN_SCHEMES = [{ id: 'charuco', label: 'ChArUco' }, { id: 'vpqsp', label: '密集编码点' }];
  const OUTPUT_PATHS = {
    /* Compatibility fallback only; preflight resolves editor_paths per node from the machine library. */
    editor_path: 'D:\\Program Files\\Epic Games\\UE_5.8\\Engine\\Binaries\\Win64\\UnrealEditor.exe',
    editor_paths: {},
    project_path: 'C:\\ProgramData\\UECM\\ndisplay-output\\VoloOutput\\VoloOutput.uproject',
    config_path: 'C:\\ProgramData\\UECM\\ndisplay-output\\VoloOutput\\Config\\VoloOutput.ndisplay',
    manifest_path: 'C:\\ProgramData\\UECM\\ndisplay-output\\session\\manifest.json',
    image_dir: 'C:\\ProgramData\\UECM\\ndisplay-output\\session\\frames',
  };
  function usePattern(s, screenIds) {
    const proj = CX.useProj();
    const ids = (screenIds && screenIds.length) ? screenIds : [s.calActiveScreen];
    const screenId = ids[0];
    const [scheme, setScheme] = useState('vpqsp');
    const [busy, setBusy] = useState(false);
    const [playing, setPlaying] = useState(false);
    const genN = ids.filter((id) => proj.patternGenByScreen && proj.patternGenByScreen[id]).length;
    const gen = genN === ids.length && ids.length > 0;
    const stale = ids.some((id) => proj.patternGenByScreen && proj.patternGenByScreen[id] && proj.patternStaleByScreen && proj.patternStaleByScreen[id]);
    const res = proj.patternGenByScreen && proj.patternGenByScreen[screenId];
    const runGen = async () => {
      if (busy) return;
      setBusy(true);
      try {
        const nextGen = Object.assign({}, proj.patternGenByScreen);
        const nextStale = Object.assign({}, proj.patternStaleByScreen);
        let last = null;
        let failed = null;
        await Promise.all(ids.map(async (id) => {
          try {
            const result = await meshVisualGeneratePattern(proj.path, id, scheme, SCREEN_ID_CODE, null);
            nextGen[id] = result;
            nextStale[id] = false;
            last = result;
            CX.projStore.patch({ patternGenByScreen: Object.assign({}, nextGen), patternStaleByScreen: Object.assign({}, nextStale) });
          } catch (e) {
            if (!failed) failed = e;
          }
        }));
        if (failed) throw failed;
        s.setCalReceipt({ tone: 'ok', text: ids.length > 1 ? `已生成测试图 · ${ids.length} 块屏幕` : `已生成测试图 · ${last.cabinet_count} 箱体` });
      } catch (e) {
        const msg = `测试图生成失败 · ${e && e.message ? e.message : e}`;
        s.pushLog({ lv: 'err', cat: 'calibrate', msg });
        s.setCalReceipt({ tone: 'err', text: msg.length > 120 ? msg.slice(0, 120) + '…（详见控制台）' : msg });
      }
      finally { setBusy(false); }
    };
    const togglePlayer = async () => {
      if (playing) {
        try { await playerClear(); await closePatternPlayer(); } catch (e) { /* 播放器可能已被手动关闭 */ }
        setPlaying(false); s.setCalReceipt({ tone: 'ok', text: '已停止播放' });
        return;
      }
      if (!res || typeof res !== 'object' || !res.output_dir) return;
      try {
        const mons = await listMonitors();
        const mon = mons.length > 1 ? mons[mons.length - 1] : mons[0];
        await openPatternPlayer(mon ? mon.index : 0);
        await playerShowPattern(generatedPatternImagePath(res.output_dir), 'full_screen');
        setPlaying(true); s.setCalReceipt({ tone: 'ok', text: '已发送到播放器' });
      } catch (e) { s.pushLog({ lv: 'err', cat: 'calibrate', msg: `发送到播放器失败 · ${e && e.message ? e.message : e}` }); }
    };
    const openFolder = () => { if (res && typeof res === 'object' && res.output_dir) revealPath(res.output_dir).catch(() => {}); };
    return { proj, screenId, screenIds: ids, scheme, setScheme, busy, runGen, gen, genN, stale, res: (res && typeof res === 'object') ? res : null, playing, togglePlayer, openFolder };
  }
  function patternBadge(stale, genN, total) {
    if (total > 1) {
      if (genN === total) return h('span', { className: 'spill spill--positive' }, h(Icon, { name: 'check', size: 12 }), '已生成 ' + genN + ' / ' + total + ' 屏');
      return h('span', { className: 'spill spill--notice' }, h(Icon, { name: 'alert', size: 12 }), '已生成 ' + (genN || 0) + ' / ' + total + ' 屏');
    }
    if (genN !== total || total === 0) return h('span', { className: 'spill spill--neutral' }, h('span', { style: { fontWeight: 700 } }, '—'), '未生成');
    if (stale) return h('span', { className: 'spill spill--notice' }, h(Icon, { name: 'alert', size: 12 }), '已过期');
    return h('span', { className: 'spill spill--positive' }, h(Icon, { name: 'check', size: 12 }), '已生成');
  }

  /* 「去向」段（本机显示器 / nDisplay 集群）—— PatternPanel 与 StagePanel 的测试图段共用 */
  function OutputDestination({ s, p }) {
    const [destination, setDestination] = useState('local');
    const [clusterPhase, setClusterPhase] = useState('idle');
    const [clusterBusy, setClusterBusy] = useState(false);
    const [nodeStates, setNodeStates] = useState({});
    const [outputLogs, setOutputLogs] = useState([]);
    const [runtimePaths, setRuntimePaths] = useState(OUTPUT_PATHS);
    const topology = useMemo(() => window.resolveProjectTopology(p.proj.config), [p.proj.config]);
    const nodes = (topology && topology.nodes) || [];
    const screen = useMemo(() => topology
      ? window.stageScreenForOutput(p.proj.config, topology)
      : (p.proj.config && p.proj.config.screens[p.screenId]), [p.proj.config, topology, p.screenId]);
    const sessionId = `${p.proj.path}::stage`;
    const appendOutputLog = (entry) => setOutputLogs((current) => current.concat(entry).slice(-80));
    useEffect(() => {
      let alive = true;
      const cleanups = [];
      listenNDisplayOutputEvent((payload) => {
        if (!alive || payload.session_id !== sessionId) return;
        setNodeStates((current) => Object.assign({}, current, { [payload.node_id]: payload }));
        appendOutputLog(payload);
      }).then((fn) => alive ? cleanups.push(fn) : fn());
      listenNDisplayOutputRunner((payload) => {
        if (!alive || payload.session_id !== sessionId) return;
        appendOutputLog(payload);
      }).then((fn) => alive ? cleanups.push(fn) : fn());
      return () => { alive = false; cleanups.forEach((fn) => fn()); };
    }, [sessionId]);
    const runtimeRequest = (paths) => ({ session_id: sessionId, screen, paths: paths || runtimePaths, ssh_user: null });
    const resolveEditorPaths = async () => {
      const machines = await listMachines();
      const resolved = {};
      for (const node of nodes) {
        const hostname = (node.machine.hostname || '').trim().toLowerCase();
        const ip = (node.machine.ip || '').trim().toLowerCase();
        const machine = machines.find((candidate) =>
          (hostname && (candidate.hostname || '').trim().toLowerCase() === hostname) ||
          (ip && (candidate.ip || '').trim().toLowerCase() === ip));
        if (!machine || machine.id == null) throw new Error(`${node.node_id}：机器库中找不到 ${node.machine.ip || node.machine.hostname}`);
        const detail = await getMachineDetail(machine.id);
        const install = detail.ue_installs
          .filter((item) => /^5\.8(?:\.|$)/.test(item.version))
          .sort((a, b) => Number(b.is_primary) - Number(a.is_primary))[0];
        if (!install) throw new Error(`${node.node_id}：机器库未探测到 UE 5.8`);
        resolved[node.node_id] = `${install.install_path.replace(/[\\/]+$/, '')}\\Engine\\Binaries\\Win64\\UnrealEditor.exe`;
      }
      const paths = Object.assign({}, OUTPUT_PATHS, { editor_paths: resolved });
      setRuntimePaths(paths);
      return paths;
    };
    const runCluster = async (operation, fn, nextPhase) => {
      if (clusterBusy || !screen) return;
      setClusterBusy(true);
      try {
        const result = await fn();
        setClusterPhase(nextPhase);
        s.setCalReceipt({ tone: 'ok', text: `nDisplay ${operation} 完成 · ${result.nodes.length} 节点` });
      } catch (e) {
        const message = e && e.message ? e.message : String(e);
        appendOutputLog({ operation, state: 'error', message, timestamp_ms: Date.now() });
        s.setCalReceipt({ tone: 'err', text: `nDisplay ${operation} 失败 · ${message}` });
      } finally { setClusterBusy(false); }
    };
    const openTopology = () => s.setModal({ xwide: true, render: ({ close }) => window.VOLO_GRID_MODALS.topology(s, close) });
    const preflight = () => runCluster('预检', async () => {
      const paths = await resolveEditorPaths();
      return outputPreflight(runtimeRequest(paths));
    }, 'preflight');
    const deploy = () => runCluster('部署', () => outputDeploy(Object.assign(runtimeRequest(), { ue_version: '5.8' })), 'deployed');
    const startCluster = () => runCluster('启动', () => outputStart(runtimeRequest()), 'running');
    const showCluster = () => runCluster('显示', () => {
      const comp = window.buildStageComposite((p.proj.config && p.proj.config.screens) || {});
      const stage = {
        project_path: p.proj.path,
        canvas_px: [comp.canvas.w, comp.canvas.h],
        screens: comp.screens.map((r) => ({ screen_id: r.id, x: r.x, y: r.y })),
      };
      return outputShow(Object.assign(runtimeRequest(), { mode: 'show', image_path: null, stage }));
    }, 'running');
    const clearCluster = () => runCluster('清空', () => outputShow(Object.assign(runtimeRequest(), { mode: 'clear', image_path: null })), 'running');
    const stopCluster = () => runCluster('停止', () => outputStop(runtimeRequest()), 'idle');
    const phaseRank = { idle: 0, preflight: 1, deployed: 2, running: 3 };
    return h('div', { className: 'nd-deliver' },
      h('div', { className: 'nd-target' },
        h('button', { className: 'nd-tbtn' + (destination === 'local' ? ' on' : ''), onClick: () => setDestination('local') },
          h(Icon, { name: 'panel', size: 15 }), h('div', { className: 'm' }, h('b', null, '本机显示器'), h('span', null, '投到本机 HDMI'))),
        h('button', { className: 'nd-tbtn' + (destination === 'cluster' ? ' on' : ''), onClick: () => setDestination('cluster') },
          h(Icon, { name: 'net', size: 15 }), h('div', { className: 'm' }, h('b', null, 'nDisplay 集群'), h('span', null, '渲染服务器上墙')))),
      destination === 'local' ? h('div', { className: 'nd-monitor', style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          h(Button, { variant: p.playing ? 'negative' : 'accent', size: 'S', isDisabled: !p.res, icon: h(Icon, { name: p.playing ? 'pause' : 'play', size: 13 }), onPress: p.togglePlayer }, p.playing ? '停止投放' : '投放到显示器'),
          h(Button, { variant: 'secondary', size: 'S', isDisabled: !p.res, icon: h(Icon, { name: 'external', size: 13 }), onPress: p.openFolder }, '打开输出文件夹'))
          : h('div', { className: 'nd-cluster' },
              !nodes.length
                ? h('div', { className: 'nd-guide' },
                    h('div', { className: 'nd-guide-ic' }, h(Icon, { name: 'net', size: 26 })),
                    h('div', { className: 'nd-guide-t' }, '该 Stage 尚未配置输出拓扑'),
                    h('div', { className: 'nd-guide-d' }, '整个 Stage 只有一份 nDisplay 集群配置：需先在复合画布上定义哪几台渲染服务器、各驱动哪个像素区域（可跨屏），才能把测试图上墙。'),
                    h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'net', size: 15 }), onPress: openTopology }, '配置输出拓扑…'))
                : h(React.Fragment, null,
                    h('button', { className: 'nd-summary', onClick: openTopology, title: '点击重新打开输出拓扑配置' },
                      h('span', { className: 'nd-summary-ic' }, h(Icon, { name: 'panel', size: 15 })),
                      h('div', { className: 'nd-summary-m' },
                        h('div', { className: 'nd-summary-t' }, nodes.length + ' 节点 · Stage 级'),
                        h('div', { className: 'nd-summary-s' }, '复合画布拓扑')),
                      h(Icon, { name: 'settings', size: 14, style: { color: 'var(--chrome-faint)' } })),
                    h('div', { className: 'gw-output-flow' },
                      h(Button, { variant: 'secondary', size: 'S', isDisabled: clusterBusy || !nodes.length, icon: h(Icon, { name: 'check', size: 13 }), onPress: preflight }, '预检'),
                      h(Button, { variant: 'secondary', size: 'S', isDisabled: clusterBusy || phaseRank[clusterPhase] < 1, icon: h(Icon, { name: 'download', size: 13 }), onPress: deploy }, '部署'),
                      h(Button, { variant: 'accent', size: 'S', isDisabled: clusterBusy || phaseRank[clusterPhase] < 2, icon: h(Icon, { name: 'play', size: 13 }), onPress: startCluster }, '启动')),
                    h('div', { className: 'gw-output-flow' },
                      h(Button, { variant: 'secondary', size: 'S', isDisabled: clusterBusy || clusterPhase !== 'running', icon: h(Icon, { name: 'eye', size: 13 }), onPress: showCluster }, '显示测试图'),
                      h(Button, { variant: 'secondary', size: 'S', isDisabled: clusterBusy || clusterPhase !== 'running', icon: h(Icon, { name: 'minus', size: 13 }), onPress: clearCluster }, '清空'),
                      h(Button, { variant: 'negative', size: 'S', isDisabled: clusterBusy || clusterPhase !== 'running', icon: h(Icon, { name: 'pause', size: 13 }), onPress: stopCluster }, '停止')),
                    h('div', { className: 'gw-output-nodes' }, nodes.map((node) => {
                      const state = nodeStates[node.node_id];
                      const tone = state && state.state === 'ok' ? 'positive' : state && state.state === 'error' ? 'negative' : clusterBusy ? 'notice' : 'neutral';
                      const label = state ? state.message : node.primary ? 'Primary · 待命' : 'Secondary · 待命';
                      return h('div', { key: node.node_id, className: 'gw-output-node' },
                        h('span', { className: `cap-pill cap-pill--${tone}` }, h(Icon, { name: tone === 'positive' ? 'check' : tone === 'negative' ? 'alert' : 'info', size: 11 }), node.node_id),
                        h('span', { className: 'host' }, node.machine.ip || node.machine.hostname),
                        h('span', { className: 'msg', title: label }, label));
                    })),
                    h('details', { className: 'gw-output-log' },
                      h('summary', null, h(Icon, { name: 'doc', size: 12 }), `运行日志 (${outputLogs.length})`),
                      h('div', { className: 'gw-output-logbody' }, outputLogs.length ? outputLogs.map((entry, index) => h('div', { key: index, className: `row ${entry.state || ''}` },
                        h('span', { className: 'op' }, entry.operation || 'output'), h('span', { className: 'tx' }, entry.message || '—'))) : h('div', { className: 'empty' }, '暂无日志'))))));
  }

  function PatternPanel({ s }) {
    const p = usePattern(s);
    return h(React.Fragment, null,
      head('grid', '测试图', 'ChArUco 校正图案', p.gen ? patternBadge(p.stale, p.genN, 1) : null),
      h(Fold, { label: '参数' },
        Field('图案方案', h(Sel, { value: p.scheme, options: PATTERN_SCHEMES, onChange: p.setScheme, w: 150 })),
        Field('屏幕标识码', h('input', { className: 'gw-txt', value: String(SCREEN_ID_CODE), readOnly: true, style: { width: 70, textAlign: 'center' } })),
        Field('目标屏幕', h('span', { style: { fontSize: 12.5, color: 'var(--chrome-text)', fontFamily: 'var(--font-code)' } }, p.screenId))),
      p.busy
        ? h('div', { className: 'gw-grp-body' }, h('div', { style: { fontSize: 11.5, color: 'var(--chrome-dim)', marginBottom: 6 } }, '生成中…'),
            h('div', { className: 'vmeter vmeter--accent ar-indeterminate' }, h('div', { className: 'vmeter__fill' })))
        : h('div', { className: 'gw-grp-body', style: { display: 'flex', gap: 8 } },
            h(Button, { variant: p.gen ? 'secondary' : 'accent', size: 'M', icon: h(Icon, { name: p.gen ? 'sync' : 'grid', size: 15 }), onPress: p.runGen }, p.gen ? '重新生成' : '生成'),
            p.gen ? h(Button, { variant: 'secondary', size: 'M', icon: h(Icon, { name: 'eye', size: 14 }), onPress: () => s.setCalDisplay(Object.assign({}, s.calDisplay, { pattern: true })) }, '预览') : null),
      p.res ? h(Fold, { label: '完成摘要' },
        h('div', { className: 'gw-derived' },
          h('div', { className: 'gw-dcell' }, h('div', { className: 'k' }, '覆盖箱体'), h('div', { className: 'v' }, p.res.cabinet_count)),
          h('div', { className: 'gw-dcell' }, h('div', { className: 'k' }, '标记总数'), h('div', { className: 'v' }, p.res.total_markers))),
        h('div', { className: 'gw-fileref', style: { marginTop: 8 } }, h('span', { className: 'ic' }, h(Icon, { name: 'folder', size: 14 })),
          h('div', { className: 'm' }, h('div', { className: 'n' }, p.res.output_dir.split(/[\\/]/).pop() + '/'), h('div', { className: 'd' }, p.res.output_dir)))) : null,
      p.gen ? h(OutputDestination, { s, p }) : null);
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
    const selected = (window.VOLO_GRID && window.VOLO_GRID.selectedScreenIds)
      ? window.VOLO_GRID.selectedScreenIds(s) : [];
    const multiIds = selected.length ? selected : [s.calActiveScreen];
    const isMulti = multiIds.length > 1;
    const screenId = s.calActiveScreen;
    const m = proj.config && proj.config.screens[screenId];
    const built = s.calScreenReports && !!s.calScreenReports[screenId];
    const [method, setMethod] = useState('visual'); /* handoff 默认视觉校正 */
    const [capMode, setCapMode] = useState('offline');
    const [captureDirs, setCaptureDirs] = useState({});
    const [intr, setIntr] = useState('auto');
    const [intrFile, setIntrFile] = useState('');
    const [baState, setBaState] = useState('idle');
    const [baPct, setBaPct] = useState(0);
    const [baStage, setBaStage] = useState('');
    const [baErr, setBaErr] = useState('');
    const visualJobRef = useRef(null);
    const isTS = method === 'totalstation';
    const newShapeVisualBlocked = m && GRID_MEAS_TYPES.find((x) => x.id === 'visual').disabledForShapes.includes(m.shape_prior.type);
    const captureDir = captureDirs[screenId] || '';
    const visualCapturePath = captureDir || (proj.visualSession && proj.visualSession.screenId === screenId && proj.visualSession.sessionDir) || '';
    const measured = isTS ? !!proj.measurementsAbsPath : !!visualCapturePath;
    const runs = (proj.runs || []);
    const curRun = runs.find((r) => r.is_current) || runs[0] || null;

    /* 测试图（仅视觉法）—— 多选时批量作用于全部选中屏 */
    const p = usePattern(s, multiIds);

    /* 导出（内联，同 exportDlg 的真实 exportObj） */
    const [target, setTarget] = useState('disguise');
    const [expPath, setExpPath] = useState('');
    const [expDone, setExpDone] = useState(null);
    useEffect(() => {
      let alive = true;
      const cleanups = [];
      const add = (fn) => { if (alive) cleanups.push(fn); else fn(); };
      listen('mesh-visual-progress', (event) => {
        const payload = event.payload;
        if (!payload || payload.job_id !== visualJobRef.current) return;
        const detail = payload.event || {};
        if (detail.event === 'progress') {
          setBaPct(Math.max(0, Math.min(100, detail.percent || 0)));
          setBaStage(detail.stage || '');
        }
      }).then(add);
      listen('mesh-visual-reconstruct-done', (event) => {
        const payload = event.payload;
        if (!payload || payload.job_id !== visualJobRef.current) return;
        visualJobRef.current = null;
        if (payload.result) {
          const result = payload.result;
          setBaState('done'); setBaPct(100); setBaErr('');
          CX.projStore.patch({ visualSession: { screenId, poses: (result.cabinets || []).length || 1, posePath: result.pose_report_path, sessionDir: visualCapturePath } });
          s.setCalReceipt({ tone: 'ok', text: `视觉重建完成 · BA RMS ${result.ba_rms_px.toFixed(2)} px` });
          s.pushLog({ lv: 'ok', cat: 'survey', msg: `视觉重建完成 · ba_rms <b>${result.ba_rms_px.toFixed(2)} px</b>` });
        } else {
          const msg = payload.error || '视觉重建失败';
          setBaState('idle'); setBaErr(msg);
          s.pushLog({ lv: 'err', cat: 'survey', msg: `视觉重建失败 · ${msg}` });
        }
      }).then(add);
      return () => { alive = false; cleanups.forEach((fn) => fn()); };
    }, [screenId, visualCapturePath]);
    const pickCaptureDir = async () => {
      try {
        const dir = await pickDirectory();
        if (dir) setCaptureDirs((current) => Object.assign({}, current, { [screenId]: dir }));
      } catch (e) {
        s.pushLog({ lv: 'err', cat: 'survey', msg: `选择照片文件夹失败 · ${e && e.message ? e.message : e}` });
      }
    };
    const pickIntrinsics = async () => {
      try {
        const path = await pickFile('相机内参 (JSON)', ['json']);
        if (path) { setIntrFile(path); setIntr('file'); }
      } catch (e) {
        s.pushLog({ lv: 'err', cat: 'survey', msg: `选择内参文件失败 · ${e && e.message ? e.message : e}` });
      }
    };
    const runVisualReconstruct = async () => {
      if (!visualCapturePath || (intr === 'file' && !intrFile)) return;
      setBaState('running'); setBaPct(0); setBaStage(''); setBaErr('');
      try {
        const response = await meshVisualReconstruct(proj.path, screenId, visualCapturePath, intr === 'auto' ? 'auto' : intrFile, null);
        visualJobRef.current = response.job_id;
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        setBaState('idle'); setBaErr(msg);
        s.pushLog({ lv: 'err', cat: 'survey', msg: `视觉重建启动失败 · ${msg}` });
      }
    };
    const doExport = async () => {
      if (!curRun) return;
      try {
        const out = await s.runCmd({ domain: 'calibrate', action: '导出 OBJ', target: 'run #' + curRun.id, chan: 'local' },
          () => exportObj(curRun.id, target, expPath.trim() || null), { okMsg: (path) => `已导出 <b>${path}</b>` });
        setExpDone(out);
        await CX.reloadRuns(proj.path, screenId);
      } catch (e) { /* runCmd 已记录失败 */ }
    };

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
      /* ① 测试图 —— 仅视觉校正需要 */
      !isTS ? h(Fold, { label: '测试图', defOpen: false },
        h('div', { className: 'gw-stage-badge' }, patternBadge(p.stale, p.genN, multiIds.length)),
        Field('图案方案', h(Sel, { value: p.scheme, options: PATTERN_SCHEMES, onChange: (scheme) => { p.setScheme(scheme); if (scheme === 'charuco' && intr === 'auto') setIntr('file'); }, w: 150 })),
        Field('屏幕标识码', h('input', { className: 'gw-txt', value: String(SCREEN_ID_CODE), readOnly: true, style: { width: 70, textAlign: 'center' } })),
        Field(isMulti ? '目标屏幕 · ' + multiIds.length + ' 块' : '目标屏幕',
          h('span', { style: { fontSize: 12.5, color: 'var(--chrome-text)', fontFamily: 'var(--font-code)', textAlign: 'right', textWrap: 'balance' } },
            isMulti ? multiIds.join(' · ') : screenId)),
        p.busy
          ? h('div', null, h('div', { style: { fontSize: 11.5, color: 'var(--chrome-dim)', marginBottom: 6 } }, '生成中…'), h('div', { className: 'vmeter vmeter--accent ar-indeterminate' }, h('div', { className: 'vmeter__fill' })))
          : h('div', { style: { display: 'flex', gap: 8 } },
              h(Button, { variant: p.gen ? 'secondary' : 'accent', size: 'S', icon: h(Icon, { name: p.gen ? 'sync' : 'grid', size: 14 }), onPress: p.runGen }, p.gen ? '重新生成' : '生成'),
              p.genN > 0 ? h(Button, { variant: 'secondary', size: 'S', icon: h(Icon, { name: 'eye', size: 13 }), onPress: () => s.setCalDisplay(Object.assign({}, s.calDisplay, { pattern: true })) }, '预览') : null),
        p.genN > 0 ? h('div', { style: { marginTop: 8 } }, h(OutputDestination, { s, p })) : null) : null,
      h(Fold, { label: '测量导入', defOpen: false },
        isTS
          ? (window.VOLO_GRID.flows ? window.VOLO_GRID.flows.total(s) : null)
          : h(React.Fragment, null,
              Field('采集方式', h(Sel, { value: capMode, options: [{ id: 'offline', label: '离线照片' }, { id: 'live', label: '现场实时采集' }], onChange: setCapMode, w: 150 })),
              capMode === 'offline'
                ? (captureDir
                    ? h('div', { className: 'gw-fileref' },
                        h('span', { className: 'ic' }, h(Icon, { name: 'folder', size: 14 })),
                        h('div', { className: 'm' }, h('div', { className: 'n' }, captureDir.split(/[\\/]/).pop()), h('div', { className: 'd' }, captureDir)),
                        h(Button, { variant: 'secondary', size: 'S', onPress: pickCaptureDir }, '更换'))
                    : h('div', { className: 'gw-drop', onClick: pickCaptureDir }, h(Icon, { name: 'folder', size: 20 }), h('div', null, '选择照片文件夹')))
                : h(Button, { variant: 'accent', size: 'S', icon: h(Icon, { name: 'camera', size: 14 }), onPress: () => window.VOLO_CAPTURE.openGrid(s, (resultData) => { setCaptureDirs((current) => Object.assign({}, current, { [screenId]: resultData.session_dir })); setCapMode('offline'); }) }, '接入摄影机…'),
              (captureDir || (proj.visualSession && proj.visualSession.screenId === screenId))
                ? h('div', { className: 'cal2-switch-ok', style: { marginTop: 8 } }, h(Icon, { name: 'check', size: 14 }), h('span', null, '已采集 · 采集会话'))
                : null,
              h('div', { style: { marginTop: 10 } }, Field('内参', h(Sel, { value: intr, options: [{ id: 'auto', label: '自动标定' }, { id: 'file', label: '从文件导入' }], onChange: setIntr, w: 150 }))),
              intr === 'auto'
                ? h('div', { className: 'gw-method-note', style: { marginTop: 2 } }, '默认随本次采集自动估计内参，无需设置。')
                : h(Button, { variant: 'secondary', size: 'S', icon: h(Icon, { name: 'download', size: 13 }), onPress: pickIntrinsics }, intrFile ? intrFile.split(/[\\/]/).pop() : '选择内参文件…'))),
      h(Fold, { label: '重建', defOpen: false },
        Field('方法', h('span', { style: { fontSize: 12.5, color: 'var(--chrome-text)', fontWeight: 700 } }, isTS ? '全站仪导入' : '视觉校正')),
        Field('数据源', h('span', { style: { fontSize: 12, color: 'var(--chrome-dim)', fontFamily: 'var(--font-code)' } },
          isTS ? (proj.measured && proj.measured.points ? proj.measured.points.length + ' 点' : '—') : (visualCapturePath ? visualCapturePath.split(/[\\/]/).pop() : '—'))),
        !measured ? h('div', { className: 'gw-stage-warn' }, h(Icon, { name: 'alert', size: 13 }), isTS ? '需先导入全站仪数据' : '需先完成视觉采集') : null,
        !isTS && intr === 'file' && !intrFile ? h('div', { className: 'gw-stage-warn' }, h(Icon, { name: 'alert', size: 13 }), '请选择内参文件') : null,
        baErr && !isTS ? h('div', { className: 'gw-stage-warn' }, h(Icon, { name: 'alert', size: 13 }), baErr) : null,
        !isTS && baState === 'running'
          ? h('div', null,
              h('div', { style: { fontSize: 11.5, color: 'var(--chrome-dim)', marginBottom: 6 } }, (baStage || '视觉重建中') + ' · ' + Math.round(baPct) + '%'),
              h('div', { className: 'vmeter vmeter--accent' }, h('div', { className: 'vmeter__fill', style: { width: baPct + '%' } })))
          : h(Button, { variant: 'accent', size: 'M', isDisabled: !measured || (!isTS && intr === 'file' && !intrFile), icon: h(Icon, { name: 'cube3', size: 15 }), onPress: isTS ? () => s.setModal({ render: ({ close }) => window.VOLO_GRID_MODALS.reconstruct(s, close) }) : runVisualReconstruct }, baState === 'done' && !isTS ? '重新重建' : '开始重建'),
        built && curRun ? h('div', { className: 'gw-fileref', style: { marginTop: 8 } }, h('span', { className: 'ic' }, h(Icon, { name: 'cube3', size: 14 })),
          h('div', { className: 'm' },
            h('div', { className: 'n' }, 'run #' + curRun.id + (curRun.output_obj_path ? ' · ' + curRun.output_obj_path.split(/[\\/]/).pop() : '')),
            h('div', { className: 'd' }, (curRun.estimated_rms_mm == null ? 'RMS n/a' : 'RMS ' + curRun.estimated_rms_mm.toFixed(2) + ' mm') + (curRun.is_current ? ' · 当前' : '')))) : null),
      h(Fold, { label: '导出', defOpen: false },
        !built ? h('div', { className: 'gw-stage-warn' }, h(Icon, { name: 'alert', size: 13 }), '需先完成一次重建') : null,
        expDone
          ? h('div', { className: 'cal2-switch-ok', style: { marginTop: 0 } }, h(Icon, { name: 'check', size: 14 }),
              h('span', null, '已导出 ', h('b', null, String(expDone).split(/[\\/]/).pop()), ' → ', (GRID_EXPORT_TARGETS.find((t) => t.id === target) || {}).label))
          : h(React.Fragment, null,
              h('div', { className: 'gw-export-targets', style: { opacity: built ? 1 : .5, pointerEvents: built ? 'auto' : 'none' } }, GRID_EXPORT_TARGETS.map((t) => h('button', { key: t.id, className: 'gw-etarget' + (t.id === target ? ' on' : ''), onClick: () => setTarget(t.id) },
                h('span', { className: 'rd' }), h('div', { className: 'm' }, h('b', null, t.label), h('span', null, t.desc))))),
              h('div', { className: 'gw-field stack', style: { marginTop: 8 } }, h('span', { className: 'lb' }, '输出路径', h('span', { className: 'hint' }, '留空 = 项目默认输出位置')),
                h('input', { className: 'gw-txt', value: expPath, placeholder: '默认输出到项目 output 配置', onChange: (e) => setExpPath(e.target.value) })),
              h('div', { className: 'gw-stage-acts' },
                h(Button, { variant: 'accent', size: 'S', isDisabled: !built || !curRun, icon: h(Icon, { name: 'download', size: 13 }), onPress: doExport }, '导出 OBJ'),
                h(Button, { variant: 'secondary', size: 'S', icon: h(Icon, { name: 'doc', size: 13 }), onPress: () => s.setModal({ render: ({ close }) => window.VOLO_GRID_MODALS.guideCard(s, close) }) }, '指导卡 PDF')))));
  }
  function t_isTsNote() { return '全站仪实测箱体角点，毫米级绝对精度；无需测试图。'; }

  function inspector(s) {
    const sel = s.calSel;
    const t = sel && sel.type;
    if (t === 'screenMulti') {
      const ids = sel.ids || [];
      return h('div', { className: 'gw-insp' },
        h('div', { className: 'gw-multi-banner' },
          h('span', { className: 'ic' }, h(Icon, { name: 'panel', size: 15 })),
          h('div', { className: 'm' }, h('b', null, '多选 · ' + ids.length + ' 块屏幕'), h('span', null, '改动将应用到全部选中屏幕')),
          h('span', { className: 'spill spill--informative' }, h(Icon, { name: 'check', size: 12 }), '多选')),
        h(StagePanel, { s }));
    }
    const body = t === 'cabinet' ? h(BoxSingle, { s })
      : t === 'cabinetMulti' ? h(BoxMulti, { s })
      : t === 'run' ? h(RunInsp, { s })
      : t === 'pattern' ? h(PatternPanel, { s })
      : null;
    return h('div', { className: 'gw-insp' }, h(StagePanel, { s }), body ? h('div', { className: 'gw-insp-sep' }) : null, body);
  }

  window.VOLO_GRID = Object.assign(window.VOLO_GRID || {}, { inspector, ScreenForm });
})();
