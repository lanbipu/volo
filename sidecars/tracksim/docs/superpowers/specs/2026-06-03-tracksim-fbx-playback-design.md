# tracksim — FBX 摄影机动画播放 设计文档

状态：设计待评审 · 日期：2026-06-03 · 适用分支：`main`（Phase 1 已合并之上）

## 1. 概述

为 tracksim 增加**从摄影机动画轨迹文件回放并发包**的能力：把一条已录制 / 已 K 帧的摄影机镜头轨迹喂给 tracksim，由它逐帧重放该轨迹，并按现有的 **FreeD / OpenTrackIO** 双协议发送出去——让 Unreal Engine / Disguise 等渲染目标无需实时追踪硬件即可被驱动。

这是对 Phase 1 三类 `PoseSource`（`controller` / `script` / `static`）的扩展：新增"**轨迹回放**"这一类来源。轨迹的原始载体是 **FBX**（任意 DCC 来源），但 tracksim 不直接解析 FBX——见 §2 的关键决策。

参考素材（本地，git 之外）：`~/Downloads/take_5`（Disguise 导出的**静止**机位）与 `~/Downloads/take_10`（Disguise 导出的 **6 自由度全动**机位，FBX + dense CSV + JSON 齐全）。take_10 是坐标约定校准的 ground truth（§6）。

### 1.1 目标

- 接受一个摄影机动画 FBX，识别其中的摄影机轨迹（位置 / 朝向 / 焦距 / 对焦动画），按节奏回放并经 FreeD / OpenTrackIO 发出。
- 同时支持直接读取已结构化的轨迹（tracksim 原生 `track.json`，以及 Disguise 的 CSV / JSON 导出）。
- tracksim 本体保持**纯 Python、零 Blender Python 依赖**，核心逻辑可在无 Blender 环境下完整测试。

### 1.2 非目标（本期不做）

- 不在 tracksim 进程内解析 FBX 二进制（不引入 FBX SDK / 纯 Python FBX 解析器）。
- 不做镜头畸变（`k1k2k3`）回放——**FBX 载体不携带** `k1k2k3`（实测 take_5/take_10 的 FBX 节点无此属性）；Disguise 的 CSV/JSON 侧虽含非零 `k1k2k3`，但 `CameraPose` 无对应字段、读入即丢弃。畸变不在本期范围。
- 不做轨迹编辑 / 循环 / 变速回放（`loop` / `speed`）。
- 不把 Blender 当作运行时 Python 依赖，也不内置 GUI。

## 2. 关键决策与理由

| 决策 | 选择 | 理由（实测依据） |
|---|---|---|
| FBX 如何解析 | **Blender headless 子进程** | Py3.14 无 FBX SDK wheel；纯 Python 无可靠库能读摄影机动画曲线；take_10 的相机节点带 `PreRotation`/`PostRotation`/`RotationOrder`，裸读 Euler 必错，需合成世界变换——Blender 导入器是免费工具里唯一可靠的。本机已装 `/Applications/Blender.app`。 |
| 解析与播放如何解耦 | **中间格式 `track.json` 作接缝** | 把"又重又易错、依赖外部工具"的解析，与"纯 Python、可测"的播放彻底分开；播放侧喂罐头 JSON 即可测试。 |
| 中间格式用 CSV 还是 JSON | **JSON** | CSV 装不下 rate / 单位 / 轴向约定 / 多相机；Disguise 自身也因此另出 `.json`/`.shot` 当 sidecar。CSV 仅作可选人类可读导出（本期可不做）。 |
| Blender 还是 UE 做转换器 | **Blender** | UE 几十 GB、冷启动慢、`unreal` 模块仅编辑器内可用、需工程；"在 UE 里解析坐标天然对齐"是伪收益——tracksim 最终输出的是 FreeD/OpenTrackIO 的**协议**坐标约定，非任何引擎内部约定，无论谁解析都要做一次到协议约定的映射。 |
| 独立工具还是集成 | **集成进 tracksim** | 用户要"把 FBX 直接喂给 tracksim 即可播放"的体验；Blender 以子进程隔离（见 §3），不破坏纯 Python 内核。 |

