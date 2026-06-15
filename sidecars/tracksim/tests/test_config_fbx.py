from tracksim.config import load_config, Config, FbxCfg


def test_fbx_defaults():
    cfg = Config()
    assert isinstance(cfg.fbx, FbxCfg)
    assert cfg.fbx.timeout_s == 120.0
    assert cfg.fbx.blender_path == "" and cfg.fbx.default_camera == "" and cfg.fbx.cache_dir == ""


def test_fbx_from_overrides():
    cfg = load_config(None, {"fbx": {"timeout_s": 30, "blender_path": "/x/blender"}})
    assert cfg.fbx.timeout_s == 30 and cfg.fbx.blender_path == "/x/blender"
