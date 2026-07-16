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
``ndi``        NDI SDK discovery/receive via the optional ``cyndilib`` binding;
               preserves full-NDI P216 luma at 16-bit and rejects NDI|HX for calibration.
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
    hardware_time_s: float | None = None
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
    """NDI SDK receive through the optional ``cyndilib`` binding.

    cyndilib 0.1.1 direct receive does not deliver frames with the current macOS
    NDI runtime, while its SDK FrameSync path does. FrameSync is paced at the
    negotiated source rate; static NDI senders may intentionally repeat a frame.
    """

    def __init__(self) -> None:
        from vpcal.core.ndi import load_cyndilib

        self._api = load_cyndilib()
        self._receiver = None
        self._video_frame = None
        self._config: CaptureConfig | None = None

    def open(self, config: CaptureConfig) -> None:
        timeout_s = float(config.extra.get("connect_timeout_s", 3.0))
        finder = self._api.Finder()
        finder.open()
        try:
            # Poll until the deadline instead of a single wait_for_sources()
            # call: wait_for_sources() returns on the *first* change event, and
            # senders that announce late (e.g. iOS NDI|HX apps whose mDNS burst
            # only lasts a few seconds) would otherwise miss a one-shot window.
            deadline = time.monotonic() + max(0.0, timeout_s)
            names = finder.get_source_names()
            while config.device not in names:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                finder.wait_for_sources(min(0.5, remaining))
                names = finder.get_source_names()
            if config.device not in names:
                raise PreconditionError(
                    f"NDI source not found: {config.device}",
                    details={
                        "backend": "ndi",
                        "reason": "source_not_found",
                        "source_name": config.device,
                        "available": names,
                    },
                )
            source = finder.get_source(config.device)
            video_frame = self._api.VideoFrameSync()
            receiver = self._api.Receiver(
                color_format=self._api.RecvColorFormat.best,
                bandwidth=self._api.RecvBandwidth.highest,
                allow_video_fields=True,
                recv_name="vpcal",
            )
            receiver.frame_sync.set_video_frame(video_frame)
            try:
                receiver.connect_to(source)
            except Exception:
                receiver.disconnect()
                raise
        finally:
            finder.close()
        self._receiver = receiver
        self._video_frame = video_frame
        self._config = config

    def close(self) -> None:
        if self._receiver is not None:
            self._receiver.disconnect()
        self._receiver = None
        self._video_frame = None
        self._config = None

    @staticmethod
    def _fourcc_name(value: Any) -> str:
        name = getattr(value, "name", None)
        return str(name if name is not None else value).split(".")[-1].upper()

    def frames(self) -> Iterator[CapturedFrame]:
        if self._receiver is None or self._video_frame is None or self._config is None:
            raise PreconditionError("NDI backend not opened")
        from vpcal.core.ndi import p216_luma16, p216_to_bgr, uyvy_luma, uyvy_to_bgr

        receiver = self._receiver
        video_frame = self._video_frame
        config = self._config
        idle_timeout_s = float(config.extra.get("idle_timeout_s", 5.0))
        poll_interval_s = float(config.extra.get("poll_interval_s", 1.0 / 120.0))
        started_waiting = time.monotonic()
        disconnected_since: float | None = None
        last_yield = 0.0
        idx = 0

        while self._receiver is receiver:
            receiver.frame_sync.capture_video(self._api.FrameFormat.progressive)
            recv_ts = time.monotonic()  # stamp arrival before receiver pacing sleep
            now = recv_ts
            width, height = video_frame.get_resolution()
            if width <= 0 or height <= 0:
                if now - started_waiting >= idle_timeout_s:
                    raise PreconditionError(
                        f"no video frames from NDI source: {config.device}",
                        details={"backend": "ndi", "reason": "no_signal",
                                 "source_name": config.device},
                    )
                if poll_interval_s > 0:
                    time.sleep(poll_interval_s)
                continue

            timestamp_s = float(video_frame.get_timestamp_posix())
            timecode_s = float(video_frame.get_timecode_posix())
            connections = receiver.get_num_connections() if hasattr(
                receiver, "get_num_connections"
            ) else 1
            if connections <= 0:
                disconnected_since = disconnected_since or now
                if now - disconnected_since >= idle_timeout_s:
                    raise PreconditionError(
                        f"NDI source disconnected: {config.device}",
                        details={"backend": "ndi", "reason": "no_signal",
                                 "source_name": config.device},
                    )
            else:
                disconnected_since = None

            fourcc = self._fourcc_name(video_frame.get_fourcc())
            stride = int(video_frame.get_line_stride())
            data = video_frame.get_array()
            if fourcc in {"P216", "PA16"}:
                gray = p216_luma16(data, width, height, stride)
                bgr = p216_to_bgr(data, width, height, stride)
                bit_depth = 16
                is_hx = False
            elif fourcc == "UYVY":
                is_hx = True
                if not config.extra.get("allow_hx", False):
                    raise PreconditionError(
                        NDI_HX_REFUSAL,
                        details={"backend": "ndi", "reason": "ndi_hx",
                                 "source_name": config.device, "fourcc": fourcc},
                    )
                gray = uyvy_luma(data, width, height, stride)
                bgr = uyvy_to_bgr(data, width, height, stride)
                bit_depth = 8
            else:
                raise PreconditionError(
                    f"unsupported NDI video format: {fourcc}",
                    details={"backend": "ndi", "reason": "unsupported_format",
                             "source_name": config.device, "fourcc": fourcc},
                )

            frame_rate = float(video_frame.get_frame_rate())
            interval_s = 1.0 / frame_rate if frame_rate > 0 else 1.0 / 30.0
            remaining_s = interval_s - (now - last_yield) if last_yield else 0.0
            if remaining_s > 0:
                time.sleep(remaining_s)
            last_yield = now
            yield CapturedFrame(
                gray=gray,
                bgr=bgr,
                recv_ts=recv_ts,
                timecode=f"{timecode_s:.7f}" if timecode_s > 0 else None,
                frame_index=idx,
                meta={
                    "backend": "ndi",
                    "source_name": config.device,
                    "width": width,
                    "height": height,
                    "frame_rate": frame_rate,
                    "fourcc": fourcc,
                    "is_hx": is_hx,
                    "bit_depth": bit_depth,
                    "timestamp_s": timestamp_s,
                    "transfer_function": config.transfer_function,
                },
            )
            idx += 1


