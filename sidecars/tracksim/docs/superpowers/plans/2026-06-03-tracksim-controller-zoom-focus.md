# 手柄 Zoom / Focus 控制 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Xbox Elite 手柄的 4 个背板拨片驱动变焦/对焦，并提供一套开箱即用的内置默认手柄映射。

**Architecture:** 在六边形架构内做最小切口——SDL 适配器读取拨片、端口层固化 source 词汇表、domain 暴露合法 channel 集合、config 提供默认映射、controller source 播种 rate 初值；mapping 校验分两档（`config validate` 报错 / 运行时警告不中断）。不碰协议编码、transport、envelope。

**Tech Stack:** Python 3.11+ / Pydantic v2 / PySDL3（SDL 3.4.8）/ pytest。

**源 spec：** `docs/superpowers/specs/2026-06-03-tracksim-controller-zoom-focus-design.md`（v2，已纳入 Codex adversarial review）。

**通用约定：**
- 所有命令从仓库根目录运行；测试用 `pytest`。
- 每次 commit 的 message 末尾追加 trailer：`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`（下文 task 里的 `-m` 省略该行以保持可读）。
- 当前分支：`feat/controller-zoom-focus`。

---

## 文件结构（先锁定边界）

| 文件 | 职责 | 本计划改动 |
|---|---|---|
| `src/tracksim/domain/pose.py` | 位姿模型 | 新增 `VALID_POSE_CHANNELS` 常量（Task 1） |
| `src/tracksim/ports/controller_input.py` | 手柄输入端口契约 | 新增 `CONTROLLER_AXES/BUTTONS/SOURCES`；注释补拨片（Task 2） |
| `src/tracksim/infra/sdl_controller.py` | SDL 适配器（唯一 import sdl3） | `poll()` 读 4 拨片（Task 3） |
| `src/tracksim/sources/controller.py` | 手柄 → CameraPose | `__init__` 播种 rate 初值（Task 4） |
| `src/tracksim/config.py` | 配置模型 | 新增 `DEFAULT_CONTROLLER_MAPPING`（Task 5） |
| `src/tracksim/cli/commands/factory.py` | 装配 + 校验 | `resolve_/check_/warn_controller_mapping`（Task 6/7/9） |
| `src/tracksim/cli/commands/config_cmd.py` | `config` 子命令 | `validate` 严格校验 mapping（Task 8） |
| `src/tracksim/cli/main.py` | 组合根 | controller 分支：默认映射 + 运行时警告（Task 9） |
| `tests/test_sdl_controller_poll.py` | SDL poll 测试 | 拨片断言（Task 3） |
| `docs/tracksim-CLI-运行流程.md` / `…/specs/2026-06-02-tracksim-design.md` | 文档 | §7 拨片流程 + §13 标记（Task 10） |

---

## Task 1: `VALID_POSE_CHANNELS`（domain 暴露合法 channel 集合）

**Files:**
- Modify: `src/tracksim/domain/pose.py`（在文件末尾追加，class 定义之后）
- Test: `tests/test_valid_pose_channels.py`

- [ ] **Step 1: 写失败测试**

```python
# tests/test_valid_pose_channels.py
from tracksim.domain.pose import VALID_POSE_CHANNELS


def test_valid_pose_channels_excludes_bookkeeping_fields():
    assert VALID_POSE_CHANNELS == {
        "pan", "tilt", "roll", "x", "y", "z",
        "focal_length", "focus_distance", "iris", "entrance_pupil",
    }
    # bookkeeping 字段不可作为映射目标
    assert "frame" not in VALID_POSE_CHANNELS
    assert "timestamp" not in VALID_POSE_CHANNELS
    assert "rate" not in VALID_POSE_CHANNELS
```

- [ ] **Step 2: 运行确认失败**

Run: `pytest tests/test_valid_pose_channels.py -q`
Expected: FAIL — `ImportError: cannot import name 'VALID_POSE_CHANNELS'`

- [ ] **Step 3: 实现**

在 `src/tracksim/domain/pose.py` 末尾（`CameraPose` 类之后）追加：

```python
# 控制器 mapping 可作为目标的 pose 字段（排除 frame/timestamp/rate 记账字段）。
VALID_POSE_CHANNELS = frozenset(CameraPose.model_fields) - {"frame", "timestamp", "rate"}
```

- [ ] **Step 4: 运行确认通过**

Run: `pytest tests/test_valid_pose_channels.py -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tracksim/domain/pose.py tests/test_valid_pose_channels.py
git commit -m "feat: expose VALID_POSE_CHANNELS for controller mapping validation"
```

---

## Task 2: 手柄 source 词汇表常量（端口层单一事实来源）

