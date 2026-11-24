# 前端代码结构（LAN-20 · P2-1）

> 状态：**已确认**（2026-11-24）。新 UI（LAN-11）按此结构落地。进度：P0 止血、P1 骨架已完成；P2 起见 §8。
> 已拍板的选型：Zustand（前端状态）· TanStack Query（后端数据）· token + `ry-` 组件 + CSS Modules（样式）· 新壳并行、逐页替换（过渡）。
> Design system 基准：Claude artifact「Linear」https://claude.ai/artifact/E8kZ3vwPMmDc9EjiSa3Kuh （内部名 **Runyard**：`tokens.json` + `ry-` 前缀组件 + `data-theme` / `data-ry-density`）。

## 0. 「1:1」的新定义

「1:1」= **渲染结果与 Claude Design 设计稿一致**（布局、间距、字阶、颜色、状态），**不是**照搬原型源码。
原型 JSX 是参考实现：拆成 `ui/` 组件 + 页面组件 + 本页样式后移植；验收看截图对比，不看代码形状。

## 1. 现状（为什么要重整）

| 指标 | 数值 |
|---|---|
| `src/volo` TS/TSX 文件 | 67，其中 40 个 `@ts-nocheck`（全部页面 + 外壳 + data/tweaks/ds） |
| 无 `@ts-nocheck` 的 | `api/` 全部、`keyer/`、`lib/`、`stage/model.ts`、`patternPlayer` / `devCapture` / `gridScene` |
| `window.*` 注册表 | ~30 个（`VOLO_PAGES`、`VOLO_CAL2`、`VOLO_GRID`、`VOLO_CAL_AR`、`camStore`、`deployStore` …），多个文件 `Object.assign` 往同一个全局对象上叠 |
| 页面装配 | 每页注册 `{ctx,left,center,inspector}` 四个 render 函数到 `window.VOLO_PAGES`；外壳 `App` 用 60+ 个 `useState` 拼成大对象 `s` 传给所有页面 |
| 模块级 store | `projStore` / `camStore` / `deployStore` / `arStore` / `lensStore` / `keyerStore`，手写 get/patch/subscribe，挂在闭包或 `window` 上 |
| 后端数据 | 页面直接调 `api/*`，`useState` + 手动轮询，loading/error 各写各的；Tauri `listen` 散在 shell 和多个页面 |
| CSS | 37 份，`!important` 623 个；`index.tsx` 按固定顺序 import 9 层皮肤（「换序即失效」） |
| 组件库 | `vendor/ds_bundle.js`（原型自带 Spectrum2 bundle，挂 `window.Spectrum2DesignSystem_b6d1b3`）；`@react-spectrum/s2` + `unplugin-parcel-macros` 已无代码使用 |
| 测试 | 前端 0 |

## 2. 目标目录

```
src/
  main.tsx                 入口：按 hash 分次级窗口；按开关选新壳 / 旧壳
  app/                     新外壳（无业务）
    AppShell.tsx           标题栏 + 页签 + 工作区框架 + 控制台抽屉
    pages.ts               页面注册表（静态、有类型，React.lazy）
    providers.tsx          QueryClientProvider、主题 / 密度
    console/               日志流、任务、Toast
  ui/                      新 design system 的 React 实现（无业务、无 invoke）
    tokens.json            DS artifact `project/tokens.json` 的拷贝（唯一取值来源）
    tokens.css             由 tokens.json 生成（`scripts/gen-tokens.mjs`），不手改
    base.css               reset + 字体 + 全局排版
    icons/                 图标组件
    components/            Button.tsx + Button.css（ry-button）…… 与 DS 组件一一对应
    layout/                Workspace（left / center / inspector 槽位）、Panel、Split …
  features/                按业务域，每个域自包含
    cache/
      machines/  zen/  ddc/  pso/  projects/
        model/             store.ts（Zustand）· queries.ts（TanStack Query）· 纯逻辑 + 类型
        ui/                页面 / 面板组件 + *.module.css
        index.ts           对外只导出页面入口和必要的 hooks
    calibrate/
      project/             （原 projStore / openProjectPath / rebuildMesh / runs）
      camera/              （原 camStore）
      deploy/              （原 deployStore + calDeploy）
      grid/  lens/  capture/  qsp/  ar/  ndisplay/
    tools/keyer/           （原 toolsKeyer + keyer/ 引擎）
    tools/                 工具页（组合 cache + keyer）
    previz/  color/  live/ （占位页）
  windows/                 次级窗口：pattern-player、dev/capture
  lib/                     无 React 的通用工具（framingMatch、logDetail、事件桥 …）
  volo/                    旧代码（冻结，逐页删除；api/ 在迁完前原地保留）
```

