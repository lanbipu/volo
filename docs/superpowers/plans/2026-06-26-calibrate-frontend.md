# Calibrate 页 mock-first 前端 · 实现计划

> **For agentic workers:** 本计划由主 session inline 执行（executing-plans）。步骤用 `- [ ]` 跟踪。

**Goal:** 把设计稿 `page_calibrate.jsx` 1:1 移植为本仓 React+TS 的 Calibrate 页（mock 数据，全交互），替换现有骨架占位。

**Architecture:** 新建 `src/features/calibrate/` 模块（state/ui/page/views），导出 `calibratePage: Page` 与 `CalibrateProvider`；替换 `PAGE_REGISTRY.calibrate`，四区组件用新 `useCalibrate` store 取状态，日志复用 `useCache().pushLog`。

**Tech Stack:** React 19 + TypeScript (strict)、现有 `features/cache` 自定义 UI 体系、`_app.css` 既有 CSS 类。无新依赖。

## Global Constraints（每个任务隐含遵守）

- **无新依赖**：不引入测试框架 / RS2 / 任何 npm 包。
- **Page 契约无 props**：四区组件 `ComponentType`，各自用 hook（`useCalibrate`/`useCache`）取状态。
- **日志**：组件调 `useCache().pushLog({lv, cat:'calibrate', msg})` / `pushLogs([...])` 推同一 NDJSON 控制台。
- **CSS 复用**：优先用 `_app.css` 既有 calibrate 类（已全部存在）；仅当某类缺失才补到 `features/cache/styles/cache.css` 末尾（如 `badge`）。不改既有类。
- **验证闸**（每任务末）：`pnpm exec tsc --noEmit` 通过 + `pnpm exec vite build` 通过；交互任务额外 `tauri dev` 实跑截图确认。
- **不自动 git commit**（用户规则：仅在用户要求时提交）。
- **Surgical**：除 3 处接线（`registry.tsx`/`data.ts`/`App.tsx`），不改 Cache / 其它页 / 外壳 chrome。
- **移植基准**：设计真相源 = Claude Design 项目 `cb382984-2766-473e-80c0-9d9912a73cd6` 的 `src/page_calibrate.jsx`（交互逻辑）+ `src/data.jsx` 的 `CAL_*` 段（mock 值）。用 DesignSync `get_file` 取。

---

## 文件结构

```
src/features/calibrate/
  index.tsx                 # 导出 calibratePage(Page) + CalibrateProvider
  state/
    types.ts                # CalScreen/CalStep/CalMethod/CalSelection/Run/Point... 类型
    data.ts                 # mock 常量（CAL_SCREENS/STEPS/POINTS/RUNS/MESH_METRICS/SURVEY_REPORT/LENS_STAGES/STEP_DETAIL/ROLE/CAB_STATE/SEVCAL）
    store.tsx               # CalibrateProvider + useCalibrate
  ui/
    Badge.tsx               # 变体色 + size
    InlineAlert.tsx         # variant + title
    Stat.tsx                # k/v + vmeter 进度条
  page/
    Ctx.tsx                 # 上下文工具条（含 ExportDrop）
    Left.tsx                # 工作流导航（StepItem + 双进度）
    Center.tsx              # CalTop + stepView 路由
    Inspector.tsx           # 4 态
  views/
    CalTop.tsx
    CabinetEditor.tsx
    MethodView.tsx
    SurveyView.tsx
    PreviewView.tsx
    MeshPreview3D.tsx
    RunsTable.tsx
    LensView.tsx
```
接线修改：`shell/pages/registry.tsx`、`shell/data.ts`、`App.tsx`。

---

## Task 1: 脚手架（store + mock data + 接线，空四区）

**Files:**
- Create: `src/features/calibrate/state/types.ts`、`state/data.ts`、`state/store.tsx`、`index.tsx`
- Modify: `src/shell/pages/registry.tsx`、`src/shell/data.ts:19`、`src/App.tsx`

