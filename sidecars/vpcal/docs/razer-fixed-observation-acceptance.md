# Razer VP-QSP 固定机位单次校正验收清单

Gate：`reconstruction-calibration-geometry-investigation-spec.md` 完成且 Stage geometry qualified。

## 现场前置（硬）

- [ ] ASUS + LG 使用**同一** qualified Stage geometry artifact
- [ ] 两屏摆出 **≥30° 夹角**（gate 下限 15°）
- [ ] 不预建 Master Lens（走 `joint-session-lens` / `固定机位 · 单次校正`）
- [ ] Camera focus / zoom / resolution / crop 全程不变；每次复用 session lens 时 UI attest

## 连续三次独立采集

对每一次：

- [ ] Detection：每屏 ≥12 trustworthy、≥8 inliers；total ≥60
- [ ] Combined / per-screen / withheld RMS `<2 px`（目标 `<1 px`）
- [ ] Observability gates 全过；`formal=true`，`session_lens.session_coupled=true`，`is_master=false`
- [ ] Session lens **未**写入 `lenses/*.master-lens.json`
- [ ] Static overlay perimeter/grid 通过后再看 live preview

三次之间：

- [ ] Pose 重复性：rotation `<0.05°`，translation `<5 mm`（按现场距离归一化复核）
- [ ] Machine-readable fingerprint 不变 → result 不 stale
- [ ] 故意改 resolution/crop → result 自动 stale

## 失败路径（fail-closed）

- [ ] 近共面布置 → `SINGLE_VIEW_UNOBSERVABLE`（文案含三级建议）
- [ ] 错误相对屏位姿 → `SCREEN_GEOMETRY_INCONSISTENT`
- [ ] 不得靠调低阈值或 default intrinsics 放行

## Pin 生产默认值

验收通过后，把现场测得的阈值写回：

- `sidecars/vpcal/src/vpcal/core/fixed_observation.py` 顶部常量
- Spec §3.4 表格

记录日期 / 操作者 / commit：

| 项 | 值 |
|---|---|
| 日期 | |
| 操作者 | |
| commit | |
| edge_fraction pin | |
| withheld RMS 实测 | |
| pose 重复性实测 | |
