# vpcal Quick Lens Estimate Implementation Specification

版本：1.1（draft）
状态：待评审 → 交付 Claude Code 执行
变更：v1.1 修复 Codex adversarial review 的 3 项 high 契约错误——(1) §7.1 OpenLensIO 投影偏移量纲（`−wshader/2` px → `−w/2` mm）；(2) §4.1 镜头参数块改 per-scalar，使 config 的部分子集（k1-only/cx-only）可被 `SetParameterBlockConstant` 精确兑现；(3) §5.3 #2 相关性 gate 改打 free 的 `T_S_from_O`（默认路径 tc 已固定，对常量算 ρ 无意义）+ fail-closed。v1.0 基于 3 独立方案 + 5 对抗验证综合。
基于：
- 架构文档 `../../docs/LED_VP_GeoCal_Final_Architecture_v2.1.md` §4 Level 2、§5.1、§3.5、§7 纪律一/三
- Phase 1 spec `../../docs/vpcal_phase1_implementation_spec.md`（本 spec 复用其全部基础设施，只增量定义镜头估计）
范围：在现有 QuickSpatialCal 上，**追加无 master lens 时的 Quick Lens Estimate（架构 Level 2）**，使用户一次 `vpcal quick run` 即完成**镜头校正 + 空间校正**。

> 本文档是**独立增量 spec**，不修改 Phase 1 spec（那是已实现、已冻结的工件，明确写了 "lens：仅 import + validation；NO Quick Lens Refine"）。本能力在架构 §11 路线图中属 Phase 1.5/2。开发在 `feature/quick-lens-estimate` 分支 + worktree 进行。

---

## 0. 概述

### 0.1 它是什么

Phase 1 把 lens 当作**固定输入**：用户必须提供完整 `LensProfile`（焦距 + sensor + 畸变系数），solver 只求解 `T_S_from_O`（tracker→stage 刚体变换）。当现场**没有 master lens profile**（未知镜头、变焦头、临时机位）时，Phase 1 无法工作或被迫填入不准的镜头参数，污染空间校正结果。

Quick Lens Estimate 让 solver 在**同一个 bundle adjustment 问题**里，把镜头的一部分参数（畸变 `k1`/`k2`、主点 `cx`/`cy`、可选焦距）也变成自由变量，与 `T_S_from_O` 联合求解。产出一份 **session-coupled quick lens estimate**：

- 永远标记 **非 master**（`is_master=false`）、**session 耦合**（`session_coupled=true`）；
- QA 永远附带 **identifiability warning**（即使所有 gate 通过）；
- **绝不跨棚/跨机位复用**，**绝不导出为 master lens 工件**（架构 §7 纪律一）。

### 0.2 为什么在 vpcal 里这件事可解（关键洞察）

纯 uncalibrated SfM 中，每帧外参是自由变量，焦距与尺度/距离存在简并（focal↔depth ambiguity），所以"未知靶标定未知镜头"是病态的。

**vpcal 不同**（对抗验证 Verdict 1 已确认）：

- 每帧外参由 tracking 钉死——每条 observation 携带实测的 `T_sdk`（= `T_O_from_B`），不参与优化；
- `T_C_from_B`（camera-from-tracker）默认 `SetParameterBlockConstant` 固定（`solver.cpp:58-59`）；
- marker 3D 坐标来自 screen 定义，**物理尺度已知**。

因此世界尺度被屏幕真实尺寸锚定，焦距-尺度简并被打破，镜头内参在原理上**可观测**。代价（架构反复强调、也是 Level 2 必须打 warning 的根因）：screen 几何误差 / tracking 误差会被**吸收进镜头参数**。本 spec 的核心差异化即在于用 Observability Gate（§5）把这种吸收检出并拦截，而非盲目相信求解结果。

### 0.3 一句话目标

```
无 master lens 时，用户在 LED 屏上播放 VP-QCP、移动相机扫一遍，
一次 `vpcal quick run --estimate-lens` 即同时得到：
  rough lens estimate（k1/k2/cx/cy[/focal]，带 identifiability 判级）
  + T_tracker_to_stage 空间对齐
  + QA 残差归因 + observability 报告。
默认关闭时，行为与 Phase 1 逐位一致。
```

---

## 1. 范围与非目标

### 1.1 范围（本 spec 定义）

| 项 | 内容 |
|----|------|
| 自由镜头参数 | `k1`、`k2`、`cx`、`cy`（默认子集），`focal_length_mm`（opt-in） |
| 求解策略 | 单问题联合 BA，lens 参数块化 + `SetParameterBlockConstant` |
| 初始化 | PnP（复用）+ nominal lens；可选 `cv2.calibrateCamera` bootstrap（仅初始化） |
| Observability Gate | pre-solve + post-solve 两阶段 gate，新模块 `qa/observability.py` |
| 输出 | `EstimatedLens` 块（schema 1.0→1.1）、`qa/lens_observability.json`、text 摘要 |
| 导出 | OpenTrackIO/OpenLensIO 转换 + session-coupled 标记 + 禁止 master 导出 |
| 配置/CLI | `LensEstimateConfig`（嵌入 `SolverConfig`）+ `--estimate-lens` 等 flag |
| 测试 | simulator 注入 ground-truth lens、recovery / gate / parity / 向后兼容 |

### 1.2 非目标（明确不做）

- ❌ `k3`、`p1`、`p2`（切向）在 Level 2 **永远锁 0**（见 §2.2 理由；切向需 Phase 3）。
- ❌ 完整 lens distortion map / STMap 求解（属 PrecisionCal / LensCal）。
- ❌ anamorphic / fisheye / OpenLensIO rational(k4-k6) 模型（Phase 2 LensCal）。
- ❌ 把估计结果写成 master lens file（架构 §7 纪律一硬禁止）。
- ❌ FIZ-mapping、zoom/focus 插值（属 LensCal）。
- ❌ 改动 Phase 1 的变换链、坐标系、图案、检测、帧对齐（全部**原样复用**，见 Phase 1 spec §5.1/§6/§7/§3.6/§10）。

### 1.3 复用 Phase 1（不重复定义）

