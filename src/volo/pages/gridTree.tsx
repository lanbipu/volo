// @ts-nocheck
/* Volo — 网格校正工作区 · 左侧场景树 + 测量导入流程面板（gridTree.tsx）
   1:1 port of the Claude Design handoff `src/grid_tree.jsx`。
   场景树：项目 → 屏幕 → 设计模型 / 测试图 / 测量数据（全站仪数据集 · 视觉采集会话）/
   重建结果（run 列表，读真实 proj.runs，「当前」= run.is_current，见 set_run_current）。
   测量导入两条真实流程：
   - 全站仪三步：沿用 pages/calSurvey.tsx 已验证的 importTotalStationCsv +
     loadMeasurementsYaml 接线（doImportCsv 逻辑原样搬入第 2 步）。
   - 视觉校正四步：沿用同文件 M2 的 meshVisualGeneratePattern /
     meshVisualReconstruct 流式重建接线（mesh-visual-progress /
     mesh-visual-reconstruct-done 事件），新曲率形状（arc/l_shape/u_shape/
     custom_segments）按 GRID_MEAS_TYPES.visual.disabledForShapes 在选择器里禁用
     （M2 sidecar 尚不支持，见 CALIBRATE-UX.md 附录 A G14）。 */
import * as React from "react";
import { pickFile } from "../api/commands";
import { isTauri } from "../api/invoke";
import { importTotalStationCsv, loadMeasurementsYaml, saveProjectYaml } from "../api/meshCommands";
import { meshVisualGeneratePattern, meshVisualReconstruct } from "../api/meshVisualCommands";
import { listen } from "@tauri-apps/api/event";

