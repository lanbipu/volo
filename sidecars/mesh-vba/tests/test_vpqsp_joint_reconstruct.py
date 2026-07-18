"""Joint multi-screen VP-QSP reconstruct integration tests."""
from __future__ import annotations

import json

import cv2
import numpy as np
import pytest

import lmt_vba_sidecar.vpqsp_detect as vpqsp_detect
from lmt_vba_sidecar.ipc import ReconstructInput, VpqspPatternMeta
from lmt_vba_sidecar.reconstruct import pattern_hash, run_reconstruct
from lmt_vba_sidecar.vpqsp_layout import choose_marker_grid, marker_local_mm

_ACTIVE = 600.0
_RES = (630, 630)
_IMG = (1920, 1080)
_SCREEN_GAP_MM = 800.0
_SCREEN_ANGLE_DEG = 12.0
_K = np.array([[2400.0, 0, _IMG[0] / 2], [0, 2400.0, _IMG[1] / 2], [0, 0, 1]], float)


def _camera_poses(*, bridge_views: bool = True):
    """Camera poses; when bridge_views=False, views are partitioned per screen."""
    if not bridge_views:
        out = []
        for center_x in (_ACTIVE / 2.0, _ACTIVE + _SCREEN_GAP_MM + _ACTIVE / 2.0):
            center = np.array([center_x, 0.0, 0.0])
            for yaw in (-20, 20):
                for pit in (-10, 10):
                    y, p = np.deg2rad(yaw), np.deg2rad(pit)
                    cp = center + 2200.0 * np.array([
                        np.sin(y) * np.cos(p), np.sin(p), -np.cos(y) * np.cos(p)])
                    fwd = center - cp
                    fwd /= np.linalg.norm(fwd)
                    up = np.array([0.0, -1.0, 0.0])
                    right = np.cross(up, fwd)
                    right /= np.linalg.norm(right)
                    up2 = np.cross(fwd, right)
                    Rc = np.stack([right, up2, fwd])
                    out.append((Rc, -Rc @ cp))
        return out

    center_a = np.array([_ACTIVE / 2.0, 0.0, 0.0])
    center_b = np.array([_ACTIVE + _SCREEN_GAP_MM + _ACTIVE / 2.0, 0.0, 0.0])
    center = (center_a + center_b) / 2.0
    out = []
    for yaw in (-25, -12, 0, 12, 25):
        for pit in (-12, 0, 12):
            y, p = np.deg2rad(yaw), np.deg2rad(pit)
            cp = center + 2400.0 * np.array([np.sin(y) * np.cos(p), np.sin(p), -np.cos(y) * np.cos(p)])
            fwd = center - cp
            fwd /= np.linalg.norm(fwd)
            up = np.array([0.0, -1.0, 0.0])
            right = np.cross(up, fwd)
            right /= np.linalg.norm(right)
            up2 = np.cross(fwd, right)
            Rc = np.stack([right, up2, fwd])
            out.append((Rc, -Rc @ cp))
    return out


def _screen_pose(offset_mm: float, angle_deg: float):
    R, _ = cv2.Rodrigues(np.array([0.0, np.deg2rad(angle_deg), 0.0]))
    return R, np.array([offset_mm, 0.0, 0.0], dtype=float)


