# tracksim — 追踪信号模拟器 设计文档

> 日期：2026-06-02 ｜ 状态：待用户复核 ｜ 阶段：Phase 1（CLI）

## 1. 概述

`tracksim` 是一个**追踪信号模拟器**：通过 Xbox 手柄（或脚本/固定值）生成虚拟摄像机位姿，按 **FreeD** 与 **OpenTrackIO** 两种协议实时发送到支持它们的平台（Unreal Engine、Disguise 等），用于在没有真实跟踪硬件的情况下测试/演示这些平台的追踪数据接收。

严格遵循本仓库 `../CLI_DESIGN_SPEC.md`（AI-Native App Interface Specification v3.0）：contract-first，CLI 为强制基础适配器，业务逻辑只写一次。

### 1.1 目标
- 人类用 Xbox 手柄实时驱动虚拟摄像机，发送 FreeD / OpenTrackIO 信号。
- **Claude Code / CI 无需物理手柄，通过 CLI 直接驱动**（脚本化位姿 / 固定位姿 / 程序化运动）。
- 两协议、全部传输方式、全部参数**皆可配置**。
- 提供解码/校验子命令，便于验证目标平台是否正确接收。

### 1.2 非目标（本阶段不做）
- GUI（Phase 2）。
- MCP / HTTP / Skill 适配器（架构预留，后续阶段）。
- 真实镜头标定（畸变参数可发送，但不做标定计算）。
- IPv6、OpenTrackIO 设备发现（mDNS，规范本身标 future）。

## 2. 关键架构张力与解法

CLI_DESIGN_SPEC 面向**离散操作**（输入→输出 envelope），而模拟器是**实时长驻流式**进程（30–60Hz 循环发包）。解法（不破坏契约）：

- **`run`（长驻流式）** → 用 spec §3.5/§4.3 的 **ndjson 事件流**：`start` → 周期性 `item`（当前位姿 + 已发包数/速率）→ SIGINT 优雅退出发 `result, final:true`（exit 130）。
- **`send`（一次性）** → 发单帧或按 `--duration` 持续发固定位姿。**Claude Code / CI 驱动的主力入口**。
- 位姿来源抽象为 Port——手柄只是其一；Claude Code 走 `script`/`static`，人走 `controller`。

## 3. 架构（CLI_DESIGN_SPEC §1.2 三层）

```
Domain     CameraPose（canonical 数据模型）
  ↓
Services   Simulator（按 Clock 节奏：PoseSource → 多个 Emitter）
  ↓
Ports      PoseSource | Emitter | Transport | Clock | ControllerInput
  ↓ （仅此层做 IO，全部依赖注入）
Adapters   CLI（Phase 1）   [MCP 预留]
```

### 3.1 Domain：`CameraPose`（canonical 中间表示）
两协议编码器共同消费的物理量表示（Pydantic v2 模型，CLI_DESIGN_SPEC §1.4 单一 schema 来源）：

| 字段 | 单位 | 说明 |
|---|---|---|
| `pan`, `tilt`, `roll` | 度 (°) | 朝向 |
| `x`, `y`, `z` | 米 (m) | 位置（z = 高度） |
| `focal_length` | 毫米 (mm) | 变焦（physically meaningful） |
| `focus_distance` | 米 (m) | 对焦距离 |
| `iris` | T-stop（可选） | 光圈 |
| `entrance_pupil` | 米（可选） | 入瞳距离 |
| `frame`, `timestamp`, `rate` | — | 帧号 / 时间戳 / 帧率 |

内部统一用物理量；各编码器负责映射到自己的线缆表示与缩放（可配）。

### 3.2 Ports
- **`PoseSource.next(dt) -> CameraPose`**
  - `ControllerPoseSource`：每 tick 读 SDL 手柄轴/键，按映射表把摇杆量当**速率**积分成绝对位姿（含死区/钳制/反向）。
  - `ScriptedPoseSource`：程序化运动（`orbit` / `sine` / `sweep` / `static`，参数化）；或关键帧轨迹（stdin/文件 JSON，时间插值）。
  - `StaticPoseSource`：来自 flag/config 的固定位姿。
