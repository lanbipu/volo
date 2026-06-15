# tracksim 手柄 Zoom / Focus 控制 —— 设计文档 (v2)

- 日期：2026-06-03
- 状态：v2，已纳入 Codex 挑战式 review，待出实现计划
- 关联：`docs/superpowers/specs/2026-06-02-tracksim-design.md`（§13 默认映射开放项，由本设计落地）
- 修订：见文末「修订记录」——v2 针对 Codex adversarial review 调整了拨片映射的论证依据与 mapping 校验策略

## 1. 背景与问题

`tracksim` 的 `CameraPose` 早已带有 `focal_length`（变焦，mm）和 `focus_distance`
（对焦距离，m）两个字段（`domain/pose.py`），`ControllerPoseSource` 也把 mapping 里每条的
`channel` 直接 `CameraPose(**channels)` 展开（`sources/controller.py`）。所以**底层有能力把手柄
轴/键映射到变焦/对焦，缺的不是能力，而是三样东西**：

1. **没有任何默认映射**。`config.py` 里 `ControllerCfg.mapping` 默认是 `[]`，手柄开箱即用「完全
   不动」——连 pan/tilt 都没绑，更没有 zoom/focus。
2. **变焦需要双向，扳机是单向的**。SDL 后端暴露的模拟量里只有摇杆是双向 `-1..1`，扳机是单向
   `0..1`。变焦要能「推近 + 拉远」，单个扳机做不到。
3. **拨片根本没被读取**。`infra/sdl_controller.py` 的 `poll()` 只读了
   `a/b/x/y/双肩键/back/start`，没读 Xbox Elite 的 4 个背板拨片。

### 用户约束（已确认）

- 设备：Xbox Elite 手柄（macOS）。
- 现有 config：摇杆已绑 pan/tilt + 平移，**LT/RT 已绑「上升/下降」（z 轴高度）**，扳机已占用。
- 诉求：把 **变焦（Zoom）和对焦（Focus）放到 4 个背板拨片 P1–P4** 上。
- 分组决定：**上排双拨片（P1/P3）= 变焦，下排双拨片（P2/P4）= 对焦**。
- 交付形态：**后端读取拨片 + 内置一套完整默认映射**。

## 2. 已核实的技术事实

### 2.1 SDL 暴露的拨片常量（实测 `dir(sdl3)`）

环境 `.venv`：PySDL3 `0.9.11b1`，SDL 运行库 `3.4.8`：

```
SDL_GAMEPAD_BUTTON_RIGHT_PADDLE1 = 16
SDL_GAMEPAD_BUTTON_LEFT_PADDLE1  = 17
SDL_GAMEPAD_BUTTON_RIGHT_PADDLE2 = 18
SDL_GAMEPAD_BUTTON_LEFT_PADDLE2  = 19
```

### 2.2 拨片名 ↔ 物理位置 ↔ Elite P 编号（依据 SDL 官方头文件，verbatim）

`SDL_gamepad.h`（`libsdl-org/SDL` 主分支）对这四个常量的文档注释逐字如下：

| SDL 常量 | 头文件注释（节选） | 物理位置 | Elite |
|---|---|---|---|
| `RIGHT_PADDLE1` | *Upper or primary paddle, under your right hand (e.g. Xbox Elite paddle P1 …)* | 右上 | **P1** |
| `LEFT_PADDLE1` | *Upper or primary paddle, under your left hand (e.g. Xbox Elite paddle P3 …)* | 左上 | **P3** |
| `RIGHT_PADDLE2` | *Lower or secondary paddle, under your right hand (e.g. Xbox Elite paddle P2 …)* | 右下 | **P2** |
| `LEFT_PADDLE2` | *Lower or secondary paddle, under your left hand (e.g. Xbox Elite paddle P4 …)* | 左下 | **P4** |

**结论**：本设计把 config 名 `p1/p2/p3/p4` 对到上表，**与 SDL 文档契约逐字一致**（upper=P1/P3、
lower=P2/P4），并与用户「上排 P1/P3、下排 P2/P4」心智模型自洽。默认映射的拨片分组（上排=变焦、
下排=对焦）建立在 SDL 文档之上，而非假设。

### 2.3 实机层面的残留风险与首次验证（无手柄无法代验）

SDL 文档保证的是「名 ↔ 物理位置」的契约；HIDAPI 驱动是否在具体固件/连接下如实上报，仍需真机确认。
**已知的真实失败模式只有两类，且都不严重：**

