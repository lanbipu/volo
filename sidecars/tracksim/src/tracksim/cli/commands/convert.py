from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

from tracksim.config import Config
from tracksim.domain.errors import ConfigError
from tracksim.infra.blender_fbx import convert_fbx


def convert(input_path: str, *, out: str, camera: str | None, config: Config, dry_run: bool) -> tuple[str, dict[str, Any]]:
    if dry_run:
        return "sim.convert", {"dry_run_plan": {"input": input_path, "out": out, "camera": camera}}
    cached = convert_fbx(input_path, camera=camera, config=config, use_cache=True)
    try:
        shutil.copyfile(cached, out)
        obj = json.loads(Path(out).read_text(encoding="utf-8"))
    except OSError as exc:
        raise ConfigError(f"cannot write output track to {out}: {exc}", details={"out": out}) from exc
    return "sim.convert", {"out": out, "frames": len(obj.get("frames", [])),
                           "rate": obj.get("rate"), "camera": obj.get("camera")}
