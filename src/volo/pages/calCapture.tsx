// @ts-nocheck
import * as React from "react";
import "../ds";
import { listMonitors, openPatternPlayer, closePatternPlayer, playerShowPattern } from "../api/player";
import { isTauri } from "../api/invoke";
import { pickFile, pickDirectory } from "../api/commands";
import { useCaptureSession, buildSessionArgs } from "./devCapture";

/* Volo — Calibrate ·「实时采集」步骤视图（A1 配置 / A2 采集 / A3 完成 + B 播放器控制段）
   现场操作员对着 LED 墙依次摆 8+ 机位，系统检测「相机停稳」自动采集。
   状态永远三通道（颜色 + 图标 + 文字）。字段名对齐后端 DTO，勿改名。 */
(function () {
  const { Button, Badge, InlineAlert, Switch } = window.Spectrum2DesignSystem_b6d1b3;
  const { useState, useEffect, useRef } = React;
  const h = React.createElement;
  const Selector = window.Selector;

  const LS = 'volo-cap-phase';
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

  /* three-channel pill (color + icon + text) */
  function Pill({ tone, icon, children, size }) {
    return h('span', { className: 'cap-pill cap-pill--' + tone + (size === 'lg' ? ' is-lg' : '') },
      icon ? h(Icon, { name: icon, size: size === 'lg' ? 15 : 13 }) : null,
      h('span', null, children));
  }

  /* ---- LED-wall preview：真实 MJPEG（url）优先，否则合成占位 ---- */
  function PreviewMock({ state, url }) {
    const recording = state === 'capturing';
    if (url) {
      return h('div', { className: 'cap-preview' },
        h('img', { src: url, alt: '预览', style: { width: '100%', height: '100%', objectFit: 'cover', display: 'block', background: '#000' } }),
        h('div', { className: 'cap-preview-tags' },
          h('span', { className: 'cap-src-tag' }, h(Icon, { name: 'camera', size: 12 }), 'MJPEG · live'),
          recording ? h('span', { className: 'cap-rec' }, h('i', null), 'REC') : null),
        h('div', { className: 'cap-preview-cross' }, '＋'));
    }
    const inverted = state === 'capturing';
    const cells = [];
    for (let r = 0; r < 5; r++) for (let c = 0; c < 9; c++) {
      const on = (r * 9 + c * 3 + (r % 2)) % 3 !== 0;
      cells.push(h('rect', { key: r + '_' + c, x: 60 + c * 86, y: 44 + r * 86, width: 62, height: 62, rx: 4,
        fill: inverted ? (on ? '#0b0b0d' : '#e9edf3') : (on ? '#e9edf3' : '#0b0b0d'), opacity: 0.92 }));
    }
    /* detected marker crosses */
    const crosses = [];
    const pts = [[103, 87], [447, 87], [791, 87], [275, 259], [619, 259], [103, 431], [791, 431], [447, 431]];
    pts.forEach((p, i) => crosses.push(h('g', { key: 'x' + i, stroke: '#37d67a', strokeWidth: 2 },
      h('line', { x1: p[0] - 9, y1: p[1], x2: p[0] + 9, y2: p[1] }),
      h('line', { x1: p[0], y1: p[1] - 9, x2: p[0], y2: p[1] + 9 }))));
    return h('div', { className: 'cap-preview' },
      h('svg', { viewBox: '0 0 900 506', width: '100%', height: '100%', preserveAspectRatio: 'xMidYMid slice' },
        h('rect', { x: 0, y: 0, width: 900, height: 506, fill: '#101014' }),
        h('rect', { x: 44, y: 30, width: 812, height: 446, rx: 8, fill: '#0a0a0c', stroke: 'rgba(255,255,255,.08)' }),
        h('g', null, cells),
        state !== 'wait_tracking' ? h('g', null, crosses) : null),
      h('div', { className: 'cap-preview-tags' },
        h('span', { className: 'cap-src-tag' }, h(Icon, { name: 'camera', size: 12 }), 'MJPEG · 1280×720 · 30 fps'),
        recording ? h('span', { className: 'cap-rec' }, h('i', null), 'REC') : null),
      h('div', { className: 'cap-preview-cross' }, '＋'));
  }

  /* ============================= A1 · 配置态 ============================= */
  function ConfigView({ s, cfg, setCfg, start }) {
    const [advOpen, setAdvOpen] = useState(false);
    const vb = CAP_VIDEO_BACKENDS.find((x) => x.id === cfg.videoBackend) || CAP_VIDEO_BACKENDS[0];
    const link = CAP_TRACK_LINK[cfg.trackLink];
    /* 真实文件选择：Tauri 走原生选择器，浏览器演示态切换占位名 */
    const pickInto = async (key, name, exts, demoVal) => {
      if (!isTauri()) { setCfg({ ...cfg, [key]: cfg[key] ? null : demoVal }); return; }
      try { const p = exts ? await pickFile(name, exts) : await pickDirectory(); if (p) setCfg({ ...cfg, [key]: p }); }
      catch (e) { s.pushLog && s.pushLog({ lv: 'err', cat: 'capture', msg: `选择 ${name} 失败 · ${e && e.message ? e.message : e}` }); }
    };
    const base = (p) => (p ? p.split(/[\\/]/).pop() : null);
    const canRun = !isTauri() || (cfg.screenPath && cfg.outDir);

    const NumRow = (label, key, unit, min, max) => h('div', { className: 'cap-num' },
      h('label', null, label),
      h('div', { className: 'cap-num-in' },
        h('input', { type: 'number', value: cfg[key], min, max,
          onChange: (e) => setCfg({ ...cfg, [key]: e.target.value }) }),
        unit ? h('span', { className: 'u' }, unit) : null));

    return h('div', { className: 'cap-config cal-scroll' },
      h('div', { className: 'cap-cfg-grid' },
        /* 视频源 */
        h('div', { className: 'cap-card' },
          h('div', { className: 'cap-card-h' }, h(Icon, { name: 'camera', size: 15 }), '视频源'),
          h('div', { className: 'cap-field' },
            h('span', { className: 'cap-lbl' }, 'backend'),
            h(Selector, { kpre: '', value: cfg.videoBackend, width: 200,
              options: CAP_VIDEO_BACKENDS.map((x) => ({ id: x.id, label: x.label + (x.avail ? '' : ' · 不可用'), sub: x.note })),
              onChange: (id) => { const b = CAP_VIDEO_BACKENDS.find((x) => x.id === id); if (b && b.avail) setCfg({ ...cfg, videoBackend: id }); } })),
          h('div', { className: 'cap-field' },
            h('span', { className: 'cap-lbl' }, '设备号'),
            h('input', { className: 'cap-tf', value: cfg.deviceId, onChange: (e) => setCfg({ ...cfg, deviceId: e.target.value }) })),
          !vb.avail ? h('div', { className: 'cap-inline-note notice' },
            h(Icon, { name: 'alert', size: 13 }),
            h('span', null, vb.note, ' ', h('a', { href: '#', onClick: (e) => e.preventDefault() }, '查看指引'))) : null,
          h('div', { className: 'cap-backend-list' },
            CAP_VIDEO_BACKENDS.map((b) => h('div', { key: b.id, className: 'cap-be' + (b.avail ? '' : ' off') + (b.id === cfg.videoBackend ? ' on' : ''),
              onClick: () => b.avail && setCfg({ ...cfg, videoBackend: b.id }) },
              h('span', { className: 'sdot bg-' + (b.avail ? (b.id === cfg.videoBackend ? 'positive' : 'neutral') : 'neutral') }),
              b.label, b.avail ? null : h('span', { className: 'cap-be-x' }, '需 SDK'))))),
        /* 追踪源 */
        h('div', { className: 'cap-card' },
          h('div', { className: 'cap-card-h' }, h(Icon, { name: 'net', size: 15 }), '追踪源'),
          h('div', { className: 'cap-field' },
            h('span', { className: 'cap-lbl' }, '协议'),
            h('div', { className: 'cap-seg' },
              CAP_TRACK_PROTOCOLS.map((p) => h('button', { key: p.id, className: cfg.trackProto === p.id ? 'on' : '',
                onClick: () => setCfg({ ...cfg, trackProto: p.id }) }, p.label)))),
          h('div', { className: 'cap-field' },
            h('span', { className: 'cap-lbl' }, 'UDP 端口'),
            h('input', { className: 'cap-tf', value: cfg.udpPort, onChange: (e) => setCfg({ ...cfg, udpPort: e.target.value }) })),
          h('div', { className: 'cap-field' },
            h('span', { className: 'cap-lbl' }, '连接状态'),
            h(Pill, { tone: link.tone, icon: link.icon }, link.label)),
          h('div', { className: 'cap-link-seg' },
            [['connected', '已连接'], ['waiting', '等待数据'], ['lost', '信号丢失']].map(([k, l]) =>
              h('button', { key: k, className: 'cap-link-btn' + (cfg.trackLink === k ? ' on' : ''),
                onClick: () => setCfg({ ...cfg, trackLink: k }) },
                h('span', { className: 'sdot bg-' + CAP_TRACK_LINK[k].tone }), l))),
          h('div', { className: 'cap-hint' }, '演示：切换以预览三态连接反馈'))),
      /* 采集参数 */
      h('div', { className: 'cap-card cap-card--wide' },
        h('div', { className: 'cap-card-h' }, h(Icon, { name: 'target', size: 15 }), '采集参数'),
        h('div', { className: 'cap-param-grid' },
          h('div', { className: 'cap-num' },
            h('label', null, '目标 pose 数'),
            h('div', { className: 'cap-stepper' },
              h('button', { onClick: () => setCfg({ ...cfg, targetPoses: clamp(+cfg.targetPoses - 1, 3, 24) }) }, '−'),
              h('span', null, cfg.targetPoses),
              h('button', { onClick: () => setCfg({ ...cfg, targetPoses: clamp(+cfg.targetPoses + 1, 3, 24) }) }, '+')),
            h('span', { className: 'cap-min' }, '最少 3')),
          h('div', { className: 'cap-toggle-row' },
            h('div', null, h('div', { className: 'cap-tg-t' }, '反相双帧'),
              h('div', { className: 'cap-tg-s' }, '正/反图案各拍一帧做差分')),
            h(Switch, { isSelected: cfg.dualFrame, onChange: (v) => setCfg({ ...cfg, dualFrame: v }) })),
          h('div', { className: 'cap-lens' },
            h('label', null, 'screen.json' + (isTauri() ? ' · 必填' : '')),
            h('div', { className: 'cap-lens-pick' },
              h('button', { className: 'cap-file-btn', onClick: () => pickInto('screenPath', 'screen 定义', ['json'], 'screen.json') },
                h(Icon, { name: 'folder', size: 14 }), base(cfg.screenPath) || '选择文件…'),
              cfg.screenPath ? h(Pill, { tone: 'positive', icon: 'check' }, '已选') : null),
            h('label', { style: { marginTop: 10 } }, '输出目录' + (isTauri() ? ' · 必填' : '')),
            h('div', { className: 'cap-lens-pick' },
              h('button', { className: 'cap-file-btn', onClick: () => pickInto('outDir', '输出目录', null, 'captures/session_01') },
                h(Icon, { name: 'folder', size: 14 }), base(cfg.outDir) || '选择目录…'),
              cfg.outDir ? h(Pill, { tone: 'positive', icon: 'check' }, '已选') : null),
            h('label', { style: { marginTop: 10 } }, 'lens profile'),
            h('div', { className: 'cap-lens-pick' },
              h('button', { className: 'cap-file-btn', onClick: () => pickInto('lensProfile', 'lens profile', ['json'], 'lens_master_35mm.json') },
                h(Icon, { name: 'folder', size: 14 }), base(cfg.lensProfile) || '选择文件…'),
              cfg.lensProfile ? h(Pill, { tone: 'positive', icon: 'check' }, '已就绪') : null),
            !cfg.lensProfile ? h('div', { className: 'cap-inline-note notice' }, h(Icon, { name: 'alert', size: 13 }),
              h('span', null, '缺 lens 无法直接求解，可后补')) : null)),
        /* 高级参数折叠 */
        h('div', { className: 'cap-adv' },
          h('button', { className: 'cap-adv-h', onClick: () => setAdvOpen((v) => !v) },
            h(Icon, { name: 'chevr', size: 13, style: { transform: advOpen ? 'rotate(90deg)' : 'none', transition: 'transform .15s' } }),
            '高级参数', h('span', { className: 'cap-adv-tag' }, '静止判定 / 阈值 / 连拍')),
          advOpen ? h('div', { className: 'cap-adv-body' },
            NumRow('静止判定时长', 'settleMs', 'ms', 100, 2000),
            NumRow('静止速度阈值', 'stillThresh', 'mm/s', 0, 50),
            NumRow('移动速度阈值', 'moveThresh', 'mm/s', 0, 200),
            NumRow('连拍帧数', 'burst', '帧', 1, 12),
            NumRow('配对容差', 'pairTol', 's', 0, 2)) : null)),
      /* B 播放器控制段（反相双帧或图案播放时出现） */
      cfg.dualFrame ? h(PlayerSegment, { s, cfg, output: 'black' }) : null,
      /* 主操作 */
      h('div', { className: 'cap-cfg-foot' },
        h('div', { className: 'cap-cfg-sum' },
          h('span', null, '视频 ', h('b', null, vb.label)),
          h('span', { className: 'dot' }, '·'),
          h('span', null, '追踪 ', h('b', null, cfg.trackProto === 'freed' ? 'FreeD' : 'OpenTrackIO'), ' :', cfg.udpPort),
          h('span', { className: 'dot' }, '·'),
          h('span', null, '目标 ', h('b', null, cfg.targetPoses), ' pose')),
        h(Button, { variant: 'accent', size: 'L', icon: h(Icon, { name: 'live', size: 16 }),
          isDisabled: cfg.trackLink === 'lost' || !canRun,
          onPress: start }, isTauri() && !canRun ? '选择 screen.json 与输出目录' : '开始采集')));
  }

  /* ============================= B · 播放器控制段 ============================= */
  /* 接真 player.ts：list_monitors 枚举真实显示器 · open/close_pattern_player 开关播放窗 ·
     1:1 自检对比真实显示器物理分辨率。浏览器预览无后端时回退 CAP_PLAYER mock。 */
  function PlayerSegment({ s, cfg, output }) {
    const fallbackMons = CAP_PLAYER.monitors;
    const [mons, setMons] = useState(fallbackMons);
    const [monIdx, setMonIdx] = useState(() => (fallbackMons.find((m) => m.is_primary) || fallbackMons[0]).index);
    const [winOpen, setWinOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    useEffect(() => {
      if (!isTauri()) return;
      listMonitors().then((list) => {
        if (list && list.length) { setMons(list); const prim = list.find((m) => m.is_primary) || list[0]; setMonIdx(prim.index); }
      }).catch(() => {});
      return () => { if (isTauri()) closePatternPlayer().catch(() => {}); };
    }, []);
    const mon = mons.find((m) => m.index === monIdx) || mons[0];
    const p = CAP_PLAYER;
    /* 1:1 自检基于当前选中显示器的真实物理分辨率 */
    const mismatch = winOpen && (p.pattern_width !== mon.width || p.pattern_height !== mon.height);
    const out = CAP_OUTPUT_STATES[output] || CAP_OUTPUT_STATES.black;
    const openWin = async () => {
      if (!isTauri()) { setWinOpen(true); return; }
      setBusy(true);
      try { await openPatternPlayer(monIdx); setWinOpen(true); s.pushLog && s.pushLog({ lv: 'ok', cat: 'capture', msg: `播放窗已在显示器 ${monIdx} 打开` }); }
      catch (e) { s.pushLog && s.pushLog({ lv: 'err', cat: 'capture', msg: `打开播放窗失败 · ${e && e.message ? e.message : e}` }); }
      finally { setBusy(false); }
    };
    const closeWin = async () => {
      if (isTauri()) { try { await closePatternPlayer(); } catch (e) {} }
      setWinOpen(false);
    };
    return h('div', { className: 'cap-player' },
      h('div', { className: 'cap-player-h' },
        h(Icon, { name: 'film', size: 15 }), '播放器控制段',
        h('span', { className: 'cap-player-sub' }, '反相双帧 / 图案播放'),
        h('div', { className: 'cap-player-out' },
          h('span', { className: 'cap-lbl' }, '当前输出'),
          h(Pill, { tone: out.tone, icon: output === 'black' ? 'moon' : output === 'inverted' ? 'flush' : 'eye' }, out.label))),
      h('div', { className: 'cap-player-row' },
        h(Selector, { kpre: '显示器', value: monIdx, width: 268,
          options: mons.map((m) => ({ id: m.index, label: `${m.index}: ${m.name || '显示器'}`, sub: `${m.width}×${m.height}${m.is_primary ? ' · 主屏' : ''}` })),
          onChange: setMonIdx }),
        winOpen
          ? h(Button, { variant: 'secondary', size: 'S', isDisabled: busy, icon: h(Icon, { name: 'x', size: 14 }), onPress: closeWin }, '关闭')
          : h(Button, { variant: 'primary', size: 'S', isDisabled: busy, icon: h(Icon, { name: 'play', size: 14 }), onPress: openWin }, '打开播放窗')),
      /* 1:1 分辨率自检 */
      winOpen ? (mismatch
        ? h('div', { className: 'cap-res-warn bad' }, h(Icon, { name: 'alert', size: 15 }),
            h('span', null, '图案 ', h('b', null, `${p.pattern_width}×${p.pattern_height}`), ' 与输出 ',
              h('b', null, `${mon.width}×${mon.height}`), ' 不一致，像素映射被破坏'))
        : h('div', { className: 'cap-res-warn ok' }, h(Icon, { name: 'check', size: 15 }),
            h('span', null, '1:1 像素映射（', `${mon.width}×${mon.height}`, '）'))) : null,
      winOpen && p.graycode_confirmed ? h('div', { className: 'cap-gray' },
        h(Icon, { name: 'check', size: 12 }), '图案序号已由画面确认（Gray code）') : null);
  }

  /* ============================= A2 · 采集态 ============================= */
  function CapturingView({ s, cfg, finish, abort, session, live }) {
    const [idx, setIdx] = useState(1);
    const [auto, setAuto] = useState(true);
    const [confirmAbort, setConfirmAbort] = useState(false);
    const timer = useRef(null);
    const target = +cfg.targetPoses;

    /* 演示态五态轮播（仅无真实 session 时） */
    useEffect(() => {
      if (live || !auto) { clearInterval(timer.current); return; }
      timer.current = setInterval(() => setIdx((i) => (i + 1) % CAP_STATES.length), 1700);
      return () => clearInterval(timer.current);
    }, [auto, live]);

    /* request_pattern → pattern_ready 回执（无 pattern 目录时放行，session 不挂起） */
    const handledSeq = useRef(new Set());
    useEffect(() => {
      if (!live) return;
      for (const ev of session.events) {
        if (ev.type !== 'request_pattern' || typeof ev.sequence !== 'number') continue;
        if (handledSeq.current.has(ev.sequence)) continue;
        handledSeq.current.add(ev.sequence);
        session.sendCmd({ cmd: 'pattern_ready', pattern: String(ev.pattern || 'normal') });
      }
    }, [live, session && session.events]);

    /* ---- 数据模型：真实 session 事件 vs 演示常量 ---- */
    let st, stateId, captured, cov, poses, warnings, previewUrl;
    if (live) {
      const progress = session.latest('progress') || {};
      stateId = progress.state || 'wait_tracking';
      st = CAP_STATES.find((x) => x.id === stateId) || CAP_STATES[0];
      captured = progress.poses_captured != null ? progress.poses_captured : 0;
      const c = session.latest('coverage_update');
      cov = c ? {
        sensor_grid: [],
        sensor_coverage_pct: Math.round((c.sensor_coverage_pct || 0) * 100),
        sensor_missing_regions: c.sensor_missing_regions || [],
        screen_markers_seen: c.screen_markers_seen || 0,
        screen_markers_total: c.screen_markers_total || 0,
        screen_coverage_pct: Math.round((c.screen_coverage_pct || 0) * 100),
        pose_spatial_spread_mm: c.pose_spatial_spread_mm || 0,
        suggestions: (c.suggestions || []).map((m) => ({ tone: 'notice', msg: m })),
      } : null;
      const seen = {};
      for (const ev of session.events) {
        if (ev.type === 'detect_feedback' && ev.pose_index != null) {
          const hits = ev.marker_hits || 0;
          seen[ev.pose_index] = { pose_index: ev.pose_index, marker_hits: hits, mean_confidence: ev.mean_confidence, differenced: ev.differenced != null ? ev.differenced : hits > 0 };
        }
      }
      poses = Object.keys(seen).map((k) => seen[k]).sort((a, b) => a.pose_index - b.pose_index);
      warnings = session.events.filter((e) => e.type === 'warning').map((w) => ({ t: '警告', msg: String(w.message || w.msg || '') }));
      const pr = session.latest('preview_ready');
      previewUrl = pr && pr.mjpeg_url;
    } else {
      st = CAP_STATES[idx]; stateId = st.id;
      cov = CAP_COVERAGE; poses = CAP_POSES; warnings = CAP_WARNINGS;
      captured = CAP_POSES.filter((p) => p.differenced).length; previewUrl = null;
    }
    const skipPose = () => { if (live) session.sendCmd({ cmd: 'skip_pose' }); else setIdx((i) => (i + 1) % CAP_STATES.length); };

    const output = stateId === 'capturing' ? (Math.round(Date.now() / 1700) % 2 ? 'inverted' : 'normal') : 'black';

    return h('div', { className: 'cap-a2' },
      /* 状态机大提示 */
      h('div', { className: 'cap-banner tone-' + st.tone + (st.pulse ? ' is-pulse' : '') },
        h('span', { className: 'cap-banner-ico' + (st.dir ? ' is-dir' : '') },
          st.pulse ? h('span', { className: 'cap-pulse-dot' }) : h(Icon, { name: st.icon, size: 30 })),
        h('div', { className: 'cap-banner-tx' },
          h('div', { className: 'cap-banner-t' }, st.label),
          h('div', { className: 'cap-banner-s' }, st.sub)),
        h('div', { className: 'cap-banner-prog' },
          h('span', { className: 'cap-prog-n' }, captured, ' / ', target),
          h('span', { className: 'cap-prog-l' }, 'pose 已采')),
        st.settle ? h('div', { className: 'cap-settle-ring' }) : null),
      h('div', { className: 'cap-body' },
        /* 左：预览 + 控制 + 播放器 */
        h('div', { className: 'cap-left' },
          h(PreviewMock, { state: stateId, url: previewUrl }),
          cfg.dualFrame ? h(PlayerSegment, { s, cfg, output }) : null,
          /* 警告条（滚动接收后端 warning） */
          warnings.length ? h('div', { className: 'cap-warnbar' },
            h(Icon, { name: 'alert', size: 14 }),
            h('div', { className: 'cap-warn-scroll' },
              warnings.map((w, i) => h('span', { key: i, className: 'cap-warn-i' },
                h('span', { className: 'cap-warn-t' }, w.t), w.msg)))) : null,
          h('div', { className: 'cap-controls' },
            h(Button, { variant: 'secondary', size: 'M', icon: h(Icon, { name: 'chevr', size: 14 }),
              onPress: skipPose }, '跳过当前 pose'),
            confirmAbort
              ? h('span', { className: 'cap-abort-confirm' }, '确认中止？',
                  h(Button, { variant: 'negative', size: 'S', onPress: abort }, '中止采集'),
                  h(Button, { variant: 'secondary', size: 'S', onPress: () => setConfirmAbort(false) }, '取消'))
              : h(Button, { variant: 'negative', size: 'M', icon: h(Icon, { name: 'x', size: 14 }),
                  onPress: () => setConfirmAbort(true) }, '中止'),
            h('div', { className: 'cap-controls-sp' }),
            h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'check', size: 15 }), onPress: finish }, '完成并组装')),
          /* 状态机五态：真实态由 progress.state 高亮（只读）；演示态可轮播 / 手点 */
          h('div', { className: 'cap-sm' },
            h('div', { className: 'cap-sm-h' },
              h('span', null, '状态机 · 五态' + (live ? ' · 实时' : '')),
              live ? null : h('button', { className: 'cap-sm-auto' + (auto ? ' on' : ''), onClick: () => setAuto((v) => !v) },
                h(Icon, { name: auto ? 'pause' : 'play', size: 12 }), auto ? '自动轮播' : '已暂停')),
            h('div', { className: 'cap-sm-track' },
              CAP_STATES.map((x, i) => h('button', { key: x.id, className: 'cap-sm-node tone-' + x.tone + ((live ? x.id === stateId : i === idx) ? ' on' : ''),
                onClick: () => { if (!live) { setAuto(false); setIdx(i); } } },
                h('span', { className: 'sdot bg-' + x.tone }),
                h('code', null, x.id)))))),
        /* 右：覆盖度 + pose 列表 */
        h('div', { className: 'cap-side cal-scroll' },
          h(CoverageCard, { cov }),
          h('div', { className: 'cap-poses' },
            h('div', { className: 'cap-poses-h' }, '已采 pose', h('span', { className: 'cap-poses-n' }, captured, ' / ', target)),
            (live && !poses.length) ? h('div', { style: { fontSize: 11.5, color: 'var(--chrome-faint)', padding: '6px 2px' } }, '等待首个 pose 检测反馈…') : null,
            poses.map((p) => {
              const bad = p.marker_hits === 0;
              return h('div', { key: p.pose_index, className: 'cap-pose' + (bad ? ' is-bad' : '') },
                h('span', { className: 'cap-pose-n' }, '#', p.pose_index),
                h('div', { className: 'cap-pose-m' },
                  h('span', { className: 'cap-pose-hit' + (bad ? ' bad' : '') }, p.marker_hits, ' 命中'),
                  h('span', { className: 'cap-pose-conf' }, p.mean_confidence != null ? (p.mean_confidence * 100).toFixed(0) + '%' : 'n/a')),
                bad
                  ? h(Pill, { tone: 'negative', icon: 'alert' }, '无命中')
                  : h(Pill, { tone: p.differenced ? 'positive' : 'notice', icon: p.differenced ? 'check' : 'alert' }, p.differenced ? '差分成功' : '未差分'));
            })))));
  }

  function CoverageCard({ cov }) {
    if (!cov) return h('div', { className: 'cap-cov' },
      h('div', { className: 'cap-cov-h' }, h(Icon, { name: 'grid', size: 15 }), '覆盖度'),
      h('div', { style: { fontSize: 11.5, color: 'var(--chrome-faint)', padding: '10px 2px' } }, '等待覆盖度反馈（每 pose 采集后更新）…'));
    return h('div', { className: 'cap-cov' },
      h('div', { className: 'cap-cov-h' }, h(Icon, { name: 'grid', size: 15 }), '覆盖度'),
      h('div', { className: 'cap-cov-body' },
        h('div', { className: 'cap-cov-grid' },
          cov.sensor_grid.map((row, r) => row.map((on, c) =>
            h('div', { key: r + '_' + c, className: 'cap-cov-cell' + (on ? ' on' : '') })))),
        h('div', { className: 'cap-cov-metrics' },
          h('div', { className: 'cap-cov-m' },
            h('span', { className: 'k' }, '画面覆盖'),
            h('span', { className: 'v' }, cov.sensor_coverage_pct, '%')),
          cov.sensor_missing_regions.length ? h('div', { className: 'cap-cov-miss' },
            h(Icon, { name: 'alert', size: 12 }), '缺：', cov.sensor_missing_regions.join('、')) : null,
          h('div', { className: 'cap-cov-m' },
            h('span', { className: 'k' }, '屏幕 marker'),
            h('span', { className: 'v' }, cov.screen_markers_seen, '/', cov.screen_markers_total,
              h('span', { className: 'u' }, ' (', cov.screen_coverage_pct, '%)'))),
          h('div', { className: 'cap-cov-m' },
            h('span', { className: 'k' }, 'pose 跨度'),
            h('span', { className: 'v mono' }, cov.pose_spatial_spread_mm, h('span', { className: 'u' }, ' mm'))))),
      h('div', { className: 'cap-cov-sug' },
        cov.suggestions.map((sg, i) => h('div', { key: i, className: 'cap-sug tone-' + sg.tone },
          h(Icon, { name: sg.tone === 'positive' ? 'check' : 'alert', size: 13 }), sg.msg))));
  }

  /* ============================= A3 · 完成态 ============================= */
  function DoneView({ s, cfg, resolve, solved, session }) {
    /* 真实会话 result 事件优先（data = {session_dir, poses_captured, lens_ready, marker_hits_total}） */
    const res = session && session.latest ? session.latest('result') : null;
    const rd = res && res.data ? res.data : null;
    const r = rd ? {
      poses_captured: rd.poses_captured, marker_total_hits: rd.marker_hits_total,
      session_dir: rd.session_dir, lens_ready: !!rd.lens_ready, rms: CAP_RESULT.rms,
    } : CAP_RESULT;
    const rmsBadge = (rms) => {
      if (rms == null) return h(Badge, { variant: 'neutral', size: 'S' }, 'n/a');
      const v = rms < 3 ? 'positive' : rms < 8 ? 'notice' : 'negative';
      return h(Badge, { variant: v, size: 'S' }, rms.toFixed(2) + ' mm');
    };
    return h('div', { className: 'cap-done cal-scroll' },
      h('div', { className: 'cap-done-hero' },
        h('span', { className: 'cap-done-badge' }, h(Icon, { name: 'check', size: 26 })),
        h('div', null,
          h('div', { className: 'cap-done-t' }, '采集完成 · ', r.poses_captured, ' 个 pose'),
          h('div', { className: 'cap-done-s' }, '会话已写入磁盘，可直接求解或后补 lens'))),
      h('div', { className: 'cap-done-grid' },
        h('div', { className: 'cap-card' },
          h('div', { className: 'cap-card-h' }, h(Icon, { name: 'list', size: 15 }), '结果摘要'),
          h('div', { className: 'cap-kv' }, h('span', null, 'poses_captured'), h('b', null, r.poses_captured)),
          h('div', { className: 'cap-kv' }, h('span', null, 'marker 总命中'), h('b', null, r.marker_total_hits)),
          h('div', { className: 'cap-kv' }, h('span', null, 'session_dir'), h('code', { className: 'cap-dir' }, r.session_dir)),
          h('div', { className: 'cap-kv' }, h('span', null, 'lens_ready'),
            r.lens_ready ? h(Pill, { tone: 'positive', icon: 'check' }, '就绪') : h(Pill, { tone: 'notice', icon: 'alert' }, '缺 lens'))),
        h('div', { className: 'cap-card' },
          h('div', { className: 'cap-card-h' }, h(Icon, { name: 'target', size: 15 }), '求解'),
          solved
            ? h(React.Fragment, null,
                h('div', { className: 'cap-solve-done' },
                  h('span', null, '求解完成 · RMS'), rmsBadge(r.rms)),
                h(InlineAlert, { variant: 'positive', title: '已求解' }, 'tracker→stage 变换已回填，可在 Lens 步查看完整报告。'))
            : r.lens_ready
              ? h(React.Fragment, null,
                  h('p', { className: 'cap-solve-p' }, 'lens profile 就绪，可直接求解。求解进度复用 Runs / 报告视图。'),
                  h(Button, { variant: 'accent', size: 'L', icon: h(Icon, { name: 'bolt', size: 16 }), onPress: resolve }, '立即求解'))
              : h(React.Fragment, null,
                  h(InlineAlert, { variant: 'notice', title: '缺 lens' }, '未提供 lens profile，无法直接求解。补齐后可在此触发。'),
                  h('div', { style: { marginTop: 10 } }, h(Button, { variant: 'accent', size: 'L', isDisabled: true }, '立即求解'))))),
      h('div', { className: 'cap-done-foot' },
        h(Button, { variant: 'secondary', size: 'M', icon: h(Icon, { name: 'sync', size: 14 }),
          onPress: () => s.setCalStep('capture') }, '重新采集')));
  }

  /* ============================= 步骤视图（router） ============================= */
  function CaptureView({ s }) {
    const persisted = (() => { try { return localStorage.getItem(LS) || 'config'; } catch (e) { return 'config'; } })();
    const [phase, setPhaseRaw] = useState(persisted);
    const [solved, setSolved] = useState(false);
    const [cfg, setCfg] = useState({
      videoBackend: 'uvc', deviceId: '0', trackProto: 'freed', udpPort: '6301', trackLink: 'connected',
      targetPoses: 8, dualFrame: true, lensProfile: null, screenPath: null, outDir: null,
      settleMs: 300, stillThresh: 4, moveThresh: 60, burst: 4, pairTol: 0.25,
    });
    const setPhase = (p) => { setPhaseRaw(p); try { localStorage.setItem(LS, p); } catch (e) {} };
    /* 真实采集数据层（复用 devCapture 的 useCaptureSession，NDJSON 流式）。
       浏览器 / 缺 screen·out 时走演示态。 */
    const session = useCaptureSession();
    const live = isTauri() && session.taskId !== null && session.state.exit === null;

    const start = () => {
      /* 真实路径：Tauri + screen.json + 输出目录齐备 → spawn vpcal capture session */
      if (isTauri() && cfg.screenPath && cfg.outDir) {
        s.setLogOpen && s.setLogOpen(true);
        s.pushLog && s.pushLog({ lv: 'info', cat: 'capture', msg: '实时采集会话启动 · vpcal capture session' });
        session.start({
          screenPath: cfg.screenPath, outDir: cfg.outDir, backend: cfg.videoBackend, device: String(cfg.deviceId),
          trackProtocol: cfg.trackProto === 'freed' ? 'freed' : 'opentrackio', trackPort: +cfg.udpPort || 6301,
          poses: +cfg.targetPoses || 8, inverted: !!cfg.dualFrame, graycodeSync: false,
          lensPath: cfg.lensProfile || '', settleMs: +cfg.settleMs || 300, burst: +cfg.burst || 5,
        });
        setPhase('capturing');
        return;
      }
      /* 演示态 */
      s.pushLogs([
        { lv: 'info', cat: 'capture', msg: '实时采集会话启动（演示）· backend <b>' + (CAP_VIDEO_BACKENDS.find((x) => x.id === cfg.videoBackend) || {}).label + '</b>' },
        { lv: 'ok', cat: 'capture', msg: '追踪流已连接 · 等待相机停稳' },
      ]); setPhase('capturing');
    };
    const finish = () => {
      if (live) { session.sendCmd({ cmd: 'finish' }); s.pushLog && s.pushLog({ lv: 'info', cat: 'capture', msg: '完成并组装 · 等待会话写盘' }); setSolved(false); setPhase('done'); return; }
      s.pushLog({ lv: 'ok', cat: 'capture', msg: '采集完成（演示）· <b>8</b> pose 已组装，marker 总命中 112' }); setSolved(false); setPhase('done');
    };
    const abort = () => {
      if (live) { session.cancel(); s.pushLog && s.pushLog({ lv: 'warn', cat: 'capture', msg: '采集已中止 · 已保存部分会话' }); setPhase('config'); return; }
      s.pushLog({ lv: 'warn', cat: 'capture', msg: '采集已中止（演示）· 已保存部分会话' }); setPhase('config');
    };
    const resolve = () => { s.pushLogs([
      { lv: 'info', cat: 'capture', msg: '触发求解 · ' + (cfg.lensProfile ? cfg.lensProfile.split(/[\\/]/).pop() : 'lens profile') },
      { lv: 'ok', cat: 'capture', msg: '求解收敛 · RMS <b>0.47 mm</b>（演示，接 Lens 步 quick run 求解）' },
    ]); setSolved(true); };

    const head = h('div', { className: 'canvas-head' },
      h('span', { className: 't' }, '实时采集'),
      h('span', { className: 'toolchip' }, h(Icon, { name: 'live', size: 14 }),
        phase === 'config' ? '配置' : phase === 'capturing' ? '采集中' : '已完成'),
      h('div', { className: 'right' },
        h('div', { className: 'cap-phase-seg' },
          [['config', '配置'], ['capturing', '采集'], ['done', '完成']].map(([k, l]) =>
            h('button', { key: k, className: phase === k ? 'on' : '', onClick: () => setPhase(k) }, l)))));

    return h('div', { className: 'cap-wrap' }, head,
      phase === 'config' ? h(ConfigView, { s, cfg, setCfg, start })
        : phase === 'capturing' ? h(CapturingView, { s, cfg, finish, abort, session, live })
        : h(DoneView, { s, cfg, resolve, solved, session }));
  }

  window.VOLO_CAL_CAPTURE = { CaptureView };
})();
