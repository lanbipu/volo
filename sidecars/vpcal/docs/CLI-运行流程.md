# CLI 运行流程

本文档通过 CLI 将 vpcal 全部功能完整跑一遍，记录每步的命令与输出。
供 Skill 开发、UI 界面功能验证及部署工作参考。

> 版本：vpcal 0.1.0 | 运行环境：macOS arm64, Python 3.11 | 日期：2026-06-07

---

## 前置准备

```bash
cd vpcal
pip install -e ".[dev]"    # 编译 C++ Ceres solver 并安装
vpcal --version            # 确认安装成功
```

```
vpcal 0.1.0
```

所有命令均支持 `--output text|json|ndjson|stream-json` 切换输出格式。
设置 `AI_AGENT=1` 环境变量时默认输出 JSON。

---

## 0. 基础信息命令

### 0.1 version

```bash
vpcal version -o json
```

```json
{
  "schema_version": "1.0",
  "status": "ok",
  "operation_id": "version",
  "data": {
    "name": "vpcal",
    "version": "0.1.0"
  }
}
```

### 0.2 manifest（Contract Manifest）

列出所有 operation_id 及其对应的 CLI 命令映射。

```bash
vpcal manifest
```

```
vpcal contract manifest (version 1.0)
  quick.run              vpcal quick run
  pattern.generate       vpcal pattern generate
  screen.create          vpcal screen create
  screen.import          vpcal screen import
  simulate               vpcal simulate
  report.generate        vpcal report generate
  export.opentrackio     vpcal export opentrackio
```

### 0.3 schema

输出 SessionConfig 和 CalibrationResult 的 JSON Schema，供前端表单生成或 Agent 参数校验。

```bash
vpcal schema -o json
```

返回的 `data` 包含两个 key：
- `session_config`：顶层字段 `images, tracking, screen, lens, solver, capture_mode`
- `calibration_result`：顶层字段 `schema_version, vpcal_version, timestamp, tracker_to_stage, tracker_to_camera, quality, inputs, solver_diagnostics`

### 0.4 completion（Shell 补全）

```bash
vpcal completion bash   # 或 zsh / fish
```

---

## 1. 创建 Screen 定义

Screen 定义描述 LED 屏幕的物理尺寸、像素间距和分区（plane / arc）。

### 1.1 从参数创建（screen create）

```bash
vpcal screen create \
  --name "LG-OLED-G3-55" \
  --width 1217 \
  --height 685 \
  --pixel-pitch 0.317 \
  --section-name panel \
  --out screen_lg.json \
  -o json
```

```json
{
  "schema_version": "1.0",
  "status": "ok",
  "operation_id": "screen.create",
  "data": {
    "output": "screen_lg.json",
    "sections": ["panel"],
    "cabinet_size": [608.5, 342.5]
  }
}
```

**`--cabinet-size` 自动计算**：不指定时，根据屏幕尺寸自动计算，确保每轴至少 2–3 个 cabinet，使 marker 覆盖整个屏幕。如果显式指定了过大的值导致 marker 稀疏，text 和 JSON 输出都会发出警告：

```
Wrote screen definition → screen.json (cabinet 600×300mm)
WARNING: section 'wall': 1×1 cabinets (4 markers) — marker coverage may be insufficient for lens calibration
```

**完整参数**：

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--name` | 屏幕名称 | 必填 |
| `--width` | 平面宽度 (mm) | — |
| `--height` | 分区高度 (mm) | 必填 |
| `--pixel-pitch` | LED 像素间距 (mm) | 2.8 |
| `--section-type` | `plane` 或 `arc` | plane |
| `--cabinet-size W H` | Cabinet 尺寸 (mm) | 自动计算 |
| `--section-name` | 分区名称 | wall |
| `--arc-radius` | 弧形半径 (mm) | — |
| `--arc-angle` | 弧形角度 (deg) | — |
| `--arc-center-angle` | 弧形中心角 (deg) | 180.0 |
| `--origin X Y Z` | 分区原点 (mm) | 0 0 0 |

### 1.2 从 OBJ 导入（screen import）

```bash
vpcal screen import \
  --obj led_wall.obj \
  --name "Studio A Main Wall" \
  --out screen.json
```

自动拟合平面/弧形分区。`--cabinet-size` 同样支持自动计算。

---

## 2. 生成校正图案（pattern generate）

根据 screen 定义生成 VP-QCP 校正图案（普通 + 反色两张），用于在 LED 屏幕上显示后拍照。

```bash
vpcal pattern generate \
  --screen screen_lg.json \
  --output-dir patterns/ \
  -o json
