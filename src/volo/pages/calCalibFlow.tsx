// @ts-nocheck
/* Volo — 校正 · 镜头校正流程（采集大窗）
   1:1 移植自 Claude Design handoff `cal2_calib_flow.jsx`。
   检查器基座「镜头校正」打开二级大窗；方式选择在大窗内紧凑组（MethodOptions），
   偏离旧 Q3 / spec§4 的独立 MethodSelect / LensSetup 页——已删除死代码。
   采集主页接真：useMonitor MJPEG + useCaptureSession + list_lens_sessions。 */
import * as React from "react";
import { lensWorkspacePaths } from "../api/lensWorkspace";
import {
  listLensSessions, readLensQaReport, readImageAsDataUrl,
  startCaptureStills, stillsFinish,
  trackerFreeLensCal, trackerFreeVerify,
  qualityFromRms, qualityFromLabel, writeFixedRunMeta,
} from "../api/lensCommands";
import { probeTrackingSource } from "../api/captureProfiles";
import {
  spawnSidecarStreaming, cancelSidecarTask, useSidecarStream, listenSidecarStream,
} from "../api/sidecarStream";
import { useCaptureSession } from "./devCapture";
import { playerShowPattern, playerClear } from "../api/player";
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

(function () {
  const { Button, Switch } = window.Spectrum2DesignSystem_b6d1b3;
  const { useState, useRef, useEffect } = React;
  const h = React.createElement;
  const CX = () => window.VOLO_CAL2 || {};
  const BACKEND_LABEL = { uvc: 'UVC', ndi: 'NDI', decklink: 'DeckLink', synthetic: '合成' };
  const LS_CAP_PARAMS = 'volo-capw-params';
  const loadCapParams = () => {
    /* patternsDir 字段已随路径全自动化删除（图案目录由系统推导）；读到旧值忽略。 */
    try { return Object.assign({ poses: 8, settleMs: 300, burst: 5, inverted: true, graycodeSync: true, lensPath: '' }, JSON.parse(localStorage.getItem(LS_CAP_PARAMS) || '{}')); }
    catch (e) { return { poses: 8, settleMs: 300, burst: 5, inverted: true, graycodeSync: true, lensPath: '' }; }
  };
  const saveCapParams = (p) => { try { localStorage.setItem(LS_CAP_PARAMS, JSON.stringify(p)); } catch (e) {} };
  const joinPath = (dir, name) => {
    const sep = dir.indexOf('\\') >= 0 ? '\\' : '/';
    return dir.replace(/[\\/]+$/, '') + sep + name;
  };
  const pad6 = (n) => String(n).padStart(6, '0');
  const useCamStore = () => {
    const store = window.camStore;
    return React.useSyncExternalStore(
      store ? store.subscribe : () => () => {},
      () => (store ? store.get() : { cameras: CAL_CAMERAS, selectedId: CAL_CAMERAS[0] && CAL_CAMERAS[0].id }),
    );
  };
  async function writeFixedRunMetaSafe(sessionDir, meta) {
    try {
      await writeFixedRunMeta(sessionDir, meta);
    } catch (e) { /* captures/normal 仍可被 list 扫描 */ }
  }
  async function showViaDeploy(s, imagePath, pattern) {
    const store = window.deployStore && window.deployStore.get();
    const channel = (store && store.channel) || (s.calOutTarget === 'cluster' ? 'ndisplay' : 'monitor');
    if (channel === 'ndisplay') {
      const proj = CX().projStore ? CX().projStore.get() : null;
      if (!proj || !proj.path) throw new Error('无打开项目，无法 nDisplay 推图');
      const topology = window.resolveProjectTopology && window.resolveProjectTopology(proj.config);
      const screenId = s.calActiveScreen;
      const screen = topology
        ? window.stageScreenForOutput(proj.config, topology)
        : (proj.config && proj.config.screens[screenId]);
      if (!screen) throw new Error('无可用输出屏幕');
      /* 采集切图必须只传 image_path。后端有 stage 时会忽略 image_path，
         改拼各屏 patterns/<id>/full_screen.png（测试图），导致切图无效。 */
      await outputShow({
        session_id: proj.path + '::stage',
        screen,
        paths: Object.assign({}, DEFAULT_NDISPLAY_OUTPUT_PATHS),
        ssh_user: null,
        mode: 'show',
        image_path: imagePath,
      });
      return;
    }
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
  const rmsTone = (rms) => rms == null ? 'neutral' : rms < 1 ? 'positive' : rms < 2 ? 'notice' : 'negative';

  /* MethodViz / MethodSelect / LensSetup 已删：方式选择在大窗 MethodOptions 紧凑组。 */

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
  function CaptureWindow({ s, close }) {
    const method = s.lensCalMethod || 'qsp';
    const isSl = method === 'sl';
    const capturing = s.capState === 'capturing';
    const [open, setOpen] = useState({ mopt: true, general: true, method: true, camera: true, records: true });
    const camSnap = useCamStore();
    const [camId, setCamId] = useState(s.capCam || camSnap.selectedId || (camSnap.cameras[0] && camSnap.cameras[0].id));
    const [trackSignal, setTrackSignal] = useState(s.capTrack === 'fixed' ? 'none' : (s.capTrack === 'connected' ? 'freed' : 'none'));
    const tracked = trackSignal !== 'none';
    const [banner, setBanner] = useState(0);
    const [slFrame, setSlFrame] = useState(0);
    const [params, setParams] = useState(loadCapParams);
    const setP = (k, v) => setParams((f) => Object.assign({}, f, { [k]: v }));
    const gsync = !!params.graycodeSync;
    const inverted = !!params.inverted;
    const setGsync = (v) => setP('graycodeSync', v);
    const setInverted = (v) => setP('inverted', v);
    const timer = useRef(null);
    const patternAckSeq = useRef(new Set());
    const stillsOutRef = useRef(null);
    const stillsFinishingRef = useRef(false);
    const stillsResultHandledRef = useRef(new Set());
    const trackedResultHandledRef = useRef(false);
    /** Active SL nDisplay play-sequence request; cleared when play finishes/fails. */
    const slPlayReqRef = useRef(null);
    const [stillsTaskId, setStillsTaskId] = useState(null);
    const [stillsSnapN, setStillsSnapN] = useState(0);
    const stillsStream = useSidecarStream(stillsTaskId);
    const cam = (camSnap.cameras || []).find((c) => c.id === camId) || camSnap.cameras[0] || CAL_CAMERAS[0];
    const targetM = Number(params.poses) || 8;

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
    /* index 保证 calCaptureWindow 先于本文件加载，useMonitor 始终可用 */
    const monitor = window.VOLO_CAPTURE.useMonitor(profile, !capturing && !!profile && backend !== 'synthetic');
    const session = useCaptureSession();
    const [liveRuns, setLiveRuns] = useState([]);
    const [sessionsErr, setSessionsErr] = useState(null);
    const [solvingId, setSolvingId] = useState(null);

    /* 路径全自动化：标定屏幕 + 屏幕定义 / 校正图案 / 输出位置自动状态（真实后端） */
    const ag = window.VoloAutoGen.useAutoGen(s);
    const proj = CX().useProj ? CX().useProj() : {};
    const projectPath = proj && proj.path ? proj.path : null;

    const screenFile = typeof s.capScreenFile === 'string' ? s.capScreenFile : null;
    /* 输出目录固定 = <project>/vpcal/captures/（§3.4；不再用 profile.outputRoot / 手选） */
    const outDir = projectPath ? lensWorkspacePaths(projectPath).capturesDir : '';
    const deployed = s.deployState !== 'idle';
    const signalReady = backend === 'synthetic' || monitor.sig === 'ok' || (!!monitor.url && monitor.sig !== 'lost');
    const deployStoreSnap = window.deployStore && window.deployStore.get();
    const deployChannel = (deployStoreSnap && deployStoreSnap.channel)
      || (s.calOutTarget === 'cluster' ? 'ndisplay' : 'monitor');
    /* §3.5 qsp：部署 + profile + 屏幕定义已同步 + 单 section + 图案未失败（生成中 / 需重生成仍可点，
       beginCapture 会先补生成）。screenFile 由 ag 系统写入 s.capScreenFile。
       SL×nDisplay：不依赖校正图案 auto-gen，走序列播放通道。 */
    const readyQsp = method === 'qsp'
      && (backend === 'synthetic' || signalReady)
      && ag.screenDef === 'synced' && !ag.multiSection && ag.pattern !== 'genFail';
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
          let rms = null, conf = null, solveState = sess.lens_ready ? 'ok' : 'none';
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
          if (isFixed && sess.lens_ready) {
            /* lens.json RMS 不在 list 里；求解后前端 patch liveRuns */
            solveState = 'ok';
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
            error: sess.error || null,
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

    /* stills NDJSON：snap 计数 + 达目标自动 finish + 完成（result 只处理一次） */
    useEffect(() => {
      if (!stillsTaskId || !capturing || tracked) return;
      let snaps = 0;
      for (let i = 0; i < (stillsStream.state.lines || []).length; i++) {
        const line = stillsStream.state.lines[i];
        const p = line.parsed;
        if (!p) continue;
        if (p.type === 'snap_saved') snaps = Math.max(snaps, (p.index != null ? p.index + 1 : snaps + 1));
        if (p.type === 'result' && p.data) {
          const key = stillsTaskId + ':result:' + i;
          if (stillsResultHandledRef.current.has(key)) continue;
          stillsResultHandledRef.current.add(key);
          const dir = stillsOutRef.current || (p.data.session_dir);
          void writeFixedRunMetaSafe(dir, {
            mode: 'fixed', frames_captured: p.data.frames_captured || snaps,
            camera_id: camId, screen: screenFile, method: 'qsp',
          }).then(() => refreshSessions());
          s.setCapState('idle');
          setStillsTaskId(null);
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
        setStillsTaskId(null);
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
      const patternsDir = ag.patternsDir;
      for (const ev of session.events) {
        if (ev.type !== 'request_pattern' || typeof ev.sequence !== 'number') continue;
        if (patternAckSeq.current.has(ev.sequence)) continue;
        const pattern = String(ev.pattern || 'normal');
        patternAckSeq.current.add(ev.sequence);
        (async () => {
          try {
            if (patternsDir) {
              const path = joinPath(patternsDir, pattern + '.png');
              /* 按部署通道推图；nDisplay 失败不得静默回落本机 player */
              await showViaDeploy(s, path, pattern);
            }
            await session.sendCmd({ cmd: 'pattern_ready', pattern });
            if (s.setDeployState) s.setDeployState('showing');
          } catch (e) {
            patternAckSeq.current.delete(ev.sequence);
            s.pushLog({ lv: 'err', cat: 'lens', msg: '切图失败 · ' + (e && e.message ? e.message : e) });
          }
        })();
      }
    }, [capturing, session.events, ag.patternsDir]);

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
      saveCapParams(params);
      patternAckSeq.current.clear();
      stillsResultHandledRef.current.clear();
      trackedResultHandledRef.current = false;
      setBanner(0);
      setStillsSnapN(0);
      stillsFinishingRef.current = false;

      /* —— 结构光 × nDisplay：生成 → 起录像 → play-sequence → 停录像 → 解码 —— */
      if (isSl) {
        const proj = CX().projStore ? CX().projStore.get() : null;
        if (!proj || !proj.path) {
          s.pushLog({ lv: 'err', cat: 'lens', msg: '无打开项目，无法生成结构光序列' });
          return;
        }
        const screenId = s.calActiveScreen;
        if (!screenId) {
          s.pushLog({ lv: 'err', cat: 'lens', msg: '未选活动屏幕' });
          return;
        }
        const topology = window.resolveProjectTopology && window.resolveProjectTopology(proj.config);
        const screen = topology
          ? window.stageScreenForOutput(proj.config, topology)
          : (proj.config && proj.config.screens[screenId]);
        if (!screen) {
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
          s.pushLog({ lv: 'info', cat: 'lens', msg: '结构光 · 生成序列…' });
          const gen = await meshVisualGenerateStructuredLight(
            proj.path, screenId, null, 6, null, false, null);
          const framesDir = joinPath(gen.output_dir, 'frames');
          const slMeta = joinPath(gen.output_dir, 'sl_meta.json');
          /* sidecar 默认 hold_ms=500 → 播放 fps=2（与 sl_meta.sequence.hold_ms 一致） */
          const fps = 2.0;
          const durationS = Math.max(12, (Number(gen.n_frames) || 12) / fps + 8);
          const videoOut = joinPath(sessionOut, 'video');
          s.pushLog({ lv: 'info', cat: 'lens', msg: '结构光 · 开始录像 · <b>' + (profile.name || 'Profile') + '</b>' });
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
          setStillsTaskId(vResp.task_id);
          /* 略等录像落盘，再起播（哨兵软同步，起点偏差无影响） */
          await new Promise((r) => setTimeout(r, 800));
          s.pushLog({ lv: 'info', cat: 'lens', msg: '结构光 · nDisplay 播放序列 · ' + gen.n_frames + ' 帧 @ ' + fps + ' fps' });
          const screenOrigin = window.stageScreenOriginPx
            ? window.stageScreenOriginPx(proj.config.screens, screenId)
            : [0, 0];
          const playReq = {
            session_id: proj.path + '::stage',
            screen,
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
          try { await cancelSidecarTask(videoTaskId); } catch (e) { /* ignore */ }
          videoTaskId = null;
          setStillsTaskId(null);
          const corrOut = joinPath(sessionOut, 'corr.json');
          s.pushLog({ lv: 'info', cat: 'lens', msg: '结构光 · 解码…' });
          const dec = await meshVisualDecodeStructuredLight(
            videoOut, slMeta, corrOut, null, null, true);
          s.setCapState('idle');
          if (CX().lensStore) CX().lensStore.patch({ phase: 'captured' });
          s.pushLog({
            lv: 'ok', cat: 'lens',
            msg: '结构光完成 · 解码 <b>' + dec.n_dots_decoded + '</b> 点 · ' + dec.output_path,
          });
          void refreshSessions();
        } catch (e) {
          await abortSlPlayback();
          if (videoTaskId) {
            try { await cancelSidecarTask(videoTaskId); } catch (e2) { /* ignore */ }
            setStillsTaskId(null);
          }
          s.setCapState('idle');
          s.pushLog({ lv: 'err', cat: 'lens', msg: '结构光采集失败 · ' + (e && e.message ? e.message : e) });
        }
        return;
      }

      try {
        /* 图案由系统自动生成到 ag.patternsDir（含 normal.png）；开始前先推 normal.png 上屏 */
        if (ag.patternsDir) {
          const path = joinPath(ag.patternsDir, 'normal.png');
          await showViaDeploy(s, path, 'normal');
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
        const sessionOut = joinPath(outDir, 'fixed_' + new Date().toISOString().replace(/[:.]/g, '-'));
        stillsOutRef.current = sessionOut;
        s.setCapTrack('fixed');
        s.pushLog({ lv: 'info', cat: 'lens', msg: '开始固定机位采集 · <b>capture stills</b> · ' + (profile.name || 'Profile') });
        try {
          const resp = await startCaptureStills({
            backend: profile.videoBackend, device: String(profile.device),
            outDir: sessionOut, auto: true, minMarkers: 4,
            width: profile.fmtMode === 'manual' ? profile.width : null,
            height: profile.fmtMode === 'manual' ? profile.height : null,
            fps: profile.fmtMode === 'manual' ? profile.fps : null,
            transferFunction: profile.transferFunction || 'sdr',
          });
          setStillsTaskId(resp.task_id);
        } catch (e) {
          s.setCapState('idle');
          s.pushLog({ lv: 'err', cat: 'lens', msg: '固定机位启动失败 · ' + (e && e.message ? e.message : e) });
        }
        return;
      }

      /* —— 追踪机位：capture session —— */
      const sessionOut = joinPath(outDir, 'session_' + new Date().toISOString().replace(/[:.]/g, '-'));
      const camTrack = cam && cam.tracking;
      s.pushLog({ lv: 'info', cat: 'lens', msg: '开始追踪机位采集 · <b>' + (profile.name || 'Profile') + '</b>' });
      session.start({
        screenPath: screenFile, outDir: sessionOut,
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
    };
    const stop = async () => {
      await abortSlPlayback();
      if (!tracked && stillsTaskId) {
        try { await stillsFinish(stillsTaskId); } catch (e) { /* ignore */ }
        try { await cancelSidecarTask(stillsTaskId); } catch (e) { /* ignore */ }
        setStillsTaskId(null);
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
      if (!run || !run.sessionDir || !screenFile) return;
      setSolvingId(run.id);
      try {
        const images = joinPath(run.sessionDir, 'captures/normal');
        const lensJson = joinPath(run.sessionDir, 'lens.json');
        s.pushLog({ lv: 'info', cat: 'lens', msg: '固定机位求解 · <b>tracker-free lens-cal</b>…' });
        const cal = await trackerFreeLensCal({ imagesDir: images, screenPath: screenFile, outLensJson: lensJson });
        const firstPng = joinPath(images, '000000.png');
        s.pushLog({ lv: 'info', cat: 'lens', msg: '固定机位位姿 · <b>tracker-free verify</b>…' });
        const ver = await trackerFreeVerify({
          imagePath: firstPng, screenA: screenFile, screenB: screenFile, lensJson,
        });
        const pose = ver.camera_from_a;
        if (pose && window.camStore) {
          const t = pose.position_mm || [0, 0, 0];
          const e = pose.euler_deg || { rx: 0, ry: 0, rz: 0 };
          const dist = cal.dist_coeffs || [];
          /* focal_mm ≈ fx * sensor_w / image_w（用当前相机 sensor 档案） */
          const ui = window.camStore.selected();
          const sw = (ui && ui.lens && ui.lens.sensorW && ui.lens.sensorW.v) || 36;
          const focalMm = (cal.fx && cal.image_size && cal.image_size[0])
            ? cal.fx * sw / cal.image_size[0] : null;
          window.camStore.setSolvePose(camId, [t[0], t[1], t[2]], [e.rx, e.ry, e.rz], {
            focal_mm: focalMm, k1: dist[0], k2: dist[1], k3: dist[4] != null ? dist[4] : null,
            cx: cal.cx, cy: cal.cy,
          });
        }
        await writeFixedRunMetaSafe(run.sessionDir, {
          mode: 'fixed', frames_captured: run.poseCount,
          camera_id: camId, screen: screenFile, method: 'qsp',
          lens_json: lensJson, lens_rms: cal.rms, verify: ver,
        });
        s.setCalLensState('done');
        if (CX().lensStore) CX().lensStore.patch({ phase: 'solved' });
        s.pushLog({
          lv: cal.rms < 2 ? 'ok' : 'warn', cat: 'lens',
          msg: '固定机位求解完成 · RMS <b>' + Number(cal.rms).toFixed(3) + '</b> px'
            + (pose ? (' · 距屏 ' + Math.round(pose.distance_mm) + ' mm') : ''),
        });
        void refreshSessions();
      } catch (e) {
        s.pushLog({ lv: 'err', cat: 'lens', msg: '固定机位求解失败 · ' + (e && e.message ? e.message : e) });
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
    const openDetail = (runId, poseId) => s.setCapDetail({ runId, poseId });
    const runs = liveRuns;
    const tgl = (k) => setOpen((o) => Object.assign({}, o, { [k]: !o[k] }));
    const trackCfg = (cam && cam.tracking) || null;
    const trackHost = (trackCfg && trackCfg.host) || (profile && profile.trackHost) || '0.0.0.0';
    const trackPort = Number((trackCfg && trackCfg.port) || (profile && profile.trackPort) || 6301);

    /* --------- 左：实时信号 --------- */
    const hasFeed = !!previewUrl || backend === 'synthetic';
    const signal = h('div', { className: 'lc-signal' },
      hasFeed || signalReady
        ? h(React.Fragment, null,
            previewUrl
              ? h('img', { className: 'lc-feed', src: previewUrl, alt: '现场画面', style: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' } })
              : h(CameraSignal, { method, capturing, detect: !isSl && capturing, sl: isSl, slFrame }),
            h('div', { className: 'lc-vig' }),
            h('div', { className: 'lc-hud lc-hud--tl' },
              h('span', { className: 'lc-sigchip' }, capturing ? h('span', { className: 'lc-rec' }) : null,
                capturing ? 'REC · MJPEG' : 'LIVE · MJPEG'),
              h('span', { className: 'lc-sigchip' }, h('span', { className: 'mono' },
                (BACKEND_LABEL[backend] || backend || '—') + ' · ' + hudFmt))),
            capturing && !isSl ? h(React.Fragment, null,
              h('div', { className: 'lc-banner lc-banner--' + CAP_BANNERS[banner].tone },
                h(Icon, { name: CAP_BANNERS[banner].icon, size: 18 }),
                h('div', { className: 'lc-banner-tx' }, h('b', null, CAP_BANNERS[banner].label), h('span', null, CAP_BANNERS[banner].sub))),
              h('div', { className: 'lc-hud lc-hud--tr' },
                h('span', { className: 'lc-sigchip' }, '已采 ', h('b', { style: { color: '#fff', margin: '0 2px' } }, capN), ' / 目标 ' + targetM))) : null,
            capturing && isSl ? h(SlPlaybackBar, { slFrame }) : null)
        : h('div', { className: 'lc-nosig' },
            h('div', { className: 'lc-nosig-ic' }, h(Icon, { name: 'camera', size: 30, stroke: 1.3 })),
            h('div', { className: 'lc-nosig-t' }, monitor.sig === 'lost' ? '信号丢失' : '无信号'),
            h('div', { className: 'lc-nosig-d' }, profile
              ? '等待首帧或检查设备占用。可在右侧「常规设置」切换采集配置 Profile。'
              : '请先选择采集配置 Profile（信号源）。')),
      s.capDetail ? h(PoseDetail, { s, runs, onSolve: solveRun }) : null);

    /* --------- 右：设置列 --------- */
    const side = h('div', { className: 'lc-side' },
      /* 校正方式（三个紧凑选项） */
      grp('mopt', CAL_METHOD_BADGES[method].icon, '校正方式', open.mopt, () => tgl('mopt'), h(MethodOptions, { s })),
      /* a 常规设置 */
      grp('general', 'sliders', '常规设置', open.general, () => tgl('general'),
        h('div', { className: 'lc-field' }, h('span', { className: 'k' }, '采集配置 Profile'),
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
                h(Icon, { name: 'camera', size: 14 }), h('span', { className: 'v', style: { color: 'var(--notice-visual)' } }, '尚未创建 · 去新建'), h(Icon, { name: 'chevd', size: 13 }))),
        /* 标定屏幕单选 + 三个自动状态行（screen.json / 图案 / 输出位置 由系统自动推导生成） */
        h('div', { className: 'ag-block' },
          h('span', { className: 'ag-sublbl' }, '标定屏幕'),
          h(window.VoloAutoGen.ScreenChips, { ag })),
        h(window.VoloAutoGen.AutoStatusRows, { ag })),
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
        h('div', { className: 'lc-camchips' }, (camSnap.cameras || []).map((c) => h('button', { key: c.id, className: 'lc-camchip' + (c.id === camId ? ' on' : ''), onClick: () => {
            setCamId(c.id); s.setCapCam(c.id);
            if (window.camStore) window.camStore.select(c.id);
          } },
          h('span', { className: 'dot', style: { background: c.mode === 'tracked' ? 'var(--volo-500)' : c.solved ? 'var(--positive-visual)' : 'var(--chrome-faint)' } }), c.name)),
          h('button', { className: 'lc-camchip-add', title: '新建相机', onClick: () => {
            if (!window.camStore) return;
            const c = window.camStore.add();
            setCamId(c.id); s.setCapCam(c.id);
          } }, h(Icon, { name: 'plus', size: 14 }))),
        h('div', { className: 'lc-cam-bar' },
          h('span', { className: 'sp' }),
          h('button', { className: 'lc-cam-iconbtn', title: '重命名', onClick: () => {
            const name = window.prompt('相机名称', cam.name);
            if (name && window.camStore) window.camStore.rename(camId, name);
          } }, h(Icon, { name: 'sliders', size: 14 })),
          h('button', { className: 'lc-cam-iconbtn', title: '删除', onClick: () => {
            if (window.camStore) window.camStore.remove(camId);
            const next = window.camStore && window.camStore.get().selectedId;
            if (next) { setCamId(next); s.setCapCam(next); }
          } }, h(Icon, { name: 'trash', size: 14 }))),
        h('div', { className: 'lc-field' }, h('span', { className: 'k' }, '选择追踪信号'),
          h(window.Selector, { kpre: '', value: trackSignal, options: TRACK_SIGNALS, onChange: onTrackChange, width: 214, variant: 'obj', align: 'left' })),
        h(CameraParams, { cam, tracked, camId, editable: !tracked })),
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
        !liveRuns.length ? h('div', { style: { fontSize: 11.5, color: 'var(--chrome-faint)', padding: '4px 0 8px', lineHeight: 1.5 } },
          outDir ? '输出目录暂无采集会话。完成一次采集后将出现在此。' : '选择输出目录后扫描会话。') : null,
        liveRuns.length ? h('div', { className: 'lc-runs' }, runs.map((run) => h('div', { key: run.id, className: 'lc-run' },
          h('div', { className: 'lc-run-h' },
            h('span', { className: 'lc-run-n' }, run.label),
            h('span', { className: 'lc-run-time' }, run.time),
            h('div', { className: 'lc-run-badges' }, methodBadge(run.method), modeBadge(run.mode), solveBadge(run.solveState))),
          run.error ? h('div', { style: { padding: '8px 11px', fontSize: 11.5, color: 'var(--notice-visual)', borderBottom: '1px solid var(--chrome-line)' } }, run.error) : null,
          run.solveState === 'none' ? h('div', { style: { padding: '9px 11px', borderBottom: '1px solid var(--chrome-line)', display: 'flex', alignItems: 'center', gap: 10 } },
            h('span', { style: { fontSize: 11.5, color: 'var(--chrome-dim)' } }, run.poseCount + ' 点位 · 未求解'),
            h('span', { style: { flex: 1 } }),
            h(Button, { variant: 'accent', size: 'S', icon: h(Icon, { name: 'target', size: 13 }),
              isDisabled: solvingId === run.id || !!run.error,
              onPress: () => solveRun(run) }, solvingId === run.id ? '求解中…' : '立即求解')) : null,
          (run.poses || []).map((p) => h('button', { key: p.id, className: 'lc-pose' + (p.diff === 'fail' ? ' bad' : ''), onClick: () => openDetail(run.id, p.id) },
            h('span', { className: 'lc-pose-idx' }, '#' + p.idx),
            h('div', { className: 'lc-pose-m' }, h('div', { className: 'lc-pose-pose' }, p.pose), h('div', { className: 'lc-pose-sub' }, p.time + ' · ' + (p.tracked ? 'tracked' : 'fixed'))),
            h('div', { className: 'lc-pose-lights' }, qualityLight(p.detect), qualityLight(p.reproj), qualityLight(p.diff)),
            h('span', { className: 'lc-pose-rms', style: p.rms == null ? { color: 'var(--chrome-faint)' } : null }, p.rms == null ? '—' : Number(p.rms).toFixed(2))))))) : null));

    /* --------- 底部主动作条 --------- */
    /* §3.5：路径已自动化，禁用原因仅保留系统级阻断（原 screen.json / 输出目录 / 图案目录条目删除） */
    const reasons = [];
    if (!deployed) reasons.push('未部署上屏');
    if (!profile) reasons.push('未选采集配置');
    if (!signalReady && backend !== 'synthetic') reasons.push('信号源未就绪');
    if (ag.screenDef === 'exportFail') reasons.push('屏幕定义导出失败');
    if (ag.multiSection) reasons.push('折面屏（多 section）图案上屏暂不支持');
    if (ag.pattern === 'genFail') reasons.push('校正图案生成失败');
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
                   : h('span', { className: 'lc-prog-n' }, '已采点位 ', capN, h('span', { className: 'm' }, ' / ' + targetM))))
        : h(React.Fragment, null,
            h('div', { className: 'lc-start' },
              h(Button, { variant: 'accent', size: 'L',
                icon: ag.preparing ? h('span', { className: 'ag-spin' }, h(Icon, { name: 'sync', size: 16 })) : h(Icon, { name: isSl ? 'play' : 'camera', size: 16 }),
                isDisabled: !ready || ag.preparing, onPress: () => ag.beginCapture(start) },
                ag.preparing ? '生成图案中…' : (isSl ? '开始采集 · 播放序列' : '开始采集'))),
            reasons.length
              ? h('div', { className: 'lc-reasons' },
                  reasons.map((r, i) => h('span', { key: i, className: 'lc-reason' }, h(Icon, { name: 'info', size: 12 }), r)),
                  !deployed ? h('button', { className: 'flow-back', style: { padding: '3px 9px' }, onClick: () => { close(); s.setCalSection('deploy'); } }, '去上屏部署') : null,
                  ag.multiSection ? h('div', { className: 'lc-cli-note' }, h(Icon, { name: 'info', size: 13 }),
                    h('span', null, '折面屏（多 section）需通过 CLI 手动生成 / 上屏：', h('code', null, 'vpcal pattern generate --screen <screen.json> --output-dir <dir>'), '，暂无 UI 操作入口。')) : null)
              : h('div', { className: 'lc-reasons' }, h('span', { className: 'lc-reason ok' }, h(Icon, { name: 'check', size: 12 }),
                  tracked ? '前置就绪 · 追踪机位' : '前置就绪 · 固定机位（stills · 采集期间须静止）')),
            h('span', { className: 'sp' })));

    return h('div', { className: 'drawer drawer--lcwin' },
      h('div', { className: 'drawer-h' },
        h('span', { className: 'di info' }, h(Icon, { name: 'camera', size: 17 })),
        h('div', { style: { minWidth: 0, flex: 1 } }, h('h2', null, '镜头校正 · 实时采集'),
          h('div', { className: 'sub' }, methodBadge(method))),
        h('button', { className: 'iconbtn x', onClick: () => { if (capturing) stop(); close(); } }, h(Icon, { name: 'x', size: 16 }))),
      h('div', { className: 'lc-body' }, signal, side),
      actionbar);
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
    const commitPose = (axis, val) => {
      if (!window.camStore || !camId) return;
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
            onChange: (ev) => commitPose(axis, Number(ev.target.value)),
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
        cell('Sensor 宽', L.sensorW, 'mm'), cell('Sensor 高', L.sensorH, 'mm'), cell('焦距', L.focal, 'mm')),
      h('div', { className: 'lc-param-grid3' },
        cell('FOV K3', L.fovK3), cell('主点 Δx', L.ppx), cell('主点 Δy', L.ppy)),
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
          h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'camera', size: 15 }), onPress: () => { openLensWindow(s); s.pushLog({ lv: 'info', cat: 'lens', msg: '打开镜头校正采集窗口' }); } }, '镜头校正')),
        h('div', { style: { fontSize: 11.5, color: 'var(--chrome-faint)', marginTop: 9, lineHeight: 1.5 } }, '打开镜头校正采集窗口：左侧实时画面，右侧选择方式、设置参数并开始采集。')),
      h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, '功能入口'),
        h('div', { className: 'lens-entry-list' },
          lensEntry('doc', '从已有 session 求解', () => CX().openSolveFromSession ? CX().openSolveFromSession(s) : s.pushLog({ lv: 'info', cat: 'lens', msg: '打开：从已有 session 求解' })),
          lensEntry('target', '求解结果报告', () => CX().openReport ? CX().openReport(s) : s.pushLog({ lv: 'info', cat: 'lens', msg: '打开求解结果报告' }), !solved),
          lensEntry('download', '导出 OpenTrackIO', () => CX().openExport ? CX().openExport(s) : s.pushLog({ lv: 'info', cat: 'lens', msg: '导出 OpenTrackIO' }), !solved),
          lensEntry('panel', '播放器自检', () => CX().openPlayerCheck ? CX().openPlayerCheck(s) : s.pushLog({ lv: 'info', cat: 'lens', msg: '打开播放器自检' })))));
  }

  window.VOLO_CALFLOW = {
    openLensWindow, CaptureWindow, lensInspector,
    sourceTag, modeBadge, methodBadge, qualityLight, solveBadge,
  };
})();
