// @ts-nocheck
/* Volo — Calibrate page shell（重构 · 新 IA）
   1:1 port of the Claude Design handoff `src/cal2_pages.jsx`.
   概览 / 网格校正折叠组[屏幕与设计·测量导入·重建与预览·历史与导出] / 镜头校正。
   仪表盘语言沿用缓存页（land-status / dash-card / kpi / diag / spill 三通道）。

   本文件是「骨架」：ctx 栏 · 左栏导航 · center/inspector 路由 · 共享原子（挂 window.VOLO_CAL2）。
   同时保留旧 pages/calibrate.tsx 的全部真实后端接线基础设施（projStore / CalController /
   deriveScreens / openProjectPath / reloadRuns / pickAndOpenProject / pickAndSeedExample /
   rebuildMesh）——各 leaf 页（calOverview/calDesign/calSurvey/calPreview/calHistory）通过
   window.VOLO_CAL2 取用，而不是各自重新发明一套项目状态管理。 */
import * as React from "react";
import "../ds";
import { pickFile, pickDirectory } from "../api/commands";
import { isTauri } from "../api/invoke";
import {
  loadProjectYaml, listRecentProjects, addRecentProject, seedExampleProject,
  reconstructSurface, listRuns, getRunReport,
} from "../api/meshCommands";

