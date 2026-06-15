# tracksim CLI 使用手册

tracksim 是一个摄像机追踪信号模拟器。它生成虚拟摄像机位姿（来自手柄、脚本运动或固定值），以 FreeD 和 OpenTrackIO 两种协议通过 UDP 或串口发送出去，让 Unreal Engine、Disguise 等渲染端不需要真实追踪硬件就能接收追踪数据。

本文档覆盖 tracksim 全部功能，按实际使用顺序编排。版本基线：`tracksim 0.1.0`，`contract_version 1.0`。

---

## 0. 快速上手（macOS + 手柄 → FreeD）

适用场景：在 macOS 上用 Xbox 手柄通过 FreeD 协议实时发送追踪数据到 Disguise / Unreal Engine。

### 第一步：确认手柄已连接

```bash
tracksim controllers list
```

输出的 `devices` 数组不为空即可继续。如果为空，检查手柄是否已配对并被 macOS 识别。

### 第二步：创建配置文件（只需一次）

```bash
cat > ~/tracksim.toml << 'EOF'
[freed]
target_ip="192.168.10.20"   # 替换为目标机器的 IP
port=6000
EOF
```

**目标机器是 Windows 时**，还需要在对方机器上开放 UDP 入站规则（以管理员身份运行 PowerShell）：

```powershell
New-NetFirewallRule -DisplayName "FreeD UDP 6000" -Direction Inbound -Protocol UDP -LocalPort 6000 -Action Allow
```

### 第三步：启动手柄模式

```bash
tracksim run --source controller --protocol freed --rate 30 -o ndjson --config ~/tracksim.toml
```

按 **Ctrl-C** 停止。配置文件 `~/tracksim.toml` 下次直接复用，无需重新创建。

### 默认手柄轴映射

| 输入 | 控制通道 | 说明 |
|------|----------|------|
| 左摇杆 X | x（横向平移） | rate 模式，无范围限制 |
| 左摇杆 Y | y（纵向平移） | rate 模式，无范围限制，已反向 |
| 右摇杆 X | pan（水平旋转） | 60°/s，无范围限制 |
| 右摇杆 Y | tilt（俯仰） | 60°/s，限 ±90° |
| LT | z（高度降低） | rate 模式，无范围限制 |
| RT | z（高度升高） | rate 模式，无范围限制 |
| LB | roll（向左滚转） | 30°/s，限 ±30° |
| RB | roll（向右滚转） | 30°/s，限 ±30° |
| 右上拨片 P1 | focal_length 增大 | 50mm/s，限 12–300mm |
| 左上拨片 P3 | focal_length 减小 | 同上 |
| 右下拨片 P2 | focus_distance 增大 | 1m/s，限 0.1–100m |
| 左下拨片 P4 | focus_distance 减小 | 同上 |

摇杆死区为 ±0.1，扳机死区为 0.05。如需调整 scale、deadzone 或范围限制，在 `~/tracksim.toml` 里加 `[[controller.mapping]]` 条目覆盖默认值（见第 7 节）。

---

## 1. 安装

tracksim 需要 Python 3.11 或更高版本。macOS / Linux 上建议用虚拟环境安装：

```bash
cd tracksim
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
```

后续每次使用 CLI 前都需要先激活虚拟环境（`source .venv/bin/activate`）。

安装后有两个等价的入口：

```bash
tracksim --help
python -m tracksim --help
```

确认安装成功：

```bash
tracksim version -o json
```

输出中 `data.version` 应为 `"0.1.0"`，`data.contract_version` 应为 `"1.0"`。`--version` 全局 flag 效果相同。

如果想做最彻底的验证，跑一遍测试套件（不需要联网，不需要手柄）：

```bash
pytest
```

全部通过即可。SDL3 相关用例在没有 SDL3 运行库时会自动跳过，不会报错。

---

## 2. tracksim 的输出机制

在开始使用之前，需要理解 tracksim 的输出规则 —— 这是它作为「可编程工具」的核心约定。

### 所有输出都是统一格式的信封

不管哪个命令、不管成功还是失败，tracksim 的 stdout 输出都是同一种 JSON 结构。成功时：

