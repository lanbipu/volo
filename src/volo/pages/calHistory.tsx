// @ts-nocheck
/* Volo — 校正 · 网格校正 · 历史与导出
   1:1 port of the Claude Design handoff `src/cal2_history.jsx`：
   ① 重建历史表（行展开质量指标 · 在预览中查看）
   ② M1+M2 融合（输入 → 结果卡 → 残差表）—— 沿用旧 pages/calLedExt.tsx 的 FusePanel
     真实 mesh_fuse_run 接线（唯一消费方，「📝 no-ui」的旧头注释已过时）。
   ③ 导出（OBJ 目标单选 + 另存 + 导出）+ 指导卡 —— 指导卡预览不是设计稿里手搓的
     iframe 演示 HTML，而是真调用 generate_instruction_card 拿到的真实 htmlContent
     （后端本就是"HTML string for iframe srcdoc rendering"，比自己拼一份假预览更准确）。 */
import * as React from "react";
import { listRuns, getRunReport, exportObj, generateInstructionCard, saveInstructionPdf } from "../api/meshCommands";
import { meshFuseRun } from "../api/meshFuseCommands";
import { pickFile, pickDirectory, revealPath } from "../api/commands";
import { isTauri } from "../api/invoke";

(function () {
  const { Button, Badge, InlineAlert, Switch } = window.Spectrum2DesignSystem_b6d1b3;
  const { useState } = React;
  const h = React.createElement;
  const CX = window.VOLO_CAL2;

  const mmBadge = (mm) => { if (mm == null) return h(Badge, { variant: 'neutral', size: 'S' }, 'n/a'); const v = mm < 3 ? 'positive' : mm < 8 ? 'notice' : 'negative'; return h(Badge, { variant: v, size: 'S' }, mm.toFixed(2) + ' mm'); };

  /* ① 重建历史表 */
  function History1({ s, proj }) {
    const [exp, setExp] = useState(null);
    const [reports, setReports] = useState({});
    const runs = proj.runs || [];
    const click = (r) => {
      s.setCalSel({ type: 'run', id: r.id });
      const next = exp === r.id ? null : r.id;
      setExp(next);
      if (next && !reports[r.id]) {
        setReports((prev) => ({ ...prev, [r.id]: 'loading' }));
        getRunReport(r.id).then((rep) => setReports((prev) => ({ ...prev, [r.id]: rep })))
          .catch((e) => setReports((prev) => ({ ...prev, [r.id]: 'error:' + (e && e.message ? e.message : e) })));
      }
    };
    const viewInPreview = (r) => { CX.viewRunInPreview(s, proj, r.id); };
    const openFolder = (path) => revealPath(path).catch((err) => s.pushLog({ lv: 'err', cat: 'calibrate', msg: `打开失败 · ${err && err.message ? err.message : err}` }));
    return h('div', { className: 'dash-card' },
      h('div', { className: 'dc-h' }, h('span', { className: 't' }, h(Icon, { name: 'list', size: 14 }), '重建历史'), h('span', { className: 'dc-n' }, runs.length + ' 次重建')),
      h('div', { className: 'cal2-htable' },
        h('div', { className: 'cal2-ht-head' }, h('span', null, 'id'), h('span', null, 'method'), h('span', null, 'RMS'), h('span', null, 'vertices'), h('span', null, 'screen'), h('span', null, 'created_at'), h('span', null, 'OBJ'), h('span', null, '')),
        runs.length ? runs.map((r) => { const rep = reports[r.id]; return h(React.Fragment, { key: r.id },
          h('div', { className: 'cal2-ht-row' + (s.calSel && s.calSel.type === 'run' && s.calSel.id === r.id ? ' sel' : ''), onClick: () => click(r) },
            h('span', { className: 'mono' }, 'run #' + r.id),
            h('span', { className: 'dim' }, r.method),
            h('span', null, CX.rmsBadge(r.estimated_rms_mm)),
            h('span', { className: 'mono' }, r.vertex_count ? r.vertex_count.toLocaleString() : '—'),
            h('span', { className: 'mono dim' }, r.screen_id),
            h('span', { className: 'dim' }, r.created_at),
            h('span', null, r.output_obj_path ? h('button', { className: 'cal2-objbtn', onClick: (e) => { e.stopPropagation(); openFolder(r.output_obj_path); } }, h(Icon, { name: 'external', size: 12 }), '打开文件夹') : h('span', { style: { color: 'var(--chrome-faint)' } }, '—')),
            h('span', { className: 'cal2-ht-caret' }, h(Icon, { name: 'chevr', size: 13, style: { transform: exp === r.id ? 'rotate(90deg)' : 'none' } }))),
          exp === r.id ? h('div', { className: 'cal2-ht-exp' },
            rep === 'loading' ? h('div', { style: { fontSize: 12, color: 'var(--chrome-faint)' } }, '加载中…')
              : (typeof rep === 'string' && rep.indexOf('error:') === 0) ? h('div', { style: { fontSize: 12, color: 'var(--negative-visual)' } }, rep.slice(6))
              : rep ? h('div', { className: 'cal2-qbar' },
                  [['middle_max_dev', rep.quality_metrics.middle_max_dev_mm], ['middle_mean_dev', rep.quality_metrics.middle_mean_dev_mm],
                   ['estimated_rms', rep.quality_metrics.estimated_rms_mm], ['estimated_p95', rep.quality_metrics.estimated_p95_mm]].map(([k, v]) => h('div', { className: 'cal2-q', key: k },
                    h('div', { className: 'cal2-q-k' }, k), h('div', { className: 'cal2-q-v' }, v == null ? 'n/a' : v.toFixed(2), v == null ? null : h('span', { className: 'cal2-q-u' }, 'mm')))))
                : null,
            h('div', { style: { marginTop: 10 } }, h(Button, { variant: 'secondary', size: 'S', icon: h(Icon, { name: 'cube3', size: 14 }), onPress: () => viewInPreview(r) }, '在预览中查看'))) : null); })
          : h('div', { style: { padding: 16, fontSize: 12, color: 'var(--chrome-faint)' } }, '当前屏幕暂无重建记录。')));
  }

  /* ② M1 + M2 融合（真接 mesh_fuse_run，见 pages/calLedExt.tsx 原始实现） */
  function Fuse({ s, proj }) {
    const [open, setOpen] = useState(false);
    const [err, setErr] = useState(null);
    const [result, setResult] = useState(null);
    const [running, setRunning] = useState(false);
    const [allowScale, setAllowScale] = useState(false);
    const hasBackend = isTauri() && proj && proj.path;
    const F = result;

    const runFuse = async () => {
      if (open) { setOpen(false); return; }
      if (!hasBackend) { s.pushLog({ lv: 'warn', cat: 'fuse', msg: '融合失败 · 尚未打开项目' }); return; }
      const measurementsPath = proj.measurementsAbsPath;
      if (!measurementsPath) { s.pushLog({ lv: 'warn', cat: 'fuse', msg: '融合失败 · 请先在测量导入中导入 M1 全站仪测量' }); return; }
      let poseReportPath;
      try { poseReportPath = await pickFile('M2 视觉重建 pose report', ['yaml', 'yml', 'json']); }
      catch (e) { s.pushLog({ lv: 'err', cat: 'fuse', msg: `选择 pose report 失败 · ${e && e.message ? e.message : e}` }); return; }
      if (!poseReportPath) return;
      setRunning(true); setErr(null);
      s.setLogOpen(true);
      s.pushLog({ lv: 'info', cat: 'fuse', msg: `融合运行 · mesh_fuse_run（allowScale=${allowScale}）` });
      try {
        const res = await meshFuseRun(proj.path, s.calScreen, poseReportPath, measurementsPath, allowScale);
        setResult(res); setOpen(true);
        s.pushLog({ lv: 'ok', cat: 'fuse', msg: `融合完成 · anchor RMS <b>${res.anchor_rms_mm.toFixed(2)} mm</b> · ${res.anchor_count} 锚点` });
      } catch (e) {
        setResult(null); setErr(e && e.message ? e.message : String(e)); setOpen(true);
        s.pushLog({ lv: 'err', cat: 'fuse', msg: `融合失败 · ${e && e.message ? e.message : e}` });
      } finally { setRunning(false); }
    };

    const scaleDev = F ? (F.scale - 1) * 100 : 0;
    return h('div', { className: 'dash-card' },
      h('div', { className: 'dc-h' }, h('span', { className: 't' }, h(Icon, { name: 'link', size: 14 }), 'M1 + M2 融合'), h('span', { className: 'dc-n' }, '全站仪锚定 + 视觉稠密化')),
      h('div', { className: 'cal2-fuse-inputs' },
        h('div', { className: 'cal2-fi' }, h('span', { className: 'cap-lbl' }, 'measurements'),
          h('span', { className: 'cal2-fi-cur' }, h('span', { className: 'sdot bg-' + (proj.measurementsAbsPath ? 'positive' : 'neutral') }), proj.measurementsAbsPath ? '当前项目 M1 测量已导入' : '尚未导入 M1 测量')),
        h('div', { className: 'cal2-fi' }, h('span', { className: 'cap-lbl' }, 'pose report'), h('span', { style: { fontSize: 11.5, color: 'var(--chrome-faint)' } }, '点「融合」时选择')),
        h('div', { className: 'cal2-fi cal2-fi--tg' }, h('span', { className: 'cap-lbl' }, 'allowScale'), h(Switch, { isSelected: allowScale, onChange: setAllowScale }))),
      h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginBottom: open ? 14 : 0 } },
        h(Button, { variant: open ? 'secondary' : 'accent', size: 'S', isDisabled: running, icon: h(Icon, { name: 'sync', size: 14 }), onPress: runFuse }, running ? '融合中…' : open ? '收起' : '融合')),
      open ? h(React.Fragment, null,
        err
          ? h(InlineAlert, { variant: 'negative', title: '融合失败' }, err)
          : F ? h(React.Fragment, null,
              h('div', { className: 'cal2-fuse-sum' },
                h('div', { className: 'cal2-fs-badge' }, h('span', { className: 'k' }, 'anchor_count'), h('span', { className: 'v mono' }, F.anchor_count)),
                h('div', { className: 'cal2-fs-badge' }, h('span', { className: 'k' }, 'anchor_rms_mm'), h('span', { className: 'v' }, mmBadge(F.anchor_rms_mm))),
                h('div', { className: 'cal2-fs-badge' }, h('span', { className: 'k' }, 'scale' + (F.scale_locked ? ' · locked' : '')),
                  h('span', { className: 'v mono' + (!F.scale_locked && Math.abs(scaleDev) > 0.5 ? ' s-negative' : '') }, F.scale.toFixed(4),
                    !F.scale_locked ? h('span', { className: 'cal2-fs-dev' }, ' ' + (scaleDev >= 0 ? '+' : '') + scaleDev.toFixed(2) + '%') : h('span', { className: 'cal2-fs-lock' }, h(Icon, { name: 'shield', size: 11 }), 'locked')))),
              !F.scale_locked && Math.abs(scaleDev) > 0.05 ? h('div', { className: 'cal2-mc-warn', style: { margin: '10px 0 0' } }, h(Icon, { name: 'alert', size: 13 }), 'scale 未锁定，偏离 1.0 ' + scaleDev.toFixed(2) + '%（阈值 ±0.5%）') : null,
              h('div', { className: 'cal2-subh', style: { marginTop: 14 } }, '锚点残差'),
              h('div', { className: 'cal2-restable' },
                h('div', { className: 'cal2-res-head' }, h('span', null, 'point_name'), h('span', null, 'residual_mm'), h('span', null, 'Δ x/y/z (mm)')),
                F.anchor_residuals.map((r) => { const over = r.residual_mm > 2.5; return h('div', { key: r.point_name, className: 'cal2-res-row' + (over ? ' over' : '') },
                  h('span', { className: 'mono' }, r.point_name),
                  h('span', { className: 'mono' + (over ? ' s-negative' : '') }, r.residual_mm.toFixed(2)),
                  h('span', { className: 'mono dim' }, '[' + r.delta_mm.map((v) => v.toFixed(2)).join(', ') + ']')); })),
              h('div', { style: { marginTop: 10, fontSize: 11, color: 'var(--chrome-faint)', fontFamily: 'var(--font-code)' } }, F.fused_pose_report_path))
            : null) : null);
  }

  /* ③ 导出块 */
  function ExportBlock({ s, proj }) {
    const [target, setTarget] = useState('disguise');
    const [savePath, setSavePath] = useState('');
    const TARGETS = [
      { id: 'disguise', label: 'Disguise', sub: '.obj + 顶点贴图' },
      { id: 'unreal', label: 'Unreal', sub: 'nDisplay 配置' },
      { id: 'neutral', label: 'Neutral', sub: '.obj 中性网格' },
    ];
    const runId = proj.reconstruction && proj.reconstruction.run_id;
    const doExport = () => {
      if (!runId) { s.pushLog({ lv: 'warn', cat: 'calibrate', msg: '导出失败 · 当前屏幕尚无重建记录' }); return; }
      s.runCmd({ domain: 'calibrate', action: '导出网格', target, chan: 'local' },
        () => exportObj(runId, target, savePath.trim() || null),
        { okMsg: (p) => `导出完成 → <b>${p}</b>` }).catch(() => {});
    };
    const doPreviewCard = async () => {
      if (!proj.path) { s.pushLog({ lv: 'warn', cat: 'calibrate', msg: '预览失败 · 尚未打开项目' }); return; }
      try {
        const card = await generateInstructionCard(proj.path, s.calScreen);
        s.setModal({ wide: true, render: ({ close }) => h(PreviewModal, { close, s, screenId: s.calScreen, projPath: proj.path, html: card.htmlContent }) });
      } catch (e) { s.pushLog({ lv: 'err', cat: 'calibrate', msg: `生成指导卡失败 · ${e && e.message ? e.message : e}` }); }
    };
    const doExportPdf = async () => {
      if (!proj.path) { s.pushLog({ lv: 'warn', cat: 'calibrate', msg: '导出失败 · 尚未打开项目' }); return; }
      let dir;
      try { dir = await pickDirectory(); } catch (e) { s.pushLog({ lv: 'err', cat: 'calibrate', msg: `选择保存目录失败 · ${e && e.message ? e.message : e}` }); return; }
      if (!dir) return;
      const dst = dir.replace(/[\\/]+$/, '') + '/' + s.calScreen + '_instruction_card.pdf';
      s.runCmd({ domain: 'calibrate', action: '生成指导卡', target: s.calScreen, chan: 'local' },
        () => saveInstructionPdf(proj.path, s.calScreen, dst),
        { okMsg: (p) => `指导卡已保存 → <b>${p}</b>` }).catch(() => {});
    };
    return h('div', { className: 'cal2-export-grid' },
      h('div', { className: 'dash-card' },
        h('div', { className: 'dc-h' }, h('span', { className: 't' }, h(Icon, { name: 'download', size: 14 }), '导出 OBJ')),
        h('div', { className: 'cal2-export-targets' }, TARGETS.map((t) => h('button', { key: t.id, className: 'cal2-target' + (target === t.id ? ' on' : ''), onClick: () => setTarget(t.id) },
          h('span', { className: 'cal2-target-ck' }, target === t.id ? h(Icon, { name: 'check', size: 12 }) : null),
          h('div', null, h('div', { className: 'cal2-target-l' }, t.label), h('div', { className: 'cal2-target-s' }, t.sub))))),
        h('div', { className: 'cal2-savepath' },
          h('span', { className: 'cap-lbl' }, '另存路径（可空）'),
          h('input', { className: 'cap-tf', value: savePath, placeholder: '留空使用默认路径', onChange: (e) => setSavePath(e.target.value) })),
        h('div', { style: { marginTop: 12 } }, h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'download', size: 15 }), isDisabled: !runId, onPress: doExport }, '导出 OBJ'))),
      h('div', { className: 'dash-card' },
        h('div', { className: 'dc-h' }, h('span', { className: 't' }, h(Icon, { name: 'doc', size: 14 }), '指导卡')),
        h('div', { className: 'cal2-guide-desc' }, '为现场生成校正指导卡：可先在浮层预览，再导出 PDF 带到现场。'),
        h('div', { className: 'cal2-guide-acts' },
          h(Button, { variant: 'secondary', size: 'M', icon: h(Icon, { name: 'eye', size: 15 }), onPress: doPreviewCard }, '预览'),
          h(Button, { variant: 'secondary', size: 'M', icon: h(Icon, { name: 'doc', size: 15 }), onPress: doExportPdf }, '导出 PDF'))));
  }

  /* 指导卡预览：iframe srcdoc 直接吃真实 generate_instruction_card 的 htmlContent */
  function PreviewModal({ close, s, screenId, projPath, html }) {
    const exportPdf = async () => {
      let dir;
      try { dir = await pickDirectory(); } catch (e) { return; }
      if (!dir) return;
      const dst = dir.replace(/[\\/]+$/, '') + '/' + screenId + '_instruction_card.pdf';
      s.runCmd({ domain: 'calibrate', action: '生成指导卡', target: screenId, chan: 'local' },
        () => saveInstructionPdf(projPath, screenId, dst), { okMsg: (p) => `指导卡已保存 → <b>${p}</b>` }).catch(() => {});
      close();
    };
    return h('div', { className: 'drawer drawer--cal2cap' },
      h('div', { className: 'drawer-h' },
        h('span', { className: 'di info' }, h(Icon, { name: 'eye', size: 17 })),
        h('div', { style: { minWidth: 0 } }, h('h2', null, '指导卡预览'), h('div', { className: 'sub' }, h('span', { className: 'cli-pill' }, screenId), h('span', null, ' · generate_instruction_card'))),
        h('button', { className: 'iconbtn x', onClick: close }, h(Icon, { name: 'x', size: 16 }))),
      h('div', { className: 'drawer-b', style: { padding: 0 } },
        h('iframe', { srcDoc: html, style: { width: '100%', height: 420, border: 'none', display: 'block', background: '#f6f6f8' }, title: 'guide-preview' })),
      h('div', { className: 'drawer-f' },
        h(Button, { variant: 'secondary', size: 'M', onPress: close }, '关闭'),
        h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'doc', size: 15 }), onPress: exportPdf }, '导出 PDF')));
  }

  function History({ s }) {
    const proj = CX.useProj();
    return h('div', { className: 'dash' },
      h(History1, { s, proj }),
      h(Fuse, { s, proj }),
      h(ExportBlock, { s, proj }));
  }

  /* inspector（run 详情） */
  const KV = (k, v, mono) => h('div', { className: 'kv', key: k }, h('span', { className: 'k' }, k), h('span', { className: 'v' + (mono ? ' mono' : '') }, v));
  function historyInspector(s, proj) {
    const sel = s.calSel;
    if (!sel || sel.type !== 'run') return CX.inspEmpty('选择一次重建查看报告');
    const r = (proj.runs || []).find((x) => x.id === sel.id);
    if (!r) return null;
    return h(React.Fragment, null,
      h('div', { className: 'insp-head' },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 } },
          h('span', { className: 'step-ico', style: { width: 30, height: 30, borderRadius: 8, background: 'var(--wash)', display: 'grid', placeItems: 'center' } }, h(Icon, { name: 'list', size: 16 })),
          h('h2', { style: { margin: 0, fontSize: 15, fontWeight: 700, fontFamily: 'var(--font-code)' } }, 'run #' + r.id)),
        h('div', { style: { display: 'flex', gap: 7, alignItems: 'center' } }, CX.rmsBadge(r.estimated_rms_mm), h('span', { style: { fontSize: 11.5, color: 'var(--chrome-faint)' } }, r.created_at))),
      h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, '概要'),
        KV('method', r.method), KV('screen', r.screen_id), KV('vertices', r.vertex_count ? r.vertex_count.toLocaleString() : '—', true), KV('OBJ', r.output_obj_path ? '已导出' : '未导出')),
      r.output_obj_path ? h('div', { className: 'insp-sect' },
        h(Button, { variant: 'secondary', size: 'S', icon: h(Icon, { name: 'cube3', size: 14 }), onPress: () => { CX.viewRunInPreview(s, proj, r.id); } }, '在预览中查看')) : null);
  }

  window.VOLO_CAL2 = Object.assign(window.VOLO_CAL2 || {}, { History, historyInspector });
})();
