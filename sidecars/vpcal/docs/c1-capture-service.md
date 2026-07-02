# C1 采集服务（capture service）

> 路线图任务 **C1**（`docs/remediation-roadmap-v1.md` Stage 3）。把"摆 pose → 拍照 → 拷卡 →
> 命令行"降级为离线兜底，主路径走实时采集，目标一次完整校正（≥8 pose）≤ 5min、零手工文件操作。
> 分三步落地。

## 状态总览

| 步骤 | 内容 | 状态 |
|---|---|---|
| **C1.1** | 追踪实时接入（FreeD UDP / OpenTrackIO 监听，录带 timestamp 的 tracking 流） | ✅ **已实现** |
| **C1.2** | 视频流取流（SDI/NDI/UVC 采集帧，按接收时戳与追踪流配对） | ✅ **软件路径已实现**（`capture video` / `capture session`，backend 抽象 uvc/synthetic 可用；ndi 待 spike、decklink 需本地 SDK——真机项见 `decklink-bench-checklist.md`） |
| **C1.3** | 图案播放同步（驱动输出窗口/LED processor 播放 pattern，内嵌 Gray code 序号） | ✅ **软件路径已实现**（Volo 播放器窗口 + `pattern generate --graycode-tags` + `capture session` 的 `request_pattern`/`pattern_ready` 闭环与 Gray code 校验） |

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

## C1.2 视频流取流（已实现，软件路径）

```bash
# 取流（synthetic/uvc 零硬件即可跑；--preview-port 起 localhost MJPEG/WS 预览）
vpcal capture video --backend uvc --device 0 --duration 10 --out frames/ --preview-port 0

# 闭环采集会话（settle→burst→detect→advance 状态机，自动组装 quick-run 兼容 session）
vpcal capture session --screen screen.json --out session/ --backend uvc \
    --track-protocol freed --track-port 6301 --poses 8 --lens lens.json --preview-port 0
```

- 后端抽象 `core/capture_backend.py`：`synthetic`（开发/CI）、`uvc`（cv2，含 SDI/HDMI→USB3 转换器）、`ndi`（cyndilib spike 待做，缺依赖给引导性 PreconditionError）、`decklink`（`src/vpcal_capture/` C++ shim，需本地 SDK，真机验收见 `decklink-bench-checklist.md`）；
- 与 C1.1 追踪流**按接收时戳配对**（同一 `time.monotonic()` 时钟域，`core/tracking_listener.py`），持久化产物用 `frame_id` 1:1 对应（live 配对已在会话内完成，`frame_matching` 文件名路径就此降级为离线兜底）；
- 每 pose 连拍平均、全质量 PNG 落盘（10-bit 源保 16-bit，`core/v210.py`）；预览流独立降采样 JPEG（`core/preview_server.py`），校正链零有损再压缩；
- 每 pose 即时 detect + coverage 增量反馈（NDJSON 事件 `detect_feedback` / `coverage_update`），事件流契约见 `vpcal capture session --help`。

## C1.3 图案播放同步（已实现，软件路径）

播放器本体在 Volo（Tauri 第二窗口，`src-tauri/src/commands/player.rs` + `#/pattern-player` 页）；vpcal 侧：
- `vpcal pattern generate --graycode-tags`：pattern 四角嵌 **Gray code 序号块**（`core/graycode.py`，SYNC 双格同时携带 normal/inverted 极性）；
- `capture session` 通过事件 `request_pattern` 请求切图、stdin `{"cmd":"pattern_ready",…}` 回执确认；`--graycode-sync` 时另以帧内 Gray code 解码佐证 → normal/inverted 双帧全自动、零手工拷贝。
- `vpcal capture playback` 保留为指路桩（播放职责已移交 Volo 播放器窗口）。

## 验收（M3）

- 一次完整校正（≥8 pose）从开始到 `result.json` ≤ 5min、零手工文件操作；
- `frame_matching` 文件名路径降级为离线兜底模式。

C1.1 的合成包回归测试见 `tests/integration/test_capture.py`（FreeD 编解码、单元换算、UDP loopback）。
C1.2/C1.3 的软件路径回归测试见 `tests/integration/test_capture_session.py`（合成源 + FreeD UDP
回环端到端：状态机 → session 组装 → `quick run` validate/detect 消费）、
`tests/integration/test_preview_server.py`、`tests/unit/test_{capture_backend,graycode,v210}.py`。
真实采集卡 / LED 链路的验收项见 `decklink-bench-checklist.md`，由现场执行。
