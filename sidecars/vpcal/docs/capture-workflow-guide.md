# 采集工作流指南（Phase 1 手动采集）

> 来源：[vpcal Phase 1 Implementation Spec](../../docs/vpcal_phase1_implementation_spec.md) §3.5、§3.3、§3.6、§6.6、§6.7

Phase 1 的 vpcal 是一个**离线计算工具**——它只处理已经采集好的数据，
**不控制 LED 显示，也不控制相机采集**。图案显示和图像 / tracking 数据的采集需要你自己用现场设备完成。

本指南给出从"生成图案"到"运行校正"的完整手动流程。

---

## 总览

```
步骤 1：生成图案        vpcal pattern generate
步骤 2：在 LED 墙上显示  Disguise / Unreal / Resolume 等（1:1 像素映射，见下方警告）
步骤 3：采集图像 + tracking（8-15 个 pose）
步骤 4：运行校正        vpcal quick run
```

---

## 步骤 1：生成图案

根据 screen 定义生成 VP-QCP 图案：

```bash
vpcal pattern generate --screen wall.json --output-dir ./pattern/
```

产出：

- `pattern/normal.png` — 正常图案（白色 marker on 黑色背景），分辨率匹配 LED 墙总像素数
- `pattern/inverted.png` — 反相图案（黑色 marker on 白色背景），可选但强烈推荐

---

## 步骤 2：在 LED 墙上显示

把 `normal.png` 全屏显示到 LED 墙上。可用任何能全屏输出到 LED 处理器的软件：
Disguise、Unreal Engine、Resolume，或其他播放器。

### ⚠ 关键警告：LED 1:1 像素映射

**Phase 1 假设 pattern 图像与 LED 物理像素直接 1:1 映射**——无缩放、无裁切、无色彩变换。

LED 处理器（Brompton Tessera / Megapixel HELIOS / Nova 等）的缩放、裁切、色彩管理
**不在 Phase 1 范围内**。如果 LED 处理器对图像做了任何变换，marker 在墙上的物理位置就会偏离
screen 定义算出的理论位置，**导致 marker 3D 坐标错误、solver 产出错误结果**。

确保：

- 输出分辨率 = LED 墙总像素数，pattern 全屏铺满
- 处理器侧关闭任何缩放 / scaling、裁切 / crop、画面缩放 / fit-to-screen
- 关闭可能改变像素灰度的色彩管理 / gamma / LUT（marker 检测依赖黑白对比）

> Phase 2 计划提供 LED 处理器配置导入功能来补偿这些变换；Phase 1 必须靠现场配置保证 1:1。

---

## 步骤 3：采集图像 + tracking 数据

推荐采集 **8-15 个 pose**（相机不同位置 / 角度）。硬阈值是 ≥ 3 pose（否则 solver 拒绝运行），
< 6 pose 结果会被标记为 `very_low` 置信度。

对每个 pose：

1. 把相机移动到一个新的位置 / 角度。pose 之间在空间和角度上分布越广越好（覆盖率影响精度）。
2. 拍摄一帧（或多帧取平均以降噪），保存为 `captures/normal/NNNN.png`（如 `0001.png`、`0002.png`）。
3. **同时**记录该帧对应的 tracking pose，写入 `tracking/poses.jsonl`（每行一帧）。
4. 如需 inverted 帧：把 LED 显示切换到 `inverted.png`，在**相同的 pose**再拍一帧，
   保存到 `captures/inverted/NNNN.png`（文件名与 normal 对应）。

### Normal / Inverted 双帧（§6.6）

- **Normal frame**：白色 marker on 黑色背景
- **Inverted frame**：黑色 marker on 白色背景（完全反相）
- 当 `captures/inverted/` 目录存在时，检测管线自动启用**帧差分**（normal − inverted），
  消除环境光污染和 sensor 噪声，显著提升检测鲁棒性。
- 没有 inverted 帧时直接用 normal 帧，仍可工作，但检测鲁棒性降低。

---

## session/ 目录布局（§3.3）

采集完成后，目录应组织为：

```
session/
├── session.json              # session config（见下方）
├── pattern/                  # vpcal pattern generate 产出
│   ├── normal.png
│   └── inverted.png          # 可选
├── captures/                 # 你采集的图像
│   ├── normal/               # 显示 normal 图案时拍的帧
│   │   ├── 0001.png
│   │   ├── 0002.png
│   │   └── ...
│   └── inverted/             # 可选，显示 inverted 图案时拍的帧
│       ├── 0001.png
│       └── ...
├── tracking/
│   └── poses.jsonl           # 每行一帧的 tracking pose
└── screen/
    └── wall.json             # 或 wall.obj
```

---

## 帧对齐：图像 ↔ tracking（§3.6）

