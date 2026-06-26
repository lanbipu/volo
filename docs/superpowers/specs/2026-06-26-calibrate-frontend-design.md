# Calibrate 页 · mock-first 前端实现设计规格

- **日期**：2026-06-26
- **来源**：Claude Design handoff `Volo.html` → `src/page_calibrate.jsx`（设计真相源）
- **路径决策**：mock-first。本 spec = **第一期**（纯前端 UI + 全交互，mock 数据）；**第二期**（接真 `mesh_*` Tauri 命令）另立 spec。
- **范围**：切片 A+B+C 一次性 —— 整个 mock UI，含两个重交互单元 `CabinetEditor` 与 `MeshPreview3D`。

## 1. 范围

### In scope（第一期）
- Calibrate 页四区（`Ctx`/`Left`/`Center`/`Inspector`）完整实现，替换现有 `makeSkeleton(CALIBRATE_CFG)` 占位。
- 6 步工作流路由：网格设计(CabinetEditor) / 重建方法 / 测量导入 / 网格预览(MeshPreview3D) / 重建历史 / 镜头校正。
- `calTop` KPI 总览条、Inspector 4 态（cabinet / cabinetMulti / point / run）。
- 全部交互：框选/多选/undo-redo/缩放平移/三编辑模式/键盘快捷键、3D 旋转、可展开历史表。
- mock 数据驱动；按钮动作推日志到现有 NDJSON 控制台。

### Out of scope（留第二期 / 设计本就占位）
- 接真 `mesh_projects/mesh_reconstruct/mesh_total_station/mesh_measurements/mesh_export` 命令。
- 镜头校正实际求解（设计稿 `lensView` 本就是占位流程，全 `—`）。
- M2 视觉测量导入面板（设计稿标注「未实现」hatch 占位，保持占位）。
- 不改动 Cache / 其它页 / 外壳 chrome（surgical）。

## 2. 现状与架构事实（已核实）

- 本仓单一桌面外壳 `src/shell/Shell.tsx`：`const pg = PAGE_REGISTRY[page]` → 渲染 `pg.Ctx/Left/Center/Inspector` + 可选 `pg.Overlay`。
- `PAGE_REGISTRY`（`shell/pages/registry.tsx`）：`previz/calibrate/color/live/tools`，calibrate 当前 = `makeSkeleton(CALIBRATE_CFG)`。
- **Page 契约**（`shell/pages/types.ts`）：`{ Ctx, Left, Center, Inspector: ComponentType; Overlay?: ComponentType }` —— **无 props**，四区组件各自用 hook 取状态。
- 状态：`useShell`（page/platform/theme/density/leftW/rightW/stage）；`useCache`（cache 域 + `pushLog`/`logs`/`tasks`）。`LogPanel` 全局挂在 Shell，读 `useCache().logs`。
- Provider 栈（`App.tsx`）：`ShellProvider > CacheProvider > MachinesProvider > Shell`。
- **CSS 已就绪**：43 个 calibrate 专属类（`cabwrap/cabstage/cabgrid/cstep/mcard/surv/stile/ptable/prow/runtable/rt-row/rt-exp/lstage/qmetric/qbar/land-status/kpi/cal-dash/cal-list/modebar/role-seg/leg/zoombar/vmeter/hatch/insp-head/insp-sect/marquee-box/cal-stage-card/cal-scroll/farm-roll/step-d/rot-hint/cal-axis/prev-badge/lmatrix/lmcell/toolchip/spill/mbtn`）全部存在于 `features/cache/styles/_app.css`。
- **Icon 全覆盖**：calibrate 所需图标名在 `features/cache/ui/Icon.tsx` 的 `ICON_PATHS` 中均已存在。
- `features/cache/ui/status.tsx` 提供 `spill` pill（`StatusPill/TonePill`）；**缺** `Badge`/`InlineAlert`/`Stat`。

## 3. 目标架构

