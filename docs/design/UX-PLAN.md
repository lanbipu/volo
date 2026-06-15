# Volo — UX 方案 (v0.1)

> 一款面向虚拟制作（Virtual Production / LED 虚拟拍摄）的跨平台桌面 App。
> 形态：底部页面 tab + 随页切换的上下文工具条 + 左子栏 / 右 Inspector；用 **React Spectrum 2** 组件、暗 / 亮双主题。
> 一个统一的 Stage/Show 项目从左到右流经各现场流程阶段。
> 目标平台：Windows + macOS（Tauri）。
>
> 状态：方向已锁定，待细化。优先落地 **Cache（UECM）** 与 **Calibrate（网格段，LMT）** 两页。
>
> ⚠️ **方向变更（2026-06-14）**：从"复刻 DaVinci Resolve"改为 **React Spectrum 2 + React 栈**。本文以下凡提"DR 风格 / 暗色克制留白 / Vue / OKLCH token / Claude Design 流程 / Manrope"均**作废**，以 `BRAND-BRIEF.md`（S2 版）为准。**IA（tab / 外壳四区 / Stage 模型 / 迁移映射）仍有效。**

---

## 0. 一句话定位

**"一个 Stage 从左流到右"的现场全流程控制台**：把现场虚拟拍摄全流程（预演 → 建 LED 模型 → 几何校准 → 色彩校准 → 缓存/集群 → 现场拍摄）收进一个 App，一个统一的 Stage 项目贯穿各阶段。外壳 = 底部 tab + 上下文工具条 + 左子栏 + 右 Inspector，用 React Spectrum 2 组件实现，视觉 / 密度交给 S2。

---

## 1. 锁定的产品决策（来自前期 discovery）

1. **全新统一 Tauri 壳**，把各工具功能迁移/重写成 App 内页面，共用一套设计系统与统一后端。前端用 **React + Tauri 2 + `@react-spectrum/s2`**；两个主应用（UECM / LMT）现是 Vue 3，**前端需重写成 React**（Rust 后端 / Tauri commands / Python sidecar 不动）。
2. **底部页面 tab + 随页切换的上下文工具条** 作为外壳骨架；视觉 / 密度 / 留白 / 圆角全交给 React Spectrum 2，不自定义。
3. **底部 tab = 现场工作流阶段**，线性排列。
4. **统一 Stage/Show 项目贯穿所有页面**（像 DR 的 project 流经所有页面）。
5. **Tab 结构 = 功能即 tab**：`Pre-viz · Calibrate · Color · Cache · Live · Tools`（6 个；原 Mesh + Geometry 合并为 **Calibrate** = 网格重建 + 镜头校正）。
6. **Stage 绑定一切**，含本次拍摄用到的渲染节点与 DDC/PSO 配置（见 §4 对"基础设施 vs per-show"张力的处理）。
7. **落地流程**：启动先进 Stage 管理器（最近项目卡片 + 新建）→ 选定后进入底部 tab 工作区；chrome 顶部常驻 Stage 切换器。

---

## 2. 信息架构（IA）

### 2.1 顶层结构

```
启动
  └─ Stage Manager（选/建 Stage）
       └─ Workspace（底部 tab 工作区，顶部常驻 Stage 切换器）
            ├─ Pre-viz
            ├─ Calibrate   （网格重建 → 镜头校正）
            ├─ Color
            ├─ Cache
            ├─ Live
            └─ Tools
```

### 2.2 底部页面 tab（按现场流程线性排）

| Tab | 阶段 | 来源 | 内核功能 | 现场时机 |
|---|---|---|---|---|
| **Pre-viz** | 预演/规划 | 新建 | 关卡布局、镜头/机位预演、LED 墙摆位设定 | 拍前（棚外） |
| **Calibrate** | LED 网格重建 + 镜头校正 | `led-mesh-toolkit` + `vpcal` | 网格：定义屏→测量→重建→3D 预览→导出；镜头：Validate→Detect→Solve→Report（变换矩阵 / RMS / 重投影误差） | 搭棚后 |
| **Color** | 色彩校准 | 自研（参考 `OpenVPCal`） | ICVFX 色彩校准：图案 → 拍摄 → 分析 → 矩阵/LUT/OCIO | 几何之后 |
| **Cache** | 缓存/集群 | `ue-cache-manager` | 渲染节点纳管、DDC、PSO、健康/一致性 | 拍前 + 全程并行 |
| **Live** | 现场 | 新建 + monitor | 实时监控（设备/性能/追踪）+ 控制面板（OSC / TCP-IP 远程命令） | 拍摄中 |
| **Tools** | 工具箱 | `tracksim` + 网格生成器 | 追踪信号模拟（FreeD/OpenTrackIO）+ LED 测试图生成 | 全程辅助 |