**Files:**
- Modify: `src/tracksim/ports/controller_input.py`（imports 之后加常量；更新 `ControllerState` 注释）
- Test: `tests/test_controller_sources.py`

- [ ] **Step 1: 写失败测试**

```python
# tests/test_controller_sources.py
from tracksim.ports.controller_input import (
    CONTROLLER_AXES,
    CONTROLLER_BUTTONS,
    CONTROLLER_SOURCES,
)


def test_sources_cover_paddles_sticks_triggers():
    assert {"p1", "p2", "p3", "p4"} <= CONTROLLER_BUTTONS
    assert {"a", "b", "x", "y", "leftshoulder", "rightshoulder", "back", "start"} <= CONTROLLER_BUTTONS
    assert {"leftx", "lefty", "rightx", "righty", "lefttrigger", "righttrigger"} == CONTROLLER_AXES


def test_sources_is_union_and_disjoint():
    assert CONTROLLER_SOURCES == CONTROLLER_AXES | CONTROLLER_BUTTONS
    assert CONTROLLER_AXES.isdisjoint(CONTROLLER_BUTTONS)
```

- [ ] **Step 2: 运行确认失败**

Run: `pytest tests/test_controller_sources.py -q`
Expected: FAIL — `ImportError: cannot import name 'CONTROLLER_AXES'`

- [ ] **Step 3: 实现**

在 `src/tracksim/ports/controller_input.py` 的 `from typing import Protocol` 之后、`@dataclass` 之前插入：

```python
# 一个 ControllerState 能包含的全部 axis / button 键。
# SDL 后端的 poll() 产出与 mapping 校验共同引用此处，保证「合法 source」单一事实来源。
CONTROLLER_AXES = frozenset({
    "leftx", "lefty", "rightx", "righty", "lefttrigger", "righttrigger",
})
CONTROLLER_BUTTONS = frozenset({
    "a", "b", "x", "y", "leftshoulder", "rightshoulder", "back", "start",
    "p1", "p2", "p3", "p4",  # Xbox Elite 背板拨片：p1=右上 p2=右下 p3=左上 p4=左下
})
CONTROLLER_SOURCES = CONTROLLER_AXES | CONTROLLER_BUTTONS
```

并把 `ControllerState` 的两行注释更新为：

```python
    # axis keys: leftx, lefty, rightx, righty in -1..1;
    #            lefttrigger, righttrigger in 0..1   (见 CONTROLLER_AXES)
    axes: dict[str, float] = field(default_factory=dict)
    # button keys: a, b, x, y, leftshoulder, rightshoulder, back, start,
    #              p1, p2, p3, p4 (Elite paddles)    (见 CONTROLLER_BUTTONS)
    buttons: dict[str, bool] = field(default_factory=dict)
```

- [ ] **Step 4: 运行确认通过**

Run: `pytest tests/test_controller_sources.py -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tracksim/ports/controller_input.py tests/test_controller_sources.py
git commit -m "feat: add CONTROLLER_SOURCES vocabulary incl. Elite paddles"
```

---

## Task 3: SDL 后端读取 4 拨片

**Files:**
- Modify: `src/tracksim/infra/sdl_controller.py`（`poll()` 的 `buttons` 字典，约 124–133 行）
- Test: `tests/test_sdl_controller_poll.py`（fake 加常量；更新按键集合断言；加拨片用例）

- [ ] **Step 1: 写失败测试**

在 `tests/test_sdl_controller_poll.py` 的 `_install_fake_sdl3` 里，紧接 `mod.SDL_GAMEPAD_BUTTON_START = 6` 之后追加拨片常量：

```python
    mod.SDL_GAMEPAD_BUTTON_RIGHT_PADDLE1 = 16
    mod.SDL_GAMEPAD_BUTTON_LEFT_PADDLE1 = 17
    mod.SDL_GAMEPAD_BUTTON_RIGHT_PADDLE2 = 18
    mod.SDL_GAMEPAD_BUTTON_LEFT_PADDLE2 = 19
```

把 `test_poll_maps_buttons` 里的集合断言

```python
    assert set(s.buttons) == {
        "a", "b", "x", "y", "leftshoulder", "rightshoulder", "back", "start"
    }
```

替换为（引用端口常量，保证 completeness）：

```python
    from tracksim.ports.controller_input import CONTROLLER_BUTTONS
    assert set(s.buttons) == CONTROLLER_BUTTONS
```

并新增用例：

