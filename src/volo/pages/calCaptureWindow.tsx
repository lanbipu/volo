// @ts-nocheck
/* Volo — 实时采集 · 单窗口（配置 + 现场画面 + 采集，一屏完成）
   1:1 port of the Claude Design handoff `src/cal2_capture_window.jsx`，真实接线。

   替代原先两套独立的真实采集实现——gridModals.tsx 的 LiveCapture（网格「接入摄影
   机…」/「现场实时采集」入口）与 calLens.tsx 内联的采集态渲染（镜头「开始采集」）——
   统一成这一个共享组件，grid/lens 两变体复用同一份接线：
   - 采集会话：复用 devCapture.tsx 的 useCaptureSession/buildSessionArgs（唯一验证
     过的 spawnSidecarStreaming + `vpcal capture session` 真实闭环）。
   - 现场画面：采集前常驻 `vpcal capture video --duration 0 --preview-port 0` 监看流
     （画面保真 + 断流自愈标准，同 calVideoSource.tsx）；采集开始后让出设备，切换消费
     采集会话自己的 preview_ready.mjpeg_url。
   - 会话参数（poses/settleMs/burst/inverted/graycodeSync/patternsDir/lensPath）不再
     挂在 Capture Profile 上，改为本窗口自己的 localStorage 持久化（volo-capw-params，
     grid/lens 入口共享），与 Profile（信号源身份 + 输出目录）解耦。
   - screen.json 为真实采集会话必填参数（--screen，与 backend 无关，不像设计稿假设
     synthetic 可以跳过）；grid 变体每次现开现选，lens 变体接受调用方传入的已选路径，
     变更时回写给调用方（同步 Lens 页顶栏的 screen.json 选择）。
   - 覆盖度反馈只渲染真实 coverage_update 字段；设计稿的 3×3 sensor_grid 示意矩阵后端
     不产出，不臆造，改用 sensor_missing_regions 文字提示（同 calLens.tsx lensInspector
     的既有真实数据渲染）。 */
import * as React from "react";
import { pickDirectory, pickFile } from "../api/commands";
import { spawnSidecarStreaming, cancelSidecarTask, listenSidecarStream, useSidecarStream } from "../api/sidecarStream";
import { useCaptureSession } from "./devCapture";
import { listMonitors, openPatternPlayer, closePatternPlayer, playerShowPattern } from "../api/player";
import { exportVpcalScreen } from "../api/meshCommands";

