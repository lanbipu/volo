import json

from lmt_vba_sidecar.ipc import PlanCaptureInput
from lmt_vba_sidecar.capture_planner.cmd import run_plan_capture


def _flat_input():
    return PlanCaptureInput.model_validate({
        "command": "plan_capture",
        "version": 1,
        "project": {
            "screen_id": "V000",
            "cabinet_array": {"cols": 2, "rows": 2, "cabinet_size_mm": [500.0, 500.0],
                              "absent_cells": []},
            "shape_prior": "flat",
        },
        "intrinsics": {"image_size": [1920, 1080], "hfov_deg": 60.0},
        "shell": {"standoff_min_mm": 2000.0, "standoff_max_mm": 4000.0,
                  "height_min_mm": 400.0, "height_max_mm": 2200.0},
        "target_p95_residual_mm": 4.0,
        "trials": 6, "n_fan": 5,
    })


def test_run_plan_capture_emits_result_event(capsys):
    rc = run_plan_capture(_flat_input())
    assert rc == 0
    line = capsys.readouterr().out.strip().splitlines()[-1]
    ev = json.loads(line)
    assert ev["event"] == "result"
    data = ev["data"]
    assert len(data["stations"]) >= 5                  # >= seed (fan+top+bottom)
    assert len(data["coverage"]) == 4                  # 2x2 cabinets
    assert data["all_pass"] is True
    assert data["unreachable_regions"] == []
    cov = data["coverage"][0]
    assert set(cov) >= {"col", "row", "p95_residual_mm", "reconstructable", "pass"}
    assert cov["pass"] is True
    st = data["stations"][0]
    assert set(st) >= {"id", "position_mm", "look_at_mm", "standoff_mm", "height_mm",
                       "role", "covers_cabinets"}
    # p95 must be a real number here (all reconstructable), JSON has no NaN
    assert isinstance(cov["p95_residual_mm"], (int, float))


def test_run_plan_capture_zero_budget_is_all_unreachable_not_crash(capsys):
    # Regression: max_stations=0 -> optimize() empty-cams fallback report. cmd.py reads
    # fail_reason from every cabinet, so the fallback dict MUST carry it (was a KeyError crash).
    inp = _flat_input().model_copy(update={"max_stations": 0})
    rc = run_plan_capture(inp)
    assert rc == 0
    ev = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert ev["event"] == "result"
    cov = ev["data"]["coverage"]
    assert len(cov) == 4
    assert all((not c["pass"]) and c["fail_reason"] == "low_coverage" for c in cov)


def test_run_plan_capture_curved_radius_too_small_is_invalid_input(capsys):
    inp = _flat_input()
    inp = inp.model_copy(update={
        "project": inp.project.model_copy(update={
            "shape_prior": {"curved": {"radius_mm": 1.0}}})})  # << min ratio
    rc = run_plan_capture(inp)
    assert rc == 1
    line = capsys.readouterr().out.strip().splitlines()[-1]
    ev = json.loads(line)
    assert ev["event"] == "error"
    assert ev["code"] == "invalid_input"


import subprocess
import sys


def _flat_payload():
    return {
        "command": "plan_capture", "version": 1,
        "project": {"screen_id": "V000",
                    "cabinet_array": {"cols": 2, "rows": 2,
                                      "cabinet_size_mm": [500.0, 500.0], "absent_cells": []},
                    "shape_prior": "flat"},
        "intrinsics": {"image_size": [1920, 1080], "hfov_deg": 60.0},
        "shell": {"standoff_min_mm": 2000.0, "standoff_max_mm": 4000.0,
                  "height_min_mm": 400.0, "height_max_mm": 2200.0},
        "target_p95_residual_mm": 4.0, "trials": 6, "n_fan": 5,
    }


def test_subprocess_plan_capture_happy():
    proc = subprocess.run(
        [sys.executable, "-m", "lmt_vba_sidecar", "plan_capture"],
        input=json.dumps(_flat_payload()), capture_output=True, text=True,
    )
    assert proc.returncode == 0, proc.stderr
    ev = json.loads(proc.stdout.strip().splitlines()[-1])
    assert ev["event"] == "result"
    assert ev["data"]["all_pass"] is True
    # output must be valid JSON end-to-end (no bare NaN tokens)
    assert "NaN" not in proc.stdout


def test_subprocess_plan_capture_invalid_input_envelope():
    payload = _flat_payload()
    payload["project"]["shape_prior"] = {"curved": {"radius_mm": 1.0}}
    proc = subprocess.run(
        [sys.executable, "-m", "lmt_vba_sidecar", "plan_capture"],
        input=json.dumps(payload), capture_output=True, text=True,
    )
    assert proc.returncode == 1
    ev = json.loads(proc.stdout.strip().splitlines()[-1])
    assert ev["event"] == "error"
    assert ev["code"] == "invalid_input"
