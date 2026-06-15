# vpcal Stage Display（测试图上墙）Implementation Specification

版本：1.0（draft）
状态：待评审 → 交付新 session 执行
基于：
- 路线图 `docs/remediation-roadmap-v1.md` Stage 3 的 **C1.3 图案播放同步**（现状 ⛔ 硬件阻塞、已搭骨架）与 **C0 LED 处理器链路校验**（1:1 映射验证）
- 采集服务设计 `docs/c1-capture-service.md`（C1.1 已实现 / C1.2、C1.3 待落地）
- 采集工作流 `docs/capture-workflow-guide.md` §2（当前"人工把 pattern 投到墙上"的步骤）
- house CLI 契约 `../docs/CLI_DESIGN_SPEC.md`、退出码 `docs/exit-codes.md`
范围：让 vpcal **远程把测试图显示到 LED 墙上**，消除"人工往 Disguise / nDisplay 里塞图并全屏"这一步。分三种现场场景、三个阶段落地。**第一阶段（原生全屏 Agent）写到可直接执行的细度**；第二、三阶段（Disguise / nDisplay）记录方向与契约骨架，细化留待各自阶段启动时。

> 本文档是**独立增量 spec**。它实现路线图既有的 C1.3、复用 C0，**不修改** Phase 1 的变换链 / 坐标系 / 图案编码 / 检测 / 求解（全部原样复用）。开发建议在 `feature/stage-display` 分支进行。

---

## 0. 概述

### 0.1 它是什么

当前 vpcal 是纯离线计算工具：用户用外部软件（Disguise / UE / Resolume）**手动**把 `vpcal pattern generate` 产出的 `normal.png` / `inverted.png` 全屏显示到 LED 墙，再人工拍摄。`docs/capture-workflow-guide.md` §2 明确："Phase 1 的 vpcal 不控制 LED 显示"。

Stage Display 给 vpcal 加上**远程驱动墙面显示**的能力，覆盖三种现场：

| 场景 | 墙由谁驱动 | 本 spec 的后端 | 阶段 |
|------|-----------|---------------|------|
| **基础（空机）** | 普通 PC / 仅作处理器，OS 把 LED canvas 当扩展屏 | **原生全屏 Agent** | **第一阶段** |
| **Disguise** | Disguise 媒体服务器 | Disguise 文件落位（首发）/ API（进阶） | 第二阶段 |
| **nDisplay** | UE nDisplay 集群 | 独立工具配置 nDisplay + 原生纹理显示 | 第三阶段 |

### 0.2 为什么这样设计（两个压倒性约束）

**约束一：1:1 像素映射是校正正确性的命门，不是精度优化。**
VP-QSP marker 编码的是**身份**（`screen_id | cab_col | cab_row | local_id`，`core/pattern.py`），不是位置；detector 解出 marker ID 后 solver **查表**得到其 3D 物理坐标，该表由 `ScreenDefinition` 的柜体网格 + LED 像素间距**预先算死**（`core/screen_geometry.py`）。**显示层一旦缩放 / 裁切 / 偏移 / 滤波，墙上 marker 的真实物理位置就偏离查表值，solver 在错误的 2D-3D 对应上拟合，产出静默错误的 `T_S_from_O`。** 这正是 C0、`core/processor_check.py::verify_one_to_one` 要守的关。因此**任何后端的第一性要求都是"保证或验证 1:1"**，而非"能不能全屏"。

**约束二：LED 墙输出的所有权决定了能不能"裸全屏"。**
- 空机场景：OS 拥有输出 → 裸全屏窗口可用，原生 Agent 是最优解。
- Disguise / nDisplay 场景：它们**独占**那条 genlock / 信号链输出 → 外部全屏窗口抢不过来，只能用它们自己的机制（文件落位 / API / Remote Control）把图喂进**已配置好的映射**，1:1 从那套映射继承。

这两条约束直接推导出"三后端而非一个 client"的架构。

### 0.3 一句话目标

```
第一阶段：空机场景下，操作员在播放机上启动一次 Agent，之后在自己的笔记本上用
  vpcal display connect / show / clear / verify
即可远程切换墙面 pattern（normal/inverted/网格）、并由程序断言显示分辨率与 1:1 映射，
全程不再走回播放机、不再人工拖图。
```

### 0.4 与现有路线图的关系（执行前必读）

