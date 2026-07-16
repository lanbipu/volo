# Changelog

本项目的所有重要变更记录于此文件。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

每个条目标注对应的 `contract_version`（见 [docs/schema-versions.md](docs/schema-versions.md)）。

## [Unreleased]

> `schema_version` 升至 **1.2**（A3.2 拆分先验权重，additive）。下列为 0.1.0 之后、
> 整改路线图（`docs/remediation-roadmap-v1.md`）Stage 1–2 及此前增量的全部变更。

### ⚠ Breaking（MarkerId 结构变更）

- **Marker 编码从 VP-QCP 24-bit 升级为 VP-QSP 32-bit**（`1f3a14b`）：`MarkerId` 从扁平
  24-bit（row 6 + col 8 + sub 2 + CRC 8）改为带 `screen_id` 的 32-bit 结构化编码，
  支持多屏 ID 不冲突。**破坏性**：旧 24-bit 图案 / 缓存的 `observations.jsonl` marker_id 不兼容，
  需用新版重新生成图案与检测。

### Added

- **Calibrate FPR additive schema fields**：`LensProfile.image_domain` 声明标定像素域，
  `LensProfile.lens_table` 预留 FIZ sample/interpolation 模型；`SolverConfig` 新增 staticity、
  hand-eye、scale diagnostic 与 marker uncertainty gates。旧 session 仍可读取，缺失像素域按
  `unknown` 处理并发出一次 QA warning。

- **Quick Lens Estimate（Level 2）**（`f53bcf4`）：`vpcal quick run --estimate-lens` 在无 master
  镜头时联合估计 lens + 空间配准，由 `qa/observability.py` 的可观测性 gate（κ / 协方差 / 相关性 /
  cross-subset）门控，pre/post gate + revert，产出带强制 identifiability 警告的 session-coupled 估计。
- **Tracker-free 校准**（`77dd3a1`、`2455640`）：`vpcal tracker-free lens-cal | spatial | verify | export` ——
  仅凭图案照片（无追踪系统）估计内参 + 多屏相对位姿 + 导出 OBJ。定位为 Level 0–1 无追踪诊断 / 屏间配准工具。
- **A4 held-out validation**：`SessionConfig.validation`（`holdout_frames` / `holdout_ratio`）；hold-out 帧
  不进求解，求解后独立算 `validation_rms_px`，写入 `CalibrationResult.quality` 与 `qa/reprojection.json`；
  `_confidence` 优先看 validation RMS；QLE post-gate 改用 validation RMS 防联合估镜头吸收误差。
- **B1 误差预算 sweep**：`vpcal simulate sweep` 扫各误差源（像素噪声 / tracker 平移·旋转噪声 /
  hand-eye 偏移 / outlier / 运动采集时序）→ 解 `T_S_from_O` 偏差敏感性表，产出 `docs/error-budget.md` + CSV。
  `SimulatorConfig` 新增 `tracker_noise_mm/deg`、`temporal_offset_frames`、`trajectory`（平滑扫掠）、
  `bake_dot_screen_space`（屏幕空间 dot 烘焙）、`handeye_perturbation`、`holdout_ratio`。
- **B3 时序敏感性结论**：`docs/error-budget.md` 含静态 vs 运动采集对照 + TimeCal（4.5）范围裁剪决策
  （运动采集对时序高度敏感 ~0.6 mm/ms，静态构造性免疫）。
- **C5 漂移监测**（`vpcal report diff`）：对比两份 result.json 的 T_S_from_O / T_C_from_B /
  validation RMS，输出平移/旋转漂移 + 阈值告警（默认 >2mm / >0.05°，`any_alert` 供脚本监控）。
- **C6 nDisplay 导出**（`vpcal export ndisplay`）：从 result.json 导出 LED 墙几何 + 标定变换
  （UE 左手系、cm），含操作指引 README；目标 UE 5.7。screens/cameras 用列表结构（D6 约定）。
