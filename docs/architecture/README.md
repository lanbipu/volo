# Architecture

Volo 的数据模型与架构文档。

## 待写

**`stage-data-model.md`（Step 3）** —— Stage 数据模型。将定义：

- `Stage`（一次拍摄项目）绑定什么：LED 屏 / Mesh 重建 / 几何校准 / 色彩校准 / Pre-viz / 本次机器 + DDC/PSO 配置快照。
- 全局 **Machine Library**（机器/凭据登记处，跨 Stage 复用）与 Stage 的**引用 / 快照**关系（见 `../design/UX-PLAN.md` §4）。
- 各阶段**完成度**推导（给 Stage Manager 卡片的徽标）。
- 实体字段可对照迁入工具的真实结构：`ScreenConfig` / `ReconstructionRun`（LMT）、`Machine` / `MachineDetail`（UECM），见 `../design/WIREFRAMES.md` 附表。

> 仓库已建好，Step 3 可随时直接落在本目录。它属于"开发/架构"层，跟前端 UI 实现无关。
