# Volo 整改待办（第一性原理审查，2026-11-24）

> 来源：2026-11-24 对全仓的静态审查（未跑真机；本机为全新 clone）。
> 文中的验收状态取自仓内 6–7 月的文档，处理前先核对是否已有进展。
> 状态图例：⬜ 未开始 · 🟡 进行中 · ✅ 完成 · ⛔ 等决策或等硬件。
> 本文件位于被 `.gitignore` 忽略的 `docs/` 下，入库需 `git add -f`。

## 总判定

- **不推翻**：Rust 领域层、`voloctl`、Python 标定算法、SSH 远程执行、PSO 预热机制。
- **要大改**：跨板块数据模型（Stage）、Calibrate 两套求解代码合并、"融合"的做法、DDC 三代方案收敛、前端代码结构。
- **最大风险不在代码**：标定链路缺真 LED 墙和真追踪的验证。

## 保留不动清单

处理下列待办时，不得顺手重构这些部分：

| 部分 | 理由 |
|---|---|
| `crates/cache-core` 领域逻辑与 `crates/volo-cli` | GUI 与 CLI 共用同一核心，约 1300 个测试覆盖 |
| 破坏性操作的 `confirmed` / `dry_run` 契约 | 与 CLI 的 `--yes` / `--dry-run` 一一对应 |
| `mesh-vba` 的箱体刚体平差建模 | 未知数少、尺度由像素间距确定，建模正确 |
| `vpcal` 的重投影残差链、坐标变换、可观测性门 | 仓内整改路线已审过并列入保留清单 |
| PSO 预热（交互式计划任务 + 卡顿计数 + 扫场收敛判据） | 由真机实测逼出，旧的缓存文件分发方案已被证伪 |
| SSH 推送分发（暂存区 + 原子移动） | 数据与控制同一条信任通道 |
| sidecar 启动白名单 | 前端不能让后端执行任意二进制 |

---

## P0：先做

### P0-1 入口文档与代码对齐 ✅（2026-11-24）

- **现象**：`README.md`、`PRODUCT.md`、`AGENTS.md` 仍写"用 React Spectrum 2 实现""各 crate 为占位 stub""约 96 个 command"，路径仍是 `src/features/...`。`AGENTS.md` 要求"用 `@react-spectrum/s2` 现成组件、不写自定义视觉"，与 `CLAUDE.md` 直接矛盾，按它干活的 agent 会做错。
- **改法**：三份文档按 `CLAUDE.md` 和实际代码重写。

### P0-2 文档入库策略 🟡

- **现象**：`.gitignore` 第 43 行忽略整个 `docs/`（2026-06-29 的 `c412160` 起），仅 8 份被强制跟踪。`CLAUDE.md` 要求"涉及共享访问问题先读" `docs/architecture/ddc-credentials.md`，该文件不在仓里；`CLAUDE.md` 还引用了多条本机 auto-memory（`volo-razer-app-deployment`、`volo-native-ui-verification`），换机器后同样不存在。
- **影响**：新 clone 或云端 agent 拿不到被标为"必读"的资料。
- **待决策**：把承重文档强制入库（至少 `ddc-credentials.md`），还是从 `CLAUDE.md` 删掉对未入库文档的硬依赖。
- **顺带**：`CLAUDE.md` 里的 `/Users/bip.lan/AIWorkspace/vp/volo/target` 是另一台机器的绝对路径。
- **决策**（2026-11-24）：先删硬依赖，以后再入库。`ddc-credentials.md` 与两份 memory 只存在于另一台机器，内容到手后再强制入库。
- **已做**（2026-11-24）：`CLAUDE.md` 三处引用改为「本机有则读、没有就向用户索要或以脚本为准」；`CARGO_TARGET_DIR` 的绝对路径换成主仓 `target/` 的写法。
- **剩余**：拿到 `ddc-credentials.md` 后 `git add -f` 入库，并把两份 memory 整理成 `docs/guides/` 下的文档，再恢复 `CLAUDE.md` 的硬引用。

