# Volo — Wireframes (Step 2)：Cache + Calibrate

> 用途：**喂给 Claude Design 逐页设计 UI 的功能蓝本**——每页有哪些区、每区放什么字段 / 按钮 / 选项、保留哪些交互。视觉 / 主题由 Claude Design 的 React Spectrum design system 决定，本文件只管功能与结构。
> ⚠️ **这是临时功能稿，会在 Claude Design 设计过程中大量调整**；最终以迭代后的设计稿为准。
> ⚠️ tab 已从 7 合并为 **6**：原 Mesh + Geometry(镜头校正) 合并为 **Calibrate**(先网格重建、再镜头校正，见 §2)。
> 字段/阈值/组件名均来自对 `ue-cache-manager` / `led-mesh-toolkit` 源码的实测(见末尾映射表)。

**图例**（每个组件标来源，便于实现时区分"有参照"vs"要新设计"）：
- ◆ **迁移现状**：旧 app 已有，直接搬结构。
- ✚ **新增**：旧 app 没有，Volo 新设计。
- ⤴ **补强**：旧 app 有雏形但不完整，Volo 做完整。

---

## 0. 通用壳（两页共用，回顾）

```
┌────────────────────────────────────────────────────────────────────┐
│ 标题栏 + 菜单栏           [● Stage: Volume_A ▾]        ◐ 主题  ⚙     │
├────────────────────────────────────────────────────────────────────┤
│ ① 上下文工具条（随页变；该页 1–3 主操作 + 对象选择器）              │
├──────────┬─────────────────────────────────────────┬───────────────┤
│ ② 左子栏  │  ③ 主画布                                │ ④ 右检查器    │
│ (页内分段) │                                          │ (选中详情)    │
├──────────┴─────────────────────────────────────────┴───────────────┤
│ ⑤ 日志/活动面板（可收起；长任务进度、命令输出、backup 路径）        │
├────────────────────────────────────────────────────────────────────┤
│         Pre-viz   Calibrate   Color   [Cache]   Live   Tools         │ ← 6 tab 水平居中
└────────────────────────────────────────────────────────────────────┘
```

---

## 0.5 应用外壳（所有页共用，用 S2 组件实现）

> 外壳是全部页公用的框，只实现一次；各页只换"主画布"内容（§1 / §2）。

外壳六区：
- ① 顶部标题栏 + 菜单栏 + 常驻 **Stage 切换器**（下拉 / Picker）
- ② 上下文工具条：随当前页替换，放该页 1–3 个主操作 + 对象选择器
- ③ 左子栏：页内分段（S2 的 SideNav / 垂直分段一类）
- ④ 右 Inspector：选中对象详情
- ⑤ 底部可收起日志 / 活动面板
- ⑥ 最底部一排 **page tab，水平居中**，共 **6 个**：Pre-viz / Calibrate / Color / Cache / Live / Tools，当前页高亮（S2 accent）

实现：Tauri 2 + React + `@react-spectrum/s2`；暗 / 亮双主题（`colorScheme`）；中文 fallback 思源黑体。组件选型查 S2 MCP。Cache / Calibrate 主画布先做实，其余 4 页占位。

---

## 1. Cache 页（迁移自 UECM）

### 1.1 整页 ASCII

```
① 工具条:  [● 在线 6/8 · 健康分 72]   [扫描/纳管]   [一键部署]
┌──────────┬─────────────────────────────────────────┬───────────────┐
│ ② 左子栏  │ ③ 主画布（随左子栏分段切换）             │ ④ 检查器       │
│          │                                          │ 选中机器:      │
│ Cluster ●│  ┌─汇总条: 在线6 严重1 警告1  健康分72─┐ │ RENDER-02     │
│ DDC      │  ┌────┐ ┌────┐ ┌────┐ ┌────┐           │ 192.168.10.22 │
│ PSO      │  │卡片│ │卡片│ │卡片│ │卡片│  ← 机器网格 │ ─────────────  │
│ 一致性   │  └────┘ └────┘ └────┘ └────┘           │ 身份 / UE      │
│ 健康     │  ┌────┐ ┌────┐ ┌────┐ ┌────┐           │ GPU / 凭据     │
│          │  └────┘ └────┘ └────┘ └────┘           │ [操作…]        │
└──────────┴─────────────────────────────────────────┴───────────────┘
```