- **本 spec = C1.3 的实现载体**。C1.3 原描述为"驱动输出窗口 / LED processor 播放 pattern，内嵌 Gray code 序号"——原生 Agent 即"输出窗口"，Gray code 序号在 §4.5 编排集成里落地。
- **复用 C0**：`vpcal display verify`（§4.4）= 通过 Agent 把 C0 的"1:1 映射验证图"显示出来 → 拍摄 → 跑 `processor_check` 验证。C0 与本 spec 互为前后件。
- **协同 C1.1**：C1.1（`vpcal capture track`，已实现）提供 tracking 流；§4.5 的编排在显示每张 pattern 时调用它做 tracking 快照。
- **C1.2（视频取流）仍硬件阻塞**：本 spec 不依赖采集卡，第一阶段交付"显示半自动 + 1:1 自检"，不假设相机能被远程触发（见 §4.5 诚实边界）。
- 执行后应在 `remediation-roadmap-v1.md` 的 C1.3 行回填状态与本文件链接。

---

## 1. 范围与非目标

### 1.1 范围

| 项 | 内容 |
|----|------|
| 抽象层 | vpcal 侧 `StageDisplay` 协议（`core/display/base.py`），三后端共用 |
| 第一阶段后端 | `NativeAgentDisplay`（vpcal 侧）+ 独立的 `display-agent` 程序（播放机侧） |
| 1:1 保障 | Agent `describe()` 上报渲染分辨率 → 与 `ScreenDefinition` 对账；`display verify` 闭环校验（复用 C0 + `processor_check`） |
| CLI | `vpcal display` 命令组（`agent` / `connect` / `show` / `clear` / `verify`），遵循 house envelope / exit code |
| 配置 | `DisplayConfig`（`models/display.py`），可嵌入 `SessionConfig` |
| 编排集成 | `vpcal capture playback`（C1.3）改为消费 `StageDisplay` 后端，串 show→（拍摄）→tracking 快照，内嵌 Gray code 序号 |
| 第二阶段 | Disguise：基础（文件落位 + 人工投屏）首发；API 自动建层为进阶（§5） |
| 第三阶段 | nDisplay：独立配置工具 + 走 UE 原生纹理显示（§6） |
| 安全 | Agent 绑内网网卡 + bearer token（§9） |
| 测试 | Agent 单测 + vpcal 侧集成（loopback / fake agent）+ 闭环校验合成测试；无显示硬件时 graceful skip（对齐 C1.2/C1.3 纪律） |

### 1.2 非目标（明确不做）

- ❌ **不让 Agent 含 VP-QSP 渲染逻辑**：Agent 是"哑的 1:1 贴图器"，pattern 由 vpcal 现有 `pattern generate` 产出后推给它（理由见 §4.1）。
- ❌ **不远程触发相机录制 / 取流**：那是 C1.2（采集卡硬件阻塞）。第一阶段相机拍摄仍可人工。
- ❌ **不改 Phase 1 任何核心**：变换链 / 坐标系 / 图案编码 / 检测 / 求解 / 帧对齐全部原样复用（`remediation-roadmap-v1.md` §0 保留不动清单）。
- ❌ **第一阶段不做 Disguise / nDisplay 后端**（仅定义抽象层占位 + 本 spec 的方向描述）。
- ❌ **不做色彩管理 / HDR / 色彩校准**：几何校正只检 marker，不依赖色彩（但 Agent 须不引入滤波，见 §4.1）。

### 1.3 复用 Phase 1（不重复定义）

- `core/pattern.py::generate_pattern_images` —— 产出 `normal.png` / `inverted.png`，分辨率 = canvas 物理像素数。**Agent 显示的就是这些文件。**
- `models/screen.py::ScreenDefinition` —— `cabinet_size` / `led_pixel_pitch_mm` / `sections`（`PlaneSection` / `ArcSection`）/ 可选 `ProcessorCanvas`。**`describe()` 对账的"期望分辨率"由它推出。**
- `core/detector.py` —— marker 检测，`display verify` 复用。
- `core/processor_check.py::verify_one_to_one` —— 1:1 实测验证（C0），`display verify` 复用。
- `core/capture.py` —— C1.1 tracking 摄入，§4.5 编排复用。

---

## 2. 架构总览

### 2.1 两层结构

```
┌─ vpcal 侧（操作员笔记本）─────────────────────────────┐
│  CLI: vpcal display {connect,show,clear,verify}        │
│  core/display/base.py   ：StageDisplay 协议             │
│  core/display/native.py ：NativeAgentDisplay（HTTP 客户端）│
│  core/display/disguise.py（第二阶段占位）               │
│  core/display/ndisplay.py（第三阶段占位）               │
│  models/display.py      ：DisplayConfig                 │
└────────────────────────────────────────────────────────┘
                    │ HTTP（LAN，token 鉴权）
                    ▼
┌─ 播放机侧 ─────────────────────────────────────────────┐
│  display-agent（独立最小程序，可打包单 exe）            │
│   · 独占接 LED 处理器那路输出，1:1 全屏贴图              │
│   · HTTP 服务：/health /describe /load /show /clear     │
│   · standby 屏 / 断连看门狗 / Esc 退出                  │
└────────────────────────────────────────────────────────┘
```

