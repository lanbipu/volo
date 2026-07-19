// @ts-nocheck
/* Volo — Calibrate page shared infra（网格校正新 IA · 2026-07）
   本文件不再自己装配 ctx/left/center/inspector——那份路由现在归 gridPages.tsx
   （在 index.tsx 里排在本文件之后加载，覆盖 window.VOLO_PAGES.calibrate）。
   这里只保留真实后端接线基础设施（projStore / CalController / openProjectPath /
   reloadRuns / pickAndOpenProject / pickAndSeedExample / rebuildMesh /
   setRunCurrentAction），挂在 window.VOLO_CAL2 上供 gridView/gridTree/gridInsp/
   gridModals/gridOverview 以及未受本轮影响的 calLens.tsx/calLensDialogs.tsx 取用。 */
import * as React from "react";
import "../ds";
import { pickFile, pickDirectory } from "../api/commands";
import { isTauri } from "../api/invoke";
import {
  loadProjectYaml, saveProjectYaml, listRecentProjects, addRecentProject, seedExampleProject,
  reconstructSurface, listRuns, getRunReport, setRunCurrent,
} from "../api/meshCommands";
import { meshVisualLoadScreenTransforms } from "../api/meshVisualCommands";
import { loadSolveDigestCached, peekSolveDigestCache } from "../api/visualSolveUi";
import { RMS_PX_THRESHOLDS } from "../api/lensCommands";