以下来自 Phase 1 spec，本 spec **不修改**：
- 变换链 `pixel = project(lens, T_C_from_B · inv(T_sdk) · inv(T_S_from_O) · M_rh_from_ue · P_stage_ue)`（`core/transforms.py`）
- 坐标系策略 / `M_rh_from_*`（`core/coordinates.py`）
- VP-QCP 图案 + marker 编码 + 检测（`core/pattern.py` / `core/detector.py`）
- 帧对齐 frame_id/line_number/timestamp（`io/frame_matching.py`）
- Brown-Conrady 投影 `project_points` / `distort_normalized`（`core/projection.py`，§5.5 公式）

---

## 2. 算法设计

### 2.1 问题陈述

在 Phase 1 的最小化目标上追加镜头自由变量：

```
min over { T_S_from_O, [T_C_from_B delta], lens_free }
    Σ_obs  ρ_huber( || project(lens(lens_free), chain(T_S_from_O, T_sdk_obs, T_C_from_B)) − pixel_obs || )
    + prior(T_C_from_B)            # 已有，refine_C 时
    + prior(focal)                 # 新增，refine_focal 时（Gaussian）
```

`lens_free` 是被选中放开的镜头参数子集；未放开的部分锁在 nominal/0。**这是一个单一 Ceres `Problem`，不是交替迭代**（理由见 §2.4）。

### 2.2 自由变量与默认值

| 参数 | 内部表示 | Level 2 默认 | gate | 说明 |
|------|----------|--------------|------|------|
| `k1` | dist block[0]（normalized 坐标，与现 k1 同单位） | **free** | §5.2 边缘覆盖 + spatial RMS | 径向一阶，最主要畸变 |
| `k2` | dist block[1] | **free**（与 k1 成对） | 同 k1，且后验 gate 须双双通过 | k2 单独无意义；config 校验拒绝"只放 k2" |
| `cx` | center block[0]（px） | **free** | §5.2 角度展开 + corner 覆盖 + 与 refine_C 互斥 | 主点 X |
| `cy` | center block[1]（px） | **free** | 同 cx | 主点 Y |
| `focal_length_mm` | focal block（1 DoF） | **fixed**（opt-in `refine_focal`） | §5.2 + \|ρ(focal,tz)\|<0.8 + ±3% Gaussian prior | 见下方决策说明 |
| `k3` | — | **锁 0** | — | 仅极端半径有效，moving-capture 难可靠覆盖 |
| `p1`,`p2` | — | **锁 0** | — | 切向与 `T_C_from_B` tilt confound，平面墙近不可观测（Verdict 5） |
| `sensor_w/h_mm`,`image_w/h_px` | — | **固定** | — | 由用户/EXIF 提供，非求解量 |

**默认 `params = {k1, k2, cx, cy}`。**

> **焦距默认 fixed 的理由**（§15-1，用户已确认）：Verdict 1 确认焦距**可观测**，故它不是硬性"永不放开"；但 (a) 架构 §5.1 原文只列 "K1/K2 / center / offset"，未列焦距；(b) 当 screen mesh 存在尺度误差时，焦距是**最危险的误差吸收器**（focal↔standoff 残差耦合）。因此默认 fixed，作为带 ±3% Gaussian prior + 相关性 backstop 的 opt-in。

> **k2 默认进子集的理由**（§15-2，用户已确认）：依架构 §5.1 原文 "K1/K2" 字面 → 默认 `{k1,k2,cx,cy}`。k2 可观测性弱于 k1、依赖良好的边缘覆盖，但本就由 §5.2 边缘半径覆盖 gate 与 §5.3 后验协方差/跨子集一致性把关——覆盖不足时 k2（连同 k1）会被 gate 锁回/revert，因此默认放开是安全的，且更贴合架构意图。

### 2.3 初始化（解决 chicken-and-egg）

三步，全部在现有代码上增量：

```
1. T_S_from_O 种子：复用 solver.py:62 pnp_initial_tracker_to_stage(observations, nominal_intr, init_C)
   —— 用 nominal lens 做 RANSAC PnP，得到 T_S_from_O 初值。不变。

2. [可选] cv2.calibrateCamera bootstrap（默认 off，Verdict 2 确认为合理的独立初始化器）：
   - 把每帧的 (world_rh, pixel) 重打包为 objectPoints/imagePoints
   - K0, dist0, _, _ = cv2.calibrateCamera(objectPoints, imagePoints, imageSize, None, None, flags=...)
   - 仅取 K0 的 cx/cy 与 dist0 的 k1/k2 作为 lens_free 初值；其 per-view 外参丢弃（在 cv2 帧，非 T_S_from_O）
   - 取到后用 K0 重跑一次 PnP 精化 T_S_from_O 种子
   - 任一步 cv2 发散/失败 → 回退 nominal，记 warning（不阻断）
   - sanity clamp：bootstrap 出的 focal 若被请求，钳到 nominal ±2% 内才接受

3. lens_free 初值兜底：cx/cy 来自 principal_point_offset_mm，k1=k2=0，focal=nominal。
```

> bootstrap 的简并（单平面墙 + 恒定朝向 → K 与外参耦合，Verdict 2）正是 §5.2 pre-solve 的 angular-spread / 边缘覆盖 gate 要拦截的；bootstrap 仅作初值，联合 solve 可从坏初值移开，故风险可控。

### 2.4 为什么是单问题联合求解，而非交替迭代

设计阶段曾考虑"固定 pose 解 lens / 固定 lens 解 pose"交替外循环。**否决**，理由：

1. 交替迭代与联合 BA **不数值等价**，可能震荡（其本身列为风险）；
2. 破坏 Ceres↔scipy parity 契约（两后端难保证一致收敛）；
3. Verdict 4 确认：lens 参数块化 + `SetParameterBlockConstant` 与现 const 路径**数值等价**，单问题求解既简单又能保证 Phase 1 逐位不变。

架构 §3.5.2 的 "lock-one-solve-one ablation" 在本 spec 中**降级为 post-solve 诊断**（§5.3 #5），不是求解机制。

---

## 3. 配置与 CLI

### 3.1 `LensEstimateConfig`（`models/session.py`，嵌入 `SolverConfig`，默认禁用 = Phase 1 行为）