`src/volo/api/` 原地保留，新代码通过路径别名 `@/api` 引用；旧壳删完后整体移到 `src/api/`，只改别名，不改调用方。

## 3. 分层与依赖方向

```
app  ──►  features/*/ui  ──►  features/*/model  ──►  api  ──►  @tauri-apps/api
  │            │                    │
  └──────►    ui    ◄───────────────┘ (model 不依赖 ui)
                lib  ◄── 任何层都可用
```

硬性规则（lint 强制，见 §8 P0）：

1. **`invoke` / `listen` 只出现在 `api/`**（及 `lib/` 里的事件桥）。页面和 store 只调 `api/` 的有类型函数。
2. **`ui/` 不 import `features/`、`api/`**；只收 props。
3. **feature 之间只走对方的 `index.ts`**，不深层 import 对方内部文件；跨域共享的类型 / 逻辑上提到 `lib/` 或 `api/types`。
4. **不写 `window.*` 全局**，不写 `@ts-nocheck` / `@ts-ignore`（确有必要用 `@ts-expect-error` + 原因）。
5. **不靠 import 顺序生效**：任何模块单独 import 都能工作。

## 4. 状态

三类状态，各有归属，不混放：

| 类别 | 例子 | 放哪 |
|---|---|---|
| 后端数据（来自 Rust、可重新拉取） | 机器列表、共享、PSO 状态 / 历史、健康检查、runs、报告 | **TanStack Query**：`features/*/model/queries.ts` 里 `useXxxQuery` / `useXxxMutation`，query key 按域命名（`['cache','machines']`） |
| 前端会话状态（跨组件共享、不可从后端重拉） | 当前项目路径 + 编辑中的 config、相机选择与位姿草稿、部署通道状态、采集会话 | **Zustand**：每个域一个 store（`useProjectStore`、`useCameraStore`、`useDeployStore` …） |
| 界面偏好（需跨重启保留） | 当前页、左右栏宽、折叠、控制台高度、各域选中项 | Zustand + `persist` 中间件，**按域拆 key**（替代现在的单个 `volo2` 大对象） |
| 纯局部 | 弹层开关、输入框草稿 | 组件 `useState` |

补充规则：

- **Tauri 事件 → Query**：进度 / 状态推送统一经 `lib/events.ts` 订阅，收到后 `queryClient.setQueryData` 或 `invalidateQueries`；页面不直接 `listen`。
- **高频流**（结构光相位、采集预览帧、三维视口姿态）不进 Query 也不进 React state，走 store 的非响应式字段或 ref + `requestAnimationFrame`，避免整树重渲染。
- **不再有大对象 `s`**：页面自己订阅需要的 store / query；外壳只管外壳自己的状态。

## 5. 页面与外壳

- `app/pages.ts` 是唯一的页面表：`{ id, label, icon, component: lazy(() => import('@/features/cache')) }`，有类型，静态可查。
- 页面是一个普通组件，自己用 `ui/layout/Workspace` 摆 `left / center / inspector`；不再把四个 render 函数交给外壳拼。
- 页面内部子导航（Cache 的机器 / Zen / DDC / PSO，Calibrate 的各 section）由页面自己的 store 管，偏好持久化走 §4。
- 次级窗口（`#/pattern-player`、`#/dev/capture`）放 `windows/`，不引入外壳。

## 6. 样式

三层，只有这三层：

