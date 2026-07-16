"""Small, mockable adapter around the optional :mod:`cyndilib` NDI binding."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import numpy as np

from vpcal.core.errors import PreconditionError


def load_cyndilib() -> SimpleNamespace:
    """Load cyndilib and expose only the symbols used by the capture backend."""
    try:
        from cyndilib.finder import Finder
        from cyndilib.receiver import Receiver
        from cyndilib.video_frame import VideoFrameSync
        from cyndilib.wrapper import FrameFormat, RecvBandwidth, RecvColorFormat
    except (ImportError, OSError) as exc:
        raise PreconditionError(
            "NDI backend requires the optional 'cyndilib' binding and the NDI "
            "runtime. Install with `pip install cyndilib`; current wheels bundle "
            "the NDI runtime on supported platforms. If unavailable, use an "
            "SDI/HDMI→USB3 converter with --backend uvc.",
            details={
                "backend": "ndi",
                "missing": "cyndilib",
                "cause": str(exc),
            },
        ) from None
    return SimpleNamespace(
        Finder=Finder,
        Receiver=Receiver,
        VideoFrameSync=VideoFrameSync,
        FrameFormat=FrameFormat,
        RecvBandwidth=RecvBandwidth,
        RecvColorFormat=RecvColorFormat,
    )


def enumerate_sources(timeout_s: float = 3.0) -> list[dict[str, str]]:
    """Discover NDI sources visible to the SDK during ``timeout_s`` seconds."""
    api = load_cyndilib()
    finder = api.Finder()
    finder.open()
    try:
        finder.wait_for_sources(max(0.0, timeout_s))
        return [{"name": name} for name in sorted(finder.get_source_names())]
    finally:
        finder.close()


def uyvy_luma(data: Any, width: int, height: int, stride: int) -> np.ndarray:
    """Copy the 8-bit Y plane from a packed UYVY frame."""
    raw = np.frombuffer(data, dtype=np.uint8, count=height * stride)
    rows = raw.reshape(height, stride)
    return rows[:, 1:width * 2:2].copy()


def p216_luma16(data: Any, width: int, height: int, stride: int) -> np.ndarray:
    """Copy the left-aligned 16-bit Y plane from P216/PA16 frame storage."""
    y_bytes = np.frombuffer(data, dtype=np.uint8, count=height * stride)
    rows = y_bytes.view("<u2").reshape(height, stride // 2)
    return rows[:, :width].copy()


def uyvy_to_bgr(data: Any, width: int, height: int, stride: int) -> np.ndarray:
    """Convert a packed 8-bit UYVY frame to BGR (preview only — BT.601 matrix)."""
    import cv2

    raw = np.frombuffer(data, dtype=np.uint8, count=height * stride)
    packed = raw.reshape(height, stride)[:, : width * 2].reshape(height, width, 2)
    return cv2.cvtColor(packed, cv2.COLOR_YUV2BGR_UYVY)


def p216_to_bgr(data: Any, width: int, height: int, stride: int) -> np.ndarray:
    """Convert semi-planar 16-bit P216/PA16 to 8-bit BGR (preview only).

    Plane 0 is 16-bit Y, plane 1 is interleaved 16-bit CbCr (4:2:2). Both are
    truncated to their top 8 bits and repacked as UYVY so the conversion shares
    OpenCV's UYVY path (BT.601, like the UVC/UYVY previews). PA16's trailing
    alpha plane is simply ignored.
    """
    import cv2

    buf = np.frombuffer(data, dtype=np.uint8, count=height * stride * 2)
    y = buf[: height * stride].view("<u2").reshape(height, stride // 2)[:, :width]
    cbcr = buf[height * stride:].view("<u2").reshape(height, stride // 2)[:, :width]
    uyvy = np.empty((height, width, 2), np.uint8)
    uyvy[:, :, 0] = (cbcr >> 8).astype(np.uint8)
    uyvy[:, :, 1] = (y >> 8).astype(np.uint8)
    return cv2.cvtColor(uyvy, cv2.COLOR_YUV2BGR_UYVY)
