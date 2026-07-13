// @ts-nocheck
/* Volo — 网格校正工作区 · 中央三维视口 + 四角叠加（gridView.tsx）
   1:1 port of the Claude Design handoff `src/grid_view.jsx`, 改接真实数据：
   - 名义（未重建）几何：本文件的 buildNominalBoxes() 镜像
     crates/mesh-adapter-total-station/src/shape_grid.rs 的「逐列朝向角累加铺列」
     算法（flat/curved 闭式 + arc/l_shape/u_shape/custom_segments 统一骨架），
     两边独立实现、保持数学一致，不做跨语言同步机制（同本仓其它纯可视化模块）。
   - 已重建几何：读真实 ReconstructedSurface.vertices（米），vertex_index =
     row*(cols+1)+col 行主序，与 crates/mesh-core/src/surface.rs 一致。
   - 模型坐标系（与 crates/mesh-core/src/coordinate.rs::from_three_points_m01 +
     shape_grid.rs 的既有约定一致，经 apply_world_transform 的坐标系推导核对）：
     X = 列（横向）· Y = 弯曲/深度（曲面外凸方向）· Z = 行（竖直，随 row 递增）。
     视口据此把 Z 当"上"来摆相机，不是设计稿原型的 Y-up 摆法。 */
import * as React from "react";
import { saveProjectYaml } from "../api/meshCommands";

