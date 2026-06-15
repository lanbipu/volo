# Volo 仓库结构与移植蓝图

> 本文是把 4 个 VP 现场工具(`ue-cache-manager` / `led-mesh-toolkit` / `vpcal` / `tracksim`)统一移植进 Tauri app **Volo** 的落地蓝图。
> 形态:**一个 Cargo workspace**(`crates/*` + `src-tauri`)+ **多个进程隔离的 Python sidecar**(`sidecars/*`)+ **一个 React 前端**(`src/`,按 `features/<tab>` 切),设计系统用 Adobe React Spectrum 2。
> 纪律:**换栈只换前端(Vue→React);Rust 后端 / Tauri commands / Python sidecar 保留并平移整合,CLI 契约不动。** 前端 UI 须在 Claude Design 出设计稿后才实现。

---

## 0. 已拍板决策(2026-06-15)

1. **git 策略**:volo 全新 `git init`,不背源仓历史(4 个源仓在原地可查)。
2. **SQLite 库**:各 feature 保留独立 sqlite + 原 identifier,不合库——不丢现有节点纳管 / 凭据 / baseline 历史。`volo-shared` 只提供 connection / schema / migrate 基座,不强制并库。
3. **crate 命名 / CLI**:采纳本文命名方案(`mesh-*` / `cache-*` / `volo-shared` / `volo-cli`);两 CLI 合并为单个 `volo-cli` 二进制,`uecm` / `lmt` 子命令组命名空间隔离,各自保住原契约与 E2E。
4. **明文凭据**:UECM bootstrap 的明文运维凭据维持现状随迁(home lab 内网)。
5. **Tauri identifier(决策 2 的推论)**:`cache-core` 的 `resolve_db_path` 与 `ps-scripts` 路径解析**继续用 `com.lanbipu.uecm`**,不跟随 volo app 的顶层 identifier;volo app 另取顶层 identifier(如 `com.lanbipu.volo`),但不接管 UECM 的 DB / 脚本路径镜像,否则现有节点历史库断裂。

> 其余 openQuestions 延到对应 cutover 步再定:command 防撞名(建议统一加 `cache_` 前缀)、UECM 6 个孤立视图去留、WinRM 冻结桩去留、sidecar Python 基线(vpcal pybind11 锁 cp311)。

---

## 1. 顶层目录树

```
vp/volo/
├── Cargo.toml                 workspace 根(members = crates/* + src-tauri)
├── README.md / PRODUCT.md / CLAUDE.md
├── docs/
│   ├── design/                UX / 设计真相源(WIREFRAMES / BRAND-BRIEF / UX-PLAN)
│   └── architecture/
│       ├── repo-structure.md  ← 本文
│       └── stage-data-model.md  Stage 数据模型(Step 3,待写)
├── src/                       React 前端(Tauri webview)
│   ├── shell/                 应用外壳四区(底部 tab / 工具条 / 左子栏 / 右 Inspector / Stage 切换器 / 日志面板)
│   ├── stage/                 统一 Stage 项目模型(前端侧 store,跨 feature 流转)
│   └── features/
│       ├── cache/             ← ue-cache-manager 前端(React 重写)
│       ├── calibrate/         ← led-mesh-toolkit 网格段 + vpcal 镜头段(React 重写)
│       ├── color/             自研(仅参考 OpenVPCal,不移植)
│       ├── previz/            新建(占位)
│       ├── live/              新建(占位)
│       └── tools/             ← tracksim + 网格生成器
├── src-tauri/                 统一 Tauri host(thin transport:聚合各 feature 的 #[tauri::command])
├── crates/                    Rust 业务核心
│   ├── volo-shared/           全局共享:DTO / envelope / exit_codes / manifest / SQLite 基座 / Stage 实体(零 tauri)
│   ├── mesh-core/             LED 屏几何重建算法(IR,零 IO)         ← lmt-core
│   ├── mesh-app/              网格段 service 层(run_*,含内嵌 3D 资产) ← lmt-app
│   ├── mesh-adapter-total-station/  M1 全站仪 CSV adapter          ← adapter-total-station
│   ├── mesh-adapter-visual-ba/      M2 视觉 BA sidecar bridge       ← adapter-visual-ba
│   ├── cache-core/            UECM 业务逻辑(core/data/startup,剥离 tauri)  ← uecm
│   └── volo-cli/             统一 CLI bin(合并 uecm-cli + lmt)
└── sidecars/                  进程隔离 Python sidecar(各自独立 venv)
    ├── mesh-vba/              视觉 BA / 标定 / 结构光(OpenCV+scipy)  ← lmt-vba-sidecar
    ├── vpcal/                 几何/空间校正(含 pybind11 C++ Ceres)   ← vpcal 整包
    └── tracksim/              追踪信号模拟(FreeD/OpenTrackIO)        ← tracksim 整包
```

---

## 2. 移植映射表

### 2.1 Rust crate(统一 workspace)