- **C1.1 追踪实时接入**（`vpcal capture track`）：FreeD UDP / OpenTrackIO 监听，录带 timestamp 的
  tracking 流（`core/freed.py` D1 编解码 + `core/capture.py`）。`capture video`/`playback`（C1.2/C1.3）
  需采集卡 / 显示输出硬件，已搭骨架（抛 PreconditionError）。见 `docs/c1-capture-service.md`。
- **C0 LED 处理器画布校验**：`ScreenDefinition.processor`（input→physical 仿射映射）+
  `core/processor_check.py`（拟合 / 1:1 验证，合成可检出 1px 偏移）+ validate 阶段一致性检查。
  真 LED 墙验收延后，见任务说明。
- **D6 multi-camera schema 预留**：`docs/schema-versions.md` 划定 multi-camera 属 2.0 破坏性边界 +
  新增 schema 一律用列表结构（非单数字段）+ 新 schema 评审检查项。
- **A1 OpenTrackIO conformance 测试**：用官方 `OpenTrackIO_JSON_schema.json` 校验每条导出样本；
  新增内置 `"opentrackio"` 源坐标系，自家导出文件零 custom 声明即可读回；`--frame spec|ue` 选项。

### Changed

- **A1 OpenTrackIO 导出默认规范帧**：默认输出 RH / Z-up / Y=前向的规范帧（原写成 UE 左手帧）；
  畸变标签 `"D-U"` → `"Brown-Conrady U-D"`；`protocol.version` 改 3 元整数数组、`sampleId` 用 `uuid5`、
  `focalLength` → `pinholeFocalLength`、自定义键移入 `tracker.notes`。
- **A3.1 闭式手眼初始化**（`core/handeye.py`）：Park-Martin AX=XB 闭式解作 `T_C_from_B` 初值
  （含旋转轴多样性退化检查），`--handeye-init` 强制；先验差异大写 QA warning。
- **A3.2 先验权重分量纲**：`SolverConfig` 拆 `prior_weight_rotation` / `prior_weight_translation`
  （默认 σ=2° / 10 mm），两后端同步；旧 `tracker_to_camera_prior_weight` 保留为废弃别名；schema → 1.2。
- **D4 tracker-free QA**：`SpatialResult` 实际赋值 `rms_reprojection_a/b`（用 M_avg 反投影）+ per-image
  一致性离散度 + 逐图离群剔除；四元数数学并回 `transforms.py`（删重复实现）。
- **空间求解改进**（`6721681`、`b78d307`）：IPPE + LM refinement + 四元数平均；镜头标定默认 `CALIB_FIX_K3` 防过拟合。
- **⚠ simulate 渲染默认改为屏幕空间 dot 烘焙**（B1④，`bake_dot_screen_space=True` 默认）：`vpcal simulate`
  渲染的图像中 locator dot 现经完整透视投影链（更真实，含透视质心偏置），而非旧的"投影中心解析 splat"（无偏）。
  合成检测精度因此**故意更贴近真实**（求解仍收敛，全套测试通过）；依赖旧"亚像素完美"渲染基准的外部消费方会看到（正确但）不同的结果。`--no-images` 或 `bake_dot_screen_space=False` 可回退旧行为。
- **Marker 覆盖**（`602bcdd`、`9ddd153`、`1e7b123`）：移植 LMT marker-grid 算法提高显示屏覆盖密度；
  自动计算 `cabinet_size`；从 Screen A 列数自动推算 `offset-b`。

### Fixed

- **A2 图案 / 检测系统偏差**：图案 dot 按精确分数像素浮点 splat（消除整数量化 ~0.5–1 LED pitch 偏差）；
  亚像素质心改在带符号差分图上算（消除环境光梯度偏置）；confidence < 1.0 检测硬剔除并计入 QA
  `detection_rejected_topology`；Otsu 失败回退 adaptiveThreshold；inverted 帧缺失发 warning 不再静默退化。
- **D1 双后端一致性**：固定参数逐 observation 对比 C++/Python 残差（atol 1e-9）；修正 `solver_scipy.py`
  docstring（注明三处合法分歧点）。
