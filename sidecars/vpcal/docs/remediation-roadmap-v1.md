# vpcal 整改与演进路线 v1.1（整合版）

> 依据：2026-06-10 全面技术路线审查（7 个并行读者建图 + 主审综合，全部论断带 file:line 证据）+ Phase 2/3 内容对账。
> v1.1 变更：整合架构 v2.0/v2.1 §11 的 Phase 2/3 全部内容与 Phase 1 规格散落承诺，按执行优先级重排为 Stage 1–5。
> **排序总原则：最高优先级是修复当前快速校正（QuickCal）与基础功能，保证其优先稳定可用**；之后才是实测可信 → 现场效率 → 精密校正 → 工业级扩展。
> 总判定：**重投影 BA 核心路线正确，不推倒**。
> 执行纪律：每项任务有验收标准（verify），完成一项勾一项；**禁止顺手改"保留不动"清单内的代码**。任务保留原编号（A/B/C/D 系）便于追溯，Stage 划分即执行顺序。

---

## 执行进度（截至 2026-06-14）

> 完成状态总览。图例：✅ 完成且验收通过 ｜ 🟡 代码完成 + 合成/快照验收，真机验收延后 ｜ ⛔ 硬件阻塞（已搭骨架 + 准备文档）｜ ⬜ 未开始。
> 提交：`edbd0d2`/`60ac5de`/`7fbda51`/`f5aec6b`（Stage 1）、`23b1b95`（Stage 2）、`6cd1915`（Stage 3）、`4b26539`（code-review 修复）；架构 v2.2 在父仓库 `73d0707`。
> 测试：321 个（3 个在 B2 真实数据缺失时 skip），覆盖率 ~88%。

| Stage / 里程碑 | 任务 | 状态 | 备注 |
|---|---|---|---|
| **Stage 1 · M1 ✅** | A1 A2 A3 A4 ／ D1 D2 D5 | ✅ 全部完成 | 导出规范帧+conformance、图案/检测偏差、闭式手眼+分量纲先验、held-out validation、双后端位级一致、配置接线、小修集 |
| **Stage 2 · M2 🟡** | B1 误差预算 sweep | ✅ | `vpcal simulate sweep` + `docs/error-budget.md` |
| | B2 主路径真实数据 E2E | ⛔ | 需真实追踪硬件；骨架 + `docs/b2-real-data-capture.md` |
| | B3 时序敏感性 | ✅ | 写入 error-budget.md，裁剪 TimeCal(4.5) |
| | D3 文档收敛 + 架构 v2.2 | ✅ | CHANGELOG ／ CLAUDE.md ／ v2.2（父仓库） |
| | D4 tracker-free QA | ✅ | RMS 反投影 + 离散度 + 离群剔除 + 四元数去重 |
| **Stage 3 · M3 🟡** | C0 LED 处理器校验 | 🟡 | 代码+合成（检出 1px 偏移）；真 LED 墙验收延后 |
| | C1.1 追踪实时接入 | ✅ | `vpcal capture track`（FreeD/OpenTrackIO） |
| | C1.2／C1.3 视频取流／图案播放 | ⛔ | 需采集卡/显示输出；骨架 + `docs/c1-capture-service.md` |
| | C5 drift 监测 | ✅ | `vpcal report diff` |
| | C6 nDisplay export | 🟡 | 代码+快照；真 UE 加载验收延后 |
| | D6 multi-camera schema 预留 | ✅ | `docs/schema-versions.md` |
| **Stage 4 · M4 ⬜** | 4.1–4.10 | ⬜ 未开始 | 精密校正与资产体系（≈架构 Phase 2） |
| **Stage 5 · M5 ⬜** | 5.1–5.7 | ⬜ 未开始 | 工业级扩展（≈架构 Phase 3） |

**阻塞总结**：M2/M3 仅余**硬件耦合项**未达成——B2（真实追踪源）、C1.2/C1.3（采集卡 + 显示输出）、C0 真 LED 墙验收、C6 真 UE 验收。代码与数学核心、合成/快照验收均已就绪，补上硬件即可跑通。

---

## 0. 保留不动清单（防 scope creep）

以下模块经审查确认质量高，本路线图所有任务**不得重构它们**（仅允许下文明确列出的定点修改）：

| 模块 | 理由 |
|---|---|
| `core/transforms.py` / `core/projection.py` / `core/coordinates.py` | 残差链与坐标系数学正确，闭环 <0.01px 验证 |
| `src/vpcal_solver/cost_functions.h` 残差链结构 | 同上（仅 A3 定点改 `CameraPriorCost` 权重） |
| `core/solver_scipy.py` 残差公式与 LensFreedom 机制 | QLE 位级兼容设计成熟 |
| `qa/observability.py` gate 框架与 revert 纪律 | 五步流程（baseline→pre-gate→joint→post-gate→re-solve）保留 |
| `models/` 全部（Pydantic 单一事实源设计） | 仅按任务新增字段，不改既有结构 |
| CLI contract（envelope / exit codes / manifest） | house 标准 |
| `pattern.py` 的 VP-QSP 32-bit + CRC-8 编码体系 | 编码本身合理（仅 A2 修量化） |
| 测试方法论（simulate→solve 对照 ground truth 闭环范式） | 扩展噪声模型，不改范式 |

---

# Stage 1 —— 现有功能稳定化（最高优先级）

