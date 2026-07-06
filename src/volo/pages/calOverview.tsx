// @ts-nocheck
/* Volo — 校正 · LED 概览页（仪表盘型单栏滚动）
   1:1 port of the Claude Design handoff `src/cal2_overview.jsx`, adapted to real data:
   - 「切换项目」复用旧 ProjectChip 的真实机制（proj.recent + openProjectPath），
     不是设计稿里的纯前端 mock 切换。
   - 「项目概览」表格没有现成的「多项目状态汇总」后端命令 —— 运行时对 proj.recent
     里的每个项目分别 load_project_yaml + list_runs 聚合出网格状态；镜头状态没有任何
     持久化信号（quick-run session/export 路径完全是用户每次手选的临时文件，不落
     project.yaml），如实显示「未跟踪」，不编造。
   - 设计稿 cal2_overview.jsx 里的 ProjectBar / DeliverCard / ProjectHeader / ProjectCard
     四个函数定义了但 Overview() 实际渲染路径从未调用（失效代码），故不搬。
   - 镜头校正 leaf 本批仍是概要占位页：「运行求解」按钮沿用设计稿的本地 setTimeout
     演示态（真实 vpcal quick-run 接线见后续批次），与设计稿自己标注的 WIP 一致。 */
import * as React from "react";
import { loadProjectYaml, listRuns } from "../api/meshCommands";

