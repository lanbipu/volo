# Volo — 设计基线（React Spectrum 2）

> 用途：前端视觉 / 主题基线。**Volo 用 Adobe React Spectrum 2 (S2) 现成组件库，不自建视觉、不复刻任何第三方工具。**
> 历史：曾走"复刻 DaVinci Resolve"（2026-06-14 弃）；更早走"自建冷蓝克制设计系统"（已弃）。现统一用 S2。

---

## 1. 方向

- **栈**：Tauri 2 + **React** + `@react-spectrum/s2`。
- **设计系统 = Spectrum 2 本身**：配色 / 间距 / 圆角 / 字号 / 控件 / 密度全部继承 S2，不自定义 token。换 Spectrum 的目的就是不再自己设计视觉。
- **不做**：自建 token、复刻第三方工具的皮。UI 在 Claude Design（基于 RS 的 system）里设计，本文件给视觉 / 主题基线；组件用法查 repo 自带 **S2 MCP server**（`react-spectrum/packages/dev/mcp/s2`）。

## 2. 主题

- **暗 + 亮双主题，可切换**（Spectrum `colorScheme`；默认跟随系统或暗色，实现时定）。
- VP 现场常在差光照，暗色要可读；亮色供办公 / 白光环境。

## 3. 字体 / 中文

- 英文 / 数字：Spectrum 默认字体栈。
- **中文：fallback 思源黑体（Noto Sans SC）**——Spectrum 字体无 CJK 字形。中文不进等宽（mono 无 CJK）。
- 行高比纯英文放宽一档。

## 4. 强调色 / 品牌

- 默认用 Spectrum **accent**（Adobe 蓝）。
- 若要 LanX 品牌色，在 S2 token 层覆盖 accent（品牌色待定，不急）。

## 5. 保留的可用性底线（跨设计系统不变）

- **状态三通道**：色 + 图标 + 文字（healthy / warning / critical / offline / unknown …）。用 Spectrum 的 StatusLight / 语义色 + 图标 + 文案。
- **破坏性操作摩擦**：改配置 / 凭据 / 注册表前显示 diff + 影响 + backup（功能需求，与视觉无关）。
- **诚实对待不确定性**：未知 / 低置信态明确（Calibrate 的斜纹 / measured vs guessed）。

---

> External Inputs：Adobe React Spectrum 2（`@react-spectrum/s2`）作为设计系统；中文 fallback 思源黑体。无 KB 命中。
