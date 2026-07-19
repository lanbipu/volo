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
   - 渲染/交互底层在 gridScene.tsx：Blender 视口模型（转台轨道、缩放到光标、
     轴向 gizmo、无限地面网格）+ three.js GPU 管线；本文件持有业务几何与叠加层。 */
import * as React from "react";
import * as THREE from "three";
import { computeRebuiltAlignment, saveProjectYaml } from "../api/meshCommands";
import { generatedPatternImagePath, readGeneratedPatternAsDataUrl } from "../api/meshVisualCommands";
import { CameraRig, SceneCanvas, pickBoxAt } from "./gridScene";

(function () {
  const { useState, useRef, useEffect, useMemo, useCallback, useSyncExternalStore } = React;
  const h = React.createElement;
  const CX = window.VOLO_CAL2;
  const Icon = window.Icon;

  const ROLE = {
    origin: { short: 'O', label: 'origin', color: '#f5c542' },
    x_axis: { short: 'X', label: 'x_axis', color: '#ff5a4d' },
    xy_plane: { short: 'Y', label: 'xy_plane', color: '#3ddc84' },
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
  /** 在候选屏列表中解析点名，返回 { screenId, c, r }；跨屏 O/X/Y 用。 */
  function resolvePointName(name, screenIds) {
    if (!name || !screenIds) return null;
    for (let i = 0; i < screenIds.length; i++) {
      const sid = screenIds[i];
      const at = parsePointName(name, sid);
      if (at) return { screenId: sid, c: at.c, r: at.r };
    }
    return null;
  }

  /* ---------- 相机 rig（模块级单例：跨挂载保留视角，同旧版模块级 ORBIT 约定） ---------- */
  const RIG = new CameraRig();
  const SCENE_STORE = { pickMeshes: [], setHover: () => {}, invalidate: () => {} };

  /* 世界轴色：地面轴端 / gizmo 共用（显示 Z = 世界 Y） */
  const WORLD_AXIS = { x: '#c74436', y: '#3f74c4' };
  const GIZMO_AXES = [
    { dir: [1, 0, 0], col: WORLD_AXIS.x, label: 'X' },
    { dir: [-1, 0, 0], col: WORLD_AXIS.x, label: null },
    { dir: [0, 0, 1], col: '#3f9c46', label: 'Y' },   /* 显示 Y（向上）= 世界 Z */
    { dir: [0, 0, -1], col: '#3f9c46', label: null },
    { dir: [0, 1, 0], col: WORLD_AXIS.y, label: 'Z' },   /* 显示 Z（深度）= 世界 Y */
    { dir: [0, -1, 0], col: WORLD_AXIS.y, label: null },
  ];

  /** Overlay / NavGizmo：相机变化经 rAF 节流触发重渲 */
  function useRigTick() {
    const [, setTick] = useState(0);
    useEffect(() => {
      let raf = null;
      const off = RIG.onChange(() => {
        if (raf != null) return;
        raf = requestAnimationFrame(() => { raf = null; setTick((t) => t + 1); });
      });
      return () => { off(); if (raf != null) cancelAnimationFrame(raf); };
    }, []);
  }

  const pstr = (pts) => pts.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
  const boxCenter = (b) => b.corners.reduce((p, q) => ({ x: p.x + q.x / 4, y: p.y + q.y / 4, z: p.z + q.z / 4 }), { x: 0, y: 0, z: 0 });
  /** 箱体出光面法线（面内水平，含 normal_flip）。约定：模型系 +Y = 深度轴（入墙，
   *  与重建对齐 m01 一致），出光面 = −Y = 列方向顺时针 90°。 */
  const boxNormalOf = (b, cfg) => {
    const dx = b.corners[1].x - b.corners[0].x, dy = b.corners[1].y - b.corners[0].y;
    const len = Math.hypot(dx, dy) || 1, sign = cfg && cfg.normal_flip ? -1 : 1;
    return { x: sign * dy / len, y: sign * -dx / len, z: 0 };
  };

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

  function applyScreenTransform(p, m) {
    const pos = m.position_m || [0, 0, 0];
    const yawRad = ((m.yaw_deg || 0) * Math.PI) / 180;
    const cy = Math.cos(yawRad), sy = Math.sin(yawRad);
    return {
      x: p.x * cy + p.y * sy + (pos[0] || 0),
      y: -p.x * sy + p.y * cy + (pos[1] || 0),
      z: p.z + (pos[2] || 0) + (m.height_offset_mm || 0) / 1000,
    };
  }

  /** 行主序 SE(3)：p' = R·p + t（屏间 SE3 / rebuilt_alignment 共用）。 */
  function applyRowMajorRigid(p, R, t) {
    const t0 = (t && t[0]) || 0, t1 = (t && t[1]) || 0, t2 = (t && t[2]) || 0;
    return {
      x: R[0][0] * p.x + R[0][1] * p.y + R[0][2] * p.z + t0,
      y: R[1][0] * p.x + R[1][1] * p.y + R[1][2] * p.z + t1,
      z: R[2][0] * p.x + R[2][1] * p.y + R[2][2] * p.z + t2,
    };
  }
  function applyAlignmentTransform(p, A) {
    if (!A || !A.rotation) return p;
    return applyRowMajorRigid(p, A.rotation, A.t_m);
  }

  /**
   * 从 visualSession.screenTransforms 建屏→SE3 表。
   * null = 尚未加载；{} / 有成员 = 已加载。membershipOnly 时只记 screen_id（组判定用）。
   */
  function se3ByScreenFromFile(xfFile, membershipOnly) {
    if (!xfFile) return null;
    const out = {};
    (xfFile.transforms || []).forEach((t) => {
      if (!t.R) return;
      if (membershipOnly) {
        out[t.screen_id] = true;
      } else {
        out[t.screen_id] = {
          R: t.R,
          tM: [(t.t_mm[0] || 0) / 1000, (t.t_mm[1] || 0) / 1000, (t.t_mm[2] || 0) / 1000],
        };
      }
    });
    return out;
  }

  function boxesVertexMap(boxes) {
    const vmap = new Map();
    (boxes || []).forEach((b) => {
      [[b.c, b.r, b.corners[0]], [b.c + 1, b.r, b.corners[1]], [b.c + 1, b.r + 1, b.corners[2]], [b.c, b.r + 1, b.corners[3]]]
        .forEach(([c, r, p]) => vmap.set(c + ',' + r, p));
    });
    return vmap;
  }

  /**
   * 联合重建组成员：
   * 1. se3ByScreen 有 ≥2 成员且含本屏 → 该联合组
   * 2. se3ByScreen 已加载（非 null）但本屏不在其中 / 仅 1 成员 → 单屏组（不回退 yaml）
   * 3. se3ByScreen === null（尚未加载）→ 才回退 yaml persisted 多屏组（恢复跨屏点选）
   */
  function alignmentGroupScreenIds(screenId, se3ByScreen, config) {
    if (se3ByScreen != null) {
      const members = Object.keys(se3ByScreen);
      if (members.length >= 2 && members.indexOf(screenId) >= 0) return members.slice();
      return [screenId];
    }
    const persisted = alignmentForScreen(config, screenId);
    if (persisted && persisted.screens && persisted.screens.length >= 2) {
      return persisted.screens.slice();
    }
    return [screenId];
  }

  /** 两组 alignment 的 rotation/t_m 是否在容差内一致。 */
  function alignmentApproxEq(a, b, tol) {
    const t = tol == null ? 1e-9 : tol;
    if (!a && !b) return true;
    if (!a || !b) return false;
    const ta = a.t_m || [0, 0, 0], tb = b.t_m || [0, 0, 0];
    for (let i = 0; i < 3; i++) if (Math.abs(ta[i] - tb[i]) > t) return false;
    const ra = a.rotation, rb = b.rotation;
    if (!ra || !rb) return false;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      if (Math.abs(ra[i][j] - rb[i][j]) > t) return false;
    }
    return true;
  }

  /** 组内各屏现有 alignment 是否一致；不一致时不可直接应用（需先复位）。 */
  function groupAlignmentsConsistent(screenIds, config) {
    let baseline = undefined;
    for (let i = 0; i < screenIds.length; i++) {
      const e = alignmentForScreen(config, screenIds[i]);
      if (baseline === undefined) { baseline = e; continue; }
      if (!alignmentApproxEq(baseline, e)) return false;
    }
    return true;
  }

  /** 查屏所属 rebuilt_alignment 组（同一屏至多一组）。 */
  function alignmentForScreen(config, screenId) {
    const groups = config && config.rebuilt_alignment && config.rebuilt_alignment.groups;
    if (!groups) return null;
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      if (g.screens && g.screens.indexOf(screenId) >= 0) return g;
    }
    return null;
  }

  /** 项目相对路径（写 yaml solve_ref）；已是相对则原样。 */
  function relUnderProject(projectPath, absOrRel) {
    if (!absOrRel || !projectPath) return absOrRel || null;
    const root = String(projectPath).replace(/[\\/]+$/, '');
    const p = String(absOrRel);
    const norm = (s) => s.replace(/\\/g, '/');
    const nr = norm(root), np = norm(p);
    if (np.toLowerCase().startsWith(nr.toLowerCase() + '/')) return np.slice(nr.length + 1);
    if (np.toLowerCase() === nr.toLowerCase()) return '';
    if (!/^[A-Za-z]:[\\/]/.test(p) && !p.startsWith('/')) return p.replace(/^[\\/]+/, '');
    return p;
  }

  /** solve_ref 与当前 visualSession 路径不一致 → 对齐过期。 */
  function alignmentIsStale(group, proj_) {
    if (!group || !group.solve_ref) return false;
    const cur = proj_.visualSession && proj_.visualSession.screenTransformsPath;
    if (!cur) return false;
    const a = relUnderProject(proj_.path, group.solve_ref);
    const b = relUnderProject(proj_.path, cur);
    return !!(a && b && a.replace(/\\/g, '/') !== b.replace(/\\/g, '/'));
  }

  /** 从联合组 entries 的 vmap 取参考点世界坐标（已含 A∘B）。 */
  function refWorldFromEntries(entries, resolved) {
    if (!resolved || !entries) return null;
    const entry = entries.find((x) => x.id === resolved.screenId);
    if (!entry || !entry.vmap) return null;
    return entry.vmap.get(resolved.c + ',' + resolved.r) || null;
  }

  function xyzTuple(p) {
    return p ? [p.x, p.y, p.z] : null;
  }

  /* ---------- 已重建几何：读真实 ReconstructedSurface ---------- */
  function buildRealBoxes(surface, m, se3, alignment) {
    const cols = surface.topology.cols, rows = surface.topology.rows;
    const verts = surface.vertices;
    const prov = surface.vertex_provenance || [];
    const vi = (c, r) => r * (cols + 1) + c;
    const at = (c, r) => {
      const v = verts[vi(c, r)];
      const local = { x: v[0], y: v[1], z: v[2] };
      const placed = (se3 && se3.R && se3.tM)
        ? applyRowMajorRigid(local, se3.R, se3.tM)
        : applyScreenTransform(local, m);
      return applyAlignmentTransform(placed, alignment);
    };
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

  /* 当前选中的屏幕 id 列表（单选 / 多选）；无屏幕选中时返回 [] */
  function selectedScreenIds(s) {
    const cur = s.calSel;
    if (cur && cur.type === 'screenMulti') return (cur.ids || []).slice();
    if (cur && cur.type === 'screen' && s.calActiveScreen) return [s.calActiveScreen];
    return [];
  }

  /* 屏幕多选：Ctrl/Cmd 点击切换（场景树 / 视口 / 检查器预设列表共用） */
  function toggleScreenSel(s, id) {
    const cur = s.calSel;
    let base = cur && cur.type === 'screenMulti' ? (cur.ids || []).slice() : [s.calActiveScreen];
    base = base.filter(Boolean);
    const i = base.indexOf(id);
    if (i >= 0) base.splice(i, 1); else base.push(id);
    s.setCalMode('object');
    if (base.length === 0) { s.setCalSel(null); return; }
    if (base.length === 1) { s.setCalActiveScreen(base[0]); s.setCalDraftScreen(null); s.setCalSel({ type: 'screen' }); return; }
    if (!base.includes(s.calActiveScreen)) s.setCalActiveScreen(id);
    s.setCalSel({ type: 'screenMulti', ids: base });
  }

  /* ---------- 视口（three.js Canvas + SVG 叠加层） ---------- */

  function Viewport({ s }) {
    const proj_ = CX.useProj();
    const disp = s.calDisplay;
    const cabinet = s.calMode === 'cabinet';
    const [marquee, setMarquee] = useState(null); /* {cx0,cy0,cx1,cy1} client 坐标 */
    const hostRef = useRef(null);
    const panDragRef = useRef(null);
    const orbitDragRef = useRef(null);
    const marqueeRef = useRef(null);
    const marqueeFinalizeRef = useRef(null);
    const paintRef = useRef(null); /* { to: boolean, last: key } */
    const paintMoveRef = useRef(null);
    const hoverRafRef = useRef(null);
    const bboxRef = useRef(null);
    const prevPreviewRef = useRef(false);
    /* 背景左键按下 → 延迟到松开才判定「取消选中」：期间若拖动（旋转视图）则不取消 */
    const bgDownRef = useRef(null);
    const patternByScreen = proj_.patternGenByScreen || {};
    const patternPathKey = Object.keys(patternByScreen).sort()
      .map((id) => id + '=' + ((patternByScreen[id] && patternByScreen[id].output_dir) || '')).join('|');
    const [patternImages, setPatternImages] = useState({}); /* { [screenId]: { path, dataUrl } } */
    const patternImagesRef = useRef({});

    useEffect(() => { patternImagesRef.current = patternImages; }, [patternImages]);

    /* 轴向预览刚出现时配一条非阻塞 Receipt（与 handoff 一致）。 */
    useEffect(() => {
      const cfg = proj_.config;
      if (!cfg) { prevPreviewRef.current = false; return; }
      const cab = s.calMode === 'cabinet' && s.calBoxTool === 'refs';
      const report = s.calScreenReports && s.calScreenReports[s.calActiveScreen];
      const ver = report ? s.calMeshVersion : 'original';
      const aligned = !!(alignmentForScreen(cfg, s.calActiveScreen) && ver !== 'original');
      const ids = Object.keys(cfg.screens || {});
      const o = resolvePointName(cfg.coordinate_system && cfg.coordinate_system.origin_point, ids);
      const x = resolvePointName(cfg.coordinate_system && cfg.coordinate_system.x_axis_point, ids);
      const y = resolvePointName(cfg.coordinate_system && cfg.coordinate_system.xy_plane_point, ids);
      const show = cab && !!report && ver !== 'original' && !aligned && !!(o && x && y);
      if (show && !prevPreviewRef.current) {
        s.setCalReceipt({ tone: 'ok', text: '预览：应用后模型将按此轴向对齐，深度轴由右手系自动推导' });
      }
      prevPreviewRef.current = show;
    }, [
      s.calMode, s.calBoxTool, s.calMeshVersion, s.calActiveScreen, s.calScreenReports,
      proj_.config && proj_.config.coordinate_system,
      proj_.config && proj_.config.rebuilt_alignment,
    ]);

    useEffect(() => {
      let active = true;
      if (!disp.pattern) { setPatternImages({}); return () => { active = false; }; }
      const ids = Object.keys(patternByScreen);
      if (!ids.length) { setPatternImages({}); return () => { active = false; }; }
      const prev = patternImagesRef.current || {};
      Promise.all(ids.map(async (id) => {
        const res = patternByScreen[id];
        const path = res && res.output_dir ? generatedPatternImagePath(res.output_dir) : null;
        if (!path) return [id, null];
        const cached = prev[id];
        if (cached && cached.path === path && cached.dataUrl) return [id, cached];
        try {
          const dataUrl = await readGeneratedPatternAsDataUrl(path);
          return [id, { path, dataUrl }];
        } catch (e) {
          s.pushLog({ lv: 'err', cat: 'calibrate', msg: `测试图预览读取失败 · ${id} · ${e && e.message ? e.message : e}` });
          return [id, null];
        }
      })).then((entries) => {
        if (!active) return;
        const next = {};
        entries.forEach(([id, img]) => { if (img) next[id] = img; });
        setPatternImages(next);
      });
      return () => { active = false; };
    }, [disp.pattern, patternPathKey]);

    /* 每块屏幕：激活屏用草稿（若有）+ 已重建版本切换；其余屏幕恒用已保存配置 + 原始网格。
       新建/叠加：P_s = A ∘ B_s（A=rebuilt_alignment，B=屏间 SE3 或名义摆放）；ghost/原始不变。
       memo 化：相机拖拽/框选期间的叠加层 tick 不触发几何重建。 */
    const built = useMemo(() => {
      if (!proj_.config) return { sbuilt: [], bbox: null, se3ByScreen: null };
      const screens = Object.keys(proj_.config.screens);
      const se3ByScreen = se3ByScreenFromFile(proj_.visualSession && proj_.visualSession.screenTransforms);
      const se3Lookup = se3ByScreen || {};
      const sbuilt = screens.map((id) => {
        const isActive = id === s.calActiveScreen;
        const cfg = (isActive && s.calDraftScreen) ? s.calDraftScreen : proj_.config.screens[id];
        const report = s.calScreenReports && s.calScreenReports[id];
        const hasBuilt = !!report;
        const version = hasBuilt ? s.calMeshVersion : 'original';
        const se3 = se3Lookup[id] || null;
        const alignment = (version === 'rebuilt' || version === 'overlay')
          ? alignmentForScreen(proj_.config, id)
          : null;
        const g = (version === 'rebuilt' || version === 'overlay')
          ? buildRealBoxes(report.surface, cfg, se3, alignment)
          : buildNominalBoxes(cfg);
        const ghost = version === 'overlay' ? buildNominalBoxes(cfg) : null;
        return { id, cfg, isActive, g, ghost, built: hasBuilt, version, vmap: boxesVertexMap(g.boxes) };
      });
      let bboxMin = null, bboxMax = null;
      sbuilt.forEach((entry) => entry.g.boxes.forEach((b) => b.corners.forEach((p) => {
        if (!bboxMin) { bboxMin = { x: p.x, y: p.y, z: p.z }; bboxMax = { x: p.x, y: p.y, z: p.z }; }
        else {
          bboxMin.x = Math.min(bboxMin.x, p.x); bboxMin.y = Math.min(bboxMin.y, p.y); bboxMin.z = Math.min(bboxMin.z, p.z);
          bboxMax.x = Math.max(bboxMax.x, p.x); bboxMax.y = Math.max(bboxMax.y, p.y); bboxMax.z = Math.max(bboxMax.z, p.z);
        }
      })));
      return { sbuilt, bbox: bboxMin ? { min: bboxMin, max: bboxMax } : null, se3ByScreen };
    }, [
      proj_.config, proj_.visualSession, s.calDraftScreen, s.calScreenReports,
      s.calMeshVersion, s.calActiveScreen,
    ]);
    const sbuilt = built.sbuilt;

    /* 自动取景：用户手动操作前跟随内容包围盒（旧 fitZoom 语义）。 */
    useEffect(() => {
      bboxRef.current = built.bbox;
      if (!RIG.touched && built.bbox) RIG.fit(built.bbox.min, built.bbox.max);
    }, [built]);

    const reset = useCallback(() => {
      RIG.touched = false;
      RIG.ortho = false;
      RIG.setAzEl(30, 22);
      if (bboxRef.current) RIG.fit(bboxRef.current.min, bboxRef.current.max); else RIG.apply();
    }, []);
    useEffect(() => {
      const onReset = () => reset();
      const onFocus = () => RIG.smoothTo({ dist: Math.max(0.05, RIG.dist * 0.7) });
      window.addEventListener('volo-gw-reset', onReset);
      window.addEventListener('volo-gw-focus', onFocus);
      return () => { window.removeEventListener('volo-gw-reset', onReset); window.removeEventListener('volo-gw-focus', onFocus); };
    }, [reset]);

    /* 滚轮：Blender ×1.2/格 + 缩放到光标。 */
    useEffect(() => {
      const el = hostRef.current; if (!el) return undefined;
      const onWheel = (e) => {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const ndc = {
          x: ((e.clientX - rect.left) / rect.width) * 2 - 1,
          y: -(((e.clientY - rect.top) / rect.height) * 2 - 1),
        };
        RIG.zoomStep(e.deltaY > 0 ? 1 : -1, ndc);
      };
      el.addEventListener('wheel', onWheel, { passive: false });
      return () => el.removeEventListener('wheel', onWheel);
    }, []);

    /* 全局拖拽：框选 → 轨道 → 平移 → 遮罩拖刷（增量喂给 rig，即时生效无插值）。 */
    useEffect(() => {
      const move = (e) => {
        if (bgDownRef.current && (Math.abs(e.clientX - bgDownRef.current.x) > 3 || Math.abs(e.clientY - bgDownRef.current.y) > 3))
          bgDownRef.current.moved = true;
        if (marqueeRef.current) { marqueeRef.current = Object.assign({}, marqueeRef.current, { cx1: e.clientX, cy1: e.clientY }); setMarquee(marqueeRef.current); return; }
        if (orbitDragRef.current) { const o = orbitDragRef.current; RIG.orbit(e.clientX - o.x, e.clientY - o.y); o.x = e.clientX; o.y = e.clientY; return; }
        if (panDragRef.current) { const o = panDragRef.current; RIG.pan(e.clientX - o.x, e.clientY - o.y); o.x = e.clientX; o.y = e.clientY; return; }
        if (paintRef.current && paintMoveRef.current) paintMoveRef.current(e);
      };
      const up = () => {
        if (marqueeRef.current) { const r = marqueeRef.current; marqueeRef.current = null; setMarquee(null); if (marqueeFinalizeRef.current) marqueeFinalizeRef.current(r); }
        paintRef.current = null;
        panDragRef.current = null;
        orbitDragRef.current = null;
        /* 松开鼠标才生效：仅当是「未拖动的背景左键单击」时才取消选中 */
        if (bgDownRef.current) {
          if (bgDownRef.current.canDeselect && !bgDownRef.current.moved) s.setCalSel(null);
          bgDownRef.current = null;
        }
      };
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
      return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    }, []);

    const selKey = s.calSel && s.calSel.type === 'cabinet' ? s.calSel.c + ',' + s.calSel.r : null;
    const multiKeys = s.calSel && s.calSel.type === 'cabinetMulti' ? new Set(s.calSel.keys || []) : null;

    /* three 场景数据（与业务 sbuilt 解耦的纯渲染描述）。必须在 early return 之前（Hooks 顺序）。 */
    const [selColor] = useState(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--volo-500').trim() || 'rgb(224,70,38)');
    const camSnap = useSyncExternalStore(
      (window.camStore && window.camStore.subscribe) || (() => () => {}),
      () => (window.camStore ? window.camStore.get() : { cameras: [], selectedId: null }),
    );
    const sceneCams = useMemo(
      () => (window.camStore ? window.camStore.sceneCameras() : []),
      [camSnap],
    );
    const sceneData = useMemo(() => ({
      entries: sbuilt.map((entry) => {
        const ppc = entry.cfg.pixels_per_cabinet;
        const img = patternImages[entry.id];
        const provByKey = disp.provenance
          ? entry.g.boxes.reduce((acc, b) => { if (b.prov) acc[b.key] = PROV[b.prov].color; return acc; }, {})
          : null;
        return {
          id: entry.id,
          isActive: entry.isActive,
          boxes: entry.g.boxes,
          ghostBoxes: entry.ghost ? entry.ghost.boxes : null,
          provByKey,
          cutout: disp.maskStyle === 'cutout' && !(entry.isActive && cabinet),
          patternUrl: (disp.pattern && img && ppc && ppc[0] && ppc[1]) ? img.dataUrl : null,
          normalSign: entry.cfg.normal_flip ? -1 : 1,
          selKeys: entry.isActive
            ? (multiKeys ? [...multiKeys] : (selKey ? [selKey] : []))
            : [],
        };
      }),
      showGround: !!disp.ground,
      selColor,
      cameras: sceneCams,
    }), [sbuilt, patternImages, disp.pattern, disp.provenance, disp.maskStyle, disp.ground, cabinet, s.calSel, selColor, sceneCams]);

    if (!proj_.config) return h('div', { className: 'gw-svp', ref: hostRef });

    const activeEntry = sbuilt.find((x) => x.isActive) || sbuilt[0];
    const m = activeEntry ? activeEntry.cfg : null;

    const setBoxMask = (b, to) => {
      const cur = s.calDraftScreen || m;
      const set = new Set((cur.irregular_mask || []).map(([c, r]) => c + ',' + r));
      if (to == null) set.has(b.key) ? set.delete(b.key) : set.add(b.key);
      else if (to) set.add(b.key); else set.delete(b.key);
      s.setCalDraftScreen(Object.assign({}, cur, { irregular_mask: [...set].map((k) => k.split(',').map(Number)) }));
      return set.has(b.key);
    };
    const clickBox = (b, e) => {
      if (!cabinet) { s.setCalSel({ type: 'screen' }); return; }
      const tool = s.calBoxTool;
      if (tool === 'mask') {
        if (m.shape_mode !== 'irregular') { s.setCalReceipt({ tone: 'notice', text: '矩形屏不支持遮罩，仅异形屏可镂空' }); return; }
        const nowMasked = setBoxMask(b, null);
        paintRef.current = { to: nowMasked, last: b.key };
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

    /* 遮罩拖刷（raycast 版）：拖动划过的箱体统一设为首格新状态。 */
    paintMoveRef.current = (e) => {
      const host = hostRef.current;
      if (!host || !paintRef.current) return;
      if (!cabinet || s.calBoxTool !== 'mask' || !m || m.shape_mode !== 'irregular') return;
      const hit = pickBoxAt(RIG, SCENE_STORE, host.getBoundingClientRect(), e.clientX, e.clientY);
      if (!hit || !activeEntry || hit.entryId !== activeEntry.id) return;
      if (hit.box.key === paintRef.current.last) return;
      paintRef.current.last = hit.box.key;
      setBoxMask(hit.box, paintRef.current.to);
    };

    const startPan = (e) => { RIG.cancelAnim(); RIG.touched = true; panDragRef.current = { x: e.clientX, y: e.clientY }; };
    const startOrbit = (e) => { RIG.cancelAnim(); RIG.touched = true; orbitDragRef.current = { x: e.clientX, y: e.clientY }; };

    const onHostDown = (e) => {
      const host = hostRef.current; if (!host) return;
      if (e.button === 2) { startPan(e); return; }
      if (e.button !== 0) return;
      const hit = pickBoxAt(RIG, SCENE_STORE, host.getBoundingClientRect(), e.clientX, e.clientY);
      if (hit) {
        const entry = sbuilt.find((x) => x.id === hit.entryId);
        if (!entry) return;
        if (!cabinet || s.calBoxTool === 'select') startOrbit(e);
        if (e.ctrlKey || e.metaKey) { toggleScreenSel(s, entry.id); return; }
        if (entry.isActive) { clickBox(hit.box, e); return; }
        s.setCalActiveScreen(entry.id); s.setCalDraftScreen(null); s.setCalMode('object'); s.setCalSel({ type: 'screen' });
        return;
      }
      /* 箱体模式·选择工具：Shift+左拖 = 框选多选；纯左拖恒为轨道旋转（传统 DCC 习惯）。 */
      if (cabinet && s.calBoxTool === 'select' && e.shiftKey) {
        marqueeRef.current = { cx0: e.clientX, cy0: e.clientY, cx1: e.clientX, cy1: e.clientY };
        setMarquee(marqueeRef.current);
        return;
      }
      /* 取消选中推迟到 mouseup：长按左键旋转视图不再取消选中 */
      bgDownRef.current = { x: e.clientX, y: e.clientY, moved: false, canDeselect: !cabinet };
      startOrbit(e);
    };

    /* hover 高亮 + 箱体点名 tooltip（rAF 节流 raycast；拖拽期间关闭）。 */
    const onHostMove = (e) => {
      if (hoverRafRef.current != null) return;
      const cx = e.clientX, cyv = e.clientY;
      hoverRafRef.current = requestAnimationFrame(() => {
        hoverRafRef.current = null;
        const host = hostRef.current; if (!host) return;
        if (orbitDragRef.current || panDragRef.current || marqueeRef.current || paintRef.current) { SCENE_STORE.setHover(null); return; }
        const hit = pickBoxAt(RIG, SCENE_STORE, host.getBoundingClientRect(), cx, cyv);
        SCENE_STORE.setHover(hit);
        host.title = hit
          ? hit.entryId + ' V' + String(hit.box.c + 1).padStart(2, '0') + '_R' + String(hit.box.r + 1).padStart(2, '0')
          : '';
      });
    };
    const onHostLeave = () => { SCENE_STORE.setHover(null); };

    /* 框选命中：client → 视口像素，与激活屏各箱体的投影质心比较。 */
    marqueeFinalizeRef.current = (r) => {
      const host = hostRef.current; if (!host) return;
      const w = Math.abs(r.cx1 - r.cx0), hgt = Math.abs(r.cy1 - r.cy0);
      if (w < 4 && hgt < 4) { s.setCalSel(null); return; } /* 视为空点击 */
      const rect = host.getBoundingClientRect();
      const ax = Math.min(r.cx0, r.cx1) - rect.left, bx = Math.max(r.cx0, r.cx1) - rect.left;
      const ay = Math.min(r.cy0, r.cy1) - rect.top, by = Math.max(r.cy0, r.cy1) - rect.top;
      const keys = [];
      if (activeEntry) activeEntry.g.boxes.forEach((b) => {
        const q = RIG.project(boxCenter(b));
        if (q && q[0] >= ax && q[0] <= bx && q[1] >= ay && q[1] <= by) keys.push(b.key);
      });
      if (keys.length > 1) { s.setCalSel({ type: 'cabinetMulti', keys }); s.setCalReceipt({ tone: 'ok', text: '框选 ' + keys.length + ' 个箱体' }); }
      else if (keys.length === 1) { const [c, r2] = keys[0].split(',').map(Number); s.setCalSel({ type: 'cabinet', c, r: r2 }); }
      else s.setCalSel(null);
    };

    return h('div', {
      className: 'gw-svp', ref: hostRef,
      onMouseDown: onHostDown, onMouseMove: onHostMove, onMouseLeave: onHostLeave,
      onContextMenu: (e) => e.preventDefault(),
      style: { overflow: 'hidden' },
    },
      h(SceneCanvas, { rig: RIG, data: sceneData, store: SCENE_STORE }),
      h(OverlayLayer, { s, proj_, sbuilt, se3ByScreen: built.se3ByScreen, cabinet, disp, marquee, hostRef }));
  }

  /* ---------- SVG 叠加层：世界锚定的标注（点/参考点/法线/轮廓/预览轴/标签/框选） ----------
     相机每帧变化经 rAF 节流只重渲本层（元素量小），三维场景与业务树不动。 */
  function OverlayLayer({ s, proj_, sbuilt, se3ByScreen, cabinet, disp, marquee, hostRef }) {
    useRigTick();
    const W = Math.max(1, RIG.width), H = Math.max(1, RIG.height);
    const P = (p) => RIG.project(p);

    const activeEntry = sbuilt.find((x) => x.isActive) || sbuilt[0];
    const coord = proj_.config && proj_.config.coordinate_system;
    const screenIds = sbuilt.map((x) => x.id);

    const assignReferenceVertex = (screenId, c, r, e) => {
      e.stopPropagation();
      const role = s.calRefRole;
      const name = pointName(screenId, c, r);
      const entry = sbuilt.find((x) => x.id === screenId);
      const screenCfg = entry ? entry.cfg : (proj_.config.screens[screenId] || (activeEntry && activeEntry.cfg));
      const nextCoord = Object.assign({}, coord, { [role + '_point']: name });
      const nextScreens = role === 'origin'
        ? Object.assign({}, proj_.config.screens, { [screenId]: Object.assign({}, screenCfg, { origin_aligned: false }) })
        : proj_.config.screens;
      const nextConfig = Object.assign({}, proj_.config, { screens: nextScreens, coordinate_system: nextCoord });
      s.runCmd({ domain: 'calibrate', action: '指派参考点', target: name, chan: 'local' },
        () => saveProjectYaml(proj_.path, nextConfig),
        { okMsg: () => `已指派 ${ROLE[role].label} → ${name}` })
        .then(() => CX.openProjectPath(proj_.path, s))
        .catch((err) => {
          const msg = err && err.message ? err.message : String(err);
          s.setCalReceipt({ tone: 'err', text: '指派参考点失败 · ' + msg });
        });
    };

    /* 轴端 X/Z 标记：屏幕空间渲染、贴边钳制（轴线本体在网格 shader 里） */
    const axisLabels = [];
    if (disp.ground) {
      const AG = 8, M = 16;
      /* preferRight：X 贴屏幕右侧端；否则 Z 贴上方端；再钳 16px */
      /* 标签固定钉在世界正向端（+X / +Y）随场景一起转，端点转到相机背后时隐藏。
         旧逻辑按「哪端在屏幕更靠右/靠上」动态选端，自由旋转时两端不断易主 → 标签跳动。 */
      const mkAxisLabel = (end, col, lbl) => {
        const t0 = P({ x: end.x * 1.07, y: end.y * 1.07, z: 0 });
        if (!t0) return;
        const t = [Math.max(M, Math.min(W - M, t0[0])), Math.max(M, Math.min(H - M, t0[1]))];
        axisLabels.push(h('text', { key: 'axl' + lbl, x: t[0], y: t[1], fill: col, fontSize: 15, fontWeight: 700, textAnchor: 'middle', dominantBaseline: 'central', style: { fontFamily: 'ui-monospace, monospace', userSelect: 'none' } }, lbl));
      };
      mkAxisLabel({ x: AG, y: 0 }, WORLD_AXIS.x, 'X');
      mkAxisLabel({ x: 0, y: AG }, WORLD_AXIS.y, 'Z');
    }

    const labels = sbuilt.length > 1 ? sbuilt.map((entry) => {
      const g = entry.g;
      const midCorner = g.boxes.length ? g.boxes[Math.floor(g.boxes.length / 2)].corners[3] : { x: 0, y: 0, z: 0 };
      const p = P({ x: midCorner.x, y: midCorner.y, z: midCorner.z + 0.28 });
      if (!p) return null;
      return h('text', { key: 'lb' + entry.id, x: p[0], y: p[1], textAnchor: 'middle', className: 'gw-wall-lb' + (entry.isActive ? ' on' : '') }, entry.id);
    }) : null;

    /* 测量点（仅激活屏，读 proj.measured；见 gridTree.tsx 的全站仪流写入） */
    const points = [];
    if (disp.points && proj_.measured && proj_.measured.points && activeEntry) {
      const seen = new Set();
      proj_.measured.points.forEach((pt) => {
        if (!pt.name.startsWith(s.calActiveScreen + '_V')) return;
        const p = P({ x: pt.position[0], y: pt.position[1], z: pt.position[2] });
        if (!p) return;
        const outlier = pt.uncertainty && 'isotropic' in pt.uncertainty && pt.uncertainty.isotropic > 5;
        points.push(h('circle', { key: 'p' + pt.name, cx: p[0], cy: p[1], r: outlier ? 3.4 : 2.4, className: 'gw-pt' + (outlier ? ' gw-pt--out' : '') }));
        if (disp.pointLabels && !seen.has(pt.name)) { seen.add(pt.name); points.push(h('text', { key: 'pl' + pt.name, x: p[0] + 5, y: p[1] - 4, className: 'gw-pt-lb' }, pt.name)); }
      });
    }

    /* 参考点工具：联合组内所有屏 seam 可点；badge 用 sbuilt[].vmap + resolvePointName。 */
    const refPoints = [], refMarks = [];
    const groupIds = activeEntry
      ? alignmentGroupScreenIds(activeEntry.id, se3ByScreen, proj_.config)
      : [];
    const groupEntries = sbuilt.filter((x) => groupIds.indexOf(x.id) >= 0);
    const refsActive = cabinet && s.calBoxTool === 'refs' && groupEntries.length > 0;
    if (refsActive) groupEntries.forEach((entry) => {
      entry.vmap.forEach((v, key) => {
        const [c, r] = key.split(',').map(Number), p = P(v);
        if (!p) return;
        const hitKey = entry.id + ':' + key;
        refPoints.push(h('circle', { key: 'rv-' + hitKey, cx: p[0], cy: p[1], r: 2, className: 'gw-pt gw-pt--pick' }));
        refPoints.push(h('circle', { key: 'rh-' + hitKey, cx: p[0], cy: p[1], r: 8, fill: 'transparent', className: 'gw-pt-hit', style: { pointerEvents: 'all' }, onMouseDown: (e) => { e.stopPropagation(); }, onClick: (e) => assignReferenceVertex(entry.id, c, r, e) }));
      });
    });
    if (coord) {
      Object.entries({ origin: coord.origin_point, x_axis: coord.x_axis_point, xy_plane: coord.xy_plane_point }).forEach(([role, name]) => {
        const at = resolvePointName(name, screenIds);
        if (!at) return;
        const entry = sbuilt.find((x) => x.id === at.screenId);
        const v = entry && entry.vmap.get(at.c + ',' + at.r);
        if (!v) return;
        const p = P(v);
        if (!p) return;
        const meta = ROLE[role];
        refMarks.push(h('g', { key: 'ref-' + role + '-' + at.screenId },
          h('circle', { cx: p[0], cy: p[1], r: 5.5, fill: meta.color, stroke: '#0c0c10', strokeWidth: .8 }),
          h('text', { x: p[0], y: p[1] + 2.4, fill: '#0c0c10', fontSize: 6.5, fontWeight: 800, textAnchor: 'middle' }, meta.short)));
      });
    }

    /* 轴向预览：O/X/Y 齐备且组未对齐、新建/叠加视图时，由 O 绘推导三轴（仅视觉，不写 A'）。 */
    const previewAxes = [];
    const activeBuilt = !!(activeEntry && s.calScreenReports && s.calScreenReports[activeEntry.id]);
    const versionNow = activeBuilt ? s.calMeshVersion : 'original';
    const alignGroup = activeEntry ? alignmentForScreen(proj_.config, activeEntry.id) : null;
    const alignedNow = !!(alignGroup && versionNow !== 'original');
    const oAt = coord && resolvePointName(coord.origin_point, screenIds);
    const xAt = coord && resolvePointName(coord.x_axis_point, screenIds);
    const yAt = coord && resolvePointName(coord.xy_plane_point, screenIds);
    const allThree = !!(oAt && xAt && yAt);
    const showPreview = refsActive && allThree && !alignedNow && versionNow !== 'original' && activeBuilt;
    if (showPreview) {
      const O = refWorldFromEntries(sbuilt, oAt);
      const X = refWorldFromEntries(sbuilt, xAt);
      const Y = refWorldFromEntries(sbuilt, yAt);
      if (O && X && Y) {
        const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
        const nrm = (v) => { const l = Math.hypot(v.x, v.y, v.z) || 1; return { x: v.x / l, y: v.y / l, z: v.z / l }; };
        const crs = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
        /* 深度 = dY × dX，与 from_three_points 的 z=normalize(dxy×x) → m01 后模型 +Y 一致 */
        const dX = nrm(sub(X, O)), dY = nrm(sub(Y, O)), dZ = nrm(crs(dY, dX));
        const L = 1.6;
        const arrow = (dir, col, label, k) => {
          const tip = { x: O.x + dir.x * L, y: O.y + dir.y * L, z: O.z + dir.z * L };
          const P0 = P(O), P1 = P(tip);
          if (!P0 || !P1) return;
          const ang = Math.atan2(P1[1] - P0[1], P1[0] - P0[0]);
          const hl = 7, hw = 0.42;
          const a1 = [P1[0] - hl * Math.cos(ang - hw), P1[1] - hl * Math.sin(ang - hw)];
          const a2 = [P1[0] - hl * Math.cos(ang + hw), P1[1] - hl * Math.sin(ang + hw)];
          previewAxes.push(h('g', { key: 'pv' + k, className: 'gw-pvaxis' },
            h('line', { x1: P0[0], y1: P0[1], x2: P1[0], y2: P1[1], stroke: col, strokeWidth: 1.7, strokeDasharray: '4 3', strokeLinecap: 'round' }),
            h('polygon', { points: pstr([P1, a1, a2]), fill: col }),
            h('text', { x: P1[0] + 5, y: P1[1] - 4, fill: col, fontSize: 8, fontWeight: 800 }, label)));
        };
        arrow(dX, '#e0563f', '横向 · OX', 'x');
        arrow(dY, '#49b257', '高度 · OY', 'y');
        arrow(dZ, '#4f88e0', '深度 · 推导', 'z');
      }
    }

    /* 激活屏箱体外法线；镂空块始终跳过。 */
    const normals = [];
    if (disp.normals && activeEntry) {
      const masked = new Set((activeEntry.cfg.irregular_mask || []).map(([c, r]) => c + ',' + r));
      activeEntry.g.boxes.forEach((b) => {
        if (b.masked || masked.has(b.key)) return;
        const center = boxCenter(b), n = boxNormalOf(b, activeEntry.cfg), tip = { x: center.x + n.x * .24, y: center.y + n.y * .24, z: center.z };
        const p0 = P(center), p1 = P(tip);
        if (!p0 || !p1) return;
        const ang = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
        const hl = 4.5, hw = .5;
        const a1 = [p1[0] - hl * Math.cos(ang - hw), p1[1] - hl * Math.sin(ang - hw)];
        const a2 = [p1[0] - hl * Math.cos(ang + hw), p1[1] - hl * Math.sin(ang + hw)];
        normals.push(h('g', { key: 'normal-' + b.key, className: 'gw-normal' },
          h('line', { x1: p0[0], y1: p0[1], x2: p1[0], y2: p1[1] }),
          h('polygon', { className: 'gw-normal-h', points: pstr([p1, a1, a2]) })));
      });
    }

    /* 单选 / 多选屏幕均显示橙色轮廓。 */
    const objOutline = [];
    {
      const selIds = selectedScreenIds(s);
      selIds.forEach((sid) => {
        const entry = sbuilt.find((x) => x.id === sid);
        if (!entry) return;
        const vmap = entry.vmap;
        const cols = entry.g.cols, rows = entry.g.rows, ring = [];
        for (let c = 0; c <= cols; c++) ring.push(vmap.get(c + ',0'));
        for (let r = 1; r <= rows; r++) ring.push(vmap.get(cols + ',' + r));
        for (let c = cols - 1; c >= 0; c--) ring.push(vmap.get(c + ',' + rows));
        for (let r = rows - 1; r > 0; r--) ring.push(vmap.get('0,' + r));
        const projected = ring.filter(Boolean).map((p) => P(p)).filter(Boolean);
        if (projected.length > 2) objOutline.push(h('polygon', { key: 'objol-' + sid, className: 'gw-obj-outline', points: pstr(projected) }));
      });
    }

    /* 框选矩形（client → 视口局部坐标） */
    let marqueeEl = null;
    if (marquee && hostRef.current) {
      const rect = hostRef.current.getBoundingClientRect();
      const x0 = marquee.cx0 - rect.left, y0 = marquee.cy0 - rect.top;
      const x1 = marquee.cx1 - rect.left, y1 = marquee.cy1 - rect.top;
      marqueeEl = h('rect', {
        x: Math.min(x0, x1), y: Math.min(y0, y1),
        width: Math.abs(x1 - x0), height: Math.abs(y1 - y0),
        fill: 'rgba(214,84,45,0.10)', stroke: 'var(--volo-500)', strokeWidth: 1, strokeDasharray: '4 3', pointerEvents: 'none',
      });
    }

    return h('svg', {
      className: 'gw-ovl',
      viewBox: '0 0 ' + W + ' ' + H,
      preserveAspectRatio: 'none',
      style: { position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', pointerEvents: 'none' },
    },
      objOutline, labels, points, refPoints, normals, previewAxes, refMarks, axisLabels, marqueeEl);
  }

  /* ---------- 导航 gizmo（Blender 右上角轴向球）：点轴 200ms 吸附正交视图，拖拽轨道 ---------- */
  function NavGizmo() {
    useRigTick();
    const dragRef = useRef(null);
    useEffect(() => {
      const move = (e) => {
        const d = dragRef.current; if (!d) return;
        d.moved = Math.max(d.moved, Math.abs(e.clientX - d.x0) + Math.abs(e.clientY - d.y0));
        RIG.orbit(e.clientX - d.x, e.clientY - d.y);
        d.x = e.clientX; d.y = e.clientY;
      };
      const up = () => { dragRef.current = null; };
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
      return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    }, []);

    const size = 88, c = size / 2, R = 32;
    const inv = RIG.quat.clone().invert();
    const balls = GIZMO_AXES.map((ax) => {
      const d = new THREE.Vector3(ax.dir[0], ax.dir[1], ax.dir[2]).applyQuaternion(inv);
      return { ...ax, sx: c + d.x * R, sy: c - d.y * R, z: d.z };
    }).sort((a, b) => a.z - b.z);

    const snap = (ax) => {
      const back = new THREE.Vector3(ax.dir[0], ax.dir[1], ax.dir[2]);
      /* 顶/底视图 up 取 +Y（Blender 顶视图约定：+Y 朝画面上），其余取世界 Z。 */
      const up = Math.abs(back.z) > 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
      RIG.axisView(back, up);
    };
    const onBallUp = (ax) => {
      const d = dragRef.current;
      if (!d || d.moved < 3) snap(ax);
    };

    return h('svg', {
      className: 'gw-gizmo', width: size, height: size, viewBox: '0 0 ' + size + ' ' + size,
      style: { display: 'block', cursor: 'default' },
      onMouseDown: (e) => {
        e.preventDefault(); e.stopPropagation();
        RIG.cancelAnim(); RIG.touched = true;
        dragRef.current = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, moved: 0 };
      },
    },
      h('circle', { cx: c, cy: c, r: c - 1, fill: 'rgba(20,20,26,0.35)' }),
      balls.map((b, i) => {
        const front = b.z >= -0.02;
        const op = front ? 1 : 0.45;
        return h('g', { key: 'gz' + i, style: { cursor: 'pointer' }, onMouseUp: () => onBallUp(b) },
          h('line', { x1: c, y1: c, x2: b.sx, y2: b.sy, stroke: b.col, strokeWidth: b.label ? 1.6 : 0, opacity: 0.7 * op }),
          h('circle', {
            cx: b.sx, cy: b.sy, r: b.label ? 8.5 : 6.5,
            fill: b.label ? b.col : 'rgba(20,20,26,0.55)',
            stroke: b.col, strokeWidth: b.label ? 0 : 1.4, opacity: op,
          }),
          b.label ? h('text', {
            x: b.sx, y: b.sy, fill: '#101014', fontSize: 9.5, fontWeight: 800,
            textAnchor: 'middle', dominantBaseline: 'central', style: { userSelect: 'none', pointerEvents: 'none' },
          }, b.label) : null);
      }));
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
    const proj_ = CX.useProj();
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
    else if (tool === 'refs') {
      const se3By = se3ByScreenFromFile(proj_.visualSession && proj_.visualSession.screenTransforms, true);
      const gids = alignmentGroupScreenIds(s.calActiveScreen, se3By, proj_.config);
      const joint = gids.length >= 2;
      hint = joint
        ? [['单击角点', '指派角色'], ['1/2/3', '切角色'], ['组内各屏', '均可指派']]
        : [['单击角点', '指派角色'], ['1/2/3', '切角色'], ['单独重建', '仅本屏']];
    }
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

  /* 摆放图例：解算结果生效时，说明「新建=解算摆放 / 原始=设计摆放」+ 对齐/过期态 */
  function PlacementLegend({ s }) {
    const proj_ = CX.useProj();
    const built = s.calScreenReports && s.calScreenReports[s.calActiveScreen];
    const v = s.calMeshVersion;
    if (!built || v === 'original') return null;
    const multi = proj_.config && Object.keys(proj_.config.screens || {}).length > 1;
    const overlay = v === 'overlay';
    const alignEntry = alignmentForScreen(proj_.config, s.calActiveScreen);
    const aligned = !!alignEntry;
    const translateOnly = aligned && !(alignEntry.ref_points && alignEntry.ref_points.x_axis && alignEntry.ref_points.xy_plane);
    const stale = alignmentIsStale(alignEntry, proj_);
    return h('div', { className: 'gw-glass gw-plegend' },
      h('div', { className: 'gw-plegend-h' }, h(Icon, { name: 'cube3', size: 12 }), '网格摆放'),
      h('div', { className: 'li' }, h('span', { className: 'sw solid' }), h('span', null, '新建网格 · 解算摆放')),
      overlay ? h('div', { className: 'li' }, h('span', { className: 'sw ghost' }), h('span', null, '原始网格 · 设计摆放')) : null,
      aligned ? h('div', { className: 'li align' }, h(Icon, { name: 'target', size: 12 }), h('span', null, '新建网格 · 已按参考系对齐' + (translateOnly ? '（仅平移）' : ''))) : null,
      stale ? h('div', { className: 'li stale' }, h(Icon, { name: 'alert', size: 12 }), h('span', null, '对齐来自旧解算，建议重新指派参考点')) : null,
      h('div', { className: 'note' }, overlay
        ? '两套摆放之差即为解算修正量。'
        : (multi ? '各屏已按联合解算位置摆放。' : '已按解算位置摆放。')));
  }

  function BoxBar({ s }) {
    const proj_ = CX.useProj();
    const [resetArm, setResetArm] = useState(false);
    const m = (proj_.config && proj_.config.screens[s.calActiveScreen]) || {};
    const tool = s.calBoxTool;
    const rectScreen = m.shape_mode !== 'irregular';
    const coord = proj_.config && proj_.config.coordinate_system;
    const allScreenIds = proj_.config && proj_.config.screens
      ? Object.keys(proj_.config.screens)
      : [s.calActiveScreen].filter(Boolean);
    const se3ByScreen = se3ByScreenFromFile(proj_.visualSession && proj_.visualSession.screenTransforms);
    const se3Lookup = se3ByScreen || {};
    const gids = alignmentGroupScreenIds(s.calActiveScreen, se3ByScreen, proj_.config);
    const originRef = coord && resolvePointName(coord.origin_point, allScreenIds);
    const xRef = coord && resolvePointName(coord.x_axis_point, allScreenIds);
    const yRef = coord && resolvePointName(coord.xy_plane_point, allScreenIds);
    const hasO = !!originRef;
    const full = !!(originRef && xRef && yRef);
    const built = !!(s.calScreenReports && s.calScreenReports[s.calActiveScreen]);
    const version = built ? s.calMeshVersion : 'original';
    const onOriginal = version === 'original';
    const alignEntry = alignmentForScreen(proj_.config, s.calActiveScreen);
    const aligned = !!alignEntry;
    const stale = alignmentIsStale(alignEntry, proj_);
    let aDisabled = false, aVariant = 'is-ready', aTip = '';
    if (!built) { aDisabled = true; aVariant = 'is-off'; aTip = '需先完成重建以生成新建网格'; }
    else if (onOriginal) { aDisabled = true; aVariant = 'is-off'; aTip = '参考系对齐仅作用于新建网格，请切换到新建/叠加视图'; }
    else if (!hasO) { aDisabled = true; aVariant = 'is-off'; aTip = '请先指派 origin 参考点'; }
    else if (full) { aVariant = 'is-accent'; aTip = 'O→原点 · OX 贴横向轴 · OY 贴高度轴'; }
    else { aVariant = 'is-ready'; aTip = '将 O 平移至世界原点 (0,0,0)'; }

    const applyReferenceFrame = async () => {
      if (aDisabled || !proj_.path || !proj_.config || !originRef) return;
      if (!groupAlignmentsConsistent(gids, proj_.config)) {
        s.setCalReceipt({ tone: 'notice', text: '组内存在旧对齐，请先复位再应用' });
        return;
      }
      /* 同一屏只建一次 vmap（O/X/Y 常跨 1–3 屏，避免重复 buildRealBoxes）。 */
      const vmapByScreen = new Map();
      const worldOf = (resolved) => {
        if (!resolved) return null;
        let vmap = vmapByScreen.get(resolved.screenId);
        if (!vmap) {
          const cfg = proj_.config.screens[resolved.screenId] || m;
          const report = s.calScreenReports && s.calScreenReports[resolved.screenId];
          const se3 = se3Lookup[resolved.screenId] || null;
          const alignment = (version === 'rebuilt' || version === 'overlay')
            ? alignmentForScreen(proj_.config, resolved.screenId)
            : null;
          const geometry = (report && version !== 'original')
            ? buildRealBoxes(report.surface, cfg, se3, alignment)
            : buildNominalBoxes(cfg);
          vmap = boxesVertexMap(geometry.boxes);
          vmapByScreen.set(resolved.screenId, vmap);
        }
        return vmap.get(resolved.c + ',' + resolved.r) || null;
      };
      const O = worldOf(originRef);
      if (!O) { s.setCalReceipt({ tone: 'notice', text: 'origin 参考点无效' }); return; }
      const X = full ? worldOf(xRef) : null;
      const Y = full ? worldOf(yRef) : null;
      if (full && (!X || !Y)) { s.setCalReceipt({ tone: 'notice', text: 'X/Y 参考点无效' }); return; }
      /* aOld 取 origin 点所在屏的 alignment（跨屏指派时激活屏可能无条目）。 */
      const aOldEntry = alignmentForScreen(proj_.config, originRef.screenId);
      const aOld = aOldEntry || {
        rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
        t_m: [0, 0, 0],
      };
      try {
        const result = await computeRebuiltAlignment({
          origin: xyzTuple(O),
          x_axis: full ? xyzTuple(X) : null,
          xy_plane: full ? xyzTuple(Y) : null,
          a_old_rotation: aOld.rotation,
          a_old_t_m: aOld.t_m || [0, 0, 0],
        });
        const solveAbs = proj_.visualSession && proj_.visualSession.screenTransformsPath;
        const solveRef = (gids.length >= 2 && solveAbs)
          ? relUnderProject(proj_.path, solveAbs)
          : null;
        const newGroup = {
          screens: gids.slice(),
          rotation: result.rotation,
          t_m: result.t_m,
          ref_points: {
            origin: coord.origin_point,
            x_axis: full ? coord.x_axis_point : null,
            xy_plane: full ? coord.xy_plane_point : null,
          },
          solve_ref: solveRef || undefined,
          applied_at: new Date().toISOString(),
        };
        const prevGroups = (proj_.config.rebuilt_alignment && proj_.config.rebuilt_alignment.groups) || [];
        const gidSet = new Set(gids);
        const kept = prevGroups.filter((g) => !(g.screens || []).some((sid) => gidSet.has(sid)));
        const nextConfig = Object.assign({}, proj_.config, {
          rebuilt_alignment: { groups: kept.concat([newGroup]) },
        });
        await s.runCmd(
          { domain: 'calibrate', action: '应用参考系', target: gids.join('+'), chan: 'local' },
          () => saveProjectYaml(proj_.path, nextConfig),
          { okMsg: () => '已应用参考系 · ' + gids.length + ' 块屏随组对齐' },
        );
        await CX.openProjectPath(proj_.path, s);
        s.setCalReceipt({ tone: 'ok', text: '已应用参考系 · ' + gids.length + ' 块屏随组对齐' });
      } catch (e) {
        const msg = (e && e.message) ? e.message : String(e);
        s.setCalReceipt({ tone: 'err', text: '应用参考系失败 · ' + msg });
      }
    };

    const doReset = async () => {
      if (!proj_.path || !proj_.config || !alignEntry) return;
      const prevGroups = (proj_.config.rebuilt_alignment && proj_.config.rebuilt_alignment.groups) || [];
      const gidSet = new Set(alignEntry.screens || gids);
      const kept = prevGroups.filter((g) => !(g.screens || []).some((sid) => gidSet.has(sid)));
      const nextConfig = Object.assign({}, proj_.config, {
        rebuilt_alignment: kept.length ? { groups: kept } : null,
      });
      try {
        await s.runCmd(
          { domain: 'calibrate', action: '复位对齐', target: (alignEntry.screens || gids).join('+'), chan: 'local' },
          () => saveProjectYaml(proj_.path, nextConfig),
          { okMsg: () => '已复位对齐 · 网格回到解算原始摆放' },
        );
        await CX.openProjectPath(proj_.path, s);
        s.setCalReceipt({ tone: 'notice', text: '已复位对齐 · 网格回到解算原始摆放' });
      } catch (e) { /* runCmd 已记录 */ }
      setResetArm(false);
    };

    const T = (id, label, key, icon) => h('button', { className: 'tbtn' + (tool === id ? ' on' : ''), onClick: () => s.setCalBoxTool(id), title: label + ' (' + key + ')' },
      h(Icon, { name: icon, size: 14 }), h('span', null, label), h('kbd', null, key));
    return h(React.Fragment, null,
      h('div', { className: 'gw-glass gw-boxbar' },
        T('select', '选择', 'V', 'target'),
        h('button', { className: 'tbtn' + (tool === 'mask' ? ' on' : ''), onClick: () => s.setCalBoxTool('mask'), disabled: rectScreen, style: rectScreen ? { opacity: .45 } : null, title: rectScreen ? '矩形屏不支持遮罩' : '遮罩 (M)' },
          h(Icon, { name: 'panel', size: 14 }), h('span', null, '遮罩'), h('kbd', null, 'M')),
        T('refs', '参考点', 'R', 'pin'),
        tool === 'refs' ? h(React.Fragment, null,
          h('div', { className: 'sep' }),
          h('div', { className: 'gw-roleseg' }, ['origin', 'x_axis', 'xy_plane'].map((rk, i) => {
            const field = rk === 'origin' ? 'origin_point' : rk === 'x_axis' ? 'x_axis_point' : 'xy_plane_point';
            const at = coord && resolvePointName(coord[field], allScreenIds);
            const onOther = at && at.screenId !== s.calActiveScreen;
            return h('button', { key: rk, className: s.calRefRole === rk ? 'on' : '', onClick: () => s.setCalRefRole(rk),
              title: ROLE[rk].label + '（' + (i + 1) + '）' + (onOther ? ' · 已在其他屏指派' : '') },
              h('span', { className: 'dot', style: { background: ROLE[rk].color } }),
              ROLE[rk].short,
              at ? h('span', { className: 'done' + (onOther ? ' cross' : '') }, h(Icon, { name: 'check', size: 11 })) : null);
          })),
          h('div', { className: 'sep' }),
          h('button', { className: 'gw-alignbtn ' + aVariant, disabled: aDisabled, title: aTip, onClick: applyReferenceFrame },
            h(Icon, { name: 'target', size: 14 }), h('span', null, '应用参考系'),
            aligned ? h('span', { className: 'gw-alignbtn-ck' }, h(Icon, { name: 'check', size: 11 })) : null)) : null),
      tool === 'refs' && aligned ? h('div', { className: 'gw-glass gw-alignstatus' },
        h('span', { className: 'gw-aligned-badge' + (stale ? ' stale' : '') },
          h(Icon, { name: stale ? 'alert' : 'check', size: 11 }),
          stale ? '对齐过期' : '已对齐 · ' + (alignEntry.screens || gids).length + ' 屏联动'),
        h('button', { className: 'gw-alignreset', title: '清除对齐 · 网格回到解算原始摆放', onClick: () => setResetArm((v) => !v) },
          h(Icon, { name: 'undo', size: 13 }), h('span', null, '复位对齐')),
        resetArm ? h('div', { className: 'gw-reset-confirm' },
          h('span', null, '复位？'),
          h('button', { className: 'y', onClick: doReset }, '复位'),
          h('button', { className: 'n', onClick: () => setResetArm(false) }, '取消')) : null) : null);
  }

  function Coords() {
    const [c, setC] = useState([0, 0]);
    useEffect(() => {
      const el = document.querySelector('.gw-stage'); if (!el) return undefined;
      const onMove = (e) => { const r = el.getBoundingClientRect(); setC([Math.round(e.clientX - r.left), Math.round(e.clientY - r.top)]); };
      el.addEventListener('mousemove', onMove);
      return () => el.removeEventListener('mousemove', onMove);
    }, []);
    return h('div', { className: 'gw-glass gw-coords' },
      h('span', { className: 'u' }, '视口坐标'),
      h('span', { className: 'xyz' }, 'x ', c[0], ' px  y ', c[1], ' px'));
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
    const proj_ = CX.useProj();
    const se3By = se3ByScreenFromFile(proj_.visualSession && proj_.visualSession.screenTransforms, true);
    const gids = alignmentGroupScreenIds(s.calActiveScreen, se3By, proj_.config);
    const isSolo = gids.length < 2;
    const alignedNow = !!alignmentForScreen(proj_.config, s.calActiveScreen);
    return h('div', { className: 'gw-center' },
      h('div', { className: 'gw-stage' },
        h(Viewport, { s }),
        cabinet ? h(BoxBar, { s }) : null,
        /* 已对齐时 gw-alignstatus 占同带，隐藏 solonote 避免叠层 */
        cabinet && s.calBoxTool === 'refs' && isSolo && !alignedNow
          ? h('div', { className: 'gw-glass gw-solonote' }, h(Icon, { name: 'info', size: 13 }), '当前屏为单独重建 · 多屏联动需联合重建') : null,
        h('div', { className: 'gw-ov gw-ov--tl' }, h(CtxCard, { s }), h(Coords)),
        h('div', { className: 'gw-ov gw-ov--tr' }, h(DisplayToggles, { s }), h(NavGizmo)),
        h('div', { className: 'gw-ov gw-ov--bc' }, h(HintBar, { s }), h(VersionSwitcher, { s })),
        h('div', { className: 'gw-ov gw-ov--bl', style: { display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' } }, h(PlacementLegend, { s }), h(Legend, { s })),
        h('div', { className: 'gw-ov gw-ov--br' }, h(Receipt, { s }))));
  }

  window.VOLO_GRID = Object.assign(window.VOLO_GRID || {}, {
    Center, center: (s) => h(Center, { s }), ROLE, PROV, pointName, roleAtCabinet, parsePointName, resolvePointName,
    buildNominalBoxes, buildRealBoxes, applyRowMajorRigid, applyAlignmentTransform, se3ByScreenFromFile,
    alignmentGroupScreenIds, alignmentForScreen, alignmentIsStale, alignmentApproxEq,
    groupAlignmentsConsistent, selectedScreenIds, toggleScreenSel,
    rig: RIG,
  });
})();
