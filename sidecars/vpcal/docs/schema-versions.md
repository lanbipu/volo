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

## 输入模型变更历史（session / lens / screen，无独立版本号）

`session.json` / `LensProfile` / `ScreenDefinition` 本身**不带 `schema_version` 字段**——
Pydantic v2 默认 `extra` 行为是忽略未知字段，新增可选字段天然向后兼容，无需版本号协调。
以下按同样的 additive / breaking 纪律记录变更，供下游（UI 接线、其他 sidecar）追溯：

- **W8（架构 v2.2 §4.3，入瞳偏移建模）** —— `LensProfile` 新增
  `entrance_pupil_offset_mm: float | None`，默认 `None`（等价于 0.0，逐位复现 pre-W8
  行为）。投影链（`core/projection.py` `CameraIntrinsics` + scipy/Ceres 两后端）在相机系
  沿光轴平移该偏移量后再做透视除法，符号约定对齐 OpenLensIO eq.(1) /
  OpenTrackIO `entrancePupilOffset`（正值 = 入瞳在物方一侧）。定焦镜头下该量与
  `T_C_from_B`（`refine_tracker_to_camera=true` 时）沿光轴的平移分量简并，二者从重投影
  残差无法区分；QA 未新增专门判据，使用者需知悉该简并。OpenTrackIO 导出的 `lens` block
  新增 `entrancePupilOffset`（米，外部 schema 已定义的字段，非 vpcal 自定义扩展）。

- **W9.1（架构 §3.3a，1:1 映射验证）** —— `SessionConfig` 新增可选 `processor_check` 块
  （`ProcessorCheckConfig`：`mapping_image` / `expected_width_px` / `expected_height_px` /
  `processor_verified`）。仅当 `screen.processor`（既有 C0 字段）被声明时，`validate_session`
  才将映射验证视为强制前置步骤——未声明处理器的会话（Phase 1 假设的直驱 1:1 画布）行为不变。
  `processor_verified: true` 显式跳过（用户自证已在别处验证）；否则必须提供
  `mapping_image` 且检测结果与声明画布尺寸吻合（非恒等映射 → `PreconditionError`，
  exit 6），或校验缺失/未通过 → 同样 `PreconditionError`。

- **AR 校正 Phase A–E（marker map 真值源，2026-07-02 执行方案）** ——
  `SessionConfig.screen` 变为可选，新增可选 `marker_map` 块（`MarkerMapConfig`：
  `path` + `ground_tolerance_mm` / `ground_tolerance_deg`），二者**互斥且必须恰好其一**
  （违反 → ArgumentError，exit 2）。既有 LED 会话文件（只有 `screen`）逐位不变。
  `marker_map` 存在时 detect 阶段路由到物理 ArUco/AprilTag 检测器
  （`core/detector_physical.py`），marker 3D 真值来自实测 marker map；**map 坐标系即
  stage 系，右手 Z-up，不做 UE 翻转**。新增独立 schema（全部列表结构，D6 纪律）：
  - `marker_map.json` —— `MarkerMapDefinition`，`schema_version: "1.0"`，`markers` 列表 +
    `rebase_history` 审计列表（`vpcal schema` 已输出该 JSON Schema）；
  - `timing/delay_profile.json`（Phase C）—— `schema_version: "1.0"`，`cameras` 列表承载
    per-camera 维度：`delay_ms ± sigma_ms`（正值 = tracking 领先 video）、confidence、
    运动门限计数与合成端建议；
  - `qa/tracker_offsets.json`（Phase E3）—— `schema_version: "1.0"`，`cameras` 列表，
    hand-eye 与世界对齐各一组 X/Y/Z(mm) + Pan/Tilt/Roll(deg)，按 session 声明的 tracker
    坐标系表达，`rotation_convention` / `translation_unit` 显式标注（可直接抄录进
    FreeD 类追踪设备）；
  - `qa/ground_plane.json` / `qa/world_alignment.json`（Phase B）—— marker-map 会话专属
    QA（地面平面拟合 + 按 survey_source/uncertainty_mm 的诚实不确定度分级，无输入时 n/a）。
  OpenTrackIO 导出新增 `applied_delay_ms`（CLI `--apply-delay` / `--delay-profile`）：
  样本时间戳整体平移，且每条 sample 的 `tracker.notes` 打 `delayCompensated` 标记
  （防双重补偿）。`result.json` 结构未变（`schema_version` 维持 1.2；AR 会话的
  `inputs.screen_definition` 填 marker map 名称）。

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