> 目标：QuickCal 快速校正 + 基础功能（检测、求解、导出、QA）稳定可用、结果可信、对外契约正确。
> 此 Stage 完成前不启动任何新功能开发。

## ✅ A1. 导出层修复 —— 导出环节正在静默破坏透视

**A1.1 OpenTrackIO 坐标帧违规（critical）**
- 问题：`io/export/opentrackio.py:122` 经 `to_ue_transform` 把位姿写成 UE 左手帧；OpenTrackIO 规范要求 RH、Z-up、Y=相机前向。第三方消费者解析得到前向轴错置 + 手性翻转。自家 roundtrip 测试（`tests/integration/test_export_roundtrip.py:52`）须以 `coordinate_system="unreal"` 重导入才闭环，自证非规范。
- 改法：默认输出规范帧（internal RH → OTIO 帧的固定置换）；提供 `--frame spec|ue` 选项保留 UE 帧路径（显式声明非规范，文件头注 `coordinateSystem` 备注）。同步在 `CoordinateSystem` Literal 中新增内置 `"opentrackio"` 源坐标系（`models/session.py:16`、`core/coordinates.py:27-42`），让自家导出文件不需要声明 `unreal` 即可读回。
- 验收：roundtrip 测试改为零 custom 声明闭环；新增"规范帧轴向"单测（已知位姿 → 检查 Y 轴=前向）。

**A1.2 畸变方向标签写反（major，一行修）**
- 问题：系数实际为 OpenCV 正向（undistorted→distorted），按 `../docs/OpenCV_to_OpenTrackIO.md` 应标 `"Brown-Conrady U-D"`；`opentrackio.py:46` 写成 `"D-U"`。消费者按标签反向应用，边缘误差约 2× 畸变量。
- 改法：改标签为 `"Brown-Conrady U-D"`。
- 验收：单测断言导出 sample 的 `lens.distortion[].model == "Brown-Conrady U-D"`。

**A1.3 官方 JSON Schema 合规（major）**
- 问题（4 处，`opentrackio.py:41-84`）：① `protocol.version` 写字符串 `"1.0.0"`，schema 要求 3 元整数数组；② `sampleId` `"urn:uuid:vpcal-00000001"` 不符 urn:uuid 十六进制正则；③ lens 块 `focalLength` 应为 `pinholeFocalLength`，且 `sessionEstimate`/`calibrationHistory` 自定义键撞 `additionalProperties:false`（自定义信息移入 `tracker.notes` 或 `custom` 容器）；④ `tracker.notes` 非 session_estimate 时为 null，schema 要求字符串（改为省略该键）。
- 改法 + 验收：新增 conformance 测试——用仓库内 `../docs/OpenTrackIO_JSON_schema.json` + `jsonschema` 对每条导出样本做校验，全绿为验收。此测试同时锁定 A1.1/A1.2。

## ✅ A2. 图案与检测层系统偏差

**A2.1 图案整数像素量化（major）**
- 问题：`pattern.py:249-251` 把 marker 中心 round 到整数 LED 像素，而 `screen_geometry.py:191-193` 的 3D 查表用精确 UV → 每 marker 系统偏差 ~0.5–1 LED pitch（P2.5 屏 ≈1.25–2.5mm）。叠加像素索引 `u*w` vs 像素中心 `u*w−0.5` 的约定差。
- 改法：dot 用 `splat_gaussian_dot` 的浮点坐标按精确分数位置直接 splat 在 section 图上（函数本身已支持）；统一像素中心约定（明确 `u*w−0.5`），pattern 与 world_map 两侧用同一函数取坐标。
- 验收：新增单测——生成图案后用解析方法反求 dot 质心，与 `marker_world_map` 的 UV 反推像素位置之差 < 0.05 LED 像素。

**A2.2 亚像素质心改在差分图上计算（major）**
- 问题：`detector.py:209,212` 的 `_decode_quad` 与 `_subpixel_center` 用原始 normal 灰度图，normal−inverted 差分只用于阈值分割——环境光梯度直接偏置强度加权质心（这正是 inverted 帧要消除的误差源）。且 `cv2.subtract` 饱和截断丢负向信息。
- 改法：质心（及 cell 采样）改在带符号差分图 `(int16(normal) − int16(inverted))` 上计算（无 inverted 时回退 normal 并在 Detection 上打标）。
- 验收：合成测试——对 normal 帧叠加线性环境光梯度（如 0→40 灰度跨 marker），差分质心偏移 < 0.05px，而 normal 帧质心偏移显著（>0.3px），证明修复有效。

**A2.3 confidence 通路接线（major）**
- 问题：`detector.py:163` topology filter 降权 confidence，但 `Observation`（`observations.py:65-82`）无 confidence 字段，`pipeline.py:125-130` 构造时丢弃 → 整条质量通路是 no-op。
- 改法（取简单方案）：confidence < 1.0 的检测**硬剔除**（不进求解），剔除数计入 QA 报告 `detection_rejected_topology` 字段。不做 solver 加权（避免动残差公式）。
- 验收：单测——构造一个 decode 正确但位置与邻域拓扑矛盾的检测，断言它不出现在 observations 中且 QA 计数 +1。