(function () {
  const { Button } = window.Spectrum2DesignSystem_b6d1b3;
  const { useState, useRef, useEffect } = React;
  const h = React.createElement;
  const CX = window.VOLO_CAL2;

  function useOutside(open, close) {
    const ref = useRef(null);
    useEffect(() => {
      if (!open) return undefined;
      const fn = (e) => { if (ref.current && !ref.current.contains(e.target)) close(); };
      document.addEventListener('mousedown', fn);
      return () => document.removeEventListener('mousedown', fn);
    }, [open]);
    return ref;
  }

  function NodeMenu({ items }) {
    const [open, setOpen] = useState(false);
    const ref = useOutside(open, () => setOpen(false));
    return h('span', { ref, style: { position: 'relative' } },
      h('button', { className: 'gw-tact', onClick: (e) => { e.stopPropagation(); setOpen((v) => !v); }, title: '更多操作' }, h(Icon, { name: 'more', size: 15 })),
      open ? h('div', { className: 'popover', style: { right: 0, left: 'auto', top: 'calc(100% + 4px)', minWidth: 180 } },
        items.map((it, i) => it === '-' ? h('div', { key: i, className: 'pop-div' }) : h('div', { key: i, className: 'pop-i' + (it.danger ? ' danger' : ''), onClick: (e) => { e.stopPropagation(); setOpen(false); it.onClick && it.onClick(); } },
          h(Icon, { name: it.icon, size: 14 }), h('span', { className: 'pop-l' }, it.label)))) : null);
  }

  /* ---------- 新建屏幕 ---------- */
  function defaultScreenConfig(kind) {
    const base = {
      cabinet_count: [8, 3], cabinet_size_mm: [500, 500], pixels_per_cabinet: [176, 176],
      shape_mode: 'rectangle', irregular_mask: [], bottom_completion: null,
      position_m: [0, 0, 0], yaw_deg: 0,
    };
    const t = (GRID_SCREEN_TYPES.find((x) => x.id === kind) || GRID_SCREEN_TYPES[0]).shape;
    const shapes = {
      flat: { type: 'flat' },
      arc: { type: 'arc', center_flat_cols: 2, angle_per_col_deg: 9 },
      l_shape: { type: 'l_shape', left_cols: 4, soften_cols: 1, corner_angle_deg: 90 },
      u_shape: { type: 'u_shape', wing_cols: 3, soften_cols: 1, corner_angle_deg: 90 },
      custom_segments: { type: 'custom_segments', segments: [{ cols: 3, cum_angle_deg: 0 }, { cols: 2, cum_angle_deg: 30 }, { cols: 3, cum_angle_deg: 60 }] },
    };
    return Object.assign({}, base, { shape_prior: shapes[t] || shapes.flat });
  }
  function NewScreenMenu({ s }) {
    const proj = CX.useProj();
    const [open, setOpen] = useState(false);
    const ref = useOutside(open, () => setOpen(false));
    const create = async (kind) => {
      setOpen(false);
      if (!proj.config || !proj.path) return;
      let id = kind === 'flat' ? 'SCREEN' : kind.toUpperCase();
      let n = 1; while (proj.config.screens[id]) { n += 1; id = (kind === 'flat' ? 'SCREEN' : kind.toUpperCase()) + n; }
      const nextConfig = Object.assign({}, proj.config, { screens: Object.assign({}, proj.config.screens, { [id]: defaultScreenConfig(kind) }) });
      try {
        await s.runCmd({ domain: 'calibrate', action: '新建屏幕', target: id, chan: 'local' },
          () => saveProjectYaml(proj.path, nextConfig), { okMsg: () => `已新建屏幕 <b>${id}</b>` });
        await CX.openProjectPath(proj.path, s);
        s.setCalActiveScreen(id); s.setCalDraftScreen(null); s.setCalMode('object'); s.setCalSel({ type: 'screen' });
        s.setCalReceipt({ tone: 'ok', text: '已新建屏幕 · ' + id });
      } catch (e) { /* runCmd 已记录失败 */ }
    };
    return h('div', { className: 'gw-newscreen', ref, style: { position: 'relative' } },
      h(Button, { variant: 'secondary', size: 'S', icon: h(Icon, { name: 'plus', size: 14 }), onPress: () => setOpen((v) => !v) }, '新建屏幕'),
      open ? h('div', { className: 'popover', style: { left: 8, right: 8, bottom: 'calc(100% + 6px)', top: 'auto' } },
        GRID_SCREEN_TYPES.map((t) => h('div', { key: t.id, className: 'pop-i', onClick: () => create(t.id) },
          h(Icon, { name: t.icon, size: 15 }), h('span', { className: 'pop-l' }, t.label)))) : null);
  }

  /* ---------- 场景树 ---------- */
  function Tree({ s }) {
    const proj = CX.useProj();
    const [openP, setOpenP] = useState(true);
    const [openS, setOpenS] = useState(true);
    const [openMeas, setOpenMeas] = useState(true);
    const [openRuns, setOpenRuns] = useState(true);
    if (!proj.config) return h('div', { className: 'gw-tree' }, h('div', { className: 'gw-tempty' }, '加载中…'));
    const screenId = s.calActiveScreen;
    const m = proj.config.screens[screenId];
    const runs = proj.runs || [];
    const sel = s.calSel;
    const selType = sel && sel.type;
    const shapeLabel = (GRID_SHAPES.find((x) => x.id === (m && m.shape_prior && m.shape_prior.type)) || GRID_SHAPES[0]).label;

    const caret = (open, onClick, leaf) => h('span', { className: 'gw-tcaret' + (leaf ? ' leaf' : open ? '' : ' closed'), onClick: leaf ? null : (e) => { e.stopPropagation(); onClick(); } }, h(Icon, { name: 'chevd', size: 13 }));
    const selectScreen = () => { s.setCalMode('object'); s.setCalSel({ type: 'screen' }); };
    const hasTs = !!proj.measurementsAbsPath;
    const hasVs = !!(proj.visualSession && proj.visualSession.screenId === screenId);
    const fuseReady = hasTs && hasVs;
    /* 测试图生成状态是会话内的临时结果缓存（同 measurementsAbsPath/visualSession
       的既定模式），不是 ScreenConfig 字段——后端没有"是否已生成过测试图"的
       持久标记，输出只落盘到 pattern 目录，不回写 project.yaml。 */
    const hasPattern = !!(proj.patternGenByScreen && proj.patternGenByScreen[screenId]);

    const tsNode = hasTs
      ? h('div', { key: 'ts', className: 'gw-tnode' + (selType === 'survey' && sel.kind === 'ts' ? ' on' : ''), onClick: () => { s.setCalSel({ type: 'survey', kind: 'ts' }); s.setCalFlow('totalstation'); } },
          caret(false, null, true), h('span', { className: 'gw-tico' }, h(Icon, { name: 'target', size: 14 })),
          h('span', { className: 'gw-tlabel' }, '全站仪数据集'),
          h('span', { className: 'gw-tmeta' }, (proj.measured && proj.measured.points ? proj.measured.points.length : 0) + ' 点'))
      : h('div', { key: 'ts', className: 'gw-tnode is-muted' },
          caret(false, null, true), h('span', { className: 'gw-tico' }, h(Icon, { name: 'target', size: 14 })),
          h('span', { className: 'gw-tlabel gw-tempty' }, '全站仪数据集'),
          h('button', { className: 'gw-tinline', onClick: () => s.setCalFlow('totalstation') }, h(Icon, { name: 'download', size: 12 }), '导入'));
    const vsNode = hasVs
      ? h('div', { key: 'vs', className: 'gw-tnode' + (selType === 'survey' && sel.kind === 'vs' ? ' on' : ''), onClick: () => { s.setCalSel({ type: 'survey', kind: 'vs' }); s.setCalFlow('visual'); } },
          caret(false, null, true), h('span', { className: 'gw-tico' }, h(Icon, { name: 'camera', size: 14 })),
          h('span', { className: 'gw-tlabel' }, '视觉采集会话'),
          h('span', { className: 'gw-tmeta' }, (proj.visualSession.poses || 0) + ' 姿位'))
      : h('div', { key: 'vs', className: 'gw-tnode is-muted' },
          caret(false, null, true), h('span', { className: 'gw-tico' }, h(Icon, { name: 'camera', size: 14 })),
          h('span', { className: 'gw-tlabel gw-tempty' }, '视觉采集会话'),
          h('button', { className: 'gw-tinline', onClick: () => s.setCalFlow('visual') }, h(Icon, { name: 'camera', size: 12 }), '拍摄'));

    const screenMenuItems = [
      { icon: 'target', label: '聚焦选中', onClick: () => window.dispatchEvent(new CustomEvent('volo-gw-focus')) },
      '-',
      { icon: 'trash', label: '删除屏幕', danger: true, onClick: () => {
        if (!proj.config || Object.keys(proj.config.screens).length <= 1) { s.setCalReceipt({ tone: 'notice', text: '至少保留一块屏幕' }); return; }
        const screens = Object.assign({}, proj.config.screens);
        delete screens[screenId];
        const nextId = Object.keys(screens)[0];
        s.runCmd({ domain: 'calibrate', action: '删除屏幕', target: screenId, chan: 'local' },
          () => saveProjectYaml(proj.path, Object.assign({}, proj.config, { screens })),
          { okMsg: () => `已删除屏幕 <b>${screenId}</b>` })
          .then(() => { CX.openProjectPath(proj.path, s); s.setCalActiveScreen(nextId); s.setCalDraftScreen(null); })
          .catch(() => {});
      } },
    ];
    const screenNode = h('div', { className: 'gw-tnode' + (selType === 'screen' ? ' on' : ''), onClick: selectScreen },
      caret(openS, () => setOpenS((v) => !v)), h('span', { className: 'gw-tico' }, h(Icon, { name: 'panel', size: 15 })),
      h('span', { className: 'gw-tlabel' }, screenId),
      m ? h('span', { className: 'gw-tmeta' }, m.cabinet_count[0] + '×' + m.cabinet_count[1]) : null,
      h('span', { className: 'gw-tacts' }, h(NodeMenu, { items: screenMenuItems })));

    const patternNode = hasPattern
      ? h('div', { className: 'gw-tnode' + (selType === 'pattern' ? ' on' : ''), onClick: () => s.setCalSel({ type: 'pattern' }) },
          caret(false, null, true), h('span', { className: 'gw-tico' }, h(Icon, { name: 'grid', size: 14 })),
          h('span', { className: 'gw-tlabel' }, '测试图'), h('span', { className: 'gw-tmeta' }, 'ChArUco'))
      : h('div', { className: 'gw-tnode is-muted' },
          caret(false, null, true), h('span', { className: 'gw-tico' }, h(Icon, { name: 'grid', size: 14 })),
          h('span', { className: 'gw-tlabel gw-tempty' }, '测试图'),
          h('button', { className: 'gw-tinline', onClick: () => s.setCalSel({ type: 'pattern' }) }, h(Icon, { name: 'plus', size: 12 }), '生成'));

    const runMenuItems = (r) => [
      { icon: 'eye', label: '在视口中查看', onClick: () => { CX.viewRunInPreview(s, proj, r.id); s.setCalMeshVersion('rebuilt'); } },
      { icon: 'star', label: '设为当前', onClick: () => { CX.setRunCurrentAction(s, proj, r.id); } },
      { icon: 'layers', label: '与另一 run 比对', onClick: () => s.setCalMeshVersion('overlay') },
      { icon: 'external', label: '导出', onClick: () => s.setModal({ wide: true, render: ({ close }) => window.VOLO_GRID_MODALS.exportDlg(s, close) }) },
    ];
    const runNode = (r) => h('div', { key: r.id, className: 'gw-tnode' + (selType === 'run' && sel.id === r.id ? ' on' : ''), onClick: () => { s.setCalSurveyRun(r.id); s.setCalSel({ type: 'run', id: r.id }); } },
      caret(false, null, true), h('span', { className: 'gw-tico' }, h(Icon, { name: 'cube3', size: 14 })),
      h('span', { className: 'gw-tlabel' }, 'run #' + r.id),
      r.is_current ? h('span', { className: 'gw-tcur' }, '当前') : h('span', { className: 'gw-tmeta' }, r.estimated_rms_mm == null ? 'n/a' : r.estimated_rms_mm.toFixed(2) + 'mm'),
      h('span', { className: 'gw-tacts' }, h(NodeMenu, { items: runMenuItems(r) })));
    const runsEmptyNode = h('div', { className: 'gw-tnode is-muted' },
      caret(false, null, true), h('span', { className: 'gw-tico' }, h(Icon, { name: 'cube3', size: 14 })),
      h('span', { className: 'gw-tlabel gw-tempty' }, '尚无重建结果'));
    const runsChildren = h('div', { className: 'gw-tchildren' }, runs.length ? runs.map(runNode) : runsEmptyNode);

    const runsGroupNode = h('div', { className: 'gw-tnode', onClick: () => setOpenRuns((v) => !v) },
      caret(openRuns, () => setOpenRuns((v) => !v)), h('span', { className: 'gw-tico' }, h(Icon, { name: 'list', size: 14 })),
      h('span', { className: 'gw-tlabel' }, '重建结果'),
      h('span', { className: 'gw-tacts' }, h('button', {
        className: 'gw-tinline', disabled: !fuseReady, style: fuseReady ? null : { opacity: .4, cursor: 'not-allowed' },
        onClick: (e) => { e.stopPropagation(); if (fuseReady) s.setModal({ wide: true, render: ({ close }) => window.VOLO_GRID_MODALS.fuse(s, close) }); },
        title: fuseReady ? '融合全站仪 + 视觉数据' : '需同屏两类数据齐备才可融合',
      }, h(Icon, { name: 'link', size: 12 }), '融合…')));

    const screenChildren = h('div', { className: 'gw-tchildren' },
      h('div', { className: 'gw-tnode' + (selType === 'screen' ? ' on' : ''), onClick: selectScreen },
        caret(false, null, true), h('span', { className: 'gw-tico' }, h(Icon, { name: 'cube3', size: 14 })),
        h('span', { className: 'gw-tlabel' }, '设计模型'), h('span', { className: 'gw-tmeta' }, shapeLabel)),
      patternNode,
      h('div', { className: 'gw-tnode', onClick: () => setOpenMeas((v) => !v) },
        caret(openMeas, () => setOpenMeas((v) => !v)), h('span', { className: 'gw-tico' }, h(Icon, { name: 'download', size: 14 })),
        h('span', { className: 'gw-tlabel' }, '测量数据')),
      openMeas ? h('div', { className: 'gw-tchildren' }, tsNode, vsNode) : null,
      runsGroupNode,
      openRuns ? runsChildren : null);

    const projectChildren = h('div', { className: 'gw-tchildren' },
      screenNode,
      openS ? screenChildren : null);

    return h('div', { className: 'gw-tree' },
      h('div', { className: 'gw-tnode', onClick: () => setOpenP((v) => !v) },
        caret(openP, () => setOpenP((v) => !v)), h('span', { className: 'gw-tico' }, h(Icon, { name: 'folder', size: 15 })),
        h('span', { className: 'gw-tlabel' }, (proj.config.project && proj.config.project.name) || '—')),
      openP ? projectChildren : null,
      h(NewScreenMenu, { s }));
  }

  /* ================= 测量导入流程面板 ================= */
  function FlowHead({ s, type }) {
    const [open, setOpen] = useState(false);
    const ref = useOutside(open, () => setOpen(false));
    const proj = CX.useProj();
    const m = proj.config && proj.config.screens[s.calActiveScreen];
    const isNewShape = m && m.shape_prior && GRID_MEAS_TYPES.find((x) => x.id === 'visual').disabledForShapes.includes(m.shape_prior.type);
    const t = GRID_MEAS_TYPES.find((x) => x.id === type) || GRID_MEAS_TYPES[0];
    return h('div', { className: 'gw-flow-head' },
      h('span', { className: 'ic' }, h(Icon, { name: t.icon, size: 15 })),
      h('div', { className: 'tt', ref, style: { position: 'relative' } },
        h('b', { style: { cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 }, onClick: () => setOpen((v) => !v) }, t.label, h(Icon, { name: 'chevd', size: 13 })),
        h('span', null, '测量导入流程'),
        open ? h('div', { className: 'popover', style: { left: 0, top: 'calc(100% + 4px)', minWidth: 200 } },
          GRID_MEAS_TYPES.map((x) => {
            const disabled = x.id === 'visual' && isNewShape;
            return h('div', { key: x.id, className: 'pop-i' + (x.id === type ? ' on' : '') + (disabled ? ' is-disabled' : ''), style: disabled ? { opacity: .45, cursor: 'not-allowed' } : null, title: disabled ? x.disabledMsg : '', onClick: () => { if (disabled) return; setOpen(false); s.setCalFlow(x.id); } },
              h(Icon, { name: x.icon, size: 14 }), h('span', { className: 'pop-l' }, x.label));
          })) : null),
      h('button', { className: 'gw-tact', onClick: () => s.setCalFlow(null), title: '关闭流程' }, h(Icon, { name: 'x', size: 16 })));
  }

  function Step({ n, active, done, idle, title, desc, children }) {
    return h('div', { className: 'gw-fstep' + (done ? ' done' : active ? ' active' : idle ? ' is-idle' : '') },
      h('div', { className: 'gw-fstep-rail' }, h('div', { className: 'gw-fstep-n' }, done ? h(Icon, { name: 'check', size: 13 }) : n)),
      h('div', { className: 'gw-fstep-body' },
        h('div', { className: 'gw-fstep-t' }, title),
        desc ? h('div', { className: 'gw-fstep-d' }, desc) : null, children));
  }

  /* ---- 全站仪三步（doImportCsv 沿用 pages/calSurvey.tsx 已验证逻辑） ---- */
  async function doImportCsv(s, proj, screenId) {
    if (!proj.path) { s.pushLog({ lv: 'warn', cat: 'calibrate', msg: '导入失败 · 尚未打开项目' }); return; }
    let csvPath;
    try { csvPath = await pickFile('Total Station CSV', ['csv']); }
    catch (e) { s.pushLog({ lv: 'err', cat: 'calibrate', msg: `选择 CSV 失败 · ${e && e.message ? e.message : e}` }); return; }
    if (!csvPath) return;
    try {
      await s.runCmd({ domain: 'calibrate', action: '导入全站仪 CSV', target: screenId, chan: 'local' }, async () => {
        const report = await importTotalStationCsv(proj.path, csvPath, screenId);
        const absMeasured = proj.path.replace(/[\\/]+$/, '') + '/' + report.measurementsYamlPath;
        const measured = await loadMeasurementsYaml(absMeasured);
        CX.projStore.patch({ surveyReport: report, measured, measurementsAbsPath: absMeasured });
        return report;
      }, { okMsg: (r) => `导入完成 · 实测 ${r.measuredCount} · 制造 ${r.fabricatedCount} · 离群 ${r.outlierCount} · 缺失 ${r.missingCount}` });
    } catch (e) { /* runCmd 已记录失败 */ }
  }

  function TotalStationFlow({ s }) {
    const proj = CX.useProj();
    const m = proj.config && proj.config.screens[s.calActiveScreen];
    const coord = proj.config && proj.config.coordinate_system;
    const screenId = s.calActiveScreen;
    const refsSet = coord && [coord.origin_point, coord.x_axis_point, coord.xy_plane_point].every((n) => n && n.startsWith(screenId + '_V'));
    const [statFilter, setStatFilter] = useState(null);
    const rep = proj.surveyReport;
    const step = rep ? 3 : proj.measurementsAbsPath ? 3 : 1;
    const points = (proj.measured && proj.measured.points) || [];
    const tiles = rep ? [
      { k: 'measured', label: '实测', n: rep.measuredCount, tone: 'positive', icon: 'check' },
      { k: 'fabricated', label: '制造', n: rep.fabricatedCount, tone: 'neutral', icon: 'wave' },
      { k: 'outlier', label: '离群', n: rep.outlierCount, tone: 'notice', icon: 'alert' },
      { k: 'missing', label: '缺失', n: rep.missingCount, tone: 'neutral', icon: 'minus' },
    ] : [];
    return h('div', { className: 'gw-flow-body' }, h('div', { className: 'gw-flow' },
      h(Step, { n: 1, done: step > 1, active: step === 1, title: '测量准备',
        desc: '设置坐标系参考点，生成全站仪指导卡。' },
        !refsSet
          ? h('div', { className: 'cal2-flow-wait', style: { borderColor: 'color-mix(in srgb, var(--notice-visual) 40%, transparent)', color: 'var(--notice-visual)' } },
              h(Icon, { name: 'alert', size: 14 }), h('span', null, '参考点未设置'),
              h('button', { className: 'gw-tinline', style: { marginLeft: 'auto' }, onClick: () => { s.setCalMode('cabinet'); s.setCalBoxTool('refs'); s.setCalFlow(null); } }, '去设置参考点'))
          : h('div', { className: 'cal2-switch-ok', style: { marginTop: 0 } }, h(Icon, { name: 'check', size: 14 }), h('span', null, '已指派 origin / x_axis / xy_plane')),
        h('div', { className: 'gw-mrow', style: { marginTop: 8, gap: 8 } },
          h(Button, { variant: 'secondary', size: 'S', icon: h(Icon, { name: 'doc', size: 13 }), onPress: () => s.setModal({ render: ({ close }) => window.VOLO_GRID_MODALS.guideCard(s, close) }) }, '生成指导卡'))),
      h(Step, { n: 2, done: step > 2, active: step === 2, title: '导入 CSV',
        desc: '选择全站仪导出的 CSV。' },
        h('div', { className: 'gw-drop', onClick: () => doImportCsv(s, proj, screenId) }, h(Icon, { name: 'download', size: 20 }), h('div', null, '点击选择 CSV 文件'))),
      h(Step, { n: 3, active: step === 3, title: '结果与检查',
        desc: rep ? '点击统计块筛选点表；主按钮开始重建。' : '导入完成后显示统计与点表。' },
        rep ? h('div', { className: 'gw-stat4', style: { marginBottom: 10 } },
          tiles.map((st) => h('button', { key: st.k, className: 'gw-statcell' + (statFilter === st.k ? ' on' : ''), onClick: () => setStatFilter(statFilter === st.k ? null : st.k) },
            h('div', { className: 'n s-' + st.tone }, st.n),
            h('div', { className: 'l' }, h(Icon, { name: st.icon, size: 12 }), st.label)))) : null,
        rep && rep.warnings.length ? rep.warnings.map((w, i) => h('div', { key: i, style: { fontSize: 11.5, color: 'var(--notice-visual)', display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 } }, h(Icon, { name: 'alert', size: 13 }), w)) : null,
        h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'cube3', size: 15 }), isDisabled: !proj.measurementsAbsPath, onPress: () => s.setModal({ render: ({ close }) => window.VOLO_GRID_MODALS.reconstruct(s, close) }) }, '重建'))));
  }

  /* ---- 视觉校正四步（沿用 pages/calSurvey.tsx 的 M2 真接线） ---- */
  function VisualFlow({ s }) {
    const proj = CX.useProj();
    const screenId = s.calActiveScreen;
    const m = proj.config && proj.config.screens[screenId];
    const [tab, setTab] = useState('offline');
    const [manifestPath, setManifestPath] = useState(null);
    const [intr, setIntr] = useState('auto');
    const [baState, setBaState] = useState('idle');
    const [baPct, setBaPct] = useState(0);
    const [baStage, setBaStage] = useState('');
    const [baErr, setBaErr] = useState(null);
    const jobRef = useRef(null);
    const unref = useRef([]);
    const hasBackend = isTauri() && proj && proj.path;
    const hasPattern = !!(proj.patternGenByScreen && proj.patternGenByScreen[screenId]);

    useEffect(() => {
      if (!hasBackend) return undefined;
      let alive = true;
      const add = (fn) => { if (alive) unref.current.push(fn); else fn(); };
      listen('mesh-visual-progress', (e) => {
        const p = e.payload; if (!p || p.job_id !== jobRef.current) return;
        const ev = p.event || {};
        if (ev.event === 'progress') { setBaPct(Math.max(0, Math.min(100, ev.percent || 0))); setBaStage(ev.stage || ''); }
      }).then(add);
      listen('mesh-visual-reconstruct-done', (e) => {
        const p = e.payload; if (!p || p.job_id !== jobRef.current) return;
        if (p.result) {
          setBaState('done'); setBaPct(100); jobRef.current = null;
          CX.projStore.patch({ visualSession: { screenId, poses: (p.result.cabinets || []).length || 1, posePath: p.result.pose_report_path } });
          s.pushLog({ lv: 'ok', cat: 'survey', msg: `BA 重建完成 · ba_rms <b>${p.result.ba_rms_px.toFixed(2)} px</b>` });
        } else {
          setBaErr(p.error || '重建失败'); setBaState('idle'); jobRef.current = null;
          s.pushLog({ lv: 'err', cat: 'survey', msg: `BA 重建失败 · ${p.error || '未知错误'}` });
        }
      }).then(add);
      return () => { alive = false; unref.current.forEach((fn) => fn()); unref.current = []; };
    }, [hasBackend, screenId]);

    const genPattern = async () => {
      if (!hasBackend) return;
      try {
        const r = await meshVisualGeneratePattern(proj.path, screenId, 'charuco', 1, null);
        /* 存完整结果对象（与 gridInsp usePattern 一致），否则检查器里「发送到播放器/打开输出文件夹」拿不到 output_dir */
        CX.projStore.patch({
          patternGenByScreen: Object.assign({}, proj.patternGenByScreen, { [screenId]: r }),
          patternStaleByScreen: Object.assign({}, proj.patternStaleByScreen, { [screenId]: false }),
        });
        s.setCalReceipt({ tone: 'ok', text: `已生成测试图 · ${r.cabinet_count} 箱体` });
        s.pushLog({ lv: 'ok', cat: 'survey', msg: `pattern 生成 · ${r.cabinet_count} 箱体 · ${r.total_markers} markers` });
      } catch (e) {
        const msg = `测试图生成失败 · ${e && e.message ? e.message : e}`;
        s.pushLog({ lv: 'err', cat: 'survey', msg });
        s.setCalReceipt({ tone: 'err', text: msg.length > 120 ? msg.slice(0, 120) + '…（详见控制台）' : msg });
      }
    };
    const pickManifest = async () => {
      try { const p = await pickFile('capture manifest (JSON/YAML)', ['json', 'yaml', 'yml']); if (p) { setManifestPath(p); setTab('offline'); } }
      catch (e) { s.pushLog({ lv: 'err', cat: 'survey', msg: `选择 manifest 失败 · ${e && e.message ? e.message : e}` }); }
    };
    const runBa = async () => {
      if (!manifestPath) { await pickManifest(); return; }
      setBaErr(null); setBaState('running'); setBaPct(0);
      try {
        const resp = await meshVisualReconstruct(proj.path, screenId, manifestPath, intr === 'auto' ? null : intr, null);
        jobRef.current = resp.job_id;
      } catch (e) {
        setBaState('idle'); setBaErr(e && e.message ? e.message : String(e));
        s.pushLog({ lv: 'err', cat: 'survey', msg: `BA 重建启动失败 · ${e && e.message ? e.message : e}` });
      }
    };

    return h('div', { className: 'gw-flow-body' }, h('div', { className: 'gw-flow' },
      h(Step, { n: 1, done: hasPattern, active: !hasPattern, title: '测试图',
        desc: '屏幕需显示 ChArUco 测试图后再拍摄。' },
        hasPattern
          ? h('div', { className: 'gw-fileref' }, h('span', { className: 'ic' }, h(Icon, { name: 'grid', size: 14 })),
              h('div', { className: 'm' }, h('div', { className: 'n' }, 'ChArUco'), h('div', { className: 'd' }, '已生成')))
          : h(Button, { variant: 'accent', size: 'S', icon: h(Icon, { name: 'plus', size: 13 }), onPress: genPattern }, '生成测试图')),
      h(Step, { n: 2, done: !!manifestPath, active: hasPattern && !manifestPath, title: '素材采集',
        desc: '离线导入照片 manifest，或现场实时采集。' },
        h('div', { className: 'gw-tabs2', style: { marginBottom: 10 } },
          h('button', { className: tab === 'offline' ? 'on' : '', onClick: () => setTab('offline') }, h(Icon, { name: 'folder', size: 13 }), '离线照片'),
          h('button', { className: tab === 'live' ? 'on' : '', onClick: () => setTab('live') }, h(Icon, { name: 'live', size: 13 }), '现场实时采集')),
        tab === 'offline'
          ? (manifestPath
              ? h('div', { className: 'gw-fileref' }, h('span', { className: 'ic' }, h(Icon, { name: 'doc', size: 14 })), h('div', { className: 'm' }, h('div', { className: 'n' }, manifestPath.split(/[\\/]/).pop())))
              : h('div', { className: 'gw-drop', onClick: pickManifest }, h(Icon, { name: 'folder', size: 20 }), h('div', null, '选择 capture manifest')))
          : h(Button, { variant: 'accent', size: 'S', icon: h(Icon, { name: 'camera', size: 13 }), onPress: () => s.setModal({ render: ({ close }) => window.VOLO_GRID_MODALS.liveCapture(s, close, (manifestP) => { setManifestPath(manifestP); setTab('offline'); }) }) }, '接入摄影机…')),
      h(Step, { n: 3, done: intr !== null, active: false, title: '标定',
        desc: '内参来源，无需操作即可继续。' },
        h('div', { className: 'gw-tabs2' },
          h('button', { className: intr === 'auto' ? 'on' : '', onClick: () => setIntr('auto') }, '自动标定'),
          h('button', { className: intr !== 'auto' ? 'on' : '', onClick: async () => { try { const p = await pickFile('相机内参 (YAML)', ['yaml', 'yml']); if (p) setIntr(p); } catch (e) {} } }, '外部内参'))),
      h(Step, { n: 4, active: true, title: '重建',
        desc: '开始视觉重建，完成后可在视口比对。' },
        baErr ? h('div', { style: { fontSize: 11.5, color: 'var(--negative-visual)', marginBottom: 8 } }, baErr) : null,
        baState === 'running'
          ? h('div', null, h('div', { style: { fontSize: 11.5, color: 'var(--chrome-dim)', marginBottom: 6 } }, (baStage || 'BA 重建中') + ' · ' + Math.round(baPct) + '%'),
              h('div', { className: 'vmeter vmeter--accent' }, h('div', { className: 'vmeter__fill', style: { width: baPct + '%' } })))
          : h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'cube3', size: 15 }), isDisabled: !hasPattern, onPress: runBa }, manifestPath ? '开始重建' : '选择 manifest 后开始'))));
  }

  function left(s) {
    if (s.calFlow) {
      return h(React.Fragment, null,
        h(FlowHead, { s, type: s.calFlow }),
        s.calFlow === 'totalstation' ? h(TotalStationFlow, { s }) : h(VisualFlow, { s }));
    }
    return h(Tree, { s });
  }

  window.VOLO_GRID = Object.assign(window.VOLO_GRID || {}, { left, flows: { total: (s) => h(TotalStationFlow, { s }), visual: (s) => h(VisualFlow, { s }) } });
})();
