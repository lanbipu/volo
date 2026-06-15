# tracksim Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 tracksim 第一阶段 CLI —— 一个跨平台（Mac/Windows）的追踪信号模拟器，由 Xbox 手柄或脚本/固定位姿驱动，按 FreeD 与 OpenTrackIO 两种协议经 UDP/串口发送给 Unreal Engine、Disguise 等平台。

**Architecture:** 严格遵循 `../../CLI_DESIGN_SPEC.md`（v3.0）contract-first 分层：与适配器无关的 Core SDK（domain `CameraPose`；Ports：PoseSource / Emitter / Transport / Clock / ControllerInput；Simulator 服务）所有 IO 依赖注入；一份 Contract Manifest；强制的 CLI 适配器。手柄输入用 SDL3/PySDL3 置于 Port 之后；OpenTrackIO 的 OTrk 头/分段/Fletcher-16 移植自 camdkit 参考实现；FreeD D1 编码器照 `../../docs/freed-doc.md` Appendix A/B 从零实现。

**Tech Stack:** Python 3.11、Pydantic v2、PySDL3（SDL3）、pyserial、cbor2、pyyaml；测试用 pytest + jsonschema。

---

## 仓库与路径

- 仓库根 = tracksim git 仓库（`/Users/bip.lan/AIWorkspace/vp/calibration/tracksim`，已 `git init`，分支 main）。下文所有路径相对仓库根。
- 包：`src/tracksim/`（src layout）；测试：`tests/`。测试运行：`python -m pytest`。
- 任务共 **46 个**，已按执行（依赖）顺序编号 1–46。

## 文件结构（创建后形态）

```
src/tracksim/
├── __init__.py            # __version__
├── __main__.py            # python -m tracksim
├── checksum.py            # fletcher16
├── envelope.py            # 成功/错误 envelope + exit code 常量
├── config.py              # Config 模型 + load_config (toml/yaml/json)
├── manifest.py            # build_manifest()
├── simulator.py           # SimEvent + Simulator 服务
├── domain/                # pose.py (CameraPose), errors.py
├── ports/                 # pose_source/emitter/transport/clock/controller_input (Protocol)
├── transports/            # udp.py, serial_port.py
├── emitters/              # freed.py (D1), opentrackio.py (OTrk)
├── sources/               # static.py, scripted.py, controller.py
├── infra/                 # clock.py (WallClock/FakeClock), sdl_controller.py (唯一 import sdl3)
└── cli/                   # main.py, render.py, commands/*
tests/                     # 各模块单测 + tests/fakes.py + CLI 一致性测试
```

## 执行须知

- 每个任务严格 TDD：写失败测试 → 跑（确认失败）→ 最小实现 → 跑（通过）→ 提交。
- **少数任务是"特征锁定测试"**（标注"无需新增代码"，因实现已在前序任务完成）：这类测试首次运行即应为绿，按任务说明确认契约后直接提交即可，无需强求先红。
- Task 1 的 `git init` 对已存在仓库幂等（仓库已初始化，可跳过该子步骤）。
- `src/tracksim/infra/sdl_controller.py` 是**唯一**允许 `import sdl3` 的模块；无手柄设备/SDL3 库时相关测试自动 skip，功能由 Section 5 的 FakeControllerInput 覆盖。
- **实现期需对照目标平台实测确认**（见设计文档 §13）：FreeD 缩放常量（对照 UE Live Link FreeD 解码器）、OpenTrackIO 走组播还是 unicast、手柄默认映射手感。config 均提供兜底开关。

## 修订记录

- **2026-06-02 (rev. adversarial-review)**：依据 Codex 对抗式审查（4 条 finding 均经独立验证为 CONFIRMED）修订：
  - **F1**（Task 6/9/45/46）：全局 flag 改为 root + 每个 subparser 双挂（subparser 副本用 `argparse.SUPPRESS`），使 `--output`/`--dry-run` 等在子命令前后均生效；补 build_parser 单测与 conformance。
  - **F2**（Task 43/44/45/46）：`run`/`controllers monitor` 按输出格式分流——仅 `ndjson` 流式，`json`/`text` 输出单个 summary envelope（`run_stream`/`monitor_stream` 接受 `writer=None`）；`run` 的 `--duration` 接线为 `max_ticks` 使其有界；补「`run --output json` 单对象」「`monitor --output json` 单错误对象」conformance。
  - **F3**（Task 6/9/40/45）：`config init` 覆盖已有文件需全局 `--yes`（映射为 `force`），否则抛新增的 `ConflictError`(exit 6，对齐 §5)；dry-run 区分 create/overwrite；补不覆盖/强制覆盖测试。
  - **F4**（Task 22/42）：`ScriptedPoseSource.__init__` 增加 `rate`/`clock`（与 `StaticPoseSource` 一致、与 factory 调用匹配），消除 `run --source script` 的 `TypeError`；补构造测试。
- **2026-06-02 (rev. adversarial-review 2)**：第二轮 Codex 对抗式审查（4 条 finding 均经独立验证为 CONFIRMED，F6 的正确语义由 camdkit 参考实现敲定）修订：
  - **F5**（Task 42/45/46）：`run --source controller` 此前无人接线、落到 factory 的 `UnsupportedProtocolError`（核心手柄功能不可达）。改为在 `_dispatch` run 分支特判：构造 `SDLControllerInput` + 打开设备 + `ControllerPoseSource(config.controller.mapping, clock)`（factory 保持设备无关）；补 conformance「`run --source controller` 无手柄 → exit 10 NO_CONTROLLER（非 12）」。
  - **F6**（Task 18/20）：OTrk `sequence` 是「每包」递增（camdkit 接收端按 sequence 去重）。`build_packets` 每段递增本就正确，bug 在 `OpenTrackIOEmitter.emit` 只 `+1`；改为发送后 `+= len(packets)`，避免多段样本跨样本复用 sequence；补「两个超长样本全部分段 sequence 唯一且单调」回归测试。
  - **F7**（Task 23）：`ControllerMappingEntry.clamp_min/clamp_max` 默认 `None`，而 `next()` 无条件 `min/max` 会抛 `TypeError`；改为 `None` 用 ±inf 兜底；补「省略 clamp 不崩溃且透传」测试。
  - **F8**（Task 41）：`send_hold` 用 `int(round(duration*rate))`，银行家舍入把 0.5 帧截成 0 帧静默空发；改为 `max(1, math.ceil(...))` 并校验 `duration>0`/`rate>0`；补「亚帧正 duration 至少发 1 帧」与「非正 duration 抛错」测试。

---

### Task 1: 初始化 git 仓库与 pyproject.toml

**Files:** Create `pyproject.toml`; Test `tests/test_packaging.py`

- [ ] **Step 1: 写失败测试** — 测试 `pyproject.toml` 存在且关键打包元数据正确（name、requires-python、src layout、runtime/dev deps、console_scripts）。

```python
# tests/test_packaging.py
import tomllib
from pathlib import Path

PYPROJECT = Path(__file__).resolve().parent.parent / "pyproject.toml"


def _load():
    with PYPROJECT.open("rb") as f:
        return tomllib.load(f)


def test_pyproject_exists():
    assert PYPROJECT.is_file()


def test_project_name_and_python():
    data = _load()
    assert data["project"]["name"] == "tracksim"
    assert data["project"]["requires-python"] == ">=3.11"


def test_runtime_dependencies():
    data = _load()
    deps = data["project"]["dependencies"]
    joined = " ".join(deps)
    assert "pydantic>=2" in joined
    assert "pysdl3" in joined
    assert "pyserial" in joined
    assert "cbor2" in joined
    assert "pyyaml" in joined


def test_dev_optional_dependencies():
    data = _load()
    dev = data["project"]["optional-dependencies"]["dev"]
    joined = " ".join(dev)
    assert "pytest" in joined
    assert "jsonschema" in joined


def test_console_script_entrypoint():
    data = _load()
    scripts = data["project"]["scripts"]
    assert scripts["tracksim"] == "tracksim.cli.main:main"


def test_src_layout_package_discovery():
    data = _load()
    where = data["tool"]["setuptools"]["packages"]["find"]["where"]
    assert where == ["src"]
```

- [ ] **Step 2: 运行测试确认失败** — Run: `python -m pytest tests/test_packaging.py -v`  Expected: FAIL (`pyproject.toml` 不存在，`FileNotFoundError` / 收集错误)

- [ ] **Step 3: 最小实现** — 先 git init，再写 `pyproject.toml`（src layout，setuptools 后端）。

先执行（一次性，非测试代码）：

```bash
git init -b main /Users/bip.lan/AIWorkspace/vp/calibration/tracksim
```

```toml
# pyproject.toml
[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[project]
name = "tracksim"
version = "0.1.0"
description = "Camera tracking protocol simulator (FreeD / OpenTrackIO)"
readme = "README.md"
requires-python = ">=3.11"
dependencies = [
    "pydantic>=2",
    "pysdl3",
    "pyserial",
    "cbor2",
    "pyyaml",
]

[project.optional-dependencies]
dev = [
    "pytest",
    "jsonschema",
]

[project.scripts]
tracksim = "tracksim.cli.main:main"

[tool.setuptools.packages.find]
where = ["src"]
```

- [ ] **Step 4: 运行测试确认通过** — Run: `python -m pytest tests/test_packaging.py -v`  Expected: PASS（6 个测试全部通过）

- [ ] **Step 5: 提交**

```bash
git -C /Users/bip.lan/AIWorkspace/vp/calibration/tracksim add pyproject.toml tests/test_packaging.py
git -C /Users/bip.lan/AIWorkspace/vp/calibration/tracksim commit -m "build: add pyproject.toml with src layout and packaging metadata"
```

### Task 2: 包入口与 __version__

**Files:** Create `src/tracksim/__init__.py`, `src/tracksim/__main__.py`, `tests/__init__.py`, `tests/conftest.py`; Test `tests/test_version.py`

- [ ] **Step 1: 写失败测试** — 测试 `import tracksim` 且 `__version__ == "0.1.0"`。此测试必须在仅有 `__init__.py` 的情况下通过，不得在模块加载时 import `cli`（`cli.main` 直到 Section 8 才存在）。

```python
# tests/test_version.py
import tracksim


def test_version_constant():
    assert tracksim.__version__ == "0.1.0"


def test_version_is_string():
    assert isinstance(tracksim.__version__, str)
```

- [ ] **Step 2: 运行测试确认失败** — Run: `python -m pytest tests/test_version.py -v`  Expected: FAIL (`ModuleNotFoundError: No module named 'tracksim'`，包尚未创建/安装)

- [ ] **Step 3: 最小实现** — 创建包 `__init__.py`（只定义 `__version__`，不 import 子模块），`__main__.py`（在 `main()` 内部 lazily import `cli.main`），以及 `tests/` 的 `__init__.py` 与 `conftest.py`。

```python
# src/tracksim/__init__.py
__version__ = "0.1.0"
```

```python
# src/tracksim/__main__.py
def main() -> int:
    from tracksim.cli.main import main as cli_main

    return cli_main()


if __name__ == "__main__":
    raise SystemExit(main())
```

```python
# tests/__init__.py
```

```python
# tests/conftest.py
# tracksim is imported via the editable install (pip install -e ".[dev]").
# No sys.path manipulation here; rely on the installed package.
```

- [ ] **Step 4: 运行测试确认通过** — Run: `python -m pytest tests/test_version.py -v`  Expected: PASS（前提：Task 4 的 editable install 已执行；若尚未安装，先执行 Task 4 的安装命令再跑此测试）

- [ ] **Step 5: 提交**

```bash
git -C /Users/bip.lan/AIWorkspace/vp/calibration/tracksim add src/tracksim/__init__.py src/tracksim/__main__.py tests/__init__.py tests/conftest.py tests/test_version.py
git -C /Users/bip.lan/AIWorkspace/vp/calibration/tracksim commit -m "feat: add tracksim package entrypoint with __version__"
```

### Task 3: .gitignore、README、CHANGELOG

**Files:** Create `.gitignore`, `README.md`, `CHANGELOG.md`

- [ ] **Step 1: 写失败测试** — 测试三份脚手架文档存在，且 `README.md` 与 `CHANGELOG.md` 均提及 `contract_version 1.0`。

```python
# tests/test_docs_scaffold.py
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def test_gitignore_exists():
    assert (ROOT / ".gitignore").is_file()


def test_gitignore_covers_python():
    text = (ROOT / ".gitignore").read_text(encoding="utf-8")
    assert "__pycache__/" in text
    assert "*.egg-info/" in text


def test_readme_mentions_contract_version():
    text = (ROOT / "README.md").read_text(encoding="utf-8")
    assert "contract_version 1.0" in text


def test_changelog_mentions_contract_version():
    text = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    assert "contract_version 1.0" in text
```

- [ ] **Step 2: 运行测试确认失败** — Run: `python -m pytest tests/test_docs_scaffold.py -v`  Expected: FAIL (`.gitignore` / `README.md` / `CHANGELOG.md` 不存在，`FileNotFoundError`)

- [ ] **Step 3: 最小实现** — 写 Python `.gitignore`、README 与 CHANGELOG stub（均显式包含字符串 `contract_version 1.0`）。

```gitignore
# .gitignore
# Byte-compiled / optimized / DLL files
__pycache__/
*.py[cod]
*$py.class

# Distribution / packaging
build/
dist/
*.egg-info/
.eggs/

# Virtual environments
.venv/
venv/
env/

# Test / coverage
.pytest_cache/
.coverage
htmlcov/

# IDE / OS
.idea/
.vscode/
.DS_Store
```

```markdown
# tracksim

Camera tracking protocol simulator emitting FreeD and OpenTrackIO data over UDP / serial transports.

## Status

Early scaffolding. Implements `contract_version 1.0` (the stable CLI / envelope / protocol contract; see `SCHEMA_VERSION` and `CONTRACT_VERSION` in `tracksim.envelope`).

## Install

```bash
pip install -e ".[dev]"
```

## Usage

```bash
tracksim --help
python -m tracksim --help
```
```

```markdown
# Changelog

All notable changes to this project are documented here. This project adheres to `contract_version 1.0`.

## [Unreleased]

### Added
- Initial project scaffolding (src layout, packaging metadata, package entrypoint).
```

- [ ] **Step 4: 运行测试确认通过** — Run: `python -m pytest tests/test_docs_scaffold.py -v`  Expected: PASS（4 个测试全部通过）

- [ ] **Step 5: 提交**

```bash
git -C /Users/bip.lan/AIWorkspace/vp/calibration/tracksim add .gitignore README.md CHANGELOG.md tests/test_docs_scaffold.py
git -C /Users/bip.lan/AIWorkspace/vp/calibration/tracksim commit -m "docs: add gitignore, README and CHANGELOG stubs"
```

### Task 4: editable 安装与版本导入验证

**Files:** (无新增源码；执行安装并验证)

- [ ] **Step 1: 写失败测试** — 测试已安装的 `tracksim` 暴露 `__file__` 且其分发元数据版本为 `0.1.0`（验证 editable install 生效，而非仅靠 sys.path 偶然命中）。

```python
# tests/test_install_smoke.py
from importlib.metadata import version

import tracksim


def test_package_importable_from_install():
    assert tracksim.__file__ is not None
    assert tracksim.__file__.endswith("__init__.py")


def test_distribution_version_matches():
    assert version("tracksim") == "0.1.0"
    assert version("tracksim") == tracksim.__version__
```

- [ ] **Step 2: 运行测试确认失败** — Run: `python -m pytest tests/test_install_smoke.py -v`  Expected: FAIL（`tracksim` 未安装时 `importlib.metadata.version("tracksim")` 抛 `PackageNotFoundError`）

- [ ] **Step 3: 最小实现** — 执行 editable 安装（含 dev extras），再做命令行级别的版本导入自检。

```bash
pip install -e "/Users/bip.lan/AIWorkspace/vp/calibration/tracksim[dev]"
python -c "import tracksim; print(tracksim.__version__)"
```

预期 `python -c` 输出 `0.1.0`。

- [ ] **Step 4: 运行测试确认通过** — Run: `python -m pytest tests/test_install_smoke.py -v`  Expected: PASS（2 个测试通过；`version("tracksim")` 返回 `0.1.0`）。同时回归全部脚手架测试：`python -m pytest tests/test_packaging.py tests/test_version.py tests/test_docs_scaffold.py tests/test_install_smoke.py -v` Expected: PASS

- [ ] **Step 5: 提交**

```bash
git -C /Users/bip.lan/AIWorkspace/vp/calibration/tracksim add tests/test_install_smoke.py
git -C /Users/bip.lan/AIWorkspace/vp/calibration/tracksim commit -m "test: add editable install smoke test for version import"
```

### Task 5: Domain `CameraPose` model

**Files:**
- Create: `src/tracksim/__init__.py`
- Create: `src/tracksim/domain/__init__.py`
- Create: `src/tracksim/domain/pose.py`
- Test: `tests/test_pose.py`

- [ ] **Step 1: 写失败测试**

```python
# tests/test_pose.py
from tracksim.domain.pose import CameraPose


def test_camera_pose_defaults():
    p = CameraPose()
    assert p.pan == 0.0
    assert p.tilt == 0.0
    assert p.roll == 0.0
    assert p.x == 0.0
    assert p.y == 0.0
    assert p.z == 0.0
    assert p.focal_length == 35.0
    assert p.focus_distance == 3.0
    assert p.iris is None
    assert p.entrance_pupil is None
    assert p.frame == 0
    assert p.timestamp == 0.0
    assert p.rate == 60.0


def test_camera_pose_explicit_values():
    p = CameraPose(
        pan=10.0, tilt=-5.0, roll=1.5,
        x=1.0, y=2.0, z=3.0,
        focal_length=50.0, focus_distance=4.2,
        iris=2.8, entrance_pupil=0.05,
        frame=12, timestamp=0.2, rate=30.0,
    )
    assert p.pan == 10.0
    assert p.tilt == -5.0
    assert p.roll == 1.5
    assert p.x == 1.0 and p.y == 2.0 and p.z == 3.0
    assert p.focal_length == 50.0
    assert p.focus_distance == 4.2
    assert p.iris == 2.8
    assert p.entrance_pupil == 0.05
    assert p.frame == 12
    assert p.timestamp == 0.2
    assert p.rate == 30.0


def test_camera_pose_is_pydantic_model():
    p = CameraPose(pan=3.0)
    dumped = p.model_dump()
    assert dumped["pan"] == 3.0
    assert "focal_length" in dumped
    reloaded = CameraPose.model_validate(dumped)
    assert reloaded == p
```

- [ ] **Step 2: 运行测试确认失败** — Run: `python -m pytest tests/test_pose.py -v`  Expected: FAIL (`ModuleNotFoundError: No module named 'tracksim.domain.pose'`)

- [ ] **Step 3: 最小实现**

```python
# src/tracksim/__init__.py
```

```python
# src/tracksim/domain/__init__.py
```

```python
# src/tracksim/domain/pose.py
from __future__ import annotations

from pydantic import BaseModel


class CameraPose(BaseModel):
    """Canonical physical camera pose shared by all protocol encoders."""

    pan: float = 0.0
    tilt: float = 0.0
    roll: float = 0.0
    x: float = 0.0
    y: float = 0.0
    z: float = 0.0
    focal_length: float = 35.0
    focus_distance: float = 3.0
    iris: float | None = None
    entrance_pupil: float | None = None
    frame: int = 0
    timestamp: float = 0.0
    rate: float = 60.0
```

- [ ] **Step 4: 运行测试确认通过** — Run: `python -m pytest tests/test_pose.py -v`  Expected: PASS (3 passed)

- [ ] **Step 5: 提交**

```bash
git add src/tracksim/__init__.py src/tracksim/domain/__init__.py src/tracksim/domain/pose.py tests/test_pose.py
git commit -m "feat(domain): add canonical CameraPose model"
```

---

### Task 6: Domain error hierarchy

**Files:**
- Create: `src/tracksim/domain/errors.py`
- Test: `tests/test_errors.py`

- [ ] **Step 1: 写失败测试**

```python
# tests/test_errors.py
import pytest

from tracksim.domain.errors import (
    TracksimError,
    ConfigError,
    ConflictError,
    NoControllerError,
    TransportError,
    UnsupportedProtocolError,
    InvalidTrajectoryError,
)


def test_base_error_attributes():
    err = TracksimError("boom")
    assert err.code == "INTERNAL"
    assert err.exit_code == 1
    assert err.retryable is False
    assert err.message == "boom"
    assert err.details == {}
    assert isinstance(err, Exception)


def test_base_error_details_passthrough():
    err = TracksimError("boom", details={"k": "v"})
    assert err.details == {"k": "v"}


def test_base_error_default_details_isolated():
    a = TracksimError("a")
    b = TracksimError("b")
    a.details["x"] = 1
    assert b.details == {}


@pytest.mark.parametrize(
    "cls, code, exit_code, retryable",
    [
        (ConfigError, "CONFIG_ERROR", 3, False),
        (ConflictError, "CONFLICT", 6, False),
        (NoControllerError, "NO_CONTROLLER", 10, False),
        (TransportError, "TRANSPORT_SEND_FAILED", 11, True),
        (UnsupportedProtocolError, "UNSUPPORTED_PROTOCOL", 12, False),
        (InvalidTrajectoryError, "INVALID_TRAJECTORY", 13, False),
    ],
)
def test_subclass_semantics(cls, code, exit_code, retryable):
    err = cls("msg")
    assert err.code == code
    assert err.exit_code == exit_code
    assert err.retryable is retryable
    assert err.message == "msg"
    assert isinstance(err, TracksimError)


def test_subclass_details():
    err = TransportError("send failed", details={"target": "239.135.1.1:55555"})
    assert err.details == {"target": "239.135.1.1:55555"}
```

- [ ] **Step 2: 运行测试确认失败** — Run: `python -m pytest tests/test_errors.py -v`  Expected: FAIL (`ModuleNotFoundError: No module named 'tracksim.domain.errors'`)

- [ ] **Step 3: 最小实现**

```python
# src/tracksim/domain/errors.py
from __future__ import annotations

from typing import Any


class TracksimError(Exception):
    """Base class for all tracksim domain errors."""

    code: str = "INTERNAL"
    exit_code: int = 1
    retryable: bool = False

    def __init__(self, message: str, *, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.details: dict[str, Any] = details if details is not None else {}


class ConfigError(TracksimError):
    code = "CONFIG_ERROR"
    exit_code = 3
    retryable = False


class ConflictError(TracksimError):
    code = "CONFLICT"
    exit_code = 6
    retryable = False


class NoControllerError(TracksimError):
    code = "NO_CONTROLLER"
    exit_code = 10
    retryable = False


class TransportError(TracksimError):
    code = "TRANSPORT_SEND_FAILED"
    exit_code = 11
    retryable = True


class UnsupportedProtocolError(TracksimError):
    code = "UNSUPPORTED_PROTOCOL"
    exit_code = 12
    retryable = False


class InvalidTrajectoryError(TracksimError):
    code = "INVALID_TRAJECTORY"
    exit_code = 13
    retryable = False
```

- [ ] **Step 4: 运行测试确认通过** — Run: `python -m pytest tests/test_errors.py -v`  Expected: PASS (all parametrized cases + details/isolation passed)

- [ ] **Step 5: 提交**

```bash
git add src/tracksim/domain/errors.py tests/test_errors.py
git commit -m "feat(domain): add error hierarchy with code/exit_code/retryable"
```

---

### Task 7: Ports (Protocols + controller dataclasses)

**Files:**
- Create: `src/tracksim/ports/__init__.py`
- Create: `src/tracksim/ports/pose_source.py`
- Create: `src/tracksim/ports/emitter.py`
- Create: `src/tracksim/ports/transport.py`
- Create: `src/tracksim/ports/clock.py`
- Create: `src/tracksim/ports/controller_input.py`
- Test: `tests/test_ports.py`

说明：用 `typing.Protocol` 定义结构化接口；测试通过让 trivial fakes 在静态类型 `: Protocol` 注解处赋值并断言其有效，验证它们 structurally satisfy 各 Protocol（`isinstance` 仅对 `@runtime_checkable` 的 Protocol 可用，这里只对方法名集合做结构检查 + 实际调用）。

- [ ] **Step 1: 写失败测试**

```python
# tests/test_ports.py
from tracksim.domain.pose import CameraPose
from tracksim.ports.pose_source import PoseSource
from tracksim.ports.emitter import Emitter
from tracksim.ports.transport import Transport
from tracksim.ports.clock import Clock
from tracksim.ports.controller_input import (
    ControllerDevice,
    ControllerState,
    ControllerInput,
)


class FakePoseSource:
    def next(self, dt: float) -> CameraPose:
        return CameraPose(timestamp=dt)

    def close(self) -> None:
        pass


class FakeTransport:
    def __init__(self) -> None:
        self.sent: list[bytes] = []

    def send(self, data: bytes) -> None:
        self.sent.append(data)

    def close(self) -> None:
        pass


class FakeEmitter:
    name = "fake"

    def __init__(self) -> None:
        self.poses: list[CameraPose] = []

    def emit(self, pose: CameraPose) -> None:
        self.poses.append(pose)

    def close(self) -> None:
        pass


class FakeClock:
    def now(self) -> float:
        return 1.0

    def sleep(self, seconds: float) -> None:
        pass


class FakeControllerInput:
    def list_devices(self) -> list[ControllerDevice]:
        return [ControllerDevice(index=0, name="Xbox", guid="abc")]

    def open(self, index: int) -> None:
        pass

    def poll(self) -> ControllerState:
        return ControllerState()

    def close(self) -> None:
        pass


def test_fakes_satisfy_protocols():
    src: PoseSource = FakePoseSource()
    tp: Transport = FakeTransport()
    em: Emitter = FakeEmitter()
    clk: Clock = FakeClock()
    ci: ControllerInput = FakeControllerInput()

    assert isinstance(src.next(0.5), CameraPose)
    tp.send(b"x")
    assert tp.sent == [b"x"]
    em.emit(CameraPose())
    assert len(em.poses) == 1
    assert em.name == "fake"
    assert clk.now() == 1.0
    clk.sleep(0.0)
    assert ci.list_devices()[0].name == "Xbox"
    ci.open(0)
    assert isinstance(ci.poll(), ControllerState)


def test_controller_device_dataclass():
    d = ControllerDevice(index=2, name="Pad", guid="g-1")
    assert d.index == 2
    assert d.name == "Pad"
    assert d.guid == "g-1"


def test_controller_state_defaults():
    s = ControllerState()
    assert s.axes == {}
    assert s.buttons == {}
    assert s.connected is True


def test_controller_state_default_isolation():
    a = ControllerState()
    b = ControllerState()
    a.axes["leftx"] = 0.5
    a.buttons["a"] = True
    assert b.axes == {}
    assert b.buttons == {}


def test_controller_state_explicit():
    s = ControllerState(
        axes={"leftx": -0.3, "righttrigger": 0.8},
        buttons={"a": True, "start": False},
        connected=False,
    )
    assert s.axes["leftx"] == -0.3
    assert s.axes["righttrigger"] == 0.8
    assert s.buttons["a"] is True
    assert s.connected is False
```

- [ ] **Step 2: 运行测试确认失败** — Run: `python -m pytest tests/test_ports.py -v`  Expected: FAIL (`ModuleNotFoundError: No module named 'tracksim.ports.pose_source'`)

- [ ] **Step 3: 最小实现**

```python
# src/tracksim/ports/__init__.py
```

```python
# src/tracksim/ports/pose_source.py
from __future__ import annotations

from typing import Protocol

from tracksim.domain.pose import CameraPose


class PoseSource(Protocol):
    def next(self, dt: float) -> CameraPose: ...
    def close(self) -> None: ...
```

```python
# src/tracksim/ports/emitter.py
from __future__ import annotations

from typing import Protocol

from tracksim.domain.pose import CameraPose


class Emitter(Protocol):
    name: str

    def emit(self, pose: CameraPose) -> None: ...
    def close(self) -> None: ...
```

```python
# src/tracksim/ports/transport.py
from __future__ import annotations

from typing import Protocol


class Transport(Protocol):
    def send(self, data: bytes) -> None: ...
    def close(self) -> None: ...
```

```python
# src/tracksim/ports/clock.py
from __future__ import annotations

from typing import Protocol


class Clock(Protocol):
    def now(self) -> float: ...
    def sleep(self, seconds: float) -> None: ...
```

```python
# src/tracksim/ports/controller_input.py
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol


@dataclass
class ControllerDevice:
    index: int
    name: str
    guid: str


@dataclass
class ControllerState:
    # axis keys: leftx, lefty, rightx, righty in -1..1;
    #            lefttrigger, righttrigger in 0..1
    axes: dict[str, float] = field(default_factory=dict)
    # button keys: a, b, x, y, leftshoulder, rightshoulder, back, start
    buttons: dict[str, bool] = field(default_factory=dict)
    connected: bool = True


class ControllerInput(Protocol):
    def list_devices(self) -> list[ControllerDevice]: ...
    def open(self, index: int) -> None: ...
    def poll(self) -> ControllerState: ...
    def close(self) -> None: ...
```

- [ ] **Step 4: 运行测试确认通过** — Run: `python -m pytest tests/test_ports.py -v`  Expected: PASS (5 passed)

- [ ] **Step 5: 提交**

```bash
git add src/tracksim/ports/__init__.py src/tracksim/ports/pose_source.py src/tracksim/ports/emitter.py src/tracksim/ports/transport.py src/tracksim/ports/clock.py src/tracksim/ports/controller_input.py tests/test_ports.py
git commit -m "feat(ports): add PoseSource/Emitter/Transport/Clock/ControllerInput protocols"
```

---

### Task 8: Fletcher-16 checksum

**Files:**
- Create: `src/tracksim/checksum.py`
- Test: `tests/test_checksum.py`

说明：参考 `opentrackio_lib.py` 的算法 `sum1=(sum1+byte)%256; sum2=(sum2+sum1)%256; checksum=(sum2<<8)|sum1`（modulus 256，返回 2-byte big-endian）。本仓库 `fletcher16` 按 SHARED CONTRACT 返回 16-bit `int`（即 `(sum2 << 8) | sum1`，与参考 `struct.pack('!H', ...)` 的整型值一致）。测试向量手算自该参考算法。

向量推导（`b"OTrk"` = bytes `[0x4F, 0x54, 0x72, 0x6B]` = `[79, 84, 114, 107]`）：
- byte 79：sum1=79, sum2=79
- byte 84：sum1=163, sum2=242
- byte 114：sum1=277%256=21, sum2=(242+21)%256=263%256=7
- byte 107：sum1=(21+107)=128, sum2=(7+128)=135
- checksum=(135<<8)|128 = 0x8780 = 34688
另用 `b"abcde"` 校验经典向量：Fletcher-16(mod 256) = 0xC8F0 = 51440。

- [ ] **Step 1: 写失败测试**

```python
# tests/test_checksum.py
from tracksim.checksum import fletcher16


def _ref_fletcher16(data: bytes) -> int:
    sum1 = 0
    sum2 = 0
    for byte in data:
        sum1 = (sum1 + byte) % 256
        sum2 = (sum2 + sum1) % 256
    return (sum2 << 8) | sum1


def test_returns_int():
    assert isinstance(fletcher16(b"OTrk"), int)


def test_empty():
    assert fletcher16(b"") == 0


def test_otrk_vector():
    # derived by hand from camdkit opentrackio_lib.fletcher16 algorithm
    assert fletcher16(b"OTrk") == 0x8780


def test_classic_abcde_vector():
    assert fletcher16(b"abcde") == 0xC8F0


def test_matches_reference_algorithm():
    for data in [b"", b"\x00", b"\xff" * 17, bytes(range(64)), b"hello world"]:
        assert fletcher16(data) == _ref_fletcher16(data)


def test_result_in_16bit_range():
    val = fletcher16(bytes(range(256)) * 4)
    assert 0 <= val <= 0xFFFF
```

