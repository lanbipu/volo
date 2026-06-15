# CLAUDE.md

Volo —— LanX 出品的虚拟制作桌面工具（**Tauri 2 + React + Adobe React Spectrum 2**）。本仓是单一 monorepo，设计文档与代码同仓。

## 先读这些（设计真相源）

动任何 UI / 组件前，先读 `docs/design/`：
- `WIREFRAMES.md` —— Cache / Calibrate 两页的逐组件功能规格（字段 / 按钮 / 交互）。改这两页对照它。
- `BRAND-BRIEF.md` —— 设计基线：用 React Spectrum 2、暗 / 亮双主题、状态三通道、中文 fallback 思源黑体。
- `UX-PLAN.md` —— 整体 IA（6-tab：Pre-viz / Calibrate / Color / Cache / Live / Tools、外壳四区、Stage 模型）。

数据模型见 `docs/architecture/`（Step 3 = `stage-data-model.md`，待写）。

## 设计系统：React Spectrum 2

- **UI 流程**：先在 Claude Design（基于 RS 的 design system）设计 / 迭代 → handoff，本仓照确认后的设计稿 + `WIREFRAMES.md` 用 `@react-spectrum/s2` 实现。
- 用 `@react-spectrum/s2` 现成组件，**不自建 token、不写自定义视觉**。
- 组件用法查 repo 自带 **S2 MCP server**：`../../person/design/react-spectrum/packages/dev/mcp/s2`。
- 暗 / 亮双主题（`colorScheme`）；中文 fallback 思源黑体；状态三通道（色 + 图标 + 文字）。

## 来源工具（在 `../`，将迁入 / 整合）

- `../ue-cache-manager` → **Cache** 页（现 Vue3，**前端重写成 React**）
- `../led-mesh-toolkit` → **Calibrate** 页网格段（Vue3 + Konva + Three.js + Rust workspace + Python sidecar；前端重写 React，用 `react-konva` / `@react-three/fiber`）
- `../calibration/vpcal`（Calibrate 镜头段，纯 CLI）/ `../calibration/tracksim`（Tools，纯 CLI）—— 都移植整合

> **Color** 页不移植任何来源：`../color/OpenVPCal`（Netflix 开源，PySide6/Qt）仅作**方法 / 流程参考**，功能后续自研。

## 约定

- 业务逻辑放服务层 / Rust crates，`src-tauri` 只做 transport 翻译；新功能从设计阶段就考虑 CLI 暴露（沿用 LMT 的 CLI 底座契约，见 `../led-mesh-toolkit/CLAUDE.md`）。
- **换栈只换前端（Vue → React）；Rust 后端 / Tauri commands / Python sidecar 保留。**
- 视觉全交给 React Spectrum 2，不硬编码颜色 / 不自建 token。
- 暗 / 亮双主题；状态永远「色 + 图标 + 文字」；CJK 排版（中文 sans fallback 思源黑体，mono 仅标识符，行高放宽）。

## 代码状态

未初始化。开始开发时用官方脚手架（`create-tauri-app` 选 React）生成，不手搓配置。