### P0-3 最小 CI 🟡

- **现象**：没有 `.github/`。Rust 约 1833 个测试函数、Python 约 1500 个，全靠手动跑；提交里 `fix` 184 条多于 `feat` 150 条。
- **改法**：一条 workflow 跑 `cargo test`（先 `crates/*`）、`pnpm exec tsc --noEmit`、三个 sidecar 的 `pytest`（vpcal 用 `VPCAL_SKIP_SOLVER` 走 scipy 回退）。
- **已做**（2026-11-24）：新增 `.github/workflows/ci.yml`，三个 job：前端、`crates/*` 的 `cargo test`、三个 sidecar 的 `pytest`。
- **本地基线**（macOS，2026-11-24，提交 `cb720fe`）：

  | 项 | 结果 |
  |---|---|
  | `tsc --noEmit` | 通过 |
  | `vite build` | 通过（主包 1.95 MB，有分包体积警告） |
  | tracksim `pytest` | 484 通过 |
  | mesh-vba `pytest` | 533 通过 |
  | vpcal `pytest`（跳过 Ceres，走 scipy） | 初始 559 通过、1 失败；修复 P0-6 后 560 通过、9 跳过 |
  | `cargo test` | **未跑**：本机没有 Rust 工具链 |

- **剩余**：
  1. Rust job 没有本地基线，首次 CI 运行即基线；若有平台相关的失败再逐个处理。
  2. `src-tauri`（约 73 个测试）未纳入：Linux 上需要系统 WebView 依赖，且 `tauri.conf.json` 引用的 `target/sidecar-vendor` 资源目录在干净环境里不存在，需先核实构建脚本的行为。
  3. CI 用的是 Ubuntu，本地基线是 macOS，sidecar 在 Linux 上的首次结果待确认。
  4. vpcal 的 Ceres 原生求解器路径不在 CI 覆盖内。

### P0-4 标定链路真机验证 ⛔ 等硬件

- **现象**：
  - 视觉建屏的合格记录来自两台显示器（解出 784 mm，卷尺 782 mm），不是真 LED 墙。
  - 追踪主路径的真实数据端到端在 `sidecars/vpcal/docs/remediation-roadmap-v1.md` 里标为硬件阻塞（B2）。
  - 固定机位单次校正的验收表 `sidecars/vpcal/docs/razer-fixed-observation-acceptance.md` 未填。
- **改法**：按 `sidecars/vpcal/docs/sim2real-protocol.md` 采一套黄金数据集，一面真墙加一套真追踪，把三条链路各验一遍并回填阈值。
- **说明**：这是 Calibrate 最大的风险，优先级高于下面所有算法改动。P1-1、P1-2 的收益也要靠它来度量。

### P0-5 Stage 数据模型落到 Rust ⛔ 等设计确认

- **Stage 是什么**：一个摄影棚在软件里的完整档案，即这个棚有哪些屏、哪些摄影机、哪些渲染机、当前校准到什么程度。产品的核心命题"一个 Stage 项目从左流到右"指各个 tab 轮流读写同一份档案，而不是各管各的数据：

  | 阶段 | 往 Stage 里写什么 | 从 Stage 里读什么 |
  |---|---|---|
  | Pre-viz | 屏幕的设计参数 | — |
  | Calibrate | 实测网格、镜头参数、摄影机位姿 | 屏幕设计参数 |
  | Color | 色彩校正结果 | 屏幕、摄影机 |
  | Cache | 各渲染机的就绪状态 | 哪些机器驱动哪块屏 |
  | Live | — | 以上全部 |

  完整的 Stage 至少包含：屏幕、摄影机与镜头、追踪、渲染机及其与屏幕的对应关系、UE 工程、各次校准的结果。统一成一个 App 的价值来自这些共享实体，不来自共享外观。
