"""Shared intrinsics-file loader (`intrinsics_io.load_intrinsics_file`): accepts
both the mesh `{K, ...}` shape and the vpcal master-lens flat `{fx,fy,cx,cy,...}`
shape so a vpcal lens calibration drops straight in."""
import json

import numpy as np
import pytest

from lmt_vba_sidecar.intrinsics_io import load_intrinsics_file

K = np.array([[3000.0, 0.0, 2000.0], [0.0, 3010.0, 1500.0], [0.0, 0.0, 1.0]])
DIST = [-0.12, 0.04, 0.001, -0.002, 0.02]


def _write(tmp_path, obj):
    p = tmp_path / "intr.json"
    p.write_text(json.dumps(obj))
    return str(p)


def test_k_matrix_format_roundtrip(tmp_path):
    path = _write(tmp_path, {"K": K.tolist(), "dist_coeffs": DIST, "image_size": [4000, 3000]})
    loaded = load_intrinsics_file(path)
    assert loaded.source_format == "k_matrix"
    assert np.allclose(loaded.K, K)
    assert np.allclose(loaded.dist, DIST)
    assert loaded.image_size == (4000, 3000)


def test_vpcal_flat_format(tmp_path):
    # Fields copied verbatim from vpcal/cli/tracker_free.py:57-71 master-lens output.
    path = _write(tmp_path, {
        "fx": 3000.0, "fy": 3010.0, "cx": 2000.0, "cy": 1500.0,
        "dist_coeffs": DIST, "rms": 0.3, "num_images": 20, "num_points": 400,
        "image_size": [4000, 3000], "calibration_kind": "multi_view_intrinsics",
        "is_master": True, "session_coupled": False,
    })
    loaded = load_intrinsics_file(path)
    assert loaded.source_format == "vpcal_flat"
    assert np.allclose(loaded.K, K)
    assert np.allclose(loaded.dist, DIST)
    assert loaded.image_size == (4000, 3000)


def test_missing_dist_defaults_zero(tmp_path):
    path = _write(tmp_path, {"fx": 3000.0, "fy": 3010.0, "cx": 2000.0, "cy": 1500.0})
    loaded = load_intrinsics_file(path)
    assert np.allclose(loaded.dist, np.zeros(5))
    assert loaded.image_size is None


def test_negative_focal_rejected(tmp_path):
    path = _write(tmp_path, {"fx": -3000.0, "fy": 3010.0, "cx": 2000.0, "cy": 1500.0})
    with pytest.raises(ValueError):
        load_intrinsics_file(path)


def test_unknown_format_rejected(tmp_path):
    path = _write(tmp_path, {"focal_length_mm": 35.0})
    with pytest.raises(ValueError):
        load_intrinsics_file(path)


def test_nonfinite_dist_rejected(tmp_path):
    path = _write(tmp_path, {"K": K.tolist(), "dist_coeffs": [float("nan"), 0, 0, 0, 0]})
    with pytest.raises(ValueError):
        load_intrinsics_file(path)
