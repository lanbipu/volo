# DeckLink 真机验收清单（Phase 2 交付物）

> 执行环境无采集卡（live-capture plan §0 第 5 条），以下项由用户在现场执行。
> 软件侧前置已就绪：`vpcal_capture` C++ shim（`src/vpcal_capture/`，需本地
> DeckLink SDK 才编译）、v210 解包 / timecode 解析合成层单测（`tests/unit/test_v210.py`，
> 全绿）、`--backend decklink` 无模块时的引导性 PreconditionError（已测）。

## 前置

- [ ] 安装 Blackmagic Desktop Video 驱动 + Desktop Video Setup。
- [ ] 下载 DeckLink SDK，设置 `DECKLINK_SDK_DIR=<SDK>/Win|Mac|Linux/include`。
- [ ] `pip install -e .` 重装 vpcal，确认 CMake 输出
      `vpcal_capture: building against DeckLink SDK at …`（模块装为 `vpcal._vpcal_capture`）。
- [ ] `python -c "from vpcal import _vpcal_capture as c; print(c.list_devices())"`
      列出全部板卡。

## 1. 设备枚举与打开

- [ ] `list_devices()` 与 Desktop Video Setup 显示的设备一致（多卡机逐一核对 index）。
- [ ] 对 output-only 卡（如 Mini Monitor）构造 `DeckLinkInput` 报
      "no capture interface"，不崩溃。

## 2. 模式协商（TODO(bench) capture.cpp）

- [ ] 1080p25 / 1080p50 / 1080p59.94 / 1080p60 输入自动检出（VideoInputFormatChanged 路径）。
- [ ] 信号中途切换分辨率/帧率：流不中断，帧尺寸随之更新。
- [ ] YUV 源 → pixel_format "v210"；RGB 源走 10BitRGB 路径（当前 Python 侧只消费
      v210/uyvy，RGB 输入记录现象即可）。

## 3. 拖流稳定性

- [ ] `vpcal capture video --backend decklink --duration 600 --output ndjson`
      1080p50/60 拖流 10 分钟：`frames` 计数 ≈ fps×600（允差 <0.1%），
      `frames_dropped` 为 0（latest-wins 队列不该触发——触发说明消费端阻塞）。
- [ ] 同时开 `--preview-port 0`，MJPEG 预览不中断、CPU 增量记录在案。

## 4. Timecode（Phase 2c 同步分级 gate 的证据链）

- [ ] 送 RP188 的信号链：`raw.timecode` 每帧非空、连续（无跳帧/重复；
      drop-frame 源分隔符为 `;`）。
- [ ] 无 timecode 信号链：`timecode` 为空、`timecode_present == False`——
      运动采集入口应据此硬拒（静态模式不受影响）。

## 5. 精度红线抽查

- [ ] v210 源采集帧落盘为 16-bit PNG（`captures/normal/*.png` 位深 16），
      与 `tests/unit/test_v210.py` 的左对齐约定一致（`gray16 >> 6` 还原 10-bit）。
- [ ] 全流程无任何有损再压缩介入校正链（预览另走独立 JPEG，允许）。

## 6. 端到端

- [ ] 以真实相机 + 追踪源跑 `vpcal capture session --backend decklink …`，
      ≥8 pose 全流程 ≤ 5 分钟、零手工文件操作（C1 验收，M3）。

结果回填本文件并提交（含驱动/SDK 版本、卡型号、信号链拓扑）。
