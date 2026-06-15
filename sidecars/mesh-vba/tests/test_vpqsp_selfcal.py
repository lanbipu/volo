"""VP-QSP `--intrinsics auto` self-calibration: solve K from the captured marker wall.

The displayed wall IS the calibration target. These tests project
``nominal_marker_positions_world`` through known oblique poses to produce
frame-matched detections (the same approach the SL self-cal test uses), then assert
``_self_calibrate_vpqsp`` / ``run_reconstruct`` recover K. Unlike the SL path, a FLAT
wall WITHOUT an anchor is ADMITTED (with a ``no_intrinsics_anchor`` warning): the
provided pixel pitch fixes the metric scale, so a known flat target + angularly
diverse shots is a well-posed Zhang problem. (FIX-2 unified the model frame to
+y-UP, so ``nominal_marker_positions_world`` composes world = t + R @ local with
no sign flips; the old local-y negation this docstring used to justify is gone.)
"""
from __future__ import annotations

import json

import cv2
import numpy as np
import pytest

import lmt_vba_sidecar.vpqsp_detect as vpqsp_detect
from lmt_vba_sidecar.intrinsics_solve import IntrinsicsRefused
from lmt_vba_sidecar.ipc import ReconstructInput, VpqspPatternMeta
from lmt_vba_sidecar.nominal import nominal_marker_positions_world
from lmt_vba_sidecar.reconstruct import _self_calibrate_vpqsp, pattern_hash, run_reconstruct
from lmt_vba_sidecar.vpqsp_layout import choose_marker_grid

_RES = (630, 630)
_ACTIVE = 600.0
_IMG = (1920, 1080)
_K = np.array([[2400.0, 0.0, _IMG[0] / 2], [0.0, 2400.0, _IMG[1] / 2], [0.0, 0.0, 1.0]], float)
_MX, _MY, _MPX = choose_marker_grid(_RES)
_PITCH = [_ACTIVE / _RES[0], _ACTIVE / _RES[1]]


# --------------------------------------------------------------------------- #
# synthetic builders
# --------------------------------------------------------------------------- #
def _meta(cols, rows, screen_id_code=0) -> VpqspPatternMeta:
    cabs = [
        {"col": c, "row": r, "resolution_px": list(_RES), "markers_x": _MX,
         "markers_y": _MY, "marker_px": _MPX, "pixel_pitch_mm": list(_PITCH)}
        for r in range(rows) for c in range(cols)
    ]
    return VpqspPatternMeta.model_validate(
        {"schema_version": "vpqsp.v1", "screen_id_code": screen_id_code, "cabinets": cabs})


def _shape_prior(shape, radius_mm=4000.0):
    return {"curved": {"radius_mm": radius_mm}} if shape == "curved" else "flat"


def _cmd(cols, rows, *, shape="flat", crosscheck=None, screen_id_code=0,
         capture="cap.json", pose=None) -> ReconstructInput:
    d = {
        "command": "reconstruct", "version": 1,
        "project": {
            "screen_id": "S",
            "cabinet_array": {"cols": cols, "rows": rows, "cabinet_size_mm": [_ACTIVE, _ACTIVE]},
            "shape_prior": _shape_prior(shape),
        },
        "capture_manifest_path": capture,
        "intrinsics_path": "auto",
    }
    if crosscheck is not None:
        d["crosscheck_intrinsics_path"] = crosscheck
    if pose is not None:
        d["pose_report_path"] = pose
    return ReconstructInput.model_validate(d)


def _poses(center_m, *, yaws=(-25, -12, 0, 12, 25), pits=(-15, 0, 15), standoff=2.2):
    """Oblique look-at poses around the wall center (angular diversity = Zhang's
    well-posedness requirement)."""
    out = []
    for yaw in yaws:
        for pit in pits:
            y, p = np.deg2rad(yaw), np.deg2rad(pit)
            cp = center_m + standoff * np.array(
                [np.sin(y) * np.cos(p), np.sin(p), -np.cos(y) * np.cos(p)])
            fwd = center_m - cp
            fwd /= np.linalg.norm(fwd)
            up = np.array([0.0, -1.0, 0.0])
            right = np.cross(up, fwd)
            right /= np.linalg.norm(right)
            up2 = np.cross(fwd, right)
            Rc = np.stack([right, up2, fwd])
            out.append((Rc, -Rc @ cp))
    return out