```

```json
{
  "schema_version": "1.0",
  "status": "ok",
  "operation_id": "pattern.generate",
  "data": {
    "files": [
      "patterns/normal.png",
      "patterns/inverted.png"
    ],
    "warnings": [],
    "num_markers": 16
  }
}
```

生成的图案分辨率匹配屏幕原生分辨率（如 LG 55" 4K → 3839×2161px），可全屏显示。

每个 marker 中心含 Gaussian locator dot，用于亚像素级精度检测（< 0.01px）。`normal` + `inverted` 配对用于差分检测。

`--max-dim` 控制生成图片的最大边长（默认 8192px）。

---

## 3. 生成合成数据集（simulate）

生成带有已知 ground truth 的合成数据集，用于验证 solver 精度或集成测试。

### 3.1 带噪声

```bash
vpcal simulate \
  --screen screen_lg.json \
  --num-poses 10 \
  --noise-px 0.3 \
  --output-dir sim/ \
  --seed 42 \
  -o json
```

```json
{
  "schema_version": "1.0",
  "status": "ok",
  "operation_id": "simulate",
  "data": {
    "output_dir": "sim/",
    "num_poses": 10,
    "num_observations": 160,
    "ground_truth": {
      "rotation": [0.9951, 0.0228, -0.0777, 0.0561],
      "translation": [-405.82, 475.62, 261.14]
    }
  }
}
```

**生成的文件结构**：

```
sim/
├── session.json          # 可直接传给 vpcal quick run 的 SessionConfig
├── observations.jsonl    # 2D-3D 对应点（pipeline 检测到此文件时跳过图像检测）
├── ground_truth.json     # 已知的 tracker-to-stage 变换
├── screen/               # screen 定义副本
├── tracking/             # 合成 tracking 数据 (JSONL)
└── captures/             # 合成图像
```

### 3.2 无噪声（理想情况）

```bash
vpcal simulate \
  --screen screen_lg.json \
  --num-poses 8 \
  --noise-px 0.0 \
  --output-dir sim-clean/ \
  --seed 42 --no-images
```

无噪声数据用于验证 solver 精度上限，期望 RMS < 0.01px。

### 3.3 有噪声 + 异常值

```bash
vpcal simulate \
  --screen screen_lg.json \
  --num-poses 12 \
  --noise-px 1.5 \
  --outlier-ratio 0.05 \
  --output-dir sim-noisy/ \
  --seed 99 --no-images
```

**完整参数**：

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--screen` | Screen 定义 JSON | 必填 |
| `--num-poses` | 摄影机位姿数量 | 10 |
| `--noise-px` | 高斯像素噪声 sigma | 0.0 |
| `--outlier-ratio` | 异常观测比例 | 0.0 |
| `--output-dir` | 输出目录 | 必填 |
| `--seed` | 随机种子 | 0 |
| `--no-images` | 跳过渲染图像（加速） | false |
| `--image-width` | 渲染图像宽度 (px) | 1920 |
| `--image-height` | 渲染图像高度 (px) | 1080 |

---

## 4. 运行校正 Pipeline（quick run）

核心命令。执行完整的 validate → detect → solve → report 四阶段 pipeline。

### 4.1 空间校正（默认模式）

```bash
vpcal quick run \
  --config sim/session.json \
  --output-dir result/ \
  -o json
```

关键输出字段（已精简）：

```json
{
  "status": "ok",
  "operation_id": "quick.run",
  "data": {
    "exit_code": 0,
    "result": {
      "tracker_to_stage": {
        "translation": [-405.87, 475.38, 260.83],
        "rotation": [0.9951, 0.0224, -0.0777, 0.0562],
        "matrix_4x4": [[...], [...], [...], [0, 0, 0, 1]]
      },
      "quality": {
        "reprojection_rms_px": 0.4154,
        "total_observations": 160,
        "inlier_observations": 160,
        "outlier_ratio": 0.0,
        "num_poses": 10,
        "confidence": "high"
      },
      "solver_diagnostics": {
        "num_iterations": 3,
        "termination_type": "CONVERGENCE",
        "solver_backend": "ceres",
        "parameter_covariance": {
          "available": true,
          "tracker_to_stage_std": {
            "tx_mm": 0.499, "ty_mm": 0.650, "tz_mm": 0.882,
            "rx_deg": 0.055, "ry_deg": 0.008, "rz_deg": 0.035
          }
        }
      }
    },
    "qa": {
      "coverage": {
        "sensor_coverage": { "percentage": 1.0 },
        "screen_coverage": { "percentage": 1.0 }
      }
    },
    "confidence": "high",
    "solver_backend": "ceres"
  }
}
```

text 模式输出：