**Interfaces — Produces:**
- `types.ts`: `CalStep = 'design'|'method'|'survey'|'preview'|'runs'|'lens'`；`CalMethod='m1'|'m2'`；`CalRole='origin'|'x_axis'|'xy_plane'`；`CabState='normal'|'masked'|'below'|'ref'`；`CalSelection`（判别联合：`{type:'cabinet',col,row,state:CabState,role:CalRole|null}` | `{type:'cabinetMulti',count:number,bd:Record<CabState,number>}` | `{type:'point',id:string}` | `{type:'run',id:string}`）；`CalScreen{id,name,cols,rows,panels}`；`CalStepDef{id:CalStep,n:number,label,cn,group:'mesh'|'lens',status:'done'|'active'|'ready'|'idle'}`；`CalPoint{id,name,role?:CalRole,xyz:[number,number,number],measured:boolean,err:number,sigma:number}`；`MeshMetrics{cols,rows,vertices,est_rms,mid_max,mid_mean,est_p95}`；`SurveyReport{measured,fabricated,outlier,missing,warnings:{lv:'warn'|'info',msg:string}[]}`；`CalRun{id,created,screen,method,rms:number|null,vertices:number|null,target,obj:boolean,metrics?:{mid_max,mid_mean,est_rms,est_p95}}`；`LensStage{id,n:number,label,cn,status:'done'|'active'|'idle'}`。
- `store.tsx`: `useCalibrate(): { calScreen, setCalScreen, calStep, setCalStep, calMethod, setCalMethod, calSel, setCalSel }`；`CalibrateProvider`。
- `index.tsx`: `export const calibratePage: Page`（Task 1 阶段四区先渲染最小占位）；`export { CalibrateProvider }`。

**Steps:**
- [ ] **1.1** 用 DesignSync 取 `src/data.jsx`，提取 `CAL_SCREENS/CAL_STEPS/CAL_POINTS/CAL_RUNS/MESH_METRICS/SURVEY_REPORT/LENS_STAGES`（及 `ROLE/CAB_STATE/SEVCAL/STEP_DETAIL` 若在其中）的实际值。
- [ ] **1.2** 写 `state/types.ts`（上面 Produces 的全部类型）。
- [ ] **1.3** 写 `state/data.ts`：把 1.1 的 mock 值落为带类型的 `export const`；`ROLE`(各角色 label/short/color css var)、`CAB_STATE`(normal/masked/below/ref→中文)、`SEVCAL`(healthy/warning/critical→{visual,icon})、`STEP_DETAIL`(每步说明，取自 page_calibrate.jsx 内联定义)。
- [ ] **1.4** 写 `state/store.tsx`：`createContext` + `CalibrateProvider`（`useState` 初值 `calScreen=CAL_SCREENS[0].id`、`calStep='design'`、`calMethod='m1'`、`calSel=null`）+ `useCalibrate` hook（context 缺失抛错）。
- [ ] **1.5** 写 `index.tsx`：`calibratePage` 四区暂用最小占位（`Ctx`=CtxTitle、`Left`/`Center`/`Inspector`=空 div 占位），导出 `CalibrateProvider`。
- [ ] **1.6** 接线：`registry.tsx` 引入 `calibratePage` 替换 `makeSkeleton(CALIBRATE_CFG)`；`shell/data.ts` calibrate 行 `skeleton:false`；`App.tsx` 在 `MachinesProvider` 内层包 `CalibrateProvider`。
- [ ] **1.7** 验证：`pnpm exec tsc --noEmit` + `pnpm exec vite build` 通过。

---

## Task 2: UI 原子 Badge / InlineAlert / Stat

**Files:** Create `src/features/calibrate/ui/Badge.tsx`、`InlineAlert.tsx`、`Stat.tsx`；按需 Modify `src/features/cache/styles/cache.css`（补 `badge` 类，若 `_app.css` 无）。

**Interfaces — Produces:**
- `Badge({variant, size='S', children})`：`variant: 'positive'|'notice'|'negative'|'neutral'|'accent'`。
- `InlineAlert({variant, title, children})`：`variant:'informative'|'notice'|'positive'|'negative'`。
- `Stat({k, v, pct, variant='informative'})`：渲染 `statrow`+`vmeter`（对应设计稿 shell.jsx 的 Stat）。

**Steps:**
- [ ] **2.1** grep `_app.css` 是否有 `.badge` / `.statrow`；缺则在 `cache.css` 末尾补最小样式（badge：inline-flex 小标签，按 variant 用 `--{variant}-visual`；statrow 已有 vmeter 则仅补 statrow 容器）。
- [ ] **2.2** 写三个原子组件（纯展示，参照设计稿 `rmsBadge`/`InlineAlert` 用法 + shell.jsx `Stat`）。
- [ ] **2.3** 验证：`tsc --noEmit` + `vite build` 通过。