控制方向：**笔记本（vpcal，客户端）→ 播放机（Agent，HTTP 服务）**。Agent 在播放机上是个监听端口的小服务，vpcal 主动发指令。

### 2.2 `StageDisplay` 协议（三后端共用）

```python
# core/display/base.py
from typing import Protocol
from dataclasses import dataclass

@dataclass
class DisplayInfo:
    backend: str                 # "native_agent" | "disguise" | "ndisplay"
    render_width_px: int | None  # Agent 实际渲染分辨率；后端不可内省时 None
    render_height_px: int | None
    output_index: int | None
    dpi_aware: bool | None
    notes: str = ""

@dataclass
class DisplayAck:
    shown: str                   # 当前显示的 pattern 标识（如 "normal"）
    at_monotonic_ns: int         # Agent 端单调时钟（供编排对齐）
    ok: bool

class StageDisplay(Protocol):
    def describe(self) -> DisplayInfo: ...
    def load(self, frames: dict[str, str]) -> None: ...   # {名称: 本地 png 路径}，推送/落位到后端
    def show(self, frame: str) -> DisplayAck: ...         # 显示已 load 的某帧
    def clear(self) -> None: ...                          # 回 standby / 移除内容
    def close(self) -> None: ...
```

三后端各自实现该协议；上层 CLI 与编排只依赖协议，不关心后端。

### 2.3 1:1 像素映射 —— 贯穿所有后端的硬约束

无论哪个后端，正确性都取决于"显示像素 1:1 对应物理 LED 像素"。保障分两层：

1. **静态对账（能内省时）**：`describe()` 回报渲染分辨率，vpcal 与 `ScreenDefinition` 推出的 canvas 像素数比对，不一致直接 `PreconditionError`（exit 6）。原生 Agent 能内省；Disguise / nDisplay 多半不能。
2. **闭环校验（对所有后端成立的兜底）**：`vpcal display verify` 显示 C0 的"已知像素基准点验证图" → 操作员拍一帧 → 复用 `processor_check::verify_one_to_one` 比对几何 → 不成立报 `PreconditionError` 并输出实测缩放/偏移。这是唯一不依赖后端内省、对陌生现场都成立的保证手段，**应作为真机 session 的强制前置**。

### 2.4 空机全屏的 1:1 配方（第一阶段 Agent 必须逐条做到）

> 击穿三层缩放陷阱：OS 显示缩放 / GPU 缩放 / LED 处理器缩放。

1. 接 LED 处理器那路输出的**显示模式锁成 canvas 原生分辨率**（源=输出，无一层需要缩放）。
2. Agent 进程声明 **Per-Monitor DPI Aware V2**（Windows 报物理像素，不被系统拉伸）。
3. **borderless 窗口铺满该输出**，按 `canvas_w × canvas_h` 设备像素精确贴图，**关闭一切插值（nearest）**。
4. 现场把 **NVIDIA 控制面板该输出设 "No scaling" / 整数缩放**、LED 处理器设 1:1 直通（Agent 在 `describe()` 里暴露已知项，处理器侧靠 §4.4 闭环校验）。
5. 隐藏光标、抑制屏保 / DPMS、置顶、能枚举并指定输出。
6. **最后跑 §4.4 闭环校验确认**。

> ⚠ 已知坑（实现需验）：NVIDIA 驱动 + OpenGL + per-monitor DPI 有内容被错误缩放的历史 bug；若 Agent 用 GL 后端须专门验证 1:1（这是 §4.1 工具栈选型的考量之一）。

---

## 3. 阶段划分（执行顺序）

```
第一阶段（本 spec 详写）：原生全屏 Agent + StageDisplay 抽象 + 1:1 闭环校验
        覆盖"空机 / 仅处理器 / 纯几何校正阶段"场景
   ↓
第二阶段：Disguise —— 基础（文件落位 + 人工投屏）首发，API 自动建层为进阶
   ↓
第三阶段：nDisplay —— 独立配置工具，走 UE 原生纹理显示
```

每阶段独立可交付；后两阶段启动时再把本 spec 对应章节细化到执行细度。

---

# 4. 第一阶段：原生全屏 Agent（详细）

## 4.1 `display-agent` 程序（播放机侧，独立最小）

### 职责 / 非职责

