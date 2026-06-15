import json
import os
import subprocess
import sys

from tests.test_cli_conformance import _make_freed_config   # _make_freed_config(port:int)->str


def _env():
    return {**os.environ, "PYTHONPATH": os.path.abspath("src"), "PYSDL3_NO_UPDATE_CHECK": "1"}


def test_run_source_track_loopback(tmp_path):
    track = {"schema": "tracksim.track/1", "rate": 50.0, "camera": "c",
             "frames": [{"t": 0.0, "pose": {"pan": 0.0}}, {"t": 0.04, "pose": {"pan": 2.0}}]}
    tp = tmp_path / "t.json"; tp.write_text(json.dumps(track), encoding="utf-8")
    cfg_path = _make_freed_config(59999)                  # 发往 127.0.0.1:59999；不校验送达，仅校验 stdout 形态
    r = subprocess.run(
        [sys.executable, "-m", "tracksim", "run", "--source", "track", str(tp),
         "--protocol", "freed", "--rate", "50", "--duration", "0.06",
         "--config", cfg_path, "-o", "json"],
        capture_output=True, text=True, timeout=30, env=_env())
    assert r.returncode == 0, r.stdout + r.stderr
    env = json.loads(r.stdout)
    assert env["status"] == "ok" and env["operation_id"] == "sim.run"


def test_run_source_track_rate_defaults_to_track_rate(tmp_path):
    # 不带 --rate：发射速率应取 track.rate（25），run 正常完成
    track = {"schema": "tracksim.track/1", "rate": 25.0, "camera": "c",
             "frames": [{"t": 0.0, "pose": {"pan": 0.0}}, {"t": 0.08, "pose": {"pan": 1.0}}]}
    tp = tmp_path / "t.json"; tp.write_text(json.dumps(track), encoding="utf-8")
    cfg_path = _make_freed_config(59998)
    r = subprocess.run(
        [sys.executable, "-m", "tracksim", "run", "--source", "track", str(tp),
         "--protocol", "freed", "--duration", "0.12", "--config", cfg_path, "-o", "json"],
        capture_output=True, text=True, timeout=30, env=_env())
    assert r.returncode == 0, r.stdout + r.stderr
    assert json.loads(r.stdout)["status"] == "ok"


def test_run_source_track_loop_does_not_exhaust(tmp_path):
    # 短 track（0.04s 内容）+ --loop + 长于内容的 duration：应被 duration 截断而非提前 source-exhausted
    track = {"schema": "tracksim.track/1", "rate": 50.0, "camera": "c",
             "frames": [{"t": 0.0, "pose": {"pan": 0.0}}, {"t": 0.04, "pose": {"pan": 2.0}}]}
    tp = tmp_path / "t.json"; tp.write_text(json.dumps(track), encoding="utf-8")
    cfg_path = _make_freed_config(59997)
    r = subprocess.run(
        [sys.executable, "-m", "tracksim", "run", "--source", "track", str(tp),
         "--protocol", "freed", "--rate", "50", "--duration", "0.1", "--loop",
         "--config", cfg_path, "-o", "json"],
        capture_output=True, text=True, timeout=30, env=_env())
    assert r.returncode == 0, r.stdout + r.stderr
    assert json.loads(r.stdout)["data"]["reason"] != "source-exhausted"   # --loop 让回放不耗尽


def test_loop_ignored_warns_for_non_track_source(tmp_path):
    # --loop 对非 track/fbx 源无效，应在 stderr 警告（而非静默忽略）
    cfg_path = _make_freed_config(59996)
    r = subprocess.run(
        [sys.executable, "-m", "tracksim", "run", "--source", "static", "--loop",
         "--protocol", "freed", "--rate", "20", "--duration", "0.05", "--config", cfg_path, "-o", "json"],
        capture_output=True, text=True, timeout=30, env=_env())
    assert r.returncode == 0, r.stdout + r.stderr
    assert "loop" in r.stderr.lower()   # 警告 --loop 被忽略
