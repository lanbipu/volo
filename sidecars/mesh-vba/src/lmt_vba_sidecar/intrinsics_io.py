"""Shared intrinsics-file loader for the reconstruct paths (charuco / vpqsp /
structured-light) and the `--intrinsics-crosscheck` anchor. Accepts BOTH the
mesh `{K, dist_coeffs, image_size}` shape AND the vpcal master-lens flat shape
`{fx, fy, cx, cy, dist_coeffs, image_size, is_master, ...}` so a vpcal lens
calibration drops straight in as an intrinsics file or a crosscheck anchor.

Kept OUT of intrinsics_solve.py (whose contract is no-IO) to avoid a
reconstruct <-> sl_reconstruct import cycle."""
from __future__ import annotations

import json
import pathlib
from dataclasses import dataclass

import numpy as np

from lmt_vba_sidecar.intrinsics_solve import intrinsics_K_problem


@dataclass
class LoadedIntrinsics:
    K: np.ndarray
    dist: np.ndarray
    image_size: tuple[int, int] | None
    source_format: str  # "k_matrix" | "vpcal_flat"


def load_intrinsics_file(path) -> LoadedIntrinsics:
    """Load intrinsics from `path`. Raises ValueError (or OSError/json errors) on
    a malformed file so callers' existing `(OSError, json.JSONDecodeError, ...,
    ValueError)` except tuples map it to invalid_input. `dist_coeffs` defaults to
    zeros; `image_size` is optional (None when absent)."""
    raw = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    if "K" in raw:
        K = np.asarray(raw["K"], dtype=float)
        source = "k_matrix"
    elif all(k in raw for k in ("fx", "fy", "cx", "cy")):
        K = np.array(
            [[float(raw["fx"]), 0.0, float(raw["cx"])],
             [0.0, float(raw["fy"]), float(raw["cy"])],
             [0.0, 0.0, 1.0]],
            dtype=float,
        )
        source = "vpcal_flat"
    else:
        raise ValueError("intrinsics file has neither a 'K' matrix nor flat fx/fy/cx/cy fields")
    prob = intrinsics_K_problem(K)
    if prob is not None:
        raise ValueError(prob)
    dist = np.asarray(raw.get("dist_coeffs", [0.0, 0.0, 0.0, 0.0, 0.0]), dtype=float)
    if not np.isfinite(dist).all():
        raise ValueError("dist_coeffs must be finite")
    image_size: tuple[int, int] | None = None
    if raw.get("image_size") is not None:
        size = [int(v) for v in raw["image_size"]]
        if len(size) != 2:
            raise ValueError("image_size must have exactly two entries")
        image_size = (size[0], size[1])
    return LoadedIntrinsics(K=K, dist=dist, image_size=image_size, source_format=source)