```json
{
  "schema_version": "1.0",
  "status": "ok",
  "operation_id": "sim.send",
  "data": { "packets_sent": 1, "protocols": ["freed"], "frames": 1 },
  "meta": { "request_id": "uuid", "duration_ms": 5, "timestamp": "2026-06-03T..." }
}
```

失败时，`data` 字段换成 `error`，但**仍然输出到 stdout**（stderr 只放给人看的日志）：

```json
{
  "schema_version": "1.0",
  "status": "error",
  "operation_id": "sim.send",
  "error": {
    "code": "CONFIG_ERROR",
    "exit_code": 3,
    "message": "no protocols enabled...",
    "retryable": false,
    "details": {}
  },
  "meta": { "..." }
}
```

这意味着消费 tracksim 输出时，永远可以 `json.loads(stdout)` 然后检查 `status` 字段。

### 四种输出格式

通过 `--output`（简写 `-o`）选择：

- **`text`** —— 给人看的纯文本，成功是 `key: value` 多行，失败是 `error [CODE] (exit N): message`
- **`json`** —— 上面说的完整信封，单个 JSON 对象
- **`ndjson`** —— 每行一个 JSON 事件，只有 `run` 和 `controllers monitor` 才会真正产生多行流式输出，其余命令输出单行 `result`
- **`stream-json`** —— `ndjson` 的别名

不指定 `--output` 时：如果设置了环境变量 `AI_AGENT=1`，默认用 `json`；否则默认用 `text`。

### 退出码

每种错误都有固定的退出码，程序可以直接拿来做分支判断：

| 退出码 | 含义 | 对应 `error.code` |
|--------|------|-------------------|
| 0 | 成功 | — |
| 2 | 命令行参数错误 | `ARG_VALIDATION` |
| 3 | 配置错误 | `CONFIG_ERROR` |
| 6 | 冲突（如覆盖文件未确认） | `CONFLICT` |
| 10 | 找不到手柄 | `NO_CONTROLLER` |
| 11 | 发送失败（UDP/串口） | `TRANSPORT_SEND_FAILED`（可重试） |
| 12 | 不支持的协议 | `UNSUPPORTED_PROTOCOL` |
| 13 | 输入数据非法（位姿、数据包等） | `INVALID_TRAJECTORY` |
| 130 | 被 Ctrl-C 中断 | — |
| 143 | 被 SIGTERM 终止 | — |

退出码 7（超时）和 8（外部依赖失败）已预留但当前版本未使用。

其中只有退出码 11（发送失败）标记为 `retryable: true`，表示重试可能成功。

---

## 3. 配置

tracksim 的配置有三层优先级，从高到低：**CLI flag > 配置文件 > 内置默认值**。

### 生成配置文件

```bash
tracksim config init --path tracksim.toml -o json
```

这会在当前目录写一个 `tracksim.toml`。如果文件已存在，需要加 `--yes` 才能覆盖，否则报 exit 6。

可以先用 `--dry-run` 预览要写的内容而不实际落盘：

```bash
tracksim config init --path tracksim.toml --dry-run -o json
```

**重要：** 生成的模板和内置默认值不完全一致。主要区别：

| 配置项 | 模板写的值 | 不提供配置文件时的内置默认值 |
|--------|-----------|---------------------------|
| `protocols.opentrackio` | `false` | `true` |
| `freed.camera_id` | `0` | `1` |
| `controller.device` | `"0"` | 不设置 |
| `motion.radius` | `1.0` | `2.0` |
| `motion.speed` | `1.0` | `30.0` |
| `motion.amplitude` | `1.0` | `10.0` |

这意味着：如果你不传配置文件直接 `tracksim send`，FreeD 和 OpenTrackIO 都会启用，camera_id 是 1。但如果用了模板生成的配置文件，OpenTrackIO 默认是关的，camera_id 是 0。

### 查看当前生效的配置

```bash
tracksim config show -o json                         # 查看内置默认值
tracksim config show --config tracksim.toml -o json  # 查看合并后的生效值
```

### 校验配置

```bash
tracksim config validate --config tracksim.toml -o json
```

校验通过返回 `{ "valid": true }`。校验的是枚举值和范围，不是类型（类型由 Pydantic 在加载时检查）：