```python
def test_poll_reads_elite_paddles(monkeypatch):
    _install_fake_sdl3(
        monkeypatch,
        gamepad_ids=[7],
        buttons={16: True, 17: False, 18: True, 19: False},
    )
    from tracksim.infra.sdl_controller import SDLControllerInput

    ctrl = SDLControllerInput()
    ctrl.open(0)
    s = ctrl.poll()
    assert s.buttons["p1"] is True   # RIGHT_PADDLE1 右上
    assert s.buttons["p3"] is False  # LEFT_PADDLE1  左上
    assert s.buttons["p2"] is True   # RIGHT_PADDLE2 右下
    assert s.buttons["p4"] is False  # LEFT_PADDLE2  左下
```

- [ ] **Step 2: 运行确认失败**

Run: `pytest tests/test_sdl_controller_poll.py -q`
Expected: FAIL — `test_poll_reads_elite_paddles` KeyError `'p1'`，且 `test_poll_maps_buttons` 集合不相等

- [ ] **Step 3: 实现**

在 `src/tracksim/infra/sdl_controller.py` 的 `poll()` 中，`buttons = { ... }` 字典末尾（`"start": ...` 之后）追加：

```python
            "p1": button(sdl.SDL_GAMEPAD_BUTTON_RIGHT_PADDLE1),
            "p2": button(sdl.SDL_GAMEPAD_BUTTON_RIGHT_PADDLE2),
            "p3": button(sdl.SDL_GAMEPAD_BUTTON_LEFT_PADDLE1),
            "p4": button(sdl.SDL_GAMEPAD_BUTTON_LEFT_PADDLE2),
```

- [ ] **Step 4: 运行确认通过**

Run: `pytest tests/test_sdl_controller_poll.py -q`
Expected: PASS（全部用例）

- [ ] **Step 5: Commit**

```bash
git add src/tracksim/infra/sdl_controller.py tests/test_sdl_controller_poll.py
git commit -m "feat: read 4 Xbox Elite paddles in SDL poll() as p1-p4"
```

---

## Task 4: rate channel 初始值播种

**Files:**
- Modify: `src/tracksim/sources/controller.py`（`__init__`，约 22–25 行）
- Test: `tests/sources/test_controller_seed.py`

- [ ] **Step 1: 写失败测试**

```python
# tests/sources/test_controller_seed.py
from dataclasses import dataclass

import pytest

from tracksim.ports.controller_input import ControllerState
from tracksim.sources.controller import ControllerPoseSource


@dataclass
class MapEntry:
    channel: str
    source: str
    mode: str = "rate"
    scale: float = 1.0
    deadzone: float = 0.0
    invert: bool = False
    clamp_min: float | None = None
    clamp_max: float | None = None


class FakeControllerInput:
    def __init__(self, states):
        self._states = states
        self._i = 0

    def list_devices(self):
        return []

    def open(self, index):
        return None

    def poll(self):
        s = self._states[min(self._i, len(self._states) - 1)]
        self._i += 1
        return s

    def close(self):
        return None


class StubClock:
    def now(self):
        return 0.0

    def sleep(self, seconds):
        return None


def test_rate_channels_seed_from_camerapose_defaults():
    # 未按拨片：focal/focus 应停在 CameraPose 默认值，而非 0。
    states = [ControllerState(axes={}, buttons={"p1": False, "p2": False}, connected=True)]
    mapping = [
        MapEntry(channel="focal_length", source="p1"),
        MapEntry(channel="focus_distance", source="p2"),
        MapEntry(channel="pan", source="rightx"),
    ]
    src = ControllerPoseSource(FakeControllerInput(states), mapping, StubClock())
    pose = src.next(0.1)
    assert pose.focal_length == pytest.approx(35.0)
    assert pose.focus_distance == pytest.approx(3.0)
    assert pose.pan == pytest.approx(0.0)  # 未映射来源静止仍为 0
```

- [ ] **Step 2: 运行确认失败**

Run: `pytest tests/sources/test_controller_seed.py -q`
Expected: FAIL — `focal_length` 为 `0.0`（未播种），断言 35.0 不成立

- [ ] **Step 3: 实现**

在 `src/tracksim/sources/controller.py` 的 `__init__` 中，`self._channels: dict[str, float] = {}` 这一行之后插入：

```python
        # rate 模式从 channel 当前值积分；用 CameraPose 默认值播种，使 focal_length
        # 起于 35mm、focus_distance 起于 3m（否则会从 0 起积分 = 0mm 镜头）。
        base = CameraPose()
        for entry in self._mapping:
            seed = getattr(base, entry.channel, 0.0)
            self._channels.setdefault(entry.channel, seed if seed is not None else 0.0)
```

（`CameraPose` 已在文件顶部导入，无需新增 import。）

- [ ] **Step 4: 运行确认通过**

Run: `pytest tests/sources/test_controller_seed.py -q`
Expected: PASS

- [ ] **Step 5: 回归既有 controller source 测试**

Run: `pytest tests/sources/test_controller.py -q`
Expected: PASS（pan 等默认 0，播种不改变其行为）