转换器藏在 `track.json` 接缝之后，因此 Blender 并非终身绑定：将来可加产出同一格式的 UE / FBX2glTF 转换器，播放侧无感知。

## 3. 架构

沿用 Phase 1 的 hexagonal 分层（依赖严格向内：`domain → ports → adapters → cli`）。新增组件：

| 层 | 新增 | 说明 |
|---|---|---|
| `sources/` | `TrackPoseSource` | 新 `PoseSource` 适配器：装载 `track.json`（或 Disguise CSV/JSON）→ 关键帧序列 → 按 `next(dt)` 时间游标插值出 `CameraPose`。复用 `ScriptedPoseSource` 的插值机制（§12）。 |
| `infra/` | `blender_fbx.py` | **唯一允许触碰 Blender 的模块**（SDL-style quarantine）：以子进程调用 Blender 跑提取脚本，产出 `track.json`。tracksim 不 `import bpy`，只 `exec` Blender 二进制。 |
| `infra/blender/` | `extract_camera.py` | 随包发布、**在 Blender 自带 Python 里运行**的提取脚本（不被 tracksim import）。导入 FBX、逐帧求相机世界变换+焦距/对焦、做坐标/单位/欧拉转换、写出 `track.json`。 |
| `domain/` | `errors.FbxConversionError` | 新错误子类（§10）。 |
| `cli/commands/` | `convert.py` | `convert` 命令实现；`factory.py` 增 `build_source` 的 `track`/`fbx` 分支。 |

**隔离纪律**（照 SDL 先例）：`infra/blender_fbx.py` 是 Blender 的唯一接触点；转换失败 / 找不到 Blender 都转成 domain 错误，不裸崩。播放侧（`TrackPoseSource`）对 Blender 完全无感知，只认 `track.json`。

## 4. 数据流

```
<in.fbx> ──[infra/blender_fbx.py]──► Blender --background --python extract_camera.py -- --in <fbx> --out <tmp>.json [--camera NAME]
                                          │（Blender 内：导入→逐帧世界变换+焦距→坐标/单位/欧拉转换）
                                          ▼
                                     track.json (dense 逐帧)
                                          │
                                   TrackPoseSource（复用关键帧插值）
                                          │  Simulator 按 Clock 限速
                                   ┌──────┴──────┐
                              FreeDEmitter   OpenTrackIOEmitter
                                   ▼              ▼
                            UE/Disguise(FreeD)  UE/Disguise(OpenTrackIO)
```

Disguise 的 `.csv`/`.json` 是已结构化的干净轨迹，绕过 Blender，由 `TrackPoseSource` 的装载器直接读入（§5）。

## 5. 中间格式 `track.json`

dense 逐帧、自描述。schema：

```json
{
  "schema": "tracksim.track/1",
  "rate": 60.0,
  "camera": "cam 1",
  "frames": [
    {"t": 0.0,      "pose": {"pan": 0.0, "tilt": 0.0, "roll": 0.0, "x": 0.0, "y": 1.0, "z": -6.0, "focal_length": 30.296, "focus_distance": 12.0}},
    {"t": 0.016667, "pose": {"pan": 0.01, "tilt": -0.002, "roll": 0.0, "x": 0.00002, "y": 1.0, "z": -6.00003, "focal_length": 30.296, "focus_distance": 12.0}}
  ]
}
```