1. **`ui/tokens.css`** —— 颜色 / 间距 / 圆角 / 阴影 / 密度 / 布局 / 图标 token，`data-theme="dark|light"` 切主题、`data-ry-density="compact|comfortable"` 切密度、`data-ry-font` / `data-ry-mono` 切字体。由 `ui/tokens.json` 经 `node scripts/gen-tokens.mjs` 生成，**不手改**；DS 更新时先替换 tokens.json 再生成。
2. **`ui/components/*.css`** —— 组件样式，全局 `ry-` 前缀类名，沿用 DS `components/bundle.css` 的类名，与 DS 组件一一对应（方便和后续 handoff 逐行对照），只引用 token。
3. **页面样式 `*.module.css`** —— 只放该页独有的布局，CSS Modules 天然作用域隔离。

规则（stylelint 强制）：

- 禁止 `!important`（唯一例外：`base.css` 里的 reduced-motion 之类无障碍覆盖）。
- 颜色 / 间距 / 字号只能用 `var(--token)`，不写字面值（`0`、`1px` 描边、`100%` 之类除外）。
- 页面 CSS 不得写 `ry-` 类、不得写元素选择器作用于全局。
- 不新增全局 CSS 文件；**新 handoff 不再叠皮肤层**——设计变了就改 token 或组件本身。
- WKWebView 兼容：禁止选中用 `-webkit-user-select`；拖拽区用 `data-tauri-drag-region`（见根 CLAUDE.md）。

## 7. Claude Design handoff 的移植流程

1. 在 Claude Design 里定稿（DS 组件先行，页面后行）。
2. DS 组件变更 → 更新 `ui/components`（+ 重新生成 tokens）。
3. 页面 handoff → 拆成：用到哪些 `ui/` 组件、本页独有的布局（module.css）、需要哪些 store / query。原型里的 mock 数据换成 query。
4. 验收：原生 App 截图 vs 设计稿截图，暗 / 亮两套主题都对一遍。

## 8. 迁移路径

| 阶段 | 内容 | 动不动 UI |
|---|---|---|
| **P0 止血** ✅ | ESLint（`@typescript-eslint/ban-ts-comment`、`no-restricted-syntax` 禁 `window.VOLO_*` 赋值、`no-restricted-imports` 落实 §3）+ stylelint（`declaration-no-important`、token 规则），**只对新目录生效**；旧 `src/volo` 加入忽略但禁止新增文件。根 CLAUDE.md 补约定。 | 否 |
| **P1 骨架** ✅ | 建 `app/ ui/ features/ windows/ lib/`；加 `zustand`、`@tanstack/react-query`；删 `@react-spectrum/s2`、`unplugin-parcel-macros` 及 vite 里相关配置；`@/` 路径别名；`main.tsx` 开关（默认旧壳，`localStorage['volo-shell']='next'` 或 dev 菜单切新壳），旧壳及其 CSS 改为动态 import，只在旧壳时加载；加 Vitest。 | 否（新壳先是空框架） |
| **P2 抽 model** | 把旧页面里的业务逻辑抽到 `features/*/model`（有类型 + 单测），旧页面改为 import 新 model，渲染不变。顺序：calibrate `project` / `camera` / `deploy`（被引用最多）→ cache 数据加载改 query → keyer store。 | 否（只换数据来源，旧页面渲染结果不变） |
| **P3 逐页重写**（= LAN-11） | DS 定稿 → `ui/` 组件；每页 handoff 落到新壳；新页验收后从旧壳删掉对应页面和它的 CSS。 | 是，全部经 Claude Design |
| **P4 收尾** | 新壳设为默认 → 删 `src/volo`（`api/` 移到 `src/api`）、`ds_bundle.js`、`tweaks`、旧 CSS；关闭开关。 | — |

## 9. 旧 → 新对照

