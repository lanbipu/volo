"""Video capture backend abstraction (remediation C1.2 — capture service step 2).

A :class:`CaptureBackend` turns a physical (or synthetic) video source into a
uniform iterator of :class:`CapturedFrame`.  The calibration chain consumes the
full-quality grayscale plane; the preview chain (``core/preview_server.py``)
independently re-encodes a downsampled JPEG — the two never share an encode
path (precision red line #1: the calibration path takes no lossy re-compress).

Backends
--------
``synthetic``  procedurally generated moving test card — dev/CI, zero hardware.
``uvc``        ``cv2.VideoCapture`` — webcams and SDI/HDMI→USB3 converters
               (AJA U-TAP class devices), the field-proven no-driver path.
``ndi``        NDI receive via the optional ``cyndilib`` binding (spike; raises
               a guided PreconditionError when the binding/SDK is missing).
``decklink``   Blackmagic DeckLink via the optional ``vpcal_capture`` C++
               module (Phase 2; raises a guided PreconditionError when the
               module was not built against a local DeckLink SDK).
"""

from __future__ import annotations

import dataclasses
import time
from typing import Any, Iterator, Protocol

import numpy as np

from vpcal.core.errors import ArgumentError, PreconditionError

BACKENDS = ("synthetic", "uvc", "ndi", "decklink")

# NDI|HX is a long-GOP H.264/HEVC transport (80–200 ms, inter-frame lossy) —
# never acceptable for calibration captures, preview only (precision red line #3).
NDI_HX_REFUSAL = (
    "NDI|HX source detected: NDI|HX is a long-GOP H.264/HEVC transport and is "
    "not acceptable for calibration capture (preview only). Use full NDI, a "
    "UVC converter, or a DeckLink input for calibration."
)


@dataclasses.dataclass
class CaptureConfig:
    """Configuration for opening a capture backend."""

    backend: str = "uvc"
    device: str = "0"            # uvc: device index; ndi: source name; decklink: device index
    width: int | None = None     # requested width (backend may negotiate)
    height: int | None = None
    fps: float | None = None
    transfer_function: str = "sdr"   # "sdr" | "log" | … — declared, not converted
    pixel_format: str | None = None  # backend-specific hint (e.g. "v210")
    extra: dict[str, Any] = dataclasses.field(default_factory=dict)


@dataclasses.dataclass
class CapturedFrame:
    """One captured frame, normalised for the calibration chain.

    ``gray`` is the full-quality grayscale plane: uint8 for 8-bit sources,
    uint16 (left-aligned) for >8-bit sources — precision red line #4 keeps
    10-bit sources at 16-bit until PNG write.  ``bgr`` is the original colour
    frame when the source is colour (preview encodes from it); ``None`` for
    grayscale-native sources.
    """

    gray: np.ndarray
    recv_ts: float                     # monotonic receive timestamp (time.monotonic())
    timecode: str | None = None        # embedded RP188/VITC timecode if present
    frame_index: int = 0
    bgr: np.ndarray | None = None
    meta: dict[str, Any] = dataclasses.field(default_factory=dict)


class CaptureBackend(Protocol):
    """Uniform capture interface (plan §5 Phase 1a)."""

    def open(self, config: CaptureConfig) -> None: ...

    def frames(self) -> Iterator[CapturedFrame]: ...

    def close(self) -> None: ...


def to_gray(bgr: np.ndarray) -> np.ndarray:
    """BGR (or single-plane) uint8/uint16 → grayscale, dtype preserved."""
    if bgr.ndim == 2:
        return bgr
    import cv2

    return cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)


# ── synthetic ────────────────────────────────────────────────────────


