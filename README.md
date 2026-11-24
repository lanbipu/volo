# Volo

> LanX 出品 · 虚拟制作（VP / LED 虚拟拍摄）统一桌面控制台。
> 跨平台桌面 App（Windows + macOS，**Tauri 2 + React**）。界面按 Claude Design 原型用自定义 CSS 1:1 移植，不使用组件库。

## 为什么

把分散在多个工具里的 VP 现场工作（渲染集群与缓存、LED 屏几何重建、镜头与空间校准、上屏输出）收进**一个** App，共用一套外壳和设计语言，减少工具切换与重复录入。

## 现状

| Tab | 内容 | 状态 |
|---|---|---|
| **Cache** | 机器发现与入网、凭据、DDC 共享与 PAK、ZenServer、PSO 预热、INI 巡检、健康检查 | 后端、CLI、界面全通 |
| **Calibrate** | 屏幕建模、全站仪导入、视觉重建、融合、导出；镜头标定、固定机位校正、结构光、AR 分支；nDisplay 上屏部署 | 主路径通，部分链路待真机验收 |
| **Tools** | Keyer Lab（WebGPU 实时抠像实验台） | 算法原型；tracksim 后端已进仓，界面未接 |
| Pre-viz / Color / Live | — | 空骨架 |

跨板块共享的 Stage 数据模型尚未落地：Calibrate 用 `project.yaml`，Cache 用独立的 SQLite，两边靠 hostname / IP 对接。

## 结构（monorepo）

```
volo/
├── Cargo.toml          workspace 根（members = crates/* + src-tauri）
├── package.json        前端（React + Vite + Tauri）
├── src/volo/           前端：shell.tsx 外壳 + pages/ 按页面平铺 + api/ 类型化命令封装 + styles/
├── src-tauri/          Tauri host：约 210 个 command（见 src/lib.rs 的 invoke_handler），只做 transport
│   └── resources/      节点端 PowerShell 脚本、UE 上屏模板
├── crates/
│   ├── cache-core      Cache 领域逻辑（SSH 远程执行、DDC、Zen、PSO、INI）
│   ├── mesh-core       屏幕几何：重建、曲面拟合、刚性对齐、导出
│   ├── mesh-app        网格服务层：项目、视觉重建编排、nDisplay、上屏输出
│   ├── mesh-adapter-*  全站仪导入 / 视觉重建 sidecar 适配
│   ├── volo-shared     跨 crate 的 DTO、错误类型、网格侧数据库
│   └── volo-cli        voloctl：与 GUI 共用同一套核心的命令行
├── sidecars/           Python（各自独立 venv）
│   ├── mesh-vba        视觉重建：标记检测 + 箱体刚体平差
│   ├── vpcal           镜头与空间校准（含可选的 C++ Ceres 求解器）
│   └── tracksim        追踪协议模拟器（FreeD / OpenTrackIO）
├── examples/           示例 Stage 项目（project.yaml）
├── scripts/            开发、部署、诊断脚本
└── docs/               设计与架构文档（目录整体被 .gitignore 忽略，仅少数文件入库）
```

## 快速开始

```bash
pnpm install
pnpm tauri dev                                      # 原生 App，dev server :1420
pnpm exec tsc --noEmit                              # 前端类型检查
pnpm exec vite build                                # 前端构建
cargo check --manifest-path src-tauri/Cargo.toml    # 后端快验
cargo test --workspace --exclude volo               # crates 测试
```

Python sidecar 默认未安装，由 Rust 按需启动。各 sidecar 目录下建 `.venv` 后 `pip install -e .`；未安装时相关动作会报 "sidecar not found"，不影响 App 启动。`vpcal` 首次安装会编译 Ceres，可加 `-C cmake.define.VPCAL_SKIP_SOLVER=ON` 跳过，运行时回退到 scipy。

## 工作流

1. 界面先在 **Claude Design** 设计和迭代，确认后 handoff。
2. 本仓照设计稿做 1:1 移植。**不在 Claude Code、Cursor 或其他 AI 平台里直接改界面视觉或布局。**
3. 业务逻辑放 `crates/`，`src-tauri` 只做参数翻译；新功能从设计阶段就考虑 `voloctl` 暴露。

约定细节见 `CLAUDE.md`（`AGENTS.md` 与之同步）。

## 文档

- `CLAUDE.md` / `AGENTS.md`：给 AI 协作者的约定与易踩的坑。
- `docs/architecture/remediation-backlog.md`：整改待办与优先级。
- `docs/architecture/volo-output-*.md`：nDisplay 上屏的编排契约、manifest 协议、验收报告。
- `docs/design/CALIBRATE-UX.md`：LED 网格校正的交互规范。
- `docs/guides/`：视觉重建拍摄、Keyer Lab、上屏蓝图的使用指南。
- `sidecars/*/README.md` 与 `sidecars/vpcal/docs/`：各 sidecar 的规格、误差预算、整改路线。
