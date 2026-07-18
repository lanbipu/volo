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


class ScreenConnectivityError(Exception):
    """Screens are not connected via enough co-visible bridge views."""


def check_screen_connectivity(
    observations,
    cabinet_to_screen: dict[int, int],
    n_screens: int,
    *,
    screen_labels: list[str] | None = None,
    min_bridge_views: int = 2,
) -> dict:
    """Verify screens form one connected component via bridge views.

    A bridge view is a camera that observes markers from at least two screens.
    Screens A and B are adjacent when >= ``min_bridge_views`` cameras see both.

    Returns a dict with ``pair_bridge_counts`` and per-screen ``bridge_views``
    (cameras that see that screen together with at least one other screen).

    Raises
    ------
    ScreenConnectivityError
        When the screen graph is disconnected, listing pairs that lack bridges.
    """
    if n_screens <= 1:
        return {"connected": True, "pair_bridge_counts": {}, "bridge_views": {}}

    labels = screen_labels or [str(i) for i in range(n_screens)]
    cam_screens: dict[int, set[int]] = collections.defaultdict(set)
    for o in observations:
        si = cabinet_to_screen.get(o.cabinet_idx)
        if si is None:
            continue
        cam_screens[o.camera_idx].add(si)

    pair_counts: dict[tuple[int, int], int] = collections.defaultdict(int)
    bridge_views_per_screen: dict[int, int] = collections.defaultdict(int)
    for screens in cam_screens.values():
        if len(screens) < 2:
            continue
        sl = sorted(screens)
        for i in range(len(sl)):
            for j in range(i + 1, len(sl)):
                pair_counts[(sl[i], sl[j])] += 1
        for si in screens:
            bridge_views_per_screen[si] += 1

    adj: list[set[int]] = [set() for _ in range(n_screens)]
    for (a, b), count in pair_counts.items():
        if count >= min_bridge_views:
            adj[a].add(b)
            adj[b].add(a)

    seen = {0}
    stack = [0]
    while stack:
        u = stack.pop()
        for v in adj[u]:
            if v not in seen:
                seen.add(v)
                stack.append(v)

    if len(seen) == n_screens:
        return {
            "connected": True,
            "pair_bridge_counts": dict(pair_counts),
            "bridge_views": dict(bridge_views_per_screen),
        }

    # Collect component ids, then list cross-component pairs lacking bridges.
    comp = [-1] * n_screens
    for cid, start in enumerate(range(n_screens)):
        if comp[start] >= 0:
            continue
        comp_ids = {start}
        stack = [start]
        while stack:
            u = stack.pop()
            for v in adj[u]:
                if v not in comp_ids:
                    comp_ids.add(v)
                    stack.append(v)
        for si in comp_ids:
            comp[si] = cid

    missing: list[str] = []
    for a in range(n_screens):
        for b in range(a + 1, n_screens):
            if comp[a] == comp[b]:
                continue
            count = pair_counts.get((a, b), 0)
            missing.append(
                f"{labels[a]}↔{labels[b]} ({count} bridge view(s), need {min_bridge_views})"
            )
    raise ScreenConnectivityError(
        "screens_disconnected: " + "; ".join(sorted(missing))
    )


def check_observability(observations, n_cabinets: int,
                        min_views: int = 2, min_points: int = 8,
                        *, check_connectivity: bool = True) -> dict:
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

    if weak or (check_connectivity and not connected):
        raise ObservabilityError(
            f"observability failed: weak={weak}, connected={connected}, "
            f"isolated_cabinets={isolated}"
        )

    return {"connected": connected if check_connectivity else True, "weak": weak}