**每张图像必须精确对应一条 tracking pose 记录。** 对齐错误会让 solver 产出完全错误的结果，
所以这是采集阶段最需要小心的一环。对齐策略通过 session config 的 `tracking.frame_matching` 配置：

| 策略 | 值 | 规则 |
|------|-----|------|
| frame_id 匹配（默认） | `"frame_id"` | 图像文件名中的数字 = tracking JSONL 中的 `frame_id` 字段。`captures/normal/0001.png` ↔ `{"frame_id": 1, ...}` |
| 行号匹配 | `"line_number"` | JSONL 第 N 行（0-based）= 按文件名排序后的第 N 张图像 |
| 时间戳匹配 | `"timestamp"` | 图像 EXIF 时间戳与 tracking 的 `timestamp_s` 做最近邻匹配，容差由 `tracking.timestamp_tolerance_s` 控制（默认 0.05s） |

**默认且最稳妥的策略是 `frame_id`**：用图像文件名里的数字直接对应 JSONL 里的 `frame_id`，
不依赖文件排序顺序或时钟同步。

### validate 阶段会执行的对齐检查（Stage 0）

```
- 每张图像必须有且仅有一条匹配的 tracking 记录
- 无匹配的图像   → warning（跳过该帧）
- 无匹配的 tracking 记录 → warning（忽略）
- 匹配数量 < 3   → error，exit code 6
- 输出匹配报告：matched / unmatched / skipped 帧列表
```

---

## 步骤 4：运行校正

```bash
vpcal quick run --config session.json --output json
```

`quick run` 内部依次执行四个阶段：`validate → detect → solve → report`。
可用 `--stage validate|detect|solve|report` 只运行到某个阶段——
例如先用 `--stage detect --verbose` 在正式校正前验证每帧的检测质量
（候选数、解码成功率、CRC 失败数、平均 confidence）。

成功后产出（默认写到输出目录）：

```
output_dir/
├── result.json               # 校正结果主文件（含 T_tracker_to_stage 4×4 矩阵）
├── qa/
│   ├── reprojection.json     # 重投影误差
│   ├── coverage.json         # 覆盖率
│   └── validation.json       # 输入数据验证结果
└── export/
    └── tracking_calibrated.jsonl  # OpenTrackIO 校正后 tracking
```

`--output text` 模式会给出人类可读摘要，并附带可操作建议
（例如"底部区域重投影误差偏高，建议增加该区域的 pose 采集"）。

---

## 镜头估计模式（Quick Lens Estimate，无 master lens）

> 详见 [Quick Lens Estimate spec](vpcal_quick_lens_estimate_spec.md)。

当你**没有 master lens profile**（未知镜头 / 变焦头 / 临时机位）时，加 `--estimate-lens`
让校正在同一次运行里**联合估计镜头参数**（默认 `k1,k2,cx,cy`）+ 空间对齐：

```bash
vpcal quick run --config session.json --estimate-lens --output json
# 可选：--lens-params k1,cx,cy（缩小自由集）/ --refine-focal（也估焦距）/ --cv2-bootstrap（cv2 初始化）
```

产出的镜头是 **session-coupled quick estimate**：标记非 master、**不可跨棚/跨机位复用**，QA 永远附带
identifiability warning。结果在 `result.json` 的 `quality.lens_estimate`，详细 gate 判词在
`qa/lens_observability.json`。

**镜头估计对采集的额外要求**（比纯空间校正更严）：

```
- pose 数 ≥ 8（cx/cy gate 硬要求），推荐 10–15；不足时 cx/cy 会被锁、退化为纯空间校正
- 画面边缘/四角覆盖：marker 必须铺到画面边缘——k1/k2 仅在边缘可观测
  （需 ≥25% 观测点的像素半径 > 0.35·画面对角线；中心聚集会导致 k1/k2 被锁）
- 角度多样性 ≥ 30°：纯平移 + 恒定朝向会让内参与机位简并（cx/cy 会被 revert）
- 多面墙（弧面/天花板）天然非共面，比单平面墙更利于 cx/cy 可观测
- 估焦距（--refine-focal）时：需变化 camera-to-screen 距离以降低 focal↔standoff 相关性
- 仍遵守 1:1 像素映射、frame_id 对齐、normal/inverted 双帧等所有常规要求
```

**纪律**：镜头估计**不开放 `--force`**——gate 不通过的参数会被锁定/revert 并在 QA 说明原因；
若需要可复用的高精度 master lens，请走离线 chart 标定（不在本工具范围内）。`--output text`
会打印 "QUICK LENS ESTIMATE (Session-Coupled, Non-Master)" 区块，逐参数列出 KEPT/LOCKED + 阈值对照。
