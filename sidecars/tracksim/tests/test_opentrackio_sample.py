import json
import re
from pathlib import Path

import jsonschema

from tracksim.domain.pose import CameraPose
from tracksim.emitters.opentrackio import build_sample

SCHEMA_PATH = Path(__file__).parent / "resources" / "OpenTrackIO_JSON_schema.json"
URN_RE = re.compile(
    r"^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)


def _schema():
    return json.loads(SCHEMA_PATH.read_text())


def test_build_sample_validates_against_schema():
    sample = build_sample(
        CameraPose(pan=10.0, tilt=-5.0, roll=0.0, x=1.0, y=2.0, z=1.5,
                   focal_length=24.305, focus_distance=10.0, timestamp=1.5),
        source_number=1,
        sequence=0,
        static_meta={},
    )
    jsonschema.validate(instance=sample, schema=_schema())


def test_build_sample_transform_and_lens_values():
    sample = build_sample(
        CameraPose(pan=10.0, tilt=-5.0, roll=2.5, x=1.0, y=-2.0, z=1.5,
                   focal_length=35.0, focus_distance=3.0),
        source_number=7,
        sequence=4,
        static_meta={},
    )
    tr = sample["transforms"][0]
    assert tr["id"] == "Camera"
    assert tr["translation"] == {"x": 1.0, "y": -2.0, "z": 1.5}
    assert tr["rotation"] == {"pan": 10.0, "tilt": -5.0, "roll": 2.5}
    assert sample["lens"]["pinholeFocalLength"] == 35.0
    assert sample["lens"]["focusDistance"] == 3.0
    assert sample["sourceNumber"] == 7
    assert sample["protocol"] == {"name": "OpenTrackIO", "version": [1, 0, 1]}
    assert URN_RE.match(sample["sampleId"])
    assert URN_RE.match(sample["sourceId"])


def test_build_sample_timestamp_split():
    sample = build_sample(
        CameraPose(timestamp=2.25),
        source_number=1,
        sequence=0,
        static_meta={},
    )
    ts = sample["timing"]["sampleTimestamp"]
    assert ts["seconds"] == 2
    assert ts["nanoseconds"] == 250000000


def test_build_sample_static_meta_merged():
    static = {"static": {"tracker": {"serialNumber": "ABC123"}}}
    sample = build_sample(
        CameraPose(),
        source_number=1,
        sequence=0,
        static_meta=static,
    )
    assert sample["static"]["tracker"]["serialNumber"] == "ABC123"
    jsonschema.validate(instance=sample, schema=_schema())


def test_build_sample_sequence_changes_sample_id():
    a = build_sample(CameraPose(), source_number=1, sequence=0, static_meta={})
    b = build_sample(CameraPose(), source_number=1, sequence=1, static_meta={})
    assert a["sampleId"] != b["sampleId"]
    assert a["sourceId"] == b["sourceId"]