- **`Emitter.emit(sample)`**：`FreeDEmitter`、`OpenTrackIOEmitter`，各挂一个 Transport。
- **`Transport.send(bytes)`**：`udp_unicast` / `udp_multicast` / `udp_broadcast` / `serial`(pyserial)。
- **`Clock`**：墙钟（run）/ 虚拟时钟（测试）做帧节奏限速。
- **`ControllerInput`**：默认 **SDL3 后端**（`PySDL3`，纯 Python ctypes 包装），SDL3 gamepad API 提供跨平台（Mac/Windows/Linux，USB + 蓝牙）标准化 Xbox 布局；可注入 fake。
  - **选型理由**：仅用 SDL gamepad 的一小块（init/枚举/打开/轮询轴键/热插拔，~10 个函数），藏在本 Port 之后，故 PySDL3 单人维护/beta（0.9.x）的风险可控；SDL3 还标准化了手柄 gyro/accel 传感器（接 DualSense 可用 IMU 直接驱动 tilt/roll，贴题）。
  - **兜底**：pygame-ce 当前稳定版仍是 SDL2（SDL3 版未发布）；若 PySDL3 不稳，Port 后可换 `pysdl2`（SDL2，成熟）或直接 ctypes。
  - **实现期确认**：PySDL3 是否自带 macOS arm64 + Windows 的 SDL3 二进制；否则系统安装 SDL3（如 macOS `brew install sdl3`）。
  - **决策：不采用 Microsoft GameInput 作为主输入。** 经查 `../docs/gaming-gdk-docs-features-common-gdk-2604.md`（GDK 文档第 413 页"What platforms does GameInput support?"），GameInput 仅支持 **Xbox + Windows 10(19H1)/11**，**无 macOS**，与本项目跨平台要求冲突（且开发机为 macOS）；GameInput 为原生 C/C++ COM API（`IGameInput`，NuGet 分发），无 Python 绑定。其低延迟/impulse triggers 优势对 30–60Hz 位姿模拟无实际意义。
  - GameInput 可作为**未来可选的 Windows-only 后端**置于本 Port 之后（ctypes/cffi 包装），不影响跨平台主路径。

### 3.3 复用与从零写
- **OpenTrackIO**：把 `camdkit` 当依赖拿数据模型（`Clip`/类型）；编码/传输改造其 `ris-osvp-metadata-camdkit/src/test/python/parser/`（`opentrackio_sender.py`/`opentrackio_lib.py`）——16 字节 `OTrk` 头 + Fletcher-16 + 分段 + JSON/CBOR 编码均已有参考实现。
- **FreeD**：照 `../docs/freed-doc.md` Appendix A/B 从零写编码器（无现成代码）。

## 4. 协议编码细节

### 4.1 FreeD（D1 消息，照 freed-doc.md Appendix A/B）
- D1 = **29 字节**：`[0xD1][camID][pan H M L][tilt H M L][roll H M L][X H M L][Y H M L][Z(height) H M L][zoom H M L][focus H M L][spare H L][checksum]`。
- 大端；校验和 = `(0x40 − Σ(前 28 字节)) mod 256`。
- 角度 24-bit 有符号；位置 24-bit 有符号；zoom/focus 24-bit 无符号。
- **缩放可配**：默认采用现代业界通行的 native 编码（角度 1/32768°）；同时提供 Radamec 旧格式（1/900° 等）开关。**Phase 1 默认缩放需在实现期对照 Unreal Engine Live Link FreeD 解码器确认后锁定**（不在本文档写死可能错误的常量）。
- 传输：UDP datagram 装这 29 字节（FreeD-over-UDP 事实做法），或串口 38.4kbaud 8-O-1（可配）。camera_id（含 0xFF 广播）可配。

