"""Pytest bootstrap: prefer this checkout's ``src/`` over skbuild editable maps."""

from __future__ import annotations

import sys
from pathlib import Path

# Mirror tests/_bootstrap/sitecustomize.py for in-process imports.
sys.meta_path = [
    finder
    for finder in sys.meta_path
    if "editable" not in type(finder).__module__.lower()
    and "editable" not in type(finder).__name__.lower()
    and "_editable_skbc" not in type(finder).__module__
]

_local_src = (Path(__file__).resolve().parents[1] / "src").resolve()
_local_s = str(_local_src)


def _is_foreign_vpcal_src(entry: str) -> bool:
    try:
        resolved = Path(entry).resolve()
    except OSError:
        return False
    if resolved == _local_src:
        return False
    parts = resolved.parts
    return "sidecars" in parts and "vpcal" in parts and parts[-1] == "src"


sys.path = [path for path in sys.path if not _is_foreign_vpcal_src(path)]
if _local_src.is_dir() and _local_s not in sys.path:
    sys.path.insert(0, _local_s)