# ── decklink (Phase 2 gate) ──────────────────────────────────────────

# Capture-capable connector ids (a subset of BMDVideoConnection; matches the
# C++ shim's connector map). Used for a fast offline validation of a device
# spec — the shim re-validates against the real card's advertised connectors.
DECKLINK_CONNECTORS = ("sdi", "hdmi", "optical_sdi", "component", "composite", "svideo")

# Connector id → human display name. Keyed off DECKLINK_CONNECTORS so validation
# (this module) and display (the CLI `enumerate`) can never drift apart — adding
# a connector to the tuple above surfaces here as a KeyError, not a silent ugly
# fallback label in the UI.
_DECKLINK_CONNECTOR_LABELS = {
    "sdi": "SDI", "hdmi": "HDMI", "optical_sdi": "Optical SDI",
    "component": "Component", "composite": "Composite", "svideo": "S-Video",
}
DECKLINK_CONNECTOR_LABELS = {c: _DECKLINK_CONNECTOR_LABELS[c] for c in DECKLINK_CONNECTORS}

_DECKLINK_MISSING_MODULE = (
    "DeckLink backend requires the vpcal._vpcal_capture native module, which is "
    "only built when a local Blackmagic DeckLink SDK is present. Download the "
    "SDK from https://www.blackmagicdesign.com/developer/, set DECKLINK_SDK_DIR "
    "to its include path, and reinstall vpcal (pip install -e .)."
)


def _import_vpcal_capture():
    """Import the native shim or raise the shared guided PreconditionError."""
    try:
        from vpcal import _vpcal_capture
    except ImportError:
        raise PreconditionError(
            _DECKLINK_MISSING_MODULE,
            details={"backend": "decklink", "missing": "vpcal._vpcal_capture",
                     "hint": "set DECKLINK_SDK_DIR and reinstall"},
        ) from None
    return _vpcal_capture


