"""nDisplay screen-geometry export (remediation C6).

Emits the calibrated LED-wall geometry + camera transforms in the Unreal
convention (cm, left-handed) so an operator can set up an nDisplay screen/mesh
that matches ``result.json``.  nDisplay's on-disk format drifts between UE
versions (spec:1216 deferred this to Phase 2), so this is a **version-locked,
operator-assisted** export — a structured geometry config + a README — not a
drop-in ``.ndisplay`` asset.  Target version is declared in the output.

Coordinate handling:
  * Screen sections are authored in the UE/Stage frame already (mm) → only mm→cm.
  * Camera transforms in ``result.json`` are internal right-hand → converted to
    UE via ``to_ue_transform`` then mm→cm.
Per the D6 schema convention, screens and cameras are LISTS (even with one each)
so a future multi-camera 2.0 does not invalidate exported files.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from vpcal.core.coordinates import to_ue_transform
from vpcal.core.transforms import make_transform, transform_to_qt
from vpcal.models.screen import ScreenDefinition

TARGET_UE_VERSION = "5.7"
SCHEMA_VERSION = "1.0"
_MM_TO_CM = 0.1

# Quad corners in UV: TL, TR, BR, BL.
_QUAD_UV = [(0.0, 1.0), (1.0, 1.0), (1.0, 0.0), (0.0, 0.0)]


def _section_vertices_cm(section) -> list[list[float]]:
    """Absolute UE-cm corner vertices (TL, TR, BR, BL) of one section."""
    return [(_MM_TO_CM * np.asarray(section.uv_to_world(u, v))).tolist() for u, v in _QUAD_UV]


def _transform_to_ue_cm(q: list[float], t: list[float]) -> dict:
    """Internal RH (q, t mm) → UE (q, t cm) location/rotation dict."""
    T_ue = to_ue_transform(make_transform(q, t))
    q_ue, t_ue = transform_to_qt(T_ue)
    return {
        "location_cm": (np.asarray(t_ue) * _MM_TO_CM).tolist(),
        "rotation_quat_wxyz": np.asarray(q_ue).tolist(),
    }


def build_ndisplay_config(screen: ScreenDefinition, result: dict) -> dict:
    """Build the nDisplay geometry config dict from a screen + result.json."""
    for key in ("tracker_to_stage", "tracker_to_camera"):
        tf = result.get(key)
        if not isinstance(tf, dict) or "rotation" not in tf or "translation" not in tf:
            raise ValueError(
                f"result.json is missing the '{key}' transform (need rotation + translation); "
                "is this a valid vpcal calibration result?"
            )
    screens = []
    for s in screen.sections:
        screens.append({
            "name": s.name,
            "type": s.type,
            "vertices_cm": _section_vertices_cm(s),  # TL, TR, BR, BL (absolute, UE cm)
        })
    cameras = [{
        "id": "tracked_camera",
        "tracker_to_stage": _transform_to_ue_cm(
            result["tracker_to_stage"]["rotation"], result["tracker_to_stage"]["translation"]),
        "tracker_to_camera": _transform_to_ue_cm(
            result["tracker_to_camera"]["rotation"], result["tracker_to_camera"]["translation"]),
    }]
    return {
        "schema_version": SCHEMA_VERSION,
        "target_ue_version": TARGET_UE_VERSION,
        "unit": "cm",
        "coordinate_system": "unreal",
        "source": {
            "vpcal_version": result.get("vpcal_version"),
            "result_schema_version": result.get("schema_version"),
            "screen": screen.name,
        },
        "screens": screens,    # list (D6: list-not-singular)
        "cameras": cameras,    # list (D6)
    }


_README = """\
# nDisplay 导入指引（vpcal C6 导出）

> 目标 UE 版本：**{ue}**。nDisplay 配置格式在 UE 版本间不稳定，本导出为**几何配置 + 操作指引**，
> 非 drop-in `.ndisplay` 资产——按下列步骤手动建立 nDisplay 屏幕几何。

## 单位与坐标系
- 全部为 **cm + Unreal 左手坐标系**（已从 vpcal 内部右手 mm 转换）。
- `screens[].vertices_cm`：每个屏幕区段的 4 个角点（顺序 TL, TR, BR, BL），舞台/世界系绝对坐标 cm。

## 步骤
1. 在 nDisplay 配置（{ue}）中为每个 `screens[]` 项新建一个 Screen / Mesh 组件；
2. 用 `vertices_cm` 的四角建立平面（或对 `type: arc` 用区段网格）几何，**保持角点绝对坐标**；
3. `cameras[].tracker_to_stage` / `tracker_to_camera` 为标定出的相对变换（cm + UE 四元数 wxyz），
   用于把被追踪相机摆到舞台系正确位置；
4. 加载后用一张已知机位照片核对：屏幕在引擎内的位置应与 `result.json` 矩阵一致。

## 验收（手动一次）
- 几何加载无误、屏幕位置与 `result.json` 的 `tracker_to_stage` 一致（手动验证）。
- 本仓库的格式快照测试锁定 `ndisplay.json` 结构（`tests/.../test_ndisplay_export.py`）。
"""


def export_ndisplay(screen: ScreenDefinition, result: dict, out_dir: str | Path) -> dict:
    """Write ``ndisplay.json`` + ``README.md`` to ``out_dir``; return a summary."""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    config = build_ndisplay_config(screen, result)
    (out / "ndisplay.json").write_text(json.dumps(config, indent=2))
    (out / "README.md").write_text(_README.format(ue=TARGET_UE_VERSION))
    return {
        "output_dir": str(out),
        "target_ue_version": TARGET_UE_VERSION,
        "num_screens": len(config["screens"]),
        "files": ["ndisplay.json", "README.md"],
    }
