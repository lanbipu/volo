// @ts-nocheck
/* Volo — 网格快拍采集 · 屏幕重建（单窗口）
   1:1 port of Claude Design handoff `src/grid_capture_window.jsx`，真实接线。

   派生自 calCaptureWindow 骨架（drawer 双栏 / capw-*），业务换成无追踪快拍：
   单进程 `vpcal capture stills` 同时承担 MJPEG 监看 + 自动/手动快拍落盘
   （`<out>/captures/normal/*.png`，不写 capture_manifest）。
   三阶段态 config → capturing → done；重置通过 onSaved({reset:true}) 清 visualSession。 */
import * as React from "react";
import { lensWorkspacePaths } from "../api/lensWorkspace";
import { meshVisualPlanCapture } from "../api/meshVisualCommands";
import {
  spawnSidecarStreaming,
  cancelSidecarTaskAwaitExit,
  useSidecarStream,
} from "../api/sidecarStream";
import {
  applyMatchHysteresis,
  bboxToXywh,
  cabinetsNormBBox,
  computeFramingScore,
  FRAMING_MATCHED_HINT,
  framingDiffHint,
  stationRegionLabel,
} from "../lib/framingMatch";

(function () {
  const { Button, Switch } = window.Spectrum2DesignSystem_b6d1b3;
  const { useState, useEffect, useRef } = React;
  const h = React.createElement;
  const CX = window.VOLO_CAL2;

  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const BACKEND_LABEL = { uvc: 'UVC 摄像头', ndi: 'NDI', decklink: 'DeckLink SDI', synthetic: '合成测试源' };
  const SIGNAL = {
    ok:      { tone: 'positive', icon: 'check', text: '已连接' },
    waiting: { tone: 'notice',   icon: 'sync',  text: '等待信号' },
    lost:    { tone: 'negative', icon: 'alert', text: '信号丢失' },
  };
  const MOTION = {
    moving:   { tone: 'notice',   text: '移动中', hint: '机位移动中，等待画面稳定' },
    settling: { tone: 'notice',   text: '稳定中', hint: '画面渐稳，即将可拍' },
    ready:    { tone: 'positive', text: '待拍',   hint: '画面已稳定，可拍摄' },
    shake:    { tone: 'negative', text: '画面晃动', hint: '画面持续晃动，无法稳定' },
    nomarker: { tone: 'notice',   text: '未识别测试图', hint: '请确认画面对准测试图，检查对焦与曝光' },
  };
  const MOTION_FROM_AUTO = { moving: 'moving', stabilizing: 'settling', stable: 'ready' };
  /** UI is-low threshold; CLI `--min-markers` default is the gate source of truth. */
  const MIN_MARKERS = 4;

  function joinPath(dir, name) {
    const sep = dir.indexOf('\\') >= 0 ? '\\' : '/';
    return dir.replace(/[\\/]+$/, '') + sep + name;
  }
  function baseName(p) { return p ? String(p).split(/[\\/]/).pop() : ''; }
  function makeStamp() {
    return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  }
  /** Parse Profile lens once: numeric hfov for planning + display labels. */
  function profileLens(p) {
    if (!p) return { hfov: null, focal: null, fov: null };
    const focalN = p.focalMm != null && p.focalMm !== '' ? Number(p.focalMm) : NaN;
    const hfovN = p.hfovDeg != null && p.hfovDeg !== '' ? Number(p.hfovDeg) : NaN;
    const hfov = Number.isFinite(hfovN) && hfovN > 0 ? hfovN : null;
    return {
      hfov,
      focal: Number.isFinite(focalN) && focalN > 0 ? focalN + ' mm' : null,
      fov: hfov != null ? hfov + '°' : null,
    };
  }
  function imageSizeOf(profile, fmt) {
    if (fmt && fmt.res) return String(fmt.res).replace(/[×xX]/, 'x');
    if (profile && profile.width && profile.height) return `${profile.width}x${profile.height}`;
    return '1920x1080';
  }

  /* 参考画幅线框缩略图：两块屏幕示意 + 当前机位推荐取景框（handoff GuideThumb） */
  function GuideThumb({ box }) {
    const frame = box && box.length >= 4
      ? h('rect', {
          className: 'gt-frame',
          x: box[0] * 200, y: box[1] * 120,
          width: Math.max(2, box[2] * 200), height: Math.max(2, box[3] * 120),
          rx: 4,
        })
      : null;
    return h('svg', { className: 'gcapw-guide-svg', viewBox: '0 0 200 120', preserveAspectRatio: 'none' },
      h('rect', { className: 'gt-panel', x: 12, y: 26, width: 82, height: 70, rx: 3 }),
      h('rect', { className: 'gt-panel', x: 106, y: 26, width: 82, height: 70, rx: 3 }),
      h('text', { className: 'gcapw-guide-lb', x: 53, y: 18 }, 'A'),
      h('text', { className: 'gcapw-guide-lb', x: 147, y: 18 }, 'B'),
      frame);
  }

  /* ---------- 现场画面：真实 MJPEG + 稳定度浮标 / 快门白闪 ---------- */
  function CamFeed({ signal, url, synthetic, phase, motion, flash }) {
    let body;
    if (synthetic && !url) {
      body = h('div', { className: 'capw-mid' },
        h(Icon, { name: 'grid', size: 30, style: { color: 'var(--chrome-faint)' } }),
        h('div', { className: 'capw-mid-t' }, '内置合成图案'),
        h('div', { className: 'capw-mid-d' }, '无硬件信号，配置就绪后直接可采集'));
    } else if (signal === 'lost') {
      body = h('div', { className: 'capw-mid' },
        h(Icon, { name: 'alert', size: 30, style: { color: 'color-mix(in srgb, var(--negative-visual) 82%, #fff)' } }),
        h('div', { className: 'capw-mid-t neg' }, '设备无法打开 / 断流'),
        h('div', { className: 'capw-mid-d' }, '确认设备未被其他程序占用，检查连线后重试'));
    } else if (!url) {
      body = h('div', { className: 'capw-mid' },
        h('span', { className: 'capw-spinner' }),
        h('div', { className: 'capw-mid-t' }, '等待首帧…'),
        h('div', { className: 'capw-mid-d' }, '已建立连接，正在协商信号格式'));
    } else {
      body = h('img', { src: url, alt: '现场画面', className: 'capw-img' });
    }
    const m = MOTION[motion] || MOTION.ready;
    return h('div', { className: 'capw-canvas' },
      body,
      (phase === 'capturing' && signal === 'ok')
        ? h('div', { className: 'gcapw-motionchip gcapw-motionchip--' + m.tone },
            motion === 'ready' ? h(Icon, { name: 'check', size: 12 }) : h('span', { className: 'gcapw-mdot' }),
            m.text)
        : null,
      flash ? h('div', { className: 'gcapw-flash' }) : null);
  }

  function sumField(k, v, mono) {
    return h('div', { className: 'capw-sumf', key: k },
      h('span', { className: 'k' }, k),
      h('span', { className: 'v' + (mono ? ' mono' : '') }, v));
  }

  /* ================= 主窗口 ================= */
  function GridCaptureWindow({ s, close, onSaved }) {
    const screenId = s.calActiveScreen;
    const profiles = CX.loadProfiles ? CX.loadProfiles() : [];
    const [pid, setPid] = useState(profiles[0] ? profiles[0].id : '');
    const profile = profiles.find((p) => p.id === pid) || profiles[0] || null;
    const backend = profile && profile.videoBackend;

    const [sessionStamp, setSessionStamp] = useState(() => makeStamp());
    const [spawnGen, setSpawnGen] = useState(0);
    const [phase, setPhase] = useState('config'); /* config | capturing | done */
    const [pfOpen, setPfOpen] = useState(false);
    const [leftPct, setLeftPct] = useState(60);
    const [askAbort, setAskAbort] = useState(false);
    const [finishing, setFinishing] = useState(false);

    const [autoSnap, setAutoSnap] = useState(true);
    const [motion, setMotion] = useState('ready');
    const [shots, setShots] = useState(0);
    const [autoShots, setAutoShots] = useState(0);
    const [manualShots, setManualShots] = useState(0);
    const [lastFile, setLastFile] = useState('');
    const [lastFileNoMarker, setLastFileNoMarker] = useState(false);
    const [flash, setFlash] = useState(false);
    const [sig, setSig] = useState('waiting');
    const [url, setUrl] = useState(null);
    const [fmt, setFmt] = useState(null);
    const [taskId, setTaskId] = useState(null);
    const [spawnError, setSpawnError] = useState(null);
    const [captureResult, setCaptureResult] = useState(null);
    const [markerCount, setMarkerCount] = useState(0);
    const [markerStale, setMarkerStale] = useState(true);
    const [gateNoPattern, setGateNoPattern] = useState(false);
    const [guideStations, setGuideStations] = useState([]);
    const [poseIdx, setPoseIdx] = useState(0);
    const [matchPct, setMatchPct] = useState(0);
    const [matched, setMatched] = useState(false);
    const [obsCabinets, setObsCabinets] = useState([]);
    const [obsBbox, setObsBbox] = useState(null);
    const [guidePlanning, setGuidePlanning] = useState(false);

    const rootRef = useRef(null);
    const pfRef = useRef(null);
    const taskRef = useRef(null);
    const flashT = useRef(null);
    const lastFrame = useRef(0);
    const lineCursor = useRef(0);
    const seenSnapSeq = useRef(new Set());
    const seenResult = useRef(false);
    const finishingRef = useRef(false);
    const phaseRef = useRef(phase);
    const matchedRef = useRef(false);
    const guideOnRef = useRef(false);
    const guideLenRef = useRef(0);
    const lastAutoCmdRef = useRef(null);
    phaseRef.current = phase;
    finishingRef.current = finishing;
    taskRef.current = taskId;
    matchedRef.current = matched;
    guideLenRef.current = guideStations.length;

    const stream = useSidecarStream(taskId);
    const proj = CX.projStore ? CX.projStore.get() : null;
    const projPath = proj && proj.path ? proj.path : null;
    const screenCfg = (proj && proj.config && proj.config.screens && screenId)
      ? proj.config.screens[screenId] : null;
    const screenCols = screenCfg && screenCfg.cabinet_count ? screenCfg.cabinet_count[0] : 8;
    const screenRows = screenCfg && screenCfg.cabinet_count ? screenCfg.cabinet_count[1] : 4;
    const lens = profileLens(profile);
    const hfov = lens.hfov;
    const planImageSize = imageSizeOf(profile, fmt);
    const guideOn = guideStations.length > 0;
    guideOnRef.current = guideOn;
    const curStation = guideStations.length
      ? guideStations[poseIdx % guideStations.length]
      : null;
    const curCovers = (curStation && curStation.covers_cabinets) || [];
    const curExpBox = curStation
      ? cabinetsNormBBox(curCovers, screenCols, screenRows)
      : null;
    const curGuideBox = bboxToXywh(curExpBox);

    /* 输出目录固定 = <project>/vpcal/captures/（对齐镜头流程 §3.4；不再用
       profile.outputRoot / 手选,sidecar 落盘时自动建目录） */
    const sessionRoot = projPath ? lensWorkspacePaths(projPath).capturesDir : '';
    const sessionDir = sessionRoot ? joinPath(sessionRoot, 'stills_' + sessionStamp) : '';

    /* ---- 缩放 / 分栏（同 calCaptureWindow） ---- */
    const onResize = (dx, dy) => (e) => {
      e.preventDefault(); e.stopPropagation();
      const host = rootRef.current && rootRef.current.parentElement; if (!host) return;
      const r = host.getBoundingClientRect(); const sw = r.width, sh = r.height, sx = e.clientX, sy = e.clientY;
      const move = (ev) => {
        host.style.width = clamp(sw + dx * 2 * (ev.clientX - sx), 780, window.innerWidth - 24) + 'px';
        host.style.height = clamp(sh + dy * 2 * (ev.clientY - sy), 440, window.innerHeight - 24) + 'px';
      };
      const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.body.style.cursor = ''; };
      document.body.style.cursor = getComputedStyle(e.currentTarget).cursor;
      document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
    };
    const onSplit = (e) => {
      e.preventDefault();
      const capw = rootRef.current && rootRef.current.querySelector('.capw'); if (!capw) return;
      const rect = capw.getBoundingClientRect(); const sx = e.clientX, sp = leftPct;
      const move = (ev) => setLeftPct(clamp(sp + ((ev.clientX - sx) / rect.width) * 100, 34, 74));
      const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.body.style.cursor = ''; };
      document.body.style.cursor = 'col-resize';
      document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
    };
    useEffect(() => {
      if (!pfOpen) return undefined;
      const d = (e) => { if (pfRef.current && !pfRef.current.contains(e.target)) setPfOpen(false); };
      document.addEventListener('mousedown', d);
      return () => document.removeEventListener('mousedown', d);
    }, [pfOpen]);

    const sendCmd = (cmd) => {
      const id = taskRef.current;
      if (!id) return Promise.resolve(false);
      return stream.writeLine(JSON.stringify(cmd));
    };

    const syncAuto = (enabled) => {
      const on = !!enabled;
      if (lastAutoCmdRef.current === on) return Promise.resolve(true);
      lastAutoCmdRef.current = on;
      return sendCmd({ cmd: 'auto', enabled: on });
    };

    const resetMatch = () => { setMatched(false); setMatchPct(0); };

    const stopTask = async () => {
      const t = taskRef.current;
      taskRef.current = null;
      lastAutoCmdRef.current = null;
      setTaskId(null); setUrl(null); setSig('waiting'); setFmt(null);
      if (t) await cancelSidecarTaskAwaitExit(t);
    };

    const startStills = async (outDir) => {
      await stopTask();
      lineCursor.current = 0;
      seenSnapSeq.current = new Set();
      seenResult.current = false;
      setSpawnError(null);
      setSig('waiting'); setUrl(null); setFmt(null);
      if (!profile || !outDir) return;
      const args = [
        'capture', 'stills',
        '--backend', profile.videoBackend,
        '--device', String(profile.device || '0'),
        '--allow-hx', '--preview-port', '0',
        '--out', outDir,
        '--no-auto',
        '--min-markers', String(MIN_MARKERS),
        '--output', 'ndjson',
      ];
      if (profile.fmtMode === 'manual' && profile.width) args.push('--width', String(profile.width));
      if (profile.fmtMode === 'manual' && profile.height) args.push('--height', String(profile.height));
      if (profile.fmtMode === 'manual' && profile.fps) args.push('--fps', String(profile.fps));
      args.push('--transfer-function', profile.transferFunction || 'sdr');
      try {
        const resp = await spawnSidecarStreaming('vpcal', args);
        setTaskId(resp.task_id);
      } catch (e) {
        setSig('lost');
        setSpawnError(e && e.message ? e.message : String(e));
      }
    };

    /* Profile+目录就绪即单进程 spawn。勿把 phase 放进依赖——config→capturing 必须保活同一进程。 */
    const canSpawn = !!(profile && sessionDir);
    useEffect(() => {
      if (!canSpawn) return undefined;
      void startStills(sessionDir);
      return () => { void stopTask(); };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [canSpawn, pid, sessionDir, spawnGen]);

    /* 参考画幅规划：需项目路径 + 活跃屏 + Profile.hfovDeg；失败则引导层整体隐藏 */
    useEffect(() => {
      if (!projPath || !screenId || hfov == null) {
        setGuideStations([]);
        setGuidePlanning(false);
        return undefined;
      }
      let cancelled = false;
      setGuidePlanning(true);
      meshVisualPlanCapture(projPath, screenId, planImageSize, hfov, null).then((plan) => {
        if (cancelled) return;
        const stations = (plan && plan.stations) || [];
        setGuideStations(stations);
        setPoseIdx(0);
        resetMatch();
        if (!stations.length) {
          s.pushLog({ lv: 'warn', cat: 'capture', msg: '参考画幅规划返回 0 机位 · 退化为纯快拍' });
        } else {
          s.pushLog({
            lv: 'ok', cat: 'capture',
            msg: '参考画幅规划完成 · ' + stations.length + ' 机位 · hfov ' + hfov + '°',
          });
        }
      }).catch((e) => {
        if (cancelled) return;
        setGuideStations([]);
        s.pushLog({
          lv: 'warn', cat: 'capture',
          msg: '参考画幅规划失败 · 退化为纯快拍 · ' + (e && e.message ? e.message : e),
        });
      }).finally(() => { if (!cancelled) setGuidePlanning(false); });
      return () => { cancelled = true; };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pid, screenId, hfov, projPath, planImageSize]);

    /* 匹配分：期望箱体 ∩ 实测箱体 + bbox 占比容差；滞回防闪烁 */
    useEffect(() => {
      if (!guideOn || !guideStations.length) {
        setMatchPct(0); setMatched(false);
        return;
      }
      const station = guideStations[poseIdx % guideStations.length];
      if (!station || markerStale) return;
      const expected = station.covers_cabinets || [];
      const expBox = cabinetsNormBBox(expected, screenCols, screenRows);
      const score = computeFramingScore(expected, obsCabinets, expBox, obsBbox);
      setMatchPct((cur) => (cur === score ? cur : score));
      setMatched((prev) => applyMatchHysteresis(score, prev));
    }, [guideOn, guideStations, poseIdx, obsCabinets, obsBbox, markerStale, screenCols, screenRows]);

    /* 引导开启时：仅绿框 + 用户开关打开才放行后端自动快门 */
    useEffect(() => {
      if (phase !== 'capturing' || !guideOn) return undefined;
      void syncAuto(!!(autoSnap && matched));
      return undefined;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [phase, guideOn, autoSnap, matched]);

    /* 增量消费 stills NDJSON（避免每行整表 O(n²) 重扫） */
    useEffect(() => {
      const lines = stream.state.lines;
      if (lineCursor.current > lines.length) lineCursor.current = 0;
      for (; lineCursor.current < lines.length; lineCursor.current += 1) {
        const p = lines[lineCursor.current].parsed;
        if (!p || typeof p.type !== 'string') continue;

        if (p.type === 'preview_ready' && p.mjpeg_url) {
          setUrl((u) => (u === p.mjpeg_url ? u : p.mjpeg_url));
        }
        if (p.type === 'source_info') {
          lastFrame.current = Date.now();
          setSig('ok');
          setFmt({
            res: p.width + '×' + p.height,
            fps: p.fps == null ? '—' : Number(p.fps).toFixed(2),
            pix: (p.pixel_format || p.fourcc || 'Unknown') + ' ' + (p.bit_depth || '') + '-bit',
            depth: (p.bit_depth || '—') + ' bit',
          });
        }
        if (p.type === 'progress') lastFrame.current = Date.now();

        if (p.type === 'detect_state') {
          const n = typeof p.markers === 'number' ? p.markers : 0;
          const stale = !!p.stale;
          setMarkerCount((cur) => (cur === n ? cur : n));
          setMarkerStale((cur) => (cur === stale ? cur : stale));
          const cabs = Array.isArray(p.cabinets)
            ? p.cabinets.map((c) => [c[1] | 0, c[2] | 0])
            : [];
          setObsCabinets((cur) => {
            if (cur.length === cabs.length
              && cur.every((c, i) => c[0] === cabs[i][0] && c[1] === cabs[i][1])) {
              return cur;
            }
            return cabs;
          });
          const bbox = Array.isArray(p.bbox_frac) && p.bbox_frac.length >= 4 ? p.bbox_frac : null;
          setObsBbox((cur) => {
            if (cur === bbox) return cur;
            if (cur && bbox && cur.length === bbox.length
              && cur.every((v, i) => v === bbox[i])) return cur;
            return bbox;
          });
        }

        if (p.type === 'auto_state' && phaseRef.current === 'capturing') {
          const m = MOTION_FROM_AUTO[p.state] || 'moving';
          const blocked = p.gate === 'no_pattern';
          setMotion((cur) => (cur === m ? cur : m));
          setGateNoPattern((cur) => (cur === blocked ? cur : blocked));
        }
        if (p.type === 'warning' && p.code === 'never_stable') {
          setMotion('shake');
        }
        if (p.type === 'snap_saved') {
          lastFrame.current = Date.now();
          const key = String(p.sequence != null ? p.sequence : p.index) + ':' + (p.path || '');
          if (seenSnapSeq.current.has(key)) continue;
          seenSnapSeq.current.add(key);
          const name = baseName(p.path) || '000000.png';
          const noMk = !p.auto && p.markers === 0;
          setLastFile(name);
          setLastFileNoMarker(noMk);
          setShots((n) => n + 1);
          if (p.auto) setAutoShots((n) => n + 1); else setManualShots((n) => n + 1);
          setFlash(true);
          clearTimeout(flashT.current);
          flashT.current = setTimeout(() => setFlash(false), 200);
          if (noMk) {
            s.pushLog({
              lv: 'warn', cat: 'capture',
              msg: '手动快拍 · 已保存 ' + name + ' · 未检测到标记，重建时将被忽略',
            });
          }
          setGateNoPattern(false);
          if (p.auto && guideOnRef.current) {
            setPoseIdx((i) => {
              const n = guideLenRef.current;
              return n ? (i + 1) % n : i;
            });
            setMatched(false);
            setMatchPct(0);
          }
        }
        if (p.type === 'result' && p.data && !seenResult.current
            && (phaseRef.current === 'capturing' || finishingRef.current)) {
          seenResult.current = true;
          setCaptureResult(p.data);
          setFinishing(false);
          setPhase('done');
          const n = p.data.frames_captured != null ? p.data.frames_captured : 0;
          s.pushLog({
            lv: 'ok', cat: 'capture',
            msg: '快拍采集完成 · 共 ' + n + ' 张（自动 ' + (p.data.auto_snaps || 0)
              + ' · 手动 ' + (p.data.manual_snaps || 0) + '）',
          });
        }
      }
    }, [stream.state.lines]);

    useEffect(() => {
      if (!taskId) return undefined;
      const t = setInterval(() => {
        const age = Date.now() - lastFrame.current;
        setSig((cur) => {
          if (cur === 'ok' && age > 4000) return 'waiting';
          if (cur === 'waiting' && lastFrame.current > 0 && age < 2500) return 'ok';
          return cur;
        });
      }, 1000);
      return () => clearInterval(t);
    }, [taskId]);

    useEffect(() => {
      const exit = stream.state.exit;
      if (!exit) return;
      setTaskId(null);
      taskRef.current = null;
      if (exit.cancelled || phaseRef.current === 'done' || finishingRef.current) return;
      if (exit.fatal) {
        setSig('lost');
        setUrl(null);
        s.pushLog({
          lv: 'err', cat: 'capture',
          msg: '快拍进程异常退出 · ' + (exit.stderr_tail || ('exit ' + exit.exit_code)),
        });
        setPhase('config');
        setFinishing(false);
        setSpawnGen((g) => g + 1);
      }
    }, [stream.state.exit]);

    useEffect(() => {
      if (spawnError) {
        s.pushLog({ lv: 'err', cat: 'capture', msg: '快拍采集启动失败 · ' + spawnError });
      }
    }, [spawnError]);

    const reasons = [];
    if (!profile) reasons.push('未选择采集配置');
    if (sig === 'lost') reasons.push('信号丢失，无法采集');
    if (!projPath) reasons.push('未打开项目，无法定位输出目录');
    const canStart = reasons.length === 0 && !!sessionDir && !!taskId && sig !== 'lost';

    const start = async () => {
      if (!canStart) return;
      setCaptureResult(null);
      seenResult.current = false;
      setPhase('capturing');
      setMotion('moving');
      s.pushLog({
        lv: 'info', cat: 'capture',
        msg: '开始快拍采集 · 屏幕重建 · 配置 <b>' + profile.name + '</b> · 会话 ' + sessionDir
          + (guideOn ? (' · 引导 ' + guideStations.length + ' 机位') : ''),
      });
      await syncAuto(!!autoSnap && (!guideOn || matchedRef.current));
    };

    const toggleAuto = async (on) => {
      setAutoSnap(on);
      if (phase === 'capturing') {
        await syncAuto(!!on && (!guideOnRef.current || matchedRef.current));
      }
    };

    const advancePose = (delta) => {
      const n = guideStations.length;
      if (!n) return;
      setPoseIdx((i) => (i + delta + n) % n);
      resetMatch();
    };

    const doSnap = () => {
      if (phase !== 'capturing') return;
      void sendCmd({ cmd: 'snap' });
    };

    const finish = async () => {
      if (shots === 0 || finishing) return;
      setFinishing(true);
      await sendCmd({ cmd: 'finish' });
    };

    const doAbort = async () => {
      setAskAbort(false);
      await stopTask();
      setPhase('config');
      s.pushLog({
        lv: 'warn', cat: 'capture',
        msg: '快拍采集已中止 · ' + shots + ' 张保留在会话目录 ' + sessionDir,
      });
      close && close();
    };

    const rearm = ({ clearSession }) => {
      setShots(0); setAutoShots(0); setManualShots(0); setLastFile('');
      setLastFileNoMarker(false);
      setGateNoPattern(false);
      setMarkerCount(0); setMarkerStale(true);
      setObsCabinets([]); setObsBbox(null);
      setPoseIdx(0); resetMatch();
      setCaptureResult(null); setMotion('ready'); setAutoSnap(true);
      seenSnapSeq.current = new Set();
      seenResult.current = false;
      lineCursor.current = 0;
      setSessionStamp(makeStamp());
      setPhase('config');
      if (clearSession) {
        CX.projStore.patch({ visualSession: null });
        s.setCalReceipt({ tone: 'warn', text: '已清除采集会话' });
        s.pushLog({ lv: 'warn', cat: 'capture', msg: '已重置采集 · 清除已采信息，可重新采集' });
        onSaved && onSaved({ reset: true });
      }
    };

    const summary = () => {
      const n = captureResult && captureResult.frames_captured != null ? captureResult.frames_captured : shots;
      const a = captureResult && captureResult.auto_snaps != null ? captureResult.auto_snaps : autoShots;
      const m = captureResult && captureResult.manual_snaps != null ? captureResult.manual_snaps : manualShots;
      const dir = (captureResult && captureResult.session_dir) || sessionDir;
      return { n, a, m, dir };
    };

    const savedSession = () => {
      const { n, a, m, dir } = summary();
      const msg = '已保存采集会话 · ' + n + ' 张';
      s.pushLog({ lv: 'ok', cat: 'capture', msg });
      s.setCalReceipt({ tone: 'ok', text: msg });
      CX.projStore.patch({ visualSession: { screenId, poses: n, sessionDir: dir } });
      close && close();
      onSaved && onSaved({ shots: n, auto: a, manual: m, session_dir: dir });
    };

    const locked = phase === 'capturing';
    const displaySig = backend === 'synthetic' && url ? 'ok' : sig;
    const sigMeta = SIGNAL[displaySig] || SIGNAL.waiting;
    const lowMarkers = displaySig === 'ok' && !markerStale && markerCount < MIN_MARKERS;
    const effMotion = (phase === 'capturing' && motion === 'ready'
      && (gateNoPattern || lowMarkers)) ? 'nomarker' : (phase === 'capturing' ? motion : 'ready');
    const mstate = MOTION[effMotion] || MOTION.ready;

    /* ---------- 头部 ---------- */
    const head = h('div', { className: 'drawer-h' },
      h('span', { className: 'di info' }, h(Icon, { name: 'camera', size: 17 })),
      h('div', { style: { minWidth: 0, flex: 1 } },
        h('h2', null, '快拍采集 · 屏幕重建'),
        h('div', { className: 'sub', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('span', { className: 'cli-pill' }, backend === 'synthetic' ? 'synthetic' : 'MJPEG live'),
          profile ? h('span', null, profile.name) : null)),
      h('button', {
        className: 'iconbtn x', style: { width: 26, height: 26 },
        onClick: () => { if (locked) setAskAbort(true); else { void stopTask(); close(); } },
      }, h(Icon, { name: 'x', size: 16 })));

    /* ---------- 左侧现场画面 ---------- */
    const guideActive = guideOn && phase === 'capturing' && displaySig === 'ok';
    const diffHint = (guideActive && curStation && !matched)
      ? framingDiffHint(curCovers, obsCabinets, screenCols, screenRows)
      : '';
    const stage = h('div', { className: 'capw-stage' },
      h('div', { className: 'capw-feed' },
        h(CamFeed, {
          signal: displaySig, url, synthetic: backend === 'synthetic',
          phase, motion: effMotion, flash,
        }),
        guideActive
          ? h('div', { className: 'gcapw-matchframe gcapw-matchframe--' + (matched ? 'ok' : 'no') },
              h('div', { className: 'gcapw-matchbadge gcapw-matchbadge--' + (matched ? 'ok' : 'no') },
                h(Icon, { name: matched ? 'check' : 'target', size: 13 }),
                h('span', null, matched ? '构图匹配' : (diffHint || '继续对准')),
                h('span', { className: 'gcapw-match-pct mono' }, Math.round(matchPct) + '%')))
          : null,
        h('div', { className: 'capw-sigbadge' },
          h('span', { className: 'cap-pill cap-pill--' + (backend === 'synthetic' ? 'informative' : sigMeta.tone) + ' is-lg' },
            displaySig === 'waiting'
              ? h('span', { className: 'capw-pill-spin' }, h(Icon, { name: 'sync', size: 13 }))
              : h(Icon, { name: backend === 'synthetic' ? 'grid' : sigMeta.icon, size: 13 }),
            backend === 'synthetic' ? '合成源' : sigMeta.text)),
        (displaySig === 'ok' || backend === 'synthetic')
          ? h('div', {
              className: 'gcapw-markerread'
                + (markerStale ? ' is-stale' : '')
                + (lowMarkers ? ' is-low' : ''),
              title: 'VP-QSP 标定标记实时检测数 · 内容门够数才自动拍摄',
            },
              h(Icon, { name: 'grid', size: 12 }),
              h('span', { className: 'k' }, '检测到'),
              h('span', { className: 'n mono' }, markerStale ? '—' : markerCount),
              h('span', { className: 'k' }, '个标记'))
          : null,
        (displaySig === 'ok' || backend === 'synthetic')
          ? h('span', { className: 'capw-livedot' }, h('i', null), locked ? 'REC' : 'LIVE')
          : null),
      h('div', { className: 'capw-fmtbar' },
        backend === 'synthetic'
          ? h('span', { className: 'capw-fmt-read' }, h(Icon, { name: 'grid', size: 12 }), '内置合成图案 · 无硬件信号')
          : displaySig === 'lost'
            ? h('span', { className: 'capw-fmt-read dim' }, h(Icon, { name: 'x', size: 12 }), '无信号 · 格式不可读')
            : fmt
              ? h('span', { className: 'capw-fmt-read' },
                  h('b', null, fmt.res), h('span', { className: 'sep' }, '·'), h('span', null, fmt.fps + ' fps'),
                  h('span', { className: 'sep' }, '·'), h('span', { className: 'dim' }, fmt.pix),
                  h('span', { className: 'sep' }, '·'), h('span', { className: 'dim' }, fmt.depth))
              : h('span', { className: 'capw-fmt-read dim' }, '等待格式上报…'),
        backend !== 'synthetic' && displaySig !== 'lost' && fmt
          ? h('span', { className: 'capw-fmt-auto' }, h(Icon, { name: 'check', size: 12 }), '自动读取')
          : null),
      guideActive
        ? h('div', { className: 'gcapw-lenslock' },
            h(Icon, { name: 'pin', size: 13 }),
            h('span', { className: 'gcapw-lenslock-t' }, '引导会话进行中 · 本次会话请保持焦距不变'),
            (lens.focal || lens.fov)
              ? h('span', { className: 'gcapw-lenslock-v mono' }, lens.focal || lens.fov)
              : null)
        : null);

    /* ---------- 右栏：信号源 ---------- */
    const sourceSection = h('div', { className: 'cap-card' + (locked ? ' is-locked' : '') },
      h('div', { className: 'cap-card-h' }, h(Icon, { name: 'camera', size: 15 }), '信号源',
        h('span', { className: 'capw-code' }, 'source')),
      h('div', { className: 'capw-pick' },
        h('span', { className: 'capw-pick-lb' }, 'Capture Profile'),
        h('div', { className: 'capw-pfsel', ref: pfRef },
          h('button', {
            className: 'capw-pfbtn' + (pfOpen ? ' open' : ''), disabled: locked,
            onClick: () => !locked && setPfOpen((v) => !v),
          },
            h('span', { className: 'capw-pf-ic' }, h(Icon, { name: backend === 'synthetic' ? 'grid' : 'camera', size: 14 })),
            h('span', { className: 'capw-pf-main' },
              h('b', null, profile ? profile.name : '未选择'),
              h('span', null, profile ? (BACKEND_LABEL[backend] + ' / ' + profile.device) : '—')),
            h(Icon, { name: 'chevd', size: 14 })),
          pfOpen ? h('div', { className: 'capw-pfmenu' },
            profiles.map((p) => h('button', {
              key: p.id,
              className: 'capw-pfopt' + (p.id === pid ? ' on' : ''),
              onClick: () => {
                setPid(p.id); setOutputDir('');
                setPfOpen(false); rearm({ clearSession: false });
              },
            },
              h('span', { className: 'capw-pf-ic' }, h(Icon, { name: p.videoBackend === 'synthetic' ? 'grid' : 'camera', size: 14 })),
              h('span', { className: 'capw-pf-main' },
                h('b', null, p.name),
                h('span', null, BACKEND_LABEL[p.videoBackend] + ' / ' + p.device)),
              p.id === pid ? h(Icon, { name: 'check', size: 14 }) : null)),
            h('button', {
              className: 'capw-pfmanage',
              onClick: () => {
                setPfOpen(false);
                if (window.VOLO_CAL2 && window.VOLO_CAL2.openCaptureModal) {
                  void stopTask(); close && close();
                  window.VOLO_CAL2.openCaptureModal(s);
                }
              },
            }, h(Icon, { name: 'sliders', size: 14 }), '管理采集配置…')) : null)),
      (lens.focal || lens.fov)
        ? h('div', { className: 'capw-pick gcapw-lensrow' },
            h('span', { className: 'capw-pick-lb' }, '镜头参数', h('span', { className: 'capw-opt' }, '来自 Profile')),
            h('div', { className: 'gcapw-lens-vals' },
              lens.focal
                ? h('div', { className: 'gcapw-lens-v' }, h('span', { className: 'k' }, '焦距'), h('span', { className: 'v mono' }, lens.focal))
                : null,
              lens.fov
                ? h('div', { className: 'gcapw-lens-v' }, h('span', { className: 'k' }, '视场角'), h('span', { className: 'v mono' }, lens.fov))
                : null,
              h('span', { className: 'gcapw-lens-note' }, h(Icon, { name: 'pin', size: 12 }),
                guidePlanning ? '正在规划参考画幅…' : '引导拍摄须保持不变')))
        : null,
      h('div', { className: 'capw-pick' },
        h('span', { className: 'capw-pick-lb' }, '输出目录', h('span', { className: 'capw-opt' }, '来自项目')),
        h('div', { className: 'gcapw-autodir' },
          h('div', { className: 'gcapw-autodir-h' },
            h(Icon, { name: 'folder', size: 14 }),
            h('span', { className: 'mono' }, sessionRoot || '—'),
            sessionRoot
              ? h('span', { className: 'cap-pill cap-pill--positive', style: { marginLeft: 'auto' } },
                  h(Icon, { name: 'check', size: 12 }), '已就绪')
              : null),
          h('div', { className: 'gcapw-autodir-s' },
            '每次采集自动生成子目录 · ', h('span', { className: 'mono' }, 'stills_' + sessionStamp)))));

    /* ---------- 参考画幅引导卡 ---------- */
    const poseLabel = curStation
      ? stationRegionLabel(curStation.role, curCovers, screenCols, screenRows, curExpBox)
      : '—';
    const guideCard = guideOn ? h('div', { className: 'cap-card gcapw-guide' },
      h('div', { className: 'cap-card-h' }, h(Icon, { name: 'target', size: 15 }), '参考画幅',
        h('span', { className: 'gcapw-guide-prog' }, '机位 ',
          h('b', { className: 'mono' }, (poseIdx % guideStations.length) + 1),
          ' / ', h('span', { className: 'mono' }, guideStations.length))),
      h('div', { className: 'gcapw-guide-body' },
        h('div', { className: 'gcapw-guide-thumbwrap' },
          h(GuideThumb, { box: curGuideBox }),
          h('span', { className: 'gcapw-guide-region' }, poseLabel)),
        h('div', { className: 'gcapw-guide-side' },
          h('div', { className: 'gcapw-guide-match gcapw-guide-match--' + (matched ? 'ok' : 'no') },
            h(Icon, { name: matched ? 'check' : 'target', size: 13 }),
            h('span', { className: 'gcapw-guide-match-t' }, matched ? '构图匹配' : '继续对准'),
            h('span', { className: 'gcapw-guide-match-pct mono' }, Math.round(matchPct) + '%')),
          h('div', { className: 'gcapw-guide-diff' },
            matched ? FRAMING_MATCHED_HINT : (diffHint || '继续对准推荐区域')))),
      h('div', { className: 'gcapw-guide-nav' },
        h('button', { className: 'gcapw-guide-btn', onClick: () => advancePose(-1) },
          h(Icon, { name: 'arrowl', size: 14 }), '上一个'),
        h('button', { className: 'gcapw-guide-btn', onClick: () => advancePose(1) },
          '下一个', h(Icon, { name: 'arrowr', size: 14 })),
        h('button', { className: 'gcapw-guide-btn gcapw-guide-skip', onClick: () => advancePose(1) }, '跳过此机位')))
      : null;

    /* ---------- 采集控制卡 ---------- */
    const captureCard = h('div', { className: 'cap-card gcapw-capcard' },
      h('div', { className: 'cap-card-h' }, h(Icon, { name: 'camera', size: 15 }), '快拍采集',
        h('span', { className: 'spill spill--notice', style: { marginLeft: 'auto' } },
          h(Icon, { name: 'camera', size: 12 }), finishing ? '保存中…' : '采集中')),
      h('div', { className: 'gcapw-autorow' },
        h('div', null,
          h('div', { className: 'cap-tg-t' }, '自动快拍'),
          h('div', { className: 'cap-tg-s' },
            guideOn
              ? '构图匹配（绿框）且画面稳定后自动拍摄'
              : '画面稳定后自动拍摄一张，无需手动')),
        h(Switch, { isSelected: autoSnap, onChange: toggleAuto, isDisabled: finishing })),
      h('div', { className: 'gcapw-statusbadge gcapw-statusbadge--' + mstate.tone },
        effMotion === 'ready' ? h(Icon, { name: 'check', size: 14 }) : h('span', { className: 'gcapw-mdot' }),
        h('span', { className: 'gcapw-status-t' }, mstate.text),
        h('span', { className: 'gcapw-status-h' }, mstate.hint)),
      h('div', { className: 'gcapw-shutterwrap' },
        h('button', { className: 'gcapw-shutter', disabled: finishing, onClick: doSnap },
          h('span', { className: 'gcapw-shutter-ring' }),
          h('span', { className: 'gcapw-shutter-core' }, h(Icon, { name: 'camera', size: 26 }))),
        h('div', { className: 'gcapw-shutter-cap' }, '手动快门 · 随时可拍')),
      h('div', { className: 'gcapw-count' },
        h('div', { className: 'gcapw-count-main' },
          h('span', { className: 'gcapw-count-n', key: shots }, shots),
          h('span', { className: 'gcapw-count-u' }, '张')),
        h('div', { className: 'gcapw-count-side' },
          h('div', { className: 'gcapw-count-split' },
            h('span', null, '自动 ', h('b', null, autoShots)),
            h('span', { className: 'sep' }, '·'),
            h('span', null, '手动 ', h('b', null, manualShots))),
          h('div', { className: 'gcapw-count-file' }, lastFile
            ? h(React.Fragment, null, h('span', { className: 'k' }, '最近'), h('span', { className: 'mono' }, lastFile))
            : h('span', { className: 'dim' }, '尚未拍摄')))),
      (lastFile && lastFileNoMarker)
        ? h('div', { className: 'gcapw-nomkwarn' },
            h(Icon, { name: 'alert', size: 13 }),
            h('span', null, '该张未检测到标记，重建时将被忽略'))
        : null,
      motion === 'shake'
        ? h('div', { className: 'capw-note capw-note--negative gcapw-warn' },
            h(Icon, { name: 'alert', size: 14 }),
            h('span', null, '画面持续晃动，无法自动拍摄。请放慢移动、稳定机位后再拍，或改用手动快门。'))
        : null);

    const sourceStrip = h('div', { className: 'gcapw-srcstrip' },
      h('span', { className: 'gcapw-srcstrip-ic' },
        h(Icon, { name: backend === 'synthetic' ? 'grid' : 'camera', size: 14 })),
      h('div', { className: 'gcapw-srcstrip-main' },
        h('b', null, profile ? profile.name : '—'),
        h('span', { className: 'mono' }, sessionDir || '—')),
      h('span', { className: 'cap-pill cap-pill--positive' },
        h(Icon, { name: 'check', size: 12 }), '会话就绪'));

    const sum = summary();
    const summaryCard = h('div', { className: 'cap-card capw-summary' },
      h('div', { className: 'cap-card-h' },
        h('span', { className: 'capw-ok-ic' }, h(Icon, { name: 'check', size: 15 })), '采集汇总',
        h('span', { className: 'spill spill--positive', style: { marginLeft: 'auto' } }, '会话已完成')),
      h('div', { className: 'capw-cov-metrics' },
        h('div', { className: 'capw-cov-m' }, h('div', { className: 'k' }, '总张数'), h('div', { className: 'v' }, sum.n)),
        h('div', { className: 'capw-cov-m' }, h('div', { className: 'k' }, '自动'), h('div', { className: 'v' }, sum.a)),
        h('div', { className: 'capw-cov-m' }, h('div', { className: 'k' }, '手动'), h('div', { className: 'v' }, sum.m))),
      h('div', { className: 'capw-sumfields' },
        sumField('session 目录', sum.dir, true),
        sumField('capture profile', profile ? profile.name : '—'),
        sumField('信号格式', backend === 'synthetic' ? '合成 8-bit' : (fmt ? (fmt.res + ' · ' + fmt.fps + ' fps') : '—'))));

    let side;
    if (phase === 'done') {
      side = h(React.Fragment, null,
        h('div', { className: 'capw-side-scroll' }, summaryCard),
        h('div', { className: 'capw-foot' },
          h(Button, { variant: 'secondary', size: 'M', icon: h(Icon, { name: 'sync', size: 15 }), onPress: () => rearm({ clearSession: false }) }, '重新采集'),
          h('div', { style: { flex: 1 } }),
          h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'check', size: 15 }), onPress: savedSession }, '保存会话')));
    } else if (phase === 'capturing') {
      side = h(React.Fragment, null,
        h('div', { className: 'capw-side-scroll' }, guideCard, captureCard, sourceStrip),
        h('div', { className: 'capw-foot is-capture' },
          h(Button, {
            variant: 'accent', size: 'M', icon: h(Icon, { name: 'check', size: 15 }),
            isDisabled: shots === 0 || finishing, onPress: finish,
          }, finishing ? '保存中…' : '完成并保存'),
          h('div', { style: { flex: 1 } }),
          h(Button, {
            variant: 'negative', size: 'M', icon: h(Icon, { name: 'x', size: 15 }),
            isDisabled: finishing, onPress: () => setAskAbort(true),
          }, '中止')));
    } else {
      side = h(React.Fragment, null,
        h('div', { className: 'capw-side-scroll' }, sourceSection),
        h('div', { className: 'capw-foot' },
          h('div', { className: 'capw-start' },
            h(Button, {
              variant: 'accent', size: 'L', icon: h(Icon, { name: 'camera', size: 16 }),
              isDisabled: !canStart, onPress: start,
            }, '开始采集'),
            !canStart
              ? h('div', { className: 'capw-note capw-note--notice' },
                  h(Icon, { name: 'info', size: 14 }),
                  h('span', null, '待补：', reasons.join(' · ')))
              : h('div', { className: 'capw-hint' },
                  '相机对准显示网格测试图的屏幕，画面已常驻监看。开始后绕机位拍摄若干张即可。'),
            h('button', { className: 'gcapw-reset', onClick: () => rearm({ clearSession: true }) },
              h(Icon, { name: 'sync', size: 13 }),
              shots > 0
                ? ('重置采集 · 清除已采集的 ' + shots + ' 张，重新开始')
                : '重置采集 · 清除之前的采集信息'))));
    }

    const rzDirs = [['n', 0, -1], ['s', 0, 1], ['e', 1, 0], ['w', -1, 0], ['ne', 1, -1], ['nw', -1, -1], ['se', 1, 1], ['sw', -1, 1]];
    return h('div', { className: 'drawer drawer--capw drawer--gcapw', ref: rootRef }, head,
      h('div', { className: 'capw', style: { gridTemplateColumns: leftPct + '% ' + (100 - leftPct) + '%' } },
        stage, h('div', { className: 'capw-side' }, side),
        h('div', { className: 'capw-split', style: { left: leftPct + '%' }, onPointerDown: onSplit },
          h('span', { className: 'capw-split-grip' }))),
      rzDirs.map(([n, dx, dy]) => h('div', { key: n, className: 'capw-rz capw-rz--' + n, onPointerDown: onResize(dx, dy) })),
      askAbort ? h('div', { className: 'capw-abort' },
        h('div', { className: 'capw-abort-card' },
          h('div', { className: 'capw-abort-h' },
            h('span', { className: 'capw-abort-ic' }, h(Icon, { name: 'alert', size: 18 })),
            h('h3', null, '中止采集')),
          h('p', null,
            '将结束本次采集。已拍摄的 ', h('b', null, shots), ' 张照片会保留在会话目录 ',
            h('code', { className: 'mono' }, sessionDir), '，但不会写入完成汇总。'),
          h('div', { className: 'capw-abort-acts' },
            h(Button, { variant: 'secondary', size: 'M', onPress: () => setAskAbort(false) }, '继续采集'),
            h(Button, {
              variant: 'negative', size: 'M', icon: h(Icon, { name: 'x', size: 15 }), onPress: doAbort,
            }, '中止')))) : null);
  }

  function openGridCapture(s, opts) {
    opts = opts || {};
    s.setModal({
      xwide: true,
      render: ({ s: st, close }) => h(GridCaptureWindow, Object.assign({ s: st, close }, opts)),
    });
  }
  const openGrid = (s, onSaved) => openGridCapture(s, { onSaved });

  window.VOLO_GRID_CAPTURE = { openGridCapture, openGrid, GridCaptureWindow };
})();
