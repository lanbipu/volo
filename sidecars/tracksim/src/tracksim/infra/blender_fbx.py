from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

from tracksim import __version__ as _TS_VERSION
from tracksim.config import Config
from tracksim.domain.errors import ConfigError, FbxConversionError
from tracksim.track import TRACK_SCHEMA

_SCRIPT = Path(__file__).with_name("blender_extract.py")
_LOG_CAP = 64 * 1024


def _candidate_paths(config: Config) -> list[str]:
    out: list[str] = []
    if config.fbx.blender_path:
        out.append(config.fbx.blender_path)
    if os.environ.get("BLENDER"):
        out.append(os.environ["BLENDER"])
    if sys.platform == "darwin":
        out.append("/Applications/Blender.app/Contents/MacOS/Blender")
    if shutil.which("blender"):
        out.append(shutil.which("blender"))
    return out


def find_blender(config: Config) -> str:
    for p in _candidate_paths(config):
        if p and Path(p).exists():
            return p
    raise ConfigError(
        "Blender not found; set [fbx].blender_path, $BLENDER, or install Blender",
        details={"searched": _candidate_paths(config)})


def blender_version(blender_path: str) -> str:
    try:
        out = subprocess.run([blender_path, "--version"], capture_output=True, text=True, timeout=30)
        return out.stdout.strip().splitlines()[0] if out.stdout else "unknown"
    except Exception:
        return "unknown"


def _cache_dir(config: Config) -> Path:
    if config.fbx.cache_dir:
        return Path(config.fbx.cache_dir)
    base = os.environ.get("XDG_CACHE_HOME") or str(Path.home() / ".cache")
    return Path(base) / "tracksim" / "fbx"


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _cache_key(fbx_path: str, camera: str | None, config: Config, blender_ver: str) -> dict:
    # blender_path/timeout_s/cache_dir 不入键（不改变轨迹内容）
    return {
        "fbx_sha": _sha(Path(fbx_path).read_bytes()),
        "script_sha": _sha(_SCRIPT.read_bytes()),     # 坐标常量改动 → 此 hash 变 → 缓存失效
        "tracksim_version": _TS_VERSION,
        "blender_version": blender_ver,
        "schema": TRACK_SCHEMA,
        "camera": camera or "",
        "default_camera": config.fbx.default_camera,
    }


def _run_blender(blender: str, script: str, inp: str, out: str, camera: str, timeout: float):
    """运行 Blender 子进程。返回 (returncode, stdout_tail, stderr_tail)。超时抛 TimeoutError。
    POSIX 下用进程组隔离+killpg；Windows 仅 proc.kill()（无进程组清理，Phase 1 可接受）。"""
    cmd = [blender, "--background", "--factory-startup", "--python", script, "--", "--in", inp, "--out", out]
    if camera:
        cmd += ["--camera", camera]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
    try:
        so, se = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(proc.pid), 9)        # POSIX：杀整个进程组，避免遗留 Blender
        except Exception:
            proc.kill()                                # Windows 兜底
        proc.communicate()
        raise TimeoutError(f"Blender conversion exceeded {timeout}s")
    return proc.returncode, (so or "")[-_LOG_CAP:], (se or "")[-_LOG_CAP:]


def convert_fbx(fbx_path: str, *, camera: str | None, config: Config, use_cache: bool = True) -> str:
    import math
    fbx_path = str(Path(fbx_path).resolve())
    if not Path(fbx_path).exists():
        raise FbxConversionError(f"FBX not found: {fbx_path}", details={"path": fbx_path})
    # 这两条路径(convert / run --source fbx)在 build_emitters 校验前就到这里，须自校 timeout。
    if not math.isfinite(config.fbx.timeout_s) or config.fbx.timeout_s <= 0:
        raise ConfigError(
            f"fbx.timeout_s must be a finite number > 0, got {config.fbx.timeout_s}",
            details={"timeout_s": config.fbx.timeout_s})
    # 非空 default_camera 等同 --camera（--camera 优先）。
    camera = camera or config.fbx.default_camera or None
    blender = find_blender(config)
    bver = blender_version(blender)
    key = _cache_key(fbx_path, camera, config, bver)
    digest = _sha(json.dumps(key, sort_keys=True).encode("utf-8"))
    cdir = _cache_dir(config)
    out_json = cdir / f"{digest}.track.json"
    meta_json = cdir / f"{digest}.meta.json"

    if use_cache and out_json.exists() and meta_json.exists():
        try:
            if json.loads(meta_json.read_text()) == key:
                return str(out_json)
        except Exception:
            pass

    cdir.mkdir(parents=True, exist_ok=True)
    tmp_out = out_json.with_suffix(".tmp")
    try:
        rc, so, se = _run_blender(blender, str(_SCRIPT), fbx_path, str(tmp_out), camera or "", config.fbx.timeout_s)
    except TimeoutError as exc:
        tmp_out.unlink(missing_ok=True)
        raise FbxConversionError(str(exc), details={"timeout": True, "timeout_s": config.fbx.timeout_s}) from exc
    if rc != 0 or not tmp_out.exists():
        tmp_out.unlink(missing_ok=True)
        raise FbxConversionError(
            f"Blender FBX conversion failed (rc={rc})",
            details={"returncode": rc, "stderr": se[-2000:], "stdout": so[-500:]})
    try:
        obj = json.loads(tmp_out.read_text(encoding="utf-8"))
        if not obj.get("frames"):
            raise ValueError("no frames")
    except Exception as exc:
        tmp_out.unlink(missing_ok=True)
        raise FbxConversionError(f"Blender produced invalid track JSON: {exc}", details={"stderr": se[-2000:]}) from exc
    os.replace(tmp_out, out_json)                      # 原子（tmp 与目标同目录）
    meta_json.write_text(json.dumps(key, sort_keys=True), encoding="utf-8")
    return str(out_json)
