// @ts-nocheck
/* Volo — 校正 · AR 工具页 ①–④
   真值导入与检查 / 镜头与内参（后端待接） / 空间求解 / 延迟校准。
   1:1 port of the Claude Design handoff `src/cal2_ar_pages.jsx`, wired to real vpcal
   （argv 与结果字段核实自 sidecars/vpcal/src/vpcal/cli/{marker_map,quick,capture}.py
   与 docs/design/CALIBRATE-UX.md §4.3/§4.4/§4.5/§4.6）。共享原子/store 见 calAr.tsx。 */
import * as React from "react";
import "../ds";
import { pickFile, pickDirectory, revealPath } from "../api/commands";
import { spawnSidecar } from "../api/sidecarStream";

(function () {
  const { useState, useEffect } = React;
  const h = React.createElement;

  /* =================== ① 真值导入与检查 =================== */
  function LevelDialog({ s, close }) {
    const AR = window.VOLO_CAL_AR;
    const { Button } = window.Spectrum2DesignSystem_b6d1b3;
    const ws = AR.useArWorkspace();
    const vp = AR.useVpcalRun();
    const mapPath = ws.markerMapPath;
    const G = ws.lastValidate && ws.lastValidate.ground_plane;
    const newPath = mapPath ? mapPath.replace(/\.json$/i, '') + '_leveled.json' : null;

    useEffect(() => {
      if (vp.data) s.pushLog({ lv: 'ok', cat: 'ar', msg: '已校平到地面 · 写出 <b>' + AR.baseName(vp.data.output) + '</b>' });
    }, [vp.data]);
    useEffect(() => { if (vp.err) s.pushLog({ lv: 'err', cat: 'ar', msg: '校平失败 · ' + vp.err.msg }); }, [vp.err]);

    const run = () => {
      s.pushLog({ lv: 'info', cat: 'ar', msg: '校平到地面 · <b>vpcal marker-map rebase --to-ground</b>' });
      vp.run(['marker-map', 'rebase', mapPath, '--to-ground', '--out', newPath]);
    };
    const useAsWorkspace = () => {
      /* setArPath 本身会清空 lastValidate（描述的是旧 map），逼一次对新文件的重新校验 */
      AR.setArPath('markermap', vp.data.output);
      s.pushLog({ lv: 'ok', cat: 'ar', msg: '已设为当前工作区 map · <b>' + AR.baseName(vp.data.output) + '</b>' });
      close();
    };
    const done = !!vp.data;
    return h('div', { className: 'drawer drawer--cal2cap' },
      h('div', { className: 'drawer-h' },
        h('span', { className: 'di info' }, h(Icon, { name: 'ruler', size: 17 })),
        h('div', { style: { minWidth: 0 } }, h('h2', null, '校平到地面'), h('div', { className: 'sub' }, h('span', { className: 'cli-pill' }, 'marker-map rebase --to-ground'))),
        h('button', { className: 'iconbtn x', onClick: close }, h(Icon, { name: 'x', size: 16 }))),
      h('div', { className: 'drawer-b' },
        vp.err ? h('div', { className: 'ar-degen ar-degen--negative', style: { marginBottom: 12 } },
          h(Icon, { name: 'alert', size: 15 }), h('div', null, h('b', null, '校平失败'), h('div', { className: 'ar-degen-d' }, vp.err.msg))) : null,
        done
          ? h('div', { className: 'ar-lvl-done' },
              h('div', { className: 'ar-ok-note', style: { marginTop: 0 } }, h(Icon, { name: 'check', size: 14 }),
                '已将地面平面旋转对齐到 z=0' + (vp.data.audit ? '，倾斜 ' + G.tilt_from_z_deg.toFixed(2) + '° → ' + vp.data.audit.tilt_corrected_deg.toFixed(2) + '°' : '')),
              h('div', { className: 'cal2-prod', style: { margin: '13px 0 0' } },
                h('span', { className: 'cal2-prod-ic' }, h(Icon, { name: 'doc', size: 14 })),
                h('div', { className: 'cal2-prod-m' }, h('div', { className: 'cal2-prod-f' }, AR.baseName(vp.data.output)), h('div', { className: 'cal2-prod-d' }, AR.dirName(vp.data.output))),
                h('button', { className: 'cal2-folderbtn', onClick: () => revealPath(AR.dirName(vp.data.output)).catch(() => {}) }, h(Icon, { name: 'external', size: 13 }), '打开文件夹')))
          : h(React.Fragment, null,
              h('p', { className: 'cap-solve-p', style: { marginBottom: 12 } },
                G ? h(React.Fragment, null, '当前 marker map 相对地面倾斜 ', h('b', null, G.tilt_from_z_deg.toFixed(2) + '°'), '，超出容差 ', h('b', null, G.tolerance_deg.toFixed(2) + '°'), '。') : null,
                '校平会把地面平面旋转对齐到 z=0，并写出一份新的 map 文件（不修改原文件）：'),
              h('div', { className: 'ar-copyrow', style: { marginTop: 0 } }, h('code', null, newPath)))),
      h('div', { className: 'drawer-f' },
        h(Button, { variant: 'secondary', size: 'M', onPress: close }, done ? '关闭' : '取消'),
        done
          ? h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'check', size: 15 }), onPress: useAsWorkspace }, '设为当前工作区 map')
          : h(Button, { variant: 'accent', size: 'M', isDisabled: vp.running, icon: h(Icon, { name: 'ruler', size: 15 }), onPress: run }, vp.running ? '校平中…' : '校平到地面')));
  }

  function GenTool({ s, kind }) {
    const AR = window.VOLO_CAL_AR;
    const { Button } = window.Spectrum2DesignSystem_b6d1b3;
    const [dir, setDir] = useState(null);
    const [files, setFiles] = useState(null);
    const [busy, setBusy] = useState(false);
    const meta = kind === 'board'
      ? { icon: 'grid', title: '生成打印板', sub: 'AprilTag 36h11 · ids 0–11' }
      : { icon: 'cube', title: '生成立方体', sub: 'AprilTag 36h11 · 边长 300 mm' };
    const pickDir = async () => { const d = await pickDirectory().catch(() => null); if (d) setDir(d); };
    const gen = async () => {
      let outDir = dir;
      if (!outDir) { outDir = await pickDirectory().catch(() => null); if (!outDir) return; setDir(outDir); }
      setBusy(true);
      const argv = kind === 'board'
        ? ['marker-map', 'board', '--dict', 'DICT_APRILTAG_36h11', '--ids', '0-11', '--out-dir', outDir]
        : ['marker-map', 'cube', '--dict', 'DICT_APRILTAG_36h11', '--out-dir', outDir];
      s.pushLog({ lv: 'info', cat: 'ar', msg: meta.title + ' · <b>vpcal marker-map ' + kind + '</b>' });
      try {
        const out = await spawnSidecar('vpcal', argv.concat(['--output', 'json']));
        const env = AR.parseEnvelope(out);
        if (env && env.status === 'error') throw new Error(env.error && env.error.message);
        const rd = env && env.data;
        const fileList = kind === 'board'
          ? (rd.boards || []).concat(rd.survey_template ? [rd.survey_template] : [])
          : (rd.faces || []).concat(rd.marker_map ? [rd.marker_map] : []);
        setFiles(fileList.map((f) => AR.baseName(f)));
        s.pushLog({ lv: 'ok', cat: 'ar', msg: kind === 'board'
          ? `打印板生成 · ${(rd.boards || []).length} 板 + survey_template.csv`
          : `立方体生成 · ${(rd.faces || []).length} 面 + cube_map.json` });
      } catch (e) {
        s.pushLog({ lv: 'err', cat: 'ar', msg: meta.title + '失败 · ' + (e && e.message ? e.message : e) });
      } finally { setBusy(false); }
    };
    return h('div', { className: 'ar-card' },
      h('div', { className: 'ar-card-h' }, h(Icon, { name: meta.icon, size: 15 }), meta.title,
        h('span', { style: { marginLeft: 'auto', fontSize: 11, color: 'var(--chrome-faint)', fontWeight: 500, fontFamily: 'var(--font-code)' } }, meta.sub)),
      h('div', { className: 'cap-field', style: { marginBottom: 12 } },
        h('span', { className: 'cap-lbl' }, '输出'),
        h('button', { className: 'cap-file-btn', onClick: pickDir }, h(Icon, { name: 'folder', size: 14 }), dir ? AR.baseName(dir) : '选择输出目录')),
      files ? h('div', { className: 'ar-genfiles' }, files.map((f, i) => h('div', { key: i, className: 'ar-genfile' },
        h(Icon, { name: /\.csv|\.json/.test(f) ? 'doc' : 'film', size: 13 }), h('span', { className: 'ar-genfile-n' }, f)))) : null,
      h('div', { style: { marginTop: 13, display: 'flex', gap: 9, alignItems: 'center' } },
        h(Button, { variant: 'secondary', size: 'S', isDisabled: busy, icon: h(Icon, { name: 'download', size: 14 }), onPress: gen }, busy ? '生成中…' : '生成'),
        dir ? h('button', { className: 'cal2-folderbtn', onClick: () => revealPath(dir).catch(() => {}) }, h(Icon, { name: 'external', size: 13 }), '打开文件夹') : null));
  }

  function Markers({ s }) {
    const AR = window.VOLO_CAL_AR;
    const { Button, Badge } = window.Spectrum2DesignSystem_b6d1b3;
    const ws = AR.useArWorkspace();
    const vp = AR.useVpcalRun();

    useEffect(() => {
      if (!vp.data) return;
      AR.arStore.setRunning('markers', false);
      AR.arStore.patch({ lastValidate: vp.data });
      const val = vp.data.validation, wa = vp.data.world_alignment;
      s.pushLog({ lv: 'ok', cat: 'ar', msg: `真值校验完成 · ${val.num_markers} markers · ${val.num_detectable} 可检测 · 世界对齐 <b>${wa.grade}</b>` });
    }, [vp.data]);
    useEffect(() => {
      if (!vp.err) return;
      AR.arStore.setRunning('markers', false);
      s.pushLog({ lv: 'err', cat: 'ar', msg: '真值校验失败 · ' + vp.err.msg });
    }, [vp.err]);

    const runCheck = async () => {
      let mp = ws.markerMapPath;
      if (!mp) { mp = await AR.pickArPath('markermap', ['json'], 'marker map JSON'); if (!mp) return; }
      AR.arStore.setRunning('markers', true);
      s.setLogOpen(true);
      s.pushLog({ lv: 'info', cat: 'ar', msg: `真值校验 · <b>vpcal marker-map validate</b> · ${AR.baseName(mp)}` });
      vp.run(['marker-map', 'validate', mp]);
    };
    const openLevel = () => s.setModal({ render: ({ close }) => h(LevelDialog, { s, close }) });

    const D = ws.lastValidate, val = D && D.validation, G = D && D.ground_plane;
    const over = !!(G && G.available && G.tolerance_deg != null && G.tilt_from_z_deg != null && G.tilt_from_z_deg > G.tolerance_deg);

    return h(AR.Page, {
      title: '真值导入与检查',
      chip: h(React.Fragment, null, h(Icon, { name: 'pin', size: 14 }), 'marker map · AprilTag 36h11'),
      right: h(Button, { variant: 'accent', size: 'S', isDisabled: vp.running, icon: h(Icon, { name: 'shield', size: 14 }), onPress: runCheck }, vp.running ? '校验中…' : '运行校验'),
    },
      h('div', { className: 'cal2-imp-bar' },
        h('div', { className: 'cal2-imp-l' }, h(Icon, { name: 'pin', size: 15 }),
          h('span', null, '当前 marker map'),
          ws.markerMapPath ? h('code', null, AR.baseName(ws.markerMapPath)) : h('span', { className: 'dim' }, '未设置'),
          h('button', { className: 'cal2-folderbtn', onClick: () => AR.pickArPath('markermap', ['json'], 'marker map JSON') },
            h(Icon, { name: 'folder', size: 13 }), ws.markerMapPath ? '更换' : '选择')),
        D ? AR.gradeBadge(D.world_alignment.grade) : null),
      vp.err ? h('div', { className: 'ar-degen ar-degen--negative' }, h(Icon, { name: 'alert', size: 15 }),
        h('div', null, h('b', null, '校验失败'), h('div', { className: 'ar-degen-d' }, vp.err.msg))) : null,
      !D
        ? h('div', { className: 'cluster-empty', style: { marginTop: 4 } },
            h('div', { className: 'ce-ico' }, h(Icon, { name: 'pin', size: 34, stroke: 1.3 })),
            h('div', { className: 'ce-t' }, '尚未校验真值'),
            h('div', { className: 'ce-d' }, '选择 marker map（全站仪实测 CSV 生成，或用下方工具生成打印板 / 立方体），运行校验查看世界对齐等级与地面平面。'))
        : h(React.Fragment, null,
            h('div', { className: 'ar-card' },
              h('div', { className: 'ar-card-h' }, h(Icon, { name: 'shield', size: 15 }), '校验结果', h('span', { style: { marginLeft: 'auto' } }, AR.gradeBadge(D.world_alignment.grade))),
              h('div', { className: 'ar-det' },
                AR.gm('num_markers', val.num_markers, true),
                AR.gm('num_detectable', val.num_detectable, true),
                AR.gm('num_ground_markers', val.num_ground_markers, true),
                AR.gm('span_mm', val.span_mm.toLocaleString(), true),
                AR.gm('collinearity_ratio', val.collinearity_ratio.toFixed(2), true),
                AR.gm('warnings', val.warnings.length, true)),
              val.warnings.length ? h('div', { className: 'ar-warnlist' }, val.warnings.map((w, i) =>
                h('div', { key: i, className: 'ar-warn-i' }, h(Icon, { name: 'alert', size: 13 }), w))) : null),
            h('div', { className: 'ar-card' + (over ? ' ar-card--hl' : '') },
              h('div', { className: 'ar-card-h' }, h(Icon, { name: 'ruler', size: 15 }), '地面平面',
                h('span', { style: { marginLeft: 'auto' } }, h(Badge, { variant: G.available ? 'positive' : 'neutral', size: 'S' }, G.available ? 'available' : 'n/a'))),
              G.available
                ? h(React.Fragment, null,
                    h('div', { className: 'ar-ground' },
                      AR.gm('residual_rms_mm', G.residual_rms_mm.toFixed(2), true),
                      AR.gm('tilt_from_z_deg', h('span', { className: over ? 's-negative' : '' }, G.tilt_from_z_deg.toFixed(2) + '°'), true),
                      AR.gm('offset_from_z0_mm', G.offset_from_z0_mm.toFixed(2), true),
                      AR.gm('tolerance_deg', G.tolerance_deg.toFixed(2) + '°', true)),
                    over
                      ? h('div', { className: 'ar-level-bar' },
                          h('div', { className: 'ar-inline-warn', style: { marginTop: 0 } }, h(Icon, { name: 'alert', size: 14 }),
                            '地面倾斜 ' + G.tilt_from_z_deg.toFixed(2) + '° 超出容差 ' + G.tolerance_deg.toFixed(2) + '°'),
                          h(Button, { variant: 'secondary', size: 'S', icon: h(Icon, { name: 'ruler', size: 14 }), onPress: openLevel }, '校平到地面'))
                      : h('div', { className: 'ar-ok-note' }, h(Icon, { name: 'check', size: 14 }), '地面平面在容差内'))
                : h('div', { style: { fontSize: 12, color: 'var(--chrome-faint)' } }, '该 marker map 没有可用于拟合地面平面的地面 marker。'))),
      h('div', { className: 'cal2-subh', style: { marginTop: 4 } }, '生成工具'),
      h('div', { className: 'ar-entry' }, h(GenTool, { s, kind: 'board' }), h(GenTool, { s, kind: 'cube' })));
  }

  /* =================== ② 镜头与内参（整页后端待接） =================== */
  function Lens() {
    const AR = window.VOLO_CAL_AR;
    const { Button } = window.Spectrum2DesignSystem_b6d1b3;
    return h('div', { className: 'cal2-page' },
      h('div', { className: 'canvas-head' },
        h('span', { className: 't' }, '镜头与内参'),
        h('span', { className: 'toolchip' }, h(Icon, { name: 'camera', size: 14 }), 'vpcal lens'),
        h('div', { className: 'right' }, h('span', { className: 'ar-wip-badge' }, h(Icon, { name: 'info', size: 12 }), '后端待接'))),
      h('div', { className: 'cal2-hintbar' }, h(Icon, { name: 'info', size: 14 }), '功能待接后端 — 该页展示目标形态；求解内参需接入 ', h('code', null, 'vpcal lens'), ' 后端。'),
      h('div', { className: 'dash', style: { paddingTop: 14 } },
        h('div', { className: 'ar-card' },
          h('div', { className: 'ar-card-h' }, h(Icon, { name: 'camera', size: 15 }), '当前 session · 内参来源'),
          h('div', { className: 'ar-det', style: { gridTemplateColumns: '1fr 1fr' } },
            AR.gm('intrinsics_source', '未接线'),
            AR.gm('lens_profile', '未提供 · 未引用可复用镜头档案'))),
        h('div', { className: 'ar-card' },
          h('div', { className: 'ar-card-h' }, h(Icon, { name: 'info', size: 15 }), 'QLE 与可复用镜头档案'),
          h('p', { className: 'cap-solve-p', style: { margin: 0 } },
            'QLE（Quick Lens Estimate）在空间求解时随本次 session 一起估计镜头内参，只对该 session 有效、不落盘复用；可复用镜头档案（lens profile）是一次独立标定得到的持久内参，可跨 session 引用、避免每次重估。')),
        h('div', { className: 'ar-card' },
          h('div', { className: 'ar-card-h' }, h(Icon, { name: 'target', size: 15 }), '求解内参'),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 } },
            h(Button, { variant: 'accent', size: 'M', isDisabled: true, icon: h(Icon, { name: 'target', size: 15 }) }, '求解内参'),
            h('span', { className: 'ar-wip-badge' }, h(Icon, { name: 'info', size: 12 }), '后端待接')),
          h('div', { className: 'cal2-wip', style: { opacity: 1 } },
            h('span', { className: 'cal2-wip-ic' }, h(Icon, { name: 'camera', size: 15 })),
            h('div', { className: 'cal2-wip-m' },
              h('div', { className: 'cal2-wip-t' }, '结果留位'),
              h('div', { className: 'cal2-wip-d' }, '该功能待接 vpcal lens — 求解后此处显示内参矩阵 / 畸变系数 / 重投影 RMS。')),
            h('span', { className: 'nav-tag' }, 'WIP')))));
  }

  /* =================== ③ 空间求解 =================== */
  function ConfRing({ pct, tone }) {
    const col = tone === 'positive' ? 'var(--positive-visual)' : tone === 'notice' ? 'var(--notice-visual)' : 'var(--negative-visual)';
    return h('span', { className: 'ar-conf-ring', style: { background: 'conic-gradient(' + col + ' ' + (pct * 3.6) + 'deg, var(--track) 0)' } }, h('span', null, pct + '%'));
  }
  /* exit_code 语义（sidecars/vpcal/docs/exit-codes.md）：9=partial（观测不足），
     6=precondition（空间求解场景下常见为旋转多样性不足）。同 calLens.tsx 的
     classifySolveFailure 判定风格，不固定成唯一文案（具体原因取 err.msg）。 */
  function classifySpatialFailure(err) {
    if (!err) return null;
    if (err.exitCode === 9) return { tone: 'negative', title: '观测不足（partial）', msg: err.msg };
    if (err.exitCode === 6) return { tone: 'notice', title: '前置条件未满足（常见为旋转多样性不足）', msg: err.msg };
    return { tone: 'negative', title: '求解失败', msg: err.msg };
  }
  function Spatial({ s }) {
    const AR = window.VOLO_CAL_AR;
    const { Button, Badge } = window.Spectrum2DesignSystem_b6d1b3;
    const ws = AR.useArWorkspace();
    const vp = AR.useVpcalRun();

    useEffect(() => {
      if (!vp.data) return;
      AR.arStore.setRunning('spatial', false);
      AR.arStore.patch({ lastSpatial: vp.data });
      const q = vp.data.result.quality;
      /* partial（观测不足）不走异常路径——run_operation 的成功 envelope 固定
         status:'ok'，vpcal 把 exit_code=9 塞进 data.exit_code 这个业务字段里，
         不是顶层字段，也不会被 useVpcalRun 分流进 vp.err（那条判定只看 envelope
         的 status）。之前这里只看 status，partial 结果被当全量成功，四张结果卡的
         退化告警条永远不会为 partial 亮起——按 data.exit_code 补一次判定。 */
      if (vp.data.exit_code === 9) {
        s.pushLog({ lv: 'warn', cat: 'ar', msg: '空间求解完成（partial · 观测不足）· validation_rms <b>' + (q.validation_rms_px != null ? q.validation_rms_px.toFixed(2) : 'n/a') + ' px</b>' });
      } else {
        s.pushLog({ lv: 'ok', cat: 'ar', msg: '空间求解完成 · validation_rms <b>' + (q.validation_rms_px != null ? q.validation_rms_px.toFixed(2) : 'n/a') + ' px</b> · confidence ' + q.confidence });
      }
    }, [vp.data]);
    useEffect(() => {
      if (!vp.err) return;
      AR.arStore.setRunning('spatial', false);
      const c = classifySpatialFailure(vp.err);
      s.pushLog({ lv: 'err', cat: 'ar', msg: '空间求解失败 · ' + c.title + (vp.err.exitCode != null ? ' · exit ' + vp.err.exitCode : '') });
    }, [vp.err]);

    const run = () => {
      if (!ws.sessionPath) return;
      AR.arStore.setRunning('spatial', true);
      s.setLogOpen(true);
      s.pushLog({ lv: 'info', cat: 'ar', msg: '空间求解 · <b>vpcal quick run</b>（使用工作区 session）' });
      vp.run(['quick', 'run', '--config', ws.sessionPath, '--per-marker']);
    };

    const SP = ws.lastSpatial, q = SP && SP.result.quality, qa = SP && SP.qa;
    const cover = qa && qa.coverage && qa.coverage.marker_coverage;
    /* marker_coverage.percentage 是后端 0–1 fraction（qa/coverage.py），不是 0–100；
       ConfRing 的 conic-gradient（pct*3.6deg）和三通道阈值都按 0–100 设计，这里换算一次。 */
    const covPct = cover ? Math.round(cover.percentage * 100) : 0;
    const covTone = covPct >= 85 ? 'positive' : covPct >= 60 ? 'notice' : 'negative';
    /* partial（data.exit_code=9）不经过 vp.err，得从落地的结果本身补判一次；
       真正的硬失败（进程异常退出 / envelope status:'error'，如旋转多样性不足的
       precondition 报错）仍然走 vp.err，两条来源互斥（同一次结果不会同时命中）。 */
    const failure = (SP && SP.exit_code === 9)
      ? classifySpatialFailure({ exitCode: 9, msg: '有效观测低于最小阈值（成功 pose 过少），本次结果仍已写入但精度置信度较低，建议补采更多机位后重试。' })
      : classifySpatialFailure(vp.err);

    return h(AR.Page, {
      title: '空间求解',
      chip: h(React.Fragment, null, h(Icon, { name: 'cube', size: 14 }), 'tracker → world · hand-eye'),
      right: h(React.Fragment, null,
        q ? AR.pxBadge(q.validation_rms_px) : null,
        h(Button, { variant: 'accent', size: 'S', isDisabled: vp.running || !ws.sessionPath, icon: h(Icon, { name: 'target', size: 14 }), onPress: run },
          q ? '重新求解' : vp.running ? '求解中…' : '开始求解')),
    },
      !ws.sessionPath ? h('div', { className: 'cal2-reason', style: { position: 'static', width: 'fit-content' } }, h(Icon, { name: 'info', size: 12 }), '工作区 session 未设置，无法求解') : null,
      vp.running
        ? h('div', { className: 'cal2-progbox' },
            h('div', { className: 'cal2-prog-top' }, h('span', { className: 'cal2-prog-stage' }, 'bundle adjustment · 迭代中'), h('span', { className: 'cal2-prog-pct' }, '进行中'),
              h('button', { className: 'cal2-prog-cancel', onClick: () => { vp.cancel(); AR.arStore.setRunning('spatial', false); } }, h(Icon, { name: 'x', size: 11 }), '取消')),
            h('div', { className: 'vmeter vmeter--accent ar-indeterminate' }, h('div', { className: 'vmeter__fill' })),
            h('div', { className: 'cal2-prog-log' }, '优化外参与 hand-eye，请稍候…'))
        : !q
          ? h('div', { className: 'cluster-empty', style: { marginTop: 4 } },
              h('div', { className: 'ce-ico' }, h(Icon, { name: 'cube', size: 34, stroke: 1.3 })),
              h('div', { className: 'ce-t', style: { fontSize: 17 } }, '尚未求解'),
              h('div', { className: 'ce-d' }, '使用工作区 session，检测 marker → 光束法平差 → hand-eye 求解相机到世界的外参。'),
              h('div', { className: 'ce-acts' }, h(Button, { variant: 'accent', size: 'L', isDisabled: !ws.sessionPath, icon: h(Icon, { name: 'target', size: 16 }), onPress: run }, '开始求解')))
          : h(React.Fragment, null,
              failure ? h('div', { className: 'ar-degen ar-degen--' + failure.tone },
                h(Icon, { name: 'alert', size: 15 }),
                h('div', null, h('b', null, failure.title), h('div', { className: 'ar-degen-d' }, failure.msg))) : null,
              h('div', { className: 'ar-entry' },
                h('div', { className: 'ar-card' },
                  h('div', { className: 'ar-card-h' }, h(Icon, { name: 'pulse', size: 15 }), '质量', h('span', { style: { marginLeft: 'auto' } }, AR.confBadge(q.confidence))),
                  h('div', { className: 'ar-det' },
                    AR.gm('reprojection_rms_px', q.reprojection_rms_px.toFixed(2), true),
                    AR.gm('validation_rms_px', q.validation_rms_px != null ? q.validation_rms_px.toFixed(2) : 'n/a', true),
                    AR.gm('num_poses', q.num_poses, true),
                    AR.gm('total_observations', q.total_observations.toLocaleString(), true),
                    AR.gm('inlier_observations', q.inlier_observations.toLocaleString(), true),
                    AR.gm('outliers', q.total_observations - q.inlier_observations, true))),
                h('div', { className: 'ar-card' },
                  h('div', { className: 'ar-card-h' }, h(Icon, { name: 'search', size: 15 }), '检测'),
                  h('div', { className: 'ar-det', style: { gridTemplateColumns: '1fr 1fr' } },
                    AR.gm('detected_markers', qa.detection.detected_markers, true),
                    AR.gm('unknown_markers', qa.detection.unknown_markers, true)),
                  h('div', { className: 'ar-never' }, h('span', { className: 'dim', style: { color: 'var(--chrome-faint)' } }, 'map_markers_never_detected'),
                    (qa.detection.map_markers_never_detected || []).map((id) => h('span', { key: id, className: 'ar-chip ar-miss' }, 'id ' + id)))),
                h('div', { className: 'ar-card' },
                  h('div', { className: 'ar-card-h' }, h(Icon, { name: 'link', size: 15 }), 'hand-eye',
                    h('span', { style: { marginLeft: 'auto' } }, h(Badge, { variant: qa.handeye.applied ? 'positive' : 'neutral', size: 'S' }, qa.handeye.applied ? 'applied' : 'skipped'))),
                  h('div', { className: 'ar-det' },
                    AR.gm('axis_spread', qa.handeye.axis_spread.toFixed(2), true),
                    AR.gm('prior_translation_diff_mm', qa.handeye.prior_translation_diff_mm != null ? qa.handeye.prior_translation_diff_mm.toFixed(1) : 'n/a', true),
                    AR.gm('prior_rotation_diff_deg', qa.handeye.prior_rotation_diff_deg != null ? qa.handeye.prior_rotation_diff_deg.toFixed(1) : 'n/a', true))),
                h('div', { className: 'ar-card' },
                  h('div', { className: 'ar-card-h' }, h(Icon, { name: 'target', size: 15 }), '覆盖'),
                  h('div', { className: 'ar-cov' },
                    h(ConfRing, { pct: covPct, tone: covTone }),
                    h('div', { className: 'ar-cov-m' },
                      h('div', { className: 'ar-cov-k' }, 'marker_coverage.percentage'),
                      h('div', { className: 'ar-never', style: { marginTop: 6 } }, h('span', { style: { color: 'var(--chrome-faint)' } }, 'missing'),
                        (cover && cover.missing || []).map((m) => h('span', { key: m, className: 'ar-chip ar-miss' }, m)))))))));
  }

  /* =================== ④ 延迟校准 =================== */
  function ConfRingDelay({ pct }) {
    return h('span', { className: 'ar-conf-ring', style: { background: 'conic-gradient(var(--positive-visual) ' + (pct * 3.6) + 'deg, var(--track) 0)' } }, h('span', null, pct + '%'));
  }
  function Delay({ s }) {
    const AR = window.VOLO_CAL_AR;
    const { Button } = window.Spectrum2DesignSystem_b6d1b3;
    const ws = AR.useArWorkspace();
    const vp = AR.useVpcalRun();
    const [resultPath, setResultPath] = useState(null);
    const [videoDir, setVideoDir] = useState(null);
    const [trackingPath, setTrackingPath] = useState(null);
    const [copied, setCopied] = useState(false);

    useEffect(() => {
      if (!vp.data) return;
      AR.arStore.setRunning('delay', false);
      AR.arStore.patch({ lastDelay: vp.data });
      const cam = vp.data.cameras[0];
      s.pushLog({ lv: 'ok', cat: 'ar', msg: '延迟校准完成 · delay <b>+' + (cam ? cam.delay_ms.toFixed(1) : 'n/a') + ' ms</b>' + (cam ? ' ± ' + cam.sigma_ms.toFixed(1) : '') });
    }, [vp.data]);
    useEffect(() => {
      if (!vp.err) return;
      AR.arStore.setRunning('delay', false);
      s.pushLog({ lv: 'err', cat: 'ar', msg: '延迟校准失败 · ' + (vp.err.exitCode === 6 ? '运动不足（exit 6）' : vp.err.msg) });
    }, [vp.err]);

    const run = async () => {
      if (!ws.sessionPath) return;
      let rp = resultPath, vd = videoDir, tp = trackingPath;
      if (!rp) { rp = await pickFile('quick run 输出 result.json', ['json']).catch(() => null); if (!rp) return; setResultPath(rp); }
      if (!vd) { vd = await pickDirectory().catch(() => null); if (!vd) return; setVideoDir(vd); }
      if (!tp) { tp = await pickFile('tracking poses (jsonl)', ['jsonl', 'json']).catch(() => null); if (!tp) return; setTrackingPath(tp); }
      AR.arStore.setRunning('delay', true);
      s.setLogOpen(true);
      s.pushLog({ lv: 'info', cat: 'ar', msg: '延迟校准 · <b>vpcal capture delay-cal</b>（tracking × video 互相关）' });
      vp.run(['capture', 'delay-cal', '--config', ws.sessionPath, '--result', rp, '--video', vd, '--tracking', tp]);
    };

    const D = ws.lastDelay, cam = D && D.cameras[0];
    const motionLow = vp.err && vp.err.exitCode === 6;
    const copy = () => {
      if (!D || !D.recommendation) return;
      if (navigator.clipboard) navigator.clipboard.writeText(D.recommendation).catch(() => {});
      setCopied(true); setTimeout(() => setCopied(false), 1500);
    };
    const inputRow = (lbl, val, isDir, onPick) => h('div', { key: lbl, className: 'cap-field', style: { marginBottom: 0 } },
      h('span', { className: 'cap-lbl', style: { width: 88 } }, lbl),
      h('button', { className: 'cap-file-btn', onClick: onPick }, h(Icon, { name: isDir ? 'folder' : 'doc', size: 14 }), val ? AR.baseName(val) : '选择…'));

    return h(AR.Page, {
      title: '延迟校准',
      chip: h(React.Fragment, null, h(Icon, { name: 'pulse', size: 14 }), 'tracking × video'),
      right: h(Button, { variant: 'accent', size: 'S', isDisabled: vp.running || !ws.sessionPath, icon: h(Icon, { name: 'pulse', size: 14 }), onPress: run },
        D ? '重新校准' : vp.running ? '校准中…' : '开始校准'),
    },
      h('div', { className: 'ar-card' },
        h('div', { className: 'ar-card-h' }, h(Icon, { name: 'doc', size: 15 }), '输入'),
        h('div', { className: 'ar-inputs' },
          inputRow('session', ws.sessionPath, false, () => AR.pickArPath('session', ['json'], 'session 配置')),
          inputRow('result.json', resultPath, false, async () => { const p = await pickFile('quick run 输出 result.json', ['json']).catch(() => null); if (p) setResultPath(p); }),
          inputRow('视频帧目录', videoDir, true, async () => { const p = await pickDirectory().catch(() => null); if (p) setVideoDir(p); }),
          inputRow('tracking jsonl', trackingPath, false, async () => { const p = await pickFile('tracking poses (jsonl)', ['jsonl', 'json']).catch(() => null); if (p) setTrackingPath(p); }))),
      vp.running
        ? h('div', { className: 'cal2-progbox' },
            h('div', { className: 'cal2-prog-top' }, h('span', { className: 'cal2-prog-stage' }, '互相关 · 扫描时移'), h('span', { className: 'cal2-prog-pct' }, '进行中')),
            h('div', { className: 'vmeter vmeter--accent ar-indeterminate' }, h('div', { className: 'vmeter__fill' })))
        : !D
          ? h('div', { style: { fontSize: 12, color: 'var(--chrome-faint)', padding: '4px 2px' } }, '补齐上方四项输入后开始校准。')
          : h(React.Fragment, null,
              motionLow ? h('div', { className: 'ar-degen ar-degen--notice' }, h(Icon, { name: 'alert', size: 15 }),
                h('div', null, h('b', null, '运动不足'), h('div', { className: 'ar-degen-d' }, '采集期间相机 / 场景运动过小，互相关峰值不显著，延迟估计不可靠。请增加平移 / 旋转幅度后重采。'))) : null,
              cam ? h(React.Fragment, null,
                h('div', { className: 'ar-delay-hero' },
                  h('div', null,
                    h('div', { className: 'ar-delay-big' },
                      h('span', { className: 'ar-delay-num' }, (cam.delay_ms >= 0 ? '+' : '') + cam.delay_ms.toFixed(1)),
                      h('span', { className: 'ar-delay-unit' }, 'ms'),
                      h('span', { className: 'ar-delay-sig' }, '± ' + cam.sigma_ms.toFixed(1))),
                    h('div', { className: 'ar-delay-note' }, 'delay_ms · num_markers ' + cam.num_markers + ' · num_frames ' + cam.num_frames)),
                  h('div', { className: 'ar-delay-conf' },
                    h(ConfRingDelay, { pct: AR.confPct(cam.confidence) }),
                    h('div', null, h('div', { className: 'ar-conf-l' }, AR.confBadge(cam.confidence)), h('div', { className: 'ar-conf-meta' }, 'confidence ' + cam.confidence)))),
                D.recommendation ? h('div', { className: 'ar-copyrow' },
                  h('code', null, D.recommendation),
                  h('button', { className: 'ar-copy-btn' + (copied ? ' done' : ''), onClick: copy }, h(Icon, { name: copied ? 'check' : 'copy', size: 13 }), copied ? '已复制' : '复制')) : null,
                h('div', { className: 'ar-notes' },
                  h('div', { className: 'ar-note-i' }, h(Icon, { name: 'info', size: 13 }), '正值 = tracking 领先视频'),
                  h('div', { className: 'ar-note-i' }, h(Icon, { name: 'info', size: 13 }), '1 ms ≈ 0.59 mm 滑移'))) : null,
              h('div', { className: 'cal2-wip' },
                h('span', { className: 'cal2-wip-ic' }, h(Icon, { name: 'live', size: 15 })),
                h('div', { className: 'cal2-wip-m' }, h('div', { className: 'cal2-wip-t' }, '使用采集配置实时校准'), h('div', { className: 'cal2-wip-d' }, '直接从现场采集流实时估计延迟，无需离线帧目录 / jsonl。')),
                h('span', { className: 'nav-tag' }, 'WIP'))));
  }

  window.VOLO_CAL_AR = Object.assign(window.VOLO_CAL_AR || {}, { Markers, Lens, Spatial, Delay });
})();

export {};
