"""Calibration drift comparison (remediation C5).

Compares two ``result.json`` calibrations (e.g. a baseline and today's re-cal)
and reports how far ``T_S_from_O`` (tracker→stage), ``T_C_from_B``
(tracker→camera) and the validation RMS have moved — the ``daily drift check``
use case in the QuickCal brief.  Pure comparison; no solving.
"""

from __future__ import annotations

import numpy as np

DEFAULT_TRANS_THRESHOLD_MM = 2.0
DEFAULT_ROT_THRESHOLD_DEG = 0.05
DEFAULT_RMS_THRESHOLD_PX = 0.5
DEFAULT_DELAY_THRESHOLD_MS = 2.0


def _trans_drift_mm(a: list[float], b: list[float]) -> float:
    return float(np.linalg.norm(np.asarray(b, float) - np.asarray(a, float)))


def _rot_drift_deg(qa: list[float], qb: list[float]) -> float:
    """Geodesic angle (deg) between two unit quaternions (w, x, y, z)."""
    a = np.asarray(qa, float)
    b = np.asarray(qb, float)
    a = a / (np.linalg.norm(a) or 1.0)
    b = b / (np.linalg.norm(b) or 1.0)
    return float(np.degrees(2.0 * np.arccos(np.clip(abs(np.dot(a, b)), 0.0, 1.0))))


def _transform_drift(ta: dict, tb: dict, trans_thresh: float, rot_thresh: float) -> dict:
    td = _trans_drift_mm(ta["translation"], tb["translation"])
    rd = _rot_drift_deg(ta["rotation"], tb["rotation"])
    return {
        "translation_drift_mm": round(td, 4),
        "rotation_drift_deg": round(rd, 5),
        "translation_alert": bool(td > trans_thresh),
        "rotation_alert": bool(rd > rot_thresh),
    }


def compare_results(
    a: dict,
    b: dict,
    *,
    trans_threshold_mm: float = DEFAULT_TRANS_THRESHOLD_MM,
    rot_threshold_deg: float = DEFAULT_ROT_THRESHOLD_DEG,
    rms_threshold_px: float = DEFAULT_RMS_THRESHOLD_PX,
    delay_a: dict | None = None,
    delay_b: dict | None = None,
    delay_threshold_ms: float = DEFAULT_DELAY_THRESHOLD_MS,
) -> dict:
    """Structured drift between two calibration result dicts.

    ``a`` is the baseline/earlier result, ``b`` the later one.  Each rigid
    transform contributes translation (mm) and rotation (deg geodesic) drift with
    a per-axis alert flag; ``validation_rms_px`` / ``reprojection_rms_px`` get a
    signed delta, and a *worsening* validation RMS beyond ``rms_threshold_px``
    raises an alert too (a re-cal can degrade in held-out validation while its
    transforms barely move — C5 must catch that).  ``any_alert`` is True iff any
    threshold is breached.
    """
    out: dict = {
        "schema_version": "1.0",
        "thresholds": {"translation_mm": trans_threshold_mm, "rotation_deg": rot_threshold_deg,
                       "validation_rms_px": rms_threshold_px, "delay_ms": delay_threshold_ms},
        "transforms": {},
        "quality": {},
    }
    alerts = []
    for key in ("tracker_to_stage", "tracker_to_camera"):
        ta, tb = a.get(key), b.get(key)
        if ta and tb:
            d = _transform_drift(ta, tb, trans_threshold_mm, rot_threshold_deg)
            out["transforms"][key] = d
            alerts.append(d["translation_alert"] or d["rotation_alert"])

    qa = a.get("quality", {}) or {}
    qb = b.get("quality", {}) or {}
    for metric in ("validation_rms_px", "reprojection_rms_px"):
        va, vb = qa.get(metric), qb.get(metric)
        entry = {"a": va, "b": vb}
        if va is not None and vb is not None:
            entry["delta"] = round(vb - va, 4)
            # Only validation RMS gates the alert (in-sample reprojection RMS is
            # not a degradation signal on its own).
            if metric == "validation_rms_px":
                entry["alert"] = bool(vb - va > rms_threshold_px)
                alerts.append(entry["alert"])
        out["quality"][metric] = entry

    if delay_a is not None and delay_b is not None:
        cams_a = {str(c.get("id", i)): c for i, c in enumerate(delay_a.get("cameras", []))}
        cams_b = {str(c.get("id", i)): c for i, c in enumerate(delay_b.get("cameras", []))}
        delay_diff = {}
        for camera_id in sorted(cams_a.keys() & cams_b.keys()):
            va = float(cams_a[camera_id]["delay_ms"])
            vb = float(cams_b[camera_id]["delay_ms"])
            delta = vb - va
            entry = {"a_ms": va, "b_ms": vb, "delta_ms": round(delta, 4),
                     "alert": abs(delta) > delay_threshold_ms}
            delay_diff[camera_id] = entry
            alerts.append(entry["alert"])
        out["delay"] = delay_diff

    out["any_alert"] = bool(any(alerts))
    return out


def render_drift(diff: dict, *, label_a: str = "A", label_b: str = "B") -> str:
    th = diff["thresholds"]
    lines = [
        f"Calibration drift  {label_a} → {label_b}"
        + ("   ⚠ ALERT" if diff.get("any_alert") else "   ✓ within thresholds"),
        f"  thresholds: {th['translation_mm']} mm / {th['rotation_deg']}°",
    ]
    names = {"tracker_to_stage": "T_S_from_O (tracker→stage)",
             "tracker_to_camera": "T_C_from_B (tracker→camera)"}
    for key, d in diff["transforms"].items():
        flag = " ⚠" if (d["translation_alert"] or d["rotation_alert"]) else ""
        lines.append(
            f"  {names.get(key, key):28s} Δt {d['translation_drift_mm']:.3f} mm   "
            f"Δr {d['rotation_drift_deg']:.4f}°{flag}"
        )
    for metric, e in diff["quality"].items():
        if e.get("a") is not None and e.get("b") is not None:
            lines.append(f"  {metric:28s} {e['a']:.4f} → {e['b']:.4f}  (Δ {e['delta']:+.4f})")
    for camera_id, e in diff.get("delay", {}).items():
        flag = " ⚠" if e["alert"] else ""
        lines.append(
            f"  delay {camera_id:22s} {e['a_ms']:+.2f} → {e['b_ms']:+.2f} ms "
            f"(Δ {e['delta_ms']:+.2f}){flag}"
        )
    return "\n".join(lines)
