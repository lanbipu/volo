# Design

Volo 的 UX 与设计文档。**这是设计真相源**，开发时对照。

| 文件 | 用途 | 时机 |
|---|---|---|
| `UX-PLAN.md` | 整体 IA：6-tab（Mesh+Geometry 合并为 Calibrate）、外壳四区、Stage 模型、迁移映射 | 先读，建立全局 |
| `WIREFRAMES.md` | Cache + Calibrate 两页逐组件功能规格（字段 / 按钮 / 交互）+ 给 Claude Code 的实现规格 | 实现页面时 |
| `CACHE-UX.md` | Cache 页 UX 蓝本：从 UECM CLI 走读抽出的功能域 / 工作流（向导）/ 状态模型 / 护栏，喂 Claude Design 做布局（配套 WIREFRAMES §1） | 设计 / 布局 Cache 页时 |
| `CACHE-CAPABILITIES.md` | Cache 页**后端能力边界**：实测的 GUI 命令 + DTO 真实字段；标出原型已超出后端的项。喂 Claude Design 当硬约束、落地对账用 | 设计 Cache 页 + `.tsx` 落地对账时 |
| `BRAND-BRIEF.md` | 设计基线：用 React Spectrum 2、暗 / 亮双主题、中文 fallback、强调色 | 起前端 / 写组件前 |
| `DESIGN-SYSTEM-SEED.md` | 基于 React Spectrum 的 Claude Design system + 逐页设计流程 | 设计前读 |

## 方向

用 **Adobe React Spectrum 2（S2）** 作设计系统（不自建）；在 Claude Design（基于 RS 的 system）设计 UI → handoff Claude Code 用 `@react-spectrum/s2` 实现。组件用法查 repo 自带 S2 MCP server（`react-spectrum/packages/dev/mcp/s2`）。

## 阅读顺序

UX-PLAN（全局 IA）→ BRAND-BRIEF（S2 基线）→ WIREFRAMES（两页功能规格）。