def _detections(marker_world, poses, *, K=_K, dist=None, noise=0.0, seed=0,
                screen_id_code=0, transform=None, names=None):
    """Project nominal marker world (meters) through poses -> per-view detections.

    `transform(X)->X'` corrupts the displayed geometry (e.g. anisotropic screen
    pitch) while self-cal still assumes the un-transformed nominal target."""
    rng = np.random.default_rng(seed)
    items = list(marker_world.items())
    dets, view_images = {}, []
    for vi, (Rc, tc) in enumerate(poses):
        path = (names[vi] if names else f"view_{vi:03d}.png")
        view_images.append([path])
        obs = []
        for (col, row, lid), X in items:
            Xw = X if transform is None else transform(X)
            cam = Rc @ Xw + tc
            if cam[2] <= 0:
                continue
            if dist is None:
                uv = K @ cam
                uv = uv[:2] / uv[2]
            else:
                rvec, _ = cv2.Rodrigues(Rc)
                uv = cv2.projectPoints(
                    Xw.reshape(1, 1, 3), rvec, tc.reshape(3, 1), K, np.asarray(dist, float)
                )[0].reshape(2)
            uv = uv + rng.normal(0.0, noise, 2)
            obs.append({"cabinet": (col, row), "screen_id": screen_id_code,
                        "local_id": lid, "corner_px": [float(uv[0]), float(uv[1])]})
        dets[path] = obs
    return dets, view_images


def _center(marker_world):
    return np.mean(np.stack(list(marker_world.values())), axis=0)


def _warnings(out: str) -> set[str]:
    codes = set()
    for line in out.splitlines():
        line = line.strip()
        if line and json.loads(line).get("event") == "warning":
            codes.add(json.loads(line)["code"])
    return codes


# --------------------------------------------------------------------------- #
# nominal_marker_positions_world geometry
# --------------------------------------------------------------------------- #
def test_nominal_marker_positions_world_flat_geometry():
    cmd = _cmd(2, 1)
    meta = _meta(2, 1)
    world = nominal_marker_positions_world(meta, cmd.project.cabinet_array, cmd.project.shape_prior)
    # One entry per (col,row,local_id), all flat (z == 0), spanning both cabinets.
    assert len(world) == 2 * _MX * _MY
    assert {(c, r) for (c, r, _l) in world} == {(0, 0), (1, 0)}
    assert all(abs(float(p[2])) < 1e-9 for p in world.values())  # flat -> z=0
    # Inter-cabinet centroid offset == one cabinet width (600mm = 0.6m) in +x.
    c0 = np.mean([p for (c, r, _l), p in world.items() if (c, r) == (0, 0)], axis=0)
    c1 = np.mean([p for (c, r, _l), p in world.items() if (c, r) == (1, 0)], axis=0)
    assert np.allclose(c1 - c0, [0.6, 0.0, 0.0], atol=1e-6)


def test_nominal_marker_positions_world_rejects_absent_cabinet():
    cmd = _cmd(2, 1)
    meta = _meta(2, 1)
    cmd.project.cabinet_array.absent_cells = [[1, 0]]  # cabinet present in meta, absent in nominal
    with pytest.raises(ValueError, match="absent/unknown"):
        nominal_marker_positions_world(meta, cmd.project.cabinet_array, cmd.project.shape_prior)


