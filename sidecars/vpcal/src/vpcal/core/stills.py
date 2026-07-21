"""Auto-snap detector for tracker-free stills capture (grid screen rebuild).

Downsample + blur + EMA motion gate → novelty vs last saved frame. Pure logic;
no I/O. Used by ``vpcal capture stills``. Also hosts :class:`DetectionGate` —
VP-QSP content gate layered on top of the motion gate (does not replace it).
"""

from __future__ import annotations

import threading
from collections.abc import Callable, Mapping
from typing import Any

import cv2
import numpy as np

DetectFnResult = Mapping[str, Any]

_EMA_ALPHA = 0.3
_PREVIEW_WIDTH = 160
_NEVER_STABLE_S = 15.0
_GATE_FRESH_S = 1.0


def gray_to_uint8(gray: np.ndarray) -> np.ndarray:
    """Normalize capture gray (uint8 / left-aligned uint16 / other) to uint8."""
    g = np.asarray(gray)
    if g.dtype == np.uint16 or (g.dtype.kind == "u" and g.dtype.itemsize > 1):
        return (g >> 8).astype(np.uint8)
    if g.dtype != np.uint8:
        return np.clip(g, 0, 255).astype(np.uint8)
    return g


class AutoSnapDetector:
    """Frame-diff stills gate: moving → stabilizing → stable → (optional) snap.

    ``update(gray, t)`` returns ``{snap, state, motion, novelty}`` and may
    include ``warning: {code: "never_stable"}`` once if auto never settles
    within 15 s. Call ``mark_saved(gray, t)`` after every save (auto or manual)
    to refresh the novelty reference and start the min-interval cooldown.
    """

    def __init__(
        self,
        *,
        stable_ms: float = 200.0,
        motion_thresh: float = 12.0,
        novelty_thresh: float = 6.0,
        min_interval: float = 1.0,
        enabled: bool = True,
    ) -> None:
        # Defaults tuned for handheld: the motion gate only rejects active
        # repositioning (walking / fast pans); ordinary handheld sway on busy
        # marker content easily reaches EMA 5-10 on the 160px diff, so the
        # ceiling sits above that. Frame sharpness is guaranteed by
        # DetectionGate.confirm (snap-time decode of the actual candidate
        # frame), not by stillness.
        self.stable_ms = float(stable_ms)
        self.motion_thresh = float(motion_thresh)
        self.novelty_thresh = float(novelty_thresh)
        self.min_interval = float(min_interval)
        self.enabled = bool(enabled)

        self._prev_small: np.ndarray | None = None
        self._saved_small: np.ndarray | None = None
        self._motion_ema: float | None = None
        self._state = "moving"
        self._stable_since: float | None = None
        self._last_saved_t: float | None = None
        self._t0: float | None = None
        self._warned_never_stable = False

    @property
    def state(self) -> str:
        return self._state

    def set_enabled(self, enabled: bool) -> None:
        self.enabled = bool(enabled)
        if not self.enabled:
            self._state = "moving"
            self._stable_since = None

    @staticmethod
    def preprocess(gray: np.ndarray) -> np.ndarray:
        """Resize width 160 first, then 16-bit→8-bit, then 3×3 Gaussian."""
        g = np.asarray(gray)
        h, w = g.shape[:2]
        if w != _PREVIEW_WIDTH:
            nh = max(1, int(round(h * (_PREVIEW_WIDTH / w))))
            g = cv2.resize(g, (_PREVIEW_WIDTH, nh), interpolation=cv2.INTER_AREA)
        return cv2.GaussianBlur(gray_to_uint8(g), (3, 3), 0)

    def update(self, gray: np.ndarray, t: float) -> dict[str, Any]:
        t = float(t)
        if self._t0 is None:
            self._t0 = t

        if not self.enabled:
            self._state = "moving"
            self._stable_since = None
            return {"snap": False, "state": "moving", "motion": 0.0, "novelty": 0.0}

        small = self.preprocess(gray)
        had_prev = self._prev_small is not None
        motion = 0.0
        if had_prev:
            raw = float(np.mean(cv2.absdiff(small, self._prev_small)))
            if self._motion_ema is None:
                self._motion_ema = raw
            else:
                self._motion_ema = _EMA_ALPHA * raw + (1.0 - _EMA_ALPHA) * self._motion_ema
            motion = float(self._motion_ema)
        self._prev_small = small

        novelty = 0.0
        if self._saved_small is not None:
            novelty = float(np.mean(cv2.absdiff(small, self._saved_small)))

        if had_prev:
            self._advance_state(motion, t)

        warning = None
        if (
            not self._warned_never_stable
            and self._state != "stable"
            and (t - self._t0) >= _NEVER_STABLE_S
        ):
            self._warned_never_stable = True
            warning = {"code": "never_stable"}

        snap = False
        if self._state == "stable":
            interval_ok = (
                self._last_saved_t is None or (t - self._last_saved_t) >= self.min_interval
            )
            # First save: no reference yet → any stable frame is novel.
            novelty_ok = self._saved_small is None or novelty >= self.novelty_thresh
            if interval_ok and novelty_ok:
                snap = True

        out: dict[str, Any] = {
            "snap": snap,
            "state": self._state,
            "motion": round(motion, 4),
            "novelty": round(novelty, 4),
        }
        if warning is not None:
            out["warning"] = warning
        return out

    def mark_saved(
        self,
        gray: np.ndarray | None,
        t: float,
        *,
        small: np.ndarray | None = None,
    ) -> None:
        """Refresh novelty reference. Pass ``small`` to reuse the last ``update`` buffer."""
        if small is not None:
            self._saved_small = small
        elif gray is not None:
            self._saved_small = self.preprocess(gray)
        elif self._prev_small is not None:
            self._saved_small = self._prev_small
        else:
            raise ValueError("mark_saved requires gray, small, or a prior update()")
        self._last_saved_t = float(t)
        # Force re-settle so the same hold does not immediately re-arm.
        self._state = "moving"
        self._stable_since = None

    def _advance_state(self, motion: float, t: float) -> None:
        if motion > self.motion_thresh:
            self._state = "moving"
            self._stable_since = None
            return
        if self._state == "moving":
            self._state = "stabilizing"
            self._stable_since = t
        elif (
            self._state == "stabilizing"
            and self._stable_since is not None
            and (t - self._stable_since) * 1000.0 >= self.stable_ms
        ):
            self._state = "stable"