```
Calibration complete (confidence: high, backend: ceres).
  reprojection RMS : 0.4154 px
  observations     : 160 (10 poses, 160 inliers)
  outputs written  : result/
```

**生成的文件结构**：

```
result/
├── result.json           # CalibrationResult（后续 report / export 的输入）
├── qa/                   # 重投影分析数据
└── export/               # 导出数据（如有）
```

### 4.2 联合镜头校正（--estimate-lens）

当没有 master lens profile 时，使用 `--estimate-lens` 在空间校正的同时估计镜头参数。需要 scipy 后端（`--scipy`）以获取完整协方差矩阵。

```bash
vpcal quick run \
  --config sim/session.json \
  --output-dir result-lens/ \
  --estimate-lens --scipy \
  -o json
```

镜头校正结果中的关键字段：

```json
{
  "quality": {
    "lens_estimate": {
      "is_master": false,
      "session_coupled": true,
      "distortion_k1": {
        "value": 0.0,
        "std": null,
        "observable": false,
        "locked_reason": "k1/k2 locked (pre-solve): edge_coverage"
      },
      "identifiability_flags": ["..."],
      "confidence": "low"
    },
    "lens_observability_warning": true
  }
}
```

Observability gate 会自动判断哪些参数可估计：
- **cx/cy（主点）**：要求 angular_spread >= 30° 且传感器九宫格五区都有覆盖
- **k1/k2（径向畸变）**：要求足够的边缘观测（edge_coverage gate）
- 不满足条件的参数自动锁定，不会产生不可靠的估计

**镜头校正相关参数**：

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--estimate-lens` | 启用 Quick Lens Estimate | false |
| `--lens-params` | 指定要释放的参数，逗号分隔 | `k1,k2,cx,cy` |
| `--refine-focal` | 同时估计焦距 | false |
| `--cv2-bootstrap` | 用 cv2.calibrateCamera 初始化 | false |
| `--scipy` | 强制使用 scipy 后端 | false |

### 4.3 仅运行到指定阶段

```bash
vpcal quick run --config sim/session.json --stage validate -o json
```

可选阶段：`validate` | `detect` | `solve` | `report`

### 4.4 使用 scipy 后端

当没有 C++ 工具链或需要对比时，强制使用 scipy 后端：

```bash
vpcal quick run --config sim/session.json --output-dir result-scipy/ --scipy
```

scipy 后端不提供 parameter_covariance。

### 4.5 per-marker 详细报告

```bash
vpcal quick run --config sim/session.json --output-dir result/ --per-marker
```

在 QA 输出中增加每个 marker 的重投影误差明细。

### 4.6 关键输出字段解读

| 字段 | 含义 |
|------|------|
| `tracker_to_stage.translation` | 平移量 [tx, ty, tz] (mm) |
| `tracker_to_stage.rotation` | 四元数 [w, x, y, z] |
| `tracker_to_stage.matrix_4x4` | 4x4 齐次矩阵（可直接用于 UE/nDisplay） |
| `quality.confidence` | `high` / `medium` / `low` / `very_low` |
| `quality.reprojection_rms_px` | 重投影均方根误差 (px) |
| `quality.lens_estimate` | 镜头估计结果（`--estimate-lens` 时存在） |
| `solver_diagnostics.solver_backend` | `ceres` 或 `scipy` |
| `solver_diagnostics.parameter_covariance` | 参数不确定度（仅 Ceres） |

---

## 5. 生成 QA 报告（report generate）

基于 result.json 生成包含建议的综合报告。

```bash
vpcal report generate --result result/result.json
```

```
Calibration QA report (confidence: high)
  reprojection RMS : 0.4154 px
  observations     : 160 (10 poses)
  outlier ratio    : 0.000
```

JSON 模式（`-o json`）输出包含：
- `result`：完整的 CalibrationResult
- `reprojection`：逐 pose RMS、逐 marker 误差、top10 outlier、误差直方图、径向残差检查
- `coverage`：传感器覆盖率（九宫格）、屏幕覆盖率（逐 section）、pose 分布（空间/角度分散度）

可选 `--qa-dir` 指定 QA 数据目录（默认在 result.json 同级）。

---

## 6. 导出 OpenTrackIO（export opentrackio）

将校正后的摄影机位姿导出为 OpenTrackIO JSONL 格式。

```bash
vpcal export opentrackio \
  --result result/result.json \
  --session sim/session.json \
  --out opentrackio.jsonl \
  -o json
