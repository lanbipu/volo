"""Main-path real-data regression (remediation B2) — skipped until data exists.

Unlike ``test_tracker_free_walkthrough`` (the tracker-FREE bypass: per-frame PnP
+ averaging, no Ceres / scipy / observability), this exercises the **main**
calibration path — ``run_quick`` over a real tracking stream — which today has
ZERO real-data coverage (B2).

B2 cannot be completed in CI / dev machines without a real tracking source
(OptiTrack rigid body, Vicon, or an ARKit phone standing in as the tracker) and
a fresh capture that includes **held-out, different-position validation
frames**.  This file is the regression scaffold the roadmap calls for: drop a
captured session at ``_main_path/`` (gitignored) and these tests run; absent it,
they skip.  See ``docs/b2-real-data-capture.md`` for the capture procedure and
the required directory layout.

When real data is added, this also becomes the A3/A4 before-after evidence:
``MAINPATH/expected.json`` may record the validation RMS so the test asserts the
fix held on real data, not just synthetic.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

# Dev-only, gitignored.  Layout (see docs/b2-real-data-capture.md):
#   _main_path/session.json          (images + tracking + screen + lens + validation)
#   _main_path/<as referenced by session.json>
#   _main_path/expected.json         (optional regression anchor)
MAINPATH = Path(__file__).resolve().parents[2] / "_main_path"

pytestmark = [
    pytest.mark.walkthrough,
    pytest.mark.skipif(
        not (MAINPATH / "session.json").exists(),
        reason="B2 real-data not available (gitignored; needs a real tracking source + "
               "held-out validation frames — see docs/b2-real-data-capture.md)",
    ),
]


def _run():
    from vpcal.core.pipeline import run_quick
    from vpcal.models.session import SessionConfig

    raw = json.loads((MAINPATH / "session.json").read_text())
    session = SessionConfig.model_validate(raw)
    out = MAINPATH / "output"
    return run_quick(session, MAINPATH, out, raw_session=raw, prefer_cpp=True)


def test_main_path_solves_with_independent_validation():
    """The main path produces a T_S_from_O with an INDEPENDENT validation RMS."""
    result = _run()
    assert result["exit_code"] in (0, 9)
    q = result["result"]["quality"]
    # B2's whole point: a held-out validation number must exist on real data.
    assert q.get("validation_rms_px") is not None, \
        "session.json must declare a `validation` hold-out (A4) for B2 evidence"
    diag = result["result"]["solver_diagnostics"]
    assert diag["solver_backend"] in ("ceres", "scipy")


def test_main_path_validation_close_to_training():
    """Healthy calibration: validation RMS not wildly above training RMS."""
    result = _run()
    q = result["result"]["quality"]
    train = q["reprojection_rms_px"]
    val = q.get("validation_rms_px")
    if val is None or train == 0:
        pytest.skip("no holdout / degenerate training RMS")
    # A blown-up ratio means bad tracking or a wrong solve — surface it loudly.
    assert val < max(5.0 * train, train + 2.0), \
        f"validation RMS {val:.3f} px ≫ training {train:.3f} px — suspect tracking/solve"


def test_main_path_matches_expected_anchor():
    """If an expected.json anchor is present, T_S_from_O must match it."""
    anchor = MAINPATH / "expected.json"
    if not anchor.exists():
        pytest.skip("no expected.json regression anchor recorded yet")
    expected = json.loads(anchor.read_text())["tracker_to_stage"]
    result = _run()
    est = result["result"]["tracker_to_stage"]
    np.testing.assert_allclose(est["translation"], expected["translation"], atol=2.0)
    qg, qe = np.array(expected["rotation"]), np.array(est["rotation"])
    assert min(np.linalg.norm(qg - qe), np.linalg.norm(qg + qe)) < 1e-2