- [ ] **Step 2: 运行测试确认失败** — Run: `python -m pytest tests/test_checksum.py -v`  Expected: FAIL (`ModuleNotFoundError: No module named 'tracksim.checksum'`)

- [ ] **Step 3: 最小实现**

```python
# src/tracksim/checksum.py
from __future__ import annotations


def fletcher16(data: bytes) -> int:
    """16-bit Fletcher checksum (modulus 256).

    Algorithm copied from camdkit opentrackio_lib.fletcher16; returns the
    16-bit value (sum2 << 8) | sum1 as an int.
    """
    sum1 = 0
    sum2 = 0
    for byte in data:
        sum1 = (sum1 + byte) % 256
        sum2 = (sum2 + sum1) % 256
    return (sum2 << 8) | sum1
```

- [ ] **Step 4: 运行测试确认通过** — Run: `python -m pytest tests/test_checksum.py -v`  Expected: PASS (6 passed)

- [ ] **Step 5: 提交**

```bash
git add src/tracksim/checksum.py tests/test_checksum.py
git commit -m "feat(checksum): add fletcher16 per camdkit reference"
```

---

### Task 9: Envelope constants + builders

**Files:**
- Create: `src/tracksim/envelope.py`
- Test: `tests/test_envelope.py`

说明：success/error envelope 形状照 CLI_DESIGN_SPEC §4.1/§4.2；exit code 常量照 spec §5 + design §7。

- [ ] **Step 1: 写失败测试**

```python
# tests/test_envelope.py
from tracksim import envelope as env


def test_version_constants():
    assert env.SCHEMA_VERSION == "1.0"
    assert env.CONTRACT_VERSION == "1.0"


def test_exit_code_constants():
    assert env.EXIT_OK == 0
    assert env.EXIT_USAGE == 2
    assert env.EXIT_CONFIG == 3
    assert env.EXIT_CONFLICT == 6
    assert env.EXIT_TIMEOUT == 7
    assert env.EXIT_EXTERNAL == 8
    assert env.EXIT_NO_CONTROLLER == 10
    assert env.EXIT_TRANSPORT == 11
    assert env.EXIT_UNSUPPORTED == 12
    assert env.EXIT_INVALID_INPUT == 13
    assert env.EXIT_SIGINT == 130


def test_success_envelope_shape():
    out = env.success_envelope(
        "config.show",
        {"k": "v"},
        request_id="req-1",
        duration_ms=42,
        timestamp="2026-06-02T00:00:00Z",
    )
    assert out == {
        "schema_version": "1.0",
        "status": "ok",
        "operation_id": "config.show",
        "data": {"k": "v"},
        "meta": {
            "request_id": "req-1",
            "duration_ms": 42,
            "timestamp": "2026-06-02T00:00:00Z",
        },
    }


def test_error_envelope_shape():
    out = env.error_envelope(
        "sim.send",
        code="TRANSPORT_SEND_FAILED",
        exit_code=11,
        message="send failed",
        retryable=True,
        details={"target": "239.135.1.1:55555"},
        request_id="req-2",
        duration_ms=7,
        timestamp="2026-06-02T00:00:01Z",
    )
    assert out == {
        "schema_version": "1.0",
        "status": "error",
        "operation_id": "sim.send",
        "error": {
            "code": "TRANSPORT_SEND_FAILED",
            "exit_code": 11,
            "message": "send failed",
            "retryable": True,
            "details": {"target": "239.135.1.1:55555"},
        },
        "meta": {
            "request_id": "req-2",
            "duration_ms": 7,
            "timestamp": "2026-06-02T00:00:01Z",
        },
    }
```

- [ ] **Step 2: 运行测试确认失败** — Run: `python -m pytest tests/test_envelope.py -v`  Expected: FAIL (`ModuleNotFoundError: No module named 'tracksim.envelope'`)

- [ ] **Step 3: 最小实现**

```python
# src/tracksim/envelope.py
from __future__ import annotations

from typing import Any

SCHEMA_VERSION = "1.0"
CONTRACT_VERSION = "1.0"

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_CONFIG = 3
EXIT_CONFLICT = 6
EXIT_TIMEOUT = 7
EXIT_EXTERNAL = 8
EXIT_NO_CONTROLLER = 10
EXIT_TRANSPORT = 11
EXIT_UNSUPPORTED = 12
EXIT_INVALID_INPUT = 13
EXIT_SIGINT = 130


def success_envelope(
    operation_id: str,
    data: Any,
    *,
    request_id: str,
    duration_ms: int,
    timestamp: str,
) -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "status": "ok",
        "operation_id": operation_id,
        "data": data,
        "meta": {
            "request_id": request_id,
            "duration_ms": duration_ms,
            "timestamp": timestamp,
        },
    }


def error_envelope(
    operation_id: str,
    *,
    code: str,
    exit_code: int,
    message: str,
    retryable: bool,
    details: dict[str, Any],
    request_id: str,
    duration_ms: int,
    timestamp: str,
) -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "status": "error",
        "operation_id": operation_id,
        "error": {
            "code": code,
            "exit_code": exit_code,
            "message": message,
            "retryable": retryable,
            "details": details,
        },
        "meta": {
            "request_id": request_id,
            "duration_ms": duration_ms,
            "timestamp": timestamp,
        },
    }
```

- [ ] **Step 4: 运行测试确认通过** — Run: `python -m pytest tests/test_envelope.py -v`  Expected: PASS (4 passed)

- [ ] **Step 5: 提交**

```bash
git add src/tracksim/envelope.py tests/test_envelope.py
git commit -m "feat(envelope): add success/error builders and exit-code constants"
```

---

### Task 10: Config models + `load_config`

**Files:**
- Create: `src/tracksim/config.py`
- Test: `tests/test_config.py`

说明：pydantic v2 嵌套模型，分节照 design §8。`load_config` 合并优先级：内置默认 < 文件（按扩展名 `.toml`/`.yaml`/`.yml`/`.json`）< overrides。文件读取/解析失败或扩展名不支持时抛 `ConfigError`。FreeDCfg/OpenTrackIOCfg 字段照 SHARED CONTRACT 具体字段。

- [ ] **Step 1: 写失败测试**

```python
# tests/test_config.py
import json

import pytest

from tracksim.config import (
    Config,
    ProtocolsCfg,
    FreeDCfg,
    OpenTrackIOCfg,
    ControllerCfg,
    MotionCfg,
    OutputCfg,
    load_config,
)
from tracksim.domain.errors import ConfigError


def test_default_config_structure():
    cfg = Config()
    assert isinstance(cfg.protocols, ProtocolsCfg)
    assert isinstance(cfg.freed, FreeDCfg)
    assert isinstance(cfg.opentrackio, OpenTrackIOCfg)
    assert isinstance(cfg.controller, ControllerCfg)
    assert isinstance(cfg.motion, MotionCfg)
    assert isinstance(cfg.output, OutputCfg)


def test_freed_defaults():
    f = FreeDCfg()
    assert f.transport == "udp_unicast"
    assert f.target_ip == "127.0.0.1"
    assert f.port == 6000
    assert f.serial_device is None
    assert f.baud == 38400
    assert f.camera_id == 1
    assert f.rate_hz == 60.0
    assert f.scaling.variant == "native"
    assert f.scaling.angle_lsb_per_deg == 32768.0
    assert f.scaling.pos_lsb_per_m == 64000.0


def test_opentrackio_defaults():
    o = OpenTrackIOCfg()
    assert o.transport == "multicast"
    assert o.source_number == 1
    assert o.ip == "239.135.1.1"
    assert o.port == 55555
    assert o.encoding == "json"
    assert o.rate_hz == 60.0


def test_motion_defaults():
    m = MotionCfg()
    assert m.motion == "static"
    assert m.radius == 2.0
    assert m.speed == 30.0
    assert m.amplitude == 10.0
    assert m.freq == 0.5


def test_output_defaults():
    out = OutputCfg()
    assert out.format == "text"
    assert out.log_level == "info"


def test_load_config_none_returns_defaults():
    cfg = load_config(None)
    assert cfg == Config()


def test_load_config_json(tmp_path):
    p = tmp_path / "c.json"
    p.write_text(json.dumps({"freed": {"camera_id": 7, "port": 6001}}))
    cfg = load_config(str(p))
    assert cfg.freed.camera_id == 7
    assert cfg.freed.port == 6001
    # untouched fields keep defaults
    assert cfg.freed.transport == "udp_unicast"


def test_load_config_toml(tmp_path):
    p = tmp_path / "c.toml"
    p.write_text(
        "[opentrackio]\n"
        'transport = "unicast"\n'
        "source_number = 12\n"
    )
    cfg = load_config(str(p))
    assert cfg.opentrackio.transport == "unicast"
    assert cfg.opentrackio.source_number == 12


def test_load_config_yaml(tmp_path):
    p = tmp_path / "c.yaml"
    p.write_text("motion:\n  motion: orbit\n  radius: 5.0\n")
    cfg = load_config(str(p))
    assert cfg.motion.motion == "orbit"
    assert cfg.motion.radius == 5.0


def test_override_precedence_beats_file(tmp_path):
    p = tmp_path / "c.json"
    p.write_text(json.dumps({"freed": {"camera_id": 7}}))
    cfg = load_config(str(p), overrides={"freed": {"camera_id": 99}})
    assert cfg.freed.camera_id == 99


def test_controller_mapping_entry(tmp_path):
    p = tmp_path / "c.json"
    p.write_text(
        json.dumps(
            {
                "controller": {
                    "device": "0",
                    "mapping": [
                        {
                            "channel": "x",
                            "source": "leftx",
                            "mode": "rate",
                            "scale": 1.5,
                            "deadzone": 0.1,
                            "invert": True,
                            "clamp_min": -5.0,
                            "clamp_max": 5.0,
                        }
                    ],
                }
            }
        )
    )
    cfg = load_config(str(p))
    entry = cfg.controller.mapping[0]
    assert entry.channel == "x"
    assert entry.source == "leftx"
    assert entry.mode == "rate"
    assert entry.scale == 1.5
    assert entry.deadzone == 0.1
    assert entry.invert is True
    assert entry.clamp_min == -5.0
    assert entry.clamp_max == 5.0


def test_load_config_missing_file_raises():
    with pytest.raises(ConfigError):
        load_config("/nonexistent/path/to/config.toml")


def test_load_config_unsupported_extension(tmp_path):
    p = tmp_path / "c.ini"
    p.write_text("nope")
    with pytest.raises(ConfigError):
        load_config(str(p))


def test_load_config_malformed_json_raises(tmp_path):
    p = tmp_path / "c.json"
    p.write_text("{ not valid json ")
    with pytest.raises(ConfigError):
        load_config(str(p))


def test_load_config_invalid_value_raises(tmp_path):
    p = tmp_path / "c.json"
    p.write_text(json.dumps({"freed": {"port": "not-an-int"}}))
    with pytest.raises(ConfigError):
        load_config(str(p))
```

- [ ] **Step 2: 运行测试确认失败** — Run: `python -m pytest tests/test_config.py -v`  Expected: FAIL (`ModuleNotFoundError: No module named 'tracksim.config'`)

- [ ] **Step 3: 最小实现**

```python
# src/tracksim/config.py
from __future__ import annotations

import json
import tomllib
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, ValidationError

from tracksim.domain.errors import ConfigError


class ProtocolsCfg(BaseModel):
    freed: bool = True
    opentrackio: bool = True


class FreeDScalingCfg(BaseModel):
    variant: str = "native"
    angle_lsb_per_deg: float = 32768.0
    pos_lsb_per_m: float = 64000.0


class FreeDCfg(BaseModel):
    transport: str = "udp_unicast"
    target_ip: str = "127.0.0.1"
    port: int = 6000
    serial_device: str | None = None
    baud: int = 38400
    camera_id: int = 1
    rate_hz: float = 60.0
    scaling: FreeDScalingCfg = FreeDScalingCfg()


class OpenTrackIOCfg(BaseModel):
    transport: str = "multicast"
    source_number: int = 1
    ip: str = "239.135.1.1"
    port: int = 55555
    encoding: str = "json"
    rate_hz: float = 60.0


class ControllerMappingEntry(BaseModel):
    channel: str
    source: str
    mode: str = "rate"
    scale: float = 1.0
    deadzone: float = 0.0
    invert: bool = False
    clamp_min: float | None = None
    clamp_max: float | None = None


class ControllerCfg(BaseModel):
    device: str | None = None
    mapping: list[ControllerMappingEntry] = []


class MotionCfg(BaseModel):
    motion: str = "static"
    radius: float = 2.0
    speed: float = 30.0
    amplitude: float = 10.0
    freq: float = 0.5


class OutputCfg(BaseModel):
    format: str = "text"
    log_level: str = "info"


class Config(BaseModel):
    protocols: ProtocolsCfg = ProtocolsCfg()
    freed: FreeDCfg = FreeDCfg()
    opentrackio: OpenTrackIOCfg = OpenTrackIOCfg()
    controller: ControllerCfg = ControllerCfg()
    motion: MotionCfg = MotionCfg()
    output: OutputCfg = OutputCfg()


def _deep_merge(base: dict[str, Any], over: dict[str, Any]) -> dict[str, Any]:
    result = dict(base)
    for key, value in over.items():
        if (
            key in result
            and isinstance(result[key], dict)
            and isinstance(value, dict)
        ):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def _load_file(path: str) -> dict[str, Any]:
    p = Path(path)
    try:
        raw = p.read_bytes()
    except OSError as e:
        raise ConfigError(f"Cannot read config file: {path}", details={"path": path}) from e

    suffix = p.suffix.lower()
    try:
        if suffix == ".toml":
            return tomllib.loads(raw.decode("utf-8"))
        if suffix in (".yaml", ".yml"):
            return yaml.safe_load(raw.decode("utf-8")) or {}
        if suffix == ".json":
            return json.loads(raw.decode("utf-8"))
    except (tomllib.TOMLDecodeError, yaml.YAMLError, json.JSONDecodeError, ValueError) as e:
        raise ConfigError(f"Cannot parse config file: {path}", details={"path": path}) from e

    raise ConfigError(
        f"Unsupported config extension: {suffix}", details={"path": path}
    )


def load_config(
    path: str | None, overrides: dict[str, Any] | None = None
) -> Config:
    """Merge defaults < file < overrides into a validated Config."""
    merged: dict[str, Any] = {}
    if path is not None:
        merged = _deep_merge(merged, _load_file(path))
    if overrides is not None:
        merged = _deep_merge(merged, overrides)
    try:
        return Config.model_validate(merged)
    except ValidationError as e:
        raise ConfigError("Invalid config values", details={"errors": e.errors()}) from e
```

- [ ] **Step 4: 运行测试确认通过** — Run: `python -m pytest tests/test_config.py -v`  Expected: PASS (all cases passed)

- [ ] **Step 5: 提交**

```bash
git add src/tracksim/config.py tests/test_config.py
git commit -m "feat(config): add nested Config models and load_config with merge precedence"
```

---

### Task 11: Contract Manifest builder

**Files:**
- Create: `src/tracksim/manifest.py`
- Test: `tests/test_manifest.py`

说明：`build_manifest()` 返回 `contract_version` + `operations` 列表；operation_id 集合必须精确等于 SHARED CONTRACT 给定的 12 个。`contract_version` 复用 `envelope.CONTRACT_VERSION`。

- [ ] **Step 1: 写失败测试**

```python
# tests/test_manifest.py
from tracksim.manifest import build_manifest
from tracksim.envelope import CONTRACT_VERSION

EXPECTED_OPERATION_IDS = {
    "sim.run",
    "sim.send",
    "controllers.list",
    "controllers.monitor",
    "config.init",
    "config.show",
    "config.validate",
    "freed.decode",
    "opentrackio.decode",
    "meta.manifest",
    "meta.schema",
    "meta.version",
}


def test_manifest_is_dict_with_operations():
    m = build_manifest()
    assert isinstance(m, dict)
    assert m["contract_version"] == CONTRACT_VERSION
    assert isinstance(m["operations"], list)


def test_manifest_operation_id_set_exact():
    m = build_manifest()
    ids = {op["operation_id"] for op in m["operations"]}
    assert ids == EXPECTED_OPERATION_IDS


def test_manifest_operation_ids_unique():
    m = build_manifest()
    ids = [op["operation_id"] for op in m["operations"]]
    assert len(ids) == len(set(ids))
    assert len(ids) == 12


def test_each_operation_has_summary():
    m = build_manifest()
    for op in m["operations"]:
        assert isinstance(op.get("summary"), str)
        assert op["summary"]
```

- [ ] **Step 2: 运行测试确认失败** — Run: `python -m pytest tests/test_manifest.py -v`  Expected: FAIL (`ModuleNotFoundError: No module named 'tracksim.manifest'`)

- [ ] **Step 3: 最小实现**

```python
# src/tracksim/manifest.py
from __future__ import annotations

from typing import Any

from tracksim.envelope import CONTRACT_VERSION

_OPERATIONS: list[dict[str, str]] = [
    {"operation_id": "sim.run", "summary": "Stream camera poses to enabled protocols (long-running)"},
    {"operation_id": "sim.send", "summary": "Send a single frame or hold a fixed pose for a duration"},
    {"operation_id": "controllers.list", "summary": "Enumerate connected game controllers"},
    {"operation_id": "controllers.monitor", "summary": "Stream raw controller axis/button values"},
    {"operation_id": "config.init", "summary": "Generate a default configuration file"},
    {"operation_id": "config.show", "summary": "Show the effective merged configuration"},
    {"operation_id": "config.validate", "summary": "Validate a configuration file"},
    {"operation_id": "freed.decode", "summary": "Decode a FreeD packet into fields"},
    {"operation_id": "opentrackio.decode", "summary": "Decode an OpenTrackIO packet into fields"},
    {"operation_id": "meta.manifest", "summary": "Output the contract manifest"},
    {"operation_id": "meta.schema", "summary": "Output the CLI structure JSON schema"},
    {"operation_id": "meta.version", "summary": "Output version metadata"},
]


def build_manifest() -> dict[str, Any]:
    return {
        "contract_version": CONTRACT_VERSION,
        "operations": [dict(op) for op in _OPERATIONS],
    }
```

- [ ] **Step 4: 运行测试确认通过** — Run: `python -m pytest tests/test_manifest.py -v`  Expected: PASS (4 passed)

- [ ] **Step 5: 提交**

```bash
git add src/tracksim/manifest.py tests/test_manifest.py
git commit -m "feat(manifest): add build_manifest with canonical operation_id set"
```

### Task 12: `UdpTransport` — loopback unicast send

**Files:**
- Create: `src/tracksim/transports/__init__.py`
- Create: `src/tracksim/transports/udp.py`
- Test: `tests/test_udp_transport.py`

- [ ] **Step 1: 写失败测试** — 绑定一个真实 loopback UDP recv socket（ephemeral port），构造 unicast `UdpTransport` 发送字节，断言收到的字节一致。

```python
# tests/test_udp_transport.py
import socket

from tracksim.transports.udp import UdpTransport


def test_unicast_loopback_send_delivers_bytes():
    recv = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    recv.bind(("127.0.0.1", 0))
    recv.settimeout(2.0)
    host, port = recv.getsockname()

    transport = UdpTransport(mode="unicast", host=host, port=port)
    try:
        payload = b"hello-tracksim"
        transport.send(payload)
        data, _addr = recv.recvfrom(4096)
        assert data == payload
    finally:
        transport.close()
        recv.close()
```

- [ ] **Step 2: 运行测试确认失败** — Run: `python -m pytest tests/test_udp_transport.py::test_unicast_loopback_send_delivers_bytes -v`  Expected: FAIL（`ModuleNotFoundError: No module named 'tracksim.transports.udp'`）

- [ ] **Step 3: 最小实现** — 创建 transports 包与 `UdpTransport`，构造期建立 socket 并按 mode 设置 sockopt，`send` 用 `sendto`，socket 失败抛 `TransportError`。

```python
# src/tracksim/transports/__init__.py
```

```python
# src/tracksim/transports/udp.py
from __future__ import annotations

import socket

from tracksim.domain.errors import TransportError

_VALID_MODES = ("unicast", "multicast", "broadcast")


class UdpTransport:
    """UDP transport implementing the ports.transport.Transport protocol."""

    def __init__(self, mode: str, host: str, port: int, ttl: int = 2) -> None:
        if mode not in _VALID_MODES:
            raise TransportError(
                f"unknown UDP mode: {mode!r}",
                details={"mode": mode, "valid": list(_VALID_MODES)},
            )
        self.mode = mode
        self.host = host
        self.port = port
        self.ttl = ttl
        try:
            self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            if mode == "multicast":
                self._sock.setsockopt(
                    socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, ttl
                )
            elif mode == "broadcast":
                self._sock.setsockopt(
                    socket.SOL_SOCKET, socket.SO_BROADCAST, 1
                )
        except OSError as exc:
            raise TransportError(
                f"failed to open UDP socket: {exc}",
                details={"mode": mode, "host": host, "port": port},
            ) from exc

    def send(self, data: bytes) -> None:
        try:
            self._sock.sendto(data, (self.host, self.port))
        except OSError as exc:
            raise TransportError(
                f"UDP send failed: {exc}",
                details={"host": self.host, "port": self.port},
            ) from exc

    def close(self) -> None:
        self._sock.close()
```

- [ ] **Step 4: 运行测试确认通过** — Run: `python -m pytest tests/test_udp_transport.py::test_unicast_loopback_send_delivers_bytes -v`  Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/tracksim/transports/__init__.py src/tracksim/transports/udp.py tests/test_udp_transport.py
git commit -m "feat(transports): add UdpTransport with loopback unicast send"
```

---

### Task 13: `UdpTransport` — multicast TTL & broadcast sockopt

**Files:**
- Modify: `src/tracksim/transports/udp.py` (no change expected; tests assert existing behavior)
- Test: `tests/test_udp_transport.py`

- [ ] **Step 1: 写失败测试** — monkeypatch `socket.socket` 返回一个记录 `setsockopt` 调用的 fake，断言 multicast 设置 `IP_MULTICAST_TTL`、broadcast 设置 `SO_BROADCAST`，并断言无效 mode 抛 `TransportError`。

```python
# append to tests/test_udp_transport.py
import socket as _socket_module

import pytest

from tracksim.domain.errors import TransportError


class _FakeSocket:
    def __init__(self, *args, **kwargs):
        self.sockopts: list[tuple[int, int, int]] = []
        self.sent: list[tuple[bytes, tuple[str, int]]] = []
        self.closed = False

    def setsockopt(self, level, optname, value):
        self.sockopts.append((level, optname, value))

    def sendto(self, data, addr):
        self.sent.append((data, addr))

    def close(self):
        self.closed = True


def test_multicast_sets_ip_multicast_ttl(monkeypatch):
    created: list[_FakeSocket] = []

    def factory(*args, **kwargs):
        sock = _FakeSocket(*args, **kwargs)
        created.append(sock)
        return sock

    monkeypatch.setattr(_socket_module, "socket", factory)
    transport = UdpTransport(mode="multicast", host="239.135.1.1", port=55555, ttl=5)
    assert (
        _socket_module.IPPROTO_IP,
        _socket_module.IP_MULTICAST_TTL,
        5,
    ) in created[0].sockopts
    transport.close()
    assert created[0].closed is True


def test_broadcast_sets_so_broadcast(monkeypatch):
    created: list[_FakeSocket] = []

    def factory(*args, **kwargs):
        sock = _FakeSocket(*args, **kwargs)
        created.append(sock)
        return sock

    monkeypatch.setattr(_socket_module, "socket", factory)
    transport = UdpTransport(mode="broadcast", host="255.255.255.255", port=55555)
    assert (
        _socket_module.SOL_SOCKET,
        _socket_module.SO_BROADCAST,
        1,
    ) in created[0].sockopts
    transport.close()


def test_invalid_mode_raises_transport_error():
    with pytest.raises(TransportError) as excinfo:
        UdpTransport(mode="bogus", host="127.0.0.1", port=55555)
    assert excinfo.value.code == "TRANSPORT_SEND_FAILED"
    assert excinfo.value.details["mode"] == "bogus"
```

- [ ] **Step 2: 运行测试确认失败** — Run: `python -m pytest tests/test_udp_transport.py::test_multicast_sets_ip_multicast_ttl tests/test_udp_transport.py::test_broadcast_sets_so_broadcast tests/test_udp_transport.py::test_invalid_mode_raises_transport_error -v`  Expected: 若 Task 12 实现已正确则三测试均 PASS；若 `_socket_module.socket` 未被构造期使用（例如实现内部 import 了 `from socket import socket`）则 monkeypatch 不生效 → FAIL，需要修正实现使其引用 `socket.socket`。

- [ ] **Step 3: 最小实现** — Task 12 的 `udp.py` 已通过 `socket.socket(...)` 引用模块属性，monkeypatch 生效，无需改动。若上一步 FAIL，确认 `udp.py` 顶部为 `import socket` 且调用为 `socket.socket(...)`（而非 `from socket import socket`），保持如下：

```python
# src/tracksim/transports/udp.py  (confirm this exact module-attribute usage; no rewrite needed if already so)
from __future__ import annotations

import socket

from tracksim.domain.errors import TransportError

_VALID_MODES = ("unicast", "multicast", "broadcast")


class UdpTransport:
    """UDP transport implementing the ports.transport.Transport protocol."""

    def __init__(self, mode: str, host: str, port: int, ttl: int = 2) -> None:
        if mode not in _VALID_MODES:
            raise TransportError(
                f"unknown UDP mode: {mode!r}",
                details={"mode": mode, "valid": list(_VALID_MODES)},
            )
        self.mode = mode
        self.host = host
        self.port = port
        self.ttl = ttl
        try:
            self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            if mode == "multicast":
                self._sock.setsockopt(
                    socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, ttl
                )
            elif mode == "broadcast":
                self._sock.setsockopt(
                    socket.SOL_SOCKET, socket.SO_BROADCAST, 1
                )
        except OSError as exc:
            raise TransportError(
                f"failed to open UDP socket: {exc}",
                details={"mode": mode, "host": host, "port": port},
            ) from exc

    def send(self, data: bytes) -> None:
        try:
            self._sock.sendto(data, (self.host, self.port))
        except OSError as exc:
            raise TransportError(
                f"UDP send failed: {exc}",
                details={"host": self.host, "port": self.port},
            ) from exc

    def close(self) -> None:
        self._sock.close()
```

- [ ] **Step 4: 运行测试确认通过** — Run: `python -m pytest tests/test_udp_transport.py -v`  Expected: PASS（全部 4 个 UDP 测试通过）

- [ ] **Step 5: 提交**

```bash
git add src/tracksim/transports/udp.py tests/test_udp_transport.py
git commit -m "test(transports): cover UDP multicast TTL, broadcast sockopt, invalid mode"
```

---

### Task 14: `FakeTransport` 测试替身

**Files:**
- Modify: `tests/fakes.py`
- Test: `tests/test_fakes_transport.py`

- [ ] **Step 1: 写失败测试** — 断言 `FakeTransport` 记录 `send` 的字节到 `sent` 列表，`close` 设置 `closed` 标记。

```python
# tests/test_fakes_transport.py
from tests.fakes import FakeTransport


def test_fake_transport_records_sent_bytes():
    t = FakeTransport()
    t.send(b"abc")
    t.send(b"def")
    assert t.sent == [b"abc", b"def"]


def test_fake_transport_close_sets_flag():
    t = FakeTransport()
    assert t.closed is False
    t.close()
    assert t.closed is True
```

- [ ] **Step 2: 运行测试确认失败** — Run: `python -m pytest tests/test_fakes_transport.py -v`  Expected: FAIL（`tests/fakes.py` 中尚无 `FakeTransport`，`ImportError`）

- [ ] **Step 3: 最小实现** — 向已存在的 `tests/fakes.py` 追加 `FakeTransport`（若文件不存在则创建；此处给出追加内容的完整类定义）。

```python
# append to tests/fakes.py
class FakeTransport:
    """Recording test double for ports.transport.Transport."""

    def __init__(self) -> None:
        self.sent: list[bytes] = []
        self.closed: bool = False

    def send(self, data: bytes) -> None:
        self.sent.append(data)

    def close(self) -> None:
        self.closed = True
```

- [ ] **Step 4: 运行测试确认通过** — Run: `python -m pytest tests/test_fakes_transport.py -v`  Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add tests/fakes.py tests/test_fakes_transport.py
git commit -m "test(fakes): add FakeTransport recording double"
```

---

### Task 15: `SerialTransport` — 注入式 serial 工厂，写字节 + 打开失败抛 `TransportError`

**Files:**
- Create: `src/tracksim/transports/serial_port.py`
- Test: `tests/test_serial_transport.py`

- [ ] **Step 1: 写失败测试** — 注入一个 fake serial 工厂，断言：构造期以 FreeD 串口参数（38400/8/Odd/1）打开端口；`send` 调用 fake 的 `write`；`close` 调用 `close`；打开抛异常时包装成 `TransportError`。

```python
# tests/test_serial_transport.py
import pytest

from tracksim.domain.errors import TransportError
from tracksim.transports.serial_port import SerialTransport


class _FakeSerial:
    def __init__(self, port, baudrate, parity, stopbits, bytesize):
        self.port = port
        self.baudrate = baudrate
        self.parity = parity
        self.stopbits = stopbits
        self.bytesize = bytesize
        self.written: list[bytes] = []
        self.closed = False

    def write(self, data):
        self.written.append(data)
        return len(data)

    def close(self):
        self.closed = True


def test_serial_opens_with_freed_params_and_writes():
    created: list[_FakeSerial] = []

    def factory(**kwargs):
        sock = _FakeSerial(**kwargs)
        created.append(sock)
        return sock

    transport = SerialTransport(device="/dev/ttyUSB0", serial_factory=factory)
    assert created[0].port == "/dev/ttyUSB0"
    assert created[0].baudrate == 38400
    assert created[0].parity == "O"
    assert created[0].stopbits == 1
    assert created[0].bytesize == 8

    transport.send(b"\xd1\x00")
    assert created[0].written == [b"\xd1\x00"]

    transport.close()
    assert created[0].closed is True


def test_serial_open_failure_raises_transport_error():
    def factory(**kwargs):
        raise OSError("port busy")

    with pytest.raises(TransportError) as excinfo:
        SerialTransport(device="/dev/ttyUSB0", serial_factory=factory)
    assert excinfo.value.code == "TRANSPORT_SEND_FAILED"
    assert excinfo.value.details["device"] == "/dev/ttyUSB0"


def test_serial_send_failure_raises_transport_error():
    class _FailingSerial(_FakeSerial):
        def write(self, data):
            raise OSError("write error")

    def factory(**kwargs):
        return _FailingSerial(**kwargs)

    transport = SerialTransport(device="/dev/ttyUSB0", serial_factory=factory)
    with pytest.raises(TransportError) as excinfo:
        transport.send(b"\x00")
    assert excinfo.value.code == "TRANSPORT_SEND_FAILED"
```

- [ ] **Step 2: 运行测试确认失败** — Run: `python -m pytest tests/test_serial_transport.py -v`  Expected: FAIL（`ModuleNotFoundError: No module named 'tracksim.transports.serial_port'`）

- [ ] **Step 3: 最小实现** — 创建 `SerialTransport`，默认用 pyserial 工厂（延迟 import，便于注入），FreeD 协议参数映射到 pyserial 常量。注意：`baud=38400, parity="O", stopbits=1` 来自 SHARED CONTRACT 与 FreeD 协议 v1.0 (RS422, 38.4 kbaud, 8 data bits LSB first, Odd parity, 1 stop bit)。`bytesize` 固定为 8。