### 1.2 ① 上下文工具条
- ◆ **集群摘要**：`在线 N/总 N` + 健康分。健康分公式实测：`max(0,(healthy − critical*0.75 − warning*0.35)/total*100)`。
- ◆ **扫描/纳管**：触发 machine scan。
- ◆ **一键部署**：Deploy 入口。
- 作用域提示：◆ 数据在**当前 Stage**上下文里（底层机器来自全局 Machine Library，见 UX-PLAN §4.2）。

### 1.3 ② 左子栏分段
`Cluster（总览）` / `DDC` / `PSO` / `一致性` / `健康`。
> ◆ 对应 UECM 实际的 Machines / DDCPak / PSOCache / INIScanner / HealthCheck 五页，在 Volo 里折叠成一页的左子栏分段。

### 1.4 ③ 主画布（逐段）

**Cluster（总览）**
- ◆ 顶部 **汇总条**：online / critical / warning 计数 + 各自状态点 + 健康分。
- ◆ **机器卡片网格**（aspect-square 卡片）：每张显示 `hostname`、`ip`(mono)、右下角状态点(`UecmStatusDot`)，hover/选中时左上角出现 checkbox。
- ◆ **批量操作 bar**：选中多台后出现。

**DDC**（两列）
- ◆ 左：**生成任务卡片列表**（`PakJobCard` 包 `UecmTaskCard`）：`job_id`、输出路径、项目、状态徽章(queued→running→verifying→completed/error)、进度条(`progress_pct`/`progress_label`)、日志末 8 行。
- ◆ 右：**分发进度表**（`DistributeProgressTable`）：每行一个 target — `target_host`、状态(pending/running/ok/err)、message、err 时显 Retry。

**PSO**（两列）
- ◆ 左：**采集任务卡片**（`PsoJobCard`）：状态(spawning/collecting/completing/completed)、进度、`files_collected` 计数。
- ◆ 右：**采集文件浏览器**（`PsoFileExplorer`）：`file_name`、`size`、`gpu_signature`、`ue_version`、`collected_at` + Distribute 按钮。

