import pytest
from pydantic import ValidationError
from lmt_vba_sidecar.ipc import CalibrateStructuredLightInput, ReconstructProject, CabinetArray


def _project():
    return ReconstructProject(screen_id="MAIN", cabinet_array=CabinetArray(cols=2, rows=1, cabinet_size_mm=[500.0, 500.0]), shape_prior="flat")


def test_valid_input_parses_with_default_max_rms():
    m = CalibrateStructuredLightInput.model_validate({
        "command": "calibrate_structured_light", "version": 1,
        "project": _project().model_dump(),
        "correspondence_paths": ["a.json"], "sl_meta_path": "m.json", "output_path": "o.json",
    })
    assert m.max_rms_px == 1.5
    assert len(m.correspondence_paths) == 1


def test_zero_correspondences_rejected():
    with pytest.raises(ValidationError):
        CalibrateStructuredLightInput.model_validate({
            "command": "calibrate_structured_light", "version": 1,
            "project": _project().model_dump(),
            "correspondence_paths": [], "sl_meta_path": "m.json", "output_path": "o.json",
        })


def test_max_rms_px_above_cap_rejected():
    """max_rms_px=50 exceeds le=5.0 upper cap → ValidationError at IPC boundary."""
    with pytest.raises(ValidationError):
        CalibrateStructuredLightInput.model_validate({
            "command": "calibrate_structured_light", "version": 1,
            "project": _project().model_dump(),
            "correspondence_paths": ["a.json"], "sl_meta_path": "m.json", "output_path": "o.json",
            "max_rms_px": 50,
        })


def test_max_rms_px_at_cap_accepted():
    """max_rms_px=5.0 is exactly at the le=5.0 upper cap → accepted."""
    m = CalibrateStructuredLightInput.model_validate({
        "command": "calibrate_structured_light", "version": 1,
        "project": _project().model_dump(),
        "correspondence_paths": ["a.json"], "sl_meta_path": "m.json", "output_path": "o.json",
        "max_rms_px": 5.0,
    })
    assert m.max_rms_px == 5.0


def test_crosscheck_path_defaults_none():
    m = CalibrateStructuredLightInput.model_validate({
        "command": "calibrate_structured_light", "version": 1,
        "project": _project().model_dump(),
        "correspondence_paths": ["a.json"], "sl_meta_path": "m.json", "output_path": "o.json",
    })
    assert m.crosscheck_intrinsics_path is None