# --------------------------------------------------------------------------- #
# _self_calibrate_vpqsp (direct)
# --------------------------------------------------------------------------- #
def test_selfcal_recovers_focal_flat_no_anchor(capsys):
    cmd = _cmd(2, 1)
    meta = _meta(2, 1)
    world = nominal_marker_positions_world(meta, cmd.project.cabinet_array, cmd.project.shape_prior)
    dets, view_images = _detections(world, _poses(_center(world)))
    K, dist = _self_calibrate_vpqsp(meta, dets, view_images, _IMG, cmd)
    assert abs(K[0, 0] - 2400.0) / 2400.0 < 0.01   # fx within 1%
    assert abs(K[1, 1] - 2400.0) / 2400.0 < 0.01   # fy within 1%
    assert abs(K[0, 2] - _IMG[0] / 2) < 5.0        # cx locked near image center
    assert abs(K[1, 2] - _IMG[1] / 2) < 5.0        # cy locked near image center
    assert np.allclose(dist.flatten()[:2], 0.0, atol=2e-3)  # zero-distortion truth
    # FLAT wall + no anchor is ADMITTED (the key divergence from SL), with a warning.
    assert "no_intrinsics_anchor" in _warnings(capsys.readouterr().out)


def test_selfcal_curved_no_anchor_admitted_with_warning(capsys):
    cmd = _cmd(3, 3, shape="curved")
    meta = _meta(3, 3)
    world = nominal_marker_positions_world(meta, cmd.project.cabinet_array, cmd.project.shape_prior)
    K, _ = _self_calibrate_vpqsp(meta, *_detections(world, _poses(_center(world))), _IMG, cmd)
    assert abs(K[0, 0] - 2400.0) / 2400.0 < 0.01
    assert "no_intrinsics_anchor" in _warnings(capsys.readouterr().out)


def test_selfcal_with_anchor_passes_crosscheck(tmp_path, capsys):
    anchor = tmp_path / "anchor.json"
    anchor.write_text(json.dumps({"K": _K.tolist(), "dist_coeffs": [0, 0, 0, 0, 0]}))
    cmd = _cmd(2, 1, crosscheck=str(anchor))
    meta = _meta(2, 1)
    world = nominal_marker_positions_world(meta, cmd.project.cabinet_array, cmd.project.shape_prior)
    K, _ = _self_calibrate_vpqsp(meta, *_detections(world, _poses(_center(world))), _IMG, cmd)
    assert abs(K[0, 0] - 2400.0) / 2400.0 < 0.01
    # An anchor was supplied -> no no_intrinsics_anchor warning.
    assert "no_intrinsics_anchor" not in _warnings(capsys.readouterr().out)


def test_selfcal_anisotropic_pitch_absorbed_refused_with_anchor(tmp_path):
    # Screen driven non-1:1: displayed x-pitch is 4% larger than the assumed nominal.
    # Self-cal absorbs the stretch into fx/fy aspect; the anchor cross-check catches it.
    anchor = tmp_path / "anchor.json"
    anchor.write_text(json.dumps({"K": _K.tolist(), "dist_coeffs": [0, 0, 0, 0, 0]}))
    cmd = _cmd(2, 1, crosscheck=str(anchor))
    meta = _meta(2, 1)
    world = nominal_marker_positions_world(meta, cmd.project.cabinet_array, cmd.project.shape_prior)
    ctr = _center(world)

    def stretch_x(X):
        return ctr + np.array([1.04, 1.0, 1.0]) * (X - ctr)

    dets, view_images = _detections(world, _poses(ctr), transform=stretch_x)
    with pytest.raises(IntrinsicsRefused) as ei:
        _self_calibrate_vpqsp(meta, dets, view_images, _IMG, cmd)
    assert ei.value.code == "observability_failed"  # anti-absorption refusal


def test_selfcal_frontal_only_is_refused():
    # All shots fronto-parallel -> no rotation diversity -> ill-posed -> refused
    # (the conditioning gate that replaces SL's flat-wall-needs-anchor refusal).
    cmd = _cmd(2, 1)
    meta = _meta(2, 1)
    world = nominal_marker_positions_world(meta, cmd.project.cabinet_array, cmd.project.shape_prior)
    dets, view_images = _detections(world, _poses(_center(world), yaws=(0,), pits=(0,) * 4))
    with pytest.raises(IntrinsicsRefused) as ei:
        _self_calibrate_vpqsp(meta, dets, view_images, _IMG, cmd)
    assert ei.value.code == "observability_failed"