- **职责**：独占指定输出 → 1:1 全屏贴图（显示 vpcal 推来的 PNG）→ 提供 HTTP 控制 → standby 屏 / 看门狗 / 退出热键。
- **非职责**：不生成 pattern、不含 VP-QSP 编码、不做检测求解。**它只是一个能保证 1:1 的哑贴图器。**

> **为何 Agent 显示 vpcal 推来的 PNG，而非自己渲染**：① vpcal 的 `pattern generate` 已把 PNG 出成 canvas 像素数，Agent 只要"锁原生分辨率 + 无滤波贴图"，贴 PNG 本身就是精确的；② 让 Agent 含 VP-QSP 逻辑会造成代码重复 + 同步成本，且把重依赖拖进必须打包到播放机的程序里。Agent 自行矢量渲染（彻底消除"位图被重采样"这一类失败）列为**进阶可选项**（待决策项 §11-3），首发走贴 PNG（简单优先）。

### 依赖隔离（硬约束）

Agent **不得** import vpcal 的 solver / ceres / scipy / 重型 core 模块——只依赖一个窗口/图形库 + 标准库 HTTP。这样 PyInstaller 能把 Agent 单独打成小 exe。若 Agent 代码放在 `src/vpcal/display/agent/`，该子包须保持 import 卫生（CI 加一条"agent 子包导入图不含 solver"的检查）。

### 工具栈（待决策项 §11-1，给推荐默认）

| 候选 | 多屏定位 | DPI/1:1 控制 | 打包体积 | 备注 |
|------|---------|-------------|---------|------|
| **PySide6 / Qt（推荐默认）** | ★★★ `QScreen` 精确 | ★★★ 原生 DPI 策略 | 大 | 多屏定位最稳，适合"发给各异现场" |
| pygame / SDL2 | ★★ 偶有 Windows 多屏 finicky | ★★ 需手设 hints | 小 | 最轻，但多屏定位要验 |
| 包装 mpv | ★★ `--fs-screen` 有历史 bug | ★★ `--video-unscaled` | 中（带二进制） | "不想自己写渲染"的折中 |

推荐 **PySide6**：发给设备各异的现场时，多输出定位的鲁棒性比体积更重要。最终由实现 session 拍板。

### standby / identify 屏

Agent 启动后、未收到 show 指令前，在目标输出上全屏显示一块自检屏：大字 `AGENT READY` + `输出序号` + `渲染分辨率 W×H` + `监听 IP:PORT` + `DPI-aware: yes/no`。意义：操作员**站在墙前**就能确认 Agent 起来了、落在对的输出、分辨率对不对，然后回笔记本远程操作。

### HTTP 端点

所有端点要求 `Authorization: Bearer <token>`（§9）。

| 方法 路径 | 入参 | 出参 | 说明 |
|----------|------|------|------|
| `GET /health` | — | `{ok, version}` | 存活探测 |
| `GET /describe` | — | `DisplayInfo` JSON | 渲染分辨率 / 输出序号 / DPI 状态 / 刷新率 |
| `POST /load` | multipart 或 base64：`{名称: png}` | `{loaded: [names]}` | 推送一组帧，Agent 解码缓存在内存 |
| `POST /show` | `{frame}` | `DisplayAck` | 全屏贴图该帧，返回 Agent 单调时戳 |
| `POST /clear` | — | `{ok}` | 回 standby |

> 设计取舍：帧在 session 开始时一次性 `load`，之后 `show` 只传名称——避免每帧重传，降低切换延迟。

### 命令行

```
display-agent --output 1 --port 7000 --token-file ./agent.token [--bind 192.168.10.50]
```

- `--output N`：可枚举确认（启动时打印所有输出 + 各自分辨率，防跑到主控屏）。
- `--bind`：绑指定内网网卡（缺省绑 0.0.0.0 须显式 `--allow-any` 才放行，fail-closed）。

### 健壮性

- **断连看门狗**：与 vpcal 最后一次心跳超时（默认 30s）→ 自动 `clear` 回 standby，防墙卡在某张图。
- **退出热键**：播放机本地按 `Esc` 立即退出、还原输出。
- **独占输出**：Agent 全屏占该输出 → 与 Disguise/nDisplay 不能同占一路（这正是它只服务空机场景的原因，文档须写明）。

## 4.2 vpcal 侧后端 `NativeAgentDisplay`

```python
# core/display/native.py
class NativeAgentDisplay:   # implements StageDisplay
    def __init__(self, host: str, port: int, token: str, timeout_s: float = 5.0): ...
    # describe(): GET /describe → DisplayInfo
    # load(frames): POST /load（多帧）
    # show(frame): POST /show → DisplayAck
    # clear(): POST /clear
    # 连接失败 → 抛 ExternalDependencyError（exit 8，见 §4.6）
    # token 拒绝 → 抛 AuthError（exit 4）
```