```python
class LensEstimateConfig(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    enabled: bool = False                       # 总开关（Level 2）
    params: set[Literal["k1", "k2", "cx", "cy"]] = Field(default_factory=lambda: {"k1", "k2", "cx", "cy"})
    refine_focal: bool = False                  # opt-in 焦距（+1 DoF + Gaussian prior）
    focal_prior_weight: float = Field(default=1000.0, gt=0)
    principal_point_margin_mm: float = Field(default=5.0, ge=0.0)   # cx/cy 边界（mm，对齐 LensProfile 单位）
    k_bounds: tuple[float, float] = (-0.5, 0.5)
    cv2_bootstrap: bool = False                 # 仅初始化（Verdict 2）

    # Observability gate 阈值（作为架构约束记录，非魔法数；全部可调、QA 打印实测 vs 阈值）
    min_poses: int = 8
    min_observations: int = 60
    min_edge_obs_fraction: float = 0.25         # ≥25% obs 的像素半径 > 0.35·image_diagonal（Verdict 5）
    edge_radius_fraction: float = 0.35
    max_spatial_rms_px_for_center: float = 2.0
    max_spatial_rms_px_for_k: float = 1.0
    condition_number_limit: float = 1.0e4
    correlation_limit: float = 0.8
    cross_subset_k_abs_delta: float = 0.05      # |Δk1| 跨子集
    cross_subset_k_rel_delta: float = 0.30      # 或 |Δk1|/|k1|
    min_improvement_pct: float = 3.0            # 相对 spatial-only baseline RMS

class SolverConfig(BaseModel):
    # ... 现有字段不变 ...
    lens_estimate: LensEstimateConfig = Field(default_factory=LensEstimateConfig)
```

`SessionConfig.lens` 仍是必填的 `LensProfile`——在 estimate 模式下，它提供 **nominal/初值 + 固定的 sensor/image 尺寸**（焦距 mm、sensor mm、分辨率 px 必填，因为 fx/fy 的 mm↔px 映射、focal prior 都依赖它们）。

### 3.2 Config 校验规则（fail fast，`ArgumentError` → exit 2）

```
- params 含 "k2" 但不含 "k1"            → 拒绝
- enabled=true 且 refine_focal=true 且 lens.focal_length_mm<=0   → 拒绝
- enabled=true 且 refine_tracker_to_camera=true 且 ({"cx","cy"} ∩ params)
      → 强制从 free 集合移除 cx/cy + 记一条 identifiability_flag（Verdict 3 硬互斥），不阻断
- 请求 p1/p2/k3（不在 Literal 内）        → pydantic 直接拒绝
```

### 3.3 CLI（`cli/quick.py`，house 契约不变）

新增 flag（覆盖 JSON config，沿用既有覆盖优先级；`AI_AGENT=1` 仍默认 `--output json`）：

```
vpcal quick run --config session.json \
  --estimate-lens \                  # → lens_estimate.enabled=true
  --lens-params k1,k2,cx,cy \        # → 覆盖 params 集合
  --refine-focal \                   # → opt-in 焦距
  --cv2-bootstrap \                  # → opt-in 初始化
  --output json
```

> 注：实际 CLI 入口当前用 `--config`（`cli/quick.py` 的 `@click.option("--config", ...)`），非位置参数；本 spec 以真实代码为准。

### 3.4 session.json 片段（Level 2）

```json
{
  "lens": {
    "focal_length_mm": 35.0,
    "sensor_width_mm": 36.0,
    "sensor_height_mm": 24.0,
    "principal_point_offset_mm": [0.0, 0.0],
    "image_width_px": 3840,
    "image_height_px": 2160,
    "distortion": { "model": "brown_conrady", "k1": 0.0, "k2": 0.0, "k3": 0.0, "p1": 0.0, "p2": 0.0 }
  },
  "solver": {
    "refine_tracker_to_camera": false,
    "lens_estimate": {
      "enabled": true,
      "params": ["k1", "k2", "cx", "cy"],
      "refine_focal": false,
      "principal_point_margin_mm": 5.0,
      "cv2_bootstrap": false
    }
  }
}
```

---

## 4. Solver 改造

### 4.1 C++（Ceres）—— 单问题参数块化

**`cost_functions.h`：**

1. `ReprojectionCost` 不再持有 `const LensParams lens_` 作为编译期常量，改为把每个镜头标量按**独立单元素参数块**传入：新增 `operator()` 签名
   ```cpp
   template <typename T>
   bool operator()(const T* qs, const T* ts, const T* qc, const T* tc,
                   const T* focal /*[1] focal_length_mm*/,
                   const T* cx /*[1] px*/, const T* cy /*[1] px*/,
                   const T* k1 /*[1]*/, const T* k2 /*[1]*/, T* residual) const;
   ```
   > **为何 per-scalar 而非把 `[cx,cy]`/`[k1,k2]` 各打成一块（adversarial review 发现）**：`config.params` 是 `set[Literal["k1","k2","cx","cy"]]`，**允许部分子集**（如 `{k1}` 单独放、`{cx}` 单独放——k1-only 是最保守的合法畸变模型）。而 `SetParameterBlockConstant` 冻结的是**整块**，无法表达"放开 cx 锁 cy"。故每个标量独立成块，逐个 `SetParameterBlockConstant` 才能精确兑现任意子集；这同时与 §4.2 scipy 的逐标量状态向量天然对齐。
   函子成员保存**固定的** nominal sensor/image 尺寸（`sensor_w_mm_`, `sensor_h_mm_`, `image_w_px_`, `image_h_px_`）与锁死的 `k3_=p1_=p2_=0`。内部：
   ```cpp
   LensParams lens;
   lens.fx = focal[0] * T(image_w_px_) / T(sensor_w_mm_);
   lens.fy = focal[0] * T(image_h_px_) / T(sensor_h_mm_);
   lens.cx = cx[0]; lens.cy = cy[0];
   lens.k1 = k1[0]; lens.k2 = k2[0];
   lens.k3 = T(0); lens.p1 = T(0); lens.p2 = T(0);
   project(lens, p_cam, &u, &v);   // project() 原样不变（lines 21-34）
   ```
   链路其余部分（lines 53-78）**逐字不变**。
2. AutoDiff 维度：`ceres::AutoDiffCostFunction<ReprojectionCost, 2, 4,3,4,3, 1,1,1,1,1>`（residual 2；qs4 ts3 qc4 tc3；focal1 cx1 cy1 k1_1 k2_1）。
3. 新增 `LensFocalPriorCost`（镜像 `CameraPriorCost`，lines 93-127）：`residual = sqrt(weight) * (focal[0] - focal_nominal)`，仅 `refine_focal` 时挂上。

**`solver.cpp`：**

