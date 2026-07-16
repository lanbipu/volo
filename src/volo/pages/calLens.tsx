// @ts-nocheck
/* Volo — 校正 · 镜头校正（Lens · 单页，相机画面为主体）
   1:1 port of the Claude Design handoff `src/cal2_lens.jsx`, wired to real vpcal.

   真实接线要点（与设计稿的差异均因「不编造数据」原则，详见各处注释）：
   - 采集：「开始采集」打开 calCaptureWindow.tsx 的共享实时采集单窗口（lens 变体），
     采集会话的真实闭环（devCapture.tsx 的 useCaptureSession/buildSessionArgs）与会话
     参数（poses/settleMs/…/patternsDir/lensPath）都收在那个窗口里，本页不再内联驱动
     capturing 态；窗口「保存会话」后通过 onSaved 把真实 result.data 交回本页，直接进
     captured 态。Profile 来自 calCapture.tsx 的 localStorage CRUD（loadProfiles）。
   - 求解：spawnSidecarStreaming('vpcal', ['quick','run','--config',<session.json>,
     '--output','json'])；结果 envelope 形状核实自 sidecars/vpcal/src/vpcal/cli/quick.py
     （data.result = CalibrationResult, data.confidence/data.solver_backend 顶层镜像）。
   - screen.json：vpcal ScreenDefinition 与 Volo 自己的 project.yaml screens{} 是两套
     不相关 schema（无转换代码，见调研），本批按 src/stage/model.ts 的既有假设——
     screen.json 是运营者线下生成好、手选路径——每工程一份，localStorage 持久化，
     不臆造「屏幕名/cabinets/来自网格」等无数据来源的字段。
   - 跨 fiber 共享（Lens 画面 与 lensInspector 是外壳里两棵独立 Slot fiber，互不共享
     hooks，见 calibrate.tsx 顶部架构注释）：本文件建一个模块级 lensStore
     （同 calibrate.tsx 的 projStore 手法），calibrate.tsx 的 inspector() 无条件调用
     useLensLive() 拿快照传给 lensInspector（纯函数，不在内部调用 hook）。 */
import * as React from "react";
import { pickFile } from "../api/commands";
import { spawnSidecarStreaming, useSidecarStream } from "../api/sidecarStream";
import { exportVpcalScreen } from "../api/meshCommands";

