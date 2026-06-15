# Cache 页 UX 蓝本（源自 UECM CLI 走读）

> **来源**：`ue-cache-manager/_walkthrough/REPORT.md`（UECM CLI 0.1.0 全量走读实测，2026-06-14；91 命令 / 17 域）。
> **用途**：把 UECM 的**功能 / 工作流 / 状态模型**从命令行视角抽出来，喂给 Claude Design 做 **Cache 页**布局。
> **与 `WIREFRAMES.md §1` 的分工**：WIREFRAMES 管**视觉结构**（哪个区放什么组件、字段名、组件名）；本文管**操作真相**（能做什么、按什么顺序做、对象有哪些状态、哪些操作要有摩擦）。两者配套读，组件命名以 WIREFRAMES 为准，本文不重复。
> ⚠️ 临时功能稿，会在 Claude Design 迭代中调整；CLI 行为以 REPORT 实测为准。

**图例**（沿用 WIREFRAMES）：◆ 迁移现状（旧 app 已有，搬结构）· ✚ 新增（Volo 新设计）· ⤴ 补强（旧 app 有雏形，Volo 做完整）。

---

## 0. 一句话 & 操作者心智模型

**Cache 页 = 一个跨多台渲染机的「集群运维控制台」**：把一批 Windows 渲染节点纳管进来，让它们的 UE 缓存（DDC / PSO）、共享缓存服务（ZenServer）、配置一致性（INI）和整体健康保持就绪，**破坏性操作前必须先看见影响范围再确认**。

操作者心智模型（决定信息架构）：

1. **先有机器，才有一切** —— 纳管 → 探测硬件/UE → 存凭据，是所有后续操作的前提。
2. **「服务器 / 工作站」两类机器**职责不同（见 §2.2），界面要让人一眼分清谁是共享缓存服务器、谁是跑 UE 的工作站。
3. **多数高价值操作是「多步流程」而非「单按钮」**：部署 ZenServer、接入新机、一键部署都是有先后顺序、带凭据、带预检和验证关卡的向导（见 §3）。
4. **诚实 > 自信**：可达性探测会有「陈旧误报」、Zen 可达时任务会「智能跳过」—— 这些既不是成功也不是失败，要有独立的视觉（见 §2.6）。

---

## 1. 核心功能域（8 域 → UI 落点）

REPORT 走读覆盖 8 个核心功能域。下表是「域 → Cache 页 UI 落点」的映射，给 Claude Design 定位每块功能放哪。

| # | 功能域 | UI 落点（左子栏分段 / 入口） | 该处主操作 | 关键命令（实测） |
|---|--------|------------------------------|-----------|------------------|
| 1 | **扫描与基础设置** | `Cluster` 段 + 工具条「扫描/纳管」+ Bootstrap 向导(§3.1) | 探测 → 纳管 → 存凭据 | `machine scan/add/refresh`、`cred save`、`local-cache create`、`env set`、`share create`、`ssh package-bootstrap` |
| 2 | **ZenServer 部署** | ⤴ Zen 状态进 `Cluster`(机器角色+服务态) 与 `健康`(zen_reachable)；动作是部署向导(§3.2/§3.3) | 服务端装服务 / 工作站接共享缓存 | `zen register/detect-binary/apply-config/urlacl/service install+start/probe/enable/set-region-host/clean-env` |
| 3 | **PSO 缓存** | `PSO` 段 | 采集着色器管线缓存 → 分发 | `pso verify/list/collect/distribute` |
| 4 | **DDC Pack** | `DDC` 段 | 生成派生数据缓存 → 验证 → 分发 | `ddc generate/verify/distribute` |
| 5 | **INI 扫描修复** | `一致性` 段 | 扫出配置问题 → 看 diff → 应用/跳过 | `ini scan/findings/apply/skip` |
| 6 | **集群健康检查** | `健康` 段 | 三层探测 → 看 remediation → GPU 一致性 | `health run/results/consistency-check` |
| 7 | **Log 验证 / 顾问** | `健康` 段内（高级诊断） | 跑启动日志验证、分析 advisory | `log verify-startup`、`health analyze-advisories` |
| 8 | **一键部署** | 工具条「一键部署」→ plan 向导(§3.8) | 预览 plan → dry-run → 执行 | `deploy ddc --plan / --dry-run` |

