# BP_VoloOutput Blueprint 指南

## 1. 目标

`BP_VoloOutput` 是 nDisplay Root Actor Blueprint。它定时轮询 manifest，把节点对应的 PNG 作为 Viewport Texture Replacement 输入，并保留纹理成员引用以避免 GC。

## 2. 插件与项目

项目启用：

- nDisplay
- Json Blueprint Utilities
- Remote Control
- Remote Control Web Interface

`DefaultEngine.ini` 使用 `DisplayClusterGameEngine` 与 `DisplayClusterViewportClient`，启动关卡为 `/Engine/Maps/Entry`。

## 3. 成员变量

| 变量 | 类型 | 默认值 |
| --- | --- | --- |
| `ManifestPath` | String | `C:\ProgramData\UECM\ndisplay-output\session\manifest.json` |
| `LastRevision` | Integer | `-1` |
| `ActiveTexture` | Texture2D Object Reference | 空 |
| `PollInterval` | Float | `0.5` |

`ActiveTexture` 必须是成员变量，用于持有导入纹理引用，避免运行时 GC 后黑屏。

## 4. BeginPlay

使用 `Set Timer by Event`：`Time=PollInterval`、`Looping=true`，事件绑定 `PollManifest`。不要使用 Tick。

## 5. PollManifest

1. `Load Json from File`；失败立即返回。
2. 仅当 `revision > LastRevision` 时继续；所有失败路径都不能更新 `LastRevision`。
3. `mode == "clear"` 时调用 `SetReplaceTextureFlagForAllViewports(false)`，成功后更新 revision。
4. show 路径调用 `Import File as Texture 2D`，结果写入 `ActiveTexture`，依次设置 `SRGB=true`、`MipGenSettings=NoMipmaps`、`Filter=Nearest`。
5. 通过 `Get Current Config Data → Cluster → Nodes → Find(Get Node ID) → Viewports → Values → [0]` 定位本节点 viewport。
6. 从顶层读取 `image_path` 与 `crop_x`、`crop_y`、`crop_w`、`crop_h`。注意：现存手工 `BP_VoloOutput.uasset` 实际读取的字段名是 `texture_path`（偏离本指南），生产 manifest 因此双字段同发；新建/修复 Blueprint 时应统一改回 `image_path`。组装 Replace：`bAllowReplace=true`、`SourceTexture=ActiveTexture`、`bShouldUseTextureRegion=true`，`TextureRegion` 写入这四个 crop 值。
7. `Set Members in RenderSettings` 后必须连接 `Set Render Settings` 写回；只修改 struct 副本不会生效。
8. 调用 `SetReplaceTextureFlagForAllViewports(true)`；全部成功后才更新 `LastRevision`。

`TextureRegion` 在不同 Blueprint UI 中可能显示为 `IntRect`，也可能展开成 `Origin + Size`，按实际引脚形态填写同一组 `crop_x/y/w/h`。

## 6. nDisplay 配置命名

Blueprint 与外部 `.ndisplay` 必须一致：

- cluster node：例如 `LanNode`
- viewport：例如 `LanViewport`
- Simple Projection screen component：`VoloScreen`

外部配置引用 `VoloScreen` 时，Root Actor Blueprint 中也必须存在同名 screen component，否则会持续报 `Couldn't create warp interface`。

## 7. 单节点验收

### 7.1 启动命令

```powershell
"D:\Program Files\Epic Games\UE_5.8\Engine\Binaries\Win64\UnrealEditor.exe" "C:\ProgramData\UECM\ndisplay-spike\VoloOutputSpike.uproject" -game -messaging -dc_cluster -dc_cfg="C:\ProgramData\UECM\ndisplay-spike\lan-rc-only.ndisplay" -dc_node=LanNode -dc_dev_mono -windowed -ResX=800 -ResY=600 -RemoteControlIsHeadless -RCWebControlEnable -ClusterForceApplyResponse -log
```

UE 5.8 缺少 `-dc_dev_mono` 时不会创建 nDisplay 渲染设备；不能以“进程仍在运行”判断启动成功。

生产启动参数另需 `-NoScreenMessages`：`dc_dev_mono` 使视图成为 stereo view，引擎会在左上角常驻 `StereoView: Primary` 调试字并上墙。生产启动还必须经 Interactive 计划任务落到交互桌面会话，SSH 网络登录直启会因 session 0 无桌面报 `DXGI_ERROR_NOT_CURRENTLY_AVAILABLE` 秒崩（见 `volo-output-orchestration.md`）。

### 7.0 已知缺陷（装饰性）

2026-07-17 晚节点级直测确认：revision 门控**正常**（每个新 revision 恰好 apply 一次，12 个轮询周期零重复；clear 正常清屏）。唯一遗留是 `Print String` 拼接的 revision 恒打印 `1`，不反映 manifest 真实值——排障读日志时勿被误导；修正需在编辑器把该打印的输入引脚改接解析出的 revision 变量。

### 7.2 A 图 + crop

`revision=1`、`mode=show`、A 图、crop `(4,0,4,4)`。应只显示绿/黄区域并 apply 一次。

### 7.3 B 图与 clear

用新 revision 切换 B 图，再用 `mode=clear` 清空；两步 PID 均不得变化。

### 7.4 半写容错

先放入截断 JSON，等待至少三个轮询周期，再以同目录临时文件原子替换完整版。截断期间不得改变画面或 revision；完整版只 apply 一次。

## 8. 像素 1:1

使用 64×64 硬边测试图：1 px 棋盘格、1 px 边框、四角 marker。测试时 crop、viewport region 与窗口输出必须同为 64×64。

nDisplay 在输入输出尺寸不同时会强制使用 `SF_Bilinear`；`Filter=Nearest` 不能覆盖该 copy shader 决策。因此放大 64×64 到 800×600 不是像素 1:1 验收条件。