1. **拨片收不到信号（安全）**。两种诱因：
   - 连接方式：USB-C 有线最稳；蓝牙在 macOS 对 Elite 拨片上报历史上较飘。
   - profile 未清空：Elite 默认把拨片映射成镜像 ABXY（按 P1 实际发 A）。需在 Xbox Accessories app
     里把 4 个拨片设为「未分配/清空」，它们才会作为 PADDLE 位单独上报。
   - 后果：zoom/focus「不动」，不会误绑到错误的 channel——属安全退化，`controllers monitor` 一眼可辨。
2. **谁进谁退方向偏好**。默认 P1=变焦推近、P3=拉远、P2=对焦远、P4=近；若偏好相反，改一个 `invert`
   即可（一行配置）。

**首次验证流程（交付一等步骤，写入 CLI 流程文档）**：
拨片读入 `poll()` 后，跑 `tracksim controllers monitor`，USB-C 与蓝牙各试一次，逐个按 P1–P4 确认：
(a) 4 个能独立 toggle；(b) 物理位置与 `p1..p4` 名对得上。任一不符 → 改 config（纯配置），并在文档记录
实测到的对应关系。

## 3. 设计

### 3.1 SDL 后端读取 4 拨片（`infra/sdl_controller.py`）

`poll()` 返回的 `buttons` 字典新增 4 个布尔键，对应 §2.2 的 SDL 常量：

```python
buttons = {
    # ...existing a/b/x/y/leftshoulder/rightshoulder/back/start...
    "p1": button(sdl.SDL_GAMEPAD_BUTTON_RIGHT_PADDLE1),  # 右上
    "p2": button(sdl.SDL_GAMEPAD_BUTTON_RIGHT_PADDLE2),  # 右下
    "p3": button(sdl.SDL_GAMEPAD_BUTTON_LEFT_PADDLE1),   # 左上
    "p4": button(sdl.SDL_GAMEPAD_BUTTON_LEFT_PADDLE2),   # 左下
}
```

Fake sdl3（测试）与真实 SDL 共用 `SDL_GetGamepadButton(gp, code)` 读取路径，无需特判。

### 3.2 source 词汇表常量（`ports/controller_input.py`）—— 支撑 completeness

把「一个 `ControllerState` 能包含哪些 axis / button 键」固化为端口层常量，作为 SDL 后端产出与
mapping 校验共同引用的单一事实来源（避免校验器误杀后端真能产出的 source）：

```python
CONTROLLER_AXES = frozenset({
    "leftx", "lefty", "rightx", "righty", "lefttrigger", "righttrigger",
})
CONTROLLER_BUTTONS = frozenset({
    "a", "b", "x", "y", "leftshoulder", "rightshoulder", "back", "start",
    "p1", "p2", "p3", "p4",
})
CONTROLLER_SOURCES = CONTROLLER_AXES | CONTROLLER_BUTTONS
```

约束（测试守护）：`SDLControllerInput.poll()` 产出的键集合必须等于 `CONTROLLER_SOURCES`。

### 3.3 内置默认映射 `DEFAULT_CONTROLLER_MAPPING`（`config.py`）

定义为 `list[ControllerMappingEntry]` 常量。**仅当 `config.controller.mapping` 为空时启用**；用户给出
非空 mapping 时整体覆盖（不做逐 channel 合并，行为简单可预测）。

变焦/对焦用「一对拨片各管一个方向」实现双向——rate 模式两条绑同一 channel，`next()` 的累加循环已支持
（第二条读到第一条更新后的值再叠加）。方向用 `invert` 区分。

完整默认映射（`scale`/`clamp` 为「实测手感后微调」的起点值，全可配；正负号是初始猜测）：

| 控件 | source | channel | mode | scale | invert | deadzone | clamp_min | clamp_max |
|---|---|---|---|---|---|---|---|---|
| 左摇杆 X | `leftx` | `x` | rate | 1.0 | false | 0.1 | -10 | 10 |
| 左摇杆 Y | `lefty` | `y` | rate | 1.0 | true | 0.1 | -10 | 10 |
| 右摇杆 X | `rightx` | `pan` | rate | 60 | false | 0.1 | —(None) | —(None) |
| 右摇杆 Y | `righty` | `tilt` | rate | 60 | true | 0.1 | -90 | 90 |
| LT | `lefttrigger` | `z` | rate | 1.0 | true | 0.05 | 0 | 10 |
| RT | `righttrigger` | `z` | rate | 1.0 | false | 0.05 | 0 | 10 |
| LB | `leftshoulder` | `roll` | rate | 30 | true | 0.0 | -30 | 30 |
| RB | `rightshoulder` | `roll` | rate | 30 | false | 0.0 | -30 | 30 |
| **P1 右上** | `p1` | `focal_length` | rate | 50 | false | 0.0 | 12 | 300 |
| **P3 左上** | `p3` | `focal_length` | rate | 50 | true | 0.0 | 12 | 300 |
| **P2 右下** | `p2` | `focus_distance` | rate | 1.0 | false | 0.0 | 0.1 | 100 |
| **P4 左下** | `p4` | `focus_distance` | rate | 1.0 | true | 0.0 | 0.1 | 100 |

