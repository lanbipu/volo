import tomllib
from pathlib import Path

PYPROJECT = Path(__file__).resolve().parent.parent / "pyproject.toml"


def _load():
    with PYPROJECT.open("rb") as f:
        return tomllib.load(f)


def test_pyproject_exists():
    assert PYPROJECT.is_file()


def test_project_name_and_python():
    data = _load()
    assert data["project"]["name"] == "tracksim"
    assert data["project"]["requires-python"] == ">=3.11"


def test_runtime_dependencies():
    data = _load()
    deps = data["project"]["dependencies"]
    joined = " ".join(deps)
    assert "pydantic>=2" in joined
    assert "pysdl3" in joined
    assert "pyserial" in joined
    assert "cbor2" in joined
    assert "pyyaml" in joined


def test_dev_optional_dependencies():
    data = _load()
    dev = data["project"]["optional-dependencies"]["dev"]
    joined = " ".join(dev)
    assert "pytest" in joined
    assert "jsonschema" in joined


def test_console_script_entrypoint():
    data = _load()
    scripts = data["project"]["scripts"]
    assert scripts["tracksim"] == "tracksim.cli.main:main"


def test_src_layout_package_discovery():
    data = _load()
    where = data["tool"]["setuptools"]["packages"]["find"]["where"]
    assert where == ["src"]