# --------------------------------------------------------------------------- #
# run_reconstruct integration (--intrinsics auto end-to-end)
# --------------------------------------------------------------------------- #
def _write_auto_capture(tmp_path, cmd, meta, dets, view_images, *, with_intrinsics_field=False):
    """Write blank PNGs (only their size matters; detection is monkeypatched),
    pattern_meta, screen_mapping and a manifest WITHOUT an intrinsics field, then
    rekey detections by absolute path. Returns (paths, abs_detections)."""
    cap = tmp_path / "cap"
    cap.mkdir()
    blank = np.zeros((_IMG[1], _IMG[0]), dtype=np.uint8)
    abs_dets = {}
    views = []
    for imgs in view_images:
        name = imgs[0]
        cv2.imwrite(str(cap / name), blank)
        abs_dets[str(cap / name)] = dets[name]
        views.append({"view_id": name, "images": [name]})

    (cap / "pattern_meta.json").write_text(meta.model_dump_json())

    def _sm_cab(cid):
        return {"cabinet_id": cid, "resolution_px": list(_RES), "active_size_mm": [_ACTIVE, _ACTIVE],
                "pixel_pitch_mm": list(_PITCH), "active_origin": "center",
                "input_rect_px": [0, 0, _RES[0], _RES[1]], "rotation": 0,
                "mirror_x": False, "mirror_y": False}

    cabs = [(c, r) for r in range(cmd.project.cabinet_array.rows)
            for c in range(cmd.project.cabinet_array.cols)]
    (cap / "screen_mapping.json").write_text(json.dumps(
        {"screen_id": "S",
         "cabinets": [_sm_cab(f"V{c:03d}_R{r:03d}") for (c, r) in cabs],
         "expected_pattern_hash": pattern_hash(meta)}))

    manifest = {"method": "vpqsp", "pattern_meta": "pattern_meta.json",
                "screen_mapping": "screen_mapping.json", "views": views}
    if with_intrinsics_field:
        manifest["intrinsics"] = "auto"
    (cap / "capture.json").write_text(json.dumps(manifest))
    return str(cap / "capture.json"), abs_dets


def _patch_detector(monkeypatch, detections):
    def fake(paths, *, screen_id_code=None, config=None):
        return {p: [o for o in detections.get(p, [])
                    if screen_id_code is None or o["screen_id"] == screen_id_code]
                for p in paths}
    monkeypatch.setattr(vpqsp_detect, "detect_vpqsp_markers", fake)


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


def test_run_reconstruct_auto_recovers_geometry(tmp_path, capsys, monkeypatch):
    meta = _meta(2, 1)
    cmd0 = _cmd(2, 1)
    world = nominal_marker_positions_world(meta, cmd0.project.cabinet_array, cmd0.project.shape_prior)
    dets, view_images = _detections(world, _poses(_center(world)), noise=0.2, seed=1)
    cap, abs_dets = _write_auto_capture(tmp_path, cmd0, meta, dets, view_images)
    _patch_detector(monkeypatch, abs_dets)

    pose = str(tmp_path / "pose.json")
    cmd = ReconstructInput.model_validate({
        "command": "reconstruct", "version": 1,
        "project": cmd0.project.model_dump(),
        "capture_manifest_path": cap, "pose_report_path": pose, "intrinsics_path": "auto",
    })
    assert run_reconstruct(cmd) == 0
    out = capsys.readouterr().out
    data = _result(out)["data"]
    assert data["intrinsics_source"] == "auto_self_calibrated"
    assert data["ba_stats"]["rms_reprojection_px"] < 1.0
    assert "no_intrinsics_anchor" in _warnings(out)
    # On-nominal flat wall: cabinets recovered ~600mm apart, ~coplanar.
    poses = json.loads((tmp_path / "pose.json").read_text())["cabinet_poses"]
    pos = {c["cabinet_id"]: np.array(c["position_mm"]) for c in poses}
    nrm = {c["cabinet_id"]: np.array(c["normal"]) for c in poses}
    assert abs(np.linalg.norm(pos["V001_R000"] - pos["V000_R000"]) - 600.0) < 10.0
    ang = np.degrees(np.arccos(np.clip(nrm["V000_R000"] @ nrm["V001_R000"], -1, 1)))
    assert ang < 1.0


