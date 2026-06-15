import json

import pytest

from tracksim.cli.commands import convert as convert_cmd
from tracksim.config import load_config


def test_convert_dry_run():
    op, data = convert_cmd.convert("in.fbx", out="o.json", camera=None, config=load_config(None, {}), dry_run=True)
    assert op == "sim.convert"
    assert data["dry_run_plan"]["input"] == "in.fbx" and data["dry_run_plan"]["out"] == "o.json"


def test_convert_runs_and_reports(monkeypatch, tmp_path):
    produced = tmp_path / "cache.json"
    produced.write_text(json.dumps({"schema": "tracksim.track/1", "rate": 60.0, "camera": "cam_1",
                                    "frames": [{"t": 0.0, "pose": {"pan": 0.0}}, {"t": 0.1, "pose": {"pan": 1.0}}]}),
                        encoding="utf-8")
    monkeypatch.setattr(convert_cmd, "convert_fbx", lambda *a, **k: str(produced))
    op, data = convert_cmd.convert("in.fbx", out=str(tmp_path / "o.json"), camera="cam_1",
                                   config=load_config(None, {}), dry_run=False)
    assert op == "sim.convert"
    assert data["frames"] == 2 and data["rate"] == 60.0 and data["camera"] == "cam_1"
    assert json.loads((tmp_path / "o.json").read_text())["frames"]


def test_convert_bad_out_raises_tracksim_error(monkeypatch, tmp_path):
    # 回归(Codex P2)：--out 指向不可写位置，应抛 TracksimError(干净 envelope) 而非裸 OSError
    from tracksim.domain.errors import TracksimError
    produced = tmp_path / "c.json"
    produced.write_text(json.dumps({"schema": "tracksim.track/1", "rate": 60.0, "camera": "c",
                                    "frames": [{"t": 0.0, "pose": {}}]}), encoding="utf-8")
    monkeypatch.setattr(convert_cmd, "convert_fbx", lambda *a, **k: str(produced))
    with pytest.raises(TracksimError):
        convert_cmd.convert("in.fbx", out=str(tmp_path / "nodir" / "o.json"), camera=None,
                            config=load_config(None, {}), dry_run=False)
