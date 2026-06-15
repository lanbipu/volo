"""Reconcile a reconstructed cabinet_pose_report against known monitor geometry.

Pure function: takes a parsed pose report (reconstruct output, spec §9) plus a
user-filled "known geometry" dict (true monitor sizes + pairwise distances and
angles), and reports per-cabinet size error, per-pair distance error, and
per-pair angle error, each with a pass/fail against tolerance thresholds.

No I/O — file reading lives in compare_known_cmd.run_compare_known.
"""
from __future__ import annotations

import math

import numpy as np

# Default tolerances (spec §10.3 nominal targets).
DEFAULT_THRESHOLDS = {
    "size_mm": 2.0,
    "distance_mm": 3.0,
    "angle_deg": 0.3,
}


def _corner_size(corners: list[list[float]]) -> tuple[float, float]:
    """Width/height of the cabinet rectangle from its 4 ordered corners.

    Corners are ordered bottom-left, bottom-right, top-right, top-left, so
    width = |corner1 - corner0| and height = |corner2 - corner1|.
    """
    c = np.asarray(corners, dtype=float)
    width = float(np.linalg.norm(c[1] - c[0]))
    height = float(np.linalg.norm(c[2] - c[1]))
    return width, height


def compare_known(report: dict, known: dict, thresholds: dict | None = None) -> dict:
    """Compare a reconstructed pose report against known geometry.

    Args:
        report: parsed cabinet_pose_report.json (spec §9). Uses cabinet_poses[*]
            cabinet_id, position_mm, normal, corners_mm.
        known: user-filled truth. Shape:
            {"cabinets": {cabinet_id: {"size_mm": [w, h]}},
             "pairs": [{"a", "b", "distance_mm", "angle_deg"}]}.
        thresholds: optional override of DEFAULT_THRESHOLDS keys
            (size_mm, distance_mm, angle_deg).

    Returns:
        {"cabinets": [{cabinet_id, size_error_mm, pass}],
         "pairs": [{a, b, distance_error_mm, angle_error_deg, distance_pass, angle_pass}],
         "passed": bool, "thresholds": {...}}.
    """
    thr = dict(DEFAULT_THRESHOLDS)
    if thresholds:
        thr.update(thresholds)

    poses = {p["cabinet_id"]: p for p in report.get("cabinet_poses", [])}

    cabinets_out: list[dict] = []
    known_cabs = known.get("cabinets", {})
    for cabinet_id, spec in known_cabs.items():
        pose = poses.get(cabinet_id)
        if pose is None:
            raise ValueError(f"known cabinet {cabinet_id!r} not present in pose report")
        w, h = _corner_size(pose["corners_mm"])
        known_w, known_h = float(spec["size_mm"][0]), float(spec["size_mm"][1])
        size_error_mm = max(abs(w - known_w), abs(h - known_h))
        cabinets_out.append({
            "cabinet_id": cabinet_id,
            "size_error_mm": size_error_mm,
            "pass": size_error_mm <= thr["size_mm"],
        })

    pairs_out: list[dict] = []
    for pair in known.get("pairs", []):
        a, b = pair["a"], pair["b"]
        pose_a, pose_b = poses.get(a), poses.get(b)
        if pose_a is None or pose_b is None:
            raise ValueError(f"pair ({a!r}, {b!r}) references cabinet absent from pose report")

        pos_a = np.asarray(pose_a["position_mm"], dtype=float)
        pos_b = np.asarray(pose_b["position_mm"], dtype=float)
        computed_distance = float(np.linalg.norm(pos_a - pos_b))
        distance_error_mm = abs(computed_distance - float(pair["distance_mm"]))

        n_a = np.asarray(pose_a["normal"], dtype=float)
        n_b = np.asarray(pose_b["normal"], dtype=float)
        dot = float(np.clip(np.dot(n_a, n_b), -1.0, 1.0))
        computed_angle_deg = math.degrees(math.acos(dot))
        angle_error_deg = abs(computed_angle_deg - float(pair["angle_deg"]))

        pairs_out.append({
            "a": a,
            "b": b,
            "distance_error_mm": distance_error_mm,
            "angle_error_deg": angle_error_deg,
            "distance_pass": distance_error_mm <= thr["distance_mm"],
            "angle_pass": angle_error_deg <= thr["angle_deg"],
        })

    passed = (
        all(c["pass"] for c in cabinets_out)
        and all(p["distance_pass"] and p["angle_pass"] for p in pairs_out)
    )

    return {
        "cabinets": cabinets_out,
        "pairs": pairs_out,
        "passed": passed,
        "thresholds": thr,
    }