def test_run_reconstruct_auto_via_manifest_sentinel(tmp_path, capsys, monkeypatch):
    # `--intrinsics` omitted at the CLI but the manifest's intrinsics field == "auto".
    meta = _meta(2, 1)
    cmd0 = _cmd(2, 1)
    world = nominal_marker_positions_world(meta, cmd0.project.cabinet_array, cmd0.project.shape_prior)
    dets, view_images = _detections(world, _poses(_center(world)), noise=0.2, seed=2)
    cap, abs_dets = _write_auto_capture(tmp_path, cmd0, meta, dets, view_images,
                                        with_intrinsics_field=True)
    _patch_detector(monkeypatch, abs_dets)
    cmd = ReconstructInput.model_validate({
        "command": "reconstruct", "version": 1, "project": cmd0.project.model_dump(),
        "capture_manifest_path": cap, "pose_report_path": str(tmp_path / "p.json"),
        # no intrinsics_path override -> falls back to manifest.intrinsics == "auto"
    })
    assert run_reconstruct(cmd) == 0
    assert _result(capsys.readouterr().out)["data"]["intrinsics_source"] == "auto_self_calibrated"


def test_run_reconstruct_no_intrinsics_anywhere_is_invalid_input(tmp_path, capsys, monkeypatch):
    meta = _meta(2, 1)
    cmd0 = _cmd(2, 1)
    world = nominal_marker_positions_world(meta, cmd0.project.cabinet_array, cmd0.project.shape_prior)
    dets, view_images = _detections(world, _poses(_center(world)))
    cap, abs_dets = _write_auto_capture(tmp_path, cmd0, meta, dets, view_images)
    _patch_detector(monkeypatch, abs_dets)
    cmd = ReconstructInput.model_validate({
        "command": "reconstruct", "version": 1, "project": cmd0.project.model_dump(),
        "capture_manifest_path": cap, "pose_report_path": str(tmp_path / "p.json"),
        # neither manifest.intrinsics nor --intrinsics provided
    })
    assert run_reconstruct(cmd) == 1
    assert _error(capsys.readouterr().out)["code"] == "invalid_input"


def test_run_reconstruct_auto_unreadable_images_is_invalid_input(tmp_path, capsys, monkeypatch):
    # --intrinsics auto needs the camera frame size, read from a capture image. If NO
    # image is readable (missing/corrupt files), fail clean with invalid_input — not a crash.
    meta = _meta(2, 1)
    cmd0 = _cmd(2, 1)
    world = nominal_marker_positions_world(meta, cmd0.project.cabinet_array, cmd0.project.shape_prior)
    dets, view_images = _detections(world, _poses(_center(world)))
    cap = tmp_path / "cap"
    cap.mkdir()
    abs_dets, views = {}, []
    for imgs in view_images:  # write meta/sm/manifest but NOT the PNGs (unreadable)
        name = imgs[0]
        abs_dets[str(cap / name)] = dets[name]
        views.append({"view_id": name, "images": [name]})
    (cap / "pattern_meta.json").write_text(meta.model_dump_json())
    (cap / "screen_mapping.json").write_text(json.dumps(
        {"screen_id": "S",
         "cabinets": [{"cabinet_id": f"V{c:03d}_R000", "resolution_px": list(_RES),
                       "active_size_mm": [_ACTIVE, _ACTIVE], "pixel_pitch_mm": list(_PITCH),
                       "active_origin": "center", "input_rect_px": [0, 0, _RES[0], _RES[1]],
                       "rotation": 0, "mirror_x": False, "mirror_y": False} for c in (0, 1)],
         "expected_pattern_hash": pattern_hash(meta)}))
    (cap / "capture.json").write_text(json.dumps(
        {"method": "vpqsp", "pattern_meta": "pattern_meta.json",
         "screen_mapping": "screen_mapping.json", "views": views}))
    _patch_detector(monkeypatch, abs_dets)
    cmd = ReconstructInput.model_validate({
        "command": "reconstruct", "version": 1, "project": cmd0.project.model_dump(),
        "capture_manifest_path": str(cap / "capture.json"),
        "pose_report_path": str(tmp_path / "p.json"), "intrinsics_path": "auto",
    })
    assert run_reconstruct(cmd) == 1
    err = _error(capsys.readouterr().out)
    assert err["code"] == "invalid_input"
    assert "cannot read any capture image" in err["message"]


