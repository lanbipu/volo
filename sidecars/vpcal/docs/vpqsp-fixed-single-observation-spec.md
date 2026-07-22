# VP-QSP 固定机位单次 Observation 校正 Spec

状态：Draft for implementation（2026-07-22 讨论修订已合入）

日期：2026-07-22
范围：`VP-QSP detection → fixed-camera solve → static validation → formal Stage pose`

关联文档：

- `lens-calibration-redesign-spec.md`
- `structured-light-fixed-calibration-spec.md`
- `reconstruction-calibration-geometry-investigation-spec.md`
- `../../sidecars/vpcal/docs/vpcal_quick_lens_estimate_spec.md`

## 1. 决策摘要

### 1.1 产品结论

VP-QSP **可以**用于“固定机位点击一次后得到精准对位”，但当前实现不能满足该目标。

当前正式路径是：

```text
Qualified Master Lens → single image VP-QSP detection → solvePnPRansac → extrinsics-only
```

目标需要新增第二条正式路径：

```text
qualified Stage geometry + single fixed observation
→ dense VP-QSP correspondences
→ joint session lens + camera pose solve
→ observability / covariance / withheld gates
→ session-coupled formal Stage pose
```

这里的“一次”定义为：用户不移动相机，只执行一次采集动作。VP-QSP 当前是一个静态 pattern，因此通常对应一张主求解图；允许自动补采短 burst 用于去噪，但所有 frame 必须来自同一 camera pose，不能把它们计为多个 lens poses。

### 1.2 不能承诺的边界

- 单个平面屏幕、近正视、未知 lens 的单张图，无法稳定分离 focal length、camera distance、principal point 与 radial distortion；marker 再多也不能消除几何简并。
- 两块或多块具有准确相对 3D pose、且在相机中形成足够 depth/angle spread 的屏幕，可以使单次 joint solve 可观测。
- 求出的 lens 只对当前 `focus / zoom / resolution / crop / image domain` 有效，是 `session_coupled=true`，不得冒充可复用 `Master Lens`。
- 如果可观测性不够，系统必须 fail-closed，并提供“改拍摄构图 / 使用 Qualified Master Lens / 改用 Structured Light”的明确建议，不能回退到 default intrinsics。

### 1.3 方法定位

| 路径 | 用户采集 | Lens 来源 | 输出 | 正式可用条件 |
|---|---:|---|---|---|
| `known_lens_pose` | 1 observation | Qualified Master Lens | extrinsics | 现有路径，保留 |
| `joint_single_observation` | 1 fixed observation | 当前 observation 联合估计 | session lens + extrinsics | 新增；强 observability gate |
| `master_lens_capture` | ≥8 diverse poses | multi-view lens calibration | reusable Master Lens | 独立流程，不是 fixed solve 前置必选 |

UI 不得再把缺少 Master Lens 自动解释成“必须先采 8 poses”。用户应能明确选择：

- `固定机位 · 单次校正`
- `使用 Master Lens · 只求外参`
- `建立 Master Lens · 多姿态`

## 2. 当前 As-Built 评估

### 2.1 已具备

- VP-QSP marker 具备 `screen_id / cabinet / local_id / CRC`，可建立 screen-space 到 camera-pixel correspondence。
- detector 已保留 native input 后再规范化为 8-bit；白色编码块只产生 `brightness_warning`，不再作为 hard rejection。
- central locator 已有 `contrast / plateau / center displacement` 质量判断。
- fixed pose 已有 per-screen homography、joint projective preflight、`solvePnPRansac` fail-closed、combined/per-screen RMS 和 `image_size` 持久化。
- formal path 已禁止 default `50mm / 36×24 / zero distortion`，并校验 Master Lens 与 geometry provenance。

### 2.2 当前阻塞项

1. `tracker-free stage-pose` 只接受 Qualified Master Lens；没有 joint single-observation lens solver。
2. `markers_per_cabinet` 的默认密度主要服务 cabinet reconstruction，不足以保证 sensor edge coverage 与 lens identifiability。
3. 当前 preflight 只回答“这些 world points 是否能由某个 projective camera 解释”，没有输出 joint lens parameter covariance、parameter correlation 或 model rank。
4. 当前 formal artifact 只有 `fixed_extrinsics_only`；没有 session lens provenance、camera-state fingerprint 和 observability report。
5. 当前 geometry formal gate 依赖 reconstruction artifact，但 reconstruction 是否正确、是否被正确导出仍需按第三份 Spec 完成调查。

## 3. 数学问题与可观测性

### 3.1 已知量