> **注意（IA 提示）**：WIREFRAMES 左子栏是 5 段 `Cluster / DDC / PSO / 一致性 / 健康`。**ZenServer 部署是横切的第 6 个域，但不单独占段**：它的**状态**显示在 Cluster（机器角色 + `UECMZenServer` 服务态）和健康（`zen_reachable` 探测）里，它的**动作**是从工具条/机器检查器拉起的向导。这是相对 WIREFRAMES 的一处补强建议（⤴），见 §2.2 / §5。

---

## 2. 核心对象 & 状态模型（驱动「状态三通道」）

状态三通道（色+图标+文字）需要确定的枚举值才能落地。下面把每类对象的状态从 REPORT 抽出来。tone 枚举沿用 UECM：`healthy | warning | critical | info | offline | unknown | progress | na`。

### 2.1 机器 Machine —— 有「角色」之分（⤴ 补强）

机器卡片（WIREFRAMES 的 aspect-square 卡）除 `hostname / ip / 状态点` 外，**应增加角色标识**：

- **`shared_upstream`（共享缓存服务器）** —— 跑 `UECMZenServer` 服务、被工作站连接的独立服务器。卡片要显示服务态（见 §2.2）。
- **`workstation`（工作站）** —— 跑 UE Editor、消费共享缓存的渲染机。有 `ue_runtime_user` 信号（部署 Zen 服务时会对它发 advisory 警告，提示「这看着像工作站，别在这装服务端」）。
- 角色未声明的普通纳管机：保持现状卡片。

> 依据：REPORT「架构决策：ZenServer 独立服务器部署」—— ZenLocal（工作站，UE 自管）与 ZenShared（独立服务器，UECM 管）两层并存。`zen register --role shared_upstream` 显式声明角色；`zen service install` 在有 `ue_runtime_user` 的机器上发 advisory（ZEN-3）。

机器在线态（◆ 现状）：`online / offline`，离线时检查器才出 Bootstrap 区。

### 2.2 Zen 两层架构 —— UI 必须表达（✚ 新增表达）

这是 Cache 页最容易被旧 UI 漏掉、但运维上最关键的概念。两层并存、互不冲突：

| 层 | 位置 | 管理者 | 端口 | 在 UI 哪里体现 |
|---|---|---|---|---|
| **ZenLocal** | 工作站 localhost | UE Editor AutoLaunch | 8558 | 不归 Volo 管，**不展示也不操作**（避免误导用户去关它） |
| **ZenShared** | 独立服务器 LAN IP | UECM 的 `UECMZenServer` 服务 | 8558 | `shared_upstream` 机器卡片上的服务态徽章 + `健康` 段的 `zen_reachable` |

服务态（`shared_upstream` 卡片）：`Running/Automatic`（healthy）· `Stopped`（critical）· 探测陈旧（见 §2.6，不要当成 critical）。

> 依据：REPORT 架构决策表 + `zen service status → UECMZenServer Running/Automatic`（BUG-6 复验）。**不要在工作站上提供「关 AutoLaunch」开关** —— REPORT 明确该方案（commit 92017be）已被回滚淘汰，会禁用 UE 内建 Zen 面板。

### 2.3 凭据 Credential —— 别名 + 提权通道（◆ + ⤴）

- 凭据以**别名（alias）**贯穿所有远程操作（`cred save --alias <alias>`，后续 `--cred-alias <alias>`）。UI 任何远程动作都要有**凭据选择器**。
- **两条远程通道、权限不同**，UI 要在需要时提示走哪条：

| 操作 | WinRM（uecm-svc） | 提权 SSH（uecm-svc） |
|------|------------------|---------------------|
| 读文件/注册表 | ✅ | ✅ |
| 写 Machine-scope 环境变量 | ❌ UAC 过滤 | ✅ |
| Stop/卸载 Windows 服务 | ❌ UAC 过滤 | ✅ |
| 建 SMB 共享 | ✅（需管理员组） | ✅ |
| 写 Program Files 下 INI | ✅（在 Admins 组） | ✅ |

> 含义：当用户要「停 Zen 服务」「写机器级 ENV」「set-region-host」时，UI 应表明此操作需提权 SSH 通道（key 认证），不能只靠 WinRM。这是 ⤴ 补强：旧 UI 未把通道差异显式化。

### 2.4 任务状态机（DDC / PSO / 分发）—— 走日志面板，不堵主画布

