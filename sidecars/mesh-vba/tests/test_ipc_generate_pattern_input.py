from lmt_vba_sidecar.ipc import GeneratePatternInput


def test_generate_pattern_input_optional_screen_mapping():
    base = {
        "command": "generate_pattern", "version": 1,
        "project": {"screen_id": "BENCH",
                    "cabinet_array": {"cols": 1, "rows": 2, "cabinet_size_mm": [300.0, 300.0]}},
        "output_dir": "/tmp/out", "screen_resolution": [1080, 2160],
    }
    assert GeneratePatternInput.model_validate(base).screen_mapping_path is None
    with_sm = {**base, "screen_mapping_path": "/tmp/screen_mapping.json"}
    assert GeneratePatternInput.model_validate(with_sm).screen_mapping_path == "/tmp/screen_mapping.json"
