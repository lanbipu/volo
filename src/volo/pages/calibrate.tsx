// @ts-nocheck
/* Volo — Calibrate page (LED mesh reconstruct → lens solve).
   1:1 port of the Claude Design handoff `src/page_calibrate.jsx`. */
import * as React from "react";
import "../ds";
import { spawnSidecar, spawnSidecarStreaming, useSidecarStream } from "../api/sidecarStream";
import { pickFile, pickDirectory, revealPath } from "../api/commands";
import { isTauri } from "../api/invoke";
import {
  loadProjectYaml, saveProjectYaml, listRecentProjects, addRecentProject, seedExampleProject,
  loadMeasurementsYaml, importTotalStationCsv, reconstructSurface, listRuns, getRunReport,
  exportObj, generateInstructionCard, saveInstructionPdf,
} from "../api/meshCommands";

(function () {
  const { Button, Badge, InlineAlert } = window.Spectrum2DesignSystem_b6d1b3;
  const { useState, useEffect, useRef, useLayoutEffect, useSyncExternalStore } = React;
  const h = React.createElement;

  const ROLE = {
    origin:   { label: 'origin',   short: 'O',  color: 'var(--positive-visual)' },
    x_axis:   { label: 'x_axis',   short: 'X',  color: 'var(--volo-700)' },
    xy_plane: { label: 'xy_plane', short: 'XY', color: 'var(--informative-visual)' },
  };
  const CAB_STATE = { normal: '正常', masked: '遮罩', below: '基线以下', ref: '参考点' };
  const SEVCAL = {
    healthy:  { visual: 'positive', icon: 'check' },
    warning:  { visual: 'notice',   icon: 'alert' },
    critical: { visual: 'negative', icon: 'alert' },
  };

  function rmsBadge(rms) {
    if (rms == null) return h(Badge, { variant: 'neutral', size: 'S' }, 'n/a');
    const v = rms < 3 ? 'positive' : rms < 8 ? 'notice' : 'negative';
    return h(Badge, { variant: v, size: 'S' }, rms.toFixed(2) + ' mm');
  }

  /* =================== project store (W2: Calibrate mesh 接线) ===================
     ctx/left/center/inspector 各是 shell.tsx App 内独立的 h(Slot,{render}) 调用——
     hooks 状态互不共享（各自独立 fiber）。不把整份 ProjectConfig/测量/重建数据塞进
     shell 的 App state（改动面太大，且 Cache 域已用同模式管 machines/creds/shares，
     这里数据形状差异很大，硬塞进去不合适）——改用模块级 useSyncExternalStore store，
     4 个 Slot 各自在自己开头无条件调用一次 useProj() 订阅，同步当前项目状态。
     TODO(Claude Design): 项目切换/最近项目 UI 目前只在「无项目」空态出现，无常驻切换入口。 */
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
     screen 无独立显示名字段 —— 用 screen_id 本身当 name（无 Volume 分组概念）。
     TODO(Claude Design): 屏幕若需要中文显示名 / Volume 分组，需要新字段，此处忠实反映现状。 */
  function deriveScreens(config) {
    if (!config) return [];
    return Object.keys(config.screens).map((id) => {
      const sc = config.screens[id];
      const cols = sc.cabinet_count[0], rows = sc.cabinet_count[1];
      return { id, name: id, cols, rows, panels: cols * rows };
    });
  }

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
     缓存为「当前网格」——Preview 步 / overview band 显示的是"最近一次重建"，不是重新计算。 */
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
    } catch (e) { /* runCmd 已记日志 + 任务抽屉，这里只吞掉 rethrow 避免 unhandled rejection */ }
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

  /* 常驻控制器：随 center() 挂载（不随 calStep 切换卸载/重挂），负责首次自动打开
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

  function projectEmptyState(s, proj) {
    const examples = ['curved-flat', 'curved-arc', 'monitor-bench'];
    return h('div', { className: 'hatch dark', style: { minHeight: 420 } },
      h('div', { className: 'hi' },
        h('span', { className: 'hic' }, h(Icon, { name: 'folder', size: 28 })),
        h('span', { className: 'ht' }, proj.error ? '加载项目失败' : '未打开项目'),
        h('span', { className: 'hd' }, proj.error || '打开一个已有工程，或从内置示例创建一份用于探索。'),
        h('div', { style: { display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap', justifyContent: 'center' } },
          h(Button, { variant: 'accent', size: 'S', icon: h(Icon, { name: 'folder', size: 15 }), onPress: () => pickAndOpenProject(s) }, '打开项目'),
          examples.map((ex) => h(Button, { key: ex, variant: 'secondary', size: 'S', icon: h(Icon, { name: 'cube', size: 14 }),
            onPress: () => pickAndSeedExample(s, ex) }, '示例 · ' + ex))),
        proj.recent.length ? h('div', { style: { marginTop: 18, width: '100%', maxWidth: 440 } },
          h('div', { className: 'surv-sub', style: { marginTop: 0 } }, '最近项目'),
          proj.recent.slice(0, 5).map((r) => h('div', { key: r.id, className: 'out-item', onClick: () =>
            openProjectPath(r.abs_path, s).catch((e) => projStore.patch({ error: e && e.message ? e.message : String(e) })) },
            h('span', { className: 'out-ico' }, h(Icon, { name: 'doc', size: 15 })),
            h('div', { className: 'out-main' }, h('div', { className: 'out-t' }, r.display_name), h('div', { className: 'out-s' }, r.abs_path))))) : null));
  }

  /* =================== context toolbar =================== */
  /* 重建 / 导出 / 生成指导卡 三个按钮已移除（导出 / 生成指导卡 迁至左侧导航「输出」），
     仅保留居中显示的「屏幕」选择器 */
  function ctx(s) {
    const proj = useProj();
    const screens = deriveScreens(proj.config);
    return h(React.Fragment, null,
      h(CtxTitle, { icon: 'calibrate', title: 'Calibrate', sub: 'LED 网格重建 → 镜头校正' }),
      h('div', { className: 'ctx-center' },
        screens.length ? h(Selector, { kpre: '屏幕', value: s.calScreen, width: 196,
          options: screens.map((x) => ({ id: x.id, label: x.name, sub: `${x.cols}×${x.rows} · ${x.panels} 面板` })),
          onChange: s.setCalScreen }) : h('span', { className: 'toolchip' }, proj.loading ? '加载中…' : '未打开项目')));
  }

  /* =================== left: workflow =================== */
  function StepItem({ st, s }) {
    const isCur = s.calStep === st.id;
    const done = st.status === 'done';
    const cls = 'cstep' + (isCur ? ' on' : '') + (done ? ' done' : '');
    const statusTxt = done ? '已完成' : st.status === 'active' ? '进行中' : st.status === 'ready' ? '可用' : '待运行';
    return h('div', { key: st.id, className: cls, onClick: () => s.setCalStep(st.id) },
      h('span', { className: 'cstep-ico' }, done ? h(Icon, { name: 'check', size: 13 }) : st.n),
      h('div', { className: 'cstep-main' },
        h('div', { className: 'cstep-t' }, st.label, h('span', { className: 'cn' }, ' · ' + st.cn)),
        h('div', { className: 'cstep-s' }, statusTxt),
        isCur ? h('div', { className: 'step-d' }, STEP_DETAIL[st.id]) : null));
  }
  const STEP_DETAIL = {
    design: '编辑 Cabinet 网格 — 遮罩、基线与参考点，定义重建范围与坐标系',
    method: '选择重建方法：M1 全站仪 或 M2 视觉（ChArUco + BA）',
    survey: '导入测量数据并核对：measured / fabricated / outlier / missing',
    preview: '检查重建网格 — 拓扑、顶点与质量偏差，旋转查看曲率',
    runs: '历史重建记录，按 RMS 与目标筛选，可展开报告',
    lens: '镜头校正：Validate → Detect → Solve → Report（7-DOF 变换）',
  };

  /* 左侧导航「输出」列表项 — 由原顶部工具栏的「导出 / 生成指导卡」迁入 */
  function OutItem({ icon, label, sub, onClick }) {
    return h('div', { className: 'out-item', onClick },
      h('span', { className: 'out-ico' }, h(Icon, { name: icon, size: 15 })),
      h('div', { className: 'out-main' },
        h('div', { className: 'out-t' }, label),
        h('div', { className: 'out-s' }, sub)));
  }

  function left(s) {
    const proj = useProj();
    const mesh = CAL_STEPS.filter((x) => x.group === 'mesh');
    const lens = CAL_STEPS.filter((x) => x.group === 'lens');
    const runId = proj.reconstruction && proj.reconstruction.run_id;
    /* TODO(Claude Design): 导出目标目前用 3 个固定 OutItem 平铺，无下拉/弹层选择器。 */
    const exportTargets = [['disguise', 'Disguise'], ['unreal', 'Unreal'], ['neutral', 'Neutral']];
    const doExport = (target) => {
      if (!runId) { s.pushLog({ lv: 'warn', cat: 'calibrate', msg: '导出失败 · 当前屏幕尚无重建记录' }); return; }
      s.runCmd({ domain: 'calibrate', action: '导出网格', target, chan: 'local' },
        () => exportObj(runId, target, null),
        { okMsg: (p) => `导出完成 → <b>${p}</b>` }).catch(() => {});
    };
    const doInstructionCard = async () => {
      if (!proj.path) { s.pushLog({ lv: 'warn', cat: 'calibrate', msg: '生成指导卡失败 · 尚未打开项目' }); return; }
      const screenId = s.calScreen;
      let dir;
      try { dir = await pickDirectory(); } catch (e) { s.pushLog({ lv: 'err', cat: 'calibrate', msg: `选择保存目录失败 · ${e && e.message ? e.message : e}` }); return; }
      if (!dir) return;
      const dst = dir.replace(/[\\/]+$/, '') + '/' + screenId + '_instruction_card.pdf';
      s.runCmd({ domain: 'calibrate', action: '生成指导卡', target: screenId, chan: 'local' }, async () => {
        const card = await generateInstructionCard(proj.path, screenId);
        s.pushLog({ lv: 'info', cat: 'calibrate', msg: `指导卡 HTML 已生成（${card.htmlContent.length} 字符）` });
        return saveInstructionPdf(proj.path, screenId, dst);
      }, { okMsg: (p) => `指导卡已保存 → <b>${p}</b>` }).catch(() => {});
    };
    return h(React.Fragment, null,
      h('div', { className: 'sect' },
        h('div', { className: 'sect-h' }, h('span', { className: 't' }, '网格重建')),
        h('div', { className: 'cal-list' }, mesh.map((st) => h(StepItem, { key: st.id, st, s })))),
      h('div', { className: 'sect' },
        h('div', { className: 'sect-h' }, h('span', { className: 't' }, '镜头校正')),
        h('div', { className: 'cal-list' }, lens.map((st) => h(StepItem, { key: st.id, st, s })))),
      h('div', { className: 'sect' },
        h('div', { className: 'sect-h' }, h('span', { className: 't' }, '输出')),
        h('div', { className: 'cal-list' },
          exportTargets.map(([t, label]) => h(OutItem, { key: t, icon: 'download', label: '导出 · ' + label,
            sub: runId ? `run #${runId} → .obj` : '需先完成重建', onClick: () => doExport(t) })),
          h(OutItem, { icon: 'doc', label: '生成指导卡', sub: 'PDF · 选择保存目录', onClick: doInstructionCard }))),
      h('div', { className: 'sect', style: { marginTop: 'auto' } },
        h('div', { className: 'farm-roll' },
          h('div', { className: 'top' }, h('span', null, '重建进度'), h('span', null, '4 / 5')),
          h('div', { className: 'vmeter vmeter--accent' }, h('div', { className: 'vmeter__fill', style: { width: '80%' } })),
          h('div', { className: 'top', style: { marginTop: 10 } }, h('span', null, '镜头校正'), h('span', null, '未运行')),
          h('div', { className: 'vmeter vmeter--neutral' }, h('div', { className: 'vmeter__fill', style: { width: '0%' } })))));
  }

  /* =================== Design: cabinet editor =================== */
  /* 真实数据映射（W2 item 3）：
     - masked ← ScreenConfig.irregular_mask（cabinet 索引，与编辑器网格同一坐标系，忠实双向映射）。
       注意：export.rs / total_station_mapper.rs 都显式说明 shape_mode==='rectangle' 时
       irregular_mask 被当作 stale 数据忽略——mask 只有在 shape_mode==='irregular' 时才生效，
       此处如实提示，不悄悄改 shape_mode（那不在本次改动范围内）。
     - below ← ScreenConfig.bottom_completion.lowest_measurable_row 派生的只读提示（r < 该值
       的行视为不可测量 / 由 vertical extension 兜底），仅供预览，不接受编辑回写。
     - ref(origin/x_axis/xy_plane) ← 无法忠实映射：ProjectConfig.coordinate_system 引用的是
       **顶点点名**（如 "MAIN_V001_R001"，见 nominal.rs 命名约定），而编辑器网格是 **cabinet 格子**
       （cols×rows，顶点是 (cols+1)×(rows+1)），一个 cabinet 格子对应 4 个顶点角，无既定的
       "选哪个角" 规则——不造假映射，保留原有 ref/baseline 模式按钮供本地探索，但不参与保存；
       真实 coordinate_system 点名改以只读文字展示在画布下方。
     TODO(Claude Design): 若要让 ref 编辑真正可保存，需要设计"cabinet 格子 → 顶点角"的选择交互。 */
  function seedCellsFromConfig(sc) {
    const m = {};
    (sc.irregular_mask || []).forEach(([c, r]) => { m[c + ',' + r] = { state: 'masked' }; });
    const bc = sc.bottom_completion;
    if (bc && typeof bc.lowest_measurable_row === 'number') {
      for (let r = 0; r < bc.lowest_measurable_row; r++) {
        for (let c = 0; c < sc.cabinet_count[0]; c++) {
          const key = c + ',' + r;
          if (!m[key]) m[key] = { state: 'below' };
        }
      }
    }
    return m;
  }

  /* screen/screenConfig 理论上不会为空（center() 在 !proj.config 时已整体拦截，不会挂载本
     组件）——仍保留兜底值而非提前 return，避免 hooks 调用顺序在极端时序下不一致。 */
  function CabinetEditor({ s }) {
    const proj = useProj();
    const screens = deriveScreens(proj.config);
    const screen = screens.find((x) => x.id === s.calScreen) || screens[0] || { id: '', name: '—', cols: 1, rows: 1 };
    const screenConfig = (proj.config && proj.config.screens[screen.id]) || { cabinet_count: [1, 1], irregular_mask: [] };
    const { cols, rows } = screen;
    const [cells, setCells] = useState(() => seedCellsFromConfig(screenConfig));
    const [mode, setMode] = useState('select');
    const [role, setRole] = useState('origin');
    const [undoStack, setUndo] = useState([]);
    const [redoStack, setRedo] = useState([]);
    const stageRef = useRef(null);
    const panRef = useRef(null);
    const [zoom, setZoom] = useState(1);
    const [pan, setPan] = useState({ x: 0, y: 0 });
    const [fitW, setFitW] = useState(0);
    const [saving, setSaving] = useState(false);
    /* multi-selection: a set of "c,r" keys; s.calSel mirrors it for the inspector */
    const [selKeys, setSelKeys] = useState(() => new Set());
    const marqueeRef = useRef(null);
    const [marquee, setMarquee] = useState(null);
    const selKeysRef = useRef(selKeys); selKeysRef.current = selKeys;
    const cellsRef = useRef(cells); cellsRef.current = cells;
    const setSel = (nextSet) => { selKeysRef.current = nextSet; setSelKeys(nextSet); };
    const setMultiSel = (arr) => {
      if (!arr.length) { s.setCalSel(null); return; }
      if (arr.length === 1) { const [c, r] = arr[0].split(',').map(Number); const cell = cellsRef.current[arr[0]] || { state: 'normal' }; s.setCalSel({ type: 'cabinet', col: c, row: r, state: cell.state || 'normal', role: cell.role || null }); return; }
      const bd = { normal: 0, masked: 0, below: 0, ref: 0 };
      arr.forEach((k) => { const st = (cellsRef.current[k] && cellsRef.current[k].state) || 'normal'; bd[st] = (bd[st] || 0) + 1; });
      s.setCalSel({ type: 'cabinetMulti', count: arr.length, bd });
    };

    /* wheel = zoom · left-drag on empty area = free pan in any direction (vector-canvas feel) */
    useEffect(() => {
      const el = stageRef.current; if (!el) return;
      const onWheel = (e) => {
        e.preventDefault();
        setZoom((z) => Math.max(0.4, Math.min(4, +(z - Math.sign(e.deltaY) * 0.12).toFixed(2))));
      };
      el.addEventListener('wheel', onWheel, { passive: false });
      const move = (e) => {
        if (!panRef.current) return;
        setPan({ x: panRef.current.px + (e.clientX - panRef.current.x), y: panRef.current.py + (e.clientY - panRef.current.y) });
      };
      const up = () => { if (panRef.current) { el.classList.remove('panning'); panRef.current = null; } };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      return () => { el.removeEventListener('wheel', onWheel); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    }, [pan]);
    const onStageDown = (e) => {
      if (e.button === 2) { // right button = pan, anywhere on the stage
        e.preventDefault();
        panRef.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
        stageRef.current.classList.add('panning');
        return;
      }
      if (e.button !== 0 || mode !== 'select') return; // left marquee only in select mode
      if (e.metaKey || e.altKey) return; // ⌘/Alt click = multi-toggle, handled on the cell
      e.preventDefault();
      marqueeRef.current = { x: e.clientX, y: e.clientY, moved: false, onCell: !!(e.target.closest && e.target.closest('.cab')) };
    };
    const resetView = () => { setZoom(1); setPan({ x: 0, y: 0 }); };

    /* left-drag marquee: box-select every cabinet the rubber band touches */
    useEffect(() => {
      const move = (e) => {
        const m = marqueeRef.current; if (!m) return;
        if (Math.abs(e.clientX - m.x) + Math.abs(e.clientY - m.y) > 4) m.moved = true;
        const el = stageRef.current; const rect = el.getBoundingClientRect();
        setMarquee({ x0: m.x - rect.left, y0: m.y - rect.top, x1: e.clientX - rect.left, y1: e.clientY - rect.top });
        const minX = Math.min(m.x, e.clientX), maxX = Math.max(m.x, e.clientX), minY = Math.min(m.y, e.clientY), maxY = Math.max(m.y, e.clientY);
        const set = new Set();
        el.querySelectorAll('.cab').forEach((cab) => {
          const r = cab.getBoundingClientRect();
          if (r.left < maxX && r.right > minX && r.top < maxY && r.bottom > minY) set.add(cab.dataset.cr);
        });
        setSel(set);
      };
      const up = () => {
        const m = marqueeRef.current; if (!m) return;
        marqueeRef.current = null; setMarquee(null);
        if (m.moved) setMultiSel([...selKeysRef.current]);
        else if (!m.onCell) { setSel(new Set()); s.setCalSel(null); } // click on empty = clear selection
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    }, []);

    /* fit the grid inside its stage (constrain by BOTH width and height so it never spills over) */
    useLayoutEffect(() => {
      const el = stageRef.current; if (!el) return;
      const PAD = 44;
      const calc = () => {
        const w = el.clientWidth - PAD, hh = el.clientHeight - PAD;
        if (w <= 0 || hh <= 0) return;
        setFitW(Math.max(160, Math.min(w, hh * (cols / rows))));
      };
      calc();
      const ro = new ResizeObserver(calc); ro.observe(el);
      return () => ro.disconnect();
    }, [cols, rows]);

    useEffect(() => { setCells(seedCellsFromConfig(screenConfig)); setUndo([]); setRedo([]); setZoom(1); setPan({ x: 0, y: 0 }); setSel(new Set()); }, [s.calScreen, screenConfig]);

    const sel = (c, r, cell) => s.setCalSel({ type: 'cabinet', col: c, row: r, state: (cell && cell.state) || 'normal', role: (cell && cell.role) || null });
    const commit = (next) => { setUndo((u) => [...u, cells]); setRedo([]); setCells(next); };
    const doUndo = () => { if (!undoStack.length) return; setRedo((r) => [...r, cells]); setCells(undoStack[undoStack.length - 1]); setUndo((u) => u.slice(0, -1)); };
    const doRedo = () => { if (!redoStack.length) return; setUndo((u) => [...u, cells]); setCells(redoStack[redoStack.length - 1]); setRedo((r) => r.slice(0, -1)); };

    useEffect(() => {
      const ent = Object.entries(cells).find(([, v]) => v.role === 'origin');
      if (ent && (!s.calSel || s.calSel.type !== 'cabinet')) { const [c, r] = ent[0].split(',').map(Number); sel(c, r, ent[1]); setSel(new Set([ent[0]])); }
    }, []);

    useEffect(() => {
      const onKey = (e) => {
        if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
        const k = e.key.toLowerCase();
        if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
        if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); doRedo(); return; }
        if (k === 'm') setMode((m) => m === 'mask' ? 'select' : 'mask');
        else if (k === 'r') setMode((m) => m === 'refs' ? 'select' : 'refs');
        else if (k === 'b') setMode((m) => m === 'baseline' ? 'select' : 'baseline');
        else if (k === 'escape') setMode('select');
        else if (k === '1') setRole('origin');
        else if (k === '2') setRole('x_axis');
        else if (k === '3') setRole('xy_plane');
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [mode, cells, undoStack, redoStack]);

    const onCell = (c, r, e) => {
      const key = c + ',' + r; const cur = cells[key] || { state: 'normal' };
      if (mode === 'select') {
        if (e && (e.metaKey || e.altKey)) { // multi add / remove
          const n = new Set(selKeysRef.current); n.has(key) ? n.delete(key) : n.add(key);
          setSel(n); setMultiSel([...n]); return;
        }
        setSel(new Set([key])); sel(c, r, cur); return;
      }
      const next = { ...cells };
      if (mode === 'mask') next[key] = cur.state === 'masked' ? { state: 'normal' } : { state: 'masked' };
      else if (mode === 'baseline') next[key] = cur.state === 'below' ? { state: 'normal' } : { state: 'below' };
      else if (mode === 'refs') next[key] = { state: 'ref', role };
      commit(next); setSel(new Set([key])); sel(c, r, next[key]);
    };

    const grid = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const cell = cells[c + ',' + r] || { state: 'normal' };
      const isSel = selKeys.has(c + ',' + r);
      let cls = 'cab';
      if (cell.state === 'masked') cls += ' masked';
      else if (cell.state === 'below') cls += ' below';
      else if (cell.state === 'ref') cls += ' ref-' + cell.role;
      if (isSel) cls += ' sel';
      grid.push(h('div', { key: c + ',' + r, className: cls, 'data-cr': c + ',' + r, onClick: (e) => onCell(c, r, e), title: `col ${c}, row ${r}` },
        cell.state === 'ref' ? h('span', { className: 'rl' }, ROLE[cell.role].short) : null));
    }

    const ModeBtn = (id, label, key, icon) => h('div', { className: 'mbtn' + (mode === id ? ' on' : ''), onClick: () => setMode((m) => m === id ? 'select' : id) },
      h(Icon, { name: icon, size: 14 }), label, h('kbd', null, key));

    /* 只回写 irregular_mask（遮罩），below/ref 是本地预览，见组件顶部注释。 */
    const doSave = async () => {
      if (!proj.path || saving || !proj.config) return;
      const screenId = screen.id;
      const irregular_mask = Object.entries(cells).filter(([, v]) => v.state === 'masked').map(([k]) => k.split(',').map(Number));
      const nextConfig = { ...proj.config, screens: { ...proj.config.screens, [screenId]: { ...proj.config.screens[screenId], irregular_mask } } };
      setSaving(true);
      try {
        await s.runCmd({ domain: 'calibrate', action: '保存工程', target: screenId, chan: 'local' },
          () => saveProjectYaml(proj.path, nextConfig),
          { okMsg: () => `已保存 <b>${screenId}</b> 的遮罩改动（${irregular_mask.length} 格）` });
        await openProjectPath(proj.path, s); /* 回读校验：保存后重新 load_project_yaml */
      } catch (e) { /* runCmd 已记录失败 */ } finally { setSaving(false); }
    };

    return h('div', { className: 'cabwrap' },
      h('div', { className: 'canvas-head' },
        h('span', { className: 't' }, screen.name + ' — Cabinet 网格'),
        h('span', { className: 'toolchip' }, h(Icon, { name: 'grid', size: 14 }), `${cols} × ${rows} cabinet`),
        h('span', { className: 'toolchip' }, mode === 'select' ? '选择模式' : mode === 'mask' ? '遮罩模式' : mode === 'refs' ? '参考点模式' : '基线模式'),
        h('div', { className: 'right' },
          h('div', { className: 'zoombar' },
            h('button', { className: 'zb-btn', onClick: () => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2))), title: '缩小' }, '−'),
            h('button', { className: 'zb-lbl', onClick: resetView, title: '适应窗口' }, Math.round(zoom * 100) + '%'),
            h('button', { className: 'zb-btn', onClick: () => setZoom((z) => Math.min(3, +(z + 0.25).toFixed(2))), title: '放大' }, '+')),
          h('button', { className: 'iconbtn', disabled: !undoStack.length, style: { opacity: undoStack.length ? 1 : .4 }, onClick: doUndo, title: '撤销' }, h(Icon, { name: 'undo', size: 16 })),
          h('button', { className: 'iconbtn', disabled: !redoStack.length, style: { opacity: redoStack.length ? 1 : .4 }, onClick: doRedo, title: '重做' }, h(Icon, { name: 'redo', size: 16 })),
          /* TODO(Claude Design): 保存目前是纯图标按钮，无脏态提示；样式沿用 iconbtn。 */
          h('button', { className: 'iconbtn', disabled: !proj.path || saving, style: { opacity: (!proj.path || saving) ? .4 : 1 },
            onClick: doSave, title: '保存遮罩到工程' }, h(Icon, { name: saving ? 'sync' : 'check', size: 16 })))),
      h('div', { className: 'cabstage' + (marquee ? ' marquee' : ''), ref: stageRef, onMouseDown: onStageDown, onContextMenu: (e) => e.preventDefault() },
        h('div', { className: 'cabgrid', style: { gridTemplateColumns: `repeat(${cols}, 1fr)`, width: fitW ? fitW + 'px' : undefined, transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` } }, grid),
        marquee ? h('div', { className: 'marquee-box', style: { left: Math.min(marquee.x0, marquee.x1), top: Math.min(marquee.y0, marquee.y1), width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0) } }) : null),
      h('div', { className: 'modebar' },
        ModeBtn('mask', '遮罩', 'M', 'panel'),
        ModeBtn('refs', '参考点', 'R', 'pin'),
        ModeBtn('baseline', '基线', 'B', 'ruler'),
        mode === 'refs' ? h('div', { className: 'role-seg' },
          ['origin', 'x_axis', 'xy_plane'].map((rk, i) => h('button', { key: rk, className: (role === rk ? 'on r-' + rk : ''), onClick: () => setRole(rk) },
            h('span', { className: 'sdot', style: { background: ROLE[rk].color } }), ROLE[rk].label, h('kbd', { style: { marginLeft: 2 } }, i + 1)))) : null,
        h('span', { className: 'sp' })),
      h('div', { className: 'leg' },
        h('span', { className: 'leg-i' }, h('span', { className: 'leg-sw', style: { background: '#3a4654' } }), '正常'),
        h('span', { className: 'leg-i' }, h('span', { className: 'leg-sw', style: { background: 'repeating-linear-gradient(45deg,#26262b 0 3px,#1b1b1f 3px 6px)' } }), '遮罩（可保存）'),
        h('span', { className: 'leg-i' }, h('span', { className: 'leg-sw', style: { background: '#243a52' } }), '基线以下（只读提示，不保存）'),
        h('span', { className: 'leg-i' }, h('span', { className: 'leg-sw', style: { background: ROLE.origin.color } }), 'origin'),
        h('span', { className: 'leg-i' }, h('span', { className: 'leg-sw', style: { background: ROLE.x_axis.color } }), 'x_axis'),
        h('span', { className: 'leg-i' }, h('span', { className: 'leg-sw', style: { background: ROLE.xy_plane.color } }), 'xy_plane')),
      /* 真实 coordinate_system 是顶点点名，不是 cabinet 格子——只读展示，不与网格 ref 模式绑定
         （见组件顶部注释）。TODO(Claude Design): 若需要可视化定位到具体网格顶点，需要新设计。 */
      proj.config ? h('div', { style: { padding: '8px 14px 0', fontSize: 11.5, color: 'var(--chrome-faint)', lineHeight: 1.6 } },
        h('div', null,
          '坐标系参考点（只读 · project.yaml coordinate_system，与顶点点名绑定，非 cabinet 格子）：',
          h('span', { className: 'mono', style: { marginLeft: 6 } }, proj.config.coordinate_system.origin_point),
          ' / ', h('span', { className: 'mono' }, proj.config.coordinate_system.x_axis_point),
          ' / ', h('span', { className: 'mono' }, proj.config.coordinate_system.xy_plane_point)),
        screenConfig.shape_mode !== 'irregular' ? h('div', { style: { marginTop: 3, color: 'var(--notice-visual, #d9a441)' } },
          `注意：shape_mode 当前为 "${screenConfig.shape_mode}"，遮罩(irregular_mask) 在 rectangle 模式下会被后端忽略（需切到 irregular 才生效）。`) : null) : null);
  }

  /* =================== Method =================== */
  function methodView(s) {
    const M = [
      { id: 'm1', icon: 'target', title: 'M1 · 全站仪', tag: 'Trimble SX', desc: '使用全站仪逐点测量物理坐标，导入 CSV 后做刚体配准。精度最高，依赖现场测量与人工。',
        bullets: ['亚毫米级测量精度', '需现场架设与逐点采集', 'CSV 导入 + 离群剔除'] },
      { id: 'm2', icon: 'camera', title: 'M2 · 视觉', tag: 'ChArUco + BA', desc: '相机拍摄 ChArUco 标定板，特征检测后做 bundle adjustment 联合优化。快速、自动，适合迭代。',
        bullets: ['自动角点检测', 'bundle adjustment 联合优化', '分钟级迭代，无需测量员'] },
    ];
    return h(React.Fragment, null,
      h('div', { className: 'canvas-head' },
        h('span', { className: 't' }, '选择重建方法'),
        h('div', { className: 'right' }, h('span', { className: 'toolchip' }, h(Icon, { name: 'tools', size: 14 }), '当前 · ' + (s.calMethod === 'm1' ? 'M1 全站仪' : 'M2 视觉')))),
      h('div', { className: 'mcards' },
        M.map((m) => {
          const on = s.calMethod === m.id;
          return h('div', { key: m.id, className: 'mcard' + (on ? ' on' : '') },
            h('div', { className: 'mc-top' },
              h('span', { className: 'mc-ic' }, h(Icon, { name: m.icon, size: 20 })),
              h('div', { style: { flex: 1 } }, h('h3', null, m.title), h('div', { className: 'mc-tag' }, m.tag)),
              on ? h(Badge, { variant: 'accent', size: 'S' }, '当前方法') : null),
            h('div', { className: 'mc-desc' }, m.desc),
            h('ul', null, m.bullets.map((b, i) => h('li', { key: i }, b))),
            h('div', { className: 'mc-f' },
              on
                ? h(Button, { variant: 'accent', size: 'S', icon: h(Icon, { name: 'chevr', size: 15 }), onPress: () => s.setCalStep('survey') }, '继续')
                : h(Button, { variant: 'secondary', size: 'S', icon: h(Icon, { name: 'sync', size: 15 }),
                    onPress: () => { s.setCalMethod(m.id); s.pushLog({ lv: 'info', cat: 'calibrate', msg: `切换重建方法为 <b>${m.title}</b>` }); } }, '使用此方法'),
              !on ? h('span', { style: { fontSize: 11.5, color: 'var(--chrome-faint)' } }, '切换将重置测量导入') : null));
        })));
  }

  /* =================== Survey =================== */
  /* 后端没有逐点"实测 vs fabricated"字段（measured.yaml 的 source 恒为 total_station，
     两者只靠 sigma 大小区分——crates/mesh-adapter-total-station/src/report_builder.rs
     的 FABRICATED_SIGMA_THRESHOLD_MM = 5.0 是文档化的既定启发式，非本页发明）。 */
  const FABRICATED_SIGMA_THRESHOLD_MM = 5.0;
  function sigmaApproxMm(u) {
    if (!u) return null;
    if ('isotropic' in u) return u.isotropic;
    if ('covariance' in u) { const m = u.covariance; return Math.sqrt((m[0][0] + m[1][1] + m[2][2]) / 3); }
    return null;
  }
  async function doImportCsv(s, proj) {
    if (!proj.path) { s.pushLog({ lv: 'warn', cat: 'calibrate', msg: '导入失败 · 尚未打开项目' }); return; }
    let csvPath;
    try { csvPath = await pickFile('Total Station CSV', ['csv']); }
    catch (e) { s.pushLog({ lv: 'err', cat: 'calibrate', msg: `选择 CSV 失败 · ${e && e.message ? e.message : e}` }); return; }
    if (!csvPath) return;
    const screenId = s.calScreen;
    try {
      await s.runCmd({ domain: 'calibrate', action: '导入全站仪 CSV', target: screenId, chan: 'local' }, async () => {
        const report = await importTotalStationCsv(proj.path, csvPath, screenId);
        const absMeasured = proj.path.replace(/[\\/]+$/, '') + '/' + report.measurementsYamlPath;
        const measured = await loadMeasurementsYaml(absMeasured);
        projStore.patch({ surveyReport: report, measured, measurementsAbsPath: absMeasured });
        return report;
      }, { okMsg: (r) => `导入完成 · 实测 ${r.measuredCount} · 制造 ${r.fabricatedCount} · 离群 ${r.outlierCount} · 缺失 ${r.missingCount}` });
    } catch (e) { /* runCmd 已记录失败 */ }
  }
  function surveyView(s, proj) {
    if (s.calMethod === 'm2') {
      return h(React.Fragment, null,
        h('div', { className: 'canvas-head' }, h('span', { className: 't' }, '测量导入 · M2 视觉')),
        h('div', { className: 'surv' },
          h('div', { className: 'hatch dark', style: { minHeight: 360 } },
            h('div', { className: 'hi' },
              h('span', { className: 'hic' }, h(Icon, { name: 'camera', size: 26 })),
              h('span', { className: 'ht' }, '未实现'),
              h('span', { className: 'hd' }, 'M2 视觉方法直接从相机帧提取角点，无独立测量导入步骤。该面板暂未实现。')))));
    }
    const rep = proj.surveyReport;
    const tiles = rep ? [
      ['measured', '实测点', rep.measuredCount, 'positive'], ['fabricated', '制造点', rep.fabricatedCount, 'neutral'],
      ['outlier', '离群点', rep.outlierCount, 'negative'], ['missing', '缺失点', rep.missingCount, 'notice'],
    ] : [];
    const coord = proj.config && proj.config.coordinate_system;
    const roleOf = (name) => !coord ? null : name === coord.origin_point ? 'origin' : name === coord.x_axis_point ? 'x_axis' : name === coord.xy_plane_point ? 'xy_plane' : null;
    const points = (proj.measured && proj.measured.points) || [];
    return h(React.Fragment, null,
      h('div', { className: 'canvas-head' },
        h('span', { className: 't' }, '测量导入 · M1 全站仪'),
        rep ? h('span', { className: 'toolchip' }, h(Icon, { name: 'download', size: 14 }), rep.measurementsYamlPath) : null,
        h('div', { className: 'right' },
          h(Button, { variant: 'accent', size: 'S', icon: h(Icon, { name: 'download', size: 14 }), onPress: () => doImportCsv(s, proj) }, '导入 CSV'))),
      h('div', { className: 'surv cal-scroll' },
        rep ? h('div', { className: 'surv-tiles' },
          tiles.map(([id, lab, n, v]) => h('div', { className: 'stile', key: id },
            h('div', { className: 'n s-' + v }, n),
            h('div', { className: 'l' }, h('span', { className: 'sdot bg-' + v }), lab)))) : h('div', { style: { fontSize: 12, color: 'var(--chrome-faint)', marginBottom: 10 } }, '尚未导入 CSV。'),
        rep ? rep.warnings.map((w, i) => h('div', { key: i, style: { marginBottom: 8 } },
          h(InlineAlert, { variant: 'notice', title: '提示' }, w))) : null,
        h('div', { className: 'surv-sub' }, '参考点 / 测量点' + (points.length ? `（${points.length}）` : '')),
        points.length ? h('div', { className: 'ptable' },
          points.map((p) => {
            const isSel = s.calSel && s.calSel.type === 'point' && s.calSel.id === p.name;
            const role = roleOf(p.name);
            const sigma = sigmaApproxMm(p.uncertainty);
            const measuredReal = sigma == null || sigma < FABRICATED_SIGMA_THRESHOLD_MM;
            return h('div', { key: p.name, className: 'prow' + (isSel ? ' sel' : ''), onClick: () => s.setCalSel({ type: 'point', id: p.name }) },
              h('div', { className: 'pn' },
                role ? h('span', { className: 'sdot', style: { background: ROLE[role].color } }) : h('span', { className: 'sdot bg-neutral' }),
                p.name),
              h('div', { className: 'xyz' }, `[${p.position.map((v) => v.toFixed(3)).join(', ')}]`),
              h('div', { style: { fontSize: 11.5, color: 'var(--chrome-dim)' } }, measuredReal ? '实测' : '推测'),
              h('div', { className: 'er s-' + (sigma == null ? 'neutral' : sigma < 3 ? 'positive' : sigma < 8 ? 'notice' : 'negative') }, sigma == null ? '—' : sigma.toFixed(2) + ' mm'));
          })) : h('div', { style: { fontSize: 12, color: 'var(--chrome-faint)' } }, '—')));
  }

  /* =================== Preview: rotatable 3D mesh =================== */
  /* 真实顶点接线（W2 item 5）：原 pt(i,j) 是按 cols/rows 生成的规则弧面公式（procedural，
     与真实测量/重建坐标无关）——现改为查 surface.vertices 的真实位置（米），用顶点包围盒
     做一次"适应窗口"缩放（FIT）喂给原有的旋转+透视投影 project()（这部分数学本就与具体
     坐标无关，原样复用）。低置信 hatch 改由 vertex_provenance==='extrapolated' 驱动，
     provenance 为空数组（旧 surface，语义未知）时不画 hatch，不假设"全部已测量"。 */
  function MeshPreview3D({ surface }) {
    const cols = surface.topology.cols, rows = surface.topology.rows;
    const vertices = surface.vertices;
    const provenance = surface.vertex_provenance || [];
    const vidx = (c, r) => r * (cols + 1) + c; /* 必须与 crates/mesh-core/src/surface.rs GridTopology::vertex_index 一致 */
    const isExtrap = (c, r) => provenance.length ? provenance[vidx(c, r)] === 'extrapolated' : false;
    const [rot, setRot] = useState({ yaw: -2.532, pitch: -0.276 });
    const [zoom, setZoom] = useState(1.36);
    const [pan, setPan] = useState({ x: -47, y: -75 });
    const rotRef = useRef(null);
    const panRef = useRef(null);
    const svgRef = useRef(null);
    const onDown = (e) => {
      if (e.button === 2) { e.preventDefault(); panRef.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y }; return; } // right = pan
      if (e.button !== 0) return;
      rotRef.current = { x: e.clientX, y: e.clientY, ...rot }; // left = rotate
    };
    useEffect(() => {
      const svg = svgRef.current;
      const onWheel = (e) => { e.preventDefault(); setZoom((z) => Math.max(0.4, Math.min(4, +(z - Math.sign(e.deltaY) * 0.12).toFixed(2)))); };
      if (svg) svg.addEventListener('wheel', onWheel, { passive: false });
      const mv = (e) => {
        if (rotRef.current) { const d = rotRef.current;
          setRot({ yaw: d.yaw + (e.clientX - d.x) * 0.006, pitch: Math.max(-0.5, Math.min(0.6, d.pitch + (e.clientY - d.y) * 0.004)) }); }
        else if (panRef.current) { const p = panRef.current; const k = 900 / ((svg && svg.clientWidth) || 900);
          setPan({ x: p.px + (e.clientX - p.x) * k, y: p.py + (e.clientY - p.y) * k }); }
      };
      const up = () => { rotRef.current = null; panRef.current = null; };
      window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
      return () => { if (svg) svg.removeEventListener('wheel', onWheel); window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
    }, []);

    const z0 = 230, Hh = 300; /* Hh 只用于地面网格的装饰性高度基准，与真实顶点无关 */
    const zc = z0 + 150;
    const cyaw = Math.cos(rot.yaw), syaw = Math.sin(rot.yaw), cpit = Math.cos(rot.pitch), spit = Math.sin(rot.pitch);
    const F = 780;
    const project = (x, y, z) => {
      let dx = x, dz = z - zc; let x2 = dx * cyaw - dz * syaw, z2 = dx * syaw + dz * cyaw + zc;
      let dy = y, dz2 = z2 - zc; let y2 = dy * cpit - dz2 * spit, z3 = dy * spit + dz2 * cpit + zc;
      const sc = F / (F + z3);
      return [450 + x2 * sc, 300 - y2 * sc, sc];
    };
    /* 真实顶点包围盒 → "适应窗口"缩放，喂给上面与坐标无关的旋转+透视投影。 */
    const xs = vertices.map((v) => v[0]), ys = vertices.map((v) => v[1]), zs = vertices.map((v) => v[2]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys), minZ = Math.min(...zs);
    const spanX = Math.max(maxX - minX, 0.05), spanY = Math.max(maxY - minY, 0.05);
    const FIT = 620 / Math.max(spanX, spanY);
    const midX = (minX + maxX) / 2, midY = (minY + maxY) / 2;
    const pt = (c, r) => {
      const v = vertices[vidx(c, r)];
      return project((v[0] - midX) * FIT, (v[1] - midY) * FIT, z0 + (v[2] - minZ) * FIT);
    };
    const lines = [];
    for (let i = 0; i <= cols; i++) { let d = ''; for (let j = 0; j <= rows; j++) { const [px, py] = pt(i, j); d += (j ? 'L' : 'M') + px.toFixed(1) + ' ' + py.toFixed(1) + ' '; }
      lines.push(h('path', { key: 'c' + i, d, stroke: 'rgba(120,180,255,.30)', strokeWidth: i % 4 === 0 ? 1.2 : .6, fill: 'none' })); }
    for (let j = 0; j <= rows; j++) { let d = ''; for (let i = 0; i <= cols; i++) { const [px, py] = pt(i, j); d += (i ? 'L' : 'M') + px.toFixed(1) + ' ' + py.toFixed(1) + ' '; }
      lines.push(h('path', { key: 'r' + j, d, stroke: 'rgba(120,180,255,.30)', strokeWidth: j % 4 === 0 ? 1.2 : .6, fill: 'none' })); }
    /* 低置信 hatch：四角任一顶点为 extrapolated 就整格铺纹理（provenance 为空数组时不铺，见组件顶部注释）。 */
    const hatch = [];
    for (let i = 0; i < cols; i += 1) for (let j = 0; j < rows; j += 1) {
      if (!(isExtrap(i, j) || isExtrap(i + 1, j) || isExtrap(i, j + 1) || isExtrap(i + 1, j + 1))) continue;
      const a = pt(i, j), b = pt(i + 1, j), c = pt(i + 1, j + 1), dd = pt(i, j + 1);
      hatch.push(h('polygon', { key: 'h' + i + j, points: `${a[0]},${a[1]} ${b[0]},${b[1]} ${c[0]},${c[1]} ${dd[0]},${dd[1]}`, fill: 'url(#lowhatch)', stroke: 'none' }));
    }
    /* 装饰性抽样密度（原图固定 4/2 是照 64×16 网格调的，改按真实拓扑自适应，避免小网格几乎没有点/大网格过密）。 */
    const stepI = Math.max(1, Math.round(cols / 16)), stepJ = Math.max(1, Math.round(rows / 8));
    const dots = [];
    for (let i = 0; i <= cols; i += stepI) for (let j = 0; j <= rows; j += stepJ) { const [px, py] = pt(i, j);
      dots.push(h('circle', { key: 'd' + i + '_' + j, cx: px, cy: py, r: 1.7, fill: isExtrap(i, j) ? 'rgba(255,150,40,.7)' : 'var(--volo-600)' })); }

    // ground plane (floor grid at the foot of the wall, same camera; 纯装饰参照面，非真实数据)
    const gY = -Hh / 2, gx0 = -800, gx1 = 800, gz0 = -160, gz1 = 1120, S = 80;
    const ground = [];
    const q00 = project(gx0, gY, gz0), q10 = project(gx1, gY, gz0), q11 = project(gx1, gY, gz1), q01 = project(gx0, gY, gz1);
    ground.push(h('polygon', { key: 'gfill', points: `${q00[0]},${q00[1]} ${q10[0]},${q10[1]} ${q11[0]},${q11[1]} ${q01[0]},${q01[1]}`, fill: 'rgba(120,140,170,.045)', stroke: 'none' }));
    for (let x = gx0; x <= gx1 + 0.5; x += S) { const a = project(x, gY, gz0), b = project(x, gY, gz1);
      ground.push(h('line', { key: 'gx' + x, x1: a[0], y1: a[1], x2: b[0], y2: b[1], stroke: 'rgba(135,155,185,.17)', strokeWidth: Math.round(x) % 400 === 0 ? 1 : .5 })); }
    for (let z = gz0; z <= gz1 + 0.5; z += S) { const a = project(gx0, gY, z), b = project(gx1, gY, z);
      ground.push(h('line', { key: 'gz' + z, x1: a[0], y1: a[1], x2: b[0], y2: b[1], stroke: 'rgba(135,155,185,.17)', strokeWidth: Math.round(z) % 400 === 0 ? 1 : .5 })); }

    const tf = `translate(${450 + pan.x} ${300 + pan.y}) scale(${zoom}) translate(-450 -300)`;
    return h('svg', { viewBox: '0 0 900 600', width: '100%', height: '100%', preserveAspectRatio: 'xMidYMid meet', ref: svgRef, style: { display: 'block', cursor: 'grab' }, onMouseDown: onDown, onContextMenu: (e) => e.preventDefault() },
      h('defs', null, h('pattern', { id: 'lowhatch', width: 7, height: 7, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' },
        h('rect', { width: 7, height: 7, fill: 'rgba(255,150,40,.05)' }), h('line', { x1: 0, y1: 0, x2: 0, y2: 7, stroke: 'rgba(255,150,40,.4)', strokeWidth: 1 }))),
      h('g', { transform: tf },
        h('g', null, ground), h('g', null, hatch), h('g', null, lines), h('g', null, dots)));
  }

  function previewView(s, proj) {
    const screens = deriveScreens(proj.config);
    const screen = screens.find((x) => x.id === s.calScreen) || screens[0] || { name: '—' };
    const rec = proj.reconstruction;
    const Q = (k, v, u, vis) => h('div', { className: 'qmetric' },
      h('div', { className: 'qk' }, k), h('div', { className: 'qv s-' + (vis || '') }, v, u ? h('span', { className: 'u' }, u) : null));
    if (!rec) {
      /* 无重建结果：现有 hatch 占位，不放假数据（W2 item 5）。 */
      return h('div', { className: 'cabwrap' },
        h('div', { className: 'canvas-head' }, h('span', { className: 't' }, screen.name + ' — 网格预览'),
          h('div', { className: 'right' }, h('span', { className: 'toolchip' }, '未重建'))),
        h('div', { className: 'cabstage', style: { padding: 0 } },
          h('div', { className: 'hatch dark', style: { minHeight: 360 } },
            h('div', { className: 'hi' },
              h('span', { className: 'hic' }, h(Icon, { name: 'cube', size: 26 })),
              h('span', { className: 'ht' }, '尚未重建'),
              h('span', { className: 'hd' }, '在上方概览条点击「重建」以生成当前屏幕的网格。')))));
    }
    const surface = rec.surface;
    const qm = surface.quality_metrics;
    const fmt = (v) => v == null ? 'n/a' : v.toFixed(2);
    const visOf = (v) => v == null ? '' : v < 3 ? 'positive' : v < 8 ? 'notice' : 'negative';
    return h('div', { className: 'cabwrap' },
      h('div', { className: 'canvas-head' },
        h('span', { className: 't' }, screen.name + ' — 网格预览'),
        h('span', { className: 'toolchip' }, h(Icon, { name: 'cube', size: 14 }), `拓扑 ${surface.topology.cols} × ${surface.topology.rows}`),
        h('span', { className: 'toolchip' }, h(Icon, { name: 'layers', size: 14 }), surface.vertices.length.toLocaleString() + ' 顶点'),
        h('div', { className: 'right' }, rmsBadge(qm.estimated_rms_mm))),
      h('div', { className: 'cabstage', style: { padding: 0 } },
        h('div', { className: 'prev-badge' },
          h('span', { className: 'toolchip' }, h('span', { className: 'leg-sw', style: { background: 'url(#none)', backgroundColor: 'rgba(255,150,40,.3)', border: '1px solid rgba(255,150,40,.6)' } }),
            `外插 / 低置信 · ${qm.extrapolated_count}`)),
        h('div', { className: 'cal-axis' }, 'PERSP · world'),
        h(MeshPreview3D, { surface }),
        h('div', { className: 'rot-hint' }, h(Icon, { name: 'rotate', size: 13 }), '拖动旋转')),
      h('div', { className: 'modebar', style: { gap: 9 } },
        h('div', { className: 'qbar' },
          Q('middle_max_dev', fmt(qm.middle_max_dev_mm), 'mm', visOf(qm.middle_max_dev_mm)),
          Q('middle_mean_dev', fmt(qm.middle_mean_dev_mm), 'mm', visOf(qm.middle_mean_dev_mm)),
          Q('estimated_rms', fmt(qm.estimated_rms_mm), 'mm', visOf(qm.estimated_rms_mm)),
          Q('estimated_p95', fmt(qm.estimated_p95_mm), 'mm', visOf(qm.estimated_p95_mm)))));
  }

  /* =================== Runs =================== */
  function RunsTable({ s, proj }) {
    const [exp, setExp] = useState(null);
    const [reports, setReports] = useState({}); /* runId → ReconstructionReport | 'loading' | 'error:<msg>' */
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
    const runs = proj.runs || [];
    const qRow = (k, v) => h('div', { className: 'qmetric' }, h('div', { className: 'qk' }, k),
      h('div', { className: 'qv' }, v == null ? 'n/a' : v.toFixed(2), v == null ? null : h('span', { className: 'u' }, 'mm')));
    return h('div', { className: 'runtable cal-scroll' },
      h('div', { className: 'rt-head' },
        h('span', null, 'Created'), h('span', null, 'Screen'), h('span', null, 'Method'),
        h('span', null, 'RMS'), h('span', null, 'Vertices'), h('span', null, 'Target'), h('span', null, 'OBJ')),
      runs.length ? runs.map((r) => {
        const rep = reports[r.id];
        return h(React.Fragment, { key: r.id },
          h('div', { className: 'rt-row' + (s.calSel && s.calSel.type === 'run' && s.calSel.id === r.id ? ' sel' : ''), onClick: () => click(r) },
            h('span', { className: 'dim' }, r.created_at),
            h('span', null, r.screen_id),
            h('span', { className: 'dim' }, r.method),
            h('span', null, rmsBadge(r.estimated_rms_mm)),
            h('span', { className: 'mono' }, r.vertex_count ? r.vertex_count.toLocaleString() : '—'),
            h('span', { className: 'mono dim' }, r.target || '—'),
            h('span', null, r.output_obj_path
              ? h('button', { className: 'iconbtn', style: { width: 24, height: 24 }, title: '在文件夹中显示', onClick: (e) => {
                  e.stopPropagation();
                  revealPath(r.output_obj_path).catch((err) => s.pushLog({ lv: 'err', cat: 'calibrate', msg: `打开失败 · ${err && err.message ? err.message : err}` }));
                } }, h(Icon, { name: 'download', size: 15 }))
              : h('span', { style: { color: 'var(--chrome-faint)' } }, '—'))),
          exp === r.id ? h('div', { className: 'rt-exp' },
            h('div', { className: 'ttl' }, '重建报告 · run #' + r.id),
            rep === 'loading' ? h('div', { style: { fontSize: 12, color: 'var(--chrome-faint)' } }, '加载中…')
              : (typeof rep === 'string' && rep.indexOf('error:') === 0) ? h('div', { style: { fontSize: 12, color: 'var(--negative-visual)' } }, rep.slice(6))
              : rep ? h('div', { className: 'qbar' },
                  qRow('middle_max_dev', rep.quality_metrics.middle_max_dev_mm),
                  qRow('middle_mean_dev', rep.quality_metrics.middle_mean_dev_mm),
                  qRow('estimated_rms', rep.quality_metrics.estimated_rms_mm),
                  qRow('estimated_p95', rep.quality_metrics.estimated_p95_mm))
                : null) : null);
      }) : h('div', { style: { padding: 16, fontSize: 12, color: 'var(--chrome-faint)' } }, '当前屏幕暂无重建记录。'));
  }

  /* =================== Lens (vpcal quick run wiring, W3.2) =================== */
  /* Wiring notes:
     - `vpcal quick run` (sidecars/vpcal/src/vpcal/cli/quick.py:34) runs the full
       validate → detect → solve → report pipeline in ONE process and only emits
       its result envelope once, at exit (`run_operation`, not
       `run_streaming_operation` — sidecars/vpcal/src/vpcal/cli/_common.py L263-299
       vs L182-244). There is no per-stage progress on stdout, so the 4-stage
       strip below reflects idle/running(whole pipeline)/done rather than genuine
       per-stage completion. Re-running per-stage via `--stage` would recompute
       earlier stages from scratch each call (wasteful for a BA solve) for a
       stepper that would still be cosmetic — not worth it.
     - `--output json` (not ndjson) so spawn_sidecar_streaming's per-line JSON
       parse (src-tauri/src/commands/sidecar_stream.rs:182) captures the single
       result envelope directly on one `line` event. `envelope.data` already
       carries `result` (CalibrationResult — vpcal/src/vpcal/models/calibration.py
       L137-149), `qa`, `output_dir`, `confidence`, `solver_backend`, `exit_code`
       (vpcal/src/vpcal/core/pipeline.py L835-841) — no separate result.json file
       read needed.
     - `tracker_to_stage.rotation` is a quaternion (w,x,y,z) — vpcal solves a
       *rigid* transform (translation + rotation only, no scale term), so the
       DOF panel below is 6, not 7; rotation is shown as Euler XYZ (deg) derived
       from the quaternion for readability. */
  function quatToEulerDeg(q) {
    const [w, x, y, z] = q;
    const sinr = 2 * (w * x + y * z), cosr = 1 - 2 * (x * x + y * y);
    const rx = Math.atan2(sinr, cosr);
    const sinp = 2 * (w * y - z * x);
    const ry = Math.abs(sinp) >= 1 ? Math.sign(sinp) * (Math.PI / 2) : Math.asin(sinp);
    const siny = 2 * (w * z + x * y), cosy = 1 - 2 * (y * y + z * z);
    const rz = Math.atan2(siny, cosy);
    return [rx, ry, rz].map((r) => (r * 180) / Math.PI);
  }

  function LensPanel({ s }) {
    const [sessionPath, setSessionPath] = useState(() => {
      try { return localStorage.getItem('volo-vpcal-session-path'); } catch (e) { return null; }
    });
    const [taskId, setTaskId] = useState(null);
    const [phase, setPhase] = useState('idle'); // idle | running | done | error | cancelled
    const [envelope, setEnvelope] = useState(null);
    const [errorMsg, setErrorMsg] = useState(null);
    const [exporting, setExporting] = useState(false);
    const { state, cancel } = useSidecarStream(taskId);

    useEffect(() => {
      if (!state.exit) return;
      const last = state.lines[state.lines.length - 1];
      const env = last && last.parsed && typeof last.parsed === 'object' ? last.parsed : null;
      if (env && env.status === 'ok') {
        setEnvelope(env);
        setPhase('done');
        const q = env.data && env.data.result && env.data.result.quality;
        s.pushLog({ lv: 'ok', cat: 'calibrate', msg: q
          ? `镜头求解完成 · confidence <b>${env.data.confidence}</b> · RMS ${q.reprojection_rms_px.toFixed(3)} px`
          : '镜头求解完成' });
      } else if (env && env.status === 'error') {
        setPhase('error');
        setErrorMsg(env.error && env.error.message);
        s.pushLog({ lv: 'err', cat: 'calibrate', msg: `镜头求解失败 · ${env.error && env.error.message}` });
      } else if (state.exit.cancelled) {
        setPhase('cancelled');
        s.pushLog({ lv: 'warn', cat: 'calibrate', msg: '镜头求解已取消' });
      } else {
        setPhase('error');
        setErrorMsg(state.exit.stderr_tail || `进程异常退出（exit ${state.exit.exit_code}）`);
        s.pushLog({ lv: 'err', cat: 'calibrate', msg: `镜头求解异常退出 · exit ${state.exit.exit_code}` });
      }
      setTaskId(null);
    }, [state.exit]);

    const pickSession = async () => {
      try {
        const p = await pickFile();
        if (p) { setSessionPath(p); try { localStorage.setItem('volo-vpcal-session-path', p); } catch (e) {} }
      } catch (e) {
        s.pushLog({ lv: 'err', cat: 'calibrate', msg: `选择 session 配置失败 · ${e && e.message ? e.message : e}` });
      }
    };

    const runSolve = async () => {
      if (!sessionPath || phase === 'running') return;
      if (!isTauri()) { s.pushLog({ lv: 'err', cat: 'calibrate', msg: '镜头求解失败 · 浏览器预览无后端' }); return; }
      setPhase('running'); setEnvelope(null); setErrorMsg(null);
      s.pushLog({ lv: 'info', cat: 'calibrate', msg: `运行 <b>vpcal quick run</b> · ${sessionPath}` });
      try {
        const resp = await spawnSidecarStreaming('vpcal', ['quick', 'run', '--config', sessionPath, '--output', 'json']);
        setTaskId(resp.task_id);
      } catch (e) {
        setPhase('error');
        setErrorMsg(e && e.message ? e.message : String(e));
        s.pushLog({ lv: 'err', cat: 'calibrate', msg: `镜头求解启动失败 · ${e && e.message ? e.message : e}` });
      }
    };
    const cancelSolve = () => { cancel(); s.pushLog({ lv: 'info', cat: 'calibrate', msg: '请求取消镜头求解…' }); };

    const data = envelope && envelope.data;
    const result = data && data.result;
    const quality = result && result.quality;
    const qa = data && data.qa;
    const t2s = result && result.tracker_to_stage;

    const dof = t2s ? (() => {
      const [tx, ty, tz] = t2s.translation;
      const [rx, ry, rz] = quatToEulerDeg(t2s.rotation);
      return [
        ['t.x (mm)', tx.toFixed(3)], ['t.y (mm)', ty.toFixed(3)], ['t.z (mm)', tz.toFixed(3)],
        ['r.x (deg)', rx.toFixed(3)], ['r.y (deg)', ry.toFixed(3)], ['r.z (deg)', rz.toFixed(3)],
      ];
    })() : [
      ['t.x (mm)', '—'], ['t.y (mm)', '—'], ['t.z (mm)', '—'],
      ['r.x (deg)', '—'], ['r.y (deg)', '—'], ['r.z (deg)', '—'],
    ];

    const qualityRows = quality ? [
      ['RMS (px)', quality.reprojection_rms_px.toFixed(4)],
      ['inlier', String(quality.inlier_observations)],
      ['outlier', String(quality.total_observations - quality.inlier_observations)],
      ['重投影误差 · mean (px)', qa && qa.reprojection && typeof qa.reprojection.global_mean_px === 'number' ? qa.reprojection.global_mean_px.toFixed(4) : '—'],
      ['held-out validation RMS (px)', typeof quality.validation_rms_px === 'number' ? quality.validation_rms_px.toFixed(4) : '—'],
      ['confidence', quality.confidence],
    ] : [
      ['RMS (px)', '—'], ['inlier', '—'], ['outlier', '—'], ['重投影误差 · mean (px)', '—'],
      ['held-out validation RMS (px)', '—'], ['confidence', '—'],
    ];

    const stageStatus = phase === 'done' ? 'done' : phase === 'running' ? 'active' : 'pending';
    const stagesView = LENS_STAGES.map((st) => ({ ...st, status: stageStatus }));

    let alertNode;
    if (phase === 'running') {
      alertNode = h(InlineAlert, { variant: 'informative', title: '求解中' },
        'vpcal quick run 正在执行（validate → detect → solve → report 同进程内顺序完成）。CLI 目前只在流水线结束时输出一次结果，暂无逐阶段进度。');
    } else if (phase === 'error') {
      alertNode = h(InlineAlert, { variant: 'negative', title: '求解失败' }, errorMsg || '未知错误');
    } else if (phase === 'cancelled') {
      alertNode = h(InlineAlert, { variant: 'notice', title: '已取消' }, '镜头求解已取消。');
    } else if (phase === 'done' && quality) {
      const vis = quality.confidence === 'high' ? 'positive' : quality.confidence === 'medium' ? 'notice' : 'negative';
      alertNode = h(InlineAlert, { variant: vis, title: '求解完成' },
        `confidence ${quality.confidence} · backend ${data.solver_backend} · 输出目录 ${data.output_dir}`
        + (data.exit_code === 9 ? '（partial：总观测数偏低，结果置信度低）' : ''));
    } else {
      alertNode = h(InlineAlert, { variant: 'informative', title: '待运行' },
        sessionPath ? '已选择 session 配置，点击「运行求解」执行 vpcal quick run。' : '先选择 session 配置 JSON，再运行求解。');
    }

    /* Session-coupled Quick Lens Estimate (QLE) — vpcal's own identifiability
       warning passed through as-is. The full QLE report treatment (per-param
       kept/locked breakdown, identifiability flags) is a new report view.
       TODO(Claude Design): QLE detail panel. */
    const qle = quality && quality.lens_estimate;

    /* `quick run`'s report stage already auto-writes a spec-frame OpenTrackIO
       export to output_dir/export/tracking_calibrated.jsonl (vpcal/src/vpcal/
       core/pipeline.py L919-923). This button additionally exports the UE-frame
       variant via the dedicated CLI subcommand (vpcal/src/vpcal/cli/export.py
       L49-56: `vpcal export opentrackio --result … --session … --out … --frame
       ue`). Placed inside the Lens panel (not the left sidebar's global「输出」
       list) because that list is shared chrome read by every step via s/left() —
       surfacing this here avoids lifting result/output_dir into shell state for
       a single-step feature. */
    const exportOpenTrackIO = async () => {
      if (!data || !data.output_dir || !sessionPath || exporting) return;
      setExporting(true);
      const outDir = data.output_dir;
      const resultPath = outDir + '/result.json';
      const outPath = outDir + '/export/tracking_calibrated_ue.jsonl';
      s.pushLog({ lv: 'info', cat: 'calibrate', msg: '导出 OpenTrackIO（UE 坐标系）…' });
      try {
        const out = await spawnSidecar('vpcal', ['export', 'opentrackio', '--result', resultPath, '--session', sessionPath, '--out', outPath, '--frame', 'ue', '--output', 'json']);
        if (out.exit_code === 0) s.pushLog({ lv: 'ok', cat: 'calibrate', msg: `导出完成 → <b>${outPath}</b>` });
        else s.pushLog({ lv: 'err', cat: 'calibrate', msg: `导出失败 · exit ${out.exit_code} · ${out.stderr.slice(-400)}` });
      } catch (e) {
        s.pushLog({ lv: 'err', cat: 'calibrate', msg: `导出失败 · ${e && e.message ? e.message : e}` });
      } finally {
        setExporting(false);
      }
    };

    return h(React.Fragment, null,
      h('div', { className: 'canvas-head' },
        h('span', { className: 't' }, '镜头校正'),
        h('span', { className: 'toolchip', onClick: pickSession, style: { cursor: 'pointer' }, title: sessionPath || undefined },
          h(Icon, { name: 'doc', size: 14 }), sessionPath ? sessionPath.split(/[\\/]/).pop() : '选择 session 配置'),
        h('div', { className: 'right' },
          phase === 'running'
            ? h(Button, { variant: 'secondary', size: 'S', icon: h(Icon, { name: 'x', size: 14 }), onPress: cancelSolve }, '取消求解')
            : h(Button, { variant: 'accent', size: 'S', icon: h(Icon, { name: 'target', size: 14 }), isDisabled: !sessionPath, onPress: runSolve }, '运行求解'))),
      h('div', { className: 'lwrap cal-scroll' },
        h('div', { className: 'lstages' },
          stagesView.map((st) => h('div', { key: st.id, className: 'lstage' + (st.status === 'done' ? ' done' : '') + (st.status === 'active' ? ' active' : '') },
            h('div', { className: 'ln' }, st.status === 'done' ? h(Icon, { name: 'check', size: 14 }) : st.n),
            h('div', { className: 'lt' }, st.label),
            h('div', { className: 'lc' }, st.cn + ' · ' + (st.status === 'done' ? '已完成' : st.status === 'active' ? '求解中…' : '待运行'))))),
        h('div', { style: { marginBottom: 14 } }, alertNode),
        qle ? h('div', { style: { marginBottom: 14 } },
          h(InlineAlert, { variant: 'notice', title: 'Session-Coupled 镜头估计' },
            `本次求解含 quick-lens-estimate（confidence ${qle.confidence}），为 session-coupled 非 master 估计，不可跨 session / 镜头设置复用。`)) : null,
        h('div', { style: { display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: 16 } },
          h('div', null,
            h('div', { className: 'surv-sub', style: { marginTop: 0 } }, '变换矩阵 · 6 自由度 (T_tracker_to_stage)'),
            h('div', { className: 'hatch', style: { minHeight: 0, padding: 14 } },
              h('div', { className: 'lmatrix', style: { width: '100%' } },
                dof.map(([k, v]) => h('div', { className: 'lmcell', key: k, style: { textAlign: 'left' } },
                  h('span', { style: { color: 'var(--chrome-faint)', fontSize: 11 } }, k + ' = '), v))))),
          h('div', null,
            h('div', { className: 'surv-sub', style: { marginTop: 0 } }, '求解质量'),
            h('div', { className: 'qbar', style: { flexDirection: 'column' } },
              qualityRows.map(([k, v]) => h('div', { className: 'qmetric', key: k, style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                h('div', { className: 'qk' }, k), h('div', { className: 'qv', style: { color: v === '—' ? 'var(--chrome-faint)' : undefined } }, v)))))),
        /* coverage 建议 / report diff：新报告视图范畴，此次跳过。
           TODO(Claude Design): coverage 建议 + 历史 report diff。 */
        data ? h('div', { style: { marginTop: 16 } },
          h('div', { className: 'surv-sub' }, '输出'),
          h(OutItem, { icon: 'download', label: exporting ? '导出中…' : '导出 OpenTrackIO（UE 坐标系）', sub: 'export/tracking_calibrated_ue.jsonl',
            onClick: exportOpenTrackIO })) : null));
  }

  /* =================== overview band (参考缓存总览的布局形式) =================== */
  const calKpi = (icon, k, big, bigTone, note, noteTone) => h('div', { className: 'kpi' },
    h('div', { className: 'kpi-h' }, h('span', { className: 'kpi-ico' }, h(Icon, { name: icon, size: 15 })), h('span', { className: 'kpi-k' }, k)),
    h('div', { className: 'kpi-v' + (bigTone ? ' ' + bigTone : '') }, big),
    h('div', { className: 'kpi-note' + (noteTone ? ' ' + noteTone : '') }, note));

  /* 「重建」→ reconstruct_surface：需要 Survey 步已导入的 measurementsAbsPath；
     成功后把 surface 直接写入 store（无需等 reloadRuns 的 get_run_report 往返），
     再 reloadRuns 刷新 Runs 列表（含新 run 的 created_at/vertex_count 等）。 */
  const rebuildMesh = async (s, proj) => {
    if (!proj.path || proj.rebuilding) return;
    const screenId = s.calScreen;
    if (!proj.measurementsAbsPath) { s.pushLog({ lv: 'warn', cat: 'calibrate', msg: '重建失败 · 请先在 Survey 步导入测量数据' }); return; }
    projStore.patch({ rebuilding: true });
    try {
      await s.runCmd({ domain: 'calibrate', action: '重建网格', target: screenId, chan: 'local' }, async () => {
        const result = await reconstructSurface(proj.path, screenId, proj.measurementsAbsPath);
        projStore.patch({ reconstruction: { run_id: result.run_id, surface: result.surface, quality_metrics: result.surface.quality_metrics } });
        await reloadRuns(proj.path, screenId);
        return result;
      }, { okMsg: (r) => `重建收敛 · run #${r.run_id} · estimated RMS ${r.surface.quality_metrics.estimated_rms_mm == null ? 'n/a' : r.surface.quality_metrics.estimated_rms_mm.toFixed(2) + ' mm'}` });
    } catch (e) { /* runCmd 已记录失败 */ } finally { projStore.patch({ rebuilding: false }); }
  };

  function calTop(s, proj) {
    const screens = deriveScreens(proj.config);
    const screen = screens.find((x) => x.id === s.calScreen) || screens[0] || { name: '—' };
    const rec = proj.reconstruction;
    const qm = rec && rec.surface.quality_metrics;
    const lensDone  = LENS_STAGES.filter((x) => x.status === 'done').length;
    const lensTotal = LENS_STAGES.length;
    const lensRun   = lensDone === lensTotal;
    const rms = qm ? qm.estimated_rms_mm : null;
    const rmsVis  = rms == null ? 'neutral' : rms < 3 ? 'positive' : rms < 8 ? 'notice' : 'negative';
    const overall = !rec ? 'warning' : rmsVis === 'negative' ? 'critical' : (!lensRun || rmsVis !== 'positive') ? 'warning' : 'healthy';
    const sev = SEVCAL[overall];
    const latestRun = proj.runs && proj.runs[0];
    return h(React.Fragment, null,
      /* 1 · 校正总览条 */
      h('div', { className: 'land-status hero-' + overall },
        h('div', { className: 'ls-badge s-' + sev.visual }, h(Icon, { name: sev.icon, size: 24 })),
        h('div', { className: 'ls-main' },
          h('div', { className: 'ls-line' },
            h('b', null, rms == null ? 'n/a' : rms.toFixed(2) + ' mm'), h('span', { className: 'dim' }, ' RMS · '),
            h('span', null, rec ? '网格已重建' : '网格未重建'), h('span', { className: 'dim' }, ' · '),
            h('b', { className: 's-' + (lensRun ? 'positive' : 'notice') }, lensRun ? '镜头已校正' : '镜头校正未运行')),
          h('div', { className: 'ls-sub' }, '当前 ' + screen.name
            + (rec ? ' · 拓扑 ' + rec.surface.topology.cols + ' × ' + rec.surface.topology.rows + ' · ' + rec.surface.vertices.length.toLocaleString() + ' 顶点' : '')
            + (latestRun ? ' · 上次重建 run #' + latestRun.id + ' · ' + latestRun.created_at : ' · 尚无重建记录'))),
        h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'sync', size: 15 }), isDisabled: proj.rebuilding || !proj.path,
          onPress: () => rebuildMesh(s, proj) }, proj.rebuilding ? '重建中…' : '重建')));
  }

  /* =================== center router =================== */
  function stepView(s, proj) {
    switch (s.calStep) {
      case 'method': return methodView(s);
      case 'survey': return surveyView(s, proj);
      case 'preview': return previewView(s, proj);
      case 'runs': return h(React.Fragment, null,
        h('div', { className: 'canvas-head' }, h('span', { className: 't' }, '重建历史'),
          h('div', { className: 'right' }, h('span', { className: 'toolchip' }, (proj.runs || []).length + ' 次重建'))),
        h(RunsTable, { s, proj }));
      case 'lens': return h(LensPanel, { s });
      default: return h(CabinetEditor, { s });
    }
  }
  function center(s) {
    const proj = useProj();
    /* 仅 Design 步（非 method/survey/preview/runs/lens）走满铺画布：
       画布铺满编辑区，顶部工具栏 / 底部模式按钮 / 图例浮动其上，取消外层卡片框 */
    const bleed = !['method', 'survey', 'preview', 'runs', 'lens'].includes(s.calStep);
    return h(React.Fragment, null,
      h(CalController, { s }),
      h('div', { className: 'dash cal-dash' + (bleed ? ' cal-dash--bleed' : '') },
        !proj.config ? h('div', { className: 'dash-card cal-stage-card' }, projectEmptyState(s, proj)) : h(React.Fragment, null,
          calTop(s, proj),
          h('div', { className: 'dash-card cal-stage-card' + (bleed ? ' is-bleed' : '') }, stepView(s, proj)))));
  }

  /* =================== inspector (per selected object) =================== */
  const KV = (k, v, mono) => h('div', { className: 'kv', key: k },
    h('span', { className: 'k' }, k), h('span', { className: 'v' + (mono ? ' mono' : '') }, v));

  function inspector(s) {
    const proj = useProj();
    const sel = s.calSel;
    /* run 详情需要完整 quality_metrics（ReconstructionRun 摘要只带 estimated_rms_mm），
       按选中 run id 异步取 get_run_report，与 Runs 步 RunsTable 各自独立缓存（不同 Slot fiber）。 */
    const [runReport, setRunReport] = useState(null);
    useEffect(() => {
      if (!sel || sel.type !== 'run') return;
      let cancelled = false;
      getRunReport(sel.id).then((rep) => { if (!cancelled) setRunReport({ id: sel.id, data: rep }); })
        .catch((e) => { if (!cancelled) setRunReport({ id: sel.id, error: e && e.message ? e.message : String(e) }); });
      return () => { cancelled = true; };
    }, [sel && sel.type === 'run' ? sel.id : null]);

    if (!sel) return h('div', { className: 'insp-empty' },
      h('div', { className: 'ph' }, h(Icon, { name: 'target', size: 30 })),
      h('div', null, h('div', { style: { color: 'var(--chrome-dim)', fontWeight: 600, marginBottom: 4 } }, '未选择对象'), '选择 cabinet / 测量点 / 重建记录'));

    if (sel.type === 'cabinetMulti') {
      const bd = sel.bd || {};
      const order = [['normal', 'informative'], ['masked', 'neutral'], ['below', 'notice'], ['ref', 'positive']].filter(([k]) => bd[k]);
      return h(React.Fragment, null,
        h('div', { className: 'insp-head' },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 } },
            h('span', { className: 'step-ico' }, h(Icon, { name: 'grid', size: 16 })),
            h('h2', { style: { margin: 0, fontSize: 15, fontWeight: 700, fontFamily: 'var(--font-code)' } }, '已选 ' + sel.count + ' 个 Cabinet')),
          h('span', { className: 'spill spill--informative' }, h(Icon, { name: 'check', size: 13 }), '多选')),
        h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, '选区构成'),
          order.length ? order.map(([k, v]) => h('div', { className: 'kv', key: k },
            h('span', { className: 'k' }, h('span', { className: 'sdot bg-' + v, style: { display: 'inline-block', marginRight: 7 } }), CAB_STATE[k]),
            h('span', { className: 'v' }, bd[k]))) : h('div', { style: { fontSize: 12, color: 'var(--chrome-faint)' } }, '—')),
        h('div', { className: 'insp-sect' },
          h('div', { style: { fontSize: 11.5, color: 'var(--chrome-faint)', lineHeight: 1.55 } }, '左键拖动可框选，按住 ⌘ / Alt 点击可加选或减选；切到遮罩 / 参考点 / 基线模式可对选区批量编辑。')));
    }

    if (sel.type === 'cabinet') {
      const st = sel.state || 'normal';
      const screens = deriveScreens(proj.config);
      const sc = screens.find((x) => x.id === s.calScreen) || screens[0] || { cols: 0 };
      const stVis = st === 'masked' ? 'neutral' : st === 'below' ? 'notice' : st === 'ref' ? 'positive' : 'informative';
      return h(React.Fragment, null,
        h('div', { className: 'insp-head' },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 } },
            h('span', { className: 'step-ico' }, h(Icon, { name: 'grid', size: 16 })),
            h('h2', { style: { margin: 0, fontSize: 15, fontWeight: 700, fontFamily: 'var(--font-code)' } }, `Cabinet ${sel.col},${sel.row}`)),
          h('span', { className: 'spill spill--' + stVis }, h(Icon, { name: st === 'normal' ? 'check' : 'panel', size: 13 }), CAB_STATE[st])),
        h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, '位置'),
          KV('列 (col)', sel.col, true), KV('行 (row)', sel.row, true), KV('面板索引', `#${sel.row * sc.cols + sel.col}`, true)),
        h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, '状态'),
          h('div', { className: 'kv' }, h('span', { className: 'k' }, '类型'), h('span', { className: 'v' }, CAB_STATE[st])),
          KV('参与重建', st === 'masked' ? '否（遮罩，保存后写回 irregular_mask）' : '是'),
          KV('ref 角色', sel.role ? ROLE[sel.role].label : '—', !!sel.role)),
        sel.role ? h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, '坐标系角色（本地预览）'),
          h('div', { style: { fontSize: 12, color: 'var(--chrome-dim)', lineHeight: 1.5 } },
            '此标记不写回工程 —— 真实 coordinate_system 绑定的是顶点点名而非 cabinet 格子，见 Design 画布下方的只读参考点展示。')) : null);
    }

    if (sel.type === 'point') {
      const p = proj.measured && proj.measured.points && proj.measured.points.find((x) => x.name === sel.id);
      if (!p) return null;
      const coord = proj.config && proj.config.coordinate_system;
      const role = !coord ? null : p.name === coord.origin_point ? 'origin' : p.name === coord.x_axis_point ? 'x_axis' : p.name === coord.xy_plane_point ? 'xy_plane' : null;
      const sigma = sigmaApproxMm(p.uncertainty);
      const measuredReal = sigma == null || sigma < FABRICATED_SIGMA_THRESHOLD_MM;
      const sigVis = sigma == null ? 'informative' : sigma < 3 ? 'positive' : sigma < 8 ? 'notice' : 'negative';
      return h(React.Fragment, null,
        h('div', { className: 'insp-head' },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 } },
            h('span', { className: 'step-ico' }, h(Icon, { name: 'pin', size: 16 })),
            h('h2', { style: { margin: 0, fontSize: 15, fontWeight: 700, fontFamily: 'var(--font-code)' } }, p.name)),
          h('div', { style: { display: 'flex', gap: 7, alignItems: 'center' } },
            h('span', { className: 'spill spill--' + (measuredReal ? 'positive' : 'notice') }, h(Icon, { name: measuredReal ? 'check' : 'alert', size: 13 }), measuredReal ? '实测' : '推测'),
            role ? h(Badge, { variant: 'accent', size: 'S' }, ROLE[role].label) : null)),
        h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, '坐标 [x, y, z] (m)'),
          KV('x', p.position[0].toFixed(4), true), KV('y', p.position[1].toFixed(4), true), KV('z', p.position[2].toFixed(4), true)),
        h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, '质量'),
          h('div', { className: 'kv' }, h('span', { className: 'k' }, '来源'), h('span', { className: 'v' }, measuredReal ? 'measured 实测' : 'guessed 推测（σ 高于 5mm 启发式阈值）')),
          h(Stat, { k: '不确定度 σ', v: sigma == null ? 'n/a' : sigma.toFixed(1) + ' mm', pct: sigma == null ? 0 : Math.min(100, sigma / 12 * 100), variant: sigVis })));
    }

    if (sel.type === 'run') {
      const r = (proj.runs || []).find((x) => x.id === sel.id);
      if (!r) return null;
      const rep = runReport && runReport.id === sel.id ? runReport : null;
      const qm = rep && rep.data && rep.data.quality_metrics;
      return h(React.Fragment, null,
        h('div', { className: 'insp-head' },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 } },
            h('span', { className: 'step-ico' }, h(Icon, { name: 'list', size: 16 })),
            h('h2', { style: { margin: 0, fontSize: 15, fontWeight: 700, fontFamily: 'var(--font-code)' } }, r.target || ('run #' + r.id))),
          h('div', { style: { display: 'flex', gap: 7, alignItems: 'center' } }, rmsBadge(r.estimated_rms_mm),
            h('span', { style: { fontSize: 11.5, color: 'var(--chrome-faint)' } }, r.created_at))),
        h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, '概要'),
          KV('方法', r.method), KV('屏幕', r.screen_id), KV('顶点数', r.vertex_count ? r.vertex_count.toLocaleString() : '—', true), KV('OBJ', r.output_obj_path ? '已导出' : '未导出')),
        qm ? h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, '质量指标 (mm)'),
          h(Stat, { k: 'middle_max_dev', v: qm.middle_max_dev_mm.toFixed(2), pct: Math.min(100, qm.middle_max_dev_mm / 12 * 100), variant: qm.middle_max_dev_mm < 3 ? 'positive' : qm.middle_max_dev_mm < 8 ? 'notice' : 'negative' }),
          h(Stat, { k: 'middle_mean_dev', v: qm.middle_mean_dev_mm.toFixed(2), pct: Math.min(100, qm.middle_mean_dev_mm / 8 * 100), variant: 'positive' }),
          h(Stat, { k: 'estimated_rms', v: qm.estimated_rms_mm == null ? 'n/a' : qm.estimated_rms_mm.toFixed(2), pct: qm.estimated_rms_mm == null ? 0 : Math.min(100, qm.estimated_rms_mm / 12 * 100), variant: qm.estimated_rms_mm == null ? 'informative' : qm.estimated_rms_mm < 3 ? 'positive' : qm.estimated_rms_mm < 8 ? 'notice' : 'negative' }),
          h(Stat, { k: 'estimated_p95', v: qm.estimated_p95_mm == null ? 'n/a' : qm.estimated_p95_mm.toFixed(2), pct: qm.estimated_p95_mm == null ? 0 : Math.min(100, qm.estimated_p95_mm / 16 * 100), variant: 'notice' }),
          h(Stat, { k: 'extrapolated 顶点', v: String(qm.extrapolated_count), pct: 0, variant: qm.extrapolated_count ? 'notice' : 'positive' }))
          : h('div', { className: 'insp-sect' }, h('div', { style: { fontSize: 12, color: 'var(--chrome-faint)' } },
              rep && rep.error ? `质量指标加载失败 · ${rep.error}` : '加载中…')));
    }
    return null;
  }

  window.VOLO_PAGES = window.VOLO_PAGES || {};
  window.VOLO_PAGES.calibrate = { ctx, left, center, inspector };
})();

export {};