class DetectionGate:
    """VP-QSP marker content gate for auto stills.

    ``detect_fn(gray)`` returns ``{count, cabinets?, bbox_frac?}``. Call
    ``poll`` from a throttled worker; ``allow`` / ``snapshot`` are cheap reads.
    ``min_markers <= 0`` bypasses the gate.
    """

    def __init__(
        self,
        *,
        min_markers: int = 4,
        detect_fn: Callable[[np.ndarray], DetectFnResult],
        interval_s: float = 0.5,
        fresh_s: float = _GATE_FRESH_S,
    ) -> None:
        self.min_markers = int(min_markers)
        self.detect_fn = detect_fn
        self.interval_s = float(interval_s)
        self.fresh_s = float(fresh_s)
        self._count: int | None = None
        self._detect_t: float | None = None
        self._cabinets: list[list[int]] = []
        self._bbox_frac: list[float] | None = None
        self._lock = threading.Lock()

    @property
    def bypass(self) -> bool:
        return self.min_markers <= 0

    def poll(self, gray: np.ndarray, t: float) -> dict[str, Any]:
        """Run ``detect_fn`` when the throttle interval elapses; cache result."""
        t = float(t)
        with self._lock:
            due = self._detect_t is None or (t - self._detect_t) >= self.interval_s
        if due:
            raw = self.detect_fn(gray)
            count = int(raw.get("count", 0))
            cabinets = [list(c) for c in (raw.get("cabinets") or [])]
            bbox = raw.get("bbox_frac")
            bbox_frac = [float(x) for x in bbox] if bbox is not None else None
            with self._lock:
                self._count = count
                self._detect_t = t
                self._cabinets = cabinets
                self._bbox_frac = bbox_frac
        return self.snapshot(t)

    def snapshot(self, t: float) -> dict[str, Any]:
        """Current cached readout without running detection."""
        t = float(t)
        with self._lock:
            count = self._count
            detect_t = self._detect_t
            cabinets = list(self._cabinets)
            bbox_frac = None if self._bbox_frac is None else list(self._bbox_frac)
        if count is None or detect_t is None:
            return {
                "markers": None, "stale": True,
                "cabinets": [], "bbox_frac": None,
            }
        stale = (t - detect_t) > self.fresh_s
        return {
            "markers": count, "stale": stale,
            "cabinets": cabinets, "bbox_frac": bbox_frac,
        }

    def markers_for_event(self, t: float) -> int | None:
        """Marker count for ``snap_saved`` — ``None`` when stale / never run."""
        snap = self.snapshot(t)
        if snap["stale"] or snap["markers"] is None:
            return None
        return int(snap["markers"])

    def allow(self, t: float) -> bool:
        """True when the latest detect is fresh and meets ``min_markers``."""
        if self.bypass:
            return True
        markers = self.markers_for_event(t)
        return markers is not None and markers >= self.min_markers

    def confirm(self, gray: np.ndarray, t: float) -> bool:
        """Snap-time gate: decode the actual candidate frame, ignore throttle.

        Defocus / motion blur breaks VP-QSP decoding, so a passing confirm
        certifies the frame being saved (not a cached earlier one) is sharp
        enough for reconstruction. Refreshes the cache for readouts/events.
        """
        if self.bypass:
            return True
        raw = self.detect_fn(gray)
        count = int(raw.get("count", 0))
        cabinets = [list(c) for c in (raw.get("cabinets") or [])]
        bbox = raw.get("bbox_frac")
        with self._lock:
            self._count = count
            self._detect_t = float(t)
            self._cabinets = cabinets
            self._bbox_frac = [float(x) for x in bbox] if bbox is not None else None
        return count >= self.min_markers
