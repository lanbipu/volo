// @ts-nocheck
/* Volo — 校正 · 镜头校正流程（采集大窗）
   1:1 移植自 Claude Design handoff `cal2_calib_flow.jsx`。
   检查器基座「镜头校正」打开二级大窗；方式选择在大窗内紧凑组（MethodOptions），
   偏离旧 Q3 / spec§4 的独立 MethodSelect / LensSetup 页——已删除死代码。
   采集主页接真：useMonitor MJPEG + useCaptureSession + list_lens_sessions。 */
import * as React from "react";
import { lensWorkspacePaths } from "../api/lensWorkspace";
import {
  listLensSessions, deleteLensSession, readLensQaReport, readImageAsDataUrl,
  startCaptureStills, stillsFinish,
  trackerFreeLensCal, trackerFreeLensInfo, trackerFreeStagePose, trackerFreeFixedObservation,
  trackerFreeFixedObservationSl, trackerFreeGrid,
  qualityFromRms, qualityFromLabel, writeFixedRunMeta,
} from "../api/lensCommands";
import { pickDirectory, pickFile } from "../api/commands";
import { probeTrackingSource } from "../api/captureProfiles";
import {
  spawnSidecarStreaming, cancelSidecarTask, cancelSidecarTaskAwaitExit, finishSidecarTaskAwaitExit,
  useSidecarStream, listenSidecarStream,
} from "../api/sidecarStream";
import { useCaptureSession } from "./devCapture";
import {
  listMonitors, openPatternPlayer, playerShowPattern, playerClear, preferPatternMonitor,
} from "../api/player";
import {
  DEFAULT_NDISPLAY_OUTPUT_PATHS,
  outputShow,
  outputPlaySequence,
  outputSequenceAbort,
} from "../api/ndisplayOutput";
import {
  meshVisualGenerateStructuredLight,
  meshVisualDecodeStructuredLight,
} from "../api/meshVisualCommands";
import { computeFramingScore, cabinetsNormBBox } from "../lib/framingMatch";