class SyntheticBackend:
    """Procedural moving test card — deterministic, zero hardware.

    Frame content: mid-gray field, a bright square orbiting the centre (motion
    for latency eyeballing), a frame-index binary strip (top-left) so a decoder
    can recover the source frame number, and a timestamp text row baked in via
    plain numpy (no cv2.putText dependency on font rendering determinism).

    ``config.extra["script"]`` may hold a list of grayscale ndarrays to play
    back instead (used by tests to simulate an LED wall showing patterns).
    """

    def __init__(self) -> None:
        self._config: CaptureConfig | None = None
        self._open = False

    def open(self, config: CaptureConfig) -> None:
        self._config = config
        self._open = True

    def close(self) -> None:
        self._open = False

    def frames(self) -> Iterator[CapturedFrame]:
        if not self._open or self._config is None:
            raise PreconditionError("synthetic backend not opened")
        cfg = self._config
        w = cfg.width or 1920
        h = cfg.height or 1080
        fps = cfg.fps or 30.0
        period = 1.0 / fps
        script = cfg.extra.get("script")
        loop_script = bool(cfg.extra.get("loop_script", True))
        realtime = bool(cfg.extra.get("realtime", True))
        idx = 0
        next_due = time.monotonic()
        while self._open:
            if script is not None:
                if idx >= len(script) and not loop_script:
                    return
                frame = np.asarray(script[idx % len(script)])
                gray = frame if frame.ndim == 2 else to_gray(frame)
            else:
                gray = self._test_card(w, h, idx, fps)
            yield CapturedFrame(
                gray=gray,
                recv_ts=time.monotonic(),
                frame_index=idx,
                meta={"backend": "synthetic", "transfer_function": cfg.transfer_function},
            )
            idx += 1
            if realtime:
                next_due += period
                delay = next_due - time.monotonic()
                if delay > 0:
                    time.sleep(delay)
                else:
                    next_due = time.monotonic()

    @staticmethod
    def _test_card(w: int, h: int, idx: int, fps: float) -> np.ndarray:
        gray = np.full((h, w), 96, dtype=np.uint8)
        # Orbiting bright square (motion cue).
        t = idx / fps
        cx = int(w / 2 + (w / 3) * np.cos(2 * np.pi * t / 4.0))
        cy = int(h / 2 + (h / 3) * np.sin(2 * np.pi * t / 4.0))
        s = max(8, h // 20)
        y0, y1 = max(0, cy - s), min(h, cy + s)
        x0, x1 = max(0, cx - s), min(w, cx + s)
        gray[y0:y1, x0:x1] = 255
        # Frame-index binary strip: 24 bits, MSB first, top-left; each bit is a
        # (h//36)² block — white=1, black=0. Decodable by tests and latency rigs.
        b = max(4, h // 36)
        for bit in range(24):
            val = 255 if (idx >> (23 - bit)) & 1 else 0
            gray[0:b, bit * b:(bit + 1) * b] = val
        return gray


# ── uvc ──────────────────────────────────────────────────────────────


class UvcBackend:
    """``cv2.VideoCapture`` backend — webcams and SDI/HDMI→USB3 converters."""

    def __init__(self) -> None:
        self._cap = None
        self._config: CaptureConfig | None = None

    def open(self, config: CaptureConfig) -> None:
        import cv2

        try:
            device: int | str = int(config.device)
        except ValueError:
            device = config.device  # URL / path source
        cap = cv2.VideoCapture(device)
        if not cap.isOpened():
            raise PreconditionError(
                f"UVC device {config.device!r} could not be opened — check the "
                "device index/path and that no other app holds the camera",
                details={"backend": "uvc", "device": config.device},
            )
        if config.width:
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, config.width)
        if config.height:
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, config.height)
        if config.fps:
            cap.set(cv2.CAP_PROP_FPS, config.fps)
        self._cap = cap
        self._config = config

    def close(self) -> None:
        if self._cap is not None:
            self._cap.release()
            self._cap = None

    def frames(self) -> Iterator[CapturedFrame]:
        if self._cap is None or self._config is None:
            raise PreconditionError("uvc backend not opened")
        idx = 0
        while self._cap is not None:
            ok, bgr = self._cap.read()
            recv_ts = time.monotonic()
            if not ok:
                return
            yield CapturedFrame(
                gray=to_gray(bgr),
                recv_ts=recv_ts,
                frame_index=idx,
                bgr=bgr,
                meta={
                    "backend": "uvc",
                    "device": self._config.device,
                    "transfer_function": self._config.transfer_function,
                },
            )
            idx += 1