def _build_joint_capture(tmp_path, *, bridge_views: bool = True):
    """Two-screen synthetic capture with known relative pose."""
    mx, my, mpx = choose_marker_grid(_RES)
    pitch = (_ACTIVE / _RES[0], _ACTIVE / _RES[1])
    R0, T0 = np.eye(3), np.zeros(3)
    R1, T1 = _screen_pose(_ACTIVE + _SCREEN_GAP_MM, _SCREEN_ANGLE_DEG)

    screen_defs = [
        ("screen_a", 0, [
            ((0, 0), R0, T0),
            ((1, 0), R0, T0 + np.array([_ACTIVE, 0.0, 0.0])),
        ]),
        ("screen_b", 1, [
            ((0, 0), R1, T1),
            ((1, 0), R1, T1 + R1 @ np.array([_ACTIVE, 0.0, 0.0])),
        ]),
    ]

    cap = tmp_path / "capture"
    cap.mkdir()
    rng = np.random.default_rng(7)
    detections: dict[str, list] = {}
    views = []

    for vi, (Rc, tc) in enumerate(_camera_poses(bridge_views=bridge_views)):
        path = str(cap / f"cam_{vi:03d}.png")
        views.append({"view_id": f"cam_{vi:03d}", "images": [f"cam_{vi:03d}.png"]})
        obs = []
        for sid, code, cab_defs in screen_defs:
            for cr, Rb, Tb in cab_defs:
                for lid in range(mx * my):
                    pl = marker_local_mm(
                        lid, markers_x=mx, markers_y=my, marker_px=mpx,
                        resolution_px=_RES, pixel_pitch_mm=pitch)
                    cam = Rc @ (Rb @ pl + Tb) + tc
                    if cam[2] <= 0:
                        continue
                    uv = _K @ cam
                    uv = uv[:2] / uv[2] + rng.normal(0, 0.15, 2)
                    obs.append({
                        "cabinet": cr,
                        "screen_id": code,
                        "local_id": lid,
                        "corner_px": [float(uv[0]), float(uv[1])],
                    })
        detections[path] = obs

    def _meta_cab(col, row):
        return {
            "col": col, "row": row, "resolution_px": list(_RES),
            "markers_x": mx, "markers_y": my, "marker_px": mpx,
            "pixel_pitch_mm": list(pitch),
        }

    def _sm_cab(cid):
        return {
            "cabinet_id": cid, "resolution_px": list(_RES),
            "active_size_mm": [_ACTIVE, _ACTIVE], "pixel_pitch_mm": list(pitch),
            "active_origin": "center", "input_rect_px": [0, 0, _RES[0], _RES[1]],
            "rotation": 0, "mirror_x": False, "mirror_y": False,
        }

    screen_entries = []
    for sid, code, cab_defs in screen_defs:
        cabs = [cr for cr, _Rb, _Tb in cab_defs]
        meta = VpqspPatternMeta.model_validate({
            "schema_version": "vpqsp.v1",
            "screen_id_code": code,
            "cabinets": [_meta_cab(c[0], c[1]) for c in cabs],
        })
        (cap / f"{sid}_pattern_meta.json").write_text(meta.model_dump_json())
        (cap / f"{sid}_screen_mapping.json").write_text(json.dumps({
            "screen_id": sid,
            "cabinets": [_sm_cab(f"V{c[0]:03d}_R{c[1]:03d}") for c in cabs],
            "expected_pattern_hash": pattern_hash(meta),
        }))
        screen_entries.append({
            "screen_id": sid,
            "screen_id_code": code,
            "pattern_meta": f"{sid}_pattern_meta.json",
            "screen_mapping": f"{sid}_screen_mapping.json",
        })

    (cap / "intrinsics.json").write_text(json.dumps({
        "K": _K.tolist(), "dist_coeffs": [0, 0, 0, 0, 0], "image_size": list(_IMG),
    }))
    (cap / "capture.json").write_text(json.dumps({
        "method": "vpqsp",
        "intrinsics": "intrinsics.json",
        "screens": screen_entries,
        "views": views,
    }))

    return {
        "capture": str(cap / "capture.json"),
        "transforms": str(tmp_path / "screen_transforms.json"),
        "pose_a": str(tmp_path / "pose_a.json"),
        "pose_b": str(tmp_path / "pose_b.json"),
        "expected_R": R1,
        "expected_t": T1,
    }, detections


def _patch_detector(monkeypatch, detections):
    def fake(paths, *, screen_id_code=None, config=None):
        return {
            p: [o for o in detections.get(p, [])
                if screen_id_code is None or o["screen_id"] == screen_id_code]
            for p in paths
        }
    monkeypatch.setattr(vpqsp_detect, "detect_vpqsp_markers", fake)


def _joint_input(paths) -> ReconstructInput:
    return ReconstructInput.model_validate({
        "command": "reconstruct",
        "version": 1,
        "screens": [
            {
                "screen_id": "screen_a",
                "screen_id_code": 0,
                "cabinet_array": {"cols": 2, "rows": 1, "cabinet_size_mm": [600, 600]},
                "shape_prior": "flat",
                "pattern_meta_path": str(paths["capture"].replace("capture.json", "screen_a_pattern_meta.json")),
                "screen_mapping_path": str(paths["capture"].replace("capture.json", "screen_a_screen_mapping.json")),
                "pose_report_path": paths["pose_a"],
            },
            {
                "screen_id": "screen_b",
                "screen_id_code": 1,
                "cabinet_array": {"cols": 2, "rows": 1, "cabinet_size_mm": [600, 600]},
                "shape_prior": "flat",
                "pattern_meta_path": str(paths["capture"].replace("capture.json", "screen_b_pattern_meta.json")),
                "screen_mapping_path": str(paths["capture"].replace("capture.json", "screen_b_screen_mapping.json")),
                "pose_report_path": paths["pose_b"],
            },
        ],
        "capture_manifest_path": paths["capture"],
        "screen_transforms_path": paths["transforms"],
    })