> **排序说明**：整体按"拍前 → 搭建 → 校准 → 拍摄"的现场时间线。唯一不完全落在严格线性上的是 **Cache**——渲染集群准备其实是贯穿全程、可与其他阶段并行的基础设施工作。把它放在 Color 与 Live 之间，是因为它是"开拍前最后一道交付前的就绪检查"，承上（校准产物要在节点上跑顺）启下（进入 Live 拍摄）。
>
> **数量说明**：上表 **6 个**功能页（原 7 个，Mesh + Geometry 已合并为 Calibrate）。Stage Manager 不在底部 tab 内，作为工作区之外的一层（见 §4）。

---

## 3. 应用外壳（React Spectrum 2）

### 3.1 区域划分

```
┌──────────────────────────────────────────────────────────────────┐
│ ▤ Volo   文件 编辑 …(菜单栏)        [● Stage: Volume_A ▾]  ◐ 主题 ⚙ │  ← 标题栏 + 菜单栏 + Stage 切换器 + 全局动作
├──────────────────────────────────────────────────────────────────┤
│ [上下文工具条：随当前页变化]  例: Calibrate → 屏选择器 · 重建 · 导出   │  ← DR 招牌：per-page 顶部工具条
├──────────┬───────────────────────────────────────────┬───────────┤
│ 左子栏    │                                           │  右 检查器 │
│ (页内分段) │            主画布 / 主工作区                │ (选中详情) │
│ Cluster   │                                           │           │
│ DDC       │                                           │           │
│ PSO …     │                                           │           │
├──────────┴───────────────────────────────────────────┴───────────┤
│ 日志/活动面板（可收起）                                              │  ← 沿用两个 app 已有的 LogPanel
├──────────────────────────────────────────────────────────────────┤
│        Pre-viz   Calibrate   Color   Cache   Live   Tools       │  ← 底部 tab（6 个，水平居中）
└──────────────────────────────────────────────────────────────────┘
```

### 3.2 面板系统（四区，按页启用）

- **顶部上下文工具条**：每页一套，切 tab 时整条替换。承载该页最高频的 1-3 个主操作 + 当前对象选择器（屏/机器/墙）。这是 DR 风格的核心识别点。
- **左子栏（page sub-rail）**：当一页有多个子区时出现（Cache 的 Cluster/DDC/PSO/一致性/健康；Mesh 的 Design/Method/Survey/Preview/Runs）。沿用两个现有 app 已经在用的左栏分组习惯，迁移成本低。
- **主画布**：该页主体。表格 / 卡片网格 / 2D 编辑器（Konva）/ 3D 预览（Three.js）/ 色彩示波器，按页而定。
- **右检查器（Inspector）**：选中对象的详情与可编辑属性（选中的机器、cabinet、point、reconstruction run、色块）。借鉴 DR 的"检查器"，**替代 UECM 现有那套 SVG 箭头浮层详情**（巧妙但偏重，统一成右栏更一致）。
- **底部日志/活动面板**：可收起，承载长任务进度、命令输出、破坏性操作的 backup 路径。沿用现有 LogPanel。

---

## 4. Stage/Show 数据模型与生命周期

### 4.1 Stage 绑定什么

按锁定决策，一个 **Stage/Show** 绑定本次拍摄的一切：

- LED 墙/屏定义、Mesh 重建结果
- 几何校准（镜头 + 空间）结果
- 色彩校准结果（矩阵 / LUT / OCIO）
- Pre-viz 设定
- **本次拍摄用到的渲染节点 + 其 DDC/PSO 配置快照**

### 4.2 处理"基础设施 vs per-show"的张力

机器集群是跨 show 持久存在的基础设施，若每个 Stage 都从零录入机器/凭据会重复劳动。处理方式：

- 维护一个**全局 Machine Library（机器/凭据登记处）**作为可复用"源"：机器、凭据一处录入，所有 Stage 共享。
- 每个 Stage **引用/快照**机器库里的节点子集（"本次用这 8 台"），并在 Stage 内记录这批节点本次用的 DDC/PSO 配置。
- 净效果：Stage 仍"绑定"了本次的机器与配置（满足决策 6），但不强迫重复录入基础设施；换 show 复用机器时只是重新勾选。

> 这是对决策 6 与"别重复录入基础设施"的调和。Cache 页在当前 Stage 上下文里工作，但其底层机器来自全局库。

### 4.3 Stage Manager（落地页）