```

```json
{
  "schema_version": "1.0",
  "status": "ok",
  "operation_id": "export.opentrackio",
  "data": {
    "output": "opentrackio.jsonl",
    "samples": 10,
    "session_estimate": false
  }
}
```

每条 JSONL 记录结构（OpenTrackIO 1.0.0 协议）：

```json
{
  "protocol": { "name": "OpenTrackIO", "version": "1.0.0" },
  "sampleId": "urn:uuid:vpcal-00000000",
  "timing": { "sequenceNumber": 0 },
  "tracker": { "status": "calibrated" },
  "lens": {
    "focalLength": 24.0,
    "distortion": [{
      "model": "Brown-Conrady D-U",
      "radial": [0.0, 0.0, 0.0],
      "tangential": [0.0, 0.0]
    }],
    "projectionOffset": { "x": 0.0, "y": 0.0 }
  },
  "transforms": [{
    "translation": { "x": -0.183, "y": 1.586, "z": 0.326 },
    "rotation": { "pan": -174.189, "tilt": -88.736, "roll": 0.098 },
    "id": "camera_to_world"
  }]
}
```

注意 translation 单位为米（m），rotation 为 pan/tilt/roll 度（deg）。

---

## 7. 端到端完整流程（一键复制版）

从零开始跑通所有功能：

```bash
# 0. 准备工作目录
WORK=/tmp/vpcal-demo && mkdir -p $WORK

# 1. 创建 Screen 定义（cabinet_size 自动计算）
vpcal screen create \
  --name "Demo Wall" --width 1217 --height 685 \
  --pixel-pitch 0.317 --out $WORK/screen.json

# 2. 生成校正图案
vpcal pattern generate \
  --screen $WORK/screen.json --output-dir $WORK/patterns/

# 3. 生成合成数据集
vpcal simulate \
  --screen $WORK/screen.json --num-poses 10 --noise-px 0.3 \
  --output-dir $WORK/sim --seed 42

# 4a. 空间校正
vpcal quick run \
  --config $WORK/sim/session.json --output-dir $WORK/result

# 4b. 联合镜头 + 空间校正（可选）
vpcal quick run \
  --config $WORK/sim/session.json --output-dir $WORK/result-lens \
  --estimate-lens --scipy

# 5. 生成 QA 报告
vpcal report generate --result $WORK/result/result.json

# 6. 导出 OpenTrackIO
vpcal export opentrackio \
  --result $WORK/result/result.json \
  --session $WORK/sim/session.json \
  --out $WORK/opentrackio.jsonl
```

---

## 8. 全局通用选项

所有子命令都支持以下选项：

| 选项 | 说明 |
|------|------|
| `-o, --output` | 输出格式：`text` (默认) / `json` / `ndjson` / `stream-json` |
| `--log-level` | 日志级别：`debug` / `info` / `warning` / `error` |
| `-v, --verbose` | 等同于 `--log-level debug` |
| `-q, --quiet` | 抑制非错误输出 |
| `--no-color` | 禁用 ANSI 颜色（也遵从 `NO_COLOR` 环境变量） |
| `--no-input` | 拒绝交互式提示（推荐 Agent 使用） |
| `-y, --yes` | 跳过确认提示 |
| `--dry-run` | 仅验证和计划，不写入文件 |

Agent 模式：设置 `AI_AGENT=1` 环境变量，输出自动切换为 JSON。

---

## 9. Exit Code 速查

| Code | 语义 | 场景 |
|------|------|------|
| `0` | 成功 | 所有阶段正常完成 |
| `1` | 运行时错误 | solver 发散、未预期异常 |
| `2` | 参数错误 | session config 格式错误、CLI 参数语法错误 |
| `3` | 配置错误 | 配置文件不存在或格式不合法 |
| `5` | 资源未找到 | 图像/tracking/screen 文件不存在 |
| `6` | 前置条件不满足 | pose 数 < 3、帧对齐失败、lens 模型不支持 |
| `7` | 超时 | solver 超过 timeout_seconds |
| `9` | 部分失败 | solver 收敛但置信度低 |

JSON 模式下，`error.exit_code` 与进程退出码一致，`error.code` 提供细粒度错误分类。

---

## 10. JSON Envelope 格式

所有 `--output json` 响应遵循统一信封格式：

**成功**：

```json
{
  "schema_version": "1.0",
  "status": "ok",
  "operation_id": "<operation_id>",
  "data": { ... },
  "meta": {
    "request_id": "<uuid>",
    "duration_ms": 695,
    "timestamp": "2026-06-07T04:13:47Z"
  }
}
```

**失败**：

```json
{
  "schema_version": "1.0",
  "status": "error",
  "operation_id": "<operation_id>",
  "error": {
    "code": "ARG_VALIDATION",
    "exit_code": 2,
    "message": "session config missing required field 'screen.path'",
    "retryable": false,
    "details": { ... }
  }
}
```