| 任务 | 状态流转（用于进度徽章 + 进度条） | 计数字段 | 出口 |
|---|---|---|---|
| **DDC 生成**（`PakJobCard`，◆） | `queued → running → verifying → completed / error` | `progress_pct` / `progress_label` + 日志末 8 行 | 底部日志面板 |
| **PSO 采集**（`PsoJobCard`，◆） | `spawning → collecting → completing → completed` | `files_collected` | 底部日志面板 |
| **分发**（`DistributeProgressTable`，◆） | 每 target：`pending → running → ok / err`（err 显 Retry） | `target_host` + message | 右侧/分发表 |

> DDC/PSO 是「启 UE 进程、流式输出日志」的长任务（REPORT BUG-1 实测：`ddc generate --backend legacy` 稳定跑 34min 编译 43,481 shader 无 panic）。**进度必须走底部日志/活动面板**，主画布不阻塞。

### 2.5 诊断状态（INI / 健康 / GPU）

- **INI Finding**（◆）：`critical / warning / healthy`，每条带 `rule_id`、`symptom`、`snippet_before/after`（代码 diff）、`recommended_action`。
- **健康三层探测**（◆）：`l1_port`（TCP）/ `l2_bootstrap`（PowerShell）/ `l3_business`（WinRM），每条 `status` + `outcome message` +（critical/warning 时）`remediation`。
- **GPU 一致性矩阵**（◆ `UecmGpuMatrix`）：按 `signature(vendor/model/driver)` 分组，baseline 行高亮，单元格 OK / 空(偏离) / −(无 GPU)。注：`machine refresh` 已自动过滤虚拟显示适配器（MS Idd/Parsec/向日葵/VMware…，F-005），矩阵里只剩物理卡。
- **健康分公式**（◆，工具条用）：`max(0,(healthy − critical*0.75 − warning*0.35)/total*100)`。

### 2.6 「跳过」与「陈旧」是一等结果（✚ —— 诚实对待不确定性）

REPORT 里两个反直觉但高频的结果，**界面必须区别于成功/失败**，否则会误导操作者：

1. **智能跳过（`skipped:true`）** —— `ddc generate/verify --backend auto` 在 Zen 可达时直接返回 `{"skipped":true,"reason":"zen handles caching natively / routing to zen"}`。这是**正确行为不是错误**。用 `na` tone（中性/斜纹），文案明确「已交由共享 Zen，无需本地生成」。
2. **健康在 Zen 模式下降级** —— 集群存在共享 Zen 时，`env_shared/env_vars` 检查项从 `critical` 降级为 `na`（计入 skipped），message 改写为「Zen shared mode active…」，remediation「No action needed」（DESIGN-1）。
3. **探测陈旧误报** —— `health run` 的 `zen_reachable` 在探测数据 stale（last age > 5min 窗口）时会报 critical，但**不是真不可达**（F-043）。UI 应：① 健康段提供「前置刷新」按钮串（`zen probe → cache-stats → health run`，见 §3.7）；② 对陈旧态用「stale/需刷新」措辞而非红色 critical。

> 这条直接对应跨页原则「诚实对待不确定性」：跳过/陈旧/未知是一等公民，视觉上独立，不用「自信的红/绿」掩盖。

---

## 3. 关键工作流（要做成向导 / stepper）

REPORT 的「操作顺序（Skill/GUI 必须遵守）」给了精确步骤序列。这些**不能做成散落的按钮**，要做成有先后、带凭据选择、带 dry-run 预览、带末端验证关卡的**向导**。每个向导都标注了哪一步「破坏性 / 需提权 / 需现场」。

### 3.1 新机接入 Bootstrap（◆，5 步，含唯一需现场步骤）

```
1. ssh package-bootstrap --out <目录>        生成引导包
2. 〔现场〕人工传到新机并双击运行            ← 唯一需要人到现场的步骤，UI 要明确标注「等待现场执行」
3. machine add --ip <IP>                     纳管入库
4. machine refresh <id>                      探测 GPU/UE（自动过滤虚拟适配器）
5. machine set-ue-user --machine <id> --ue-user <用户名>
```
UX 要点：第 2 步是异步的现场动作，向导应停在「已生成引导包，等待该机回连」并提供「我已运行，继续探测」。

### 3.2 ZenServer 服务端部署（◆，在 `shared_upstream` 机器上，10 步）

