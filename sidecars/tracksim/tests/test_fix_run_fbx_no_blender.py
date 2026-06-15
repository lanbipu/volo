import json
import os
import subprocess
import sys


def test_run_source_fbx_bad_input_errors_clean():
    """run --source fbx 指向不存在的 FBX：必须给明确错误码（无 Blender→3；FBX 不存在→13），
    不裸崩、stdout 仍是合法 error envelope。"""
    env = {**os.environ, "PYTHONPATH": os.path.abspath("src"),
           "PYSDL3_NO_UPDATE_CHECK": "1", "BLENDER": ""}
    r = subprocess.run([sys.executable, "-m", "tracksim", "run", "--source", "fbx", "/no/such.fbx", "-o", "json"],
                       capture_output=True, text=True, timeout=30, env=env)
    assert r.returncode in (3, 13), r.stdout + r.stderr
    env_obj = json.loads(r.stdout)
    assert env_obj["status"] == "error" and env_obj["error"]["exit_code"] == r.returncode