(function () {
  const { Button, Badge } = window.Spectrum2DesignSystem_b6d1b3;
  const { useState, useRef, useEffect, useMemo, useSyncExternalStore } = React;
  const h = React.createElement;
  const CX = window.VOLO_CAL2;

  /* ============================================================
     模块级 store —— Lens 画面（真实 mount 的组件）与 lensInspector
     （calibrate.tsx inspector() 里的纯函数分支）跨 fiber 共享的唯一真相源。
     ============================================================ */
  const lensStore = (() => {
    let st = {
      phase: 'idle', /* idle|captured|solving|solved —— capturing 态收在 calCaptureWindow.tsx 的共享单窗口里 */
      profileId: null,
      screenPath: null,
      captureResult: null, /* 采集完成：{session_dir, poses_captured, lens_ready, marker_hits_total} */
      sessionPathForSolve: null, /* 采集完成后本页「立即求解」用的 session.json 路径 */
      solveResult: null,   /* 已求解：见 buildSolveResult() */
      solveError: null,    /* 求解失败：{exitCode, title, msg} */
      estimateLens: false,
      screenFingerprint: null,
      screenSourceSnapshot: null,
    };
    const listeners = new Set();
    const notify = () => listeners.forEach((l) => l());
    return {
      get: () => st,
      patch: (p) => { st = { ...st, ...p }; notify(); },
      subscribe: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    };
  })();
  function useLensLive() { return useSyncExternalStore(lensStore.subscribe, lensStore.get); }

  /* ---------- screen.json / sessions 根目录：按工程路径持久化（无转换后端，手选） ---------- */
  const scrKey = (projPath) => 'volo-cal-lens-screen::' + (projPath || '');
  const loadScreenPath = (projPath) => { try { return localStorage.getItem(scrKey(projPath)); } catch (e) { return null; } };
  const saveScreenPath = (projPath, p) => { try { p ? localStorage.setItem(scrKey(projPath), p) : localStorage.removeItem(scrKey(projPath)); } catch (e) {} };
  const rootKey = (projPath) => 'volo-cal-lens-sessroot::' + (projPath || '');
  const loadSessRoot = (projPath) => { try { return localStorage.getItem(rootKey(projPath)); } catch (e) { return null; } };
  const saveSessRoot = (projPath, p) => { try { p ? localStorage.setItem(rootKey(projPath), p) : localStorage.removeItem(rootKey(projPath)); } catch (e) {} };

  /* ---------- 路径拼接：沿用字符串里已出现的分隔符（Windows 生产 vs 本地 dev） ---------- */
  function joinPath(dir, name) {
    const sep = dir.indexOf('\\') >= 0 ? '\\' : '/';
    return dir.replace(/[\\/]+$/, '') + sep + name;
  }
  function baseName(p) { return p ? p.split(/[\\/]/).pop() : ''; }
  function dirName(p) { return p ? p.replace(/[\\/][^\\/]*$/, '') : ''; }
  function deriveOutputDir(sessionDir) { return joinPath(sessionDir, 'output'); }
  function deriveResultPath(sessionDir) { return joinPath(deriveOutputDir(sessionDir), 'result.json'); }

  /* ---------- 四元数(w,x,y,z) → 欧拉 XYZ(deg) / 4×4 矩阵（RigidTransform.matrix_4x4 为空时兜底） ---------- */
  function quatToEulerDeg(qt) {
    const [w, x, y, z] = qt;
    const sinr = 2 * (w * x + y * z), cosr = 1 - 2 * (x * x + y * y);
    const rx = Math.atan2(sinr, cosr);
    const sinp = 2 * (w * y - z * x);
    const ry = Math.abs(sinp) >= 1 ? Math.sign(sinp) * (Math.PI / 2) : Math.asin(sinp);
    const siny = 2 * (w * z + x * y), cosy = 1 - 2 * (y * y + z * z);
    const rz = Math.atan2(siny, cosy);
    return [rx, ry, rz].map((r) => (r * 180) / Math.PI);
  }
  function matFromTransQuat(t, qt) {
    const [w, x, y, z] = qt;
    const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
    return [
      [1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy), t[0]],
      [2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx), t[1]],
      [2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy), t[2]],
      [0, 0, 0, 1],
    ];
  }

  /* envelope（quick.py: data.result = CalibrationResult, data.confidence/data.solver_backend 顶层镜像）
     → 页面/对话框共用的求解结果形状。hand-eye / coverage / qa.reprojection.global_mean_px 在
     CalibrationResult schema 里不存在（models/calibration.py 核实），如实不渲染，不是遗漏。 */
  function buildSolveResult(env, sessionPath, resultPath) {
    const rr = env && env.data && env.data.result;
    if (!rr) return null;
    const t2 = rr.tracker_to_stage;
    return {
      translation: t2.translation,
      rotation: t2.rotation,
      matrix_4x4: t2.matrix_4x4 || matFromTransQuat(t2.translation, t2.rotation),
      euler_deg: quatToEulerDeg(t2.rotation),
      quality: rr.quality,
      solver_backend: env.data.solver_backend || (rr.solver_diagnostics && rr.solver_diagnostics.solver_backend) || null,
      degraded_backend: !!(env.data.degraded_backend || (rr.solver_diagnostics && rr.solver_diagnostics.degraded_backend)),
      parameter_covariance: (rr.solver_diagnostics && rr.solver_diagnostics.parameter_covariance) || null,
      timestamp: rr.timestamp,
      session_path: sessionPath,
      result_path: resultPath,
      output_dir: dirName(resultPath),
    };
  }

  /* exit_code 语义（sidecars/vpcal/docs/exit-codes.md）：9=partial，6=precondition
     （旋转多样性不足是 precondition 失败的一种，不是 6 的唯一含义——具体原因取
     env.error.message / stderr_tail，不固定文案）。 */
  function classifySolveFailure(env, exitEvent) {
    const code = exitEvent ? exitEvent.exit_code : null;
    const msg = (env && env.error && env.error.message) || (exitEvent && exitEvent.stderr_tail) || '求解进程异常退出，无更多信息。';
    if (code === 9) return { exitCode: 9, title: '观测不足（partial）', tone: 'notice', msg };
    if (code === 6) return { exitCode: 6, title: '前置条件未满足', tone: 'notice', msg };
    return { exitCode: code, title: '求解失败', tone: 'negative', msg };
  }

  /* ---------- 求解 hook（Lens 画面「立即求解」与 calLensDialogs 的「从已有 session 求解」共用） ---------- */
  function useLensSolve() {
    const [taskId, setTaskId] = useState(null);
    const [busy, setBusy] = useState(false);
    const [launchError, setLaunchError] = useState(null);
    const { state, cancel: cancelStream } = useSidecarStream(taskId);
    const run = async (sessionJsonPath, estimateLens) => {
      setLaunchError(null); setBusy(true);
      try {
        const args = ['quick', 'run', '--config', sessionJsonPath];
        if (estimateLens) args.push('--estimate-lens');
        args.push('--output', 'json');
        const resp = await spawnSidecarStreaming('vpcal', args);
        setTaskId(resp.task_id);
      } catch (e) { setBusy(false); setLaunchError(e && e.message ? e.message : String(e)); }
    };
    const outcome = useMemo(() => {
      if (!state.exit) return null;
      const last = state.lines[state.lines.length - 1];
      const env = last && last.parsed && typeof last.parsed === 'object' ? last.parsed : null;
      return { env, exit: state.exit };
    }, [state.exit]);
    useEffect(() => { if (state.exit) setBusy(false); }, [state.exit]);
    /* 真正终止后台 sidecar 任务（不只是 reset 本地 state）——否则「取消」只是 UI 谎报，
       vpcal quick run 进程仍在后台跑完并写 output/result.json。 */
    const cancel = () => { cancelStream(); setTaskId(null); setLaunchError(null); };
    const reset = () => { setTaskId(null); setLaunchError(null); };
    return { run, busy, outcome, launchError, cancel, reset };
  }

  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

  /* ---------- 通用内联 popover ---------- */
  function Pop({ btn, children, align = 'left', width }) {
    const [open, setOpen] = useState(false);
    const ref = useRef(null);
    useEffect(() => {
      if (!open) return undefined;
      const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
      document.addEventListener('mousedown', onDown);
      return () => document.removeEventListener('mousedown', onDown);
    }, [open]);
    return h('div', { className: 'lens-pop-wrap', ref },
      btn({ open, toggle: () => setOpen((v) => !v) }),
      open ? h('div', { className: 'lens-pop', style: Object.assign({ width }, align === 'right' ? { right: 0 } : { left: 0 }) },
        children(() => setOpen(false))) : null);
  }

  /* ---------- 摄影机画面：纯装饰性示意背景 ----------
     1:1 移植自设计稿 CameraFeed —— SVG（LED 墙 + ChArUco 结构光 + 检测叠加），不代表真实
     数据。capturing 态的真实 MJPEG 预览已收在 calCaptureWindow.tsx 的共享单窗口里，本页
     非 idle 时（captured/solving/solved）只用这个示意背景衬托浮层。 */
  function CameraFeed({ live, detect }) {
    const TL = [232, 150], TR = [726, 138], BR = [760, 412], BL = [198, 424];
    const bilerp = (u, v) => { const top = lerp(TL, TR, u), bot = lerp(BL, BR, u); return lerp(top, bot, v); };
    const bands = [], N = 22;
    for (let i = 0; i < N; i++) {
      const a = bilerp(i / N, 0), b = bilerp((i + 1) / N, 0), cc = bilerp((i + 1) / N, 1), d = bilerp(i / N, 1);
      bands.push(h('polygon', { key: 'b' + i, points: [a, b, cc, d].map((p) => p.join(',')).join(' '),
        fill: i % 2 ? 'rgba(150,175,210,.16)' : 'rgba(20,26,38,.55)' }));
    }
    const rows = [];
    for (let j = 1; j < 9; j++) { const l = bilerp(0, j / 9), rr = bilerp(1, j / 9); rows.push(h('line', { key: 'r' + j, x1: l[0], y1: l[1], x2: rr[0], y2: rr[1], stroke: 'rgba(120,150,190,.16)', strokeWidth: .8 })); }
    const tags = [[0.16, 0.2], [0.5, 0.16], [0.84, 0.21], [0.2, 0.82], [0.52, 0.86], [0.82, 0.83]].map((uv, i) => {
      const p = bilerp(uv[0], uv[1]);
      return h('g', { key: 't' + i, transform: 'translate(' + (p[0] - 11) + ' ' + (p[1] - 11) + ')' },
        h('rect', { width: 22, height: 22, fill: '#0c0f16' }),
        h('rect', { x: 4, y: 4, width: 6, height: 6, fill: '#c9d4e4' }),
        h('rect', { x: 12, y: 4, width: 4, height: 4, fill: '#c9d4e4' }),
        h('rect', { x: 4, y: 12, width: 4, height: 6, fill: '#c9d4e4' }),
        h('rect', { x: 13, y: 13, width: 5, height: 5, fill: '#c9d4e4' }));
    });
    return h('svg', { className: 'lens-feed', viewBox: '0 0 960 540', preserveAspectRatio: 'xMidYMid slice' },
      h('rect', { width: 960, height: 540, fill: '#06070b' }),
      h('polygon', { points: [TL, TR, BR, BL].map((p) => p.join(',')).join(' '), fill: '#0a0e16', stroke: 'rgba(140,170,210,.4)', strokeWidth: 1.5 }),
      h('g', null, bands), h('g', null, rows), h('g', null, tags),
      h('rect', { x: 354, y: 472, width: 252, height: 34, rx: 6, fill: 'rgba(0,0,0,.78)' }),
      h('text', { x: 480, y: 494, textAnchor: 'middle', fill: '#bfc4ce', fontSize: 15 }, '示意图（无真实预览信号）'));
  }

  /* 会话状态徽标（capturing 态收在共享采集单窗口里，本页 phase 只会是 idle/captured/solving/solved） */
  const LENS_SESSION_STATUS = {
    idle: { label: '空闲', tone: 'neutral', icon: 'minus' },
    captured: { label: '已有 session', tone: 'informative', icon: 'doc' },
    solving: { label: '求解中', tone: 'notice', icon: 'sync' },
    solved: { label: '已求解', tone: 'positive', icon: 'check' },
  };

  /* ================= 主页面 ================= */
  function Lens({ s }) {
    const proj = CX.useProj();
    const live = useLensLive();
    const phase = live.phase;
    const solve = useLensSolve();
    const [profiles, setProfiles] = useState(() => (CX.loadProfiles ? CX.loadProfiles() : []));
    const profile = profiles.find((p) => p.id === live.profileId) || null;
    const [screenExportBusy, setScreenExportBusy] = useState(false);

    /* 每次打开页面刷新一次 profile 列表（管理弹窗关闭后可能已增删） */
    useEffect(() => { const onFocus = () => setProfiles(CX.loadProfiles ? CX.loadProfiles() : []); window.addEventListener('focus', onFocus); return () => window.removeEventListener('focus', onFocus); }, []);
    /* 切工程 → 重新读取该工程的 screen.json 选择 */
    useEffect(() => { lensStore.patch({ screenPath: loadScreenPath(proj.path) }); }, [proj.path]);

    /* 「开始采集」打开共享实时采集单窗口（lens 变体）；capturing 态的会话驱动/图案
       播放器/覆盖度反馈全部收在 calCaptureWindow.tsx 里，本页只在窗口「保存会话」后
       通过 onSaved 拿到真实 result.data，直接进 captured 态。 */
    const startCapture = () => {
      if (!profile) return;
      window.VOLO_CAPTURE.openLens(s, {
        profileId: profile.id,
        screenPath: live.screenPath,
        onScreenPathChange: (p, fingerprint) => {
          lensStore.patch(Object.assign({ screenPath: p },
            fingerprint !== undefined ? { screenFingerprint: fingerprint, screenSourceSnapshot: sourceSnapshot } : null));
          saveScreenPath(proj.path, p);
        },
        onSaved: (resultData) => {
          const sessionJsonPath = joinPath(resultData.session_dir, 'session.json');
          lensStore.patch({ phase: 'captured', captureResult: resultData, solveResult: null, solveError: null, sessionPathForSolve: sessionJsonPath });
          s.setCalLensState('running');
          s.pushLog({ lv: 'ok', cat: 'lens', msg: '采集完成 · ' + resultData.poses_captured + ' pose 已写入 <b>' + resultData.session_dir + '</b>' });
        },
      });
    };

    const solveNow = () => {
      const cur = lensStore.get();
      const sp = cur.sessionPathForSolve;
      if (!sp || (cur.captureResult && !cur.captureResult.lens_ready)) return;
      lensStore.patch({ phase: 'solving' });
      s.pushLog({ lv: 'info', cat: 'lens', msg: '开始求解镜头外参 · <b>vpcal quick run</b>' });
      solve.run(sp, !!cur.estimateLens);
    };
    const cancelSolve = () => { solve.cancel(); lensStore.patch({ phase: 'captured' }); s.pushLog({ lv: 'warn', cat: 'lens', msg: '求解已取消 · 后台进程已终止' }); };

    const sourceSnapshot = proj.config && proj.config.screens && proj.config.screens[s.calActiveScreen]
      ? JSON.stringify(proj.config.screens[s.calActiveScreen]) : null;
    const sourceChanged = !!(live.screenSourceSnapshot && sourceSnapshot && live.screenSourceSnapshot !== sourceSnapshot);
    const generateScreen = async () => {
      if (!proj.path || !s.calActiveScreen || screenExportBusy) return;
      setScreenExportBusy(true);
      try {
        const out = await exportVpcalScreen(proj.path, s.calActiveScreen, null);
        lensStore.patch({ screenPath: out.path, screenFingerprint: out.fingerprint, screenSourceSnapshot: sourceSnapshot });
        saveScreenPath(proj.path, out.path);
        s.pushLog({ lv: 'ok', cat: 'lens', msg: '已从当前项目屏幕生成 <b>screen.json</b> · fingerprint ' + out.fingerprint });
      } catch (e) { s.pushLog({ lv: 'err', cat: 'lens', msg: '生成 screen.json 失败 · ' + (e && e.message ? e.message : e) }); }
      finally { setScreenExportBusy(false); }
    };

    /* 求解结果落地（Lens 页「立即求解」与 dialogs 里的「从已有 session 求解」共用同一 hook，
       但各自在调用处消费 outcome —— 这里只处理本页发起的求解） */
    useEffect(() => {
      if (phase !== 'solving' || !solve.outcome) return;
      const { env, exit } = solve.outcome;
      const sp = lensStore.get().sessionPathForSolve;
      if (env && env.status === 'ok') {
        const rp = deriveResultPath(dirName(sp));
        const result = buildSolveResult(env, sp, rp);
        lensStore.patch({ phase: 'solved', solveResult: result, solveError: null });
        s.setCalLensState('done');
        s.pushLog({ lv: 'ok', cat: 'lens', msg: 'lens solve 收敛 · validation_rms <b>' + (result.quality.validation_rms_px != null ? result.quality.validation_rms_px.toFixed(2) : 'n/a') + ' px</b> · confidence ' + result.quality.confidence });
      } else {
        const err = classifySolveFailure(env, exit);
        lensStore.patch({ phase: 'captured', solveError: err });
        s.pushLog({ lv: 'err', cat: 'lens', msg: 'lens solve 失败 · ' + err.title + ' · exit ' + err.exitCode });
      }
    }, [phase, solve.outcome]);

    /* ---------- 顶部薄工具条 ---------- */
    const statusKey = phase === 'idle' ? 'idle' : phase;
    const st = LENS_SESSION_STATUS[statusKey] || LENS_SESSION_STATUS.idle;
    const topbar = h('div', { className: 'lens-topbar' },
      h(Pop, { width: 268, btn: ({ open, toggle }) => h('button', { className: 'lens-tbtn' + (open ? ' on' : ''), onClick: toggle },
        h(Icon, { name: 'camera', size: 15 }),
        h('span', { className: 'lens-tbtn-k' }, '采集配置'),
        h('b', null, profile ? profile.name : '未选择'),
        h(Icon, { name: 'chevd', size: 13 })) },
        (close) => h(React.Fragment, null,
          h('div', { className: 'lens-pop-h' }, '命名采集配置'),
          profiles.length === 0 ? h('div', { style: { padding: '8px 9px', fontSize: 12, color: 'var(--chrome-faint)' } }, '还没有采集配置') : null,
          profiles.map((p) => h('button', { key: p.id, className: 'lens-pop-i' + (p.id === live.profileId ? ' on' : ''),
            onClick: () => { lensStore.patch({ profileId: p.id }); close(); } },
            h('span', { className: 'lens-pop-ic' }, h(Icon, { name: p.videoBackend === 'synthetic' ? 'grid' : 'camera', size: 14 })),
            h('div', { className: 'lens-pop-meta' }, h('div', { className: 'lens-pop-n' }, p.name),
              h('div', { className: 'lens-pop-s' }, p.videoBackend + ' / ' + p.device)),
            p.id === live.profileId ? h(Icon, { name: 'check', size: 14 }) : null)),
          h('button', { className: 'lens-pop-manage', onClick: () => { close(); CX.openCaptureModal(s); } },
            h(Icon, { name: 'sliders', size: 14 }), '管理配置…'))),
      h(Pop, { width: 300, btn: ({ open, toggle }) => h('button', { className: 'lens-chip' + (open ? ' on' : ''), onClick: toggle, title: '点击更换 screen.json' },
        h(Icon, { name: 'doc', size: 14 }), h('span', { className: 'mono' }, live.screenPath ? baseName(live.screenPath) : '未设置 screen.json'), h(Icon, { name: 'chevd', size: 12 })) },
        (close) => {
          const pick = async () => {
            try { const p = await pickFile('vpcal screen definition (screen.json)', ['json']); if (p) { lensStore.patch({ screenPath: p }); saveScreenPath(proj.path, p); } }
            catch (e) { s.pushLog({ lv: 'err', cat: 'lens', msg: `选择 screen.json 失败 · ${e && e.message ? e.message : e}` }); }
            close();
          };
          return h(React.Fragment, null,
            h('div', { className: 'lens-pop-h' }, 'screen.json'),
            h('div', { className: 'lens-sj' },
              live.screenPath
                ? h(React.Fragment, null,
                    h('div', { className: 'lens-sj-row' }, h('span', { className: 'k' }, '文件'), h('span', { className: 'v mono' }, baseName(live.screenPath))),
                    h('div', { className: 'lens-sj-row' }, h('span', { className: 'k' }, '目录'), h('span', { className: 'v mono dim' }, dirName(live.screenPath))))
                : h('div', { style: { fontSize: 12, color: 'var(--chrome-faint)' } }, '尚未设置，vpcal 采集/求解均需要此文件。'),
              live.screenFingerprint ? h('div', { className: 'lens-sj-row' }, h('span', { className: 'k' }, 'fingerprint'), h('span', { className: 'v mono dim' }, live.screenFingerprint)) : null,
              sourceChanged ? h('div', { className: 'lens-nanote', style: { color: 'var(--notice-visual)' } }, h(Icon, { name: 'alert', size: 13 }), '项目屏幕源已变更，建议重新生成。') : null),
            h('button', { className: 'lens-pop-manage', disabled: screenExportBusy || !proj.path, onClick: () => { void generateScreen(); close(); } },
              h(Icon, { name: 'sync', size: 14 }), screenExportBusy ? '生成中…' : '从当前项目屏幕生成 screen.json'),
            h('button', { className: 'lens-pop-manage', onClick: pick },
              h(Icon, { name: 'folder', size: 14 }), '浏览选择 screen.json…'));
        }),
      h('div', { style: { flex: 1 } }),
      h('button', { className: 'lens-tbtn', onClick: () => CX.openPlayerCheck(s), title: '在 LED 处理器显示器打开图案播放器并校验分辨率' },
        h(Icon, { name: 'panel', size: 15 }), '播放器自检'),
      h('span', { className: 'spill spill--' + st.tone },
        st.icon === 'minus' ? h('span', { style: { fontWeight: 700 } }, '—') : h(Icon, { name: st.icon, size: 12 }), st.label));

    /* ---------- 画面区 ---------- */
    let stage;
    if (phase === 'idle') {
      const hasScreen = !!live.screenPath;
      stage = h('div', { className: 'lens-stage lens-stage--idle' },
        h('div', { className: 'lens-idle' },
          h('div', { className: 'lens-idle-ic' }, h(Icon, { name: 'camera', size: 40, stroke: 1.3 })),
          h('div', { className: 'lens-idle-t' }, '选择采集配置后开始实时采集'),
          h('div', { className: 'lens-idle-d' }, !hasScreen ? '需先设置 screen.json（顶部工具条），再选择采集配置开始采集。'
            : profile ? ('已选配置 “' + profile.name + '” · 点底部「开始采集」进入现场机位摆位。') : '顶部工具条选择一个命名采集配置（Profile），再开始采集。'),
          h('div', { className: 'lens-idle-alt' },
            h(Button, { variant: 'secondary', size: 'M', icon: h(Icon, { name: 'doc', size: 15 }), onPress: () => CX.openSolveFromSession(s) }, '从已有 session 求解'))));
    } else {
      /* capturing 态收在共享采集单窗口里，本页非 idle 时只会是 captured/solving/solved
         之一——画面区始终是示意背景（无真实预览信号，见 CameraFeed 注释）+ 对应浮层。 */
      stage = h('div', { className: 'lens-stage' },
        h(CameraFeed, { live: false, detect: true }),
        h('div', { className: 'lens-scan' }),
        h('div', { className: 'lens-vig' }),
        h('div', { className: 'lens-hud lens-hud--tl' }, h('span', { className: 'lens-mjpeg' }, 'FROZEN')),
        phase === 'captured' && live.captureResult ? h('div', { className: 'lens-overlay' },
          h('div', { className: 'lens-ov-card' },
            h('div', { className: 'lens-ov-h' }, h('span', { className: 'lens-ov-ic ok' }, h(Icon, { name: 'check', size: 18 })), h('h3', null, '采集完成')),
            h('div', { className: 'lens-ov-fields' },
              ovField('session 目录', live.captureResult.session_dir, true),
              ovField('poses_captured', String(live.captureResult.poses_captured)),
              ovField('marker_hits_total', String(live.captureResult.marker_hits_total)),
              h('div', { className: 'lens-ov-f' }, h('span', { className: 'k' }, 'lens_ready'),
                h('span', null, live.captureResult.lens_ready ? h(Badge, { variant: 'positive', size: 'S' }, 'ready') : h(Badge, { variant: 'neutral', size: 'S' }, 'not ready')))),
            live.solveError ? h('div', { className: 'lens-ov-note', style: { color: 'var(--negative-visual)' } }, live.solveError.title + '（exit ' + live.solveError.exitCode + '）· ' + live.solveError.msg) : null,
            /* SessionConfig.lens 是必填字段（models/session.py:243）——没有 lens 的 session
               求解必然 validation fail，禁用按钮而不是让用户点了才看到必然失败的报错。 */
            !live.captureResult.lens_ready ? h('div', { className: 'lens-ov-note', style: { color: 'var(--notice-visual)' } }, '缺 lens profile，需先在采集配置里补上 lensPath 才能求解。') : null,
            h('label', { className: 'cap-toggle-row', style: { marginTop: 10 } },
              h('input', { type: 'checkbox', checked: !!live.estimateLens, onChange: (e) => lensStore.patch({ estimateLens: e.target.checked }) }),
              h('div', null, h('div', { className: 'cap-tg-t' }, '联合估计镜头（QLE）'), h('div', { className: 'cap-tg-s' }, '传入 --estimate-lens；结果仅绑定本 session，不是 master lens'))),
            h(Button, { variant: 'accent', size: 'L', icon: h(Icon, { name: 'target', size: 16 }), isDisabled: !live.captureResult.lens_ready, onPress: solveNow }, live.solveError ? '重新求解' : '立即求解'))) : null,
        phase === 'solving' ? h('div', { className: 'lens-overlay' },
          h('div', { className: 'lens-ov-card lens-ov-card--solving' },
            h('div', { className: 'lens-ov-h' }, h('span', { className: 'lens-ov-ic' }, h(Icon, { name: 'sync', size: 18 })), h('h3', null, '正在求解镜头外参')),
            h('div', { className: 'lens-indet' }, h('div', { className: 'lens-indet-bar' })),
            h('div', { className: 'lens-ov-note' }, '光束平差求解中（vpcal quick run），用时取决于 pose 数与观测量，请稍候…'),
            h(Button, { variant: 'secondary', size: 'M', icon: h(Icon, { name: 'x', size: 15 }), onPress: cancelSolve }, '取消'))) : null,
        phase === 'solved' && live.solveResult ? h('div', { className: 'lens-hud lens-hud--br lens-result' },
          h('div', { className: 'lens-result-h' }, h(Icon, { name: 'target', size: 14 }), '求解结果'),
          h('div', { className: 'lens-result-main' },
            h('div', { className: 'lens-result-rms' },
              h('span', { className: 'n' }, live.solveResult.quality.validation_rms_px != null ? live.solveResult.quality.validation_rms_px.toFixed(2) : 'n/a'),
              live.solveResult.quality.validation_rms_px != null ? h('span', { className: 'u' }, 'px') : null,
              h('span', { className: 'lb' }, 'validation_rms')),
            CX.confBadge(live.solveResult.quality.confidence)),
          live.solveResult.degraded_backend ? h('div', { className: 'lens-nanote', style: { color: 'var(--notice-visual)' } }, h(Icon, { name: 'alert', size: 13 }), '求解器使用了 fallback / degraded path') : null,
          live.solveResult.parameter_covariance ? h('div', { className: 'lens-nanote' }, 'parameter covariance · ' + (live.solveResult.parameter_covariance.available ? 'available' : 'unavailable')) : null,
          h('button', { className: 'lens-result-btn', onClick: () => CX.openReport(s) }, h(Icon, { name: 'doc', size: 13 }), '查看完整报告')) : null);
    }

    /* ---------- 底部动作条 ---------- */
    const solved = phase === 'solved';
    const reason = !profile ? '未选择采集配置' : null;
    const actions = h('div', { className: 'lens-actionbar' },
      h('div', { className: 'lens-start-wrap' },
        h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'camera', size: 15 }), isDisabled: !!reason || phase === 'solving', onPress: startCapture }, '开始采集'),
        reason ? h('span', { className: 'lens-start-reason' }, h(Icon, { name: 'info', size: 12 }), reason) : null),
      h(Button, { variant: 'secondary', size: 'M', icon: h(Icon, { name: 'doc', size: 15 }), onPress: () => CX.openSolveFromSession(s) }, '从已有 session 求解'),
      h('div', { style: { flex: 1 } }),
      h(Button, { variant: 'secondary', size: 'M', icon: h(Icon, { name: 'download', size: 15 }), isDisabled: !solved,
        onPress: () => CX.openExport(s) }, '导出 OpenTrackIO'));

    return h('div', { className: 'cal2-canvas-wrap lens-wrap' }, topbar, stage, actions);
  }

  function ovField(k, v, mono) {
    return h('div', { className: 'lens-ov-f', key: k }, h('span', { className: 'k' }, k), h('span', { className: 'v' + (mono ? ' mono' : '') }, v));
  }

  /* ================= inspector（纯函数，不在内部调用 hook —— live 由 calibrate.tsx
     的 inspector() 用 CX.useLensLive() 无条件取好后传入，理由见文件头架构注释） ================= */
  const KV = (k, v, mono, tone) => h('div', { className: 'kv', key: k }, h('span', { className: 'k' }, k),
    h('span', { className: 'v' + (mono ? ' mono' : '') + (tone ? ' s-' + tone : '') }, v));

  function lensInspector(s, live) {
    live = live || lensStore.get();
    const phase = live.phase;
    if (phase === 'solved' && live.solveResult) {
      const R = live.solveResult, q = R.quality;
      const le = q.lens_estimate;
      return h(React.Fragment, null,
        h('div', { className: 'insp-head' },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 9, marginBottom: 6 } },
            h('span', { className: 'step-ico', style: { width: 30, height: 30, borderRadius: 8, background: 'var(--wash)', display: 'grid', placeItems: 'center' } }, h(Icon, { name: 'target', size: 16 })),
            h('h2', { style: { margin: 0, fontSize: 15, fontWeight: 700 } }, 'tracker_to_stage')),
          CX.confBadge(q.confidence)),
        h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, '平移 translation [x, y, z] (mm)'),
          KV('x', R.translation[0].toFixed(4), true), KV('y', R.translation[1].toFixed(4), true), KV('z', R.translation[2].toFixed(4), true)),
        h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, '欧拉角 XYZ (deg)'),
          KV('rx', R.euler_deg[0].toFixed(2), true), KV('ry', R.euler_deg[1].toFixed(2), true), KV('rz', R.euler_deg[2].toFixed(2), true)),
        h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, 'quality'),
          KV('reprojection_rms_px', q.reprojection_rms_px.toFixed(2), true, 'positive'),
          h('div', { className: 'kv lens-kv-hi' }, h('span', { className: 'k' }, 'validation_rms_px'),
            h('span', { className: 'v' }, CX.rmsBadge(q.validation_rms_px, 'px'), h('span', { className: 'lens-kv-tag' }, '主指标'))),
          KV('total_observations', q.total_observations.toLocaleString(), true),
          KV('inlier_observations', q.inlier_observations.toLocaleString(), true),
          KV('num_poses', String(q.num_poses), true),
          h('div', { className: 'kv' }, h('span', { className: 'k' }, 'confidence'), h('span', { className: 'v' }, CX.confBadge(q.confidence)))),
        R.degraded_backend ? h('div', { className: 'lens-warn' }, h(Icon, { name: 'alert', size: 12 }), h('span', null, '求解器使用了 fallback / degraded path')) : null,
        R.parameter_covariance ? h('div', { className: 'lens-warn' }, h(Icon, { name: R.parameter_covariance.available ? 'check' : 'alert', size: 12 }), h('span', null, 'parameter covariance · ' + (R.parameter_covariance.available ? 'available' : 'unavailable'))) : null,
        le ? h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, 'QLE · session-coupled'),
          h('div', { className: 'lens-qle' }, h('span', { className: 'spill spill--informative' }, h(Icon, { name: 'bolt', size: 12 }), 'quick lens estimate'),
            h('p', { className: 'lens-qle-note' }, '随本次 session 耦合估计，仅供本会话使用；非 master lens。'),
            KV('confidence', le.confidence || 'low', true),
            KV('RMS', Number(le.spatial_only_rms_px).toFixed(3) + ' → ' + Number(le.refined_rms_px).toFixed(3) + ' px', true),
            ['focal_length_mm', 'distortion_k1', 'distortion_k2'].map((k) => le[k] ? KV(k, le[k].observable ? String(le[k].value) + (le[k].std == null ? '' : ' ± ' + le[k].std) : 'reverted · ' + (le[k].locked_reason || 'gate'), true) : null),
            (le.identifiability_flags || []).map((flag, i) => h('div', { key: i, className: 'lens-warn' }, h(Icon, { name: 'alert', size: 12 }), h('span', null, flag))))) : null,
        h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, '功能入口'),
          h('div', { className: 'lens-entry-list' },
            entryBtn('doc', '求解结果报告', () => CX.openReport(s)),
            entryBtn('live', '实时回填验证（verify live）', () => CX.openLiveVerify(s)),
            entryBtn('download', '导出 OpenTrackIO', () => CX.openExport(s)),
            entryBtn('panel', '播放器自检', () => CX.openPlayerCheck(s)))));
    }
    return h(React.Fragment, null,
      CX.inspEmpty(phase === 'captured' ? '已有 session · 点画面「立即求解」' : phase === 'solving' ? '求解进行中…' : '开始采集或从已有 session 求解'),
      h('div', { className: 'insp-sect', style: { marginTop: 12 } }, h('div', { className: 'lh' }, '功能入口'),
        h('div', { className: 'lens-entry-list' },
          entryBtn('download', '导出 OpenTrackIO', () => CX.openExport(s), phase !== 'solved'),
          entryBtn('panel', '播放器自检', () => CX.openPlayerCheck(s)))));
  }
  function entryBtn(icon, label, onClick, disabled) {
    return h('button', { className: 'lens-entry' + (disabled ? ' is-disabled' : ''), onClick: disabled ? undefined : onClick, disabled },
      h('span', { className: 'lens-entry-ic' }, h(Icon, { name: icon, size: 15 })), h('span', null, label), h(Icon, { name: 'chevr', size: 14 }));
  }

  window.VOLO_CAL2 = Object.assign(window.VOLO_CAL2 || {}, {
    Lens, lensInspector, useLensLive, lensStore, useLensSolve,
    buildSolveResult, classifySolveFailure, deriveOutputDir, deriveResultPath, joinPath, baseName, dirName,
    loadScreenPath, saveScreenPath, loadSessRoot, saveSessRoot,
  });
})();