语义说明：
- pan 不 clamp（允许 360° 自由旋转）；tilt clamp ±90°。
- LT/RT 都绑 `z`、方向相反 → 双向高度控制，与用户实际用法一致。**这正式取代设计 §13 里「扳机 =
  zoom/focus」的暂定写法。**
- P1/P3 都绑 `focal_length`（P1 进、P3 退）；P2/P4 都绑 `focus_distance`（P2 远、P4 近）。
- 拨片是数字键（按下 value=1.0），rate 模式下 = 按住匀速变、松开停。

启用位置：`cli/main.py::_dispatch` 的 `controller` 分支，构造 source 前替换：

```python
mapping = config.controller.mapping or DEFAULT_CONTROLLER_MAPPING
```

### 3.4 rate channel 初始值播种（`sources/controller.py`）

**问题**：rate 模式现在从 `self._channels.get(channel, 0.0)` 即 `0.0` 起积分。对 pan/tilt/x/y/z 无碍
（静止本就是 0），但 `focal_length` 会从 0mm 起、`focus_distance` 从 0m 起——等于开机焦距为 0。

**改法**：`ControllerPoseSource.__init__` 用 `CameraPose()` 的字段默认值给每个 mapped channel 播种：

```python
base = CameraPose()
for entry in self._mapping:
    self._channels.setdefault(entry.channel, getattr(base, entry.channel, 0.0))
```

效果：`focal_length` 起于 35mm、`focus_distance` 起于 3m，其余仍为 0。

向后兼容性：
- 现有 rate 映射（pan/tilt/x/y/z）的 CameraPose 默认值都是 0，播种后行为不变。
- absolute 模式每 tick 覆盖 channel，播种值会被立即覆盖，无影响。

> **播种只限合法 channel（v3 修正，见修订记录）**：仅对 `entry.channel in VALID_POSE_CHANNELS`
> 的条目播种。否则 `getattr(base, channel)` 对像 `model_dump` 这类「恰是 CameraPose 方法名」的
> 非法 channel 会取回绑定方法并塞进 `_channels`，首次 `next()` 的 `+=` 直接 TypeError。非法 channel
> 不播种 → `next()` 走 `get(ch, 0.0)` 兜底为无害 no-op（被 `CameraPose` 的 `extra="ignore"` 丢弃）。

不引入 per-entry `initial` 字段（YAGNI）；rest 值的单一来源就是 `CameraPose` 默认值。

### 3.5 mapping 校验：严格只在 `config validate`，运行时警告不中断

**问题**：现在 channel 名拼错被 Pydantic 静默忽略（`CameraPose` 默认 `extra="ignore"`），source 名拼错
`axes.get(..., 0.0)` 静默返回 0——配了等于没配且不报错。用户接下来手写拨片条目，极易踩坑。

**约束（来自 adversarial review，finding 2）**：当前「静默忽略」是既有行为；若改成运行时硬 `ConfigError`
(exit 3)，会让原本能跑（降级为 no-op）的 config 直接起不来——破坏性变更。故**分两档**处理：

1. **纯函数 `check_controller_mapping(mapping) -> list[str]`**（建议置于 `cli/commands/factory.py`），
   逐条检查，返回问题描述列表（空 = 干净），**自身不抛异常**。判定规则：
   - `channel ∈ VALID_POSE_CHANNELS`（见下）
   - `source ∈ CONTROLLER_SOURCES`（§3.2，从后端实际产出键派生）
   - `mode ∈ {"rate", "absolute"}`
   - `modifier`（若非 None）∈ `CONTROLLER_BUTTONS`
   每条问题文案带条目下标、字段、收到值与建议（如 `entry[2]: unknown source 'P1'（合法集合: …）`）。

2. **`config validate` 命令（`cli/commands/config_cmd.py`）**：在现有 `validate_config_enums` 之后调用
   `check_controller_mapping`；**非空 → 抛 `ConfigError`(exit 3)**，`details` 带全部问题。这是该命令的
   本职（显式严格校验），属新增的按需能力，非回归。