```
1. machine add --ip <server_ip>
2. machine refresh <id>
3. cred save --alias <alias> --user uecm-svc --pass-stdin       〔凭据〕
4. zen register --machine <id> --role shared_upstream --declared-port 8558 --data-dir <dir>
5. zen detect-binary --machine <id> --cred-alias <alias>        自动选最高 UE 版本的 in-tree 二进制
6. zen apply-config --endpoint-id <id> --cred-alias <alias> --yes   写 zen.lua + SHA256 校验
7. zen urlacl add --endpoint-id <id> --principal "NT AUTHORITY\LocalService" --cred-alias <alias> --yes
8. zen service install --endpoint-id <id> --cred-alias <alias> --yes  〔工作站会发 advisory 警告〕
9. zen service start  --endpoint-id <id> --cred-alias <alias>
10. zen probe --machine <id>                                    ← 末端验证关卡：服务可达才算成功
```
UX 要点：做成 stepper，每步显示成功/失败 + 输出；第 6/7/8 步是破坏性需 `--yes`（向导内统一确认）；第 8 步若目标机像工作站则显 advisory（黄，不硬失败）；**最后一步 probe 是验证关卡**，绿了才标「部署完成」。

### 3.3 ZenShared 客户端配置（◆，在工作站上，2 步 + 可选路由）

```
1. machine set-ue-user --machine <workstation_id> --ue-user <Windows用户名>
2. zen enable --upstream-endpoint-id <id> --global --machines <workstation_id> --cred-alias <alias> --yes
```
- `zen enable` 写 `[StorageServers] Shared=(Host="http://<host>:8558", Namespace=…, EnvHostOverride=UE-ZenSharedDataCacheHost, …)` —— **端口必须内嵌进 Host URI**（ZEN-1：UE 的 Zen 解析器没有独立 `Port=` 字段，裸 `Port=8558` 会被静默忽略导致连不上）。
- **不写 `AutoLaunch=false`**（独立服务器方案下 ZenLocal 保持正常）。
- **可选·多区域路由**（✚ 展示为「按机/区覆盖」）：
  ```
  zen set-region-host --machines <ids> --host http://<region_server>:8558 --yes   〔需提权 SSH，写机器级 ENV〕
  zen clean-env --machines <ids> --name UE-ZenSharedDataCacheHost --yes            还原到 INI 默认
  ```

### 3.4 DDC 生成 → 验证 → 分发（◆，DDC 段）

```
ddc generate --backend auto    Zen 可达 → skipped(§2.6)；否则 legacy 启 UE 跑 commandlet
ddc verify   --backend auto    同上路由，Zen 可达 → skipped
ddc distribute                 推到各 target（需第二台节点）
```
UX 要点：`--backend auto` 的「智能跳过」要可见且解释清楚；`distribute` 用分发进度表（§2.4）。

### 3.5 PSO 采集 → 分发（◆，PSO 段）

```
pso collect       启 UE editor 收集着色器管线缓存，流式日志
pso list          已采集文件浏览器（file_name/size/gpu_signature/ue_version/collected_at）
pso distribute    分发到 target
```
UX 要点：采集卡片走 §2.4 状态机；文件浏览器每行带 Distribute。（REPORT F-044：重型 VP 项目 editor 退出阶段可能 hang → 采集到但未入库，属 UE 项目侧限制，UI 对「采集中/超时未入库」要有明确态。）

### 3.6 INI 扫描 → 修复（◆ + ⤴，一致性段）

```
ini scan       扫描配置
ini findings   列出问题（分层树：hostname → file → finding）
ini apply <id> 应用建议（自动建 .bak.<timestamp> 备份；就地改 backend-graph tuple 内联字段）
ini skip  <id> 跳过
```
UX 要点（⤴ 重点补强）：UECM 现状 `IniEditModal` 有 backup 反馈但**无 diff 预览**。Volo 在 `apply` 前必须走**确认抽屉**（§4）：① 变更 diff（`snippet_before/after`）② **影响机器列表**（跨机批量改 INI 时）③ backup 路径。`ini set/remove` 直接编辑往返一致，破坏性需 `--yes`。

### 3.7 健康检查（◆，健康段，含前置刷新）

```
zen probe       --machine <ids>      ← 前置：避免 zen_reachable 陈旧误报(§2.6)
zen cache-stats --endpoint-id <id>
health run      --machine-ids <ids>  L1/L2/L3 三层；每条 critical 带 remediation
health results  <run_id>             读结果
```
UX 要点：把「前置刷新」做成健康段顶部一个动作（一键串起 probe→cache-stats→run），从根上消除陈旧误报。