1. 维护 5 个标量 lens 块 `double focal[1], cx[1], cy[1], k1[1], k2[1]`，初值来自 `LensFree`（见 `solver.h`）。每个 residual block `AddResidualBlock(ReprojectionCost::Create(...), loss, qs, ts, qc, tc, focal, cx, cy, k1, k2)`。
2. 对**不在 free 集合**的每个标量块：`problem.SetParameterBlockConstant(block)`（与 qc/tc 在 lines 58-59 完全相同的模式，Verdict 4 已证等价）。per-scalar 冻结 → 任意子集（含 k1-only / cx-only）均可精确表达。
3. free 时加边界/prior：
   - `cx`/`cy`：各自 `SetParameterLowerBound/UpperBound`，margin = `principal_point_margin_mm * image_w_px / sensor_w_mm`（cx；cy 用 `image_h_px/sensor_h_mm`），单位 px；
   - `k1`/`k2`：各 bound 到 `k_bounds`（默认 [-0.5, 0.5]）；
   - `focal`：`LensFocalPriorCost` 残差块（权重 `focal_prior_weight`），软约束在 nominal ±3% 量级。
4. covariance：把 free 的标量块加入协方差 block 列表（扩展 lines 103-104），输出每参数 std，并计算每个 free 镜头标量与**当前 free 空间参数**（见下 SolverResult）的相关系数。

**`solver.h` / `bindings.cpp`：**

- 新增 `struct LensFree { bool free_focal, free_cx, free_cy, free_k1, free_k2; double focal0, cx0, cy0, k1_0, k2_0; double pp_margin_x_px, pp_margin_y_px, k_lo, k_hi, focal_prior_weight; };`，经 `solve()` 传入；默认 `LensFree{}`（全 fixed）使**现有 5 参数 `solve()` 调用点不变**。
- `SolverResult` 扩展：`lens_focal`, `lens_cx`, `lens_cy`, `lens_k1`, `lens_k2` 估计值 + 对应 std；以及供 §5.3 #2 gate 用的相关性——**针对实际 free 的空间参数**：每个 free 镜头标量对 `T_S_from_O` 的 6 个切空间分量（3 平移 + 3 旋转）取 `max |ρ|`；仅当 `refine_C=true` 时另含对 `T_C_from_B` 平移的 ρ。字段如 `corr_cx_vs_TS`, `corr_cy_vs_TS`, `corr_focal_vs_TS`（及可选 `corr_*_vs_tc`），并带 `corr_available` 标志（不可得 → §5.3 fail-closed）。

### 4.2 scipy fallback（`solver_scipy.py`）—— 同构扩展状态向量

- `solve()` 增参 `lens_free: LensFree | None`。状态 `x` 从 `[rotvec_S, t_S, (rotvec_C, t_C)]` 末尾按**固定 canonical 顺序**追加 `[focal?, cx?, cy?, k1?, k2?]`（仅 free 的）。
- `residuals()`（lines 123-133）内每次迭代重建 `CameraIntrinsics`（frozen dataclass → 构造新实例），只覆盖 free 字段，其余取 nominal；复用 `_reproject`（line 92）+ `project_points`，**保证与 Ceres 同一残差**。
- focal prior：追加残差行 `sqrt(focal_prior_weight) * (focal - focal0)`（与 camera prior 同模式，line 129）。
- bounds：`least_squares(..., bounds=(lo, hi))`，仅约束 free 维度（center ±margin、dist ∈ k_bounds、focal ±box）。
- covariance：scipy 仍无法给完整后验协方差（Phase 1 已有此缺口）。lens std 从 `sol.jac` 的 `JᵀJ` 近似（best-effort）；不可得时置 `None`，触发 §5.6 降级。

### 4.3 向后兼容保证（硬约束）

`lens_estimate.enabled=false`（默认）时，free 集合为空，三个 lens 块全 `SetParameterBlockConstant` 且初值 = nominal → `project()` 收到与今天完全相同的镜头值 → **结果逐位一致**（<<0.01px，Phase 1 的 146 测试保持绿）。Pipeline 在 `enabled=false` 时**完全走旧路径**（不跑 baseline、不跑 gate、`quality.lens_estimate=None`）。

### 4.4 Ceres↔scipy parity 契约（硬测试）

同一合成数据，两后端须一致：`k1` 差 < 0.01、`cx/cy` 差 < 0.5px、`focal` 差 < 0.3%、`final_cost` 差 < 1%。与现有 fallback parity 测试同纪律（C++ 未编译时 graceful skip）。

---

## 5. Identifiability / Observability Gate（核心差异化）

实现架构 §3.5.2「先归因后放行」、§7 纪律三。**新模块 `qa/observability.py`。**

### 5.1 两阶段 gate 总览

```
Step A  spatial-only baseline solve（lens 全固定）—— 总是先跑、总是记录
          产出 baseline RMS、condition number κ；同时是"全部 lens 自由被拒"时的兜底结果
Step B  determine_lens_freedom()  —— PRE-SOLVE：用 baseline + 覆盖率 决定哪些参数可放开
Step C  joint solve（放开 Step B 选中的参数）
Step D  validate_lens_estimate()  —— POST-SOLVE：对每个放开的参数判定是否"保留"
Step E  对被 revert 的参数锁回 → warm-start 重解（cheap），保证报告的 transform 与报告的 lens 自洽
```

### 5.2 PRE-SOLVE gates（`determine_lens_freedom()`）

针对 baseline 求解评估：

| # | 针对 | 判据 | 阈值（默认） | 不通过 |
|---|------|------|--------------|--------|
| 1 | 全部 | 法方程/Hessian 条件数 κ | κ ≥ `condition_number_limit`(1e4) | 拒绝**全部** lens 自由 |
| 2 | cx,cy | 角度展开（复用 `coverage._pose_distribution`） | angular_spread ≥ 30° | 锁 cx/cy |
| 2 | cx,cy | sensor 区域（复用 `coverage._sensor_coverage`） | center + 四角齐全 | 锁 cx/cy |
| 2 | cx,cy | pose/obs 数 | ≥`min_poses`(8) 且 ≥`min_observations`(60) | 锁 cx/cy |
| 2 | cx,cy | baseline RMS | < `max_spatial_rms_px_for_center`(2.0) | 锁 cx/cy |
| 2 | cx,cy | **硬互斥** | `refine_tracker_to_camera=true` | 强制锁 cx/cy（Verdict 3） |
| 3 | k1,k2 | **边缘半径覆盖**（新，Verdict 5） | ≥`min_edge_obs_fraction`(25%) 的 inlier obs 像素半径 > `edge_radius_fraction`(0.35)·image_diagonal（半径从当前 cx,cy 量） | 锁 k1/k2 |
| 3 | k1,k2 | baseline RMS | < `max_spatial_rms_px_for_k`(1.0) | 锁 k1/k2 |