- `freed.transport` 只能是 `udp_unicast`、`udp_broadcast`、`serial`
- `freed.scaling.variant` 只能是 `native`、`radamec`
- `freed.camera_id` 必须在 0–255
- `opentrackio.transport` 只能是 `unicast`、`multicast`
- `opentrackio.encoding` 只能是 `json`、`cbor`

非法值会报 `CONFIG_ERROR`（exit 3），`details.allowed` 里给出合法选项。

---

## 4. 发送追踪数据

`send` 是最直接的命令 —— 构造一个位姿，发一帧（或持续发一段时间）。不需要手柄，适合脚本驱动和 CI 测试。

### 发一帧

```bash
tracksim send --protocol freed -o json
```

不指定位姿时使用默认值（pan/tilt/roll 和 x/y/z 全为 0，焦距 35mm，对焦距离 3m）。返回：

```json
{ "packets_sent": 1, "protocols": ["freed"], "frames": 1 }
```

### 指定位姿

有 8 个位姿参数可以直接通过 flag 传：

```bash
tracksim send --protocol freed \
  --pan 12.5 --tilt -3 --roll 0 \
  --x 1.0 --y 2.0 --z 1.5 \
  --focal-length 50 --focus-distance 4 \
  -o json
```

还有 5 个位姿参数（`iris`、`entrance_pupil`、`frame`、`timestamp`、`rate`）只能通过 stdin 传 JSON：

```bash
echo '{"pan": 10, "iris": 2.8}' | tracksim send --protocol freed -o json
```

stdin 和 flag 可以混用。如果同一个字段两边都给了值，**stdin 优先**（stdin 的值会覆盖 flag）。stdin 中出现位姿模型里不存在的字段会报 exit 13。用 `--no-input` 可以强制忽略 stdin。

所有数值字段都不接受 NaN 和正负无穷，违反会报 `INVALID_TRAJECTORY`（exit 13）。

### 持续发送

加上 `--duration`（秒）和 `--rate`（Hz）就能持续发送固定位姿：

```bash
tracksim send --protocol freed --pan 10 --duration 2 --rate 60 -o json
```

帧数的计算是 `max(1, ceil(duration × rate))`，所以这个例子会发 120 帧。`packets_sent` = 帧数 × 启用的协议数。

### 同时发两种协议

```bash
tracksim send --protocol freed --protocol opentrackio -o json
```

`--protocol` 可以重复指定。如果不指定，按配置文件的 `[protocols]` 开关决定。两个协议都没启用会报 exit 3。

---

## 5. 持续运行（流式模式）

`send` 适合发一帧或发一段固定位姿。如果需要根据运动脚本或手柄输入持续生成变化的位姿，用 `run`。

### 基本用法

```bash
tracksim run --source script --protocol freed --rate 20 --duration 0.5 -o ndjson
```

这会启动一个流式循环：每 tick 从位姿来源获取新位姿 → 发送给所有启用的协议 → 按 rate 限速 → 循环直到 duration 用完。

### 流式输出和非流式输出的区别

这是 tracksim 最重要的行为差异之一：

- **`-o ndjson`**：真正的流式输出。每个事件实时写一行 JSON。你会看到 `start` → 若干个 `progress` → `result` 逐行出现。
- **`-o json`**：不输出中间过程。整个运行结束后输出一个汇总信封。stdout 始终是**单个合法的 JSON 对象** —— `json.loads(stdout)` 必须成功，不管命令跑了多久。
- **`-o text`**：同样不输出中间过程，但输出的是人类可读的 `key: value` 纯文本，不是 JSON。

### ndjson 的事件序列

每行都带 `type`、`sequence`（从 0 递增）、`timestamp`、`request_id`、`schema_version` 五个公共字段，加上事件特有的字段：

**`start`** —— 运行开始，附带 `protocols`（协议名列表）和 `rate`（配置的帧率）。

**`progress`** —— 每 tick 一行，附带 `packets_sent`（累计发包数）、`rate_actual`（实际帧率）、`pose`（当前位姿的完整字段）。

**`warning`** —— 某个 emitter 发送失败但没有 fail-fast 时出现，附带 `message`。循环不会因此中断。

**`result`** —— 运行结束，`final: true`。附带 `reason`（`"completed"` / `"stopped"` / `"source-exhausted"`）和 `total_packets`。

举例：`--rate 20 --duration 0.5` 会产生约 12 行（1 start + 10 progress + 1 result）。

