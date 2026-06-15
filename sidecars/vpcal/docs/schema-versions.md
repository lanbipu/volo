# Schema 版本化策略

> 来源：[CLI_DESIGN_SPEC.md](../../docs/CLI_DESIGN_SPEC.md) §4.4、[vpcal Phase 1 Implementation Spec](../../docs/vpcal_phase1_implementation_spec.md) §4.4

vpcal 的所有结构化输出都带版本号，调用方据此判断输出格式是否兼容。本文档说明各个版本字段的语义、
演进规则，以及它们之间的关系。

---

## 版本化规则（CLI_DESIGN_SPEC §4.4）

- 顶层 `schema_version` 采用**语义化版本** `MAJOR.MINOR`。
- **Breaking change**（删除字段、改变字段语义 / 类型、收紧约束）→ `MAJOR + 1`。
- **新增可选字段**（additive，向后兼容）→ `MINOR + 1`。
- CLI / MCP / HTTP **共享同一个 `schema_version`**，并与 `contract_version` 对齐。
  也就是说，输出 envelope 的 schema 和接口契约一起版本化、一起演进，不会各自漂移。

调用方应只读取自己认识的字段，对未知的新增字段保持容忍（forward-compatible），
这样 MINOR 升级不会破坏既有集成。

---

## 当前版本

| 版本字段 | 当前值 | 含义 |
|----------|--------|------|
| envelope `schema_version` | `1.0` | 成功 / 错误 / ndjson 输出 envelope 的 schema 版本（CLI_DESIGN_SPEC §4.1–4.3） |
| `contract_version` | `1.0` | Contract Manifest 的契约版本（`vpcal manifest` 输出），与 envelope `schema_version` 对齐 |
| calibration result `schema_version` | `1.2` | `result.json` 校正结果文件的 schema 版本（spec §4.4） |

### result schema 变更历史

- **1.1** → Quick Lens Estimate：`quality.lens_estimate` / `lens_observability_warning` 可选字段。
- **1.2** → 手眼先验权重分量纲（整改 A3.2）：session `solver` 配置新增
  `prior_weight_rotation`（默认 1/σ²，σ=2°，单位 rad⁻²）与 `prior_weight_translation`
  （默认 1/σ²，σ=10mm，单位 mm⁻²）。旧字段 `tracker_to_camera_prior_weight`
  **保留为废弃别名**：设置时同时填充两个新字段（复刻旧行为）；新字段显式给出时优先。
  同版本起 `vpcal quick run` 支持 `--handeye-init`（闭式手眼初始化，qa/handeye.json 报告）。
  另含 held-out 验证（整改 A4）：session 可选 `validation` 块
  （`holdout_frames` 显式帧列表或 `holdout_ratio`，按 frame 划分），holdout 帧不进求解；
  result `quality` 新增可选 `validation_rms_px` / `validation_observations`，
  confidence 分级优先看 validation RMS；无 holdout 时 qa/reprojection.json 标注
  `"validation": "none"` 并维持原行为。

---

## 两个独立的版本号：`schema_version` vs `vpcal_version`

`result.json` 顶部同时带两个版本字段，**含义完全不同，演进节奏也独立**：

```json
{
  "schema_version": "1.0",
  "vpcal_version": "0.1.0",
  "timestamp": "2026-06-06T14:30:00Z",
  "tracker_to_stage": { "...": "..." }
}
```

- **`schema_version`（`1.0`）** —— `result.json` 这个**文件格式 / 数据 schema** 的版本。
  只有在 result 文件结构发生变化时才变（新增可选字段 → `1.1`，破坏性结构变更 → `2.0`）。
  下游消费者（解析 `result.json` 的程序）应据此判断兼容性。

- **`vpcal_version`（`0.1.0`）** —— **生成这个文件的工具版本**（即 Python 包 `vpcal` 的版本，
  当前 Phase 1 MVP 为 `0.1.0`）。它跟随工具发布迭代，可能频繁变化，
  但**不代表** schema 改变。工具从 `0.1.0` 升到 `0.2.0` 时，只要 result 结构没动，
  `schema_version` 仍然是 `1.0`。

简言之：`schema_version` 描述"数据长什么样"，`vpcal_version` 记录"谁生成了它"。
做兼容性判断时**只看 `schema_version`**，`vpcal_version` 仅用于溯源 / 审计。

---

## 演进示例

| 变更 | `schema_version` | `contract_version` | `vpcal_version` |
|------|------------------|--------------------|-----------------|
| 当前 Phase 1 MVP | `1.0` | `1.0` | `0.1.0` |
| result.json 新增一个可选诊断字段 | `1.1` | `1.1` | `0.2.0`（举例） |
| Bug 修复，无格式变化 | `1.0`（不变） | `1.0`（不变） | `0.1.1`（举例） |
| 改变 `tracker_to_stage` 字段结构（破坏性） | `2.0` | `2.0` | `1.0.0`（举例） |

注：`schema_version` 与 `contract_version` 始终保持一致（CLI_DESIGN_SPEC §4.4 要求共享同一版本号）；
`vpcal_version` 独立演进。

---

## 预留：multi-camera 与 schema 2.0 破坏性边界（整改 D6）

> 不提前实现 multi-camera，但**现在划定边界**，让 Stage 3 起新增的 schema 不会在 Stage 5
> multi-camera 落地时被整体作废。

### multi-camera 属 **2.0 破坏性变更**

当前所有数据模型隐含**单相机假设**——`session.json` 的 `lens` / `tracker_to_camera` 与
`result.json` 的 `tracker_to_stage` / `tracker_to_camera` 全是**单数字段**。升级为多相机
（相机列表、多机位共享 `T_S_from_O` 联合求解）会改变这些字段的语义 / 类型，属**破坏性变更**，
集中在 **schema 2.0** 一次完成（架构 v2.2 §5.5 / 路线图 5.5）。在 2.0 之前不引入任何
单相机→多相机的隐式迁移。

### 约定：新 schema 一律用**列表结构**而非单数字段

为避免 2.0 落地时作废 Stage 3/4 已交付的文件，**本 Stage 起新增的导出 / 资产 schema**
（如 nDisplay 导出清单、master/session 标定包、采集录制 take 清单 C4/4.10）
**必须用列表 / 复数容器**承载"每相机"维度，即使当前只有一个相机：

```jsonc
// ✅ 推荐：列表结构，2.0 加第二台相机不破坏已交付文件
{ "cameras": [ { "id": "camA", "tracker_to_stage": { ... } } ] }

// ❌ 避免：单数字段，加第二台相机即破坏性变更
{ "tracker_to_stage": { ... } }
```

既有 Phase 1 字段（`result.json` 的 `tracker_to_stage` 等）**保持现状不动**——它们由 2.0
统一迁移；本约定只约束**新增**的 schema。

### 新 schema 评审检查项

任何新增结构化输出（导出 / 资产 / 清单）评审时必须确认：

- [ ] "每相机"维度用**列表 / 复数容器**承载（即使当前单相机），不用单数字段；
- [ ] 不引入任何单相机→多相机的隐式迁移逻辑（多相机留给 2.0）；
- [ ] 带 `schema_version`，且新增字段为 additive（MINOR+1）或显式声明破坏性（MAJOR+1）；
- [ ] 若是 master / session 资产，按纪律打 `is_master` 标记（master / session 分离）。