def _result(out: str) -> dict:
    for line in out.splitlines():
        line = line.strip()
        if line and json.loads(line).get("event") == "result":
            return json.loads(line)
    raise AssertionError("no result event")


def _error(out: str) -> dict:
    for line in out.splitlines():
        line = line.strip()
        if line and json.loads(line).get("event") == "error":
            return json.loads(line)
    raise AssertionError("no error event")


def test_joint_two_screen_recovers_relative_pose(tmp_path, capsys, monkeypatch):
    paths, dets = _build_joint_capture(tmp_path, bridge_views=True)
    _patch_detector(monkeypatch, dets)
    assert run_reconstruct(_joint_input(paths)) == 0

    data = _result(capsys.readouterr().out)["data"]
    assert data["screen_transforms_path"] == paths["transforms"]
    assert len(data["screens"]) == 2
    assert data["ba_stats"]["rms_reprojection_px"] < 1.5

    transforms = json.loads(open(paths["transforms"]).read())
    assert transforms["schema_version"] == "visual_screen_transforms.v1"
    assert transforms["frame_screen_id"] == "screen_a"
    tb = next(t for t in transforms["transforms"] if t["screen_id"] == "screen_b")
    R_est = np.array(tb["R"], dtype=float)
    t_est = np.array(tb["t_mm"], dtype=float)

    R_exp, t_exp = paths["expected_R"], paths["expected_t"]
    angle_err = np.degrees(np.arccos(np.clip((np.trace(R_exp.T @ R_est) - 1) / 2, -1, 1)))
    assert angle_err < 0.1, f"rotation error {angle_err:.3f}°"
    assert np.linalg.norm(t_est - t_exp) < 15.0, f"translation error {np.linalg.norm(t_est - t_exp):.1f}mm"

    pose_a = json.loads(open(paths["pose_a"]).read())
    pose_b = json.loads(open(paths["pose_b"]).read())
    assert len(pose_a["cabinet_poses"]) == 2
    assert len(pose_b["cabinet_poses"]) == 2
    root_a = next(c for c in pose_a["cabinet_poses"] if c["cabinet_id"] == "V000_R000")
    root_b = next(c for c in pose_b["cabinet_poses"] if c["cabinet_id"] == "V000_R000")
    assert np.linalg.norm(np.array(root_a["position_mm"])) < 1.0
    assert np.linalg.norm(np.array(root_b["position_mm"])) < 1.0


def test_joint_no_bridge_views_is_screens_disconnected(tmp_path, capsys, monkeypatch):
    paths, dets = _build_joint_capture(tmp_path, bridge_views=False)
    # Partition views: first half sees only screen A, second half only screen B.
    view_paths = sorted(dets.keys())
    mid = len(view_paths) // 2
    partitioned = {}
    for i, path in enumerate(view_paths):
        code = 0 if i < mid else 1
        partitioned[path] = [o for o in dets[path] if o["screen_id"] == code]
    _patch_detector(monkeypatch, partitioned)
    assert run_reconstruct(_joint_input(paths)) == 1
    err = _error(capsys.readouterr().out)
    assert err["code"] == "screens_disconnected"


def test_single_screen_project_field_still_works(tmp_path, capsys, monkeypatch):
    """Old single-screen `project` input must remain byte-compatible."""
    from test_vpqsp_reconstruct import _build_capture, _input, _patch_detector as patch_single

    paths, dets = _build_capture(tmp_path)
    patch_single(monkeypatch, dets)
    assert run_reconstruct(_input(paths)) == 0
    data = _result(capsys.readouterr().out)["data"]
    assert data.get("screen_transforms_path") is None
    assert data.get("screens") is None
    assert data["ba_stats"]["rms_reprojection_px"] < 1.0
