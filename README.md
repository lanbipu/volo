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
├── README.md / PRODUCT.md / AGENTS.md / CLAUDE.md
├── docs/
│   ├── design/             UX / 设计文档（设计真相源）
│   │   ├── BRAND-BRIEF.md        设计基线：React Spectrum 2 / 暗·亮双主题 / 中文 fallback
│   │   ├── DESIGN-SYSTEM-SEED.md 基于 React Spectrum 的 Claude Design system 说明
│   │   ├── UX-PLAN.md            信息架构 / 6-tab / 外壳四区 / Stage 模型
│   │   └── WIREFRAMES.md         Cache + Calibrate 两页逐组件功能规格
│   └── architecture/       repo-structure.md（移植蓝图）· stage-data-model.md（待写）
├── src/
│   ├── main.tsx            React 入口
│   └── volo/               前端应用：shell · pages · api · styles
│       ├── shell.tsx       外壳（tab / 工具条 / Inspector）
│       ├── pages/          Cache · Calibrate 等功能页
│       ├── api/            Tauri invoke 封装（commands / types / adapters）
│       └── styles/         设计 token CSS
├── src-tauri/              统一 Tauri host（thin transport，聚合各 feature command）
├── crates/                 Rust 核心：volo-shared · mesh-core/app/adapter-* · cache-core · volo-cli
└── sidecars/               Python（各独立 venv）：mesh-vba · vpcal · tracksim
```

> 已用官方脚手架（`create-tauri-app` React）初始化；workspace 骨架、Rust crates / sidecar、前端 Cache / Calibrate 页与 Tauri command 层均已落地，其余 tab 与 Stage 数据模型按 `docs/architecture/repo-structure.md` 的 cutover 顺序继续填实。

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
- **设计系统**：用 Adobe React Spectrum 2（不自建 token、不写自定义视觉），组件查 repo 自带 S2 MCP；Cache 页按 Codex Design 原型全自定义 CSS 1:1 移植（不依赖 RS2 组件库）为有意例外
- **代码**：已脚手架 ✅ · 前端 Cache / Calibrate 页已移植（`src/volo/pages/`）✅ · Rust `crates/` + `src-tauri`（117 个 Tauri command，见 `lib.rs` invoke_handler）✅

## 开发验证

- 前端：`pnpm exec tsc --noEmit` + `pnpm exec vite build`
- 后端：`cargo check --manifest-path src-tauri/Cargo.toml`
- 跑原生 App：`pnpm tauri dev`（devUrl :1420）

## 工作流

先定 UX（`docs/design/`）→ 在 **Codex Design**（基于 RS 的 design system）设计 UI（功能输入用 `WIREFRAMES.md`）→ handoff 后用 `@react-spectrum/s2` 实现 React 前端；后端 Rust / Python sidecar 复用。详见 `AGENTS.md`。

## 链接

React Spectrum（设计系统 + S2 MCP server）：`../../person/design/react-spectrum`