任一参数失败 → 保持锁定，原因写入 `identifiability_flags`。`qa/reprojection.py::_lens_residual_check` 的径向残差检测作为 **secondary 佐证信号**（不是唯一 gate）。

### 5.3 POST-SOLVE gates（`validate_lens_estimate()`）

joint solve 后，对每个放开的参数：

1. **协方差**（Ceres 协方差块 / scipy JᵀJ⁻¹）：std 过大 → revert。`σ_cx,σ_cy > 5px` → revert；`σ_k1 > 0.15` → revert；`σ_focal/focal > 0.03` → revert。
2. **相关性 backstop**（§3.5.2 #3）——**针对实际 free 的空间参数**（adversarial review 修正）：
   - 默认路径 `refine_tracker_to_camera=false` 时 `T_C_from_B`(tc) 被 `SetParameterBlockConstant` 固定，对**常量**算 ρ 无意义；cx/cy 此时仍 free，其真正混淆源是 **free 的 `T_S_from_O` 平移/旋转**。故 gate 用 `max|ρ(cx, T_S_from_O 切空间分量)|`（cy/focal 同理，focal 重点看与 standoff 方向的 T_S 平移）> `correlation_limit`(0.8) → revert。
   - `refine_C=true` 时 cx/cy 已被 §3.2 硬锁，故那条 tc 耦合路径不出现；若放开 focal，则同时检 `|ρ(focal, T_S 平移)|` 与 `|ρ(focal, tc)|`。
   - **fail-closed**：相关性数据不可得（`corr_available=false`，典型为 scipy 后端无完整协方差）→ 不放行该参数（按未通过处理）或至少 confidence 封顶 medium（见 §5.6），绝不"默认通过"。
   - 须有测试：`refine_tracker_to_camera=false` 且 cx/cy 与 `T_S_from_O` 平移共线时，gate 能 revert（见 §10.1）。
3. **跨子集一致性**（§3.5.2 #6，Verdict 5——最强的"误差吸收"检出器）：把 pose 二分，各自独立精化放开的畸变参数；`|Δk1| > cross_subset_k_abs_delta`(0.05) 或 `|Δk1|/|k1| > cross_subset_k_rel_delta`(30%) → revert k1（连带 k2）。真镜头属性 pose-invariant，被吸收的误差不是。
4. **改善检查**：global RMS 须较 baseline 下降 ≥ `min_improvement_pct`(3%)，否则该参数在拟合噪声 → revert。
5. **lock-one-solve-one ablation**（§3.5.2 #5）：可选，仅 `--verbose`（贵），报告但默认不阻断。

### 5.4 revert 后重解

任一放开参数被 revert → 用缩小的 free 集合 warm-start 重解一次（廉价），使 `result.json` 报告的 `tracker_to_stage` 与报告的 lens **自洽**。

### 5.5 ALWAYS-ON identifiability warning（不可协商，§7 纪律一）

只要 `lens_estimate.enabled=true`，**无论所有 gate 是否通过**：

- QA 顶层置 `quality.lens_observability_warning=true`；
- text 报告打印醒目的 **SESSION-COUPLED / NON-MASTER / DO-NOT-CROSS-STAGE** 区块；
- gate 全过只提升 confidence 标签（high/medium/low），**永不移除 warning**；
- **不提供 `--force` 覆盖**（架构纪律在代码层强制；专家要 master 走 Level 5 离线 chart 标定，不在本 spec）。

### 5.6 scipy 无 covariance 的降级

scipy 后端拿不到完整后验协方差时：跳过 §5.3 #1 协方差 gate；#2 相关性若能从 `sol.jac` 的 `JᵀJ` 近似则用近似值（针对 free 空间参数，见 §5.3 #2），否则按 **fail-closed**（不放行该参数）；主要依赖 cross-subset(#3) + improvement(#4)；confidence **上限封顶 medium**。须作为文档化的 graceful degradation。

---

## 6. 输出 schema

### 6.1 `models/calibration.py` 改动（`schema_version` "1.0" → "1.1"，新字段全部 optional/None 兜底，解析方须容忍）

```python
class EstimatedLensParam(BaseModel):
    value: float
    std: float | None = None
    observable: bool                 # 通过全部 gate 且被保留
    locked_reason: str | None = None # 未放开/未保留时的原因

class EstimatedLens(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    is_master: bool = False          # 恒 False
    session_coupled: bool = True     # 恒 True
    focal_length_mm: EstimatedLensParam | None = None              # 仅 refine_focal
    principal_point_offset_mm: tuple[EstimatedLensParam, EstimatedLensParam] | None = None
    distortion_k1: EstimatedLensParam | None = None
    distortion_k2: EstimatedLensParam | None = None
    spatial_only_rms_px: float       # baseline，供 improvement 审计
    refined_rms_px: float
    identifiability_flags: list[str] # 人类可读 gate 判词
    confidence: Literal["high", "medium", "low"]

class Quality(BaseModel):
    # ... 现有字段不变 ...
    lens_estimate: EstimatedLens | None = None       # Phase 1 模式下 None
    lens_observability_warning: bool = False         # 有 lens_estimate 时恒 True
```

`CalibrationResult` 顶层不加字段（估计内嵌于 `quality`，比并列顶层字段更简洁）；`is_master`/`session_coupled` 落在 `EstimatedLens` 自身。

### 6.2 新文件 `qa/lens_observability.json`（仅 enabled 时写）

每参数一条记录：`pre_solve` gates `{metric, threshold, value, verdict}`、精化值+std、`post_solve` gates `{covariance, correlation_pairs, cross_subset_delta, improvement_pct, verdict: ACCEPTED|REVERTED}`，及 `summary`：`params_kept` / `params_reverted` / `identifiability_flags` / `confidence` / 强制的 session-coupled 建议文本 + 条件数 + 观测计数（audit trail）。

### 6.3 `qa/reprojection.json` 增强

