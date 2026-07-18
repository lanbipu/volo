"""Auto-snap detector for tracker-free stills capture (grid screen rebuild).

Downsample + blur + EMA motion gate → novelty vs last saved frame. Pure logic;
no I/O. Used by ``vpcal capture stills``.
"""

from __future__ import annotations

from typing import Any

import cv2
import numpy as np

_EMA_ALPHA = 0.3
_PREVIEW_WIDTH = 160
_NEVER_STABLE_S = 15.0


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
        stable_ms: float = 700.0,
        motion_thresh: float = 1.5,
        novelty_thresh: float = 6.0,
        min_interval: float = 1.0,
        enabled: bool = True,
    ) -> None:
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
        if g.dtype == np.uint16 or (g.dtype.kind == "u" and g.dtype.itemsize > 1):
            g = (g >> 8).astype(np.uint8)
        elif g.dtype != np.uint8:
            g = np.clip(g, 0, 255).astype(np.uint8)
        return cv2.GaussianBlur(g, (3, 3), 0)

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
