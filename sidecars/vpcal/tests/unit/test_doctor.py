"""Regression tests for fail-closed runtime diagnostics."""

from __future__ import annotations

import json

from click.testing import CliRunner

from vpcal.cli import doctor as doctor_module
from vpcal.cli.main import cli


def _invoke_with_missing(monkeypatch, missing: str):
    real_import = doctor_module._import_optional

    def fake_import(name: str):
        if name == missing:
            return None, f"No module named {missing!r}"
        return real_import(name)

    monkeypatch.setattr(doctor_module, "_import_optional", fake_import)
    return CliRunner().invoke(cli, ["doctor", "--output", "json"])


def test_doctor_reports_missing_opencv_as_structured_precondition(monkeypatch):
    result = _invoke_with_missing(monkeypatch, "cv2")

    assert result.exit_code == 6
    envelope = json.loads(result.output)
    assert envelope["status"] == "ok"
    assert envelope["data"]["ok"] is False
    check = envelope["data"]["checks"]["opencv"]
    assert check["available"] is False
    assert check["aruco"] is False
    assert "No module named" in check["error"]


def test_doctor_reports_missing_scipy_and_no_resolved_fallback(monkeypatch):
    result = _invoke_with_missing(monkeypatch, "scipy")

    assert result.exit_code == 6
    envelope = json.loads(result.output)
    assert envelope["status"] == "ok"
    assert envelope["data"]["ok"] is False
    assert envelope["data"]["checks"]["solver_scipy"]["available"] is False
    if not envelope["data"]["checks"]["solver_ceres"]["available"]:
        assert envelope["data"]["resolved_solver_backend"] is None