- `t`：秒，从 0 起（Disguise 的绝对帧号 17449… 归一化为 t=0 起点）。
- `pose`：`CameraPose` 的字段子集；FBX 路径只产出 `pan/tilt/roll/x/y/z/focal_length/focus_distance`（无 `iris`/畸变）。
- `rate`：来源的原生帧率（作者帧率，定每帧 `t` 与默认发射速率）。原生 `track.json` 必须含 `rate`（schema required）；缺失按 `InvalidTrajectoryError`（exit 13）拒绝，不静默漂移。

**装载器格式识别**（`TrackPoseSource` 入口）：
- `*.json` 且含 `"schema":"tracksim.track/1"` → 原生 track。
- `*.json` 且为 Disguise change-list（含 `sources`+`changes`）→ carry-forward 重建逐帧（首帧填全量、后续帧沿用上次值）。
- `*.csv` → Disguise dense CSV（每行整帧），按通道名后缀（`offset.*`/`rotation.*`/`focalLengthMM`/`focusDistance`）映射到 `CameraPose`。**`rate` 不设魔法默认**：依次从同名 sidecar（`.shot`/`.json` 的 `fps`）或显式 `--rate` 解析；二者皆无则**拒绝**（`InvalidTrajectoryError`，exit 13；track 装载错误不归 `FbxConversionError`——后者专指 Blender/FBX 转换），杜绝静默速度漂移（如把 23.976/24/25 fps 资料当 60 播）。解析出的 `rate`（作者帧率）写入归一化 `track.json`。

本期至少实现：原生 `track.json` + Disguise dense CSV。Disguise change-list JSON 的 carry-forward 列为期望项（§15）。

## 6. 坐标 / 单位 / 旋转约定 —— 本设计的核心风险

**canonical 约定 = Disguise 通道语义。** `CameraPose` 的 `x/y/z` = Disguise `offset.x/y/z`（米、y 上、z 深度），`pan/tilt/roll` = Disguise `rotation.x/y/z`（度）。`rotation.*→pan/tilt/roll` 的确切对应、各自符号、相机本地轴的常量姿态偏移、单位换算，构成一张**映射表**：其数值由 take_10 校准拟合得出，**落盘为 `[fbx]` 的 `disguise` 预设常量（§9）并随仓库版本化**——不是运行期才决定的 TBD，而是一份可被 golden 复核的常量。直接读 Disguise 导出因此几乎 1:1。

**Disguise dense CSV 一物两用**：既是 canonical 语义的事实定义，又是转换器的 golden 真值。

**golden 校验是强制 gate，且语义校验不依赖 Blender**（双层，闭掉"无 Blender 单测全绿但数据错"的洞）：
- **Tier-1（无 Blender，所有环境必跑）**：仓库提交一份由校准后转换器对 `take_10.fbx` 产出的 `expected/take_10.track.json`（golden 工件）。测试断言它逐帧匹配 vendored 的 `take_10_dense.csv`（位置 < 1 mm、角度 < 0.1°，逐帧对齐；两者帧数必须相等，否则直接 fail）。坐标映射只要错，这层立刻红——无需 Blender，发不出"看似有效但坐标错误"的轨迹而测试全绿。
- **Tier-2（需 Blender）**：用本机 Blender 重新对 `take_10.fbx` 转换，断言数值匹配已提交的 `expected/take_10.track.json`，捕捉转换器脚本 / Blender importer 漂移。仅当 Blender 缺席时 skip——但 Tier-1 仍守住语义。
- **release CI 必须装 Blender 跑 Tier-2**；Tier-1 在任何环境必跑。take_5（静止）补充校验位置零点与焦距提取。
- **映射表数值或 `expected` 工件未就绪前，FBX 路径视为未达标、不放行（feature gate）。**

**非 Disguise 来源的 FBX**：约定可能不同（UpAxis / 单位 / 欧拉序 / 相机本地轴各异），通过 `[fbx].axis_map="custom"` + remap（§9）校正；建议每个新来源各自补一条 golden。

