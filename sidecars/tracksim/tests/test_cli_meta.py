import json
import os
import subprocess
import sys

from tracksim import __version__ as pkg_version_module  # noqa: F401  (ensure package importable)
from tracksim.cli.commands import meta
from tracksim.manifest import build_manifest

_ENV = {**os.environ, "PYTHONPATH": os.path.abspath("src"), "PYSDL3_NO_UPDATE_CHECK": "1", "SDL_CHECK_VERSION": "0"}


def _run(args, **kw):
    return subprocess.run(
        [sys.executable, "-m", "tracksim", *args],
        capture_output=True, text=True, env=_ENV, **kw
    )


def test_version_returns_operation_id_and_version():
    op, data = meta.version()
    assert op == "meta.version"
    assert isinstance(data["version"], str)
    assert data["version"]


def test_manifest_returns_build_manifest():
    op, data = meta.manifest()
    assert op == "meta.manifest"
    assert data == build_manifest()


def test_schema_returns_operation_ids():
    op, data = meta.schema()
    assert op == "meta.schema"
    ids = {c["operation_id"] for c in data["commands"]}
    assert ids == {o["operation_id"] for o in build_manifest()["operations"]}


def test_completion_bash_contains_program_name():
    script = meta.completion("bash")
    assert "tracksim" in script


def test_completion_supports_three_shells():
    for shell in ("bash", "zsh", "fish"):
        assert isinstance(meta.completion(shell), str)
        assert meta.completion(shell)


def test_completion_bash_json_envelope_has_meta_completion_operation_id():
    """completion bash --output json envelope must have operation_id 'meta.completion'."""
    proc = _run(["completion", "bash", "--output", "json"])
    assert proc.returncode == 0, proc.stderr
    obj = json.loads(proc.stdout)
    assert obj["operation_id"] == "meta.completion"
    assert obj["status"] == "ok"
