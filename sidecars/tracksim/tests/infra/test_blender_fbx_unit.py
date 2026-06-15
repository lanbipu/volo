import json

import pytest

from tracksim.config import load_config
from tracksim.domain.errors import ConfigError, FbxConversionError
from tracksim.infra import blender_fbx


def test_find_blender_missing_raises(monkeypatch):
    monkeypatch.delenv("BLENDER", raising=False)
    monkeypatch.setattr(blender_fbx, "_candidate_paths", lambda cfg: [])
    with pytest.raises(ConfigError):
        blender_fbx.find_blender(load_config(None, {}))


def test_find_blender_from_config(tmp_path):
    fake = tmp_path / "blender"; fake.write_text("#!/bin/sh\n"); fake.chmod(0o755)
    cfg = load_config(None, {"fbx": {"blender_path": str(fake)}})
    assert blender_fbx.find_blender(cfg) == str(fake)


def test_convert_maps_subprocess_failure(monkeypatch, tmp_path):
    cfg = load_config(None, {"fbx": {"blender_path": "/bin/false"}})
    monkeypatch.setattr(blender_fbx, "find_blender", lambda c: "/bin/false")
    monkeypatch.setattr(blender_fbx, "blender_version", lambda p: "x")
    fbx = tmp_path / "a.fbx"; fbx.write_bytes(b"FBX")
    monkeypatch.setattr(blender_fbx, "_run_blender", lambda *a, **k: (1, "", "ERR_NO_CAMERA"))
    with pytest.raises(FbxConversionError):
        blender_fbx.convert_fbx(str(fbx), camera=None, config=cfg, use_cache=False)


def test_convert_success_writes_and_caches(monkeypatch, tmp_path):
    cfg = load_config(None, {"fbx": {"blender_path": "/bin/true", "cache_dir": str(tmp_path / "cache")}})
    monkeypatch.setattr(blender_fbx, "find_blender", lambda c: "/bin/true")
    monkeypatch.setattr(blender_fbx, "blender_version", lambda p: "5.1.2")
    fbx = tmp_path / "a.fbx"; fbx.write_bytes(b"FBXDATA")
    obj = {"schema": "tracksim.track/1", "rate": 60.0, "camera": "cam_1",
           "frames": [{"t": 0.0, "pose": {"pan": 0.0}}]}

    def fake_run(blender, script, inp, out, camera, timeout):
        with open(out, "w", encoding="utf-8") as fh:
            json.dump(obj, fh)
        return 0, "OK_FRAMES=1", ""
    monkeypatch.setattr(blender_fbx, "_run_blender", fake_run)
    out1 = blender_fbx.convert_fbx(str(fbx), camera=None, config=cfg, use_cache=True)
    assert json.loads(open(out1).read())["camera"] == "cam_1"

    def boom(*a, **k):
        raise AssertionError("should have hit cache")
    monkeypatch.setattr(blender_fbx, "_run_blender", boom)
    assert blender_fbx.convert_fbx(str(fbx), camera=None, config=cfg, use_cache=True) == out1


def test_default_camera_used_when_no_explicit(monkeypatch, tmp_path):
    # 回归(Codex P2)：未传 --camera 但配了 default_camera，应作为有效相机传给 Blender
    cfg = load_config(None, {"fbx": {"blender_path": "/bin/true", "cache_dir": str(tmp_path / "c"),
                                     "default_camera": "cam 2"}})
    monkeypatch.setattr(blender_fbx, "find_blender", lambda c: "/bin/true")
    monkeypatch.setattr(blender_fbx, "blender_version", lambda p: "v")
    fbx = tmp_path / "a.fbx"; fbx.write_bytes(b"X")
    seen = {}

    def fake_run(blender, script, inp, out, camera, timeout):
        seen["camera"] = camera
        with open(out, "w", encoding="utf-8") as fh:
            json.dump({"schema": "tracksim.track/1", "rate": 60.0, "camera": camera or "x",
                       "frames": [{"t": 0.0, "pose": {}}]}, fh)
        return 0, "", ""
    monkeypatch.setattr(blender_fbx, "_run_blender", fake_run)
    blender_fbx.convert_fbx(str(fbx), camera=None, config=cfg, use_cache=False)
    assert seen["camera"] == "cam 2"


def test_bad_timeout_raises_configerror(monkeypatch, tmp_path):
    # 回归(Codex P2)：非法 timeout_s 必须走 ConfigError，而非被丢给 subprocess
    cfg = load_config(None, {"fbx": {"blender_path": "/bin/true", "timeout_s": 0}})
    monkeypatch.setattr(blender_fbx, "find_blender", lambda c: "/bin/true")
    fbx = tmp_path / "a.fbx"; fbx.write_bytes(b"X")
    with pytest.raises(ConfigError):
        blender_fbx.convert_fbx(str(fbx), camera=None, config=cfg, use_cache=False)
