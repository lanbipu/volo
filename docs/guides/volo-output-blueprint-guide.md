# BP_VoloOutput / AVoloOutputRoot 指南

## 1. 目标

运行时根演员是 `AVoloOutputRoot`（C++，`VoloOutput` 模块）。`BP_VoloOutput` 是
其 DisplayClusterBlueprint 子类，保留 `VoloScreen` 等 nDisplay 场景组件；EventGraph
在 S2 起已清空，轮询 / show / clear / sequence 逻辑全部在 C++ 中。

`.ndisplay` 的 `assetPath` 仍为：

```text
/Game/VoloOutput/BP_VoloOutput.BP_VoloOutput
```

（nDisplay 无法把 `/Script/VoloOutput.VoloOutputRoot` 当配置资产加载。）

## 2. 插件与项目

`VoloOutput.uproject`：

- Modules：`VoloOutput`（Runtime）
- Plugins：nDisplay、TextureShare、Remote Control、Remote Control Web Interface、
  Json Blueprint Utilities

`DefaultEngine.ini` 使用 `DisplayClusterGameEngine` 与 `DisplayClusterViewportClient`，
启动关卡为 `/Engine/Maps/Entry`。

模板必须附带预编译：

```text
Binaries/Win64/UnrealEditor-VoloOutput.dll
Binaries/Win64/UnrealEditor.modules
Binaries/Win64/VoloOutputEditor.target
```

缺少 `.target` 时 `UnrealEditor.exe -game` 会卡在 UBT/receipt 探测。

## 3. 成员（C++ `AVoloOutputRoot`）

| 变量 | 类型 | 默认值 |
| --- | --- | --- |
| `ManifestPath` | FString | `C:\ProgramData\UECM\ndisplay-output\session\manifest.json` |
| `LastRevision` | int64 | `-1` |
| `ActiveTexture` | UTexture2D* | null |
| `PollInterval` | float | `0.5` |
| `Frames` | TArray\<UTexture2D*\> | 空（防 GC） |
| `SeqRevision` / `SeqFps` / `SeqT0` | int64 / float / double | `-1` / `2` / `0` |
| `SeqState` | Idle / Preloading / Ready / Playing | Idle |
| `ReadySet` | TSet\<FString\> | 空（primary） |

## 4. BeginPlay

- 注册 JSON cluster event listener（`volo.sl.ready` / `volo.sl.start`）
- `SetTimer` 每 `PollInterval` 调用 `PollManifest`
- 序列步进在 `Tick`（仅 Playing / Preloading）

## 5. PollManifest

1. 读 manifest JSON；失败立即返回。
2. 仅当 `revision > LastRevision` 时继续。
3. `mode == clear`：中止序列（若在播）→ 关 replace → 更新 revision。
4. `mode == sequence`：进入预载（§5.1）。
5. show：`ImportFileAsTexture2D`（`FImageUtils`）→ SRGB / NoMipmaps / Nearest →
   写本节点 viewport `Replace` + crop → `SetReplaceTextureFlagForAllViewports(true)`。

### 5.1 序列模式

1. 解析 `sequence_dir` / `frame_count` / `fps` / crop。
2. Preloading：每 tick 导入 1–2 帧到 `Frames[]`；预载期间黑场。
3. 完成：日志 `VoloOutput: sequence ready rev=<n> node=<id>`，emit `volo.sl.ready`。
4. Primary 收齐 cluster node ids → emit `volo.sl.start`。
5. 全集群收到 start：`SeqT0 = GameTime`，Playing；日志
   `VoloOutput: sequence start rev=<n>`。
6. Playing：`idx = floor((t - SeqT0) * fps)` 换 `SourceTexture`；越界 → 黑场 +
   `VoloOutput: sequence done rev=<n>`。
7. clear 中途：`VoloOutput: sequence abort rev=<n>`。

S2 实测（Razer 单节点，20 帧 @ 2 fps）：预载约 **1.72 s**；start→done ≈ **10.0 s**。

## 6. 源码位置

```text
src-tauri/resources/ue-template/VoloOutput/Source/VoloOutput/
  VoloOutputRoot.h/.cpp
  VoloOutput.Build.cs
```

真机重编：

```bat
"%UE%\Engine\Build\BatchFiles\Build.bat" VoloOutputEditor Win64 Development ^
  -Project="C:\ProgramData\UECM\ndisplay-output\VoloOutput\VoloOutput.uproject" -WaitMutex
```

BP 重父类（编辑器，交互桌面会话）：

```text
UnrealEditor.exe VoloOutput.uproject -ExecutePythonScript=.../reparent_bp.py
```

## 7. nDisplay 配置命名

- cluster node / viewport 名与拓扑一致
- Simple Projection screen component：`VoloScreen`（在 BP SCS 上）

## 8. 单节点验收（摘要）

生产启动必须经 Interactive 计划任务；缺 `-dc_dev_mono` 不会创建 nDisplay 渲染设备。
序列验收看固定前缀日志 + 视觉帧序；CLI：`voloctl output play-sequence`。