| 旧 | 新 |
|---|---|
| `shell.tsx` | `app/AppShell` + `app/console/`；60+ `useState` 按 §4 拆到各域 |
| `index.tsx`（import 顺序契约） | 删除，`app/pages.ts` 取代 |
| `ds.ts` + `vendor/ds_bundle.js` | 删除，`ui/components` 取代 |
| `data.tsx` | 图标 → `ui/icons`；mock 数据删除 |
| `tweaks.tsx` | 删除（原型编辑器遗留） |
| `api/*` | 保留，P4 移到 `src/api` |
| `api/uiConfig.ts`（`NODE_STATUS`/`CHANNEL`/…） | 对应 feature 的 `model/` |
| `pages/cache*.tsx`、`api/cacheData.ts` | `features/cache/{machines,zen,ddc,pso,projects}` |
| `pages/calibrate.tsx`（projStore、CalController、openProjectPath …） | `features/calibrate/project` |
| `pages/calFlowData.tsx`（camStore、deployStore） | `features/calibrate/{camera,deploy}` |
| `pages/grid*.tsx` | `features/calibrate/grid`（`gridScene` 三维视口 → `grid/ui/scene`） |
| `pages/calLens*`、`calCalibFlow`、`calCapture*`、`calVideoSource`、`calTrackingSource`、`gridCaptureWindow` | `features/calibrate/{lens,capture}` |
| `pages/calQsp.tsx` | `features/calibrate/qsp` |
| `pages/calAr*.tsx` | `features/calibrate/ar` |
| `pages/calDeploy.tsx`、`gridNdisplay.tsx` | `features/calibrate/{deploy,ndisplay}` |
| `pages/calAutogen.tsx` | `features/calibrate/grid`（待确认归属） |
| `pages/toolsKeyer.tsx` + `keyer/` | `features/tools/keyer`（引擎原样搬，已是干净 TS） |
| `pages/skeletons.tsx` | `features/{previz,color,live}` 占位 |
| `pages/patternPlayer.tsx`、`devCapture.tsx` | `windows/` |
| `stage/model.ts` | `features/calibrate/project/model`（Stage schema） |
| `lib/framingMatch.ts`、`logDetail.ts` | `lib/` |

## 10. 待定

- `calAutogen` 的归属（网格自动生成 vs 独立工具）。
- 新壳的开关形式（localStorage / dev 菜单 / 构建变量）。

## 11. P0 / P1 落地清单（2026-11-24）

| 项 | 位置 |
|---|---|
| ESLint（`ban-ts-comment`、禁 `window` / `globalThis` 赋值与 `Object.assign(window.*)`、`invoke` / `listen` 限定在 `api/` 与 `lib/events.ts`、禁依赖旧壳、跨 feature 只走 index、`ui/` 不依赖 api / features / app、禁 `any`） | `eslint.config.js` |
| stylelint（禁 `!important`、hex / 命名色 / 颜色函数；页面样式禁覆盖 `ry-` 类、禁类型选择器） | `.stylelintrc.json` |
| 结构守卫（旧壳只改不增、旧壳外禁 `@ts-nocheck`、页面样式必须 `*.module.css`、全局 CSS 只在 `ui/`） | `scripts/check-frontend-structure.mjs` + `scripts/frontend/legacy-volo-files.txt` |
| token 生成（与 DS `06-css-variables.md` 逐字节一致，vitest 校验；`--check` 进 lint） | `scripts/gen-tokens.mjs` → `src/ui/tokens.css` |
| 新壳骨架：页面表（lazy）、外壳 store（Zustand + persist，key `volo:shell`）、QueryClient、Tauri 事件桥 | `src/app/`、`src/lib/` |
| 新 / 旧壳开关；旧壳 CSS 只随旧壳 chunk 加载（实测新壳 3 张样式表，旧壳 39 张） | `src/main.tsx` |
| 依赖：+`zustand` +`@tanstack/react-query` +`vitest` +ESLint / stylelint；−`@react-spectrum/s2` −`unplugin-parcel-macros` | `package.json` |
| 命令：`pnpm lint` / `pnpm test` / `pnpm tokens` | `package.json` scripts |

未做（按阶段推进）：`windows/` 次级窗口搬迁、各 feature `model/` 抽取（P2）、`ui/components` 与字体本地打包（P3，Runyard `bundle.css` 目前走 Google Fonts，需改为随 App 打包 Inter / IBM Plex Mono / HarmonyOS Sans SC）。