## 4.3 配置模型 `DisplayConfig`

```python
# models/display.py
from pydantic import BaseModel, Field, ConfigDict
from typing import Literal

class NativeAgentConfig(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    host: str
    port: int = 7000
    token_file: str | None = None          # 或环境变量 VPCAL_DISPLAY_TOKEN
    timeout_s: float = Field(default=5.0, gt=0)
    heartbeat_s: float = Field(default=10.0, gt=0)

class DisplayConfig(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    backend: Literal["native_agent", "disguise", "ndisplay"] = "native_agent"
    native_agent: NativeAgentConfig | None = None
    # disguise / ndisplay 后端配置块在各自阶段追加
    require_one_to_one_check: bool = True  # 真机 session 强制闭环校验通过才放行

class SessionConfig(BaseModel):
    # ... 现有字段不变 ...
    display: DisplayConfig | None = None   # None = 不启用远程显示（纯离线，行为同今天）
```

`display=None` 时 vpcal 行为与今天逐位一致（不连任何 Agent）。

## 4.4 1:1 闭环校验（`vpcal display verify`，复用 C0）

```
1. 取 C0 的"1:1 映射验证图"（含已知像素基准点；C0 未就绪时回退用一张稀疏网格 + 已知 marker 子集）
2. backend.load({"verify": 验证图})；backend.show("verify")
3. 操作员用相机拍一帧，回传路径给 vpcal
4. 复用 core/processor_check.py::verify_one_to_one 比对：检出缩放/裁切/偏移
5. 成立 → 通过；不成立 → PreconditionError(exit 6)，输出实测 scale_x/scale_y/offset
```

`require_one_to_one_check=true`（真机默认）时，`vpcal quick run` 在 validate 阶段强制先过此校验再继续采集。

## 4.5 与 C1.3 capture playback 编排集成

`vpcal capture playback`（C1.3，当前抛 `PreconditionError`）改为：**消费配置的 `StageDisplay` 后端**，驱动一次采集编排：

```
for pose in poses:
    引导操作员摆 pose（text/UI 提示）
    backend.show("normal")  → ack(t_normal)
    [操作员拍一帧 / 或 C1.2 取流（硬件就绪时）]
    capture.py 快照 tracking（C1.1）→ 标 t_normal
    backend.show("inverted") → ack(t_inverted)
    [拍一帧]
    快照 tracking → 标 t_inverted
backend.clear()
```

- **Gray code 序号**（C1.3 原设计）：编排时 Agent 可在帧角嵌入一个 Gray-code 帧序（vpcal 预渲染进推送的 PNG，Agent 仍只贴图）——供 C1.2 视频流侧识别"当前墙上是第几帧"，实现拍摄全程零手工拷贝。第一阶段 C1.2 未就绪时，此序号仅作日志/人工核对。
- **诚实边界**：第一阶段相机拍摄多半仍人工（电影机难远程触发，C1.2 硬件阻塞）。本阶段交付的是"**显示半自动 + 1:1 自检 + tracking 快照**"，而非全自动校正。`capture playback` 在 C1.2 就绪前对"拍摄"步骤打人工提示。

## 4.6 退出码映射

本特性让 vpcal 首次获得**外部网络依赖**，激活两个 `exit-codes.md` 中此前"Phase 1 不使用"的码：

| Code | 触发场景 |
|------|---------|
| `0` | 显示 / 校验成功 |
| `2` | `--output` 序号非法、`display` 配置缺字段、host 格式错 |
| `3` | `DisplayConfig` 文件不可解析 |
| `4`（**新激活**：auth/permission） | Agent token 鉴权失败 |
| `5` | 验证图 / pattern 文件不存在 |
| `6` | `describe()` 分辨率与 `ScreenDefinition` 不符；或闭环校验判定非 1:1（precondition） |
| `7` | Agent 响应超时（`timeout_s`） |
| `8`（**新激活**：external dependency） | Agent 不可达 / 连接被拒 / HTTP 5xx |

> `exit-codes.md` 须更新：声明 4 / 8 因 Stage Display 引入外部依赖而启用，并给 `error.code` 细粒度串（`DISPLAY_AUTH` / `DISPLAY_UNREACHABLE` / `DISPLAY_NOT_ONE_TO_ONE` 等）。

## 4.7 测试计划

### Agent 单测（`display-agent` 自带，不依赖显示硬件）
1. HTTP 端点：`/health` `/describe` `/load` `/show` `/clear` 的鉴权、入参校验、状态机（未 load 就 show → 4xx）。
2. 1:1 贴图逻辑：在 **offscreen surface** 上验证"输入 W×H 图 → 输出 buffer 逐像素相等、无插值"（不开真窗口）。
3. 看门狗：模拟心跳超时 → 状态回 standby。
4. import 卫生：断言 agent 子包导入图不含 solver/ceres/scipy。

