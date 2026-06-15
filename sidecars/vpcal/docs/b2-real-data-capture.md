# B2 — 主路径真实数据端到端（采集准备指南）

> 路线图任务 **B2**（`docs/remediation-roadmap-v1.md` Stage 2）。本文档说明 B2 为何**当前阻塞**、
> 需要采集什么、以及如何让 `tests/integration/test_main_path_walkthrough.py` 回归测试跑起来。

## 状态：⛔ 阻塞（缺真实追踪硬件 + 数据）

B2 要求**主校准路径**（`run_quick` → Ceres/scipy + observability，经完整重投影 BA）跑一遍真实数据。
当前仓库里**没有任何主路径真实数据**：

- 唯一的实拍数据集 `_walkthrough/`（消费级显示器照片）走的是 **tracker-free 旁路**
  （逐帧 PnP + 平均，**不**经 Ceres/scipy/observability），且无追踪流。
- 主路径需要一个**真实追踪源**逐帧给出相机刚体位姿——本开发环境无此硬件，故无法执行。

代码侧的脚手架已就位（`test_main_path_walkthrough.py`，数据缺失则 skip）；**只差真实数据**。
A3（闭式手眼初始化）/ A4（held-out validation）在合成数据上已验证，B2 是它们在真实数据上的对照证据。

## 需要采集什么

### 1. 真实追踪源（三选一）
| 选项 | 说明 | 备注 |
|---|---|---|
| OptiTrack / Vicon 刚体 | 影棚级，精度最高 | 首选，结论可用于精度判断 |
| FreeD / OpenTrackIO 摄像机追踪 | 现场常见 | 需协议接入（C1 会做实时取流；离线可先手录） |
| 手机 ARKit 充当 tracker | 零成本验证流程 | ⚠ ARKit 自身漂移会进误差预算——**结论只用于流程验证，不用于精度结论** |

### 2. 采集内容
- 在 LED 屏 / 显示器上播放 `vpcal pattern generate` 生成的 **VP-QSP** 图案（normal + inverted 双帧）。
- 摆 **≥8 个机位**拍照，同步记录每帧的追踪位姿（带 timestamp 或 frame_id）。
- **关键**：额外补拍**不在训练集内、不同机位**的 **held-out 验证帧**（≥3 帧，覆盖中心/边缘/远近），
  这些帧只用于独立 `validation_rms_px`，不进求解（A4）。验证帧的追踪位姿也要记录。

### 3. 目录布局（放在仓库根 `_main_path/`，已 gitignore）
```
_main_path/
├── session.json          # images + tracking + screen + lens + validation 配置
├── captures/normal/      # 拍摄照片（与 inverted 配对）
├── captures/inverted/
├── tracking/poses.jsonl  # 逐帧追踪位姿（coordinate_system 按真实源填）
├── screen/wall.json      # 屏幕定义
└── expected.json         # （可选）回归锚点：记录首次跑通的 T_S_from_O + validation RMS
```

`session.json` 必须声明 `validation` 块（A4），否则 B2 的核心证据（独立验证 RMS）缺失：
```json
{
  "validation": { "holdout_frames": [12, 13, 14] }
}
```
或按比例：`"validation": { "holdout_ratio": 0.2 }`。

## 跑通后做什么（验收）

1. `pytest tests/integration/test_main_path_walkthrough.py` 自动取消 skip 并运行：
   - `test_main_path_solves_with_independent_validation`：主路径出 `T_S_from_O` + 独立 `validation_rms_px`；
   - `test_main_path_validation_close_to_training`：validation RMS 不显著高于训练 RMS（健康判据）；
   - `test_main_path_matches_expected_anchor`：若有 `expected.json` 则锁定回归值。
2. **A3/A4 真实数据对照**：分别在「恒等先验 vs 闭式手眼初始化」「有/无 held-out」下各跑一次，
   把 validation RMS 对比记入报告——证明合成数据上的修复在真实数据上同样成立。
3. 用 ARKit 数据时，在报告中显式标注"流程验证，非精度结论"。

## 与其它任务的衔接

- **C1 采集服务** 落地后，追踪实时接入 + 视频取流可替代手录 + 文件名配对，让 B2 数据采集 ≤5min 自动化。
- **C0 LED 处理器校验** 是真 LED 墙（非显示器）B2 的硬前置——处理器画布缩放/裁切会让 marker 3D 查表全错。
- 真 LED 墙的摩尔纹/黑格/刷新/处理器链路风险全部押后到 C0 之后的真机实测。
