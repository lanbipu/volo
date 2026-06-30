# CLAUDE.md

Volo —— LanX 出品的虚拟制作桌面工具（**Tauri 2 + React**，UI 按 Claude Design 原型 1:1 自定义 CSS 移植）。本仓是单一 monorepo，设计文档与代码同仓。

## 先读这些（设计真相源）

动任何 UI / 组件前，先读 `docs/design/`：
- `WIREFRAMES.md` —— Cache / Calibrate 两页的逐组件功能规格（字段 / 按钮 / 交互）。改这两页对照它。
- `BRAND-BRIEF.md` —— 设计基线：用 React Spectrum 2、暗 / 亮双主题、状态三通道、中文 fallback 思源黑体。
- `UX-PLAN.md` —— 整体 IA（6-tab：Pre-viz / Calibrate / Color / Cache / Live / Tools、外壳四区、Stage 模型）。
- `CACHE-CAPABILITIES.md` —— Cache 页后端能力边界（能给/给不了的数据与动作）；会漂移，落地前对着 `src-tauri/src/commands/*.rs` + `crates/cache-core` 实测核对。

> Cache / Calibrate 的视觉真相源是**最新 Claude Design handoff 原型**；`WIREFRAMES.md` 自声明是临时稿、会被最终设计稿取代，仅作字段/意图参照。

数据模型见 `docs/architecture/`（Step 3 = `stage-data-model.md`，待写）。

## 设计系统：Claude Design 1:1 自定义实现

- **UI 流程**：先在 Claude Design（claude.ai/design，底层基于 RS 的 design system）设计 / 迭代 → handoff（HTML/JSX 原型 + 它自带的 design token CSS），本仓照确认后的设计稿用**全自定义 CSS 1:1 移植**实现，不接 `@react-spectrum/s2` 组件库。
- **全部模块都走这条路**，不只 Cache 页——Cache 页是这套做法最早落地的范例，不是例外。RS2 只作**视觉参考**（间距/字阶/状态色这类设计直觉可以借鉴），代码里不实际引入其组件；需要参考时查 repo 自带 **S2 MCP server**：`../../person/design/react-spectrum/packages/dev/mcp/s2`。
- 暗 / 亮双主题走 Claude Design 原型自带的 `data-theme` attribute + CSS 变量机制（不是 RS2 的 `colorScheme` Provider）；中文 fallback 思源黑体；状态三通道（色 + 图标 + 文字）。

## 来源工具（在 `../`，将迁入 / 整合）

- `../ue-cache-manager` → **Cache** 页（现 Vue3，**前端重写成 React**）
- `../led-mesh-toolkit` → **Calibrate** 页网格段（Vue3 + Konva + Three.js + Rust workspace + Python sidecar；前端重写 React，用 `react-konva` / `@react-three/fiber`）
- `../calibration/vpcal`（Calibrate 镜头段，纯 CLI）/ `../calibration/tracksim`（Tools，纯 CLI）—— 都移植整合

> **Color** 页不移植任何来源：`../color/OpenVPCal`（Netflix 开源，PySide6/Qt）仅作**方法 / 流程参考**，功能后续自研。

## 约定

- 业务逻辑放服务层 / Rust crates，`src-tauri` 只做 transport 翻译；新功能从设计阶段就考虑 CLI 暴露（沿用 LMT 的 CLI 底座契约，见 `../led-mesh-toolkit/CLAUDE.md`）。
- **换栈只换前端（Vue → React）；Rust 后端 / Tauri commands / Python sidecar 保留。**
- 视觉走 Claude Design 原型 1:1 自定义 CSS（颜色/间距取设计稿给的 token 值，不是自己拍脑袋编），不接 RS2 组件库。
- 暗 / 亮双主题；状态永远「色 + 图标 + 文字」；CJK 排版（中文 sans fallback 思源黑体，mono 仅标识符，行高放宽）。

## 代码状态

已脚手架（`create-tauri-app` React）。前端 `src/`（shell + features/{cache,…}）、Rust `crates/`（cache-core 等）+ `src-tauri`（~96 个 Tauri command，见 `lib.rs` invoke_handler）均已落地。

## 开发 / 构建（实测）

- 前端验证：`pnpm exec tsc --noEmit` + `pnpm exec vite build`；后端快验：`cargo check --manifest-path src-tauri/Cargo.toml`。
- 跑原生 App：`pnpm tauri dev`（devUrl :1420）。在 `.claude/worktrees/*` 里 target/ 是空的会从头编 → 用 `CARGO_TARGET_DIR=/Users/bip.lan/AIWorkspace/vp/volo/target` 复用主仓热缓存，增量编译数秒。
- `tauri dev` 后台 detached 启动时**不会**自动重编 Rust 改动 → 改了 `src-tauri` 要手动重启，跑 `./scripts/restart-dev.sh`（kill 旧进程 + 重新后台启动，日志写到仓库根目录 `volo-dev.log`，已 gitignore）。

## Tauri v2 接线 / 窗口（最易踩）

- invoke 参数 key：Rust snake_case 函数参数 → JS **camelCase**（`machine_id`→`machineId`）；struct 入参（request/input/cred/plan）整体一个 key、内部字段保持 snake_case。
- 返回 DTO 字段 = **snake_case**（crates 全 `#[derive(Serialize)]` 无 rename_all）；例外看各自 `#[serde(rename)]`（如 `ProjectDir.Path` 是 PascalCase）/ enum `rename_all`。前端封装见 `src/volo/api/commands.ts`。
- 无边框窗口拖动用 `data-tauri-drag-region` 属性（不是 `-webkit-app-region`），需在 `src-tauri/capabilities/default.json` 开 `core:window:allow-start-dragging`（+ close/minimize/toggle-maximize）。
- 禁界面文字选中用 `-webkit-user-select`（macOS WKWebView 不认裸 `user-select`）。