### 4.2 OpenTrackIO（照规范 + camdkit 参考）
- 由 `CameraPose` 构造 camdkit `Clip`/sample → JSON 或 CBOR（可配）。
- 包头：16 字节 `OTrk` 标识 + encoding(JSON=0x01/CBOR=0x02) + sequence + segment offset + last-segment flag + payload length + Fletcher-16；超 MTU 自动分段。
- 传输：UDP 组播 `239.135.1.{source_number}:55555`（默认，source_number 1–200 可配）或 unicast 到指定 IP:port。
- 纳入字段、static 元数据（镜头/相机）、timing/sync、protocol/sourceId/sampleId 均可配。

## 5. Contract Manifest（CLI_DESIGN_SPEC §12 Step 1②）

每个 operation 的 input/output/error schema 用 Pydantic 定义一次，CLI 与未来 MCP 共用；`tracksim manifest` 输出 canonical manifest。

| operation_id | side_effects | 说明 |
|---|---|---|
| `sim.run` | external_calls✓, 非幂等, 流式 | 长驻发包（来源/协议/目标/速率） |
| `sim.send` | external_calls✓ | 发单帧 / 持续固定位姿 |
| `controllers.list` | readOnly | 枚举手柄 |
| `controllers.monitor` | readOnly, 流式 | 实时原始轴/键值 |
| `config.init` | writes✓, dry-run✓ | 生成默认配置 |
| `config.show` | readOnly | 生效配置 |
| `config.validate` | readOnly | 校验配置 |
| `freed.decode` | readOnly | 解析 FreeD 包 → 字段 |
| `opentrackio.decode` | readOnly | 解析 OpenTrackIO 包 → 字段 |
| `meta.manifest` / `meta.schema` / `meta.version` | readOnly | 自描述 |

## 6. Command Tree（CLI_DESIGN_SPEC §12 Step 1③）

```
tracksim
├── run                 # sim.run     长驻流式
├── send                # sim.send    一次性 / 持续固定位姿
├── controllers list    # controllers.list
├── controllers monitor # controllers.monitor
├── config init         # config.init   (--dry-run)
├── config show         # config.show
├── config validate     # config.validate
├── freed decode        # freed.decode
├── opentrackio decode  # opentrackio.decode
├── manifest            # meta.manifest
├── schema              # meta.schema
├── completion          # bash|zsh|fish
└── version             # meta.version
```

**全局 flag 全量实现 CLI_DESIGN_SPEC §3.2**：`--help/-h`、`--version`、`--yes/-y`、`--dry-run`、`--config <path>`、`--output text|json|ndjson`、`--input-format`、`--log-level`、`--verbose/-v`、`--quiet/-q`、`--no-color`（尊重 `NO_COLOR`）、`--no-input`、`--`。环境变量 `AI_AGENT=1` 触发 AI-stable profile（默认 `--output json`）。

## 7. Exit Code 表（CLI_DESIGN_SPEC §5）

| Code | 语义 |
|---|---|
| 0 | success |
| 2 | 用法/参数语法错 |
| 3 | 配置错 |
| 7 | 超时 |
| 8 | 外部依赖失败（通用发送失败） |
| 10 | 找不到手柄 / 手柄断开（app-specific） |
| 11 | 传输/目标错误：UDP 发送失败、串口打不开、目标不可达（app-specific） |
| 12 | 不支持的协议或编码（app-specific） |
| 13 | 位姿/轨迹输入非法（script 来源解析失败，app-specific） |
| 130 | SIGINT 优雅停止 `run` |

`error.code`（如 `NO_CONTROLLER`、`TRANSPORT_SEND_FAILED`、`INVALID_TRAJECTORY`）承载细粒度语义；exit code 只承载粗分类。

## 8. 配置（一切可配；TOML 默认，亦接受 YAML/JSON）

优先级：CLI flag > `--config` 文件 > 内置默认。分节：