### 3.8 一键部署（◆，工具条入口）

```
deploy ddc --plan <plan.json> --dry-run   输出完整 steps 列表，可预览不执行
```
UX 要点：plan → dry-run 预览（输出 steps）→ 执行。plan 校验失败给明确报错（DESIGN-2：`pso.enabled` 为真但缺 `resolution` → `invalid_input` exit2「pso.resolution is required…」）。这是「预览优先」原则的招牌场景。

---

## 4. 贯穿全页的交互护栏（所有破坏性操作共用）

REPORT 反复验证了一组「安全行为」，是 Cache 页所有写操作的统一底座。Claude Design 应把它们设计成**一致的复用模式**，而非每处各搞一套：

1. **预览优先（dry-run）** —— `env set` / `ini apply` / `deploy` 均支持 `--dry-run`。任何写操作 UI 默认先给「预览变更」。
2. **二次确认（`--yes`）** —— 破坏性命令缺 `--yes` 一律拒绝（exit 2，提示 `pass --yes to confirm or --dry-run`），真实 id 也不误删（实测 `machine delete 1` 无 `--yes` 后机器仍在）。涉及：`machine delete` / `zen unregister` / `cred delete` / `zen service stop` / `ini gc-pause|gc-resume`。UI = 不可绕过的确认步骤。
3. **自动备份** —— `ini apply` 自动建 `.bak.<timestamp>`。确认抽屉与日志面板都要回显 backup 路径。
4. **统一「确认抽屉」**（⤴ 重点补强）—— 改 INI / 凭据 / 注册表 / 机器级 ENV 前，抽屉必须显示三件套：① 变更 **diff**；② **影响机器列表**（沿用 `BatchProgressTable` 形态：✓/✗/↻/— + 机器名 + IP + 消息）；③ **backup 路径**。再确认。（修复 UECM 现状：`IniEditModal` 无 diff、`CredentialDialog` 删除无二次确认。）
5. **两阶段「探测 vs 纳管」** —— `machine scan` 纯探测**不写 DB**，`machine add` 才入库。UI 的「扫描/纳管」应是：扫出候选列表 → 勾选 → 纳管，不要扫到就直接入库。
6. **权限通道提示** —— 需提权 SSH 的操作（停服务 / 写机器级 ENV，§2.3）UI 要标明，并确保已配置提权 key（`uecm_ed25519`）。
7. **长任务走底部日志/活动面板** —— DDC/PSO 生成、分发、部署的流式输出与进度都进 ⑤ 面板，主画布不阻塞。

---

## 5. 左子栏逐段布局指引（给 Claude Design）

把 §1–§4 落到 WIREFRAMES 的 5 段主画布上。每段一句话「这段在干什么 + 主状态 + 关键护栏」。

- **Cluster（总览）** —— 集群一眼概览。顶部汇总条（online/critical/warning 计数 + 健康分）；机器卡片网格，**卡片增加角色标识与（服务器卡）Zen 服务态**（§2.1/§2.2）；多选出批量操作 bar。「扫描/纳管」走两阶段（§4.5）。部署向导（§3.1/§3.2/§3.3）从这里或机器检查器拉起。
- **DDC** —— 左：生成任务卡片（`queued→running→verifying→completed/error`）；右：分发进度表。突出 `--backend auto` 的**智能跳过**态（§2.6）。
- **PSO** —— 左：采集卡片（`spawning→collecting→completing→completed` + `files_collected`）；右：采集文件浏览器（每行 Distribute）。处理「采集到但未入库/超时」态。
- **一致性（INI）** —— 顶部 4 KPI（Critical/Warning/Healthy/Files）；左 finding 分层树；右详情（severity + 规则 + 文件 + 行号 + 代码 diff + Apply/Skip）。**Apply 前强制确认抽屉**（§3.6/§4.4）。
- **健康** —— 集群评分瓦片 + 4 KPI；分层 probe 表（L1/L2/L3，critical/warning 带 remediation）；GPU 一致性矩阵（baseline 高亮）。顶部放「前置刷新」（§3.7），陈旧态用 stale 而非 critical（§2.6）。

右检查器（选中机器，◆/✚）：身份 / UE 安装 / GPU / 凭据 /（离线时）Bootstrap；**新增**角色与 Zen 客户端配置状态；「查看该机的 DDC/PSO/INI/健康」= 跳到对应段并过滤到本机。

