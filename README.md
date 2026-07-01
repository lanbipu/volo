# Volo

> LanX 出品 · 虚拟制作（VP / LED 虚拟拍摄）统一桌面控制台。
> 跨平台桌面 App（Windows + macOS，**Tauri 2 + React + Adobe React Spectrum 2**）：底部页面 tab + 随页切换的上下文工具条 + 左子栏 / 右 Inspector，一个统一的 Stage 项目从左流到右，暗 / 亮双主题。

## 为什么

把分散在多个工具里的 VP 现场工作（渲染缓存 / 集群、LED 屏几何重建、几何 / 色彩校准、追踪模拟）收进**一个** App，共用一套设计系统 + 一个贯穿的 Stage 项目，减少工具切换与重复录入。

## 结构（monorepo）

```
vp/volo/
├── Cargo.toml              workspace 根（members = crates/* + src-tauri）
├── package.json            前端（React + Vite + Tauri）
├── README.md / PRODUCT.md / CLAUDE.md
├── docs/
│   ├── design/             UX / 设计文档（设计真相源）
│   │   ├── BRAND-BRIEF.md        设计基线：React Spectrum 2 / 暗·亮双主题 / 中文 fallback
│   │   ├── DESIGN-SYSTEM-SEED.md 基于 React Spectrum 的 Claude Design system 说明
│   │   ├── UX-PLAN.md            信息架构 / 6-tab / 外壳四区 / Stage 模型
│   │   └── WIREFRAMES.md         Cache + Calibrate 两页逐组件功能规格
│   └── architecture/       repo-structure.md（移植蓝图）· stage-data-model.md（待写）
├── src/                 React 前端：shell/ + stage/ + features/{cache,calibrate,color,previz,live,tools}
├── src-tauri/           统一 Tauri host（thin transport，聚合各 feature command）
├── crates/              Rust 核心：volo-shared · mesh-core/app/adapter-* · cache-core · volo-cli
└── sidecars/            Python（各独立 venv）：mesh-vba · vpcal · tracksim
```

> 已用官方脚手架（`create-tauri-app` React）初始化；workspace 骨架已建，各 crate / sidecar / feature 当前为占位 stub，按 `docs/architecture/repo-structure.md` 的 cutover 顺序逐个填实。

## 6 个功能 tab（= 现场工作流阶段，线性排列，底部居中）

`Pre-viz · Calibrate · Color · Cache · Live · Tools`

| Tab | 来源（在 `../`） | 栈 / 集成方式 |
|---|---|---|
| **Cache** | `ue-cache-manager` | 现 Vue3 + Tauri2，**前端重写成 React** |
| **Calibrate** | `led-mesh-toolkit` + `calibration/vpcal` | 网格段 Konva + Three.js（用 `react-konva` / `@react-three/fiber`）；镜头段 Python CLI 需包 GUI |
| **Color** | 自研（参考 `color/OpenVPCal`） | 不移植；仅借 Netflix 工具的方法 / 流程，功能后续自研 |
| **Tools** | `calibration/tracksim` + 网格生成器 | Python CLI |
| Pre-viz / Live | 新建 | — |

## 状态

- **UX 设计**：IA + Cache/Calibrate wireframe ✅ · Stage 数据模型 ⬜ → `docs/architecture/`
- **设计系统**：用 Adobe React Spectrum 2（不自建），组件查 repo 自带 S2 MCP
- **代码**：脚手架已落地（`src/` · `src-tauri/` · `crates/`）

## 快速开始

```bash
pnpm install
pnpm tauri dev          # 原生 App，dev server :1420
pnpm exec tsc --noEmit  # 前端类型检查
cargo check --manifest-path src-tauri/Cargo.toml  # 后端快验
```

## 工作流

先定 UX（`docs/design/`）→ 在 **Claude Design**（基于 RS 的 design system）设计 UI（功能输入用 `WIREFRAMES.md`）→ handoff **Claude Code** 用真 `@react-spectrum/s2` 实现 React 前端；后端 Rust / Python sidecar 复用。

## 链接

React Spectrum（设计系统 + S2 MCP server）：`../../person/design/react-spectrum`
