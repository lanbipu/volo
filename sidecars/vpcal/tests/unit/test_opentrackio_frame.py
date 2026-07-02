"""OpenTrackIO spec-frame export: axis conventions (remediation A1.1).

The spec frame is right-hand, Z-up, Y = camera-forward, X = camera-right.
Internal is X-forward / Y-left / Z-up.
"""

from __future__ import annotations

import json

import numpy as np

from vpcal.core.coordinates import (
    m_rh_from_source,
    to_opentrackio_transform,
)
from vpcal.core.simulator import default_lens
from vpcal.io.export.opentrackio import export_opentrackio

IDENT = (np.array([1.0, 0, 0, 0]), np.zeros(3))


def test_spec_frame_y_is_camera_forward(tmp_path):
    """Identity camera attitude (internal +X forward) → pan=tilt=roll=0 (+Y fwd)."""
    out = tmp_path / "otio.jsonl"
    # Camera at internal (2000, 300, 1500) mm, identity attitude.
    tp = [(0, 0.0, np.array([1.0, 0, 0, 0]), np.array([2000.0, 300.0, 1500.0]))]
    export_opentrackio(tp, IDENT, IDENT, default_lens(), out)
    s = json.loads(out.read_text().splitlines()[0])
    tr = s["transforms"][0]
    # Zero euler ⇔ camera forward is +Y in the OpenTrackIO frame.
    assert abs(tr["rotation"]["pan"]) < 1e-9
    assert abs(tr["rotation"]["tilt"]) < 1e-9
    assert abs(tr["rotation"]["roll"]) < 1e-9
    # Position permutes (x,y,z)_internal → (-y, x, z)_otio, mm → m.
    assert abs(tr["translation"]["x"] - (-0.3)) < 1e-12
    assert abs(tr["translation"]["y"] - 2.0) < 1e-12
    assert abs(tr["translation"]["z"] - 1.5) < 1e-12


def test_to_opentrackio_transform_roundtrip():
    """to_opentrackio_transform inverts via the m_rh_from_source('opentrackio') map."""
    rng = np.random.default_rng(3)
    # Random proper rotation + translation.
    A = rng.normal(size=(3, 3))
    Q, _ = np.linalg.qr(A)
    if np.linalg.det(Q) < 0:
        Q[:, 0] *= -1
    T_rh = np.eye(4)
    T_rh[:3, :3] = Q
    T_rh[:3, 3] = rng.normal(size=3) * 1000
    T_otio = to_opentrackio_transform(T_rh)
    M = m_rh_from_source("opentrackio")
    back = M @ T_otio @ np.linalg.inv(M)
    assert np.allclose(back, T_rh, atol=1e-12)


def test_m_rh_from_opentrackio_axes():
    """Built-in 'opentrackio' source maps spec axes onto internal axes."""
    M3 = m_rh_from_source("opentrackio")[:3, :3]
    assert np.allclose(M3 @ [0, 1, 0], [1, 0, 0])   # spec Y (fwd) → internal X (fwd)
    assert np.allclose(M3 @ [1, 0, 0], [0, -1, 0])  # spec X (right) → internal -Y
    assert np.allclose(M3 @ [0, 0, 1], [0, 0, 1])   # Z-up preserved
    assert np.isclose(np.linalg.det(M3), 1.0)       # proper rotation (no flip)


def test_sample_timestamp_is_unsigned_with_correct_carry(tmp_path):
    """seconds/nanoseconds must both be unsigned and in range (spec-conformant).

    ts=1.9999999996 rounds to 2.0 s exactly — a naive frac*1e9 would emit
    nanoseconds=1000000000 (out of range) next to seconds=1.
    """
    out = tmp_path / "otio.jsonl"
    q, t = np.array([1.0, 0, 0, 0]), np.zeros(3)
    tp = [(0, 1.9999999996, q, t), (1, 0.25, q, t)]
    export_opentrackio(tp, IDENT, IDENT, default_lens(), out)
    samples = [json.loads(line) for line in out.read_text().splitlines()]
    st0 = samples[0]["timing"]["sampleTimestamp"]
    assert (st0["seconds"], st0["nanoseconds"]) == (2, 0)
    st1 = samples[1]["timing"]["sampleTimestamp"]
    assert (st1["seconds"], st1["nanoseconds"]) == (0, 250_000_000)
    for st in (st0, st1):
        assert st["seconds"] >= 0 and 0 <= st["nanoseconds"] <= 999_999_999


def test_negative_shifted_timestamp_is_rejected(tmp_path):
    """A delay shift pushing a 0-based clock negative must not silently emit
    a non-conformant unsigned-field underflow."""
    import pytest

    from vpcal.core.errors import PreconditionError

    out = tmp_path / "otio.jsonl"
    tp = [(0, 0.0, np.array([1.0, 0, 0, 0]), np.zeros(3))]
    with pytest.raises(PreconditionError, match="unsigned"):
        export_opentrackio(tp, IDENT, IDENT, default_lens(), out, applied_delay_ms=-40.0)


def test_ue_frame_optin_flagged(tmp_path):
    """--frame ue keeps the legacy UE path but flags it as non-spec in notes."""
    out = tmp_path / "otio_ue.jsonl"
    tp = [(0, 0.0, np.array([1.0, 0, 0, 0]), np.array([2000.0, 300.0, 1500.0]))]
    export_opentrackio(tp, IDENT, IDENT, default_lens(), out, frame="ue")
    s = json.loads(out.read_text().splitlines()[0])
    assert "NON-SPEC" in s["tracker"]["notes"]
    tr = s["transforms"][0]
    # UE frame: Y flips relative to internal, no axis permutation.
    assert abs(tr["translation"]["x"] - 2.0) < 1e-12
    assert abs(tr["translation"]["y"] - (-0.3)) < 1e-12
    assert abs(tr["translation"]["z"] - 1.5) < 1e-12
