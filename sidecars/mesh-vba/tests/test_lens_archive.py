"""Archive a reconstruction self-cal lens as a vpcal master-lens file."""
from __future__ import annotations

import json
import os
import stat

import numpy as np
import pytest

from lmt_vba_sidecar.intrinsics_solve import IntrinsicsResult
from lmt_vba_sidecar.lens_archive import (
    MASTER_LENS_SOURCE,
    SelfCalInfo,
    archive_master_lens,
    master_lens_qualification_reasons,
)

_K = np.array([[3000.0, 0.0, 2000.0], [0.0, 3000.0, 1500.0], [0.0, 0.0, 1.0]])


def _res(dist=None, rms=0.4, model="full"):
    d = np.array([-0.12, 0.04, 0.0008, -0.0006, 0.02]) if dist is None else np.asarray(dist)
    return IntrinsicsResult(
        K=_K.copy(), dist=d, rms=rms, focal_stddev_px=(1.0, 1.0),
        pp_stddev_px=(1.0, 1.0), distortion_model=model, coplanar_ratio=0.2,
        rvecs=[], tvecs=[])


def _info(*, num_images=10, num_points=120, image_size=(4000, 3000),
          diversity_ok=True, rms=0.4, dist=None, model="full"):
    return SelfCalInfo(
        res=_res(dist=dist, rms=rms, model=model), num_images=num_images,
        num_points=num_points, image_size=image_size, view_axis_deg=22.0,
        standoff_ratio=1.7, diversity_ok=diversity_ok, has_anchor=False)


def _vpcal_gate_reasons(data: dict) -> list[str]:
    """The authoritative vpcal master-lens gate (tracker_free.py:116-139), inlined
    so the archived JSON is checked against the SAME口径 without importing vpcal."""
    reasons = []
    if data.get("is_master") is not True:
        reasons.append("is_master")
    if data.get("session_coupled") is True:
        reasons.append("session_coupled")
    if data.get("calibration_kind") not in {"multi_view_intrinsics", "offline_chart"}:
        reasons.append("calibration_kind")
    if int(data.get("num_images", 0) or 0) < 8:
        reasons.append("num_images")
    if int(data.get("num_points", 0) or 0) < 60:
        reasons.append("num_points")
    isz = data.get("image_size")
    if not (isinstance(isz, (list, tuple)) and len(isz) >= 2
            and int(isz[0]) > 0 and int(isz[1]) > 0):
        reasons.append("image_size")
    rms = float(data.get("rms", float("inf")))
    if not np.isfinite(rms) or rms >= 2.0:
        reasons.append("rms")
    return reasons


def test_qualified_writes_vpcal_master_lens(tmp_path):
    out = tmp_path / "lenses" / "recon-auto.master-lens.json"
    summary = archive_master_lens(_info(), str(out))
    assert summary.archived is True
    assert summary.path == str(out)
    data = json.loads(out.read_text())
    # Passes the authoritative vpcal gate on every field.
    assert _vpcal_gate_reasons(data) == []
    # Provenance + timestamp present.
    assert data["source"] == MASTER_LENS_SOURCE
    assert "calibrated_at" in data and data["calibrated_at"]
    # fx/fy/cx/cy taken from res.K; 5-element dist_coeffs.
    assert data["fx"] == 3000.0 and data["cx"] == 2000.0
    assert len(data["dist_coeffs"]) == 5


def test_zero_dist_padded_to_five(tmp_path):
    out = tmp_path / "lenses" / "l.master-lens.json"
    summary = archive_master_lens(_info(dist=np.zeros(0), model="zero_dist"), str(out))
    assert summary.archived is True
    data = json.loads(out.read_text())
    assert data["dist_coeffs"] == [0.0, 0.0, 0.0, 0.0, 0.0]


def test_num_images_below_gate_not_written(tmp_path):
    out = tmp_path / "lenses" / "l.master-lens.json"
    summary = archive_master_lens(_info(num_images=7), str(out))
    assert summary.archived is False
    assert not out.exists()
    assert "num_images" in (summary.reason or "")


def test_rms_above_gate_not_written(tmp_path):
    out = tmp_path / "lenses" / "l.master-lens.json"
    summary = archive_master_lens(_info(rms=2.5), str(out))
    assert summary.archived is False
    assert not out.exists()
    assert "RMS" in (summary.reason or "")


def test_weak_diversity_not_written(tmp_path):
    out = tmp_path / "lenses" / "l.master-lens.json"
    summary = archive_master_lens(_info(diversity_ok=False), str(out))
    assert summary.archived is False
    assert not out.exists()
    assert "diversity" in (summary.reason or "")


def test_parent_dir_created(tmp_path):
    out = tmp_path / "does" / "not" / "exist" / "l.master-lens.json"
    summary = archive_master_lens(_info(), str(out))
    assert summary.archived is True
    assert out.exists()


def test_readonly_dir_reports_write_failed(tmp_path):
    ro = tmp_path / "ro"
    ro.mkdir()
    os.chmod(ro, stat.S_IRUSR | stat.S_IXUSR)  # read+exec, no write
    out = ro / "l.master-lens.json"
    try:
        summary = archive_master_lens(_info(), str(out))
    finally:
        os.chmod(ro, stat.S_IRWXU)
    assert summary.archived is False
    assert (summary.reason or "").startswith("write failed")


def test_qualification_reasons_empty_when_ok():
    assert master_lens_qualification_reasons(_info()) == []