### 3.1 挂载
1. 新建 `src/features/calibrate/` 模块，导出 `calibratePage: Page` 与 `CalibrateProvider`。
2. `shell/pages/registry.tsx`：`calibrate: calibratePage`（替换 `makeSkeleton`）。
3. `shell/data.ts`：`PAGES` 中 calibrate 的 `skeleton: false`。
4. `App.tsx` Provider 栈加入 `CalibrateProvider`（包在 `MachinesProvider` 内层、`Shell` 外层即可）。

### 3.2 状态：`useCalibrate`
- 全局页面状态（对应设计稿 `s.calScreen/calStep/calMethod/calSel` + setter）：
  - `calScreen: string`、`calStep: 'design'|'method'|'survey'|'preview'|'runs'|'lens'`
  - `calMethod: 'm1'|'m2'`、`calSel: CalSelection | null`
- `CalSelection` 判别联合：`{type:'cabinet',col,row,state,role?}` | `{type:'cabinetMulti',count,bd}` | `{type:'point',id}` | `{type:'run',id}`。
- **局部 UI 状态留在组件内 `useState`**（与设计稿一致）：`CabinetEditor` 的 `cells/mode/role/undoStack/redoStack/zoom/pan/selKeys/marquee`；`MeshPreview3D` 的 `rot/zoom/pan`。不进全局 store。
- **日志**：组件通过 `useCache().pushLog/pushLogs` 推同一 NDJSON 控制台，`cat:'calibrate'`（mock-first 阶段复用 cache 域日志设施；若未来日志上移至 shell store，再调整，影响面仅这几处调用）。

### 3.3 文件结构（仿 `features/cache`）
```
src/features/calibrate/
  index.tsx                 # 导出 calibratePage(Page) + CalibrateProvider
  state/
    store.tsx               # CalibrateProvider + useCalibrate
    data.ts                 # mock 常量（见 §5）+ 类型
  ui/
    Badge.tsx               # 新建（变体色 + size）
    InlineAlert.tsx         # 新建（variant + title）
    Stat.tsx                # 新建（k/v + vmeter 进度条）
  page/
    Ctx.tsx                 # 上下文工具条（含 ExportDrop）
    Left.tsx                # 工作流导航（StepItem + 双进度）
    Center.tsx              # calTop + stepView 路由
    Inspector.tsx           # 4 态
  views/
    CalTop.tsx              # KPI 总览条
    CabinetEditor.tsx       # 网格编辑器（重）
    MethodView.tsx
    SurveyView.tsx
    PreviewView.tsx         # 含 MeshPreview3D
    MeshPreview3D.tsx       # SVG 3D 渲染器（重）
    RunsTable.tsx
    LensView.tsx
```
> 复用：`features/cache/ui/{Icon,Selector,Button}`、`shell/chrome` 的 `CtxTitle`、`status.tsx` 的 `spill`。
> 顺手清理：现有无人引用的 `features/calibrate/index.tsx`（21 行 dead stub）被本模块替换。

### 3.4 复用 vs 新建
| 项 | 决策 |
|---|---|
| `Icon`/`Selector`/`Button`/`CtxTitle` | 复用现有 |
| `spill` pill（inspector 标签） | 复用 CSS |
| `Badge`（rmsBadge、方法卡标记、point role） | **新建** 自定义（variant positive/notice/negative/neutral/accent + size S）。设计稿用 RS2，本仓走自定义 |
| `InlineAlert`（survey 警告、lens 占位提示） | **新建**，仿 `skeleton.tsx` 的 `InlineNote` |
| `Stat`（inspector 进度条 k/v/pct/variant） | **新建**，用现成 `vmeter`/`statrow` 类 |
| mock 数据 | 从设计 `data.jsx` 的 `CAL_*` 段移植到 `state/data.ts` |

## 4. 组件分解（交互契约）