新增 `spatial_vs_lens_refined: {spatial_only_rms_px, refined_rms_px, improvement_pct}`，使改善审计可见。现有 `lens_residual_check` 保留（现在兼作 pre-solve 佐证信号）。

### 6.4 text 输出（`cli/quick.py::_render_text`）

新增 "QUICK LENS ESTIMATE (Session-Coupled, Non-Master)" 区块：逐参数 KEPT(`value ± std`) 或 REVERTED/LOCKED(`reason`)；"OBSERVABILITY" 子块列每个 gate PASS/FAIL 的**实测 vs 阈值**数值；结尾恒打 DO-NOT-CROSS-STAGE 警告 + "如需高精度可复用资产，请走离线 chart 标定 / Level 5"。

---

## 7. 导出（OpenTrackIO / OpenLensIO）

### 7.1 vpcal Brown-Conrady(pixel) → OpenLensIO(mm) 转换

来源 `../../docs/OpenCV_to_OpenTrackIO.md`。OpenLensIO 系数 **mm 归一化、与分辨率/sensor 无关**：

```
F_mm = (w/wshader)·fx = (h/hshader)·fy                 # 焦距（vpcal 直接有 focal_length_mm）
∆Px  = (w/wshader)·cx − w/2 = w·(cx/wshader − 0.5)      # projectionOffset.x（mm，原点屏幕中心）
∆Py  = (h/hshader)·cy − h/2 = h·(cy/hshader − 0.5)      # projectionOffset.y（mm）
l1 = k1/F²,  l3 = k2/F⁴,  l5 = k3/F⁶                   # 径向（分子）
q1 = p1/F²,  q2 = p2/F²                                 # 切向
（w,h = sensor mm；wshader,hshader = 分辨率 px；cx,cy = px 原点左上）
```

> ⚠ **量纲修正（adversarial review 发现，必须用此式）**：参考文档 `OpenCV_to_OpenTrackIO.md` 把第二项写作 `− wshader/2`（px），与第一项 `(w/wshader)·cx`（mm）量纲不一致——对 3840px 居中主点会算出 `≈18mm − 1920` 这种荒谬值，schema 校验却看似合法。正确的 sensor-space 形式是 `∆Px = (w/wshader)·cx − w/2`（两项皆 mm），等价于 `w·(cx/wshader − 0.5)`；居中主点 `cx=wshader/2` 时 `∆Px=0`。**实现必须用修正式，并由 §10.2 round-trip 测试断言"居中主点 → ∆P≈0"。**（这是从 OpenLensIO 投影关系 `εu = F·(x/z) + ∆P` 反推得到，与 review 建议一致。）

OpenTrackIO `lens.distortion[0]`：`model` 字串、`radial=[l1,l3,l5,(l2,l4,l6)]`、`tangential=[q1,q2]`；`projection_offset=∆P`；`pinhole_focal_length=F`。注意当前 `io/export/opentrackio.py:47-56` 直接把 `focal_length_mm` + 原始 k1/k2/k3/p1/p2 塞进 `radial`/`tangential`——**那是未归一化的 pixel-space 系数，对 OpenLensIO 不正确**；本 spec 的导出须改用上面的归一化转换（这是已有的 latent bug，估计镜头时必须修对）。

### 7.2 session-coupled 标记 + 禁止 master 导出

`vpcal export opentrackio` 须读 `quality.lens_estimate.session_coupled`，为 true 时：
- 在 OpenTrackIO `lens` 加 metadata `session_estimate=true`、`calibrationHistory: ["vpcal Quick Lens Estimate v1.0"]`、`static.lens` 不写 master 字段；
- **绝不**把估计镜头作为 master lens 发出；
- 附上 identifiability 注记（求解在固定外参下完成、非跨棚可移植）。

### 7.3 D-U / U-D 模型字串核对（caveat，必做）

camdkit 默认 `"Brown-Conrady D-U"`（系数为 distortion 正向 camera→pixels）。vpcal `projection.py` 的 `project_points` 应用的是**正向畸变 D**（`distort_normalized`）。导出前须核对 vpcal 优化的 k1/k2 是 D→U 还是 U→D，并据此填 `model` 字串；写 round-trip 导出测试对照 `projection.py` 正向约定（§10）。

> 焦距未放开时 F=nominal，转换照常；overscan Ω 在 quick estimate 下不可靠，标 TBD 或按 §A.1 从去畸变后屏角范围估。

---

## 8. 采集工作流差异（镜头估计所需）

在 `docs/capture-workflow-guide.md` 增 "镜头估计模式" 小节。相对纯空间校正，镜头估计对采集要求更严：

```
- pose 数 ≥ 8（cx/cy gate 硬要求），推荐 10-15；< 8 时镜头参数会被锁、退化为纯空间校正
- sensor 覆盖：marker 必须铺到画面四角/边缘——k1/k2 仅在边缘可观测（≥25% 观测半径 > 0.35·对角线）
- 角度多样性 ≥ 30°：纯平移单墙 + 恒定朝向会导致内参与外参简并（cv2 bootstrap 也会被坑）
- 多面墙（弧/天花板）天然非共面，比单平面墙更易可观测
- focal 若要估（--refine-focal）：需变化 camera-to-screen 距离以降低 focal↔standoff 相关性
- 仍遵守 Phase 1 的 1:1 像素映射假设、frame_id 对齐、normal/inverted 双帧
```

CLI 文本/帮助在覆盖不足时给可操作建议（"四角未覆盖 → k1 已锁，补采边缘 pose"）。

---

## 9. Simulator 改造（测试前置）

`core/simulator.py::forward_observations` 当前用单一 `intr` 投影。新增薄变体（默认行为不变）：

```python
def forward_observations(..., ground_truth_intr: CameraIntrinsics | None = None):
    # 用 ground_truth_intr（≠ 给 solver 的 nominal）投影生成像素，
    # 使测试能注入已知 k1/k2/cx/cy/focal 并验证 recovery。默认 gt = nominal（现行为）。
```

`simulate_dataset` 增 `--gt-lens-*` 选项（或测试直接调 `forward_observations`），并在 `ground_truth.json` 记录 ground-truth lens 供断言。

---

## 10. 测试计划

### 10.1 单元（`tests/unit/`）

