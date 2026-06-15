import json
import os
import subprocess
import sys


def _env():
    return {**os.environ, "PYTHONPATH": os.path.abspath("src"), "PYSDL3_NO_UPDATE_CHECK": "1"}


def test_convert_dry_run_json_envelope():
    r = subprocess.run([sys.executable, "-m", "tracksim", "convert", "x.fbx", "--out", "o.json",
                        "--dry-run", "-o", "json"], capture_output=True, text=True, env=_env())
    assert r.returncode == 0
    env = json.loads(r.stdout)
    assert env["status"] == "ok" and env["operation_id"] == "sim.convert"
    assert env["data"]["dry_run_plan"]["input"] == "x.fbx"
