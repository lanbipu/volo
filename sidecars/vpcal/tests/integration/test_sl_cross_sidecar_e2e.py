"""Cross-sidecar synthetic E2E (scripts/sl_e2e_synth.py) as a pytest gate.

Drives the REAL binaries end to end: mesh-vba generate → synthetic camera
imaging → mesh-vba decode → vpcal fixed-observation-sl, asserting ground-truth
recovery AND a passing SL formal-gate set. Skipped where the mesh-vba venv is
absent (the script needs both sidecars' interpreters).
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[4]
SCRIPT = REPO / "scripts" / "sl_e2e_synth.py"
MESHVBA_PY = REPO / "sidecars" / "mesh-vba" / ".venv" / "bin" / "python"


@pytest.mark.skipif(not MESHVBA_PY.exists(), reason="mesh-vba venv not present")
def test_sl_cross_sidecar_synthetic_e2e(tmp_path):
    proc = subprocess.run(
        [sys.executable, str(SCRIPT), "--workdir", str(tmp_path / "e2e")],
        capture_output=True, text=True, timeout=600,
    )
    assert proc.returncode == 0, f"exit {proc.returncode}:\n{proc.stdout}\n{proc.stderr}"
    assert "PASS" in proc.stdout