3. **控制器运行路径（`main._dispatch` 的 `controller` 分支）**：构造 source 后调用
   `check_controller_mapping`；**每条问题 → 输出一行 stderr 人类警告日志，跳过该条目、继续运行**。
   非破坏：原本能跑的 config 仍能跑，同时「不再静默」（满足 fail-loudly 诉求）。

> **明确不改 `validate_config_enums`**：它被 `build_emitters`（运行时）调用，若把 mapping 硬校验塞进去
> 会让 `run` 直接硬失败——正是 review 指出的回归。mapping 严格校验只走 `config validate`。

`VALID_POSE_CHANNELS`：建议在 `domain/pose.py` 定义为 `CameraPose` 字段减去 `{frame, timestamp, rate}`：
`{pan, tilt, roll, x, y, z, focal_length, focus_distance, iris, entrance_pupil}`。`source`/`channel` 命名
空间相互独立（`source` 是手柄输入名，`channel` 是 pose 字段名），`x`/`y` 在两边各有含义不冲突。

### 3.6 给现有 config 的可粘贴片段

因默认映射「全空才生效」、不与用户 mapping 合并，单独提供 zoom/focus 拨片条目供追加到现有
`[controller].mapping`（TOML 示例，写入 CLI 流程文档）：

```toml
[[controller.mapping]]   # P1 右上：变焦推近
channel = "focal_length"
source = "p1"
mode = "rate"
scale = 50.0
clamp_min = 12.0
clamp_max = 300.0

[[controller.mapping]]   # P3 左上：变焦拉远
channel = "focal_length"
source = "p3"
mode = "rate"
scale = 50.0
invert = true
clamp_min = 12.0
clamp_max = 300.0

[[controller.mapping]]   # P2 右下：对焦拉远
channel = "focus_distance"
source = "p2"
mode = "rate"
scale = 1.0
clamp_min = 0.1
clamp_max = 100.0

[[controller.mapping]]   # P4 左下：对焦拉近
channel = "focus_distance"
source = "p4"
mode = "rate"
scale = 1.0
invert = true
clamp_min = 0.1
clamp_max = 100.0
```

## 4. 受影响文件

| 文件 | 改动 |
|---|---|
| `src/tracksim/infra/sdl_controller.py` | `poll()` buttons 字典新增 p1–p4 |
| `src/tracksim/ports/controller_input.py` | 新增 `CONTROLLER_AXES/BUTTONS/SOURCES` 常量；按键注释补 p1–p4 |
| `src/tracksim/domain/pose.py` | 新增 `VALID_POSE_CHANNELS` 常量 |
| `src/tracksim/config.py` | 新增 `DEFAULT_CONTROLLER_MAPPING` 常量 |
| `src/tracksim/sources/controller.py` | `__init__` 播种 rate channel 初始值 |
| `src/tracksim/cli/commands/factory.py` | 新增 `check_controller_mapping()` 纯函数 |
| `src/tracksim/cli/commands/config_cmd.py` | `config validate` 调用 `check_controller_mapping`，非空 → ConfigError(3) |
| `src/tracksim/cli/main.py` | controller 分支：空 mapping 用默认；建 source 后跑 mapping 检查 → stderr 警告、不中断 |
| `tests/test_sdl_controller_poll.py` | `test_poll_maps_buttons` 按键集合断言补 4 拨片 |
| `docs/tracksim-CLI-运行流程.md` | §7 补拨片接线 / Accessories 取消指派 / monitor 验证 / 默认映射说明 |
| `docs/superpowers/specs/2026-06-02-tracksim-design.md` | §13 标记默认映射已落地 |

**不触碰**：协议编码（FreeD / OpenTrackIO emitter）、transport、envelope、`validate_config_enums`
的既有 enum 校验、其余命令的运行时行为。

## 5. 测试计划（TDD，红 → 绿 → commit）

1. **`poll()` 读拨片**：Fake sdl3 注入拨片常量 16–19，按下 → `state.buttons["p1".."p4"]` 为 True；
   未按为 False。更新 `test_poll_maps_buttons` 按键集合断言含 p1–p4，并断言 == `CONTROLLER_SOURCES` 的按键部分。
2. **默认映射启用**：`config.controller.mapping == []` 时，controller 路径用 `DEFAULT_CONTROLLER_MAPPING`
   （断言条目数与关键条目存在；非空 config 时不替换）。
3. **拨片双向积分**：FakeControllerInput 脚本化 → 按住 P1 三 tick 焦距上升、P3 下降、同按一 tick 抵消；
   焦距 clamp 在 12–300。