**A2.4 检测鲁棒性最小集（minor，可与 A2.2 同 PR）**
- 全局 Otsu 失败回退：检测数为 0 时自动重试 `cv2.adaptiveThreshold` 分块阈值（`detector.py:53-56`）。
- inverted 帧路径替换 `'/normal/'→'/inverted/'` 失败时（`pipeline.py:110`）发 warning 并在 QA 报告写 `differencing_enabled: false`，不再静默退化。
- 验收：两个对应单测。

## ✅ A3. 手眼链修复 —— 当前最大的不可见系统误差源

**A3.1 闭式手眼初始化（major，算法层投入产出比最高）**
- 问题：`init_C` 默认恒等（`solver.py:183-184`），无任何闭式手眼解；真实 rig 追踪刚体与相机差几 cm + 90° 级旋转，先验全靠用户手量，错误先验下 LM 收敛域不保证、且误差无法被 `T_S_from_O` 吸收。
- 改法：新增 `core/handeye.py`——对每个 pose 已有 PnP（`pnp_initial_tracker_to_stage` 的逐帧版本）得到 `T_C_from_S_i` 序列，与追踪位姿 `T_sdk_i` 构成 AX=XB，用 Park-Martin 闭式解出 `T_C_from_B` 初值（≥3 个旋转轴不平行的 pose 即可解）。接入 `solve_calibration`：用户未提供先验时自动启用；提供先验时仍可 `--handeye-init` 强制并报告两者差异（差异大 = 用户先验可疑，写入 QA warning）。**必须加旋转轴多样性检查**，纯平移构型退化时报 PreconditionError 并引导补拍。
- 验收：simulator 加手眼扰动（见 B1）后闭环测试——给定恒等先验 + 真实 `T_C_from_B` 含 5cm/30° 偏置，闭式初始化 + BA 后平移误差 < 2mm、旋转 < 0.05°（当前实现此场景直接失败或收敛错盆地）。

**A3.2 先验权重分量纲（major）**
- 问题：`cost_functions.h:107-114` 与 `solver_scipy.py:201` 用同一 `sqrt(1000)` 乘平移（mm）和旋转（rad）残差。等效 σ：平移 ≈0.032mm（=硬冻结），旋转 ≈1.8°。`refine_C=True` 时平移实际不动且不报警。
- 改法：`SolverConfig` 拆为 `prior_weight_rotation` / `prior_weight_translation`（按期望误差尺度定默认值，如旋转 σ=2°、平移 σ=10mm），两后端同步修改；旧字段 `tracker_to_camera_prior_weight` 保留作废弃别名（schema_version 升 1.2 并更新 `docs/schema-versions.md`）。
- 验收：闭环测试——真实手眼相对先验偏移 8mm，refine_C=True 求解后平移恢复误差 < 1mm（当前实现恢复不了）。

## ✅ A4. validation pose（held-out 验证）—— 最廉价的精度自证

- 问题：全仓无 validation pose（grep 零命中）；RMS 是 in-sample 自洽指标，证明不了透视准确；它同时是架构 Observability Gate 判据 #4 的前置。
- 改法：`SessionConfig` 新增 `validation.holdout_frames`（显式帧列表）或 `validation.holdout_ratio`（默认 0.2，按 frame 划分而非按观测）；这些帧不进求解，求解后用结果变换对它们算独立 reprojection RMS，写入 `CalibrationResult.quality.validation_rms_px` 与 `qa/reprojection.json`。`_confidence` 分级改为优先看 validation RMS（无 holdout 时按现行逻辑并在报告标注 `validation: none`）。QLE 的 post-gate `improvement` 判据同步改用 validation RMS（防联合估镜头吸收误差——架构纪律三的本意）。
- 验收：① 合成闭环——训练/验证 RMS 接近（差 < 30%）为健康，人为给一半帧注入坏追踪数据后 validation RMS 显著高于训练 RMS（敏感性证明）；② QLE E2E——镜头参数过拟合场景（少 pose 强放开）validation gate 能 revert 而旧 in-sample gate 放行。

## ✅ D1. 双后端一致性位级测试
- 固定参数向量，逐 observation 对比 C++/Python 残差（atol 1e-9）；并修文档表述——"逐位一致"仅对未鲁棒化重投影残差成立（Huber 聚合、先验参数化、先验是否鲁棒化三处本就不同，注明即可，不强行统一）（证据：`solver_scipy.py:6` 注释 vs `solver.cpp:45,54-56`）。
- 验收：新测试入库；`solver_scipy.py` docstring 修正。

## ✅ D2. 未接线配置处理
- `robust_loss`（cauchy/none 被静默忽略）、`timeout_seconds`、`capture_mode`——接线或删除+schema 注明 reserved，不许静默忽略（证据：`models/session.py:129-132,146`；`solver.cpp:45`）。
- 验收：配 `robust_loss=cauchy` 报 NotImplemented 或生效。

## ✅ D5. 小修集
- `line_number` 字典序错配警告（自然序排序 + 无零填充告警，`frame_matching.py:149`）；重复 frame_id 两路径不一致（exact 路径与 match_frames 统一取首条，`tracking_io.py:131-133`）；`observations.jsonl` 与真实图像并存时显式报错（`pipeline.py:412-414`）；inlier 阈值在 QA 报告标注像素语义；QLE `confidence="high"` 不可达分支注明或移除 ceres 条件（`observability.py:233-246`）。
- 验收：各配单测。