### 三种位姿来源

通过 `--source` 指定：

**`static`** —— 固定位姿，每 tick 位姿不变。

**`script`**（默认值）—— 程序化运动，根据 `[motion]` 配置生成轨迹。但要注意，`[motion] motion` 的默认值是 `"static"`，所以如果不改配置，script 来源实际上也不动。要看到运动，需要改成 `"orbit"`、`"sine"` 或 `"sweep"`，并设置对应的 radius/speed/amplitude/freq。

**`controller`** —— 从游戏手柄实时读取输入。这个来源比较特殊：它绕过了普通的 factory，由 main 直接初始化 SDL。没有手柄时报 exit 10。

### 有界和无界运行

给了 `--duration` 就是有界运行，到时间自动停止。不给则一直跑下去，直到 Ctrl-C。

Ctrl-C（SIGINT）和 SIGTERM 都会触发优雅关闭：停止循环 → 发出 `result` 行 → 退出。退出码是 128 + 信号编号（Ctrl-C 是 130，SIGTERM 是 143）。

---

## 6. 解码和回环验证

tracksim 可以解码自己发出的数据包，用来做端到端正确性验证。

### 解码 FreeD 包

```bash
tracksim freed decode <hex字符串> -o json
```

也可以从 stdin 读二进制：

```bash
cat packet.bin | tracksim freed decode -o json
```

解码结果包含 `message_type`、`camera_id`、`pan`/`tilt`/`roll`（度）、`x`/`y`/`z`（米）、`zoom_raw`/`focus_raw`（原始整数）、`checksum_valid`。

要求输入必须是 29 字节，首字节 `0xD1`，校验和正确（`(0x40 - 前28字节之和) & 0xFF`），否则报 exit 13。

注意：解码固定使用 native 缩放参数（角度 ×32768，位置 ×64000）。如果发送端用了 radamec 或自定义缩放，解出来的数值会有偏差。

### 解码 OpenTrackIO 包

```bash
cat otrk.bin | tracksim opentrackio decode -o json
```

只从 stdin 读二进制。解码结果包含 `encoding`（json/cbor）、`sequence`、`segment_offset`、`last_segment`、`checksum_valid`、`sample`（完整的 OpenTrackIO 样本对象）。

要求：至少 16 字节，开头是 `OTrk`，Fletcher-16 校验和正确，编码标识必须是 `0x01`（JSON）或 `0x02`（CBOR）。

### 回环测试示例

最可靠的验证方式是在本机抓包然后解码比对。FreeD 默认发往 `127.0.0.1:6000`（UDP unicast），可以直接用 Python 收：

```bash
# 终端 1：监听
python3 -c '
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", 6000))
open("/tmp/freed.hex", "w").write(s.recvfrom(65535)[0].hex())
' &
sleep 0.3

# 终端 2：发一帧已知位姿
tracksim send --protocol freed --pan 12.5 --x 1.0 -o json

# 等收包器结束后解码
wait
tracksim freed decode "$(cat /tmp/freed.hex)" -o json
```

解码结果中 `pan` 应接近 12.5，`x` 应接近 1.0，`checksum_valid` 为 `true`。

OpenTrackIO 的默认目标是组播地址 `239.135.1.1:55555`，本机测试建议改成 unicast。在配置文件中设 `[opentrackio] transport = "unicast"` 和 `ip = "127.0.0.1"`，然后用类似的方法收包和解码。

---

## 7. 手柄

需要 SDL3 运行库和物理手柄。没有 SDL3 或没接手柄时，相关命令报 exit 10，测试中自动跳过。

### 列出已连接的手柄

```bash
tracksim controllers list -o json
```

返回 `devices` 数组，每个元素包含 `index`、`name`、`guid`。没有手柄时数组为空。

### 实时监控手柄输入

```bash
tracksim controllers monitor --rate 30 --samples 100 -o ndjson
```

ndjson 模式下会逐帧流式输出每个采样的轴值（`axes`）和按键状态（`buttons`）。json 模式下只返回最后一帧和总采样数。

`--rate` 默认 30 Hz，`--samples` 默认 100 个。

---

### Xbox Elite 拨片控制变焦 / 对焦

