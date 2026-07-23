# 上屏联合重建拍摄指导（stills 多屏）

> Pipeline: `src/volo/pages/calCalibFlow.tsx`（stills 采集）→ `sidecars/mesh-vba/src/lmt_vba_sidecar/reconstruct.py`（joint BA + 自标定 + withheld 验证）
> 产物: `measurements/ASUS+…_screen_transforms.json`（屏间相对位姿唯一来源）+ `<transforms>.validation.json`
> 实例复盘见 auto-memory `volo-lgasus-rebuild-drift-weak-capture`（2026-07-23：10 张 / LG 仅 5 views → 相对位姿偏 19°/135mm）。

## 1. 照片在算法里的两种角色

联合重建把所有屏的所有 cabinet 放进**同一个 bundle adjustment**，同时解相机位姿、各屏几何与相机内参（无锚自标定）。照片按内容分两类：

- **桥接照（bridge view）**：一张照片同时检测到 ≥2 块屏。这是**屏间相对位姿的唯一约束来源**——单屏照片对屏间关系零贡献。withheld 验证硬性要求 **≥3 张桥接照**（`insufficient_bridge_views_for_holdout`）。
- **单屏照**：增加该屏观测点、提升该屏自身几何精度，并喂内参自标定。是补充，不是替代。

代码中的硬门与软门（`reconstruct.py`）：

| 约束 | 阈值 | 违反后果 |
|---|---|---|
| 每 cabinet 有效观测 | ≥2 views / ≥8 点 | 拒解（`observability_failed`） |
| 每 cabinet 观测（软） | <4 views | `low_observation` 警告，精度显著下降 |
| 自标定姿态多样性 | 照片间旋转差 ≥5°、点覆盖画面 ≥20% | 全正对 / 覆盖不足 → 自标定拒绝 |
| BA 整体 RMS | >2 px | 拒解（`ba_diverged`） |

## 2. 拍摄前准备

- **TV / 显示器必须 1:1 像素直通**：LG TV 开 PC 模式 / Just Scan，关闭一切缩放、超分、画质处理。自标定假设屏幕像素 1:1 驱动（`no_intrinsics_anchor` 警告防不住这一项），overscan 会系统性毒化内参。
- 屏幕亮度适中，避免 marker 大面积过曝反光；环境光稳定。

## 3. 拍摄流程（两屏 15–20 张）

1. **主力：双屏同框 8–12 张。** 围绕两屏中线走一道约 120° 的弧（左端 → 正中 → 右端），每走一步拍一张；两屏都完整入画，合计占画面 ≥1/3。远近变化一两档更好。
2. **每屏单独补 3–4 张**：正对到小角度侧视，屏占满画面大部分。
3. 必须**移动相机位置**换视角，不是原地转动相机——倾角多样性决定自标定可解性与三角测量基线。

单张质量要求：对焦实、不糊；入画的屏尽量完整（避免只露一条边）；掠射角不超过 ~60°（掠射下 marker 检测精度骤降）。

## 4. 验收标准（客观指标，三条全绿才算采集有效）

| 指标 | 位置 | 合格线 |
|---|---|---|
| 每屏 `observed_views` | solve digest（`measurements/visual_solves/*_solve.json` → `screens[].cabinets[]`） | ≥8 |
| 整体 `ba_rms_px` | 同上 | ≤0.5 |
| `withheld_validation.passed` | `<screen_transforms>.validation.json` | `true` |

参考值：2026-07-22 的合格采集（15 张、两屏全 15 views）RMS 0.28 px，解出屏间 69.6° / 784 mm，与卷尺实测 782 mm 吻合。

## 5. 责任判定

- 指标不全绿 → 采集不合格，先按本指导重拍，不归因算法。
- **指标全绿仍与实测明显不符**（夹角 / 间距差出几度、几厘米）→ 定性为算法 / 约定问题：直接读 `screen_transforms.json` 数值与卷尺实测对比取证。
- 中间地带：显示链路非 1:1（§2 未做到）会造成指标尚可但几何带系统性尺度误差；怀疑时用 `--intrinsics-crosscheck` 锚点验证。

注意：withheld 验证结果目前只被导出 gate 读取（`src-tauri/src/commands/mesh_export.rs`），重建结果页 UI 不展示——重建完成后需手动查看 `validation.json`。