- [ ] **Step 6: Commit**

```bash
git add src/tracksim/sources/controller.py tests/sources/test_controller_seed.py
git commit -m "fix: seed controller rate channels from CameraPose defaults"
```

---

## Task 5: 内置默认映射 `DEFAULT_CONTROLLER_MAPPING`

**Files:**
- Modify: `src/tracksim/config.py`（`ControllerCfg` 类之后，约第 60 行后）
- Test: `tests/test_default_controller_mapping.py`

- [ ] **Step 1: 写失败测试**

```python
# tests/test_default_controller_mapping.py
from tracksim.config import DEFAULT_CONTROLLER_MAPPING


def test_default_mapping_binds_paddles_to_zoom_and_focus():
    by_source = {e.source: e for e in DEFAULT_CONTROLLER_MAPPING}
    assert {"p1", "p2", "p3", "p4"} <= set(by_source)
    # 上排 P1/P3 -> 变焦
    assert by_source["p1"].channel == "focal_length"
    assert by_source["p3"].channel == "focal_length"
    # 下排 P2/P4 -> 对焦
    assert by_source["p2"].channel == "focus_distance"
    assert by_source["p4"].channel == "focus_distance"
    # 双向：退/近用 invert
    assert by_source["p1"].invert is False and by_source["p3"].invert is True
    assert by_source["p2"].invert is False and by_source["p4"].invert is True
    # 变焦 clamp 12..300mm，对焦 0.1..100m
    assert (by_source["p1"].clamp_min, by_source["p1"].clamp_max) == (12.0, 300.0)
    assert (by_source["p2"].clamp_min, by_source["p2"].clamp_max) == (0.1, 100.0)


def test_default_mapping_covers_sticks_triggers_shoulders():
    channels = {e.channel for e in DEFAULT_CONTROLLER_MAPPING}
    assert {"x", "y", "pan", "tilt", "z", "roll"} <= channels
    # LT/RT 都绑 z（双向高度），与用户实际用法一致
    z_sources = {e.source for e in DEFAULT_CONTROLLER_MAPPING if e.channel == "z"}
    assert z_sources == {"lefttrigger", "righttrigger"}
    assert all(e.mode == "rate" for e in DEFAULT_CONTROLLER_MAPPING)
```

- [ ] **Step 2: 运行确认失败**

Run: `pytest tests/test_default_controller_mapping.py -q`
Expected: FAIL — `ImportError: cannot import name 'DEFAULT_CONTROLLER_MAPPING'`

- [ ] **Step 3: 实现**

在 `src/tracksim/config.py` 的 `ControllerCfg` 类定义之后插入：

```python
# 内置默认手柄映射：仅当 config.controller.mapping 为空时启用（见 factory.resolve_controller_mapping）。
# scale/clamp 为「实测手感后微调」的起点值；正负号是初始猜测，全可配。
# 拨片：上排 P1/P3 -> 变焦（focal_length），下排 P2/P4 -> 对焦（focus_distance），各管一个方向。
DEFAULT_CONTROLLER_MAPPING: list[ControllerMappingEntry] = [
    ControllerMappingEntry(channel="x", source="leftx", mode="rate", scale=1.0, deadzone=0.1, clamp_min=-10.0, clamp_max=10.0),
    ControllerMappingEntry(channel="y", source="lefty", mode="rate", scale=1.0, invert=True, deadzone=0.1, clamp_min=-10.0, clamp_max=10.0),
    ControllerMappingEntry(channel="pan", source="rightx", mode="rate", scale=60.0, deadzone=0.1),
    ControllerMappingEntry(channel="tilt", source="righty", mode="rate", scale=60.0, invert=True, deadzone=0.1, clamp_min=-90.0, clamp_max=90.0),
    ControllerMappingEntry(channel="z", source="lefttrigger", mode="rate", scale=1.0, invert=True, deadzone=0.05, clamp_min=0.0, clamp_max=10.0),
    ControllerMappingEntry(channel="z", source="righttrigger", mode="rate", scale=1.0, deadzone=0.05, clamp_min=0.0, clamp_max=10.0),
    ControllerMappingEntry(channel="roll", source="leftshoulder", mode="rate", scale=30.0, invert=True, clamp_min=-30.0, clamp_max=30.0),
    ControllerMappingEntry(channel="roll", source="rightshoulder", mode="rate", scale=30.0, clamp_min=-30.0, clamp_max=30.0),
    ControllerMappingEntry(channel="focal_length", source="p1", mode="rate", scale=50.0, clamp_min=12.0, clamp_max=300.0),
    ControllerMappingEntry(channel="focal_length", source="p3", mode="rate", scale=50.0, invert=True, clamp_min=12.0, clamp_max=300.0),
    ControllerMappingEntry(channel="focus_distance", source="p2", mode="rate", scale=1.0, clamp_min=0.1, clamp_max=100.0),
    ControllerMappingEntry(channel="focus_distance", source="p4", mode="rate", scale=1.0, invert=True, clamp_min=0.1, clamp_max=100.0),
]
```