1. `test_lens_recovery_k1` / `_k2` / `_cx_cy` / `_focal`：零噪声、单个已知非零参数 → 联合解恢复（`|Δk1|<0.005`、`|Δcx|<5px`、`|Δfocal|/focal<0.5%`），RMS<0.05px。
2. `test_lens_recovery_all`：k1+cx+cy 同时（focal off）→ 全恢复，RMS<0.1px。
3. `test_phase1_bit_identical`：`enabled=false` 时结果 == 重构前 gold（tx/ty/tz 1e-6mm、final_cost 1e-9 内）。**Verdict 4 向后兼容证明，两后端都跑。**
4. gate 单测：`test_gate_cx_cy_angular_spread`(<30°→锁)、`test_gate_cx_cy_forced_off_when_refine_C`(Verdict 3)、`test_gate_k1_edge_coverage`(中心聚集→锁，Verdict 5)、`test_gate_condition_number_illposed`(κ≥1e4→全锁)、`test_config_rejects_k2_without_k1`、`test_config_rejects_tangential`。
5. post-solve：`test_cross_subset_k1_reverts`（注入 screen-scale 误差使 k1 跨子集不一致→revert）、`test_cx_cy_confound_TS_translation_default_path`（**默认路径 refine_C=false**、cx/cy free 且与 `T_S_from_O` 平移共线 → `|ρ(cx, T_S)|`>0.8→revert；这是 Finding 3 修正后的核心用例，注意 refine_C 开启时 cx/cy 本就被硬锁、不走此路径）、`test_corr_unavailable_fails_closed`（相关性不可得 → 不放行/封顶 medium）、`test_improvement_below_3pct_reverts`。

### 10.2 集成（`tests/integration/`）

6. `test_quick_run_estimate_lens_end_to_end`：注入 gt 畸变 → `--estimate-lens` → `result.json` 有 `quality.lens_estimate`（is_master=false、session_coupled=true、恢复 k1、warning=true）；`qa/lens_observability.json` 存在含逐参数判词。
7. `test_quick_run_disabled_no_lens_estimate`：默认运行 → `quality.lens_estimate is None`、无 observability 文件、schema 仍校验通过。
8. `test_ceres_scipy_lens_parity`：同数据 cpp vs scipy → §4.4 阈值（C++ 未编译则 graceful skip）。
9. `test_cv2_bootstrap_seeds_and_falls_back`：bootstrap on 收敛；强制 cv2 失败（退化输入）→ 回退 nominal、记 warning、仍解出。
10. `test_export_refuses_session_coupled_master`：对 Level-2 result `vpcal export opentrackio` 打 session_estimate / 不发 master。
11. `test_precondition_still_exit6_in_lens_mode`：<3 pose + `--estimate-lens` 仍 exit 6。
12. `test_openlensio_distortion_conversion_roundtrip`：§7.1 转换 + §7.3 D-U 约定对照 `projection.py` 正向；**必含断言：居中主点（cx=wshader/2, cy=hshader/2）导出的 ∆Px、∆Py ≈ 0**（量纲修正回归测试）；以及 OpenLensIO→OpenCV 往返还原 fx/fy/cx/cy/k 在容差内。

### 10.3 一致性 / 覆盖率

- `test_schema_v1_1_roundtrip`：`CalibrationResult` 带 `EstimatedLens` 序列化/校验；`vpcal schema` 输出含新字段。
- 覆盖率：整体 ≥90%（Phase 1 标准）；`qa/observability.py` gate 逻辑 ≥95%。

---

## 11. Exit Code（复用 Phase 1 §12，新增场景）

| Code | 新增/复用场景 |
|------|---------------|
| 2 | `params` 含 k2 不含 k1、请求切向、refine_focal 但 focal≤0 |
| 6 | pose<3（含 estimate 模式）；所有 lens 自由被 pre-solve 拒后**仍按纯空间校正完成**（exit 0，非 6） |
| 9 | enabled 但 observation<50 / 全部 lens 参数被 revert → low-confidence partial |

> 注意：lens 自由被全部拒 **不是错误**——退化为 Phase 1 纯空间校正，正常 exit 0，但 QA 标 `lens_estimate` 全 locked + warning。

---

## 12. Contract Manifest 影响

`quick.run` operation 的副作用/幂等不变；新增可选输出 `qa/lens_observability.json`。`contract_version` 随 `schema_version` 升至 `1.1`（CLI_DESIGN_SPEC §4.4 要求二者对齐）。`vpcal manifest` 输出反映新版本与新 CLI flag。

---

## 13. 实现优先级（按依赖排序）

```
QLE-1  Config + 校验
  1. LensEstimateConfig（models/session.py）+ §3.2 校验 + CLI flag（cli/quick.py）
  2. EstimatedLens / Quality 改动（models/calibration.py，schema→1.1）+ schema-versions.md 更新

QLE-2  Solver 核心
  3. C++ ReprojectionCost 参数块化 + LensFocalPriorCost + solver.{h,cpp} LensFree + covariance（§4.1）
  4. bindings.cpp 暴露 LensFree / 扩展 SolverResult
  5. scipy fallback 状态向量扩展（§4.2）
  6. 向后兼容 bit-identical 测试（test 3）+ parity 测试（test 8）—— 必须先绿再继续

QLE-3  初始化
  7. cv2.calibrateCamera bootstrap（init-only，§2.3 step 2）+ 回退

QLE-4  Observability Gate（核心差异化）
  8. qa/observability.py：determine_lens_freedom（pre-solve）+ validate_lens_estimate（post-solve）
  9. pipeline.py 接线：baseline solve → pre-gate → joint solve → post-gate → revert 重解
  10. qa/lens_observability.json + reprojection.json 增强 + text 区块 + always-on warning

QLE-5  Simulator + 测试
  11. forward_observations ground_truth_intr（§9）
  12. recovery / gate / parity 全套测试（§10）

QLE-6  导出
  13. OpenLensIO 归一化转换修正（§7.1）+ session-coupled 标记 + 禁 master（§7.2）+ D-U 核对测试（§7.3）

QLE-7  文档
  14. capture-workflow-guide.md 镜头估计小节（§8）+ README/CLAUDE.md 更新
```

---

## 14. 残留风险与限制

