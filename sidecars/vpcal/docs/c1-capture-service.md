# C1 采集服务（capture service）

> 路线图任务 **C1**（`docs/remediation-roadmap-v1.md` Stage 3）。把"摆 pose → 拍照 → 拷卡 →
> 命令行"降级为离线兜底，主路径走实时采集，目标一次完整校正（≥8 pose）≤ 5min、零手工文件操作。
> 分三步落地。

## 状态总览

| 步骤 | 内容 | 状态 |
|---|---|---|
| **C1.1** | 追踪实时接入（FreeD UDP / OpenTrackIO 监听，录带 timestamp 的 tracking 流） | ✅ **已实现** |
| **C1.2** | 视频流取流（SDI/NDI/UVC 采集帧，按接收时戳与追踪流配对） | ⛔ 需采集卡硬件，已搭骨架 |
| **C1.3** | 图案播放同步（驱动输出窗口/LED processor 播放 pattern，内嵌 Gray code 序号） | ⛔ 需显示输出硬件，已搭骨架 |

## C1.1 追踪实时接入（已实现）

```bash
# 监听 FreeD UDP，录 30s 到 poses.jsonl
vpcal capture track --protocol freed --port 6301 --duration 30 --out poses.jsonl

# OpenTrackIO（JSON 样本）
vpcal capture track --protocol opentrackio --port 6301 --duration 30 --out poses.jsonl
```

- 输出为带**接收时戳**的 vpcal tracking 流（`poses.jsonl`），可直接作为 session 的 tracking 输入；
- 协议解码：FreeD D1（29 字节，`core/freed.py`）/ OpenTrackIO JSON 样本（`core/capture.py`）；
  位置 m→mm，旋转 pan/tilt/roll（`EULER_PTR`），**`coordinate_system` 用 `freeDEuler`**；
- 时戳基准为首包（相对秒）；非法包跳过；`--max-packets` 可定量截断。
- 这让 `timestamp` 帧匹配策略**真正可达**，替代文件名尾号约定（`frame_matching.py` 降级为离线兜底）。

## C1.2 视频流取流（硬件阻塞，已搭骨架）

`vpcal capture video` 当前抛 `PreconditionError`（"requires capture/display hardware"）。
落地需要：SDI/NDI/UVC 采集设备 + 取流后端（如 PyAV/NDI SDK）。设计要点：
- 与 C1.1 追踪流**按接收时戳配对**（让 timestamp 匹配替代文件名约定）；
- 每帧落盘 + 记录采集时戳。

## C1.3 图案播放同步（硬件阻塞，已搭骨架）

`vpcal capture playback` 当前抛 `PreconditionError`。落地需要：输出窗口 / LED processor 链路。设计要点：
- 按序播放 pattern（normal/inverted 对、多 pose 引导 UI）；
- 帧内嵌 **Gray code 序号**供视频流侧识别当前 pattern → 全程零手工拷贝。

## 验收（M3）

- 一次完整校正（≥8 pose）从开始到 `result.json` ≤ 5min、零手工文件操作；
- `frame_matching` 文件名路径降级为离线兜底模式。

C1.1 的合成包回归测试见 `tests/integration/test_capture.py`（FreeD 编解码、单元换算、UDP loopback）。
C1.2/C1.3 的验收需在接入真实采集卡 / 显示输出后补充。