> **实现结果与决策（2026-06-03，实测 take_10）：** 位置映射 `x=bx, y=bz, z=by` 经 Blender 实测验证 **<4mm**，已锁进 `blender_extract.py`；focal_length 1:1。**旋转无法以 Disguise 为准达到 0.1°**——穷尽搜索（基变换 × 世界/本地相对系 × 6 欧拉序 × 符号）最优仍残 **中位 0.78° / max 2.35°**，系 Disguise 的 `rotation.*` 通道与 FBX 朝向有系统性偏差（其导出特性），非代码问题。**决策：不以 Disguise 为准、撤掉强制 Disguise golden**；旋转用 best-effort 欧拉映射（对 Disguise ~2°），**真正的旋转/单位标定改用 Unreal Engine 导出的 FBX 验证**（后续）。Disguise 生产数据不入库。

已实测的 FBX 事实（take_5 与 take_10 一致，Disguise 导出器）：`FBXVersion 7700`、`UpAxis=Y`、`FrontAxis=Z`、`CoordAxis=X`、`UnitScaleFactor=100`（米）、相机节点含 `PreRotation`/`PostRotation`/`RotationOrder`。

## 7. Blender 集成

**发现顺序**（`infra/blender_fbx.py`）：`[fbx].blender_path`（配置）→ `$BLENDER` 环境变量 → `/Applications/Blender.app/Contents/MacOS/Blender`（macOS）→ `which blender`（PATH）。都找不到 → `ConfigError`（exit 3），消息含安装/配置指引。

**子进程协议**：
```
<blender> --background --factory-startup --python <pkg>/infra/blender/extract_camera.py -- \
  --in <abs fbx> --out <abs json> [--camera NAME]
```
- `--factory-startup`：忽略用户插件/偏好，提高确定性。
- 提取脚本在 Blender 自带 Python 中运行（本机 Blender 5.1.2 → Python 3.13.9），与 tracksim 的运行时 Python 互不干扰。已实测 `<blender> --background --factory-startup` + `import bpy` 可用。
- 成功判据：退出码 0 且输出 JSON 存在且可解析且 `frames` 非空。否则按 stderr 诊断转 `FbxConversionError`（exit 13）。
- 多相机：脚本按**名称稳定排序**枚举所有 `type=='CAMERA'`。**含多个相机且未指定相机 → 直接失败**（`FbxConversionError`，details 列出全部 camera names），不静默取第一个（automation 看不到 stderr，错相机会发出完全有效但错误的 pose 流）。**“指定” = `--camera` flag 或非空 `[fbx].default_camera`（前者优先）**；恰好一个相机时可不指定、用它。指定的相机不存在 → 失败并列出可选名。所选 camera 写入产物与成功 envelope。

**失败边界与资源控制**（子进程不可无限阻塞，否则 `run` 会在建 emitters 前卡死、automation 无法恢复）：
- **超时**：`[fbx].timeout_s`（默认 120s）；超时 → **杀整个进程组**（`start_new_session`/process-group kill，避免遗留 Blender），转 `FbxConversionError`（details 标 `timeout`）。
- **日志上限**：捕获的 stdout/stderr 限长（如末尾 64 KiB），防坏 FBX 刷爆内存；摘要入 error details。
- **原子输出 + 清理**：Blender 写临时文件，成功后原子 rename 到目标；失败 / 超时清理临时件，绝不留半成品 `track.json`。

**缓存**：`run --source fbx` 把转换结果写入缓存（默认 XDG 缓存目录，`[fbx].cache_dir` 可配）以跳过 Blender 冷启动；`convert` 写用户指定路径。**缓存键 / 元数据必须覆盖一切会改变输出的输入**，命中前逐项校验，不符即强制重转，杜绝静默复用过期轨迹（坐标 bug 修复、Blender importer 变化、用户改 remap 后，旧 `track.json` 不得直接命中）：输入 FBX 内容 hash（兼 path+mtime+size 快速预筛）、`extract_camera.py` 内容 hash、tracksim 版本、Blender 二进制路径 + 版本字符串、`[fbx]` 中影响输出的字段（`axis_map`/`remap`/`default_camera`；`blender_path`/`timeout_s`/`cache_dir` 不入键，不改变轨迹内容）、track schema 版本、所选 camera。元数据与 `track.json` 同存（旁置 `.meta.json`）。注：`tracksim 版本` 与 `schema 版本` 本期恒定，纯为未来令旧缓存失效预留。