(function () {
  const { Button, Badge } = window.Spectrum2DesignSystem_b6d1b3;
  const { useState, useRef, useEffect, useSyncExternalStore } = React;
  const h = React.createElement;

  const RMS_THRESHOLDS = Object.freeze({ mm: [3, 8], px: [...RMS_PX_THRESHOLDS] });
  function rmsTone(rms, unit) {
    if (rms == null) return 'neutral';
    const lim = RMS_THRESHOLDS[unit || 'mm'] || RMS_THRESHOLDS.mm;
    return rms < lim[0] ? 'positive' : rms < lim[1] ? 'notice' : 'negative';
  }
  function rmsBadge(rms, unit) {
    unit = unit || 'mm';
    if (rms == null) return h(Badge, { variant: 'neutral', size: 'S' }, 'n/a');
    return h(Badge, { variant: rmsTone(rms, unit), size: 'S' }, rms.toFixed(2) + ' ' + unit);
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

  /* 打开新项目 / 返回总览共用的「清空派生视图态」——每次都建新对象，避免多次
     patch 共享同一个 runs: [] 数组引用。patternGenByScreen/visualSession 同
     measured/surveyReport 一样是会话内临时结果缓存（无对应 project.yaml 持久
     字段，见 pages/gridTree.tsx 顶部注释），切项目时一并清空。 */
  const derivedResetFields = () => ({
    measured: null, surveyReport: null, measurementsAbsPath: null, reconstruction: null, runs: [],
    patternGenByScreen: {}, patternStaleByScreen: {}, visualSession: null,
  });

  async function openProjectPath(absPath, s) {
    const config = await loadProjectYaml(absPath);
    try { localStorage.setItem(PROJ_LS_KEY, absPath); } catch (e) {}
    const screenIds = Object.keys(config.screens);
    const screenId = screenIds.includes(s.calActiveScreen) ? s.calActiveScreen : screenIds[0];
    if (screenId && screenId !== s.calActiveScreen) s.setCalActiveScreen(screenId);
    /* 同一项目内的「保存后回读」不清会话内派生缓存（测试图/测量/runs），
       否则每次保存屏幕设计都会丢测试图状态；只有真正切换项目才全量重置。 */
    const samePath = projStore.get().path === absPath;
    projStore.patch({ path: absPath, config, error: null, ...(samePath ? {} : derivedResetFields()) });
    if (window.camStore) window.camStore.loadFromProject(absPath, config);
    return config;
  }

  /** 读改写 project.yaml 的 cameras 列表（camStore 防抖落盘）。 */
  async function saveProjectCameras(absPath, cameras) {
    const latest = await loadProjectYaml(absPath);
    const next = Object.assign({}, latest, { cameras: cameras || [] });
    await saveProjectYaml(absPath, next);
    const samePath = projStore.get().path === absPath;
    if (samePath) projStore.patch({ config: next });
    return next;
  }

  /* 「返回项目总览」：回到未打开项目时的着陆页（Empty），只清视图态，不动
     PROJ_LS_KEY —— 下次启动仍自动续开最近项目，这里不是"关闭/遗忘项目"。 */
  function closeProject() {
    projStore.patch({ path: null, config: null, error: null, ...derivedResetFields() });
  }

  /* 刷新当前项目/屏幕的重建历史，并把最新一条 run 的完整报告（含真实顶点/quality_metrics）
     缓存为「当前网格」——Preview 页 / 概览条显示的是"最近一次重建"，不是重新计算。 */
  async function reloadRuns(projectPath, screenId) {
    const runs = await listRuns(projectPath, screenId);
    projStore.patch({ runs });
    if (runs.length) {
      const run = runs.find((r) => r.is_current) || runs[0];
      try {
        const report = await getRunReport(run.id);
        projStore.patch({ reconstruction: { run_id: run.id, surface: report.surface, quality_metrics: report.quality_metrics } });
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
    s.setCalSection('rebuild');
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
    const screenId = s.calActiveScreen;
    if (!proj.measurementsAbsPath) { s.pushLog({ lv: 'warn', cat: 'calibrate', msg: '重建失败 · 请先在测量导入中导入数据' }); return; }
    projStore.patch({ rebuilding: true });
    try {
      await s.runCmd({ domain: 'calibrate', action: '重建网格', target: screenId, chan: 'local' }, async () => {
        const result = await reconstructSurface(proj.path, screenId, proj.measurementsAbsPath);
        projStore.patch({ reconstruction: { run_id: result.run_id, surface: result.surface, quality_metrics: result.surface.quality_metrics } });
        await reloadRuns(proj.path, screenId);
        await reloadScreenReports(proj.path, proj.config, s);
        return result;
      }, { okMsg: (r) => `重建收敛 · run #${r.run_id} · estimated RMS ${r.surface.quality_metrics.estimated_rms_mm == null ? 'n/a' : r.surface.quality_metrics.estimated_rms_mm.toFixed(2) + ' mm'}` });
    } catch (e) { /* runCmd 已记录失败 */ } finally { projStore.patch({ rebuilding: false }); }
  }

  /* 「设为当前」（gridInsp.tsx 的 RunInsp / gridTree.tsx 的 run 节点菜单共用）：
     写库 + 刷新该屏的 runs 列表 + 刷新多屏视口摘要（is_current 变了）。 */
  async function setRunCurrentAction(s, proj, runId) {
    await s.runCmd({ domain: 'calibrate', action: '设为当前 run', target: 'run #' + runId, chan: 'local' },
      () => setRunCurrent(runId), { okMsg: () => `run #${runId} 已设为当前` });
    await reloadRuns(proj.path, s.calActiveScreen);
    await reloadScreenReports(proj.path, proj.config, s);
  }

  /** 相对项目根拼绝对路径（yaml solve_ref → 读 transforms）。 */
  function absUnderProject(projectPath, relOrAbs) {
    if (!relOrAbs) return null;
    const p = String(relOrAbs);
    if (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/')) return p;
    const sep = projectPath.indexOf('\\') >= 0 ? '\\' : '/';
    return projectPath.replace(/[\\/]+$/, '') + sep + p.replace(/^[\\/]+/, '');
  }

  /**
   * A6：当前 run digest 的 screen_transforms_path → 回填 visualSession；
   * yaml solve_ref 仅作后备。多独立联合组时只加载第一份，其余组回退名义摆放。
   * 已确定当前项目不需要联合 SE(3)（无 visual_solve / 无 solve_ref）时清除会话 transforms，
   * 避免切到全站仪/单屏后仍套用旧 SE(3)。不在 digest 加载完成前误清。
   */
  async function ensureScreenTransformsLoaded(projectPath, config, s, visualSolvePaths) {
    const st = projStore.get();
    let xfPath = null;
    const uniq = Array.from(new Set((visualSolvePaths || []).filter(Boolean)));
    for (let i = 0; i < uniq.length; i++) {
      const peeked = peekSolveDigestCache(uniq[i]);
      if (peeked && peeked.screen_transforms_path) {
        xfPath = peeked.screen_transforms_path;
        break;
      }
    }
    if (!xfPath && uniq.length) {
      const digests = await Promise.all(
        uniq.map((p) => loadSolveDigestCached(p, { pushLog: s.pushLog })),
      );
      for (let i = 0; i < digests.length; i++) {
        if (digests[i] && digests[i].screen_transforms_path) {
          xfPath = digests[i].screen_transforms_path;
          break;
        }
      }
    }
    if (!xfPath && config && config.rebuilt_alignment) {
      const groups = config.rebuilt_alignment.groups || [];
      for (let i = 0; i < groups.length; i++) {
        if (groups[i].solve_ref) {
          xfPath = absUnderProject(projectPath, groups[i].solve_ref);
          break;
        }
      }
    }
    if (!xfPath) {
      /* digest 已解析完毕（uniq 空或已 await），且无 solve_ref → 清除旧会话 SE(3) */
      if (st.visualSession
        && (st.visualSession.screenTransforms || st.visualSession.screenTransformsPath)) {
        projStore.patch({
          visualSession: Object.assign({}, st.visualSession, {
            screenTransformsPath: null,
            screenTransforms: null,
          }),
        });
      }
      return;
    }
    if (st.visualSession
      && st.visualSession.screenTransformsPath === xfPath
      && st.visualSession.screenTransforms) {
      return;
    }
    try {
      const transforms = await meshVisualLoadScreenTransforms(xfPath);
      projStore.patch({
        visualSession: Object.assign({}, st.visualSession || {}, {
          screenTransformsPath: xfPath,
          screenTransforms: transforms,
        }),
      });
    } catch (e) {
      s.pushLog({
        lv: 'warn',
        cat: 'survey',
        msg: `读取屏间变换失败 · ${e && e.message ? e.message : e}`,
      });
    }
  }

  /* 多屏视口：每屏当前 run 的 report + 回填联合屏间 SE(3)（A6）。 */
  async function reloadScreenReports(projectPath, config, s) {
    if (!config) { s.setCalScreenReports({}); return; }
    const screenIds = Object.keys(config.screens);
    const st = projStore.get();
    /* 激活屏优先复用 reloadRuns 刚写入的 reconstruction + runs（省 listRuns/getRunReport）。 */
    const entries = await Promise.all(screenIds.map(async (id) => {
      if (id === s.calActiveScreen && st.path === projectPath && st.reconstruction) {
        const run = (st.runs || []).find((r) => r.is_current) || (st.runs || [])[0];
        const solvePath = (run && run.visual_solve_path) || null;
        return [id, { surface: st.reconstruction.surface, quality_metrics: st.reconstruction.quality_metrics }, solvePath];
      }
      try {
        const runs = await listRuns(projectPath, id);
        if (!runs.length) return [id, null, null];
        const run = runs.find((r) => r.is_current) || runs[0];
        const report = await getRunReport(run.id);
        return [id, report, (run && run.visual_solve_path) || null];
      } catch (e) {
        s.pushLog({
          lv: 'warn',
          cat: 'calibrate',
          msg: `加载屏 ${id} 重建摘要失败 · ${e && e.message ? e.message : e}`,
        });
        return [id, null, null];
      }
    }));
    const next = {};
    const visualSolvePaths = [];
    entries.forEach(([id, report, solvePath]) => {
      if (report) next[id] = report;
      if (solvePath) visualSolvePaths.push(solvePath);
    });
    s.setCalScreenReports(next);
    await ensureScreenTransformsLoaded(projectPath, config, s, visualSolvePaths);
  }

  /* 常驻控制器：随 center() 挂载（不随 calSection 切换卸载/重挂），负责首次自动打开
     最近项目 + 项目/屏幕变化时刷新 runs 列表 + 多屏视口摘要。渲染 null，无可见 UI。 */
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
      reloadRuns(proj.path, s.calActiveScreen).catch((e) => {
        s.pushLog({ lv: 'err', cat: 'calibrate', msg: `加载重建记录失败 · ${e && e.message ? e.message : e}` });
      });
    }, [proj.path, s.calActiveScreen]);
    useEffect(() => {
      if (!proj.path || !proj.config) return;
      reloadScreenReports(proj.path, proj.config, s).catch((e) => {
        s.pushLog({ lv: 'err', cat: 'calibrate', msg: `加载多屏重建摘要失败 · ${e && e.message ? e.message : e}` });
      });
    }, [proj.path, proj.config]);
    return null;
  }

  /* 导航项「阻断」判定 —— 唯一真实作用是给 nav-i 加 is-blocked 样式 + 禁用点击；
     设计稿里区分 done/ready 的三色 NavDot 组件从未被任何页面实际调用（失效代码），
     ctx/left/center/inspector 路由本身也已随新 IA 移交 gridPages.tsx（见文件头注释），
     这里不再定义。 */

  /* 共享给各 grid_*.tsx / calLens.tsx/calLensDialogs.tsx：状态原子 + 项目基础设施 */
  window.VOLO_CAL2 = Object.assign(window.VOLO_CAL2 || {}, {
    Pill, RMS_THRESHOLDS, rmsTone, rmsBadge, confBadge, statusPill, inspEmpty, CalController,
    useProj, projStore, openProjectPath, closeProject, reloadRuns, reloadScreenReports,
    pickAndOpenProject, pickAndSeedExample, rebuildMesh, viewRunInPreview, setRunCurrentAction, PROJ_LS_KEY,
    saveProjectCameras,
  });
})();
