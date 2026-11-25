# AGENTS.md

Volo —— LanX 出品的虚拟制作桌面工具（**Tauri 2 + React**，界面按 Claude Design 原型 1:1 自定义 CSS 移植）。本仓是单一 monorepo，设计文档与代码同仓。

> 本文件与 `CLAUDE.md` 同步。两者冲突时以 `CLAUDE.md` 为准，并顺手把本文件改齐。

## 设计系统：Claude Design 1:1 自定义实现

- **UI 流程**：先在 Claude Design（claude.ai/design）设计 / 迭代 → handoff（HTML/JSX 原型 + 它自带的 design token CSS），本仓照确认后的设计稿用**全自定义 CSS 1:1 移植**实现，不接 `@react-spectrum/s2` 组件库。
- **全部模块都走这条路**。React Spectrum 2 只作**视觉参考**（间距 / 字阶 / 状态色这类设计直觉可以借鉴），代码里不引入其组件。
- 暗 / 亮双主题走原型自带的 `data-theme` 属性 + CSS 变量机制；中文回退思源黑体；状态三通道（色 + 图标 + 文字）。
- 颜色 / 间距一律取设计稿 token 值，不自造；CJK 排版 mono 仅用于标识符、行高放宽。

## 约定

- **所有 UI 更改必须在 Claude Design 里完成**（设计 / 迭代 → handoff），本仓只做确认后的 1:1 移植。禁止在任何 AI 编码平台里直接改 UI 视觉或布局。
- 执行任务时一旦发现当前操作会触及 UI 更改，**立刻停下来提醒用户**，并询问：
  1. 当前操作已涉及 UI 更改，是否要移到 Claude Design 里执行？
  2. 是否需要把本次要改的部分提取出来，整理成可交给 Claude Design 的 Prompt？

  用户确认前不要动手改 UI；可继续推进非 UI 部分（业务逻辑 / Rust / 接线等）。
- 业务逻辑放服务层 / Rust crates，`src-tauri` 只做 transport 翻译；新功能从设计阶段就考虑 CLI（`voloctl`）暴露。

## 来源工具移植状态

- Cache 页（原 `ue-cache-manager`）与 Calibrate 网格段（原 `led-mesh-toolkit`）**已迁移完成**，代码以本仓为准。
- **vpcal 认准本仓 `sidecars/vpcal`**（App 实际启动的活副本）；仓外的上游副本滞后，勿以它判断功能。
- tracksim：`sidecars/tracksim` + 后端启动桥已进仓，**Tools 页界面尚未接**。
- **Color** 页不移植任何来源，功能后续自研。

## 代码结构

- 前端 `src/`：`app/` 外壳 + 页面表、`ui/` design system 组件、`features/<域>/{model,ui}` 页面与状态、`lib/` 通用工具、`windows/` 独立窗口、`api/` 类型化命令封装（方案见 `docs/architecture/frontend-structure.md`）。
- Rust `crates/`（cache-core、mesh-*、volo-shared、volo-cli）+ `src-tauri`（约 210 个 Tauri command，见 `src-tauri/src/lib.rs` 的 invoke_handler）。
- Python / C++ sidecar 在 `sidecars/`（mesh-vba、vpcal、tracksim）。
- 规则由 `pnpm lint` 强制：不写 `@ts-nocheck` / `window.*` 全局；`invoke` / `listen` 只在 `api/`（及 `lib/events.ts`）；跨 feature 只 import 对方 `index`；页面样式只用 `*.module.css`，禁 `!important` 与字面色值。
- 整改待办与优先级：`docs/architecture/remediation-backlog.md`。

## 开发 / 构建（实测）

- 前端验证：`pnpm exec tsc --noEmit` + `pnpm exec vite build`；后端快验：`cargo check --manifest-path src-tauri/Cargo.toml`。无 ESLint / Prettier / husky，`tsc --noEmit` 即前端 lint。
- 跑原生 App：`pnpm tauri dev`（devUrl :1420）。在 git worktree 里 `target/` 是空的会从头编，可把 `CARGO_TARGET_DIR` 指到主仓的 `target/` 复用热缓存。
- `tauri dev` 后台 detached 启动时**不会**自动重编 Rust 改动，改了 `src-tauri` 要手动重启：`./scripts/restart-dev.sh`（日志写到仓库根目录 `volo-dev.log`，已忽略）。
- UI 改动必须在**原生 App** 里实测：浏览器被 `isTauri()` 拦在门外。

## Tauri v2 接线 / 窗口（最易踩）

- invoke 参数 key：Rust snake_case 函数参数 → JS **camelCase**（`machine_id` → `machineId`）；struct 入参（request / input / cred / plan）整体一个 key、内部字段保持 snake_case。
- 返回 DTO 字段 = **snake_case**（crates 全 `#[derive(Serialize)]` 无 rename_all）；例外看各自 `#[serde(rename)]`（如 `ProjectDir.Path` 是 PascalCase）/ enum `rename_all`。前端封装见 `src/api/commands.ts`。
- 无边框窗口拖动用 `data-tauri-drag-region` 属性（不是 `-webkit-app-region`），需在 `src-tauri/capabilities/default.json` 开 `core:window:allow-start-dragging`（+ close / minimize / toggle-maximize）。
- 禁界面文字选中用 `-webkit-user-select`（macOS WKWebView 不认裸 `user-select`）。

## 机器拓扑 / DDC 凭据

- 两台测试机是 workgroup，本地账户互不信任，整套 DDC 凭据注入机制因此存在。细节见 `CLAUDE.md` 同名一节。

## Cursor Cloud specific instructions

云端环境是 **headless Linux (Ubuntu 24.04)**，非 mac。跑 App / 验证要点（依赖已由启动脚本 + 快照装好，勿在此列安装步骤）：

- **跑原生 App（headless）**：必须先设 `DISPLAY=:1`，并禁掉 webkit GPU 合成，否则 WebView 白屏 / 崩：
  ```bash
  DISPLAY=:1 WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 pnpm tauri dev
  ```
  `pnpm tauri dev` 会自动起 vite(:1420) 再编译并运行 Rust host（首次冷编约 1 分钟，增量数秒）。窗口标题 `Volo`，可在 `:1` 上截图 / 交互。
- **Rust 版本**：某传递依赖（`zvariant` 需 edition2024）要求 **Rust ≥ 1.85**。
- **本地可跑的核心流**：Cache 页「新增部署机」用扫描向导即可在无真机时把机器写入本地 sqlite（`~/.local/share/com.lanbipu.uecm/uecm.sqlite`），可作冒烟。真实渲染集群 / DDC / SSH 目标在云端不可达，属可选。
- **Python sidecars（mesh-vba / vpcal / tracksim）默认未装**，由 Rust 按需启动；未建各自 `.venv` 前，sidecar 相关动作会报 "sidecar not found"，不影响 App 启动与上述冒烟。