- **Ctx**：`CtxTitle` + 屏幕 `Selector(CAL_SCREENS)` + 动作（重建 → 推日志；`ExportDrop` 导出下拉 Disguise/Unreal/Neutral → 推日志；生成指导卡 → 推日志）。
- **Left**：网格重建组 + 镜头校正组（`CAL_STEPS` 按 `group` 分），`StepItem`（序号/标签/中英/状态，当前项展开 `STEP_DETAIL`，点击 `setCalStep`）；底部双 `vmeter` 进度（重建 4/5、镜头未运行）。
- **Center** = `dash cal-dash`：`CalTop` + `dash-card` 内 `stepView` 路由。
- **CalTop**：`land-status` hero —— RMS、网格/镜头状态、概要行、重建按钮（推日志）。tone 由 `MESH_METRICS.est_rms` + 镜头是否运行推导（`SEVCAL`）。
- **stepView 路由**：`design→CabinetEditor`（default）、`method→MethodView`、`survey→SurveyView`、`preview→PreviewView`、`runs→RunsTable`、`lens→LensView`。
- **CabinetEditor**（重）：
  - `cols×rows` 网格（`seedCells` 初始化 masked/below/ref 角色）。
  - 模式 `select/mask/refs/baseline`；refs 子角色 `origin/x_axis/xy_plane`。
  - 左键拖动 marquee 框选；⌘/Alt 点击多选加减；右键拖动平移；wheel 缩放；undo/redo。
  - 键盘：`M/R/B` 切模式、`Esc` 回 select、`1/2/3` 选角色、`⌘Z/⌘⇧Z/⌘Y` 撤销重做。
  - 选择同步 `setCalSel`（单选 cabinet / 多选 cabinetMulti，含 state 构成 `bd`）。
  - `ResizeObserver` fit；头部 `zoombar` + undo/redo 按钮；`modebar` + `role-seg`；`leg` 图例。
- **MethodView**：M1/M2 双 `mcard`，当前态 `Badge`，切换 `setCalMethod` + 推日志，「继续」→ `setCalStep('survey')`。
- **SurveyView**：M1 = 4 计数瓦片(`stile`) + `InlineAlert` 警告 + 参考点表(`ptable`，行点击 `setCalSel({type:'point'})`)；M2 = `hatch` 未实现占位。
- **PreviewView**：头部拓扑/顶点/RMS badge + `cabstage` 内嵌 `MeshPreview3D` + 底部 `qbar` 质量指标。
- **MeshPreview3D**（重）：纯 SVG 手写 3D —— 圆弧墙参数化 + yaw/pitch 旋转矩阵 + 透视投影；网格线/低置信 hatch/采样点/地面网格；左键旋转、右键平移、wheel 缩放。
- **RunsTable**：`runtable` 表头 + `CAL_RUNS` 行（rms badge / 顶点 / OBJ 下载推日志），行点击 `setCalSel({type:'run'})` 并展开报告 `rt-exp`(qbar)。
- **LensView**：占位 —— `LENS_STAGES` 阶段条 + `InlineAlert` 占位说明 + 7-DOF 矩阵(全 `—`) + 求解质量(全 `—`)；「运行求解」仅推占位日志。
- **Inspector**（4 态）：
  - 空：提示选择对象。
  - `cabinet`：位置/状态/ref 角色/坐标系角色说明。
  - `cabinetMulti`：选区构成 `bd` + 多选操作提示。
  - `point`：坐标 xyz / 来源 / σ / 误差 `Stat`。
  - `run`：概要 + 质量指标 `Stat` 组。
- **Overlay**：Calibrate 无浮层抽屉（设计稿 calibrate 不含 drawer/scrim），`calibratePage` 不提供 `Overlay`。

## 5. 数据模型（mock；形状贴近未来 DTO，降低第二期返工）

从设计 `data.jsx` 的 `CAL_*` 段移植，定义 TS 类型于 `state/data.ts`：

