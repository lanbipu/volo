import json

import pytest

from tracksim.config import (
    Config,
    ProtocolsCfg,
    FreeDCfg,
    OpenTrackIOCfg,
    ControllerCfg,
    MotionCfg,
    OutputCfg,
    load_config,
)
from tracksim.domain.errors import ConfigError


def test_default_config_structure():
    cfg = Config()
    assert isinstance(cfg.protocols, ProtocolsCfg)
    assert isinstance(cfg.freed, FreeDCfg)
    assert isinstance(cfg.opentrackio, OpenTrackIOCfg)
    assert isinstance(cfg.controller, ControllerCfg)
    assert isinstance(cfg.motion, MotionCfg)
    assert isinstance(cfg.output, OutputCfg)


def test_freed_defaults():
    f = FreeDCfg()
    assert f.transport == "udp_unicast"
    assert f.target_ip == "127.0.0.1"
    assert f.port == 6000
    assert f.serial_device is None
    assert f.baud == 38400
    assert f.camera_id == 1
    assert f.rate_hz == 60.0
    assert f.scaling.variant == "native"
    assert f.scaling.angle_lsb_per_deg == 32768.0
    assert f.scaling.pos_lsb_per_m == 64000.0


def test_opentrackio_defaults():
    o = OpenTrackIOCfg()
    assert o.transport == "multicast"
    assert o.source_number == 1
    assert o.ip == "239.135.1.1"
    assert o.port == 55555
    assert o.encoding == "json"
    assert o.rate_hz == 60.0


def test_motion_defaults():
    m = MotionCfg()
    assert m.motion == "static"
    assert m.radius == 2.0
    assert m.speed == 30.0
    assert m.amplitude == 10.0
    assert m.freq == 0.5


def test_output_defaults():
    out = OutputCfg()
    assert out.format == "text"
    assert out.log_level == "info"


def test_load_config_none_returns_defaults():
    cfg = load_config(None)
    assert cfg == Config()


def test_load_config_json(tmp_path):
    p = tmp_path / "c.json"
    p.write_text(json.dumps({"freed": {"camera_id": 7, "port": 6001}}))
    cfg = load_config(str(p))
    assert cfg.freed.camera_id == 7
    assert cfg.freed.port == 6001
    # untouched fields keep defaults
    assert cfg.freed.transport == "udp_unicast"


def test_load_config_toml(tmp_path):
    p = tmp_path / "c.toml"
    p.write_text(
        "[opentrackio]\n"
        'transport = "unicast"\n'
        "source_number = 12\n"
    )
    cfg = load_config(str(p))
    assert cfg.opentrackio.transport == "unicast"
    assert cfg.opentrackio.source_number == 12


def test_load_config_yaml(tmp_path):
    p = tmp_path / "c.yaml"
    p.write_text("motion:\n  motion: orbit\n  radius: 5.0\n")
    cfg = load_config(str(p))
    assert cfg.motion.motion == "orbit"
    assert cfg.motion.radius == 5.0


def test_override_precedence_beats_file(tmp_path):
    p = tmp_path / "c.json"
    p.write_text(json.dumps({"freed": {"camera_id": 7}}))
    cfg = load_config(str(p), overrides={"freed": {"camera_id": 99}})
    assert cfg.freed.camera_id == 99


def test_controller_mapping_entry(tmp_path):
    p = tmp_path / "c.json"
    p.write_text(
        json.dumps(
            {
                "controller": {
                    "device": "0",
                    "mapping": [
                        {
                            "channel": "x",
                            "source": "leftx",
                            "mode": "rate",
                            "scale": 1.5,
                            "deadzone": 0.1,
                            "invert": True,
                            "clamp_min": -5.0,
                            "clamp_max": 5.0,
                        }
                    ],
                }
            }
        )
    )
    cfg = load_config(str(p))
    entry = cfg.controller.mapping[0]
    assert entry.channel == "x"
    assert entry.source == "leftx"
    assert entry.mode == "rate"
    assert entry.scale == 1.5
    assert entry.deadzone == 0.1
    assert entry.invert is True
    assert entry.clamp_min == -5.0
    assert entry.clamp_max == 5.0


def test_load_config_missing_file_raises():
    with pytest.raises(ConfigError):
        load_config("/nonexistent/path/to/config.toml")


def test_load_config_unsupported_extension(tmp_path):
    p = tmp_path / "c.ini"
    p.write_text("nope")
    with pytest.raises(ConfigError):
        load_config(str(p))


def test_load_config_malformed_json_raises(tmp_path):
    p = tmp_path / "c.json"
    p.write_text("{ not valid json ")
    with pytest.raises(ConfigError):
        load_config(str(p))


def test_load_config_invalid_value_raises(tmp_path):
    p = tmp_path / "c.json"
    p.write_text(json.dumps({"freed": {"port": "not-an-int"}}))
    with pytest.raises(ConfigError):
        load_config(str(p))