(function () {
  const { Button, Badge } = window.Spectrum2DesignSystem_b6d1b3;
  const { useState, useRef, useEffect, useSyncExternalStore } = React;
  const h = React.createElement;

  function rmsBadge(rms, unit) {
    unit = unit || 'mm';
    if (rms == null) return h(Badge, { variant: 'neutral', size: 'S' }, 'n/a');
    const lim = unit === 'px' ? [1, 2] : [3, 8];
    const v = rms < lim[0] ? 'positive' : rms < lim[1] ? 'notice' : 'negative';
    return h(Badge, { variant: v, size: 'S' }, rms.toFixed(2) + ' ' + unit);
  }
  function confBadge(c) {
    const m = CAL_CONF[c] || CAL_CONF.medium;
    return h('span', { className: 'cap-pill cap-pill--' + m.tone }, h(Icon, { name: m.tone === 'positive' ? 'check' : 'alert', size: 12 }), m.label);
  }
  function statusPill(map, key) {
    const m = map[key] || Object.values(map)[0];
    return h('span', { className: 'spill spill--' + m.tone },
      m.icon === 'minus' ? h('span', { style: { fontWeight: 700 } }, '—') : h(Icon, { name: m.icon, size: 12 }), m.label);
  }
  function Pill({ tone, icon, children, lg }) {
    return h('span', { className: 'cap-pill cap-pill--' + tone + (lg ? ' is-lg' : '') },
      icon ? h(Icon, { name: icon, size: lg ? 15 : 13 }) : null, h('span', null, children));
  }
  function inspEmpty(msg) {
    return h('div', { className: 'insp-empty' },
      h('div', { className: 'ph' }, h(Icon, { name: 'target', size: 30 })),
      h('div', null, h('div', { style: { color: 'var(--chrome-dim)', fontWeight: 600, marginBottom: 4 } }, '未选择对象'), msg));
  }

  /* =================== project store（W2 起沿用，未改动） ===================
     ctx/left/center/inspector 各是 shell.tsx App 内独立的 h(Slot,{render}) 调用——
     hooks 状态互不共享（各自独立 fiber）。不把整份 ProjectConfig/测量/重建数据塞进
     shell 的 App state，改用模块级 useSyncExternalStore store，各 Slot 开头无条件
     调用一次 useProj() 订阅，同步当前项目状态。 */
  const PROJ_LS_KEY = 'volo-calibrate-project-path';
  const projStore = (() => {
    let st = {
      path: null, recent: [], config: null, loading: true, error: null,
      measured: null, surveyReport: null, measurementsAbsPath: null, reconstruction: null, runs: [],
      rebuilding: false,
    };
    const listeners = new Set();
    const notify = () => listeners.forEach((l) => l());
    return {
      get: () => st,
      patch: (p) => { st = { ...st, ...p }; notify(); },
      subscribe: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    };
  })();
  function useProj() { return useSyncExternalStore(projStore.subscribe, projStore.get); }

  /* ScreenConfig.cabinet_count = [cols, rows]（cabinet 网格；顶点网格是 (cols+1)×(rows+1)）。
     screen 无独立显示名字段 —— 用 screen_id 本身当 name（无 Volume 分组概念）。 */
  function deriveScreens(config) {
    if (!config) return [];
    return Object.keys(config.screens).map((id) => {
      const sc = config.screens[id];
      const cols = sc.cabinet_count[0], rows = sc.cabinet_count[1];
      return { id, name: id, cols, rows, panels: cols * rows, shape_mode: sc.shape_mode };
    });
  }
  const scr = (s) => { const list = deriveScreens(projStore.get().config); return list.find((x) => x.id === s.calScreen) || list[0] || { id: '', name: '—', cols: 1, rows: 1, shape_mode: 'rectangular' }; };

  async function openProjectPath(absPath, s) {
    const config = await loadProjectYaml(absPath);
    try { localStorage.setItem(PROJ_LS_KEY, absPath); } catch (e) {}
    const screenIds = Object.keys(config.screens);
    const screenId = screenIds.includes(s.calScreen) ? s.calScreen : screenIds[0];
    if (screenId && screenId !== s.calScreen) s.setCalScreen(screenId);
    projStore.patch({ path: absPath, config, error: null,
      measured: null, surveyReport: null, measurementsAbsPath: null, reconstruction: null, runs: [] });
    return config;
  }

  /* 刷新当前项目/屏幕的重建历史，并把最新一条 run 的完整报告（含真实顶点/quality_metrics）
     缓存为「当前网格」——Preview 页 / 概览条显示的是"最近一次重建"，不是重新计算。 */
  async function reloadRuns(projectPath, screenId) {
    const runs = await listRuns(projectPath, screenId);
    projStore.patch({ runs });
    if (runs.length) {
      try {
        const report = await getRunReport(runs[0].id);
        projStore.patch({ reconstruction: { run_id: runs[0].id, surface: report.surface, quality_metrics: report.quality_metrics } });
      } catch (e) { projStore.patch({ reconstruction: null }); /* 历史 report_json 可能已被移动/删除 */ }
    } else {
      projStore.patch({ reconstruction: null });
    }
  }

  async function pickAndOpenProject(s) {
    let yamlPath;
    try { yamlPath = await pickFile('Project Config (project.yaml)', ['yaml', 'yml']); }
    catch (e) { s.pushLog({ lv: 'err', cat: 'calibrate', msg: `选择工程文件失败 · ${e && e.message ? e.message : e}` }); return; }
    if (!yamlPath) return;
    const dir = yamlPath.replace(/[\\/][^\\/]*$/, '');
    try {
      await s.runCmd({ domain: 'calibrate', action: '打开项目', target: dir, chan: 'local' }, async () => {
        const config = await openProjectPath(dir, s);
        const rec = await addRecentProject(dir, (config.project && config.project.name) || dir.split(/[\\/]/).pop());
        projStore.patch({ recent: [rec, ...projStore.get().recent.filter((r) => r.abs_path !== dir)] });
        return config;
      }, { okMsg: (c) => `已打开项目 <b>${(c.project && c.project.name) || dir}</b>` });
    } catch (e) { /* runCmd 已记日志 + 任务抽屉 */ }
  }

  async function pickAndSeedExample(s, example) {
    let targetDir;
    try { targetDir = await pickDirectory(); }
    catch (e) { s.pushLog({ lv: 'err', cat: 'calibrate', msg: `选择目标目录失败 · ${e && e.message ? e.message : e}` }); return; }
    if (!targetDir) return;
    try {
      await s.runCmd({ domain: 'calibrate', action: '创建示例项目', target: example, chan: 'local' }, async () => {
        const outDir = await seedExampleProject(targetDir, example);
        const config = await openProjectPath(outDir, s);
        const rec = await addRecentProject(outDir, (config.project && config.project.name) || example);
        projStore.patch({ recent: [rec, ...projStore.get().recent.filter((r) => r.abs_path !== outDir)] });
        return config;
      }, { okMsg: (c) => `已创建示例项目 <b>${(c.project && c.project.name) || example}</b>` });
    } catch (e) { /* 同上 */ }
  }

  /* 「在预览中查看」（历史表 / inspector 均会调）：Preview 页读的是 store 里的
     reconstruction，而 reloadRuns 只会把它设成最新一条 run —— 跳转前必须先把
     用户选中的这条 run 的完整报告 patch 进去，否则 Preview 显示的是错误的网格。 */
  async function viewRunInPreview(s, proj, runId) {
    s.setCalSel({ type: 'run', id: runId });
    s.setCalNav('preview');
    if (proj.reconstruction && proj.reconstruction.run_id === runId) return;
    try {
      const report = await getRunReport(runId);
      projStore.patch({ reconstruction: { run_id: runId, surface: report.surface, quality_metrics: report.quality_metrics } });
    } catch (e) { s.pushLog({ lv: 'err', cat: 'calibrate', msg: `加载 run #${runId} 报告失败 · ${e && e.message ? e.message : e}` }); }
  }

  /* 「重建」→ reconstruct_surface：需要 Survey 步已导入的 measurementsAbsPath；
     成功后把 surface 直接写入 store，再 reloadRuns 刷新历史。 */
  async function rebuildMesh(s, proj) {
    if (!proj.path || proj.rebuilding) return;
    const screenId = s.calScreen;
    if (!proj.measurementsAbsPath) { s.pushLog({ lv: 'warn', cat: 'calibrate', msg: '重建失败 · 请先在测量导入中导入数据' }); return; }
    projStore.patch({ rebuilding: true });
    try {
      await s.runCmd({ domain: 'calibrate', action: '重建网格', target: screenId, chan: 'local' }, async () => {
        const result = await reconstructSurface(proj.path, screenId, proj.measurementsAbsPath);
        projStore.patch({ reconstruction: { run_id: result.run_id, surface: result.surface, quality_metrics: result.surface.quality_metrics } });
        await reloadRuns(proj.path, screenId);
        return result;
      }, { okMsg: (r) => `重建收敛 · run #${r.run_id} · estimated RMS ${r.surface.quality_metrics.estimated_rms_mm == null ? 'n/a' : r.surface.quality_metrics.estimated_rms_mm.toFixed(2) + ' mm'}` });
    } catch (e) { /* runCmd 已记录失败 */ } finally { projStore.patch({ rebuilding: false }); }
  }

  /* 常驻控制器：随 center() 挂载（不随 calNav 切换卸载/重挂），负责首次自动打开
     最近项目 + 项目/屏幕变化时刷新 runs 列表。渲染 null，无可见 UI。 */
  function CalController({ s }) {
    const proj = useProj();
    useEffect(() => {
      if (!isTauri()) { projStore.patch({ loading: false }); return; } /* 浏览器预览无后端，留空态 */
      listRecentProjects().then((recent) => {
        const savedPath = (() => { try { return localStorage.getItem(PROJ_LS_KEY); } catch (e) { return null; } })();
        const openPath = (savedPath && recent.some((r) => r.abs_path === savedPath)) ? savedPath : (recent[0] && recent[0].abs_path);
        projStore.patch({ recent, loading: false });
        if (openPath) {
          openProjectPath(openPath, s).catch((e) => projStore.patch({ error: e && e.message ? e.message : String(e) }));
        }
      }).catch((e) => { projStore.patch({ loading: false, error: e && e.message ? e.message : String(e) }); });
    }, []);
    useEffect(() => {
      if (!proj.path) return;
      projStore.patch({ measured: null, surveyReport: null, measurementsAbsPath: null });
      reloadRuns(proj.path, s.calScreen).catch((e) => {
        s.pushLog({ lv: 'err', cat: 'calibrate', msg: `加载重建记录失败 · ${e && e.message ? e.message : e}` });
      });
    }, [proj.path, s.calScreen]);
    return null;
  }

  /* 导航项「阻断」判定 —— 唯一真实作用是给 nav-i 加 is-blocked 样式 + 禁用点击；
     设计稿里区分 done/ready 的三色 NavDot 组件从未被 left() 实际调用（失效代码），
     故这里只需要算出「是否阻断」，不必伪造 done/ready 的精细语义。 */
  function navBlocked(proj) {
    const open = !!proj.path;
    return {
      overview: false, design: !open, survey: !open, preview: !open, history: !open, lens: !open,
    };
  }

  /* =================== ctx 栏 =================== */
  function ctx(s) {
    const ar = s.calStageType === 'ar';
    const stTabs = [{ id: 'led', label: 'LED', icon: 'panel' }, { id: 'ar', label: 'AR', icon: 'cube' }];
    const seg = h('div', { className: 'ctxnav cal2-stageseg', style: { flex: '0 0 auto' } },
      stTabs.map((c) => {
        const on = (ar ? 'ar' : 'led') === c.id;
        return h('div', {
          key: c.id, className: 'ctxnav-i' + (on ? ' on' : ''),
          title: on ? (s.leftCollapsed ? '展开左侧导航' : '收起左侧导航') : undefined,
          onClick: () => {
            if (!on) { s.setCalStageType(c.id); s.setLeftCollapsed(false); }
            else { s.setLeftCollapsed((v) => !v); }
          },
        },
          h('span', { className: 'ctxnav-ico' }, h(Icon, { name: c.icon, size: 16 })),
          h('span', null, c.label),
          c.id === 'ar' ? h('span', { className: 'cal2-stageseg-wip' }, 'WIP') : null,
          on ? h('span', { className: 'ctxnav-caret', style: { transform: s.leftCollapsed ? 'none' : 'rotate(180deg)' } }, h(Icon, { name: 'chevr', size: 12 })) : null);
      }));
    return h(React.Fragment, null,
      seg,
      h('div', { className: 'ctx-div' }),
      h('div', { style: { flex: 1 } }),
      h('button', { className: 'paneltgl cal2-capbtn2', onClick: () => window.VOLO_CAL2.openCaptureModal(s), title: '命名采集配置（Profile）' },
        h(Icon, { name: 'camera', size: 15 }), h('span', null, '采集设置')));
  }

  /* =================== 左栏 · 新 IA =================== */
  function left(s) {
    const proj = useProj();
    if (s.calStageType === 'ar') return arLeft(s);
    const blocked = navBlocked(proj);
    const leaf = (id, icon, label, sub) => h('div', {
      key: id, className: 'nav-i nav-mod cal2-nav' + (s.calNav === id ? ' on' : '') + (blocked[id] ? ' is-blocked' : ''),
      onClick: () => { if (!blocked[id]) s.setCalNav(id); },
    },
      h('span', { className: 'nav-ico' }, h(Icon, { name: icon, size: 17 })),
      h('span', { className: 'nav-lbl' }, label),
      sub ? h('span', { className: 'nav-sub' }, sub) : null);
    const child = (id, icon, label) => h('div', {
      key: id, className: 'nav-i nav-child cal2-nav' + (s.calNav === id ? ' on' : '') + (blocked[id] ? ' is-blocked' : ''),
      onClick: () => { if (!blocked[id]) s.setCalNav(id); },
    },
      h('span', { className: 'nav-ico' }, h(Icon, { name: icon, size: 15 })),
      h('span', { className: 'nav-lbl' }, label));
    const meshBuilt = !!proj.reconstruction;
    return h(React.Fragment, null,
      h('div', { className: 'sect' },
        h('div', { className: 'sect-h' }, h('span', { className: 't' }, 'LED · 校正')),
        leaf('overview', 'grid', '概览', 'LED'),
        h('div', { className: 'nav-i nav-mod nav-head cal2-grouphd', onClick: () => s.setCalGridOpen((v) => !v) },
          h('span', { className: 'nav-ico' }, h(Icon, { name: 'cube', size: 17 })),
          h('span', { className: 'nav-lbl' }, '网格校正'),
          h('span', { className: 'cal2-caret', style: { transform: s.calGridOpen ? 'none' : 'rotate(-90deg)' } }, h(Icon, { name: 'chevd', size: 14 }))),
        s.calGridOpen ? h('div', { className: 'nav-children' },
          child('design', 'panel', '屏幕与设计'),
          child('survey', 'pin', '测量导入'),
          child('preview', 'cube3', '重建与预览'),
          child('history', 'list', '历史与导出')) : null,
        leaf('lens', 'camera', '镜头校正', 'Lens')),
      proj.path ? h('div', { className: 'sect', style: { marginTop: 'auto' } },
        h('div', { className: 'farm-roll' },
          h('div', { className: 'top' }, h('span', null, '网格重建'), h('span', null, meshBuilt ? '已重建' : '未重建')),
          h('div', { className: 'vmeter vmeter--' + (meshBuilt ? 'positive' : 'neutral') }, h('div', { className: 'vmeter__fill', style: { width: meshBuilt ? '100%' : '0%' } })),
          h('div', { className: 'top', style: { marginTop: 10 } }, h('span', null, '镜头校正'), h('span', null, s.calLensState === 'done' ? '已校正' : s.calLensState === 'running' ? '运行中' : '未运行')),
          h('div', { className: 'vmeter vmeter--' + (s.calLensState === 'done' ? 'positive' : 'neutral') }, h('div', { className: 'vmeter__fill', style: { width: s.calLensState === 'done' ? '100%' : s.calLensState === 'running' ? '50%' : '0%' } })))) : null);
  }

  /* AR 分支左栏 —— 本批仅占位（见 arCenter 说明） */
  function arLeft(s) {
    return h('div', { className: 'sect' },
      h('div', { className: 'sect-h' }, h('span', { className: 't' }, 'AR · 舞台校正')),
      h('div', { className: 'nav-i nav-mod is-blocked' },
        h('span', { className: 'nav-ico' }, h(Icon, { name: 'cube', size: 17 })),
        h('span', { className: 'nav-lbl' }, '空间校正'),
        h('span', { className: 'nav-tag' }, 'WIP')));
  }

  /* =================== center 路由 =================== */
  function center(s) {
    const CAL2 = window.VOLO_CAL2 || {};
    const proj = useProj();
    if (s.calStageType === 'ar') return h(React.Fragment, null, h(CalController, { s }), arCenter());
    if (!proj.path) return h(React.Fragment, null, h(CalController, { s }), CAL2.Overview ? h(CAL2.Overview, { s }) : null);
    let body;
    switch (s.calNav) {
      case 'design':  body = CAL2.Design ? h(CAL2.Design, { s }) : null; break;
      case 'survey':  body = CAL2.Survey ? h(CAL2.Survey, { s }) : null; break;
      case 'preview': body = CAL2.Preview ? h(CAL2.Preview, { s }) : null; break;
      case 'history': body = CAL2.History ? h(CAL2.History, { s }) : null; break;
      case 'lens':    body = CAL2.Lens ? h(CAL2.Lens, { s }) : null; break;
      default:        body = CAL2.Overview ? h(CAL2.Overview, { s }) : null;
    }
    return h(React.Fragment, null, h(CalController, { s }), body);
  }
  function arCenter() {
    return h('div', { className: 'dash' },
      h('div', { className: 'cluster-empty' },
        h('div', { className: 'ce-ico' }, h(Icon, { name: 'cube', size: 36, stroke: 1.3 })),
        h('div', { className: 'ce-t' }, 'AR 舞台校正 · 建设中'),
        h('div', { className: 'ce-d' }, '本批仅交付 LED 网格重建 → 镜头校正流程。AR（无 LED 屏、实景叠加）的空间求解 / 延迟校准 / 验证叠加将在后续批次展开。'),
        h('div', { className: 'ce-acts' },
          h(Button, { variant: 'secondary', size: 'M', icon: h(Icon, { name: 'arrowr', size: 15 }), isDisabled: true }, '敬请期待'))));
  }

  /* =================== inspector 路由 =================== */
  function inspector(s) {
    const CAL2 = window.VOLO_CAL2 || {};
    const proj = useProj();
    /* 无条件调用（同 useProj）：lensInspector 是纯函数，不在内部调用 hook —— Lens
       画面（calLens.tsx）与这里是外壳里两棵独立 Slot fiber，互不共享 hooks，实时数据
       靠这个模块级 store 快照跨 fiber 传递。放在 calNav 分支判断之前，任何 render
       都固定调用一次，Rules of Hooks 意义上等价于上面的 useProj()。 */
    const lensLive = CAL2.useLensLive();
    if (s.calStageType === 'ar') return inspEmpty('AR 校正建设中');
    if (!proj.path) return inspEmpty('打开项目后可查看细节');
    if (s.calNav === 'design' && CAL2.designInspector) return CAL2.designInspector(s);
    if (s.calNav === 'survey' && CAL2.surveyInspector) return CAL2.surveyInspector(s, proj);
    if (s.calNav === 'history' && CAL2.historyInspector) return CAL2.historyInspector(s, proj);
    if (s.calNav === 'lens' && CAL2.lensInspector) return CAL2.lensInspector(s, lensLive);
    return inspEmpty('选择对象查看细节');
  }

  /* 共享给 leaf 页：状态原子 + 项目基础设施 */
  window.VOLO_CAL2 = Object.assign(window.VOLO_CAL2 || {}, {
    Pill, rmsBadge, confBadge, statusPill, inspEmpty, scr,
    useProj, projStore, deriveScreens, openProjectPath, reloadRuns,
    pickAndOpenProject, pickAndSeedExample, rebuildMesh, viewRunInPreview, PROJ_LS_KEY,
  });
  window.VOLO_PAGES = window.VOLO_PAGES || {};
  window.VOLO_PAGES.calibrate = { ctx, left, center, inspector };
})();
