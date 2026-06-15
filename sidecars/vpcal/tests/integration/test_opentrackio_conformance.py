"""OpenTrackIO export conformance against the official JSON schema (A1.3).

Validates every exported sample against the workspace copy of the official
schema (``../docs/OpenTrackIO_JSON_schema.json``).  This locks in A1.1 (spec
frame), A1.2 (distortion model label) and A1.3 (schema-conformant protocol
version, sampleId, lens keys, tracker.notes handling).
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

jsonschema = pytest.importorskip("jsonschema")

from vpcal.core.simulator import (  # noqa: E402
    default_lens,
    forward_observations,
    generate_camera_poses,
    random_ground_truth,
)
from vpcal.core.projection import CameraIntrinsics  # noqa: E402
from vpcal.io.export.opentrackio import export_opentrackio  # noqa: E402
from vpcal.models.screen import PlaneSection, ScreenDefinition  # noqa: E402

_SCHEMA_PATH = Path(__file__).resolve().parents[3] / "docs" / "OpenTrackIO_JSON_schema.json"

pytestmark = pytest.mark.skipif(
    not _SCHEMA_PATH.exists(),
    reason="workspace OpenTrackIO_JSON_schema.json not available",
)


@pytest.fixture(scope="module")
def validator():
    schema = json.loads(_SCHEMA_PATH.read_text())
    return jsonschema.Draft202012Validator(schema)


def _validate_file(path: Path, validator) -> None:
    lines = [ln for ln in path.read_text().splitlines() if ln.strip()]
    assert lines, "export produced no samples"
    for i, ln in enumerate(lines):
        sample = json.loads(ln)
        errors = sorted(validator.iter_errors(sample), key=lambda e: list(e.path))
        msgs = [f"sample {i} at {list(e.path)}: {e.message}" for e in errors]
        assert not errors, "\n".join(msgs)


def test_export_conforms_multi_pose(tmp_path, validator):
    """A realistic multi-pose export passes official schema validation."""
    screen = ScreenDefinition(
        name="w", unit="mm", cabinet_size=(500, 500), led_pixel_pitch_mm=2.8,
        markers_per_cabinet=4,
        sections=[PlaneSection(name="w", width_mm=4000, height_mm=3000, origin=[0, 0, 0])],
    )
    rng = np.random.default_rng(11)
    gt = random_ground_truth(rng)
    poses = generate_camera_poses(screen, 5, rng)
    intr = CameraIntrinsics(fx=3733.33, fy=3733.33, cx=1920.0, cy=1080.0)
    _obs, tracker_poses, _vis = forward_observations(
        screen, intr, gt, poses, markers_per_cabinet=4, rng=rng
    )
    tp = [(fid, fid / 30.0, q, t) for fid, (q, t) in enumerate(tracker_poses)]
    t2s = (np.array(gt.tracker_to_stage_q), np.array(gt.tracker_to_stage_t))
    c2t = (np.array(gt.camera_from_tracker_q), np.array(gt.camera_from_tracker_t))
    out = tmp_path / "otio.jsonl"
    export_opentrackio(tp, t2s, c2t, default_lens(), out)
    _validate_file(out, validator)


@pytest.mark.parametrize("session_estimate", [False, True])
def test_export_conforms_session_estimate_variants(tmp_path, validator, session_estimate):
    """Both lens-source variants (nominal / QLE session estimate) conform."""
    ident = (np.array([1.0, 0, 0, 0]), np.zeros(3))
    tp = [(0, 1.5, np.array([1.0, 0, 0, 0]), np.array([100.0, -50.0, 30.0]))]
    out = tmp_path / f"otio_{session_estimate}.jsonl"
    export_opentrackio(tp, ident, ident, default_lens(), out, session_estimate=session_estimate)
    _validate_file(out, validator)


def test_export_ue_frame_also_schema_valid(tmp_path, validator):
    """The opt-in UE frame is non-spec geometrically but structurally valid."""
    ident = (np.array([1.0, 0, 0, 0]), np.zeros(3))
    tp = [(3, 0.1, np.array([1.0, 0, 0, 0]), np.array([1.0, 2.0, 3.0]))]
    out = tmp_path / "otio_ue.jsonl"
    export_opentrackio(tp, ident, ident, default_lens(), out, frame="ue")
    _validate_file(out, validator)