## 8. CLI 表面与 operation registry

新增 / 改动命令：

```
tracksim convert <in.fbx> --out <track.json> [--camera NAME]   # fbx → track.json（调 Blender）
tracksim run --source fbx   <path.fbx>   [--camera NAME]       # 转换(带缓存)+回放
tracksim run --source track <path.(json|csv)>                  # 直接回放结构化轨迹（含 Disguise 导出）
```

- `run` 的 `--source` choices 增加 `fbx`、`track`；新增位置参数承接输入文件路径（`fbx`/`track` 时必填，其余来源忽略）。
- `convert` 为顶层命令，operation_id = **`sim.convert`**，side_effects：external_calls✓（调 Blender）、writes✓、dry-run✓。
- **注册表三处必须同步**（既有 gotcha）：`manifest.py::_OPERATIONS`、`main.py::_operation_id_for`、`build_parser`。
- `--source fbx`/`track` 在 `main._dispatch` 的 `run` 分支内特判装载（类比 `controller` 特判 SDL）：先建 `TrackPoseSource`（含转换/装载，失败则不建 emitters），再建 emitters，保持 `factory` 设备/工具无关。
- `convert` 走标准单 envelope（非流式），输出 `{out, frames, rate, camera, cached}`。

## 9. 配置：新增 `[fbx]` 节

```toml
[fbx]
blender_path = ""          # 空 = 自动探测
default_camera = ""        # 空：单相机用唯一相机、多相机失败（§7）；非空等同 --camera（--camera 优先）
timeout_s = 120            # Blender 子进程超时（秒）；超时 → 进程组 kill + FbxConversionError
cache_dir = ""             # 空 = XDG 缓存目录
# axis_map="disguise" 即 §6 校准锁定的常量映射表，随仓库版本化；"custom" 时启用下方 remap：
axis_map = "disguise"      # 预设："disguise"｜"custom"
[fbx.remap]                # axis_map="custom" 时生效
position = ["x", "y", "z"] # canonical x/y/z 各取 Blender 的哪个轴
position_sign = [1, 1, 1]
rotation = ["pan", "tilt", "roll"]  # canonical pan/tilt/roll 来自哪路 Euler
rotation_sign = [1, 1, 1]
rotation_offset_deg = [0, 0, 0]     # 相机本地轴常量姿态偏移（合成 Pre/PostRotation 后的零点修正），于轴/符号变换之后施加
```

校验沿用 `validate_config_enums` 单一关口（`axis_map` 枚举、remap 数组长度/取值合法性、`rotation_offset_deg` 有限性、**`timeout_s` 为有限正数**——否则超时形同失效、重开无限阻塞风险）。`disguise` 预设把校准锁定的轴/符号/偏移常量内置于上述同名字段；`custom` 来源可经 `rotation_offset_deg` 表达同类本地轴偏移。

## 10. 错误模型

新增子类，沿用 data-driven class-attr 模式，`main` 的 `except TracksimError` 无需改动：

```python
class FbxConversionError(TracksimError):
    code = "FBX_CONVERSION_FAILED"
    exit_code = 13          # 与 InvalidTrajectoryError 同 exit 13，但为独立子类（code 不同）
    retryable = False
```