def parse_decklink_device(device: str) -> tuple[int, str]:
    """Parse a DeckLink device spec into ``(index, connector)``.

    Accepts ``"0"`` (index only), or ``"0:sdi"`` / ``"1:hdmi"`` (index + input
    connector). The index must be an integer; the connector is lower-cased and
    ``-``→``_`` normalised, and must be one of :data:`DECKLINK_CONNECTORS`.
    A missing connector returns ``""`` (the card's current input is kept).

    Pure function — no native module needed, so it is unit-testable on any host.
    """
    raw = str(device).strip()
    index_part, sep, connector_part = raw.partition(":")
    try:
        index = int(index_part)
    except ValueError:
        raise ArgumentError(
            f"invalid DeckLink device {device!r}: the index must be an integer "
            "(examples: '0', '0:sdi', '1:hdmi')",
            details={"backend": "decklink", "device": device},
        ) from None
    if not sep:
        return index, ""
    connector = connector_part.strip().lower().replace("-", "_")
    if connector not in DECKLINK_CONNECTORS:
        raise ArgumentError(
            f"invalid DeckLink connector {connector_part!r}: expected one of "
            f"{DECKLINK_CONNECTORS} (examples: '0:sdi', '1:hdmi')",
            details={"backend": "decklink", "device": device,
                     "connector": connector_part},
        )
    return index, connector


def list_decklink_devices() -> list[dict[str, Any]]:
    """Enumerate attached DeckLink devices with their input connectors.

    Each entry is ``{"index": int, "name": str, "connectors": [str, ...]}``.
    Raises the guided PreconditionError when the native module was not built.
    """
    return _import_vpcal_capture().list_devices()