# ── ndi (spike gate) ─────────────────────────────────────────────────


class NdiBackend:
    """NDI receive via ``cyndilib`` (optional dependency, spike per plan risk #2)."""

    def __init__(self) -> None:
        raise PreconditionError(
            "NDI backend requires the optional 'cyndilib' binding and the NDI "
            "runtime. Install with `pip install cyndilib` and the NDI SDK/Tools "
            "from https://ndi.video/ — then re-run. If unavailable, use an "
            "SDI/HDMI→USB3 converter with --backend uvc instead.",
            details={"backend": "ndi", "missing": "cyndilib", "status": "spike-pending"},
        )


# ── decklink (Phase 2 gate) ──────────────────────────────────────────


class DecklinkBackend:
    """Blackmagic DeckLink via the optional ``vpcal._vpcal_capture`` C++ module.

    Named like the solver module (``vpcal._vpcal_solver``) and installed into
    the ``vpcal`` package — a top-level name would collide with the shim's
    *source* directory ``src/vpcal_capture/``, which editable installs expose
    as a PEP 420 namespace package.
    """

    def __init__(self) -> None:
        try:
            from vpcal import _vpcal_capture  # noqa: F401
        except ImportError:
            raise PreconditionError(
                "DeckLink backend requires the vpcal._vpcal_capture native "
                "module, which is only built when a local Blackmagic DeckLink "
                "SDK is present. Download the SDK from "
                "https://www.blackmagicdesign.com/developer/, set "
                "DECKLINK_SDK_DIR to its include path, and reinstall vpcal "
                "(pip install -e .).",
                details={"backend": "decklink", "missing": "vpcal._vpcal_capture",
                         "hint": "set DECKLINK_SDK_DIR and reinstall"},
            ) from None
        self._impl = None
        self._config: CaptureConfig | None = None

    def open(self, config: CaptureConfig) -> None:
        from vpcal import _vpcal_capture

        self._impl = _vpcal_capture.DeckLinkInput(int(config.device))
        self._impl.start()
        self._config = config

    def close(self) -> None:
        if self._impl is not None:
            self._impl.stop()
            self._impl = None

    def frames(self) -> Iterator[CapturedFrame]:
        if self._impl is None or self._config is None:
            raise PreconditionError("decklink backend not opened")
        from vpcal.core.v210 import v210_to_gray16

        idx = 0
        while self._impl is not None:
            raw = self._impl.next_frame()  # blocking; None on stop
            recv_ts = time.monotonic()
            if raw is None:
                return
            if raw.pixel_format == "v210":
                gray = v210_to_gray16(raw.data, raw.width, raw.height, raw.row_bytes)
            else:  # 8-bit UYVY: luma is every second byte starting at offset 1
                buf = np.frombuffer(raw.data, dtype=np.uint8)
                gray = buf.reshape(raw.height, raw.row_bytes)[:, 1:raw.width * 2:2].copy()
            yield CapturedFrame(
                gray=gray,
                recv_ts=recv_ts,
                timecode=raw.timecode or None,
                frame_index=idx,
                meta={
                    "backend": "decklink",
                    "pixel_format": raw.pixel_format,
                    "transfer_function": self._config.transfer_function,
                },
            )
            idx += 1


_BACKENDS: dict[str, type] = {
    "synthetic": SyntheticBackend,
    "uvc": UvcBackend,
    "ndi": NdiBackend,
    "decklink": DecklinkBackend,
}


def open_backend(config: CaptureConfig) -> CaptureBackend:
    """Instantiate + open the backend named in ``config.backend``."""
    cls = _BACKENDS.get(config.backend)
    if cls is None:
        raise ArgumentError(
            f"unknown capture backend {config.backend!r}; expected one of {BACKENDS}"
        )
    backend = cls()
    backend.open(config)
    return backend


__all__ = [
    "BACKENDS",
    "NDI_HX_REFUSAL",
    "CaptureConfig",
    "CapturedFrame",
    "CaptureBackend",
    "SyntheticBackend",
    "UvcBackend",
    "NdiBackend",
    "DecklinkBackend",
    "open_backend",
    "to_gray",
]