- **D2 未接线配置**：`robust_loss`（cauchy/none）真正生效、非法值报错；`timeout_seconds` 强制；
  `capture_mode=dual_frame` 报 ConfigError reserved——不再静默忽略。
- **D5 小修集**：`line_number` 自然序排序 + 无零填充告警；重复 frame_id 两路径统一取首条；
  `observations.jsonl` 与真实图像并存显式报错；inlier 阈值标注像素语义。
- Codex review P2 修复（`34b2d1d`）；重名 OBJ 覆盖 + offset-b gap 常量修复（`9c13e7c`）。

## [0.1.0] - 2026-06-06

Phase 1 — QuickSpatialCal MVP 首个版本。`contract_version: 1.0`。

### Added

- **Session config**：Pydantic v2 数据模型，定义完整校正输入（images / tracking / screen / lens / solver）。
- **Screen 定义**：JSON 读写 + 从 OBJ mesh 导入；支持 `plane` 和 `arc`（垂直圆柱面段）两种几何类型，
  提供 UV → 3D 世界坐标的参数化映射。
- **VP-QCP 图案生成**（`pattern generate`）：Grid-Position 编码 marker field，
  24-bit 编码（row 6-bit + col 8-bit + sub_index 2-bit + CRC-8 8-bit），
  CRC-8/AUTOSAR（多项式 `0x2F`）校验，marker ID 即空间坐标；Normal / Inverted 双帧。
- **Marker 检测管线**（`detector.py`）：OpenCV 轮廓检测 + 透视校正 + 24-bit 解码 + CRC-8 校验
  + 局部拓扑一致性校验 + Gaussian 中心亚像素定位 + orientation dot 定向；
  可选 Normal − Inverted 帧差分。
- **相机投影模型**（`projection.py`）：Brown-Conrady 5 参数模型（k1, k2, k3, p1, p2），
  含主点偏移（`principal_point_offset_mm`），OpenCV 像素坐标约定。
- **Solver**：求解 `T_tracker_to_stage`（tracker 坐标系 → 舞台坐标系刚体变换）。
  自定义 C++ Ceres solver（CMake FetchContent 编译，Levenberg-Marquardt + Huber robust loss +
  `QuaternionParameterization`）；当 C++ module 不可用时自动降级为 `scipy.optimize.least_squares` fallback。
- **帧对齐**：图像 ↔ tracking 三种对齐策略（`frame_id` / `line_number` / `timestamp`）。
- **坐标系转换**：输入 tracking 数据从 `unreal` / `optitrack` / `vicon` / `freeDEuler` / `custom`
  坐标系单步转换到内部右手系。
- **数据验证管线**（`validator.py`，Stage 0）：文件存在性、tracking 合理性、帧对齐验证、
  lens 参数兼容性（拒绝 k4/k5/k6）、screen 几何一致性、pose 多样性预估。
- **simulate**（`simulate`）：生成 ground-truth 已知的合成数据集，用于端到端验证 solver 正确性
  （可配 pose 数、像素噪声、outlier 比例）。
- **QA 报告**（`report generate`）：reprojection error（global / per-pose / outliers / 直方图 +
  lens 残差签名检查）、coverage（sensor / screen / pose 分布）。
- **OpenTrackIO 导出**（`export opentrackio`）：将校正后 tracking 数据导出为 OpenTrackIO 格式 JSONL。
- **CLI**：遵循 [CLI_DESIGN_SPEC.md](../docs/CLI_DESIGN_SPEC.md)。
  命令树 `quick run` / `pattern generate` / `screen create` / `screen import` / `simulate` /
  `report generate` / `export opentrackio` / `manifest` / `schema` / `completion` / `version`；
  统一成功 / 错误 envelope，三档输出格式（text / json / ndjson），完整 exit code 体系。
- **Contract Manifest**：`vpcal manifest` 输出 canonical 接口契约（`contract_version: 1.0`）。

[Unreleased]: #unreleased
[0.1.0]: #010---2026-06-06