| Volo crate | 来源 | 类型 | 职责 |
|---|---|---|---|
| `volo-shared` | `led-mesh-toolkit/crates/lmt-shared` | 平移升格 | DTO / 统一 error·envelope·exit_codes / manifest / SQLite 基座 / Stage 实体。**零 tauri 依赖**(CLI·sidecar 化前提)。全局共享,因 Stage 模型跨页。 |
| `mesh-core` | `led-mesh-toolkit/crates/core` | 平移改名 | 纯几何 IR(point/shape/surface/uv/reconstruct/export)。泛名 `core` → `mesh-core` 去重。IR-FROZEN.md 约束。 |
| `mesh-app` | `led-mesh-toolkit/crates/lmt-app` | 平移 | `run_*` service 层(GUI·CLI 共用)。内嵌 `three-bundle.min.js`(684KB)+ `capture_card_3d.html`;`render: impl FnOnce` 闭包注入模式保留。 |
| `mesh-adapter-total-station` | `adapter-total-station` | 平移 | M1 Trimble CSV adapter(纯 Rust 生成 HTML)。 |
| `mesh-adapter-visual-ba` | `adapter-visual-ba` | 平移 | M2 sidecar bridge(tokio 子进程 + NDJSON)。`locate.rs` 路径约定须对齐 volo 打包。 |
| `cache-core` | `ue-cache-manager/src-tauri/src/{core,data,startup.rs,error.rs}` | 抽 crate | UECM 业务逻辑(43 core 模块含远程执行层 + zen 18 模块,24 data 模块 + migrate)。**从单 crate `uecm` 剥出,剥离 `tauri::Builder`**。 |
| `volo-cli` | `ue-cache-manager/src/cli` + `led-mesh-toolkit/crates/lmt-cli` | 合并 | 统一 CLI。两套契约(UECM JSON 信封/exit 64/AI_AGENT;LMT cli_e2e/agents-cli)保留,子命令组命名空间隔离。 |
| `src-tauri`(app bin) | `ue-cache-manager/src-tauri/{commands,lib.rs}` + `led-mesh-toolkit/src-tauri` | 拆解并入 | 统一 Tauri host。聚合所有 `#[tauri::command]` thin shim + 统一 invoke_handler / app.manage / setup。含 cfg-gated `pdf_render`。 |

### 2.2 Python sidecar(进程隔离,各自 venv)

| Volo sidecar | 来源 | 类型 | 职责 |
|---|---|---|---|
| `sidecars/mesh-vba` | `led-mesh-toolkit/python-sidecar` | 平移 | 视觉 BA/标定/结构光。11 子命令,stdin-JSON/stdout-NDJSON。依赖 numpy<2/scipy/opencv-contrib/pydantic。**包名+子命令名与 Rust adapter 双向硬编码,改名三处同步**。 |
| `sidecars/vpcal` | `calibration/vpcal`(整包 + C++ 扩展) | cli→sidecar | 几何/空间校正。click CLI + 14 operation_id。内嵌 pybind11 Ceres solver(scikit-build-core,FetchContent Eigen/ceres)+ scipy fallback。**pybind11 ABI 锁 cp311,跨平台重编**。 |
| `sidecars/tracksim` | `calibration/tracksim`(整包) | cli→sidecar | 追踪信号模拟。六边形架构,14 operation_id。SDL3 native 须捆绑;Blender 外部 headless 子进程。 |

> **去重命名规则**:LMT 的泛名 `core` → `mesh-core`;`lmt-shared` 升为全局 `volo-shared`(因 Stage 模型跨页);UECM 单 crate 业务逻辑抽出为 `cache-core`;两个 CLI 合并为一个 `volo-cli`。Tauri command 一律加 feature 前缀防撞名(UECM 命名极通用:`list_machines`/`run_health_check`)。

---

## 3. 逐工具 cutover 规则

上线顺序:**脚手架 → 共享层 → Cache → Calibrate 网格 → vpcal/tracksim → 其余占位**。每步带可验证 verify,且前端实现一律受"设计稿门禁"约束。