- [ ] **Step 4: 运行确认通过**

Run: `pytest tests/test_default_controller_mapping.py -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tracksim/config.py tests/test_default_controller_mapping.py
git commit -m "feat: add built-in DEFAULT_CONTROLLER_MAPPING (paddles=zoom/focus)"
```

---

## Task 6: `resolve_controller_mapping`（空配置 → 默认映射）

**Files:**
- Modify: `src/tracksim/cli/commands/factory.py`（imports + 新函数）
- Test: `tests/test_resolve_controller_mapping.py`

- [ ] **Step 1: 写失败测试**

```python
# tests/test_resolve_controller_mapping.py
from tracksim.cli.commands.factory import resolve_controller_mapping
from tracksim.config import (
    Config,
    ControllerCfg,
    ControllerMappingEntry,
    DEFAULT_CONTROLLER_MAPPING,
)


def test_empty_mapping_resolves_to_default():
    resolved = resolve_controller_mapping(Config())
    assert [e.source for e in resolved] == [e.source for e in DEFAULT_CONTROLLER_MAPPING]


def test_nonempty_mapping_used_verbatim():
    entry = ControllerMappingEntry(channel="pan", source="rightx")
    cfg = Config(controller=ControllerCfg(mapping=[entry]))
    resolved = resolve_controller_mapping(cfg)
    assert len(resolved) == 1
    assert resolved[0].source == "rightx"
```

- [ ] **Step 2: 运行确认失败**

Run: `pytest tests/test_resolve_controller_mapping.py -q`
Expected: FAIL — `ImportError: cannot import name 'resolve_controller_mapping'`

- [ ] **Step 3: 实现**

在 `src/tracksim/cli/commands/factory.py` 顶部，把

```python
from tracksim.config import Config
```

改为

```python
from tracksim.config import Config, ControllerMappingEntry, DEFAULT_CONTROLLER_MAPPING
```

在文件末尾追加：

```python
def resolve_controller_mapping(config: Config) -> list[ControllerMappingEntry]:
    """返回用户 mapping；为空时回退到内置默认映射。"""
    if config.controller.mapping:
        return list(config.controller.mapping)
    return list(DEFAULT_CONTROLLER_MAPPING)
```

- [ ] **Step 4: 运行确认通过**

Run: `pytest tests/test_resolve_controller_mapping.py -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tracksim/cli/commands/factory.py tests/test_resolve_controller_mapping.py
git commit -m "feat: resolve_controller_mapping falls back to default when unset"
```

---

## Task 7: `check_controller_mapping`（纯函数，返回问题列表）

**Files:**
- Modify: `src/tracksim/cli/commands/factory.py`（imports + 新函数）
- Test: `tests/test_check_controller_mapping.py`

- [ ] **Step 1: 写失败测试**

```python
# tests/test_check_controller_mapping.py
from tracksim.cli.commands.factory import check_controller_mapping
from tracksim.config import ControllerMappingEntry


def test_clean_mapping_has_no_problems():
    m = [ControllerMappingEntry(channel="focal_length", source="p1", mode="rate")]
    assert check_controller_mapping(m) == []


def test_unknown_channel_flagged():
    probs = check_controller_mapping([ControllerMappingEntry(channel="zoomzoom", source="p1")])
    assert len(probs) == 1 and "channel" in probs[0]


def test_unknown_source_flagged():
    probs = check_controller_mapping([ControllerMappingEntry(channel="pan", source="P1")])
    assert len(probs) == 1 and "source" in probs[0]


def test_unknown_mode_flagged():
    probs = check_controller_mapping([ControllerMappingEntry(channel="pan", source="rightx", mode="ratee")])
    assert any("mode" in p for p in probs)


def test_unknown_modifier_flagged():
    probs = check_controller_mapping([ControllerMappingEntry(channel="pan", source="rightx", modifier="nope")])
    assert any("modifier" in p for p in probs)


def test_default_mapping_is_clean():
    from tracksim.config import DEFAULT_CONTROLLER_MAPPING
    assert check_controller_mapping(DEFAULT_CONTROLLER_MAPPING) == []
```

- [ ] **Step 2: 运行确认失败**

Run: `pytest tests/test_check_controller_mapping.py -q`
Expected: FAIL — `ImportError: cannot import name 'check_controller_mapping'`

- [ ] **Step 3: 实现**