- **现状**：Stage 以碎片形式存在，没有合成一个东西。目前是两个迁移过来的工具共用一个外壳。
- **后果**：
  - 机器改名或换 IP，拓扑节点与 Cache 机器的对应会悄悄断开。
  - 同一个项目换台电脑打开，舞台类型可能不一样，Calibrate 会走错流程分支。
  - 打开一个 `project.yaml` 不会改变 Cache 页显示的任何内容，Cache 不知道当前是哪个棚。
- **现象**：
  - 外壳里的 Stage 入口已被拆掉：`src/volo/shell.tsx:545` 注释写着"舞台切换器 / 面包屑已移除，stage state 无消费者"；原型留下的假数据 `STAGES` 还在 `src/volo/data.tsx:98`。
  - 事实上的 Stage 是 Calibrate 的 `project.yaml`（`crates/volo-shared/src/dto.rs:15` 的 `ProjectConfig`）。
  - Cache 的数据在 `uecm.sqlite`，全局、不属于任何 Stage；它的 `projects` 表指 UE 工程，与 Calibrate 的"项目"不是一回事。
  - `src/stage/model.ts` 零消费者。
  - nDisplay 拓扑节点靠 hostname 或 IP 字符串匹配 Cache 机器（`src/volo/data.tsx:450` 的 `matchRenderNode`）。
  - 舞台类型（LED / AR）存在 `localStorage`，由调试面板切换（`src/volo/shell.tsx:1111`），不在项目文件里。
- **改法**（纯数据层部分，不涉及视觉）：
  1. `ProjectConfig` 增加 `stage_type`，缺省 `led`，前端从项目文件读取。
  2. 拓扑节点增加稳定的机器 ID 引用，保留 hostname / IP 作回退。
  3. Cache 的机器和 UE 工程可归属到某个 Stage。
  4. 删除 `src/stage/model.ts`，或改为由 Rust 类型生成。
- **UI 部分**：外壳恢复"当前 Stage"选择器属于 UI 改动，须先在 Claude Design 完成。
- **待确认**：Stage 的载体是继续用 `project.yaml`，还是迁入数据库；一台机器能否同时属于多个 Stage。

### P0-6 vpcal 主流水线对多标记布局检测全拒 ✅（2026-11-24）

- **现象**：`tests/integration/test_pipeline.py::test_detector_path_end_to_end` 失败，报 `need >= 3 poses to solve; got 0`。128 个标记全部检出，又全部被拓扑一致性检查拒掉。换三组 OpenCV / numpy 版本结果相同，不是依赖漂移。
- **根因**：提交 `6ccb1b7`（2026-07-23）把检测器改为"每箱标记数必须由屏幕配置传入，未传按 1 处理"，但 `core/pipeline.py` 的 `_detect_observations` 没有传。屏幕定义的默认值是每箱 4 个，于是同一箱体的 4 个标记被放到同一个网格点，局部仿射拟合残差超限，全部降权后被硬拒。
- **影响**：`vpcal quick run` 走真实图像检测、且每箱标记数大于 1 时得不到任何观测。同类调用点 `core/overlay.py`、`core/live_verify.py`、`core/delay_cal.py` 有同样的问题。
- **修复**：四处都把屏幕配置的每箱标记数传给检测器。
- **未处理**：`core/mapping_verify.py` 和 `cli/capture.py` 的检测调用同样没传配置。前者用专用的映射校验屏，后者只做采集门控计数，本次未核实是否受影响。
- **提醒**：现场机器上已打包的 vpcal 若在 2026-07-23 之后构建，带有此缺陷，需重新打包。

---

## P1：方向性改动

### P1-1 合并 Calibrate 的两套求解代码 ⬜