- `P_i^S`：来自 qualified Stage geometry 的 marker 3D world points。
- `p_i`：VP-QSP central locator 的 sub-pixel image coordinates。
- `image_size` 与固定的 image domain。
- camera state fingerprint（见 §6.1）：机读部分 `camera_id / resolution / crop / transfer path` 的 hash，加上用户 attest 的 focus/zoom 未变声明。focus/zoom 通常不可机读，不得假装能自动检测其变化。

### 3.2 待估量

```text
θ = {T_C_from_S, f, cx, cy, k1, k2}   # 首版强制 fx = fy = f
```

默认固定 `skew=0`、`fx=fy`、`p1=p2=0`、`k3=0`。只有在信息矩阵证明额外参数可观测时，才允许放开更复杂模型；首版不放开 `fx≠fy`。

目标函数：

```text
min θ Σ_i ρHuber( project(P_i^S, θ) - p_i )²
      + prior(principal_point)
      + prior(distortion)
```

不再使用 aspect-ratio prior（参数空间本身已锁 `fx=fy`）。priors 只用于稳定求解，不能把不可观测数据“变成可观测”。最终 qualification 必须基于去掉强 prior 后的 sensitivity/covariance 复核。

### 3.3 Model ladder

solver 必须从低自由度向高自由度逐级放开：

1. `M0 pose_only`：**现有 `known_lens_pose` 路径的别名**——Qualified Master Lens 固定，只求 `T_C_from_S`。不属于 joint solver 内部 ladder；joint 模式从 M1 起步。
2. `M1 focal_pose`：固定 principal point 于 image center、distortion=0，只求单 focal `f`（`fx=fy`）+ pose。
3. `M2 radial_pose`：在 `M1` 可观测后放开 `k1`，必要时再放开 `k2`。
4. `M3 center_radial_pose`：只有 2D edge/corner coverage 和 covariance 同时通过，才放开 `cx/cy`。

选用最低且能通过 independent validation 的模型。高自由度模型 RMS 更低，不构成采用理由。

### 3.4 Hard observability gates

首版正式门槛（placeholder；由 P0 synthetic sweep 与 Razer 实测重新 pin）：

| Gate | Formal threshold |
|---|---:|
| trustworthy correspondences | total ≥60；每个可见 selected screen ≥12 |
| RANSAC inliers | total ≥40；每屏 ≥8；inlier ratio ≥0.70 |
| image 2D coverage | X span ≥35%，Y span ≥35% |
| edge observations | ≥25% inliers 的 radius ≥0.35 × image diagonal |
| 3D depth ratio | centered world points `σ3/σ1 ≥0.02` |
| multi-plane angle | 至少两组 surface normals 相差 ≥15° |
| normalized DLT condition | `<1e6` |
| refined Hessian condition | `<1e5` after column normalization |
| focal std-dev | `σf/f ≤1%` |
| principal-point std-dev | `max(σcx, σcy) ≤3 px`，否则锁回 center prior |
| corner distortion uncertainty | 95% displacement uncertainty ≤1 px |

门槛必须由 **P0 内的 synthetic sweep harness**（与 solver 同一套代码）与 Razer 实测重新 pin；在验证完成前只允许 `experimental`，不得降低门槛以让失败数据通过。

## 4. Detection 与 Pattern 改造

### 4.1 Pattern density 与 cabinet 解耦

新增 stage-level placement planner，不再只按“每 cabinet N 个 marker”决定密度：

- 输入：所有 selected screens 的实际 output mapping、camera preview、target marker size。
- 输出：每屏 marker placement，优先覆盖 image corners、screen perimeter、plane boundaries 与 depth extremes。
- global marker identity 保持唯一；`screen_id` 继续参与 code。
- target：双屏正常 framing 下总计 ≥100 个可解码 marker，最低 formal gate 为 60。
- marker body 与 central locator 不得被 cabinet seam、output crop 或 bezel 截断。

### 4.2 Capture quality

每个 observation 输出：

```json
{
  "decoded": 128,
  "trustworthy": 114,
  "brightness_warnings": 7,
  "localization_rejected": 3,
  "coverage_xy": [0.71, 0.58],
  "edge_fraction": 0.31,
  "per_screen": {}
}
```

要求：

- native bit depth 进入 localization；8-bit 只用于 segmentation/decode。
- brightness/clipping 只在 locator localization 明确退化时 hard fail。
- duplicate marker IDs、topology conflict、screen-id conflict 必须剔除并计数。
- 对 locator 做 multi-scale centroid stability：至少两个 window scale 的 centroid 差 `<0.15 locator cell`。
- burst 模式以 median/robust average 合成 locator coordinate，并报告 temporal jitter；不能把 burst 当作 multi-pose lens evidence。