**✅ 里程碑 M1（快速校正稳定可用）= A1–A4 + D1/D2/D5 全验收**：导出可互操作、检测无系统偏差、手眼可自动初始化、有 held-out 自证、无静默失效路径。 **【已达成】**

---

# Stage 2 —— 实测可信（把"数学正确"升级为"实测可信"）

## ✅ B1. simulator 噪声模型扩展 + 误差预算敏感性曲线
- 问题：当前仿真只有像素高斯噪声 + uniform outlier；追踪位姿零噪声（由相机位姿解析反推，`simulator.py:148-154`）、无时间错位、无手眼扰动；Gaussian dot 在图像空间按解析投影中心 splat（`simulator.py:290-292`），掩盖真实屏幕空间 dot 的透视质心偏置。
- 改法：`SimulatorConfig` 新增 ① `tracker_noise`（平移 σ mm / 旋转 σ deg，加在 T_sdk 上）；② `temporal_offset_frames`（图像与追踪错位 N 帧，含小数插值）；③ `handeye_perturbation`（真实 T_C_from_B 与上报先验之差）；④ dot 渲染改为屏幕空间烘焙后经完整投影链采样（与 `pattern.py` 真实路径一致，消除 splat 捷径）。然后写 `vpcal simulate sweep`：对每个误差源扫参数，输出"误差源量级 → 解的 T_S_from_O 偏差"敏感性表（CSV + 图）。
- 验收：敏感性表产出并入库 `docs/error-budget.md`，定量回答"哪个误差源主导"——后续所有精度决策的依据。
- 依赖：无（A3 的验收测试依赖本项 ③，可提前做 ③）。

## ⛔ B2. 主路径真实数据端到端（当前为零）
- 问题：唯一实拍（`_walkthrough`）走 tracker-free 旁路（逐帧 PnP + 平均，不经 Ceres/scipy/observability）；主路径只有合成数据。且实拍"验证图"与训练帧 md5 相同，闭环部分 in-sample。
- 改法：① 重做显示器实验时**补拍不在训练集内、不同机位的 held-out 验证帧**；② 借/租真实追踪源（OptiTrack 刚体、或手机 ARKit 充当 tracker）跑一次 `vpcal quick run` 主路径全流程，产出第一份真实 `T_S_from_O` + validation RMS；③ 固化为第二组 walkthrough 回归测试（数据缺失 skip）。
- 验收：主路径真实数据 validation RMS 有数字、有报告；A3/A4 的修复在真实数据上各跑一次对照（修复前后 RMS 对比记入报告）。
- 依赖：A3、A4。

## ✅ B3. "非同步采集结果几乎相同"论断的受控验证（TimeCal 决策依据）
- 问题：架构 v2.1 用该论断替代 TimeCal（纪律二），但引文在 disguise 知识库不可溯，且与 QuickCal "moving capture" 流程自相矛盾；静态默认采集下 timing 残差签名永不可观测。
- 改法：用 tracksim 产生带受控时序偏移的追踪流 + B1 的 `temporal_offset_frames` 仿真，定量测"错位 N ms → 解偏差"曲线（静态 pose vs 运动采集两组）。
- 验收：结论写入 `docs/error-budget.md`；据此决定 Stage 4 的 TimeCal（任务 4.5）排期与裁剪。
- 依赖：B1。

## ✅ D3. 文档收敛 + 架构 v2.2
- CHANGELOG 补 0.1.0 后全部 commit（含 MarkerId 结构 breaking 变更）；修 `CLAUDE.md` "OpenCV ArUco" 错误描述（实为自研 VP-QSP）与 146/92% 过期数字（实为 230/88%）；commit 三个未跟踪的 tracker-free 测试文件；**按本文档附录的 17 条修订清单发布架构 v2.2 收敛版**（收编 tracker-free 定位、回改 Phase 1 实际边界、恢复 v2.0 来源置信度风险标注段）。
- 验收：文档与代码事实一致；v2.2 发布。

## ✅ D4. tracker-free QA 补齐
- `SpatialResult.rms_reprojection_a/b` 实际赋值（用 M_avg 反投影，`tracker_free.py:81-82`）；输出 per-image 相对变换对均值的偏差作为一致性指标；逐图平均加离群剔除（`tracker_free.py:346-356`）；四元数数学并回 `transforms.py`（删除重复实现）。
- 验收：spatial.json 含 RMS/离散度字段；walkthrough 回归测试更新参考值。

**🟡 里程碑 M2（实测可信）= B1–B3 + D3/D4 完成**：有定量误差预算、主路径有真实数据闭环、文档与代码一致。 **【B1/B3/D3/D4 已达成；B2 硬件阻塞，骨架就绪】**

---

# Stage 3 —— 现场效率与产品化基础

## 🟡 C0. LED 处理器链路校验（第一次真实 LED 墙测试的硬前置）
- 问题：Phase 1 规格 §6.7 假设 pattern 与 LED 物理像素 1:1 映射并承诺 "Phase 2 提供 LED 处理器配置导入"（spec:924），但架构 v2.0/v2.1 Phase 清单完全遗漏此项。真实 LED 墙几乎都经处理器（Brompton Tessera / Megapixel HELIOS / Nova），画布缩放/裁切任何一项存在则 marker 3D 查表全错，当前无任何检测手段。
- 改法：① 处理器画布配置导入（input 分辨率→物理像素的映射声明，进 `ScreenDefinition`）；② **1:1 映射实测验证 pattern**——一张含已知像素坐标基准点的测试图，拍摄后自动验证映射成立，不成立时报 PreconditionError 并输出实测缩放/偏移；③ 该验证作为真机 session 的 validate 阶段强制步骤。
- 验收：在带处理器的真实 LED 墙上，映射验证 pattern 能检出人为设置的 1px 画布偏移。
- 依赖：无（应在 B2 之后、第一次真 LED 墙测试之前完成）。