(function () {
  const { Button, Switch } = window.Spectrum2DesignSystem_b6d1b3;
  const { useState, useEffect, useRef } = React;
  const h = React.createElement;
  const CX = window.VOLO_CAL2;

  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const BACKEND_LABEL = { uvc: 'UVC 摄像头', ndi: 'NDI', decklink: 'DeckLink SDI', synthetic: '合成测试源' };
  const SIGNAL = {
    ok: { tone: 'positive', icon: 'check', text: '已连接' },
    waiting: { tone: 'notice', icon: 'sync', text: '等待信号' },
    lost: { tone: 'negative', icon: 'alert', text: '信号丢失' },
  };

  /* 会话参数——窗口自己的持久化，独立于 Profile（grid/lens 入口共享同一份记忆） */
  const LS_KEY = 'volo-capw-params';
  const defaultParams = () => ({ poses: 8, settleMs: 300, burst: 5, inverted: true, graycodeSync: true, patternsDir: '', lensPath: '' });
  const loadParams = () => { try { const v = JSON.parse(localStorage.getItem(LS_KEY)); return Object.assign(defaultParams(), v || {}); } catch (e) { return defaultParams(); } };
  const saveParams = (p) => { try { localStorage.setItem(LS_KEY, JSON.stringify(p)); } catch (e) {} };

  function joinPath(dir, name) {
    const sep = dir.indexOf('\\') >= 0 ? '\\' : '/';
    return dir.replace(/[\\/]+$/, '') + sep + name;
  }
  function baseName(p) { return p ? p.split(/[\\/]/).pop() : ''; }

  /* ================= 常驻监看流（采集前「选定 Profile 即预览」，同 calVideoSource.tsx 的保真监看标准） ================= */
  function useMonitor(profile, active) {
    const [sig, setSig] = useState('waiting');
    const [url, setUrl] = useState(null);
    const [fmt, setFmt] = useState(null);
    const [task, setTask] = useState(null);
    const taskRef = useRef(null);
    taskRef.current = task;
    const lastFrame = useRef(0);
    const frameCount = useRef(0);
    const stream = useSidecarStream(task);

    const backend = profile && profile.videoBackend;
    const device = profile && profile.device;
    const activeRef = useRef(active);
    activeRef.current = active;

    const start = async () => {
      if (taskRef.current) void cancelSidecarTask(taskRef.current);
      lastFrame.current = 0; frameCount.current = 0;
      setSig('waiting'); setUrl(null); setFmt(null);
      if (!profile || backend === 'synthetic' || !device) return;
      const manualFmt = profile.fmtMode === 'manual';
      const args = ['capture', 'video', '--backend', backend, '--device', String(device),
        '--allow-hx', '--preview-port', '0', '--duration', '0', '--output', 'json'];
      if (manualFmt && profile.width) args.push('--width', String(profile.width));
      if (manualFmt && profile.height) args.push('--height', String(profile.height));
      if (manualFmt && profile.fps) args.push('--fps', String(profile.fps));
      args.push('--transfer-function', profile.transferFunction || 'sdr');
      try {
        const resp = await spawnSidecarStreaming('vpcal', args);
        setTask(resp.task_id);
      } catch (e) {
        setSig('lost'); setUrl(null);
      }
    };

    useEffect(() => {
      if (!active) { if (taskRef.current) void cancelSidecarTask(taskRef.current); setTask(null); setUrl(null); setSig('waiting'); return undefined; }
      void start();
      return () => { if (taskRef.current) void cancelSidecarTask(taskRef.current); };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active, backend, device]);

    useEffect(() => {
      const parsed = stream.state.lines.map((l) => l.parsed).filter((p) => p && typeof p.type === 'string');
      const preview = [...parsed].reverse().find((p) => p.type === 'preview_ready');
      if (preview && preview.mjpeg_url) setUrl(preview.mjpeg_url);
      const frameEvts = parsed.filter((p) => p.type === 'progress' || p.type === 'source_info').length;
      if (frameEvts > frameCount.current) { frameCount.current = frameEvts; lastFrame.current = Date.now(); }
      const info = [...parsed].reverse().find((p) => p.type === 'source_info');
      if (info) {
        setFmt({
          res: info.width + '×' + info.height,
          fps: info.fps == null ? '—' : Number(info.fps).toFixed(2),
          pix: (info.pixel_format || info.fourcc || 'Unknown') + ' ' + info.bit_depth + '-bit',
          depth: info.bit_depth + ' bit',
        });
        setSig('ok');
      }
    }, [stream.state.lines]);

    /* 帧活性看门狗：>4s 无帧转「等待信号」，恢复自动转回；不碰 lost（独立来源） */
    useEffect(() => {
      if (!task) return undefined;
      const t = setInterval(() => {
        const age = Date.now() - lastFrame.current;
        setSig((s) => {
          if (s === 'ok' && age > 4000) return 'waiting';
          if (s === 'waiting' && lastFrame.current > 0 && age < 2500) return 'ok';
          return s;
        });
      }, 1000);
      return () => clearInterval(t);
    }, [task]);

    /* 断流自愈：进程非 cancel 退出且设备仍选中 → 3s 后自动重启。挂在 [active, stream.state.exit]
       上——active 变 false（比如采集已经开始，设备被真会话接管）时立即清掉待重连定时器，
       避免 3s 后冒出来跟正在跑的 capture session 抢同一个设备。 */
    useEffect(() => {
      const exit = stream.state.exit;
      if (!exit || exit.cancelled || !active) return;
      setSig(exit.fatal ? 'lost' : 'waiting'); setUrl(null);
      if (!device) return;
      const t = setTimeout(() => { if (activeRef.current) void start(); }, 3000);
      return () => clearTimeout(t);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active, stream.state.exit]);

    /* 采集开始前显式让出设备：调用方必须 await 这个再去 spawn 真实 capture session，
       避免监看流还没释放设备、新会话就去抢占同一个 backend/device 导致 device busy。
       cancel_sidecar_task 只投递 Cancel 就返回（进程还有最长 3s 的 grace 窗口），
       所以这里必须订阅 exit 事件等进程真正退出——DeckLink/UVC 是独占设备，早一毫秒
       spawn 真会话都会 EnableVideoInput busy。5s 兜底超时 > Rust 侧 3s grace + kill。 */
    const stop = async () => {
      const t = taskRef.current;
      taskRef.current = null;
      setTask(null); setUrl(null); setSig('waiting');
      if (!t) return;
      await new Promise((resolve) => {
        let un = null;
        let done = false;
        const finish = () => { if (done) return; done = true; clearTimeout(timer); if (un) un(); resolve(); };
        const timer = setTimeout(finish, 5000);
        (async () => {
          /* 先建立 exit 订阅、再发 Cancel，避免退出事件抢跑在订阅之前被漏掉。 */
          try { const fn = await listenSidecarStream(t, (ev) => { if (ev.kind === 'exit') finish(); }); if (done) fn(); else un = fn; } catch (e) {}
          try { const alive = await cancelSidecarTask(t); if (!alive || !un) finish(); } catch (e) { finish(); }
        })();
      });
    };

    return { sig, url, fmt, stop };
  }

  /* ---------- 现场画面 ---------- */
  function CamFeed({ signal, url, synthetic }) {
    if (synthetic) {
      return h('div', { className: 'capw-canvas' }, h('div', { className: 'capw-mid' },
        h(Icon, { name: 'grid', size: 30, style: { color: 'var(--chrome-faint)' } }),
        h('div', { className: 'capw-mid-t' }, '内置合成图案'),
        h('div', { className: 'capw-mid-d' }, '无硬件信号，standby 后直接可采集')));
    }
    if (signal === 'lost') {
      return h('div', { className: 'capw-canvas' }, h('div', { className: 'capw-mid' },
        h(Icon, { name: 'alert', size: 30, style: { color: 'color-mix(in srgb, var(--negative-visual) 82%, #fff)' } }),
        h('div', { className: 'capw-mid-t neg' }, '设备无法打开 / 断流'),
        h('div', { className: 'capw-mid-d' }, '确认设备未被其他程序占用，检查连线后重试')));
    }
    if (!url) {
      return h('div', { className: 'capw-canvas' }, h('div', { className: 'capw-mid' },
        h('span', { className: 'capw-spinner' }),
        h('div', { className: 'capw-mid-t' }, '等待首帧…'),
        h('div', { className: 'capw-mid-d' }, '已建立连接，正在协商信号格式')));
    }
    return h('div', { className: 'capw-canvas' }, h('img', { src: url, alt: '现场画面', className: 'capw-img' }));
  }

  /* ---------- 采集反馈（真实 coverage_update / detect_feedback 字段，不臆造 sensor_grid） ---------- */
  function CoverageCard({ cov, posesCaptured, target }) {
    return h('div', { className: 'cap-card capw-cov' },
      h('div', { className: 'cap-card-h' }, h(Icon, { name: 'pulse', size: 15 }), '采集反馈',
        h('span', { className: 'spill spill--notice', style: { marginLeft: 'auto' } }, h(Icon, { name: 'camera', size: 12 }), '采集中')),
      h('div', { className: 'capw-cov-metrics' },
        h('div', { className: 'capw-cov-m' }, h('div', { className: 'k' }, '画面覆盖'), h('div', { className: 'v', style: { color: cov.sensorPct >= 85 ? 'var(--positive-visual)' : 'var(--notice-visual)' } }, cov.sensorPct, h('span', { className: 'u' }, '%'))),
        h('div', { className: 'capw-cov-m' }, h('div', { className: 'k' }, '屏幕 marker'), h('div', { className: 'v' }, cov.markersSeen, h('span', { className: 'u' }, '/' + cov.markersTotal))),
        h('div', { className: 'capw-cov-m' }, h('div', { className: 'k' }, '已采姿位'), h('div', { className: 'v' }, posesCaptured, h('span', { className: 'u' }, '/' + target)))),
      cov.missingRegions.length ? h('div', { className: 'capw-cov-sub' },
        h('div', { className: 'capw-cov-lbl' }, '缺失区域'),
        h('div', { className: 'lens-missing' }, cov.missingRegions.map((r, i) => h('span', { key: i, className: 'lens-miss-chip' }, h(Icon, { name: 'target', size: 11 }), r)))) : null,
      cov.suggestions.length ? h('div', { className: 'capw-cov-sub' },
        h('div', { className: 'capw-cov-lbl' }, '覆盖建议'),
        cov.suggestions.map((sg, i) => h('div', { key: i, className: 'capw-sug capw-sug--' + sg.tone },
          h(Icon, { name: sg.tone === 'positive' ? 'check' : 'alert', size: 13 }), h('span', null, sg.msg)))) : null);
  }

  /* 采集会话事件流 → 覆盖度/检测摘要（同 calLens.tsx 既有 recomputeLive 手法） */
  function recomputeCoverage(session) {
    const cov = session.latest('coverage_update');
    const progress = session.latest('progress') || {};
    let lastDetect = null;
    for (let i = session.events.length - 1; i >= 0; i -= 1) {
      if (session.events[i].type === 'detect_feedback') { lastDetect = session.events[i]; break; }
    }
    return {
      poseCount: progress.poses_captured != null ? progress.poses_captured : 0,
      sensorPct: cov ? Math.round((cov.sensor_coverage_pct || 0) * 100) : 0,
      markersSeen: cov ? cov.screen_markers_seen || 0 : 0,
      markersTotal: cov ? cov.screen_markers_total || 0 : 0,
      missingRegions: cov ? cov.sensor_missing_regions || [] : [],
      suggestions: cov ? (cov.suggestions || []).map((m) => ({ tone: 'notice', msg: m })) : [],
      lastDetect,
    };
  }

  /* ================= 主窗口 ================= */
  function CaptureWindow({ s, close, variant, profileId, screenPath: screenPathProp, onScreenPathChange, onSaved }) {
    const isLens = variant === 'lens';
    const proj = CX.useProj();
    const screenId = s.calActiveScreen;
    const profiles = CX.loadProfiles ? CX.loadProfiles() : [];
    const [pid, setPid] = useState(profileId || (profiles[0] && profiles[0].id) || null);
    const profile = profiles.find((p) => p.id === pid) || null;
    const backend = profile && profile.videoBackend;

    const [screenPath, setScreenPath] = useState(screenPathProp || '');
    const [screenBusy, setScreenBusy] = useState(false);
    const [manualOutDir, setManualOutDir] = useState('');
    const [params, setParams] = useState(loadParams);
    const setP = (k, v) => setParams((f) => Object.assign({}, f, { [k]: v }));

    const [phase, setPhase] = useState('config'); /* config | capturing | done */
    const [askAbort, setAskAbort] = useState(false);
    const [pfOpen, setPfOpen] = useState(false);
    const [leftPct, setLeftPct] = useState(60);
    const [captureResult, setCaptureResult] = useState(null);
    const rootRef = useRef(null);
    const pfRef = useRef(null);
    const patternAckSeq = useRef(new Set());
    const capturePlayerOpen = useRef(false);

    const locked = phase === 'capturing';
    const monitor = useMonitor(profile, phase === 'config' && backend !== 'synthetic');
    const session = useCaptureSession();

    /* 边缘/角缩放整窗（作用于 .modal-host） */
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
    useEffect(() => { if (!pfOpen) return undefined; const d = (e) => { if (pfRef.current && !pfRef.current.contains(e.target)) setPfOpen(false); }; document.addEventListener('mousedown', d); return () => document.removeEventListener('mousedown', d); }, [pfOpen]);

    const closeCapturePlayer = () => {
      if (!capturePlayerOpen.current) return Promise.resolve();
      capturePlayerOpen.current = false;
      return closePatternPlayer().catch(() => {});
    };
    useEffect(() => () => { void closeCapturePlayer(); }, []);

    /* request_pattern → 真实播放器切图成功后才回执 */
    useEffect(() => {
      if (phase !== 'capturing') return;
      for (const ev of session.events) {
        if (ev.type !== 'request_pattern' || typeof ev.sequence !== 'number') continue;
        if (patternAckSeq.current.has(ev.sequence)) continue;
        const pattern = String(ev.pattern || 'normal');
        if (!params.patternsDir) continue;
        patternAckSeq.current.add(ev.sequence);
        const sep = String(params.patternsDir).includes('\\') ? '\\' : '/';
        const path = String(params.patternsDir).replace(/[\\/]+$/, '') + sep + pattern + '.png';
        (async () => {
          let lastError;
          for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
              await playerShowPattern(path, pattern, ev.frame_index == null ? null : ev.frame_index);
              await session.sendCmd({ cmd: 'pattern_ready', pattern });
              return;
            } catch (e) { lastError = e; if (attempt < 2) await new Promise((r) => setTimeout(r, 400)); }
          }
          throw lastError;
        })().catch((e) => { patternAckSeq.current.delete(ev.sequence); s.pushLog({ lv: 'err', cat: 'capture', msg: '播放器切图失败 · ' + (e && e.message ? e.message : e) }); });
      }
    }, [phase, session.events]);

    /* 采集完成：result 事件到达 → done 态 */
    useEffect(() => {
      if (phase !== 'capturing') return;
      const res = session.latest('result');
      if (!res || !res.data) return;
      void closeCapturePlayer();
      setCaptureResult(res.data);
      setPhase('done');
      s.pushLog({ lv: 'ok', cat: 'capture', msg: '采集完成 · ' + res.data.poses_captured + ' 姿位 · <b>' + res.data.session_dir + '</b>' });
    }, [phase, session.events]);

    /* 进程异常退出（非用户中止）→ 回落 config，避免卡死在假「采集中」 */
    useEffect(() => {
      if (phase !== 'capturing') return;
      const exit = session.state.exit;
      if (exit && !exit.cancelled && exit.fatal) {
        void closeCapturePlayer();
        s.pushLog({ lv: 'err', cat: 'capture', msg: '采集会话异常退出 · ' + (exit.stderr_tail || 'exit ' + exit.exit_code) });
        setPhase('config');
      }
      if (session.spawnError) {
        void closeCapturePlayer();
        s.pushLog({ lv: 'err', cat: 'capture', msg: '实时采集启动失败 · ' + session.spawnError });
        setPhase('config');
      }
    }, [phase, session.state.exit, session.spawnError]);

    const cov = phase === 'capturing' ? recomputeCoverage(session) : null;
    const target = params.poses;

    const pickScreen = async () => {
      try { const p = await pickFile('屏幕定义 (screen.json)', ['json']); if (p) { setScreenPath(p); onScreenPathChange && onScreenPathChange(p); } }
      catch (e) { s.pushLog({ lv: 'err', cat: 'capture', msg: `选择 screen.json 失败 · ${e && e.message ? e.message : e}` }); }
    };
    const generateScreen = async () => {
      if (!proj.path || !screenId || screenBusy) return;
      setScreenBusy(true);
      try {
        const r = await exportVpcalScreen(proj.path, screenId, null);
        setScreenPath(r.path); onScreenPathChange && onScreenPathChange(r.path, r.fingerprint);
        s.pushLog({ lv: 'ok', cat: 'capture', msg: '已从当前屏幕生成 screen.json · fingerprint ' + r.fingerprint });
      } catch (e) { s.pushLog({ lv: 'err', cat: 'capture', msg: `生成 screen.json 失败 · ${e && e.message ? e.message : e}` }); }
      finally { setScreenBusy(false); }
    };
    const pickOutDir = async () => {
      try { const p = await pickDirectory(); if (p) setManualOutDir(p); }
      catch (e) { s.pushLog({ lv: 'err', cat: 'capture', msg: `选择输出目录失败 · ${e && e.message ? e.message : e}` }); }
    };
    const hasOutDir = !!(profile && profile.outputRoot) || !!manualOutDir;

    /* ---- 开始采集禁用原因（screen.json 为真实必填参数，与 backend 无关） ---- */
    const reasons = [];
    if (!profile) reasons.push('未选择采集配置');
    if (!screenPath) reasons.push('未选择 screen.json');
    if (!hasOutDir) reasons.push('未选择输出目录');
    if (params.inverted && !params.patternsDir) reasons.push('inverted 已开但未选图案目录');
    const canStart = reasons.length === 0;

    const start = async () => {
      if (!canStart) return;
      saveParams(params);
      const outDir = profile.outputRoot
        ? joinPath(profile.outputRoot, 'session_' + new Date().toISOString().replace(/[:.]/g, '-'))
        : manualOutDir;
      if (params.inverted) {
        try {
          const monitors = await listMonitors();
          if (!monitors.length) throw new Error('未发现可用于图案播放器的显示器');
          await openPatternPlayer(monitors[monitors.length - 1].index);
          capturePlayerOpen.current = true;
        } catch (e) {
          s.pushLog({ lv: 'err', cat: 'capture', msg: '打开图案播放器失败 · ' + (e && e.message ? e.message : e) });
          return;
        }
      }
      patternAckSeq.current.clear();
      setCaptureResult(null);
      /* 让出 standby 监看流占的设备，确认它真的放手了再让真会话去开——不然两个 vpcal
         进程抢同一个 backend/device，UVC/DeckLink 这类独占型源会 device busy。 */
      await monitor.stop();
      setPhase('capturing');
      s.pushLog({ lv: 'info', cat: 'capture', msg: '开始实时采集 · 配置 <b>' + profile.name + '</b> · 目标 ' + target + ' 姿位' });
      session.start({
        screenPath, outDir, backend: profile.videoBackend, device: profile.device,
        trackProtocol: profile.trackProtocol, trackPort: Number(profile.trackPort), trackHost: profile.trackHost || '0.0.0.0',
        trackCameraId: profile.trackCameraId, poses: Number(params.poses), inverted: !!params.inverted,
        graycodeSync: !!params.inverted && !!params.graycodeSync, lensPath: isLens ? (params.lensPath || '') : '',
        settleMs: Number(params.settleMs), burst: Number(params.burst),
        width: profile.fmtMode === 'manual' ? profile.width : null, height: profile.fmtMode === 'manual' ? profile.height : null,
        fps: profile.fmtMode === 'manual' ? profile.fps : null, transferFunction: profile.transferFunction || 'sdr',
      });
    };
    const skip = () => session.sendCmd({ cmd: 'skip_pose' });
    const finish = () => session.sendCmd({ cmd: 'finish' });
    const doAbort = () => {
      setAskAbort(false);
      session.cancel();
      void closeCapturePlayer();
      setPhase('config');
      s.pushLog({ lv: 'warn', cat: 'capture', msg: '采集已中止 · 已拍 pose 保留在 session.partial.json，可用 vpcal capture finalize 恢复' });
    };
    const savedSession = () => {
      if (!captureResult) return;
      const msg = '已保存采集会话 · ' + captureResult.poses_captured + ' 姿位';
      s.pushLog({ lv: 'ok', cat: 'capture', msg });
      s.setCalReceipt({ tone: 'ok', text: msg });
      /* visualSession 是网格「测量导入」专属的持久信号（gridTree/gridInsp 的 hasVs/fuseReady
         都读它），lens 采集跟它无关，不能连带写进去。 */
      if (!isLens) {
        CX.projStore.patch({ visualSession: { screenId, poses: captureResult.poses_captured, sessionDir: captureResult.session_dir } });
      }
      close();
      onSaved && onSaved(captureResult);
    };

    /* ---------- 头部 ---------- */
    const sig = SIGNAL[monitor.sig];
    const head = h('div', { className: 'drawer-h' },
      h('span', { className: 'di info' }, h(Icon, { name: isLens ? 'target' : 'live', size: 17 })),
      h('div', { style: { minWidth: 0, flex: 1 } },
        h('h2', null, isLens ? '实时采集 · 镜头标定' : '实时采集'),
        h('div', { className: 'sub', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('span', { className: 'cli-pill' }, backend === 'synthetic' ? 'synthetic' : 'MJPEG live'),
          profile ? h('span', null, profile.name) : null)),
      h('button', { className: 'iconbtn x', style: { width: 26, height: 26 }, onClick: () => { if (locked) setAskAbort(true); else close(); } }, h(Icon, { name: 'x', size: 16 })));

    /* ---------- 左侧现场画面 ---------- */
    const stage = h('div', { className: 'capw-stage' },
      h('div', { className: 'capw-feed' },
        locked
          ? h(CamFeed, { signal: session.latest('preview_ready') ? 'ok' : 'waiting', url: session.latest('preview_ready') && session.latest('preview_ready').mjpeg_url, synthetic: backend === 'synthetic' })
          : h(CamFeed, { signal: monitor.sig, url: monitor.url, synthetic: backend === 'synthetic' }),
        h('div', { className: 'capw-sigbadge' },
          h('span', { className: 'cap-pill cap-pill--' + (backend === 'synthetic' ? 'informative' : sig.tone) + ' is-lg' },
            monitor.sig === 'waiting' && backend !== 'synthetic'
              ? h('span', { className: 'capw-pill-spin' }, h(Icon, { name: 'sync', size: 13 }))
              : h(Icon, { name: backend === 'synthetic' ? 'grid' : sig.icon, size: 13 }),
            backend === 'synthetic' ? '合成源' : sig.text)),
        (backend !== 'synthetic' && (monitor.sig === 'ok' || locked)) ? h('span', { className: 'capw-livedot' }, h('i', null), locked ? 'REC' : 'LIVE') : null,
        locked && cov ? h('div', { className: 'capw-detbar' },
          h(Icon, { name: 'target', size: 13 }),
          h('span', null, 'pose #', h('b', null, Math.min(cov.poseCount + 1, target)), ' / ' + target),
          cov.lastDetect ? h(React.Fragment, null, h('span', { className: 'sep' }, '·'), h('span', null, h('b', null, String(cov.lastDetect.marker_hits || 0)), ' markers 命中')) : null,
          params.inverted ? h('span', { className: 'capw-detbar-tag' }, 'normal + inverted 双帧') : null) : null),
      h('div', { className: 'capw-fmtbar' },
        backend === 'synthetic'
          ? h('span', { className: 'capw-fmt-read' }, h(Icon, { name: 'grid', size: 12 }), '内置合成图案 · 无硬件信号')
          : monitor.fmt
            ? h('span', { className: 'capw-fmt-read' },
                h('b', null, monitor.fmt.res), h('span', { className: 'sep' }, '·'), h('span', null, monitor.fmt.fps + ' fps'),
                h('span', { className: 'sep' }, '·'), h('span', { className: 'dim' }, monitor.fmt.pix))
            : h('span', { className: 'capw-fmt-read dim' }, h(Icon, { name: 'x', size: 12 }), '无信号 · 格式不可读'),
        (backend !== 'synthetic' && monitor.fmt) ? h('span', { className: 'capw-fmt-auto' }, h(Icon, { name: 'check', size: 12 }), '自动读取') : null));

    /* ---------- 右栏 · 信号源 ---------- */
    const sourceSection = h('div', { className: 'cap-card' + (locked ? ' is-locked' : '') },
      h('div', { className: 'cap-card-h' }, h(Icon, { name: 'camera', size: 15 }), '信号源', h('span', { className: 'capw-code' }, 'source')),
      h('div', { className: 'capw-pick' },
        h('span', { className: 'capw-pick-lb' }, 'Capture Profile'),
        profiles.length
          ? h('div', { className: 'capw-pfsel', ref: pfRef },
              h('button', { className: 'capw-pfbtn' + (pfOpen ? ' open' : ''), disabled: locked, onClick: () => !locked && setPfOpen((v) => !v) },
                h('span', { className: 'capw-pf-ic' }, h(Icon, { name: backend === 'synthetic' ? 'grid' : 'camera', size: 14 })),
                profile
                  ? h('span', { className: 'capw-pf-main' }, h('b', null, profile.name), h('span', null, BACKEND_LABEL[profile.videoBackend] + ' / ' + profile.device))
                  : h('span', { className: 'capw-pf-main' }, h('b', null, '未选择')),
                h(Icon, { name: 'chevd', size: 14 })),
              pfOpen ? h('div', { className: 'capw-pfmenu' },
                profiles.map((p) => h('button', { key: p.id, className: 'capw-pfopt' + (p.id === pid ? ' on' : ''), onClick: () => { setPid(p.id); setPfOpen(false); } },
                  h('span', { className: 'capw-pf-ic' }, h(Icon, { name: p.videoBackend === 'synthetic' ? 'grid' : 'camera', size: 14 })),
                  h('span', { className: 'capw-pf-main' }, h('b', null, p.name), h('span', null, BACKEND_LABEL[p.videoBackend] + ' / ' + p.device)),
                  p.id === pid ? h(Icon, { name: 'check', size: 14 }) : null)),
                h('button', { className: 'capw-pfmanage', onClick: () => { setPfOpen(false); close(); CX.openCaptureModal(s); } },
                  h(Icon, { name: 'sliders', size: 14 }), '管理采集配置…')) : null)
          : h('div', { className: 'capw-note capw-note--notice' }, h(Icon, { name: 'alert', size: 14 }),
              h('span', null, '还没有采集配置，'), h('button', { className: 'gw-tinline', onClick: () => { close(); CX.openCaptureModal(s); } }, '去新建'))),
      h('div', { className: 'capw-pick' + (!screenPath ? ' is-pending' : '') },
        h('span', { className: 'capw-pick-lb' }, 'screen.json', h('span', { className: 'capw-req' }, '必填')),
        h('div', { className: 'capw-pick-row' },
          h('button', { className: 'cap-file-btn', disabled: locked || screenBusy, onClick: generateScreen },
            h(Icon, { name: screenBusy ? 'sync' : 'grid', size: 14 }), screenBusy ? '生成中…' : '从当前屏幕生成'),
          h('button', { className: 'cap-file-btn', disabled: locked, onClick: pickScreen }, h(Icon, { name: 'folder', size: 14 }), '选择…'),
          screenPath ? h('span', { className: 'capw-pick-val mono' }, baseName(screenPath)) : null)),
      h('div', { className: 'capw-pick' + (!hasOutDir ? ' is-pending' : '') },
        h('span', { className: 'capw-pick-lb' }, '输出目录', h('span', { className: 'capw-req' }, '必填')),
        profile && profile.outputRoot
          ? h('div', { className: 'capw-pick-row' }, h('span', { className: 'capw-pick-val mono' }, profile.outputRoot), h('span', { className: 'capw-opt' }, '每次采集自动生成子目录'))
          : h('div', { className: 'capw-pick-row' },
              h('button', { className: 'cap-file-btn', disabled: locked, onClick: pickOutDir }, h(Icon, { name: 'folder', size: 14 }), manualOutDir || '选择目录…'),
              manualOutDir ? h('span', { className: 'cap-pill cap-pill--positive' }, h(Icon, { name: 'check', size: 12 }), '已选') : null)));

    /* ---------- 右栏 · 会话参数 ---------- */
    const paramsSection = h('div', { className: 'cap-card' + (locked ? ' is-locked' : '') },
      h('div', { className: 'cap-card-h' }, h(Icon, { name: 'sliders', size: 15 }), '会话参数', h('span', { className: 'capw-code' }, 'session')),
      h('div', { className: 'cap-param-grid' },
        h('div', { className: 'cap-num' }, h('label', null, 'poses'),
          h('div', { className: 'cap-stepper' },
            h('button', { onClick: () => setP('poses', clamp(+params.poses - 1, 3, 24)) }, '−'),
            h('span', null, params.poses),
            h('button', { onClick: () => setP('poses', clamp(+params.poses + 1, 3, 24)) }, '+')),
          h('span', { className: 'cap-min' }, '3–24')),
        h('div', { className: 'cap-num' }, h('label', null, 'settleMs'),
          h('div', { className: 'cap-num-in' }, h('input', { type: 'number', value: params.settleMs, min: 100, max: 2000, onChange: (e) => setP('settleMs', e.target.value) }), h('span', { className: 'u' }, 'ms')),
          h('span', { className: 'cap-min' }, '100–2000')),
        h('div', { className: 'cap-num' }, h('label', null, 'burst'),
          h('div', { className: 'cap-num-in' }, h('input', { type: 'number', value: params.burst, min: 1, max: 12, onChange: (e) => setP('burst', e.target.value) }), h('span', { className: 'u' }, '帧')),
          h('span', { className: 'cap-min' }, '1–12'))),
      h('div', { className: 'cal2-toggles' },
        h('div', { className: 'cap-toggle-row' },
          h('div', null, h('div', { className: 'cap-tg-t' }, 'inverted'), h('div', { className: 'cap-tg-s' }, '正 / 反图案各拍一帧做差分')),
          h(Switch, { isSelected: !!params.inverted, onChange: (v) => setP('inverted', v) })),
        h('div', { className: 'cap-toggle-row' + (!params.inverted ? ' is-dim' : '') },
          h('div', null, h('div', { className: 'cap-tg-t' }, 'graycodeSync'), h('div', { className: 'cap-tg-s' }, '用 Gray code 确认图案序号')),
          h(Switch, { isSelected: !!params.graycodeSync, isDisabled: !params.inverted, onChange: (v) => setP('graycodeSync', v) }))),
      h('div', { className: 'cap-lens', style: { marginTop: 13 } },
        h('label', null, 'patternsDir', params.inverted ? h('span', { className: 'capw-req' }, '必填') : null),
        h('div', { className: 'cap-lens-pick' },
          h('button', { className: 'cap-file-btn', onClick: async () => { if (params.patternsDir) setP('patternsDir', ''); else { const p = await pickDirectory(); if (p) setP('patternsDir', p); } } },
            h(Icon, { name: 'folder', size: 14 }), params.patternsDir || '选择 normal.png / inverted.png 所在目录…'),
          params.patternsDir ? h('span', { className: 'cap-pill cap-pill--positive' }, h(Icon, { name: 'check', size: 12 }), '已选') : null)),
      (params.inverted && !params.patternsDir) ? h('div', { className: 'capw-note capw-note--notice' }, h(Icon, { name: 'alert', size: 14 }),
        h('span', null, 'inverted 需要图案播放器闭环，请选择图案目录，或关闭 inverted。')) : null,
      isLens ? h('div', { className: 'cap-lens', style: { marginTop: 13, borderTop: '1px solid var(--chrome-line)', paddingTop: 13 } },
        h('label', null, 'lensPath', h('span', { className: 'capw-opt' }, '可选')),
        h('div', { className: 'cap-lens-pick' },
          h('button', { className: 'cap-file-btn', onClick: async () => { if (params.lensPath) setP('lensPath', ''); else { const p = await pickFile('Lens profile', ['json']); if (p) setP('lensPath', p); } } },
            h(Icon, { name: 'doc', size: 14 }), params.lensPath || '选择镜头档案…'),
          params.lensPath ? h('span', { className: 'cap-pill cap-pill--positive' }, h(Icon, { name: 'check', size: 12 }), '已选') : null),
        h('div', { className: 'capw-hint' }, '已有镜头档案时可跳过镜头段直接 quick-run。')) : null);

    /* ---------- 右栏 · 采集控制 / 完成汇总 ---------- */
    let side;
    if (phase === 'done' && captureResult) {
      side = h(React.Fragment, null,
        h('div', { className: 'capw-side-scroll' },
          h('div', { className: 'cap-card capw-summary' },
            h('div', { className: 'cap-card-h' }, h('span', { className: 'capw-ok-ic' }, h(Icon, { name: 'check', size: 15 })), '采集汇总',
              h('span', { className: 'spill spill--positive', style: { marginLeft: 'auto' } }, '会话已完成')),
            h('div', { className: 'capw-cov-metrics' },
              h('div', { className: 'capw-cov-m' }, h('div', { className: 'k' }, '姿位'), h('div', { className: 'v' }, captureResult.poses_captured)),
              h('div', { className: 'capw-cov-m' }, h('div', { className: 'k' }, 'marker 命中'), h('div', { className: 'v' }, captureResult.marker_hits_total == null ? '—' : captureResult.marker_hits_total)),
              h('div', { className: 'capw-cov-m' }, h('div', { className: 'k' }, 'lens_ready'), h('div', { className: 'v', style: { color: captureResult.lens_ready ? 'var(--positive-visual)' : 'var(--chrome-faint)' } }, captureResult.lens_ready ? 'ready' : 'not ready'))),
            h('div', { className: 'capw-sumfields' },
              h('div', { className: 'capw-sumf' }, h('span', { className: 'k' }, 'session 目录'), h('span', { className: 'v mono' }, captureResult.session_dir))))),
        h('div', { className: 'capw-foot' },
          h(Button, { variant: 'secondary', size: 'M', icon: h(Icon, { name: 'sync', size: 15 }), onPress: () => { setPhase('config'); setCaptureResult(null); } }, '重新采集'),
          h('div', { style: { flex: 1 } }),
          h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'check', size: 15 }), onPress: savedSession }, '保存会话')));
    } else {
      side = h(React.Fragment, null,
        h('div', { className: 'capw-side-scroll' },
          sourceSection,
          locked ? h(CoverageCard, { cov, posesCaptured: cov ? cov.poseCount : 0, target }) : paramsSection),
        h('div', { className: 'capw-foot' + (locked ? ' is-capture' : '') },
          locked
            ? h(React.Fragment, null,
                h('div', { className: 'capw-prog' }, h('span', { className: 'k' }, '姿位'), h('b', null, cov ? cov.poseCount : 0), h('span', { className: 'sl' }, '/'), h('span', { className: 'm' }, target)),
                h(Button, { variant: 'secondary', size: 'M', icon: h(Icon, { name: 'arrowr', size: 15 }), onPress: skip }, '跳过此姿位'),
                h('div', { style: { flex: 1 } }),
                h(Button, { variant: 'negative', size: 'M', icon: h(Icon, { name: 'x', size: 15 }), onPress: () => setAskAbort(true) }, '中止'),
                h(Button, { variant: 'secondary', size: 'M', icon: h(Icon, { name: 'check', size: 15 }), onPress: finish }, '完成'))
            : h(React.Fragment, null,
                h('div', { className: 'capw-start' },
                  h(Button, { variant: 'accent', size: 'L', icon: h(Icon, { name: 'camera', size: 16 }), isDisabled: !canStart, onPress: start }, '开始采集'),
                  !canStart ? h('div', { className: 'capw-note capw-note--notice' }, h(Icon, { name: 'info', size: 14 }),
                    h('span', null, '待补：', reasons.join(' · '))) : h('div', { className: 'capw-hint' }, '选定 Profile 后画面已常驻监看，参数确认无误即可开始。')))));
    }

    const rzDirs = [['n', 0, -1], ['s', 0, 1], ['e', 1, 0], ['w', -1, 0], ['ne', 1, -1], ['nw', -1, -1], ['se', 1, 1], ['sw', -1, 1]];
    return h('div', { className: 'drawer drawer--capw', ref: rootRef }, head,
      h('div', { className: 'capw', style: { gridTemplateColumns: leftPct + '% ' + (100 - leftPct) + '%' } },
        stage, h('div', { className: 'capw-side' }, side),
        h('div', { className: 'capw-split', style: { left: leftPct + '%' }, onPointerDown: onSplit }, h('span', { className: 'capw-split-grip' }))),
      rzDirs.map(([n, dx, dy]) => h('div', { key: n, className: 'capw-rz capw-rz--' + n, onPointerDown: onResize(dx, dy) })),
      askAbort ? h('div', { className: 'capw-abort' },
        h('div', { className: 'capw-abort-card' },
          h('div', { className: 'capw-abort-h' }, h('span', { className: 'capw-abort-ic' }, h(Icon, { name: 'alert', size: 18 })), h('h3', null, '中止采集')),
          h('p', null, '将终止当前采集进程。已完成的 pose 会保留在 session.partial.json，可稍后用 vpcal capture finalize 恢复。'),
          h('div', { className: 'capw-abort-acts' },
            h(Button, { variant: 'secondary', size: 'M', onPress: () => setAskAbort(false) }, '继续采集'),
            h(Button, { variant: 'negative', size: 'M', icon: h(Icon, { name: 'x', size: 15 }), onPress: doAbort }, '中止并保留已拍姿位')))) : null);
  }

  function openCaptureWindow(s, opts) {
    opts = opts || {};
    s.setModal({ xwide: true, render: ({ s: st, close }) => h(CaptureWindow, Object.assign({ s: st, close }, opts)) });
  }
  const openGrid = (s, onSaved) => openCaptureWindow(s, { variant: 'grid', onSaved });
  const openLens = (s, opts) => openCaptureWindow(s, Object.assign({ variant: 'lens' }, opts));

  window.VOLO_CAPTURE = { openCaptureWindow, openGrid, openLens, CaptureWindow };
})();