- 最近 Stage 卡片（缩略图 + Volume 名 + 拍摄日期 + 各阶段完成度徽标）+ "新建 Stage"。
- 新建向导：命名、绑定 LED Volume、从机器库选节点（可选，可后补）。
- 进入后，chrome 顶部常驻 Stage 切换器，上下文流向所有页面。

---

## 5. 两个优先页面的详细 UX

### 5.1 Cache（迁移自 UECM）

**目标**：在当前 Stage 上下文里，看清这批渲染节点的一致性、消除冷启动编译与运行卡顿、破坏性操作有摩擦感。

**布局**：
- **上下文工具条**：当前 Stage 的集群摘要（在线 N/总 N + 健康分）· 扫描/纳管 · 一键部署。
- **左子栏分段**：`Cluster（总览）` / `DDC` / `PSO` / `一致性(INI)` / `健康`。
- **主画布**：
  - *Cluster*：机器卡片网格（healthy/warning/critical 状态点）。
  - *DDC / PSO*：左为任务卡片列表（生成/采集进度），右（或检查器）为分发进度表。
  - *一致性*：左 finding 分层树，右详情 + 应用。
  - *健康*：集群评分 KPI + GPU 一致性矩阵 + 分层 probe 表。
- **右检查器**：选中机器 → 身份/UE 安装/GPU/凭据/ENV/INI 操作（替代原 SVG 箭头浮层）。
- **保留的关键模式**：
  - 状态色三通道（色 + 图标 + 文字），沿用 UECM 既有语义。
  - **破坏性操作自带摩擦**：改注册表/凭据/INI 前，先在屏上看到 diff、影响机器列表、backup 路径，再确认。
  - 任务进度走底部日志/活动面板。

**迁移映射**：UECM 的 Machines/Deploy/Diagnostics + 详情 6 tab（overview/projects/ddc/pso/ini/health）→ 折叠进本页左子栏分段 + 右检查器。原跨页左 Sidebar（Machines/Deploy/Diagnostics）由底部 tab 与本页左子栏共同取代。

### 5.2 Calibrate · 网格重建段（迁移自 LMT）

**目标**：现场工程师在差光照、站立、赶时间下，把 LED 屏的真实 3D 几何测出来、重建出来、看明白误差、导出给下游。

**布局**：
- **上下文工具条**：屏选择器（一个 Stage 可含多屏）· 重建 · 导出（disguise / Unreal / neutral）。
- **左子栏分段（即工作流步骤）**：`Design` → `Method` → `Survey/Import` → `Preview` → `Runs`。
  - *Design*：Konva 2D cabinet 网格编辑（mask/refs/baseline，快捷键 M/R/B）。
  - *Method*：M1 全站仪(Trimble SX) / M2 视觉(ChArUco+BA) 卡片选择。
  - *Survey/Import*：M1 走 CSV 导入 + 导入报告；M2 走 ChArUco/photoplan。
  - *Preview*：Three.js 3D 网格，OrbitControls，顶点数显示。
  - *Runs*：重建历史表，RMS 状态徽标（<3mm 健康 / <8mm 警告 / ≥8mm 严重 / null = n/a）。
- **右检查器**：选中 cabinet/point/run 的属性与误差度量。
- **保留的关键模式**：
  - **诚实对待不确定性**：未知用斜纹图案表示，不用"自信的默认值"掩盖（LMT 的设计哲学，做成视觉）。
  - 误差用真实单位呈现，measured vs guessed 清晰区分。
  - 可打印测量指导卡（instruction card）生成/导出 PDF。

**迁移映射**：LMT 的 Home（项目列表）上移到 Stage Manager；per-project 的 DESIGN/SURVEY/OUTPUT 左栏分组 → 本页左子栏。3D（Three.js）与 2D（Konva）方案直接复用。

---

## 6. 预留页面（reserved layouts）

以下页面先占好壳位与导航槽，结构意图如下，详细 UI 后续逐个完善（不在此过度设计）：

- **Calibrate 的 Lens 段（vpcal，无 GUI / 纯 CLI）**：已并入 Calibrate 页（原独立 Geometry tab 取消），承网格重建之后。vpcal 四阶段管线（Validate → Detect → Solve → Report）做成 stepper + 报告查看器（变换矩阵 7 自由度、RMS/inlier/outlier、重投影误差）；本段先占位，需为 CLI 包一层 GUI。
- **Color（自研，参考 OpenVPCal）**：参考 OpenVPCal 的 `Project → Wall → Plate → Analyse → Export` 流程；诊断面板（Max Distance / EOTF / White Point / CIE gamut）；矩阵/LUT/OCIO 导出。**注意**：OpenVPCal（Netflix，PySide6/Qt）是**参考工程，不移植代码、不进 monorepo**；Color 功能后续自研，本段先占位。
- **Live（新建 + monitor）**：上半实时监控仪表板（设备在线/性能/追踪信号健康，一眼看到不对的地方）；下半控制面板——常用命令网格，通过 OSC / TCP-IP 远程触发。
- **Tools（tracksim + 网格生成器）**：左右两工具。追踪模拟器：信号源（手柄/FBX/轨迹/脚本）· 协议（FreeD / OpenTrackIO）· 传输（UDP/串口、目标地址端口）· 速率。网格生成器：测试图参数 + 导出，供现场核对 LED Wall 显示。
- **Pre-viz（未开发）**：预留规划/布局画布槽位（关卡布局、机位、LED 墙摆位预演）。

