#!/usr/bin/env python
"""Cross-sidecar synthetic E2E for the structured-light fixed-observation chain.

Chain under test (the REAL binaries, not shortcut fixtures):
  mesh-vba generate_structured_light   -> frames/ + sl_meta.json  (per screen)
  synthetic camera imaging             -> homography warp + blur + noise
  mesh-vba decode_structured_light     -> corr.json               (per screen)
  vpcal tracker-free fixed-observation-sl -> joint lens+pose solve

Asserts ground-truth recovery (focal / camera position) AND that the SL formal
gates pass. Run under the vpcal venv (needs cv2/numpy/pydantic + vpcal on
PYTHONPATH); mesh-vba is invoked through its own venv as a subprocess.

Usage:
  sidecars/vpcal/.venv/bin/python scripts/sl_e2e_synth.py [--workdir DIR]

Exit 0 on success; non-zero with a message on any failed assertion.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import pathlib
import subprocess
import sys
import tempfile

REPO = pathlib.Path(__file__).resolve().parents[1]
MESHVBA = REPO / "sidecars" / "mesh-vba"
VPCAL = REPO / "sidecars" / "vpcal"
MESHVBA_PY = os.environ.get("VOLO_MESHVBA_PY", str(MESHVBA / ".venv" / "bin" / "python"))

sys.path.insert(0, str(VPCAL / "src"))

import cv2  # noqa: E402
import numpy as np  # noqa: E402

from vpcal.models.screen import PlaneSection, ScreenDefinition  # noqa: E402

CANVAS_W, CANVAS_H = 3400, 2200      # SL render canvas (screen px, 1 mm/px)
CAMERA_W, CAMERA_H = 1920, 1080
K = np.array([[1600.0, 0.0, 960.0], [0.0, 1600.0, 540.0], [0.0, 0.0, 1.0]])
# Same camera geometry as the vpcal SL CLI fixture. Screen B sits at ~50°
# yaw from here, so its far side genuinely decodes thin — the planner's
# decode-yield headroom is what keeps the DECODED counts above the formal
# floors, exactly as it must on a real oblique capture.
GT_CAMERA = np.array([0.0, -2600.0, 500.0])
#: The SL canvas's 4 corner pixel centers (TL, TR, BR, BL) — single source for
#: both the projected quad and the warp homography, which MUST agree.
CORNERS_PX = np.array([[0, 0], [CANVAS_W - 1, 0],
                       [CANVAS_W - 1, CANVAS_H - 1], [0, CANVAS_H - 1]],
                      dtype=np.float64)


def _quat_axis_angle(axis, deg):
    axis = np.asarray(axis, dtype=float)
    axis = axis / np.linalg.norm(axis)
    rad = math.radians(deg)
    return [float(math.cos(rad / 2)), *(axis * math.sin(rad / 2)).tolist()]


def _screen(name, origin, deg):
    return ScreenDefinition(
        name=name, unit="mm", cabinet_size=[3400.0, 2200.0], led_pixel_pitch_mm=2.8,
        markers_per_cabinet=1,
        sections=[PlaneSection(name="wall", width_mm=3400.0, height_mm=2200.0,
                               origin=origin, rotation=_quat_axis_angle([0, 0, 1], deg))],
    )


def _meshvba(command: str, payload: dict) -> None:
    proc = subprocess.run(
        [MESHVBA_PY, "-m", "lmt_vba_sidecar", command],
        input=json.dumps(payload), capture_output=True, text=True,
        env=dict(os.environ, PYTHONPATH=str(MESHVBA / "src")),
    )
    if proc.returncode != 0:
        raise SystemExit(f"mesh-vba {command} failed (exit {proc.returncode}):\n"
                         f"{proc.stdout}\n{proc.stderr}")


def _camera_corners(screen: ScreenDefinition, rvec, tvec) -> np.ndarray:
    """Project the screen canvas's 4 corners into the camera (px)."""
    section = screen.sections[0]
    world = []
    for (u_px, v_px) in CORNERS_PX:
        u = (u_px + 0.5) / CANVAS_W
        v = 1.0 - (v_px + 0.5) / CANVAS_H
        world.append(section.uv_to_world(u, v))
    cam, _ = cv2.projectPoints(np.asarray(world).reshape(-1, 1, 3), rvec, tvec, K, np.zeros(5))
    return cam.reshape(-1, 2)