## 5. Solver Pipeline

### 5.1 Preflight

1. 校验 Stage geometry qualification 与 fingerprint。
2. 校验 capture image domain 与 camera state。
3. 每屏独立 homography：`RMS <1 px`。
4. joint unrestricted projective fit：`RMS <2 px`。
5. 检查 point-cloud rank、surface-normal spread、image coverage 与 DLT condition。

错误分类：

- `DETECTION_QUALITY_FAILED`
- `SCREEN_GEOMETRY_INCONSISTENT`
- `SINGLE_VIEW_UNOBSERVABLE`
- `IMAGE_DOMAIN_MISMATCH`

### 5.2 Initialization

1. normalized DLT 求 camera matrix `P`。
2. RQ decomposition 得到 `K0 / R0 / t0`。
3. 对 `K0` 做物理 bounds 与 sign normalization。
4. 若 DLT 不稳定，允许用 camera metadata focal 作为 weak initial guess；它不能成为 qualification anchor。

### 5.3 Joint refinement

- 使用 robust nonlinear least squares。
- 按 §3.3 model ladder 逐级放开参数。
- 每级记录 parameter covariance、correlation、AIC/BIC-like complexity penalty 与 independent validation。
- `focal ↔ camera depth`、`principal point ↔ pose translation` 任一 `|ρ| >0.8` 时锁回对应 lens parameter。
- 任何 solve failure、non-finite、bound hit、RANSAC failure 都 hard fail；禁止 plain `solvePnP` fallback 落盘。

### 5.4 Independent validation

correspondences 按空间 block 留出，不做纯随机留出：

- 每屏保留 perimeter、center、depth-extreme blocks。
- solve set ≤80%，withheld set ≥20%。
- 验收同时看 solve 与 withheld：combined/per-screen withheld RMS `<2 px`，目标 `<1 px`。
- 重新以每屏独立 pose 求解，比较 camera pose；translation/rotation delta 超阈时返回 geometry inconsistency。
- 首先在同一静帧上画 perimeter/grid；静帧通过后才进入 live preview。

## 6. Artifacts 与 Public Interfaces

### 6.1 新增 `fixed_observation_result.v1`

```json
{
  "schema_version": "fixed_observation_result.v1",
  "solve_kind": "joint_single_observation",
  "mode_requested": "auto",
  "mode_resolved": "joint-session-lens",
  "formal": true,
  "camera_from_stage": {},
  "session_lens": {
    "is_master": false,
    "session_coupled": true,
    "K": [],
    "dist_coeffs": [],
    "image_size": [3840, 2160],
    "model": "brown_conrady_radial2"
  },
  "camera_state_fingerprint": {
    "machine_readable_hash": "sha256:...",
    "components": {
      "camera_id": "...",
      "resolution": [3840, 2160],
      "crop": null,
      "transfer_path": "..."
    },
    "focus_zoom_attested": true,
    "attest_timestamp": "ISO-8601"
  },
  "stage_geometry_fingerprint": "sha256:...",
  "detection": {},
  "observability": {},
  "preflight": {},
  "validation": {},
  "qualification": {
    "passed": true,
    "fail_closed": true,
    "scope": "current_camera_state_only"
  }
}
```

### 6.2 兼容规则

- `volo_stage_pose.v2 / fixed_extrinsics_only` 继续有效。
- 新 result 可以进入当前 fixed camera AR/export，但其 session lens 不写入 `Master Lens` registry。
- **stale 规则**：机读 fingerprint（camera_id/resolution/crop/transfer path）或 Stage geometry fingerprint 改变 → result 自动 `stale`。focus/zoom 变化**不能**自动检测；复用 session lens 时 UI 必须提示用户确认「对焦/变焦未变」并刷新 attest。
- legacy/default/unanchored artifact 继续保持 `invalid`。

### 6.3 CLI/API

新增 operation：

```text
vpcal tracker-free fixed-observation
  --image <capture>
  --screen-target <screen.json>:<code>:<offset> ...
  --mode auto|known-lens|joint-session-lens
  [--lens <qualified-master.json>]
  --out <fixed_observation_result.json>
```

`--mode auto` 语义写死：

- 存在合格 Qualified Master Lens → 解析为 `known-lens`；
- 否则 → 解析为 `joint-session-lens`。

result 必须同时记录 `mode_requested` 与 `mode_resolved`。UI 展示时以 `mode_resolved` 为准，不得模糊。