在 `src/tracksim/cli/commands/factory.py` 顶部补充导入（与现有 import 行并列）：

```python
from tracksim.domain.pose import CameraPose, VALID_POSE_CHANNELS
from tracksim.ports.controller_input import CONTROLLER_BUTTONS, CONTROLLER_SOURCES
```

（注意：`from tracksim.domain.pose import CameraPose` 原本已存在，改为上面这行合并导入 `VALID_POSE_CHANNELS`。）

在文件中（建议紧接 `resolve_controller_mapping` 之后）追加常量与函数：

```python
_VALID_MAPPING_MODES = frozenset({"rate", "absolute"})


def check_controller_mapping(mapping) -> list[str]:
    """返回 mapping 的问题描述列表（空 == 干净）。本函数永不抛异常。

    被 `config validate` 用作严格校验（-> 报错），被控制器运行路径用作宽松检查（-> 警告）。
    """
    problems: list[str] = []
    for i, entry in enumerate(mapping):
        if entry.channel not in VALID_POSE_CHANNELS:
            problems.append(
                f"mapping[{i}]: unknown channel {entry.channel!r} "
                f"(allowed: {sorted(VALID_POSE_CHANNELS)})"
            )
        if entry.source not in CONTROLLER_SOURCES:
            problems.append(
                f"mapping[{i}]: unknown source {entry.source!r} "
                f"(allowed: {sorted(CONTROLLER_SOURCES)})"
            )
        if entry.mode not in _VALID_MAPPING_MODES:
            problems.append(
                f"mapping[{i}]: unknown mode {entry.mode!r} (allowed: ['absolute', 'rate'])"
            )
        modifier = getattr(entry, "modifier", None)
        if modifier is not None and modifier not in CONTROLLER_BUTTONS:
            problems.append(
                f"mapping[{i}]: unknown modifier {modifier!r} "
                f"(allowed: {sorted(CONTROLLER_BUTTONS)})"
            )
    return problems
```

- [ ] **Step 4: 运行确认通过**

Run: `pytest tests/test_check_controller_mapping.py -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tracksim/cli/commands/factory.py tests/test_check_controller_mapping.py
git commit -m "feat: check_controller_mapping returns problems without raising"
```

---

## Task 8: `config validate` 严格校验 mapping

**Files:**
- Modify: `src/tracksim/cli/commands/config_cmd.py`（import + `validate()`）
- Test: `tests/test_config_validate_mapping.py`

- [ ] **Step 1: 写失败测试**

```python
# tests/test_config_validate_mapping.py
import pytest

from tracksim.cli.commands import config_cmd
from tracksim.config import Config, ControllerCfg, ControllerMappingEntry
from tracksim.domain.errors import ConfigError


def test_validate_rejects_bad_mapping():
    cfg = Config(controller=ControllerCfg(
        mapping=[ControllerMappingEntry(channel="nope", source="p1")]
    ))
    with pytest.raises(ConfigError) as exc:
        config_cmd.validate(cfg)
    assert exc.value.exit_code == 3
    assert "problems" in exc.value.details


def test_validate_accepts_clean_mapping():
    cfg = Config(controller=ControllerCfg(
        mapping=[ControllerMappingEntry(channel="focal_length", source="p1")]
    ))
    _op, data = config_cmd.validate(cfg)
    assert data["valid"] is True


def test_validate_accepts_empty_mapping():
    _op, data = config_cmd.validate(Config())
    assert data["valid"] is True
```

- [ ] **Step 2: 运行确认失败**

Run: `pytest tests/test_config_validate_mapping.py -q`
Expected: FAIL — `test_validate_rejects_bad_mapping` 不抛 `ConfigError`（当前 validate 不查 mapping）

- [ ] **Step 3: 实现**

在 `src/tracksim/cli/commands/config_cmd.py` 顶部，把

```python
from tracksim.cli.commands.factory import validate_config_enums
```

改为

```python
from tracksim.cli.commands.factory import check_controller_mapping, validate_config_enums
```

把 `validate()` 函数体改为：

```python
def validate(config: Config) -> tuple[str, dict[str, Any]]:
    validate_config_enums(config)
    problems = check_controller_mapping(config.controller.mapping)
    if problems:
        raise ConfigError("invalid controller mapping", details={"problems": problems})
    return "config.validate", {"valid": True}
```

- [ ] **Step 4: 运行确认通过**

Run: `pytest tests/test_config_validate_mapping.py -q`
Expected: PASS

- [ ] **Step 5: 回归既有 config 校验测试**

