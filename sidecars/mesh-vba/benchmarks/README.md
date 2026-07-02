# W7 — BA analytic Jacobian benchmark

`bench_ba_jacobian.py` compares `model_constrained_ba`'s current analytic
Jacobian (`jac=` callable, `_jacobian` in `model_constrained_ba.py`) against
the pre-W7 baseline (scipy 2-point finite differences guided by
`jac_sparsity`, reproduced inline in this script as
`model_constrained_ba_fd`/`_sparsity_pre_w7` since that code path was removed
from the module). Not packaged — outside `src/`, excluded by
`[tool.setuptools.packages.find]`.

```
.venv/bin/python benchmarks/bench_ba_jacobian.py --cabinets 300 --cams 20 --corners 4
```

Machine: Apple M3 Max, macOS 26.5.1, single-process (no GIL contention
control attempted), numpy 1.26.4 / scipy 1.17.1 / opencv 4.11.0, `.venv`.
Scene: full-visibility (every camera observes every cabinet), 4 planar
corners/cabinet, cabinets tiled on a grid, huber loss, `max_nfev=200`,
0.3px pixel noise, seed 0.

| cabinets × cams | observations | params | FD wall (pre-W7) | analytic wall (W7) | speedup |
|---|---|---|---|---|---|
| 5 × 4    | 80     | 48   | 0.04s  | 0.01s | 3.0x |
| 20 × 20  | 1,600  | 234  | 0.21s  | 0.07s | 3.0x |
| 50 × 20  | 4,000  | 414  | 0.69s  | 0.31s | 2.2x |
| 100 × 20 | 8,000  | 714  | 2.50s  | 1.17s | 2.1x |
| **300 × 20** (target scale) | **24,000** | **1,914** | **23.60s** | **5.64s** | **4.2x** |

## Why not 10x

The BA parameter block structure (camera params vs. non-root cabinet params)
is bipartite in the Jacobian's sparsity sense: a given residual row touches
exactly one camera's 6 columns and one cabinet's 6 columns, so no two camera
columns ever share a nonzero row, and no two cabinet columns ever share one
either — only camera↔cabinet pairs conflict. scipy's `group_columns` greedy
coloring exploits this and reduces the 1,914-parameter finite-difference
Jacobian at 300×20 down to **12 color groups** (measured directly with
`scipy.optimize._numdiff.group_columns` on the sparsity pattern), i.e. FD
needs ~13 residual evaluations per Jacobian instead of ~1,914. That built-in
sparsity exploitation is *why* the pre-W7 code was already far from the naive
O(n_params) FD cost, and why the analytic Jacobian's ceiling here is a
bounded ~3–4x (matching the measured range), not 10x+.

The acceptance bar was "≥10x speedup **or** <60s, whichever comes first" —
the analytic Jacobian hits **5.64s at the 300×20 target scale**, comfortably
under the 60s bar (and the FD baseline itself is also <60s at this scale, at
23.6s). Parity and full regression are unaffected (see report).