---

## Task 3: Ctx + Left + CalTop

**Files:** Create `page/Ctx.tsx`、`page/Left.tsx`、`views/CalTop.tsx`；Modify `index.tsx`（接入 Ctx/Left；Center 暂挂 CalTop+占位）。

**Interfaces — Consumes:** `useCalibrate`、`useCache().pushLog/pushLogs`、`CAL_SCREENS/CAL_STEPS/STEP_DETAIL/MESH_METRICS/CAL_RUNS/LENS_STAGES/SEVCAL`、复用 `Icon/Selector/Button/CtxTitle`。

**Steps:**
- [ ] **3.1** `Ctx.tsx`：移植设计稿 `ctx(s)` + `ExportDrop`（屏幕 Selector、重建/导出下拉/指导卡按钮 → `pushLog(s)`）。外部点击关闭 popover 用 `useEffect` + ref。
- [ ] **3.2** `Left.tsx`：移植 `left(s)` + `StepItem`（`CAL_STEPS` 按 group 分两组、当前项展开 `STEP_DETAIL`、点击 `setCalStep`）+ 底部双 `vmeter`（进度由 `CAL_STEPS`/`LENS_STAGES` 的 done 计数算）。
- [ ] **3.3** `CalTop.tsx`：移植 `calTop(s)` —— `land-status hero`，tone 由 `est_rms`+镜头是否运行经 `SEVCAL` 推导，重建按钮 `pushLogs`。
- [ ] **3.4** `index.tsx`：`Ctx`/`Left` 接真组件；`Center` 暂 = `<CalTop/>` + 占位 div。
- [ ] **3.5** 验证：`tsc` + `build`；`tauri dev` 切「校正」tab，截图确认工具条/左栏/KPI 条渲染。

---

## Task 4: 简单视图 + Center 路由 + Inspector(empty/point/run)

**Files:** Create `views/MethodView.tsx`、`views/SurveyView.tsx`、`views/RunsTable.tsx`、`views/LensView.tsx`、`page/Center.tsx`、`page/Inspector.tsx`；Modify `index.tsx`（Center/Inspector 接真）。

**Interfaces — Produces:** `Center`（`stepView` switch：design→占位、method→MethodView、survey→SurveyView、preview→占位、runs→RunsTable、lens→LensView；外包 `dash cal-dash` + CalTop + `dash-card`）；`Inspector`（按 `calSel.type` 分支，Task 4 实现 empty/point/run，cabinet/cabinetMulti 留 Task 5）。

**Steps:**
- [ ] **4.1** `MethodView.tsx`：移植 `methodView(s)`（M1/M2 双 `mcard`，`Badge` 当前态，切换 `setCalMethod`+pushLog，继续→`setCalStep('survey')`）。
- [ ] **4.2** `SurveyView.tsx`：移植 `surveyView(s)`（M2→hatch 占位；M1→`stile` 瓦片 + `InlineAlert` + `ptable` 参考点表，行点击 `setCalSel({type:'point',id})`）。
- [ ] **4.3** `RunsTable.tsx`：移植 `RunsTable`（`runtable` + `CAL_RUNS` 行、rms `Badge`、OBJ 下载 pushLog、点击 `setCalSel({type:'run'})`+展开 `rt-exp`）。
- [ ] **4.4** `LensView.tsx`：移植 `lensView(s)`（`LENS_STAGES` 阶段条 + `InlineAlert` 占位 + 7-DOF 矩阵全 `—` + 求解质量全 `—`）。
- [ ] **4.5** `Inspector.tsx`：移植 `inspector(s)` 的 empty / point / run 分支（用 `Stat`/`Badge`/`spill`）；cabinet/cabinetMulti 先返回 null（Task 5 补）。
- [ ] **4.6** `Center.tsx`：`stepView` switch（design/preview 暂占位 div）；`index.tsx` Center/Inspector 接真。
- [ ] **4.7** 验证：`tsc`+`build`；`dev` 实跑：method/survey/runs/lens 四步可切换渲染，点参考点/历史行 inspector 更新。

---

## Task 5: CabinetEditor + Inspector(cabinet/cabinetMulti)

**Files:** Create `views/CabinetEditor.tsx`；Modify `page/Inspector.tsx`（补 cabinet/cabinetMulti）、`page/Center.tsx`（design→CabinetEditor）。

