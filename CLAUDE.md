# CLAUDE.md

Volo —— LanX 出品的虚拟制作桌面工具（**Tauri 2 + React**，UI 按 Claude Design 原型 1:1 自定义 CSS 移植）。本仓是单一 monorepo，设计文档与代码同仓。



## 设计系统：Claude Design 1:1 自定义实现

- **UI 流程**：先在 Claude Design（claude.ai/design，底层基于 RS 的 design system）设计 / 迭代 → handoff（HTML/JSX 原型 + 它自带的 design token CSS），本仓照确认后的设计稿用**全自定义 CSS 1:1 移植**实现，不接 `@react-spectrum/s2` 组件库。
- **全部模块都走这条路**，不只 Cache 页——Cache 页是这套做法最早落地的范例，不是例外。RS2 只作**视觉参考**（间距/字阶/状态色这类设计直觉可以借鉴），代码里不实际引入其组件；需要参考时查 repo 自带 **S2 MCP server**：`../../person/design/react-spectrum/packages/dev/mcp/s2`。
- 暗 / 亮双主题走 Claude Design 原型自带的 `data-theme` attribute + CSS 变量机制（不是 RS2 的 `colorScheme` Provider）；中文 fallback 思源黑体；状态三通道（色 + 图标 + 文字）。



## 来源工具移植状态

- Cache 页（原 `../ue-cache-manager`）与 Calibrate 网格段（原 `../led-mesh-toolkit`）**已迁移完成**，代码以本仓为准。
- **vpcal 认准本仓 `sidecars/vpcal`**（App 实际 spawn 的活副本，命令面更全）；`../calibration/vpcal` 是滞后的上游源，勿以它判断功能。
- tracksim：`sidecars/tracksim` + 后端 spawn 桥已进仓，**Tools 页 UI 尚未接**。
- **Color** 页不移植任何来源：`../color/OpenVPCal`（Netflix 开源）仅作方法 / 流程参考，功能后续自研。



## 约定

- 在 Claude Code 或其他 AI 平台执行任务时，一旦发现当前操作会触及 UI 更改，**立刻停下来提醒用户**，并询问：
  1. 当前操作已涉及 UI 更改，是否要移到 Claude Design 里执行？
  2. 是否需要把本次要改的部分提取出来，整理成可交给 Claude Design 的 Prompt？
  用户确认前，不要动手改 UI；可继续推进非 UI 部分（业务逻辑 / Rust / 接线等）。
- 业务逻辑放服务层 / Rust crates，`src-tauri` 只做 transport 翻译；新功能从设计阶段就考虑 CLI 暴露（沿用 LMT 的 CLI 底座契约，见 `../led-mesh-toolkit/CLAUDE.md`）。
- 视觉/主题规范见上「设计系统」节；补充：颜色/间距一律取设计稿 token 值（不自造）；CJK 排版 mono 仅用于标识符、行高放宽。
- **所有 UI 更改必须在 Claude Design 里完成**（设计 / 迭代 → handoff），本仓只做确认后的 1:1 移植，禁止在 Claude Code / Cursor / 其他 AI 平台里直接改 UI 视觉或布局。




## 机器拓扑 / DDC 凭据

- **lanPC**（192.168.10.20，DDC 共享服务器，Mode B）/ **RazerPC**（192.168.10.173，客户端，交互用户 lanbp）/ NAS 与 DDC 无关。两机是 workgroup，本地账户互不信任——整套凭据注入机制因此存在。
- DDC 凭据机制（三路注入、Mode A/B 同服务器互斥、svc 账户生命周期）与历史 bug 结论：`docs/architecture/ddc-credentials.md`。涉及共享访问问题先读它；真机取证一键跑 `scripts/diag-ddc-creds.sh`。
- Bootstrap（USB 包）只建立 SSH 管理能力，不含凭据注入。



## 代码结构

前端 `src/volo/`（shell + pages/ 按页面平铺）、Rust `crates/`（cache-core、mesh-* 等）+ `src-tauri`（约 210 个 Tauri command，见 `lib.rs` invoke_handler）、Python/C++ sidecar 在 `sidecars/`。

## 开发 / 构建（实测）

- 前端验证：`pnpm exec tsc --noEmit` + `pnpm exec vite build`；后端快验：`cargo check --manifest-path src-tauri/Cargo.toml`。
- 跑原生 App：`pnpm tauri dev`（devUrl :1420）。在 `.claude/worktrees/*` 里 target/ 是空的会从头编 → 用 `CARGO_TARGET_DIR=/Users/bip.lan/AIWorkspace/vp/volo/target` 复用主仓热缓存，增量编译数秒。
- `tauri dev` 后台 detached 启动时**不会**自动重编 Rust 改动 → 改了 `src-tauri` 要手动重启，跑 `./scripts/restart-dev.sh`（kill 旧进程 + 重新后台启动，日志写到仓库根目录 `volo-dev.log`，已 gitignore）。



## Razer 部署测试

- 一键同步并拉起：Mac 上 `./scripts/sync-razer-dev.sh`（bundle → scp → Razer `git reset --hard` → `schtasks /run /tn VoloDev`）。只同步不重启加 `--no-restart`；同步非 main 传 ref（如 `HEAD`）。前端/vpcal Python 改动即时生效；Rust 改动需重启（脚本默认会重启）；vpcal C++ 用 `C:\vpdeploy\build.cmd` 重编。细节见 auto-memory `volo-razer-app-deployment`。



## 运行时 UI 验证

- UI 改动必须在**原生 app** 里实测（浏览器/claude-in-chrome 被 `isTauri()` 拦在 gate 外）：交互用 CGEvent 合成点击 + 置顶键入（System Events `click at` 对 WKWebView 无效，后台 `postToPid` 已证伪），截图用 `screencapture -l <CGWindowID>`（可后台/遮挡）。操作细节见 auto-memory `volo-native-ui-verification`。



## Tauri v2 接线 / 窗口（最易踩）

- invoke 参数 key：Rust snake_case 函数参数 → JS **camelCase**（`machine_id`→`machineId`）；struct 入参（request/input/cred/plan）整体一个 key、内部字段保持 snake_case。
- 返回 DTO 字段 = **snake_case**（crates 全 `#[derive(Serialize)]` 无 rename_all）；例外看各自 `#[serde(rename)]`（如 `ProjectDir.Path` 是 PascalCase）/ enum `rename_all`。前端封装见 `src/volo/api/commands.ts`。
- 无边框窗口拖动用 `data-tauri-drag-region` 属性（不是 `-webkit-app-region`），需在 `src-tauri/capabilities/default.json` 开 `core:window:allow-start-dragging`（+ close/minimize/toggle-maximize）。
- 禁界面文字选中用 `-webkit-user-select`（macOS WKWebView 不认裸 `user-select`）。