- `[protocols]`：启用 `freed` / `opentrackio`。
- `[freed]`：`transport`(udp_unicast|udp_broadcast|serial)、`target_ip`/`port` 或 `serial_device`/`baud`、`camera_id`、`rate_hz`、`encoding_variant`(native|radamec)、角度/位置/zoom/focus 缩放。
- `[opentrackio]`：`transport`(multicast|unicast)、`source_number`、`ip`、`port`、`encoding`(json|cbor)、`rate_hz`、纳入字段、static 镜头/相机元数据、`source_id`/`sample_rate`。
- `[controller]`：`device`(序号/名称)、`mapping`（轴/键→通道，`mode`(rate|absolute)、`scale`、`deadzone`、`invert`、`clamp`）、按键绑定（复位位姿/切协议/暂停）。
- `[motion]`：程序化运动默认参数（orbit 半径/速度、sine 幅度/频率等）。
- `[output]`：默认输出格式/日志级别。

## 9. 数据流

```
controller/script/static ─► PoseSource ─► CameraPose(canonical)
                                              │ (Simulator 按 Clock 限速)
                            ┌─────────────────┴─────────────────┐
                    FreeDEncoder→Transport            OTEncoder→Transport
                            │                                 │
                            ▼                                 ▼
                         UE / Disguise (FreeD)        UE / Disguise (OpenTrackIO)
CLI 适配器订阅 Simulator 事件 → stdout 渲染 text/ndjson；日志/进度 → stderr
```

## 10. 错误处理

- 统一 success/error envelope（CLI_DESIGN_SPEC §4）；domain 错误映射 `error.code` + `exit_code`。
- `run` 对 SIGINT/SIGTERM 优雅清理：停循环 → flush → 关 socket/串口 → 发 `result final:true`（128+N）。
- 传输失败按 `retryable` 标注；目标不可达不致命崩溃，记 warning 事件继续（可配 `--fail-fast`）。

## 11. 测试策略（CLI_DESIGN_SPEC §1.5、§12 Step 3）

- **Core SDK 单测 ≥80%**：FreeD 编码器对照按规范构造的 golden 字节序列；Fletcher-16 对照参考；OpenTrackIO 输出对照 camdkit schema 校验。
- **确定性测试**：Transport / Clock / ControllerInput 全注入 fake。
- **回环集成测试**：`tracksim send` 发包 → 本地用 camdkit 接收器（`opentrackio_receiver.py`）/ 自写 FreeD 解码 收 → 解码 → 断言往返一致。
- **CLI 一致性测试**（spec §12 Step 3）：`--output json` 时 stdout 纯 JSON、stderr 隔离、错误路径 exit code 正确且 stdout 仍合法 JSON、`--dry-run` 可观、人类管道行为正常。

## 12. 阶段与范围

- **Phase 1（本次）**：§3–§11 全部——Core SDK + Contract Manifest + CLI 适配器 + 双协议 + 全部传输 + 全可配 + 自描述 + 测试。
- **Phase 1.5（预留）**：MCP 适配器（薄层复用 Core SDK + Manifest）。
- **Phase 2**：GUI。
- **以后可选**：HTTP 适配器、Skill 包。

## 13. 待实现期确认的点（不在本文档写死）

1. **FreeD 默认缩放常量**：对照 Unreal Engine `FreeDController`（Live Link FreeD）解码器与 Disguise 文档确认后锁定；config 已提供 native/radamec 切换兜底。
2. **OpenTrackIO 目标接收形态**：UE/Disguise 实际吃组播还是 unicast、用 JSON 还是 CBOR——config 两者都支持，默认按规范组播 + JSON，实现期对照目标平台版本验证。
3. **手柄默认映射**：✅ 已落地（见 `specs/2026-06-03-tracksim-controller-zoom-focus-design.md`）。左摇杆 XY 平移、右摇杆 pan/tilt、LT/RT 控高度 z、肩键 roll、Elite 上排拨片变焦、下排拨片对焦——scale/clamp 实测手感后微调；全可配。