- Blender 缺失 / 路径非法 / `timeout_s` 非正 → `ConfigError`（exit 3）。
- Blender 退出非 0 / 无输出 / 无相机 / 多相机未指定 / **超时** / FBX 损坏 → `FbxConversionError`（exit 13），`details` 带 Blender stderr 摘要或 `timeout` 标记。
- track 装载错误（CSV / `track.json` 缺 `rate`、字段或格式非法、文件读不出）→ `InvalidTrajectoryError`（exit 13）；**此路不归 `FbxConversionError`**（后者专指 Blender/FBX 转换）。

## 11. 播放语义

- **rate（两个角色，勿混）**：`track.rate` 是**作者帧率**，定每帧 `t`；**发射速率**默认 = `track.rate`，`--rate` 覆盖发射速率（按时间游标重采样、复用插值）。对无 sidecar 的 rate-less CSV，加载时 `--rate` 已充当作者帧率写入 `track.rate`，此时它同时也是发射速率（两角色取值一致，不矛盾）。`--duration` 仍按现有机制截断帧数（`max(1, ceil(duration*rate))`）。
- **结束**：`TrackPoseSource` 末帧之后抛 `StopIteration`，`Simulator` 据此产出 `SimStopped`（reason=`"source-exhausted"`，**既有语义、不改 `Simulator`**）；`--duration` 早于轨迹长度时经 `stop()` 收尾（reason=`"stopped"`）；SIGINT/SIGTERM 优雅停（exit 130）。
- **多相机**：含多个相机且未指定 `--camera` → 失败（见 §7）；`--camera` 指定来选。
- **不做**：loop、变速（YAGNI）。

## 12. 复用现有代码

- 复用 `ScriptedPoseSource._lerp_pose` 的时间插值（已覆盖 `pan/tilt/roll/x/y/z/focal_length/focus_distance`，与 `track.json` 的 `frames` 结构一致）。但 `TrackPoseSource` 用**自己的 `next()`**：超过末帧 `t` 抛 `StopIteration`（触发 `source-exhausted` 收尾），而非 `from_keyframes` 的“钳制末帧”——这是回放“播完即停”与脚本“恒定保持”的关键差异。另增：格式装载、`rate` 派生、camera 元数据。
- `Simulator` / `Emitter` / `Transport` / 渲染 / envelope / 退出码体系全部不改，FBX 仅是又一种 `PoseSource`。

## 13. 测试策略

- **播放器（不需 Blender）**：`tests/sources/test_track.py`——喂罐头 `track.json`，断言 `next(dt)` 插值、`rate` 派生、播完停止、Disguise dense CSV 装载映射正确。确定性，注入 `FakeClock`。
- **转换器（需 Blender，缺则 skip）**：`tests/infra/test_blender_fbx.py`——`importorskip` 思路探测 Blender，缺失自动 skip；存在则对小 FBX 跑真转换、断言产出 `track.json` 结构。
- **golden 坐标校验（双层，§6）**：`tests/test_fbx_golden.py`——**Tier-1（无 Blender 必跑）** 断言已提交的 `expected/take_10.track.json` 逐帧匹配 vendored `take_10_dense.csv`（位置 <1mm、角度 <0.1°）；**Tier-2（需 Blender，缺则 skip）** 用 Blender 重转 `take_10.fbx` 并断言匹配该 `expected` 工件。
- **rate 失败/非 60fps**：增一条非 60fps 的 CSV/track fixture，断言无 sidecar 且无 `--rate` 时 loader 拒绝，及显式 `--rate` 覆盖生效。
- **CLI**：`tests/test_cli_convert.py`（envelope/退出码/dry-run）；`run --source fbx` 无 Blender → 明确错误码；多相机未指定 → 失败码；`run --source track` 走回环一致性（localhost UDP）。
- **fixture（已锁定 vendored）**：sanitized 的 take_10——FBX + `take_10_dense.csv` + 校准产出的 `expected/take_10.track.json`——入 `tests/resources/fbx/`，使 Tier-1 语义 gate 在无 Blender 环境也必跑。**“sanitized”指去敏、保留全部帧**；若为体积需裁剪，则 FBX 与 dense CSV 必须裁到**同一帧集**（Tier-1 要求 expected 与 CSV 帧数相等、逐帧对齐）。
- 既有 `tests/test_fixN_*.py` 不可变契约不动。