- **现象**：`sidecars/mesh-vba` 与 `sidecars/vpcal` 各自实现了 VP-QSP 编解码与检测（`mesh-vba` 注释写明"ported verbatim from vpcal"）、内参标定、平差（一边 scipy，一边 Ceres 加 scipy）、结构光、仿真器。两者靠文件交接，`sidecars/vpcal/docs/vpqsp-fixed-single-observation-spec.md` §2.2 自述"重建是否被正确导出仍需调查"。两边的依赖也不一致（`opencv-contrib-python` 对 `opencv-python-headless`，numpy 上限不同）。
- **本质**：只有一个问题，即相机、屏幕刚体、镜头之间最小化重投影误差；不同流程只是固定哪些未知数。
- **改法**：归并为一个标定核心包，共享检测、观测结构、残差、求解后端和仿真器；现有两个 CLI 作为它的两个入口保留，契约不变。先合并检测与编解码（重复最明显），再合并求解。
- **依赖**：P0-4 的黄金数据集作回归基准。

### P1-2 "融合"改为平差内约束，并加相邻箱体先验 ⬜

- **现象**：`crates/mesh-core/src/fuse.rs` 只做 Umeyama / Kabsch 整体刚性对齐。视觉平差在大墙上累积的低频弯曲，刚性对齐修不掉。`model_constrained_ba.py` 里每个箱体完全独立，没有拼缝或邻接约束。
- **改法**：
  1. 把全站仪锚点作为带权先验放进平差。
  2. 增加相邻箱体共享边的软约束，权重可配，默认保守。
  3. 现有刚性对齐保留，作为对照和残差报告。
- **验收**：仿真器注入低频弯曲后，新方法的锚点外误差显著低于刚性对齐。

### P1-3 DDC 三代方案收敛 ⛔ 等决策

- **现象**：SMB 共享（开放 / 托管两种模式，加三路凭据注入）、PAK 分发、Zen 同为一等公民，由 `cache_backend::decide` 路由。凭据注入是历史 bug 最集中处，而它只为 SMB 共享存在。Output 已只支持 UE 5.8，Zen 自 5.4 起可用。
- **改法**：Zen 作为唯一主路径；PAK 留给离线场景；SMB 共享冻结为兼容项，不再加功能，界面降级为"旧版"入口（界面部分须经 Claude Design）。
- **待决策**：是否仍有 UE 低于 5.4 的现场需要支持。

### P1-4 Zen 规则写入位置 ⬜ 待核实

- **现象**：`crates/cache-core/resources/zen-ini-rules.yaml` 的规则写工程的 `DefaultEngine.ini`。该文件通常在版本管理里，逐节点修改会与仓库漂移或被同步覆盖。
- **先核实**：现场工程是否走版本管理、节点上的工程目录如何同步。
- **改法**（若属实）：改写机器级覆盖（用户级 INI、环境变量或启动参数）。

### P1-5 从 Rust 生成 TS 类型 ⬜

- **现象**：改动最频繁的文件是 `src-tauri/src/lib.rs`（67 次）、`src/volo/api/types.ts`（54 次，1900 行）、`src/volo/api/commands.ts`（43 次），全靠手工同步；`commands.ts` 头部写的"95 个命令"已与实际 213 个不符。
- **改法**：workspace 已有 `schemars`，由 DTO 生成 `types.ts`；命令绑定可后续再生成。

### P1-6 sidecar 桥协议收敛 ⬜

- **现象**：三套并存，分别是 `mesh-adapter-visual-ba` 的专用通道、`commands/sidecars.rs` 的一次性 argv、`commands/sidecar_stream.rs` 的通用流式桥。
- **改法**：统一到通用流式桥，一次性调用视为只有一个终止事件的流。

### P1-7 旧标识改名与数据库合并 ⬜

- **现象**：运行时仍用 `com.lanbipu.uecm/uecm.sqlite`、`lmt.sqlite`、节点上的 `C:\ProgramData\UECM`、环境变量 `UECM_ZEN_RULES_PATH`。
- **改法**：随 P0-5 一并迁移，带一次性数据迁移与旧路径回退。越晚成本越高。