## 🟡 C1. 采集服务（"工具"→"产品"的分水岭） — C1.1 ✅ 已完成；C1.2/C1.3 ⛔ 硬件阻塞
- 现状：摆 pose → 拍照 → 拷卡 → 命令行，照片↔追踪靠文件名尾号约定（`frame_matching.py`），30s–5min 目标达不到。QuickCal 用户流程承诺"播放图案→移动扫一遍"，但全部 Phase 原本没有"图案播放器/取流/监听"工程载体。
- 改法（独立服务/子命令 `vpcal capture`，分三步落地）：
  1. **追踪实时接入**：FreeD UDP / OpenTrackIO 监听（tracksim 已有协议实现可参考/复用），录制为带 timestamp 的 tracking 流；
  2. **视频流取流**：SDI/NDI/UVC 采集帧，与追踪流按接收时戳配对（让 `timestamp` 匹配策略真正可达，替代文件名约定）；
  3. **图案播放同步**：驱动输出窗口/LED processor 按序播放 pattern（normal/inverted 对、多 pose 引导 UI），帧内嵌 Gray code 序号供视频流侧识别当前 pattern——拍摄全程零手工拷贝。
- 验收：一次完整校正（≥8 pose）从开始到 result.json 产出 ≤ 5min、零手工文件操作；frame_matching 的文件名路径降级为离线兜底模式。
- 依赖：A4（现场即时 QA 需要 validation 指标）；C1.1 可先行。

## ✅ C5. drift 监测（低成本高价值，可随时插队）
- 问题：QuickCal 用途清单含 "daily drift check"，但无任何 Phase 包含历史对比功能。
- 改法：`vpcal report diff <result_a> <result_b>`——对比两份 result.json 的 T_S_from_O / T_C_from_B / validation RMS，输出平移/旋转漂移量 + 阈值告警（如 >2mm / >0.05° 标红）。
- 验收：单测 + 在 B2 真实数据上对比两次独立标定（与 4.9 的 test-retest 共用数据）。
- 依赖：A4。

## 🟡 C6. UE/nDisplay export（回排项）
- 问题：spec:1216 已推迟 Phase 2（理由：nDisplay 格式在 UE 版本间不稳定），v2.1:454 仍列 Phase 1，未回排。
- 改法：锁定单一目标版本（建议当前 UE 5.7，KB 有 413 篇文档可查格式）；导出 nDisplay 配置（screen mesh + 相对变换，mm→cm、UE 坐标系）+ 操作指引。明确声明支持版本范围。
- 验收：导出配置在目标 UE 版本 nDisplay 中加载、屏幕位置与 result.json 矩阵一致（手动验证一次 + 格式快照测试）。
- 依赖：A1（坐标帧约定先收敛）。

## ✅ D6. multi-camera schema 预留
- 不提前实现，但在 `schema-versions.md` 写明 multi-camera 属 2.0 破坏性边界；本 Stage 起新增的导出/资产 schema（master/session、C4 录制清单）一律用列表结构而非单数字段，避免 Stage 5 全量作废已交付文件（证据：`models/session.py` lens/tracker_to_camera 单数假设贯穿）。
- 验收：schema-versions.md 更新；新 schema 评审检查项。

**🟡 里程碑 M3（现场可用）= C0 + C1 完成**：≤5min 零拷卡校正闭环、真 LED 墙映射可验证。 **【C0 代码+合成达成、C1.1 达成；C1.2/C1.3 硬件阻塞，骨架就绪；C5/C6/D6 已完成】**

---

# Stage 4 —— 精密校正与资产体系（≈架构 Phase 2） ⬜ 未开始

> **路线判定（2026-06-10 复审）**：PrecisionCal 骨架是成熟组件的合理组装（固定 pose 多帧平均、Gray code、master 先验锁定、屏外真值、validation pose 均为行业标准实践），无更优根本替代；observability-gated refinement 与 residual attribution 两个创新件无行业先例，但已被正确设计为"gate 不过只报告不写入"，失败不毁底线。**不换路线，按以下顺序落地。**
> 内部顺序硬依赖：4.1/4.2（真值生产线）→ 4.3/4.4 → 4.6（attribution）→ 4.7（gate 全量）→ 4.8（session refinement）→ 4.9（PrecisionCal 本体）。4.5/4.10 按各自依赖插入。