**一致性（INI）**
- ◆ 顶部 4 KPI 瓦片：Critical / Warning / Healthy / Files。
- ◆ 左：**Finding 层级树**（`FindingHierarchy`）：每行 hostname、file_path、severity badge、rule_id、symptom 摘要。
- ◆ 右：**Finding 详情**（`FindingDetail`）：severity badge + 规则 + 文件 + 行号；3 列卡片(What's Wrong / Why It Matters / Symptom)；**代码 diff**(`snippet_before` critical 调 / `snippet_after` healthy 调)；操作 Apply Suggestion / Skip(Custom Edit、Open File 现为占位)。
  - ⤴ **补强**：跨机批量改 INI 时，Apply 前增加"影响机器列表"(见 1.6)。
- ✚ **缓存留存提醒卡片**（R027/R028，Info 级）：当扫描发现 Shared DDC / Zen 跑在**默认过期窗口**上，在树顶给一张提醒卡——「当前留存=默认 N 天，长期不访问会被回收」+ 主按钮**「设为项目期常驻」**（FS→`gc_pause` / Zen→`zen_gc_pause`）+ 次按钮**「恢复默认」**（`gc_resume` / `zen_gc_resume`）。**不复用 Apply Suggestion**（这两条 finding 是 `manual`）。详见 `CACHE-UX.md §3.6.1`、`CACHE-CAPABILITIES.md §2`。

**健康**
- ◆ `UecmScoreTile`(集群评分 score/tone/verdict) + 4 KPI(healthy/warning/critical/offline)。
- ◆ **分层 probe 表**：按机器 → 按层(`l1_port` TCP / `l2_bootstrap` PowerShell / `l3_business` WinRM) → probe_key；每行 label + status badge + outcome message +（critical/warning 时）remediation。
- ◆ **GPU 一致性矩阵**（`UecmGpuMatrix`）：列头 `GPU+Driver | Count | [机器名…]`；按 signature(vendor/model/driver) 分组；单元格 OK / 空(偏离) / −(无 GPU)；baseline 行高亮。

### 1.5 ④ 右检查器（选中机器）
- ✚ **取代旧的"详情即整页 6 tab"**：检查器只放**单机信息**，不再把 DDC/PSO/INI/Health 整页嵌进来。
- ◆ 内容(来自旧 overview tab)：
  - **身份**：`hostname` / `ip` / `role` / `last_seen_at`。
  - **UE 安装**：`ue_installs[]`(version / install_path)。
  - **GPU**：`gpus[]`(gpu_model / driver_version / vram_mb / vendor)。
  - **Bootstrap**（仅 `status !== online` 时）：凭据别名选择、bootstrap script/result。
- ✚ **跨段联动**：检查器里"查看该机的 DDC / PSO / INI / 健康"= 跳到对应左子栏分段并过滤到这台机器（取代旧的整页嵌套）。

### 1.6 保留 / 新增 / 补强的交互
- ◆ **状态三通道**：色 + 图标 + 文字。组件 `UecmStatusDot` / `UecmStatusBadge`；tone 枚举 `healthy|warning|critical|info|offline|unknown|progress|na`。
- ⤴ **破坏性操作摩擦（重点补强）**：UECM 现状不完整——`IniEditModal` 有 backup 反馈但**无 diff 预览**，`CredentialDialog` 删除**无二次确认**。Volo 统一成一个**确认抽屉**，改 INI / 凭据 / 注册表前必须显示：① 变更 **diff**；② **影响机器列表**(沿用 `BatchProgressTable` 形态：✓/✗/↻/— + 机器名+IP + 消息)；③ **backup 路径**。再确认。
- ◆ **任务进度走 ⑤ 日志/活动面板**，不堵塞主画布。

### 1.7 Cache 页功能蓝本（喂 Claude Design；外壳见 §0.5，此处聚焦主画布）
> **Cache** 页主画布。布局：顶部上下文工具条显示集群摘要"在线 6/8 · 健康分 72"+ 扫描/纳管 + 一键部署；左子栏分段 Cluster / DDC / PSO / 一致性 / 健康；右侧 Inspector 显示选中机器详情；底部可收起的日志面板。
> 主画布默认显示 Cluster 段：顶部一条汇总条(在线/严重/警告计数各带状态点 + 健康分)，下面是渲染节点卡片网格，每张方形卡显示主机名、IP(等宽字体)、右下角 healthy/warning/critical 状态点(色+图标)。
> 右侧 Inspector 显示一台选中机器：身份(主机名/IP/角色/最后在线)、UE 安装(版本/路径)、GPU(型号/驱动/显存/厂商)、凭据；底部一行操作按钮。
> 改注册表/凭据/INI 这类破坏性操作走确认抽屉：先显示变更 diff + 受影响机器列表 + backup 路径，再确认。**用 React Spectrum 2 组件实现，暗 / 亮双主题；状态三通道(色+图标+文字)；中文思源黑体。界面文案用中文。**

---

## 2. Calibrate 页（网格重建 + 镜头校正；网格段迁移自 LMT，镜头段来自 vpcal）

> 合并自原 Mesh + Geometry 两 tab。逻辑：**先重建 LED 屏网格，屏几何就绪后直接校镜头**——一条连续工作流，故并为一页。网格段有逐组件 wireframe（下文），镜头段先占位。

### 2.1 整页 ASCII

```
① 工具条:  [屏: Screen_A ▾]        [重建]        [导出 ▾]  [指导卡]
┌──────────┬─────────────────────────────────────────┬───────────────┐
│ ② 左子栏  │ ③ 主画布（随步骤切换）                   │ ④ 检查器 ✚    │
│(工作流步骤)│                                          │ 选中 cabinet/  │
│ Design  ●│   ┌─────────────────────────────┐        │ point/run:    │
│ Method   │   │  Konva 2D cabinet 网格       │        │ 位置 (col,row)│
│ Survey   │   │  (mask/refs/baseline)        │        │ measured/guess│
│ Preview  │   │                              │        │ 误差 _._ mm   │
│ Runs     │   └─────────────────────────────┘        │               │
│          │   工具条: [M]ask [R]efs [B]aseline        │               │
└──────────┴─────────────────────────────────────────┴───────────────┘
```

### 2.2 ① 上下文工具条
- ◆ **屏选择器**（`ScreenPicker`）：一个 Stage/项目含多屏(`screens: Record<string, ScreenConfig>`)。
- ◆ **重建**：触发 reconstruct。
- ◆ **导出**（`PreviewToolbar` 实测三目标）：`disguise`(Disguise) / `unreal`(Unreal Engine) / `neutral`(标准 OBJ)。
- ◆ **指导卡**（M1）：生成可打印测量指导卡(HTML→PDF)。

### 2.3 ② 左子栏分段（= 工作流步骤）
**网格重建** `Design → Method → Survey/Import → Preview → Runs` → **镜头校正** `Lens`
> ◆ 网格段对应 LMT 路由 `design / method / import(M1) | charuco+photoplan(M2) / preview / runs`。
> ✚ Lens 段 = 合并进来的镜头校正（原 Geometry / vpcal），承"网格就绪后直接校镜头"的连续流程；详见 §2.4 末。

### 2.4 ③ 主画布（逐步骤）

**Design（2D 编辑）**
- ◆ **Konva cabinet 网格**（`CabinetGrid`）：cell 配色 — absent/mask 灰、belowBaseline 深蓝、normal 浅蓝、refs(origin/x_axis/xy_plane) 红/绿/蓝边框。
- ◆ **工具条**（`DesignToolbar`）：模式切换 — 快捷键 **M**=mask / **R**=refs / **B**=baseline；refs 模式下 **1/2/3** = origin / x_axis / xy_plane；Ctrl+Z / Ctrl+Y 撤销重做。
- ◆ **图例**（`CabinetGridLegend`）。
- 数据：`ScreenConfig`(cabinet_count[cols,rows] / cabinet_size_mm / shape_prior flat|curved|folded / shape_mode rectangle|irregular / irregular_mask / bottom_completion)。

**Method（测量方法）**
- ◆ 两张并排卡片(grid-cols-2)：**M1 全站仪**(Trimble SX resection) / **M2 视觉**(ChArUco + bundle adjustment)。当前方法高亮(border-primary + bg-primary/5)；按钮态 Use / Continue / Switch；切换弹确认。

**Survey/Import**
- ◆ **M1**：CSV 导入 → **导入报告**(`TotalStationImportResult`)：`measuredCount` / `fabricatedCount` / `outlierCount` / `missingCount` + warnings；measured.yaml 加载状态徽章。
- ◆ **M2**：Charuco / Photoplan —— ⚠️ 现状是 **stub/pending**，保留入口 + 明确"未实现"占位(斜纹态)。

**Preview（3D）**
- ◆ **Three.js 网格**（`MeshPreview` + OrbitControls）：显示顶点数(`surface.vertices.length`)、拓扑 cols×rows。
- ◆ **质量指标**（`QualityMetrics`）：`middle_max_dev_mm` / `middle_mean_dev_mm` / `estimated_rms_mm` / `estimated_p95_mm` / missing / outliers / warnings。
- ✚ **误差着色**：现状**未实现**(material 单色)。Volo 规划：按 per-vertex 误差上色 + 图例。标为新增、可后做。
- ◆ **斜纹未知态**(`.bg-hatched`)：空/低置信/pending 用斜纹，不用"自信默认值"掩盖。

**Runs（重建历史）**
- ◆ **历史表**：列 Created / Screen / Method / **RMS**(状态徽章+数值) / Vertices / Target / OBJ。
- ◆ **RMS 阈值**（实测 `rmsTone`）：`null → n/a` · `<3mm → healthy(绿)` · `<8mm → warning(黄)` · `≥8mm → critical(红)`。
- ◆ 点击行展开 → 加载 run report(JSON)。

**Lens（镜头校正）— ✚ 合并自 Geometry / vpcal（先占位，详细字段待补）**
- ✚ 来源 `calibration/vpcal`（纯 CLI 无 GUI，需包一层 GUI）。承网格重建之后：屏几何就绪 → 直接校镜头。
- ✚ 四阶段管线做成 stepper：`Validate → Detect → Solve → Report`。
- ✚ Report：变换矩阵（7 自由度）、RMS / inlier / outlier、重投影误差；未跑 / 未知用斜纹占位，不用自信默认值掩盖。
- ⚠️ 逐组件字段做到该段时再实测 vpcal 补全；本轮先留工作流步骤 + 报告查看器骨架。

### 2.5 ④ 右检查器（选中 cabinet / point / run）— ✚ 全新
> LMT 现状**无右检查器**。这是 Volo 新增，统一选中详情。
- ✚ 选 **cabinet/cell**：位置(col,row)、状态(absent/baseline/normal)、ref 角色(origin/x_axis/xy_plane)。
- ✚ 选 **point**：名称、坐标 [x,y,z]、**measured vs guessed**(区分实测点与补充/外推点)、不确定度、误差(真实 mm)。
- ✚ 选 **run**：method / RMS / vertex_count / target / created_at + 质量指标。

### 2.6 保留 / 新增 / 补强的交互
- ◆ **诚实对待不确定性**：斜纹表未知/空/低置信；误差用真实 **mm**；measured vs guessed 清楚区分(数据层有 `fabricatedCount`/`outlierCount`，`estimated_rms_mm = null` 表精确插值)。
- ◆ **可打印指导卡**(M1)：HTML 预览 → 导出 PDF。⚠️ 现状单屏限制(取第一个 screen)，Volo 可扩成跟随屏选择器。
- ◆ **状态徽章**复用同一套 tone。

### 2.7 Calibrate 页功能蓝本（喂 Claude Design；外壳见 §0.5，网格 + 镜头两段）
> 生成 Volo 的 **Calibrate** 页(网格重建 + 镜头校正)。布局：顶部上下文工具条有屏选择器(下拉)、重建按钮、导出下拉(Disguise / Unreal / Neutral)、生成指导卡按钮；左子栏是工作流步骤 **网格重建 Design → Method → Survey → Preview → Runs，再接 镜头校正 Lens**；右侧 Inspector 显示选中对象详情；底部可收起日志面板。
> 主画布默认 Design 步骤：一个 2D 的 LED cabinet 网格编辑器(类似画布)，格子有几种状态配色(正常 / 遮罩 / 基线以下 / 参考点 四态)；画布下方一行模式工具条 Mask(M) / Refs(R) / Baseline(B)。
> Runs 步骤显示重建历史表：列 Created / Screen / Method / RMS / Vertices / Target / OBJ；RMS 用状态徽章，<3mm 绿、3–8mm 黄、≥8mm 红、无值显示 n/a。
> Lens(镜头校正)步骤：四阶段 stepper Validate → Detect → Solve → Report；Report 显示变换矩阵(7 自由度)、RMS / inlier / outlier、重投影误差；未跑 / 未知用斜纹占位。
> 右侧 Inspector 显示选中的 cabinet/点/run：位置、measured vs guessed、误差(单位 mm)。未知或低置信区域用斜纹图案表示，不要用看起来很自信的默认值掩盖。**用 React Spectrum 2 组件实现，暗 / 亮双主题；诚实对待不确定性(斜纹 / measured vs guessed)；中文思源黑体。界面文案用中文。**

---

## 3. 两页都遵守（回指 BRAND-BRIEF — React Spectrum 2）
- **用 React Spectrum 2 组件实现**：视觉 / 主题 / 间距 / 控件全继承 S2，不自定义；暗 / 亮双主题。详见 `BRAND-BRIEF.md`，组件用法查 S2 MCP。
- 仍保留(可用性底线)：状态三通道(色+图标+文字)、CJK 排版(中文思源黑体、不进 mono)。
- 破坏性操作有摩擦；长任务走日志面板；modal 非首选(抽屉/内联优先)。

---

## 附：真实数据字段映射（核实来源）

| 区块 | 关键字段/阈值 | 来源文件 |
|---|---|---|
| 机器详情 6 tab | overview/projects/ddc/pso/ini/health | `ue-cache-manager/src/components/machines/MachineDetailTabs.vue` |
| 机器/GPU/UE 类型 | Machine / MachineDetail / GpuInfo / UeInstall | `ue-cache-manager/src/services/tauri.ts` |
| 健康分公式 | `max(0,(healthy−critical*0.75−warning*0.35)/total*100)` | `ue-cache-manager/src/views/HealthCheck.vue` |
| INI finding | severity/category/snippet_before/after/recommended_action | `ue-cache-manager/src/services/tauri.ts` (IniFinding) |
| 破坏性操作现状 | IniEditModal(有backup无diff)/CredentialDialog(无确认) | `ue-cache-manager/src/components/modals/` |
| 状态 tone 枚举 | healthy\|warning\|critical\|info\|offline\|unknown\|progress\|na | `ue-cache-manager/src/components/primitives/types.ts` |
| Design 快捷键 | M/R/B；refs 下 1/2/3；Ctrl+Z/Y | `led-mesh-toolkit/src/views/Design.vue` |
| Cabinet 数据 | cabinet_count/cabinet_size_mm/shape_mode/irregular_mask | `led-mesh-toolkit/src/services/tauri.ts` (ScreenConfig) |
| RMS 阈值 | null=na / <3 healthy / <8 warning / ≥8 critical | `led-mesh-toolkit/src/views/Runs.vue` (rmsTone) |
| 导入报告 | measured/fabricated/outlier/missing + warnings | `led-mesh-toolkit/src/services/tauri.ts` (TotalStationImportResult) |
| 导出目标 | disguise / unreal / neutral | `led-mesh-toolkit/src/components/preview/PreviewToolbar.vue` |
| 斜纹未知态 | `.bg-hatched` | `led-mesh-toolkit/src/style.css` |
| 右检查器 | LMT 现状无 → Volo 新增 | （无） |

---

> Knowledge Sources：无 KB 匹配。External Inputs：对 `ue-cache-manager` / `led-mesh-toolkit` 源码的实测探索(两个 Explore agent，路径见上表)；`UX-PLAN.md` §5、`BRAND-BRIEF.md`。