(function () {
  const { Button, Switch } = window.Spectrum2DesignSystem_b6d1b3;
  const { useState, useRef, useEffect } = React;
  const h = React.createElement;
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const CX = () => window.VOLO_CAL2 || {};
  const BACKEND_LABEL = { uvc: 'UVC', ndi: 'NDI', decklink: 'DeckLink', synthetic: '合成' };
  const LS_CAP_PARAMS = 'volo-capw-params';
  const loadCapParams = () => {
    /* patternsDir 字段已随路径全自动化删除（图案目录由系统推导）；读到旧值忽略。 */
    try { return Object.assign({ poses: 8, settleMs: 300, burst: 5, inverted: true, graycodeSync: true, lensPath: '' }, JSON.parse(localStorage.getItem(LS_CAP_PARAMS) || '{}')); }
    catch (e) { return { poses: 8, settleMs: 300, burst: 5, inverted: true, graycodeSync: true, lensPath: '' }; }
  };
  const saveCapParams = (p) => { try { localStorage.setItem(LS_CAP_PARAMS, JSON.stringify(p)); } catch (e) {} };
  /* Windows verbatim 路径（\\?\C:\...）+ 混用 `/` 会被 click.Path(exists=True) 判为不存在
     （「立即求解」曾因此静默失败）。name 内分隔符一律归一到 dir 的风格。 */
  const joinPath = (dir, name) => {
    const sep = String(dir).indexOf('\\') >= 0 ? '\\' : '/';
    const parts = String(name).split(/[\\/]+/).filter(Boolean);
    return [String(dir).replace(/[\\/]+$/, ''), ...parts].join(sep);
  };
  const pad6 = (n) => String(n).padStart(6, '0');
  const finite = (value, fallback = 0) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };
  const fixedSolveFailure = (error) => {
    const code = error && error.code;
    const details = error && error.details || {};
    if (code === 'MASTER_LENS_REQUIRED') return 'Lens invalid · ' + error.message;
    if (code === 'LOCALIZATION_QUALITY_FAILED') return 'Detection failed · ' + error.message;
    if (code === 'SCREEN_GEOMETRY_INCONSISTENT') {
      const joint = Number(details.joint_projective && details.joint_projective.rms_px);
      return 'Detection OK · Geometry invalid · '
        + (Number.isFinite(joint) ? ('joint RMS ' + joint.toFixed(3) + ' px · ') : '')
        + error.message;
    }
    return 'Pose failed · ' + (error && error.message ? error.message : String(error));
  };
  function capturePixelIntrinsics(lens, source) {
    const width = finite(source && source.width);
    const height = finite(source && source.height);
    const sensorWidth = finite(lens && lens.sensorW && lens.sensorW.v);
    const sensorHeight = finite(lens && lens.sensorH && lens.sensorH.v);
    const focal = finite(lens && lens.focal && lens.focal.v);
    if (width <= 0 || height <= 0) throw new Error('采集结果缺少有效 width/height，无法冻结 pixel intrinsics');
    if (sensorWidth <= 0 || sensorHeight <= 0 || focal <= 0) {
      throw new Error('摄影机缺少有效 focal length / active sensor，无法冻结 pixel intrinsics');
    }
    const captureAspect = width / height;
    const sensorAspect = sensorWidth / sensorHeight;
    const cropHeight = captureAspect > sensorAspect;
    const activeSensorWidth = cropHeight ? sensorWidth : sensorHeight * captureAspect;
    const activeSensorHeight = cropHeight ? sensorWidth / captureAspect : sensorHeight;
    const pixelScale = width / activeSensorWidth;
    const cropXmm = (sensorWidth - activeSensorWidth) / 2;
    const cropYmm = (sensorHeight - activeSensorHeight) / 2;
    const cropMode = Math.max(cropXmm, cropYmm) < 1e-6
      ? 'none' : (cropHeight ? 'center_crop_height' : 'center_crop_width');
    const principalXmm = finite(lens && lens.ppx && lens.ppx.v);
    const principalYmm = finite(lens && lens.ppy && lens.ppy.v);
    const focalPx = focal * pixelScale;
    return {
      fx: focalPx, fy: focalPx,
      cx: width / 2 + principalXmm * pixelScale,
      cy: height / 2 + principalYmm * pixelScale,
      dist_coeffs: [finite(lens && lens.k1), finite(lens && lens.k2), 0, 0,
        finite(lens && lens.fovK3 && lens.fovK3.v)],
      image_size: [Math.round(width), Math.round(height)],
      source: 'project_camera_capture_snapshot',
      physical_snapshot: {
        focal_mm: focal,
        sensor_width_mm: sensorWidth,
        sensor_height_mm: sensorHeight,
        active_sensor_width_mm: activeSensorWidth,
        active_sensor_height_mm: activeSensorHeight,
        crop_x_mm: cropXmm,
        crop_y_mm: cropYmm,
        crop_mode: cropMode,
        principal_x_mm: principalXmm,
        principal_y_mm: principalYmm,
        k1: finite(lens && lens.k1),
        k2: finite(lens && lens.k2),
        k3: finite(lens && lens.fovK3 && lens.fovK3.v),
      },
    };
  }
  const useCamStore = () => {
    const store = window.camStore;
    return React.useSyncExternalStore(
      store ? store.subscribe : () => () => {},
      () => (store ? store.get() : { cameras: CAL_CAMERAS, selectedId: CAL_CAMERAS[0] && CAL_CAMERAS[0].id }),
    );
  };
  async function writeFixedRunMetaSafe(sessionDir, meta, lensSourcePath) {
    try {
      await writeFixedRunMeta(sessionDir, meta, lensSourcePath);
      return null;
    } catch (e) {
      /* captures/normal 仍可被 list 扫描，但求解前必须让操作者看到 snapshot 失败。 */
      return e && e.message ? e.message : String(e);
    }
  }
  /** Resolve which OS monitor should host the pattern player (HDMI / TV path). */
  async function resolvePatternMonitorIndex(s) {
    const store = window.deployStore && window.deployStore.get();
    /* shell state is updated immediately by the in-window monitor switch, while
       deployStore mirrors it on the next React effect. Prefer the shell value so
       an LG selection cannot be overwritten by one stale ASUS store snapshot. */
    if (s.deployMeta && typeof s.deployMeta.monitorIndex === 'number') {
      return s.deployMeta.monitorIndex;
    }
    if (store && store.detail && typeof store.detail.monitorIndex === 'number') {
      return store.detail.monitorIndex;
    }
    const monitors = await listMonitors();
    const pick = preferPatternMonitor(monitors);
    if (!pick) throw new Error('未发现可用于图案播放器的显示器');
    return pick.index;
  }

  async function showViaDeploy(s, targets, pattern) {
    if (!targets || !targets.length) throw new Error('没有可用的标定屏幕图案');
    const imagePath = joinPath(targets[0].patternsDir, pattern + '.png');
    const store = window.deployStore && window.deployStore.get();
    const channel = (store && store.channel) || (s.calOutTarget === 'cluster' ? 'ndisplay' : 'monitor');
    if (channel === 'ndisplay') {
      const proj = CX().projStore ? CX().projStore.get() : null;
      if (!proj || !proj.path) throw new Error('无打开项目，无法 nDisplay 推图');
      const topology = window.resolveProjectTopology && window.resolveProjectTopology(proj.config);
      if (targets.length > 1 && (!topology || !window.stageScreenOriginPx)) {
        throw new Error('多屏同步上屏缺少有效 Stage topology');
      }
      const screenId = targets[0].id;
      const screen = topology
        ? window.stageScreenForOutput(proj.config, topology)
        : (proj.config && proj.config.screens[screenId]);
      if (!screen) throw new Error('无可用输出屏幕');
      const layers = targets.map((target) => {
        const origin = window.stageScreenOriginPx
          ? window.stageScreenOriginPx(proj.config.screens, target.id) : [0, 0];
        return {
          screen_id: target.id, x: origin[0], y: origin[1],
          image_path: joinPath(target.patternsDir, pattern + '.png'),
        };
      });
      await outputShow({
        session_id: proj.path + '::stage',
        screen,
        paths: Object.assign({}, DEFAULT_NDISPLAY_OUTPUT_PATHS),
        ssh_user: null,
        mode: 'show',
        stage: { project_path: proj.path, screens: layers },
      });
      return;
    }
    if (targets.length > 1) {
      throw new Error('多屏同步上屏需要选择 nDisplay 输出通道');
    }
    /* Always (re)place the player on the deployed / preferred monitor before
       show — deployMeta.monitorIndex was previously ignored, so a window that
       landed on the ASUS primary stayed there when capture pushed the chart. */
    const monitorIndex = await resolvePatternMonitorIndex(s);
    await openPatternPlayer(monitorIndex);
    await playerShowPattern(imagePath, pattern || 'full_screen');
  }

  /* ============================================================
     徽标体系（渲染原子）
     ============================================================ */
  function sourceTag(src, opts) {
    const m = CAL_SOURCE_BADGES[src] || CAL_SOURCE_BADGES.manual;
    return h('span', { className: 'cal-srctag cal-srctag--' + src, title: m.desc },
      h(Icon, { name: m.icon, size: 10 }), (opts && opts.compact) ? m.label : m.label);
  }
  function modeBadge(mode) {
    const m = CAL_MODE_BADGES[mode] || CAL_MODE_BADGES.fixed;
    return h('span', { className: 'spill spill--' + m.tone, title: m.desc }, h(Icon, { name: m.icon, size: 12 }), m.label);
  }
  function methodBadge(id) {
    const m = CAL_METHOD_BADGES[id] || CAL_METHOD_BADGES.qsp;
    return h('span', { className: 'spill spill--' + m.tone }, h(Icon, { name: m.icon, size: 12 }), m.label);
  }
  function qualityLight(state) {
    const m = CAL_QUALITY_LIGHT[state] || CAL_QUALITY_LIGHT.pending || CAL_QUALITY_LIGHT.ok;
    return h('span', { className: 'cal-light cal-light--' + m.tone, title: m.label }, h(Icon, { name: m.icon, size: 8 }));
  }
  function solveBadge(state) {
    const m = CAL_SOLVE_STATE[state] || CAL_SOLVE_STATE.none;
    return h('span', { className: 'spill spill--' + m.tone },
      m.icon === 'minus' ? h('span', { style: { fontWeight: 800 } }, '—') : h(Icon, { name: m.icon, size: 12 }), m.label);
  }
  /* RMS 三通道徽标（色 + 图标 + 文字）· < 2px 好 / ≥ 2px 警告 */
  function rmsSolveBadge(rms) {
    const n = Number(rms);
    if (!Number.isFinite(n)) return solveBadge('none');
    const warn = n >= 2;
    return h('span', { className: 'spill spill--' + (warn ? 'notice' : 'positive') },
      h(Icon, { name: warn ? 'alert' : 'check', size: 12 }), 'RMS ' + n.toFixed(2) + ' px');
  }
  const rmsTone = (rms) => rms == null ? 'neutral' : rms < 1 ? 'positive' : rms < 2 ? 'notice' : 'negative';

  /** Build SolveReport payload from a fixed-run `stagePose` DTO. */
  function buildSolveFromRun(run) {
    const sp = run && run.stagePose;
    if (!sp) return null;
    const rms = Number(sp.rms_reprojection_px);
    const markers = Number(sp.num_markers) || 0;
    const inliers = Number(sp.num_inliers) || 0;
    const byScreen = sp.markers_by_screen || {};
    const cam = sp.camera_from_stage || {};
    const pos = cam.position_mm || [0, 0, 0];
    const ptr = cam.ptr_deg || { pan: 0, tilt: 0, roll: 0 };
    const camName = (window.camStore && window.camStore.get().cameras.find((c) => c.id === run.cameraId))
      ? window.camStore.get().cameras.find((c) => c.id === run.cameraId).name
      : (run.cameraId || '—');
    return {
      conclusion: Number.isFinite(rms) && rms >= 2 ? 'warn' : 'ok',
      camId: run.cameraId || null,
      cam: camName,
      rms: Number.isFinite(rms) ? rms : 0,
      inliers, markers_total: markers || inliers,
      solved_at: run.time || '—',
      warn_reason: Number.isFinite(rms) && rms >= 2
        ? '重投影 RMS 偏高（≥ 2px）· 建议补采正面机位、改善对焦或复核 marker 真值'
        : null,
      screens: Object.keys(byScreen).map((name) => ({ name, hits: Number(byScreen[name]) || 0 })),
      pose: {
        x: Number(pos[0]) || 0, y: Number(pos[1]) || 0, z: Number(pos[2]) || 0,
        pan: Number(ptr.pan) || 0, tilt: Number(ptr.tilt) || 0, roll: Number(ptr.roll) || 0,
      },
    };
  }

  /* MethodViz / MethodSelect / LensSetup 已删：方式选择在大窗 MethodOptions 紧凑组。 */

  /* ============================================================
     AR 网格叠加（canvas · 归一化线段 × object-fit:contain 映射）
     ============================================================ */
  function containMap(nx, ny, iw, ih, cw, ch) {
    const scale = Math.min(cw / Math.max(iw, 1), ch / Math.max(ih, 1));
    const dw = iw * scale, dh = ih * scale;
    return [nx * dw + (cw - dw) / 2, ny * dh + (ch - dh) / 2];
  }
  function AROverlay({ grid, lost, opacity }) {
    const canvasRef = useRef(null);
    const wrapRef = useRef(null);
    const draw = () => {
      const canvas = canvasRef.current, wrap = wrapRef.current;
      if (!canvas || !wrap) return;
      const cw = wrap.clientWidth || 1, ch = wrap.clientHeight || 1;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
        canvas.width = Math.round(cw * dpr);
        canvas.height = Math.round(ch * dpr);
        canvas.style.width = cw + 'px';
        canvas.style.height = ch + 'px';
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, ch);
      if (!grid || !grid.screens || !grid.screens.length) return;
      const isize = grid.image_size || [1920, 1080];
      const iw = Number(isize[0]) || 1920, ih = Number(isize[1]) || 1080;
      const line = lost ? 'rgba(170,178,190,.92)' : '#3fe4e6';
      const cross = lost ? 'rgba(205,211,219,.95)' : '#8ff8f4';
      ctx.save();
      if (lost) ctx.globalAlpha = 0.6;
      grid.screens.forEach((screen) => {
        const segs = screen.segments || [];
        /* 内部柜格细线。 */
        ctx.strokeStyle = line;
        ctx.lineWidth = 1;
        ctx.globalAlpha = lost ? 0.7 : 0.7;
        segs.forEach((seg) => {
          if (!seg || seg.length < 4) return;
          const a = containMap(seg[0], seg[1], iw, ih, cw, ch);
          const b = containMap(seg[2], seg[3], iw, ih, cw, ch);
          ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
        });
        /* 外框必须使用后端投影的 perspective perimeter；AABB 会把倾斜屏
           错画成正矩形，不能作为几何验收依据。 */
        ctx.strokeStyle = line;
        ctx.lineWidth = 3;
        ctx.globalAlpha = 1;
        (screen.perimeter || []).forEach((seg) => {
          if (!seg || seg.length < 4) return;
          const a = containMap(seg[0], seg[1], iw, ih, cw, ch);
          const b = containMap(seg[2], seg[3], iw, ih, cw, ch);
          ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
        });
        ctx.strokeStyle = cross; ctx.lineWidth = 1.6; ctx.globalAlpha = 1;
        (screen.markers || []).forEach((m) => {
          if (!m || m.length < 2) return;
          const p = containMap(m[0], m[1], iw, ih, cw, ch);
          ctx.beginPath(); ctx.moveTo(p[0] - 6, p[1]); ctx.lineTo(p[0] + 6, p[1]); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(p[0], p[1] - 6); ctx.lineTo(p[0], p[1] + 6); ctx.stroke();
        });
      });
      ctx.restore();
    };
    useEffect(() => {
      draw();
      const wrap = wrapRef.current;
      if (!wrap || typeof ResizeObserver === 'undefined') return undefined;
      const ro = new ResizeObserver(() => draw());
      ro.observe(wrap);
      return () => ro.disconnect();
    });
    return h('div', { ref: wrapRef, className: 'lc-ar-svg', style: { opacity: opacity == null ? 1 : opacity } },
      h('canvas', { ref: canvasRef, className: 'lc-ar-g' + (lost ? ' lost' : ''), style: { width: '100%', height: '100%', display: 'block' } }));
  }

  /* ============================================================
     摄影机实时信号（LED 墙 + 检测叠加）· 复用镜头页几何思路
     ============================================================ */
  function CameraSignal({ method, capturing, detect, sl, slFrame }) {
    const TL = [232, 120], TR = [726, 108], BR = [762, 452], BL = [196, 464];
    const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const bilerp = (u, v) => { const top = lerp(TL, TR, u), bot = lerp(BL, BR, u); return lerp(top, bot, v); };
    const rows = [];
    for (let j = 1; j < 8; j++) { const l = bilerp(0, j / 8), rr = bilerp(1, j / 8); rows.push(h('line', { key: 'r' + j, x1: l[0], y1: l[1], x2: rr[0], y2: rr[1], stroke: 'rgba(120,150,190,.13)', strokeWidth: .8 })); }
    for (let i = 1; i < 12; i++) { const t = bilerp(i / 12, 0), b = bilerp(i / 12, 1); rows.push(h('line', { key: 'c' + i, x1: t[0], y1: t[1], x2: b[0], y2: b[1], stroke: 'rgba(120,150,190,.13)', strokeWidth: .8 })); }
    const pts = [];
    if (sl) {
      /* 结构光白点阵，按帧推进逐列点亮 */
      const N = 14, M = 8, lit = Math.floor(((slFrame || 0) % N) );
      for (let r = 0; r < M; r++) for (let c = 0; c < N; c++) {
        const p = bilerp((c + 0.5) / N, (r + 0.5) / M);
        const on = c <= lit;
        pts.push(h('circle', { key: 'w' + r + c, cx: p[0], cy: p[1], r: on ? 2.6 : 1.1, fill: on ? '#fff' : 'rgba(255,255,255,.16)' }));
      }
    } else {
      /* 编码点阵 + 检测十字（capturing 时脉动） */
      const N = 12, M = 6;
      for (let r = 0; r < M; r++) for (let c = 0; c < N; c++) {
        const p = bilerp((c + 0.5) / N, (r + 0.5) / M);
        const enc = (c * 3 + r * 5) % 4;
        pts.push(enc === 0
          ? h('rect', { key: 'p' + r + c, x: p[0] - 2, y: p[1] - 2, width: 4, height: 4, fill: 'rgba(120,180,255,.8)' })
          : h('circle', { key: 'p' + r + c, cx: p[0], cy: p[1], r: enc === 1 ? 2.3 : 1.4, fill: enc === 2 ? 'rgba(70,200,130,.85)' : 'rgba(190,205,228,.7)' }));
      }
    }
    const dets = [];
    if (detect && !sl) {
      [[0.2, 0.24], [0.5, 0.2], [0.8, 0.26], [0.32, 0.55], [0.66, 0.56], [0.24, 0.82], [0.54, 0.85], [0.8, 0.8]].forEach((uv, i) => {
        const p = bilerp(uv[0], uv[1]);
        dets.push(h('g', { key: 'd' + i, className: capturing ? 'lens-det pulse' : 'lens-det' },
          h('circle', { cx: p[0], cy: p[1], r: 7, fill: 'none', stroke: 'var(--positive-visual)', strokeWidth: 1.3 }),
          h('line', { x1: p[0] - 10, y1: p[1], x2: p[0] + 10, y2: p[1], stroke: 'var(--positive-visual)', strokeWidth: 1 }),
          h('line', { x1: p[0], y1: p[1] - 10, x2: p[0], y2: p[1] + 10, stroke: 'var(--positive-visual)', strokeWidth: 1 })));
      });
    }
    return h('svg', { className: 'lc-feed', viewBox: '0 0 960 540', preserveAspectRatio: 'xMidYMid slice' },
      h('rect', { width: 960, height: 540, fill: '#06070b' }),
      h('polygon', { points: [TL, TR, BR, BL].map((p) => p.join(',')).join(' '), fill: sl ? '#050506' : '#0a0e16', stroke: 'rgba(140,170,210,.4)', strokeWidth: 1.5 }),
      rows, pts, dets);
  }

  /* ============================================================
     采集主页（含结构光播放状态段 + 详情覆盖）
     ============================================================ */
  const CAP_BANNERS = [
    { label: '移动到下一机位', sub: '把相机对准 LED 墙，缓慢就位', tone: 'notice', icon: 'arrowr' },
    { label: '保持静止…', sub: '静止约 0.3 秒即触发采集', tone: 'notice', icon: 'target' },
    { label: '采集中，别动', sub: '连拍中 · 反相双帧', tone: 'negative', icon: 'camera' },
    { label: '本机位完成 · 请移动', sub: '差分成功，可移动到下一机位', tone: 'positive', icon: 'check' },
  ];

  const TRACK_SIGNALS = [
    { id: 'none', label: 'None（固定机位）' },
    { id: 'freed', label: 'FreeD · UDP 6301' },
    { id: 'opentrackio', label: 'OpenTrackIO · UDP 6301' },
  ];
  function pickExistingCamId(preferred, snap) {
    const cams = (snap && snap.cameras) || [];
    if (preferred && cams.some((c) => c.id === preferred)) return preferred;
    if (snap && snap.selectedId && cams.some((c) => c.id === snap.selectedId)) return snap.selectedId;
    return (cams[0] && cams[0].id) || null;
  }
  function CaptureWindow({ s, close }) {
    const method = s.lensCalMethod || 'qsp';
    const isSl = method === 'sl';
    const capturing = s.capState === 'capturing';
    const [open, setOpen] = useState({ mopt: true, general: true, method: true, camera: true, records: true });
    const camSnap = useCamStore();
    /* capCam 可能残留演示 id（cam1）；必须落在 camStore 真实机位上。 */
    const [camId, setCamId] = useState(() => pickExistingCamId(s.capCam, camSnap));
    useEffect(() => {
      const next = pickExistingCamId(camId, camSnap);
      if (next && next !== camId) {
        setCamId(next);
        if (s.setCapCam) s.setCapCam(next);
      }
    }, [camSnap.cameras, camSnap.selectedId]);
    const [trackSignal, setTrackSignal] = useState(s.capTrack === 'fixed' ? 'none' : (s.capTrack === 'connected' ? 'freed' : 'none'));
    const tracked = trackSignal !== 'none';
    /* Fixed-camera purpose: do NOT auto-hijack into master-lens (≥8) when lens
       is missing — that forced every「固定机位」start to demand 8 poses.
       Modes are explicit（= Design `observation.purpose`）:
         fixed            — 固定机位 · 单次校正（auto → known-lens or joint）
         known_lens       — 使用 Master Lens · 只求外参
         joint_session    — 自动估计当前镜头（session-coupled）
         master_lens      — 建立 Master Lens · 多姿态 ≥8 */
    const [purpose, setPurpose] = useState('fixed'); /* 'fixed' | 'known_lens' | 'joint_session' | 'master_lens' */
    /* 固定机位 · VP-QSP 单次校正 —— 8 状态机的瞬态部分 + AR 静帧门控 */
    const [qspFail, setQspFail] = useState(null); /* {code, message} — 最近一次 fail-closed 求解 */
    const [qspRunId, setQspRunId] = useState(null); /* 本窗口内最近一次成功求解的 run */
    const [qspDismissed, setQspDismissed] = useState(false); /* 「重新采集」后回 idle */
    const [, setAttestTick] = useState(0); /* attest ref 更新后触发重渲染 */
    const attestedRunsRef = useRef(new Set()); /* 本窗口内已 attest 的 run id */
    const sessionSolvedRef = useRef(new Set()); /* 本窗口内新求解的 run id（无需 attest） */
    const [arStage, setArStage] = useState('idle'); /* idle|verifying|passed|failed（静帧门控） */
    const lastDetectRef = useRef(null); /* stills detect_state 最新非 stale 帧（framing 用） */
    const [patternMons, setPatternMons] = useState([]);
    const [patternMonBusy, setPatternMonBusy] = useState(false);
    const [banner, setBanner] = useState(0);
    const [slFrame, setSlFrame] = useState(0);
    const [params, setParams] = useState(loadCapParams);
    const setP = (k, v) => setParams((f) => Object.assign({}, f, { [k]: v }));
    const gsync = !!params.graycodeSync;
    const inverted = !!params.inverted;
    const setGsync = (v) => setP('graycodeSync', v);
    const setInverted = (v) => setP('inverted', v);
    /* AR 网格叠加验证 */
    const [arOn, setArOn] = useState(false);
    const [arOpacity, setArOpacity] = useState(60);
    const [arPanelOpen, setArPanelOpen] = useState(false);
    const [arGrid, setArGrid] = useState(null);
    const [arLost, setArLost] = useState(false);
    const [arLiveTaskId, setArLiveTaskId] = useState(null);
    const [arLiveUrl, setArLiveUrl] = useState(null);
    const [arErr, setArErr] = useState(null);
    const arBtnRef = useRef(null);
    const arLiveTaskRef = useRef(null);
    const qspCtxRef = useRef(null); /* 供 QspOverlays 在渲染期取 qctx（函数体尾部装配） */
    const rootRef = useRef(null);
    const [leftPct, setLeftPct] = useState(68);
    const timer = useRef(null);
    const patternAckSeq = useRef(new Set());
    const stillsOutRef = useRef(null);
    const stillsFinishingRef = useRef(false);
    const stillsResultHandledRef = useRef(new Set());
    const fixedInputRef = useRef(null);
    const trackedResultHandledRef = useRef(false);
    /** Active SL nDisplay play-sequence request; cleared when play finishes/fails. */
    const slPlayReqRef = useRef(null);
    const [stillsTaskId, setStillsTaskId] = useState(null);
    /* stillsTaskRef 与 state 同步：换任务前必须先杀旧任务（DeckLink/UVC 独占，
       裸覆盖 id 会留下独占设备的孤儿进程）；写入一律走 setStillsTask */
    const stillsTaskRef = useRef(null);
    const setStillsTask = (id) => { stillsTaskRef.current = id; setStillsTaskId(id); };
    /* 重入护栏：ref 挡同帧重入（state 更新是异步的），state 驱动按钮禁用/文案 */
    const startingRef = useRef(false);
    const [starting, setStarting] = useState(false);
    const [masterLensBusy, setMasterLensBusy] = useState(false);
    const [stillsSnapN, setStillsSnapN] = useState(0);
    const stillsStream = useSidecarStream(stillsTaskId);
    const cam = (camSnap.cameras || []).find((c) => c.id === camId) || camSnap.cameras[0] || CAL_CAMERAS[0];
    const profiles = (CX().loadProfiles && CX().loadProfiles()) || [];
    const [pid, setPid] = useState(s.capProfileId || (profiles[0] && profiles[0].id) || null);
    const profile = profiles.find((p) => p.id === pid) || null;
    const backend = profile && profile.videoBackend;
    const onTrackChange = (v) => {
      setTrackSignal(v);
      s.setCapTrack(v === 'none' ? 'fixed' : 'connected');
      if (window.camStore) {
        window.camStore.setTracking(camId, v === 'none' ? null : {
          protocol: v,
          host: (profile && profile.trackHost) || '0.0.0.0',
          port: Number((profile && profile.trackPort) || 6301),
          camera_id: (profile && profile.trackCameraId != null) ? profile.trackCameraId : null,
        });
      }
    };
    /* index 保证 calCaptureWindow 先于本文件加载，useMonitor 始终可用。
       追踪机位 AR 占用 verify live 时暂停监看流（设备独占）。 */
    const monitor = window.VOLO_CAPTURE.useMonitor(
      profile,
      !capturing && !!profile && backend !== 'synthetic' && !arLiveTaskId,
    );
    const arLiveStream = useSidecarStream(arLiveTaskId);
    const session = useCaptureSession();
    const [liveRuns, setLiveRuns] = useState([]);
    const [sessionsErr, setSessionsErr] = useState(null);
    const [solvingId, setSolvingId] = useState(null);

    /* 路径全自动化：标定屏幕 + 屏幕定义 / 校正图案 / 输出位置自动状态（真实后端） */
    const ag = window.VoloAutoGen.useAutoGen(s);
    const proj = CX().useProj ? CX().useProj() : {};
    const projectPath = proj && proj.path ? proj.path : null;

    /* Framing score（取景构图评分）：采集时最后一帧 detect_state 的 cabinets 命中率
       × bbox 占比 —— 与网格快拍窗同一套 framingMatch 算法（≠ Geometry RMS）。 */
    const computeQspFraming = (targets) => {
      const det = lastDetectRef.current;
      const cfgScreens = proj && proj.config && proj.config.screens ? proj.config.screens : null;
      if (!det || !det.cabinets || !det.cabinets.length || !cfgScreens) return null;
      const perScreen = {};
      const scores = [];
      for (const target of (targets || [])) {
        const cfg = cfgScreens[target.id];
        const count = cfg && cfg.cabinet_count;
        if (!count || !count[0] || !count[1]) continue;
        const cols = count[0], rows = count[1];
        const expected = [];
        for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) expected.push([c, r]);
        const observed = det.cabinets
          .filter((cab) => cab[0] === target.code)
          .map((cab) => [cab[1], cab[2]]);
        const score = computeFramingScore(
          expected, observed,
          cabinetsNormBBox(expected, cols, rows),
          det.bbox || cabinetsNormBBox(observed, cols, rows),
        );
        perScreen[target.id] = score;
        scores.push(score);
      }
      if (!scores.length) return null;
      return {
        score: Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100,
        per_screen: perScreen,
        observed_markers: det.markers,
        bbox_frac: det.bbox,
        source: 'capture_detect_state',
      };
    };

    const screenFile = typeof s.capScreenFile === 'string' ? s.capScreenFile : null;
    /* 输出目录固定 = <project>/vpcal/captures/（§3.4；不再用 profile.outputRoot / 手选） */
    const outDir = projectPath ? lensWorkspacePaths(projectPath).capturesDir : '';
    const deployed = s.deployState !== 'idle';
    const signalReady = backend === 'synthetic'
      || monitor.sig === 'ok'
      || (!!monitor.url && monitor.sig !== 'lost')
      || !!arLiveUrl;
    const deployStoreSnap = window.deployStore && window.deployStore.get();
    const deployChannel = (deployStoreSnap && deployStoreSnap.channel)
      || (s.calOutTarget === 'cluster' ? 'ndisplay' : 'monitor');
    const activeMonitorIndex = (s.deployMeta && typeof s.deployMeta.monitorIndex === 'number')
      ? s.deployMeta.monitorIndex
      : (deployStoreSnap && deployStoreSnap.detail && typeof deployStoreSnap.detail.monitorIndex === 'number'
        ? deployStoreSnap.detail.monitorIndex : null);
    useEffect(() => {
      if (deployChannel !== 'monitor' || !deployed) return undefined;
      let alive = true;
      listMonitors().then((list) => { if (alive && Array.isArray(list)) setPatternMons(list); }).catch(() => {});
      return () => { alive = false; };
    }, [deployChannel, deployed]);
    const retargetPatternMonitor = async (mon) => {
      if (!mon || patternMonBusy) return;
      setPatternMonBusy(true);
      try {
        await openPatternPlayer(mon.index);
        await playerClear();
        if (s.setDeployMeta) {
          s.setDeployMeta({
            channel: 'HDMI · 本机',
            target: mon.name || ('显示器 ' + mon.index),
            monitorIndex: mon.index,
          });
        }
        if (s.setDeployState && s.deployState === 'idle') s.setDeployState('standby');
        s.pushLog({
          lv: 'ok', cat: 'deploy',
          msg: '图案输出已切到 <b>' + (mon.name || ('#' + mon.index)) + '</b>'
            + (mon.is_primary ? '（主屏）' : ''),
        });
      } catch (e) {
        s.pushLog({ lv: 'err', cat: 'deploy', msg: '切换图案显示器失败 · ' + (e && e.message ? e.message : e) });
      } finally { setPatternMonBusy(false); }
    };
    const fixedLensReady = !!(cam && cam.lensIsMaster && cam.masterLensPath
      && cam.masterLensInfo && cam.masterLensInfo.qualified_master);
    /* Explicit mode only — never infer master-lens capture from missing lens. */
    const collectingMasterLens = method === 'qsp' && !tracked && purpose === 'master_lens';
    const targetM = tracked
      ? (Number(params.poses) || 8)
      : (collectingMasterLens ? Math.max(8, Number(params.poses) || 8) : 1);
    const installMasterLens = async (path) => {
      const info = await trackerFreeLensInfo(path);
      if (!info.qualified_master) {
        throw new Error('Master lens qualification failed: ' + (info.reasons || []).join('; '));
      }
      if (!window.camStore) throw new Error('camera store unavailable');
      window.camStore.setMasterLens(camId, path, info);
      setPurpose('fixed');
      s.pushLog({ lv: 'ok', cat: 'lens', msg: 'Master lens 已绑定 · RMS <b>'
        + Number(info.rms).toFixed(3) + '</b> px · <b>' + info.num_images + '</b> poses' });
    };
    const importMasterLens = async () => {
      setMasterLensBusy(true);
      try {
        const path = await pickFile('Qualified master lens', ['json']);
        if (path) await installMasterLens(path);
      } catch (e) {
        s.pushLog({ lv: 'err', cat: 'lens', msg: 'Lens invalid · ' + (e && e.message ? e.message : e) });
      } finally { setMasterLensBusy(false); }
    };
    const createMasterLens = async () => {
      setMasterLensBusy(true);
      try {
        if (!projectPath || !ag.targets.length) throw new Error('需要项目路径和至少一个已导出的 screen target');
        const imagesDir = await pickDirectory();
        if (!imagesDir) return;
        const target = ag.targets[0];
        const outLens = joinPath(lensWorkspacePaths(projectPath).vpcalDir, 'lenses/' + camId + '.master-lens.json');
        await trackerFreeLensCal({
          imagesDir, screenPath: target.screenJson, outLensJson: outLens,
          cabColOffset: target.offset, screenId: target.code,
        });
        await installMasterLens(outLens);
      } catch (e) {
        s.pushLog({ lv: 'err', cat: 'lens', msg: 'Master lens 生成失败 · ' + (e && e.message ? e.message : e) });
      } finally { setMasterLensBusy(false); }
    };
    /* 固定机位 · VP-QSP 派生态：追踪 None + 密集编码点 → 走新版单次校正 UX */
    const isQspFixed = method === 'qsp' && !tracked;
    const hasMaster = fixedLensReady;
    const qspLensPhase = window.VOLO_QSP ? window.VOLO_QSP.lensPhaseOf(purpose, hasMaster) : 'joint';
    /* §3.5 qsp：部署 + profile + 屏幕定义已同步 + 单 section + 图案未失败（生成中 / 需重生成仍可点，
       beginCapture 会先补生成）。screenFile 由 ag 系统写入 s.capScreenFile。
       固定机位不再强制 Master Lens：fixed / joint_session 无档案时走 joint session lens（fail-closed 由求解端把关）；
       仅 known_lens 显式模式缺档案时禁用主按钮。
       SL×nDisplay：不依赖校正图案 auto-gen，走序列播放通道。 */
    const readyQsp = method === 'qsp'
      && (backend === 'synthetic' || signalReady)
      && ag.screenDef === 'synced' && !ag.multiSection && ag.pattern !== 'genFail'
      && ag.targets.length === ag.selectedIds.length
      && (ag.selectedIds.length <= 1 || deployChannel === 'ndisplay')
      && (tracked || purpose !== 'known_lens' || fixedLensReady);
    const readySl = method === 'sl'
      && deployChannel === 'ndisplay'
      && (backend === 'synthetic' || signalReady)
      && !!screenFile && !!outDir;
    const ready = deployed && !!profile && (readyQsp || readySl);

    /* 同步 shell 前置徽标 / Profile 标签 */
    useEffect(() => {
      if (s.setCapSignalReady) s.setCapSignalReady(signalReady);
    }, [signalReady]);
    useEffect(() => {
      if (profile) {
        if (s.setCapProfileId) s.setCapProfileId(profile.id);
        if (s.setCapProfileLabel) s.setCapProfileLabel(profile.name);
      }
    }, [pid, profile && profile.name]);

    const refreshSessions = async () => {
      if (!outDir) { setLiveRuns([]); return; }
      try {
        const list = await listLensSessions(outDir);
        const runs = await Promise.all((list || []).map(async (sess) => {
          const isFixed = sess.mode === 'fixed';
          const n = sess.poses_captured != null ? sess.poses_captured : 0;
          let poses = Array.from({ length: n }, (_, j) => ({
            id: sess.id + '_p' + (j + 1), idx: j + 1, time: '—',
            pose: isFixed ? ('固定 · ' + (j + 1)) : ('点位 ' + (j + 1)),
            tracked: !isFixed, detect: 'pending', reproj: 'pending', diff: 'pending',
            rms: null, obs: null, outliers: 0, missing: [],
            framePath: isFixed ? joinPath(sess.session_dir, 'captures/normal/' + pad6(j) + '.png') : null,
          }));
          let rms = null, conf = null, solveState = 'none';
          let outliersAll = [];
          const qaDir = sess.output_dir || (isFixed ? null : joinPath(sess.session_dir, 'output'));
          if (qaDir && !isFixed) {
            try {
              const qa = await readLensQaReport(qaDir);
              rms = qa.global_rms_px != null ? qa.global_rms_px : null;
              outliersAll = qa.outliers_top10 || [];
              if (qa.per_pose && qa.per_pose.length) {
                poses = qa.per_pose.map((pp, j) => {
                  const q = qualityFromLabel(pp.quality) || qualityFromRms(pp.rms_px);
                  const outs = outliersAll.filter((o) => o.frame_id === pp.frame_id);
                  return {
                    id: sess.id + '_p' + (j + 1), idx: j + 1, time: '—',
                    pose: '点位 ' + (j + 1), tracked: true,
                    detect: pp.num_observations > 0 ? 'ok' : 'fail',
                    reproj: q, diff: q,
                    rms: pp.rms_px, obs: pp.num_observations,
                    outliers: outs.length, missing: [],
                    outliersDetail: outs.map((o) => ({
                      id: o.marker_id != null ? JSON.stringify(o.marker_id) : (o.frame_id + ':' + j),
                      residual_px: o.error_px,
                      uv: o.pixel_detected || [0, 0],
                    })),
                    framePath: null,
                    qaDir,
                    sessionJson: sess.session_json_path,
                  };
                });
              }
              if (rms != null) solveState = rms < 2 ? 'ok' : 'warn';
            } catch (e) { /* 未求解或无 qa */ }
          }
          let stagePose = null;
          if (isFixed && sess.stage_pose_ready) {
            stagePose = sess.stage_pose || null;
            const poseRms = stagePose && stagePose.rms_reprojection_px != null
              ? Number(stagePose.rms_reprojection_px) : null;
            if (poseRms != null && !Number.isNaN(poseRms)) {
              rms = poseRms;
              solveState = poseRms < 2 ? 'ok' : 'warn';
            } else {
              solveState = 'ok';
            }
          } else if (isFixed && sess.stage_pose && sess.stage_pose.stale === true) {
            /* stale artifact 不算 formal（不进 AR/export），但要进 QSP 状态机
               → 右栏 stale 指引卡「请重新采集」。 */
            stagePose = sess.stage_pose;
            solveState = 'none';
          }
          return {
            id: sess.id, label: sess.id,
            time: sess.modified_at ? String(sess.modified_at).replace('T', ' ').slice(0, 16) : '—',
            method: 'qsp', mode: isFixed ? 'fixed' : 'tracked',
            solveState, rms, conf, poseCount: poses.length || n,
            sessionDir: sess.session_dir,
            sessionJson: sess.session_json_path,
            outputDir: qaDir,
            modeFixed: isFixed,
            stagePose,
            /* fixed_observation_result.v1 全量（五分区 report 数据源）+ 采集时 framing */
            fixedObservation: sess.fixed_observation || null,
            framing: sess.framing || null,
            artifactStatus: sess.stage_pose_status || 'missing',
            error: sess.error || sess.intrinsics_error || null,
            cameraId: sess.camera_id || null,
            lensJson: sess.lens_json || null,
            intrinsics: sess.intrinsics || null,
            intrinsicsError: sess.intrinsics_error || null,
            targets: (sess.targets || []).map((target) => ({
              id: target.id || '',
              screenJson: target.screenJson || target.path || '',
              code: target.code != null ? target.code : (target.screen_id || 0),
              offset: target.offset != null ? target.offset : (target.cab_col_offset || 0),
            })).filter((target) => !!target.screenJson),
            poses,
          };
        }));
        setLiveRuns(runs);
        setSessionsErr(null);
      } catch (e) {
        setSessionsErr(e && e.message ? e.message : String(e));
        setLiveRuns([]);
      }
    };
    useEffect(() => { void refreshSessions(); }, [outDir]);

    /* 从「求解结果报告」回大窗：自动选中机位并打开 AR 叠加 */
    useEffect(() => {
      if (s.capArReq) {
        if (s.capArReq.cam) {
          setCamId(s.capArReq.cam);
          s.setCapCam(s.capArReq.cam);
          if (window.camStore) window.camStore.select(s.capArReq.cam);
        }
        setArOn(true);
        setArPanelOpen(true);
        if (s.setCapArReq) s.setCapArReq(null);
      }
    }, [s.capArReq]);

    useEffect(() => {
      if (!arPanelOpen) return undefined;
      const d = (e) => { if (arBtnRef.current && !arBtnRef.current.contains(e.target)) setArPanelOpen(false); };
      document.addEventListener('mousedown', d);
      return () => document.removeEventListener('mousedown', d);
    }, [arPanelOpen]);

    /* 当前机位 AR 可用性：固定=本机位 stage_pose；追踪=result.json + session */
    const fixedRunsForCam = (liveRuns || []).filter((r) => (
      (r.modeFixed || r.mode === 'fixed') && r.stagePose
      && r.cameraId === camId
    ));
    /* QSP 报告选中的 run：本窗口最近求解的优先，否则该机位最新已求解 run */
    const qspRun = (qspRunId && fixedRunsForCam.find((r) => r.id === qspRunId)) || fixedRunsForCam[0] || null;
    const fixedSolvedRun = qspRun;
    const lensLiveSnap = CX().lensStore ? CX().lensStore.get() : null;
    const trackedSolve = lensLiveSnap && lensLiveSnap.solveResult ? lensLiveSnap.solveResult : null;
    const trackedSolvedRun = (liveRuns || []).find((r) => (
      !r.modeFixed && r.mode !== 'fixed' && r.sessionJson
      && (r.solveState === 'ok' || r.solveState === 'warn')
    ));
    const arTrackedPaths = trackedSolve && trackedSolve.session_path && trackedSolve.result_path
      ? { session: trackedSolve.session_path, result: trackedSolve.result_path }
      : (trackedSolvedRun
        ? {
            session: trackedSolvedRun.sessionJson,
            result: joinPath(trackedSolvedRun.outputDir || joinPath(trackedSolvedRun.sessionDir, 'output'), 'result.json'),
          }
        : null);
    const arAvail = tracked
      ? (!!arTrackedPaths && !capturing)
      : !!fixedSolvedRun;
    const arLockHint = tracked
      ? (capturing
        ? '采集中无法同时启动 AR 验证流（设备独占）'
        : (!arTrackedPaths
          ? '追踪机位需已有 result.json（先完成求解）；当前无可用路径'
          : null))
      : (fixedSolvedRun ? null : '当前机位尚未求解 · 请先完成求解');

    /* 固定机位：静帧 perimeter/grid 自动验收通过后才进入 AR overlay */
    const [arStaticOk, setArStaticOk] = useState(false);
    useEffect(() => {
      if (!arOn || tracked || !fixedSolvedRun) {
        if (!tracked) {
          setArGrid(null);
          setArStaticOk(false);
        }
        return undefined;
      }
      let alive = true;
      setArErr(null);
      setArStaticOk(false);
      (async () => {
        try {
          if (!fixedSolvedRun.targets || !fixedSolvedRun.targets.length) {
            throw new Error('该 run 缺少 screen target，无法投影柜格');
          }
          const posePath = joinPath(fixedSolvedRun.sessionDir, 'stage_pose.json');
          const sl = (fixedSolvedRun.stagePose && fixedSolvedRun.stagePose.session_lens)
            || (fixedSolvedRun.fixedObservation && fixedSolvedRun.fixedObservation.session_lens)
            || null;
          const solveKind = (fixedSolvedRun.fixedObservation && fixedSolvedRun.fixedObservation.solve_kind)
            || (fixedSolvedRun.stagePose && fixedSolvedRun.stagePose.solve_kind)
            || null;
          /* Joint AR must use session_lens intrinsics — never prefer Master lensJson. */
          const isJoint = solveKind === 'joint_single_observation'
            || !!(sl && sl.session_coupled);
          const sessionIntrinsics = (sl && sl.K && sl.K.length >= 2)
            ? {
                fx: Number(sl.K[0][0]),
                fy: Number(sl.K[1][1]),
                cx: Number(sl.K[0][2]),
                cy: Number(sl.K[1][2]),
                dist_coeffs: sl.dist_coeffs || [0, 0, 0, 0, 0],
                image_size: sl.image_size,
              }
            : null;
          let lensPath = null;
          let intrinsics = null;
          if (fixedSolvedRun.stagePose && fixedSolvedRun.stagePose.stale === true) {
            throw new Error('Stage pose fingerprint stale · 请重新采集（对焦/变焦需用户确认未变）');
          }
          if (isJoint) {
            if (!sessionIntrinsics) {
              throw new Error('joint formal run 缺少 session lens，禁止作为 AR source');
            }
            intrinsics = sessionIntrinsics;
          } else {
            /* known-lens / fixed_extrinsics_only: Master lensJson is the source of truth. */
            lensPath = fixedSolvedRun.lensJson || null;
            if (!lensPath) {
              if (!sessionIntrinsics) {
                throw new Error('该 formal run 缺少 Master Lens 或 session lens，禁止作为 AR source');
              }
              intrinsics = sessionIntrinsics;
            }
          }
          const grid = await trackerFreeGrid({
            targets: fixedSolvedRun.targets,
            posePath,
            lensPath,
            intrinsics,
          });
          if (alive) {
            setArGrid(grid);
            setArStaticOk(true);
            s.pushLog({
              lv: 'ok', cat: 'lens',
              msg: 'Static validation · perimeter/grid 投影通过 · 可查看静帧 AR（live preview 需另行开启）',
            });
          }
        } catch (e) {
          if (alive) {
            setArGrid(null);
            setArStaticOk(false);
            setArErr(e && e.message ? e.message : String(e));
            s.pushLog({ lv: 'err', cat: 'lens', msg: 'AR 网格加载失败 · ' + (e && e.message ? e.message : e) });
          }
        }
      })();
      return () => { alive = false; };
    }, [arOn, tracked, fixedSolvedRun && fixedSolvedRun.id, fixedSolvedRun && fixedSolvedRun.sessionDir]);

    /* ---------- 固定机位 · VP-QSP 8 状态机（真实信号推导，无演示态） ----------
       idle → capturing → solving → formal_ok / warn / fail_closed / unobservable
       + stale（artifact 标记 fingerprint 失效）+ attest（复用历史 joint 结果前需人工确认 focus/zoom） */
    const qspState = (() => {
      if (!isQspFixed) return 'idle';
      if (capturing) return 'capturing';
      if (solvingId) return 'solving';
      if (qspFail) return qspFail.code === 'SINGLE_VIEW_UNOBSERVABLE' ? 'unobservable' : 'fail_closed';
      if (qspDismissed) return 'idle';
      if (qspRun && qspRun.stagePose) {
        if (qspRun.stagePose.stale === true) return 'stale';
        const sl = qspRun.stagePose.session_lens;
        const coupled = !!(sl && sl.session_coupled);
        /* 历史 joint 结果（非本窗口求解）：复用 session lens 前必须 attest（Spec §6.2） */
        if (coupled && !sessionSolvedRef.current.has(qspRun.id) && !attestedRunsRef.current.has(qspRun.id)) return 'attest';
        const runRms = Number(qspRun.stagePose.rms_reprojection_px);
        return Number.isFinite(runRms) && runRms >= 2 ? 'warn' : 'formal_ok';
      }
      return 'idle';
    })();
    const qspSolved = qspState === 'formal_ok' || qspState === 'warn';
    /* 静帧 AR 门控：verifying（trackerFreeGrid 进行中）→ passed / failed（真实投影结果） */
    const startArVerify = () => {
      if (!qspSolved) return;
      setArPanelOpen(false);
      setArStage(arStaticOk && arOn ? 'passed' : 'verifying');
      if (!arOn) setArOn(true);
    };
    useEffect(() => {
      if (!isQspFixed || arStage !== 'verifying') return;
      if (arErr) setArStage('failed');
      else if (arStaticOk) setArStage('passed');
    }, [isQspFixed, arStage, arStaticOk, arErr]);
    /* run 变化 / 关叠加：门控回 idle */
    useEffect(() => { setArStage('idle'); }, [qspRun && qspRun.id]);
    useEffect(() => { if (!arOn && arStage !== 'idle') setArStage('idle'); }, [arOn]);
    /* 换机位：QSP 瞬态全部复位（报告选中 / 驳回 / 失败态） */
    useEffect(() => {
      setQspRunId(null);
      setQspDismissed(false);
      setQspFail(null);
      setArStage('idle');
    }, [camId]);
    const confirmAttest = () => {
      if (!qspRun) return;
      attestedRunsRef.current.add(qspRun.id);
      setAttestTick((t) => t + 1);
      s.pushLog({ lv: 'ok', cat: 'lens', msg: 'attest · 对焦/变焦未变 → 复用 session lens（' + qspRun.label + '）' });
    };
    const qspRecapture = () => {
      setQspFail(null);
      setQspDismissed(true);
      setArStage('idle');
      setArOn(false);
    };
    const qspOpenLivePreview = () => {
      /* 固定机位：位姿静态，静帧通过后 AR 叠加直接保持在实时监看画面上 */
      if (!arOn) setArOn(true);
      s.pushLog({ lv: 'info', cat: 'lens', msg: '开启 live preview 叠加（静帧 perimeter/grid 已过 · 固定机位位姿静态）' });
    };

    /* 追踪机位：verify live --grid，订阅 overlay_grid + tracking 状态 */
    const wantArLive = arOn && tracked && !capturing && arAvail && !!arTrackedPaths;
    useEffect(() => {
      if (!wantArLive || !arTrackedPaths || !profile) {
        if (arLiveTaskRef.current) {
          void cancelSidecarTask(arLiveTaskRef.current);
          arLiveTaskRef.current = null;
          setArLiveTaskId(null);
        }
        setArLiveUrl(null);
        setArLost(false);
        if (tracked) setArGrid(null);
        return undefined;
      }
      let cancelled = false;
      setArErr(null);
      (async () => {
        try {
          const args = [
            'verify', 'live',
            '--config', arTrackedPaths.session,
            '--result', arTrackedPaths.result,
            '--backend', profile.videoBackend || 'uvc',
            '--device', String(profile.device || '0'),
            '--track-protocol', profile.trackProtocol || trackSignal || 'freed',
            '--track-host', (profile.trackHost || '0.0.0.0'),
            '--track-port', String(profile.trackPort || 6301),
            '--tolerance', '0.05', '--preview-port', '0', '--duration', '0',
            '--grid', '--output', 'ndjson',
          ];
          if ((profile.trackProtocol || trackSignal) === 'freed' && profile.trackCameraId != null) {
            args.push('--track-camera-id', String(profile.trackCameraId));
          }
          if (profile.fmtMode === 'manual' && profile.width) args.push('--width', String(profile.width));
          if (profile.fmtMode === 'manual' && profile.height) args.push('--height', String(profile.height));
          if (profile.fmtMode === 'manual' && profile.fps) args.push('--fps', String(profile.fps));
          args.push('--transfer-function', profile.transferFunction || 'sdr');
          const r = await spawnSidecarStreaming('vpcal', args);
          if (cancelled) { void cancelSidecarTask(r.task_id); return; }
          arLiveTaskRef.current = r.task_id;
          setArLiveTaskId(r.task_id);
          s.pushLog({ lv: 'info', cat: 'lens', msg: 'AR 叠加 · 启动 <b>vpcal verify live --grid</b>' });
        } catch (e) {
          if (!cancelled) {
            setArErr(e && e.message ? e.message : String(e));
            setArOn(false);
            s.pushLog({ lv: 'err', cat: 'lens', msg: 'AR 实时叠加启动失败 · ' + (e && e.message ? e.message : e) });
          }
        }
      })();
      return () => {
        cancelled = true;
        if (arLiveTaskRef.current) {
          void cancelSidecarTask(arLiveTaskRef.current);
          arLiveTaskRef.current = null;
        }
        setArLiveTaskId(null);
        setArLiveUrl(null);
      };
    }, [wantArLive, arAvail, arTrackedPaths && arTrackedPaths.result, arTrackedPaths && arTrackedPaths.session, profile && profile.id, capturing]);

    useEffect(() => {
      if (!arLiveTaskId) return;
      const parsed = arLiveStream.state.lines.map((l) => l.parsed).filter((p) => p && typeof p.type === 'string');
      const preview = [...parsed].reverse().find((p) => p.type === 'preview_ready');
      if (preview && preview.mjpeg_url) setArLiveUrl(preview.mjpeg_url);
      const gridEv = [...parsed].reverse().find((p) => p.type === 'overlay_grid');
      if (gridEv && (gridEv.screens || (gridEv.data && gridEv.data.screens))) {
        setArGrid({
          screens: gridEv.screens || gridEv.data.screens,
          image_size: gridEv.image_size || (gridEv.data && gridEv.data.image_size) || [1920, 1080],
        });
      }
      const stats = [...parsed].reverse().find((p) => p.type === 'live_stats');
      if (stats && typeof stats.tracking_connected === 'boolean') {
        setArLost(!stats.tracking_connected);
      }
      const warn = [...parsed].reverse().find((p) => p.type === 'warning'
        && p.message && String(p.message).toLowerCase().indexOf('track') >= 0);
      if (warn) setArLost(true);
    }, [arLiveStream.state.lines, arLiveTaskId]);

    useEffect(() => () => {
      if (arLiveTaskRef.current) void cancelSidecarTask(arLiveTaskRef.current);
    }, []);

    /* 整窗缩放（边缘 / 角落手柄，作用于 .modal-host） */
    const onResize = (dx, dy) => (e) => {
      e.preventDefault(); e.stopPropagation();
      const host = rootRef.current && rootRef.current.parentElement; if (!host) return;
      const r = host.getBoundingClientRect(); const sw = r.width, sh = r.height, sx = e.clientX, sy = e.clientY;
      const move = (ev) => {
        host.style.width = clamp(sw + dx * 2 * (ev.clientX - sx), 860, window.innerWidth - 24) + 'px';
        host.style.height = clamp(sh + dy * 2 * (ev.clientY - sy), 480, window.innerHeight - 24) + 'px';
      };
      const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.body.style.cursor = ''; };
      document.body.style.cursor = getComputedStyle(e.currentTarget).cursor;
      document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
    };
    const onSplit = (e) => {
      e.preventDefault();
      const body = rootRef.current && rootRef.current.querySelector('.lc-body'); if (!body) return;
      const rect = body.getBoundingClientRect(); const sx = e.clientX, sp = leftPct;
      const move = (ev) => setLeftPct(clamp(sp + ((ev.clientX - sx) / rect.width) * 100, 38, 78));
      const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.body.style.cursor = ''; };
      document.body.style.cursor = 'col-resize';
      document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
    };

    /* stills NDJSON：snap 计数 + 达目标自动 finish + 完成（result 只处理一次） */
    useEffect(() => {
      if (!stillsTaskId || !capturing || tracked) return;
      let snaps = 0;
      for (let i = 0; i < (stillsStream.state.lines || []).length; i++) {
        const line = stillsStream.state.lines[i];
        const p = line.parsed;
        if (!p) continue;
        if (p.type === 'snap_saved') snaps = Math.max(snaps, (p.index != null ? p.index + 1 : snaps + 1));
        /* Framing 数据源：最新非 stale 检测帧（cabinets 三元组 + 画面 bbox） */
        if (p.type === 'detect_state' && !p.stale && Array.isArray(p.cabinets)) {
          lastDetectRef.current = {
            markers: typeof p.markers === 'number' ? p.markers : null,
            cabinets: p.cabinets.map((c) => [c[0] | 0, c[1] | 0, c[2] | 0]),
            bbox: Array.isArray(p.bbox_frac) && p.bbox_frac.length >= 4 ? p.bbox_frac : null,
          };
        }
        if (p.type === 'result' && p.data) {
          const key = stillsTaskId + ':result:' + i;
          if (stillsResultHandledRef.current.has(key)) continue;
          stillsResultHandledRef.current.add(key);
          const dir = stillsOutRef.current || (p.data.session_dir);
          const fixedInput = fixedInputRef.current || {};
          if (fixedInput.purpose === 'master_lens') {
            fixedInputRef.current = null;
            s.setCapState('idle');
            setStillsTask(null);
            void playerClear().catch(() => {});
            if (s.setDeployState && s.deployState !== 'idle') s.setDeployState('standby');
            const imagesDir = joinPath(dir, 'captures/normal');
            const target = fixedInput.targets && fixedInput.targets[0];
            s.pushLog({
              lv: 'info', cat: 'lens',
              msg: 'Master lens multi-view 采集完成 · <b>' + (p.data.frames_captured || snaps)
                + '</b> poses · 正在求解镜头…',
            });
            setMasterLensBusy(true);
            void (async () => {
              try {
                if (!target || !fixedInput.masterLensOut) {
                  throw new Error('master lens capture 缺少 screen target 或输出路径');
                }
                await trackerFreeLensCal({
                  imagesDir,
                  screenPath: target.screenJson,
                  outLensJson: fixedInput.masterLensOut,
                  cabColOffset: target.offset,
                  screenId: target.code,
                });
                await installMasterLens(fixedInput.masterLensOut);
                s.pushLog({
                  lv: 'ok', cat: 'lens',
                  msg: 'Master lens 已生成 · 请锁定 focus/zoom/resolution/crop，'
                    + '把相机放回最终固定机位后重新进行单帧采集',
                });
              } catch (e) {
                s.pushLog({
                  lv: 'err', cat: 'lens',
                  msg: 'Master lens qualification failed · ' + (e && e.message ? e.message : e)
                    + ' · 原始 multi-view images 已保留，可补采后从文件夹重新生成',
                });
              } finally {
                setMasterLensBusy(false);
                void refreshSessions();
              }
            })();
            continue;
          }
          const meta = {
            mode: 'fixed', frames_captured: p.data.frames_captured || snaps,
            camera_id: fixedInput.cameraId || camId,
            screen: fixedInput.screenFile || screenFile, method: 'qsp',
            targets: (fixedInput.targets || []).map((target) => ({
              id: target.id, screenJson: target.screenJson,
              code: target.code, offset: target.offset,
            })),
          };
          if (!fixedInput.lensPath) {
            try {
              meta.intrinsics = capturePixelIntrinsics(fixedInput.lens || {}, p.data.source || {});
            } catch (e) {
              /* joint session lens 求解不依赖 capture-time intrinsics（fixed-observation
                 自估焦距/畸变）——记录但不阻断。 */
              meta.intrinsics_error = e && e.message ? e.message : String(e);
            }
          }
          /* Framing score（取景构图评分 · 独立于 Geometry RMS）——来自采集时最后一帧
             真实 detect_state；无检测数据则不写（UI 显示 —，不造值）。 */
          const framing = computeQspFraming(meta.targets);
          if (framing) meta.framing = framing;
          fixedInputRef.current = null;
          const lensSource = fixedInput.lensSnapshotted ? null : (fixedInput.lensPath || null);
          const autoRunId = String(dir).split(/[\\/]+/).filter(Boolean).pop() || 'fixed';
          const autoRun = {
            id: autoRunId, label: autoRunId, sessionDir: dir,
            poseCount: meta.frames_captured, cameraId: meta.camera_id,
            lensJson: fixedInput.lensPath ? joinPath(dir, 'lens.json') : null,
            targets: meta.targets, modeFixed: true, mode: 'fixed',
            framing: framing || null,
          };
          void writeFixedRunMetaSafe(dir, meta, lensSource).then((writeError) => {
            if (writeError) {
              s.pushLog({ lv: 'err', cat: 'lens', msg: '固定机位采集已保存，但 intrinsics snapshot 失败 · ' + writeError });
            } else if (meta.intrinsics_error && !isQspFixed) {
              s.pushLog({ lv: 'err', cat: 'lens', msg: '固定机位采集已保存，但无法求解 · ' + meta.intrinsics_error });
            } else if (meta.intrinsics && meta.intrinsics.physical_snapshot
              && meta.intrinsics.physical_snapshot.crop_mode !== 'none') {
              const snap = meta.intrinsics.physical_snapshot;
              s.pushLog({
                lv: 'warn', cat: 'lens',
                msg: '采集画幅与完整 sensor 比例不同 · 已按 centered crop 推导 active sensor <b>'
                  + Number(snap.active_sensor_width_mm).toFixed(3) + ' × '
                  + Number(snap.active_sensor_height_mm).toFixed(3) + ' mm</b>',
              });
            }
            return refreshSessions().then(() => {
              /* QSP 固定机位：capturing → solving 自动衔接（单次采集动作即得可用 Stage pose） */
              if (isQspFixed && !writeError) void solveFixedRun(autoRun);
            });
          });
          s.setCapState('idle');
          setStillsTask(null);
          void playerClear().catch(() => {});
          if (s.setDeployState && s.deployState !== 'idle') s.setDeployState('standby');
          s.pushLog({ lv: 'ok', cat: 'lens', msg: '固定机位采集完成 · ' + (p.data.frames_captured || snaps) + ' 帧 · <b>' + dir + '</b>' });
        }
      }
      setStillsSnapN(snaps);
      if (snaps >= targetM && stillsTaskId && !stillsFinishingRef.current) {
        stillsFinishingRef.current = true;
        void stillsFinish(stillsTaskId);
      }
      if (stillsStream.state.exit && stillsStream.state.exit.fatal) {
        s.setCapState('idle');
        setStillsTask(null);
        s.pushLog({ lv: 'err', cat: 'lens', msg: '固定机位采集异常 · ' + (stillsStream.state.exit.stderr_tail || '') });
      }
    }, [stillsTaskId, capturing, tracked, stillsStream.state.lines, stillsStream.state.exit, targetM]);

    /* 采集中：点位横幅轮转（示意引导）+ 真实 pose / stills 计数 */
    const cov = capturing && tracked && window.VOLO_CAPTURE && window.VOLO_CAPTURE.recomputeCoverage
      ? window.VOLO_CAPTURE.recomputeCoverage(session) : null;
    const capN = tracked ? (cov ? cov.poseCount : 0) : stillsSnapN;
    const stillsPreview = (() => {
      if (tracked || !capturing) return null;
      for (let i = (stillsStream.state.lines || []).length - 1; i >= 0; i--) {
        const p = stillsStream.state.lines[i].parsed;
        if (p && p.type === 'preview_ready' && p.mjpeg_url) return p.mjpeg_url;
      }
      return null;
    })();
    const previewUrl = capturing
      ? (tracked ? ((session.latest('preview_ready') || {}).mjpeg_url || null) : stillsPreview)
      : monitor.url;
    const hudFmt = monitor.fmt
      ? (monitor.fmt.res + ' · ' + monitor.fmt.fps + 'fps')
      : (profile ? ((BACKEND_LABEL[backend] || backend) + ' · 设备' + profile.device) : '—');

    useEffect(() => {
      if (!capturing || !isSl) { clearInterval(timer.current); return undefined; }
      timer.current = setInterval(() => setSlFrame((f) => (f + 1) % CAL_SL_SEQ.frames), 260);
      return () => clearInterval(timer.current);
    }, [capturing, isSl]);
    useEffect(() => {
      if (!capturing || isSl) return undefined;
      timer.current = setInterval(() => setBanner((b) => (b + 1) % CAP_BANNERS.length), 1200);
      return () => clearInterval(timer.current);
    }, [capturing, isSl]);

    /* request_pattern → 按部署通道切图（仅追踪 session） */
    useEffect(() => {
      if (!capturing || !tracked) return;
      for (const ev of session.events) {
        if (ev.type !== 'request_pattern' || typeof ev.sequence !== 'number') continue;
        if (patternAckSeq.current.has(ev.sequence)) continue;
        const pattern = String(ev.pattern || 'normal');
        patternAckSeq.current.add(ev.sequence);
        (async () => {
          try {
            /* 按部署通道把同名图案同步推到全部选中屏幕。 */
            await showViaDeploy(s, ag.targets, pattern);
            await session.sendCmd({ cmd: 'pattern_ready', pattern });
            if (s.setDeployState) s.setDeployState('showing');
          } catch (e) {
            patternAckSeq.current.delete(ev.sequence);
            s.pushLog({ lv: 'err', cat: 'lens', msg: '切图失败 · ' + (e && e.message ? e.message : e) });
          }
        })();
      }
    }, [capturing, session.events, ag.targets]);

    useEffect(() => {
      if (!capturing || !tracked) return;
      const res = session.latest('result');
      if (res && res.data) {
        if (trackedResultHandledRef.current) return;
        trackedResultHandledRef.current = true;
        s.setCapState('idle');
        if (CX().lensStore) CX().lensStore.patch({ phase: 'captured' });
        s.pushLog({ lv: 'ok', cat: 'lens', msg: '采集完成 · ' + res.data.poses_captured + ' 点位 · <b>' + res.data.session_dir + '</b>' });
        void playerClear().catch(() => {});
        if (s.setDeployState && s.deployState !== 'idle') s.setDeployState('standby');
        void refreshSessions();
      }
    }, [capturing, tracked, session.events]);
    useEffect(() => {
      if (!capturing || !tracked) return;
      if (session.spawnError) {
        s.setCapState('idle');
        s.pushLog({ lv: 'err', cat: 'lens', msg: '采集启动失败 · ' + session.spawnError });
      }
      const exit = session.state.exit;
      if (exit && !exit.cancelled && exit.fatal) {
        s.setCapState('idle');
        s.pushLog({ lv: 'err', cat: 'lens', msg: '采集异常退出 · ' + (exit.stderr_tail || ('exit ' + exit.exit_code)) });
      }
    }, [capturing, tracked, session.spawnError, session.state.exit]);

    const abortSlPlayback = async () => {
      const abortReq = slPlayReqRef.current;
      if (!abortReq) return;
      slPlayReqRef.current = null;
      try { await outputSequenceAbort(abortReq); } catch (e) { /* ignore */ }
    };
    const start = async () => {
      if (!ready) return;
      /* 公共入口护栏（fixed / tracked / SL 三分支共用）：从点击到 capState 落定之间
         隔着推图 + monitor.stop 两个异步步骤（真机约 2.5s），期间再点会完整跑第二遍、
         第二个会话独占设备并把第一个变孤儿——ref 同帧生效，state 禁用按钮 */
      if (startingRef.current || capturing) return;
      startingRef.current = true;
      setStarting(true);
      try {
      saveCapParams(params);
      patternAckSeq.current.clear();
      stillsResultHandledRef.current.clear();
      trackedResultHandledRef.current = false;
      setBanner(0);
      setStillsSnapN(0);
      stillsFinishingRef.current = false;
      /* QSP：新采集开始 → 清失败态 / 报告驳回态 / 静帧门控 / framing 数据源 */
      lastDetectRef.current = null;
      setQspFail(null);
      setQspDismissed(false);
      setArStage('idle');
      setArOn(false);

      /* —— 结构光 × nDisplay：逐屏顺序 生成→录像→播放→解码（相机不动），
         合并全部屏幕对应关系后一次 fixed-observation-sl 求解 —— */
      if (isSl) {
        const proj = CX().projStore ? CX().projStore.get() : null;
        if (!proj || !proj.path) {
          s.pushLog({ lv: 'err', cat: 'lens', msg: '无打开项目，无法生成结构光序列' });
          return;
        }
        const slTargets = ag.targets;
        if (!slTargets.length) {
          s.pushLog({ lv: 'err', cat: 'lens', msg: '未选标定屏幕' });
          return;
        }
        const topology = window.resolveProjectTopology && window.resolveProjectTopology(proj.config);
        const outputScreen = topology
          ? window.stageScreenForOutput(proj.config, topology)
          : (proj.config && proj.config.screens[slTargets[0].id]);
        if (!outputScreen) {
          s.pushLog({ lv: 'err', cat: 'lens', msg: '无可用输出屏幕' });
          return;
        }
        await monitor.stop();
        s.setCapState('capturing');
        if (CX().lensStore) CX().lensStore.patch({ phase: 'capturing', screenPath: screenFile });
        s.setCapTrack('fixed');
        const sessionOut = joinPath(outDir, 'sl_' + new Date().toISOString().replace(/[:.]/g, '-'));
        let videoTaskId = null;
        try {
          const solveTargets = [];
          for (let i = 0; i < slTargets.length; i++) {
            const target = slTargets[i];
            const screenId = target.id;
            const tag = '[' + (i + 1) + '/' + slTargets.length + '] ' + screenId;
            s.pushLog({ lv: 'info', cat: 'lens', msg: '结构光 · 生成序列 · ' + tag + '…' });
            const gen = await meshVisualGenerateStructuredLight(
              proj.path, screenId, null, 6, null, false, null);
            const framesDir = joinPath(gen.output_dir, 'frames');
            const slMeta = joinPath(gen.output_dir, 'sl_meta.json');
            /* sidecar 默认 hold_ms=500 → 播放 fps=2（与 sl_meta.sequence.hold_ms 一致） */
            const fps = 2.0;
            const durationS = Math.max(12, (Number(gen.n_frames) || 12) / fps + 8);
            const videoOut = joinPath(sessionOut, 'video_' + screenId);
            s.pushLog({ lv: 'info', cat: 'lens', msg: '结构光 · 开始录像 · ' + tag + ' · <b>' + (profile.name || 'Profile') + '</b>' });
            const vArgs = ['capture', 'video',
              '--backend', profile.videoBackend, '--device', String(profile.device),
              '--duration', String(durationS), '--out', videoOut, '--output', 'json'];
            if (profile.fmtMode === 'manual') {
              if (profile.width) vArgs.push('--width', String(profile.width));
              if (profile.height) vArgs.push('--height', String(profile.height));
              if (profile.fps) vArgs.push('--fps', String(profile.fps));
            }
            if (profile.transferFunction) vArgs.push('--transfer-function', profile.transferFunction);
            const vResp = await spawnSidecarStreaming('vpcal', vArgs);
            videoTaskId = vResp.task_id;
            setStillsTask(vResp.task_id);
            /* 略等录像落盘，再起播（哨兵软同步，起点偏差无影响） */
            await new Promise((r) => setTimeout(r, 800));
            s.pushLog({ lv: 'info', cat: 'lens', msg: '结构光 · nDisplay 播放序列 · ' + tag + ' · ' + gen.n_frames + ' 帧 @ ' + fps + ' fps' });
            const screenOrigin = window.stageScreenOriginPx
              ? window.stageScreenOriginPx(proj.config.screens, screenId)
              : [0, 0];
            const playReq = {
              session_id: proj.path + '::stage',
              screen: outputScreen,
              paths: Object.assign({}, DEFAULT_NDISPLAY_OUTPUT_PATHS),
              ssh_user: null,
              sequence_dir: framesDir,
              fps,
              screen_origin_px: screenOrigin,
            };
            slPlayReqRef.current = playReq;
            await outputPlaySequence(playReq);
            slPlayReqRef.current = null;
            if (s.setDeployState) s.setDeployState('showing');
            /* finish（非 cancel）：等录像进程优雅落盘 frames.jsonl + 最后一帧再退出，
               避免 cancel 的「关 stdin 无效 → 3s grace → SIGKILL」在写入中途打断，
               decode 读到不完整帧集合却不报错静默产出错误结果。 */
            try { await finishSidecarTaskAwaitExit(videoTaskId); } catch (e) { /* ignore */ }
            videoTaskId = null;
            setStillsTask(null);
            const corrOut = joinPath(sessionOut, 'corr_' + screenId + '.json');
            s.pushLog({ lv: 'info', cat: 'lens', msg: '结构光 · 解码 · ' + tag + '…' });
            const dec = await meshVisualDecodeStructuredLight(
              videoOut, slMeta, corrOut, null, null, true);
            s.pushLog({
              lv: 'ok', cat: 'lens',
              msg: '结构光解码完成 · ' + tag + ' · <b>' + dec.n_dots_decoded + '</b> 点',
            });
            solveTargets.push({ screenJson: target.screenJson, slMeta, corr: corrOut });
          }

          s.pushLog({ lv: 'info', cat: 'lens', msg: '结构光 · fixed-observation-sl 求解 Stage pose…' });
          const fixedObsJson = joinPath(sessionOut, 'fixed_observation_result.json');
          const poseJson = joinPath(sessionOut, 'stage_pose.json');
          const mode = purpose === 'known_lens'
            ? 'known-lens'
            : (purpose === 'joint_session' ? 'joint-session-lens' : 'auto');
          const solvedObs = await trackerFreeFixedObservationSl({
            screenTargets: solveTargets,
            mode,
            lensPath: cam.masterLensPath || null,
            outPath: fixedObsJson,
            stagePoseOut: poseJson,
            cameraId: camId,
            transferPath: 'volo-stills',
            attestFocusZoom: true,
          });
          const solved = {
            ...solvedObs,
            schema_version: 'volo_stage_pose.v2',
            solve_kind: solvedObs.solve_kind === 'joint_single_observation'
              ? 'joint_single_observation'
              : 'fixed_extrinsics_only',
            qualification: {
              ...(solvedObs.qualification || {}),
              master_lens: !!(solvedObs.session_lens && solvedObs.session_lens.is_master),
              passed: !!(solvedObs.qualification && solvedObs.qualification.passed),
            },
          };
          const writeError = await writeFixedRunMetaSafe(sessionOut, {
            mode: 'fixed', frames_captured: solveTargets.length,
            camera_id: camId, method: 'sl',
            targets: slTargets.map((target) => ({ id: target.id, screenJson: target.screenJson })),
            stage_pose_json: poseJson, stage_pose: solved,
          }, null);
          if (writeError) throw new Error('无法保存结构光求解结果: ' + writeError);
          const pose = solved.camera_from_stage;
          if (pose && window.camStore) {
            const t = pose.position_mm || [0, 0, 0];
            const ptr = pose.ptr_deg || { pan: 0, tilt: 0, roll: 0 };
            window.camStore.setSolvePose(
              camId,
              [t[0], t[1], t[2]],
              [ptr.pan, ptr.tilt, ptr.roll],
              null,
              {
                formal: solved.formal === true && solved.qualification && solved.qualification.passed === true,
                source_artifact: poseJson,
                rms_reprojection_px: solved.rms_reprojection_px,
                image_size: solved.image_size,
                preflight_passed: !!(solved.preflight && solved.preflight.passed),
                schema_version: solved.schema_version,
                qualification_passed: !!(solved.qualification && solved.qualification.passed),
                master_lens: !!(solved.qualification && solved.qualification.master_lens),
                solve_kind: solved.solve_kind,
                fail_closed: !!(solved.qualification && solved.qualification.fail_closed),
              },
            );
          }
          s.setCapState('idle');
          if (CX().lensStore) CX().lensStore.patch({ phase: 'solved' });
          const solvedRms = Number(solved.rms_reprojection_px);
          const solvedState = solvedRms < 2 ? 'ok' : 'warn';
          s.pushLog({
            lv: solvedState, cat: 'lens',
            msg: '结构光固定机位求解完成 · mode=<b>' + (solvedObs.mode_resolved || mode)
              + '</b> · RMS <b>' + solvedRms.toFixed(3) + '</b> px · 屏幕 <b>'
              + slTargets.map((t) => t.id).join('、') + '</b>',
          });
          void refreshSessions();
        } catch (e) {
          await abortSlPlayback();
          if (videoTaskId) {
            try { await cancelSidecarTask(videoTaskId); } catch (e2) { /* ignore */ }
            setStillsTask(null);
          }
          s.setCapState('idle');
          s.pushLog({ lv: 'err', cat: 'lens', msg: '结构光采集失败 · ' + (e && e.message ? e.message : e) });
        }
        return;
      }

      const captureTargets = collectingMasterLens ? ag.targets.slice(0, 1) : ag.targets;
      try {
        /* 图案由系统自动生成到 ag.patternsDir（含 normal.png）；开始前先推 normal.png 上屏 */
        if (captureTargets.length) {
          await showViaDeploy(s, captureTargets, 'normal');
          if (s.setDeployState) s.setDeployState('showing');
        }
      } catch (e) {
        s.pushLog({ lv: 'err', cat: 'lens', msg: '推图失败 · ' + (e && e.message ? e.message : e) });
        return;
      }
      await monitor.stop();
      s.setCapState('capturing');
      if (CX().lensStore) CX().lensStore.patch({ phase: 'capturing', screenPath: screenFile });

      /* —— 固定机位：capture stills（无追踪）—— */
      if (trackSignal === 'none') {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const sessionOut = collectingMasterLens
          ? joinPath(lensWorkspacePaths(projectPath).vpcalDir, 'lens-captures/lens_' + stamp)
          : joinPath(outDir, 'fixed_' + stamp);
        stillsOutRef.current = sessionOut;
        fixedInputRef.current = {
          cameraId: camId,
          screenFile,
          lensPath: cam.masterLensPath || null,
          purpose: collectingMasterLens ? 'master_lens' : 'fixed_extrinsics',
          masterLensOut: collectingMasterLens
            ? joinPath(lensWorkspacePaths(projectPath).vpcalDir, 'lenses/' + camId + '.master-lens.json')
            : null,
          targets: captureTargets.map((target) => ({
            id: target.id, screenJson: target.screenJson,
            code: target.code, offset: target.offset,
          })),
        };
        s.setCapTrack('fixed');
        s.pushLog({
          lv: 'info', cat: 'lens',
          msg: collectingMasterLens
            ? ('开始 Master Lens multi-view 采集 · 目标 <b>' + targetM
              + '</b> poses · 保持 focus/zoom 不变并移动相机覆盖角度与画面边缘')
            : ('开始固定机位单帧采集 · <b>capture stills</b> · ' + (profile.name || 'Profile')),
        });
        let spawnedId = null;
        try {
          /* 换任务前先等旧任务真正退出（独占设备），护栏兜不住的残留也在这兜 */
          const prev = stillsTaskRef.current;
          if (prev) { try { await cancelSidecarTaskAwaitExit(prev); } catch (e) { /* ignore */ } }
          const resp = await startCaptureStills({
            backend: profile.videoBackend, device: String(profile.device),
            outDir: sessionOut, auto: true, minMarkers: collectingMasterLens ? 6 : 4,
            width: profile.fmtMode === 'manual' ? profile.width : null,
            height: profile.fmtMode === 'manual' ? profile.height : null,
            fps: profile.fmtMode === 'manual' ? profile.fps : null,
            transferFunction: profile.transferFunction || 'sdr',
          });
          spawnedId = resp.task_id;
          if (fixedInputRef.current && fixedInputRef.current.lensPath) {
            const snapshotError = await writeFixedRunMetaSafe(sessionOut, {
              mode: 'fixed', frames_captured: 0,
              camera_id: fixedInputRef.current.cameraId,
              screen: fixedInputRef.current.screenFile, method: 'qsp',
              targets: fixedInputRef.current.targets,
            }, fixedInputRef.current.lensPath);
            if (snapshotError) throw new Error('无法冻结 LensProfile: ' + snapshotError);
            fixedInputRef.current.lensSnapshotted = true;
          }
          setStillsTask(resp.task_id);
        } catch (e) {
          /* 本次已 spawn 的任务必须杀掉再回 idle，否则孤儿独占设备、监看永远拉不起来 */
          if (spawnedId) { try { await cancelSidecarTaskAwaitExit(spawnedId); } catch (e2) { /* ignore */ } }
          if (stillsTaskRef.current === spawnedId) setStillsTask(null);
          fixedInputRef.current = null;
          s.setCapState('idle');
          s.pushLog({
            lv: 'err', cat: 'lens',
            msg: (collectingMasterLens ? 'Master lens 采集启动失败 · ' : '固定机位启动失败 · ')
              + (e && e.message ? e.message : e),
          });
        }
        return;
      }

      /* —— 追踪机位：capture session —— */
      const sessionOut = joinPath(outDir, 'session_' + new Date().toISOString().replace(/[:.]/g, '-'));
      const camTrack = cam && cam.tracking;
      s.pushLog({ lv: 'info', cat: 'lens', msg: '开始追踪机位采集 · <b>' + (profile.name || 'Profile') + '</b>' });
      session.start({
        screenTargets: ag.targets, outDir: sessionOut,
        backend: profile.videoBackend, device: String(profile.device),
        trackProtocol: trackSignal,
        trackPort: Number((camTrack && camTrack.port) || profile.trackPort || 6301),
        trackHost: (camTrack && camTrack.host) || profile.trackHost || '0.0.0.0',
        trackCameraId: (camTrack && camTrack.camera_id != null) ? camTrack.camera_id : profile.trackCameraId,
        poses: targetM, inverted: !!params.inverted,
        graycodeSync: !!params.inverted && !!params.graycodeSync, lensPath: params.lensPath || '',
        settleMs: Number(params.settleMs), burst: Number(params.burst),
        width: profile.fmtMode === 'manual' ? profile.width : null,
        height: profile.fmtMode === 'manual' ? profile.height : null,
        fps: profile.fmtMode === 'manual' ? profile.fps : null,
        transferFunction: profile.transferFunction || 'sdr',
      });
      s.setCapTrack('connected');
      } finally {
        startingRef.current = false;
        setStarting(false);
      }
    };
    const stop = async () => {
      await abortSlPlayback();
      if (!tracked && stillsTaskId) {
        try { await stillsFinish(stillsTaskId); } catch (e) { /* ignore */ }
        try { await cancelSidecarTask(stillsTaskId); } catch (e) { /* ignore */ }
        setStillsTask(null);
      } else {
        session.cancel();
      }
      s.setCapState('idle');
      if (CX().lensStore) CX().lensStore.patch({ phase: 'captured' });
      void playerClear().catch(() => {});
      if (s.setDeployState && s.deployState === 'showing') s.setDeployState('standby');
      s.pushLog({ lv: 'ok', cat: 'lens', msg: '停止采集' });
      void refreshSessions();
    };

    const solveFixedRun = async (run) => {
      const solveTargets = (run && run.targets) || [];
      if (!run || !run.sessionDir) return;
      setSolvingId(run.id);
      setQspFail(null);
      setQspDismissed(false);
      try {
        if (!solveTargets.length) {
          throw new Error('该固定机位 run 缺少采集时 screen target snapshot，不能使用当前屏幕选择代替');
        }
        let writeCameraId = run.cameraId;
        if (!writeCameraId) {
          throw new Error('该固定机位 run 缺少采集时 camera ownership，不能写回当前摄影机');
        }
        if (!(camSnap.cameras || []).some((camera) => camera.id === writeCameraId)) {
          /* 常见于 shell 曾默认 capCam=cam1（演示 id）写进 fixed_run，而项目机位是 cam-01。
             求解仍可用采集时 intrinsics；位姿写回到当前存在的机位并订正 meta。 */
          const fallback = (camSnap.cameras || []).find((c) => c.id === camId)
            || (camSnap.cameras || []).find((c) => c.id === camSnap.selectedId)
            || (camSnap.cameras || [])[0];
          if (!fallback) {
            throw new Error('采集该 run 的摄影机已不存在，无法安全写回 Stage pose');
          }
          s.pushLog({
            lv: 'warn', cat: 'lens',
            msg: 'run 绑定摄影机 <b>' + writeCameraId + '</b> 已不存在 · 改写到 <b>'
              + (fallback.name || fallback.id) + '</b>',
          });
          writeCameraId = fallback.id;
        }
        const images = joinPath(run.sessionDir, 'captures/normal');
        const firstPng = joinPath(images, '000000.png');
        const poseJson = joinPath(run.sessionDir, 'stage_pose.json');
        const fixedObsJson = joinPath(run.sessionDir, 'fixed_observation_result.json');
        const mode = purpose === 'known_lens'
          ? 'known-lens'
          : (purpose === 'joint_session' ? 'joint-session-lens' : 'auto');
        if (mode === 'known-lens' && !run.lensJson) {
          const error = new Error('使用 Master Lens 模式需要 qualified master lens snapshot');
          error.code = 'MASTER_LENS_REQUIRED';
          throw error;
        }
        s.pushLog({
          lv: 'info', cat: 'lens',
          msg: '固定机位 · 单次校正 · <b>fixed-observation</b> · mode=' + mode + '…',
        });
        const solvedObs = await trackerFreeFixedObservation({
          imagePath: firstPng,
          targets: solveTargets,
          mode,
          lensPath: run.lensJson || null,
          outPath: fixedObsJson,
          stagePoseOut: poseJson,
          cameraId: writeCameraId,
          transferPath: 'volo-stills',
          attestFocusZoom: true,
        });
        const solved = {
          ...solvedObs,
          camera_from_stage: solvedObs.camera_from_stage,
          rms_reprojection_px: solvedObs.rms_reprojection_px,
          formal: solvedObs.formal,
          solve_kind: solvedObs.solve_kind === 'joint_single_observation'
            ? 'joint_single_observation'
            : 'fixed_extrinsics_only',
          schema_version: 'volo_stage_pose.v2',
          qualification: {
            ...(solvedObs.qualification || {}),
            master_lens: !!(solvedObs.session_lens && solvedObs.session_lens.is_master),
            passed: !!(solvedObs.qualification && solvedObs.qualification.passed),
          },
        };
        const pose = solved.camera_from_stage;
        const writeError = await writeFixedRunMetaSafe(run.sessionDir, {
          mode: 'fixed', frames_captured: run.poseCount,
          camera_id: writeCameraId, method: 'qsp',
          targets: solveTargets.map((target) => ({
            id: target.id, screenJson: target.screenJson,
            code: target.code, offset: target.offset,
          })),
          stage_pose_json: poseJson, stage_pose: solved,
        });
        if (writeError) throw new Error('无法保存固定机位求解结果: ' + writeError);
        if (pose && window.camStore) {
          const t = pose.position_mm || [0, 0, 0];
          const ptr = pose.ptr_deg || { pan: 0, tilt: 0, roll: 0 };
          window.camStore.setSolvePose(
            writeCameraId,
            [t[0], t[1], t[2]],
            [ptr.pan, ptr.tilt, ptr.roll],
            null,
            {
              formal: solved.formal === true && solved.qualification && solved.qualification.passed === true,
              source_artifact: poseJson,
              rms_reprojection_px: solved.rms_reprojection_px,
              image_size: solved.image_size,
              preflight_passed: !!(solved.preflight && solved.preflight.passed),
              schema_version: solved.schema_version,
              qualification_passed: !!(solved.qualification && solved.qualification.passed),
              master_lens: !!(solved.qualification && solved.qualification.master_lens),
              solve_kind: solved.solve_kind,
              fail_closed: !!(solved.qualification && solved.qualification.fail_closed),
            },
          );
        }
        s.setCalLensState('done');
        if (CX().lensStore) CX().lensStore.patch({ phase: 'solved' });
        const solvedRms = Number(solved.rms_reprojection_px);
        const solvedState = solvedRms < 2 ? 'ok' : 'warn';
        const screensLabel = (solvedObs.detection && solvedObs.detection.per_screen)
          ? Object.keys(solvedObs.detection.per_screen).join('、')
          : (solveTargets.map((t) => t.id || t.screenJson).join('、') || '—');
        const sessionNote = solvedObs.session_lens && solvedObs.session_lens.session_coupled
          ? ' · 当前焦距/对焦/分辨率有效 · 非 Master Lens'
          : '';
        s.pushLog({
          lv: solvedState, cat: 'lens',
          msg: '固定机位单次校正完成 · mode=<b>' + (solvedObs.mode_resolved || mode)
            + '</b> · RMS <b>' + solvedRms.toFixed(3)
            + '</b> px · 屏幕 <b>' + screensLabel + '</b>' + sessionNote,
        });
        if (solvedObs.observability) {
          const failed = solvedObs.observability.failed || [];
          s.pushLog({
            lv: failed.length ? 'warn' : 'ok', cat: 'lens',
            msg: 'Lens observability · '
              + (failed.length ? ('failed: ' + failed.join(', ')) : 'gates passed')
              + (solvedObs.model_level ? (' · model ' + solvedObs.model_level) : ''),
          });
        }
        const detectionText = Object.entries((solvedObs.detection && solvedObs.detection.per_screen) || {})
          .map(([label, count]) => label + ' trustworthy ' + count)
          .join(' | ');
        if (detectionText) s.pushLog({ lv: 'ok', cat: 'lens', msg: 'Detection · ' + detectionText });
        /* QSP 状态机：本窗口新求解的 run 无需 attest；报告选中该 run */
        sessionSolvedRef.current.add(run.id);
        setQspRunId(run.id);
        setQspDismissed(false);
        setArStage('idle');
        setLiveRuns((prev) => {
          const list = prev || [];
          const patch = {
            solveState: solvedState,
            rms: solvedRms,
            stagePose: solved,
            artifactStatus: 'formal',
            solveError: null,
            fixedObservation: solvedObs,
          };
          if (!list.some((r) => r.id === run.id)) {
            /* 采集→自动求解可能先于 refreshSessions 回来：先插入占位 run，随后被磁盘扫描覆盖 */
            return [Object.assign({}, run, patch), ...list];
          }
          return list.map((r) => (r.id === run.id ? Object.assign({}, r, patch) : r));
        });
        void refreshSessions();
      } catch (e) {
        const msg = fixedSolveFailure(e);
        s.pushLog({ lv: 'err', cat: 'lens', msg: '固定机位求解失败 · ' + msg });
        const code = (e && e.code)
          || (String(msg).includes('SINGLE_VIEW_UNOBSERVABLE') ? 'SINGLE_VIEW_UNOBSERVABLE' : null);
        if (code === 'SINGLE_VIEW_UNOBSERVABLE') {
          s.pushLog({
            lv: 'info', cat: 'lens',
            msg: '建议：①增加非共面 screen coverage → ②改用 Structured Light → ③导入/建立 Master Lens',
          });
        }
        /* QSP fail-closed / unobservable 指引条（右栏结果区） */
        setQspFail({ code, message: e && e.message ? e.message : String(e) });
        setLiveRuns((prev) => (prev || []).map((r) => (
          r.id === run.id ? Object.assign({}, r, { solveError: msg }) : r
        )));
      } finally {
        setSolvingId(null);
      }
    };

    const solveRun = (run) => {
      if (run.modeFixed || run.mode === 'fixed') {
        void solveFixedRun(run);
        return;
      }
      if (CX().openSolveFromSession) CX().openSolveFromSession(s);
      else { s.setCalLensState('done'); s.pushLog({ lv: 'ok', cat: 'lens', msg: '开始求解 · ' + run.label }); }
    };
    const removeRun = async (id) => {
      const r = (liveRuns || []).find((x) => x.id === id);
      if (!r || !r.sessionDir || !outDir) return;
      try {
        await deleteLensSession(outDir, r.sessionDir);
        setLiveRuns((rs) => (rs || []).filter((x) => x.id !== id));
        s.pushLog({ lv: 'warn', cat: 'lens', msg: '已删除采集记录 · ' + r.label });
      } catch (e) {
        s.pushLog({ lv: 'err', cat: 'lens', msg: '删除失败 · ' + (e && e.message ? e.message : e) });
      }
    };
    const clearAllRuns = async () => {
      if (!(liveRuns || []).length || !outDir) return;
      const n = liveRuns.length;
      try {
        for (const r of liveRuns) {
          if (r.sessionDir) await deleteLensSession(outDir, r.sessionDir);
        }
        setLiveRuns([]);
        s.pushLog({ lv: 'warn', cat: 'lens', msg: '已一键清空采集记录 · 共 ' + n + ' 个 run' });
      } catch (e) {
        s.pushLog({ lv: 'err', cat: 'lens', msg: '清空失败 · ' + (e && e.message ? e.message : e) });
        void refreshSessions();
      }
    };
    const openDetail = (runId, poseId) => s.setCapDetail({ runId, poseId });
    const runs = liveRuns;
    const tgl = (k) => setOpen((o) => Object.assign({}, o, { [k]: !o[k] }));
    const trackCfg = (cam && cam.tracking) || null;
    const trackHost = (trackCfg && trackCfg.host) || (profile && profile.trackHost) || '0.0.0.0';
    const trackPort = Number((trackCfg && trackCfg.port) || (profile && profile.trackPort) || 6301);

    /* --------- 左：实时信号 --------- */
    const displayUrl = (wantArLive && arLiveUrl) ? arLiveUrl : previewUrl;
    const hasFeed = !!displayUrl || backend === 'synthetic';
    const arActive = signalReady && arOn && arAvail && !isSl && !!arGrid;
    const trackLostUi = tracked && (arLost || s.capTrack === 'lost');
    const arPanel = h('div', { className: 'lc-arpanel' },
      h('div', { className: 'lc-arpanel-row' },
        h('span', { className: 'lc-arpanel-lb' }, '启用叠加'),
        h(Switch, { isSelected: arOn && arAvail, isDisabled: !arAvail, onChange: (v) => { setArOn(!!v); if (!v) { setArGrid(null); setArLost(false); } } })),
      !arAvail
        ? h('div', { className: 'lc-arhud-locked' }, h(Icon, { name: 'info', size: 12 }),
            h('span', null, arLockHint || '当前机位尚未求解 · 请先完成求解'))
        : h(React.Fragment, null,
            arErr ? h('div', { className: 'lc-arhud-locked' }, h(Icon, { name: 'alert', size: 12 }), h('span', null, arErr)) : null,
            h('div', { className: 'lc-arhud-op' + (arOn ? '' : ' is-off') },
              h('span', { className: 'lc-arhud-op-k' }, '透明度'),
              h('input', { className: 'lc-ar-range', type: 'range', min: 0, max: 100, value: arOpacity, disabled: !arOn,
                style: { '--pct': arOpacity + '%' }, onChange: (e) => setArOpacity(+e.target.value) }),
              h('span', { className: 'lc-arhud-op-v mono' }, arOpacity + '%')),
            tracked
              ? h('div', { className: 'lc-arhud-track' },
                  trackLostUi
                    ? h('span', { className: 'cap-pill cap-pill--negative' }, h(Icon, { name: 'x', size: 12 }), '追踪丢失')
                    : h('span', { className: 'cap-pill cap-pill--positive' }, h(Icon, { name: 'pulse', size: 12 }), '追踪正常'))
              : arOn
                ? h('div', { className: 'lc-arhud-track' },
                    arStaticOk
                      ? h('span', { className: 'cap-pill cap-pill--positive' }, h(Icon, { name: 'check', size: 12 }), '静帧 perimeter 通过')
                      : h('span', { className: 'cap-pill cap-pill--notice' }, h(Icon, { name: 'target', size: 12 }), '静帧验收中…'))
                : null));
    const arButton = (signalReady && !isSl) ? h('div', { className: 'lc-arwrap', ref: arBtnRef },
      h('button', { className: 'lc-arbtn' + (arOn && arAvail ? ' on' : '') + (arPanelOpen ? ' open' : ''), onClick: () => setArPanelOpen((v) => !v) },
        h(Icon, { name: 'layers', size: 15 }), 'AR 叠加验证',
        arOn && arAvail ? h('span', { className: 'lc-arbtn-dot' }) : null,
        h(Icon, { name: 'chevu', size: 12 })),
      arPanelOpen ? arPanel : null) : null;
    const signal = h('div', { className: 'lc-signal' },
      hasFeed || signalReady
        ? h(React.Fragment, null,
            displayUrl
              ? h('img', { className: 'lc-feed', src: displayUrl, alt: '现场画面', style: { width: '100%', height: '100%', objectFit: 'contain', display: 'block' } })
              : h(CameraSignal, { method, capturing, detect: !isSl && capturing, sl: isSl, slFrame }),
            arActive ? h(AROverlay, { grid: arGrid, lost: trackLostUi, opacity: arOpacity / 100 }) : null,
            h('div', { className: 'lc-vig' }),
            h('div', { className: 'lc-hud lc-hud--tl' },
              h('span', { className: 'lc-sigchip' }, capturing ? h('span', { className: 'lc-rec' }) : null,
                capturing ? 'REC · MJPEG' : 'LIVE · MJPEG'),
              h('span', { className: 'lc-sigchip' }, h('span', { className: 'mono' },
                (BACKEND_LABEL[backend] || backend || '—') + ' · ' + hudFmt))),
            capturing && !isSl && !isQspFixed ? h(React.Fragment, null,
              h('div', { className: 'lc-banner lc-banner--' + CAP_BANNERS[banner].tone },
                h(Icon, { name: CAP_BANNERS[banner].icon, size: 18 }),
                h('div', { className: 'lc-banner-tx' }, h('b', null, CAP_BANNERS[banner].label), h('span', null, CAP_BANNERS[banner].sub))),
              h('div', { className: 'lc-hud lc-hud--tr' },
                h('span', { className: 'lc-sigchip' }, '已采 ', h('b', { style: { color: '#fff', margin: '0 2px' } }, capN), ' / 目标 ' + targetM))) : null,
            capturing && isQspFixed && collectingMasterLens ? h('div', { className: 'lc-hud lc-hud--tr' },
              h('span', { className: 'lc-sigchip' }, '已采 ', h('b', { style: { color: '#fff', margin: '0 2px' } }, capN), ' / 目标 ' + targetM)) : null,
            capturing && isSl ? h(SlPlaybackBar, { slFrame }) : null)
        : h('div', { className: 'lc-nosig' },
            h('div', { className: 'lc-nosig-ic' }, h(Icon, { name: 'camera', size: 30, stroke: 1.3 })),
            h('div', { className: 'lc-nosig-t' }, monitor.sig === 'lost' ? '信号丢失' : '无信号'),
            h('div', { className: 'lc-nosig-d' }, profile
              ? '等待首帧或检查设备占用。可在右侧「常规设置」切换采集配置 Profile。'
              : '请先选择采集配置 Profile（信号源）。')),
      s.capDetail ? h(PoseDetail, { s, runs, onSolve: solveRun }) : null,
      /* 固定机位 · VP-QSP：状态横幅 / 求解遮罩 / 静帧 AR 门控浮条（qctx 在本函数尾部装配） */
      isQspFixed && (hasFeed || signalReady) ? h(QspOverlays, { ctxRef: qspCtxRef }) : null);

    /* --------- 右：设置列（真实控件节点抽出，QSP 固定机位与追踪路径共用） --------- */
    const profileField = h('div', { className: 'lc-field' }, h('span', { className: 'k' }, '采集配置 Profile'),
      profiles.length
        ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            h(window.Selector, {
              kpre: '', value: pid || '',
              options: profiles.map((p) => ({ id: p.id, label: p.name + ' · ' + (BACKEND_LABEL[p.videoBackend] || p.videoBackend) })),
              onChange: (v) => setPid(v), width: 214, variant: 'obj', align: 'left',
            }),
            h('button', { className: 'lc-selbtn', onClick: () => CX().openCaptureModal && CX().openCaptureModal(s) },
              h(Icon, { name: 'sliders', size: 14 }), h('span', { className: 'v' }, '管理采集配置…')))
        : h('button', { className: 'lc-selbtn', onClick: () => CX().openCaptureModal && CX().openCaptureModal(s) },
            h(Icon, { name: 'camera', size: 14 }), h('span', { className: 'v', style: { color: 'var(--notice-visual)' } }, '尚未创建 · 去新建'), h(Icon, { name: 'chevd', size: 13 })));
    /* 标定屏幕单选 + 三个自动状态行（screen.json / 图案 / 输出位置 由系统自动推导生成） */
    const screenChipsBlock = h('div', { className: 'ag-block' },
      h('span', { className: 'ag-sublbl' }, '标定屏幕'),
      h(window.VoloAutoGen.ScreenChips, { ag }));
    const autoRows = h(window.VoloAutoGen.AutoStatusRows, { ag });
    /* 本机 HDMI：允许在采集窗内重选测试图目标屏（ASUS vs LG G3 等） */
    const monitorPicker = deployChannel === 'monitor' && deployed && patternMons.length
      ? h('div', { className: 'ag-block', style: { marginTop: 10 } },
          h('span', { className: 'ag-sublbl' }, '测试图输出显示器'),
          h('div', { className: 'lc-camchips' }, patternMons.map((m) => h('button', {
            key: m.index,
            className: 'lc-camchip' + (m.index === activeMonitorIndex ? ' on' : ''),
            disabled: patternMonBusy || capturing,
            onClick: () => void retargetPatternMonitor(m),
            title: (m.name || ('显示器 ' + m.index)) + ' · ' + m.width + '×' + m.height,
          },
            (m.name || ('#' + m.index)),
            m.is_primary ? ' · 主屏' : '',
          ))),
          h('div', { className: 'lc-reason', style: { marginTop: 6 } },
            h(Icon, { name: 'info', size: 12 }),
            '需 Windows「扩展这些显示器」；复制模式下副屏无法单独投图'))
      : null;
    const generalBody = [profileField, screenChipsBlock, autoRows, monitorPicker];
    const camChips = h('div', { className: 'lc-camchips' }, (camSnap.cameras || []).map((c) => h('button', { key: c.id, className: 'lc-camchip' + (c.id === camId ? ' on' : ''), onClick: () => {
        setCamId(c.id); s.setCapCam(c.id);
        if (window.camStore) window.camStore.select(c.id);
      } },
      h('span', { className: 'dot', style: { background: c.mode === 'tracked' ? 'var(--volo-500)' : c.solved ? 'var(--positive-visual)' : 'var(--chrome-faint)' } }), c.name)),
      h('button', { className: 'lc-camchip-add', title: '新建相机', onClick: () => {
        if (!window.camStore) return;
        const c = window.camStore.add();
        setCamId(c.id); s.setCapCam(c.id);
      } }, h(Icon, { name: 'plus', size: 14 })));
    const camBar = h('div', { className: 'lc-cam-bar' },
      h('span', { className: 'sp' }),
      h('button', { className: 'lc-cam-iconbtn', title: '重命名', onClick: () => {
        const name = window.prompt('相机名称', cam.name);
        if (name && window.camStore) window.camStore.rename(camId, name);
      } }, h(Icon, { name: 'sliders', size: 14 })),
      h('button', { className: 'lc-cam-iconbtn', title: '删除', onClick: () => {
        if (window.camStore) window.camStore.remove(camId);
        const next = window.camStore && window.camStore.get().selectedId;
        if (next) { setCamId(next); s.setCapCam(next); }
      } }, h(Icon, { name: 'trash', size: 14 })));
    const trackField = h('div', { className: 'lc-field' }, h('span', { className: 'k' }, '选择追踪信号'),
      h(window.Selector, { kpre: '', value: trackSignal, options: TRACK_SIGNALS, onChange: onTrackChange, width: 214, variant: 'obj', align: 'left' }));
    const cameraParamsNode = h(CameraParams, { cam, tracked, camId, editable: !tracked });

    const side = h('div', { className: 'lc-side' },
      /* 校正方式（三个紧凑选项） */
      grp('mopt', CAL_METHOD_BADGES[method].icon, '校正方式', open.mopt, () => tgl('mopt'), h(MethodOptions, { s })),
      /* a 常规设置 */
      grp('general', 'sliders', '常规设置', open.general, () => tgl('general'), ...generalBody),
      /* b 方式参数 */
      grp('method', CAL_METHOD_BADGES[method].icon, '方式参数', open.method, () => tgl('method'),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 } }, methodBadge(method)),
        isSl
          ? h('div', { className: 'lc-param-grid3' },
              slCell('点间距', CAL_SL_SEQ.spacing_mm, 'mm'),
              slCell('总帧数', CAL_SL_SEQ.frames, ''),
              slCell('预计时长', '2:10', ''))
          : h(React.Fragment, null,
              h('div', { className: 'lc-toggle' }, h('div', { className: 'm' }, h('div', { className: 't' }, '目标点灰码同步'), h('div', { className: 's' }, '播放器与采集帧格雷码对齐')),
                h(Switch, { isSelected: gsync, onChange: setGsync })),
              h('div', { className: 'lc-toggle' }, h('div', { className: 'm' }, h('div', { className: 't' }, '反相双帧'), h('div', { className: 's' }, 'inverted · 差分抑制环境光')),
                h(Switch, { isSelected: inverted, onChange: setInverted })))),
      /* c 摄影机设置（重点） */
      grp('camera', 'camera', '摄影机设置', open.camera, () => tgl('camera'),
        camChips, camBar, trackField, cameraParamsNode),
      /* d 追踪状态条 */
      h('div', { className: 'lc-grp' }, h('div', { className: 'lc-grp-b', style: { paddingTop: 14 } },
        h('div', { className: 'lc-cam-sub', style: { marginTop: 0 } }, '追踪状态'),
        h(TrackStatus, {
          protocol: trackSignal,
          host: trackHost,
          port: trackPort,
          onState: (st) => { if (trackSignal !== 'none') s.setCapTrack(st); },
        }))),
      /* e 采集记录（仅真实 list_lens_sessions；无 session 显示空态） */
      grp('records', 'list', '采集记录', open.records, () => tgl('records'),
        sessionsErr ? h('div', { style: { fontSize: 11.5, color: 'var(--notice-visual)', padding: '4px 0 8px' } }, '会话列表：' + sessionsErr) : null,
        liveRuns.length ? h('button', { className: 'lc-runs-clear', onClick: () => void clearAllRuns() }, h(Icon, { name: 'trash', size: 12 }), '一键清空') : null,
        h('div', { className: 'lc-runs' }, liveRuns.length
          ? runs.map((run) => {
              const solving = solvingId === run.id;
              const st = solving ? 'solving' : run.solveState;
              const solved = st === 'ok' || st === 'warn';
              const solve = buildSolveFromRun(run);
              return h('div', { key: run.id, className: 'lc-run' },
                h('div', { className: 'lc-run-h' },
                  h('span', { className: 'lc-run-n' }, run.label),
                  h('span', { className: 'lc-run-time' }, run.time),
                  h('div', { className: 'lc-run-badges' }, methodBadge(run.method), modeBadge(run.mode),
                    solving ? h('span', { className: 'cap-pill cap-pill--informative' }, h('span', { className: 'ag-spin' }, h(Icon, { name: 'sync', size: 12 })), '求解中…')
                      : solved && run.rms != null ? rmsSolveBadge(run.rms) : solveBadge(st === 'none' ? 'none' : st),
                    h('button', { className: 'lc-run-x', title: '删除该记录', onClick: (e) => { e.stopPropagation(); void removeRun(run.id); } }, h(Icon, { name: 'x', size: 12 })))),
                run.error ? h('div', { style: { padding: '8px 11px', fontSize: 11.5, color: 'var(--notice-visual)', borderBottom: '1px solid var(--chrome-line)' } }, run.error) : null,
                !run.error && run.solveError
                  ? h('div', { style: { padding: '8px 11px', fontSize: 11.5, color: 'var(--notice-visual)', borderBottom: '1px solid var(--chrome-line)' } }, '求解失败 · ' + run.solveError)
                  : null,
                run.artifactStatus === 'invalid' && !run.solveError
                  ? h('div', { style: { padding: '8px 11px', fontSize: 11.5, color: 'var(--notice-visual)', borderBottom: '1px solid var(--chrome-line)' } },
                      'Legacy/unqualified stage_pose 已标记 invalid，不会进入 AR / export')
                  : null,
                solved && run.stagePose && run.stagePose.preflight
                  ? h('div', { style: { padding: '7px 11px', fontSize: 11, borderBottom: '1px solid var(--chrome-line)' } },
                      Object.entries(run.stagePose.preflight.homography_by_screen || {}).map(([label, metrics]) =>
                        h('div', { key: label }, label + ' · decoded ' + metrics.decoded
                          + ' · trustworthy ' + metrics.trustworthy
                          + ' · H RMS ' + Number(metrics.rms_px).toFixed(3) + ' px'
                          + (metrics.brightness_warnings ? ' · brightness warning ' + metrics.brightness_warnings : ''))))
                  : null,
                st === 'none'
                  ? h('div', { className: 'lc-run-solvebar' },
                      h('span', { className: 'lc-run-solvebar-t' }, run.poseCount + ' 点位 · 未求解'),
                      h('span', { style: { flex: 1 } }),
                      h(Button, { variant: 'accent', size: 'S', icon: h(Icon, { name: 'target', size: 13 }),
                        isDisabled: !!run.error, onPress: () => solveRun(run) }, run.solveError ? '重新求解' : '立即求解'))
                  : st === 'solving'
                    ? h('div', { className: 'lc-run-solvebar is-solving' },
                        h('span', { className: 'lc-run-solvebar-t' }, '正在求解外参与重投影…'),
                        h('div', { className: 'ag-indet', style: { flex: 1, maxWidth: 130 } }, h('div', { className: 'ag-indet-bar' })))
                    : h('div', { className: 'lc-run-solvebar' },
                        h('span', { className: 'lc-run-solvebar-m' }, '内点 ',
                          h('b', null, solve ? solve.inliers : '—'),
                          solve ? ' / ' + solve.markers_total : ''),
                        h('span', { style: { flex: 1 } }),
                        solve
                          ? h('button', { className: 'lc-run-report', onClick: () => openSolveReport(s, { run }) }, h(Icon, { name: 'doc', size: 13 }), '查看报告')
                          : (run.mode !== 'fixed' && !run.modeFixed && CX().openReport
                            ? h('button', { className: 'lc-run-report', onClick: () => CX().openReport(s) }, h(Icon, { name: 'doc', size: 13 }), '查看报告')
                            : null)),
                (run.poses || []).map((p) => h('button', { key: p.id, className: 'lc-pose' + (p.diff === 'fail' ? ' bad' : ''), onClick: () => openDetail(run.id, p.id) },
                  h('span', { className: 'lc-pose-idx' }, '#' + p.idx),
                  h('div', { className: 'lc-pose-m' }, h('div', { className: 'lc-pose-pose' }, p.pose), h('div', { className: 'lc-pose-sub' }, p.time + ' · ' + (p.tracked ? 'tracked' : 'fixed'))),
                  h('div', { className: 'lc-pose-lights' }, qualityLight(p.detect), qualityLight(p.reproj), qualityLight(p.diff)),
                  h('span', { className: 'lc-pose-rms', style: p.rms == null ? { color: 'var(--chrome-faint)' } : null }, p.rms == null ? '—' : Number(p.rms).toFixed(2)))));
            })
          : h('div', { className: 'lc-runs-empty' }, outDir ? '暂无采集记录' : '选择输出目录后扫描会话。'))));

    /* --------- 底部主动作条 --------- */
    /* §3.5：路径已自动化，禁用原因仅保留系统级阻断（原 screen.json / 输出目录 / 图案目录条目删除） */
    const reasons = [];
    if (!deployed) reasons.push('未部署上屏');
    if (!profile) reasons.push('未选采集配置');
    if (!signalReady && backend !== 'synthetic') reasons.push('信号源未就绪');
    if (ag.screenDef === 'exportFail') reasons.push('屏幕定义导出失败');
    if (ag.multiSection) reasons.push('折面屏（多 section）图案上屏暂不支持');
    if (ag.pattern === 'genFail') reasons.push('校正图案生成失败');
    if (collectingMasterLens) reasons.push('当前为 Master Lens Capture · 采集 ≥8 个不同角度并覆盖画面边缘；此阶段不求 Stage 位姿');
    if (!tracked && !collectingMasterLens && !fixedLensReady && method === 'qsp' && purpose === 'known_lens') {
      reasons.push('「使用 Master Lens · 只求外参」需要 qualified master lens — 请导入，或改用「固定机位 · 单次校正 / 自动估计当前镜头」');
    }
    if (!isSl && ag.selectedIds.length > 1 && deployChannel !== 'ndisplay') reasons.push('多屏同步上屏需要 nDisplay 通道');
    if (isSl && deployChannel !== 'ndisplay') reasons.push('结构光目前仅支持 nDisplay 通道');
    if (isSl && !screenFile) reasons.push('未选屏幕文件');
    if (isSl && !outDir) reasons.push('未选输出目录');
    if (method === 'charuco') reasons.push('ChArUco 即将支持');
    const actionbar = h('div', { className: 'lc-actionbar' + (capturing ? ' capturing' : '') },
      capturing
        ? h(React.Fragment, null,
            h(Button, { variant: 'negative', size: 'M', icon: h(Icon, { name: 'x', size: 15 }), onPress: stop }, '停止采集'),
            h('div', { className: 'lc-prog' },
              isSl ? h('span', { className: 'lc-prog-n' }, '帧 ', slFrame + 1, h('span', { className: 'm' }, ' / ' + CAL_SL_SEQ.frames))
                   : h('span', { className: 'lc-prog-n' }, '已采点位 ', capN, h('span', { className: 'm' }, ' / ' + targetM))),
            arButton)
        : h(React.Fragment, null,
            h('div', { className: 'lc-start' },
              h(Button, { variant: 'accent', size: 'L',
                icon: ag.preparing ? h('span', { className: 'ag-spin' }, h(Icon, { name: 'sync', size: 16 })) : h(Icon, { name: isSl ? 'play' : 'camera', size: 16 }),
                isDisabled: !ready || ag.preparing || starting || capturing, onPress: () => ag.beginCapture(start) },
                ag.preparing ? '生成图案中…' : starting ? '正在启动…' : (isSl
                  ? '开始采集 · 播放序列'
                  : collectingMasterLens ? ('开始镜头采集 · ' + targetM + ' Poses') : '开始采集'))),
            reasons.length
              ? h('div', { className: 'lc-reasons' },
                  reasons.map((r, i) => h('span', { key: i, className: 'lc-reason' }, h(Icon, { name: 'info', size: 12 }), r)),
                  !deployed ? h('button', { className: 'flow-back', style: { padding: '3px 9px' }, onClick: () => { close(); s.setCalSection('deploy'); } }, '去上屏部署') : null,
                  ag.multiSection ? h('div', { className: 'lc-cli-note' }, h(Icon, { name: 'info', size: 13 }),
                    h('span', null, '折面屏（多 section）需通过 CLI 手动生成 / 上屏：', h('code', null, 'vpcal pattern generate --screen <screen.json> --output-dir <dir>'), '，暂无 UI 操作入口。')) : null)
              : h('div', { className: 'lc-reasons' }, h('span', { className: 'lc-reason ok' }, h(Icon, { name: 'check', size: 12 }),
                  tracked ? '前置就绪 · 追踪机位' : collectingMasterLens
                    ? '前置就绪 · Master Lens multi-view capture'
                    : '前置就绪 · 固定机位（单次采集 · 使用已知镜头参数求 Stage 位姿）')),
            h('span', { className: 'sp' }),
            arButton));

    /* ---------- 固定机位 · VP-QSP：右栏 / 底栏 / 左覆盖委托给 VOLO_QSP ----------
       仅 method==='qsp' && 追踪 None 时生效；追踪机位 / 结构光 / ChArUco 保持现有窗口一字不改。 */
    const qspModeRequested = purpose === 'known_lens' ? 'known-lens'
      : purpose === 'joint_session' ? 'joint-session-lens'
        : purpose === 'master_lens' ? 'master-lens-capture' : 'auto';
    const qspReasons = [];
    if (!deployed) qspReasons.push({ t: '未部署上屏', jump: 'deploy' });
    if (!profile) qspReasons.push({ t: '未选采集配置' });
    if (!signalReady && backend !== 'synthetic') qspReasons.push({ t: '信号源未就绪' });
    if (ag.screenDef === 'exportFail') qspReasons.push({ t: '屏幕定义导出失败' });
    if (ag.multiSection) qspReasons.push({ t: '折面屏（多 section）图案上屏暂不支持' });
    if (ag.pattern === 'genFail') qspReasons.push({ t: '校正图案生成失败' });
    if (ag.selectedIds.length > 1 && deployChannel !== 'ndisplay') qspReasons.push({ t: '多屏同步上屏需要 nDisplay 通道' });
    if (purpose === 'known_lens' && !hasMaster) {
      qspReasons.push({ t: 'known-lens 缺合格 Master Lens · 可改用「固定机位 · 单次校正 / 自动估计当前镜头」' });
    }
    const qctx = {
      s, close,
      qspState, lensPhase: qspLensPhase, modeRequested: qspModeRequested,
      purpose, setPurpose,
      hasMaster, masterInfo: cam && cam.masterLensInfo, masterBusy: masterLensBusy,
      importMaster: () => void importMasterLens(),
      createMaster: () => void createMasterLens(),
      run: qspRun, failInfo: qspFail,
      arStage, arError: arErr,
      startArVerify, confirmAttest, recapture: qspRecapture, openLivePreview: qspOpenLivePreview,
      tracked, open, tgl,
      generalBody, camChips, trackField, cameraParams: cameraParamsNode,
      reasons: qspReasons, ready, preparing: ag.preparing, starting,
      start: () => ag.beginCapture(start), stop: () => void stop(),
      targetM, capN,
      deployJump: () => { close(); s.setCalSection('deploy'); },
    };
    qspCtxRef.current = qctx;
    const sideNode = (isQspFixed && window.VOLO_QSP) ? window.VOLO_QSP.side(qctx) : side;
    const actionbarNode = (isQspFixed && window.VOLO_QSP) ? window.VOLO_QSP.actionbar(qctx) : actionbar;

    const rzDirs = [['n', 0, -1], ['s', 0, 1], ['e', 1, 0], ['w', -1, 0], ['ne', 1, -1], ['nw', -1, -1], ['se', 1, 1], ['sw', -1, 1]];
    return h('div', { className: 'drawer drawer--lcwin', ref: rootRef },
      h('div', { className: 'drawer-h' },
        h('span', { className: 'di info' }, h(Icon, { name: 'camera', size: 17 })),
        h('div', { style: { minWidth: 0, flex: 1 } }, h('h2', null, '镜头校正 · 实时采集'),
          h('div', { className: 'sub' }, methodBadge(method))),
        h('button', { className: 'iconbtn x', onClick: () => { if (capturing) stop(); close(); } }, h(Icon, { name: 'x', size: 16 }))),
      h('div', { className: 'lc-body', style: { gridTemplateColumns: leftPct + '% ' + (100 - leftPct) + '%' } },
        signal, sideNode,
        h('div', { className: 'capw-split', style: { left: leftPct + '%' }, onPointerDown: onSplit }, h('span', { className: 'capw-split-grip' }))),
      actionbarNode,
      rzDirs.map(([n, dx, dy]) => h('div', { key: n, className: 'capw-rz capw-rz--' + n, onPointerDown: onResize(dx, dy) })));
  }
  /* QSP 左覆盖层：渲染期从 ref 取 qctx（qctx 在 CaptureWindow 函数体尾部装配）。 */
  function QspOverlays({ ctxRef }) {
    const ctx = ctxRef.current;
    if (!ctx || !window.VOLO_QSP) return null;
    return window.VOLO_QSP.leftOverlays(ctx);
  }
  function openLensWindow(s) {
    s.setModal({ xwide: true, render: ({ s: st, close }) => h(CaptureWindow, { s: st, close }) });
  }

  function grp(key, icon, label, isOpen, onToggle, ...children) {
    return h('div', { className: 'lc-grp' },
      h('button', { className: 'lc-grp-h', onClick: onToggle },
        h('span', { className: 'ic' }, h(Icon, { name: icon, size: 15 })),
        h('span', { className: 't' }, label),
        h('span', { className: 'car' + (isOpen ? '' : ' closed') }, h(Icon, { name: 'chevd', size: 14 }))),
      isOpen ? h('div', { className: 'lc-grp-b' }, children) : null);
  }
  function slCell(k, v, u) {
    return h('div', { className: 'lc-pcell' }, h('span', { className: 'pk' }, k), h('span', { className: 'pv' }, v, u ? h('span', { style: { fontSize: 10, color: 'var(--chrome-faint)', marginLeft: 2 } }, u) : null));
  }

  /* 摄影机参数面板（位置/旋转/镜头 + 来源徽标）；手动模式可编辑写回 camStore */
  function CameraParams({ cam, tracked, camId, editable }) {
    const ro = tracked != null ? tracked : cam.mode === 'tracked';
    const P = cam.pos, R = cam.rot, L = cam.lens;
    const canEdit = !!editable && !ro && cam.pos.x.src === 'manual';
    const commitValue = (axis, val) => {
      if (!window.camStore || !camId) return;
      if (['sensorW', 'sensorH', 'focal', 'k3', 'ppx', 'ppy'].includes(axis)) {
        window.camStore.setLensValue(camId, axis, val);
        return;
      }
      const t = [P.x.v, P.y.v, P.z.v];
      const e = [R.pan.v, R.tilt.v, R.roll.v];
      if (axis === 'x') t[0] = val; else if (axis === 'y') t[1] = val; else if (axis === 'z') t[2] = val;
      else if (axis === 'pan') e[0] = val; else if (axis === 'tilt') e[1] = val; else if (axis === 'roll') e[2] = val;
      window.camStore.setManualPose(camId, t, e);
    };
    const cell = (k, o, u, axis) => h('div', { className: 'lc-pcell' + ((o.src === 'tracking' || o.src === 'solve' || !canEdit) ? ' readonly' : '') },
      h('span', { className: 'pk' }, k, sourceTag(o.src)),
      canEdit && axis
        ? h('input', {
            className: 'pv', type: 'number', step: 'any', value: typeof o.v === 'number' ? o.v : 0,
            onChange: (ev) => commitValue(axis, Number(ev.target.value)),
            style: { width: '100%', border: 'none', background: 'transparent', font: 'inherit', color: 'inherit' },
          })
        : h('span', { className: 'pv' }, (typeof o.v === 'number' ? o.v.toFixed(o.v % 1 === 0 ? 0 : 2) : o.v), u ? h('span', { style: { fontSize: 10, color: 'var(--chrome-faint)', marginLeft: 2 } }, u) : null));
    return h(React.Fragment, null,
      h('div', { className: 'lc-cam-sub' }, '位置 (mm)' + (ro ? ' · 追踪实时 · 只读' : (canEdit ? ' · 手动可编辑' : ''))),
      h('div', { className: 'lc-param-grid3' }, cell('X', P.x, '', 'x'), cell('Y', P.y, '', 'y'), cell('Z', P.z, '', 'z')),
      h('div', { className: 'lc-cam-sub' }, '旋转 (°) · Pan / Tilt / Roll'),
      h('div', { className: 'lc-param-grid3' }, cell('Pan', R.pan, '', 'pan'), cell('Tilt', R.tilt, '', 'tilt'), cell('Roll', R.roll, '', 'roll')),
      h('div', { className: 'lc-cam-sub' }, '镜头组'),
      h('div', { className: 'lc-param-grid3' },
        cell('Sensor 宽', L.sensorW, 'mm', 'sensorW'), cell('Sensor 高', L.sensorH, 'mm', 'sensorH'), cell('焦距', L.focal, 'mm', 'focal')),
      h('div', { className: 'lc-param-grid3' },
        cell('FOV K3', L.fovK3, '', 'k3'), cell('主点 Δx', L.ppx, '', 'ppx'), cell('主点 Δy', L.ppy, '', 'ppy')),
      cam.protocol === 'freed' ? h(React.Fragment, null,
        h('div', { className: 'lc-cam-sub' }, 'FreeD 编码器原始值'),
        h('div', { className: 'lc-enc' }, h('span', { className: 'k' }, 'zoom'), h('span', { className: 'v' }, L.zoomEnc), h('span', { style: { width: 10 } }), h('span', { className: 'k' }, 'focus'), h('span', { className: 'v' }, L.focusEnc)),
        h('div', { className: 'lc-enc-note' }, 'FreeD 接入：zoom / focus 为编码器整数原始值，未映射为物理量。')) : null);
  }

  /* 追踪状态条：probe_tracking_source 三态（fixed / connected / lost） */
  function TrackStatus({ protocol, host, port, onState }) {
    const [tick, setTick] = useState(0);
    const [probe, setProbe] = useState({ status: 'idle', frames: 0, latest: null, err: null });
    const protoLabel = protocol === 'opentrackio' ? 'OpenTrackIO' : 'FreeD';
    useEffect(() => {
      if (!protocol || protocol === 'none') {
        setProbe({ status: 'idle', frames: 0, latest: null, err: null });
        if (onState) onState('fixed');
        return undefined;
      }
      let alive = true;
      let timer = null;
      const run = async () => {
        if (!alive) return;
        setProbe((p) => Object.assign({}, p, { status: 'probing' }));
        try {
          const r = await probeTrackingSource(protocol, host || '0.0.0.0', Number(port) || 6301);
          if (!alive) return;
          const frames = r && r.frames != null ? r.frames : 0;
          setProbe({ status: frames > 0 ? 'ok' : 'lost', frames, latest: (r && r.latest) || null, err: null });
          if (onState) onState(frames > 0 ? 'connected' : 'lost');
        } catch (e) {
          if (!alive) return;
          setProbe({ status: 'lost', frames: 0, latest: null, err: e && e.message ? e.message : String(e) });
          if (onState) onState('lost');
        }
        if (alive) timer = setTimeout(run, 5000);
      };
      void run();
      return () => { alive = false; if (timer) clearTimeout(timer); };
    }, [protocol, host, port, tick]);
    if (!protocol || protocol === 'none') {
      return h('div', { className: 'lc-track' },
        h('div', { className: 'lc-track-fixed' }, h(Icon, { name: 'pin', size: 13 }), h('span', null, '未选择追踪信号 · 机位在采集期间须保持静止')));
    }
    const lost = probe.status === 'lost';
    const probing = probe.status === 'probing' || probe.status === 'idle';
    const latest = probe.latest || {};
    const hasPos = Array.isArray(latest.position) && latest.position.length >= 3;
    const hasRot = !!(latest.rotation || (latest.euler_deg != null));
    const hasLens = latest.focal_length_mm != null || latest.zoom_raw != null || latest.focus_raw != null;
    const chip = (ok, label) => h('span', { className: 'lc-track-chip' },
      h('span', { className: 'cal-light cal-light--' + (probing ? 'neutral' : lost || !ok ? 'negative' : 'positive') },
        h(Icon, { name: probing ? 'minus' : (lost || !ok ? 'x' : 'check'), size: 8 })), label);
    const camId = latest.camera_id != null ? latest.camera_id : '—';
    const pps = probe.frames > 0 ? Math.round(probe.frames / 2) : 0; /* probe 窗口约 2s */
    return h('div', { className: 'lc-track' + (lost ? ' lost' : '') },
      h('div', { className: 'lc-track-top' },
        h('span', { className: 'lc-track-proto' }, protoLabel),
        probing ? h('span', { className: 'spill spill--neutral' }, h(Icon, { name: 'sync', size: 12 }), '探测中')
          : lost ? h('span', { className: 'spill spill--negative' }, h(Icon, { name: 'x', size: 12 }), '无信号')
            : h('span', { className: 'spill spill--active' }, h(Icon, { name: 'pulse', size: 12 }), '实时'),
        h('button', {
          className: 'lc-cam-iconbtn', style: { marginLeft: 'auto' }, title: '重新探测',
          onClick: () => setTick((n) => n + 1),
        }, h(Icon, { name: 'sync', size: 13 }))),
      h('div', { className: 'lc-track-meta' },
        h('span', null, 'cameraId ', h('span', { className: 'mono' }, camId)),
        h('span', null, h('span', { className: 'mono' }, probing ? '—' : pps), ' 包/秒'),
        h('span', { className: 'mono', style: { color: 'var(--chrome-faint)' } }, (host || '0.0.0.0') + ':' + (port || 6301))),
      probe.err ? h('div', { style: { fontSize: 11, color: 'var(--notice-visual)', marginTop: 4 } }, probe.err) : null,
      h('div', { className: 'lc-track-ch' },
        chip(hasPos, '位置'), chip(hasRot, '旋转'), chip(hasLens, '镜头')));
  }

  /* 结构光播放状态段（叠加在信号区顶部） */
  function SlPlaybackBar({ slFrame }) {
    const seq = CAL_SL_SEQ;
    const inAnchor = slFrame < seq.anchorFrames;
    const pct = (slFrame + 1) / seq.frames * 100;
    const beats = 6, active = slFrame % beats;
    const mm = Math.floor((slFrame / seq.fps) / 60), ss = Math.floor((slFrame / seq.fps) % 60);
    return h('div', { className: 'lc-slbar' },
      h('div', { className: 'lc-sl-top' },
        h('span', { className: 'lc-sl-phase ' + (inAnchor ? 'anchor' : 'encode') }, h(Icon, { name: inAnchor ? 'pin' : 'grid', size: 12 }), inAnchor ? '锚帧' : '编码帧'),
        h('span', { className: 'lc-sl-frames' }, '帧 ' + (slFrame + 1), h('span', { className: 'm' }, ' / ' + seq.frames)),
        h('span', { className: 'lc-sl-rec' }, h('span', { className: 'lc-rec' }), 'REC ' + String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0'))),
      h('div', { className: 'lc-sl-prog' }, h('i', { style: { width: pct + '%' } })),
      h('div', { className: 'lc-sl-rhythm' }, Array.from({ length: beats }).map((_, i) => h('span', { key: i, className: 'beat' + (i === active ? ' on' : '') }))),
      h('div', { className: 'lc-sl-still' }, h(Icon, { name: 'alert', size: 12 }), '播放期间机位必须保持静止'));
  }

  /* ============================================================
     屏四 · 采集记录详情（覆盖在信号区）
     ============================================================ */
  function ReprojView() {
    const TL = [232, 90], TR = [726, 80], BR = [760, 430], BL = [196, 442];
    const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const bilerp = (u, v) => { const top = lerp(TL, TR, u), bot = lerp(BL, BR, u); return lerp(top, bot, v); };
    const marks = [];
    const N = 10, M = 6;
    for (let r = 0; r < M; r++) for (let c = 0; c < N; c++) {
      const p = bilerp((c + 0.5) / N, (r + 0.5) / M);
      const out = (c === 3 && r === 2) || (c === 7 && r === 1) || (c === 2 && r === 4);
      const dx = out ? 8 : 1.4, dy = out ? -6 : 1.1;
      marks.push(h('line', { key: 'gx' + r + c, x1: p[0] - 6, y1: p[1], x2: p[0] + 6, y2: p[1], stroke: 'var(--positive-visual)', strokeWidth: 1.1 }));
      marks.push(h('line', { key: 'gy' + r + c, x1: p[0], y1: p[1] - 6, x2: p[0], y2: p[1] + 6, stroke: 'var(--positive-visual)', strokeWidth: 1.1 }));
      marks.push(h('circle', { key: 'rc' + r + c, cx: p[0] + dx, cy: p[1] + dy, r: out ? 7 : 3.4, fill: 'none', stroke: out ? 'var(--negative-visual)' : 'rgba(255,120,90,.7)', strokeWidth: out ? 1.7 : 1 }));
      if (out) marks.push(h('line', { key: 'ln' + r + c, x1: p[0], y1: p[1], x2: p[0] + dx, y2: p[1] + dy, stroke: 'var(--negative-visual)', strokeWidth: 1 }));
    }
    return h('svg', { viewBox: '0 0 960 540', preserveAspectRatio: 'xMidYMid slice' },
      h('rect', { width: 960, height: 540, fill: '#06070b' }),
      h('polygon', { points: [TL, TR, BR, BL].map((p) => p.join(',')).join(' '), fill: '#0a0e16', stroke: 'rgba(140,170,210,.35)', strokeWidth: 1.4 }),
      marks);
  }

  function PoseDetail({ s, runs, onSolve }) {
    const sel = s.capDetail;
    const list = runs && runs.length ? runs : [];
    const run = list.find((r) => r.id === sel.runId) || list[0];
    if (!run) {
      return h('div', { className: 'lc-detail' },
        h('div', { className: 'lc-detail-head' },
          h('button', { className: 'lc-detail-back', onClick: () => s.setCapDetail(null) }, h(Icon, { name: 'arrowl', size: 14 }), '返回采集记录'),
          h('div', { className: 'lc-detail-title' }, h('span', { style: { color: 'var(--chrome-faint)' } }, '无采集会话'))));
    }
    const pose = (run.poses && run.poses.find((p) => p.id === sel.poseId)) || (run.poses && run.poses[0]) || { idx: 1, pose: '—', tracked: false, detect: 'pending', reproj: 'pending', diff: 'pending', rms: null, obs: 0, outliers: 0, missing: [] };
    /* 真实 run 永不回落演示 outliers；空则空态 */
    const outliers = (pose.outliersDetail && pose.outliersDetail.length) ? pose.outliersDetail : [];
    const [overlayUrl, setOverlayUrl] = useState(null);
    const [thumbUrl, setThumbUrl] = useState(null);
    const [ovBusy, setOvBusy] = useState(false);
    useEffect(() => {
      let alive = true;
      setOverlayUrl(null); setThumbUrl(null);
      if (pose.framePath) {
        readImageAsDataUrl(pose.framePath).then((u) => { if (alive) setThumbUrl(u); }).catch(() => {});
      }
      return () => { alive = false; };
    }, [pose.framePath, pose.id]);
    const loadOverlay = async () => {
      if (!run.sessionJson || run.mode === 'fixed' || run.modeFixed) return;
      setOvBusy(true);
      try {
        const resultPath = joinPath(run.outputDir || joinPath(run.sessionDir, 'output'), 'result.json');
        const outDir = joinPath(run.sessionDir, 'overlay_preview');
        const resp = await spawnSidecarStreaming('vpcal', [
          'verify', 'overlay', '--config', run.sessionJson, '--result', resultPath,
          '--out', outDir, '--limit', '8', '--output', 'json',
        ]);
        const images = await new Promise((resolve, reject) => {
          let unlisten = null;
          const timer = setTimeout(() => { if (unlisten) unlisten(); reject(new Error('overlay 超时')); }, 120000);
          listenSidecarStream(resp.task_id, (ev) => {
            if (ev.kind === 'line' && ev.parsed && ev.parsed.status === 'ok') {
              const imgs = ev.parsed.data && ev.parsed.data.annotated_images;
              if (imgs && imgs.length) { clearTimeout(timer); if (unlisten) unlisten(); resolve(imgs); }
            }
            if (ev.kind === 'exit') {
              clearTimeout(timer);
              if (unlisten) unlisten();
              if (ev.fatal) reject(new Error(ev.stderr_tail || 'overlay exit ' + ev.exit_code));
              else resolve([]);
            }
          }).then((u) => { unlisten = u; }).catch(reject);
        });
        const pick = images[(pose.idx - 1) % Math.max(1, images.length)] || images[0];
        if (pick) setOverlayUrl(await readImageAsDataUrl(pick));
        else s.pushLog({ lv: 'info', cat: 'lens', msg: '未生成标注图；可在「求解结果报告」查看' });
      } catch (e) {
        s.pushLog({ lv: 'err', cat: 'lens', msg: '验证叠加失败 · ' + (e && e.message ? e.message : e) });
      } finally { setOvBusy(false); }
    };
    return h('div', { className: 'lc-detail' },
      h('div', { className: 'lc-detail-head' },
        h('button', { className: 'lc-detail-back', onClick: () => s.setCapDetail(null) }, h(Icon, { name: 'arrowl', size: 14 }), '返回采集记录'),
        h('div', { className: 'lc-detail-title' }, h('span', { className: 'mono' }, run.label + ' · #' + pose.idx), h('span', { style: { fontWeight: 600, color: 'var(--chrome-faint)', fontSize: 12 } }, pose.pose)),
        h('div', { className: 'lc-detail-badges' }, pose.tracked ? modeBadge('tracked') : modeBadge('fixed'), h('span', { className: 'lc-pose-lights' }, qualityLight(pose.detect), qualityLight(pose.reproj), qualityLight(pose.diff)))),
      h('div', { className: 'lc-detail-body' },
        h('div', { className: 'lc-detail-canvas' },
          overlayUrl || thumbUrl
            ? h('img', { src: overlayUrl || thumbUrl, alt: 'reprojection', style: { width: '100%', height: '100%', objectFit: 'contain', background: '#06070b' } })
            : h(ReprojView),
          h('div', { className: 'lc-detail-legend' },
            h('span', { className: 'li' }, h('span', { className: 'sw' }, h(Icon, { name: 'plus', size: 12, style: { color: 'var(--positive-visual)' } })), '检测点'),
            h('span', { className: 'li' }, h('span', { className: 'sw' }, h('span', { style: { width: 10, height: 10, borderRadius: '50%', border: '1.6px solid var(--negative-visual)' } })), '重投影'),
            run.mode !== 'fixed' && !run.modeFixed
              ? h(Button, { variant: 'secondary', size: 'S', isDisabled: ovBusy, onPress: loadOverlay }, ovBusy ? '生成中…' : '加载标注图')
              : null)),
        h('div', { className: 'lc-detail-side' },
          h('div', { className: 'lc-sess-sum' },
            h('div', { className: 'lc-sess-badges' }, methodBadge(run.method), run.mode === 'tracked' ? modeBadge('tracked') : modeBadge('fixed')),
            h('span', { className: 'sp' }),
            run.solveState !== 'ok' && run.solveState !== 'warn'
              ? h(Button, { variant: 'accent', size: 'S', icon: h(Icon, { name: 'target', size: 13 }), onPress: () => {
                  if (onSolve) onSolve(run);
                  else if (CX().openSolveFromSession) CX().openSolveFromSession(s);
                } }, '立即求解')
              : solveBadge(run.solveState === 'warn' ? 'warn' : 'ok')),
          h('div', { className: 'lc-detail-sum' },
            dsum('重投影 RMS', pose.rms == null ? '—' : Number(pose.rms).toFixed(2), 'px'),
            dsum('观测数', pose.obs == null ? '—' : pose.obs, ''),
            dsum('异常点', pose.outliers == null ? '—' : pose.outliers, ''),
            dsum('缺失区域', (pose.missing && pose.missing.length) || '0', '')),
          h('div', { className: 'lc-cam-sub', style: { margin: '2px 0 0' } }, '异常点 · id / 残差 / 像素位置'),
          h('div', { className: 'cal2-restable', style: { border: '1px solid var(--chrome-line)', borderRadius: 9, overflow: 'hidden' } },
            h('div', { className: 'lc-out-head' }, h('span', null, 'id'), h('span', null, '残差 px'), h('span', null, 'uv (px)')),
            pose.rms == null && !pose.framePath
              ? h('div', { style: { padding: '12px 11px', fontSize: 12, color: 'var(--chrome-faint)' } }, '求解后将从 qa/reprojection.json 回填本点位质量。')
              : (outliers.length
                ? outliers.map((o) => h('div', { key: o.id, className: 'lc-out-row' + (o.residual_px > 2.5 ? ' over' : '') },
                    h('span', null, o.id), h('span', { className: 'rp' }, Number(o.residual_px).toFixed(2)), h('span', null, '[' + (o.uv || []).join(', ') + ']')))
                : h('div', { style: { padding: '12px 11px', fontSize: 12, color: 'var(--chrome-faint)' } },
                    pose.rms != null ? '本点位无异常点记录。' : '暂无异常点数据。'))),
          h('div', { className: 'lc-cam-sub' }, '原始帧'),
          h('div', { className: 'lc-thumbs' },
            thumbUrl
              ? h('div', { className: 'lc-thumb' }, h('img', { className: 'lc-thumb-img', src: thumbUrl, alt: 'frame' }), h('div', { className: 'lc-thumb-l' }, 'normal'))
              : ['normal', 'inverted', 'diff'].map((k) => h('div', { key: k, className: 'lc-thumb' }, h('div', { className: 'lc-thumb-img' }), h('div', { className: 'lc-thumb-l' }, k)))))));
  }
  function dsum(k, v, u) {
    return h('div', { className: 'lc-dsum' }, h('span', { className: 'k' }, k), h('div', { className: 'v' }, v, u ? h('span', { className: 'u' }, u) : null));
  }

  /* ============================================================
     固定机位 · 求解结果报告（抽屉）
     ============================================================ */
  function srMetric(k, v, u, tone) {
    return h('div', { className: 'sr-metric' + (tone ? ' sr-metric--' + tone : ''), key: k },
      h('div', { className: 'k' }, k),
      h('div', { className: 'v' }, v, u ? h('span', { className: 'u' }, u) : null));
  }
  function srPose(k, v, d) {
    return h('div', { className: 'lc-pcell', key: k }, h('span', { className: 'pk' }, k), h('span', { className: 'pv' }, Number(v).toFixed(d)));
  }
  function SolveReport({ s, run, close }) {
    const R = run.solve || buildSolveFromRun(run);
    if (!R) {
      return h('div', { className: 'drawer drawer--solverep' },
        h('div', { className: 'drawer-h' },
          h('span', { className: 'di info' }, h(Icon, { name: 'target', size: 17 })),
          h('div', { style: { minWidth: 0, flex: 1 } }, h('h2', null, '求解结果报告'),
            h('div', { className: 'sub' }, '无可用的 stage_pose 数据')),
          h('button', { className: 'iconbtn x', onClick: close }, h(Icon, { name: 'x', size: 16 }))),
        h('div', { className: 'drawer-b' }, h('div', { style: { padding: 16, color: 'var(--chrome-faint)' } }, '该记录尚未写出 Stage 位姿。')));
    }
    const warn = R.conclusion === 'warn' || R.rms >= 2;
    const total = Math.max(1, R.markers_total || R.inliers || 1);
    const inlierPct = Math.round(R.inliers / total * 100);
    const goVerify = () => {
      if (s.setCapArReq) s.setCapArReq({ cam: R.camId || run.cameraId || null });
      close();
      openLensWindow(s);
      s.pushLog({ lv: 'info', cat: 'lens', msg: '在实时画面中叠加验证 · ' + run.label + '（' + (R.cam || '') + '）' });
    };
    return h('div', { className: 'drawer drawer--solverep' },
      h('div', { className: 'drawer-h' },
        h('span', { className: 'di ' + (warn ? 'info' : 'ok') }, h(Icon, { name: 'target', size: 17 })),
        h('div', { style: { minWidth: 0, flex: 1 } },
          h('h2', null, '求解结果报告'),
          h('div', { className: 'sub', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            h('span', { className: 'cli-pill' }, run.label), modeBadge('fixed'), h('span', null, R.cam))),
        h('button', { className: 'iconbtn x', onClick: close }, h(Icon, { name: 'x', size: 16 }))),
      h('div', { className: 'drawer-b' },
        h('div', { className: 'sr-concl sr-concl--' + (warn ? 'warn' : 'ok') },
          h('span', { className: 'sr-concl-ic' }, h(Icon, { name: warn ? 'alert' : 'check', size: 20 })),
          h('div', { className: 'sr-concl-m' },
            h('div', { className: 'sr-concl-t' }, warn ? '质量警告' : '求解成功'),
            h('div', { className: 'sr-concl-d' }, warn ? (R.warn_reason || '重投影误差偏高') : '重投影误差在阈值内，可用于实时叠加验证')),
          h('span', { className: 'cap-pill cap-pill--' + (warn ? 'notice' : 'positive') + ' is-lg' }, h(Icon, { name: warn ? 'alert' : 'check', size: 13 }), 'RMS ' + Number(R.rms).toFixed(2) + ' px')),
        h('div', { className: 'sr-sec-h' }, '核心指标'),
        h('div', { className: 'sr-metrics' },
          srMetric('重投影 RMS', Number(R.rms).toFixed(2), 'px', warn ? 'notice' : 'positive'),
          srMetric('内点 / 总 marker', R.inliers + ' / ' + R.markers_total),
          srMetric('内点率', inlierPct, '%')),
        h('div', { className: 'sr-sec-h' }, '各屏幕命中 marker'),
        h('div', { className: 'sr-screens' }, (R.screens && R.screens.length)
          ? R.screens.map((sc) => {
              const pct = Math.round((sc.hits || 0) / total * 100);
              return h('div', { key: sc.name, className: 'sr-screen' },
                h('div', { className: 'sr-screen-top' }, h('span', { className: 'sr-screen-n' }, sc.name), h('span', { className: 'sr-screen-v mono' }, sc.hits + ' marker · ' + pct + '%')),
                h('div', { className: 'sr-screen-bar' }, h('i', { style: { width: pct + '%' } })));
            })
          : h('div', { style: { fontSize: 12, color: 'var(--chrome-faint)' } }, '无分屏命中数据')),
        h('div', { className: 'sr-sec-h' }, '相机 Stage 位姿', h('span', { className: 'sr-sec-tag' }, sourceTag('solve'))),
        h('div', { className: 'lc-cam-sub', style: { marginTop: 0 } }, '位置 (mm)'),
        h('div', { className: 'lc-param-grid3' }, srPose('X', R.pose.x, 1), srPose('Y', R.pose.y, 1), srPose('Z', R.pose.z, 1)),
        h('div', { className: 'lc-cam-sub' }, '旋转 (°) · Pan / Tilt / Roll'),
        h('div', { className: 'lc-param-grid3' }, srPose('Pan', R.pose.pan, 2), srPose('Tilt', R.pose.tilt, 2), srPose('Roll', R.pose.roll, 2))),
      h('div', { className: 'drawer-f between' },
        h('span', { className: 'sr-foot-meta' }, '求解于 ' + (R.solved_at || '—')),
        h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'layers', size: 15 }), onPress: goVerify }, '在实时画面中叠加验证')));
  }
  function openSolveReport(s, opts) {
    opts = opts || {};
    const run = opts.run;
    if (!run) return;
    const solve = run.solve || buildSolveFromRun(run);
    if (!solve) {
      if (CX().openReport) CX().openReport(s);
      return;
    }
    s.setModal({ render: ({ s: st, close }) => h(SolveReport, { s: st, run: Object.assign({}, run, { solve }), close }) });
  }

  /* ============================================================
     校正页检查器（基座）· 「镜头校正」入口 → 进入二级流程
     ============================================================ */
  const lensEntry = (icon, label, onClick, disabled) => h('button', { className: 'lens-entry' + (disabled ? ' is-disabled' : ''), onClick: disabled ? undefined : onClick, disabled },
    h('span', { className: 'lens-entry-ic' }, h(Icon, { name: icon, size: 15 })), h('span', null, label), h(Icon, { name: 'chevr', size: 14 }));

  /* 校正方式 · 三个紧凑选项（在二级面板内选，不跳独立页） */
  function MethodOptions({ s }) {
    const slUnlocked = s.calSlUnlock;
    return h('div', { className: 'lc-mopts' }, CAL_METHODS.map((m) => {
      const avail = m.avail || (m.id === 'sl' && slUnlocked);
      const on = s.lensCalMethod === m.id;
      return h('button', { key: m.id, className: 'lc-mopt' + (on ? ' on' : '') + (avail ? '' : ' is-disabled'),
        onClick: () => { if (avail) s.setLensCalMethod(m.id); }, title: avail ? '' : '该方式即将支持' },
        h('span', { className: 'lc-mopt-ck' }, on ? h(Icon, { name: 'check', size: 11 }) : null),
        h('span', { className: 'lc-mopt-ic' }, h(Icon, { name: CAL_METHOD_BADGES[m.id].icon, size: 15 })),
        h('div', { className: 'lc-mopt-m' },
          h('div', { className: 'lc-mopt-n' }, m.name, m.sub ? h('span', { className: 'lc-mopt-sub' }, m.sub) : null),
          h('div', { className: 'lc-mopt-d' }, m.tags.join(' · ') + (m.note ? ' · ' + m.note : ''))),
        avail ? null : h('span', { className: 'lc-mopt-soon' }, '即将支持'));
    }));
  }

  function lensInspector(s) {
    const live = CX().lensStore ? CX().lensStore.get() : null;
    const solved = s.calLensState === 'done' || (live && live.phase === 'solved');
    const pill = solved ? h('span', { className: 'spill spill--positive' }, h(Icon, { name: 'check', size: 12 }), '已求解')
      : h('span', { className: 'spill spill--neutral' }, h('span', { style: { fontWeight: 700 } }, '—'), '未开始');
    return h(React.Fragment, null,
      h('div', { className: 'insp-head' },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 9, marginBottom: 6 } },
          h('span', { className: 'step-ico', style: { width: 30, height: 30, borderRadius: 8 } }, h(Icon, { name: 'camera', size: 16 })),
          h('h2', { style: { margin: 0, fontSize: 15, fontWeight: 700 } }, '镜头校正')),
        pill),
      h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, '镜头校正'),
        h('div', { style: { display: 'grid', gap: 8 } },
          h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'camera', size: 15 }), onPress: () => { if (s.setCapTrack) s.setCapTrack('fixed'); openLensWindow(s); s.pushLog({ lv: 'info', cat: 'lens', msg: '打开镜头校正采集窗口 · 固定机位（VP-QSP 单次校正）' }); } }, '镜头校正')),
        h('div', { style: { fontSize: 11.5, color: 'var(--chrome-faint)', marginTop: 9, lineHeight: 1.5 } }, '打开镜头校正采集窗口：左侧实时画面，右侧选择方式、设置参数并开始采集。')),
      h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, '功能入口'),
        h('div', { className: 'lens-entry-list' },
          lensEntry('doc', '从已有 session 求解', () => CX().openSolveFromSession ? CX().openSolveFromSession(s) : s.pushLog({ lv: 'info', cat: 'lens', msg: '打开：从已有 session 求解' })),
          lensEntry('target', '求解结果报告', () => CX().openReport ? CX().openReport(s) : s.pushLog({ lv: 'info', cat: 'lens', msg: '打开求解结果报告' }), !solved),
          lensEntry('download', '导出 OpenTrackIO', () => CX().openExport ? CX().openExport(s) : s.pushLog({ lv: 'info', cat: 'lens', msg: '导出 OpenTrackIO' }), !solved),
          lensEntry('panel', '播放器自检', () => CX().openPlayerCheck ? CX().openPlayerCheck(s) : s.pushLog({ lv: 'info', cat: 'lens', msg: '打开播放器自检' })))));
  }

  window.VOLO_CALFLOW = {
    openLensWindow, CaptureWindow, lensInspector, openSolveReport, SolveReport,
    sourceTag, modeBadge, methodBadge, qualityLight, solveBadge, rmsSolveBadge,
    /* 供 VOLO_QSP（固定机位单次校正 UX）复用的渲染原子 */
    grp, MethodOptions, CameraParams, AROverlay,
  };
})();