class DecklinkBackend:
    """Blackmagic DeckLink via the optional ``vpcal._vpcal_capture`` C++ module.

    Named like the solver module (``vpcal._vpcal_solver``) and installed into
    the ``vpcal`` package — a top-level name would collide with the shim's
    *source* directory ``src/vpcal_capture/``, which editable installs expose
    as a PEP 420 namespace package.
    """

    def __init__(self) -> None:
        _import_vpcal_capture()  # fail fast with the guided error if unbuilt
        self._impl = None
        self._config: CaptureConfig | None = None

    def open(self, config: CaptureConfig) -> None:
        vpcal_capture = _import_vpcal_capture()
        index, connector = parse_decklink_device(config.device)
        try:
            self._impl = vpcal_capture.DeckLinkInput(index, connector)
            self._impl.start()
        except RuntimeError as exc:
            # The C++ shim throws std::runtime_error (→ RuntimeError) for
            # out-of-range index, output-only cards, and connector/select
            # failures — surface them as guided preconditions.
            raise PreconditionError(
                str(exc),
                details={"backend": "decklink", "device": config.device},
            ) from exc
        self._config = config

    def close(self) -> None:
        if self._impl is not None:
            self._impl.stop()
            self._impl = None

    def frames(self) -> Iterator[CapturedFrame]:
        if self._impl is None or self._config is None:
            raise PreconditionError("decklink backend not opened")
        from vpcal.core.ndi import uyvy_to_bgr
        from vpcal.core.v210 import v210_to_bgr16, v210_to_gray16

        # Colour decode is monitor-only (preview sink) — the calibration chain
        # consumes luma; skip the extra full-frame YCbCr→BGR work otherwise.
        want_bgr = bool(self._config.extra.get("want_bgr"))
        # Monitor mode: never give up on signal loss — the DeckLink input stays
        # started, so when the source comes back (camera power-cycle) frames
        # resume via the callback without reopening the device.
        keep_alive = bool(self._config.extra.get("keep_alive"))
        idx = 0
        misses = 0
        seen_first = False
        hardware_origin: float | None = None
        monotonic_origin: float | None = None
        while self._impl is not None:
            raw = self._impl.next_frame()  # blocking; None on stop/timeout
            dequeue_ts = time.monotonic()
            if raw is None:
                # A momentary signal drop (unplug, source pause) yields None per
                # timeout; keep the stream alive across a few misses so a brief
                # glitch doesn't kill a pull/session. A real stop() drains
                # immediately, so these misses pass in quick succession.
                #
                # Before the first frame, tolerate a longer wait: locking a 4K /
                # high-frame-rate signal drives a PauseStreams→EnableVideoInput→
                # StartStreams renegotiation (VideoInputFormatChanged) that can
                # take several seconds, so a 5-miss (~5s) cap here would report a
                # genuinely-connected source as "nosignal". Once frames flow, a
                # >5s gap is a real drop. (The Rust probe caps total wall-clock.)
                misses += 1
                if not keep_alive and misses >= (5 if seen_first else 15):
                    return
                continue
            misses = 0
            seen_first = True
            hardware_time_s = float(getattr(raw, "hardware_time_s", 0.0) or 0.0)
            if hardware_time_s > 0:
                if hardware_origin is None:
                    hardware_origin = hardware_time_s
                    monotonic_origin = dequeue_ts
                recv_ts = float(monotonic_origin + hardware_time_s - hardware_origin)
            else:
                recv_ts = dequeue_ts
            bgr = None
            if raw.pixel_format == "v210":
                gray = v210_to_gray16(raw.data, raw.width, raw.height, raw.row_bytes)
                if want_bgr:
                    bgr = v210_to_bgr16(raw.data, raw.width, raw.height, raw.row_bytes)
            elif raw.pixel_format == "uyvy":
                # 8-bit UYVY: luma is every second byte starting at offset 1.
                buf = np.frombuffer(raw.data, dtype=np.uint8)
                gray = buf.reshape(raw.height, raw.row_bytes)[:, 1:raw.width * 2:2].copy()
                if want_bgr:
                    bgr = uyvy_to_bgr(raw.data, raw.width, raw.height, raw.row_bytes)
            else:
                # r210 (RGB444) / unknown: the calibration chain only unpacks
                # YCbCr. An RGB signal (common on HDMI from laptops/players)
                # would be silently misread — refuse with source guidance.
                raise PreconditionError(
                    f"DeckLink source pixel format {raw.pixel_format!r} is not "
                    "supported for calibration capture. Set the source to YCbCr "
                    "(YUV) output, or feed the signal over SDI.",
                    details={"backend": "decklink", "pixel_format": raw.pixel_format,
                             "reason": "unsupported_format"},
                )
            meta = {
                "backend": "decklink",
                "pixel_format": raw.pixel_format,
                "bit_depth": 10 if raw.pixel_format == "v210" else 8,
                "transfer_function": self._config.transfer_function,
            }
            # Only surface a real detected rate — the C++ shim reports 0.0 until
            # VideoInputFormatChanged fires, and a 0.0 key would clobber the CLI's
            # `meta.get("frame_rate", fps)` fallback with a bogus fps.
            if raw.frame_rate > 0:
                meta["frame_rate"] = raw.frame_rate
            yield CapturedFrame(
                gray=gray,
                recv_ts=recv_ts,
                hardware_time_s=hardware_time_s if hardware_time_s > 0 else None,
                timecode=raw.timecode or None,
                frame_index=idx,
                bgr=bgr,
                meta=meta,
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


def list_uvc_devices(max_index: int = 8) -> list[dict[str, Any]]:
    """Probe UVC indices without inventing device names."""
    import cv2

    devices = []
    for index in range(max_index + 1):
        cap = cv2.VideoCapture(index)
        try:
            available = bool(cap.isOpened())
            devices.append({
                "index": index,
                "available": available,
                "width": int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) if available else 0,
                "height": int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) if available else 0,
                "fps": float(cap.get(cv2.CAP_PROP_FPS)) if available else 0.0,
            })
        finally:
            cap.release()
    return devices


__all__ = [
    "BACKENDS",
    "DECKLINK_CONNECTORS",
    "DECKLINK_CONNECTOR_LABELS",
    "NDI_HX_REFUSAL",
    "CaptureConfig",
    "CapturedFrame",
    "CaptureBackend",
    "SyntheticBackend",
    "UvcBackend",
    "NdiBackend",
    "DecklinkBackend",
    "list_decklink_devices",
    "parse_decklink_device",
    "open_backend",
    "to_gray",
    "list_uvc_devices",
]