| 步 | 工具 | 上线动作 | verify |
|---|---|---|---|
| 0 | — | 脚手架(见 §5) | 空壳 `cargo build --workspace` + `tauri dev` 起得来 |
| 1 | 共享层 | `volo-shared`(升格)+ `mesh-core`(改名) | `volo-cli --json schema/manifest` 非空;`volo-shared` 无 tauri 依赖(cargo tree 验) |
| 2 | **Cache**(UECM) | 抽 `cache-core`(剥 tauri::Builder)、CLI 并入、command 加前缀、ps-scripts/vendor 接 bundle | `voloctl uecm system schema` 自洽(operation_ids 唯一、每 op 三 schema 非空);CLI 契约语义(JSON 信封 `schema_version` / exit code 表 / AI_AGENT)保留。**注**:`cli_command` / `binary` 已由旧 `uecm-cli ...` 改为 voloctl 命名空间 `voloctl uecm ...`(review #9 消除契约-现实漂移),故不再要求与源仓旧 `contract-manifest.json` 逐字 diff=0;校验改为 manifest 自洽 + 命名空间正确。同 DB CLI add → GUI 读到同行;lanPC 端到端 |
| 3 | **Calibrate 网格**(LMT) | `mesh-app`/两 adapter 平移、`mesh-vba` 进 sidecars 接 vendoring、13 command 并入、pdf_render 随迁 | `cargo test --workspace`(含 cli_e2e)绿;`mesh-vba` pytest 全过;M1 seed→reconstruct 端到端;capture-card 自包含 |
| 4 | **vpcal + tracksim** | 整包搬 sidecars(各 venv)、vpcal C++ 扩展随编、src-tauri 加 spawn sidecar command + ndjson event | sidecar pytest 全绿;`manifest` 与快照 diff 为空;tracksim freed 往返;Tauri spawn 信封与 CLI 字节对等 |
| 5 | Color/Pre-viz/Live | 仅建 feature 目录 + 路由占位 + 空 RS2 页,不接后端 | 6 tab 可点击进入占位页;Color 不暴露任何 OpenVPCal/未实现功能 |

**设计稿门禁(贯穿步 2–5)**:任何 feature 的 React UI 实现,必须等 Claude Design 出该页设计稿(功能输入用 `docs/design/WIREFRAMES.md`)。脚手架阶段前端只搭壳 + 路由占位,不写具体页 UI。后端(Rust crate / Python sidecar)平移可独立先行,不受此门禁约束。

**契约不可破**:① UECM 远程执行契约(ssh argv / STAGING_ROOT `C:\\ProgramData\\UECM\\ps-scripts` / 节点脚本 stdin-JSON / `{ok}` 信封 / SHA256 漂移检测)动了已纳管节点会失联;② 各 CLI 的 JSON 信封 `schema_version=1.0` + `contract-manifest.json` + exit code 表是对外契约,移植后 manifest 须能重生成且 diff 为空;③ sidecar 二进制名 + 子命令名 + IPC schema 在 Rust/Python 两侧硬编码,改名须多处同步。

---

## 4. OpenVPCal —— 仅参考,不移植

**Color 页(`src/features/color/`)自研,不移植任何来源。** `vp/color/OpenVPCal`(Netflix 开源,PySide6/Qt)仅作 **ICVFX 色彩校准方法 / 流程参考**(图案 → 拍摄 → 分析 → 矩阵 / LUT / OCIO):

- **不进 monorepo**:OpenVPCal 源码不复制进 `vp/volo`。
- **不进 `sidecars/`**:不做成 Volo 的 Python sidecar(它是 Qt GUI 应用,非 CLI/sidecar 形态)。
- **只借方法**:Color 功能后续自研,参考其校准流程与算法思路,不复用其代码或 UI。
- Color 页在 cutover 步 5 仅建占位布局,设计稿就绪后再逐步自研填实。

---

## 5. 脚手架步骤(从零起 volo 代码)

1. 根目录 `create-tauri-app` 选 React + TS(对齐源仓 pnpm),生成 `src/` + `src-tauri/` 骨架,替换 `.gitkeep`。
2. 建 `Cargo.toml` workspace 根:members = `crates/*` + `src-tauri`,统一 `workspace.dependencies`(合并 LMT/UECM 版本表),`resolver=2`,统一 release profile。
3. 建 `crates/` 占位子 crate(最小 Cargo.toml + lib.rs stub):`volo-shared` / `mesh-core` / `mesh-app` / `mesh-adapter-total-station` / `mesh-adapter-visual-ba` / `cache-core` / `volo-cli`。
4. 建 `sidecars/` 占位(`mesh-vba` / `vpcal` / `tracksim`),各 pyproject + src-layout + **独立 venv**(不共享,避免 numpy<2 等约束互撞)。
5. 建前端 `src/{shell,stage,features/{cache,calibrate,color,previz,live,tools}}/`,接 `@react-spectrum/s2`(查 S2 MCP),只搭壳 + 路由占位。
6. 接 bundle 资源管线:`tauri.conf.json` 配 resources(UECM `ps-scripts`/`vendor`)+ sidecar vendoring(`sidecar-vendor/<platform>/`),校准 `locate.rs` 与各 sidecar 二进制定位路径。
7. 定 git 策略后 `git init`,落本文 + 写 `stage-data-model.md`。

---

## 6. 共享层职责边界

- **`volo-shared`(crate,后端真相源,零 tauri)**:DTO(serde+schemars)/ 统一 error·envelope·exit_codes / Contract Manifest / SQLite connection·schema·migrate 基座 / Stage 实体。
- **`src/stage/`(前端状态编排)**:Stage 模型 TS 镜像 + 跨 feature 统一 store(当前 Stage 上下文、Machine Library、阶段完成度徽标、Stage 切换器)。消费 volo-shared 经 command 暴露的 DTO,不重复定义 schema。
- 两者经 `src-tauri` 的 thin command 层连接;业务逻辑不落在 `src-tauri` 也不落在 `src/stage/`。