def test_charuco_method_rejects_auto_intrinsics(tmp_path, capsys):
    # `--intrinsics auto` is vpqsp-only (charuco has no per-cabinet marker-grid target
    # assembled here); a charuco manifest + auto must fail loud, not load a file named "auto".
    cap = tmp_path / "cap"
    cap.mkdir()
    (cap / "capture.json").write_text(json.dumps(
        {"method": "charuco", "pattern_meta": "pattern_meta.json",
         "screen_mapping": "screen_mapping.json",
         "views": [{"view_id": "v0", "images": ["v0.png"]}]}))
    cmd = ReconstructInput.model_validate({
        "command": "reconstruct", "version": 1, "project": _cmd(2, 1).project.model_dump(),
        "capture_manifest_path": str(cap / "capture.json"),
        "pose_report_path": str(tmp_path / "p.json"), "intrinsics_path": "auto",
    })
    assert run_reconstruct(cmd) == 1
    err = _error(capsys.readouterr().out)
    assert err["code"] == "invalid_input"
    assert "only supported for method=vpqsp" in err["message"]


def test_run_reconstruct_auto_mixed_resolution_is_invalid_input(tmp_path, capsys, monkeypatch):
    # FIX-20: views with different frame sizes must be rejected (mirrors SL path).
    meta = _meta(2, 1)
    cmd0 = _cmd(2, 1)
    world = nominal_marker_positions_world(meta, cmd0.project.cabinet_array, cmd0.project.shape_prior)
    dets, view_images = _detections(world, _poses(_center(world)))
    cap = tmp_path / "cap"
    cap.mkdir()
    abs_dets, views = {}, []
    for vi, imgs in enumerate(view_images):
        name = imgs[0]
        # First view: 1920×1080; remaining views: 1280×720 — mixed sizes.
        h, w = (_IMG[1], _IMG[0]) if vi == 0 else (720, 1280)
        cv2.imwrite(str(cap / name), np.zeros((h, w), dtype=np.uint8))
        abs_dets[str(cap / name)] = dets[name]
        views.append({"view_id": name, "images": [name]})
    (cap / "pattern_meta.json").write_text(meta.model_dump_json())
    (cap / "screen_mapping.json").write_text(json.dumps(
        {"screen_id": "S",
         "cabinets": [{"cabinet_id": f"V{c:03d}_R000", "resolution_px": list(_RES),
                       "active_size_mm": [_ACTIVE, _ACTIVE], "pixel_pitch_mm": list(_PITCH),
                       "active_origin": "center", "input_rect_px": [0, 0, _RES[0], _RES[1]],
                       "rotation": 0, "mirror_x": False, "mirror_y": False} for c in (0, 1)],
         "expected_pattern_hash": pattern_hash(meta)}))
    (cap / "capture.json").write_text(json.dumps(
        {"method": "vpqsp", "pattern_meta": "pattern_meta.json",
         "screen_mapping": "screen_mapping.json", "views": views}))
    _patch_detector(monkeypatch, abs_dets)
    cmd = ReconstructInput.model_validate({
        "command": "reconstruct", "version": 1, "project": cmd0.project.model_dump(),
        "capture_manifest_path": str(cap / "capture.json"),
        "pose_report_path": str(tmp_path / "p.json"), "intrinsics_path": "auto",
    })
    assert run_reconstruct(cmd) == 1
    err = _error(capsys.readouterr().out)
    assert err["code"] == "invalid_input"
    assert "disagree on frame size" in err["message"]