Run: `pytest tests/test_fix25_config_validate_enums.py tests/test_fix12_config_enum_validation.py -q`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/tracksim/cli/commands/config_cmd.py tests/test_config_validate_mapping.py
git commit -m "feat: config validate rejects unknown mapping channel/source/mode"
```

---

## Task 9: 运行时警告（不中断）+ main 接线默认映射

**Files:**
- Modify: `src/tracksim/cli/commands/factory.py`（新增 `warn_controller_mapping`）
- Modify: `src/tracksim/cli/main.py`（controller 分支，第 356 行）
- Test: `tests/test_warn_controller_mapping.py`、`tests/sources/test_controller_bad_entry_noop.py`

- [ ] **Step 1: 写失败测试**

```python
# tests/test_warn_controller_mapping.py
import logging

from tracksim.cli.commands.factory import warn_controller_mapping
from tracksim.config import ControllerMappingEntry


def test_warn_logs_problems_without_raising(caplog):
    m = [ControllerMappingEntry(channel="nope", source="alsobad")]
    with caplog.at_level(logging.WARNING, logger="tracksim"):
        warn_controller_mapping(m, logging.getLogger("tracksim"))
    text = " ".join(r.message for r in caplog.records)
    assert "channel" in text and "source" in text


def test_warn_clean_mapping_logs_nothing(caplog):
    m = [ControllerMappingEntry(channel="pan", source="rightx")]
    with caplog.at_level(logging.WARNING, logger="tracksim"):
        warn_controller_mapping(m, logging.getLogger("tracksim"))
    assert caplog.records == []
```

```python
# tests/sources/test_controller_bad_entry_noop.py
from dataclasses import dataclass

import pytest

from tracksim.ports.controller_input import ControllerState
from tracksim.sources.controller import ControllerPoseSource


@dataclass
class MapEntry:
    channel: str
    source: str
    mode: str = "rate"
    scale: float = 1.0
    deadzone: float = 0.0
    invert: bool = False
    clamp_min: float | None = None
    clamp_max: float | None = None


class FakeControllerInput:
    def __init__(self, states):
        self._states = states
        self._i = 0

    def list_devices(self):
        return []

    def open(self, index):
        return None

    def poll(self):
        s = self._states[min(self._i, len(self._states) - 1)]
        self._i += 1
        return s

    def close(self):
        return None


class StubClock:
    def now(self):
        return 0.0

    def sleep(self, seconds):
        return None


def test_bad_mapping_entry_is_harmless_noop_alongside_good_entry():
    # 防回归 finding 2：坏条目在运行时不得中断，且不影响合法条目。
    states = [ControllerState(axes={"rightx": 1.0}, buttons={}, connected=True)]
    mapping = [
        MapEntry(channel="bogus", source="alsobad", scale=10.0),  # 坏条目
        MapEntry(channel="pan", source="rightx", scale=10.0),     # 合法条目
    ]
    src = ControllerPoseSource(FakeControllerInput(states), mapping, StubClock())
    pose = src.next(0.1)  # 不得抛异常
    assert pose.pan == pytest.approx(1.0)  # 合法条目照常工作
```

- [ ] **Step 2: 运行确认失败**

Run: `pytest tests/test_warn_controller_mapping.py tests/sources/test_controller_bad_entry_noop.py -q`
Expected: FAIL — `ImportError: cannot import name 'warn_controller_mapping'`

- [ ] **Step 3: 实现 `warn_controller_mapping`**

在 `src/tracksim/cli/commands/factory.py` 末尾（`check_controller_mapping` 之后）追加：

```python
def warn_controller_mapping(mapping, log) -> None:
    """把 mapping 的每条问题作为 warning 记录；永不抛异常（控制器运行路径用）。"""
    for problem in check_controller_mapping(mapping):
        log.warning("controller mapping: %s", problem)
```

- [ ] **Step 4: 接线 main.py controller 分支**

在 `src/tracksim/cli/main.py` 中，把第 356 行

```python
            source = ControllerPoseSource(ci, config.controller.mapping, clock)
```

替换为：

```python
            mapping = factory.resolve_controller_mapping(config)
            factory.warn_controller_mapping(mapping, _LOG)
            source = ControllerPoseSource(ci, mapping, clock)
```

（`factory` 与 `_LOG` 在 main.py 已可用，无需新增 import。）

- [ ] **Step 5: 运行确认通过**

Run: `pytest tests/test_warn_controller_mapping.py tests/sources/test_controller_bad_entry_noop.py -q`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/tracksim/cli/commands/factory.py src/tracksim/cli/main.py \
        tests/test_warn_controller_mapping.py tests/sources/test_controller_bad_entry_noop.py
git commit -m "feat: controller run uses default mapping + warns on bad entries"
```

---

## Task 10: 文档（拨片接线流程 + §13 标记）