4. **初始播种**：mapping 含 focal_length/focus_distance、未动拨片时首帧 `focal_length==35`、
   `focus_distance==3`；pan 等仍为 0。
5. **`check_controller_mapping` 纯函数**：坏 `channel`/坏 `source`/坏 `mode`/坏 `modifier` 各返回非空问题；
   合法 mapping 返回空列表。
6. **`config validate` 严格档**：含坏条目的 config → 命令 exit 3、envelope 带问题 details；干净 config → ok。
7. **控制器运行宽松档（非破坏，防回归 finding 2）**：含坏条目的 mapping 走 controller 路径 → **不** exit 3，
   sim 正常启动并产出帧，坏条目被跳过（断言对应 channel 不受影响 + 有警告输出）。
8. **回归**：全量 `pytest` 绿（尤其不破坏 F7 无 clamp、F32 controller close、fix7 button mapping、
   fix25 `config validate` enum 等）。

成功判据：上述测试全绿 + `pytest` 全量通过 + `controllers monitor` 在真机（USB-C 与蓝牙）上能看到
p1–p4 独立 toggle（真机验证由用户执行，文档给出步骤）。

## 6. 明确不做（YAGNI）

- 不加 per-entry `initial` 字段（用 CameraPose 默认播种已够）。
- 不做默认映射与用户 mapping 的逐 channel 合并（全空才生效，简单可预测）。
- 不暴露 D-pad / 摇杆按下等其余按键（本次只需拨片；未来按需再加）。
- 不引入 Microsoft GameInput（设计已否决）。
- 不改 FreeD 的 zoom/focus 原始整数语义（仍来自 config，与 pose 镜头字段解耦）。
- 不在运行时把 mapping 错误升级为硬失败（保持向后兼容，见 §3.5）。

## 修订记录

### v3（2026-06-03，实现后 Codex native review 的两条 P2）

实现完成后对 `main` 做 `codex review`，发现两条真 bug，均已修复（`sources/controller.py`）：

- **P2-A：逐条 clamp 导致成对反向输入在边界漂移 —— 采纳。**
  `next()` 原本对每条 entry 立即 clamp。默认映射里成对反向条目（LT/RT→z、P1/P3→focal、
  P2/P4→focus、LB/RB→roll）在 clamp 边界处，某一侧贡献会被中途 clamp 截断、无法与另一侧抵消，
  导致漂移（如起始 z=0 同按 LT/RT 每 tick 上漂 0.1；focal=300 同按 P1/P3 反而掉到 295）。
  改为：本 tick 内先把所有 entry 按 channel 累加，per-channel 的 clamp 边界取各条交集，
  **循环结束后每 channel 只 clamp 一次**。单条目 channel 行为不变，F7 无 clamp 守护不变。

- **P2-B：播种可能取回 CameraPose 方法 → TypeError —— 采纳。**
  见 §3.4 的 v3 修正：播种只对 `VALID_POSE_CHANNELS` 内的 channel 进行。

两条均补了回归测试（`tests/sources/test_controller_clamp_pairing.py`：边界不漂移、上限钉住、
非法 method-name channel 不崩）。

### v2（2026-06-03，纳入 Codex adversarial review）

review 给出两条 finding，处理如下：

- **Finding 1（[high] 硬编码 P1–P4 可能在真机上把 zoom/focus 绑反）—— 部分采纳。**
  采纳「不得把未核实的物理顺序当事实」的精神：新增 §2.2，引用 SDL 官方 `SDL_gamepad.h` 文档注释
  逐字佐证 `p1..p4 ↔ SDL 常量 ↔ Elite P 编号 ↔ 上/下排` 的对应，使默认映射的分组建立在 SDL 文档契约上
  而非假设；新增 §2.3 把残留风险界定为「拨片不动（安全）」与「方向偏好（一行配置）」两类，并把
  `controllers monitor`（USB-C + 蓝牙）首次验证升级为交付一等步骤。**不采纳**「移除默认映射」的补救——
  与用户明确的「内置默认映射」需求冲突，且映射已有 SDL 文档背书，最坏情况是安全退化而非危险误绑。

- **Finding 2（[medium] 新增强制校验会破坏既有 config）—— 采纳并改进。**
  原 v1 把 mapping 校验做成运行时硬 `ConfigError`(exit 3)，确为破坏性变更。v2 改为：严格校验只在
  `config validate` 命令报错（其本职）；控制器运行路径改为「警告 + 跳过坏条目 + 继续」，原本能跑的
  config 不再被破坏；合法 source 集合从后端 `poll()` 实际产出键派生（§3.2），杜绝误杀。新增测试 7 专门
  防此回归。