- `CAL_SCREENS: {id,name,cols,rows,panels}[]`
- `CAL_STEPS: {id,n,label,cn,group:'mesh'|'lens',status:'done'|'active'|'ready'|'idle'}[]`
- `STEP_DETAIL: Record<stepId,string>`
- `SURVEY_REPORT: {measured,fabricated,outlier,missing,warnings:{lv,msg}[]}`
- `CAL_POINTS: {id,name,role?,xyz:[number,number,number],measured:boolean,err,sigma}[]`
- `MESH_METRICS: {cols,rows,vertices,est_rms,mid_max,mid_mean,est_p95}`
- `CAL_RUNS: {id,created,screen,method,rms:number|null,vertices:number|null,target,obj:boolean,metrics?:{mid_max,mid_mean,est_rms,est_p95}}[]`
- `LENS_STAGES: {id,n,label,cn,status}[]`
- 常量：`ROLE`（origin/x_axis/xy_plane）、`CAB_STATE`、`SEVCAL`。

## 6. 实现内部顺序（建议，writing-plans 细化）

1. 脚手架：`state/store.tsx` + `state/data.ts` + 注册（registry/data.ts/App.tsx）+ 空四区组件 → 页面能切到「校正」且不报错、不再是骨架。
2. `ui/{Badge,InlineAlert,Stat}` 三原子（含必要 CSS 补丁）。
3. `Ctx` + `Left`(StepItem) + `CalTop` + `Inspector` 空态。
4. 简单视图：`MethodView`/`SurveyView`/`RunsTable`/`LensView` + Inspector 的 point/run 态。
5. `CabinetEditor`（含 Inspector cabinet/cabinetMulti 联动）。
6. `MeshPreview3D` + `PreviewView`。

## 7. 验证标准（成功 criteria）

- `pnpm exec tsc --noEmit` 通过；`pnpm exec vite build` 通过。
- `pnpm tauri dev`：切到「校正」tab，页面完整渲染（非骨架）。
- 工作流 6 步可切换，各视图正确渲染。
- `CabinetEditor`：框选 / ⌘-Alt 多选 / mask·refs·baseline 三模式 / undo-redo / wheel 缩放 / 右键平移 / 键盘 M·R·B·1·2·3·Esc·⌘Z 全部工作。
- `MeshPreview3D`：左键旋转 / 右键平移 / wheel 缩放。
- Inspector 随选择在 4 态间正确切换。
- 重建 / 导出 / 指导卡 / OBJ 下载 / 运行求解按钮均推日志到 NDJSON 控制台。
- 暗 / 亮主题均正常。
- Cache / 其它页 / 外壳 chrome 无回归（surgical）。

## 8. 风险与注意

- **全局事件监听**：`CabinetEditor`/`MeshPreview3D` 在 `window` 上挂 `mousemove/mouseup/keydown/wheel`，effect 必须 cleanup，避免与 Shell 既有监听冲突或泄漏。
- **StrictMode 双调用**：`main.tsx` 启用 `React.StrictMode`，effect 会双跑——`seedCells`、事件注册、ResizeObserver 需幂等。
- **右键平移 vs 禁用右键菜单**：Shell 已全局 `preventDefault` contextmenu；编辑器内右键平移依赖此，确认不冲突。
- **createElement → TSX**：设计稿是 `React.createElement`，移植为 TSX/JSX 时补全 `key`、类型标注；React 18 UMD → 本仓 React 19 + TS，hooks 语义一致。
- **日志跨域**：`useCalibrate` 组件引用 `useCache().pushLog`；mock-first 可接受，记为已知技术债。

## 9. 第二期预告（out of scope，另立 spec）

新建 `features/calibrate/api`（仿 `cache/api`）封装并替换 mock：
- `CAL_RUNS` / `MESH_METRICS` → `mesh_projects` / `mesh_reconstruct`(`reconstruct_surface`)
- `SURVEY_REPORT` / `CAL_POINTS` → `import_total_station_csv` / `mesh_measurements`
- 导出 → `mesh_export`
- 届时核实各命令入参/返回 DTO（task #2）并对齐 mock 形状。