### vpcal 侧集成（`tests/integration/`）
5. `NativeAgentDisplay` 对 **loopback fake agent**（测试内起一个内存 HTTP 桩）：connect → describe 对账 → load → show → ack → clear 全通。
6. `test_describe_resolution_mismatch_exit6`：fake agent 报错分辨率 → `display connect` 返 exit 6。
7. `test_agent_unreachable_exit8`：连不存在端口 → exit 8。
8. `test_token_rejected_exit4`：错 token → exit 4。
9. `test_one_to_one_verify`：用 simulator 生成"被人为缩放 0.98 的拍摄图" → `display verify` 判非 1:1、返 exit 6 并报实测 scale；1:1 图则通过。
10. `test_display_none_is_offline_noop`：`display=None` 时 `quick run` 不连任何 Agent、行为同今天。
11. `test_capture_playback_orchestration`：用 fake agent + 合成 tracking 流（复用 C1.1 loopback），跑 show→快照→show 序列，断言每帧 tracking 快照带正确时标。

### graceful skip
- 需真实显示输出的端到端（真窗口落到真输出）标记 skip（对齐 C1.2/C1.3 硬件阻塞纪律），在接入播放机后补真机验收。

### 覆盖率
- 对齐 Phase 1 标准（整体 ≥88%）；`core/display/` ≥90%。

## 4.8 实现优先级（按依赖排序，每项带验收）

```
SD-1  抽象层 + 配置
  1. core/display/base.py：StageDisplay 协议 + DisplayInfo/DisplayAck
     验收：协议导入、dataclass 序列化单测。
  2. models/display.py：DisplayConfig/NativeAgentConfig + 接入 SessionConfig（默认 None）
     验收：display=None 时 SessionConfig 解析与今天逐位一致（test 10）。

SD-2  display-agent（播放机侧，独立）
  3. 窗口/贴图核心：选定工具栈 → 锁原生分辨率 + DPI-aware + 无滤波 1:1 贴图 + 输出枚举/定位 + 隐光标
     验收：offscreen 逐像素相等单测（test 2）；真机手动验一次（skip 标记）。
  4. HTTP 服务 + 鉴权 + standby 屏 + 看门狗 + Esc 退出
     验收：端点/鉴权/状态机/看门狗单测（test 1,3）；import 卫生（test 4）。
  5. PyInstaller 打包脚本 → 单 exe（Windows 优先，Linux 次之）
     验收：产出 exe 能在干净机器上跑起来、显示 standby。

SD-3  vpcal 侧后端 + CLI
  6. core/display/native.py：NativeAgentDisplay（HTTP 客户端）
     验收：对 loopback fake agent 全流程（test 5）。
  7. cli/display.py：connect/show/clear（house envelope + exit code 映射 §4.6）
     验收：exit 4/6/8 三条路径测试（test 6,7,8）。

SD-4  1:1 闭环校验
  8. cli/display.py：verify（复用 processor_check + C0 验证图）
     验收：缩放 0.98 判非 1:1、1:1 通过（test 9）。
  9. quick run validate 阶段接线 require_one_to_one_check
     验收：真机模式下校验不过则拦截。

SD-5  编排集成（C1.3）
  10. cli/capture.py：playback 从抛 PreconditionError 改为消费 StageDisplay 编排（show→tracking 快照→show）
      验收：fake agent + 合成 tracking 编排测试（test 11）。
  11. Gray code 帧序嵌入（vpcal 预渲染进 PNG）
      验收：嵌入序号可被解码识别的单测（视频侧识别留 C1.2）。

SD-6  契约/文档
  12. contract-manifest.json + models/manifest.py：新增 display.* operation；exit-codes.md 启用 4/8
  13. capture-workflow-guide.md：新增"远程显示（原生 Agent）"小节，替换/补充 §2 的人工步骤
  14. remediation-roadmap-v1.md：回填 C1.3 状态 + 链接本 spec
```

---

# 5. 第二阶段：Disguise 快速导入测试图

> 现场墙由 Disguise 媒体服务器驱动：外部全屏窗口抢不过它的输出，必须把图喂进 Disguise 已配置好的映射，**1:1 从该映射继承**。分"基础（首发）"与"进阶"两档。

## 5.1 基础功能（首发）：手动导入模式

用户流程：