**Interfaces — Consumes:** `useCalibrate`（calScreen/calSel/setCalSel）、`CAL_SCREENS/ROLE/CAB_STATE`。

**Steps:**
- [ ] **5.1** `CabinetEditor.tsx`：移植设计稿 `CabinetEditor` + `seedCells` 全量 —— cells map、mode(select/mask/refs/baseline)、role、undo/redo stack、zoom/pan(wheel+右键拖)、marquee 框选(左键拖)、⌘/Alt 多选、`ResizeObserver` fit、键盘(M/R/B/Esc/1/2/3/⌘Z/⌘⇧Z/⌘Y)、selKeys↔`setCalSel`(单选 cabinet / 多选 cabinetMulti 含 `bd` 构成)、头部 zoombar+undo/redo、modebar+role-seg、leg 图例。TS 适配：事件类型标注、`useRef` 泛型、`Set<string>` 选区、effect cleanup。
- [ ] **5.2** `Inspector.tsx`：补 cabinet（位置/状态/ref 角色/坐标系说明）+ cabinetMulti（选区构成 `bd` + 多选提示）分支。
- [ ] **5.3** `Center.tsx`：`stepView` design 分支 → `<CabinetEditor/>`。
- [ ] **5.4** 验证：`tsc`+`build`；`dev` 实跑：框选/⌘-Alt 多选/三模式切换/undo-redo/wheel 缩放/右键平移/键盘快捷键全部工作，inspector cabinet 与 cabinetMulti 正确联动。

---

## Task 6: MeshPreview3D + PreviewView

**Files:** Create `views/MeshPreview3D.tsx`、`views/PreviewView.tsx`；Modify `page/Center.tsx`（preview→PreviewView）。

**Steps:**
- [ ] **6.1** `MeshPreview3D.tsx`：移植设计稿 `MeshPreview3D` 全量 —— 圆弧墙参数化 + yaw/pitch 旋转矩阵 + 透视投影 `pt`/`project`、网格线 lines、低置信 hatch、采样点 dots、地面 ground plane、`<defs>` pattern；左键旋转/右键平移/wheel 缩放，effect cleanup。TS 适配：数值运算、ref、SVG 元素 props。
- [ ] **6.2** `PreviewView.tsx`：移植 `previewView(s)`（头部拓扑/顶点/rms `Badge` + `cabstage` 内嵌 MeshPreview3D + `qbar` 质量指标 `Q`）。
- [ ] **6.3** `Center.tsx`：preview → `<PreviewView/>`。
- [ ] **6.4** 验证：`tsc`+`build`；`dev` 实跑：preview 步显示 3D 网格，左键旋转/右键平移/wheel 缩放工作。

---

## Task 7: 收尾与全量验证

**Files:** （Task 1 已 overwrite 旧 `features/calibrate/index.tsx` dead stub）。

**Steps:**
- [ ] **7.1** 全量验证：`pnpm exec tsc --noEmit` + `pnpm exec vite build` 全绿。
- [ ] **7.2** `tauri dev` 实跑逐条核对 spec §7 验证标准：6 步切换、CabinetEditor 全交互、MeshPreview3D 旋转、Inspector 4 态、各按钮推日志到控制台、暗/亮主题、Cache 等其它页无回归。
- [ ] **7.3** 截图 Calibrate 各关键视图（design/method/survey/preview/runs/lens）确认 1:1 还原。
- [ ] **7.4** 向用户汇报完成 + 截图；保留 `features/{color,live,previz,tools}/index.tsx` 其它 dead stub 不动（非本次范围，surgical）。

---

## 自审记录

- **Spec 覆盖**：§3 架构→Task1；§3.4 新原子→Task2；§4 组件分解→Task3-6（ctx/left/calTop/6 视图/inspector 4 态全覆盖）；§7 验证→Task7。Overlay 不提供（spec §4）已体现（index.tsx 不设 Overlay）。
- **占位扫描**：移植型组件以「参照设计稿 X 函数 + TS 适配点」描述（设计稿是逐行真相源，inline 执行者在 context 内持有），非 placeholder。
- **类型一致**：`CalStep/CalMethod/CalRole/CabState/CalSelection` 在 Task1 types.ts 统一定义，后续任务引用同名。

## 执行方式

Inline（executing-plans）：主 session 顺序执行 Task 1→7，每任务末验证闸；按用户授权「不再逐步确认」，连续推进，仅在验证失败或需决策时停。