## 4.1 LensCal 离线 chart（master lens 生产线，Level 5 资产入口）
- 问题：§10 精度链 "validation ≤0.5px" 前置的 master lens（0.1–0.3px）在当前体系无任何产出路径——三条 lens 来源全不达标（session 手填、--estimate-lens 为 session-coupled、tracker-free lens-cal 实测 RMS 1.76px）。
- 改法：`vpcal lens calibrate` 离线 chart 工作流（ChArUco/棋盘格 + 多视角引导 + robust 标定 + 留出图验证）；产物为带 `is_master: true` 标记的 master lens file（OpenLensIO 字段对齐），含标定条件元数据（focus 距离、光圈、日期）；接入 quick/precision 管线作为先验。Level 5 纪律：仅此入口可产 master，普通 session 永不隐式生成。
- 验收：chart 标定 RMS ≤ 0.3px 且留出图验证 ≤ 0.5px；master 文件经 schema 校验含完整元数据；`_walkthrough` 的 NIKKOR 镜头用此流程重标一次对照旧值。

## 4.2 ScreenGeoCal 接入接口（master screen，对接外部项目）
- 问题：ScreenGeoCal 已外移独立项目，但 `master_screen_mesh` 导入接口未定义——PrecisionCal 对着不精确屏先验做不出 §10 数字。
- 改法：**现在定义导入接口格式**：OBJ/JSON mesh + per-panel UV-to-XYZ map + 逐区域不确定度字段 + survey 来源元数据；`vpcal screen import` 扩展支持；screen 资产同样走 master/session 标记纪律。
- 验收：接口 schema + 样例文件入库；用手工测量的样例 mesh 走通导入→求解链。

## 4.3 入瞳偏移（entrance pupil offset）建模 —— 路线中唯一遗漏的物理量（原 C3.1）
- 问题：OpenLensIO 定义入瞳距离随 focus/zoom 变化（spec :138,195），OpenTrackIO 有 `entrancePupilOffset` 字段；vpcal 代码与架构文档零提及。LED volume 拍摄距离 2–5m，光轴方向几 cm 入瞳偏移=可见视差错误。
- 改法：`LensProfile` 增加 `entrance_pupil_offset_mm`（定焦：可合并进 T_C_from_B 一起解，文档注明该简并；变焦/变焦点：按 FIZ 表建模，挂 4.1 LensCal）；OpenTrackIO 导出填 `entrancePupilOffset`。
- 验收：仿真注入 30mm 入瞳偏移，建模后 validation RMS 恢复到与零偏移基线一致。

## 4.4 VP-HAP 精密图案（实现顺序调整 + LED gate 工程化，原 C3.2）
- 顺序调整：Gray code 时序 ID（兼作 C1 帧识别）→ LED lattice-aware centroid（"看得清单颗 LED"分支，LED 物理像素中心是天然亚像素特征，比 phase shift 稳）→ phase shift 最后（仅远距/长焦/低通场景）。
- QA gate 从名词变可计算指标：sampling ratio（px/LED 实测定义）、moiré risk、black grid visibility 各给计算式；**新增两个硬 gate**：曝光时间 ≥ N 个 LED PWM 调光周期（防条带/亮度抖动）、dot 饱和检测 + 曝光包围建议（当前检测器无饱和处理）。
- 验收：每个 gate 有单测 + 在真机 LED 实拍上至少各触发一次（真阳性验证）。

## 4.5 TimeCal 分级 gate（范围由 B3 结论裁剪）
- 架构原设计：Green/Yellow/Red 分级（genlock/PTP/timecode/scanout profile 完备度），gate PrecisionCal 准入并推荐采集模式。
- 执行约束：**B3 实验结论先行**——若静态 pose 主流程对时序不敏感，TimeCal 缩水为"运动采集模式（C1 视频流）的前置检查"；若敏感，按原设计实现。temporal delay 永不作为 BA 自由变量（纪律保持）。
- 验收：依 B3 结论出 TimeCal 范围说明 + 对应实现；timing gate 状态进入 QA 报告。
- 依赖：B3、C1。

## 4.6 Residual Attribution Engine 补全（产品差异化卖点，当前 2/5，原 C2）
- 现状：仅 lens radial 与 coverage 两类签名（`qa/reprojection.py:54-83`）；screen seam 聚集、tracking volume 漂移、timing 静止/运动差分无代码。
- 改法：按依赖序——#2 screen（残差按 marker 屏面位置聚类检验）→ #3 tracking（残差对 pose 位置/朝向回归）→ #4 timing（需 C1 运动采集数据才可观测）。每类签名输出"可疑误差源 + 建议动作"而非裸数字。
- 验收：B1 的 sweep 数据作为标注集——对每类注入误差，对应签名检出率 > 90%、误报 < 10%。
- 依赖：B1；#4 依赖 C1。

## 4.7 Observability Gate 全量（补 2/6 缺失判据）
- 现状：已实现 κ、covariance std、correlation、cross-subset 四判据；缺 #4 validation-pose residual（A4 完成后接入即可）与 #5 lock-one-solve-one ablation。
- 改法：A4 的 validation RMS 接入 gate 判据；新增 ablation——锁其他、单解目标参数，检验稳定性与改善。另：cross-subset gate 静默跳过问题修复（数据不足时记 `cross-subset check skipped` flag + confidence 封顶，对齐 fail-closed 纪律）；gate 阈值（`_STD_LIMIT`、30° 等模块常量）按 spec 承诺迁入 `LensEstimateConfig` 可配置。
- 验收：6 判据全可触发各有单测；阈值可配置免改码。
- 依赖：A4。

