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
import { generatedPatternImagePath, readGeneratedPatternAsDataUrl } from "../api/meshVisualCommands";

(function () {
  const { useState, useRef, useEffect, useMemo, useCallback } = React;
  const h = React.createElement;
  const CX = window.VOLO_CAL2;

  const ROLE = {
    origin: { short: 'O', label: 'origin', color: '#3ddc84' },
    x_axis: { short: 'X', label: 'x_axis', color: '#ff5a4d' },
    xy_plane: { short: 'Y', label: 'xy_plane', color: '#5aa2ff' },
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
  function parsePointName(name, screenId) {
    const prefix = screenId + '_V';
    const raw = String(name || '');
    if (!raw.startsWith(prefix)) return null;
    const m = raw.slice(prefix.length).match(/^(\d+)_R(\d+)$/);
    return m ? { c: Number(m[1]) - 1, r: Number(m[2]) - 1 } : null;
  }

  /* ---------- 投影（模型 Z=竖直/行，Y=弯曲深度，X=列） ---------- */
  const VIEW_CAM = {
    persp: { S: 72, ox: 500, oy: 350 },
    front: { S: 96, ox: 500, oy: 415 },
    top: { S: 74, ox: 500, oy: 320 },
    side: { S: 96, ox: 500, oy: 415 },
  };
  let ORBIT = { az: 30, el: 22 };
  /* 轨道目标点：场景内容（全部屏幕箱体）包围盒中心。相机绕它旋转、视口以它取景，
     与传统三维软件的 turntable 相机一致；设计稿原型把几何居中到原点等效于此。 */
  let TARGET = { x: 0, y: 0, z: 0 };
  function proj(p, view) {
    const x = p.x - TARGET.x, y = p.y - TARGET.y, z = p.z - TARGET.z;
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

  /* Map one source-image triangle to one projected triangle. Splitting every
     cabinet into two triangles keeps the real PNG exact even when a rebuilt
     cabinet projects to a non-parallelogram quad. */
  function affineFromTriangles(src, dst) {
    const [p0, p1, p2] = src, [q0, q1, q2] = dst;
    const det = p0[0] * (p1[1] - p2[1]) + p1[0] * (p2[1] - p0[1]) + p2[0] * (p0[1] - p1[1]);
    if (Math.abs(det) < 1e-9) return null;
    const solve = (v0, v1, v2) => {
      const a = (v0 * (p1[1] - p2[1]) + v1 * (p2[1] - p0[1]) + v2 * (p0[1] - p1[1])) / det;
      const c = (v0 * (p2[0] - p1[0]) + v1 * (p0[0] - p2[0]) + v2 * (p1[0] - p0[0])) / det;
      const e = (v0 * (p1[0] * p2[1] - p2[0] * p1[1]) + v1 * (p2[0] * p0[1] - p0[0] * p2[1]) + v2 * (p0[0] * p1[1] - p1[0] * p0[1])) / det;
      return [a, c, e];
    };
    const x = solve(q0[0], q1[0], q2[0]), y = solve(q0[1], q1[1], q2[1]);
    return `matrix(${x[0]} ${y[0]} ${x[1]} ${y[1]} ${x[2]} ${y[2]})`;
  }

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
    const posX = (m.position_m && m.position_m[0]) || 0, posY = (m.position_m && m.position_m[1]) || 0,
      posZ = ((m.position_m && m.position_m[2]) || 0) + (m.height_offset_mm || 0) / 1000;
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
  const VIEWPORT_MIN_ZOOM = 0.5;
  const VIEWPORT_MAX_ZOOM = 16;

  function Viewport({ s }) {
    const proj_ = CX.useProj();
    const screens = proj_.config ? Object.keys(proj_.config.screens) : [];
    const view = s.calView;
    const disp = s.calDisplay;
    const cabinet = s.calMode === 'cabinet';
    const [zoom, setZoom] = useState(1);
    const [pan, setPan] = useState({ x: 0, y: 0 });
    const [orbit, setOrbit] = useState({ az: 30, el: 22 });
    const [marquee, setMarquee] = useState(null); /* {x0,y0,x1,y1} SVG 外层坐标 */
    const panRef = useRef(null);
    const orbitRef = useRef(null);
    const stageRef = useRef(null);
    const marqueeRef = useRef(null); /* {cx0,cy0,cx1,cy1} client 坐标 */
    const marqueeFinalizeRef = useRef(null); /* 每次渲染更新，up 时用当前几何做框选命中 */
    const paintRef = useRef(null); /* 遮罩拖刷：{ to: boolean } */
    const innerRef = useRef(null); /* 内层 pan/zoom <g>，命中转换用其真实 CTM */
    const touchedRef = useRef(false); /* 用户手动操作过视口后停用自动取景 */
    const patternResult = proj_.patternGenByScreen && proj_.patternGenByScreen[s.calActiveScreen];
    const patternPath = patternResult && patternResult.output_dir ? generatedPatternImagePath(patternResult.output_dir) : null;
    const [patternImage, setPatternImage] = useState(null); /* { path, dataUrl } */
    ORBIT = orbit;

    useEffect(() => {
      let active = true;
      if (!disp.pattern || !patternPath) { setPatternImage(null); return () => { active = false; }; }
      readGeneratedPatternAsDataUrl(patternPath)
        .then((dataUrl) => { if (active) setPatternImage({ path: patternPath, dataUrl }); })
        .catch((e) => {
          if (!active) return;
          setPatternImage(null);
          s.pushLog({ lv: 'err', cat: 'calibrate', msg: `测试图预览读取失败 · ${e && e.message ? e.message : e}` });
        });
      return () => { active = false; };
    }, [disp.pattern, patternPath, patternResult]);

    /* client 坐标 → 指定元素（外层 svg / 内层 g）局部坐标，走引擎 CTM，
       避免手写反演与 transform-origin 实现差异打架。 */
    const toLocal = (el, cx, cyv) => {
      const svg = stageRef.current;
      if (!svg || !svg.createSVGPoint || !el) return [0, 0];
      const pt = svg.createSVGPoint(); pt.x = cx; pt.y = cyv;
      const ctm = el.getScreenCTM();
      if (!ctm) return [0, 0];
      const p = pt.matrixTransform(ctm.inverse());
      return [p.x, p.y];
    };

    const reset = useCallback(() => { touchedRef.current = false; setZoom(1); setPan({ x: 0, y: 0 }); setOrbit({ az: 30, el: 22 }); }, []);
    useEffect(() => {
      const onReset = () => reset();
      const onFocus = () => setZoom((z) => Math.min(VIEWPORT_MAX_ZOOM, z + 0.5));
      window.addEventListener('volo-gw-reset', onReset);
      window.addEventListener('volo-gw-focus', onFocus);
      return () => { window.removeEventListener('volo-gw-reset', onReset); window.removeEventListener('volo-gw-focus', onFocus); };
    }, [reset]);

    useEffect(() => {
      const el = stageRef.current; if (!el) return undefined;
      const onWheel = (e) => {
        e.preventDefault();
        touchedRef.current = true;
        setZoom((z) => {
          const step = z > 3 ? 0.24 : 0.12;
          return Math.max(VIEWPORT_MIN_ZOOM, Math.min(VIEWPORT_MAX_ZOOM, +(z - Math.sign(e.deltaY) * step).toFixed(2)));
        });
      };
      el.addEventListener('wheel', onWheel, { passive: false });
      const move = (e) => {
        if (marqueeRef.current) { marqueeRef.current = Object.assign({}, marqueeRef.current, { cx1: e.clientX, cy1: e.clientY }); setMarquee(marqueeRef.current); return; }
        if (orbitRef.current) { const o = orbitRef.current; setOrbit({ az: o.az - (e.clientX - o.x) * 0.3, el: Math.max(-15, Math.min(88, o.el + (e.clientY - o.y) * 0.3)) }); return; }
        if (!panRef.current) return; setPan({ x: panRef.current.px + (e.clientX - panRef.current.x), y: panRef.current.py + (e.clientY - panRef.current.y) });
      };
      const up = () => {
        if (marqueeRef.current) { const r = marqueeRef.current; marqueeRef.current = null; setMarquee(null); if (marqueeFinalizeRef.current) marqueeFinalizeRef.current(r); }
        if (paintRef.current) paintRef.current = null;
        if (panRef.current) { el.classList.remove('is-panning'); panRef.current = null; }
        if (orbitRef.current) { el.classList.remove('is-orbiting'); orbitRef.current = null; }
      };
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
      return () => { el.removeEventListener('wheel', onWheel); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    }, [pan]);

    const startPan = (e) => { touchedRef.current = true; panRef.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y }; stageRef.current.classList.add('is-panning'); };
    const startOrbit = (e) => { touchedRef.current = true; orbitRef.current = { x: e.clientX, y: e.clientY, az: orbit.az, el: orbit.el }; stageRef.current.classList.add('is-orbiting'); };
    const onBg = (e) => {
      if (e.target.closest && e.target.closest('.gw-box')) return;
      if (e.button === 2) { startPan(e); return; }
      if (e.button === 0) {
        /* 箱体模式·选择工具：Shift+左拖 = 框选多选；纯左拖恒为轨道旋转（传统 DCC 习惯）。 */
        if (cabinet && s.calBoxTool === 'select' && e.shiftKey) { marqueeRef.current = { cx0: e.clientX, cy0: e.clientY, cx1: e.clientX, cy1: e.clientY }; setMarquee(marqueeRef.current); return; }
        if (!cabinet) s.setCalSel(null);
        startOrbit(e);
      }
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

    /* 轨道目标 + 自动取景：内容包围盒中心为旋转枢轴；未手动操作视口时按内容尺度取景。 */
    let bboxMin = null, bboxMax = null;
    sbuilt.forEach((entry) => entry.g.boxes.forEach((b) => b.corners.forEach((p) => {
      if (!bboxMin) { bboxMin = { x: p.x, y: p.y, z: p.z }; bboxMax = { x: p.x, y: p.y, z: p.z }; }
      else {
        bboxMin.x = Math.min(bboxMin.x, p.x); bboxMin.y = Math.min(bboxMin.y, p.y); bboxMin.z = Math.min(bboxMin.z, p.z);
        bboxMax.x = Math.max(bboxMax.x, p.x); bboxMax.y = Math.max(bboxMax.y, p.y); bboxMax.z = Math.max(bboxMax.z, p.z);
      }
    })));
    TARGET = bboxMin ? { x: (bboxMin.x + bboxMax.x) / 2, y: (bboxMin.y + bboxMax.y) / 2, z: (bboxMin.z + bboxMax.z) / 2 } : { x: 0, y: 0, z: 0 };
    /* 内容对角线（米）→ 期望占视口宽 ~55%（1000 单位 · S=72/米），夹在滚轮缩放范围内。 */
    const diagM = bboxMin ? Math.max(0.5, Math.hypot(bboxMax.x - bboxMin.x, bboxMax.y - bboxMin.y, bboxMax.z - bboxMin.z)) : 4;
    const fitZoom = Math.max(VIEWPORT_MIN_ZOOM, Math.min(VIEWPORT_MAX_ZOOM, +(550 / (diagM * 72)).toFixed(2)));
    /* 渲染期校正（非 hook，规避早退分支的 Hooks 顺序问题）：用户未手动缩放/旋转/平移
       前，跟随内容自动取景。 */
    if (!touchedRef.current && Math.abs(zoom - fitZoom) > 0.01) setZoom(fitZoom);

    const activeEntry = sbuilt.find((x) => x.isActive) || sbuilt[0];
    const m = activeEntry ? activeEntry.cfg : null;
    const coord = proj_.config.coordinate_system;
    const selKey = s.calSel && s.calSel.type === 'cabinet' ? s.calSel.c + ',' + s.calSel.r : null;
    const multiKeys = s.calSel && s.calSel.type === 'cabinetMulti' ? new Set(s.calSel.keys || []) : null;

    const setBoxMask = (b, to) => {
      const cur = s.calDraftScreen || m;
      const set = new Set((cur.irregular_mask || []).map(([c, r]) => c + ',' + r));
      if (to == null) set.has(b.key) ? set.delete(b.key) : set.add(b.key);
      else if (to) set.add(b.key); else set.delete(b.key);
      s.setCalDraftScreen(Object.assign({}, cur, { irregular_mask: [...set].map((k) => k.split(',').map(Number)) }));
      return set.has(b.key);
    };
    const clickBox = (b, e) => {
      e.stopPropagation();
      if (!cabinet) { s.setCalSel({ type: 'screen' }); return; }
      const tool = s.calBoxTool;
      if (tool === 'mask') {
        if (m.shape_mode !== 'irregular') { s.setCalReceipt({ tone: 'notice', text: '矩形屏不支持遮罩，仅异形屏可镂空' }); return; }
        const nowMasked = setBoxMask(b, null);
        paintRef.current = { to: nowMasked }; /* 拖刷：后续划过的箱体统一设为首格的新状态 */
        s.setCalSel({ type: 'cabinet', c: b.c, r: b.r });
      } else if (tool === 'refs') {
        s.setCalSel({ type: 'cabinet', c: b.c, r: b.r });
        s.setCalReceipt({ tone: 'notice', text: '请点击屏幕接缝处的绿色角点指派参考点' });
      } else {
        s.setCalSel(e.shiftKey && s.calSel && s.calSel.type === 'cabinetMulti'
          ? Object.assign({}, s.calSel, { keys: [...new Set([...(s.calSel.keys || []), b.key])] })
          : { type: 'cabinet', c: b.c, r: b.r });
      }
    };

    const assignReferenceVertex = (c, r, e) => {
      e.stopPropagation();
      const role = s.calRefRole;
      const name = pointName(s.calActiveScreen, c, r);
      const nextCoord = Object.assign({}, coord, { [role + '_point']: name });
      const nextConfig = Object.assign({}, proj_.config, { coordinate_system: nextCoord });
      s.runCmd({ domain: 'calibrate', action: '指派参考点', target: name, chan: 'local' },
        () => saveProjectYaml(proj_.path, nextConfig),
        { okMsg: () => `已指派 ${ROLE[role].label} → ${name}` })
        .then(() => CX.openProjectPath(proj_.path, s)).catch(() => {});
    };

    /* Blender-style 地面细网格：0.5m 次要线、1m 主要线，世界原点轴线另绘。 */
    const ground = [];
    if (disp.ground) {
      const G = 8, step = 0.5;
      for (let i = -G; i <= G; i += step) {
        if (Math.abs(i) < 1e-6) continue;
        const cls = 'gw-grid-l' + (Math.abs(i % 1) < 1e-6 ? ' maj' : '');
        ground.push(h('line', { key: 'gx' + i, className: cls, x1: proj({ x: i, y: -G, z: 0 }, view)[0], y1: proj({ x: i, y: -G, z: 0 }, view)[1], x2: proj({ x: i, y: G, z: 0 }, view)[0], y2: proj({ x: i, y: G, z: 0 }, view)[1] }));
        ground.push(h('line', { key: 'gz' + i, className: cls, x1: proj({ x: -G, y: i, z: 0 }, view)[0], y1: proj({ x: -G, y: i, z: 0 }, view)[1], x2: proj({ x: G, y: i, z: 0 }, view)[0], y2: proj({ x: G, y: i, z: 0 }, view)[1] }));
      }
    }
    /* 显示 X（红）= stage X；显示 Z（蓝）= stage Y；显示 Y（绿向上）= stage Z。 */
    const axes = [];
    if (disp.ground) {
      const G = 8;
      const axis = (id, a, b, color) => { const p0 = proj(a, view), p1 = proj(b, view); axes.push(h('line', { key: id, x1: p0[0], y1: p0[1], x2: p1[0], y2: p1[1], stroke: color, strokeWidth: 1, strokeLinecap: 'round', opacity: .8 })); };
      axis('axis-x', { x: -G, y: 0, z: 0 }, { x: G, y: 0, z: 0 }, '#c74436');
      axis('axis-z', { x: 0, y: -G, z: 0 }, { x: 0, y: G, z: 0 }, '#3f74c4');
      axis('axis-y', { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 2 }, '#3f9c46');
    }

    const onBoxDown = (b, entry, e) => {
      e.stopPropagation();
      if (e.button === 2) { startPan(e); return; }
      if (e.button !== 0) return;
      if (!cabinet || s.calBoxTool === 'select') startOrbit(e);
      if (entry.isActive) { clickBox(b, e); return; }
      s.setCalActiveScreen(entry.id); s.setCalDraftScreen(null); s.setCalMode('object'); s.setCalSel({ type: 'screen' });
    };
    const paintEnter = (b, entry) => {
      if (!entry.isActive || !cabinet || s.calBoxTool !== 'mask' || !paintRef.current) return;
      if (m.shape_mode !== 'irregular') return;
      setBoxMask(b, paintRef.current.to);
    };
    const cameraToViewer = (() => {
      if (view === 'front') return { x: 0, y: 1, z: 0 };
      if (view === 'top') return { x: 0, y: 0, z: 1 };
      if (view === 'side') return { x: 1, y: 0, z: 0 };
      const a = orbit.az * Math.PI / 180, e = orbit.el * Math.PI / 180;
      return { x: Math.sin(a) * Math.cos(e), y: Math.cos(a) * Math.cos(e), z: Math.sin(e) };
    })();
    const boxCenter = (b) => b.corners.reduce((p, q) => ({ x: p.x + q.x / 4, y: p.y + q.y / 4, z: p.z + q.z / 4 }), { x: 0, y: 0, z: 0 });
    const boxNormal = (b, entry) => {
      const dx = b.corners[1].x - b.corners[0].x, dy = b.corners[1].y - b.corners[0].y;
      const len = Math.hypot(dx, dy) || 1, sign = entry.cfg.normal_flip ? -1 : 1;
      return { x: sign * -dy / len, y: sign * dx / len, z: 0 };
    };
    const faceToCamera = (b, entry) => {
      const n = boxNormal(b, entry);
      return n.x * cameraToViewer.x + n.y * cameraToViewer.y + n.z * cameraToViewer.z > 1e-6;
    };
    const patternDefs = [];
    const patternForBox = (b, entry, projected) => {
      if (!disp.pattern || !patternImage || patternImage.path !== patternPath || !entry.isActive || b.masked || !faceToCamera(b, entry)) return null;
      const ppc = entry.cfg.pixels_per_cabinet;
      if (!ppc || !ppc[0] || !ppc[1]) return null;
      const sx0 = b.c * ppc[0], sx1 = sx0 + ppc[0];
      /* Generator canvas uses row 0 at wall TOP; viewport geometry uses row 0
         at wall BOTTOM. This conversion is required for physical orientation. */
      const canvasRow = entry.g.rows - 1 - b.r;
      const sy0 = canvasRow * ppc[1], sy1 = sy0 + ppc[1];
      const [pBL, pBR, pTR, pTL] = projected;
      const triangles = [
        { src: [[sx0, sy0], [sx1, sy0], [sx1, sy1]], dst: [pTL, pTR, pBR] },
        { src: [[sx0, sy0], [sx1, sy1], [sx0, sy1]], dst: [pTL, pBR, pBL] },
      ];
      const safeId = entry.id.replace(/[^a-zA-Z0-9_-]/g, '_');
      return triangles.map((tri, i) => {
        const clipId = `gw-pat-${safeId}-${b.c}-${b.r}-${i}`;
        patternDefs.push(h('clipPath', { id: clipId, key: clipId }, h('polygon', { points: pstr(tri.dst) })));
        const transform = affineFromTriangles(tri.src, tri.dst);
        return transform ? h('g', { key: clipId + '-group', clipPath: `url(#${clipId})` },
          h('image', {
            className: 'gw-box-pat', href: patternImage.dataUrl,
            x: 0, y: 0,
            width: ppc[0] * entry.g.cols, height: ppc[1] * entry.g.rows,
            preserveAspectRatio: 'none', transform,
          })) : null;
      });
    };
    const mkBox = (b, entry) => {
      const isActive = entry.isActive;
      const projected = b.corners.map((p) => proj(p, view));
      const pts = pstr(projected);
      if (b.masked && disp.maskStyle === 'cutout' && !(isActive && cabinet)) return h('polygon', { key: entry.id + b.key, className: 'gw-box gw-box--cut' + (isActive ? '' : ' gw-box--dim'), points: pts, onMouseDown: (e) => onBoxDown(b, entry, e), onMouseEnter: () => paintEnter(b, entry) });
      let fill = '#45464a';
      if (disp.provenance && b.prov) fill = PROV[b.prov].color;
      if (b.masked) fill = 'rgba(120,124,134,0.28)';
      let cls = 'gw-box' + (b.masked ? ' gw-box--masked' : '') + (isActive ? '' : ' gw-box--dim');
      if (isActive && (b.key === selKey || (multiKeys && multiKeys.has(b.key)))) cls += ' is-sel';
      const pattern = patternForBox(b, entry, projected);
      return h('g', { key: entry.id + b.key },
        h('polygon', { className: cls, points: pts, style: { fill }, onMouseDown: (e) => onBoxDown(b, entry, e), onMouseEnter: () => paintEnter(b, entry), title: entry.id + ' V' + String(b.c + 1).padStart(2, '0') + '_R' + String(b.r + 1).padStart(2, '0') }),
        pattern,
        pattern ? h('polygon', { className: cls, points: pts, style: { fill: 'none', pointerEvents: 'none' } }) : null);
    };

    let allBoxes = [];
    sbuilt.forEach((entry) => entry.g.boxes.forEach((b) => allBoxes.push({ b, entry })));
    const cameraDepth = (b) => { const p = boxCenter(b); return p.x * cameraToViewer.x + p.y * cameraToViewer.y + p.z * cameraToViewer.z; };
    allBoxes.sort((x, y) => cameraDepth(x.b) - cameraDepth(y.b));
    const boxEls = allBoxes.map(({ b, entry }) => mkBox(b, entry));

    /* 框选命中：外层 SVG 坐标 → 反演 pan/zoom（内层 transform 以 (500,350) 为原点）
       后与激活屏各箱体的投影质心比较。 */
    marqueeFinalizeRef.current = (r) => {
      const w = Math.abs(r.cx1 - r.cx0), hgt = Math.abs(r.cy1 - r.cy0);
      if (w < 4 && hgt < 4) { s.setCalSel(null); return; } /* 视为空点击 */
      const g = innerRef.current;
      const [ax0, ay0] = toLocal(g, Math.min(r.cx0, r.cx1), Math.min(r.cy0, r.cy1));
      const [bx0, by0] = toLocal(g, Math.max(r.cx0, r.cx1), Math.max(r.cy0, r.cy1));
      const ax = Math.min(ax0, bx0), bx = Math.max(ax0, bx0), ay = Math.min(ay0, by0), by = Math.max(ay0, by0);
      const keys = [];
      if (activeEntry) activeEntry.g.boxes.forEach((b) => {
        const c = b.corners.reduce((acc, p) => { const q = proj(p, view); return [acc[0] + q[0] / 4, acc[1] + q[1] / 4]; }, [0, 0]);
        if (c[0] >= ax && c[0] <= bx && c[1] >= ay && c[1] <= by) keys.push(b.key);
      });
      if (keys.length > 1) { s.setCalSel({ type: 'cabinetMulti', keys }); s.setCalReceipt({ tone: 'ok', text: '框选 ' + keys.length + ' 个箱体' }); }
      else if (keys.length === 1) { const [c, r2] = keys[0].split(',').map(Number); s.setCalSel({ type: 'cabinet', c, r: r2 }); }
      else s.setCalSel(null);
    };

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

    const vertexMap = new Map();
    if (activeEntry) activeEntry.g.boxes.forEach((b) => {
      [[b.c, b.r, b.corners[0]], [b.c + 1, b.r, b.corners[1]], [b.c + 1, b.r + 1, b.corners[2]], [b.c, b.r + 1, b.corners[3]]]
        .forEach(([c, r, p]) => vertexMap.set(c + ',' + r, p));
    });

    /* 参考点工具：所有 seam vertex 以绿色角点呈现；O/X/Y badge 最后绘制。 */
    const refPoints = [], refMarks = [];
    const refsActive = cabinet && s.calBoxTool === 'refs' && activeEntry;
    if (refsActive) vertexMap.forEach((v, key) => {
      const [c, r] = key.split(',').map(Number), p = proj(v, view);
      refPoints.push(h('circle', { key: 'rv-' + key, cx: p[0], cy: p[1], r: 2, className: 'gw-pt gw-pt--pick' }));
      refPoints.push(h('circle', { key: 'rh-' + key, cx: p[0], cy: p[1], r: 8, fill: 'transparent', className: 'gw-pt-hit', style: { pointerEvents: 'all' }, onMouseDown: (e) => { e.stopPropagation(); }, onClick: (e) => assignReferenceVertex(c, r, e) }));
    });
    if (activeEntry && coord) Object.entries({ origin: coord.origin_point, x_axis: coord.x_axis_point, xy_plane: coord.xy_plane_point }).forEach(([role, name]) => {
      const at = parsePointName(name, activeEntry.id); if (!at) return;
      const v = vertexMap.get(at.c + ',' + at.r); if (!v) return;
      const p = proj(v, view), meta = ROLE[role];
      refMarks.push(h('g', { key: 'ref-' + role },
        h('circle', { cx: p[0], cy: p[1], r: 5.5, fill: meta.color, stroke: '#0c0c10', strokeWidth: .8 }),
        h('text', { x: p[0], y: p[1] + 2.4, fill: '#0c0c10', fontSize: 6.5, fontWeight: 800, textAnchor: 'middle' }, meta.short)));
    });

    /* 激活屏箱体外法线；镂空块始终跳过。 */
    const normals = [];
    if (disp.normals && activeEntry) {
      const masked = new Set((activeEntry.cfg.irregular_mask || []).map(([c, r]) => c + ',' + r));
      activeEntry.g.boxes.forEach((b) => {
        if (b.masked || masked.has(b.key)) return;
        const center = boxCenter(b), n = boxNormal(b, activeEntry), tip = { x: center.x + n.x * .24, y: center.y + n.y * .24, z: center.z };
        const p0 = proj(center, view), p1 = proj(tip, view), ang = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
        const hl = 4.5, hw = .5;
        const a1 = [p1[0] - hl * Math.cos(ang - hw), p1[1] - hl * Math.sin(ang - hw)];
        const a2 = [p1[0] - hl * Math.cos(ang + hw), p1[1] - hl * Math.sin(ang + hw)];
        normals.push(h('g', { key: 'normal-' + b.key, className: 'gw-normal' },
          h('line', { x1: p0[0], y1: p0[1], x2: p1[0], y2: p1[1] }),
          h('polygon', { className: 'gw-normal-h', points: pstr([p1, a1, a2]) })));
      });
    }

    /* 仅 screen selection 显示整屏橙色轮廓。 */
    const objOutline = [];
    if (activeEntry && s.calSel && s.calSel.type === 'screen') {
      const cols = activeEntry.g.cols, rows = activeEntry.g.rows, ring = [];
      for (let c = 0; c <= cols; c++) ring.push(vertexMap.get(c + ',0'));
      for (let r = 1; r <= rows; r++) ring.push(vertexMap.get(cols + ',' + r));
      for (let c = cols - 1; c >= 0; c--) ring.push(vertexMap.get(c + ',' + rows));
      for (let r = rows - 1; r > 0; r--) ring.push(vertexMap.get('0,' + r));
      objOutline.push(h('polygon', { className: 'gw-obj-outline', points: pstr(ring.filter(Boolean).map((p) => proj(p, view))) }));
    }

    const origin = proj({ x: 0, y: 0, z: 0 }, view);
    const cursor = h('g', { className: 'gw-cursor' },
      h('circle', { cx: origin[0], cy: origin[1], r: 9, fill: 'none', stroke: '#f4f4f4', strokeWidth: 1.6, strokeDasharray: '3.2 3.2' }),
      h('circle', { cx: origin[0], cy: origin[1], r: 9, fill: 'none', stroke: '#e23b2e', strokeWidth: 1.6, strokeDasharray: '3.2 3.2', strokeDashoffset: 3.2 }),
      [[-14, -6, 0], [6, 14, 1]].flatMap(([a, b, i]) => [
        h('line', { key: 'ch-' + i, x1: origin[0] + a, y1: origin[1], x2: origin[0] + b, y2: origin[1], stroke: i ? '#e23b2e' : '#f4f4f4', strokeWidth: 1.4 }),
        h('line', { key: 'cv-' + i, x1: origin[0], y1: origin[1] + a, x2: origin[0], y2: origin[1] + b, stroke: i ? '#e23b2e' : '#f4f4f4', strokeWidth: 1.4 }),
      ]));

    return h('svg', { className: 'gw-svp', ref: stageRef, viewBox: '0 0 1000 700', preserveAspectRatio: 'xMidYMid meet', onMouseDown: onBg, onContextMenu: (e) => e.preventDefault() },
      h('defs', null, patternDefs),
      /* 缩放以视口中心 (500,350) 为基准，直接烘进 translate（不依赖各引擎对 SVG
         transform-origin 的实现差异）。 */
      h('g', { ref: innerRef, transform: 'translate(' + (pan.x + 500 * (1 - zoom)) + ',' + (pan.y + 350 * (1 - zoom)) + ') scale(' + zoom + ')' },
        h('g', { className: 'gw-ground' }, ground),
        axes, ghost, boxEls, objOutline, labels, points, refPoints, normals, cursor, refMarks),
      marquee ? (function () {
        const [x0, y0] = toLocal(stageRef.current, marquee.cx0, marquee.cy0);
        const [x1, y1] = toLocal(stageRef.current, marquee.cx1, marquee.cy1);
        return h('rect', {
          x: Math.min(x0, x1), y: Math.min(y0, y1),
          width: Math.abs(x1 - x0), height: Math.abs(y1 - y0),
          fill: 'rgba(214,84,45,0.10)', stroke: 'var(--volo-500)', strokeWidth: 1, strokeDasharray: '4 3', pointerEvents: 'none',
        });
      })() : null);
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
    const [show, setShow] = useState(false);
    const timeoutRef = useRef(null);
    useEffect(() => {
      const stage = document.querySelector('.gw-stage');
      if (!stage) return undefined;
      const ping = () => {
        setShow(true);
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        timeoutRef.current = setTimeout(() => setShow(false), 1800);
      };
      const onMove = (e) => { if (e.buttons) ping(); };
      stage.addEventListener('mousedown', ping);
      stage.addEventListener('wheel', ping, { passive: true });
      window.addEventListener('mousemove', onMove);
      window.addEventListener('keydown', ping);
      return () => {
        stage.removeEventListener('mousedown', ping);
        stage.removeEventListener('wheel', ping);
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('keydown', ping);
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
      };
    }, []);
    let hint;
    if (!cabinet) hint = [['Tab', '箱体编辑'], ['左键', '旋转'], ['右键', '平移'], ['滚轮', '缩放']];
    else if (tool === 'mask') hint = [['单击/拖刷', '切换镂空'], ['Tab', '退出']];
    else if (tool === 'refs') hint = [['单击角点', '指派角色'], ['1/2/3', '切角色']];
    else hint = [['单击', '选箱体'], ['Shift', '加选'], ['Shift+拖动', '框选多选']];
    return h('div', { className: 'gw-glass gw-hint' + (show ? ' show' : '') }, hint.flatMap(([k, v], i) => [
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
            ROLE[rk].short, h('span', { className: 'num' }, i + 1),
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
    useEffect(() => { if (!s.calReceipt) return undefined; const t = setTimeout(() => s.setCalReceipt(null), s.calReceipt.tone === 'err' ? 8000 : 4200); return () => clearTimeout(t); }, [s.calReceipt]);
    if (!s.calReceipt) return null;
    const tone = s.calReceipt.tone === 'notice' ? 'notice' : s.calReceipt.tone === 'err' ? 'err' : 'ok';
    return h('div', { className: 'gw-glass gw-receipt gw-receipt--' + tone },
      h(Icon, { name: tone === 'ok' ? 'check' : 'alert', size: 13 }), s.calReceipt.text);
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
    useEffect(() => { s.setLeftCollapsed(false); }, []);
    const cabinet = s.calMode === 'cabinet';
    return h('div', { className: 'gw-center' },
      h('div', { className: 'gw-stage' },
        h(Viewport, { s }),
        cabinet ? h(BoxBar, { s }) : null,
        h('div', { className: 'gw-ov gw-ov--tl' }, h(CtxCard, { s }), h(Coords)),
        h('div', { className: 'gw-ov gw-ov--tr' }, h(DisplayToggles, { s })),
        h('div', { className: 'gw-ov gw-ov--bc' }, h(HintBar, { s }), h(VersionSwitcher, { s })),
        h('div', { className: 'gw-ov gw-ov--bl' }, h(Legend, { s })),
        h('div', { className: 'gw-ov gw-ov--br' }, h(Receipt, { s }))));
  }

  window.VOLO_GRID = Object.assign(window.VOLO_GRID || {}, { Center, center: (s) => h(Center, { s }), ROLE, PROV, pointName, roleAtCabinet, buildNominalBoxes, buildRealBoxes });
})();