(function () {
  const { Button } = window.Spectrum2DesignSystem_b6d1b3;
  const { useState, useRef, useEffect } = React;
  const h = React.createElement;
  const CX = window.VOLO_CAL2;

  /* ---------- 通用下拉 ---------- */
  function Drop({ btn, width, children, align }) {
    const [open, setOpen] = useState(false);
    const ref = useRef(null);
    useEffect(() => {
      if (!open) return;
      const fn = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
      document.addEventListener('mousedown', fn);
      return () => document.removeEventListener('mousedown', fn);
    }, [open]);
    return h('div', { className: 'ctx-drop', ref, style: { position: 'relative' } },
      h('button', { className: 'cal2-selbtn', onClick: () => setOpen((v) => !v) }, btn, h(Icon, { name: 'chevd', size: 14 })),
      open ? h('div', { className: 'popover', style: Object.assign({ minWidth: width || 260 }, align === 'left' ? { left: 0, right: 'auto' } : null) }, children(() => setOpen(false))) : null);
  }

  /* ---------- 整页空态（未打开任何项目 / 无最近项目） ---------- */
  function Empty({ s, proj }) {
    const step = (n, icon, title, desc) => h('div', { className: 'ce-step' },
      h('span', { className: 'ce-step-n' }, n),
      h('span', { className: 'ce-step-ico' }, h(Icon, { name: icon, size: 18 })),
      h('div', { className: 'ce-step-txt' }, h('div', { className: 'ce-step-t' }, title), h('div', { className: 'ce-step-d' }, desc)));
    return h('div', { className: 'dash' },
      h('div', { className: 'cluster-empty' },
        h('div', { className: 'ce-ico' }, h(Icon, { name: 'calibrate', size: 36, stroke: 1.3 })),
        h('div', { className: 'ce-t' }, proj.error ? '加载项目失败' : '尚未打开校正项目'),
        h('div', { className: 'ce-d' }, proj.error || '校正数据都归属某个项目（project.yaml）。打开或新建一个项目，导入测量后即可重建 LED 网格并做镜头校正。'),
        h('div', { className: 'ce-acts' },
          h(Button, { variant: 'accent', size: 'L', icon: h(Icon, { name: 'folder', size: 16 }), onPress: () => CX.pickAndOpenProject(s) }, '打开项目'),
          h(Button, { variant: 'secondary', size: 'L', icon: h(Icon, { name: 'plus', size: 16 }), onPress: () => CX.pickAndSeedExample(s, 'curved-flat') }, '从示例开始')),
        proj.recent && proj.recent.length ? h('div', { style: { marginTop: 18, width: '100%', maxWidth: 440 } },
          h('div', { className: 'surv-sub', style: { marginTop: 0 } }, '最近项目'),
          proj.recent.slice(0, 5).map((r) => h('div', { key: r.id, className: 'out-item', onClick: () =>
            CX.openProjectPath(r.abs_path, s).catch((e) => CX.projStore.patch({ error: e && e.message ? e.message : String(e) })) },
            h('span', { className: 'out-ico' }, h(Icon, { name: 'doc', size: 15 })),
            h('div', { className: 'out-main' }, h('div', { className: 'out-t' }, r.display_name), h('div', { className: 'out-s' }, r.abs_path))))) : null,
        h('div', { className: 'ce-steps' },
          step(1, 'folder', '打开或新建项目', '选择 project.yaml，或从示例一键 seed'),
          step(2, 'pin', '导入测量', '全站仪 CSV 或视觉 ChArUco 采集'),
          step(3, 'cube', '重建', '生成 LED 网格并评估质量偏差'))));
  }

  /* ---------- 模块 1 · 项目切换（下拉 + 应用，原地提示，不跳转） ---------- */
  function ProjectSwitcher({ s, proj }) {
    const cur = proj.recent.find((r) => r.abs_path === proj.path) || proj.recent[0];
    const [pick, setPick] = useState(cur ? cur.abs_path : null);
    const [applied, setApplied] = useState(false);
    const pk = proj.recent.find((r) => r.abs_path === pick) || cur;
    const apply = async () => {
      if (!pk) return;
      if (pk.abs_path !== proj.path) {
        try {
          await CX.openProjectPath(pk.abs_path, s);
          s.setCalLensState('idle');
        } catch (e) { CX.projStore.patch({ error: e && e.message ? e.message : String(e) }); return; }
      }
      setApplied(true);
      s.pushLog({ lv: 'ok', cat: 'project', msg: `切换到项目 <b>${pk.display_name}</b> · 已载入网格 / 镜头校正配置` });
    };
    if (!proj.recent.length) return null;
    return h('div', { className: 'dash-card' },
      h('div', { className: 'dc-h' }, h('span', { className: 't' }, h(Icon, { name: 'folder', size: 14 }), '切换项目'),
        h('span', { className: 'dc-n' }, proj.recent.length + ' 个最近项目')),
      h('div', { className: 'cal2-switch-row' },
        h(Drop, { width: 360, align: 'left', btn: h('span', { className: 'cal2-sel-inner' },
          h('span', { className: 'cal2-sel-ico' }, h(Icon, { name: 'folder', size: 15 })),
          h('span', { className: 'cal2-sel-col' }, h('span', { className: 'k' }, '目标项目'), h('span', { className: 'v' }, pk ? pk.display_name : '—'))) },
          (close) => proj.recent.map((r) => h('div', { key: r.id, className: 'pop-i' + (r.abs_path === pick ? ' on' : ''),
            onClick: () => { setPick(r.abs_path); setApplied(false); close(); } },
            h('div', { style: { display: 'flex', flexDirection: 'column', lineHeight: 1.4, minWidth: 0 } },
              h('span', { className: 'pop-l' }, r.display_name),
              h('span', { className: 'pop-s' }, r.abs_path)),
            r.abs_path === pick ? h('span', { style: { marginLeft: 'auto', color: 'var(--volo-500)', display: 'flex' } }, h(Icon, { name: 'check', size: 15 })) : null))),
        h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'check', size: 15 }), isDisabled: !pk, onPress: apply }, '应用')),
      applied && pk
        ? h('div', { className: 'cal2-switch-ok' }, h(Icon, { name: 'check', size: 14 }), h('span', null, '已切换到 ', h('b', null, pk.display_name), ' · 已载入网格 / 镜头校正配置'))
        : h('div', { className: 'cal2-switch-hint' }, h(Icon, { name: 'info', size: 13 }), '选择目标项目后点「应用」即在当前页切换，不跳转页面'));
  }

  /* ---------- 模块 2 · 项目概览（所有最近项目：屏幕 / 网格状态 / 镜头状态 / 数据） ----------
     逐项目 load_project_yaml + 逐屏幕 list_runs 聚合出「最近一次重建」；没有专门的
     「多项目状态汇总」后端命令，本页自己拼——只对 proj.recent（真实最近项目列表）算，
     不引入静态假数据。镜头状态没有任何持久化信号，统一标「未跟踪」。 */
  function useProjectSummaries(recent) {
    const [rows, setRows] = useState([]);
    const [loading, setLoading] = useState(false);
    useEffect(() => {
      let cancelled = false;
      if (!recent || !recent.length) { setRows([]); return undefined; }
      setLoading(true);
      Promise.all(recent.map(async (r) => {
        try {
          const config = await loadProjectYaml(r.abs_path);
          const screenIds = Object.keys(config.screens);
          let best = null;
          for (const sid of screenIds) {
            const runs = await listRuns(r.abs_path, sid);
            if (runs.length && (!best || runs[0].created_at > best.run.created_at)) best = { screenId: sid, run: runs[0] };
          }
          const gridStatus = best ? (best.run.output_obj_path ? 'exported' : 'rebuilt') : 'none';
          return {
            id: r.id, name: (config.project && config.project.name) || r.display_name, path: r.abs_path,
            screenId: best ? best.screenId : (screenIds[0] || null),
            gridStatus, rms: best ? best.run.estimated_rms_mm : null, vertices: best ? best.run.vertex_count : null,
            done: gridStatus === 'rebuilt' || gridStatus === 'exported',
          };
        } catch (e) {
          return { id: r.id, name: r.display_name, path: r.abs_path, screenId: null, gridStatus: 'none', rms: null, vertices: null, done: false, loadError: true };
        }
      })).then((next) => { if (!cancelled) { setRows(next); setLoading(false); } });
      return () => { cancelled = true; };
    }, [recent]);
    return { rows, loading };
  }

  function ProjectSummary({ s, proj }) {
    const { rows, loading } = useProjectSummaries(proj.recent);
    const done = rows.filter((p) => p.done);
    const wip = rows.filter((p) => !p.done);
    const row = (p) => h('div', { key: p.id, className: 'cal2-ov-row' + (p.path === proj.path ? ' active' : '') },
      h('span', { className: 'cal2-ov-n' }, h('span', { className: 'sdot bg-' + (p.path === proj.path ? 'positive' : 'neutral') }), h('b', null, p.name), p.path === proj.path ? h('span', { className: 'cal2-cur' }, '当前') : null),
      h('span', { className: 'cal2-ov-scr' }, h('span', { className: 'mono' }, p.screenId || '—')),
      h('span', null, CX.statusPill(CAL_GRID_STATUS, p.gridStatus)),
      h('span', null, CX.statusPill(CAL_LENS_STATUS, 'unknown')),
      h('span', { className: 'cal2-ov-st' }, p.loadError
        ? h('span', { style: { color: 'var(--negative-visual)' } }, '加载失败')
        : p.done
          ? h('span', { className: 'cal2-ov-data' }, h(Icon, { name: 'check', size: 12 }), 'RMS ' + (p.rms == null ? 'n/a' : p.rms.toFixed(2) + ' mm') + (p.vertices ? ' · ' + p.vertices.toLocaleString() + ' 顶点' : ''))
          : h('span', { className: 'cal2-ov-step' }, h(Icon, { name: 'arrowr', size: 12 }), p.gridStatus === 'measured' ? '已导入测量 · 待重建' : '尚无重建记录')));
    return h('div', { className: 'dash-card' },
      h('div', { className: 'dc-h' }, h('span', { className: 't' }, h(Icon, { name: 'list', size: 14 }), '项目概览'),
        h('span', { className: 'dc-n' }, loading ? '加载中…' : (done.length + ' 已完成 · ' + wip.length + ' 进行中'))),
      h('div', { className: 'cal2-ov-stats' },
        h('div', { className: 'cal2-ov-stat' }, h('span', { className: 'n s-positive' }, done.length), h('span', { className: 'l' }, '已完成')),
        h('div', { className: 'cal2-ov-stat' }, h('span', { className: 'n s-notice' }, wip.length), h('span', { className: 'l' }, '进行中')),
        h('div', { className: 'cal2-ov-stat' }, h('span', { className: 'n' }, rows.length), h('span', { className: 'l' }, '项目总数'))),
      rows.length ? h('div', { className: 'cal2-ovtable' },
        h('div', { className: 'cal2-ov-head' }, h('span', null, '项目'), h('span', null, '屏幕'), h('span', null, '网格'), h('span', null, '镜头'), h('span', null, '状态 / 数据')),
        rows.map(row)) : h('div', { style: { fontSize: 12, color: 'var(--chrome-faint)', padding: '10px 2px' } }, loading ? '加载中…' : '暂无最近项目'));
  }

  function Overview({ s }) {
    const proj = CX.useProj();
    if (proj.loading) return h('div', { className: 'dash' }, h('div', { style: { padding: 20, fontSize: 12, color: 'var(--chrome-faint)' } }, '加载中…'));
    if (!proj.path) return h(Empty, { s, proj });
    return h('div', { className: 'dash' },
      h(ProjectSwitcher, { s, proj }),
      h(ProjectSummary, { s, proj }));
  }

  /* ---------- 镜头校正（本批 leaf 概要页；完整 validate→detect→solve→report 后续批次接真 vpcal） ---------- */
  function Lens({ s }) {
    const l = CAL_OVERVIEW.lens;
    const done = s.calLensState === 'done';
    const running = s.calLensState === 'running';
    const runSolve = () => {
      s.setCalLensState('running');
      s.pushLog({ lv: 'info', cat: 'lens', msg: '镜头求解 · validate → detect → solve → report' });
      setTimeout(() => { s.setCalLensState('done'); s.pushLog({ lv: 'ok', cat: 'lens', msg: `镜头求解完成 · validation RMS <b>${l.validation_rms_px} px</b> · confidence ${l.confidence}` }); }, 1400);
    };
    const stages = [['validate', '校验'], ['detect', '检测'], ['solve', '求解'], ['report', '报告']];
    return h('div', { className: 'cal2-page' },
      h('div', { className: 'canvas-head' },
        h('span', { className: 't' }, '镜头校正'),
        h('span', { className: 'toolchip' }, h(Icon, { name: 'camera', size: 14 }), '刚体 6-DOF · OpenTrackIO'),
        h('div', { className: 'right' },
          done ? CX.rmsBadge(l.validation_rms_px, 'px') : null,
          h(Button, { variant: 'accent', size: 'S', isDisabled: running, icon: h(Icon, { name: 'target', size: 14 }), onPress: runSolve }, done ? '重新求解' : running ? '求解中…' : '运行求解'))),
      h('div', { className: 'dash', style: { paddingTop: 14 } },
        h('div', { className: 'cal2-lens-stages' }, stages.map(([id, cn], i) => h('div', { key: id, className: 'cal2-lstage' + (done ? ' done' : running && i === 0 ? ' active' : '') },
          h('span', { className: 'cal2-lstage-n' }, done ? h(Icon, { name: 'check', size: 13 }) : (i + 1)),
          h('span', { className: 'cal2-lstage-t' }, id), h('span', { className: 'cal2-lstage-c' }, cn)))),
        done
          ? h(React.Fragment, null,
              h('div', { className: 'cal2-deliver-grid' },
                h('div', { className: 'dash-card' },
                  h('div', { className: 'dc-h' }, h('span', { className: 't' }, h(Icon, { name: 'pulse', size: 14 }), '求解质量')),
                  h('div', { className: 'cal2-qbar' },
                    ['validation_rms_px', 'confidence', 'session'].map((k) => h('div', { className: 'cal2-q', key: k },
                      h('div', { className: 'cal2-q-k' }, k),
                      h('div', { className: 'cal2-q-v', style: { fontSize: 15 } },
                        k === 'validation_rms_px' ? CX.rmsBadge(l.validation_rms_px, 'px')
                          : k === 'confidence' ? CX.confBadge(l.confidence)
                          : h('span', { className: 'mono', style: { fontSize: 12 } }, l.session_file)))))),
                h('div', { className: 'dash-card' },
                  h('div', { className: 'dc-h' }, h('span', { className: 't' }, h(Icon, { name: 'download', size: 14 }), '产物 · OpenTrackIO')),
                  h('div', { className: 'cal2-prod', style: { margin: 0 } },
                    h('span', { className: 'cal2-prod-ic' }, h(Icon, { name: 'doc', size: 14 })),
                    h('div', { className: 'cal2-prod-m' }, h('div', { className: 'cal2-prod-f' }, l.export_file), h('div', { className: 'cal2-prod-d' }, l.export_dir)),
                    h('button', { className: 'cal2-folderbtn', onClick: () => s.pushLog({ lv: 'info', cat: 'lens', msg: `打开文件夹 <b>${l.export_dir}</b>` }) }, h(Icon, { name: 'external', size: 13 }), '打开文件夹')))),
              h('div', { className: 'cal2-wip' },
                h('span', { className: 'cal2-wip-ic' }, h(Icon, { name: 'sliders', size: 15 })),
                h('div', { className: 'cal2-wip-m' }, h('div', { className: 'cal2-wip-t' }, '完整镜头报告（hand-eye / 变换矩阵 / report diff）'), h('div', { className: 'cal2-wip-d' }, '本批为概要页，接真实 vpcal quick-run 的 7-DOF 报告与 Session 构建器在后续批次展开')),
                h('span', { className: 'nav-tag' }, 'WIP')))
          : h('div', { className: 'cluster-empty', style: { marginTop: 4 } },
              h('div', { className: 'ce-ico' }, h(Icon, { name: 'camera', size: 34, stroke: 1.3 })),
              h('div', { className: 'ce-t', style: { fontSize: 17 } }, running ? '正在求解…' : '镜头校正未运行'),
              h('div', { className: 'ce-d' }, '运行后生成 6-DOF 变换、拟合 / 验证 RMS 与 OpenTrackIO 导出。'),
              !running ? h('div', { className: 'ce-acts' }, h(Button, { variant: 'accent', size: 'L', icon: h(Icon, { name: 'target', size: 16 }), onPress: runSolve }, '运行求解')) : null)));
  }

  window.VOLO_CAL2 = Object.assign(window.VOLO_CAL2 || {}, { Overview, Lens });
})();
