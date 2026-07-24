// @ts-nocheck
/* Volo — 固定机位 · 单次校正（VP-QSP）采集窗新增 UX 模块
   1:1 移植自 Claude Design handoff `cal2_qsp.jsx`（window.VOLO_QSP）；
   语义配套 Spec：vpqsp-fixed-single-observation §7。
   本模块只承载「追踪 = None（固定机位）」路径的新增/调整功能 UX：
     ① 采集目的（4 模式）② 结果五分区 report ③ AR 静帧门控 ④ attest 条 ⑤ fail-closed 指引 ⑥ 8 状态。
   窗口骨架 / 左侧实时信号 / 徽标体系沿用 calCalibFlow（drawer--lcwin / lc-* / VOLO_CALFLOW）。
   与 Design 演示稿的差异：.qsp-demo 演示切换已按 handoff 要求删除；qspState / arStage /
   五分区数据全部接真实 fixed_observation_result.v1 / stage_pose / 静帧验收（trackerFreeGrid）。 */
import * as React from "react";

(function () {
  const { Button } = window.Spectrum2DesignSystem_b6d1b3;
  const h = React.createElement;
  const CF = () => window.VOLO_CALFLOW || {};

  /* 追踪 None 时四选项：fixed / known_lens / joint_session / master_lens（对齐 as-built 字段） */
  const PURPOSES = [
    { id: 'fixed', name: '固定机位 · 单次校正', tag: '默认', tagAlt: false,
      qty: '1 observation（机位不动）',
      ctx: ['单次：', 'b:1 observation ≠ 1 marker ≠ 8 lens poses', '；无 Master Lens 时自动走 joint session lens'] },
    { id: 'known_lens', name: '使用 Master Lens · 只求外参', qty: '1 observation',
      ctx: ['known-lens：固定外参需求 ', 'b:qualified master lens', '；可导入或先建立 Master Lens'] },
    { id: 'joint_session', name: '自动估计当前镜头', qty: '1 observation',
      ctx: ['joint：', 'b:当前焦距/对焦/分辨率有效 · 非 Master Lens', '；需非共面 Stage geometry'] },
    { id: 'master_lens', name: '建立 Master Lens · 多姿态', tag: '独立流程', tagAlt: true,
      qty: '多姿态移动相机',
      ctx: ['master：Master Lens Capture · 保持 focus/zoom，', 'b:移动相机覆盖 ≥8 角度与画面边缘'] },
  ];

  /* 产品语义钉死文案（Spec §5） */
  const COPY = {
    measureBound: '1 observation ≠ 1 marker ≠ 8 lens poses',
    sessionLens: '当前焦距/对焦/分辨率有效 · 非 Master Lens',
    staticPass: 'Static validation · perimeter/grid 投影通过 · 可查看静帧 AR',
    unobsOrder: ['增加非共面 screen coverage', '改用 Structured Light', '导入 / 建立 Master Lens'],
  };

  const lensPhaseOf = (purpose, hasMaster) =>
    purpose === 'master_lens' ? 'master'
      : purpose === 'known_lens' ? 'known'
        : purpose === 'joint_session' ? 'joint'
          : (hasMaster ? 'known' : 'joint'); /* fixed（默认）：有档案→known，否则→joint（auto） */

  const ctxText = (parts) => parts.map((p, i) => p.indexOf('b:') === 0 ? h('b', { key: i }, p.slice(2)) : h('span', { key: i }, p));

  /* ---------- 数据格式化（真实 DTO；缺字段一律显示 —，不造值） ---------- */
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  const fmt = (v, d) => { const n = num(v); return n == null ? '—' : n.toFixed(d == null ? 2 : d); };
  const pct = (v) => { const n = num(v); return n == null ? '—' : Math.round(n * 100) + ' %'; };

  /* ============================================================
     采集目的（摄影机设置内 · 追踪 None 时显示）
     ============================================================ */
  function CapturePurpose(q) {
    const busy = q.qspState === 'capturing' || q.qspState === 'solving';
    if (q.tracked) {
      return h('div', { className: 'qsp-collapsed' }, h(Icon, { name: 'info', size: 14 }),
        h('span', null, '追踪机位不使用此采集目的 —— 位姿由追踪源实时给出，无需单次校正采集目的。'));
    }
    const cur = PURPOSES.find((p) => p.id === q.purpose) || PURPOSES[0];
    const mi = q.masterInfo || null;
    return h('div', { className: 'qsp-purpose' },
      h('div', { className: 'qsp-purpose-h' }, h(Icon, { name: 'pin', size: 14 }), 'Fixed-camera · 采集目的',
        h('span', { className: 'code' }, 'observation.purpose')),
      h('div', { className: 'qsp-purpose-sub' }, '固定机位一次采集动作得到可用 Stage pose。选采集目的决定本次求什么 —— 外参、session lens 还是 Master Lens。'),
      h('div', { className: 'qsp-modes' }, PURPOSES.map((p) => {
        const on = q.purpose === p.id;
        return h('button', { key: p.id, className: 'qsp-mode' + (on ? ' on' : '') + (busy ? ' is-disabled' : ''),
          onClick: () => { if (!busy) q.setPurpose(p.id); } },
          h('span', { className: 'qsp-mode-rad' }),
          h('div', { className: 'qsp-mode-m' },
            h('div', { className: 'qsp-mode-nrow' }, h('span', { className: 'qsp-mode-name' }, p.name),
              p.tag ? h('span', { className: 'qsp-mode-tag' + (p.tagAlt ? ' alt' : '') }, p.tag) : null),
            h('span', { className: 'qsp-mode-qty' }, p.qty)));
      })),
      h('div', { className: 'qsp-ctx' }, h(Icon, { name: 'info', size: 13 }), h('span', null, ctxText(cur.ctx))),
      /* 已有合格 Master Lens：一行摘要（真实档案） */
      q.hasMaster ? h('div', { className: 'qsp-master-sum' },
        h('span', { className: 'ic' }, h(Icon, { name: 'check', size: 14 })),
        h('div', { className: 'm' }, h('b', null, '已有合格 Master Lens'),
          h('span', null, 'Master lens · ' + (mi ? fmt(mi.rms, 2) : '—') + ' px · ' + (mi && mi.num_images != null ? mi.num_images : '—') + ' poses')),
        h('span', { className: 'cap-pill cap-pill--positive' }, 'qualified')) : null,
      /* 次级动作：导入 / 从 Multi-view 生成（busy 禁用；真实处理器） */
      h('div', { className: 'qsp-sec-actions' },
        h('button', { className: 'qsp-secbtn', disabled: busy || q.masterBusy, onClick: () => { if (!busy && !q.masterBusy) q.importMaster(); } },
          h(Icon, { name: 'download', size: 13 }), '导入 Master Lens'),
        h('button', { className: 'qsp-secbtn', disabled: busy || q.masterBusy, onClick: () => { if (!busy && !q.masterBusy) q.createMaster(); } },
          h(Icon, { name: 'layers', size: 13 }), '从 Multi-view 生成')));
  }

  /* ============================================================
     结果五分区（右栏 · 物理分隔卡片，禁止并成一张大表）
     ============================================================ */
  function rsec(idx, title, en, tag, body) {
    return h('div', { className: 'qsp-rsec', key: idx },
      h('div', { className: 'qsp-rsec-h' },
        h('span', { className: 'qsp-rsec-idx' }, idx),
        h('span', { className: 'qsp-rsec-t' }, title),
        h('span', { className: 'qsp-rsec-en' }, en),
        tag ? h('span', { className: 'qsp-rsec-tag' }, tag) : null),
      h('div', { className: 'qsp-rsec-b' }, body));
  }
  const metric = (k, v, u, tone) => h('div', { className: 'qsp-metric' + (tone ? ' ' + tone : ''), key: k },
    h('div', { className: 'k' }, k), h('div', { className: 'v' }, v, u ? h('span', { className: 'u' }, u) : null));
  const kv = (k, v, cls) => h('div', { className: 'qsp-kv', key: k }, h('span', { className: 'k' }, k), h('span', { className: 'v ' + (cls || '') }, v));
  const poseCell = (k, v) => h('div', { className: 'qsp-pose-cell', key: k }, h('span', { className: 'pk' }, k), h('span', { className: 'pv' }, v));

  /** 从 ladder 报告里取最后一次带自由焦距的 param_std / correlation。 */
  function ladderStats(fo) {
    const ladder = (fo && fo.validation && fo.validation.ladder) || [];
    let focalRel = null, k1Std = null, fDepthCorr = null;
    for (let i = ladder.length - 1; i >= 0; i--) {
      const rep = ladder[i] || {};
      const std = rep.param_std || {};
      if (k1Std == null && std.k1 != null) k1Std = num(std.k1);
      if (focalRel == null && std.f != null) {
        /* 相对 σ 需要焦距本值：session lens K[0][0] */
        const f = fo.session_lens && fo.session_lens.K ? num(fo.session_lens.K[0][0]) : null;
        if (f) focalRel = num(std.f) / f;
      }
      const corr = rep.correlation || {};
      for (const key of Object.keys(corr)) {
        const parts = key.split('|');
        if (parts.indexOf('f') >= 0 && (parts.indexOf('tz') >= 0 || parts.indexOf('tx') >= 0 || parts.indexOf('ty') >= 0)) {
          const v = Math.abs(num(corr[key]) || 0);
          if (fDepthCorr == null || v > fDepthCorr) fDepthCorr = v;
        }
      }
      if (focalRel != null && k1Std != null) break;
    }
    return { focalRel, k1Std, fDepthCorr };
  }

  function FiveReport(q) {
    const run = q.run || {};
    const sp = run.stagePose || {};
    const fo = run.fixedObservation || null;
    const warn = q.qspState === 'warn';
    const rms = num(sp.rms_reprojection_px != null ? sp.rms_reprojection_px : (fo && fo.rms_reprojection_px));
    const modeResolved = (fo && fo.mode_resolved) || sp.mode_resolved || (sp.solve_kind === 'fixed_extrinsics_only' ? 'known-lens' : 'joint-session-lens');
    const modeRequested = (fo && fo.mode_requested) || sp.mode_requested || q.modeRequested || 'auto';
    const known = modeResolved === 'known-lens';
    const coupled = !known;
    const formal = (fo ? fo.formal : sp.formal) === true
      && (((fo && fo.qualification) || sp.qualification || {}).passed === true);

    /* ① Detection */
    const det = (fo && fo.detection) || {};
    const perScreen = det.per_screen || {};
    const screenLabels = Object.keys(perScreen);
    const maxHits = screenLabels.reduce((m, k2) => Math.max(m, Number(perScreen[k2]) || 0), 0);
    const cov = Array.isArray(det.coverage_xy) ? Math.min(num(det.coverage_xy[0]) ?? 0, num(det.coverage_xy[1]) ?? 0) : null;
    const rejected = det.localization_rejected != null ? det.localization_rejected
      : (sp.rejected_observations ? sp.rejected_observations.localization_rejected : null);
    const brightness = det.brightness_warnings != null ? det.brightness_warnings
      : (sp.rejected_observations ? sp.rejected_observations.brightness_warning : null);
    const detSec = rsec(1, 'Detection', 'detection', CF().qualityLight ? CF().qualityLight(warn ? 'warn' : 'ok') : null,
      h(React.Fragment, null,
        h('div', { className: 'qsp-metrics c3' },
          metric('decoded', det.decoded != null ? det.decoded : '—'),
          metric('trustworthy', det.trustworthy != null ? det.trustworthy : '—', null, warn ? 'notice' : 'pos'),
          metric('localization rejected', rejected != null ? rejected : '—', null, warn ? 'neg' : null)),
        h('div', null,
          kv('coverage', cov != null ? pct(cov) : '—', warn ? 'notice' : 'pos'),
          kv('edge fraction', det.edge_fraction != null ? fmt(det.edge_fraction, 2) : '—', warn ? 'notice' : ''),
          kv('brightness warnings', brightness != null ? String(brightness) : '—', warn ? 'notice' : '')),
        screenLabels.length ? h(React.Fragment, null,
          h('div', { className: 'qsp-sublbl' }, 'per-screen 摘要'),
          h('div', { className: 'qsp-screens' },
            screenLabels.map((label) => screenBar(label, Number(perScreen[label]) || 0, maxHits, warn)))) : null));

    /* ② Geometry（放 geometry RMS，不放 Framing score） */
    const pf = (fo && fo.preflight) || sp.preflight || {};
    const hom = pf.homography_by_screen || {};
    const homLabels = Object.keys(hom);
    const joint = pf.joint_projective || null;
    const jointRms = joint ? num(joint.rms_px) : null;
    const pfPassed = pf.passed === true;
    const geoSec = rsec(2, 'Geometry', 'geometry', preflightPill(pfPassed && !warn),
      h(React.Fragment, null,
        homLabels.length ? h(React.Fragment, null,
          h('div', { className: 'qsp-sublbl' }, 'per-screen homography RMS'),
          h('div', { className: 'qsp-metrics' },
            homLabels.map((label) => metric(label, fmt(hom[label] && hom[label].rms_px, 2), 'px',
              num(hom[label] && hom[label].rms_px) != null && num(hom[label].rms_px) < 2 ? 'pos' : 'notice')))) : null,
        kv('joint projective preflight',
          joint ? ((pfPassed ? 'pass' : 'marginal') + (jointRms != null ? ' · RMS ' + jointRms.toFixed(2) + ' px' : ''))
            : (known ? 'known-lens · 由 inlier gates 覆盖' : '—'),
          pfPassed && !warn ? 'pos' : 'notice'),
        h('div', { className: 'qsp-capnote' }, known
          ? '内参来自 Master Lens（固定）· 几何一致性由 known-lens per-screen inlier gates 覆盖。'
          : (warn
            ? '各屏 homography 一致但整体偏高，联合投影 preflight 勉强通过 —— 建议补正面机位或改善对焦。'
            : '各屏 homography 一致，联合投影 preflight 通过。'))));

    /* ③ Lens observability */
    const obs = (fo && fo.observability) || {};
    const failedGates = obs.failed || [];
    const level = (fo && fo.model_level) || sp.model_level || null;
    const stats = fo ? ladderStats(fo) : { focalRel: null, k1Std: null, fDepthCorr: null };
    const m2On = level === 'M2_radial_pose' || level === 'M3_center_radial_pose';
    const m3On = level === 'M3_center_radial_pose';
    const ladder = known
      ? [{ id: 'M1', lb: '外参（6 DoF）', st: 'ok' }, { id: 'M2', lb: '焦距 + 主点 · 来自 Master Lens（固定）', st: 'ok' }, { id: 'M3', lb: '畸变 K1/K2 · 来自 Master Lens（固定）', st: 'ok' }]
      : [{ id: 'M1', lb: '外参（6 DoF）+ 焦距', st: 'ok' },
         { id: 'M2', lb: '畸变 K1/K2', st: m2On ? 'ok' : 'coupled' },
         { id: 'M3', lb: '主点 cx/cy', st: m3On ? 'ok' : 'coupled' }];
    const corrLocked = stats.fDepthCorr != null && stats.fDepthCorr > 0.9;
    const obsSec = rsec(3, 'Lens observability', 'observability', null,
      h(React.Fragment, null,
        h('div', { className: 'qsp-sublbl' }, '模型阶梯 M1 / M2 / M3' + (level ? ' · resolved ' + level : '')),
        h('div', { className: 'qsp-ladder' }, ladder.map((L) => h('div', { key: L.id, className: 'qsp-lstep st-' + L.st },
          h('span', { className: 'qsp-lstep-id' }, L.id),
          h('span', { className: 'qsp-lstep-lb' }, L.lb),
          h('span', { className: 'qsp-lstep-st' }, ladderPill(L.st))))),
        known
          ? h('div', { className: 'qsp-known-note' }, h(Icon, { name: 'check', size: 13 }),
              h('span', null, '内参来自 Master Lens（固定）· 本次只求外参。σ / correlation 不参与本次估计。'))
          : h(React.Fragment, null,
              h('div', null,
                kv('σ focal', stats.focalRel != null ? '±' + (stats.focalRel * 100).toFixed(1) + ' %' : '—', warn ? 'notice' : ''),
                kv('σ k1', stats.k1Std != null ? '±' + stats.k1Std.toFixed(4) : '—', warn ? 'notice' : ''),
                kv('correlation 锁回', stats.fDepthCorr != null
                  ? ('焦距↔深度 ' + stats.fDepthCorr.toFixed(2) + (corrLocked ? '（勉强锁回）' : '（已锁回）'))
                  : '—', corrLocked ? 'notice' : '')),
              h('div', { className: 'qsp-coupled' }, h(Icon, { name: 'info', size: 13 }),
                h('span', null, 'session_coupled → ', h('b', null, COPY.sessionLens)))),
        h('div', { className: 'qsp-failed-line' }, 'Lens observability · failed: ',
          failedGates.length ? h('span', { className: 'bad' }, failedGates.join(', ')) : h('span', { className: 'ok' }, '—（ok）'))));

    /* ④ Pose（以 mode_resolved 为准） */
    const cam = sp.camera_from_stage || (fo && fo.camera_from_stage) || {};
    const pos = cam.position_mm || [null, null, null];
    const ptr = cam.ptr_deg || null;
    const poseSec = rsec(4, 'Pose', 'camera_from_stage', CF().sourceTag ? CF().sourceTag('solve') : null,
      h(React.Fragment, null,
        h('div', { className: 'qsp-mode-resolved' },
          h('span', { className: 'qsp-mrpill primary' }, h(Icon, { name: 'target', size: 12 }), 'mode_resolved · ' + modeResolved),
          h('span', { className: 'qsp-mrreq' }, 'requested · ' + modeRequested),
          h('span', { className: 'spill spill--' + (formal && !warn ? 'positive' : 'notice') },
            h(Icon, { name: formal && !warn ? 'check' : 'alert', size: 12 }), formal && !warn ? 'formal' : 'experimental')),
        h('div', { className: 'qsp-sublbl' }, 'camera_from_stage · 位置 (mm)'),
        h('div', { className: 'qsp-pose-grid' }, poseCell('X', fmt(pos[0], 1)), poseCell('Y', fmt(pos[1], 1)), poseCell('Z', fmt(pos[2], 1))),
        h('div', { className: 'qsp-sublbl' }, '旋转 (°) · Pan / Tilt / Roll'),
        h('div', { className: 'qsp-pose-grid' },
          poseCell('Pan', ptr ? fmt(ptr.pan, 2) : '—'), poseCell('Tilt', ptr ? fmt(ptr.tilt, 2) : '—'), poseCell('Roll', ptr ? fmt(ptr.roll, 2) : '—')),
        coupled ? h('div', { className: 'qsp-capnote' }, '成功日志 · ', h('b', null, '固定机位单次校正' + (warn ? '（质量警告）' : '完成')),
          ' · mode=' + modeResolved + (rms != null ? ' · RMS ' + rms.toFixed(2) : '') + ' · ' + COPY.sessionLens) : null));

    /* ⑤ Static validation（Framing 单独子行 · 通过后才暗示 live） */
    const val = (fo && fo.validation) || {};
    const withheld = num(val.withheld_rms_px);
    const arStage = q.arStage;
    const gridState = arStage === 'passed' ? '过' : arStage === 'failed' ? '未过' : arStage === 'verifying' ? '验收中' : '待验收';
    const gridTone = arStage === 'passed' ? 'pos' : arStage === 'failed' ? 'neg' : null;
    const framing = run.framing && num(run.framing.score);
    const statSec = rsec(5, 'Static validation', 'static_validation', null,
      h(React.Fragment, null,
        h('div', { className: 'qsp-metrics c3' },
          metric('withheld RMS', withheld != null ? withheld.toFixed(2) : '—', withheld != null ? 'px' : null,
            withheld != null ? (withheld < 2 ? 'pos' : 'notice') : null),
          metric('perimeter', gridState, null, gridTone),
          metric('grid', gridState, null, gridTone)),
        known && withheld == null ? h('div', { className: 'qsp-capnote' }, 'known-lens 路径不做 withheld 校验（内参固定，仅求外参）。') : null,
        /* Framing score 单独子行（与 Geometry RMS 分属不同区） */
        h('div', { className: 'qsp-framing' + (framing != null && framing < 80 ? ' notice' : '') },
          h('div', { className: 'fk' }, h('b', null, 'Framing score'),
            h('span', { className: 'note' }, '取景构图评分 · 独立于 Geometry RMS，不并入总分')),
          h('div', { className: 'fv' }, framing != null ? Math.round(framing) : '—')),
        h('div', { className: 'qsp-static-cta' },
          arStage === 'failed'
            ? h('div', { className: 'qsp-coupled' }, h(Icon, { name: 'alert', size: 13 }),
                h('span', null, '静帧 perimeter/grid 投影未过' + (q.arError ? ' · ' + q.arError : '') + '。请先按 Geometry / Detection 建议补采后重新求解。'))
            : h(React.Fragment, null,
                h(Button, { variant: 'accent', size: 'M', isDisabled: arStage === 'verifying',
                  icon: h(Icon, { name: 'layers', size: 15 }), onPress: () => q.startArVerify() },
                  arStage === 'verifying' ? '静帧验收中…' : arStage === 'passed' ? '重新查看静帧 AR' : '查看静帧 AR'),
                h('div', { className: 'live-note' }, COPY.staticPass)))));

    return h('div', { className: 'qsp-report' },
      h('div', { className: 'qsp-report-concl ' + (warn ? 'warn' : 'ok') },
        h('span', { className: 'ic' }, h(Icon, { name: warn ? 'alert' : 'check', size: 20 })),
        h('div', { className: 'm' },
          h('div', { className: 't' }, warn ? '质量警告' : '固定机位单次校正完成'),
          h('div', { className: 'd' }, warn
            ? '偏高 RMS / 某屏偏弱 —— 位姿可用但精度受限，AR 静帧验收按 gate 未全开放。'
            : (coupled ? ('mode=' + modeResolved + ' · ' + COPY.sessionLens) : ('mode=' + modeResolved + ' · 外参已求解，内参来自 Master Lens')))),
        rms != null ? h('span', { className: 'cap-pill cap-pill--' + (warn ? 'notice' : 'positive') + ' is-lg' },
          h(Icon, { name: warn ? 'alert' : 'check', size: 13 }), 'RMS ' + rms.toFixed(2) + ' px') : null),
      detSec, geoSec, obsSec, poseSec, statSec);
  }
  function screenBar(name, hits, maxHits, warn) {
    const p = maxHits > 0 ? Math.round(hits / maxHits * 100) : 0;
    return h('div', { key: name },
      h('div', { className: 'qsp-screen-top' }, h('span', { className: 'qsp-screen-n' }, name),
        h('span', { className: 'qsp-screen-v' }, hits + ' trustworthy')),
      h('div', { className: 'qsp-screen-bar' + (warn && p < 80 ? ' notice' : '') }, h('i', { style: { width: p + '%' } })));
  }
  function preflightPill(ok) {
    return h('span', { className: 'spill spill--' + (ok ? 'positive' : 'notice') }, h(Icon, { name: ok ? 'check' : 'alert', size: 12 }), ok ? 'preflight pass' : 'preflight marginal');
  }
  function ladderPill(st) {
    if (st === 'ok') return h('span', { className: 'cap-pill cap-pill--positive' }, h(Icon, { name: 'check', size: 11 }), 'ok');
    if (st === 'coupled') return h('span', { className: 'cap-pill cap-pill--notice' }, h(Icon, { name: 'alert', size: 11 }), 'coupled');
    return h('span', { className: 'cap-pill cap-pill--negative' }, h(Icon, { name: 'x', size: 11 }), 'failed');
  }

  /* ============================================================
     fail-closed / unobservable / stale 指引（禁止默认内参绕过）
     ============================================================ */
  /* 检测 / 定位类共用的补采建议（画面越大、对焦越准、反光越少，可信点越多） */
  const FAIL_STEPS_DETECT = [
    { t: '靠近或正对可信点不足的屏', d: '让该屏在画面里占更大区域，提升可信检测点数量。' },
    { t: '检查对焦 / 亮度 / 对比度', d: '确保 marker 清晰、曝光正常，避免定位被丢弃。' },
    { t: '避免强反光后重采', d: '消除屏幕反光 / 眩光，再重新采集并求解。' },
  ];
  const FAIL_STEPS_GEOM = [
    { t: '确认各屏上屏部署与屏幕定义一致', d: '排查屏幕错位 / 换屏，保证几何与定义匹配。' },
    { t: '补正面机位或改善对焦', d: '降低联合投影 RMS，让各屏几何一致。' },
    { t: '检查屏幕布局是否变动后重采', d: '布局变化会使联合投影不一致，需重新采集求解。' },
  ];
  const FAIL_COPY = {
    DETECTION_QUALITY_FAILED: { t: '检测质量不足', steps: FAIL_STEPS_DETECT },
    LOCALIZATION_QUALITY_FAILED: { t: '定位质量不足', steps: FAIL_STEPS_DETECT },
    SCREEN_GEOMETRY_INCONSISTENT: { t: '几何不一致', steps: FAIL_STEPS_GEOM },
    MASTER_LENS_REQUIRED: { t: 'Master Lens 缺失 / 不合格', steps: 'master' },
  };
  /* per-screen 条形（分母 = 门限；hits<need 标 notice 并注明「差 N」） */
  function failScreenRow(label, hits, need) {
    const short = hits < need;
    const p = need > 0 ? Math.min(100, Math.round(hits / need * 100)) : 0;
    return h('div', { key: label },
      h('div', { className: 'qsp-screen-top' }, h('span', { className: 'qsp-screen-n' }, label),
        h('span', { className: 'qsp-screen-v' }, hits + ' / ' + need + ' trustworthy' + (short ? '（差 ' + (need - hits) + '）' : ''))),
      h('div', { className: 'qsp-screen-bar' + (short ? ' notice' : '') }, h('i', { style: { width: p + '%' } })));
  }
  function FailPanel(q) {
    if (q.qspState === 'stale') return StalePanel(q);
    const fail = q.failInfo || {};
    const unobs = q.qspState === 'unobservable';
    const code = fail.code || null;
    const copy = (!unobs && code) ? FAIL_COPY[code] : null;
    const details = (fail.details && typeof fail.details === 'object') ? fail.details : {};

    /* 结构化细节（仅当 details 有对应字段；不硬造后端没说的数） */
    let structured = null;
    if (!unobs && code === 'DETECTION_QUALITY_FAILED' && details.per_screen && typeof details.per_screen === 'object') {
      const perScreen = details.per_screen;
      const m = />=\s*(\d+)/.exec(String(fail.message || ''));
      const need = num(details.min_per_screen) != null ? num(details.min_per_screen) : (m ? Number(m[1]) : 12);
      const labels = Object.keys(perScreen);
      let totalHits = 0;
      const rows = labels.map((label) => { const hits = Number(perScreen[label]) || 0; totalHits += hits; return failScreenRow(label, hits, need); });
      const totalNeed = num(details.min_total) != null ? num(details.min_total) : 60;
      structured = h(React.Fragment, null,
        h('div', { className: 'qsp-sublbl' }, 'per-screen 可信检测点 / 门限'),
        h('div', { className: 'qsp-screens' }, rows,
          labels.length ? failScreenRow('合计', totalHits, totalNeed) : null));
    } else if (!unobs && code === 'SCREEN_GEOMETRY_INCONSISTENT'
        && details.joint_projective && num(details.joint_projective.rms_px) != null) {
      structured = h('div', null, kv('joint projective RMS', num(details.joint_projective.rms_px).toFixed(2) + ' px', 'neg'));
    }

    /* 建议列表（unobs / 检测·定位 / 几何 → 步骤；Master Lens → 内联导入按钮；未知 code → 无） */
    let stepsNode = null;
    if (unobs) {
      stepsNode = h('div', null,
        h('div', { className: 'qsp-noheader', style: { marginBottom: 8 } }, '推荐动作顺序（可执行）'),
        h('div', { className: 'qsp-steps' }, COPY.unobsOrder.map((t, i) => h('div', { key: i, className: 'qsp-step' },
          h('span', { className: 'qsp-step-n' }, i + 1),
          h('div', { className: 'qsp-step-m' },
            h('div', { className: 'qsp-step-t' }, t),
            i === 0 ? h('div', { className: 'qsp-step-d' }, '把额外屏幕纳入取景，制造非共面 Stage geometry —— 最直接的解法。')
              : i === 1 ? h('div', { className: 'qsp-step-d' }, '改用 Structured Light 提供更强的逐点约束。')
                : h('div', { className: 'qsp-step-d' }, '导入或先建立 Master Lens，固定内参后本次只求外参。',
                    h('div', { className: 'btn-inline' }, h(Button, { variant: 'secondary', size: 'S', isDisabled: q.masterBusy,
                      icon: h(Icon, { name: 'download', size: 13 }),
                      onPress: () => { q.setPurpose('known_lens'); q.importMaster(); q.recapture(); } }, '导入 Master Lens'))))))));
    } else if (copy && copy.steps === 'master') {
      stepsNode = h('div', null,
        h('div', { className: 'qsp-noheader', style: { marginBottom: 8 } }, '推荐动作'),
        h('div', { className: 'qsp-steps' }, h('div', { className: 'qsp-step' },
          h('span', { className: 'qsp-step-n' }, 1),
          h('div', { className: 'qsp-step-m' },
            h('div', { className: 'qsp-step-t' }, '导入或先建立 Master Lens'),
            h('div', { className: 'qsp-step-d' }, '固定内参后本次只求外参。',
              h('div', { className: 'btn-inline' }, h(Button, { variant: 'secondary', size: 'S', isDisabled: q.masterBusy,
                icon: h(Icon, { name: 'download', size: 13 }),
                onPress: () => { q.setPurpose('known_lens'); q.importMaster(); q.recapture(); } }, '导入 Master Lens')))))));
    } else if (copy && Array.isArray(copy.steps)) {
      stepsNode = h('div', null,
        h('div', { className: 'qsp-noheader', style: { marginBottom: 8 } }, '推荐动作顺序（可执行）'),
        h('div', { className: 'qsp-steps' }, copy.steps.map((st, i) => h('div', { key: i, className: 'qsp-step' },
          h('span', { className: 'qsp-step-n' }, i + 1),
          h('div', { className: 'qsp-step-m' },
            h('div', { className: 'qsp-step-t' }, st.t),
            h('div', { className: 'qsp-step-d' }, st.d))))));
    }

    return h('div', { className: 'qsp-fail' },
      h('div', { className: 'qsp-fail-h' },
        h('span', { className: 'ic' }, h(Icon, { name: 'x', size: 18 })),
        h('div', { className: 'm' },
          h('div', { className: 't' }, unobs ? '单视图不可观测' : (copy ? copy.t : '固定机位求解失败')),
          h('div', { className: 'code' }, unobs ? 'SINGLE_VIEW_UNOBSERVABLE' : (fail.code || 'SOLVE_FAILED')))),
      h('div', { className: 'qsp-fail-b' },
        h('div', { className: 'qsp-fail-d' }, unobs
          ? h(React.Fragment, null, '单个观测无法同时约束 ', h('b', null, '外参 + 镜头'), ' —— 当前 Stage geometry 近共面，焦距与深度不可分。禁止默认内参绕过，请按下列顺序处理：')
          : h(React.Fragment, null, h('b', null, copy ? copy.t : '求解失败'),
              '：', fail.message || '本次单视图无法唯一求解位姿。', ' 已 ', h('b', null, 'fail-closed'), '，未写入任何默认焦距 / 畸变。')),
        structured,
        stepsNode,
        fail.message && unobs ? h('div', { className: 'qsp-capnote' }, fail.message) : null,
        h('div', { className: 'qsp-fail-guard' }, h(Icon, { name: 'info', size: 12 }),
          h('span', null, '已 fail-closed：不提供「忽略并继续 / 默认 50mm」等绕过项。'))));
  }
  function StalePanel(q) {
    return h('div', { className: 'qsp-stale' },
      h('div', { className: 'qsp-stale-h' },
        h('span', { className: 'ic' }, h(Icon, { name: 'alert', size: 18 })),
        h('div', null, h('div', { className: 'qsp-stale-t' }, 'Stage pose fingerprint stale'),
          h('div', { className: 'd' }, '机读 fingerprint / 几何已变')),
        h('span', { className: 'cap-pill cap-pill--notice is-lg', style: { marginLeft: 'auto' } }, 'stale')),
      h('div', { className: 'qsp-stale-b' },
        '当前 Stage pose 的 ', h('span', { className: 'mono' }, 'fingerprint'), ' 与最近一次求解不一致 —— 屏幕布局或相机几何可能已变动。已停止复用旧结果，', h('b', null, '请重新采集'), '。focus / zoom 是否变动需你确认（见下方 attest）。'));
  }

  /* ============================================================
     attest 条（复用 session lens 前 · 确认对焦/变焦未变）
     ============================================================ */
  function AttestBar(q) {
    return h('div', { className: 'qsp-attest' },
      h('div', { className: 'qsp-attest-h' }, h('span', { className: 'ic' }, h(Icon, { name: 'target', size: 16 })),
        h('span', { className: 't' }, '确认对焦 / 变焦未变')),
      h('div', { className: 'qsp-attest-d' }, '将复用上次的 ', h('b', null, 'session lens'), '（', COPY.sessionLens, '）。系统 ',
        h('b', null, '不会自动检测'), ' focus / zoom 是否变动 —— 需你确认自上次求解以来镜头对焦、变焦未动。'),
      h('div', { className: 'qsp-attest-acts' },
        h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'check', size: 15 }), onPress: () => q.confirmAttest() }, '对焦/变焦未变，继续'),
        h(Button, { variant: 'secondary', size: 'M', icon: h(Icon, { name: 'sync', size: 15 }), onPress: () => q.recapture() }, '重新采集')));
  }

  /* ============================================================
     右栏组装（config groups + 结果区 by qspState）
     ============================================================ */
  function side(q) {
    const grp = CF().grp, MethodOptions = CF().MethodOptions;
    if (!grp || !MethodOptions) return null;
    /* 结果区：随 qspState 切换（替代采集记录 / 汇总区） */
    let result;
    if (q.qspState === 'formal_ok' || q.qspState === 'warn') result = FiveReport(q);
    else if (q.qspState === 'fail_closed' || q.qspState === 'unobservable' || q.qspState === 'stale') result = FailPanel(q);
    else if (q.qspState === 'attest') result = AttestBar(q);
    else if (q.qspState === 'capturing') result = h('div', { className: 'cap-card' },
      h('div', { className: 'cap-card-h' }, h(Icon, { name: 'camera', size: 15 }), '本次采集',
        h('span', { className: 'spill spill--notice', style: { marginLeft: 'auto' } }, h(Icon, { name: 'camera', size: 12 }), '采集中')),
      h('div', { className: 'qsp-capnote' }, q.lensPhase === 'master'
        ? h(React.Fragment, null, h('b', null, 'Master Lens Capture · 多姿态'), '：保持 focus / zoom，移动相机覆盖 ≥8 角度与画面边缘。本阶段不求 Stage 位姿。')
        : h(React.Fragment, null, h('b', null, 'REC · 固定机位单帧采集'), '：机位静止，短 burst 去噪（不计多姿态）。', COPY.measureBound, '。')));
    else if (q.qspState === 'solving') result = h('div', { className: 'cap-card' },
      h('div', { className: 'cap-card-h' }, h('span', { className: 'ag-spin' }, h(Icon, { name: 'sync', size: 15 })), '求解中',
        h('span', { className: 'spill spill--informative', style: { marginLeft: 'auto' } }, '固定机位 · 单次校正')),
      h('div', { className: 'ag-indet' }, h('div', { className: 'ag-indet-bar' })),
      h('div', { className: 'qsp-capnote', style: { marginTop: 9 } }, 'mode=' + q.modeRequested + '（请求值）· 求解外参' + (q.lensPhase === 'joint' ? ' + joint session lens' : '') + '…'));
    else result = h('div', { className: 'cap-card' }, /* idle */
      h('div', { className: 'cap-card-h' }, h(Icon, { name: 'target', size: 15 }), '本次采集',
        h('span', { className: 'spill spill--neutral', style: { marginLeft: 'auto' } }, h('span', { style: { fontWeight: 800 } }, '—'), '待采集')),
      h('div', { className: 'qsp-capnote' }, '待采集 · 固定机位（单次校正）。选好采集目的后点底部「开始采集」，一次采集动作即得可用 Stage pose。'));

    return h('div', { className: 'lc-side' },
      grp('mopt', 'grid', '校正方式', q.open.mopt, () => q.tgl('mopt'), h(MethodOptions, { s: q.s })),
      grp('general', 'sliders', '常规设置', q.open.general, () => q.tgl('general'), ...(q.generalBody || [])),
      /* 摄影机设置（重点）：相机 + 追踪信号 + 采集目的 + 参数 */
      grp('camera', 'camera', '摄影机设置', q.open.camera, () => q.tgl('camera'),
        q.camChips, q.trackField,
        /* 采集目的（追踪 None 时显示；有追踪折叠一行说明） */
        h(CapturePurpose, q),
        h('div', { style: { marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--chrome-line)' } }, q.cameraParams)),
      /* 结果区（求解后五分区 / 失败指引 / attest；替代采集记录） */
      h('div', { className: 'lc-grp' }, h('div', { className: 'lc-grp-b', style: { paddingTop: 6 } }, result)));
  }

  /* ============================================================
     底部主动作条（主按钮随 lensPhase / qspState 变；AR 入口不抢主动作）
     ============================================================ */
  function actionbar(q) {
    const st = q.qspState;
    const reasons = q.reasons || [];
    const canStart = q.ready && !reasons.length;
    const solved = st === 'formal_ok' || st === 'warn';
    const failed = st === 'fail_closed' || st === 'unobservable' || st === 'stale';

    /* AR 入口：下拉式二级浮层（透明度可调）。求解可用（formal_ok/warn）才解锁验收 + 滑块。 */
    const arEnabled = solved;
    const op = q.qspArOpacity == null ? 72 : q.qspArOpacity;
    const panelOpen = !!q.qspArPanelOpen;
    const arFailed = q.arStage === 'failed';
    const pillCls = q.arStage === 'passed' ? 'cap-pill--positive'
      : arFailed ? 'cap-pill--negative'
        : arEnabled ? 'cap-pill--informative' : 'cap-pill--neutral';
    const pillIcon = q.arStage === 'passed' ? 'check' : q.arStage === 'verifying' ? 'sync' : arFailed ? 'x' : 'layers';
    const pillText = q.arStage === 'passed' ? '已通过' : q.arStage === 'verifying' ? '验收中'
      : arFailed ? '未通过' : arEnabled ? '未开始' : '锁定';
    const arPanel = h('div', { className: 'lc-arpanel qsp-arpanel' },
      h('div', { className: 'lc-arpanel-row' },
        h('span', { className: 'lc-arpanel-lb' }, '静帧叠加验证'),
        h('span', { className: 'cap-pill ' + pillCls }, h(Icon, { name: pillIcon, size: 12 }), pillText)),
      !arEnabled
        ? h('div', { className: 'lc-arhud-locked' }, h(Icon, { name: 'info', size: 12 }),
            h('span', null, '无可用求解 · 请先完成固定机位单次校正求解，再叠加静帧验证'))
        : h(React.Fragment, null,
            arFailed
              ? h('div', { className: 'lc-arhud-locked' }, h(Icon, { name: 'alert', size: 12 }),
                  h('span', null, '静帧 perimeter/grid 投影未过' + (q.arError ? ' · ' + q.arError : '') + '。请按 Geometry / Detection 建议补采后重新求解。'))
              : q.arStage === 'idle'
                ? h('button', { className: 'qsp-arbtn on', style: { width: '100%', justifyContent: 'center', padding: '7px 12px' }, onClick: () => q.startArVerify() },
                    h(Icon, { name: 'layers', size: 14 }), '运行静帧验收')
                : null,
            h('div', { className: 'lc-arhud-op' + (q.arStage === 'idle' || arFailed ? ' is-off' : '') },
              h('span', { className: 'lc-arhud-op-k' }, '透明度'),
              h('input', { className: 'lc-ar-range', type: 'range', min: 0, max: 100, value: op, disabled: q.arStage === 'idle' || arFailed,
                style: { '--pct': op + '%' }, onChange: (e) => q.setQspArOpacity && q.setQspArOpacity(+e.target.value) }),
              h('span', { className: 'lc-arhud-op-v mono' }, op + '%')),
            arFailed ? null : h('div', { className: 'lc-arhud-locked', style: { color: 'var(--chrome-faint)' } }, h(Icon, { name: 'info', size: 12 }),
              h('span', null, '在同一静帧上叠加 perimeter / grid 投影 · 拖动可调整叠加透明度复核对齐'))));
    const arBtn = h('div', { className: 'lc-arwrap', ref: q.qspArBtnRef },
      h('button', { className: 'qsp-arbtn' + (q.arStage !== 'idle' && arEnabled ? ' on' : '') + (panelOpen ? ' open' : ''),
        onClick: () => q.setQspArPanelOpen && q.setQspArPanelOpen((v) => !v) },
        h(Icon, { name: 'layers', size: 15 }), 'AR 叠加验证',
        h(Icon, { name: 'chevu', size: 12 })),
      panelOpen ? arPanel : null);

    /* 主动作 */
    let main;
    if (st === 'capturing') {
      main = h('div', { className: 'lc-start', style: { flex: 'none', width: 'auto' } },
        h(Button, { variant: 'negative', size: 'L', icon: h(Icon, { name: 'x', size: 16 }), onPress: () => q.stop() }, '停止采集'));
    } else if (st === 'solving') {
      main = h(Button, { variant: 'accent', size: 'L', isDisabled: true, icon: h('span', { className: 'ag-spin' }, h(Icon, { name: 'sync', size: 16 })) }, '求解中…');
    } else if (solved || failed || st === 'attest') {
      main = h(Button, { variant: 'secondary', size: 'L', icon: h(Icon, { name: 'sync', size: 16 }), onPress: () => q.recapture() }, '重新采集');
    } else { /* idle */
      const label = q.lensPhase === 'master' ? ('开始镜头采集 · ' + q.targetM + ' Poses') : '开始采集';
      main = h(Button, { variant: 'accent', size: 'L',
        icon: q.preparing ? h('span', { className: 'ag-spin' }, h(Icon, { name: 'sync', size: 16 })) : h(Icon, { name: 'camera', size: 16 }),
        isDisabled: !canStart || q.preparing || q.starting, onPress: () => q.start() },
        q.preparing ? '生成图案中…' : q.starting ? '正在启动…' : label);
    }

    /* 就绪 / 待补（随 lensPhase 变，勿写死「必须使用已知镜头」） */
    let hint = null;
    if (st === 'idle') {
      if (!canStart) {
        const shown = reasons.length ? reasons : [{ t: '前置检查未通过 · 屏幕定义 / 校正图案生成中' }];
        hint = h('div', { className: 'lc-reasons' },
          shown.map((r, i) => h('span', { key: i, className: 'lc-reason' }, h(Icon, { name: 'info', size: 12 }), r.t)),
          shown.some((r) => r.jump === 'deploy') ? h('button', { className: 'flow-back', style: { padding: '3px 9px' }, onClick: () => q.deployJump() }, '去上屏部署') : null);
      } else {
        const phaseNote = q.lensPhase === 'master' ? '本阶段不求 Stage 位姿'
          : q.lensPhase === 'known' ? '使用 Master Lens · 只求外参'
            : '无 Master Lens · 自动 joint session lens';
        const ready = q.lensPhase === 'master' ? '前置就绪 · Master Lens Capture（多姿态）' : '前置就绪 · 固定机位（单次采集）';
        hint = h('div', { className: 'qsp-ready' }, h(Icon, { name: 'check', size: 13 }), ready, h('span', { className: 'phase' }, '· ' + phaseNote));
      }
    } else if (st === 'capturing') {
      hint = h('div', { className: 'lc-prog' }, h('span', { className: 'lc-prog-n' }, q.lensPhase === 'master'
        ? h(React.Fragment, null, 'pose ' + q.capN + ' ', h('span', { className: 'm' }, '/ ' + q.targetM))
        : h(React.Fragment, null, 'REC ', h('span', { className: 'm' }, '· 固定机位单帧采集'))));
    } else if (solved) {
      hint = h('div', { className: 'qsp-ready' }, h(Icon, { name: 'check', size: 13 }), st === 'warn' ? '已求解（质量警告）· 见右栏五分区' : '固定机位单次校正完成 · 见右栏五分区');
    }

    return h('div', { className: 'lc-actionbar' + (st === 'capturing' ? ' capturing' : '') }, main, hint, h('span', { className: 'sp' }), arBtn);
  }

  /* ============================================================
     左侧现场画面覆盖层：状态横幅 / 求解遮罩 / 静帧 AR 门控
     （真实 AR 网格 canvas 由 CaptureWindow 的 AROverlay 渲染，本层只加门控 UI）
     ============================================================ */
  const BANNERS = {
    idle: { tone: 'info', text: '待采集 · 固定机位', dot: false },
    capturing: { tone: 'neg', text: 'REC · 固定机位单帧采集', dot: true },
    solving: { tone: 'info', text: '固定机位 · 单次校正 · 求解中…', dot: true },
    formal_ok: { tone: 'pos', text: '固定机位单次校正完成', dot: false },
    warn: { tone: 'notice', text: '质量警告', dot: false },
    fail_closed: { tone: 'neg', text: '固定机位求解失败', dot: false },
    unobservable: { tone: 'neg', text: '单视图不可观测', dot: false },
    stale: { tone: 'notice', text: 'Stage pose fingerprint stale', dot: false },
    attest: { tone: 'info', text: '确认对焦 / 变焦未变', dot: false },
  };
  function leftOverlays(q) {
    const st = q.qspState;
    const b = BANNERS[st] || BANNERS.idle;
    const solved = st === 'formal_ok' || st === 'warn';
    const banner = st === 'capturing' && q.lensPhase === 'master'
      ? { tone: 'neg', text: 'REC · Master Lens 多姿态采集', dot: true } : b;
    return h(React.Fragment, null,
      /* 状态横幅（顶部居中） */
      h('div', { className: 'qsp-statebanner ' + banner.tone },
        banner.dot ? h('span', { className: 'dot pulse' })
          : h(Icon, { name: st === 'formal_ok' ? 'check' : st === 'warn' || st === 'stale' ? 'alert' : st === 'fail_closed' || st === 'unobservable' ? 'x' : 'target', size: 12 }),
        banner.text),
      /* 求解中遮罩 */
      st === 'solving' ? h('div', { className: 'qsp-solving' },
        h('span', { className: 'qsp-solving-spin' }),
        h('div', { className: 'qsp-solving-t' }, '固定机位 · 单次校正 · 求解中…'),
        h('div', { className: 'qsp-solving-d' }, 'mode=' + q.modeRequested + '（请求值）')) : null,
      /* 静帧 AR 门控浮条 */
      solved && q.arStage === 'verifying' ? h('div', { className: 'qsp-argate verifying' },
        h('span', { className: 'ic' }, h(Icon, { name: 'sync', size: 14 })),
        h('div', { className: 'm' }, h('div', { className: 't' }, '静帧验收中…', h('span', { className: 'qsp-verify-dots' }, h('i'), h('i'), h('i'))), h('div', { className: 'd' }, '在同一静帧验收 perimeter / grid 投影'))) : null,
      solved && q.arStage === 'passed' ? h('div', { className: 'qsp-argate passed' },
        h('span', { className: 'ic' }, h(Icon, { name: 'check', size: 14 })),
        h('div', { className: 'm' }, h('div', { className: 't' }, '静帧 perimeter 通过'), h('div', { className: 'd' }, 'perimeter / grid 投影通过 · AR 叠加已呈现在实时画面'))) : null);
  }

  window.VOLO_QSP = { CapturePurpose, FiveReport, FailPanel, AttestBar, side, actionbar, leftOverlays, lensPhaseOf, PURPOSES, COPY };
})();