def _image_screen(screen: ScreenDefinition, frames_dir: pathlib.Path,
                  out_dir: pathlib.Path, rvec, tvec, rng) -> None:
    """Warp each pattern frame through the screen's true pose into the camera."""
    cam = _camera_corners(screen, rvec, tvec)
    H = cv2.getPerspectiveTransform(CORNERS_PX.astype(np.float32),
                                    cam.astype(np.float32))
    out_dir.mkdir(parents=True, exist_ok=True)
    for src in sorted(frames_dir.iterdir()):
        img = cv2.imread(str(src), cv2.IMREAD_GRAYSCALE)
        warped = cv2.warpPerspective(img, H, (CAMERA_W, CAMERA_H), flags=cv2.INTER_LINEAR)
        warped = cv2.GaussianBlur(warped, (5, 5), 1.0)
        noisy = np.clip(warped.astype(np.float64) + rng.normal(0, 2.0, warped.shape),
                        0, 255).astype(np.uint8)
        cv2.imwrite(str(out_dir / src.name), noisy)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workdir", default=None)
    args = ap.parse_args()
    work = pathlib.Path(args.workdir) if args.workdir else pathlib.Path(tempfile.mkdtemp(prefix="sl-e2e-"))
    work.mkdir(parents=True, exist_ok=True)
    print(f"[sl-e2e] workdir: {work}")

    # Ground-truth camera (same geometry as the vpcal SL CLI fixture).
    r_cw = np.array([[1, 0, 0], [0, 0, -1], [0, 1, 0]], dtype=float)
    tvec = (-r_cw @ GT_CAMERA).reshape(3, 1)
    rvec, _ = cv2.Rodrigues(r_cw)
    rng = np.random.default_rng(0)

    screens = {"A": _screen("A", [0, 0, 0], 0.0), "B": _screen("B", [1400, 900, 0], 50.0)}
    targets = []
    for label, screen in screens.items():
        sdir = work / label
        # Per-screen projected bounding box (live-preview stand-in) drives the
        # camera-aware layout planner: an oblique/distant screen gets bigger,
        # sparser dots so its camera-space blobs stay resolvable.
        cam_corners = _camera_corners(screen, rvec, tvec)
        bbox = cam_corners.max(axis=0) - cam_corners.min(axis=0)
        _meshvba("generate_structured_light", {
            "command": "generate_structured_light", "version": 1,
            "project": {"screen_id": label,
                        "cabinet_array": {"cols": 1, "rows": 1, "absent_cells": [],
                                          "cabinet_size_mm": [3400, 2200]}},
            "output_dir": str(sdir / "sl"),
            "screen_resolution": [CANVAS_W, CANVAS_H],
            "projected_screen_px": [float(bbox[0]), float(bbox[1])],
        })
        _image_screen(screen, sdir / "sl" / "frames", sdir / "camera", rvec, tvec, rng)
        _meshvba("decode_structured_light", {
            "command": "decode_structured_light", "version": 1,
            "input_path": str(sdir / "camera"),
            "sl_meta_path": str(sdir / "sl" / "sl_meta.json"),
            "output_path": str(sdir / "corr.json"),
        })
        corr = json.loads((sdir / "corr.json").read_text())
        print(f"[sl-e2e] {label}: decoded {len(corr['points'])} dots "
              f"(schema v{corr['schema_version']})")
        scr_path = work / f"{label}.screen.json"
        scr_path.write_text(screen.model_dump_json(indent=2))
        targets += ["--screen-target", str(scr_path), str(sdir / "sl" / "sl_meta.json"),
                    str(sdir / "corr.json")]

    out_path = work / "fixed_observation_result.json"
    proc = subprocess.run(
        [sys.executable, "-m", "vpcal.cli.main", "--output", "json",
         "tracker-free", "fixed-observation-sl", *targets,
         "--camera-id", "sl-e2e",
         "--out", str(out_path),
         "--static-overlay-out", str(work / "static_overlay.png")],
        capture_output=True, text=True,
        env=dict(os.environ, PYTHONPATH=str(VPCAL / "src")),
    )
    if proc.returncode != 0:
        raise SystemExit(f"vpcal solve failed (exit {proc.returncode}):\n{proc.stdout}\n{proc.stderr}")
    result = json.loads(proc.stdout)["data"]

    fx = result["session_lens"]["K"][0][0]
    pos = np.asarray(result["camera_from_stage"]["position_mm"], dtype=float)
    sl_gates = result["qualification"]["sl_gates"]
    checks = {
        "focal_rel_err<2%": abs(fx - K[0, 0]) / K[0, 0] < 0.02,
        "camera_pos_err<20mm": float(np.linalg.norm(pos - GT_CAMERA)) < 20.0,
        "qualification.passed": result["qualification"]["passed"] is True,
        "sl_gates.passed": sl_gates["passed"] is True,
        "static_overlay_written": (work / "static_overlay.png").exists(),
    }
    print(f"[sl-e2e] fx={fx:.1f} (gt {K[0,0]:.0f})  pos_err="
          f"{np.linalg.norm(pos - GT_CAMERA):.1f}mm  rms={result['rms_reprojection_px']:.3f}px")
    failed = [name for name, ok in checks.items() if not ok]
    if failed:
        print(f"[sl-e2e] FAILED: {failed}")
        print(json.dumps({"sl_gates": sl_gates}, indent=2))
        return 1
    print("[sl-e2e] PASS — full generate→image→decode→solve chain recovered ground truth")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