---

## 7. 跨页通用模式

- **状态即信息**：healthy/warning/critical/offline/unknown，永远色 + 图标 + 文字三通道（两个 app 既有规则，色盲友好，差光照可读）。
- **破坏性操作有摩擦**：先看影响范围与 backup，再确认（UECM 原则）。
- **诚实对待不确定性**：空/部分/低置信状态是一等公民，视觉上独立（LMT 原则）。
- **日志/活动面板**：长任务、命令输出、backup 路径的统一出口。
- **向导 vs 内联确认**：优先内联确认/抽屉/原地编辑，modal 不作首选。
- **暗 / 亮双主题**：现场偏暗 → 默认可暗色；用 React Spectrum 2 的 `colorScheme` 切换，不自建 token。
- **CJK 排版**：sans-serif 优先；mono 只用于标识符/路径/IP/命令；不加负 letter-spacing；中文行高放宽一档。
- **密度**："DR 骨架 + 干净内部"——内容区保持宽松留白，密度只给真正需要专业作业的地方（机器表、3D 视口、色彩示波器）。

---

## 8. 默认决定（你可推翻）

这些是为推进而做的合理默认，等你确认或修正：

1. **右检查器（Inspector）默认启用**，取代 UECM 现有 SVG 箭头浮层详情，让选中详情在所有页一致。
2. **每页保留左子栏**承载页内分段（与现有两个 app 的左栏习惯一致）。
3. **暗 / 亮双主题**：现场偏暗、室内复盘用浅色；React Spectrum 2 原生支持双主题切换。
4. **沿用底部可收起 LogPanel**，不另起一套。
5. **全局 Machine Library 作为可复用源**，Stage 引用/快照节点子集（§4.2）。
6. **Stage Manager 独立于底部 tab**（工作区之外的一层），不占 tab 槽。

---

## 9. 视觉系统 & 实现路线（React Spectrum 2 + Claude Code）

### 9.1 设计系统

**不自建。直接用 Adobe React Spectrum 2（S2）。** 配色 / 间距 / 圆角 / 字号 / 控件 / 密度全部继承 S2，不写自定义 token。暗 / 亮双主题用 Spectrum `colorScheme`。状态三通道（色 + 图标 + 文字）用 S2 的 StatusLight / 语义色。中文 fallback 思源黑体。详见 `BRAND-BRIEF.md`。

### 9.2 实现流程

不再用 Claude Design 生成视觉。直接 **Claude Code + S2 组件** 写代码：

1. **脚手架**：`create-tauri-app` 选 React 模板，装 `@react-spectrum/s2`。
2. **接 S2 MCP server**（`react-spectrum/packages/dev/mcp/s2`）给 Claude Code，写代码时直接查组件用法。
3. **逐页实现**，先做实 **Cache + Calibrate**，照 `WIREFRAMES.md` 的功能 / 字段规格用 S2 组件搭；其余 4 页先占位。
4. **后端复用**：UECM / LMT 的 Rust commands、Python sidecar 保留；只重写前端 Vue → React。

---

## 10. 下一步候选

按需挑：

1. **盘 UECM / LMT 的 Vue 前端代码量**，出 React 重写工作量评估。
2. **`create-tauri-app` (React) + `@react-spectrum/s2` 起骨架**，接 S2 MCP。
3. **Cache / Calibrate 两页**照 `WIREFRAMES.md` 用 S2 组件实现。
4. **Stage 数据模型** schema（Stage 绑定的实体、与全局 Machine Library 的引用关系）。

---

> Knowledge Sources: 无（设计系统改用 React Spectrum 2，在 Claude Design 里基于它做设计）。
> External Inputs: 对 `ue-cache-manager`、`led-mesh-toolkit`、`calibration/vpcal`、`calibration/tracksim`、`color/OpenVPCal`（仅参考，不移植）源码与产品文档的探索；Adobe React Spectrum 2（`@react-spectrum/s2`）作为设计系统。