`tracksim` 把 Elite 的 4 个背板拨片读作按键 `p1`/`p2`/`p3`/`p4`（依据 SDL `SDL_gamepad.h` 文档契约）：

| 名 | SDL 常量 | 物理位置 | 默认用途 |
|----|----------|----------|----------|
| `p1` | RIGHT_PADDLE1 | 右上 | 变焦推近（focal_length +） |
| `p3` | LEFT_PADDLE1  | 左上 | 变焦拉远（focal_length −） |
| `p2` | RIGHT_PADDLE2 | 右下 | 对焦拉远（focus_distance +） |
| `p4` | LEFT_PADDLE2  | 左下 | 对焦拉近（focus_distance −） |

**真机使用前提（需实测）：**
1. **连接**：USB-C 有线最稳；蓝牙对拨片上报可能不稳定。
2. **清空拨片 profile**：在 Xbox Accessories app 里把 4 个拨片设为「未分配」，否则它们会镜像 ABXY、不会作为独立拨片上报。
3. **验证对应关系**：跑 `tracksim controllers monitor --rate 30 --samples 100 -o ndjson`，逐个按 P1–P4，确认 `buttons.p1..p4` 能独立 toggle、且物理位置与名字一致；不一致则在 config 里对调 `source`（纯配置）。

**内置默认映射**：当 `[controller].mapping` 为空时，手柄开箱即用——左摇杆平移、右摇杆 pan/tilt、LT/RT 控高度（z）、肩键 roll、上排拨片变焦、下排拨片对焦（rate 速率模式，按住持续变、松开停）。

**追加到已有 config**：默认映射「全空才生效」，若你已有自定义 mapping，把下面四条拨片条目追加进 `[controller].mapping` 即可启用变焦/对焦：

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

> mapping 里 `channel`/`source`/`mode` 拼错时：`tracksim config validate` 会报 exit 3；`run --source controller` 则在 stderr 警告并跳过该条、继续运行（不中断）。

## 8. 工具自描述

这几个命令用于让程序自己描述自己的能力，在构建自动化集成时会用到。

```bash
tracksim manifest -o json     # 列出所有 operation 的 ID 和摘要（共 13 个）
tracksim schema -o json       # 列出 CLI 命令结构
tracksim version -o json      # 版本号和契约版本号
tracksim completion zsh       # 输出 zsh 补全脚本（也支持 bash 和 fish）
```

`completion` 在 text 模式下直接输出可 source 的脚本，json 模式下包在 `data.completion` 中。只接受 `bash`、`zsh`、`fish` 三个值。

---

## 9. 自动化集成

### AI_AGENT 模式

```bash
AI_AGENT=1 tracksim version
```

设置环境变量 `AI_AGENT=1` 后，不指定 `--output` 时默认输出 json 而非 text。

### 预演模式

`--dry-run` 让有副作用的命令只描述它会做什么，不实际执行：

```bash
tracksim send --protocol freed --pan 10 --dry-run -o json
# 返回 dry_run_plan: { protocols, targets, pose, frames }，不发任何包

tracksim run --source script --rate 20 --duration 1 --dry-run -o json
# 返回 dry_run_plan: { protocols, source, rate, max_ticks }，不启动循环

tracksim config init --path x.toml --dry-run -o json
# 返回 dry_run_plan: { path, action, content }，不写文件
```

### 其他开关

`--no-input` 强制不读 stdin，即使管道中有数据也忽略。`--no-color` 和环境变量 `NO_COLOR` 抑制颜色输出。

---

## 参考

### 全部 Operation

| operation_id | CLI 命令 | 是否有副作用 |
|---|---|---|
| `sim.run` | `run` | 网络发包（流式） |
| `sim.send` | `send` | 网络发包 |
| `controllers.list` | `controllers list` | 无 |
| `controllers.monitor` | `controllers monitor` | 无（流式） |
| `config.init` | `config init` | 写文件 |
| `config.show` | `config show` | 无 |
| `config.validate` | `config validate` | 无 |
| `freed.decode` | `freed decode` | 无 |
| `opentrackio.decode` | `opentrackio decode` | 无 |
| `meta.manifest` | `manifest` | 无 |
| `meta.schema` | `schema` | 无 |
| `meta.version` | `version` | 无 |
| `meta.completion` | `completion <shell>` | 无 |