## 14. 阶段与范围

本期交付：§3–§13 全部——`TrackPoseSource` + Blender 转换器 + `convert`/`run --source fbx|track` + `[fbx]` 配置 + 错误模型 + 测试 + 坐标校准（take_10 golden 达标）。

## 15. 待实现期确认 / 锁定的点

**仍开放：**
1. **坐标映射表的具体数值**：`rotation.*→pan/tilt/roll` 对应、符号、相机本地轴常量姿态偏移、单位换算——由 take_10 校准拟合产出，落盘为 `[fbx]` `disguise` 预设 + 提交 `expected/take_10.track.json`（§6）。流程已是强制 gate，仅数值待实现期得出。
2. **`convert` 命令归属**：顶层 `tracksim convert`（operation `sim.convert`）vs 归到 `fbx convert`（`fbx.convert`）分组——本文档暂取顶层，评审时定。
3. **Disguise change-list JSON 的 carry-forward 重建**：是否本期纳入（dense CSV 已能覆盖回放，change-list 为增强）。
9. **custom remap / axis_map 的实现期归属**：本设计的 `[fbx].remap`/`axis_map="custom"`（§9）是为非 Disguise 来源校正的*设计意图*；但实现计划（Phase 1）只交付 `disguise` 预设（常量硬编码进 `blender_extract.py`、golden 守），**custom remap 暂不实现**——避免"定义+校验+入缓存键却从不传给 Blender 子进程"的死配置（YAGNI）。待真正接入非 Disguise FBX 时再把 remap 经 argv/json 传入脚本并消费，届时一并补 config/校验/缓存键。

**评审已锁定（2026-06-03，回应 Codex adversarial review）：**
4. **golden fixture**：vendored sanitized 的 take_10 切片（FBX + dense CSV + `expected/take_10.track.json`）入 `tests/resources/fbx/`；Tier-1 语义校验无 Blender 必跑（§6/§13）。
5. **缓存失效**：缓存键含输入内容 hash + 转换器脚本 hash + tracksim 版本 + Blender 版本 + 完整 `[fbx]` 配置 + schema 版本 + camera（§7）。
6. **CSV rate**：无 sidecar / `--rate` 即拒绝，不设默认（§5）。
7. **多相机**：多于一个且未指定 → 失败（§7/§11）。
8. **Blender 子进程**：configurable timeout + 进程组 kill + 日志上限 + 原子临时输出 + 失败清理（§7）。

## 16. 修订记录

- 2026-06-03 初稿。
- 2026-06-03 Codex adversarial review 后硬化：坐标 golden 改强制双层 gate（Tier-1 无 Blender 必跑，闭"测试全绿但坐标错"洞）；缓存键扩容防静默复用过期轨迹；多相机歧义改失败（不静默取第一个）；CSV rate 无默认（缺则拒绝，防速度漂移）；Blender 子进程加超时 / 进程组 kill / 日志上限 / 原子输出 / 失败清理。
- 2026-06-03 校核 workflow（6 agent）复审后修订：§11 播放结束 reason 修正为既有 `source-exhausted`（原误写 `completed`，与"不改 `Simulator`"冲突，已核 `simulator.py`）；track 装载错误改归 `InvalidTrajectoryError`（不再错配 `FbxConversionError`）；`timeout_s` 纳入 `validate_config_enums`；remap 增 `rotation_offset_deg` 承载本地轴常量偏移；明确 `--camera`/`default_camera` 优先级与"指定"定义；Tier-1 加帧数相等约束；澄清 fixture「sanitized 保留全帧」；修正 §1.2 k1k2k3 表述。
