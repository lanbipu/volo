// @ts-nocheck
/* Volo — Calibrate page (LED mesh reconstruct → lens solve).
   1:1 port of the Claude Design handoff `src/page_calibrate.jsx`. */
import * as React from "react";
import "../ds";

(function () {
  const { Button, Badge, InlineAlert } = window.Spectrum2DesignSystem_b6d1b3;
  const { useState, useEffect, useRef, useLayoutEffect } = React;
  const h = React.createElement;

  const ROLE = {
    origin:   { label: 'origin',   short: 'O',  color: 'var(--positive-visual)' },
    x_axis:   { label: 'x_axis',   short: 'X',  color: 'var(--volo-700)' },
    xy_plane: { label: 'xy_plane', short: 'XY', color: 'var(--informative-visual)' },
  };
  const CAB_STATE = { normal: '正常', masked: '遮罩', below: '基线以下', ref: '参考点' };
  const SEVCAL = {
    healthy:  { visual: 'positive', icon: 'check' },
    warning:  { visual: 'notice',   icon: 'alert' },
    critical: { visual: 'negative', icon: 'alert' },
  };

  function rmsBadge(rms) {
    if (rms == null) return h(Badge, { variant: 'neutral', size: 'S' }, 'n/a');
    const v = rms < 3 ? 'positive' : rms < 8 ? 'notice' : 'negative';
    return h(Badge, { variant: v, size: 'S' }, rms.toFixed(2) + ' mm');
  }

  /* =================== context toolbar =================== */
  function ExportDrop({ s }) {
    const [open, setOpen] = useState(false);
    const ref = useRef(null);
    useEffect(() => {
      if (!open) return;
      const fn = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
      document.addEventListener('mousedown', fn);
      return () => document.removeEventListener('mousedown', fn);
    }, [open]);
    const opts = [
      { id: 'disguise', label: 'Disguise', sub: '.obj + 顶点贴图' },
      { id: 'unreal',   label: 'Unreal',   sub: 'nDisplay 配置' },
      { id: 'neutral',  label: 'Neutral',  sub: '.obj 中性网格' },
    ];
    return h('div', { className: 'ctx-drop', ref },
      h('button', { className: 'ctx-drop-btn', onClick: () => setOpen((v) => !v) },
        h(Icon, { name: 'download', size: 15 }), '导出', h(Icon, { name: 'chevd', size: 14 })),
      open ? h('div', { className: 'popover' },
        opts.map((o) => h('div', { key: o.id, className: 'pop-i', onClick: () => { setOpen(false); s.pushLog({ lv: 'ok', cat: 'calibrate', msg: `导出网格为 <b>${o.label}</b> 格式 → mesh_v6.obj` }); } },
          h('div', { style: { display: 'flex', flexDirection: 'column', lineHeight: 1.2 } },
            h('span', { className: 'pop-l' }, o.label), h('span', { className: 'pop-s' }, o.sub))))) : null);
  }

  function ctx(s) {
    const sc = CAL_SCREENS.find((x) => x.id === s.calScreen) || CAL_SCREENS[0];
    return h(React.Fragment, null,
      h(CtxTitle, { icon: 'calibrate', title: 'Calibrate', sub: 'LED 网格重建 → 镜头校正' }),
      h('div', { className: 'ctx-div' }),
      h(Selector, { kpre: '屏幕', value: s.calScreen, width: 196,
        options: CAL_SCREENS.map((x) => ({ id: x.id, label: x.name, sub: `${x.cols}×${x.rows} · ${x.panels} 面板` })),
        onChange: s.setCalScreen }),
      h('div', { className: 'ctx-actions' },
        h(Button, { variant: 'secondary', size: 'S', icon: h(Icon, { name: 'sync', size: 15 }),
          onPress: () => s.pushLogs([
            { lv: 'info', cat: 'calibrate', msg: `重建 <b>${sc.name}</b> 网格 …` },
            { lv: 'ok', cat: 'calibrate', msg: 'mesh_v7 重建收敛，estimated RMS <b>0.40 mm</b>' },
          ]) }, '重建'),
        h(ExportDrop, { s }),
        h(Button, { variant: 'secondary', size: 'S', icon: h(Icon, { name: 'doc', size: 15 }),
          onPress: () => s.pushLog({ lv: 'info', cat: 'calibrate', msg: '生成校正指导卡 → guide_card.pdf' }) }, '生成指导卡')));
  }

  /* =================== left: workflow =================== */
  function StepItem({ st, s }) {
    const isCur = s.calStep === st.id;
    const done = st.status === 'done';
    const cls = 'cstep' + (isCur ? ' on' : '') + (done ? ' done' : '');
    const statusTxt = done ? '已完成' : st.status === 'active' ? '进行中' : st.status === 'ready' ? '可用' : '待运行';
    return h('div', { key: st.id, className: cls, onClick: () => s.setCalStep(st.id) },
      h('span', { className: 'cstep-ico' }, done ? h(Icon, { name: 'check', size: 13 }) : st.n),
      h('div', { className: 'cstep-main' },
        h('div', { className: 'cstep-t' }, st.label, h('span', { className: 'cn' }, ' · ' + st.cn)),
        h('div', { className: 'cstep-s' }, statusTxt),
        isCur ? h('div', { className: 'step-d' }, STEP_DETAIL[st.id]) : null));
  }
  const STEP_DETAIL = {
    design: '编辑 Cabinet 网格 — 遮罩、基线与参考点，定义重建范围与坐标系',
    method: '选择重建方法：M1 全站仪 或 M2 视觉（ChArUco + BA）',
    survey: '导入测量数据并核对：measured / fabricated / outlier / missing',
    preview: '检查重建网格 — 拓扑、顶点与质量偏差，旋转查看曲率',
    runs: '历史重建记录，按 RMS 与目标筛选，可展开报告',
    lens: '镜头校正：Validate → Detect → Solve → Report（7-DOF 变换）',
  };

  function left(s) {
    const mesh = CAL_STEPS.filter((x) => x.group === 'mesh');
    const lens = CAL_STEPS.filter((x) => x.group === 'lens');
    return h(React.Fragment, null,
      h('div', { className: 'sect' },
        h('div', { className: 'sect-h' }, h('span', { className: 't' }, '网格重建')),
        h('div', { className: 'cal-list' }, mesh.map((st) => h(StepItem, { key: st.id, st, s })))),
      h('div', { className: 'sect' },
        h('div', { className: 'sect-h' }, h('span', { className: 't' }, '镜头校正')),
        h('div', { className: 'cal-list' }, lens.map((st) => h(StepItem, { key: st.id, st, s })))),
      h('div', { className: 'sect', style: { marginTop: 'auto' } },
        h('div', { className: 'farm-roll' },
          h('div', { className: 'top' }, h('span', null, '重建进度'), h('span', null, '4 / 5')),
          h('div', { className: 'vmeter vmeter--accent' }, h('div', { className: 'vmeter__fill', style: { width: '80%' } })),
          h('div', { className: 'top', style: { marginTop: 10 } }, h('span', null, '镜头校正'), h('span', null, '未运行')),
          h('div', { className: 'vmeter vmeter--neutral' }, h('div', { className: 'vmeter__fill', style: { width: '0%' } })))));
  }

  /* =================== Design: cabinet editor =================== */
  function seedCells(screen) {
    const { cols, rows } = screen, m = {};
    const set = (c, r, v) => { if (c >= 0 && c < cols && r >= 0 && r < rows) m[c + ',' + r] = v; };
    set(0, 0, { state: 'masked' }); set(1, 0, { state: 'masked' }); set(0, 1, { state: 'masked' });
    set(cols - 1, rows - 1, { state: 'masked' }); set(cols - 2, rows - 1, { state: 'masked' });
    set(3, rows - 2, { state: 'below' }); set(4, rows - 2, { state: 'below' }); set(2, rows - 1, { state: 'below' });
    set(2, rows - 2, { state: 'ref', role: 'origin' });
    set(cols - 3, rows - 2, { state: 'ref', role: 'x_axis' });
    set(cols - 3, 1, { state: 'ref', role: 'xy_plane' });
    return m;
  }

  function CabinetEditor({ s }) {
    const screen = CAL_SCREENS.find((x) => x.id === s.calScreen) || CAL_SCREENS[0];
    const { cols, rows } = screen;
    const [cells, setCells] = useState(() => seedCells(screen));
    const [mode, setMode] = useState('select');
    const [role, setRole] = useState('origin');
    const [undoStack, setUndo] = useState([]);
    const [redoStack, setRedo] = useState([]);
    const stageRef = useRef(null);
    const panRef = useRef(null);
    const [zoom, setZoom] = useState(1);
    const [pan, setPan] = useState({ x: 0, y: 0 });
    const [fitW, setFitW] = useState(0);
    /* multi-selection: a set of "c,r" keys; s.calSel mirrors it for the inspector */
    const [selKeys, setSelKeys] = useState(() => new Set());
    const marqueeRef = useRef(null);
    const [marquee, setMarquee] = useState(null);
    const selKeysRef = useRef(selKeys); selKeysRef.current = selKeys;
    const cellsRef = useRef(cells); cellsRef.current = cells;
    const setSel = (nextSet) => { selKeysRef.current = nextSet; setSelKeys(nextSet); };
    const setMultiSel = (arr) => {
      if (!arr.length) { s.setCalSel(null); return; }
      if (arr.length === 1) { const [c, r] = arr[0].split(',').map(Number); const cell = cellsRef.current[arr[0]] || { state: 'normal' }; s.setCalSel({ type: 'cabinet', col: c, row: r, state: cell.state || 'normal', role: cell.role || null }); return; }
      const bd = { normal: 0, masked: 0, below: 0, ref: 0 };
      arr.forEach((k) => { const st = (cellsRef.current[k] && cellsRef.current[k].state) || 'normal'; bd[st] = (bd[st] || 0) + 1; });
      s.setCalSel({ type: 'cabinetMulti', count: arr.length, bd });
    };

    /* wheel = zoom · left-drag on empty area = free pan in any direction (vector-canvas feel) */
    useEffect(() => {
      const el = stageRef.current; if (!el) return;
      const onWheel = (e) => {
        e.preventDefault();
        setZoom((z) => Math.max(0.4, Math.min(4, +(z - Math.sign(e.deltaY) * 0.12).toFixed(2))));
      };
      el.addEventListener('wheel', onWheel, { passive: false });
      const move = (e) => {
        if (!panRef.current) return;
        setPan({ x: panRef.current.px + (e.clientX - panRef.current.x), y: panRef.current.py + (e.clientY - panRef.current.y) });
      };
      const up = () => { if (panRef.current) { el.classList.remove('panning'); panRef.current = null; } };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      return () => { el.removeEventListener('wheel', onWheel); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    }, [pan]);
    const onStageDown = (e) => {
      if (e.button === 2) { // right button = pan, anywhere on the stage
        e.preventDefault();
        panRef.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
        stageRef.current.classList.add('panning');
        return;
      }
      if (e.button !== 0 || mode !== 'select') return; // left marquee only in select mode
      if (e.metaKey || e.altKey) return; // ⌘/Alt click = multi-toggle, handled on the cell
      e.preventDefault();
      marqueeRef.current = { x: e.clientX, y: e.clientY, moved: false, onCell: !!(e.target.closest && e.target.closest('.cab')) };
    };
    const resetView = () => { setZoom(1); setPan({ x: 0, y: 0 }); };

    /* left-drag marquee: box-select every cabinet the rubber band touches */
    useEffect(() => {
      const move = (e) => {
        const m = marqueeRef.current; if (!m) return;
        if (Math.abs(e.clientX - m.x) + Math.abs(e.clientY - m.y) > 4) m.moved = true;
        const el = stageRef.current; const rect = el.getBoundingClientRect();
        setMarquee({ x0: m.x - rect.left, y0: m.y - rect.top, x1: e.clientX - rect.left, y1: e.clientY - rect.top });
        const minX = Math.min(m.x, e.clientX), maxX = Math.max(m.x, e.clientX), minY = Math.min(m.y, e.clientY), maxY = Math.max(m.y, e.clientY);
        const set = new Set();
        el.querySelectorAll('.cab').forEach((cab) => {
          const r = cab.getBoundingClientRect();
          if (r.left < maxX && r.right > minX && r.top < maxY && r.bottom > minY) set.add(cab.dataset.cr);
        });
        setSel(set);
      };
      const up = () => {
        const m = marqueeRef.current; if (!m) return;
        marqueeRef.current = null; setMarquee(null);
        if (m.moved) setMultiSel([...selKeysRef.current]);
        else if (!m.onCell) { setSel(new Set()); s.setCalSel(null); } // click on empty = clear selection
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    }, []);

    /* fit the grid inside its stage (constrain by BOTH width and height so it never spills over) */
    useLayoutEffect(() => {
      const el = stageRef.current; if (!el) return;
      const PAD = 44;
      const calc = () => {
        const w = el.clientWidth - PAD, hh = el.clientHeight - PAD;
        if (w <= 0 || hh <= 0) return;
        setFitW(Math.max(160, Math.min(w, hh * (cols / rows))));
      };
      calc();
      const ro = new ResizeObserver(calc); ro.observe(el);
      return () => ro.disconnect();
    }, [cols, rows]);

    useEffect(() => { setCells(seedCells(screen)); setUndo([]); setRedo([]); setZoom(1); setPan({ x: 0, y: 0 }); setSel(new Set()); }, [s.calScreen]);

    const sel = (c, r, cell) => s.setCalSel({ type: 'cabinet', col: c, row: r, state: (cell && cell.state) || 'normal', role: (cell && cell.role) || null });
    const commit = (next) => { setUndo((u) => [...u, cells]); setRedo([]); setCells(next); };
    const doUndo = () => { if (!undoStack.length) return; setRedo((r) => [...r, cells]); setCells(undoStack[undoStack.length - 1]); setUndo((u) => u.slice(0, -1)); };
    const doRedo = () => { if (!redoStack.length) return; setUndo((u) => [...u, cells]); setCells(redoStack[redoStack.length - 1]); setRedo((r) => r.slice(0, -1)); };

    useEffect(() => {
      const ent = Object.entries(cells).find(([, v]) => v.role === 'origin');
      if (ent && (!s.calSel || s.calSel.type !== 'cabinet')) { const [c, r] = ent[0].split(',').map(Number); sel(c, r, ent[1]); setSel(new Set([ent[0]])); }
    }, []);

    useEffect(() => {
      const onKey = (e) => {
        if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
        const k = e.key.toLowerCase();
        if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
        if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); doRedo(); return; }
        if (k === 'm') setMode((m) => m === 'mask' ? 'select' : 'mask');
        else if (k === 'r') setMode((m) => m === 'refs' ? 'select' : 'refs');
        else if (k === 'b') setMode((m) => m === 'baseline' ? 'select' : 'baseline');
        else if (k === 'escape') setMode('select');
        else if (k === '1') setRole('origin');
        else if (k === '2') setRole('x_axis');
        else if (k === '3') setRole('xy_plane');
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [mode, cells, undoStack, redoStack]);

    const onCell = (c, r, e) => {
      const key = c + ',' + r; const cur = cells[key] || { state: 'normal' };
      if (mode === 'select') {
        if (e && (e.metaKey || e.altKey)) { // multi add / remove
          const n = new Set(selKeysRef.current); n.has(key) ? n.delete(key) : n.add(key);
          setSel(n); setMultiSel([...n]); return;
        }
        setSel(new Set([key])); sel(c, r, cur); return;
      }
      const next = { ...cells };
      if (mode === 'mask') next[key] = cur.state === 'masked' ? { state: 'normal' } : { state: 'masked' };
      else if (mode === 'baseline') next[key] = cur.state === 'below' ? { state: 'normal' } : { state: 'below' };
      else if (mode === 'refs') next[key] = { state: 'ref', role };
      commit(next); setSel(new Set([key])); sel(c, r, next[key]);
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
      grid.push(h('div', { key: c + ',' + r, className: cls, 'data-cr': c + ',' + r, onClick: (e) => onCell(c, r, e), title: `col ${c}, row ${r}` },
        cell.state === 'ref' ? h('span', { className: 'rl' }, ROLE[cell.role].short) : null));
    }

    const ModeBtn = (id, label, key, icon) => h('div', { className: 'mbtn' + (mode === id ? ' on' : ''), onClick: () => setMode((m) => m === id ? 'select' : id) },
      h(Icon, { name: icon, size: 14 }), label, h('kbd', null, key));

    return h('div', { className: 'cabwrap' },
      h('div', { className: 'canvas-head' },
        h('span', { className: 't' }, screen.name + ' — Cabinet 网格'),
        h('span', { className: 'toolchip' }, h(Icon, { name: 'grid', size: 14 }), `${cols} × ${rows} cabinet`),
        h('span', { className: 'toolchip' }, mode === 'select' ? '选择模式' : mode === 'mask' ? '遮罩模式' : mode === 'refs' ? '参考点模式' : '基线模式'),
        h('div', { className: 'right' },
          h('div', { className: 'zoombar' },
            h('button', { className: 'zb-btn', onClick: () => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2))), title: '缩小' }, '−'),
            h('button', { className: 'zb-lbl', onClick: resetView, title: '适应窗口' }, Math.round(zoom * 100) + '%'),
            h('button', { className: 'zb-btn', onClick: () => setZoom((z) => Math.min(3, +(z + 0.25).toFixed(2))), title: '放大' }, '+')),
          h('button', { className: 'iconbtn', disabled: !undoStack.length, style: { opacity: undoStack.length ? 1 : .4 }, onClick: doUndo, title: '撤销' }, h(Icon, { name: 'undo', size: 16 })),
          h('button', { className: 'iconbtn', disabled: !redoStack.length, style: { opacity: redoStack.length ? 1 : .4 }, onClick: doRedo, title: '重做' }, h(Icon, { name: 'redo', size: 16 })))),
      h('div', { className: 'cabstage' + (marquee ? ' marquee' : ''), ref: stageRef, onMouseDown: onStageDown, onContextMenu: (e) => e.preventDefault() },
        h('div', { className: 'cabgrid', style: { gridTemplateColumns: `repeat(${cols}, 1fr)`, width: fitW ? fitW + 'px' : undefined, transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` } }, grid),
        marquee ? h('div', { className: 'marquee-box', style: { left: Math.min(marquee.x0, marquee.x1), top: Math.min(marquee.y0, marquee.y1), width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0) } }) : null),
      h('div', { className: 'modebar' },
        ModeBtn('mask', '遮罩', 'M', 'panel'),
        ModeBtn('refs', '参考点', 'R', 'pin'),
        ModeBtn('baseline', '基线', 'B', 'ruler'),
        mode === 'refs' ? h('div', { className: 'role-seg' },
          ['origin', 'x_axis', 'xy_plane'].map((rk, i) => h('button', { key: rk, className: (role === rk ? 'on r-' + rk : ''), onClick: () => setRole(rk) },
            h('span', { className: 'sdot', style: { background: ROLE[rk].color } }), ROLE[rk].label, h('kbd', { style: { marginLeft: 2 } }, i + 1)))) : null,
        h('span', { className: 'sp' })),
      h('div', { className: 'leg' },
        h('span', { className: 'leg-i' }, h('span', { className: 'leg-sw', style: { background: '#3a4654' } }), '正常'),
        h('span', { className: 'leg-i' }, h('span', { className: 'leg-sw', style: { background: 'repeating-linear-gradient(45deg,#26262b 0 3px,#1b1b1f 3px 6px)' } }), '遮罩'),
        h('span', { className: 'leg-i' }, h('span', { className: 'leg-sw', style: { background: '#243a52' } }), '基线以下'),
        h('span', { className: 'leg-i' }, h('span', { className: 'leg-sw', style: { background: ROLE.origin.color } }), 'origin'),
        h('span', { className: 'leg-i' }, h('span', { className: 'leg-sw', style: { background: ROLE.x_axis.color } }), 'x_axis'),
        h('span', { className: 'leg-i' }, h('span', { className: 'leg-sw', style: { background: ROLE.xy_plane.color } }), 'xy_plane')));
  }

  /* =================== Method =================== */
  function methodView(s) {
    const M = [
      { id: 'm1', icon: 'target', title: 'M1 · 全站仪', tag: 'Trimble SX', desc: '使用全站仪逐点测量物理坐标，导入 CSV 后做刚体配准。精度最高，依赖现场测量与人工。',
        bullets: ['亚毫米级测量精度', '需现场架设与逐点采集', 'CSV 导入 + 离群剔除'] },
      { id: 'm2', icon: 'camera', title: 'M2 · 视觉', tag: 'ChArUco + BA', desc: '相机拍摄 ChArUco 标定板，特征检测后做 bundle adjustment 联合优化。快速、自动，适合迭代。',
        bullets: ['自动角点检测', 'bundle adjustment 联合优化', '分钟级迭代，无需测量员'] },
    ];
    return h(React.Fragment, null,
      h('div', { className: 'canvas-head' },
        h('span', { className: 't' }, '选择重建方法'),
        h('div', { className: 'right' }, h('span', { className: 'toolchip' }, h(Icon, { name: 'tools', size: 14 }), '当前 · ' + (s.calMethod === 'm1' ? 'M1 全站仪' : 'M2 视觉')))),
      h('div', { className: 'mcards' },
        M.map((m) => {
          const on = s.calMethod === m.id;
          return h('div', { key: m.id, className: 'mcard' + (on ? ' on' : '') },
            h('div', { className: 'mc-top' },
              h('span', { className: 'mc-ic' }, h(Icon, { name: m.icon, size: 20 })),
              h('div', { style: { flex: 1 } }, h('h3', null, m.title), h('div', { className: 'mc-tag' }, m.tag)),
              on ? h(Badge, { variant: 'accent', size: 'S' }, '当前方法') : null),
            h('div', { className: 'mc-desc' }, m.desc),
            h('ul', null, m.bullets.map((b, i) => h('li', { key: i }, b))),
            h('div', { className: 'mc-f' },
              on
                ? h(Button, { variant: 'accent', size: 'S', icon: h(Icon, { name: 'chevr', size: 15 }), onPress: () => s.setCalStep('survey') }, '继续')
                : h(Button, { variant: 'secondary', size: 'S', icon: h(Icon, { name: 'sync', size: 15 }),
                    onPress: () => { s.setCalMethod(m.id); s.pushLog({ lv: 'info', cat: 'calibrate', msg: `切换重建方法为 <b>${m.title}</b>` }); } }, '使用此方法'),
              !on ? h('span', { style: { fontSize: 11.5, color: 'var(--chrome-faint)' } }, '切换将重置测量导入') : null));
        })));
  }

  /* =================== Survey =================== */
  function surveyView(s) {
    if (s.calMethod === 'm2') {
      return h(React.Fragment, null,
        h('div', { className: 'canvas-head' }, h('span', { className: 't' }, '测量导入 · M2 视觉')),
        h('div', { className: 'surv' },
          h('div', { className: 'hatch dark', style: { minHeight: 360 } },
            h('div', { className: 'hi' },
              h('span', { className: 'hic' }, h(Icon, { name: 'camera', size: 26 })),
              h('span', { className: 'ht' }, '未实现'),
              h('span', { className: 'hd' }, 'M2 视觉方法直接从相机帧提取角点，无独立测量导入步骤。该面板暂未实现。')))));
    }
    const rep = SURVEY_REPORT;
    const tiles = [
      ['measured', '实测点', rep.measured, 'positive'], ['fabricated', '制造点', rep.fabricated, 'neutral'],
      ['outlier', '离群点', rep.outlier, 'negative'], ['missing', '缺失点', rep.missing, 'notice'],
    ];
    return h(React.Fragment, null,
      h('div', { className: 'canvas-head' },
        h('span', { className: 't' }, '测量导入 · M1 全站仪'),
        h('span', { className: 'toolchip' }, h(Icon, { name: 'download', size: 14 }), 'survey_main.csv'),
        h('div', { className: 'right' }, h('span', { className: 'toolchip' }, '1,024 行 · 已解析'))),
      h('div', { className: 'surv cal-scroll' },
        h('div', { className: 'surv-tiles' },
          tiles.map(([id, lab, n, v]) => h('div', { className: 'stile', key: id },
            h('div', { className: 'n s-' + v }, n),
            h('div', { className: 'l' }, h('span', { className: 'sdot bg-' + v }), lab)))),
        rep.warnings.map((w, i) => h('div', { key: i, style: { marginBottom: 8 } },
          h(InlineAlert, { variant: w.lv === 'warn' ? 'notice' : 'informative', title: w.lv === 'warn' ? '警告' : '提示' }, w.msg))),
        h('div', { className: 'surv-sub' }, '参考点 / 测量点'),
        h('div', { className: 'ptable' },
          CAL_POINTS.map((p) => {
            const isSel = s.calSel && s.calSel.type === 'point' && s.calSel.id === p.id;
            return h('div', { key: p.id, className: 'prow' + (isSel ? ' sel' : ''), onClick: () => s.setCalSel({ type: 'point', id: p.id }) },
              h('div', { className: 'pn' },
                p.role ? h('span', { className: 'sdot', style: { background: ROLE[p.role].color } }) : h('span', { className: 'sdot bg-neutral' }),
                p.name),
              h('div', { className: 'xyz' }, `[${p.xyz.map((v) => v.toFixed(3)).join(', ')}]`),
              h('div', { style: { fontSize: 11.5, color: 'var(--chrome-dim)' } }, p.measured ? '实测' : '推测'),
              h('div', { className: 'er s-' + (p.err < 1 ? 'positive' : p.err < 2 ? 'notice' : 'negative') }, p.err.toFixed(2)));
          }))));
  }

  /* =================== Preview: rotatable 3D mesh =================== */
  function MeshPreview3D({ screen }) {
    const cols = MESH_METRICS.cols, rows = MESH_METRICS.rows;
    const [rot, setRot] = useState({ yaw: -2.532, pitch: -0.276 });
    const [zoom, setZoom] = useState(1.36);
    const [pan, setPan] = useState({ x: -47, y: -75 });
    const rotRef = useRef(null);
    const panRef = useRef(null);
    const svgRef = useRef(null);
    const onDown = (e) => {
      if (e.button === 2) { e.preventDefault(); panRef.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y }; return; } // right = pan
      if (e.button !== 0) return;
      rotRef.current = { x: e.clientX, y: e.clientY, ...rot }; // left = rotate
    };
    useEffect(() => {
      const svg = svgRef.current;
      const onWheel = (e) => { e.preventDefault(); setZoom((z) => Math.max(0.4, Math.min(4, +(z - Math.sign(e.deltaY) * 0.12).toFixed(2)))); };
      if (svg) svg.addEventListener('wheel', onWheel, { passive: false });
      const mv = (e) => {
        if (rotRef.current) { const d = rotRef.current;
          setRot({ yaw: d.yaw + (e.clientX - d.x) * 0.006, pitch: Math.max(-0.5, Math.min(0.6, d.pitch + (e.clientY - d.y) * 0.004)) }); }
        else if (panRef.current) { const p = panRef.current; const k = 900 / ((svg && svg.clientWidth) || 900);
          setPan({ x: p.px + (e.clientX - p.x) * k, y: p.py + (e.clientY - p.y) * k }); }
      };
      const up = () => { rotRef.current = null; panRef.current = null; };
      window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
      return () => { if (svg) svg.removeEventListener('wheel', onWheel); window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
    }, []);

    const R = 540, z0 = 230, Hh = 300, arc = (110 * Math.PI) / 180;
    const zc = z0 + 150;
    const cyaw = Math.cos(rot.yaw), syaw = Math.sin(rot.yaw), cpit = Math.cos(rot.pitch), spit = Math.sin(rot.pitch);
    const pt = (i, j) => {
      const a = -arc / 2 + arc * i / cols;
      let x = R * Math.sin(a), y = -Hh / 2 + Hh * j / rows, z = z0 + R * (1 - Math.cos(a));
      let dx = x, dz = z - zc; let x2 = dx * cyaw - dz * syaw, z2 = dx * syaw + dz * cyaw + zc;
      let dy = y, dz2 = z2 - zc; let y2 = dy * cpit - dz2 * spit, z3 = dy * spit + dz2 * cpit + zc;
      const f = 780, sc = f / (f + z3);
      return [450 + x2 * sc, 300 - y2 * sc, sc];
    };
    const low = (i, j) => i >= cols - 8 && j <= 3; // low-confidence corner
    const lines = [];
    for (let i = 0; i <= cols; i++) { let d = ''; for (let j = 0; j <= rows; j++) { const [px, py] = pt(i, j); d += (j ? 'L' : 'M') + px.toFixed(1) + ' ' + py.toFixed(1) + ' '; }
      lines.push(h('path', { key: 'c' + i, d, stroke: 'rgba(120,180,255,.30)', strokeWidth: i % 4 === 0 ? 1.2 : .6, fill: 'none' })); }
    for (let j = 0; j <= rows; j++) { let d = ''; for (let i = 0; i <= cols; i++) { const [px, py] = pt(i, j); d += (i ? 'L' : 'M') + px.toFixed(1) + ' ' + py.toFixed(1) + ' '; }
      lines.push(h('path', { key: 'r' + j, d, stroke: 'rgba(120,180,255,.30)', strokeWidth: j % 4 === 0 ? 1.2 : .6, fill: 'none' })); }
    // low-confidence hatch fill
    const hatch = [];
    for (let i = cols - 8; i < cols; i += 1) for (let j = 0; j < 3; j += 1) {
      const [a] = [pt(i, j)], b = pt(i + 1, j), c = pt(i + 1, j + 1), dd = pt(i, j + 1);
      hatch.push(h('polygon', { key: 'h' + i + j, points: `${a[0]},${a[1]} ${b[0]},${b[1]} ${c[0]},${c[1]} ${dd[0]},${dd[1]}`, fill: 'url(#lowhatch)', stroke: 'none' }));
    }
    const dots = [];
    for (let i = 0; i <= cols; i += 4) for (let j = 0; j <= rows; j += 2) { const [px, py] = pt(i, j);
      dots.push(h('circle', { key: 'd' + i + '_' + j, cx: px, cy: py, r: 1.7, fill: low(i, j) ? 'rgba(255,150,40,.7)' : 'var(--volo-600)' })); }

    // ground plane (floor grid at the foot of the wall, same camera)
    const F = 780;
    const project = (x, y, z) => {
      let dx = x, dz = z - zc; let x2 = dx * cyaw - dz * syaw, z2 = dx * syaw + dz * cyaw + zc;
      let dy = y, dz2 = z2 - zc; let y2 = dy * cpit - dz2 * spit, z3 = dy * spit + dz2 * cpit + zc;
      const sc = F / (F + z3);
      return [450 + x2 * sc, 300 - y2 * sc];
    };
    const gY = -Hh / 2, gx0 = -800, gx1 = 800, gz0 = -160, gz1 = 1120, S = 80;
    const ground = [];
    const q00 = project(gx0, gY, gz0), q10 = project(gx1, gY, gz0), q11 = project(gx1, gY, gz1), q01 = project(gx0, gY, gz1);
    ground.push(h('polygon', { key: 'gfill', points: `${q00[0]},${q00[1]} ${q10[0]},${q10[1]} ${q11[0]},${q11[1]} ${q01[0]},${q01[1]}`, fill: 'rgba(120,140,170,.045)', stroke: 'none' }));
    for (let x = gx0; x <= gx1 + 0.5; x += S) { const a = project(x, gY, gz0), b = project(x, gY, gz1);
      ground.push(h('line', { key: 'gx' + x, x1: a[0], y1: a[1], x2: b[0], y2: b[1], stroke: 'rgba(135,155,185,.17)', strokeWidth: Math.round(x) % 400 === 0 ? 1 : .5 })); }
    for (let z = gz0; z <= gz1 + 0.5; z += S) { const a = project(gx0, gY, z), b = project(gx1, gY, z);
      ground.push(h('line', { key: 'gz' + z, x1: a[0], y1: a[1], x2: b[0], y2: b[1], stroke: 'rgba(135,155,185,.17)', strokeWidth: Math.round(z) % 400 === 0 ? 1 : .5 })); }

    const tf = `translate(${450 + pan.x} ${300 + pan.y}) scale(${zoom}) translate(-450 -300)`;
    return h('svg', { viewBox: '0 0 900 600', width: '100%', height: '100%', preserveAspectRatio: 'xMidYMid meet', ref: svgRef, style: { display: 'block', cursor: 'grab' }, onMouseDown: onDown, onContextMenu: (e) => e.preventDefault() },
      h('defs', null, h('pattern', { id: 'lowhatch', width: 7, height: 7, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' },
        h('rect', { width: 7, height: 7, fill: 'rgba(255,150,40,.05)' }), h('line', { x1: 0, y1: 0, x2: 0, y2: 7, stroke: 'rgba(255,150,40,.4)', strokeWidth: 1 }))),
      h('g', { transform: tf },
        h('g', null, ground), h('g', null, hatch), h('g', null, lines), h('g', null, dots)));
  }

  function previewView(s) {
    const screen = CAL_SCREENS.find((x) => x.id === s.calScreen) || CAL_SCREENS[0];
    const m = MESH_METRICS;
    const Q = (k, v, u, vis) => h('div', { className: 'qmetric' },
      h('div', { className: 'qk' }, k), h('div', { className: 'qv s-' + (vis || '') }, v, u ? h('span', { className: 'u' }, u) : null));
    return h('div', { className: 'cabwrap' },
      h('div', { className: 'canvas-head' },
        h('span', { className: 't' }, screen.name + ' — 网格预览'),
        h('span', { className: 'toolchip' }, h(Icon, { name: 'cube', size: 14 }), `拓扑 ${m.cols} × ${m.rows}`),
        h('span', { className: 'toolchip' }, h(Icon, { name: 'layers', size: 14 }), m.vertices.toLocaleString() + ' 顶点'),
        h('div', { className: 'right' }, rmsBadge(m.est_rms))),
      h('div', { className: 'cabstage', style: { padding: 0 } },
        h('div', { className: 'prev-badge' },
          h('span', { className: 'toolchip' }, h('span', { className: 'leg-sw', style: { background: 'url(#none)', backgroundColor: 'rgba(255,150,40,.3)', border: '1px solid rgba(255,150,40,.6)' } }), '空 / 低置信')),
        h('div', { className: 'cal-axis' }, 'PERSP · world'),
        h(MeshPreview3D, { screen }),
        h('div', { className: 'rot-hint' }, h(Icon, { name: 'rotate', size: 13 }), '拖动旋转')),
      h('div', { className: 'modebar', style: { gap: 9 } },
        h('div', { className: 'qbar' },
          Q('middle_max_dev', m.mid_max.toFixed(2), 'mm', 'notice'),
          Q('middle_mean_dev', m.mid_mean.toFixed(2), 'mm', 'positive'),
          Q('estimated_rms', m.est_rms.toFixed(2), 'mm', 'positive'),
          Q('estimated_p95', m.est_p95.toFixed(2), 'mm', 'notice'))));
  }

  /* =================== Runs =================== */
  function RunsTable({ s }) {
    const [exp, setExp] = useState(null);
    const click = (r) => { s.setCalSel({ type: 'run', id: r.id }); setExp((e) => e === r.id ? null : r.id); };
    return h('div', { className: 'runtable cal-scroll' },
      h('div', { className: 'rt-head' },
        h('span', null, 'Created'), h('span', null, 'Screen'), h('span', null, 'Method'),
        h('span', null, 'RMS'), h('span', null, 'Vertices'), h('span', null, 'Target'), h('span', null, 'OBJ')),
      CAL_RUNS.map((r) => h(React.Fragment, { key: r.id },
        h('div', { className: 'rt-row' + (s.calSel && s.calSel.id === r.id ? ' sel' : ''), onClick: () => click(r) },
          h('span', { className: 'dim' }, r.created),
          h('span', null, r.screen),
          h('span', { className: 'dim' }, r.method),
          h('span', null, rmsBadge(r.rms)),
          h('span', { className: 'mono' }, r.vertices ? r.vertices.toLocaleString() : '—'),
          h('span', { className: 'mono dim' }, r.target),
          h('span', null, r.obj ? h('button', { className: 'iconbtn', style: { width: 24, height: 24 }, onClick: (e) => { e.stopPropagation(); s.pushLog({ lv: 'ok', cat: 'calibrate', msg: `下载 <b>${r.target}.obj</b>` }); } }, h(Icon, { name: 'download', size: 15 })) : h('span', { style: { color: 'var(--chrome-faint)' } }, '—'))),
        exp === r.id ? h('div', { className: 'rt-exp' },
          h('div', { className: 'ttl' }, '重建报告 · ' + r.target),
          r.metrics ? h('div', { className: 'qbar' },
            h('div', { className: 'qmetric' }, h('div', { className: 'qk' }, 'middle_max_dev'), h('div', { className: 'qv' }, r.metrics.mid_max.toFixed(2), h('span', { className: 'u' }, 'mm'))),
            h('div', { className: 'qmetric' }, h('div', { className: 'qk' }, 'middle_mean_dev'), h('div', { className: 'qv' }, r.metrics.mid_mean.toFixed(2), h('span', { className: 'u' }, 'mm'))),
            h('div', { className: 'qmetric' }, h('div', { className: 'qk' }, 'estimated_rms'), h('div', { className: 'qv' }, r.metrics.est_rms.toFixed(2), h('span', { className: 'u' }, 'mm'))),
            h('div', { className: 'qmetric' }, h('div', { className: 'qk' }, 'estimated_p95'), h('div', { className: 'qv' }, r.metrics.est_p95.toFixed(2), h('span', { className: 'u' }, 'mm'))))
            : h('div', { style: { fontSize: 12, color: 'var(--chrome-faint)' } }, '该次重建未收敛，无质量指标。')) : null)));
  }

  /* =================== Lens (placeholder) =================== */
  function lensView(s) {
    const dof = [
      ['t.x', '—'], ['t.y', '—'], ['t.z', '—'],
      ['r.x', '—'], ['r.y', '—'], ['r.z', '—'], ['scale', '—'],
    ];
    return h(React.Fragment, null,
      h('div', { className: 'canvas-head' },
        h('span', { className: 't' }, '镜头校正'),
        h('div', { className: 'right' },
          h(Button, { variant: 'accent', size: 'S', icon: h(Icon, { name: 'target', size: 14 }),
            onPress: () => s.pushLogs([{ lv: 'info', cat: 'calibrate', msg: '镜头求解：占位流程，Detect → Solve 尚未接入' }]) }, '运行求解'))),
      h('div', { className: 'lwrap cal-scroll' },
        h('div', { className: 'lstages' },
          LENS_STAGES.map((st) => h('div', { key: st.id, className: 'lstage' + (st.status === 'done' ? ' done' : '') + (st.status === 'active' ? ' active' : '') },
            h('div', { className: 'ln' }, st.status === 'done' ? h(Icon, { name: 'check', size: 14 }) : st.n),
            h('div', { className: 'lt' }, st.label),
            h('div', { className: 'lc' }, st.cn + ' · ' + (st.status === 'done' ? '已完成' : '待运行'))))),
        h('div', { style: { marginBottom: 14 } },
          h(InlineAlert, { variant: 'informative', title: '占位流程' }, '镜头校正尚未接入。完成 Detect → Solve 后将生成 7-DOF 变换矩阵、RMS / inlier / outlier 与重投影误差。')),
        h('div', { style: { display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: 16 } },
          h('div', null,
            h('div', { className: 'surv-sub', style: { marginTop: 0 } }, '变换矩阵 · 7 自由度'),
            h('div', { className: 'hatch', style: { minHeight: 0, padding: 14 } },
              h('div', { className: 'lmatrix', style: { width: '100%' } },
                dof.map(([k, v]) => h('div', { className: 'lmcell', key: k, style: { textAlign: 'left' } },
                  h('span', { style: { color: 'var(--chrome-faint)', fontSize: 11 } }, k + ' = '), v))))),
          h('div', null,
            h('div', { className: 'surv-sub', style: { marginTop: 0 } }, '求解质量'),
            h('div', { className: 'qbar', style: { flexDirection: 'column' } },
              ['RMS (px)', 'inlier', 'outlier', '重投影误差 (px)'].map((k) => h('div', { className: 'qmetric', key: k, style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                h('div', { className: 'qk' }, k), h('div', { className: 'qv', style: { color: 'var(--chrome-faint)' } }, '—'))))))));
  }

  /* =================== overview band (参考缓存总览的布局形式) =================== */
  const calKpi = (icon, k, big, bigTone, note, noteTone) => h('div', { className: 'kpi' },
    h('div', { className: 'kpi-h' }, h('span', { className: 'kpi-ico' }, h(Icon, { name: icon, size: 15 })), h('span', { className: 'kpi-k' }, k)),
    h('div', { className: 'kpi-v' + (bigTone ? ' ' + bigTone : '') }, big),
    h('div', { className: 'kpi-note' + (noteTone ? ' ' + noteTone : '') }, note));

  function calTop(s) {
    const screen = CAL_SCREENS.find((x) => x.id === s.calScreen) || CAL_SCREENS[0];
    const m = MESH_METRICS;
    const rep = SURVEY_REPORT;
    const meshDone  = CAL_STEPS.filter((x) => x.group === 'mesh' && x.status === 'done').length;
    const meshTotal = CAL_STEPS.filter((x) => x.group === 'mesh').length;
    const lensDone  = LENS_STAGES.filter((x) => x.status === 'done').length;
    const lensTotal = LENS_STAGES.length;
    const lensRun   = lensDone === lensTotal;
    const latest    = CAL_RUNS.find((r) => r.rms != null);
    const refPts    = CAL_POINTS.filter((p) => p.role).length;
    const issues    = rep.outlier + rep.missing;
    const rmsVis    = m.est_rms < 3 ? 'positive' : m.est_rms < 8 ? 'notice' : 'negative';
    const overall   = rmsVis === 'negative' ? 'critical' : (!lensRun || rmsVis === 'notice') ? 'warning' : 'healthy';
    const sev       = SEVCAL[overall];
    const rebuild = () => s.pushLogs([
      { lv: 'info', cat: 'calibrate', msg: `重建 <b>${screen.name}</b> 网格 …` },
      { lv: 'ok', cat: 'calibrate', msg: 'mesh_v7 重建收敛，estimated RMS <b>0.40 mm</b>' },
    ]);
    return h(React.Fragment, null,
      /* 1 · 校正总览条 */
      h('div', { className: 'land-status hero-' + overall },
        h('div', { className: 'ls-badge s-' + sev.visual }, h(Icon, { name: sev.icon, size: 24 })),
        h('div', { className: 'ls-main' },
          h('div', { className: 'ls-line' },
            h('b', null, m.est_rms.toFixed(2) + ' mm'), h('span', { className: 'dim' }, ' RMS · '),
            h('span', null, '网格已重建'), h('span', { className: 'dim' }, ' · '),
            h('b', { className: 's-' + (lensRun ? 'positive' : 'notice') }, lensRun ? '镜头已校正' : '镜头校正未运行')),
          h('div', { className: 'ls-sub' }, '当前 ' + screen.name + ' · 拓扑 ' + m.cols + ' × ' + m.rows + ' · ' + m.vertices.toLocaleString() + ' 顶点 · 上次重建 ' + latest.target + ' · ' + latest.created)),
        h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'sync', size: 15 }), onPress: rebuild }, '重建')));
  }

  /* =================== center router =================== */
  function stepView(s) {
    switch (s.calStep) {
      case 'method': return methodView(s);
      case 'survey': return surveyView(s);
      case 'preview': return previewView(s);
      case 'runs': return h(React.Fragment, null,
        h('div', { className: 'canvas-head' }, h('span', { className: 't' }, '重建历史'),
          h('div', { className: 'right' }, h('span', { className: 'toolchip' }, CAL_RUNS.length + ' 次重建'))),
        h(RunsTable, { s }));
      case 'lens': return lensView(s);
      default: return h(CabinetEditor, { s });
    }
  }
  function center(s) {
    return h('div', { className: 'dash cal-dash' },
      calTop(s),
      h('div', { className: 'dash-card cal-stage-card' }, stepView(s)));
  }

  /* =================== inspector (per selected object) =================== */
  const KV = (k, v, mono) => h('div', { className: 'kv', key: k },
    h('span', { className: 'k' }, k), h('span', { className: 'v' + (mono ? ' mono' : '') }, v));

  function inspector(s) {
    const sel = s.calSel;
    if (!sel) return h('div', { className: 'insp-empty' },
      h('div', { className: 'ph' }, h(Icon, { name: 'target', size: 30 })),
      h('div', null, h('div', { style: { color: 'var(--chrome-dim)', fontWeight: 600, marginBottom: 4 } }, '未选择对象'), '选择 cabinet / 测量点 / 重建记录'));

    if (sel.type === 'cabinetMulti') {
      const bd = sel.bd || {};
      const order = [['normal', 'informative'], ['masked', 'neutral'], ['below', 'notice'], ['ref', 'positive']].filter(([k]) => bd[k]);
      return h(React.Fragment, null,
        h('div', { className: 'insp-head' },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 } },
            h('span', { className: 'step-ico' }, h(Icon, { name: 'grid', size: 16 })),
            h('h2', { style: { margin: 0, fontSize: 15, fontWeight: 700, fontFamily: 'var(--font-code)' } }, '已选 ' + sel.count + ' 个 Cabinet')),
          h('span', { className: 'spill spill--informative' }, h(Icon, { name: 'check', size: 13 }), '多选')),
        h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, '选区构成'),
          order.length ? order.map(([k, v]) => h('div', { className: 'kv', key: k },
            h('span', { className: 'k' }, h('span', { className: 'sdot bg-' + v, style: { display: 'inline-block', marginRight: 7 } }), CAB_STATE[k]),
            h('span', { className: 'v' }, bd[k]))) : h('div', { style: { fontSize: 12, color: 'var(--chrome-faint)' } }, '—')),
        h('div', { className: 'insp-sect' },
          h('div', { style: { fontSize: 11.5, color: 'var(--chrome-faint)', lineHeight: 1.55 } }, '左键拖动可框选，按住 ⌘ / Alt 点击可加选或减选；切到遮罩 / 参考点 / 基线模式可对选区批量编辑。')));
    }

    if (sel.type === 'cabinet') {
      const st = sel.state || 'normal';
      const sc = CAL_SCREENS.find((x) => x.id === s.calScreen) || CAL_SCREENS[0];
      const stVis = st === 'masked' ? 'neutral' : st === 'below' ? 'notice' : st === 'ref' ? 'positive' : 'informative';
      return h(React.Fragment, null,
        h('div', { className: 'insp-head' },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 } },
            h('span', { className: 'step-ico' }, h(Icon, { name: 'grid', size: 16 })),
            h('h2', { style: { margin: 0, fontSize: 15, fontWeight: 700, fontFamily: 'var(--font-code)' } }, `Cabinet ${sel.col},${sel.row}`)),
          h('span', { className: 'spill spill--' + stVis }, h(Icon, { name: st === 'normal' ? 'check' : 'panel', size: 13 }), CAB_STATE[st])),
        h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, '位置'),
          KV('列 (col)', sel.col, true), KV('行 (row)', sel.row, true), KV('面板索引', `#${sel.row * sc.cols + sel.col}`, true)),
        h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, '状态'),
          h('div', { className: 'kv' }, h('span', { className: 'k' }, '类型'), h('span', { className: 'v' }, CAB_STATE[st])),
          KV('参与重建', st === 'masked' ? '否（遮罩）' : '是'),
          KV('ref 角色', sel.role ? ROLE[sel.role].label : '—', !!sel.role)),
        sel.role ? h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, '坐标系角色'),
          h('div', { style: { fontSize: 12, color: 'var(--chrome-dim)', lineHeight: 1.5 } },
            sel.role === 'origin' ? '世界坐标原点 (0,0,0)，定义网格基准位置。'
              : sel.role === 'x_axis' ? '定义 X 轴方向，与 origin 构成基准向量。'
              : '与 origin / x_axis 共同定义 XY 平面与法向。')) : null);
    }

    if (sel.type === 'point') {
      const p = CAL_POINTS.find((x) => x.id === sel.id);
      if (!p) return null;
      const errVis = p.err < 1 ? 'positive' : p.err < 2 ? 'notice' : 'negative';
      return h(React.Fragment, null,
        h('div', { className: 'insp-head' },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 } },
            h('span', { className: 'step-ico' }, h(Icon, { name: 'pin', size: 16 })),
            h('h2', { style: { margin: 0, fontSize: 15, fontWeight: 700, fontFamily: 'var(--font-code)' } }, p.name)),
          h('div', { style: { display: 'flex', gap: 7, alignItems: 'center' } },
            h('span', { className: 'spill spill--' + (p.measured ? 'positive' : 'notice') }, h(Icon, { name: p.measured ? 'check' : 'alert', size: 13 }), p.measured ? '实测' : '推测'),
            p.role ? h(Badge, { variant: 'accent', size: 'S' }, ROLE[p.role].label) : null)),
        h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, '坐标 [x, y, z] (m)'),
          KV('x', p.xyz[0].toFixed(4), true), KV('y', p.xyz[1].toFixed(4), true), KV('z', p.xyz[2].toFixed(4), true)),
        h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, '质量'),
          h('div', { className: 'kv' }, h('span', { className: 'k' }, '来源'), h('span', { className: 'v' }, p.measured ? 'measured 实测' : 'guessed 推测')),
          KV('不确定度 σ', p.sigma.toFixed(1) + ' mm', true),
          h(Stat, { k: '误差', v: p.err.toFixed(2) + ' mm', pct: Math.min(100, p.err / 3 * 100), variant: errVis })));
    }

    if (sel.type === 'run') {
      const r = CAL_RUNS.find((x) => x.id === sel.id);
      if (!r) return null;
      return h(React.Fragment, null,
        h('div', { className: 'insp-head' },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 } },
            h('span', { className: 'step-ico' }, h(Icon, { name: 'list', size: 16 })),
            h('h2', { style: { margin: 0, fontSize: 15, fontWeight: 700, fontFamily: 'var(--font-code)' } }, r.target)),
          h('div', { style: { display: 'flex', gap: 7, alignItems: 'center' } }, rmsBadge(r.rms),
            h('span', { style: { fontSize: 11.5, color: 'var(--chrome-faint)' } }, r.created))),
        h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, '概要'),
          KV('方法', r.method), KV('屏幕', r.screen), KV('顶点数', r.vertices ? r.vertices.toLocaleString() : '—', true), KV('OBJ', r.obj ? '已导出' : '未导出')),
        r.metrics ? h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, '质量指标 (mm)'),
          h(Stat, { k: 'middle_max_dev', v: r.metrics.mid_max.toFixed(2), pct: Math.min(100, r.metrics.mid_max / 12 * 100), variant: r.metrics.mid_max < 3 ? 'positive' : r.metrics.mid_max < 8 ? 'notice' : 'negative' }),
          h(Stat, { k: 'middle_mean_dev', v: r.metrics.mid_mean.toFixed(2), pct: Math.min(100, r.metrics.mid_mean / 8 * 100), variant: 'positive' }),
          h(Stat, { k: 'estimated_rms', v: r.metrics.est_rms.toFixed(2), pct: Math.min(100, r.metrics.est_rms / 12 * 100), variant: r.rms < 3 ? 'positive' : r.rms < 8 ? 'notice' : 'negative' }),
          h(Stat, { k: 'estimated_p95', v: r.metrics.est_p95.toFixed(2), pct: Math.min(100, r.metrics.est_p95 / 16 * 100), variant: 'notice' }))
          : h('div', { className: 'insp-sect' }, h('div', { style: { fontSize: 12, color: 'var(--chrome-faint)' } }, '该次重建未收敛，无质量指标。')));
    }
    return null;
  }

  window.VOLO_PAGES = window.VOLO_PAGES || {};
  window.VOLO_PAGES.calibrate = { ctx, left, center, inspector };
})();

export {};