```
1. 用户在 vpcal 指定 Disguise Project 路径
2. vpcal 扫描该路径下的项目，列出，由用户指定目标项目
3. vpcal 用现有 pattern generate 生成测试图（分辨率匹配该映射的 screen 像素数）
4. vpcal 按 Disguise 的目录约定，把图自动存入项目的 video 子目录
5. 用户在 Disguise 里手动把该媒体投到墙上
```

- 对应后端 `DisguiseFileDropDisplay`：`load()` = 生成 + 落位到约定目录；`show()` = 打印"请在 Disguise 中投屏 <媒体名>"的人工提示（不自动播放）。
- **价值**：纯文件落位 + 路径约定，零 Disguise API 依赖、零版本风险，却省掉"找正确分辨率 + 拖进正确目录"的易错环节。

> ⚠ **未核实，实现前必须确认**：Disguise 项目里媒体的确切目录约定。用户表述为"video 子目录"；而 disguise 知识库中 provision API 落位路径为 `{project}/objects/VideoFile/...`。两者可能是不同入口（手动导入目录 vs API provision 目录）。**落位目录错则 Disguise 看不到媒体**——须在真实 Disguise 工程上核对后再写死约定。

## 5.2 进阶功能：Disguise API 自动建层

系统已部署、API 可达时，免去人工投屏：

```
1. 经 /api/service/media/provision 把测试图推到项目媒体目录
2. 经 /api/session/python/execute 跑脚本：加载为 VideoClip → 在当前时间 addNewLayer →
   挂到【已存在的】mapping → 播放
3. 经 WebSocket /api/service/task/status 跟踪进度
```

- 对应后端 `DisguiseApiDisplay`：实现完整 `StageDisplay`（含 `show`/`clear` 真正切换层）。

> ⚠ **未核实**：上述 Python 符号（`resourceManager.loadOrCreate` / `guisystem.track.addNewLayer` 等）来自知识库、跨 Designer 版本敏感，落地前须在目标 Designer 版本实测。**不能动态新建 mapping**，只能挂已有 mapping（screen/分辨率/空间位置属工程配置）。

## 5.3 1:1 与验收

- **1:1 来源**：从该项目 mapping 继承（show 建好的工程映射本就 1:1）。vpcal 无法远程内省 mapping → 依赖 §2.3 的**闭环校验**兜底。
- 验收：在一台装了 Disguise 的机器上，基础模式能把正确分辨率的图落到正确目录、人工投屏后闭环校验判 1:1；进阶模式能 API 自动显示并 clear。

---

# 6. 第三阶段：nDisplay 配置与集成

> 现场墙由 UE nDisplay 集群驱动：它是多机 genlock 集群、内容走 frustum 渲染，**没有单块"屏"给你裸全屏**。本阶段做一个**独立于 vpcal 主流程的功能**，配置 nDisplay 并走 UE 官方流程显示测试图。与路线图 **C6（nDisplay export）** 共享 UE 版本锁定与坐标约定。

## 6.1 思路

- 利用 nDisplay **原生支持纹理图显示**的特性，把测试图作为纹理放进 UE 项目，走 UE 官方 nDisplay 流程显示到墙上——而不是从外部抢输出。
- 形态：一个独立配置工具 / UE 侧预制资产（关卡 + 可参数化 material 的全屏平面 + Remote Control Preset），vpcal 经 Remote Control API 切换纹理参数。
- 对应后端 `NDisplayRemoteControlDisplay`：`load()` = 把图备入工程可达位置；`show()` = 经 Remote Control HTTP 换纹理参数。

## 6.2 1:1 难点与风险

- **三个后端里 1:1 最难**：内容经 frustum 渲染、非像素直址；要做到"墙上像素 = pattern 像素"需用 UV-based light card / outer-frustum media plate 等手段精确对齐，且纹理通常须预先进工程（Remote Control 不擅长远程推大文件）。
- 强制走 §2.3 闭环校验；标记为 **advanced**，最后做。
- UE 版本锁定（建议跟随 C6 的目标版本），明确声明支持范围。

## 6.3 验收

- 在目标 UE 版本的 nDisplay 工程中，vpcal 能远程切换墙上显示的测试图；闭环校验判 1:1（或给出量化差距与归因）。

---

## 7. 数据模型与 Schema 影响

- 新增 `models/display.py`（§4.3）。`SessionConfig.display` 为新 optional 字段 → `schema_version` 升一档（更新 `docs/schema-versions.md`，新字段全 optional，下游须容忍）。
- `CalibrationResult` 不变（显示不进求解结果）；若编排记录显示/快照时标，写入 `qa/` 旁路文件而非主结果。
- 遵循 D6 纪律：任何新增列表结构（如多帧、多后端）用列表而非单数字段，避免后续破坏性变更。

## 8. Exit Code

