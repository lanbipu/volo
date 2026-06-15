# vpcal

`vpcal` 是 LED Virtual Production 几何 / 空间校正工具。Phase 1 实现 **QuickSpatialCal MVP**——
在 LED Volume 现场快速求解 tracking 坐标系到舞台坐标系的刚体变换（`T_tracker_to_stage`），
替代人工 alignment。

**Phase 1 定位：离线计算工具。** 不控制 LED 显示或相机采集，只处理已采集好的数据。
用户需自行完成图案显示和图像 / tracking 数据采集（见 [docs/capture-workflow-guide.md](docs/capture-workflow-guide.md)）。

产物形态：Python 库 + CLI，遵循 [CLI_DESIGN_SPEC.md](../docs/CLI_DESIGN_SPEC.md)（contract-first，CLI 强制）。

---

## 核心流程

```
输入：LED 图案图像序列 + tracking 数据 + screen 定义 + lens 参数
  → 验证 (validate) → marker 检测 (detect) → 3D-2D correspondence + Ceres 最小化重投影误差 (solve) → QA 报告 (report)
输出：T_tracker_to_stage 变换矩阵 + QA 报告 + OpenTrackIO 导出
```

`quick run` 主管线内部分四阶段：`validate → detect → solve → report`，
可用 `--stage` 只运行到某个阶段。

---

## 安装

```bash
pip install .
```

首次安装会编译自定义 C++ solver（pybind11 module，内部链接 Ceres）。

**系统前置要求**（spec §1.1）：

```
必须：C++ 编译器 (gcc ≥ 9 / clang ≥ 11 / MSVC ≥ 2019), CMake ≥ 3.20
自动获取：Eigen3, glog, gflags, Ceres Solver（通过 CMake FetchContent，无需手动安装）
可选：Ninja（加速编译）
Python：≥ 3.11
```

- C++ 依赖由 CMake **FetchContent 自动拉取并编译**（Ceres Solver 及其依赖 Eigen3 / glog / gflags），
  不依赖系统预装、也**不使用** `pyceres` PyPI 包。
- **scipy fallback**：当 C++ module 编译失败或不可用时，自动降级为
  `scipy.optimize.least_squares` 纯 Python solver（标记为 slow / dev-only，结果正确性不受影响，
  result 中 `solver_backend` 会标为 `"scipy"`）。

---

## CLI 命令树（spec §2）

```
vpcal
├── quick run              # 主校正流程
├── pattern generate       # 生成 VP-QCP 图案
├── screen create          # 创建 screen 定义 JSON
├── screen import          # 从 OBJ mesh 导入 screen 定义
├── simulate               # 生成合成数据集（端到端验证）
├── report generate        # 从校正结果生成 QA 报告
├── export opentrackio     # 导出校正后 tracking 数据
├── manifest               # Contract Manifest JSON
├── schema                 # CLI JSON Schema
├── completion             # Shell 补全
└── version                # 版本信息
```

所有命令支持 CLI_DESIGN_SPEC §3.2 的必备 flag：`--help`、`--version`、`--yes`、`--dry-run`、
`--config`、`--output <text|json|ndjson>`、`--log-level`、`--verbose`、`--quiet`、`--no-color`、`--no-input`。

- `--output text`：人类可读摘要，含可操作建议
- `--output json`：单次完整 JSON 对象
- `--output ndjson`：流式事件，每行一个 JSON object

---

## Quick Start

不需要真实 LED 现场数据——先用 `simulate` 生成 ground-truth 已知的合成数据集，
再用 `quick run` 跑完整校正：

```bash
# 1. 生成一个合成 session（10 个 pose，0.5px 噪声，2% outlier）
vpcal simulate \
  --screen wall.json \
  --num-poses 10 \
  --noise-px 0.5 \
  --outlier-ratio 0.02 \
  --output-dir ./synthetic_session/

# 2. 对合成 session 运行完整校正
vpcal quick run --config ./synthetic_session/session.json --output json
```

零噪声下 solver 输出应与 ground truth 差 < 0.001；0.5px 噪声下 reprojection RMS ≈ 0.5px。

真实现场的端到端手动流程（生成图案 → LED 显示 → 采集 → 校正）见
[docs/capture-workflow-guide.md](docs/capture-workflow-guide.md)。

---

## 文档

| 文档 | 内容 |
|------|------|
| [docs/capture-workflow-guide.md](docs/capture-workflow-guide.md) | Phase 1 手动采集工作流（生成图案 → LED 显示 → 采集 → 校正），含 LED 1:1 映射警告与帧对齐策略 |
| [docs/exit-codes.md](docs/exit-codes.md) | 完整 exit code 表与 `error.code` 细粒度语义 |
| [docs/schema-versions.md](docs/schema-versions.md) | schema 版本化策略，`schema_version` vs `vpcal_version` 区别 |
| [docs/contract-manifest.json](docs/contract-manifest.json) | 当前 Contract Manifest 快照（`vpcal manifest` 输出） |
| [CHANGELOG.md](CHANGELOG.md) | 变更日志（标注 `contract_version`） |

---

## 坐标系与单位（spec §10）

- 世界坐标系（Stage）：Unreal Engine — X-forward, Y-right, Z-up（左手系）
- 相机坐标系：OpenCV — Z-forward, X-right, Y-down（右手系）
- 像素坐标：OpenCV 约定（原点左上角）
- 长度单位：毫米（mm）
- Rotation：quaternion (w, x, y, z)

solver 内部全程使用右手系，输入数据进入时一次性转换、结果导出时一次性转回。
输入 tracking 数据的源坐标系通过 session config 的 `tracking.coordinate_system` 指定
（支持 `unreal` / `optitrack` / `vicon` / `freeDEuler` / `custom`）。