```python
# src/tracksim/transports/serial_port.py
from __future__ import annotations

from typing import Any, Callable

from tracksim.domain.errors import TransportError

# Map FreeD/contract parity codes to pyserial PARITY_* string constants.
_PARITY_MAP = {"N": "N", "E": "E", "O": "O", "M": "M", "S": "S"}


def _default_serial_factory(**kwargs: Any) -> Any:
    import serial  # lazy import so tests can inject a fake factory

    parity_map = {
        "N": serial.PARITY_NONE,
        "E": serial.PARITY_EVEN,
        "O": serial.PARITY_ODD,
        "M": serial.PARITY_MARK,
        "S": serial.PARITY_SPACE,
    }
    stopbits_map = {
        1: serial.STOPBITS_ONE,
        2: serial.STOPBITS_TWO,
    }
    bytesize_map = {
        5: serial.FIVEBITS,
        6: serial.SIXBITS,
        7: serial.SEVENBITS,
        8: serial.EIGHTBITS,
    }
    return serial.Serial(
        port=kwargs["port"],
        baudrate=kwargs["baudrate"],
        parity=parity_map[kwargs["parity"]],
        stopbits=stopbits_map[kwargs["stopbits"]],
        bytesize=bytesize_map[kwargs["bytesize"]],
    )


class SerialTransport:
    """Serial transport implementing the ports.transport.Transport protocol.

    Defaults match the FreeD v1.0 RS422 line settings: 38400 baud, 8 data
    bits (LSB first), odd parity, 1 stop bit.
    """

    def __init__(
        self,
        device: str,
        baud: int = 38400,
        parity: str = "O",
        stopbits: int = 1,
        *,
        serial_factory: Callable[..., Any] = _default_serial_factory,
    ) -> None:
        if parity not in _PARITY_MAP:
            raise TransportError(
                f"unknown parity: {parity!r}",
                details={"device": device, "parity": parity},
            )
        self.device = device
        self.baud = baud
        self.parity = parity
        self.stopbits = stopbits
        try:
            self._port = serial_factory(
                port=device,
                baudrate=baud,
                parity=parity,
                stopbits=stopbits,
                bytesize=8,
            )
        except Exception as exc:
            raise TransportError(
                f"failed to open serial port: {exc}",
                details={"device": device, "baud": baud},
            ) from exc

    def send(self, data: bytes) -> None:
        try:
            self._port.write(data)
        except Exception as exc:
            raise TransportError(
                f"serial write failed: {exc}",
                details={"device": self.device},
            ) from exc

    def close(self) -> None:
        self._port.close()
```

- [ ] **Step 4: 运行测试确认通过** — Run: `python -m pytest tests/test_serial_transport.py -v`  Expected: PASS（3 个测试通过）

- [ ] **Step 5: 提交**

```bash
git add src/tracksim/transports/serial_port.py tests/test_serial_transport.py
git commit -m "feat(transports): add SerialTransport with injectable serial factory"

### Task 16: FreeD D1 编码器 — FreeDScaling 与 encode_d1（29 字节，0xD1）

**Files:**
- Create: `src/tracksim/emitters/__init__.py`
- Create: `src/tracksim/emitters/freed.py`
- Test: `tests/test_freed_encode.py`

FreeD D1 报文按 Appendix A.3.2 / Appendix B：29 字节，type=0xD1，camera_id，pan/tilt/roll 各 24-bit 大端二补码（单位 1/32768 度，零值=0x000000），X/Y/Z 各 24-bit 二补码（按 `pos_lsb_per_m` 缩放），zoom/focus 各 24-bit（用 `scaling.zoom_raw`/`focus_raw` 原始值），2 字节 spare，checksum = `(0x40 - sum(前 28 字节)) & 0xFF`。

- [ ] **Step 1: 写失败测试**

```python
# tests/test_freed_encode.py
from tracksim.domain.pose import CameraPose
from tracksim.emitters.freed import FreeDScaling, encode_d1


def _d24(bs: bytes) -> int:
    v = (bs[0] << 16) | (bs[1] << 8) | bs[2]
    if v & 0x800000:
        v -= 0x1000000
    return v


def _decode_d1(frame: bytes, scaling: FreeDScaling):
    assert len(frame) == 29
    assert frame[0] == 0xD1
    camera_id = frame[1]
    pan = _d24(frame[2:5]) / scaling.angle_lsb_per_deg
    tilt = _d24(frame[5:8]) / scaling.angle_lsb_per_deg
    roll = _d24(frame[8:11]) / scaling.angle_lsb_per_deg
    x = _d24(frame[11:14]) / scaling.pos_lsb_per_m
    y = _d24(frame[14:17]) / scaling.pos_lsb_per_m
    z = _d24(frame[17:20]) / scaling.pos_lsb_per_m
    return camera_id, pan, tilt, roll, x, y, z


def test_encode_d1_length_is_29():
    frame = encode_d1(CameraPose(), camera_id=0, scaling=FreeDScaling())
    assert len(frame) == 29
    assert frame[0] == 0xD1


def test_encode_d1_checksum_formula():
    frame = encode_d1(
        CameraPose(pan=10.0, tilt=-5.0, roll=0.0, x=1.0, y=2.0, z=1.5),
        camera_id=3,
        scaling=FreeDScaling(),
    )
    expected_ck = (0x40 - sum(frame[:28])) & 0xFF
    assert frame[28] == expected_ck


def test_encode_d1_known_bytes():
    frame = encode_d1(
        CameraPose(pan=10.0, tilt=-5.0, roll=0.0, x=1.0, y=2.0, z=1.5),
        camera_id=3,
        scaling=FreeDScaling(),
    )
    assert frame.hex() == "d103050000fd800000000000fa0001f400017700000000000000000083"
    assert frame[28] == 0x83


def test_encode_d1_zoom_focus_raw():
    frame = encode_d1(
        CameraPose(),
        camera_id=0,
        scaling=FreeDScaling(zoom_raw=0x010203, focus_raw=0x040506),
    )
    assert frame[20:23] == bytes([0x01, 0x02, 0x03])
    assert frame[23:26] == bytes([0x04, 0x05, 0x06])
    assert frame[26:28] == b"\x00\x00"


def test_encode_d1_round_trip():
    scaling = FreeDScaling()
    pose = CameraPose(pan=10.0, tilt=-5.0, roll=2.5, x=1.0, y=-2.0, z=1.5)
    frame = encode_d1(pose, camera_id=7, scaling=scaling)
    camera_id, pan, tilt, roll, x, y, z = _decode_d1(frame, scaling)
    assert camera_id == 7
    assert abs(pan - 10.0) < 1e-3
    assert abs(tilt - -5.0) < 1e-3
    assert abs(roll - 2.5) < 1e-3
    assert abs(x - 1.0) < 1e-4
    assert abs(y - -2.0) < 1e-4
    assert abs(z - 1.5) < 1e-4
```

- [ ] **Step 2: 运行测试确认失败** — Run: `python -m pytest tests/test_freed_encode.py -v`  Expected: FAIL (`ModuleNotFoundError: No module named 'tracksim.emitters'`)

- [ ] **Step 3: 最小实现**

```python
# src/tracksim/emitters/__init__.py
```

```python
# src/tracksim/emitters/freed.py
from dataclasses import dataclass

from tracksim.domain.pose import CameraPose
from tracksim.ports.transport import Transport


@dataclass
class FreeDScaling:
    variant: str = "native"
    angle_lsb_per_deg: float = 32768.0
    pos_lsb_per_m: float = 64000.0
    zoom_raw: int = 0
    focus_raw: int = 0