1. **均匀 screen-scale 误差被 focal/k1 吸收**：跨子集一致性检不出 pose-invariant 的均匀误差。唯有 master screen mesh（Phase 3 ScreenGeoCal）能根除——在 QA 建议里作为硬限制声明。focal 默认 off + always-on warning 是缓解。
2. **Ceres↔scipy parity 漂移**：frozen `CameraIntrinsics` 每迭代重建，focal→fx/fy / center→cx/cy 的重建公式必须两端逐字镜像；parity 测试作 CI gate。TRF(scipy) vs LM(Ceres) 在边缘数据上容差不同，接受 final_cost ≤1% 偏差。
3. **cv2 bootstrap 在近简并数据上给出"自信的错 K"**：默认 off + 仅初值 + sanity clamp ±2%；依赖操作者提供角度多样性。
4. **gate 阈值（κ=1e4、30°、0.35·diag、Δk1=0.05、ρ=0.8）是启发式、未在真实 LED 数据调过**：全部做成 config 字段 + QA 打印实测 vs 阈值，免改码即可重调。
5. **scipy 无完整协方差**：post-solve 协方差 gate 降级（§5.6），confidence 封顶 medium。
6. **OpenLensIO 导出 sign/归一化**易错且会静默污染下游渲染：用 round-trip 导出测试守门；未验证前导出锁在 session_coupled 标记后（反正不会当 master 消费）。

---

## 15. 待人工决策项（已给默认，标注需用户确认者）

| # | 决策 | 本 spec 默认 | 备注 |
|---|------|--------------|------|
| 1 | 焦距是否进 Level 2 | **gated opt-in（`refine_focal`，默认 off）** | ✅ 用户已确认（2026-06-06） |
| 2 | k2 是否进默认 `params` | **默认 `{k1,k2,cx,cy}`（架构 "K1/K2" 字面）** | ✅ 用户已确认（2026-06-06）；由 §5.2/§5.3 gate 把关 |
| 3 | validation-pose 留出 | **不留出，用 cross-subset 一致性作泛化代理** | 不减求解数据；可改为留出 |
| 4 | cx/cy 用户面单位 | **mm（`principal_point_offset_mm`），内部 px** | margin 语义随之为 mm |
| 5 | schema 版本策略 | **result 1.0→1.1，新字段全 optional** | 下游须容忍未知→optional 新字段 |
| 6 | confidence 标签规则 | all gate 净通过 + Ceres → high；任一 revert 或 scipy(无协方差) → 封顶 medium；pre-solve 全拒 → 无 lens_estimate | 政策非技术 |
| 7 | cv2 bootstrap 默认 | **off（保守）** | 现场验证后可在后续版本翻默认 |

---

## Appendix A：对抗验证结论摘要（设计阶段 5 项）

| # | 论断 | 结论 | 对设计的影响 |
|---|------|------|--------------|
| 1 | tracking 钉死外参 → 焦距可观测，无 SfM 简并 | **确认** | 焦距不是硬禁，作 gated opt-in（§2.2、§15-1） |
| 2 | `cv2.calibrateCamera` 可作独立初始化 | **确认**（单平面+恒定朝向为可避免简并） | 采纳为 init-only 可选步（§2.3） |
| 3 | cx/cy 与 `T_C_from_B` **平移**强耦合 | **部分**（主要平移耦合，旋转弱） | refine_C 时硬锁 cx/cy + 后验 |ρ|>0.8 backstop（§3.2、§5.3） |
| 4 | lens 参数块化 + SetParameterBlockConstant 与 const 路径数值等价 | **确认** | 选单问题联合解、否决交替迭代；Phase 1 测试逐位不变（§2.4、§4.3） |
| 5 | 现有 coverage/radial-check 足以 gate 畸变 | **部分**（仅辅助信号） | 新增边缘半径覆盖 + 后验协方差 + 跨子集一致性（§5.2、§5.3） |

> 设计经 3 个独立方案（robustness-first / minimal-change / opencv-leverage）+ 5 项对抗验证 + 参考规范核对综合而来。

---

## Appendix B：实现精化（as-built，2026-06-06）

实现 + 端到端验证过程中发现并采纳的几处对 spec 的修正，**以本附录为准**：

1. **镜头估计走 scipy 后端，C++ lens 参数块化端口延后**（取代 §4.1 的 C++ 改造为本期必做项）。理由：两阶段 gate（§5）依赖**完整后验协方差 + 相关性 + 条件数**，scipy 直接提供；在 Ceres 里复现 cross-block 协方差/相关性代码量大且易错。镜头估计是离线一次性计算，scipy 速度足够。`_estimate_lens` 内所有 solve 强制 `prefer_cpp=False`。**Ceres 仍是默认（镜头固定）空间求解的主后端，且完全未改动——Phase-1 逐位兼容自然成立**（C++ 可用时 179 测试全绿、0 skip）。C++ lens 端口列为后续性能优化。

2. **focal 内部参数化为 scale**（对 nominal fx/fy 的乘子，init=1.0），而非直接 `focal_length_mm`。避免把 sensor 尺寸塞进 solver、保持 fx/fy 比例固定（单焦距 DoF）；输出时 `focal_length_mm = nominal · scale`，相对 std（σ_scale）即 σ_focal/focal。

3. **移除 §5.2 的 baseline-RMS pre-solve gate**（`max_spatial_rms_px_for_*`）。该 gate 方向反了：基线 RMS 高正是"镜头未知"的预期症状（恰是要估计的场景），不应据此拒绝估计。改由 §5.3 #4 的 **post-solve improvement gate**（refined 须较 baseline 降 ≥3%）正确把关。配置字段保留但不再作硬 gate。

4. **条件数 κ 用列归一化的 JᵀJ**（尺度无关）。原始 JᵀJ 的 κ 被参数量纲主导（平移 mm vs 旋转 rad vs 无量纲畸变，单这一项就 ~1e8 误判病态）。归一化后 κ 反映参数共线性（可观测性），1e4 阈值才有意义（实测健康场景 κ≈35）。

5. **端到端验证**（单平面墙 + 居中主点 + gt k1=-0.06）：freed k1/k2/cx/cy → cx/cy 因与 T_S 平移相关性 0.96/0.99 被 post-solve revert（Finding 3 现象）→ **k1 恢复 -0.0600（真值 -0.06）、k2≈0 KEPT**，RMS 10.17→0.0（改善 100%），confidence medium，always-on warning 置位。gate 精确区分可观测（k1）与混淆（cx/cy）。

6. **测试**：176→179 全绿（C++ 可用时），新增 19 个 lens-estimate 测试（solver 级恢复、5 类 gate、端到端、bit-identical、OpenLensIO 转换）。
