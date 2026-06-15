"""Per-cabinet observability gates + bipartite (camera<->cabinet) graph
connectivity check.

Disconnected cabinets form locally-independent solutions that can look
converged but are silently wrong (spec §12). This module:
  1. Counts how many cameras observe each cabinet (views) and how many
     observations exist (points), raising ObservabilityError for any
     cabinet below the thresholds.
  2. Treats cameras and cabinets as nodes in a bipartite graph and checks
     full connectivity via BFS.  Isolated sub-graphs are listed explicitly.
"""
from __future__ import annotations
import collections


class ObservabilityError(Exception):
    pass


def check_observability(observations, n_cabinets: int,
                        min_views: int = 2, min_points: int = 8) -> dict:
    """Check per-cabinet observability and bipartite graph connectivity.

    Parameters
    ----------
    observations : list[Observation]
        All observations from model_constrained_ba.
    n_cabinets : int
        Total number of cabinets in the scene.
    min_views : int
        Minimum distinct cameras that must observe each cabinet.
    min_points : int
        Minimum observations (corner detections) per cabinet.

    Returns
    -------
    dict with key "connected": True when all checks pass.

    Raises
    ------
    ObservabilityError
        If any cabinet is under-observed or the camera<->cabinet graph
        is disconnected.
    """
    points_per_cab: dict[int, int] = collections.defaultdict(int)
    # adjacency: cabinet_idx -> set of camera_idx nodes that see it
    # (also serves as the per-cabinet distinct-view set)
    adj: dict[int, set] = collections.defaultdict(set)

    for o in observations:
        points_per_cab[o.cabinet_idx] += 1
        adj[o.cabinet_idx].add(o.camera_idx)

    # Gate 1: per-cabinet observation counts
    weak = []
    for j in range(n_cabinets):
        nv = len(adj.get(j, ()))
        npts = points_per_cab.get(j, 0)
        if nv < min_views or npts < min_points:
            weak.append({"cabinet_idx": j, "views": nv, "points": npts})

    # Gate 2: bipartite graph connectivity
    # Nodes are tagged tuples: ("cab", j) and ("cam", c)
    cab_nodes = {("cab", j) for j in adj}
    cam_nodes = {("cam", c) for cams in adj.values() for c in cams}

    if not cab_nodes:
        raise ObservabilityError("no cabinet observed")

    # Build undirected adjacency for BFS
    g: dict = collections.defaultdict(set)
    for j, cams in adj.items():
        for c in cams:
            g[("cab", j)].add(("cam", c))
            g[("cam", c)].add(("cab", j))

    # BFS from an arbitrary cabinet node
    start = next(iter(cab_nodes))
    seen = {start}
    stack = [start]
    while stack:
        node = stack.pop()
        for nb in g[node]:
            if nb not in seen:
                seen.add(nb)
                stack.append(nb)

    all_nodes = cab_nodes | cam_nodes
    connected = all_nodes <= seen
    # Identify cabinets not reached by BFS
    isolated = sorted(
        node[1] for node in cab_nodes if node not in seen
    )

    if weak or not connected:
        raise ObservabilityError(
            f"observability failed: weak={weak}, connected={connected}, "
            f"isolated_cabinets={isolated}"
        )

    return {"connected": True, "weak": weak}
