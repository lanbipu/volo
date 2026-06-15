"""End-to-end CLI dispatch tests via subprocess."""
from __future__ import annotations

import json
import subprocess
import sys


def _run_cli(args: list[str], stdin_payload: str) -> tuple[int, str, str]:
    proc = subprocess.run(
        [sys.executable, "-m", "lmt_vba_sidecar", *args],
        input=stdin_payload,
        capture_output=True,
        text=True,
        timeout=30,
    )
    return proc.returncode, proc.stdout, proc.stderr


def test_invalid_json_emits_error_event_and_exits_nonzero() -> None:
    code, out, _ = _run_cli(["reconstruct"], "not-json")
    assert code != 0
    last = json.loads(out.strip().splitlines()[-1])
    assert last["event"] == "error"
    assert last["code"] == "invalid_input"


def test_unknown_command_argparse_fails() -> None:
    code, _, err = _run_cli(["bogus"], "")
    assert code != 0
    assert "invalid choice" in err


def test_validation_error_emits_invalid_input() -> None:
    payload = json.dumps({
        "command": "reconstruct",
        "version": 1,
        "project": {},  # empty -> fails schema
        "images": [],
        "intrinsics": {},
        "pattern_meta": {},
    })
    code, out, _ = _run_cli(["reconstruct"], payload)
    assert code != 0
    last = json.loads(out.strip().splitlines()[-1])
    assert last["event"] == "error"
    assert last["code"] == "invalid_input"


def test_missing_subcommand_module_returns_not_implemented(tmp_path, monkeypatch) -> None:
    """When the subcommand module itself is absent, error message says
    'not yet implemented' (not generic internal_error)."""
    import importlib
    import io

    real_import_module = importlib.import_module
    target = "lmt_vba_sidecar.calibrate"

    def fake_import(name, *args, **kwargs):
        if name == target:
            raise ModuleNotFoundError(name=target)
        return real_import_module(name, *args, **kwargs)

    monkeypatch.setattr(importlib, "import_module", fake_import)

    from lmt_vba_sidecar import __main__ as m

    fake_stdin = io.StringIO(json.dumps({
        "command": "calibrate",
        "version": 1,
        "checkerboard_images": ["a.png"] * 5,
        "inner_corners": [8, 6],
        "square_size_mm": 20.0,
        "output_path": str(tmp_path / "ix.json"),
    }))
    monkeypatch.setattr(sys, "stdin", fake_stdin)
    captured = io.StringIO()
    monkeypatch.setattr(sys, "stdout", captured)
    rc = m.main(["calibrate"])
    assert rc == 1
    last = json.loads(captured.getvalue().strip().splitlines()[-1])
    assert last["event"] == "error"
    assert "not yet implemented" in last["message"]