### 全局 Flag

这些 flag 可以放在子命令前面或后面，效果相同。

| Flag | 说明 |
|------|------|
| `--version` | 打印版本号并退出 |
| `--yes, -y` | 跳过确认（`config init` 覆盖文件时需要） |
| `--dry-run` | 只预演，不执行副作用 |
| `--config PATH` | 指定配置文件（`.toml`/`.yaml`/`.json`） |
| `--output, -o` | 输出格式：`text` / `json` / `ndjson` / `stream-json` |
| `--input-format` | stdin 格式（目前固定为 json） |
| `--log-level` | 日志级别：`debug` / `info` / `warn` / `error`（写到 stderr） |
| `--verbose, -v` | 提升日志到 debug（可叠加） |
| `--quiet, -q` | 降低日志到 error |
| `--no-color` | 不输出颜色 |
| `--no-input` | 不读 stdin |

### CameraPose 位姿模型

| 字段 | 类型 | 单位 | 默认值 | 能否用 CLI flag |
|------|------|------|--------|----------------|
| `pan` | float | 度 | 0.0 | `--pan` |
| `tilt` | float | 度 | 0.0 | `--tilt` |
| `roll` | float | 度 | 0.0 | `--roll` |
| `x` | float | 米 | 0.0 | `--x` |
| `y` | float | 米 | 0.0 | `--y` |
| `z` | float | 米 | 0.0 | `--z` |
| `focal_length` | float | mm | 35.0 | `--focal-length` |
| `focus_distance` | float | m | 3.0 | `--focus-distance` |
| `iris` | float 或 null | T-stop | null | 仅 stdin |
| `entrance_pupil` | float 或 null | m | null | 仅 stdin |
| `frame` | int | — | 0 | 仅 stdin |
| `timestamp` | float | 秒 | 0.0 | 仅 stdin |
| `rate` | float | Hz | 60.0 | 仅 stdin |

### 配置文件完整结构

下面列出所有配置项、它们在配置文件中的默认值和内置默认值。两者不同时用括号标注。

```toml
[protocols]
freed = true
opentrackio = false                  # （内置默认：true）

[freed]
transport = "udp_unicast"            # 可选：udp_unicast / udp_broadcast / serial
target_ip = "127.0.0.1"
port = 6000
serial_device = "/dev/ttyUSB0"       # （内置默认：不设置）
baud = 38400
camera_id = 0                        # （内置默认：1）范围 0–255
rate_hz = 60.0

[freed.scaling]
variant = "native"                   # 可选：native / radamec
angle_lsb_per_deg = 32768.0          # 每度的 LSB 数
pos_lsb_per_m = 64000.0              # 每米的 LSB 数

[opentrackio]
transport = "multicast"              # 可选：unicast / multicast
source_number = 1
ip = "239.135.1.1"
port = 55555
encoding = "json"                    # 可选：json / cbor
rate_hz = 60.0

[controller]
device = "0"                         # （内置默认：不设置）设备序号
# mapping 是数组，每个元素：
# channel, source, mode(=rate), scale(=1.0), deadzone(=0.0),
# invert(=false), clamp_min, clamp_max

[motion]
motion = "static"                    # 可选：static / orbit / sine / sweep
radius = 1.0                         # （内置默认：2.0）
speed = 1.0                          # （内置默认：30.0）
amplitude = 1.0                      # （内置默认：10.0）
freq = 0.5

[output]
format = "text"
log_level = "info"
```

### FreeD D1 报文格式

29 字节，大端序：

| 偏移 | 长度 | 内容 |
|------|------|------|
| 0 | 1 | `0xD1` 消息类型 |
| 1 | 1 | camera_id |
| 2–4 | 3 | pan，24-bit 有符号定点数（值 = 角度 × angle_lsb_per_deg） |
| 5–7 | 3 | tilt，同上 |
| 8–10 | 3 | roll，同上 |
| 11–13 | 3 | X 位置，24-bit 有符号定点数（值 = 距离 × pos_lsb_per_m） |
| 14–16 | 3 | Y 位置，同上 |
| 17–19 | 3 | Z 位置，同上 |
| 20–22 | 3 | zoom，24-bit 无符号原始值（来自配置，不从位姿换算） |
| 23–25 | 3 | focus，同上 |
| 26–27 | 2 | 保留（0x0000） |
| 28 | 1 | 校验和 = `(0x40 - 前 28 字节之和) & 0xFF` |