**Files:**
- Modify: `docs/tracksim-CLI-运行流程.md`（§7 手柄，约 346–369 行后）
- Modify: `docs/superpowers/specs/2026-06-02-tracksim-design.md`（§13，约第 195 行）
- 无自动化测试（纯文档）

- [ ] **Step 1: 在 `docs/tracksim-CLI-运行流程.md` 的 `### 实时监控手柄输入` 小节之后、`## 8. 工具自描述` 之前，插入新小节**

```markdown
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

​```toml
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
​```

> mapping 里 `channel`/`source`/`mode` 拼错时：`tracksim config validate` 会报 exit 3；`run --source controller` 则在 stderr 警告并跳过该条、继续运行（不中断）。
```

（注意：把上面示例中的全角零宽字符 `​` 还原为标准三反引号围栏——此处仅为在本计划内转义嵌套代码块。）

- [ ] **Step 2: 在 `docs/superpowers/specs/2026-06-02-tracksim-design.md` 第 195 行，把**

```markdown
3. **手柄默认映射**：左摇杆 XY 平移、右摇杆 pan/tilt、扳机 zoom/focus、肩键 roll、摇杆控速率积分——实测手感后微调；全可配。
```

**改为**

```markdown
3. **手柄默认映射**：✅ 已落地（见 `specs/2026-06-03-tracksim-controller-zoom-focus-design.md`）。左摇杆 XY 平移、右摇杆 pan/tilt、LT/RT 控高度 z、肩键 roll、Elite 上排拨片变焦、下排拨片对焦——scale/clamp 实测手感后微调；全可配。
```

- [ ] **Step 3: Commit**

```bash
git add docs/tracksim-CLI-运行流程.md docs/superpowers/specs/2026-06-02-tracksim-design.md
git commit -m "docs: paddle zoom/focus wiring + mark §13 default mapping resolved"
```

---

## Task 11: 全量回归 + 收尾

**Files:** 无（验证）

- [ ] **Step 1: 全量测试**

Run: `pytest -q`
Expected: PASS（无 SDL 时 `pytest.importorskip("sdl3")` 用例自动跳过）。若出现因新增拨片导致的其它按键集合断言失败，定位并更新该断言后重跑。

- [ ] **Step 2: 冒烟：默认映射 dry-run 不报错**

Run: `tracksim run --source controller --dry-run -o json`
Expected: 输出单个 success envelope（`dry_run_plan`），exit 0（dry-run 不打开 SDL）。

- [ ] **Step 3: 冒烟：坏 mapping 的两档行为**

Run: 构造一个含坏 source 的临时 config（`/tmp/bad.toml`：一条 `source = "P1"`），执行
`tracksim config validate --config /tmp/bad.toml -o json`
Expected: exit 3，envelope `error.details.problems` 含该条问题。

- [ ] **Step 4: 真机验证清单（交给用户，无法自动化）**

- USB-C 有线连接，Xbox Accessories app 清空 4 拨片指派。
- `tracksim controllers monitor --rate 30 --samples 100 -o ndjson`，逐个按 P1–P4，确认 `buttons.p1..p4` 独立 toggle 且与物理位置一致。
- 蓝牙再试一次，记录是否上报；若不上报，文档保持「USB-C 优先」结论。

---

## Self-Review（计划对照 spec）

**Spec 覆盖：**
- §3.1 SDL 读拨片 → Task 3 ✓
- §3.2 source 词汇表常量 → Task 2 ✓
- §3.3 默认映射 → Task 5（常量）+ Task 6（空配置回退）+ Task 9（main 接线）✓
- §3.4 rate 播种 → Task 4 ✓
- §3.5 校验两档（config validate 报错 / 运行时警告）→ Task 7（纯函数）+ Task 8（严格档）+ Task 9（宽松档）✓
- §3.6 config 片段 → Task 10 文档 ✓
- §5 测试计划 1–8 → Task 3/5/4(seed)/4/7/8/9/11 逐条对应 ✓
- §2.3 真机验证 → Task 10 文档 + Task 11 Step 4 清单 ✓

**占位符扫描：** 无 TBD/TODO；每个代码步骤含完整代码与确切命令。

**类型/命名一致性：** `VALID_POSE_CHANNELS`(Task1)、`CONTROLLER_AXES/BUTTONS/SOURCES`(Task2)、`DEFAULT_CONTROLLER_MAPPING`(Task5)、`resolve_controller_mapping`(Task6)、`check_controller_mapping`(Task7)、`warn_controller_mapping`(Task9) 跨 task 引用名称一致；`p1..p4` ↔ SDL 常量对应在 Task2/3/5/10 一致（p1=RIGHT_PADDLE1 右上，p2=RIGHT_PADDLE2 右下，p3=LEFT_PADDLE1 左上，p4=LEFT_PADDLE2 左下）。