def test_simulate_subcommand_writes_dataset(tmp_path) -> None:
    payload = {
        "command": "simulate",
        "version": 1,
        "scene": {
            "cabinet_array": {"cols": 2, "rows": 1, "cabinet_size_mm": [600, 340]},
            "shape_prior": "flat",
            "inter_board_angle_deg": 0.0,
        },
        "cameras": {
            "n_views": 8,
            "distance_mm_range": [1500, 2500],
            "yaw_deg_range": [-30, 30],
            "pitch_deg_range": [-15, 15],
        },
        "intrinsics": {
            "K": [[2000, 0, 960], [0, 2000, 540], [0, 0, 1]],
            "dist_coeffs": [0, 0, 0, 0, 0],
            "image_size": [1920, 1080],
        },
        "noise": {"pixel_sigma": 0.3},
        "seed": 1,
        "out_dir": str(tmp_path / "ds"),
    }
    p = subprocess.run(
        [sys.executable, "-m", "lmt_vba_sidecar", "simulate"],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert p.returncode == 0
    assert (tmp_path / "ds" / "scene.npz").exists()
    last = json.loads(p.stdout.strip().splitlines()[-1])
    assert last["event"] == "result"


def test_eval_subcommand_after_simulate(tmp_path) -> None:
    ds = str(tmp_path / "ds")
    sim_payload = {
        "command": "simulate",
        "version": 1,
        "scene": {
            "cabinet_array": {"cols": 2, "rows": 1, "cabinet_size_mm": [600, 340]},
            "shape_prior": "flat",
            "inter_board_angle_deg": 10.0,
        },
        "cameras": {
            "n_views": 20,
            "distance_mm_range": [1500, 3000],
            "yaw_deg_range": [-40, 40],
            "pitch_deg_range": [-20, 20],
        },
        "intrinsics": {
            "K": [[2000, 0, 960], [0, 2000, 540], [0, 0, 1]],
            "dist_coeffs": [0, 0, 0, 0, 0],
            "image_size": [1920, 1080],
        },
        "noise": {"pixel_sigma": 0.3, "visibility_frac": 0.8},
        "seed": 2,
        "out_dir": ds,
    }
    subprocess.run(
        [sys.executable, "-m", "lmt_vba_sidecar", "simulate"],
        input=json.dumps(sim_payload),
        capture_output=True,
        text=True,
        check=True,
        timeout=60,
    )
    eval_payload = {
        "command": "eval",
        "version": 1,
        "dataset_dir": ds,
        "method": "charuco",
        "seed_matrix": [2],
    }
    p = subprocess.run(
        [sys.executable, "-m", "lmt_vba_sidecar", "eval"],
        input=json.dumps(eval_payload),
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert p.returncode == 0
    last = json.loads(p.stdout.strip().splitlines()[-1])
    assert last["event"] == "result"
    assert last["data"]["max_distance_error_mm"] < 3.0
    assert last["data"]["method"] == "charuco"


def test_compare_known_subcommand(tmp_path) -> None:
    report = {
        "schema_version": "visual_pose_report.v1",
        "frame": {},
        "cabinet_poses": [
            {
                "cabinet_id": "V000_R000",
                "position_mm": [0, 0, 0],
                "normal": [0, 0, 1],
                "rotation_matrix": [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                "corners_mm": [[-300, -170, 0], [300, -170, 0], [300, 170, 0], [-300, 170, 0]],
                "reprojection_rms_px": 0.4,
                "observed_views": 7,
                "observed_points": 120,
                "quality": "ok",
            },
            {
                "cabinet_id": "V001_R000",
                "position_mm": [702, 0, 0],
                "normal": [0.0, 0.0, 1.0],
                "rotation_matrix": [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                "corners_mm": [[-300, -170, 0], [300, -170, 0], [300, 170, 0], [-300, 170, 0]],
                "reprojection_rms_px": 0.4,
                "observed_views": 7,
                "observed_points": 120,
                "quality": "ok",
            },
        ],
    }
    known = {
        "cabinets": {"V000_R000": {"size_mm": [600, 340]}, "V001_R000": {"size_mm": [600, 340]}},
        "pairs": [{"a": "V000_R000", "b": "V001_R000", "distance_mm": 700.0, "angle_deg": 0.0}],
    }
    report_path = tmp_path / "report.json"
    known_path = tmp_path / "known.json"
    report_path.write_text(json.dumps(report))
    known_path.write_text(json.dumps(known))

    payload = {
        "command": "compare_known",
        "version": 1,
        "report_path": str(report_path),
        "known_path": str(known_path),
    }
    code, out, _ = _run_cli(["compare_known"], json.dumps(payload))
    assert code == 0
    last = json.loads(out.strip().splitlines()[-1])
    assert last["event"] == "result"
    assert abs(last["data"]["pairs"][0]["distance_error_mm"] - 2.0) < 1e-6
    assert last["data"]["passed"] is True


def test_compare_known_missing_file_emits_invalid_input(tmp_path) -> None:
    payload = {
        "command": "compare_known",
        "version": 1,
        "report_path": str(tmp_path / "nope.json"),
        "known_path": str(tmp_path / "also-nope.json"),
    }
    code, out, _ = _run_cli(["compare_known"], json.dumps(payload))
    assert code != 0
    last = json.loads(out.strip().splitlines()[-1])
    assert last["event"] == "error"
    assert last["code"] == "invalid_input"


def test_transitive_import_failure_does_not_say_not_implemented(tmp_path, monkeypatch) -> None:
    """A dependency import failure (different module name than the subcommand
    module) must propagate as internal_error with traceback, NOT as
    'not yet implemented'."""
    import importlib
    import io

    real_import_module = importlib.import_module
    subcommand_module = "lmt_vba_sidecar.calibrate"

    def fake_import(name, *args, **kwargs):
        if name == subcommand_module:
            # The subcommand module IS importable, but during its import
            # a different dep is missing.
            raise ModuleNotFoundError(name="some_required_dep")
        return real_import_module(name, *args, **kwargs)

    monkeypatch.setattr(importlib, "import_module", fake_import)

    from lmt_vba_sidecar import __main__ as m
    fake_stdin = io.StringIO(json.dumps({
        "command": "calibrate",
        "version": 1,
        "checkerboard_images": ["a.png"] * 5,
        "inner_corners": [8, 6],
        "square_size_mm": 20.0,
        "output_path": str(tmp_path / "ix.json"),
    }))
    monkeypatch.setattr(sys, "stdin", fake_stdin)
    captured = io.StringIO()
    monkeypatch.setattr(sys, "stdout", captured)
    rc = m.main(["calibrate"])
    assert rc == 1
    last = json.loads(captured.getvalue().strip().splitlines()[-1])
    assert last["event"] == "error"
    assert "not yet implemented" not in last["message"]
    assert "some_required_dep" in last["message"]


def test_dispatch_knows_structured_light_subcommands():
    import subprocess, sys, json
    p = subprocess.run([sys.executable, "-m", "lmt_vba_sidecar", "decode_structured_light"],
                       input="{}", capture_output=True, text=True)
    assert p.returncode == 1
    ev = json.loads(p.stdout.strip().splitlines()[-1])
    assert ev["event"] == "error" and ev["code"] == "invalid_input"


def test_dispatch_knows_reconstruct_structured_light():
    import subprocess, sys, json
    p = subprocess.run([sys.executable, "-m", "lmt_vba_sidecar", "reconstruct_structured_light"],
                       input="{}", capture_output=True, text=True)
    assert p.returncode == 1
    ev = json.loads(p.stdout.strip().splitlines()[-1])
    assert ev["event"] == "error" and ev["code"] == "invalid_input"