(function () {
  const { useState, useRef, useEffect, useMemo, useCallback } = React;
  const h = React.createElement;
  const CX = window.VOLO_CAL2;

  const ROLE = {
    origin: { short: 'O', label: 'origin', color: '#3ddc84' },
    x_axis: { short: 'X', label: 'x_axis', color: '#ff5a4d' },
    xy_plane: { short: 'XY', label: 'xy_plane', color: '#5aa2ff' },
  };
  const PROV = {
    measured: { color: '#46c882', label: 'measured 实测' },
    interpolated: { color: '#78b4ff', label: 'interpolated 插值' },
    extrapolated: { color: '#ff9628', label: 'extrapolated 外推' },
  };

  /* ---------- 点名 / 参考点角色（复用点名规约，见 CALIBRATE-UX.md G7 落地方案） ---------- */
  function pointName(screenId, col, row) {
    return screenId + '_V' + String(col + 1).padStart(3, '0') + '_R' + String(row + 1).padStart(3, '0');
  }
  function roleAtCabinet(coord, screenId, col, row) {
    if (!coord) return null;
    const name = pointName(screenId, col, row);
    if (coord.origin_point === name) return 'origin';
    if (coord.x_axis_point === name) return 'x_axis';
    if (coord.xy_plane_point === name) return 'xy_plane';
    return null;
  }

  /* ---------- 投影（模型 Z=竖直/行，Y=弯曲深度，X=列） ---------- */
  const VIEW_CAM = {
    persp: { S: 72, ox: 500, oy: 350 },
    front: { S: 96, ox: 500, oy: 415 },
    top: { S: 74, ox: 500, oy: 320 },
    side: { S: 96, ox: 500, oy: 415 },
  };
  let ORBIT = { az: 30, el: 22 };
  function proj(p, view) {
    const x = p.x, y = p.y, z = p.z;
    let u, v;
    if (view === 'front') { u = x; v = -z; }
    else if (view === 'top') { u = x; v = y; }
    else if (view === 'side') { u = -y; v = -z; }
    else {
      /* 转台式相机环绕：方位角 az 绕竖直轴 Z 旋转（X/Y 弯曲平面），俯仰角 el 再把
         结果与 Z 混合 —— 与传统三维软件的轨道相机一致。 */
      const a = ORBIT.az * Math.PI / 180, e = ORBIT.el * Math.PI / 180;
      const x1 = x * Math.cos(a) - y * Math.sin(a);
      const y1 = x * Math.sin(a) + y * Math.cos(a);
      const z2 = z * Math.cos(e) - y1 * Math.sin(e);
      u = x1; v = -z2;
    }
    const c = VIEW_CAM[view] || VIEW_CAM.persp;
    return [c.ox + u * c.S, c.oy + v * c.S];
  }
  const pstr = (pts) => pts.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');

  /* ---------- 名义（未重建）几何：镜像 shape_grid.rs 的逐列朝向角骨架 ---------- */
  function columnHeadingsDeg(m, cols) {
    const shape = m.shape_prior || {};
    if (shape.type === 'arc') {
      const mid = (cols - 1) / 2, cf = shape.center_flat_cols || 0, per = shape.angle_per_col_deg || 0;
      return Array.from({ length: cols }, (_, i) => { const d = i - mid; const out = Math.max(0, Math.abs(d) - cf / 2); return Math.sign(d) * out * per; });
    }
    if (shape.type === 'l_shape') {
      const lc = shape.left_cols || 0, soft = shape.soften_cols || 0, ang = shape.corner_angle_deg || 0;
      return Array.from({ length: cols }, (_, i) => i < lc ? 0 : i < lc + soft ? ang * ((i - lc + 1) / (soft + 1)) : ang);
    }
    if (shape.type === 'u_shape') {
      const wc = shape.wing_cols || 0, soft = shape.soften_cols || 0, ang = shape.corner_angle_deg || 0;
      return Array.from({ length: cols }, (_, i) => {
        if (i < wc) return ang;
        if (i < wc + soft) return ang * (1 - (i - wc + 1) / (soft + 1));
        if (i >= cols - wc) return -ang;
        if (i >= cols - wc - soft) return -ang * ((i - (cols - wc - soft) + 1) / (soft + 1));
        return 0;
      });
    }
    if (shape.type === 'custom_segments') {
      const out = [];
      (shape.segments || []).forEach((sg) => { for (let k = 0; k < sg.cols; k++) out.push(sg.cum_angle_deg); });
      while (out.length < cols) out.push(out.length ? out[out.length - 1] : 0);
      return out.slice(0, cols);
    }
    return new Array(cols).fill(0); /* flat / curved(闭式另算) / folded(暂等同 flat，同后端已知局限) */
  }

  /* 逐列铺列求 (cols+1) 个 seam 的 (x,y)；curved 用闭式圆弧公式（比分段近似精确），
     其余走「累加朝向角」骨架 —— 与 shape_grid.rs 的分支结构一一对应。 */
  function wallSeamsXY(m, cols, cwM) {
    if (m.shape_prior && m.shape_prior.type === 'curved') {
      const rM = (m.shape_prior.radius_mm || 1) / 1000;
      const totalWidth = cols * cwM, halfAngle = totalWidth / (2 * rM);
      const anchorX = rM * Math.sin(-halfAngle), anchorY = rM - rM * Math.cos(-halfAngle);
      const seams = [];
      for (let c = 0; c <= cols; c++) {
        const t = c / cols, theta = -halfAngle + 2 * halfAngle * t;
        seams.push({ x: rM * Math.sin(theta) - anchorX, y: (rM - rM * Math.cos(theta)) - anchorY });
      }
      return seams;
    }
    const headings = columnHeadingsDeg(m, cols);
    const seams = [{ x: 0, y: 0 }];
    for (let c = 0; c < cols; c++) {
      const a = headings[c] * Math.PI / 180, p = seams[c];
      seams.push({ x: p.x + cwM * Math.cos(a), y: p.y + cwM * Math.sin(a) });
    }
    return seams;
  }

  function buildNominalBoxes(m) {
    const cols = Math.max(1, m.cabinet_count[0] | 0), rows = Math.max(1, m.cabinet_count[1] | 0);
    const cwM = (m.cabinet_size_mm[0] || 500) / 1000, chM = (m.cabinet_size_mm[1] || 500) / 1000;
    const seams = wallSeamsXY(m, cols, cwM);
    const posX = (m.position_m && m.position_m[0]) || 0, posY = (m.position_m && m.position_m[1]) || 0, posZ = (m.position_m && m.position_m[2]) || 0;
    const yawRad = ((m.yaw_deg || 0) * Math.PI) / 180;
    const cy = Math.cos(yawRad), sy = Math.sin(yawRad);
    /* apply_world_transform 一致：yaw 绕竖直轴 Z 旋转 X/Y 弯曲平面。 */
    const place = (x, y, z) => ({ x: x * cy + y * sy + posX, y: -x * sy + y * cy + posY, z: z + posZ });
    const masked = new Set((m.irregular_mask || []).map(([c, r]) => c + ',' + r));
    const boxes = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const key = c + ',' + r;
      const s0 = seams[c], s1 = seams[c + 1];
      const zb = r * chM, zt = zb + chM;
      const corners = [place(s0.x, s0.y, zb), place(s1.x, s1.y, zb), place(s1.x, s1.y, zt), place(s0.x, s0.y, zt)];
      const cx = (s0.x + s1.x) / 2, cy2 = (s0.y + s1.y) / 2;
      boxes.push({ key, c, r, corners, depth: cx + cy2, masked: masked.has(key) });
    }
    return { boxes, seams, cols, rows, cwM, chM, place };
  }

  /* ---------- 已重建几何：读真实 ReconstructedSurface ---------- */
  function buildRealBoxes(surface) {
    const cols = surface.topology.cols, rows = surface.topology.rows;
    const verts = surface.vertices;
    const prov = surface.vertex_provenance || [];
    const vi = (c, r) => r * (cols + 1) + c;
    const at = (c, r) => { const v = verts[vi(c, r)]; return { x: v[0], y: v[1], z: v[2] }; };
    const provAt = (c, r) => prov.length ? prov[vi(c, r)] : null;
    const boxes = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const corners = [at(c, r), at(c + 1, r), at(c + 1, r + 1), at(c, r + 1)];
      const cx = corners.reduce((s, p) => s + p.x, 0) / 4, cy2 = corners.reduce((s, p) => s + p.y, 0) / 4;
      const provs = [provAt(c, r), provAt(c + 1, r), provAt(c, r + 1), provAt(c + 1, r + 1)];
      const prov1 = provs.find((x) => x === 'extrapolated') ? 'extrapolated' : provs.find((x) => x === 'interpolated') ? 'interpolated' : provs[0] || null;
      boxes.push({ key: c + ',' + r, c, r, corners, depth: cx + cy2, masked: false, prov: prov1 });
    }
    return { boxes, cols, rows };
  }

  /* ---------- 视口 SVG ---------- */
  function Viewport({ s }) {
    const proj_ = CX.useProj();
    const screens = proj_.config ? Object.keys(proj_.config.screens) : [];
    const view = s.calView;
    const disp = s.calDisplay;
    const cabinet = s.calMode === 'cabinet';
    const [zoom, setZoom] = useState(1);
    const [pan, setPan] = useState({ x: 0, y: 0 });
    const [orbit, setOrbit] = useState({ az: 30, el: 22 });
    const panRef = useRef(null);
    const orbitRef = useRef(null);
    const stageRef = useRef(null);
    ORBIT = orbit;

    const reset = useCallback(() => { setZoom(1); setPan({ x: 0, y: 0 }); setOrbit({ az: 30, el: 22 }); }, []);
    useEffect(() => {
      const onReset = () => reset();
      const onFocus = () => setZoom((z) => Math.min(3.2, z + 0.5));
      window.addEventListener('volo-gw-reset', onReset);
      window.addEventListener('volo-gw-focus', onFocus);
      return () => { window.removeEventListener('volo-gw-reset', onReset); window.removeEventListener('volo-gw-focus', onFocus); };
    }, [reset]);

    useEffect(() => {
      const el = stageRef.current; if (!el) return undefined;
      const onWheel = (e) => { e.preventDefault(); setZoom((z) => Math.max(0.5, Math.min(3.2, +(z - Math.sign(e.deltaY) * 0.12).toFixed(2)))); };
      el.addEventListener('wheel', onWheel, { passive: false });
      const move = (e) => {
        if (orbitRef.current) { const o = orbitRef.current; setOrbit({ az: o.az - (e.clientX - o.x) * 0.3, el: Math.max(-15, Math.min(88, o.el + (e.clientY - o.y) * 0.3)) }); return; }
        if (!panRef.current) return; setPan({ x: panRef.current.px + (e.clientX - panRef.current.x), y: panRef.current.py + (e.clientY - panRef.current.y) });
      };
      const up = () => { if (panRef.current) { el.classList.remove('is-panning'); panRef.current = null; } if (orbitRef.current) { el.classList.remove('is-orbiting'); orbitRef.current = null; } };
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
      return () => { el.removeEventListener('wheel', onWheel); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    }, [pan]);

    const onBg = (e) => {
      if (e.target.closest && e.target.closest('.gw-box')) return;
      if (e.button === 2) { panRef.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y }; stageRef.current.classList.add('is-panning'); return; }
      if (e.button === 0) { if (!cabinet) s.setCalSel(null); orbitRef.current = { x: e.clientX, y: e.clientY, az: orbit.az, el: orbit.el }; stageRef.current.classList.add('is-orbiting'); }
    };

    if (!proj_.config) return h('svg', { className: 'gw-svp', ref: stageRef, viewBox: '0 0 1000 700' });

    /* 每块屏幕：激活屏用草稿（若有）+ 已重建版本切换；其余屏幕恒用已保存配置 + 原始网格。 */
    const sbuilt = screens.map((id) => {
      const isActive = id === s.calActiveScreen;
      const cfg = (isActive && s.calDraftScreen) ? s.calDraftScreen : proj_.config.screens[id];
      const report = s.calScreenReports && s.calScreenReports[id];
      const built = !!report;
      const version = built ? s.calMeshVersion : 'original';
      const g = (version === 'rebuilt' || version === 'overlay') ? buildRealBoxes(report.surface) : buildNominalBoxes(cfg);
      const ghost = version === 'overlay' ? buildNominalBoxes(cfg) : null;
      return { id, cfg, isActive, g, ghost, built, version };
    });

    const activeEntry = sbuilt.find((x) => x.isActive) || sbuilt[0];
    const m = activeEntry ? activeEntry.cfg : null;
    const coord = proj_.config.coordinate_system;
    const selKey = s.calSel && s.calSel.type === 'cabinet' ? s.calSel.c + ',' + s.calSel.r : null;
    const multiKeys = s.calSel && s.calSel.type === 'cabinetMulti' ? new Set(s.calSel.keys || []) : null;

    const clickBox = (b, e) => {
      e.stopPropagation();
      if (!cabinet) { s.setCalSel({ type: 'screen' }); return; }
      const tool = s.calBoxTool;
      if (tool === 'mask') {
        if (m.shape_mode !== 'irregular') { s.setCalReceipt({ tone: 'notice', text: '矩形屏不支持遮罩，仅异形屏可镂空' }); return; }
        const cur = s.calDraftScreen || m;
        const set = new Set((cur.irregular_mask || []).map(([c, r]) => c + ',' + r));
        set.has(b.key) ? set.delete(b.key) : set.add(b.key);
        s.setCalDraftScreen(Object.assign({}, cur, { irregular_mask: [...set].map((k) => k.split(',').map(Number)) }));
        s.setCalSel({ type: 'cabinet', c: b.c, r: b.r });
      } else if (tool === 'refs') {
        const role = s.calRefRole;
        const name = pointName(s.calActiveScreen, b.c, b.r);
        const nextCoord = Object.assign({}, coord, { [role + '_point']: name });
        const nextConfig = Object.assign({}, proj_.config, { coordinate_system: nextCoord });
        s.runCmd({ domain: 'calibrate', action: '指派参考点', target: name, chan: 'local' },
          () => saveProjectYaml(proj_.path, nextConfig),
          { okMsg: () => `已指派 ${ROLE[role].label} → ${name}` })
          .then(() => CX.openProjectPath(proj_.path, s)).catch(() => {});
        s.setCalSel({ type: 'cabinet', c: b.c, r: b.r });
      } else {
        s.setCalSel(e.shiftKey && s.calSel && s.calSel.type === 'cabinetMulti'
          ? Object.assign({}, s.calSel, { keys: [...new Set([...(s.calSel.keys || []), b.key])] })
          : { type: 'cabinet', c: b.c, r: b.r });
      }
    };

    /* 地面网格 + 坐标轴 */
    const ground = [];
    if (disp.ground) {
      const G = 5, step = 0.5;
      for (let i = -G; i <= G; i += step) {
        ground.push(h('line', { key: 'gx' + i, className: 'gw-grid-l', x1: proj({ x: i, y: 0, z: -G }, view)[0], y1: proj({ x: i, y: 0, z: -G }, view)[1], x2: proj({ x: i, y: 0, z: G }, view)[0], y2: proj({ x: i, y: 0, z: G }, view)[1] }));
        ground.push(h('line', { key: 'gz' + i, className: 'gw-grid-l', x1: proj({ x: -G, y: 0, z: i }, view)[0], y1: proj({ x: -G, y: 0, z: i }, view)[1], x2: proj({ x: G, y: 0, z: i }, view)[0], y2: proj({ x: G, y: 0, z: i }, view)[1] }));
      }
    }
    const axes = [];
    if (disp.ground) {
      const O = proj({ x: 0, y: 0, z: 0 }, view);
      [['x', 1.6, 0, 0, '#ff5a4d', 'X'], ['y', 0, 1.6, 0, '#5aa2ff', 'Y'], ['z', 0, 0, 1.6, '#3ddc84', 'Z']].forEach(([id, x, y, z, col, lb]) => {
        const P = proj({ x, y, z }, view);
        axes.push(h('line', { key: 'a' + id, x1: O[0], y1: O[1], x2: P[0], y2: P[1], stroke: col, strokeWidth: 2, strokeLinecap: 'round', opacity: 0.9 }));
        axes.push(h('text', { key: 't' + id, x: P[0], y: P[1] - 3, fill: col, fontSize: 12, fontWeight: 700, textAnchor: 'middle' }, lb));
      });
    }

    const onBoxDown = (b, entry, e) => {
      if (entry.isActive) { clickBox(b, e); return; }
      e.stopPropagation(); s.setCalActiveScreen(entry.id); s.setCalDraftScreen(null); s.setCalMode('object'); s.setCalSel({ type: 'screen' });
    };
    const mkBox = (b, entry) => {
      const isActive = entry.isActive;
      const pts = pstr(b.corners.map((p) => proj(p, view)));
      if (b.masked && disp.maskStyle === 'cutout' && !(isActive && cabinet)) return h('polygon', { key: entry.id + b.key, className: 'gw-box gw-box--cut' + (isActive ? '' : ' gw-box--dim'), points: pts, onMouseDown: (e) => onBoxDown(b, entry, e) });
      let fill = '#39485a';
      if (disp.provenance && b.prov) fill = PROV[b.prov].color;
      if (b.masked) fill = 'rgba(120,124,134,0.28)';
      const role = coord ? roleAtCabinet(coord, entry.id, b.c, b.r) : null;
      let cls = 'gw-box' + (b.masked ? ' gw-box--masked' : '') + (isActive ? '' : ' gw-box--dim');
      if (isActive && (b.key === selKey || (multiKeys && multiKeys.has(b.key)))) cls += ' is-sel';
      if (role) cls += ' is-ref';
      return h('g', { key: entry.id + b.key },
        h('polygon', { className: cls, points: pts, style: { fill, stroke: role ? ROLE[role].color : undefined }, onMouseDown: (e) => onBoxDown(b, entry, e), title: entry.id + ' V' + String(b.c + 1).padStart(2, '0') + '_R' + String(b.r + 1).padStart(2, '0') }),
        role ? (function () { const cn = proj(b.corners[0], view); return h('g', null, h('circle', { cx: cn[0], cy: cn[1], r: 8, fill: ROLE[role].color, stroke: '#0c0c10', strokeWidth: 1.5 }), h('text', { x: cn[0], y: cn[1] + 3.2, fill: '#0c0c10', fontSize: 8.5, fontWeight: 800, textAnchor: 'middle' }, ROLE[role].short)); })() : null);
    };

    let allBoxes = [];
    sbuilt.forEach((entry) => entry.g.boxes.forEach((b) => allBoxes.push({ b, entry })));
    allBoxes.sort((x, y) => (view === 'top' ? x.b.corners[0].y - y.b.corners[0].y : y.b.depth - x.b.depth));
    const boxEls = allBoxes.map(({ b, entry }) => mkBox(b, entry));

    const ghost = [];
    sbuilt.forEach((entry) => { if (entry.ghost) entry.ghost.boxes.forEach((b) => ghost.push(h('polygon', { key: 'gh' + entry.id + b.key, className: 'gw-ghost', points: pstr(b.corners.map((p) => proj(p, view))) }))); });

    const labels = sbuilt.length > 1 ? sbuilt.map((entry) => {
      const g = entry.g;
      const midCorner = g.boxes.length ? g.boxes[Math.floor(g.boxes.length / 2)].corners[3] : { x: 0, y: 0, z: 0 };
      const p = proj({ x: midCorner.x, y: midCorner.y, z: midCorner.z + 0.28 }, view);
      return h('text', { key: 'lb' + entry.id, x: p[0], y: p[1], textAnchor: 'middle', className: 'gw-wall-lb' + (entry.isActive ? ' on' : '') }, entry.id);
    }) : null;

    /* 测量点（仅激活屏，读 proj.measured；见 gridTree.tsx 的全站仪流写入） */
    const points = [];
    if (disp.points && proj_.measured && proj_.measured.points && activeEntry) {
      const seen = new Set();
      proj_.measured.points.forEach((pt) => {
        if (!pt.name.startsWith(s.calActiveScreen + '_V')) return;
        const p = proj({ x: pt.position[0], y: pt.position[1], z: pt.position[2] }, view);
        const outlier = pt.uncertainty && 'isotropic' in pt.uncertainty && pt.uncertainty.isotropic > 5;
        points.push(h('circle', { key: 'p' + pt.name, cx: p[0], cy: p[1], r: outlier ? 3.4 : 2.4, className: 'gw-pt' + (outlier ? ' gw-pt--out' : '') }));
        if (disp.pointLabels && !seen.has(pt.name)) { seen.add(pt.name); points.push(h('text', { key: 'pl' + pt.name, x: p[0] + 5, y: p[1] - 4, className: 'gw-pt-lb' }, pt.name)); }
      });
    }

    return h('svg', { className: 'gw-svp', ref: stageRef, viewBox: '0 0 1000 700', preserveAspectRatio: 'xMidYMid meet', onMouseDown: onBg, onContextMenu: (e) => e.preventDefault() },
      h('defs', null,
        h('pattern', { id: 'gwPat', width: 7, height: 7, patternUnits: 'userSpaceOnUse' },
          h('rect', { width: 7, height: 7, fill: 'none' }),
          h('rect', { width: 3.5, height: 3.5, fill: 'rgba(255,255,255,.55)' }),
          h('rect', { x: 3.5, y: 3.5, width: 3.5, height: 3.5, fill: 'rgba(255,255,255,.55)' }))),
      h('g', { transform: 'translate(' + pan.x + ',' + pan.y + ') scale(' + zoom + ')', style: { transformOrigin: '500px 350px' } },
        h('g', { className: 'gw-ground' }, ground),
        axes, ghost, boxEls, labels, points));
  }

  /* ================= 四角叠加 + 工具条 + 状态栏 ================= */
  function DisplayToggles({ s }) {
    const d = s.calDisplay;
    const set = (k, v) => s.setCalDisplay(Object.assign({}, d, { [k]: v }));
    return h('div', { className: 'gw-glass gw-disp' },
      h('div', { className: 'gw-disp-h' }, '显示'),
      GRID_DISPLAY_ITEMS.map((it) => h(React.Fragment, { key: it.k },
        h('div', { className: 'gw-disp-row' + (d[it.k] ? ' on' : ''), onClick: () => set(it.k, !d[it.k]) },
          h('span', { className: 'ic' }, h(Icon, { name: it.icon, size: 15 })),
          h('span', { className: 'lbl' }, it.label),
          h('span', { className: 'gw-sw' + (d[it.k] ? ' on' : '') })),
        it.child && d[it.k] ? h('div', { className: 'gw-disp-row gw-disp-child' + (d[it.child] ? ' on' : ''), onClick: () => set(it.child, !d[it.child]) },
          h('span', { className: 'ic' }, h(Icon, { name: 'list', size: 13 })),
          h('span', { className: 'lbl' }, it.childLabel),
          h('span', { className: 'gw-sw' + (d[it.child] ? ' on' : '') })) : null)),
      h('div', { className: 'gw-disp-row', style: { cursor: 'default' } },
        h('span', { className: 'ic' }, h(Icon, { name: 'panel', size: 15 })),
        h('span', { className: 'lbl' }, '遮罩箱体'),
        h('div', { className: 'gw-seg2' },
          h('button', { className: d.maskStyle === 'cutout' ? 'on' : '', onClick: () => set('maskStyle', 'cutout') }, '镂空'),
          h('button', { className: d.maskStyle === 'ghost' ? 'on' : '', onClick: () => set('maskStyle', 'ghost') }, '半透明'))));
  }

  function CtxCard({ s }) {
    const proj_ = CX.useProj();
    const m = (proj_.config && proj_.config.screens[s.calActiveScreen]) || {};
    const built = s.calScreenReports && s.calScreenReports[s.calActiveScreen];
    const verLabel = !built ? '原始网格' : s.calMeshVersion === 'original' ? '原始网格' : s.calMeshVersion === 'rebuilt' ? '新建网格' : '叠加（原始+新建）';
    if (s.calFlow) {
      const t = GRID_MEAS_TYPES.find((x) => x.id === s.calFlow) || GRID_MEAS_TYPES[0];
      return h('div', { className: 'gw-glass gw-ctxcard' },
        h('div', { className: 'scr' }, h(Icon, { name: 'panel', size: 15 }), h('b', null, s.calActiveScreen)),
        h('button', { className: 'gw-meastoggle', onClick: () => s.setModal({ wide: true, render: ({ close }) => window.VOLO_GRID_MODALS.measSelector(s, close) }) },
          h(Icon, { name: t.icon, size: 14 }), h('span', null, t.label), h(Icon, { name: 'chevd', size: 13 })));
    }
    return h('div', { className: 'gw-glass gw-ctxcard' },
      h('div', { className: 'scr' }, h(Icon, { name: 'panel', size: 15 }), h('b', null, s.calActiveScreen)),
      h('div', { className: 'row' },
        h('span', { className: 'tag' }, s.calMode === 'cabinet' ? '箱体模式' : '对象模式'),
        h('span', null, '当前：'), h('span', { className: 'ver' }, verLabel)));
  }

  function VersionSwitcher({ s }) {
    const built = s.calScreenReports && s.calScreenReports[s.calActiveScreen];
    if (!built) return null;
    const v = s.calMeshVersion;
    const set = (nv) => s.setCalMeshVersion(nv);
    return h('div', { className: 'gw-glass gw-ver' },
      h('button', { className: v === 'original' ? 'on' : '', onClick: () => set('original') }, '原始网格'),
      h('div', { className: 'sep' }),
      h('button', { className: v === 'rebuilt' ? 'on' : '', onClick: () => set('rebuilt') }, '新建网格'),
      h('div', { className: 'sep' }),
      h('button', { className: v === 'overlay' ? 'on' : '', onClick: () => set('overlay'), title: '当前版实体 + 另一版线框幽灵同显' }, '叠加', h('span', { className: 'kbd' }, '\\')));
  }

  function HintBar({ s }) {
    const cabinet = s.calMode === 'cabinet';
    const tool = s.calBoxTool;
    let hint;
    if (!cabinet) hint = [['Tab', '箱体编辑'], ['左键', '旋转'], ['右键', '平移'], ['滚轮', '缩放']];
    else if (tool === 'mask') hint = [['单击', '切换镂空'], ['Tab', '退出']];
    else if (tool === 'refs') hint = [['单击角点', '指派角色'], ['1/2/3', '切角色']];
    else hint = [['单击', '选箱体'], ['Shift', '加选']];
    return h('div', { className: 'gw-glass gw-hint' }, hint.flatMap(([k, v], i) => [
      i > 0 ? h('span', { className: 'sep', key: 's' + i }, '·') : null,
      h('kbd', { key: 'k' + i }, k), h('span', { key: 'v' + i }, v),
    ]));
  }

  function Legend({ s }) {
    const d = s.calDisplay;
    if (!d.provenance) return null;
    return h('div', { className: 'gw-glass gw-legend' },
      Object.keys(PROV).map((k) => h('div', { className: 'li', key: k },
        h('span', { className: 'sw', style: { background: PROV[k].color } }), PROV[k].label)));
  }

  function BoxBar({ s }) {
    const proj_ = CX.useProj();
    const m = (proj_.config && proj_.config.screens[s.calActiveScreen]) || {};
    const tool = s.calBoxTool;
    const rectScreen = m.shape_mode !== 'irregular';
    const coord = proj_.config && proj_.config.coordinate_system;
    const T = (id, label, key, icon) => h('button', { className: 'tbtn' + (tool === id ? ' on' : ''), onClick: () => s.setCalBoxTool(id), title: label + ' (' + key + ')' },
      h(Icon, { name: icon, size: 14 }), h('span', null, label), h('kbd', null, key));
    return h('div', { className: 'gw-glass gw-boxbar' },
      T('select', '选择', 'V', 'target'),
      h('button', { className: 'tbtn' + (tool === 'mask' ? ' on' : ''), onClick: () => s.setCalBoxTool('mask'), disabled: rectScreen, style: rectScreen ? { opacity: .45 } : null, title: rectScreen ? '矩形屏不支持遮罩' : '遮罩 (M)' },
        h(Icon, { name: 'panel', size: 14 }), h('span', null, '遮罩'), h('kbd', null, 'M')),
      T('refs', '参考点', 'R', 'pin'),
      tool === 'refs' ? h(React.Fragment, null,
        h('div', { className: 'sep' }),
        h('div', { className: 'gw-roleseg' }, ['origin', 'x_axis', 'xy_plane'].map((rk, i) => {
          const assigned = coord && (coord.origin_point + coord.x_axis_point + coord.xy_plane_point).includes(rk === 'origin' ? coord.origin_point : rk === 'x_axis' ? coord.x_axis_point : coord.xy_plane_point);
          return h('button', { key: rk, className: s.calRefRole === rk ? 'on' : '', onClick: () => s.setCalRefRole(rk), title: ROLE[rk].label },
            h('span', { className: 'dot', style: { background: ROLE[rk].color } }),
            ROLE[rk].label, h('span', { className: 'num' }, i + 1),
            assigned ? h('span', { className: 'done' }, h(Icon, { name: 'check', size: 11 })) : null);
        }))) : null);
  }

  function Coords() {
    const [c, setC] = useState([0, 0, 0]);
    useEffect(() => {
      const el = document.querySelector('.gw-stage'); if (!el) return undefined;
      const onMove = (e) => { const r = el.getBoundingClientRect(); const nx = (e.clientX - r.left) / r.width - 0.5, ny = (e.clientY - r.top) / r.height - 0.5; setC([+(nx * 8).toFixed(3), +(-ny * 4).toFixed(3), +(nx * 3 + 1.5).toFixed(3)]); };
      el.addEventListener('mousemove', onMove);
      return () => el.removeEventListener('mousemove', onMove);
    }, []);
    return h('div', { className: 'gw-glass gw-coords' },
      h('span', { className: 'u' }, '单位'), h('b', null, 'm'),
      h('span', { className: 'xyz' }, 'X ', c[0], '  Y ', c[1], '  Z ', c[2]));
  }
  function Receipt({ s }) {
    useEffect(() => { if (!s.calReceipt) return undefined; const t = setTimeout(() => s.setCalReceipt(null), 4200); return () => clearTimeout(t); }, [s.calReceipt]);
    if (!s.calReceipt) return null;
    return h('div', { className: 'gw-glass gw-receipt gw-receipt--' + (s.calReceipt.tone === 'notice' ? 'notice' : 'ok') },
      h(Icon, { name: s.calReceipt.tone === 'notice' ? 'alert' : 'check', size: 13 }), s.calReceipt.text);
  }

  function useHotkeys(s) {
    useEffect(() => {
      const onKey = (e) => {
        if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
        if (s.calSection !== 'rebuild' || s.calStageType !== 'led') return;
        const k = e.key.toLowerCase();
        if (e.key === 'Tab') { e.preventDefault(); s.setCalMode(s.calMode === 'cabinet' ? 'object' : 'cabinet'); s.setCalSel(null); return; }
        if (s.calMode === 'cabinet') {
          if (k === 'v' || e.key === 'Escape') s.setCalBoxTool('select');
          else if (k === 'm') s.setCalBoxTool('mask');
          else if (k === 'r') s.setCalBoxTool('refs');
          else if (k === '1') s.setCalRefRole('origin'); else if (k === '2') s.setCalRefRole('x_axis'); else if (k === '3') s.setCalRefRole('xy_plane');
        }
        const built = s.calScreenReports && s.calScreenReports[s.calActiveScreen];
        if (k === '\\' && built) { const seq = ['original', 'rebuilt', 'overlay']; s.setCalMeshVersion(seq[(seq.indexOf(s.calMeshVersion) + 1) % 3]); }
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [s.calMode, s.calMeshVersion, s.calSection, s.calStageType, s.calActiveScreen, s.calScreenReports]);
  }

  function Center({ s }) {
    useHotkeys(s);
    useEffect(() => { s.setLeftCollapsed(false); s.setRightCollapsed(false); }, []);
    const cabinet = s.calMode === 'cabinet';
    return h('div', { className: 'gw-center' },
      h('div', { className: 'gw-stage' },
        h(Viewport, { s }),
        cabinet ? h(BoxBar, { s }) : null,
        h('div', { className: 'gw-ov gw-ov--tl' }, h(CtxCard, { s }), h(Coords)),
        h('div', { className: 'gw-ov gw-ov--tr' }, h(DisplayToggles, { s })),
        h('div', { className: 'gw-ov gw-ov--bc' }, h(VersionSwitcher, { s })),
        h('div', { className: 'gw-ov gw-ov--bl' }, h(HintBar, { s }), h(Legend, { s })),
        h('div', { className: 'gw-ov gw-ov--br' }, h(Receipt, { s }))));
  }

  window.VOLO_GRID = Object.assign(window.VOLO_GRID || {}, { Center, center: (s) => h(Center, { s }), ROLE, PROV, pointName, roleAtCabinet, buildNominalBoxes, buildRealBoxes });
})();