Tauri/TypeScript 增加同构 typed result，不再把 joint path 塞进现有 `trackerFreeStagePose` 的可选 flag。

## 7. UI 与产品语义

- 主动作：`固定机位 · 单次校正`。
- Advanced choice：`使用 Master Lens` / `自动估计当前镜头`。
- 文案明确：`1 observation` 不是 `1 marker`，也不是 `8 lens poses`。
- 结果分区展示：`Detection / Geometry / Lens observability / Pose / Static validation`。
- `Framing score` 与 geometry RMS 物理分隔。
- 自动估计结果标注：`当前焦距/对焦/分辨率有效 · 非 Master Lens`。
- `SINGLE_VIEW_UNOBSERVABLE` 的推荐动作按顺序给出：增加非共面 screen coverage → 改用 Structured Light → 导入/建立 Master Lens。

## 8. Implementation Plan

### P0 — Solver substrate（与 geometry 调查并行；纯 synthetic 驱动）

1. 抽出共享 detection-agnostic `fixed_observation` correspondence model（VP-QSP 与 Structured Light 共用）。
2. 实现 normalized DLT、RQ initialization、model ladder（M1→M3，单 focal）与 covariance/correlation。
3. 增加 spatial-block withheld validation。
4. **Synthetic sweep harness**（与 solver 同一套代码）：跑 §9.1 全用例并输出阈值 pinning 报告，替换 §3.4 placeholder。
5. 新 artifact/schema/error envelope，formal persistence fail-closed。

### P1 — VP-QSP quality

1. 先查 Razer ASUS/LG screen JSON cabinet 粒度，再放开 `local_id` 6-bit 密度。
2. stage-level marker planner 与 edge coverage。
3. burst centroid stability、per-screen metrics。
4. 单次采集 UI 与 `known-lens` / `joint-session-lens` 显式模式。

### P2 — Product integration（**gate**：`reconstruction-calibration-geometry-investigation-spec.md` 完成且 Stage geometry qualified）

1. camera state fingerprint（机读 hash + attest）与 stale propagation。
2. static overlay 自动验收。
3. export/AR source gate 接入新 artifact。
4. Razer 双屏 threshold tuning，锁定生产默认值。

## 9. Tests 与 Acceptance

### 9.1 Synthetic（P0 harness；门槛 pinning 的数据源）

- two-plane / curved geometry、未知 `f/cx/cy/k1/k2`：恢复 focal `<1%`、pp `<3 px`、pose reprojection `<1 px`。
- planar single screen：必须 `SINGLE_VIEW_UNOBSERVABLE`。
- wrong relative screen pose：per-screen homography pass、joint preflight fail，返回 `SCREEN_GEOMETRY_INCONSISTENT`。
- wrong focal prior：可观测数据应收敛；不可观测数据不得靠 prior 通过 formal gate。
- distortion overfit：高阶模型不得仅因 training RMS 更低而被选中。

### 9.2 Regression

- VP-QSP intentional white blocks 不触发 hard saturation reject。
- locator clipping/flat-top/unstable centroid 必须拒绝。
- known Master Lens path 与现有 `fixed_extrinsics_only` 数值一致。
- default/manual intrinsics 不能进入 formal result。

### 9.3 Razer acceptance

**现场前置（硬）**：ASUS + LG 两屏摆出 **≥30° 夹角**（gate 下限 15°，验收留裕量）。近共面布置按下表不计入正式验收。

- ASUS + LG 使用同一 qualified Stage geometry（依赖第三份 Spec 调查完成）。
- 不预建 Master Lens，固定机位执行一次 VP-QSP observation。
- 连续三次独立采集均成功，camera state 不变。
- 每屏 ≥12 trustworthy、≥8 inliers；total ≥60。
- combined/per-screen/withheld RMS `<2 px`，目标 `<1 px`。
- camera pose 三次重复性：rotation `<0.05°`，translation `<5 mm`；最终阈值按现场距离归一化复核。
- 同一静帧 AR perimeter 对齐通过；再检查 live preview。

## 10. Go / No-Go

满足以下条件后，VP-QSP 才能对外宣称“固定机位一次校正”：

- joint single-observation solver 与 observability gates 全部完成；
- reconstruction geometry artifact 已按第三份 Spec qualified；
- Razer 双屏连续三次验收通过；
- 失败数据稳定 fail-closed，且不能通过调低阈值或 default intrinsics 绕过。

在此之前，VP-QSP 只能宣称：`Qualified Master Lens 下的单帧 extrinsics-only solve`。
