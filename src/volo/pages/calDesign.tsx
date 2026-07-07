// @ts-nocheck
/* Volo — 校正 · 网格校正 · 屏幕与设计（满铺 cabinet 网格编辑画布）
   1:1 port of the Claude Design handoff `src/cal2_design.jsx`, wired to the real
   ScreenConfig（cabinet_count / shape_mode / irregular_mask / bottom_completion）
   通过旧 pages/calibrate.tsx 里已验证过的真实映射规则搬过来（W2 item 3 的原始注释保留）：
   - masked ← ScreenConfig.irregular_mask（cabinet 索引），只在 shape_mode==='irregular'
     时对后端生效，rectangle 模式下会被 export.rs / total_station_mapper.rs 忽略。
   - below ← ScreenConfig.bottom_completion.lowest_measurable_row 派生的只读提示，不回写。
   - ref(origin/x_axis/xy_plane) ← 无法忠实映射到 cabinet 格子（coordinate_system 绑定
     的是顶点点名，一个 cabinet 格子对应 4 个顶点角，没有既定的"选哪个角"规则）——
     保留模式按钮供本地探索，但不参与保存；真实 coordinate_system 点名只读展示。 */
import * as React from "react";
import { saveProjectYaml } from "../api/meshCommands";

(function () {
  const { Button, Switch } = window.Spectrum2DesignSystem_b6d1b3;
  const { useState, useEffect, useRef, useLayoutEffect } = React;
  const h = React.createElement;
  const CX = window.VOLO_CAL2;

  const ROLE = {
    origin:   { label: 'origin',   short: 'O',  color: 'var(--positive-visual)' },
    x_axis:   { label: 'x_axis',   short: 'X',  color: 'var(--volo-600)' },
    xy_plane: { label: 'xy_plane', short: 'XY', color: 'var(--informative-visual)' },
  };
  const CAB_STATE = { normal: '正常', masked: '遮罩', below: '基线以下', ref: '参考点' };

  /* 画布内屏幕选择器（浮层暗色下拉） */
  function ScreenChip({ s }) {
    const [open, setOpen] = useState(false);
    const ref = useRef(null);
    const proj = CX.useProj();
    const screens = CX.deriveScreens(proj.config);
    const screen = CX.scr(s);
    useEffect(() => {
      if (!open) return;
      const fn = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
      document.addEventListener('mousedown', fn);
      return () => document.removeEventListener('mousedown', fn);
    }, [open]);
    return h('div', { className: 'cal2-scrchip', ref },
      h('button', { className: 'cal2-scrchip-btn', onClick: () => setOpen((v) => !v) },
        h(Icon, { name: 'panel', size: 14 }), h('span', { className: 'k' }, '屏幕'), h('b', null, screen.id), h(Icon, { name: 'chevd', size: 13 })),
      open ? h('div', { className: 'cal2-scrchip-pop' }, screens.map((x) => h('button', {
        key: x.id, className: 'cal2-scrchip-i' + (x.id === screen.id ? ' on' : ''),
        onClick: () => { s.setCalScreen(x.id); setOpen(false); } },
        h('div', { className: 'cal2-scrchip-m' }, h('b', null, x.id)),
        h('span', { className: 'cal2-scrchip-s' }, x.cols + '×' + x.rows + ' · ' + (x.shape_mode === 'irregular' ? '异形' : '规则矩形')),
        x.id === screen.id ? h('span', { className: 'cal2-scrchip-ck' }, h(Icon, { name: 'check', size: 14 })) : null))) : null);
  }

  /* 从真实 ScreenConfig 派生初始格子态：masked ← irregular_mask，below ← bottom_completion 只读提示。 */
  function seedCellsFromConfig(sc) {
    const m = {};
    (sc.irregular_mask || []).forEach(([c, r]) => { m[c + ',' + r] = { state: 'masked' }; });
    const bc = sc.bottom_completion;
    if (bc && typeof bc.lowest_measurable_row === 'number') {
      for (let r = 0; r < bc.lowest_measurable_row; r++) {
        for (let c = 0; c < sc.cabinet_count[0]; c++) {
          const key = c + ',' + r;
          if (!m[key]) m[key] = { state: 'below' };
        }
      }
    }
    return m;
  }

  function Design({ s }) {
    const proj = CX.useProj();
    const screen = CX.scr(s);
    const { cols, rows } = screen;
    const screenConfig = (proj.config && proj.config.screens[screen.id]) || { cabinet_count: [1, 1], irregular_mask: [] };
    const [cells, setCells] = useState(() => seedCellsFromConfig(screenConfig));
    const [mode, setMode] = useState('select');
    const [role, setRole] = useState('origin');
    const [undoStack, setUndo] = useState([]);
    const [redoStack, setRedo] = useState([]);
    const [dirty, setDirty] = useState(false);
    const [saving, setSaving] = useState(false);
    const stageRef = useRef(null);
    const panRef = useRef(null);
    const [zoom, setZoom] = useState(1);
    const [pan, setPan] = useState({ x: 0, y: 0 });
    const [fitW, setFitW] = useState(0);
    const [selKeys, setSelKeys] = useState(() => new Set());
    const marqueeRef = useRef(null);
    const [marquee, setMarquee] = useState(null);
    const selKeysRef = useRef(selKeys); selKeysRef.current = selKeys;
    const cellsRef = useRef(cells); cellsRef.current = cells;
    const setSel = (n) => { selKeysRef.current = n; setSelKeys(n); };
    const irregular = screenConfig.shape_mode === 'irregular';

    const setMultiSel = (arr) => {
      if (!arr.length) { s.setCalSel(null); return; }
      if (arr.length === 1) { const [c, r] = arr[0].split(',').map(Number); const cell = cellsRef.current[arr[0]] || { state: 'normal' }; s.setCalSel({ type: 'cabinet', col: c, row: r, state: cell.state || 'normal', role: cell.role || null }); return; }
      const bd = { normal: 0, masked: 0, below: 0, ref: 0 };
      arr.forEach((k) => { const st = (cellsRef.current[k] && cellsRef.current[k].state) || 'normal'; bd[st] = (bd[st] || 0) + 1; });
      s.setCalSel({ type: 'cabinetMulti', count: arr.length, bd, keys: arr });
    };

    useEffect(() => {
      const el = stageRef.current; if (!el) return;
      const onWheel = (e) => { e.preventDefault(); setZoom((z) => Math.max(0.4, Math.min(4, +(z - Math.sign(e.deltaY) * 0.12).toFixed(2)))); };
      el.addEventListener('wheel', onWheel, { passive: false });
      const move = (e) => { if (!panRef.current) return; setPan({ x: panRef.current.px + (e.clientX - panRef.current.x), y: panRef.current.py + (e.clientY - panRef.current.y) }); };
      const up = () => { if (panRef.current) { el.classList.remove('panning'); panRef.current = null; } };
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
      return () => { el.removeEventListener('wheel', onWheel); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    }, [pan]);

    const onStageDown = (e) => {
      if (e.button === 2) { e.preventDefault(); panRef.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y }; stageRef.current.classList.add('panning'); return; }
      if (e.button !== 0 || mode !== 'select') return;
      if (e.metaKey || e.altKey) return;
      e.preventDefault();
      marqueeRef.current = { x: e.clientX, y: e.clientY, moved: false, onCell: !!(e.target.closest && e.target.closest('.cab')) };
    };
    const resetView = () => { setZoom(1); setPan({ x: 0, y: 0 }); };

    useEffect(() => {
      const move = (e) => {
        const m = marqueeRef.current; if (!m) return;
        if (Math.abs(e.clientX - m.x) + Math.abs(e.clientY - m.y) > 4) m.moved = true;
        const el = stageRef.current; const rect = el.getBoundingClientRect();
        setMarquee({ x0: m.x - rect.left, y0: m.y - rect.top, x1: e.clientX - rect.left, y1: e.clientY - rect.top });
        const minX = Math.min(m.x, e.clientX), maxX = Math.max(m.x, e.clientX), minY = Math.min(m.y, e.clientY), maxY = Math.max(m.y, e.clientY);
        const set = new Set();
        el.querySelectorAll('.cab').forEach((cab) => { const r = cab.getBoundingClientRect(); if (r.left < maxX && r.right > minX && r.top < maxY && r.bottom > minY) set.add(cab.dataset.cr); });
        setSel(set);
      };
      const up = () => {
        const m = marqueeRef.current; if (!m) return;
        marqueeRef.current = null; setMarquee(null);
        if (m.moved) setMultiSel([...selKeysRef.current]);
        else if (!m.onCell) { setSel(new Set()); s.setCalSel(null); }
      };
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
      return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    }, []);

    useLayoutEffect(() => {
      const el = stageRef.current; if (!el) return;
      const PAD = 56;
      const calc = () => { const w = el.clientWidth - PAD, hh = el.clientHeight - PAD; if (w <= 0 || hh <= 0) return; setFitW(Math.max(160, Math.min(w, hh * (cols / rows)))); };
      calc();
      const ro = new ResizeObserver(calc); ro.observe(el);
      return () => ro.disconnect();
    }, [cols, rows]);

    useEffect(() => { setCells(seedCellsFromConfig(screenConfig)); setUndo([]); setRedo([]); setZoom(1); setPan({ x: 0, y: 0 }); setSel(new Set()); setDirty(false); s.setCalSel(null); }, [s.calScreen, proj.config]);

    const sel1 = (c, r, cell) => s.setCalSel({ type: 'cabinet', col: c, row: r, state: (cell && cell.state) || 'normal', role: (cell && cell.role) || null });
    const commit = (next) => { setUndo((u) => [...u, cells]); setRedo([]); setCells(next); setDirty(true); };
    const doUndo = () => { if (!undoStack.length) return; setRedo((r) => [...r, cells]); setCells(undoStack[undoStack.length - 1]); setUndo((u) => u.slice(0, -1)); setDirty(true); };
    const doRedo = () => { if (!redoStack.length) return; setUndo((u) => [...u, cells]); setCells(redoStack[redoStack.length - 1]); setRedo((r) => r.slice(0, -1)); setDirty(true); };

    /* expose masking API to inspector via s.calDesignApi */
    const applyMask = (keys, on) => { const next = Object.assign({}, cells); keys.forEach((k) => { next[k] = on ? { state: 'masked' } : { state: 'normal' }; }); commit(next); };
    s.calDesignApi = { applyMask, cells };

    useEffect(() => {
      const onKey = (e) => {
        if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
        const k = e.key.toLowerCase();
        if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
        if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); doRedo(); return; }
        if (k === 'm') setMode((m) => m === 'mask' ? 'select' : 'mask');
        else if (k === 'r') setMode((m) => m === 'refs' ? 'select' : 'refs');
        else if (k === 'b') setMode((m) => m === 'baseline' ? 'select' : 'baseline');
        else if (k === 'v' || k === 'escape') setMode('select');
        else if (k === '1') setRole('origin'); else if (k === '2') setRole('x_axis'); else if (k === '3') setRole('xy_plane');
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [mode, cells, undoStack, redoStack]);

    const onCell = (c, r, e) => {
      const key = c + ',' + r; const cur = cells[key] || { state: 'normal' };
      if (mode === 'select') {
        if (e && (e.metaKey || e.altKey)) { const n = new Set(selKeysRef.current); n.has(key) ? n.delete(key) : n.add(key); setSel(n); setMultiSel([...n]); return; }
        setSel(new Set([key])); sel1(c, r, cur); return;
      }
      const next = Object.assign({}, cells);
      if (mode === 'mask') next[key] = cur.state === 'masked' ? { state: 'normal' } : { state: 'masked' };
      else if (mode === 'baseline') next[key] = cur.state === 'below' ? { state: 'normal' } : { state: 'below' };
      else if (mode === 'refs') next[key] = { state: 'ref', role };
      commit(next); setSel(new Set([key])); sel1(c, r, next[key]);
    };

    const grid = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const cell = cells[c + ',' + r] || { state: 'normal' };
      const isSel = selKeys.has(c + ',' + r);
      let cls = 'cab';
      if (cell.state === 'masked') cls += ' masked';
      else if (cell.state === 'below') cls += ' below';
      else if (cell.state === 'ref') cls += ' ref-' + cell.role;
      if (isSel) cls += ' sel';
      grid.push(h('div', { key: c + ',' + r, className: cls, 'data-cr': c + ',' + r, onClick: (e) => onCell(c, r, e), title: c + ',' + r },
        cell.state === 'ref' ? h('span', { className: 'rl', title: c + ',' + r }, ROLE[cell.role].short) : null));
    }

    const ModeBtn = (id, label, key, icon) => h('button', { className: 'cal2-mbtn' + (mode === id ? ' on' : ''), onClick: () => setMode((m) => m === id ? 'select' : id), title: label + ' (' + key + ')' },
      h(Icon, { name: icon, size: 15 }), h('span', null, label), h('kbd', null, key));

    /* 只回写 irregular_mask（遮罩），below/ref 是本地预览，见文件顶部注释。 */
    const doSave = async () => {
      if (!proj.path || saving || !proj.config) return;
      const screenId = screen.id;
      const irregular_mask = Object.entries(cells).filter(([, v]) => v.state === 'masked').map(([k]) => k.split(',').map(Number));
      const nextConfig = { ...proj.config, screens: { ...proj.config.screens, [screenId]: { ...proj.config.screens[screenId], irregular_mask } } };
      setSaving(true);
      try {
        await s.runCmd({ domain: 'calibrate', action: '保存工程', target: screenId, chan: 'local' },
          () => saveProjectYaml(proj.path, nextConfig),
          { okMsg: () => `已保存 <b>${screenId}</b> 的遮罩改动（${irregular_mask.length} 格）` });
        await CX.openProjectPath(proj.path, s); /* 回读校验 */
        setDirty(false);
      } catch (e) { /* runCmd 已记录失败 */ } finally { setSaving(false); }
    };

    return h('div', { className: 'cal2-canvas-wrap' },
      !irregular ? h('div', { className: 'cal2-hintbar' }, h(Icon, { name: 'info', size: 14 }),
        h('span', null, '当前屏幕为规则矩形（', h('code', null, 'shape_mode = ' + screenConfig.shape_mode), '），遮罩不生效 —— 仅异形屏需要遮罩镂空。')) : null,
      h('div', { className: 'cal2-stage', ref: stageRef, onMouseDown: onStageDown, onContextMenu: (e) => e.preventDefault() },
        h('div', { className: 'cal2-float cal2-float--tl' },
          h(ScreenChip, { s }),
          h('div', { className: 'cal2-modeseg' },
            h('button', { className: 'cal2-mbtn' + (mode === 'select' ? ' on' : ''), onClick: () => setMode('select'), title: '选择 (V)' }, h(Icon, { name: 'target', size: 15 }), h('span', null, '选择'), h('kbd', null, 'V')),
            ModeBtn('mask', '遮罩', 'M', 'panel'),
            ModeBtn('baseline', '基线', 'B', 'ruler'),
            ModeBtn('refs', '参考点', 'R', 'pin')),
          mode === 'refs' ? h('div', { className: 'cal2-roleseg' }, ['origin', 'x_axis', 'xy_plane'].map((rk, i) =>
            h('button', { key: rk, className: role === rk ? 'on' : '', onClick: () => setRole(rk), title: ROLE[rk].label },
              h('span', { className: 'sdot', style: { background: ROLE[rk].color } }), ROLE[rk].label, h('kbd', null, i + 1)))) : null),
        h('div', { className: 'cal2-float cal2-float--tr' },
          h('div', { className: 'zoombar' },
            h('button', { className: 'zb-btn', onClick: () => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2))) }, '−'),
            h('button', { className: 'zb-lbl', onClick: resetView, title: '适应窗口' }, Math.round(zoom * 100) + '%'),
            h('button', { className: 'zb-btn', onClick: () => setZoom((z) => Math.min(3, +(z + 0.25).toFixed(2))) }, '+')),
          h('button', { className: 'iconbtn', disabled: !undoStack.length, style: { opacity: undoStack.length ? 1 : .4 }, onClick: doUndo, title: '撤销' }, h(Icon, { name: 'undo', size: 16 })),
          h('button', { className: 'iconbtn', disabled: !redoStack.length, style: { opacity: redoStack.length ? 1 : .4 }, onClick: doRedo, title: '重做' }, h(Icon, { name: 'redo', size: 16 })),
          h('button', { className: 'cal2-savebtn' + (dirty ? ' dirty' : ''), disabled: !proj.path || saving, onClick: doSave },
            dirty ? h('span', { className: 'cal2-dirtydot' }) : h(Icon, { name: saving ? 'sync' : 'check', size: 14 }),
            dirty ? '保存 *' : saving ? '保存中…' : '已保存')),
        h('div', { className: 'cal2-gridwrap' },
          h('div', { className: 'cabgrid', style: { gridTemplateColumns: 'repeat(' + cols + ', 1fr)', width: fitW ? fitW + 'px' : undefined, transform: 'translate(' + pan.x + 'px,' + pan.y + 'px) scale(' + zoom + ')' } }, grid)),
        marquee ? h('div', { className: 'marquee-box', style: { left: Math.min(marquee.x0, marquee.x1), top: Math.min(marquee.y0, marquee.y1), width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0) } }) : null,
        h('div', { className: 'cal2-float cal2-float--bl cal2-leg' },
          h('span', { className: 'leg-i' }, h('span', { className: 'leg-sw', style: { background: '#3a4654' } }), '正常'),
          h('span', { className: 'leg-i' }, h('span', { className: 'leg-sw', style: { background: 'repeating-linear-gradient(45deg,#26262b 0 3px,#1b1b1f 3px 6px)' } }), '遮罩'),
          h('span', { className: 'leg-i' }, h('span', { className: 'leg-sw', style: { background: '#243a52' } }), '基线以下'),
          h('span', { className: 'leg-i' }, h('span', { className: 'leg-sw', style: { background: ROLE.origin.color } }), 'origin'),
          h('span', { className: 'leg-i' }, h('span', { className: 'leg-sw', style: { background: ROLE.x_axis.color } }), 'x_axis'),
          h('span', { className: 'leg-i' }, h('span', { className: 'leg-sw', style: { background: ROLE.xy_plane.color } }), 'xy_plane')),
        proj.config ? h('div', { className: 'cal2-float cal2-float--br', style: { fontSize: 10.5, color: 'var(--chrome-faint)', maxWidth: 420, textAlign: 'right', background: 'rgba(0,0,0,.5)', padding: '5px 10px', borderRadius: 7 } },
          '坐标系参考点（只读 · coordinate_system）：',
          h('span', { className: 'mono', style: { marginLeft: 4 } }, proj.config.coordinate_system.origin_point),
          ' / ', h('span', { className: 'mono' }, proj.config.coordinate_system.x_axis_point),
          ' / ', h('span', { className: 'mono' }, proj.config.coordinate_system.xy_plane_point)) : null,
        h('div', { className: 'cal2-canvas-axis' }, screen.id + ' · ' + cols + '×' + rows + ' cabinet · ' + (mode === 'select' ? '选择' : mode === 'mask' ? '遮罩' : mode === 'baseline' ? '基线' : '参考点') + '模式')));
  }

  /* ---------- inspector ---------- */
  const KV = (k, v, mono) => h('div', { className: 'kv', key: k }, h('span', { className: 'k' }, k), h('span', { className: 'v' + (mono ? ' mono' : '') }, v));
  function designInspector(s) {
    const sel = s.calSel;
    const screen = CX.scr(s);
    if (!sel || (sel.type !== 'cabinet' && sel.type !== 'cabinetMulti')) return CX.inspEmpty('选择 cabinet 格查看行列 / 遮罩');
    if (sel.type === 'cabinetMulti') {
      const bd = sel.bd || {};
      const order = [['normal', 'informative'], ['masked', 'neutral'], ['below', 'notice'], ['ref', 'positive']].filter(([k]) => bd[k]);
      const anyUnmasked = (bd.normal || 0) + (bd.below || 0) > 0;
      return h(React.Fragment, null,
        h('div', { className: 'insp-head' },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 } },
            h('span', { className: 'step-ico', style: { width: 30, height: 30, borderRadius: 8, background: 'var(--wash)', display: 'grid', placeItems: 'center' } }, h(Icon, { name: 'grid', size: 16 })),
            h('h2', { style: { margin: 0, fontSize: 15, fontWeight: 700, fontFamily: 'var(--font-code)' } }, '已选 ' + sel.count + ' 个 Cabinet')),
          h('span', { className: 'spill spill--informative' }, h(Icon, { name: 'check', size: 13 }), '多选')),
        h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, '选区构成'),
          order.map(([k, v]) => h('div', { className: 'kv', key: k },
            h('span', { className: 'k' }, h('span', { className: 'sdot bg-' + v, style: { display: 'inline-block', marginRight: 7 } }), CAB_STATE[k]),
            h('span', { className: 'v' }, bd[k])))),
        h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, '批量遮罩'),
          h('div', { style: { display: 'flex', gap: 8 } },
            h(Button, { variant: 'accent', size: 'S', isDisabled: !anyUnmasked, icon: h(Icon, { name: 'panel', size: 14 }), onPress: () => s.calDesignApi && s.calDesignApi.applyMask(sel.keys, true) }, '全部遮罩'),
            h(Button, { variant: 'secondary', size: 'S', icon: h(Icon, { name: 'x', size: 14 }), onPress: () => s.calDesignApi && s.calDesignApi.applyMask(sel.keys, false) }, '取消遮罩')),
          screen.shape_mode !== 'irregular' ? h('div', { style: { fontSize: 11.5, color: 'var(--chrome-faint)', marginTop: 10, lineHeight: 1.5 } }, '规则矩形屏遮罩不生效，仅异形屏需要。') : null));
    }
    const st = sel.state || 'normal';
    const stVis = st === 'masked' ? 'neutral' : st === 'below' ? 'notice' : st === 'ref' ? 'positive' : 'informative';
    const isMasked = st === 'masked';
    return h(React.Fragment, null,
      h('div', { className: 'insp-head' },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 } },
          h('span', { className: 'step-ico', style: { width: 30, height: 30, borderRadius: 8, background: 'var(--wash)', display: 'grid', placeItems: 'center' } }, h(Icon, { name: 'grid', size: 16 })),
          h('h2', { style: { margin: 0, fontSize: 15, fontWeight: 700, fontFamily: 'var(--font-code)' } }, 'Cabinet ' + sel.col + ',' + sel.row)),
        h('span', { className: 'spill spill--' + stVis }, h(Icon, { name: st === 'normal' ? 'check' : 'panel', size: 13 }), CAB_STATE[st])),
      h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, '位置'),
        KV('列 (col)', sel.col, true), KV('行 (row)', sel.row, true)),
      st !== 'ref' ? h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, '遮罩'),
        h('div', { className: 'cap-toggle-row' },
          h('div', null, h('div', { className: 'cap-tg-t' }, '遮罩此格'), h('div', { className: 'cap-tg-s' }, isMasked ? '不参与重建' : '参与重建')),
          h(Switch, { isSelected: isMasked, onChange: (v) => s.calDesignApi && s.calDesignApi.applyMask([sel.col + ',' + sel.row], v) })),
        screen.shape_mode !== 'irregular' ? h('div', { style: { fontSize: 11.5, color: 'var(--chrome-faint)', marginTop: 8, lineHeight: 1.5 } }, '规则矩形屏遮罩不生效。') : null) : null,
      sel.role ? h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, '坐标系角色 · 只读（本地预览，不参与保存）'),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
          h('span', { className: 'sdot', style: { background: ROLE[sel.role].color, width: 11, height: 11 } }),
          h('b', { style: { fontFamily: 'var(--font-code)', fontSize: 13 } }, ROLE[sel.role].label)),
        h('div', { style: { fontSize: 12, color: 'var(--chrome-dim)', lineHeight: 1.5 } },
          '真实 coordinate_system 引用的是顶点点名，不是 cabinet 格子，此处仅供本地探索。')) : null);
  }

  window.VOLO_CAL2 = Object.assign(window.VOLO_CAL2 || {}, { Design, designInspector });
})();