def _pack_s24(value: int) -> bytes:
    """Pack a signed integer as 24-bit two's-complement big-endian."""
    v = int(value) & 0xFFFFFF
    return bytes([(v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF])


def encode_d1(pose: CameraPose, *, camera_id: int, scaling: FreeDScaling) -> bytes:
    """Encode a CameraPose as a 29-byte FreeD type-0xD1 message.

    Layout (Vinten free-d v1.0, Appendix A.3.2 / Appendix B):
      [0]   0xD1 message type
      [1]   camera id
      [2:5]   pan  (24-bit signed, 1/angle_lsb_per_deg degree)
      [5:8]   tilt
      [8:11]  roll
      [11:14] X-position (24-bit signed, 1/pos_lsb_per_m metre)
      [14:17] Y-position
      [17:20] Z-position (height)
      [20:23] zoom (24-bit raw)
      [23:26] focus (24-bit raw)
      [26:28] spare (16 bits)
      [28]    checksum = (0x40 - sum(first 28 bytes)) & 0xFF
    """
    body = bytearray()
    body.append(0xD1)
    body.append(camera_id & 0xFF)
    body += _pack_s24(round(pose.pan * scaling.angle_lsb_per_deg))
    body += _pack_s24(round(pose.tilt * scaling.angle_lsb_per_deg))
    body += _pack_s24(round(pose.roll * scaling.angle_lsb_per_deg))
    body += _pack_s24(round(pose.x * scaling.pos_lsb_per_m))
    body += _pack_s24(round(pose.y * scaling.pos_lsb_per_m))
    body += _pack_s24(round(pose.z * scaling.pos_lsb_per_m))
    body += _pack_s24(scaling.zoom_raw)
    body += _pack_s24(scaling.focus_raw)
    body += b"\x00\x00"  # spare
    checksum = (0x40 - sum(body)) & 0xFF
    body.append(checksum)
    return bytes(body)


class FreeDEmitter:
    name = "freed"

    def __init__(
        self,
        transport: Transport,
        *,
        camera_id: int = 0,
        scaling: FreeDScaling = FreeDScaling(),
    ) -> None:
        self._transport = transport
        self._camera_id = camera_id
        self._scaling = scaling

    def emit(self, pose: CameraPose) -> None:
        self._transport.send(
            encode_d1(pose, camera_id=self._camera_id, scaling=self._scaling)
        )

    def close(self) -> None:
        self._transport.close()
```

- [ ] **Step 4: 运行测试确认通过** — Run: `python -m pytest tests/test_freed_encode.py -v`  Expected: PASS (6 passed)

- [ ] **Step 5: 提交** — `git add src/tracksim/emitters/__init__.py src/tracksim/emitters/freed.py tests/test_freed_encode.py` then `git commit -m "feat(emitters): add FreeD D1 encoder and FreeDEmitter"`

### Task 17: FreeDEmitter 通过 Transport 发送字节

**Files:**
- Test: `tests/test_freed_emitter.py`

验证 `FreeDEmitter.emit` 把 `encode_d1` 的输出原样交给 `Transport.send`，`name=="freed"`，`close()` 转发到 transport。用一个内存 fake transport（实现 SHARED CONTRACT 的 `Transport` 协议：`send`/`close`）。

- [ ] **Step 1: 写失败测试**

```python
# tests/test_freed_emitter.py
from tracksim.domain.pose import CameraPose
from tracksim.emitters.freed import FreeDEmitter, FreeDScaling, encode_d1


class FakeTransport:
    def __init__(self) -> None:
        self.sent: list[bytes] = []
        self.closed = False

    def send(self, data: bytes) -> None:
        self.sent.append(data)

    def close(self) -> None:
        self.closed = True


def test_freed_emitter_name():
    assert FreeDEmitter(FakeTransport()).name == "freed"


def test_freed_emitter_sends_encoded_frame():
    transport = FakeTransport()
    scaling = FreeDScaling()
    emitter = FreeDEmitter(transport, camera_id=5, scaling=scaling)
    pose = CameraPose(pan=12.0, tilt=3.0, x=0.5, y=-0.5, z=1.2)
    emitter.emit(pose)
    assert len(transport.sent) == 1
    assert transport.sent[0] == encode_d1(pose, camera_id=5, scaling=scaling)
    assert len(transport.sent[0]) == 29


def test_freed_emitter_close_forwards():
    transport = FakeTransport()
    FreeDEmitter(transport).close()
    assert transport.closed is True
```

- [ ] **Step 2: 运行测试确认失败** — Run: `python -m pytest tests/test_freed_emitter.py -v`  Expected: FAIL (collection passes but no assertion yet — actually PASS-able; run to confirm green since FreeDEmitter already exists from Task 16). If green immediately, this task documents emitter behaviour; proceed to commit. Expected first run: PASS (3 passed)

- [ ] **Step 3: 最小实现** — 无需新增代码（`FreeDEmitter` 已在 Task 16 实现）。本任务为行为锁定测试。

- [ ] **Step 4: 运行测试确认通过** — Run: `python -m pytest tests/test_freed_emitter.py -v`  Expected: PASS (3 passed)

- [ ] **Step 5: 提交** — `git add tests/test_freed_emitter.py` then `git commit -m "test(emitters): lock FreeDEmitter send/close behaviour"`

### Task 18: OpenTrackIO build_sample（构造符合 schema 的样本字典）

**Files:**
- Create: `src/tracksim/emitters/opentrackio.py`
- Test: `tests/test_opentrackio_sample.py`

`build_sample` 构造一个 dict：`transforms[0]` 含 `translation` x/y/z（米）+ `rotation` pan/tilt/roll（度）+ `id="Camera"`；`lens` 含 `pinholeFocalLength`（mm，来自 `pose.focal_length`）与 `focusDistance`（m，来自 `pose.focus_distance`）；`timing` 含 `sampleTimestamp`（由 `pose.timestamp` 拆 seconds/nanoseconds）；顶层 `sampleId`/`sourceId`（`urn:uuid:` 格式）、`sourceNumber`、`protocol`（name=`"OpenTrackIO"`, version=`[1,0,1]`）；`static_meta` 浅合并进顶层（用于注入 `static` 块等）。schema 校验用 `docs/OpenTrackIO_JSON_schema.json`（dev 依赖 jsonschema）。

测试中 schema 路径通过环境定位（绝对路径常量），sampleId/sourceId 由 `sequence`/`source_number` 派生为确定的 urn-uuid，便于断言与 pattern 校验。

- [ ] **Step 1: 写失败测试**

```python
# tests/test_opentrackio_sample.py
import json
import re
from pathlib import Path

import jsonschema

from tracksim.domain.pose import CameraPose
from tracksim.emitters.opentrackio import build_sample

SCHEMA_PATH = Path(
    "/Users/bip.lan/AIWorkspace/vp/calibration/docs/OpenTrackIO_JSON_schema.json"
)
URN_RE = re.compile(
    r"^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)


def _schema():
    return json.loads(SCHEMA_PATH.read_text())


def test_build_sample_validates_against_schema():
    sample = build_sample(
        CameraPose(pan=10.0, tilt=-5.0, roll=0.0, x=1.0, y=2.0, z=1.5,
                   focal_length=24.305, focus_distance=10.0, timestamp=1.5),
        source_number=1,
        sequence=0,
        static_meta={},
    )
    jsonschema.validate(instance=sample, schema=_schema())


def test_build_sample_transform_and_lens_values():
    sample = build_sample(
        CameraPose(pan=10.0, tilt=-5.0, roll=2.5, x=1.0, y=-2.0, z=1.5,
                   focal_length=35.0, focus_distance=3.0),
        source_number=7,
        sequence=4,
        static_meta={},
    )
    tr = sample["transforms"][0]
    assert tr["id"] == "Camera"
    assert tr["translation"] == {"x": 1.0, "y": -2.0, "z": 1.5}
    assert tr["rotation"] == {"pan": 10.0, "tilt": -5.0, "roll": 2.5}
    assert sample["lens"]["pinholeFocalLength"] == 35.0
    assert sample["lens"]["focusDistance"] == 3.0
    assert sample["sourceNumber"] == 7
    assert sample["protocol"] == {"name": "OpenTrackIO", "version": [1, 0, 1]}
    assert URN_RE.match(sample["sampleId"])
    assert URN_RE.match(sample["sourceId"])


def test_build_sample_timestamp_split():
    sample = build_sample(
        CameraPose(timestamp=2.25),
        source_number=1,
        sequence=0,
        static_meta={},
    )
    ts = sample["timing"]["sampleTimestamp"]
    assert ts["seconds"] == 2
    assert ts["nanoseconds"] == 250000000


def test_build_sample_static_meta_merged():
    static = {"static": {"tracker": {"serialNumber": "ABC123"}}}
    sample = build_sample(
        CameraPose(),
        source_number=1,
        sequence=0,
        static_meta=static,
    )
    assert sample["static"]["tracker"]["serialNumber"] == "ABC123"
    jsonschema.validate(instance=sample, schema=_schema())


def test_build_sample_sequence_changes_sample_id():
    a = build_sample(CameraPose(), source_number=1, sequence=0, static_meta={})
    b = build_sample(CameraPose(), source_number=1, sequence=1, static_meta={})
    assert a["sampleId"] != b["sampleId"]
    assert a["sourceId"] == b["sourceId"]
```

- [ ] **Step 2: 运行测试确认失败** — Run: `python -m pytest tests/test_opentrackio_sample.py -v`  Expected: FAIL (`ModuleNotFoundError: No module named 'tracksim.emitters.opentrackio'`)

- [ ] **Step 3: 最小实现**

```python
# src/tracksim/emitters/opentrackio.py
import json
import struct
import uuid

from tracksim.checksum import fletcher16
from tracksim.domain.pose import CameraPose
from tracksim.ports.transport import Transport

OTRK_IDENTIFIER = b"OTrk"
OTRK_HEADER_LENGTH = 16
OTRK_MTU = 1500
OTRK_MAX_PAYLOAD_SIZE = OTRK_MTU - OTRK_HEADER_LENGTH
ENCODING_JSON = 0x01
ENCODING_CBOR = 0x02

PROTOCOL_NAME = "OpenTrackIO"
PROTOCOL_VERSION = [1, 0, 1]

_SOURCE_NS = uuid.UUID("6ba7b810-9dad-11d1-80b4-00c04fd430c8")


def _stable_uuid(name: str) -> str:
    return f"urn:uuid:{uuid.uuid5(_SOURCE_NS, name)}"


def build_sample(
    pose: CameraPose,
    *,
    source_number: int,
    sequence: int,
    static_meta: dict,
) -> dict:
    """Build an OpenTrackIO sample dict conforming to the JSON schema."""
    seconds = int(pose.timestamp)
    nanoseconds = int(round((pose.timestamp - seconds) * 1_000_000_000))

    sample: dict = {
        "protocol": {"name": PROTOCOL_NAME, "version": list(PROTOCOL_VERSION)},
        "sampleId": _stable_uuid(f"sample:{source_number}:{sequence}"),
        "sourceId": _stable_uuid(f"source:{source_number}"),
        "sourceNumber": source_number,
        "timing": {
            "sampleTimestamp": {
                "seconds": seconds,
                "nanoseconds": nanoseconds,
            }
        },
        "lens": {
            "pinholeFocalLength": pose.focal_length,
            "focusDistance": pose.focus_distance,
        },
        "transforms": [
            {
                "translation": {"x": pose.x, "y": pose.y, "z": pose.z},
                "rotation": {"pan": pose.pan, "tilt": pose.tilt, "roll": pose.roll},
                "id": "Camera",
            }
        ],
    }
    if static_meta:
        sample.update(static_meta)
    return sample


def build_packets(payload: bytes, *, encoding: int, sequence: int) -> list[bytes]:
    """Wrap a payload in one or more 16-byte OTrk-header UDP packets.

    Header layout (OpenTrackIO transport spec, copied from camdkit
    opentrackio_sender._construct_udp_header):
      [0:4]   identifier b"OTrk"
      [4]     reserved (0)
      [5]     encoding byte
      [6:8]   sequence number (uint16 BE)
      [8:12]  segment offset (uint32 BE)
      [12:14] (last_segment << 15) | payload_length (uint16 BE)
      [14:16] fletcher16(header[0:14] + payload) (uint16 BE)
    Segmentation occurs at OTRK_MAX_PAYLOAD_SIZE.
    """
    segments: list[bytes] = []
    total_length = len(payload)
    max_payload_size = OTRK_MAX_PAYLOAD_SIZE

    offsets = range(0, total_length, max_payload_size) if total_length else [0]
    for offset in offsets:
        segment_payload = payload[offset : offset + max_payload_size]
        last_segment = offset + max_payload_size >= total_length

        l_and_len = (int(last_segment) << 15) | len(segment_payload)
        header_wo_ck = (
            OTRK_IDENTIFIER
            + struct.pack("!B", 0)
            + struct.pack("!B", encoding)
            + struct.pack("!H", sequence & 0xFFFF)
            + struct.pack("!I", offset)
            + struct.pack("!H", l_and_len)
        )
        checksum = fletcher16(header_wo_ck + segment_payload)
        header = header_wo_ck + struct.pack("!H", checksum)
        segments.append(header + segment_payload)
        sequence = (sequence + 1) & 0xFFFF

    return segments


class OpenTrackIOEmitter:
    name = "opentrackio"

    def __init__(
        self,
        transport: Transport,
        *,
        source_number: int = 1,
        encoding: int = ENCODING_JSON,
        static_meta: dict | None = None,
    ) -> None:
        self._transport = transport
        self._source_number = source_number
        self._encoding = encoding
        self._static_meta = static_meta or {}
        self._sequence = 0

    def emit(self, pose: CameraPose) -> None:
        sample = build_sample(
            pose,
            source_number=self._source_number,
            sequence=self._sequence,
            static_meta=self._static_meta,
        )
        if self._encoding == ENCODING_CBOR:
            import cbor2

            payload = cbor2.dumps(sample)
        else:
            payload = json.dumps(sample).encode("utf-8")

        # OTrk sequence 是「每包」递增（对齐 camdkit 参考实现：接收端按 sequence 去重）。
        # build_packets 已为各分段分配连续 sequence，故发送后须按分段数推进 self._sequence；
        # 若只 +1，下一样本会复用上一样本后续分段的 sequence，污染分段重组（修复 F6）。
        packets = build_packets(payload, encoding=self._encoding, sequence=self._sequence)
        for packet in packets:
            self._transport.send(packet)
        self._sequence = (self._sequence + len(packets)) & 0xFFFF

    def close(self) -> None:
        self._transport.close()
```

- [ ] **Step 4: 运行测试确认通过** — Run: `python -m pytest tests/test_opentrackio_sample.py -v`  Expected: PASS (5 passed)

- [ ] **Step 5: 提交** — `git add src/tracksim/emitters/opentrackio.py tests/test_opentrackio_sample.py` then `git commit -m "feat(emitters): add OpenTrackIO build_sample schema-conformant builder"`

### Task 19: OpenTrackIO build_packets — OTrk 16 字节头 + fletcher16 + 分段

**Files:**
- Test: `tests/test_opentrackio_packets.py`

逐字段校验头布局（identifier / reserved / encoding / sequence / segment offset / last-flag+length / fletcher16），单段路径 `offset==0` 且 last-flag 置位；大 payload 触发多段，重组后等于原 payload，且 fletcher16 对 `header[:14]+payload` 自洽。

- [ ] **Step 1: 写失败测试**

```python
# tests/test_opentrackio_packets.py
import struct

from tracksim.checksum import fletcher16
from tracksim.emitters.opentrackio import (
    ENCODING_CBOR,
    ENCODING_JSON,
    OTRK_HEADER_LENGTH,
    OTRK_IDENTIFIER,
    OTRK_MAX_PAYLOAD_SIZE,
    build_packets,
)


def _parse_header(packet: bytes):
    assert packet[0:4] == OTRK_IDENTIFIER
    reserved = packet[4]
    encoding = packet[5]
    sequence = struct.unpack("!H", packet[6:8])[0]
    offset = struct.unpack("!I", packet[8:12])[0]
    l_and_len = struct.unpack("!H", packet[12:14])[0]
    last = bool(l_and_len >> 15)
    length = l_and_len & 0x7FFF
    checksum = struct.unpack("!H", packet[14:16])[0]
    payload = packet[16 : 16 + length]
    return reserved, encoding, sequence, offset, last, length, checksum, payload


def test_single_segment_header_fields():
    payload = b'{"a":1}'
    packets = build_packets(payload, encoding=ENCODING_JSON, sequence=42)
    assert len(packets) == 1
    reserved, encoding, seq, offset, last, length, ck, body = _parse_header(packets[0])
    assert reserved == 0
    assert encoding == ENCODING_JSON
    assert seq == 42
    assert offset == 0
    assert last is True
    assert length == len(payload)
    assert body == payload


def test_single_segment_fletcher16_self_consistent():
    payload = b"hello-opentrackio"
    packet = build_packets(payload, encoding=ENCODING_CBOR, sequence=1)[0]
    header_wo_ck = packet[0:14]
    body = packet[16:]
    ck = struct.unpack("!H", packet[14:16])[0]
    assert ck == fletcher16(header_wo_ck + body)
    assert struct.unpack("!H", packet[14:16])[0] != 0


def test_large_payload_segments_and_reassembles():
    payload = bytes((i % 251) for i in range(OTRK_MAX_PAYLOAD_SIZE * 2 + 100))
    packets = build_packets(payload, encoding=ENCODING_JSON, sequence=10)
    assert len(packets) == 3

    # sequence increments per segment
    seqs = [struct.unpack("!H", p[6:8])[0] for p in packets]
    assert seqs == [10, 11, 12]

    # last flag only on final segment
    flags = [bool(struct.unpack("!H", p[12:14])[0] >> 15) for p in packets]
    assert flags == [False, False, True]

    # reassemble by segment offset
    reassembled = bytearray()
    for p in packets:
        _, _, _, offset, _, length, _, body = _parse_header(p)
        assert offset == len(reassembled)
        reassembled += body
    assert bytes(reassembled) == payload


def test_packet_total_size_within_mtu():
    payload = bytes(OTRK_MAX_PAYLOAD_SIZE)
    packets = build_packets(payload, encoding=ENCODING_JSON, sequence=0)
    assert len(packets) == 1
    assert len(packets[0]) == OTRK_HEADER_LENGTH + OTRK_MAX_PAYLOAD_SIZE
```

- [ ] **Step 2: 运行测试确认失败** — Run: `python -m pytest tests/test_opentrackio_packets.py -v`  Expected: FAIL (first run will PASS because `build_packets` was implemented in Task 18; if so this task documents/locks the wire format). Expected: PASS (4 passed)

- [ ] **Step 3: 最小实现** — 无需新增代码（`build_packets` 已在 Task 18 实现）。本任务锁定 OTrk 线格式。

- [ ] **Step 4: 运行测试确认通过** — Run: `python -m pytest tests/test_opentrackio_packets.py -v`  Expected: PASS (4 passed)

- [ ] **Step 5: 提交** — `git add tests/test_opentrackio_packets.py` then `git commit -m "test(emitters): lock OTrk header layout, fletcher16, and segmentation"`

### Task 20: OpenTrackIOEmitter — JSON 与 CBOR 发送路径

**Files:**
- Test: `tests/test_opentrackio_emitter.py`

验证 `name=="opentrackio"`；JSON 路径下发出的 packet 去头后 JSON 解析得回 `build_sample` 的内容；CBOR 路径下 packet header 的 encoding 字节为 `ENCODING_CBOR` 且 `cbor2.loads(body)` 还原样本；多次 emit 时 sequence 递增；`close()` 转发到 transport。

- [ ] **Step 1: 写失败测试**

```python
# tests/test_opentrackio_emitter.py
import json
import struct

import cbor2

from tracksim.domain.pose import CameraPose
from tracksim.emitters.opentrackio import (
    ENCODING_CBOR,
    ENCODING_JSON,
    OpenTrackIOEmitter,
)


class FakeTransport:
    def __init__(self) -> None:
        self.sent: list[bytes] = []
        self.closed = False

    def send(self, data: bytes) -> None:
        self.sent.append(data)

    def close(self) -> None:
        self.closed = True


def _body(packet: bytes) -> bytes:
    length = struct.unpack("!H", packet[12:14])[0] & 0x7FFF
    return packet[16 : 16 + length]


def test_opentrackio_emitter_name():
    assert OpenTrackIOEmitter(FakeTransport()).name == "opentrackio"


def test_json_emit_roundtrips_sample():
    transport = FakeTransport()
    emitter = OpenTrackIOEmitter(transport, source_number=3, encoding=ENCODING_JSON)
    emitter.emit(CameraPose(pan=10.0, x=1.0, z=1.5))
    assert len(transport.sent) == 1
    packet = transport.sent[0]
    assert packet[5] == ENCODING_JSON
    sample = json.loads(_body(packet))
    assert sample["sourceNumber"] == 3
    assert sample["transforms"][0]["rotation"]["pan"] == 10.0
    assert sample["transforms"][0]["translation"]["x"] == 1.0


def test_cbor_emit_roundtrips_sample():
    transport = FakeTransport()
    emitter = OpenTrackIOEmitter(transport, source_number=2, encoding=ENCODING_CBOR)
    emitter.emit(CameraPose(tilt=-5.0, z=1.2))
    packet = transport.sent[0]
    assert packet[5] == ENCODING_CBOR
    sample = cbor2.loads(_body(packet))
    assert sample["sourceNumber"] == 2
    assert sample["transforms"][0]["rotation"]["tilt"] == -5.0


def test_sequence_increments_across_emits():
    transport = FakeTransport()
    emitter = OpenTrackIOEmitter(transport, encoding=ENCODING_JSON)
    emitter.emit(CameraPose())
    emitter.emit(CameraPose())
    seq0 = struct.unpack("!H", transport.sent[0][6:8])[0]
    seq1 = struct.unpack("!H", transport.sent[1][6:8])[0]
    assert seq1 == seq0 + 1


def test_multi_segment_samples_have_unique_monotonic_sequences():
    # 防回归 F6：超过单包的样本会分多段；跨样本所有分段的 sequence 必须唯一且连续递增，
    # 不得复用上一样本后续分段的 sequence（否则接收端按 sequence 去重时会丢包）。
    transport = FakeTransport()
    big = {"blob": "x" * 8000}  # 使 JSON payload 远超 OTRK_MTU，强制分段
    emitter = OpenTrackIOEmitter(transport, encoding=ENCODING_JSON, static_meta=big)
    emitter.emit(CameraPose())
    emitter.emit(CameraPose())
    assert len(transport.sent) > 2  # 至少两个样本、每样本多段
    seqs = [struct.unpack("!H", p[6:8])[0] for p in transport.sent]
    assert len(seqs) == len(set(seqs)), f"sequence reuse across samples: {seqs}"
    assert seqs == list(range(seqs[0], seqs[0] + len(seqs)))  # 连续单调递增


def test_close_forwards():
    transport = FakeTransport()
    OpenTrackIOEmitter(transport).close()
    assert transport.closed is True
```

- [ ] **Step 2: 运行测试确认失败** — Run: `python -m pytest tests/test_opentrackio_emitter.py -v`  Expected: FAIL on first authoring if `OpenTrackIOEmitter` were absent; since it was added in Task 18, run to confirm — Expected: PASS (6 passed)

- [ ] **Step 3: 最小实现** — 无需新增代码（`OpenTrackIOEmitter` 已在 Task 18 实现）。本任务锁定 JSON/CBOR 发送行为。

- [ ] **Step 4: 运行测试确认通过** — Run: `python -m pytest tests/test_opentrackio_emitter.py -v`  Expected: PASS (6 passed)

- [ ] **Step 5: 提交** — `git add tests/test_opentrackio_emitter.py` then `git commit -m "test(emitters): lock OpenTrackIOEmitter JSON and CBOR send paths"`

### Task 21: StaticPoseSource（固定位姿来源）

固定位姿来源：每次 `next(dt)` 返回 base pose 的拷贝，`frame` 自增 1、`timestamp` 累加 `dt`，其余字段原样保留；`close()` 为 no-op。

**Files:**
- `src/tracksim/sources/static.py`
- `src/tracksim/sources/__init__.py`
- `tests/sources/test_static.py`

- [ ] **Step 1: 写失败测试**

```python
# tests/sources/test_static.py
from tracksim.domain.pose import CameraPose
from tracksim.sources.static import StaticPoseSource


def test_static_next_increments_frame_and_timestamp():
    base = CameraPose(pan=12.0, tilt=-3.0, x=1.5, focal_length=50.0)
    source = StaticPoseSource(base)

    first = source.next(0.1)
    assert first.frame == 1
    assert first.timestamp == 0.1
    assert first.pan == 12.0
    assert first.tilt == -3.0
    assert first.x == 1.5
    assert first.focal_length == 50.0

    second = source.next(0.1)
    assert second.frame == 2
    assert second.timestamp == 0.2
    assert second.pan == 12.0
    assert second.tilt == -3.0
    assert second.x == 1.5
    assert second.focal_length == 50.0

    source.close()
```

- [ ] **Step 2: 运行测试确认失败** — Run: `python -m pytest tests/sources/test_static.py::test_static_next_increments_frame_and_timestamp -v`  Expected: FAIL（`ModuleNotFoundError: No module named 'tracksim.sources.static'`）

- [ ] **Step 3: 最小实现**

```python
# src/tracksim/sources/__init__.py
```

```python
# src/tracksim/sources/static.py
from __future__ import annotations

from tracksim.domain.pose import CameraPose
from tracksim.ports.clock import Clock


class StaticPoseSource:
    """Pose source that returns a fixed pose, advancing frame/timestamp."""

    def __init__(self, pose: CameraPose, clock: Clock | None = None) -> None:
        self._pose = pose
        self._clock = clock
        self._frame = 0
        self._timestamp = 0.0

    def next(self, dt: float) -> CameraPose:
        self._frame += 1
        self._timestamp += dt
        return self._pose.model_copy(
            update={"frame": self._frame, "timestamp": self._timestamp}
        )

    def close(self) -> None:
        return None
```

- [ ] **Step 4: 运行测试确认通过** — Run: `python -m pytest tests/sources/test_static.py::test_static_next_increments_frame_and_timestamp -v`  Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/tracksim/sources/__init__.py src/tracksim/sources/static.py tests/sources/test_static.py
git commit -m "feat(sources): add StaticPoseSource"
```

---

### Task 22: ScriptedPoseSource（程序化运动 + 关键帧轨迹）

脚本化位姿来源：支持程序化运动（`static` / `orbit` / `sine` / `sweep`），以及 `from_keyframes` 关键帧线性插值。空轨迹或缺 `t`/`pose` 字段抛 `InvalidTrajectoryError`。

**Files:**
- `src/tracksim/sources/scripted.py`
- `tests/sources/test_scripted.py`

- [ ] **Step 1: 写失败测试**

```python
# tests/sources/test_scripted.py
import math

import pytest

from tracksim.domain.errors import InvalidTrajectoryError
from tracksim.sources.scripted import ScriptedPoseSource


def test_orbit_motion_at_known_phase():
    source = ScriptedPoseSource(motion="orbit", radius=2.0, speed=1.0)
    pose = source.next(math.pi / 2.0)
    # phase = speed * dt = pi/2 -> x = radius*cos, y = radius*sin
    assert pose.x == pytest.approx(2.0 * math.cos(math.pi / 2.0), abs=1e-9)
    assert pose.y == pytest.approx(2.0 * math.sin(math.pi / 2.0), abs=1e-9)
    assert pose.frame == 1
    assert pose.timestamp == pytest.approx(math.pi / 2.0)


def test_sine_motion_at_known_phase():
    source = ScriptedPoseSource(
        motion="sine", amplitude=10.0, freq=1.0, axis="pan"
    )
    pose = source.next(0.25)
    # phase = dt = 0.25 -> pan = amplitude * sin(2*pi*freq*phase)
    assert pose.pan == pytest.approx(10.0 * math.sin(2.0 * math.pi * 0.25), abs=1e-9)


def test_from_keyframes_interpolates_midpoint():
    frames = [
        {"t": 0.0, "pose": {"pan": 0.0, "x": 0.0}},
        {"t": 1.0, "pose": {"pan": 10.0, "x": 2.0}},
    ]
    source = ScriptedPoseSource.from_keyframes(frames)
    pose = source.next(0.5)
    assert pose.pan == pytest.approx(5.0, abs=1e-9)
    assert pose.x == pytest.approx(1.0, abs=1e-9)
    assert pose.frame == 1
    assert pose.timestamp == pytest.approx(0.5)


def test_from_keyframes_clamps_at_end():
    frames = [
        {"t": 0.0, "pose": {"pan": 0.0}},
        {"t": 1.0, "pose": {"pan": 10.0}},
    ]
    source = ScriptedPoseSource.from_keyframes(frames)
    pose = source.next(5.0)
    assert pose.pan == pytest.approx(10.0, abs=1e-9)


def test_from_keyframes_empty_raises():
    with pytest.raises(InvalidTrajectoryError):
        ScriptedPoseSource.from_keyframes([])


def test_from_keyframes_malformed_raises():
    with pytest.raises(InvalidTrajectoryError):
        ScriptedPoseSource.from_keyframes([{"t": 0.0}])


def test_scripted_accepts_rate_and_clock():
    # factory 会传 rate/clock；构造必须接受且 rate 写入每帧 pose（防回归 F4 签名不匹配）
    source = ScriptedPoseSource(motion="static", rate=50.0, clock=None)
    pose = source.next(0.1)
    assert pose.rate == 50.0


def test_from_keyframes_accepts_rate():
    frames = [{"t": 0.0, "pose": {"pan": 0.0}}, {"t": 1.0, "pose": {"pan": 10.0}}]
    source = ScriptedPoseSource.from_keyframes(frames, rate=30.0)
    assert source.next(0.5).rate == 30.0
```

- [ ] **Step 2: 运行测试确认失败** — Run: `python -m pytest tests/sources/test_scripted.py -v`  Expected: FAIL（`ModuleNotFoundError: No module named 'tracksim.sources.scripted'`）

- [ ] **Step 3: 最小实现**

```python
# src/tracksim/sources/scripted.py
from __future__ import annotations

import math
from typing import Any

from tracksim.domain.errors import InvalidTrajectoryError
from tracksim.domain.pose import CameraPose
from tracksim.ports.clock import Clock


class ScriptedPoseSource:
    """Procedural / keyframe pose source.

    `rate` 与 `clock` 与 StaticPoseSource 保持一致的构造契约（factory 会传入）：
    rate 写入每帧 CameraPose.rate；clock 作为可选依赖保留（按 dt 推进，无需墙钟）。
    """

    def __init__(
        self,
        motion: str = "static",
        radius: float = 1.0,
        speed: float = 1.0,
        amplitude: float = 10.0,
        freq: float = 1.0,
        axis: str = "pan",
        rate: float = 60.0,
        clock: Clock | None = None,
    ) -> None:
        self._motion = motion
        self._radius = radius
        self._speed = speed
        self._amplitude = amplitude
        self._freq = freq
        self._axis = axis
        self._rate = rate
        self._clock = clock
        self._keyframes: list[tuple[float, CameraPose]] | None = None
        self._phase = 0.0
        self._cursor = 0.0
        self._frame = 0
        self._timestamp = 0.0

    @classmethod
    def from_keyframes(
        cls,
        frames: list[dict],
        *,
        rate: float = 60.0,
        clock: Clock | None = None,
    ) -> "ScriptedPoseSource":
        if not frames:
            raise InvalidTrajectoryError("keyframe list is empty")
        keyframes: list[tuple[float, CameraPose]] = []
        for frame in frames:
            if "t" not in frame or "pose" not in frame:
                raise InvalidTrajectoryError(
                    "each keyframe must have 't' and 'pose'"
                )
            keyframes.append((float(frame["t"]), CameraPose(**frame["pose"])))
        keyframes.sort(key=lambda kf: kf[0])
        source = cls(motion="keyframes", rate=rate, clock=clock)
        source._keyframes = keyframes
        return source

    def next(self, dt: float) -> CameraPose:
        self._frame += 1
        self._timestamp += dt
        if self._keyframes is not None:
            self._cursor += dt
            pose = self._interpolate(self._cursor)
        else:
            pose = self._procedural(dt)
        return pose.model_copy(
            update={
                "frame": self._frame,
                "timestamp": self._timestamp,
                "rate": self._rate,
            }
        )

    def _procedural(self, dt: float) -> CameraPose:
        if self._motion == "orbit":
            self._phase += self._speed * dt
            return CameraPose(
                x=self._radius * math.cos(self._phase),
                y=self._radius * math.sin(self._phase),
            )
        if self._motion == "sine":
            self._phase += dt
            value = self._amplitude * math.sin(
                2.0 * math.pi * self._freq * self._phase
            )
            return CameraPose(**{self._axis: value})
        if self._motion == "sweep":
            self._phase += self._speed * dt
            return CameraPose(**{self._axis: self._phase})
        return CameraPose()

    def _interpolate(self, t: float) -> CameraPose:
        assert self._keyframes is not None
        keyframes = self._keyframes
        if t <= keyframes[0][0]:
            return keyframes[0][1]
        if t >= keyframes[-1][0]:
            return keyframes[-1][1]
        for i in range(len(keyframes) - 1):
            t0, p0 = keyframes[i]
            t1, p1 = keyframes[i + 1]
            if t0 <= t <= t1:
                span = t1 - t0
                ratio = 0.0 if span == 0 else (t - t0) / span
                return self._lerp_pose(p0, p1, ratio)
        return keyframes[-1][1]

    @staticmethod
    def _lerp_pose(p0: CameraPose, p1: CameraPose, ratio: float) -> CameraPose:
        fields = ["pan", "tilt", "roll", "x", "y", "z", "focal_length", "focus_distance"]
        update: dict[str, Any] = {}
        for name in fields:
            v0 = getattr(p0, name)
            v1 = getattr(p1, name)
            update[name] = v0 + (v1 - v0) * ratio
        return p0.model_copy(update=update)

    def close(self) -> None:
        return None
```

- [ ] **Step 4: 运行测试确认通过** — Run: `python -m pytest tests/sources/test_scripted.py -v`  Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/tracksim/sources/scripted.py tests/sources/test_scripted.py
git commit -m "feat(sources): add ScriptedPoseSource with procedural motion and keyframes"
```

---

### Task 23: ControllerPoseSource（手柄驱动位姿来源）

手柄位姿来源：每 tick 轮询手柄状态，断开抛 `NoControllerError`；按映射表读轴值，应用死区/反向，`rate` 模式积分、`absolute` 模式直设，再按 `clamp_min`/`clamp_max` 钳制，构造 `CameraPose`（`frame` 自增、`timestamp` 累加）。`close()` 转发到 controller。

**Files:**
- `src/tracksim/sources/controller.py`
- `tests/sources/test_controller.py`

- [ ] **Step 1: 写失败测试**

```python
# tests/sources/test_controller.py
from dataclasses import dataclass

import pytest

from tracksim.domain.errors import NoControllerError
from tracksim.ports.controller_input import ControllerState
from tracksim.sources.controller import ControllerPoseSource


@dataclass
class MapEntry:
    channel: str
    source: str
    mode: str
    scale: float
    deadzone: float
    invert: bool
    # 默认 None，与 config 的 ControllerMappingEntry 一致（省略 clamp 即不钳制）
    clamp_min: float | None = None
    clamp_max: float | None = None


class FakeControllerInput:
    """Scripted ControllerInput returning a queued list of states."""

    def __init__(self, states: list[ControllerState]) -> None:
        self._states = states
        self._index = 0
        self.closed = False

    def list_devices(self):
        return []

    def open(self, index: int) -> None:
        return None

    def poll(self) -> ControllerState:
        state = self._states[min(self._index, len(self._states) - 1)]
        self._index += 1
        return state

    def close(self) -> None:
        self.closed = True


class StubClock:
    def now(self) -> float:
        return 0.0

    def sleep(self, seconds: float) -> None:
        return None


def _connected(axes):
    return ControllerState(axes=axes, buttons={}, connected=True)


def test_rate_mode_integrates_over_three_ticks():
    states = [_connected({"rightx": 1.0}) for _ in range(3)]
    controller = FakeControllerInput(states)
    mapping = [
        MapEntry(
            channel="pan",
            source="rightx",
            mode="rate",
            scale=10.0,
            deadzone=0.0,
            invert=False,
            clamp_min=-1000.0,
            clamp_max=1000.0,
        )
    ]
    source = ControllerPoseSource(controller, mapping, StubClock())

    source.next(0.1)
    source.next(0.1)
    pose = source.next(0.1)
    # 1.0 * 10.0 * 0.1 per tick * 3 ticks = 3.0
    assert pose.pan == pytest.approx(3.0, abs=1e-9)
    assert pose.frame == 3
    assert pose.timestamp == pytest.approx(0.3)


def test_deadzone_zeroes_small_value():
    controller = FakeControllerInput([_connected({"rightx": 0.05})])
    mapping = [
        MapEntry(
            channel="pan",
            source="rightx",
            mode="rate",
            scale=10.0,
            deadzone=0.1,
            invert=False,
            clamp_min=-1000.0,
            clamp_max=1000.0,
        )
    ]
    source = ControllerPoseSource(controller, mapping, StubClock())
    pose = source.next(0.1)
    assert pose.pan == pytest.approx(0.0, abs=1e-9)


def test_clamp_caps_at_clamp_max():
    controller = FakeControllerInput([_connected({"leftx": 1.0})])
    mapping = [
        MapEntry(
            channel="x",
            source="leftx",
            mode="absolute",
            scale=100.0,
            deadzone=0.0,
            invert=False,
            clamp_min=-5.0,
            clamp_max=5.0,
        )
    ]
    source = ControllerPoseSource(controller, mapping, StubClock())
    pose = source.next(0.1)
    # absolute: 1.0 * 100.0 = 100.0 -> clamped to 5.0
    assert pose.x == pytest.approx(5.0, abs=1e-9)


def test_no_controller_error_when_disconnected():
    state = ControllerState(axes={}, buttons={}, connected=False)
    controller = FakeControllerInput([state])
    source = ControllerPoseSource(controller, [], StubClock())
    with pytest.raises(NoControllerError):
        source.next(0.1)


def test_close_forwards_to_controller():
    controller = FakeControllerInput([_connected({})])
    source = ControllerPoseSource(controller, [], StubClock())
    source.close()
    assert controller.closed is True


def test_mapping_without_clamps_does_not_crash():
    # 防回归 F7：clamp_min/clamp_max 省略（默认 None）时不得对 None 调 min/max 抛 TypeError，
    # 应原样透传（不钳制）
    controller = FakeControllerInput([_connected({"leftx": 1.0})])
    mapping = [
        MapEntry(
            channel="x",
            source="leftx",
            mode="absolute",
            scale=10.0,
            deadzone=0.0,
            invert=False,
        )  # clamp_min / clamp_max 省略 -> None
    ]
    source = ControllerPoseSource(controller, mapping, StubClock())
    pose = source.next(0.1)
    assert pose.x == pytest.approx(10.0, abs=1e-9)
```

- [ ] **Step 2: 运行测试确认失败** — Run: `python -m pytest tests/sources/test_controller.py -v`  Expected: FAIL（`ModuleNotFoundError: No module named 'tracksim.sources.controller'`）

- [ ] **Step 3: 最小实现**

```python
# src/tracksim/sources/controller.py
from __future__ import annotations

from typing import Iterable

from tracksim.domain.errors import NoControllerError
from tracksim.domain.pose import CameraPose
from tracksim.ports.clock import Clock
from tracksim.ports.controller_input import ControllerInput


class ControllerPoseSource:
    """Pose source driven by a ControllerInput via a channel mapping."""

    def __init__(
        self,
        controller: ControllerInput,
        mapping: Iterable,
        clock: Clock,
    ) -> None:
        self._controller = controller
        self._mapping = list(mapping)
        self._clock = clock
        self._channels: dict[str, float] = {}
        self._frame = 0
        self._timestamp = 0.0

    def next(self, dt: float) -> CameraPose:
        state = self._controller.poll()
        if not state.connected:
            raise NoControllerError("controller is not connected")

        for entry in self._mapping:
            value = state.axes.get(entry.source, 0.0)
            if abs(value) < entry.deadzone:
                value = 0.0
            if entry.invert:
                value = -value

            if entry.mode == "rate":
                current = self._channels.get(entry.channel, 0.0)
                current += value * entry.scale * dt
            else:  # "absolute"
                current = value * entry.scale

            # clamp_min/clamp_max 在 config 中默认 None（不钳制）；用 ±inf 兜底，
            # 避免对 None 调用 min/max 抛 TypeError（修复 F7）。
            lo = entry.clamp_min if entry.clamp_min is not None else float("-inf")
            hi = entry.clamp_max if entry.clamp_max is not None else float("inf")
            current = max(lo, min(hi, current))
            self._channels[entry.channel] = current

        self._frame += 1
        self._timestamp += dt
        return CameraPose(
            **self._channels,
            frame=self._frame,
            timestamp=self._timestamp,
        )

    def close(self) -> None:
        self._controller.close()
```

- [ ] **Step 4: 运行测试确认通过** — Run: `python -m pytest tests/sources/test_controller.py -v`  Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/tracksim/sources/controller.py tests/sources/test_controller.py
git commit -m "feat(sources): add ControllerPoseSource with rate/absolute mapping"
```

### Task 24: WallClock 实现（真实时钟）

**Files:** Create `src/tracksim/infra/__init__.py`; Create `src/tracksim/infra/clock.py`; Test `tests/test_infra_clock.py`

- [ ] **Step 1: 写失败测试** — 先验证 `WallClock` 满足 `Clock` 协议（`now()` 单调递增、`sleep()` 真实推进墙钟）。

```python
# tests/test_infra_clock.py
import time

from tracksim.infra.clock import WallClock


def test_wallclock_now_monotonic_nondecreasing():
    clock = WallClock()
    t0 = clock.now()
    t1 = clock.now()
    assert isinstance(t0, float)
    assert t1 >= t0


def test_wallclock_sleep_advances_real_time():
    clock = WallClock()
    start = time.monotonic()
    clock.sleep(0.02)
    elapsed = time.monotonic() - start
    assert elapsed >= 0.015
```

- [ ] **Step 2: 运行测试确认失败** — Run: `python -m pytest tests/test_infra_clock.py -v`  Expected: FAIL（`ModuleNotFoundError: No module named 'tracksim.infra'`，包与模块尚未创建）

- [ ] **Step 3: 最小实现** — 创建 `infra` 包与 `WallClock`。`WallClock` 不持状态，`now()` 直接代理 `time.monotonic()`，`sleep()` 代理 `time.sleep()`；`sleep(0)` / 负值短路避免无意义调用。

```python
# src/tracksim/infra/__init__.py
```

```python
# src/tracksim/infra/clock.py
"""Clock implementations: real wall clock + deterministic fake."""

from __future__ import annotations

import time


class WallClock:
    """Real monotonic wall clock used for live frame pacing."""

    def now(self) -> float:
        return time.monotonic()

    def sleep(self, seconds: float) -> None:
        if seconds <= 0.0:
            return
        time.sleep(seconds)


class FakeClock:
    """Deterministic clock for tests; sleep advances a virtual time base."""

    def __init__(self, start: float = 0.0) -> None:
        self._t = float(start)

    def now(self) -> float:
        return self._t

    def sleep(self, seconds: float) -> None:
        if seconds <= 0.0:
            return
        self._t += float(seconds)

    def advance(self, seconds: float) -> None:
        self._t += float(seconds)
```

- [ ] **Step 4: 运行测试确认通过** — Run: `python -m pytest tests/test_infra_clock.py -v`  Expected: PASS（2 passed）

- [ ] **Step 5: 提交**

```
git add src/tracksim/infra/__init__.py src/tracksim/infra/clock.py tests/test_infra_clock.py
git commit -m "feat(infra): add WallClock implementing Clock port"
```

### Task 25: FakeClock 确定性时钟

**Files:** Modify `src/tracksim/infra/clock.py`（`FakeClock` 已在 Task 24 写入，本任务补测试锁定确定性语义）; Test `tests/test_infra_fakeclock.py`

- [ ] **Step 1: 写失败测试** — 验证 `FakeClock`：`now()` 返回内部 `t`、`sleep(s)` 把 `t` 推进 `s`、`advance(s)` helper 同样推进、`now()` 不消耗真实时间、`start` 参数生效、负/零 `sleep` 不倒退。

```python
# tests/test_infra_fakeclock.py
import time

from tracksim.infra.clock import FakeClock


def test_fakeclock_starts_at_zero_by_default():
    clock = FakeClock()
    assert clock.now() == 0.0


def test_fakeclock_honors_start():
    clock = FakeClock(start=10.0)
    assert clock.now() == 10.0


def test_fakeclock_sleep_advances_virtual_time():
    clock = FakeClock()
    clock.sleep(0.5)
    clock.sleep(0.25)
    assert clock.now() == 0.75


def test_fakeclock_advance_helper():
    clock = FakeClock(start=1.0)
    clock.advance(2.0)
    assert clock.now() == 3.0


def test_fakeclock_now_consumes_no_real_time():
    clock = FakeClock()
    start = time.monotonic()
    for _ in range(1000):
        clock.now()
    assert time.monotonic() - start < 0.05


def test_fakeclock_nonpositive_sleep_does_not_move_time():
    clock = FakeClock(start=5.0)
    clock.sleep(0.0)
    clock.sleep(-1.0)
    assert clock.now() == 5.0
```

- [ ] **Step 2: 运行测试确认失败** — Run: `python -m pytest tests/test_infra_fakeclock.py -v`  Expected: 若严格先写测试则全部 PASS（`FakeClock` 在 Task 24 已实现）；如本任务独立验证假设 `FakeClock` 缺失，则 FAIL（`ImportError: cannot import name 'FakeClock'`）。本任务以"锁定语义"为目标，运行后应观察到 6 passed。

- [ ] **Step 3: 最小实现** — 无需改动（`FakeClock` 已在 Task 24 的 `clock.py` 中实现，语义已满足所有断言）。若上一步出现 FAIL，则补回如下实现至 `src/tracksim/infra/clock.py`：

```python
class FakeClock:
    """Deterministic clock for tests; sleep advances a virtual time base."""

    def __init__(self, start: float = 0.0) -> None:
        self._t = float(start)

    def now(self) -> float:
        return self._t

    def sleep(self, seconds: float) -> None:
        if seconds <= 0.0:
            return
        self._t += float(seconds)

    def advance(self, seconds: float) -> None:
        self._t += float(seconds)
```

- [ ] **Step 4: 运行测试确认通过** — Run: `python -m pytest tests/test_infra_fakeclock.py -v`  Expected: PASS（6 passed）

- [ ] **Step 5: 提交**

```
git add src/tracksim/infra/clock.py tests/test_infra_fakeclock.py
git commit -m "test(infra): lock FakeClock deterministic semantics"
```

### Task 26: SDLControllerInput — SDL3 库可用性 smoke 测试

**Files:** Create `tests/test_sdl_smoke.py`

- [ ] **Step 1: 写失败测试** — 仅当 `sdl3` 可导入时运行：直接验证 `SDL_Init(SDL_INIT_GAMEPAD)` 成功并 `SDL_Quit`；库不存在则整文件 skip。该测试证明运行环境的 SDL3 二进制可加载（design §3.2 "实现期确认"），不依赖真实手柄。

```python
# tests/test_sdl_smoke.py
import pytest

sdl3 = pytest.importorskip("sdl3")


def test_sdl_init_gamepad_subsystem_then_quit():
    rc = sdl3.SDL_Init(sdl3.SDL_INIT_GAMEPAD)
    try:
        # SDL3 returns True on success; older bindings may return 0.
        assert rc in (True, 0, 1)
    finally:
        sdl3.SDL_Quit()
```

- [ ] **Step 2: 运行测试确认失败** — Run: `python -m pytest tests/test_sdl_smoke.py -v`  Expected: 若环境未装 `sdl3` / 无 SDL3 二进制则 SKIPPED（`importorskip`）；若已装则 PASS。该 smoke 测试本身不依赖被测代码，作为环境就绪门禁存在——在无库环境下表现为 1 skipped。

- [ ] **Step 3: 最小实现** — 无被测实现代码（纯环境 smoke 测试）。仅确认 `pysdl3` 已在运行时依赖中声明（见 SHARED CONTRACT runtime deps），无需新增源码。

- [ ] **Step 4: 运行测试确认通过** — Run: `python -m pytest tests/test_sdl_smoke.py -v`  Expected: PASS or SKIPPED（无 SDL3 库时 1 skipped；有库时 1 passed）

- [ ] **Step 5: 提交**

```
git add tests/test_sdl_smoke.py
git commit -m "test(infra): add SDL3 library availability smoke test"
```

### Task 27: SDLControllerInput — list_devices / open NoControllerError 行为

**Files:** Create `src/tracksim/infra/sdl_controller.py`; Test `tests/test_sdl_controller.py`

- [ ] **Step 1: 写失败测试** — 用 monkeypatch 注入一个伪 `sdl3` 模块（避免依赖真实库与硬件），验证：`list_devices()` 把 `SDL_GetGamepads` 返回的 id 列表映射成 `ControllerDevice(index, name, guid)`；空设备时 `open(0)` 抛 `NoControllerError`；`open(index)` 越界同样抛 `NoControllerError`；`open` 成功后保存句柄。`ControllerDevice` 来自 `ports.controller_input`，`NoControllerError` 来自 `domain.errors`。

```python
# tests/test_sdl_controller.py
import sys
import types

import pytest

from tracksim.domain.errors import NoControllerError
from tracksim.ports.controller_input import ControllerDevice


def _install_fake_sdl3(monkeypatch, *, gamepad_ids):
    """Install a minimal fake `sdl3` module covering the ~10 functions used."""
    mod = types.ModuleType("sdl3")

    # constants
    mod.SDL_INIT_GAMEPAD = 0x2000
    mod.SDL_GAMEPAD_AXIS_LEFTX = 0
    mod.SDL_GAMEPAD_AXIS_LEFTY = 1
    mod.SDL_GAMEPAD_AXIS_RIGHTX = 2
    mod.SDL_GAMEPAD_AXIS_RIGHTY = 3
    mod.SDL_GAMEPAD_AXIS_LEFT_TRIGGER = 4
    mod.SDL_GAMEPAD_AXIS_RIGHT_TRIGGER = 5
    mod.SDL_GAMEPAD_BUTTON_SOUTH = 0
    mod.SDL_GAMEPAD_BUTTON_EAST = 1
    mod.SDL_GAMEPAD_BUTTON_WEST = 2
    mod.SDL_GAMEPAD_BUTTON_NORTH = 3
    mod.SDL_GAMEPAD_BUTTON_LEFT_SHOULDER = 9
    mod.SDL_GAMEPAD_BUTTON_RIGHT_SHOULDER = 10
    mod.SDL_GAMEPAD_BUTTON_BACK = 4
    mod.SDL_GAMEPAD_BUTTON_START = 6

    state = {"init": False, "opened": None, "axes": {}, "buttons": {}}

    def SDL_Init(flags):
        state["init"] = True
        return True

    def SDL_Quit():
        state["init"] = False

    def SDL_GetGamepads(count_ptr=None):
        return list(gamepad_ids)

    def SDL_OpenGamepad(instance_id):
        state["opened"] = instance_id
        return ("gp", instance_id)

    def SDL_CloseGamepad(gp):
        state["opened"] = None

    def SDL_UpdateGamepads():
        return None

    def SDL_GetGamepadName(gp):
        return b"Fake Xbox Pad"

    def SDL_GetGamepadNameForID(instance_id):
        return b"Fake Xbox Pad"

    def SDL_GetGamepadGUIDForID(instance_id):
        return b"0303" + bytes(str(instance_id), "ascii")

    def SDL_GetGamepadAxis(gp, axis):
        return state["axes"].get(axis, 0)

    def SDL_GetGamepadButton(gp, button):
        return state["buttons"].get(button, False)

    mod.SDL_Init = SDL_Init
    mod.SDL_Quit = SDL_Quit
    mod.SDL_GetGamepads = SDL_GetGamepads
    mod.SDL_OpenGamepad = SDL_OpenGamepad
    mod.SDL_CloseGamepad = SDL_CloseGamepad
    mod.SDL_UpdateGamepads = SDL_UpdateGamepads
    mod.SDL_GetGamepadName = SDL_GetGamepadName
    mod.SDL_GetGamepadNameForID = SDL_GetGamepadNameForID
    mod.SDL_GetGamepadGUIDForID = SDL_GetGamepadGUIDForID
    mod.SDL_GetGamepadAxis = SDL_GetGamepadAxis
    mod.SDL_GetGamepadButton = SDL_GetGamepadButton

    monkeypatch.setitem(sys.modules, "sdl3", mod)
    return mod, state


def test_list_devices_maps_gamepad_ids(monkeypatch):
    _install_fake_sdl3(monkeypatch, gamepad_ids=[11, 22])
    from tracksim.infra.sdl_controller import SDLControllerInput

    ctrl = SDLControllerInput()
    devices = ctrl.list_devices()
    assert [d.index for d in devices] == [0, 1]
    assert all(isinstance(d, ControllerDevice) for d in devices)
    assert devices[0].name == "Fake Xbox Pad"
    assert devices[0].guid != ""


def test_open_with_no_devices_raises_no_controller(monkeypatch):
    _install_fake_sdl3(monkeypatch, gamepad_ids=[])
    from tracksim.infra.sdl_controller import SDLControllerInput

    ctrl = SDLControllerInput()
    with pytest.raises(NoControllerError):
        ctrl.open(0)


def test_open_out_of_range_raises_no_controller(monkeypatch):
    _install_fake_sdl3(monkeypatch, gamepad_ids=[11])
    from tracksim.infra.sdl_controller import SDLControllerInput

    ctrl = SDLControllerInput()
    with pytest.raises(NoControllerError):
        ctrl.open(5)
```

- [ ] **Step 2: 运行测试确认失败** — Run: `python -m pytest tests/test_sdl_controller.py -v`  Expected: FAIL（`ModuleNotFoundError: No module named 'tracksim.infra.sdl_controller'`）

- [ ] **Step 3: 最小实现** — `sdl3` 在方法内部延迟 import（保证本模块是唯一 import sdl3 处，且未装库时整模块仍可加载、仅在 `open`/`list_devices` 时触发）。`list_devices` 把 `SDL_GetGamepads` 的 instance id 列表按位置映射为 `index`，名字/GUID 用 `*ForID` 查询并解码字节。`open(index)` 先取设备列表，越界或为空抛 `NoControllerError`，否则 `SDL_OpenGamepad` 保存句柄。`poll`/`close` 一并实现以满足 `ControllerInput` 协议。

```python
# src/tracksim/infra/sdl_controller.py
"""SDL3 (PySDL3) backend for the ControllerInput port.

This is the ONLY module in the package allowed to import `sdl3`.
The import is deferred so the package loads even when SDL3 is absent;
`NoControllerError` is raised when a device is requested but unavailable.
"""

from __future__ import annotations

from typing import Any

from tracksim.domain.errors import NoControllerError
from tracksim.ports.controller_input import ControllerDevice, ControllerState

_STICK_DIVISOR = 32767.0


def _decode(value: Any) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    if value is None:
        return ""
    return str(value)


def _clamp(value: float, lo: float, hi: float) -> float:
    if value < lo:
        return lo
    if value > hi:
        return hi
    return value


class SDLControllerInput:
    """ControllerInput implementation backed by SDL3 gamepad API via PySDL3."""

    def __init__(self) -> None:
        self._sdl: Any | None = None
        self._gamepad: Any | None = None
        self._initialized = False

    def _ensure_sdl(self) -> Any:
        if self._sdl is None:
            import sdl3  # deferred: only place importing sdl3

            self._sdl = sdl3
        if not self._initialized:
            self._sdl.SDL_Init(self._sdl.SDL_INIT_GAMEPAD)
            self._initialized = True
        return self._sdl

    def _instance_ids(self) -> list[int]:
        sdl = self._ensure_sdl()
        ids = sdl.SDL_GetGamepads(None)
        return list(ids) if ids is not None else []

    def list_devices(self) -> list[ControllerDevice]:
        sdl = self._ensure_sdl()
        devices: list[ControllerDevice] = []
        for index, instance_id in enumerate(self._instance_ids()):
            name = _decode(sdl.SDL_GetGamepadNameForID(instance_id))
            guid = _decode(sdl.SDL_GetGamepadGUIDForID(instance_id))
            devices.append(ControllerDevice(index=index, name=name, guid=guid))
        return devices

    def open(self, index: int) -> None:
        sdl = self._ensure_sdl()
        ids = self._instance_ids()
        if index < 0 or index >= len(ids):
            raise NoControllerError(
                f"no controller at index {index} (found {len(ids)})"
            )
        self._gamepad = sdl.SDL_OpenGamepad(ids[index])
        if not self._gamepad:
            raise NoControllerError(f"failed to open controller at index {index}")

    def poll(self) -> ControllerState:
        if self._gamepad is None:
            raise NoControllerError("poll() called before open()")
        sdl = self._ensure_sdl()
        sdl.SDL_UpdateGamepads()
        gp = self._gamepad

        def axis(code: int) -> int:
            return sdl.SDL_GetGamepadAxis(gp, code)

        def button(code: int) -> bool:
            return bool(sdl.SDL_GetGamepadButton(gp, code))

        axes = {
            "leftx": _clamp(axis(sdl.SDL_GAMEPAD_AXIS_LEFTX) / _STICK_DIVISOR, -1.0, 1.0),
            "lefty": _clamp(axis(sdl.SDL_GAMEPAD_AXIS_LEFTY) / _STICK_DIVISOR, -1.0, 1.0),
            "rightx": _clamp(axis(sdl.SDL_GAMEPAD_AXIS_RIGHTX) / _STICK_DIVISOR, -1.0, 1.0),
            "righty": _clamp(axis(sdl.SDL_GAMEPAD_AXIS_RIGHTY) / _STICK_DIVISOR, -1.0, 1.0),
            "lefttrigger": _clamp(
                axis(sdl.SDL_GAMEPAD_AXIS_LEFT_TRIGGER) / _STICK_DIVISOR, 0.0, 1.0
            ),
            "righttrigger": _clamp(
                axis(sdl.SDL_GAMEPAD_AXIS_RIGHT_TRIGGER) / _STICK_DIVISOR, 0.0, 1.0
            ),
        }
        buttons = {
            "a": button(sdl.SDL_GAMEPAD_BUTTON_SOUTH),
            "b": button(sdl.SDL_GAMEPAD_BUTTON_EAST),
            "x": button(sdl.SDL_GAMEPAD_BUTTON_WEST),
            "y": button(sdl.SDL_GAMEPAD_BUTTON_NORTH),
            "leftshoulder": button(sdl.SDL_GAMEPAD_BUTTON_LEFT_SHOULDER),
            "rightshoulder": button(sdl.SDL_GAMEPAD_BUTTON_RIGHT_SHOULDER),
            "back": button(sdl.SDL_GAMEPAD_BUTTON_BACK),
            "start": button(sdl.SDL_GAMEPAD_BUTTON_START),
        }
        return ControllerState(axes=axes, buttons=buttons, connected=True)

    def close(self) -> None:
        if self._gamepad is not None and self._sdl is not None:
            self._sdl.SDL_CloseGamepad(self._gamepad)
            self._gamepad = None
        if self._initialized and self._sdl is not None:
            self._sdl.SDL_Quit()
            self._initialized = False
```

- [ ] **Step 4: 运行测试确认通过** — Run: `python -m pytest tests/test_sdl_controller.py -v`  Expected: PASS（3 passed）

- [ ] **Step 5: 提交**

```
git add src/tracksim/infra/sdl_controller.py tests/test_sdl_controller.py
git commit -m "feat(infra): add SDLControllerInput list_devices/open via PySDL3"
```

### Task 28: SDLControllerInput — poll 轴/键归一化与 close

**Files:** Modify `src/tracksim/infra/sdl_controller.py`（poll/close 已在 Task 27 写入，本任务补归一化与生命周期测试）; Test `tests/test_sdl_controller_poll.py`

- [ ] **Step 1: 写失败测试** — 复用 Task 27 的伪 `sdl3`（在本文件内重定义同一 helper），注入原始轴值后验证：摇杆 `value/32767` 并 clamp 到 `-1..1`、扳机 clamp 到 `0..1`、按钮布尔映射到 `a/b/x/y/leftshoulder/rightshoulder/back/start`、`poll` 前未 `open` 抛 `NoControllerError`、`close()` 调用 `SDL_CloseGamepad` 后再 `poll` 抛错。

```python
# tests/test_sdl_controller_poll.py
import sys
import types

import pytest

from tracksim.domain.errors import NoControllerError


def _install_fake_sdl3(monkeypatch, *, gamepad_ids, axes=None, buttons=None):
    mod = types.ModuleType("sdl3")
    mod.SDL_INIT_GAMEPAD = 0x2000
    mod.SDL_GAMEPAD_AXIS_LEFTX = 0
    mod.SDL_GAMEPAD_AXIS_LEFTY = 1
    mod.SDL_GAMEPAD_AXIS_RIGHTX = 2
    mod.SDL_GAMEPAD_AXIS_RIGHTY = 3
    mod.SDL_GAMEPAD_AXIS_LEFT_TRIGGER = 4
    mod.SDL_GAMEPAD_AXIS_RIGHT_TRIGGER = 5
    mod.SDL_GAMEPAD_BUTTON_SOUTH = 0
    mod.SDL_GAMEPAD_BUTTON_EAST = 1
    mod.SDL_GAMEPAD_BUTTON_WEST = 2
    mod.SDL_GAMEPAD_BUTTON_NORTH = 3
    mod.SDL_GAMEPAD_BUTTON_LEFT_SHOULDER = 9
    mod.SDL_GAMEPAD_BUTTON_RIGHT_SHOULDER = 10
    mod.SDL_GAMEPAD_BUTTON_BACK = 4
    mod.SDL_GAMEPAD_BUTTON_START = 6

    state = {"closed": False, "axes": axes or {}, "buttons": buttons or {}}

    mod.SDL_Init = lambda flags: True
    mod.SDL_Quit = lambda: None
    mod.SDL_GetGamepads = lambda count_ptr=None: list(gamepad_ids)
    mod.SDL_OpenGamepad = lambda iid: ("gp", iid)

    def SDL_CloseGamepad(gp):
        state["closed"] = True

    mod.SDL_CloseGamepad = SDL_CloseGamepad
    mod.SDL_UpdateGamepads = lambda: None
    mod.SDL_GetGamepadName = lambda gp: b"Fake Xbox Pad"
    mod.SDL_GetGamepadNameForID = lambda iid: b"Fake Xbox Pad"
    mod.SDL_GetGamepadGUIDForID = lambda iid: b"03030000"
    mod.SDL_GetGamepadAxis = lambda gp, axis: state["axes"].get(axis, 0)
    mod.SDL_GetGamepadButton = lambda gp, button: state["buttons"].get(button, False)

    monkeypatch.setitem(sys.modules, "sdl3", mod)
    return mod, state


def test_poll_normalizes_sticks_and_triggers(monkeypatch):
    mod, _ = _install_fake_sdl3(
        monkeypatch,
        gamepad_ids=[7],
        axes={
            mod_axes_leftx := 0: 32767,   # full right -> +1.0
            1: -32767,                    # full up    -> -1.0
            2: 16384,                     # ~half      -> ~+0.5
            3: 0,
            4: 32767,                     # trigger full -> 1.0
            5: 0,                         # trigger idle -> 0.0
        },
    )
    from tracksim.infra.sdl_controller import SDLControllerInput

    ctrl = SDLControllerInput()
    ctrl.open(0)
    s = ctrl.poll()
    assert s.axes["leftx"] == pytest.approx(1.0)
    assert s.axes["lefty"] == pytest.approx(-1.0)
    assert s.axes["rightx"] == pytest.approx(0.5, abs=0.01)
    assert s.axes["righty"] == pytest.approx(0.0)
    assert s.axes["lefttrigger"] == pytest.approx(1.0)
    assert s.axes["righttrigger"] == pytest.approx(0.0)
    assert s.connected is True


def test_poll_axis_value_clamped_to_range(monkeypatch):
    _install_fake_sdl3(
        monkeypatch,
        gamepad_ids=[7],
        axes={0: 40000, 4: 40000},  # beyond +32767 must clamp
    )
    from tracksim.infra.sdl_controller import SDLControllerInput

    ctrl = SDLControllerInput()
    ctrl.open(0)
    s = ctrl.poll()
    assert s.axes["leftx"] == pytest.approx(1.0)
    assert s.axes["lefttrigger"] == pytest.approx(1.0)


def test_poll_maps_buttons(monkeypatch):
    _install_fake_sdl3(
        monkeypatch,
        gamepad_ids=[7],
        buttons={0: True, 1: False, 9: True, 6: True},
    )
    from tracksim.infra.sdl_controller import SDLControllerInput

    ctrl = SDLControllerInput()
    ctrl.open(0)
    s = ctrl.poll()
    assert set(s.buttons) == {
        "a", "b", "x", "y", "leftshoulder", "rightshoulder", "back", "start"
    }
    assert s.buttons["a"] is True
    assert s.buttons["b"] is False
    assert s.buttons["leftshoulder"] is True
    assert s.buttons["start"] is True


def test_poll_before_open_raises(monkeypatch):
    _install_fake_sdl3(monkeypatch, gamepad_ids=[7])
    from tracksim.infra.sdl_controller import SDLControllerInput

    ctrl = SDLControllerInput()
    with pytest.raises(NoControllerError):
        ctrl.poll()


def test_close_then_poll_raises(monkeypatch):
    _, state = _install_fake_sdl3(monkeypatch, gamepad_ids=[7])
    from tracksim.infra.sdl_controller import SDLControllerInput

    ctrl = SDLControllerInput()
    ctrl.open(0)
    ctrl.close()
    assert state["closed"] is True
    with pytest.raises(NoControllerError):
        ctrl.poll()
```

- [ ] **Step 2: 运行测试确认失败** — Run: `python -m pytest tests/test_sdl_controller_poll.py -v`  Expected: 若 `poll`/`close` 已在 Task 27 完整实现则 5 passed；本任务用于回归锁定归一化与生命周期。如发现归一化/clamp/异常路径缺失，则相应断言 FAIL。

- [ ] **Step 3: 最小实现** — 无需改动（`poll` 的 `value/32767` 归一化、`_clamp`、按钮映射、`poll` 前抛 `NoControllerError`、`close` 调 `SDL_CloseGamepad` 并置空句柄均已在 Task 27 的 `sdl_controller.py` 实现）。如上一步出现 FAIL，按 Task 27 Step 3 中 `poll`/`close`/`_clamp` 实现补齐对应分支。

- [ ] **Step 4: 运行测试确认通过** — Run: `python -m pytest tests/test_sdl_controller_poll.py -v`  Expected: PASS（5 passed）

- [ ] **Step 5: 提交**

```
git add tests/test_sdl_controller_poll.py
git commit -m "test(infra): lock SDLControllerInput poll normalization and lifecycle"
```

### Task 29: SimEvent dataclasses 定义

**Files:**
- Create: `src/tracksim/simulator.py`
- Test: `tests/test_simulator_events.py`

事件层是纯编排数据结构，不涉及任何协议字节。先把 contract 规定的 4 个 dataclass + `SimEvent` union 落地。

- [ ] **Step 1: 写失败测试**
```python
# tests/test_simulator_events.py
import dataclasses

from tracksim.domain.pose import CameraPose
from tracksim.simulator import (
    SimEvent,
    SimStarted,
    SimStopped,
    SimTick,
    SimWarning,
)


def test_sim_started_fields():
    ev = SimStarted(protocols=["freed", "opentrackio"], rate=60.0)
    assert ev.protocols == ["freed", "opentrackio"]
    assert ev.rate == 60.0


def test_sim_tick_fields():
    pose = CameraPose()
    ev = SimTick(pose=pose, packets_sent=3, rate_actual=59.5)
    assert ev.pose is pose
    assert ev.packets_sent == 3
    assert ev.rate_actual == 59.5


def test_sim_warning_field():
    ev = SimWarning(message="send failed")
    assert ev.message == "send failed"


def test_sim_stopped_fields():
    ev = SimStopped(reason="source-exhausted", total_packets=120)
    assert ev.reason == "source-exhausted"
    assert ev.total_packets == 120


def test_events_are_dataclasses_and_union_members():
    for cls in (SimStarted, SimTick, SimWarning, SimStopped):
        assert dataclasses.is_dataclass(cls)
    members = set(getattr(SimEvent, "__args__", ()))
    assert members == {SimStarted, SimTick, SimWarning, SimStopped}
```

- [ ] **Step 2: 运行测试确认失败** — Run: `python -m pytest tests/test_simulator_events.py -v`  Expected: FAIL (`ModuleNotFoundError: No module named 'tracksim.simulator'`)

- [ ] **Step 3: 最小实现**
```python
# src/tracksim/simulator.py
from __future__ import annotations

from dataclasses import dataclass
from typing import Union

from tracksim.domain.pose import CameraPose


@dataclass
class SimStarted:
    protocols: list[str]
    rate: float


@dataclass
class SimTick:
    pose: CameraPose
    packets_sent: int
    rate_actual: float


@dataclass
class SimWarning:
    message: str


@dataclass
class SimStopped:
    reason: str
    total_packets: int


SimEvent = Union[SimStarted, SimTick, SimWarning, SimStopped]
```

- [ ] **Step 4: 运行测试确认通过** — Run: `python -m pytest tests/test_simulator_events.py -v`  Expected: PASS (5 passed)

- [ ] **Step 5: 提交**
```bash
git add src/tracksim/simulator.py tests/test_simulator_events.py
git commit -m "feat(simulator): add SimEvent dataclasses union"
```

### Task 30: 测试 fakes（FakePoseSource / FakeEmitter）

**Files:**
- Modify: `tests/fakes.py`
- Test: `tests/test_fakes_sim.py`

Simulator 的测试需要可计数的 PoseSource、可注入失败的 Emitter，以及确定性 Clock。`tests/fakes.py` 在前面 section 已建立 `FakeTransport` / `FakeClock`；此处追加 `FakePoseSource`、`FakeEmitter`，并复用已有 `FakeClock`。若 `tests/fakes.py` 尚不存在或缺少 `FakeClock`，本任务的 fakes 文件给出完整内容以自洽。

- [ ] **Step 1: 写失败测试**
```python
# tests/test_fakes_sim.py
import pytest

from tracksim.domain.errors import TransportError
from tracksim.domain.pose import CameraPose
from tests.fakes import FakeClock, FakeEmitter, FakePoseSource


def test_fake_pose_source_counts_and_advances_frame():
    src = FakePoseSource()
    p0 = src.next(0.5)
    p1 = src.next(0.5)
    assert src.calls == 2
    assert src.dts == [0.5, 0.5]
    assert isinstance(p0, CameraPose)
    assert p0.frame == 0
    assert p1.frame == 1


def test_fake_pose_source_exhausts_after_limit():
    src = FakePoseSource(limit=2)
    src.next(0.1)
    src.next(0.1)
    with pytest.raises(StopIteration):
        src.next(0.1)


def test_fake_pose_source_close_sets_flag():
    src = FakePoseSource()
    src.close()
    assert src.closed is True


def test_fake_emitter_records_poses():
    em = FakeEmitter(name="freed")
    pose = CameraPose()
    em.emit(pose)
    assert em.name == "freed"
    assert em.emitted == [pose]


def test_fake_emitter_can_fail():
    em = FakeEmitter(name="freed", fail_times=1)
    with pytest.raises(TransportError):
        em.emit(CameraPose())
    em.emit(CameraPose())  # second emit succeeds
    assert len(em.emitted) == 1


def test_fake_clock_advances_on_sleep():
    clock = FakeClock()
    assert clock.now() == 0.0
    clock.sleep(0.25)
    assert clock.now() == 0.25
    assert clock.sleeps == [0.25]
```

- [ ] **Step 2: 运行测试确认失败** — Run: `python -m pytest tests/test_fakes_sim.py -v`  Expected: FAIL (`ImportError: cannot import name 'FakePoseSource' from 'tests.fakes'`)

- [ ] **Step 3: 最小实现**
```python
# tests/fakes.py
from __future__ import annotations

from tracksim.domain.errors import TransportError
from tracksim.domain.pose import CameraPose


class FakeClock:
    """Deterministic clock: now() advances only via sleep()."""

    def __init__(self, start: float = 0.0) -> None:
        self._now = start
        self.sleeps: list[float] = []

    def now(self) -> float:
        return self._now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        if seconds > 0:
            self._now += seconds

    def advance(self, seconds: float) -> None:
        self._now += seconds


class FakeTransport:
    def __init__(self, fail_times: int = 0) -> None:
        self.sent: list[bytes] = []
        self.fail_times = fail_times
        self.closed = False

    def send(self, data: bytes) -> None:
        if self.fail_times > 0:
            self.fail_times -= 1
            raise TransportError("fake transport send failed")
        self.sent.append(data)

    def close(self) -> None:
        self.closed = True


class FakePoseSource:
    """Counting pose source. Raises StopIteration after `limit` calls."""

    def __init__(self, limit: int | None = None) -> None:
        self.limit = limit
        self.calls = 0
        self.dts: list[float] = []
        self.closed = False

    def next(self, dt: float) -> CameraPose:
        if self.limit is not None and self.calls >= self.limit:
            raise StopIteration
        frame = self.calls
        self.dts.append(dt)
        self.calls += 1
        return CameraPose(frame=frame)

    def close(self) -> None:
        self.closed = True


class FakeEmitter:
    """Emitter recording poses; can raise TransportError on first N emits."""

    def __init__(self, name: str = "fake", fail_times: int = 0) -> None:
        self.name = name
        self.fail_times = fail_times
        self.emitted: list[CameraPose] = []
        self.closed = False

    def emit(self, pose: CameraPose) -> None:
        if self.fail_times > 0:
            self.fail_times -= 1
            raise TransportError(f"{self.name} emit failed")
        self.emitted.append(pose)

    def close(self) -> None:
        self.closed = True
```

- [ ] **Step 4: 运行测试确认通过** — Run: `python -m pytest tests/test_fakes_sim.py -v`  Expected: PASS (6 passed)

- [ ] **Step 5: 提交**
```bash
git add tests/fakes.py tests/test_fakes_sim.py
git commit -m "test(fakes): add FakePoseSource and FakeEmitter"
```

### Task 31: Simulator.run() 事件顺序与 source-exhausted 收尾

**Files:**
- Modify: `src/tracksim/simulator.py`
- Test: `tests/test_simulator_run.py`

`run()` 是生成器：首先 `yield SimStarted`，随后每帧 `yield SimTick`，由 source 抛 `StopIteration` 时以 `reason="source-exhausted"` 收尾 `yield SimStopped` 并 return。`dt = 1/rate`，并把该 dt 传给 `source.next`。

- [ ] **Step 1: 写失败测试**
```python
# tests/test_simulator_run.py
from tracksim.simulator import (
    SimStarted,
    SimStopped,
    SimTick,
    Simulator,
)
from tests.fakes import FakeClock, FakeEmitter, FakePoseSource


def test_run_emits_started_ticks_stopped_in_order():
    src = FakePoseSource(limit=3)
    em = FakeEmitter(name="freed")
    sim = Simulator(source=src, emitters=[em], clock=FakeClock(), rate=10.0)

    events = list(sim.run())

    assert isinstance(events[0], SimStarted)
    assert events[0].protocols == ["freed"]
    assert events[0].rate == 10.0

    ticks = [e for e in events if isinstance(e, SimTick)]
    assert len(ticks) == 3

    assert isinstance(events[-1], SimStopped)
    assert events[-1].reason == "source-exhausted"


def test_run_passes_dt_one_over_rate_to_source():
    src = FakePoseSource(limit=2)
    sim = Simulator(source=src, emitters=[FakeEmitter()], clock=FakeClock(), rate=50.0)
    list(sim.run())
    assert src.dts == [0.02, 0.02]


def test_run_started_lists_all_emitter_names():
    src = FakePoseSource(limit=1)
    a = FakeEmitter(name="freed")
    b = FakeEmitter(name="opentrackio")
    sim = Simulator(source=src, emitters=[a, b], clock=FakeClock(), rate=10.0)
    events = list(sim.run())
    assert isinstance(events[0], SimStarted)
    assert events[0].protocols == ["freed", "opentrackio"]
```

- [ ] **Step 2: 运行测试确认失败** — Run: `python -m pytest tests/test_simulator_run.py -v`  Expected: FAIL (`ImportError: cannot import name 'Simulator' from 'tracksim.simulator'`)

- [ ] **Step 3: 最小实现**
```python
# src/tracksim/simulator.py
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterator, Union

from tracksim.domain.errors import TransportError
from tracksim.domain.pose import CameraPose
from tracksim.ports.clock import Clock
from tracksim.ports.emitter import Emitter
from tracksim.ports.pose_source import PoseSource


@dataclass
class SimStarted:
    protocols: list[str]
    rate: float


@dataclass
class SimTick:
    pose: CameraPose
    packets_sent: int
    rate_actual: float


@dataclass
class SimWarning:
    message: str


@dataclass
class SimStopped:
    reason: str
    total_packets: int


SimEvent = Union[SimStarted, SimTick, SimWarning, SimStopped]


class Simulator:
    def __init__(
        self,
        source: PoseSource,
        emitters: list[Emitter],
        clock: Clock,
        rate: float,
        fail_fast: bool = False,
    ) -> None:
        self.source = source
        self.emitters = emitters
        self.clock = clock
        self.rate = rate
        self.fail_fast = fail_fast
        self._stopped = False
        self._total_packets = 0

    def stop(self) -> None:
        self._stopped = True

    def run(self) -> Iterator[SimEvent]:
        yield SimStarted(protocols=[e.name for e in self.emitters], rate=self.rate)
        dt = 1.0 / self.rate
        last = self.clock.now()
        while not self._stopped:
            try:
                pose = self.source.next(dt)
            except StopIteration:
                yield SimStopped(reason="source-exhausted", total_packets=self._total_packets)
                return
            sent = 0
            for emitter in self.emitters:
                try:
                    emitter.emit(pose)
                except TransportError as exc:
                    if self.fail_fast:
                        raise
                    yield SimWarning(message=str(exc))
                    continue
                sent += 1
            self._total_packets += sent
            now = self.clock.now()
            elapsed = now - last
            rate_actual = (1.0 / elapsed) if elapsed > 0 else self.rate
            last = now
            yield SimTick(pose=pose, packets_sent=self._total_packets, rate_actual=rate_actual)
            self.clock.sleep(dt)
        yield SimStopped(reason="stopped", total_packets=self._total_packets)
```

- [ ] **Step 4: 运行测试确认通过** — Run: `python -m pytest tests/test_simulator_run.py -v`  Expected: PASS (3 passed)

- [ ] **Step 5: 提交**
```bash
git add src/tracksim/simulator.py tests/test_simulator_run.py
git commit -m "feat(simulator): run() generator with start/tick/stopped events"
```

### Task 32: 累计 packet 计数与 rate_actual 自时钟

**Files:**
- Test: `tests/test_simulator_packets.py`

验证 `packets_sent` 是累计总数（每帧成功 emit 的总和），`rate_actual` 由 `clock` 的 now() 差值推导。无需改实现（Task 31 已满足），本任务锁定行为契约。

- [ ] **Step 1: 写失败测试**
```python
# tests/test_simulator_packets.py
from tracksim.simulator import SimTick, Simulator
from tests.fakes import FakeClock, FakeEmitter, FakePoseSource


def test_packets_sent_is_cumulative_total_over_emitters():
    src = FakePoseSource(limit=2)
    a = FakeEmitter(name="freed")
    b = FakeEmitter(name="opentrackio")
    sim = Simulator(source=src, emitters=[a, b], clock=FakeClock(), rate=10.0)

    ticks = [e for e in sim.run() if isinstance(e, SimTick)]

    # 2 emitters * 2 frames = 4 packets total; cumulative per tick
    assert [t.packets_sent for t in ticks] == [2, 4]


def test_rate_actual_derived_from_clock_deltas():
    src = FakePoseSource(limit=2)
    em = FakeEmitter(name="freed")
    # rate=10 -> dt=0.1 -> each frame clock advances 0.1 via sleep
    sim = Simulator(source=src, emitters=[em], clock=FakeClock(), rate=10.0)

    ticks = [e for e in sim.run() if isinstance(e, SimTick)]

    # first tick: no prior sleep elapsed -> falls back to nominal rate
    assert ticks[0].rate_actual == 10.0
    # second tick: 0.1s elapsed since first -> 1/0.1 = 10.0
    assert abs(ticks[1].rate_actual - 10.0) < 1e-9
```

- [ ] **Step 2: 运行测试确认失败** — Run: `python -m pytest tests/test_simulator_packets.py -v`  Expected: FAIL (`ModuleNotFoundError: No module named 'tests.test_simulator_packets'` 解析后即文件不存在；首次运行因断言尚未验证而执行，确认 packet/rate 行为)

- [ ] **Step 3: 最小实现**

实现已在 Task 31 完成；本任务为行为锁定，无需新增代码。若测试失败，按 systematic-debugging 修正 `run()` 中 `_total_packets` 累加或 `rate_actual` 推导逻辑，使下列不变量成立：每帧 `packets_sent` 为累计成功 emit 数；`rate_actual = 1/elapsed`（首帧 elapsed=0 时回退为 `self.rate`）。

```python
# src/tracksim/simulator.py (run() 关键片段 — 与 Task 31 一致，确认无改动)
            self._total_packets += sent
            now = self.clock.now()
            elapsed = now - last
            rate_actual = (1.0 / elapsed) if elapsed > 0 else self.rate
            last = now
            yield SimTick(pose=pose, packets_sent=self._total_packets, rate_actual=rate_actual)
            self.clock.sleep(dt)
```

- [ ] **Step 4: 运行测试确认通过** — Run: `python -m pytest tests/test_simulator_packets.py -v`  Expected: PASS (2 passed)

- [ ] **Step 5: 提交**
```bash
git add tests/test_simulator_packets.py
git commit -m "test(simulator): lock cumulative packet count and rate_actual"
```

### Task 33: stop() 终止循环并发出 SimStopped(reason="stopped")

**Files:**
- Test: `tests/test_simulator_stop.py`

`stop()` 置标志位，循环每轮开头检查；调用后下一轮退出并 `yield SimStopped(reason="stopped", ...)`。用一个会在 emit 时回调 `stop()` 的 emitter 验证。

- [ ] **Step 1: 写失败测试**
```python
# tests/test_simulator_stop.py
from tracksim.domain.pose import CameraPose
from tracksim.simulator import SimStopped, SimTick, Simulator
from tests.fakes import FakeClock, FakeEmitter, FakePoseSource


class StoppingEmitter:
    """Emitter that calls sim.stop() after its first emit."""

    name = "freed"

    def __init__(self) -> None:
        self.emitted: list[CameraPose] = []
        self.sim: Simulator | None = None

    def emit(self, pose: CameraPose) -> None:
        self.emitted.append(pose)
        if self.sim is not None and len(self.emitted) == 1:
            self.sim.stop()

    def close(self) -> None:
        pass


def test_stop_ends_loop_with_stopped_reason():
    src = FakePoseSource()  # unbounded
    em = StoppingEmitter()
    sim = Simulator(source=src, emitters=[em], clock=FakeClock(), rate=10.0)
    em.sim = sim

    events = list(sim.run())

    ticks = [e for e in events if isinstance(e, SimTick)]
    assert len(ticks) == 1
    assert isinstance(events[-1], SimStopped)
    assert events[-1].reason == "stopped"
    assert events[-1].total_packets == 1


def test_stop_before_run_yields_only_started_and_stopped():
    src = FakePoseSource()
    em = FakeEmitter(name="freed")
    sim = Simulator(source=src, emitters=[em], clock=FakeClock(), rate=10.0)
    sim.stop()

    events = list(sim.run())

    assert [type(e).__name__ for e in events] == ["SimStarted", "SimStopped"]
    assert events[-1].reason == "stopped"
    assert events[-1].total_packets == 0
```

- [ ] **Step 2: 运行测试确认失败** — Run: `python -m pytest tests/test_simulator_stop.py -v`  Expected: FAIL (运行前文件不存在；首次运行验证 stop() 是否在下一轮检查标志位并以 `reason="stopped"` 收尾)

- [ ] **Step 3: 最小实现**

实现已在 Task 31 完成（`run()` 循环条件 `while not self._stopped` + 末尾 `yield SimStopped(reason="stopped", ...)`）。本任务锁定 stop() 语义，无需新增代码。确认 `stop()` 仅置标志、循环每轮开头读取，且 `stop()` 后剩余事件不再产生新 SimTick。

```python
# src/tracksim/simulator.py — 本任务不新增代码（run() 循环与 SimStopped 收尾已在 Task 31 写入）。
# 关键契约（已由 Task 31 实现，此处仅说明）：
#   - stop() 只置位 self._stopped，不做其他副作用；
#   - run() 的 `while not self._stopped:` 在每轮循环开头读取该标志；
#   - 因此 stop() 之后的下一轮不再产生新的 SimTick，循环结束后 yield SimStopped(reason="stopped", ...)。
    def stop(self) -> None:
        self._stopped = True
```

- [ ] **Step 4: 运行测试确认通过** — Run: `python -m pytest tests/test_simulator_stop.py -v`  Expected: PASS (2 passed)

- [ ] **Step 5: 提交**
```bash
git add tests/test_simulator_stop.py
git commit -m "test(simulator): stop() ends loop with stopped reason"
```

### Task 34: TransportError 处理（SimWarning 软失败 / fail_fast 抛出）

**Files:**
- Test: `tests/test_simulator_warnings.py`

emit 抛 `TransportError` 时：默认（`fail_fast=False`）转成 `SimWarning(message=str(e))` 且该 emitter 不计入 packets，循环继续；`fail_fast=True` 时直接抛出，中止生成器。

- [ ] **Step 1: 写失败测试**
```python
# tests/test_simulator_warnings.py
import pytest

from tracksim.domain.errors import TransportError
from tracksim.simulator import SimTick, SimWarning, Simulator
from tests.fakes import FakeClock, FakeEmitter, FakePoseSource


def test_transport_error_becomes_warning_when_not_fail_fast():
    src = FakePoseSource(limit=1)
    bad = FakeEmitter(name="freed", fail_times=1)
    good = FakeEmitter(name="opentrackio")
    sim = Simulator(
        source=src,
        emitters=[bad, good],
        clock=FakeClock(),
        rate=10.0,
        fail_fast=False,
    )

    events = list(sim.run())

    warnings = [e for e in events if isinstance(e, SimWarning)]
    assert len(warnings) == 1
    assert "freed emit failed" in warnings[0].message

    ticks = [e for e in events if isinstance(e, SimTick)]
    assert len(ticks) == 1
    # only the good emitter succeeded -> 1 packet
    assert ticks[0].packets_sent == 1
    # warning is emitted before the tick of that frame
    w_idx = events.index(warnings[0])
    t_idx = events.index(ticks[0])
    assert w_idx < t_idx


def test_transport_error_raises_when_fail_fast():
    src = FakePoseSource(limit=1)
    bad = FakeEmitter(name="freed", fail_times=1)
    sim = Simulator(
        source=src,
        emitters=[bad],
        clock=FakeClock(),
        rate=10.0,
        fail_fast=True,
    )

    gen = sim.run()
    assert type(next(gen)).__name__ == "SimStarted"
    with pytest.raises(TransportError):
        next(gen)
```

- [ ] **Step 2: 运行测试确认失败** — Run: `python -m pytest tests/test_simulator_warnings.py -v`  Expected: FAIL (运行前文件不存在；首次运行验证 SimWarning 软失败路径与 fail_fast 抛出路径)

- [ ] **Step 3: 最小实现**

实现已在 Task 31 完成（per-emitter `try/except TransportError`：`fail_fast` 抛出，否则 `yield SimWarning(str(exc))` 并 `continue` 不计入 `sent`）。本任务锁定该契约，无需新增代码。

```python
# src/tracksim/simulator.py (与 Task 31 一致 — emit 异常处理)
            sent = 0
            for emitter in self.emitters:
                try:
                    emitter.emit(pose)
                except TransportError as exc:
                    if self.fail_fast:
                        raise
                    yield SimWarning(message=str(exc))
                    continue
                sent += 1
            self._total_packets += sent
```

- [ ] **Step 4: 运行测试确认通过** — Run: `python -m pytest tests/test_simulator_warnings.py -v`  Expected: PASS (2 passed)

- [ ] **Step 5: 提交**
```bash
git add tests/test_simulator_warnings.py
git commit -m "test(simulator): TransportError to SimWarning and fail_fast raise"
```

### Task 35: tick_once() 单帧 emit（无配速，供 sim.send 使用）

**Files:**
- Modify: `src/tracksim/simulator.py`
- Test: `tests/test_simulator_tick_once.py`

`tick_once()` 执行一次 `source.next(1/rate)` + 全 emitter emit，返回该帧 `SimTick`，不调用 `clock.sleep`（无配速），用于 `sim.send` 单包发送。累计 `total_packets`，`rate_actual` 取 `self.rate`（单帧无时钟差值参照）。

- [ ] **Step 1: 写失败测试**
```python
# tests/test_simulator_tick_once.py
import pytest

from tracksim.domain.errors import TransportError
from tracksim.simulator import SimTick, Simulator
from tests.fakes import FakeClock, FakeEmitter, FakePoseSource


def test_tick_once_returns_single_tick_no_pacing():
    src = FakePoseSource(limit=5)
    em = FakeEmitter(name="freed")
    clock = FakeClock()
    sim = Simulator(source=src, emitters=[em], clock=clock, rate=20.0)

    tick = sim.tick_once()

    assert isinstance(tick, SimTick)
    assert src.calls == 1
    assert src.dts == [0.05]  # 1 / 20
    assert len(em.emitted) == 1
    assert tick.packets_sent == 1
    assert tick.rate_actual == 20.0
    # no pacing: clock.sleep never called
    assert clock.sleeps == []


def test_tick_once_counts_all_emitters_and_accumulates():
    src = FakePoseSource(limit=5)
    a = FakeEmitter(name="freed")
    b = FakeEmitter(name="opentrackio")
    sim = Simulator(source=src, emitters=[a, b], clock=FakeClock(), rate=10.0)

    t1 = sim.tick_once()
    t2 = sim.tick_once()

    assert t1.packets_sent == 2
    assert t2.packets_sent == 4


def test_tick_once_fail_fast_propagates_transport_error():
    src = FakePoseSource(limit=5)
    bad = FakeEmitter(name="freed", fail_times=1)
    sim = Simulator(
        source=src,
        emitters=[bad],
        clock=FakeClock(),
        rate=10.0,
        fail_fast=True,
    )
    with pytest.raises(TransportError):
        sim.tick_once()
```

- [ ] **Step 2: 运行测试确认失败** — Run: `python -m pytest tests/test_simulator_tick_once.py -v`  Expected: FAIL (`AttributeError: 'Simulator' object has no attribute 'tick_once'`)

- [ ] **Step 3: 最小实现**
```python
# src/tracksim/simulator.py
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterator, Union

from tracksim.domain.errors import TransportError
from tracksim.domain.pose import CameraPose
from tracksim.ports.clock import Clock
from tracksim.ports.emitter import Emitter
from tracksim.ports.pose_source import PoseSource


@dataclass
class SimStarted:
    protocols: list[str]
    rate: float


@dataclass
class SimTick:
    pose: CameraPose
    packets_sent: int
    rate_actual: float


@dataclass
class SimWarning:
    message: str


@dataclass
class SimStopped:
    reason: str
    total_packets: int


SimEvent = Union[SimStarted, SimTick, SimWarning, SimStopped]


class Simulator:
    def __init__(
        self,
        source: PoseSource,
        emitters: list[Emitter],
        clock: Clock,
        rate: float,
        fail_fast: bool = False,
    ) -> None:
        self.source = source
        self.emitters = emitters
        self.clock = clock
        self.rate = rate
        self.fail_fast = fail_fast
        self._stopped = False
        self._total_packets = 0

    def stop(self) -> None:
        self._stopped = True

    def _emit_all(self, pose: CameraPose) -> tuple[int, list[SimWarning]]:
        sent = 0
        warnings: list[SimWarning] = []
        for emitter in self.emitters:
            try:
                emitter.emit(pose)
            except TransportError as exc:
                if self.fail_fast:
                    raise
                warnings.append(SimWarning(message=str(exc)))
                continue
            sent += 1
        return sent, warnings

    def tick_once(self) -> SimTick:
        dt = 1.0 / self.rate
        pose = self.source.next(dt)
        sent, _warnings = self._emit_all(pose)
        self._total_packets += sent
        return SimTick(
            pose=pose,
            packets_sent=self._total_packets,
            rate_actual=self.rate,
        )

    def run(self) -> Iterator[SimEvent]:
        yield SimStarted(protocols=[e.name for e in self.emitters], rate=self.rate)
        dt = 1.0 / self.rate
        last = self.clock.now()
        while not self._stopped:
            try:
                pose = self.source.next(dt)
            except StopIteration:
                yield SimStopped(reason="source-exhausted", total_packets=self._total_packets)
                return
            sent, warnings = self._emit_all(pose)
            for warning in warnings:
                yield warning
            self._total_packets += sent
            now = self.clock.now()
            elapsed = now - last
            rate_actual = (1.0 / elapsed) if elapsed > 0 else self.rate
            last = now
            yield SimTick(pose=pose, packets_sent=self._total_packets, rate_actual=rate_actual)
            self.clock.sleep(dt)
        yield SimStopped(reason="stopped", total_packets=self._total_packets)
```

- [ ] **Step 4: 运行测试确认通过** — Run: `python -m pytest tests/test_simulator_tick_once.py tests/test_simulator_run.py tests/test_simulator_packets.py tests/test_simulator_stop.py tests/test_simulator_warnings.py -v`  Expected: PASS (全部通过；`_emit_all` 重构后既有用例不回归)

- [ ] **Step 5: 提交**
```bash
git add src/tracksim/simulator.py tests/test_simulator_tick_once.py
git commit -m "feat(simulator): add tick_once() single-frame emit without pacing"
```

### Task 36: CLI render layer — text / json / ndjson 渲染器

**Files:**
- Create: `src/tracksim/cli/__init__.py`
- Create: `src/tracksim/cli/render.py`
- Test: `tests/test_cli_render.py`

说明：本层只负责把 envelope dict 渲染成字符串，并把 `SimEvent` 流映射成 ndjson 行。`render_success`/`render_error` 接受 envelope dict + `fmt`（`text`|`json`|`ndjson`）返回字符串（不含末尾换行由调用方处理；ndjson 单行）。`NdjsonWriter` 持有 `request_id`，发出带 `type/sequence/timestamp/request_id/schema_version` 字段的事件，`result(...)` 行带 `final:true`。`SimEvent`（`SimStarted`/`SimTick`/`SimWarning`/`SimStopped`，来自 `tracksim.simulator`）映射为 `start`/`progress`/`warning`/`result` ndjson 行。

- [ ] **Step 1: 写失败测试**

```python
# tests/test_cli_render.py
import io
import json

from tracksim.cli import render
from tracksim.domain.pose import CameraPose
from tracksim.envelope import success_envelope, error_envelope
from tracksim.simulator import SimStarted, SimTick, SimWarning, SimStopped


def test_render_success_json_is_pure_json():
    env = success_envelope(
        "meta.version", {"version": "0.1.0"},
        request_id="r1", duration_ms=1, timestamp="2026-06-02T00:00:00Z",
    )
    out = render.render_success(env, "json")
    assert json.loads(out) == env


def test_render_error_json_is_pure_json():
    env = error_envelope(
        "sim.send", code="TRANSPORT_SEND_FAILED", exit_code=11,
        message="boom", retryable=True, details={"k": "v"},
        request_id="r2", duration_ms=2, timestamp="2026-06-02T00:00:01Z",
    )
    out = render.render_error(env, "json")
    assert json.loads(out) == env


def test_render_success_text_is_human_readable():
    env = success_envelope(
        "meta.version", {"version": "0.1.0"},
        request_id="r1", duration_ms=1, timestamp="2026-06-02T00:00:00Z",
    )
    out = render.render_success(env, "text")
    assert "0.1.0" in out
    assert not out.startswith("{")


def test_render_error_text_includes_code_and_message():
    env = error_envelope(
        "sim.send", code="TRANSPORT_SEND_FAILED", exit_code=11,
        message="boom", retryable=True, details={},
        request_id="r2", duration_ms=2, timestamp="2026-06-02T00:00:01Z",
    )
    out = render.render_error(env, "text")
    assert "TRANSPORT_SEND_FAILED" in out
    assert "boom" in out


def test_render_success_ndjson_single_final_line():
    env = success_envelope(
        "config.show", {"k": "v"},
        request_id="r1", duration_ms=1, timestamp="2026-06-02T00:00:00Z",
    )
    out = render.render_success(env, "ndjson")
    lines = [ln for ln in out.splitlines() if ln]
    assert len(lines) == 1
    obj = json.loads(lines[0])
    assert obj["type"] == "result"
    assert obj["final"] is True
    assert obj["status"] == "ok"
    assert obj["operation_id"] == "config.show"


def test_ndjson_writer_emits_sequenced_events():
    buf = io.StringIO()
    w = render.NdjsonWriter(buf, request_id="rq", timestamp="2026-06-02T00:00:00Z")
    w.start({"protocols": ["freed"]})
    w.progress({"completed": 1, "total": 3})
    w.warning("slow")
    w.result(status="ok", data={"total_packets": 3})
    objs = [json.loads(ln) for ln in buf.getvalue().splitlines() if ln]
    assert [o["type"] for o in objs] == ["start", "progress", "warning", "result"]
    assert [o["sequence"] for o in objs] == [0, 1, 2, 3]
    for o in objs:
        assert o["request_id"] == "rq"
        assert o["schema_version"] == "1.0"
        assert o["timestamp"] == "2026-06-02T00:00:00Z"
    assert objs[-1]["final"] is True
    assert objs[0]["protocols"] == ["freed"]
    assert objs[1]["completed"] == 1
    assert objs[2]["message"] == "slow"
    assert objs[3]["data"]["total_packets"] == 3


def test_sim_event_to_ndjson_mapping():
    pose = CameraPose(pan=10.0)
    started = render.sim_event_fields(SimStarted(protocols=["freed"], rate=60.0))
    tick = render.sim_event_fields(SimTick(pose=pose, packets_sent=1, rate_actual=59.9))
    warn = render.sim_event_fields(SimWarning(message="hi"))
    stopped = render.sim_event_fields(SimStopped(reason="duration", total_packets=7))
    assert started["type"] == "start"
    assert started["protocols"] == ["freed"]
    assert started["rate"] == 60.0
    assert tick["type"] == "progress"
    assert tick["packets_sent"] == 1
    assert tick["rate_actual"] == 59.9
    assert tick["pose"]["pan"] == 10.0
    assert warn["type"] == "warning"
    assert warn["message"] == "hi"
    assert stopped["type"] == "result"
    assert stopped["status"] == "ok"
    assert stopped["reason"] == "duration"
    assert stopped["total_packets"] == 7
```

- [ ] **Step 2: 运行测试确认失败** — Run: `python -m pytest tests/test_cli_render.py -v`  Expected: FAIL (`ModuleNotFoundError: No module named 'tracksim.cli'`)

- [ ] **Step 3: 最小实现**

```python
# src/tracksim/cli/__init__.py
```

```python
# src/tracksim/cli/render.py
from __future__ import annotations

import json
from typing import Any, TextIO

from tracksim.envelope import SCHEMA_VERSION
from tracksim.simulator import (
    SimEvent,
    SimStarted,
    SimStopped,
    SimTick,
    SimWarning,
)


def render_success(envelope: dict[str, Any], fmt: str) -> str:
    if fmt == "json":
        return json.dumps(envelope)
    if fmt == "ndjson":
        return json.dumps(_result_line(envelope))
    return _text_success(envelope)


def render_error(envelope: dict[str, Any], fmt: str) -> str:
    if fmt == "json":
        return json.dumps(envelope)
    if fmt == "ndjson":
        return json.dumps(_result_line(envelope))
    return _text_error(envelope)


def _result_line(envelope: dict[str, Any]) -> dict[str, Any]:
    line: dict[str, Any] = {
        "type": "result",
        "sequence": 0,
        "timestamp": envelope["meta"]["timestamp"],
        "request_id": envelope["meta"]["request_id"],
        "schema_version": SCHEMA_VERSION,
        "final": True,
        "status": envelope["status"],
        "operation_id": envelope["operation_id"],
    }
    if envelope["status"] == "ok":
        line["data"] = envelope["data"]
    else:
        line["error"] = envelope["error"]
    return line


def _text_success(envelope: dict[str, Any]) -> str:
    data = envelope.get("data")
    if isinstance(data, dict):
        body = "\n".join(f"{k}: {v}" for k, v in data.items())
    else:
        body = str(data)
    return body


def _text_error(envelope: dict[str, Any]) -> str:
    err = envelope["error"]
    return f"error [{err['code']}] (exit {err['exit_code']}): {err['message']}"


class NdjsonWriter:
    """Writes sequenced ndjson event lines to a text stream."""

    def __init__(self, stream: TextIO, *, request_id: str, timestamp: str) -> None:
        self._stream = stream
        self._request_id = request_id
        self._timestamp = timestamp
        self._sequence = 0

    def _emit(self, event_type: str, fields: dict[str, Any]) -> None:
        line: dict[str, Any] = {
            "type": event_type,
            "sequence": self._sequence,
            "timestamp": self._timestamp,
            "request_id": self._request_id,
            "schema_version": SCHEMA_VERSION,
        }
        line.update(fields)
        self._stream.write(json.dumps(line) + "\n")
        self._stream.flush()
        self._sequence += 1

    def start(self, fields: dict[str, Any]) -> None:
        self._emit("start", fields)

    def progress(self, fields: dict[str, Any]) -> None:
        self._emit("progress", fields)

    def warning(self, message: str) -> None:
        self._emit("warning", {"message": message})

    def result(self, *, status: str, data: dict[str, Any]) -> None:
        self._emit("result", {"final": True, "status": status, "data": data})

    def event(self, event: SimEvent) -> None:
        fields = sim_event_fields(event)
        self._emit(fields.pop("type"), fields)


def sim_event_fields(event: SimEvent) -> dict[str, Any]:
    if isinstance(event, SimStarted):
        return {"type": "start", "protocols": list(event.protocols), "rate": event.rate}
    if isinstance(event, SimTick):
        return {
            "type": "progress",
            "packets_sent": event.packets_sent,
            "rate_actual": event.rate_actual,
            "pose": event.pose.model_dump(),
        }
    if isinstance(event, SimWarning):
        return {"type": "warning", "message": event.message}
    if isinstance(event, SimStopped):
        return {
            "type": "result",
            "final": True,
            "status": "ok",
            "reason": event.reason,
            "total_packets": event.total_packets,
        }
    raise TypeError(f"unknown SimEvent: {event!r}")
```

- [ ] **Step 4: 运行测试确认通过** — Run: `python -m pytest tests/test_cli_render.py -v`  Expected: PASS (7 passed)

- [ ] **Step 5: 提交**

```bash
git add src/tracksim/cli/__init__.py src/tracksim/cli/render.py tests/test_cli_render.py
git commit -m "feat(cli): add text/json/ndjson render layer and SimEvent mapping"
```

### Task 37: CLI 运行时上下文 — request_id / timestamp / output 解析 helpers

**Files:**
- Create: `src/tracksim/cli/runtime.py`
- Test: `tests/test_cli_runtime.py`

说明：把 envelope 元数据生成与 `--output` 默认值决策从 `main` 中拆出，便于单测。`new_request_id()` 返回 uuid4 字符串；`utc_now_iso()` 返回 ISO 8601 `...Z`；`resolve_output(explicit, ai_agent_env, is_tty)` 按优先级 显式 > `AI_AGENT=1`→json > tty→text，非 tty 也默认 text（§3.4）；`color_enabled(no_color_flag, no_color_env, is_tty)` 在 `--no-color`/`NO_COLOR`/非 tty 任一为真时返回 False。

- [ ] **Step 1: 写失败测试**

```python
# tests/test_cli_runtime.py
import re
import uuid

from tracksim.cli import runtime


def test_new_request_id_is_uuid4():
    rid = runtime.new_request_id()
    assert str(uuid.UUID(rid)) == rid


def test_utc_now_iso_format():
    ts = runtime.utc_now_iso()
    assert re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}", ts)
    assert ts.endswith("Z")


def test_resolve_output_explicit_wins():
    assert runtime.resolve_output("ndjson", ai_agent_env=True, is_tty=True) == "ndjson"


def test_resolve_output_ai_agent_env_json():
    assert runtime.resolve_output(None, ai_agent_env=True, is_tty=True) == "json"


def test_resolve_output_tty_text():
    assert runtime.resolve_output(None, ai_agent_env=False, is_tty=True) == "text"


def test_resolve_output_pipe_defaults_text():
    assert runtime.resolve_output(None, ai_agent_env=False, is_tty=False) == "text"


def test_color_disabled_by_flag():
    assert runtime.color_enabled(no_color_flag=True, no_color_env=False, is_tty=True) is False


def test_color_disabled_by_env():
    assert runtime.color_enabled(no_color_flag=False, no_color_env=True, is_tty=True) is False


def test_color_disabled_when_not_tty():
    assert runtime.color_enabled(no_color_flag=False, no_color_env=False, is_tty=False) is False


def test_color_enabled_when_tty_and_no_overrides():
    assert runtime.color_enabled(no_color_flag=False, no_color_env=False, is_tty=True) is True
```

- [ ] **Step 2: 运行测试确认失败** — Run: `python -m pytest tests/test_cli_runtime.py -v`  Expected: FAIL (`ModuleNotFoundError: No module named 'tracksim.cli.runtime'`)

- [ ] **Step 3: 最小实现**

```python
# src/tracksim/cli/runtime.py
from __future__ import annotations

import uuid
from datetime import datetime, timezone


def new_request_id() -> str:
    return str(uuid.uuid4())


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def resolve_output(explicit: str | None, *, ai_agent_env: bool, is_tty: bool) -> str:
    if explicit is not None:
        return explicit
    if ai_agent_env:
        return "json"
    return "text"


def color_enabled(*, no_color_flag: bool, no_color_env: bool, is_tty: bool) -> bool:
    if no_color_flag or no_color_env or not is_tty:
        return False
    return True
```

注：`resolve_output` 的关键字参数顺序在测试里用了位置传 `explicit` + 关键字 `ai_agent_env`/`is_tty`，实现签名保持一致。

- [ ] **Step 4: 运行测试确认通过** — Run: `python -m pytest tests/test_cli_runtime.py -v`  Expected: PASS (10 passed)

- [ ] **Step 5: 提交**

```bash
git add src/tracksim/cli/runtime.py tests/test_cli_runtime.py
git commit -m "feat(cli): add runtime helpers for output/color resolution and metadata"
```

### Task 38: meta 命令 — version / manifest / schema / completion

**Files:**
- Create: `src/tracksim/cli/commands/__init__.py`
- Create: `src/tracksim/cli/commands/meta.py`
- Test: `tests/test_cli_meta.py`

说明：纯函数式 operation handler，返回 `(operation_id, data)`，不做 IO。`version()` → `meta.version`；`manifest()` → `meta.manifest`（data 即 `build_manifest()`）；`schema(parser)` → `meta.schema`（data 为 CLI 结构描述）；`completion(shell)` → `meta.version`? 否——`completion` 不属于自描述 envelope，返回脚本字符串。`completion` 仅支持 `bash`|`zsh`|`fish`，未知 shell 抛 `TracksimError`（usage 范畴由 main 决定 exit 2，这里用 `UnsupportedProtocolError` 不合适——用通用 `TracksimError` code 默认 INTERNAL 不对；改为返回前在 main 用 argparse choices 限制，这里只对 choices 内的 shell 生成脚本）。

- [ ] **Step 1: 写失败测试**

```python
# tests/test_cli_meta.py
from tracksim import __version__ as pkg_version_module  # noqa: F401  (ensure package importable)
from tracksim.cli.commands import meta
from tracksim.manifest import build_manifest


def test_version_returns_operation_id_and_version():
    op, data = meta.version()
    assert op == "meta.version"
    assert isinstance(data["version"], str)
    assert data["version"]


def test_manifest_returns_build_manifest():
    op, data = meta.manifest()
    assert op == "meta.manifest"
    assert data == build_manifest()


def test_schema_returns_operation_ids():
    op, data = meta.schema()
    assert op == "meta.schema"
    ids = {c["operation_id"] for c in data["commands"]}
    assert ids == {o["operation_id"] for o in build_manifest()["operations"]}


def test_completion_bash_contains_program_name():
    script = meta.completion("bash")
    assert "tracksim" in script


def test_completion_supports_three_shells():
    for shell in ("bash", "zsh", "fish"):
        assert isinstance(meta.completion(shell), str)
        assert meta.completion(shell)
```

- [ ] **Step 2: 运行测试确认失败** — Run: `python -m pytest tests/test_cli_meta.py -v`  Expected: FAIL (`ModuleNotFoundError: No module named 'tracksim.cli.commands'`)

- [ ] **Step 3: 最小实现**

```python
# src/tracksim/cli/commands/__init__.py
```

```python
# src/tracksim/cli/commands/meta.py
from __future__ import annotations

from typing import Any

from tracksim.manifest import build_manifest

VERSION = "0.1.0"


def version() -> tuple[str, dict[str, Any]]:
    return "meta.version", {
        "version": VERSION,
        "contract_version": build_manifest()["contract_version"],
    }


def manifest() -> tuple[str, dict[str, Any]]:
    return "meta.manifest", build_manifest()


def schema() -> tuple[str, dict[str, Any]]:
    m = build_manifest()
    commands = [
        {"operation_id": op["operation_id"], "summary": op["summary"]}
        for op in m["operations"]
    ]
    return "meta.schema", {"commands": commands}


_BASH = """\
# bash completion for tracksim
_tracksim_completions() {
  local cur="${COMP_WORDS[COMP_CWORD]}"
  local cmds="run send controllers config freed opentrackio manifest schema completion version"
  COMPREPLY=( $(compgen -W "${cmds}" -- "${cur}") )
}
complete -F _tracksim_completions tracksim
"""

_ZSH = """\
#compdef tracksim
_tracksim() {
  local -a cmds
  cmds=(run send controllers config freed opentrackio manifest schema completion version)
  _describe 'command' cmds
}
_tracksim "$@"
"""

_FISH = """\
# fish completion for tracksim
complete -c tracksim -f
for cmd in run send controllers config freed opentrackio manifest schema completion version
    complete -c tracksim -n __fish_use_subcommand -a $cmd
end
"""


def completion(shell: str) -> str:
    scripts = {"bash": _BASH, "zsh": _ZSH, "fish": _FISH}
    return scripts[shell]
```

- [ ] **Step 4: 运行测试确认通过** — Run: `python -m pytest tests/test_cli_meta.py -v`  Expected: PASS (5 passed)

- [ ] **Step 5: 提交**

```bash
git add src/tracksim/cli/commands/__init__.py src/tracksim/cli/commands/meta.py tests/test_cli_meta.py
git commit -m "feat(cli): add meta commands (version/manifest/schema/completion)"
```

### Task 39: decode 命令 — freed / opentrackio 包解析

**Files:**
- Create: `src/tracksim/cli/commands/decode.py`
- Test: `tests/test_cli_decode.py`

说明：`freed_decode(data: bytes)` 解析 29 字节 D1 包 → 字段 dict（校验长度/类型/checksum，非法抛 `InvalidTrajectoryError`），返回 `("freed.decode", {...})`。`opentrackio_decode(data: bytes)` 解析 OTrk 头 + JSON/CBOR payload → `("opentrackio.decode", {...})`，校验 identifier 与 fletcher16。复用 `tracksim.checksum.fletcher16` 与 `emitters.opentrackio` 常量；解码为本地纯函数，不引入新协议常量。

- [ ] **Step 1: 写失败测试**

```python
# tests/test_cli_decode.py
import json
import struct

import pytest

from tracksim.checksum import fletcher16
from tracksim.cli.commands import decode
from tracksim.domain.errors import InvalidTrajectoryError
from tracksim.domain.pose import CameraPose
from tracksim.emitters.freed import FreeDScaling, encode_d1
from tracksim.emitters.opentrackio import (
    ENCODING_JSON,
    OTRK_IDENTIFIER,
    build_packets,
    build_sample,
)


def test_freed_decode_roundtrips_basic_fields():
    pose = CameraPose(pan=12.0, tilt=-3.0, x=1.0, z=2.0)
    packet = encode_d1(pose, camera_id=7, scaling=FreeDScaling())
    op, data = decode.freed_decode(packet)
    assert op == "freed.decode"
    assert data["camera_id"] == 7
    assert data["message_type"] == "0xD1"
    assert abs(data["pan"] - 12.0) < 0.01
    assert abs(data["tilt"] - (-3.0)) < 0.01
    assert data["checksum_valid"] is True


def test_freed_decode_rejects_wrong_length():
    with pytest.raises(InvalidTrajectoryError):
        decode.freed_decode(b"\x00" * 10)


def test_freed_decode_rejects_bad_checksum():
    pose = CameraPose(pan=1.0)
    packet = bytearray(encode_d1(pose, camera_id=0, scaling=FreeDScaling()))
    packet[-1] ^= 0xFF
    with pytest.raises(InvalidTrajectoryError):
        decode.freed_decode(bytes(packet))


def test_opentrackio_decode_returns_sample_fields():
    pose = CameraPose(pan=5.0, focal_length=50.0)
    sample = build_sample(pose, source_number=3, sequence=0, static_meta={})
    payload = json.dumps(sample).encode("utf-8")
    packet = build_packets(payload, encoding=ENCODING_JSON, sequence=0)[0]
    op, data = decode.opentrackio_decode(packet)
    assert op == "opentrackio.decode"
    assert data["encoding"] == "json"
    assert data["sample"]["sourceNumber"] == 3
    assert data["checksum_valid"] is True


def test_opentrackio_decode_rejects_bad_identifier():
    bad = b"XXXX" + b"\x00" * 12
    with pytest.raises(InvalidTrajectoryError):
        decode.opentrackio_decode(bad)
```

- [ ] **Step 2: 运行测试确认失败** — Run: `python -m pytest tests/test_cli_decode.py -v`  Expected: FAIL (`ModuleNotFoundError: No module named 'tracksim.cli.commands.decode'`)

- [ ] **Step 3: 最小实现**

```python
# src/tracksim/cli/commands/decode.py
from __future__ import annotations

import json
import struct
from typing import Any

from tracksim.checksum import fletcher16
from tracksim.domain.errors import InvalidTrajectoryError
from tracksim.emitters.freed import FreeDScaling
from tracksim.emitters.opentrackio import (
    ENCODING_CBOR,
    ENCODING_JSON,
    OTRK_HEADER_LENGTH,
    OTRK_IDENTIFIER,
)


def _unpack_s24(buf: bytes) -> int:
    v = (buf[0] << 16) | (buf[1] << 8) | buf[2]
    if v & 0x800000:
        v -= 0x1000000
    return v


def freed_decode(data: bytes, *, scaling: FreeDScaling = FreeDScaling()) -> tuple[str, dict[str, Any]]:
    if len(data) != 29:
        raise InvalidTrajectoryError(
            f"FreeD packet must be 29 bytes, got {len(data)}",
            details={"length": len(data)},
        )
    if data[0] != 0xD1:
        raise InvalidTrajectoryError(
            f"unsupported FreeD message type: 0x{data[0]:02X}",
            details={"message_type": data[0]},
        )
    expected = (0x40 - sum(data[:28])) & 0xFF
    checksum_valid = expected == data[28]
    if not checksum_valid:
        raise InvalidTrajectoryError(
            "FreeD checksum mismatch",
            details={"expected": expected, "actual": data[28]},
        )
    result = {
        "message_type": "0xD1",
        "camera_id": data[1],
        "pan": _unpack_s24(data[2:5]) / scaling.angle_lsb_per_deg,
        "tilt": _unpack_s24(data[5:8]) / scaling.angle_lsb_per_deg,
        "roll": _unpack_s24(data[8:11]) / scaling.angle_lsb_per_deg,
        "x": _unpack_s24(data[11:14]) / scaling.pos_lsb_per_m,
        "y": _unpack_s24(data[14:17]) / scaling.pos_lsb_per_m,
        "z": _unpack_s24(data[17:20]) / scaling.pos_lsb_per_m,
        "zoom_raw": (data[20] << 16) | (data[21] << 8) | data[22],
        "focus_raw": (data[23] << 16) | (data[24] << 8) | data[25],
        "checksum_valid": checksum_valid,
    }
    return "freed.decode", result


def opentrackio_decode(data: bytes) -> tuple[str, dict[str, Any]]:
    if len(data) < OTRK_HEADER_LENGTH:
        raise InvalidTrajectoryError(
            f"OpenTrackIO packet too short: {len(data)} bytes",
            details={"length": len(data)},
        )
    if data[0:4] != OTRK_IDENTIFIER:
        raise InvalidTrajectoryError(
            "OpenTrackIO identifier mismatch",
            details={"identifier": data[0:4].hex()},
        )
    encoding = data[5]
    sequence = struct.unpack("!H", data[6:8])[0]
    offset = struct.unpack("!I", data[8:12])[0]
    l_and_len = struct.unpack("!H", data[12:14])[0]
    last_segment = bool(l_and_len >> 15)
    payload_length = l_and_len & 0x7FFF
    stored_checksum = struct.unpack("!H", data[14:16])[0]
    payload = data[OTRK_HEADER_LENGTH : OTRK_HEADER_LENGTH + payload_length]
    computed = fletcher16(data[0:14] + payload)
    checksum_valid = computed == stored_checksum
    if not checksum_valid:
        raise InvalidTrajectoryError(
            "OpenTrackIO fletcher16 checksum mismatch",
            details={"expected": stored_checksum, "actual": computed},
        )
    if encoding == ENCODING_CBOR:
        import cbor2

        sample = cbor2.loads(payload)
        encoding_name = "cbor"
    else:
        sample = json.loads(payload.decode("utf-8"))
        encoding_name = "json"
    return "opentrackio.decode", {
        "encoding": encoding_name,
        "sequence": sequence,
        "segment_offset": offset,
        "last_segment": last_segment,
        "checksum_valid": checksum_valid,
        "sample": sample,
    }
```

- [ ] **Step 4: 运行测试确认通过** — Run: `python -m pytest tests/test_cli_decode.py -v`  Expected: PASS (5 passed)

- [ ] **Step 5: 提交**

```bash
git add src/tracksim/cli/commands/decode.py tests/test_cli_decode.py
git commit -m "feat(cli): add freed/opentrackio decode commands"
```

### Task 40: config 命令 — init (dry-run) / show / validate

**Files:**
- Create: `src/tracksim/cli/commands/config_cmd.py`
- Test: `tests/test_cli_config_cmd.py`

说明：`init(path, *, dry_run, force=False)` → `config.init`：`dry_run=True` 时返回 `data.dry_run_plan`（含目标路径、`action`=create/overwrite、将写入的 TOML 文本）且**不写文件**；`dry_run=False` 时——**若目标已存在且未 `force` 则抛 `ConflictError`(exit 6)**（CLI_DESIGN_SPEC §9：覆盖配置属破坏性操作，需显式确认），否则写默认 TOML 并返回 `data.written`。CLI 层把全局 `--yes` 映射为 `force=True`（见 Task 45）。`show(config)` → `config.show` data 为 `config.model_dump()`。`validate(config)` → `config.validate` data `{"valid": True}`（能构造出 `Config` 即合法；构造失败的 `ConfigError` 由 `load_config`/main 处理）。默认 TOML 文本用内置常量，不依赖运行期 toml writer（避免引入 tomllib write 缺失）。

- [ ] **Step 1: 写失败测试**

```python
# tests/test_cli_config_cmd.py
import os

import pytest

from tracksim.cli.commands import config_cmd
from tracksim.config import load_config
from tracksim.domain.errors import ConflictError


def test_init_dry_run_writes_nothing(tmp_path):
    target = tmp_path / "tracksim.toml"
    op, data = config_cmd.init(str(target), dry_run=True)
    assert op == "config.init"
    assert "dry_run_plan" in data
    assert data["dry_run_plan"]["path"] == str(target)
    assert "[protocols]" in data["dry_run_plan"]["content"]
    assert not target.exists()


def test_init_real_write_creates_file(tmp_path):
    target = tmp_path / "tracksim.toml"
    op, data = config_cmd.init(str(target), dry_run=False)
    assert op == "config.init"
    assert data["written"] is True
    assert target.exists()
    assert "[protocols]" in target.read_text()


def test_init_real_write_is_loadable(tmp_path):
    target = tmp_path / "tracksim.toml"
    config_cmd.init(str(target), dry_run=False)
    cfg = load_config(str(target))
    assert cfg is not None


def test_init_existing_file_requires_force(tmp_path):
    target = tmp_path / "tracksim.toml"
    target.write_text("# user-tuned config\n", encoding="utf-8")
    with pytest.raises(ConflictError):
        config_cmd.init(str(target), dry_run=False)
    # 未被覆盖
    assert target.read_text() == "# user-tuned config\n"


def test_init_force_overwrites_existing(tmp_path):
    target = tmp_path / "tracksim.toml"
    target.write_text("# user-tuned config\n", encoding="utf-8")
    op, data = config_cmd.init(str(target), dry_run=False, force=True)
    assert data["written"] is True
    assert data["overwritten"] is True
    assert "[protocols]" in target.read_text()


def test_init_dry_run_action_overwrite_when_exists(tmp_path):
    target = tmp_path / "tracksim.toml"
    target.write_text("# user-tuned config\n", encoding="utf-8")
    op, data = config_cmd.init(str(target), dry_run=True)
    assert data["dry_run_plan"]["action"] == "overwrite"
    assert target.read_text() == "# user-tuned config\n"


def test_show_returns_config_dump():
    cfg = load_config(None)
    op, data = config_cmd.show(cfg)
    assert op == "config.show"
    assert data == cfg.model_dump()


def test_validate_ok():
    cfg = load_config(None)
    op, data = config_cmd.validate(cfg)
    assert op == "config.validate"
    assert data["valid"] is True
```

- [ ] **Step 2: 运行测试确认失败** — Run: `python -m pytest tests/test_cli_config_cmd.py -v`  Expected: FAIL (`ModuleNotFoundError: No module named 'tracksim.cli.commands.config_cmd'`)

- [ ] **Step 3: 最小实现**

```python
# src/tracksim/cli/commands/config_cmd.py
from __future__ import annotations

import os
from typing import Any

from tracksim.config import Config
from tracksim.domain.errors import ConflictError

DEFAULT_CONFIG_TOML = """\
[protocols]
freed = true
opentrackio = false

[freed]
transport = "udp_unicast"
target_ip = "127.0.0.1"
port = 6000
serial_device = "/dev/ttyUSB0"
baud = 38400
camera_id = 0
rate_hz = 60.0

[freed.scaling]
variant = "native"
angle_lsb_per_deg = 32768.0
pos_lsb_per_m = 64000.0

[opentrackio]
transport = "multicast"
source_number = 1
ip = "239.135.1.1"
port = 55555
encoding = "json"
rate_hz = 60.0

[controller]
device = "0"

[motion]
motion = "static"
radius = 1.0
speed = 1.0
amplitude = 1.0
freq = 0.5

[output]
format = "text"
log_level = "info"
"""


def init(
    path: str, *, dry_run: bool, force: bool = False
) -> tuple[str, dict[str, Any]]:
    exists = os.path.exists(path)
    if dry_run:
        return "config.init", {
            "dry_run_plan": {
                "path": path,
                "action": "overwrite" if exists else "create",
                "content": DEFAULT_CONFIG_TOML,
            }
        }
    if exists and not force:
        # 破坏性操作（CLI_DESIGN_SPEC §9）：覆盖已有配置需显式 --yes
        raise ConflictError(
            f"config file already exists: {path} (use --yes to overwrite)",
            details={"path": path},
        )
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(DEFAULT_CONFIG_TOML)
    return "config.init", {"written": True, "path": path, "overwritten": exists}


def show(config: Config) -> tuple[str, dict[str, Any]]:
    return "config.show", config.model_dump()


def validate(config: Config) -> tuple[str, dict[str, Any]]:
    return "config.validate", {"valid": True}
```

- [ ] **Step 4: 运行测试确认通过** — Run: `python -m pytest tests/test_cli_config_cmd.py -v`  Expected: PASS (8 passed)

- [ ] **Step 5: 提交**

```bash
git add src/tracksim/cli/commands/config_cmd.py tests/test_cli_config_cmd.py
git commit -m "feat(cli): add config init/show/validate commands"
```

### Task 41: send 命令 — 单帧 / 持续固定位姿

**Files:**
- Create: `src/tracksim/cli/commands/send.py`
- Test: `tests/test_cli_send.py`

说明：`build_pose(flags, stdin_obj)` 从 flag 值与可选 stdin JSON 构造 `CameraPose`（stdin JSON 字段覆盖默认，非法字段抛 `InvalidTrajectoryError`）。`send_once(emitters, pose)` 对每个 emitter `emit(pose)` 一次，返回 `("sim.send", {...packets...})`。`send_hold(emitters, pose, clock, rate, duration)` 按 `rate` 在 `duration` 秒内重复 emit，用注入的 `Clock` 计时（`FakeClock` 可测）。本任务只测纯逻辑（用 `FakeEmitter`/`FakeClock`），真实 UDP 收包在 Task 44 conformance。

- [ ] **Step 1: 写失败测试**

```python
# tests/test_cli_send.py
import pytest

from tracksim.cli.commands import send
from tracksim.domain.errors import InvalidTrajectoryError
from tracksim.domain.pose import CameraPose


class FakeEmitter:
    def __init__(self, name: str) -> None:
        self.name = name
        self.emitted: list[CameraPose] = []
        self.closed = False

    def emit(self, pose: CameraPose) -> None:
        self.emitted.append(pose)

    def close(self) -> None:
        self.closed = True


class FakeClock:
    def __init__(self) -> None:
        self.t = 0.0
        self.slept: list[float] = []

    def now(self) -> float:
        return self.t

    def sleep(self, seconds: float) -> None:
        self.slept.append(seconds)
        self.t += seconds


def test_build_pose_from_flags():
    pose = send.build_pose({"pan": 30.0, "x": 1.5}, None)
    assert pose.pan == 30.0
    assert pose.x == 1.5


def test_build_pose_stdin_overrides():
    pose = send.build_pose({"pan": 0.0}, {"pan": 45.0, "tilt": -10.0})
    assert pose.pan == 45.0
    assert pose.tilt == -10.0


def test_build_pose_rejects_bad_field():
    with pytest.raises(InvalidTrajectoryError):
        send.build_pose({}, {"pan": "not-a-number"})


def test_send_once_emits_to_all_emitters():
    e1 = FakeEmitter("freed")
    e2 = FakeEmitter("opentrackio")
    pose = CameraPose(pan=10.0)
    op, data = send.send_once([e1, e2], pose)
    assert op == "sim.send"
    assert len(e1.emitted) == 1
    assert len(e2.emitted) == 1
    assert data["packets_sent"] == 2
    assert set(data["protocols"]) == {"freed", "opentrackio"}


def test_send_hold_repeats_for_duration():
    e1 = FakeEmitter("freed")
    clock = FakeClock()
    pose = CameraPose()
    op, data = send.send_hold([e1], pose, clock=clock, rate=10.0, duration=0.5)
    assert op == "sim.send"
    assert len(e1.emitted) == 5
    assert data["packets_sent"] == 5


def test_send_hold_sub_frame_duration_sends_at_least_one_frame():
    # 防回归 F8：duration=0.05, rate=10 -> 0.5 帧；round 会银行家舍入成 0（静默空发），
    # 必须 ceil+下限 1，至少发 1 帧
    e1 = FakeEmitter("freed")
    op, data = send.send_hold([e1], CameraPose(), clock=FakeClock(), rate=10.0, duration=0.05)
    assert data["frames"] == 1
    assert data["packets_sent"] == 1
    assert len(e1.emitted) == 1


def test_send_hold_rejects_nonpositive_duration():
    e1 = FakeEmitter("freed")
    with pytest.raises(InvalidTrajectoryError):
        send.send_hold([e1], CameraPose(), clock=FakeClock(), rate=10.0, duration=0.0)
```

- [ ] **Step 2: 运行测试确认失败** — Run: `python -m pytest tests/test_cli_send.py -v`  Expected: FAIL (`ModuleNotFoundError: No module named 'tracksim.cli.commands.send'`)

- [ ] **Step 3: 最小实现**

```python
# src/tracksim/cli/commands/send.py
from __future__ import annotations

import math
from typing import Any

from pydantic import ValidationError

from tracksim.domain.errors import InvalidTrajectoryError
from tracksim.domain.pose import CameraPose
from tracksim.ports.clock import Clock
from tracksim.ports.emitter import Emitter

_POSE_FIELDS = set(CameraPose.model_fields.keys())


def build_pose(flags: dict[str, Any], stdin_obj: dict[str, Any] | None) -> CameraPose:
    values: dict[str, Any] = {
        k: v for k, v in flags.items() if k in _POSE_FIELDS and v is not None
    }
    if stdin_obj:
        for k, v in stdin_obj.items():
            if k not in _POSE_FIELDS:
                raise InvalidTrajectoryError(
                    f"unknown pose field: {k!r}",
                    details={"field": k},
                )
            values[k] = v
    try:
        return CameraPose(**values)
    except ValidationError as exc:
        raise InvalidTrajectoryError(
            "invalid pose input",
            details={"errors": exc.errors(include_url=False)},
        ) from exc


def send_once(emitters: list[Emitter], pose: CameraPose) -> tuple[str, dict[str, Any]]:
    for emitter in emitters:
        emitter.emit(pose)
    return "sim.send", {
        "packets_sent": len(emitters),
        "protocols": [e.name for e in emitters],
        "frames": 1,
    }


def send_hold(
    emitters: list[Emitter],
    pose: CameraPose,
    *,
    clock: Clock,
    rate: float,
    duration: float,
) -> tuple[str, dict[str, Any]]:
    if duration <= 0 or rate <= 0:
        raise InvalidTrajectoryError(
            "send hold requires duration > 0 and rate > 0",
            details={"duration": duration, "rate": rate},
        )
    period = 1.0 / rate
    # 任何正 duration 至少发 1 帧；用 ceil 而非 round，避免银行家舍入把 0.5 帧截成 0 帧的静默空发（修复 F8）
    total_frames = max(1, math.ceil(duration * rate))
    sent = 0
    for _ in range(total_frames):
        for emitter in emitters:
            emitter.emit(pose)
            sent += 1
        clock.sleep(period)
    return "sim.send", {
        "packets_sent": sent,
        "protocols": [e.name for e in emitters],
        "frames": total_frames,
    }
```

- [ ] **Step 4: 运行测试确认通过** — Run: `python -m pytest tests/test_cli_send.py -v`  Expected: PASS (7 passed)

- [ ] **Step 5: 提交**

```bash
git add src/tracksim/cli/commands/send.py tests/test_cli_send.py
git commit -m "feat(cli): add send command (single frame / hold duration)"
```

### Task 42: emitter / source 工厂 — 从 Config + flags 构建

**Files:**
- Create: `src/tracksim/cli/commands/factory.py`
- Test: `tests/test_cli_factory.py`

说明：把"从 `Config` + CLI flag 构造 `Emitter` 列表 / `PoseSource` / `Clock`"的接线逻辑集中，供 `run`/`send` 共用。`build_emitters(config, protocols)` 按启用协议构造 `FreeDEmitter`(over `UdpTransport`/`SerialTransport`) 与 `OpenTrackIOEmitter`(over `UdpTransport`)，未知协议抛 `UnsupportedProtocolError`。`build_source(config, source, rate, clock)` 按 `static|script|controller` 构造 `PoseSource`；`controller` 无设备时由底层抛 `NoControllerError`（此处不 mock SDL，测试只覆盖 `static`/`script` + 协议/未知分支）。

- [ ] **Step 1: 写失败测试**

```python
# tests/test_cli_factory.py
import pytest

from tracksim.cli.commands import factory
from tracksim.config import load_config
from tracksim.domain.errors import UnsupportedProtocolError
from tracksim.emitters.freed import FreeDEmitter
from tracksim.emitters.opentrackio import OpenTrackIOEmitter
from tracksim.infra.clock import FakeClock
from tracksim.sources.static import StaticPoseSource
from tracksim.sources.scripted import ScriptedPoseSource


def test_build_emitters_freed_only():
    cfg = load_config(None)
    emitters = factory.build_emitters(cfg, ["freed"])
    assert len(emitters) == 1
    assert isinstance(emitters[0], FreeDEmitter)
    assert emitters[0].name == "freed"
    for e in emitters:
        e.close()


def test_build_emitters_both_protocols():
    cfg = load_config(None)
    emitters = factory.build_emitters(cfg, ["freed", "opentrackio"])
    names = {e.name for e in emitters}
    assert names == {"freed", "opentrackio"}
    assert any(isinstance(e, OpenTrackIOEmitter) for e in emitters)
    for e in emitters:
        e.close()


def test_build_emitters_unknown_protocol_raises():
    cfg = load_config(None)
    with pytest.raises(UnsupportedProtocolError):
        factory.build_emitters(cfg, ["bogus"])


def test_build_source_static():
    cfg = load_config(None)
    clock = FakeClock()
    src = factory.build_source(cfg, "static", rate=60.0, clock=clock)
    assert isinstance(src, StaticPoseSource)
    src.close()


def test_build_source_script():
    cfg = load_config(None)
    clock = FakeClock()
    src = factory.build_source(cfg, "script", rate=60.0, clock=clock)
    assert isinstance(src, ScriptedPoseSource)
    src.close()
```

- [ ] **Step 2: 运行测试确认失败** — Run: `python -m pytest tests/test_cli_factory.py -v`  Expected: FAIL (`ModuleNotFoundError: No module named 'tracksim.cli.commands.factory'`)

- [ ] **Step 3: 最小实现**

```python
# src/tracksim/cli/commands/factory.py
from __future__ import annotations

from tracksim.config import Config
from tracksim.domain.errors import UnsupportedProtocolError
from tracksim.domain.pose import CameraPose
from tracksim.emitters.freed import FreeDEmitter, FreeDScaling
from tracksim.emitters.opentrackio import (
    ENCODING_CBOR,
    ENCODING_JSON,
    OpenTrackIOEmitter,
)
from tracksim.ports.clock import Clock
from tracksim.ports.emitter import Emitter
from tracksim.ports.pose_source import PoseSource
from tracksim.sources.scripted import ScriptedPoseSource
from tracksim.sources.static import StaticPoseSource
from tracksim.transports.serial_port import SerialTransport
from tracksim.transports.udp import UdpTransport

_FREED_UDP_MODE = {"udp_unicast": "unicast", "udp_broadcast": "broadcast"}


def _build_freed(config: Config) -> FreeDEmitter:
    fc = config.freed
    if fc.transport == "serial":
        transport = SerialTransport(fc.serial_device, baud=fc.baud)
    else:
        mode = _FREED_UDP_MODE.get(fc.transport, "unicast")
        transport = UdpTransport(mode, fc.target_ip, fc.port)
    scaling = FreeDScaling(
        variant=fc.scaling.variant,
        angle_lsb_per_deg=fc.scaling.angle_lsb_per_deg,
        pos_lsb_per_m=fc.scaling.pos_lsb_per_m,
    )
    return FreeDEmitter(transport, camera_id=fc.camera_id, scaling=scaling)


def _build_opentrackio(config: Config) -> OpenTrackIOEmitter:
    oc = config.opentrackio
    mode = "multicast" if oc.transport == "multicast" else "unicast"
    transport = UdpTransport(mode, oc.ip, oc.port)
    encoding = ENCODING_CBOR if oc.encoding == "cbor" else ENCODING_JSON
    return OpenTrackIOEmitter(
        transport, source_number=oc.source_number, encoding=encoding
    )


def build_emitters(config: Config, protocols: list[str]) -> list[Emitter]:
    emitters: list[Emitter] = []
    for proto in protocols:
        if proto == "freed":
            emitters.append(_build_freed(config))
        elif proto == "opentrackio":
            emitters.append(_build_opentrackio(config))
        else:
            raise UnsupportedProtocolError(
                f"unknown protocol: {proto!r}",
                details={"protocol": proto},
            )
    return emitters


def build_source(
    config: Config, source: str, *, rate: float, clock: Clock
) -> PoseSource:
    if source == "static":
        return StaticPoseSource(CameraPose(rate=rate), clock=clock)
    if source == "script":
        mc = config.motion
        return ScriptedPoseSource(
            motion=mc.motion,
            radius=mc.radius,
            speed=mc.speed,
            amplitude=mc.amplitude,
            freq=mc.freq,
            rate=rate,
            clock=clock,
        )
    raise UnsupportedProtocolError(
        f"unknown pose source: {source!r}",
        details={"source": source},
    )
```

注：`ScriptedPoseSource` 的程序化构造参数（`motion/radius/speed/amplitude/freq/rate/clock`）须与 Section（sources/scripted.py）实现的关键字签名一致；若该 Section 暴露的是 `ScriptedPoseSource(config_or_params...)`，在本任务实现期对齐其实际签名。`controller` 来源**由 Task 45 `_dispatch` 的 run 分支单独接线**（构造 `SDLControllerInput`、`open(config.controller.device)`、`ControllerPoseSource(config.controller.mapping, clock)`），本工厂不处理以避免在无设备环境构造失败（修复 F5：此前 controller 源无人接线，`run --source controller` 会落到 factory 的 `UnsupportedProtocolError`）。

- [ ] **Step 4: 运行测试确认通过** — Run: `python -m pytest tests/test_cli_factory.py -v`  Expected: PASS (5 passed)

- [ ] **Step 5: 提交**

```bash
git add src/tracksim/cli/commands/factory.py tests/test_cli_factory.py
git commit -m "feat(cli): add emitter/source factory wiring from Config"
```

### Task 43: run 命令 — 驱动 Simulator 并流式 ndjson

**Files:**
- Create: `src/tracksim/cli/commands/run.py`
- Test: `tests/test_cli_run.py`

说明：`run_stream(simulator, writer)` 迭代 `simulator.run()`：`writer` 非空（ndjson 模式）时对每个 `SimEvent` 调 `writer.event(...)` 流式写出；`writer=None`（json/text 模式）时不写 stdout，只累计 `ticks`/`total_packets`/`reason` 汇总。返回 `("sim.run", {...})`。`make_simulator(source, emitters, clock, rate, fail_fast)` 仅构造 `Simulator`。用 `FakePoseSource`/`FakeEmitter`/`FakeClock` + 真实 `Simulator` 驱动（不 mock Simulator）。

- [ ] **Step 1: 写失败测试**

```python
# tests/test_cli_run.py
import io
import json

from tracksim.cli import render
from tracksim.cli.commands import run
from tracksim.domain.pose import CameraPose
from tracksim.simulator import Simulator


class FakeEmitter:
    def __init__(self, name: str) -> None:
        self.name = name
        self.emitted = 0
        self.closed = False

    def emit(self, pose: CameraPose) -> None:
        self.emitted += 1

    def close(self) -> None:
        self.closed = True


class FakePoseSource:
    def __init__(self, frames: int) -> None:
        self._frames = frames
        self._n = 0
        self.closed = False

    def next(self, dt: float) -> CameraPose:
        self._n += 1
        if self._n > self._frames:
            raise StopIteration
        return CameraPose(frame=self._n)

    def close(self) -> None:
        self.closed = True


class FakeClock:
    def __init__(self) -> None:
        self.t = 0.0

    def now(self) -> float:
        return self.t

    def sleep(self, seconds: float) -> None:
        self.t += seconds


def test_make_simulator_returns_simulator():
    sim = run.make_simulator(
        FakePoseSource(2), [FakeEmitter("freed")], FakeClock(), rate=60.0, fail_fast=False
    )
    assert isinstance(sim, Simulator)


def test_run_stream_emits_ndjson_with_final_result():
    src = FakePoseSource(3)
    emitter = FakeEmitter("freed")
    sim = Simulator(src, [emitter], FakeClock(), rate=60.0)
    buf = io.StringIO()
    writer = render.NdjsonWriter(buf, request_id="rq", timestamp="2026-06-02T00:00:00Z")
    op, data = run.run_stream(sim, writer)
    assert op == "sim.run"
    objs = [json.loads(ln) for ln in buf.getvalue().splitlines() if ln]
    assert objs[0]["type"] == "start"
    assert objs[-1]["type"] == "result"
    assert objs[-1]["final"] is True
    assert any(o["type"] == "progress" for o in objs)
    assert data["total_packets"] == objs[-1]["total_packets"]


def test_run_stream_without_writer_collects_summary_no_stdout():
    # 防回归 F2：json/text 模式 writer=None，不写中间行，只返回 summary
    src = FakePoseSource(3)
    sim = Simulator(src, [FakeEmitter("freed")], FakeClock(), rate=60.0)
    op, data = run.run_stream(sim, None)
    assert op == "sim.run"
    assert data["ticks"] == 3
    assert data["total_packets"] == 3
    assert data["reason"] == "source-exhausted"
```

- [ ] **Step 2: 运行测试确认失败** — Run: `python -m pytest tests/test_cli_run.py -v`  Expected: FAIL (`ModuleNotFoundError: No module named 'tracksim.cli.commands.run'`)

- [ ] **Step 3: 最小实现**

```python
# src/tracksim/cli/commands/run.py
from __future__ import annotations

from typing import Any

from tracksim.cli.render import NdjsonWriter, sim_event_fields
from tracksim.ports.clock import Clock
from tracksim.ports.emitter import Emitter
from tracksim.ports.pose_source import PoseSource
from tracksim.simulator import SimStopped, SimTick, Simulator


def make_simulator(
    source: PoseSource,
    emitters: list[Emitter],
    clock: Clock,
    *,
    rate: float,
    fail_fast: bool = False,
) -> Simulator:
    return Simulator(source, emitters, clock, rate=rate, fail_fast=fail_fast)


def run_stream(
    simulator: Simulator,
    writer: NdjsonWriter | None,
    *,
    max_ticks: int | None = None,
) -> tuple[str, dict[str, Any]]:
    # writer 非空（ndjson 模式）：逐事件流式写出；writer=None（json/text 模式）：
    # 不向 stdout 写任何中间行，只累计 summary，由 main 输出单个 envelope（修复 F2 stdout 污染）。
    # max_ticks 非空（来自 --duration*rate）：达到后调用 simulator.stop() 优雅收尾，使 run 有界可测。
    summary: dict[str, Any] = {"total_packets": 0, "ticks": 0, "reason": "completed"}
    ticks = 0
    for event in simulator.run():
        if writer is not None:
            writer.event(event)
        if isinstance(event, SimTick):
            ticks += 1
            if max_ticks is not None and ticks >= max_ticks:
                simulator.stop()
        if isinstance(event, SimStopped):
            summary = {"total_packets": event.total_packets, "reason": event.reason}
    summary["ticks"] = ticks
    return "sim.run", summary
```

注：`make_simulator` 用关键字 `rate`/`fail_fast`，与 SHARED CONTRACT 的 `Simulator(source, emitters, clock, rate, fail_fast=False)` 一致；测试中以位置传 `rate=` 关键字。`run_stream` 的 `writer` 可为 `None`（json/text 模式），此时不污染 stdout。

- [ ] **Step 4: 运行测试确认通过** — Run: `python -m pytest tests/test_cli_run.py -v`  Expected: PASS (3 passed)

- [ ] **Step 5: 提交**

```bash
git add src/tracksim/cli/commands/run.py tests/test_cli_run.py
git commit -m "feat(cli): add run command streaming SimEvents to ndjson"
```

### Task 44: controllers 命令 — list / monitor

**Files:**
- Create: `src/tracksim/cli/commands/controllers.py`
- Test: `tests/test_cli_controllers.py`

说明：`list_controllers(controller_input)` → `controllers.list`，data 为 `{"devices": [{index,name,guid}, ...]}`；空列表不抛错（`run`/SDL 真正打开设备时才抛 `NoControllerError`）。`monitor_stream(controller_input, writer, *, clock, rate, samples)` 打开第 0 个设备（无设备抛 `NoControllerError`），按 `rate` 采样 `samples` 次：`writer` 非空（ndjson 模式）时每次把 `ControllerState` 作为 progress ndjson 行发出并结尾发 `result`；`writer=None`（json/text 模式）时不写 stdout，只累计最后一帧到 summary。用 `FakeControllerInput`（实现 SHARED CONTRACT 的 `ControllerInput` 协议）+ `FakeClock` 测试。

- [ ] **Step 1: 写失败测试**

```python
# tests/test_cli_controllers.py
import io
import json

import pytest

from tracksim.cli import render
from tracksim.cli.commands import controllers
from tracksim.domain.errors import NoControllerError
from tracksim.ports.controller_input import ControllerDevice, ControllerState


class FakeControllerInput:
    def __init__(self, devices, states=None):
        self._devices = devices
        self._states = states or []
        self._i = 0
        self.opened = None
        self.closed = False

    def list_devices(self):
        return list(self._devices)

    def open(self, index: int) -> None:
        if not self._devices:
            raise NoControllerError("no controller", details={"index": index})
        self.opened = index

    def poll(self) -> ControllerState:
        st = self._states[min(self._i, len(self._states) - 1)]
        self._i += 1
        return st

    def close(self) -> None:
        self.closed = True


class FakeClock:
    def __init__(self) -> None:
        self.t = 0.0

    def now(self) -> float:
        return self.t

    def sleep(self, seconds: float) -> None:
        self.t += seconds


def test_list_controllers_returns_devices():
    ci = FakeControllerInput([ControllerDevice(index=0, name="Pad", guid="g0")])
    op, data = controllers.list_controllers(ci)
    assert op == "controllers.list"
    assert data["devices"] == [{"index": 0, "name": "Pad", "guid": "g0"}]


def test_list_controllers_empty_ok():
    ci = FakeControllerInput([])
    op, data = controllers.list_controllers(ci)
    assert op == "controllers.list"
    assert data["devices"] == []


def test_monitor_stream_emits_samples():
    states = [
        ControllerState(axes={"leftx": 0.5}, buttons={"a": True}),
        ControllerState(axes={"leftx": -0.5}, buttons={"a": False}),
    ]
    ci = FakeControllerInput([ControllerDevice(index=0, name="Pad", guid="g0")], states)
    buf = io.StringIO()
    writer = render.NdjsonWriter(buf, request_id="rq", timestamp="2026-06-02T00:00:00Z")
    op, data = controllers.monitor_stream(ci, writer, clock=FakeClock(), rate=10.0, samples=2)
    assert op == "controllers.monitor"
    objs = [json.loads(ln) for ln in buf.getvalue().splitlines() if ln]
    progress = [o for o in objs if o["type"] == "progress"]
    assert len(progress) == 2
    assert progress[0]["axes"]["leftx"] == 0.5
    assert progress[0]["buttons"]["a"] is True
    assert objs[-1]["type"] == "result"
    assert objs[-1]["final"] is True
    assert ci.opened == 0


def test_monitor_stream_no_device_raises():
    ci = FakeControllerInput([])
    buf = io.StringIO()
    writer = render.NdjsonWriter(buf, request_id="rq", timestamp="2026-06-02T00:00:00Z")
    with pytest.raises(NoControllerError):
        controllers.monitor_stream(ci, writer, clock=FakeClock(), rate=10.0, samples=2)


def test_monitor_stream_without_writer_no_stdout():
    # 防回归 F2：writer=None（json/text 模式）不写 stdout，返回 summary（含最后一帧）
    states = [ControllerState(axes={"leftx": 0.5}, buttons={"a": True})]
    ci = FakeControllerInput([ControllerDevice(index=0, name="Pad", guid="g0")], states)
    op, data = controllers.monitor_stream(ci, None, clock=FakeClock(), rate=10.0, samples=2)
    assert op == "controllers.monitor"
    assert data["samples"] == 2
    assert data["last"]["axes"]["leftx"] == 0.5
```

- [ ] **Step 2: 运行测试确认失败** — Run: `python -m pytest tests/test_cli_controllers.py -v`  Expected: FAIL (`ModuleNotFoundError: No module named 'tracksim.cli.commands.controllers'`)

- [ ] **Step 3: 最小实现**

```python
# src/tracksim/cli/commands/controllers.py
from __future__ import annotations

from typing import Any

from tracksim.cli.render import NdjsonWriter
from tracksim.ports.clock import Clock
from tracksim.ports.controller_input import ControllerInput


def list_controllers(controller_input: ControllerInput) -> tuple[str, dict[str, Any]]:
    devices = [
        {"index": d.index, "name": d.name, "guid": d.guid}
        for d in controller_input.list_devices()
    ]
    return "controllers.list", {"devices": devices}


def monitor_stream(
    controller_input: ControllerInput,
    writer: NdjsonWriter | None,
    *,
    clock: Clock,
    rate: float,
    samples: int,
) -> tuple[str, dict[str, Any]]:
    # writer 非空（ndjson 模式）：逐采样流式写出；writer=None（json/text 模式）：
    # 不污染 stdout，只采样并累计最后一帧状态，由 main 输出单个 envelope（修复 F2）。
    period = 1.0 / rate
    controller_input.open(0)
    if writer is not None:
        writer.start({"index": 0, "rate": rate})
    taken = 0
    last: dict[str, Any] = {}
    try:
        for _ in range(samples):
            state = controller_input.poll()
            last = {
                "axes": dict(state.axes),
                "buttons": dict(state.buttons),
                "connected": state.connected,
            }
            if writer is not None:
                writer.progress(last)
            taken += 1
            clock.sleep(period)
    finally:
        controller_input.close()
    if writer is not None:
        writer.result(status="ok", data={"samples": taken})
    return "controllers.monitor", {"samples": taken, "last": last}
```

- [ ] **Step 4: 运行测试确认通过** — Run: `python -m pytest tests/test_cli_controllers.py -v`  Expected: PASS (5 passed)

- [ ] **Step 5: 提交**

```bash
git add src/tracksim/cli/commands/controllers.py tests/test_cli_controllers.py
git commit -m "feat(cli): add controllers list/monitor commands"
```

### Task 45: main — argparse + 全局 flags + 输出/错误分发 + SIGINT

**Files:**
- Create: `src/tracksim/cli/main.py`
- Create: `src/tracksim/__main__.py`
- Modify: `pyproject.toml`
- Test: `tests/test_cli_main_unit.py`

说明：`build_parser()` 构造全局 flags（§3.2 全量）+ subparsers（run/send/controllers/config/freed/opentrackio/manifest/schema/completion/version）。**全局 flag 同时挂在 root（真实默认）与每个 subparser（`parents=[gp]`、`default=argparse.SUPPRESS`）**，因此 `--output`/`--dry-run`/`--config` 等在子命令之前或之后给出都生效，且子命令之前给出的值不会被 subparser 默认值覆盖（修复 F1）。`main(argv=None)` 返回 exit code：解析 argv（argparse 用法错 → exit 2，且 `--output json` 时 stdout 仍为合法错误 envelope），分发到 command handler，成功 envelope 写 stdout，`TracksimError` → error envelope 写 stdout + 其 `exit_code`，日志写 stderr。SIGINT 安装 handler 触发优雅停止并 exit 130。**流式命令（`run`/`controllers monitor`）按输出格式分流（修复 F2）**：仅 `--output ndjson`（或 `stream-json`）时构造 `NdjsonWriter` 流式写 stdout 且 `main` 跳过最终 envelope；`--output json`/`text` 时 `writer=None`，命令函数累计 summary 并由 `main` 输出**单个** envelope，保证 json 模式 stdout 是单个合法 JSON 对象（全局 `--yes` 在 `config init` 处映射为 `force`）。本任务只单测纯函数 `build_parser`/`emit_success`/`emit_error`/`exit_for_error` 及全局 flag 解析；端到端 subprocess 行为在 Task 46。

- [ ] **Step 1: 写失败测试**

```python
# tests/test_cli_main_unit.py
import io
import json

from tracksim.cli import main as cli_main
from tracksim.domain.errors import TransportError, TracksimError


def test_build_parser_has_global_flags():
    parser = cli_main.build_parser()
    help_text = parser.format_help()
    for flag in ("--output", "--dry-run", "--config", "--no-color", "--no-input", "--log-level", "--quiet", "--verbose", "--yes"):
        assert flag in help_text


def test_emit_success_json_to_stdout():
    out = io.StringIO()
    cli_main.emit_success(
        out, "meta.version", {"version": "0.1.0"}, fmt="json",
        request_id="r1", timestamp="2026-06-02T00:00:00Z", duration_ms=1,
    )
    obj = json.loads(out.getvalue())
    assert obj["status"] == "ok"
    assert obj["operation_id"] == "meta.version"
    assert obj["data"]["version"] == "0.1.0"


def test_emit_error_json_to_stdout():
    out = io.StringIO()
    err = TransportError("send failed", details={"host": "127.0.0.1"})
    cli_main.emit_error(
        out, "sim.send", err, fmt="json",
        request_id="r2", timestamp="2026-06-02T00:00:01Z", duration_ms=2,
    )
    obj = json.loads(out.getvalue())
    assert obj["status"] == "error"
    assert obj["error"]["code"] == "TRANSPORT_SEND_FAILED"
    assert obj["error"]["exit_code"] == 11
    assert obj["error"]["retryable"] is True
    assert obj["error"]["details"] == {"host": "127.0.0.1"}


def test_exit_for_error_uses_error_exit_code():
    err = TransportError("x")
    assert cli_main.exit_for_error(err) == 11
    assert cli_main.exit_for_error(TracksimError("y")) == 1


def test_global_flags_work_after_subcommand():
    # 防回归 F1：全局 flag 必须在子命令（含嵌套叶子）之后也可用
    parser = cli_main.build_parser()
    a = parser.parse_args(["version", "--output", "json"])
    assert a.command == "version" and a.output == "json"
    b = parser.parse_args(["config", "init", "--dry-run", "--output", "json"])
    assert b.command == "config" and b.subcommand == "init"
    assert b.dry_run is True and b.output == "json"
    c = parser.parse_args(["send", "--output", "json", "--pan", "10"])
    assert c.command == "send" and c.output == "json" and c.pan == 10.0


def test_global_flags_before_subcommand_not_clobbered():
    # 子命令之前给出的全局 flag 不能被 subparser 的默认值覆盖
    parser = cli_main.build_parser()
    a = parser.parse_args(["--output", "json", "send"])
    assert a.command == "send" and a.output == "json"
    b = parser.parse_args(["--yes", "config", "init"])
    assert b.command == "config" and b.subcommand == "init" and b.yes is True
```

- [ ] **Step 2: 运行测试确认失败** — Run: `python -m pytest tests/test_cli_main_unit.py -v`  Expected: FAIL (`ModuleNotFoundError: No module named 'tracksim.cli.main'`)

- [ ] **Step 3: 最小实现**

```python
# src/tracksim/cli/main.py
from __future__ import annotations

import argparse
import json
import logging
import os
import signal
import sys
import time
from typing import Any, TextIO

from tracksim.cli import render, runtime
from tracksim.cli.commands import (
    config_cmd,
    controllers as controllers_cmd,
    decode as decode_cmd,
    factory,
    meta as meta_cmd,
    run as run_cmd,
    send as send_cmd,
)
from tracksim.config import load_config
from tracksim.domain.errors import ConfigError, TracksimError
from tracksim.envelope import EXIT_OK, EXIT_USAGE, error_envelope, success_envelope
from tracksim.infra.clock import WallClock
from tracksim.simulator import Simulator

_LOG = logging.getLogger("tracksim")


def _add_global_flags(parser: argparse.ArgumentParser, *, suppress: bool = False) -> None:
    # suppress=True 用于挂到 subparser 的副本：未显式给出的 flag 不写回 namespace，
    # 因此不会用 None/False 覆盖在子命令之前已解析的全局 flag 值（argparse 的 parents 已知陷阱）。
    def d(real: Any) -> Any:
        return argparse.SUPPRESS if suppress else real

    parser.add_argument("--version", action="store_true", default=d(False), help="Show version and exit")
    parser.add_argument("--yes", "-y", action="store_true", default=d(False), help="Skip confirmations")
    parser.add_argument("--dry-run", action="store_true", default=d(False), help="Simulate without side effects")
    parser.add_argument("--config", metavar="PATH", default=d(None), help="Config file (TOML/YAML/JSON)")
    parser.add_argument("--output", "-o", choices=["text", "json", "ndjson", "stream-json"], default=d(None), help="Output format")
    parser.add_argument("--input-format", default=d("json"), help="stdin input format")
    parser.add_argument("--log-level", choices=["debug", "info", "warn", "error"], default=d("info"))
    parser.add_argument("--verbose", "-v", action="count", default=d(0))
    parser.add_argument("--quiet", "-q", action="store_true", default=d(False))
    parser.add_argument("--no-color", action="store_true", default=d(False))
    parser.add_argument("--no-input", action="store_true", default=d(False))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="tracksim", description="Camera tracking protocol simulator")
    _add_global_flags(parser)  # 真实默认值挂在 root：支持「全局 flag 在子命令之前」
    gp = argparse.ArgumentParser(add_help=False)
    _add_global_flags(gp, suppress=True)  # 同一组 flag 挂到每个 subparser：支持「全局 flag 在子命令之后」
    sub = parser.add_subparsers(dest="command")

    p_run = sub.add_parser("run", parents=[gp], help="Stream poses to enabled protocols")
    p_run.add_argument("--source", choices=["controller", "script", "static"], default="script")
    p_run.add_argument("--protocol", action="append", choices=["freed", "opentrackio"], default=None)
    p_run.add_argument("--rate", type=float, default=None)
    p_run.add_argument("--duration", type=float, default=None)

    p_send = sub.add_parser("send", parents=[gp], help="Send one frame or hold a fixed pose")
    p_send.add_argument("--protocol", action="append", choices=["freed", "opentrackio"], default=None)
    p_send.add_argument("--duration", type=float, default=None)
    p_send.add_argument("--rate", type=float, default=None)
    for field in ("pan", "tilt", "roll", "x", "y", "z", "focal_length", "focus_distance"):
        p_send.add_argument(f"--{field.replace('_', '-')}", type=float, default=None, dest=field)

    p_ctrl = sub.add_parser("controllers", parents=[gp], help="Controller utilities")
    ctrl_sub = p_ctrl.add_subparsers(dest="subcommand")
    ctrl_sub.add_parser("list", parents=[gp], help="List controllers")
    p_mon = ctrl_sub.add_parser("monitor", parents=[gp], help="Stream controller axis/button values")
    p_mon.add_argument("--rate", type=float, default=30.0)
    p_mon.add_argument("--samples", type=int, default=100)

    p_cfg = sub.add_parser("config", parents=[gp], help="Config utilities")
    cfg_sub = p_cfg.add_subparsers(dest="subcommand")
    p_cfg_init = cfg_sub.add_parser("init", parents=[gp], help="Write default config")
    p_cfg_init.add_argument("--path", default="tracksim.toml")
    cfg_sub.add_parser("show", parents=[gp], help="Show effective config")
    cfg_sub.add_parser("validate", parents=[gp], help="Validate config")

    p_freed = sub.add_parser("freed", parents=[gp], help="FreeD utilities")
    freed_sub = p_freed.add_subparsers(dest="subcommand")
    p_freed_dec = freed_sub.add_parser("decode", parents=[gp], help="Decode a FreeD packet (hex or stdin)")
    p_freed_dec.add_argument("hex", nargs="?", default=None)

    p_otrk = sub.add_parser("opentrackio", parents=[gp], help="OpenTrackIO utilities")
    otrk_sub = p_otrk.add_subparsers(dest="subcommand")
    otrk_sub.add_parser("decode", parents=[gp], help="Decode an OpenTrackIO packet (stdin)")

    sub.add_parser("manifest", parents=[gp], help="Output contract manifest")
    sub.add_parser("schema", parents=[gp], help="Output CLI structure schema")
    p_comp = sub.add_parser("completion", parents=[gp], help="Output shell completion script")
    p_comp.add_argument("shell", choices=["bash", "zsh", "fish"])
    sub.add_parser("version", parents=[gp], help="Output version metadata")

    return parser


def emit_success(
    stream: TextIO,
    operation_id: str,
    data: Any,
    *,
    fmt: str,
    request_id: str,
    timestamp: str,
    duration_ms: int,
) -> None:
    env = success_envelope(
        operation_id, data, request_id=request_id, duration_ms=duration_ms, timestamp=timestamp
    )
    stream.write(render.render_success(env, fmt) + "\n")


def emit_error(
    stream: TextIO,
    operation_id: str,
    error: TracksimError,
    *,
    fmt: str,
    request_id: str,
    timestamp: str,
    duration_ms: int,
) -> None:
    env = error_envelope(
        operation_id,
        code=error.code,
        exit_code=error.exit_code,
        message=error.message,
        retryable=error.retryable,
        details=error.details,
        request_id=request_id,
        duration_ms=duration_ms,
        timestamp=timestamp,
    )
    stream.write(render.render_error(env, fmt) + "\n")


def exit_for_error(error: TracksimError) -> int:
    return error.exit_code


def _normalize_fmt(fmt: str) -> str:
    return "ndjson" if fmt == "stream-json" else fmt


def _read_stdin_json(no_input: bool) -> dict[str, Any] | None:
    if no_input or sys.stdin.isatty():
        return None
    raw = sys.stdin.read().strip()
    if not raw:
        return None
    return json.loads(raw)


def _operation_id_for(args: argparse.Namespace) -> str:
    cmd = args.command
    sub = getattr(args, "subcommand", None)
    mapping = {
        ("run", None): "sim.run",
        ("send", None): "sim.send",
        ("controllers", "list"): "controllers.list",
        ("controllers", "monitor"): "controllers.monitor",
        ("config", "init"): "config.init",
        ("config", "show"): "config.show",
        ("config", "validate"): "config.validate",
        ("freed", "decode"): "freed.decode",
        ("opentrackio", "decode"): "opentrackio.decode",
        ("manifest", None): "meta.manifest",
        ("schema", None): "meta.schema",
        ("completion", None): "meta.version",
        ("version", None): "meta.version",
    }
    return mapping.get((cmd, sub), "INTERNAL")


def _dispatch(args: argparse.Namespace, fmt: str, request_id: str, timestamp: str) -> tuple[str, Any]:
    cmd = args.command
    sub = getattr(args, "subcommand", None)
    config = load_config(args.config)
    clock = WallClock()

    if cmd == "version":
        return meta_cmd.version()
    if cmd == "manifest":
        return meta_cmd.manifest()
    if cmd == "schema":
        return meta_cmd.schema()
    if cmd == "completion":
        return "meta.version", {"completion": meta_cmd.completion(args.shell)}
    if cmd == "config" and sub == "init":
        # 全局 --yes 映射为 force：允许覆盖已存在的配置（CLI_DESIGN_SPEC §9）
        return config_cmd.init(args.path, dry_run=args.dry_run, force=args.yes)
    if cmd == "config" and sub == "show":
        return config_cmd.show(config)
    if cmd == "config" and sub == "validate":
        return config_cmd.validate(config)
    if cmd == "freed" and sub == "decode":
        raw = bytes.fromhex(args.hex) if args.hex else sys.stdin.buffer.read()
        return decode_cmd.freed_decode(raw)
    if cmd == "opentrackio" and sub == "decode":
        raw = sys.stdin.buffer.read()
        return decode_cmd.opentrackio_decode(raw)
    if cmd == "controllers" and sub == "list":
        from tracksim.infra.sdl_controller import SDLControllerInput

        ci = SDLControllerInput()
        try:
            return controllers_cmd.list_controllers(ci)
        finally:
            ci.close()
    if cmd == "controllers" and sub == "monitor":
        from tracksim.infra.sdl_controller import SDLControllerInput

        ci = SDLControllerInput()
        # 仅 ndjson 模式流式写 stdout；json/text 模式 writer=None，函数累计 summary 由 main 输出单个 envelope
        writer = render.NdjsonWriter(sys.stdout, request_id=request_id, timestamp=timestamp) if fmt == "ndjson" else None
        return controllers_cmd.monitor_stream(ci, writer, clock=clock, rate=args.rate, samples=args.samples)
    if cmd == "send":
        protocols = args.protocol or [p for p, on in (("freed", config.protocols.freed), ("opentrackio", config.protocols.opentrackio)) if on]
        emitters = factory.build_emitters(config, protocols)
        try:
            stdin_obj = _read_stdin_json(args.no_input)
            flags = {f: getattr(args, f, None) for f in ("pan", "tilt", "roll", "x", "y", "z", "focal_length", "focus_distance")}
            pose = send_cmd.build_pose(flags, stdin_obj)
            if args.duration:
                rate = args.rate or config.freed.rate_hz
                return send_cmd.send_hold(emitters, pose, clock=clock, rate=rate, duration=args.duration)
            return send_cmd.send_once(emitters, pose)
        finally:
            for e in emitters:
                e.close()
    if cmd == "run":
        protocols = args.protocol or [p for p, on in (("freed", config.protocols.freed), ("opentrackio", config.protocols.opentrackio)) if on]
        rate = args.rate or config.freed.rate_hz
        # --duration（秒）映射为最大帧数，使 run 有界；不给则无界（直到 SIGINT / source 耗尽）
        max_ticks = int(round(args.duration * rate)) if args.duration else None
        # controller 源需打开 SDL 设备：在此特判（保持 factory 设备无关、可无硬件测试），修复 F5。
        # 先建 source（含设备打开），失败则不构造 emitters，避免泄漏。
        if args.source == "controller":
            from tracksim.infra.sdl_controller import SDLControllerInput
            from tracksim.sources.controller import ControllerPoseSource

            ci = SDLControllerInput()
            try:
                device = config.controller.device
                device_index = int(device) if device is not None else 0
            except (TypeError, ValueError):
                ci.close()
                raise ConfigError(
                    f"controller.device must be an integer index, got {config.controller.device!r}",
                    details={"device": config.controller.device},
                )
            try:
                ci.open(device_index)  # 无手柄 -> NoControllerError(exit 10)
            except Exception:
                ci.close()
                raise
            source = ControllerPoseSource(ci, config.controller.mapping, clock)
        else:
            source = factory.build_source(config, args.source, rate=rate, clock=clock)
        emitters = factory.build_emitters(config, protocols)
        sim = run_cmd.make_simulator(source, emitters, clock, rate=rate, fail_fast=False)
        _install_sigint(sim)
        # 仅 ndjson 模式流式写 stdout；json/text 模式 writer=None，run_stream 累计 summary 由 main 输出单个 envelope
        writer = render.NdjsonWriter(sys.stdout, request_id=request_id, timestamp=timestamp) if fmt == "ndjson" else None
        try:
            return run_cmd.run_stream(sim, writer, max_ticks=max_ticks)
        finally:
            source.close()
            for e in emitters:
                e.close()
    raise TracksimError("no command given")


def _install_sigint(sim: Simulator) -> None:
    def _handler(signum, frame):  # noqa: ANN001
        sim.stop()

    signal.signal(signal.SIGINT, _handler)


def _configure_logging(args: argparse.Namespace) -> None:
    level = logging.INFO
    if args.quiet:
        level = logging.ERROR
    elif args.verbose >= 2:
        level = logging.DEBUG
    elif args.verbose == 1:
        level = logging.DEBUG
    else:
        level = {"debug": logging.DEBUG, "info": logging.INFO, "warn": logging.WARNING, "error": logging.ERROR}[args.log_level]
    logging.basicConfig(stream=sys.stderr, level=level, format="%(levelname)s %(name)s: %(message)s")


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    ai_agent = os.environ.get("AI_AGENT") == "1"
    no_color_env = bool(os.environ.get("NO_COLOR"))
    request_id = runtime.new_request_id()
    timestamp = runtime.utc_now_iso()
    started = time.monotonic()

    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        if exc.code in (0, None):
            return EXIT_OK
        fmt = "json" if (ai_agent or "--output=json" in (argv or []) or _wants_json(argv)) else "text"
        if fmt in ("json", "ndjson"):
            err = TracksimError("invalid arguments")
            env = error_envelope(
                "INTERNAL", code="ARG_VALIDATION", exit_code=EXIT_USAGE,
                message="invalid command-line arguments", retryable=False, details={},
                request_id=request_id, duration_ms=0, timestamp=timestamp,
            )
            sys.stdout.write(json.dumps(env) + "\n")
        return EXIT_USAGE

    _configure_logging(args)
    fmt = _normalize_fmt(runtime.resolve_output(args.output, ai_agent_env=ai_agent, is_tty=sys.stdout.isatty()))

    if args.version or args.command is None and argv is None:
        op, data = meta_cmd.version()
        emit_success(sys.stdout, op, data, fmt=fmt, request_id=request_id, timestamp=timestamp, duration_ms=int((time.monotonic() - started) * 1000))
        return EXIT_OK
    if args.command is None:
        parser.print_help(sys.stderr)
        return EXIT_USAGE

    streaming = (fmt == "ndjson") and (
        args.command == "run" or (args.command == "controllers" and getattr(args, "subcommand", None) == "monitor")
    )
    operation_id = _operation_id_for(args)
    try:
        op, data = _dispatch(args, fmt, request_id, timestamp)
        duration_ms = int((time.monotonic() - started) * 1000)
        if not streaming:
            emit_success(sys.stdout, op, data, fmt=fmt, request_id=request_id, timestamp=timestamp, duration_ms=duration_ms)
        return EXIT_OK
    except TracksimError as exc:
        _LOG.error("%s: %s", exc.code, exc.message)
        duration_ms = int((time.monotonic() - started) * 1000)
        emit_error(sys.stdout, operation_id, exc, fmt=_normalize_fmt(fmt) if fmt != "ndjson" else "json", request_id=request_id, timestamp=timestamp, duration_ms=duration_ms)
        return exit_for_error(exc)
    except KeyboardInterrupt:
        _LOG.error("interrupted")
        return 130


def _wants_json(argv: list[str] | None) -> bool:
    if not argv:
        return False
    for i, tok in enumerate(argv):
        if tok in ("--output", "-o") and i + 1 < len(argv) and argv[i + 1] in ("json", "ndjson", "stream-json"):
            return True
        if tok.startswith("--output=") and tok.split("=", 1)[1] in ("json", "ndjson", "stream-json"):
            return True
    return False
```

```python
# src/tracksim/__main__.py
from tracksim.cli.main import main

if __name__ == "__main__":
    raise SystemExit(main())
```

在 `pyproject.toml` 的 `[project.scripts]` 段（若不存在则新增该段）加入 console_script，并确保 `python -m tracksim` 可用：

```toml
[project.scripts]
tracksim = "tracksim.cli.main:main"
```

注：`build_parser` 是纯函数；`emit_success`/`emit_error`/`exit_for_error` 不触碰全局状态，可单测。`main` 的端到端行为（stdout 纯净、exit code、SIGINT）在 Task 46 的 subprocess conformance 覆盖。`--output=json` 错误路径解析在 argparse 抛 `SystemExit` 后仍能输出合法 JSON envelope（满足 §12 Step3「bad-flag error → exit 2 且 json 模式 stdout 合法 JSON」）。

- [ ] **Step 4: 运行测试确认通过** — Run: `python -m pytest tests/test_cli_main_unit.py -v`  Expected: PASS (6 passed)

- [ ] **Step 5: 提交**

```bash
git add src/tracksim/cli/main.py src/tracksim/__main__.py pyproject.toml tests/test_cli_main_unit.py
git commit -m "feat(cli): add argparse main with global flags, dispatch, envelopes, SIGINT"
```

### Task 46: Subprocess conformance — CLI_DESIGN_SPEC §12 Step 3

**Files:**
- Test: `tests/test_cli_conformance.py`

说明：以 `subprocess` 调 `python -m tracksim ...` 做端到端契约验证（§12 Step 3）：(1) `version --output json` → stdout 纯 JSON 可 `json.loads`、stderr 为空；(2) bad-flag → exit 2 且 json 模式 stdout 合法 JSON；(3) `config init --dry-run --output json` 暴露 `data.dry_run_plan` 且不写文件；(4) `send` 到 `127.0.0.1`，测试内起 UDP 接收器，断言收到 29 字节 FreeD 包与一个以 `OTrk` 开头的 OpenTrackIO 包;(5) `manifest` operation_id 集合 == `build_manifest()`；(6) **`run --output json --duration ...` → stdout 是单个合法 JSON 对象**（防回归 F2，证明流式命令在 json 模式不混入 ndjson 行）；(7) **`controllers monitor --output json`（无手柄）→ 单个 JSON error envelope、exit 10**（防回归 F2，需 SDL3 否则跳过）；(8) **`run --source controller`（无手柄）→ exit 10 NO_CONTROLLER**（防回归 F5：证明已接线到 SDL，而非落到 `UNSUPPORTED_PROTOCOL`/exit 12，需 SDL3 否则跳过）。用小 `--rate`/`--duration`。`run` 的有界由 `--duration`（→ `max_ticks`）保证。

- [ ] **Step 1: 写失败测试**

```python
# tests/test_cli_conformance.py
import json
import os
import socket
import subprocess
import sys
import threading
import time

import pytest

from tracksim.manifest import build_manifest

_ENV = {**os.environ, "PYTHONPATH": os.path.abspath("src")}


def _run(args, **kw):
    return subprocess.run(
        [sys.executable, "-m", "tracksim", *args],
        capture_output=True, text=True, env=_ENV, **kw
    )


def test_version_json_stdout_pure_stderr_empty():
    proc = _run(["version", "--output", "json"])
    assert proc.returncode == 0
    obj = json.loads(proc.stdout)
    assert obj["operation_id"] == "meta.version"
    assert obj["status"] == "ok"
    assert proc.stderr == ""


def test_bad_flag_exit_2_json_stdout_valid():
    proc = _run(["version", "--definitely-not-a-flag", "--output", "json"])
    assert proc.returncode == 2
    obj = json.loads(proc.stdout)
    assert obj["status"] == "error"
    assert obj["error"]["exit_code"] == 2


def test_config_init_dry_run_exposes_plan_and_writes_nothing(tmp_path):
    target = tmp_path / "out.toml"
    proc = _run(["config", "init", "--path", str(target), "--dry-run", "--output", "json"])
    assert proc.returncode == 0
    obj = json.loads(proc.stdout)
    assert "dry_run_plan" in obj["data"]
    assert obj["data"]["dry_run_plan"]["path"] == str(target)
    assert not target.exists()


def test_manifest_operation_ids_match_build_manifest():
    proc = _run(["manifest", "--output", "json"])
    assert proc.returncode == 0
    obj = json.loads(proc.stdout)
    ids = {op["operation_id"] for op in obj["data"]["operations"]}
    expected = {op["operation_id"] for op in build_manifest()["operations"]}
    assert ids == expected


def _udp_collect(sock, packets, stop):
    sock.settimeout(0.2)
    while not stop.is_set():
        try:
            data, _ = sock.recvfrom(2048)
            packets.append(data)
        except socket.timeout:
            continue


def test_send_freed_packet_arrives_on_udp():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    packets: list[bytes] = []
    stop = threading.Event()
    t = threading.Thread(target=_udp_collect, args=(sock, packets, stop))
    t.start()
    try:
        cfg = _make_freed_config(port)
        proc = _run(["send", "--config", cfg, "--protocol", "freed", "--pan", "10", "--output", "json"])
        assert proc.returncode == 0, proc.stderr
        time.sleep(0.3)
    finally:
        stop.set()
        t.join()
        sock.close()
    assert any(len(p) == 29 and p[0] == 0xD1 for p in packets)


def test_send_opentrackio_packet_arrives_on_udp():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    packets: list[bytes] = []
    stop = threading.Event()
    t = threading.Thread(target=_udp_collect, args=(sock, packets, stop))
    t.start()
    try:
        cfg = _make_otrk_config(port)
        proc = _run(["send", "--config", cfg, "--protocol", "opentrackio", "--pan", "5", "--output", "json"])
        assert proc.returncode == 0, proc.stderr
        time.sleep(0.3)
    finally:
        stop.set()
        t.join()
        sock.close()
    assert any(p[0:4] == b"OTrk" for p in packets)


def test_run_json_is_single_object_not_ndjson(tmp_path):
    # 防回归 F2：流式命令在 --output json 下 stdout 必须是单个合法 JSON 对象（不得混入 ndjson 行）
    cfg = _make_freed_config(59999)  # 发往 127.0.0.1:59999；本测试不校验送达，仅校验 stdout 形态
    proc = _run([
        "run", "--config", cfg, "--protocol", "freed",
        "--source", "script", "--rate", "20", "--duration", "0.1", "--output", "json",
    ])
    assert proc.returncode == 0, proc.stderr
    obj = json.loads(proc.stdout)  # 单个对象；若混入 ndjson 行此处会抛 JSONDecodeError
    assert obj["operation_id"] == "sim.run"
    assert obj["status"] == "ok"
    assert obj["data"]["ticks"] >= 1


def test_controllers_monitor_json_no_device_single_error_object():
    # 防回归 F2：streaming 命令在 json 模式即使报错也只输出单个 JSON error envelope
    pytest.importorskip("sdl3")  # 无 SDL3 运行库时跳过（功能由 Section 5 FakeControllerInput 覆盖）
    proc = _run(["controllers", "monitor", "--samples", "1", "--output", "json"])
    assert proc.returncode == 10  # NO_CONTROLLER（无手柄）
    obj = json.loads(proc.stdout)
    assert obj["status"] == "error"
    assert obj["error"]["code"] == "NO_CONTROLLER"


def test_run_controller_source_reaches_sdl_not_unsupported():
    # 防回归 F5：run --source controller 必须接线到 SDL（无手柄 -> NO_CONTROLLER/exit 10），
    # 而不是落到 factory 的 UNSUPPORTED_PROTOCOL/exit 12
    pytest.importorskip("sdl3")
    proc = _run(["run", "--source", "controller", "--duration", "0.1", "--rate", "10", "--output", "json"])
    assert proc.returncode == 10, proc.stderr
    obj = json.loads(proc.stdout)
    assert obj["status"] == "error"
    assert obj["error"]["code"] == "NO_CONTROLLER"


def _make_freed_config(port: int) -> str:
    import tempfile

    content = (
        "[protocols]\nfreed = true\nopentrackio = false\n\n"
        "[freed]\ntransport = \"udp_unicast\"\n"
        f"target_ip = \"127.0.0.1\"\nport = {port}\n"
        "serial_device = \"/dev/null\"\nbaud = 38400\ncamera_id = 0\nrate_hz = 10.0\n\n"
        "[freed.scaling]\nvariant = \"native\"\nangle_lsb_per_deg = 32768.0\npos_lsb_per_m = 64000.0\n"
    )
    fh = tempfile.NamedTemporaryFile("w", suffix=".toml", delete=False)
    fh.write(content)
    fh.close()
    return fh.name


def _make_otrk_config(port: int) -> str:
    import tempfile

    content = (
        "[protocols]\nfreed = false\nopentrackio = true\n\n"
        "[opentrackio]\ntransport = \"unicast\"\nsource_number = 1\n"
        f"ip = \"127.0.0.1\"\nport = {port}\nencoding = \"json\"\nrate_hz = 10.0\n"
    )
    fh = tempfile.NamedTemporaryFile("w", suffix=".toml", delete=False)
    fh.write(content)
    fh.close()
    return fh.name
```

- [ ] **Step 2: 运行测试确认失败** — Run: `python -m pytest tests/test_cli_conformance.py -v`  Expected: FAIL (无法导入或 `tracksim.cli.main` 未实现完整分发 / UDP 未收到包)

- [ ] **Step 3: 最小实现**

本任务为纯 conformance 测试，依赖 Task 36–44 已实现的 `tracksim.cli.main` 端到端路径。无新增生产代码；若测试暴露 `main`/`_dispatch` 缺陷（如 send 未按 config 启用协议、stderr 在 json 成功路径非空），在 `src/tracksim/cli/main.py` 内做最小修复使全部用例通过。典型需保证：成功 json 路径下不向 stderr 写入任何内容（`--log-level error` 默认 info 但成功路径不产生 error/info 输出到 stderr——确认 `basicConfig` level 不触发空行）。

```python
# 若 test_version_json_stdout_pure_stderr_empty 因 logging 在 stderr 产生输出而失败，
# 在 src/tracksim/cli/main.py 的 _configure_logging 末尾确保 INFO 级别下 version 路径不 emit：
# version/manifest/schema 等 readOnly meta 命令不调用任何 _LOG.info；保持现状即可。
```

- [ ] **Step 4: 运行测试确认通过** — Run: `python -m pytest tests/test_cli_conformance.py -v`  Expected: PASS (9 passed；无 SDL3 时 7 passed + 2 skipped)

- [ ] **Step 5: 提交**

```bash
git add tests/test_cli_conformance.py
git commit -m "test(cli): add subprocess conformance suite per CLI_DESIGN_SPEC step 3"
```
