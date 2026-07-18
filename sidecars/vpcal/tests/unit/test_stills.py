"""AutoSnapDetector — stills capture motion/novelty gate (grid rebuild path)."""

from __future__ import annotations

import numpy as np

from vpcal.core.stills import AutoSnapDetector


def _gray(value: int = 96, w: int = 320, h: int = 240) -> np.ndarray:
    return np.full((h, w), value, dtype=np.uint8)


def _shifted(base: np.ndarray, dx: int, dy: int = 0, fill: int = 40) -> np.ndarray:
    out = np.full_like(base, fill)
    h, w = base.shape
    xs = max(0, dx)
    xd = max(0, -dx)
    ys = max(0, dy)
    yd = max(0, -dy)
    ww = w - abs(dx)
    hh = h - abs(dy)
    out[yd : yd + hh, xd : xd + ww] = base[ys : ys + hh, xs : xs + ww]
    return out


def _feed_still(det: AutoSnapDetector, frame: np.ndarray, t0: float, n: int, dt: float = 0.05):
    """Feed n identical frames starting at t0; return last update result."""
    last = None
    for i in range(n):
        last = det.update(frame, t0 + i * dt)
    return last


def test_still_triggers_snap():
    det = AutoSnapDetector(stable_ms=200, motion_thresh=1.5, novelty_thresh=6.0, min_interval=0.5)
    frame = _gray(100)
    # warm-up + hold still past stable_ms
    last = _feed_still(det, frame, t0=0.0, n=10, dt=0.05)
    assert last is not None
    assert last["snap"] is True
    assert last["state"] == "stable"


def test_continuous_motion_does_not_trigger():
    det = AutoSnapDetector(stable_ms=200, motion_thresh=1.5, novelty_thresh=6.0, min_interval=0.5)
    base = _gray(100)
    snapped = False
    for i in range(40):
        # alternate large shifts so EMA motion stays high
        frame = _shifted(base, dx=20 if i % 2 == 0 else -20)
        r = det.update(frame, i * 0.05)
        if r["snap"]:
            snapped = True
    assert snapped is False
    assert r["state"] == "moving"


def test_translate_then_still_second_snap():
    det = AutoSnapDetector(stable_ms=200, motion_thresh=1.5, novelty_thresh=6.0, min_interval=0.5)
    a = _gray(100)
    r1 = _feed_still(det, a, t0=0.0, n=10, dt=0.05)
    assert r1["snap"] is True
    det.mark_saved(a, 0.45)

    # move, then settle on a distinctly different still
    b = _shifted(a, dx=40, fill=20)
    for i in range(6):
        det.update(_shifted(a, dx=10 + i * 5, fill=20), 1.0 + i * 0.05)
    r2 = _feed_still(det, b, t0=1.5, n=12, dt=0.05)
    assert r2["snap"] is True
    assert r2["novelty"] >= 6.0


def test_cooldown_suppresses_duplicate():
    det = AutoSnapDetector(stable_ms=200, motion_thresh=1.5, novelty_thresh=6.0, min_interval=1.0)
    frame = _gray(120)
    r1 = _feed_still(det, frame, t0=0.0, n=10, dt=0.05)
    assert r1["snap"] is True
    det.mark_saved(frame, 0.45)

    # still below min_interval — same scene must not re-fire
    snaps = 0
    for i in range(10):
        r = det.update(frame, 0.5 + i * 0.05)
        if r["snap"]:
            snaps += 1
    assert snaps == 0


def test_mark_saved_resets_novelty_reference():
    det = AutoSnapDetector(stable_ms=100, motion_thresh=1.5, novelty_thresh=6.0, min_interval=0.0)
    a = _gray(80)
    b = _shifted(a, dx=50, fill=10)
    _feed_still(det, a, t0=0.0, n=6, dt=0.05)
    det.mark_saved(a, 0.3)
    # identical to saved reference → low novelty, no snap even when stable
    r = _feed_still(det, a, t0=0.4, n=8, dt=0.05)
    assert r["snap"] is False
    assert r["novelty"] < 6.0
    # different scene after settle → snap
    for i in range(4):
        det.update(_shifted(a, dx=20 + i * 8, fill=10), 1.0 + i * 0.05)
    r2 = _feed_still(det, b, t0=1.3, n=8, dt=0.05)
    assert r2["snap"] is True


def test_never_stable_warning_once_after_15s():
    det = AutoSnapDetector(stable_ms=500, motion_thresh=1.5, novelty_thresh=6.0, min_interval=0.5)
    base = _gray(90)
    warnings = []
    for i in range(320):  # 16 s at 50 ms
        frame = _shifted(base, dx=15 if i % 2 == 0 else -15)
        r = det.update(frame, i * 0.05)
        if r.get("warning"):
            warnings.append(r["warning"])
    assert warnings == [{"code": "never_stable"}]