---

## 6. 整页布局 brief（prompt-ready，喂 Claude Design）

> 生成 Volo 的 **Cache** 页（渲染集群运维控制台，迁移自 UECM）。外壳见 `WIREFRAMES.md §0.5`，本 brief 聚焦主画布与流程。
>
> **顶部上下文工具条**：当前 Stage 的集群摘要「在线 N/总 N · 健康分 NN」+「扫描/纳管」+「一键部署」。
>
> **左子栏 5 段**：Cluster（总览）/ DDC / PSO / 一致性 / 健康。
>
> **主画布默认 Cluster 段**：顶部汇总条（在线/严重/警告计数各带状态点 + 健康分）；下面是渲染节点**卡片网格**，每张方卡显示主机名、IP（等宽字体）、右下角 healthy/warning/critical 状态点（色+图标），并**用徽章区分机器角色**——「共享缓存服务器」要额外显示 ZenServer 服务态（Running/Stopped），「工作站」普通显示。
>
> **右侧 Inspector**：选中一台机器 → 身份（主机名/IP/角色/最后在线）、UE 安装（版本/路径）、GPU（型号/驱动/显存/厂商）、凭据、Zen 客户端配置状态；离线机才出 Bootstrap 区；底部一行「跳到该机的 DDC/PSO/INI/健康」联动按钮。
>
> **多步操作做成向导（stepper）而非单按钮**：①接入新机（生成引导包→等现场运行→纳管→探测）②部署共享缓存服务器（注册→探测二进制→写配置→装服务→启动→末端探测验证）③工作站接入共享缓存（设 UE 用户→enable）。每个向导带凭据选择、dry-run 预览、逐步状态、末端验证关卡。
>
> **破坏性操作走确认抽屉**：改 INI / 凭据 / 注册表 / 机器级 ENV 前，先显示「变更 diff + 受影响机器列表（✓/✗/↻/— + 机器名 + IP）+ backup 路径」，再确认。删除类操作不可一键直删。
>
> **诚实对待不确定性**：任务在共享 Zen 可达时会「智能跳过」（用中性/斜纹态 + 文案解释「已交由共享缓存」，不要标成成功或失败）；健康探测数据陈旧时显示「需刷新」而非红色严重；健康段顶部提供「前置刷新」按钮一键串起探测。
>
> **长任务走底部可收起的日志/活动面板**：DDC/PSO 生成、分发、部署的流式日志与进度条都在这里，主画布不阻塞。
>
> **用 React Spectrum 2 组件实现，暗 / 亮双主题；状态三通道（色+图标+文字），tone 枚举 healthy|warning|critical|info|offline|unknown|progress|na；中文思源黑体；界面文案用中文。**

---

## 附：来源映射（可回查 REPORT.md）

| 本文断言 | REPORT.md 锚点 |
|---|---|
| 8 核心功能域 | 「走读覆盖的 8 个核心功能域」表 |
| ZenLocal/ZenShared 两层架构、机器角色 | 「架构决策：ZenServer 独立服务器部署」 |
| 端口必须内嵌 Host URI | 「🔴 Port 未生效（随 ZEN-1 修复）」+ ZEN-1 实测 |
| 智能跳过 skipped / 健康 Zen 模式降级 | 「已验证的正确行为」`ddc generate/verify --backend auto` + DESIGN-1 |
| 探测陈旧误报 | F-043 + 「health run 前置刷新」 |
| 4 个操作顺序向导 | 「操作顺序（Skill/GUI 必须遵守）」全节 |
| 破坏性需 `--yes` / 自动备份 / dry-run / scan≠add | 「已验证的正确行为（Skill/GUI 可信赖）」全列 |
| 权限通道（WinRM vs 提权 SSH） | 「权限限制汇总」表 |
| 任务状态机 / 组件名 | 交叉 `WIREFRAMES.md §1.4`（DDC/PSO 卡片）+ REPORT 命令域 |
| 虚拟适配器过滤 / 健康分公式 | F-005 + `WIREFRAMES.md §1.4 健康` |

> External Inputs：`ue-cache-manager/_walkthrough/REPORT.md`（UECM CLI 0.1.0 走读实测）；交叉 `docs/design/WIREFRAMES.md §1`、`UX-PLAN.md §5.1`、`BRAND-BRIEF.md`。