### P1-8 留出验证结果未在界面展示 ⛔ UI

- **现象**：`docs/guides/visual-rebuild-capture-guide.md` 自述留出验证结果只被导出门读取，重建结果页不显示，需手动看 `validation.json`。
- **改法**：属 UI 改动，整理成 Claude Design 的输入。

---

## P2：重要但不急

### P2-1 前端代码结构重整 ⛔ 等拍板

- **现象**：70 个文件里 40 个带 `@ts-nocheck`（全部页面和外壳）；模块靠 `window.*` 全局与 import 顺序耦合；37 份 CSS 里 9 层皮肤覆盖、508 个 `!important`，`src/volo/index.tsx` 自述"换序即失效"。
- **根因**：把"1:1"理解为源码照搬原型，而原型本身用全局变量拼装。
- **改法**：把"1:1"定义为渲染结果一致。保留 `src/volo/api/`；页面逐个迁移为正常的模块、类型与状态管理；CSS 合并为一层 token 加按页样式。先止血：新代码不加 `@ts-nocheck`，新 handoff 不再叠皮肤层。
- **约束**：触及 UI 代码，按仓库约定须先确认是否经 Claude Design。

### P2-2 镜头对焦变焦查找表 ⬜

- **现象**：解出的镜头只在当前对焦和变焦下有效；`sidecars/vpcal/src/vpcal/models/lens.py` 的 FIZ 表标为 reserved。
- **影响**：定焦定点够用，跟焦或变焦拍摄不够。属能力上限。

### P2-3 把 PowerShell 里的业务判断收回 `voloctl` ⬜

- **现象**：`src-tauri/resources/ps-scripts` 有 77 个脚本约 9100 行，无类型。
- **改法**：把 `voloctl` 编为 Windows 可执行文件推到节点，逐步替换含逻辑的脚本，只留必须调 Windows 接口的薄脚本。
- **先核实**：逐脚本盘点各自含多少逻辑，本次审查未做。

### P2-4 清理死依赖与残留 ⬜

- `package.json` 的 `@react-spectrum/s2`、`unplugin-parcel-macros` 及 `vite.config.ts` 里对应的宏插件与分包规则，`src` 已不引用。移除前须跑一次完整构建确认。
- `src/volo/data.tsx:98` 的假数据 `STAGES`。
- `src-tauri/src/lib.rs` 脚手架残留的 `greet` 命令。
- `crates/cache-core/src/core/psexec.rs`：已迁到 SSH，确认是否仍被引用。

### P2-5 安全与分层审计 ⬜

- `src-tauri/tauri.conf.json` 的 `csp: null`，配上能远程执行 SSH 与 PowerShell 的后端，风险面偏大。
- `src-tauri/src/commands/zen.rs` 共 3449 行、33 个命令，核对是否仍符合"只做传输翻译"。`pso.rs`（1293 行）、`vpcal_runs.rs`（1114 行）、`output.rs`（1060 行）同查。

### P2-6 产品范围 ⛔ 等决策

- **现象**：6 个 tab 里 Pre-viz、Color、Live 是空骨架；Tools 只有 Keyer Lab，tracksim 后端已进仓但未接界面；Color 自研相当于另一个产品。
- **建议**：先把"建屏 → 校准 → 上屏 → 集群就绪"做成闭环，其余明确搁置。

### P2-7 上屏链路的同步 ⬜

- **现象**：显示与采集之间靠等待而非同步信号，结构光序列偏慢；nDisplay 上屏只支持 UE 5.8。
- **改法**：暂不动。真机验证（P0-4）后若序列耗时成为瓶颈再处理。

---

## 审查中更正过的结论

- "Stage 模型不存在"不准确：它以 `project.yaml` 的形式存在于 Calibrate 一侧，缺的是跨板块的那一层。
- "8 份文档在仓里不存在"的原因是 `docs/` 被整体忽略，而非文件丢失，见 P0-2。
