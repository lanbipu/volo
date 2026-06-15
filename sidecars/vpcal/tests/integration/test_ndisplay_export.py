"""nDisplay screen-geometry export (remediation C6)."""

from __future__ import annotations

import json

import numpy as np
import pytest

from vpcal.io.export.ndisplay import (
    TARGET_UE_VERSION,
    build_ndisplay_config,
    export_ndisplay,
)
from vpcal.models.screen import PlaneSection, ScreenDefinition


def _screen():
    return ScreenDefinition(
        name="wall", unit="mm", cabinet_size=(500, 500), led_pixel_pitch_mm=2.8,
        markers_per_cabinet=1,
        sections=[PlaneSection(name="main", width_mm=2400, height_mm=1600, origin=[0, 0, 0])],
    )


def _result():
    return {
        "schema_version": "1.2", "vpcal_version": "0.1.0",
        "tracker_to_stage": {"translation": [100.0, 200.0, 300.0], "rotation": [1.0, 0.0, 0.0, 0.0]},
        "tracker_to_camera": {"translation": [0.0, 0.0, 0.0], "rotation": [1.0, 0.0, 0.0, 0.0]},
    }


def test_plane_vertices_mm_to_cm_in_ue_frame():
    cfg = build_ndisplay_config(_screen(), _result())
    scr = cfg["screens"][0]
    assert scr["type"] == "plane"
    # uv_to_world: x=(u-0.5)*2400, z=v*1600 (mm); ÷10 → cm. UV order TL,TR,BR,BL.
    expected = [
        [-120.0, 0.0, 160.0],  # TL (0,1)
        [120.0, 0.0, 160.0],   # TR (1,1)
        [120.0, 0.0, 0.0],     # BR (1,0)
        [-120.0, 0.0, 0.0],    # BL (0,0)
    ]
    np.testing.assert_allclose(scr["vertices_cm"], expected, atol=1e-9)


def test_transforms_in_ue_cm():
    cfg = build_ndisplay_config(_screen(), _result())
    cam = cfg["cameras"][0]
    # internal RH t=[100,200,300] mm → UE diag(1,-1,1) → [100,-200,300] mm → ÷10 cm
    np.testing.assert_allclose(cam["tracker_to_stage"]["location_cm"], [10.0, -20.0, 30.0], atol=1e-9)


def test_config_uses_list_structure_d6():
    cfg = build_ndisplay_config(_screen(), _result())
    # D6 convention: screens & cameras are lists (multi-camera 2.0 safe).
    assert isinstance(cfg["screens"], list)
    assert isinstance(cfg["cameras"], list)
    assert cfg["coordinate_system"] == "unreal" and cfg["unit"] == "cm"
    assert cfg["target_ue_version"] == TARGET_UE_VERSION


def test_malformed_result_raises_clear_error():
    import pytest
    bad = {"vpcal_version": "0.1.0"}  # no tracker_to_stage / tracker_to_camera
    with pytest.raises(ValueError, match="tracker_to_stage"):
        build_ndisplay_config(_screen(), bad)


def test_export_writes_config_and_readme(tmp_path):
    summary = export_ndisplay(_screen(), _result(), tmp_path)
    assert (tmp_path / "ndisplay.json").exists()
    assert (tmp_path / "README.md").exists()
    assert summary["num_screens"] == 1
    cfg = json.loads((tmp_path / "ndisplay.json").read_text())
    assert cfg["schema_version"] == "1.0"
    assert TARGET_UE_VERSION in (tmp_path / "README.md").read_text()
