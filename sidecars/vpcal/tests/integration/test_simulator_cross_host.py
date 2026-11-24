"""Same seed → same simulated poses whether or not numpy/OpenBLAS may use
AVX-512.

AVX-512 and AVX2 LAPACK kernels return SVD singular vectors with different
signs. Before the simulator pinned its PCA basis, a single seed produced
mirrored camera poses on hosts with and without AVX-512 (differences of up to
4.5 m). This test regenerates the poses in a subprocess with AVX-512 masked
out (numpy dispatch + OpenBLAS core type) and compares them with the default
configuration. On hosts without AVX-512, or on non-x86 hosts, both runs use the
same kernels and the comparison passes trivially. The sign-flip unit test
(`tests/unit/test_simulator_determinism.py`) covers that case independently
of the host.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import numpy as np

import vpcal

_SRC = str(Path(vpcal.__file__).resolve().parents[1])
_KERNEL_VARS = ("NPY_DISABLE_CPU_FEATURES", "NPY_ENABLE_CPU_FEATURES", "OPENBLAS_CORETYPE")

_DUMP = r"""
import json, sys
import numpy as np
from vpcal.core.simulator import (
    generate_camera_poses, generate_poses_for_points, generate_trajectory_poses,
)
from vpcal.models.screen import ArcSection, PlaneSection, ScreenDefinition

def S(secs):
    return ScreenDefinition(name="x", unit="mm", cabinet_size=(500, 500),
                            led_pixel_pitch_mm=2.8, markers_per_cabinet=4, sections=secs)

screens = [
    S([PlaneSection(name="w", width_mm=4000, height_mm=3000)]),
    S([PlaneSection(name="w", width_mm=2400, height_mm=1600,
                    rotation=[0.9238795, 0.0, 0.0, 0.3826834])]),
    S([ArcSection(name="a", arc_radius_mm=4000, arc_angle_deg=80, height_mm=2000)]),
]
out = []
for sc in screens:
    for gen in (generate_camera_poses, generate_trajectory_poses):
        out.append(np.array(gen(sc, 8, np.random.default_rng(11))).tolist())
pts = np.random.default_rng(3).uniform([-2000, -50, 0], [2000, 50, 2500], size=(40, 3))
for traj in (False, True):
    out.append(np.array(generate_poses_for_points(
        pts, 6, np.random.default_rng(5), trajectory=traj)).tolist())
json.dump(out, sys.stdout)
"""


def _avx512_dispatch_features() -> list[str]:
    try:
        from numpy._core._multiarray_umath import __cpu_dispatch__
    except ImportError:  # numpy < 2
        from numpy.core._multiarray_umath import __cpu_dispatch__
    return [f for f in __cpu_dispatch__ if f.startswith("AVX512")]


def _dump(extra_env: dict[str, str]) -> list:
    env = {k: v for k, v in os.environ.items() if k not in _KERNEL_VARS}
    env.update(PYTHONPATH=_SRC, **extra_env)
    proc = subprocess.run(
        [sys.executable, "-c", _DUMP], env=env, capture_output=True, text=True, check=True
    )
    return json.loads(proc.stdout)


def test_poses_identical_with_avx512_disabled():
    ref = _dump({})
    masked_env = {"OPENBLAS_CORETYPE": "Haswell"}
    feats = _avx512_dispatch_features()
    if feats:
        masked_env["NPY_DISABLE_CPU_FEATURES"] = " ".join(feats)
    got = _dump(masked_env)
    assert len(ref) == len(got)
    diffs = [float(np.max(np.abs(np.asarray(a) - np.asarray(b)))) for a, b in zip(ref, got)]
    assert max(diffs) < 1e-9, diffs
