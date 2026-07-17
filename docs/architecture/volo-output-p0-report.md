# Volo Output P0 验收报告

## 1. 结论

P0 gate 已通过：`BP_VoloOutput` 编译与保存、单节点 A/B/clear、manifest 半写容错以及原生尺寸像素 1:1 均已在 UE 5.8 实测确认。

验收资产已收进：

`src-tauri/resources/ue-template/VoloOutput/Content/VoloOutput/BP_VoloOutput.uasset`

## 2. A-P2 启动参数基线

```text
UnrealEditor.exe <project.uproject>
  -game
  -messaging
  -dc_cluster
  -dc_cfg=<cluster.ndisplay>
  -dc_node=<NodeId>
  -dc_dev_mono
  -windowed
  -ResX=<window width>
  -ResY=<window height>
  -RemoteControlIsHeadless
  -RCWebControlEnable
  -ClusterForceApplyResponse
  -log
```

`-dc_dev_mono` 是 UE 5.8 的必要基线参数。缺少它时日志会显示 `No rendering device specified` / `No stereo device created`，进程虽然存活，但不会创建可承接 Viewport Texture Replacement 的 nDisplay 渲染设备。

## 3. 单节点验收记录

| 用例 | 输入 | 结果 |
| --- | --- | --- |
| A 图 + crop | `revision=1`, `show`, A 图, crop `(4,0,4,4)` | 仅显示绿/黄区域，apply 一次 |
| B 图切换 | `revision=2`, B 图 | PID 不变，画面切换 |
| clear | `revision=3`, `mode=clear` | PID 不变，恢复黑场 |
| 半写容错 | 截断 revision 4，等待后原子替换完整版 | 截断期间画面不变；完整版只 apply 一次 |

manifest 发布必须先写同目录临时文件，再用原子 rename/replace 覆盖正式路径；不能直接原地编辑正式 JSON。

## 4. 像素 1:1 与双线性边界

UE 5.8 的 nDisplay copy shader 在输入矩形与输出矩形尺寸相等时使用 `SF_Point`，尺寸不等时强制使用 `SF_Bilinear`：

`Engine/Plugins/Runtime/nDisplay/Source/DisplayClusterShaders/Private/Shaders/DisplayClusterShadersCopyTexture.cpp:164`

因此：

- `Texture2D.Filter=Nearest`、`MipGenSettings=NoMipmaps` 仍需设置；
- 但 `Filter=Nearest` 无法覆盖 nDisplay 在缩放 copy 阶段选择的 `SF_Bilinear`；
- 像素 1:1 的硬前提是每个节点的 manifest crop 尺寸与该节点窗口/viewport 输出尺寸完全一致；
- `window_px != viewport_rect_px[w,h]` 会引入缩放，属于校正正确性错误，不是视觉偏好。

64×64 棋盘格、1 px 边框和四角 marker 已在 64×64 原生输出条件下验证：无插值毛边、无一像素 crop 偏移。

## 5. 后续兼容性

UE 5.7 双机验证延后至 Razer SSH 恢复。UE 5.8 保存的 `.uasset` 可能无法由 5.7 加载；若复验证实，一期 preflight 应直接拒绝非 UE 5.8，并在用户文档中声明。