### OpenTrackIO OTrk 报文格式

每个 UDP 包带 16 字节头部，大端序：

| 偏移 | 长度 | 内容 |
|------|------|------|
| 0–3 | 4 | `OTrk` 标识 |
| 4 | 1 | 保留（0x00） |
| 5 | 1 | 编码方式（0x01 = JSON, 0x02 = CBOR） |
| 6–7 | 2 | sequence，uint16 |
| 8–11 | 4 | segment_offset，uint32 |
| 12–13 | 2 | 高位 1 bit = 是否最后一段，低 15 bit = payload 长度 |
| 14–15 | 2 | Fletcher-16 校验和 |
| 16+ | ≤1484 | 负载 |

payload 超过 1484 字节时自动分段，每段各自带头部。sequence 按每个 UDP 包递增，不是按每个 sample。

---

## FBX / 轨迹回放（`convert` / `run --source fbx|track`）

把已录制的摄影机动画轨迹逐帧回放并发包。轨迹来源：tracksim 原生 `track.json`、Disguise dense CSV，或任意来源的 FBX（经 Blender 转换）。

### `tracksim run --source track <file>`（纯 Python，不需 Blender）

直接回放结构化轨迹（`track.json` 或 Disguise dense `.csv`）。

```bash
tracksim run --source track shot.json --protocol freed --rate 50 --duration 2 -o json
```

- 发射速率默认取轨迹的**作者帧率**（track.json 的 `rate` / CSV 的 sidecar fps）；`--rate` 覆盖。
- CSV 无内嵌帧率且无 sidecar、又没给 `--rate` → 报错（不静默漂移）。
- 播完即 `SimStopped(reason="source-exhausted")`，正常退出 0；`--duration` 可提前截断；Ctrl-C 退 130。
- **`--loop`**：无缝循环回放——播完游标回绕到首帧，单进程内连续发包（无进程重启间隙），从不耗尽；靠 `--duration` 或 Ctrl-C 停止。`frame`/`timestamp` 持续递增，pose 周期性回到起点（`--source fbx --loop` 同样适用）。
- 期望输出：单个 success envelope（`operation_id: "sim.run"`）。

### `tracksim convert <in.fbx> --out <track.json>`（需 Blender）

把 FBX 摄影机动画转成 `track.json`（落盘、可复用、可人工检查）。

```bash
tracksim convert shot.fbx --out shot.track.json --camera "cam 1" -o json
# 期望 data: {out, frames, rate, camera}
tracksim convert shot.fbx --out o.json --dry-run -o json   # 仅打印计划，不调 Blender
```

- Blender 自动探测顺序：`[fbx].blender_path` → `$BLENDER` → `/Applications/Blender.app/...`(macOS) → PATH 上的 `blender`；找不到 → `CONFIG_ERROR`(exit 3)。
- FBX 含多个相机且未指定 `--camera`/`[fbx].default_camera` → `FBX_CONVERSION_FAILED`(exit 13)，details 列出可选相机名。
- 转换结果按内容/脚本/Blender 版本/配置派生键缓存，命中跳过冷启动。

### `tracksim run --source fbx <in.fbx>`（需 Blender）

一步到位：内部先 `convert`（带缓存）再回放。

```bash
tracksim run --source fbx shot.fbx --camera "cam 1" --protocol freed opentrackio
```

### 坐标约定（实现状态）

- **位置**：`x=bx, y=bz, z=by`（Blender 世界平移 → canonical），对 Disguise 参考实测验证 **<4mm**。
- **focal_length**：1:1。
- **旋转 / focus 单位**：当前为 best-effort（对 Disguise 标定到 ~2°；Disguise 的 rotation 通道与 FBX 朝向有系统性偏差，故不以其为准）。**后续以 Unreal Engine 导出的 FBX 为准重新标定/确认**。
- 错误：Blender 缺失/`timeout_s` 非正 → exit 3；FBX 转换失败/超时/多相机未指定/损坏 → exit 13；轨迹文件格式非法/CSV 缺 rate → exit 13（`INVALID_TRAJECTORY`）。
