# Product

## 一句话

Volo 把 LED 虚拟拍摄现场的全流程（预演 → 建 LED 模型 → 几何校准 → 色彩校准 → 渲染端就绪 → 现场拍摄）收进一个桌面控制台，用"一个 Stage 项目从左流到右"的范式串起来。前端用 React + Adobe React Spectrum 2。

## 用户

现场虚拟制作的技术总监 / LED 校准工程师 / 渲染集群运维。技术娴熟、时间紧、常在差光照下站着看笔记本屏。界面尊重其专业度，不哄不教。

## 目的

把原本分散的多个现场工具（渲染缓存管理、LED 几何重建、几何/色彩校准、追踪模拟…）统一进一个 App，共用一套设计系统、一个贯穿的 Stage 项目模型，减少工具切换与重复录入。

## 品牌个性

三个词：**克制、精确、production-safe**。看起来像一台专业作业工具，不是一份 pitch。颜色是信息不是装饰，破坏性操作显得郑重。

详见 `docs/design/BRAND-BRIEF.md`（React Spectrum 2 设计基线、暗 / 亮双主题、中文 fallback）。

## 范围

优先落地 **Cache**（迁自 `ue-cache-manager`）与 **Calibrate**（网格段迁自 `led-mesh-toolkit`）两页；其余 tab 先预留布局，逐步完善。详见 `docs/design/UX-PLAN.md`。
