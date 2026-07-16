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


def _bt709_ycbcr_to_bgr(y: np.ndarray, cb: np.ndarray, cr: np.ndarray) -> np.ndarray:
    """BT.709 video-range Y'CbCr (8-bit scale, float ok) → 8-bit BGR.

    HD NDI senders are Rec.709; OpenCV's built-in YUV paths are BT.601 and
    visibly shift saturated colours, so the matrix is applied by hand.
    """
    yl = 1.164384 * (y.astype(np.float32) - 16.0)
    cb = cb.astype(np.float32) - 128.0
    cr = cr.astype(np.float32) - 128.0
    b = yl + 2.112402 * cb
    g = yl - 0.213249 * cb - 0.532909 * cr
    r = yl + 1.792741 * cr
    return np.clip(np.stack([b, g, r], axis=-1), 0.0, 255.0).astype(np.uint8)


def uyvy_to_bgr(data: Any, width: int, height: int, stride: int) -> np.ndarray:
    """Convert a packed 8-bit UYVY frame to BGR (BT.709 video range)."""
    raw = np.frombuffer(data, dtype=np.uint8, count=height * stride)
    rows = raw.reshape(height, stride)[:, : width * 2]
    y = rows[:, 1::2]
    cb = np.repeat(rows[:, 0::4], 2, axis=1)[:, :width]
    cr = np.repeat(rows[:, 2::4], 2, axis=1)[:, :width]
    return _bt709_ycbcr_to_bgr(y, cb, cr)


def p216_to_bgr(data: Any, width: int, height: int, stride: int) -> np.ndarray:
    """Convert semi-planar 16-bit P216/PA16 to 8-bit BGR (BT.709 video range).

    Plane 0 is 16-bit Y, plane 1 is interleaved 16-bit CbCr (4:2:2). The
    16-bit values enter the matrix at full precision (scaled to 8-bit range
    as floats) so 10/16-bit gradation survives until the final 8-bit preview
    quantise. PA16's trailing alpha plane is simply ignored.
    """
    buf = np.frombuffer(data, dtype=np.uint8)
    y = buf[: height * stride].view("<u2").reshape(height, stride // 2)[:, :width]
    if buf.size >= height * stride * 2:
        cbcr = (buf[height * stride: height * stride * 2]
                .view("<u2").reshape(height, stride // 2)[:, :width])
        cb_s, cr_s = cbcr[:, 0::2], cbcr[:, 1::2]
        if cr_s.shape[1] == 0:  # degenerate 1px-wide frame: no Cr sample
            cr_s = np.full_like(cb_s, 128 << 8)
        elif cr_s.shape[1] < cb_s.shape[1]:  # odd sample count: extend edge
            cr_s = np.concatenate([cr_s, cr_s[:, -1:]], axis=1)
        cb = np.repeat(cb_s, 2, axis=1)[:, :width]
        cr = np.repeat(cr_s, 2, axis=1)[:, :width]
    else:  # luma-only buffer (e.g. synthetic test frames) → neutral chroma
        cb = cr = np.full_like(y, 128 << 8, dtype=np.uint16)
    scale = np.float32(1.0 / 256.0)
    return _bt709_ycbcr_to_bgr(y.astype(np.float32) * scale,
                               cb.astype(np.float32) * scale,
                               cr.astype(np.float32) * scale)