见 §4.6。核心：本特性激活 `4`（auth）与 `8`（external dependency）两个此前保留未用的码；`6` 复用于 1:1 precondition。`exit-codes.md` 同步更新。

## 9. 安全

- Agent **必须**鉴权：bearer token（`--token-file`），错 token → exit 4。
- 默认**绑指定内网网卡**；绑 `0.0.0.0` 需显式 `--allow-any`（fail-closed）。
- Agent 跑在生产舞台机上、能"收指令就全屏"——文档须警示：仅在受控内网启用，token 不入版本库。
- Disguise / nDisplay 后端：API 凭据走环境变量 / 配置文件，不硬编码。

## 10. 风险与未核实项

1. **Disguise 媒体目录约定未核实**（§5.1）——"video 子目录" vs `objects/VideoFile`，落位错则不可见，须真机核对。
2. **Disguise Python API 版本敏感**（§5.2）——符号需在目标 Designer 版本实测。
3. **nDisplay 1:1 经 frustum 渲染难保证**（§6.2）——最大不确定项，故排最后 + 强制闭环校验。
4. **NVIDIA + OpenGL + per-monitor DPI 历史缩放 bug**（§2.4）——Agent 若用 GL 后端须专门验 1:1。
5. **Agent 多屏定位**——SDL2/pygame 在 Windows 多输出偶有 finicky，是工具栈倾向 Qt 的原因。
6. **相机拍摄第一阶段仍人工**（§4.5）——全自动依赖 C1.2 采集卡（硬件阻塞）。
7. **闭环校验依赖 C0**——C0（1:1 验证图）未就绪时 `display verify` 用回退网格，精度与覆盖较弱；C0 完成后切换。

## 11. 待人工决策项（已给默认）

| # | 决策 | 推荐默认 | 备注 |
|---|------|---------|------|
| 1 | Agent 工具栈 | **PySide6 / Qt**（多屏定位 + DPI 最稳） | 体积大；pygame/SDL2 更轻但多屏要验；mpv 为折中 |
| 2 | Agent 分发形式 | **standalone exe（PyInstaller）** | 也支持 `vpcal display agent` 子命令；播放机不装重型 vpcal |
| 3 | Agent 显示内容 | **贴 vpcal 生成的 PNG**（简单优先） | 自行矢量渲染（消除重采样）为进阶项 |
| 4 | 控制连接方向 | **push（Agent 监听、vpcal 连）** | 浏览器 kiosk 变体走 pull（vpcal 起服务、浏览器回连），作零安装备选 |
| 5 | 协议 | **HTTP REST**（状态用轮询/SSE） | 够用；不引 WebSocket 复杂度 |
| 6 | `vpcal display` vs `capture playback` | **display=驱动墙；capture playback=同步驱动；共享 StageDisplay 后端** | 避免两套竞争命令面 |
| 7 | 真机 1:1 校验 | **强制（require_one_to_one_check=true）** | 发给各异现场，静默破 1:1 风险高 |

---

## 附录 A：现场实际操作（第一阶段，操作员视角）

```
① 播放机（动一次手）：双击 display-agent.exe 或
     display-agent --output 1 --port 7000 --token-file agent.token --bind 192.168.10.50
   → 墙上出现 standby 屏：AGENT READY  5000×2700  192.168.10.50:7000  DPI-aware: yes
② 笔记本：vpcal display connect 192.168.10.50:7000     # 握手 + describe 对账 ScreenDefinition
③ 笔记本：vpcal display verify --capture <拍的验证图>    # 闭环 1:1，过了才继续
④ 采集：
   - 手动：vpcal display show normal → 拍 → vpcal display show inverted → 拍 → vpcal display clear
   - 编排：vpcal capture playback --config session.json  # 自动 show→快照 tracking→show
全程只在①碰过播放机一次。
```

## 附录 B：关键复用点速查（给执行 session）

| 要用的现有件 | 路径 | 用途 |
|-------------|------|------|
| pattern 生成 | `core/pattern.py::generate_pattern_images` | 产出要显示的 PNG |
| 屏定义 | `models/screen.py::ScreenDefinition` | 推 canvas 期望分辨率，做 describe 对账 |
| 1:1 实测验证 | `core/processor_check.py::verify_one_to_one` | display verify 的判定核心 |
| 检测器 | `core/detector.py` | 闭环校验解 marker |
| tracking 摄入 | `core/capture.py`（C1.1） | 编排时快照 tracking |
| 播放占位 | `cli/capture.py` 的 `playback`（现抛 PreconditionError） | 改为消费 StageDisplay |
| CLI 契约 | `cli/_common.py` / `models/manifest.py` / `contract-manifest.json` | envelope / exit code / manifest |
```