## 4.8 session residual/patch + master/session 分离导出
- 实现架构 §3.5 的 session_lens_residual / session_screen_patch：在 master 先验锁定下，经 4.6 归因 → 4.7 gate 放行 → one-at-a-time refine → validation pose 复验，仅写 session 工件，绝不覆盖 master（纪律一）。导出结构对齐架构 §8 calibration_package 布局（lens/screen/spatial/qa/export 分目录）。
- 验收：E2E——注入已知 screen 局部偏差，patch 求解后 validation RMS 下降且 lens validation 不恶化（gate 的"防互吸"用例）；master 文件 hash 在全流程后不变。
- 依赖：4.1、4.2、4.6、4.7。

## 4.9 PrecisionCal 本体
- 工作流（架构 §5.2）：master 先验加载 → VP-HAP 播放（C1 驱动）→ 多固定 pose 采集（中心/边缘/四角/不同距离）→ Precision SpatialCal（registration 为主）→ lens/screen session validation（4.8）→ validation pose 复验。
- **防再耦合落成类型约束（原 C3.3）**：Observation 增加 `kind: registration|dense_validation` 字段，registration solver 对 dense 类型硬拒收（raise）——§6.2 ⚠ 从文档纪律变为代码约束。
- **验收标准量化（原 C3.4）**：validation pose 集合最小构成（中心/四角/远近/角度覆盖各 ≥1）；test-retest 重复性：同条件两次独立标定，T_S_from_O 差 ≤ 1mm / 0.02°（数字待 B1 误差预算校准后定稿）。写入 QA 报告作为 PrecisionCal pass/fail 判据。
- **witness validation 可选项（原 C3.7）**：第二台已标相机同步拍摄 validation pattern，独立计算 camera-to-screen 残差与主相机交叉比对（只比较不求解，缺 witness 时跳过）。
- 验收：在真实 LED 墙 + master 资产条件下达成 §10 目标（validation ≤ 0.5px）或给出量化差距与归因。
- 依赖：4.1–4.8、C0、C1。

## 4.10 数据录制 runtime（原 C4，可与 Stage 3 并行启动）
- 问题：产品目标包含拍摄数据录制与后期支持，但架构 Phase 3 只有 post package（导出格式），无拍摄期间的录制组件。
- 改法：`vpcal record` 长驻进程——监听追踪流（复用 C1.1），应用当前 calibration（T_S_from_O / T_C_from_B / lens），按 timecode 持续写规范 OpenTrackIO JSONL（A1 修复后的规范帧），附 session 引用与 calibration hash；停止时产出 take 清单。
- 验收：与 tracksim 联调——模拟 1 小时追踪流录制无丢帧，输出通过 OpenTrackIO conformance 测试（复用 A1.3）。
- 依赖：A1、C1.1。

**⬜ 里程碑 M4（精密校正与资产体系）= 4.1–4.9 完成**：master 资产生产线可用、PrecisionCal 达标或量化差距、归因引擎 5 签名兑现。 **【未开始】**

---

# Stage 5 —— 工业级扩展（≈架构 Phase 3） ⬜ 未开始

> 目标：hero shot 与影视工业级交付。本 Stage 启动前重新评审优先级（届时已有真机数据与用户反馈）。

## 5.1 MV witness camera 常驻几何监测
- 永久棚常驻第二相机持续监测屏幕 sag/热漂移/panel 微动（架构 ScreenGeoCal 远期设计）；witness 自身需外参标定与尺度锚定。在 4.9 的 witness validation（轻量、只比较）基础上升级为常驻重建。
- 依赖：4.2 接口、4.9 witness validation 经验。

## 5.2 屏幕形变分级精修：per-panel rigid → B-spline
- **分级前置（防自由度爆炸，与纪律三自洽）**：先 per-panel rigid（6DoF/panel，observability gate 逐 panel 判定）；B-spline deformation 仅在 witness/survey 独立真值支撑下启用。
- 依赖：4.7、4.8、5.1。

## 5.3 dynamic screen residual patch
- 周期性捕获动态形变（演员走动、热漂移日内变化），依赖 5.1 常驻 witness。

## 5.4 rolling shutter / scanout 精解
- 依赖链（架构未表达，此处明确）：**C1 视频流（运动采集存在）→ 4.5 TimeCal → 本项**。静态 pose 流程不需要它。

## 5.5 multi-camera / witness 一等公民（schema 2.0）
- 数据模型从单相机假设升级为相机列表（D6 已预留边界）；多机位联合求解共享 T_S_from_O。这是 schema 2.0 破坏性变更的正主，集中在此一次完成。
- 依赖：D6、5.1。

## 5.6 重资产导出与后期包
- STMap forward/inverse EXR、UE Lens File、screen_uv_to_xyz.exr、Nuke/Flame/Houdini post package（消费 4.10 录制产物）。
- 注：OpenTrackIO JSONL 导出 Phase 1 已存在（A1 修复后即规范），不在本项范围——架构原清单"OpenTrackIO/OpenLensIO 全链导出"按具体格式拆解至此。
- 依赖：4.1（STMap 来自 master lens）、4.10。

## 5.7 镜头模型扩展：anamorphic 与 zoom/FIZ
- **anamorphic（原 C3.6）**：spec:546 曾承诺 Phase 2，按工作量列入本 Stage；在此之前 validate 阶段显式拒绝 anamorphic lens profile（当前已拒 k4–k6，同步处理），避免隐式承诺。
- **zoom/FIZ（原 C3.5）**：Stage 4 范围为"定焦 hero lens 先行"；zoom 按 FIZ 采样点循环标定在本 Stage 实现（入瞳随 zoom 建模已由 4.3 打底）。

