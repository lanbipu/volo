"""AutoSnapDetector / DetectionGate — stills capture gates (grid rebuild path)."""

from __future__ import annotations

import numpy as np

from vpcal.core.stills import AutoSnapDetector, DetectionGate


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


# ---------- DetectionGate (VP-QSP content gate) ----------


def _count(n: int) -> dict:
    return {"count": n}


def test_detection_gate_throttles_detect_fn():
    calls = []

    def detect_fn(gray):
        calls.append(int(gray[0, 0]))
        return _count(8)

    gate = DetectionGate(min_markers=4, detect_fn=detect_fn, interval_s=0.5)
    frame = _gray(10)
    s0 = gate.poll(frame, 0.0)
    assert s0["markers"] == 8 and s0["stale"] is False
    assert len(calls) == 1
    assert gate.poll(frame, 0.2)["markers"] == 8
    assert len(calls) == 1
    assert gate.poll(frame, 0.5)["markers"] == 8
    assert len(calls) == 2


def test_detection_gate_freshness_and_threshold():
    frame = _gray()
    low = DetectionGate(min_markers=4, detect_fn=lambda _g: _count(3))
    low.poll(frame, 0.0)
    assert low.allow(0.0) is False
    assert low.snapshot(0.0)["markers"] == 3
    assert low.snapshot(0.0)["stale"] is False
    assert low.snapshot(1.1)["stale"] is True
    assert low.allow(1.1) is False

    ok = DetectionGate(min_markers=4, detect_fn=lambda _g: _count(6))
    ok.poll(frame, 0.0)
    assert ok.allow(0.5) is True
    assert ok.markers_for_event(0.5) == 6
    assert ok.markers_for_event(1.5) is None


def test_detection_gate_accepts_rich_detect_result():
    frame = _gray()
    gate = DetectionGate(
        min_markers=4,
        detect_fn=lambda _g: {
            "count": 9,
            "cabinets": [[1, 2, 0], [1, 3, 0]],
            "bbox_frac": [0.1, 0.2, 0.8, 0.7],
        },
    )
    snap = gate.poll(frame, 0.0)
    assert snap["markers"] == 9
    assert snap["cabinets"] == [[1, 2, 0], [1, 3, 0]]
    assert snap["bbox_frac"] == [0.1, 0.2, 0.8, 0.7]
    assert gate.allow(0.0) is True


def test_detection_gate_stable_zero_markers_blocks_without_mark_saved():
    det = AutoSnapDetector(stable_ms=200, motion_thresh=1.5, novelty_thresh=6.0, min_interval=0.5)
    gate = DetectionGate(min_markers=4, detect_fn=lambda _g: _count(0))
    frame = _gray(100)
    gate.poll(frame, 0.0)
    last = _feed_still(det, frame, t0=0.0, n=10, dt=0.05)
    assert last["snap"] is True
    assert gate.allow(0.45) is False
    assert det.state == "stable"


def test_detection_gate_enough_markers_allows_auto_save():
    det = AutoSnapDetector(stable_ms=200, motion_thresh=1.5, novelty_thresh=6.0, min_interval=0.5)
    gate = DetectionGate(min_markers=4, detect_fn=lambda _g: _count(12))
    frame = _gray(110)
    gate.poll(frame, 0.0)
    last = _feed_still(det, frame, t0=0.0, n=10, dt=0.05)
    assert last["snap"] is True
    assert gate.allow(0.45) is True
    det.mark_saved(frame, 0.45)
    assert det.state == "moving"


def test_detection_gate_min_markers_zero_bypasses():
    gate = DetectionGate(min_markers=0, detect_fn=lambda _g: _count(0))
    assert gate.bypass is True
    assert gate.allow(0.0) is True
    gate.poll(_gray(), 0.0)
    assert gate.allow(0.0) is True
    assert gate.snapshot(0.0)["markers"] == 0


def test_detection_gate_confirm_ignores_throttle_and_refreshes_cache():
    calls = []

    def detect_fn(gray):
        calls.append(1)
        return _count(6 if len(calls) > 1 else 2)

    gate = DetectionGate(min_markers=4, detect_fn=detect_fn, interval_s=0.5)
    frame = _gray(10)
    assert gate.confirm(frame, 0.0) is False        # count=2 < 4
    assert gate.confirm(frame, 0.1) is True         # count=6, throttle ignored
    assert len(calls) == 2
    snap = gate.snapshot(0.1)
    assert snap["markers"] == 6 and snap["stale"] is False


def test_detection_gate_confirm_bypass_skips_detect():
    calls = []

    def detect_fn(gray):
        calls.append(1)
        return _count(0)

    gate = DetectionGate(min_markers=0, detect_fn=detect_fn)
    assert gate.confirm(_gray(), 0.0) is True
    assert calls == []