**⬜ 里程碑 M5（工业级）= 按届时评审定义**。 **【未开始】**

---

## 执行顺序总览

```
Stage 1（最高优先级，完成前不开新功能）：
  A1（导出修复+conformance）│ A2（图案/检测）│ D1/D2/D5（卫生关键项）   ← 三线并行
     ↓
  A3（手眼：闭式初始化+分量纲先验）→ A4（validation pose）            ═ M1
     ↓
Stage 2：B1（sweep 误差预算）→ B2（真实追踪端到端）│ B3（时序论断）
         D3（文档+v2.2）│ D4（tracker-free QA）穿插                  ═ M2
     ↓
Stage 3：C0（LED 处理器校验，真 LED 墙前硬前置）
         C1（采集服务 1→2→3）│ C5（drift diff）│ C6（nDisplay）│ D6   ═ M3
     ↓
Stage 4：4.1/4.2（真值生产线）→ 4.3/4.4 → [4.5 按 B3 裁剪] → 4.6 → 4.7 → 4.8 → 4.9
         4.10（录制，可提前与 Stage 3 并行）                          ═ M4
     ↓
Stage 5：5.1 → 5.2/5.3 │ 5.4（依赖 C1+4.5）│ 5.5（schema 2.0）│ 5.6 │ 5.7  ═ M5
```

**里程碑**：
- M1（快速校正稳定）= Stage 1 全验收 → 导出可互操作、检测无系统偏差、手眼自动初始化、held-out 自证
- M2（实测可信）= Stage 2 完成 → 定量误差预算、主路径真实数据闭环、文档一致
- M3（现场可用）= C0+C1 完成 → ≤5min 零拷卡校正、真 LED 墙映射可验证
- M4（精密校正）= 4.1–4.9 完成 → master 资产线、PrecisionCal 达标、归因 5 签名兑现
- M5（工业级）= Stage 5 按届时评审

---

## 附录：架构 Phase 2/3 修订清单（供 D3 的 v2.2 收敛版执行）

2026-06-10 对账三处来源（架构 v2.0/v2.1 §11、Phase 1 实现规格散落承诺、当前实现状态）后的修订项，出 v2.2 时逐条处理：

**补进 Phase 2 清单**（架构原清单缺失，本文档已建任务）：
1. LED 处理器配置导入 + 1:1 映射验证（spec:924 已承诺，架构遗漏 → C0）
2. 采集/播放服务（QuickCal 用户流程承诺"播放图案"但无工程载体 → C1）
3. nDisplay export 回排（spec:1216 已推迟 Phase 2，v2.1:454 仍列 Phase 1 → C6）
4. 手眼闭式初始化（架构假设先验存在 → A3）
5. 入瞳偏移建模（→ 4.3）
6. drift 历史对比（QuickCal 用途含 daily drift check 但无对应功能 → C5）
7. witness validation 轻量前段（只比较不求解，从 Phase 3 拆出 → 4.9）

**补进 Phase 3 清单**：
8. 数据录制 runtime（产品目标含录制，Phase 3 只有 post package 格式 → 4.10，可提前）
9. anamorphic 镜头（spec:546 承诺 Phase 2，按工作量改列 Phase 3 并声明边界 → 5.7）

**状态修正**（按 v2.1 清单执行会重复排期）：
10. Quick Lens Refine（条件化）标记**已完成**（QLE，f53bcf4，含 pre/post gate + revert）
11. Observability Gate 标记**部分完成**（4/6 判据；缺项 → 4.7）
12. tracker-free 路径收编（不在任何 Phase；定位建议：Level 0–1 之间的无追踪诊断/屏间配准工具，产物按 session 资产纪律打标）

**表述修正**：
13. "OpenTrackIO/OpenLensIO 全链导出"（Phase 3）改写为具体格式名（STMap EXR、UE Lens File、nDisplay mesh → 5.6）——OpenTrackIO JSONL 导出 Phase 1 已存在
14. per-panel B-spline deformation 加分级前置：先 per-panel rigid，B-spline 仅在 witness/survey 独立真值支撑下启用（→ 5.2）
15. rolling shutter/scanout 精解标注依赖链：C1 视频流 → TimeCal → 本项（→ 5.4）
16. multi-camera 一等公民保留 Phase 3，但 schema 预留动作前置（→ D6）
17. 恢复 v2.0 §10 末被删的来源置信度风险标注段（D3 已列）

---

## 风险与未核实项

- A1.1 的 disguise 端实际导入行为未实测（disguise 知识库无 camera spatial calibration 专文）；修复后应找真实 disguise/UE 环境做一次消费端验证。
- A3 闭式手眼解在纯平移相机运动下旋转分量退化（经典退化构型）——实现已要求旋转轴多样性检查，退化时报 PreconditionError 并引导补拍。
- B2 用 ARKit 充当 tracker 时其自身漂移会进误差预算，结论只用于流程验证，不用于精度结论。
- LED 墙真机（摩尔纹/黑格/刷新/处理器链路）相关风险全部押后到 C0 之后的真机实测，当前所有精度数字仅在显示器/合成数据上成立。
- 4.5 TimeCal 的最终范围悬置于 B3 实验结论，Stage 4 排期时须先确认 B3 已完成。
