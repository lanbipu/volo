"""Capture backend abstraction (core/capture_backend.py)."""

from __future__ import annotations

import itertools

import numpy as np
import pytest

from vpcal.core.capture_backend import (
    CaptureConfig,
    DecklinkBackend,
    SyntheticBackend,
    open_backend,
    parse_decklink_device,
)
from vpcal.core.errors import ArgumentError, PreconditionError


def _take(backend, n):
    return list(itertools.islice(backend.frames(), n))


def test_synthetic_shapes_and_indices():
    b = SyntheticBackend()
    b.open(CaptureConfig(backend="synthetic", width=320, height=180, fps=240,
                         extra={"realtime": False}))
    frames = _take(b, 5)
    b.close()
    assert [f.frame_index for f in frames] == [0, 1, 2, 3, 4]
    for f in frames:
        assert f.gray.shape == (180, 320)
        assert f.gray.dtype == np.uint8
        assert f.meta["backend"] == "synthetic"
        assert f.recv_ts > 0


def test_synthetic_frame_index_strip_is_decodable():
    b = SyntheticBackend()
    b.open(CaptureConfig(backend="synthetic", width=640, height=360, fps=240,
                         extra={"realtime": False}))
    frames = _take(b, 3)
    b.close()
    cell = max(4, 360 // 36)
    for f in frames:
        bits = 0
        for i in range(24):
            block = f.gray[0:cell, i * cell:(i + 1) * cell]
            bits = (bits << 1) | (1 if block.mean() > 127 else 0)
        assert bits == f.frame_index


def test_synthetic_script_playback_no_loop():
    imgs = [np.full((10, 10), v, dtype=np.uint8) for v in (10, 20, 30)]
    b = SyntheticBackend()
    b.open(CaptureConfig(backend="synthetic",
                         extra={"script": imgs, "loop_script": False, "realtime": False}))
    frames = list(b.frames())
    b.close()
    assert len(frames) == 3
    assert [int(f.gray[0, 0]) for f in frames] == [10, 20, 30]


def test_open_backend_unknown_name():
    with pytest.raises(ArgumentError, match="unknown capture backend"):
        open_backend(CaptureConfig(backend="st2110"))


def test_ndi_backend_guides_installation(monkeypatch):
    from vpcal.core import ndi

    def missing():
        raise PreconditionError(
            "NDI backend requires cyndilib",
            details={"backend": "ndi", "missing": "cyndilib"},
        )

    monkeypatch.setattr(ndi, "load_cyndilib", missing)
    with pytest.raises(PreconditionError, match="cyndilib"):
        open_backend(CaptureConfig(backend="ndi"))


def test_decklink_backend_guides_sdk_setup():
    # The native shim's presence is environmental (built only against a local
    # SDK). When it is built, opening reaches the driver rather than the guided
    # error, so this regression only applies when the module is absent.
    try:
        from vpcal import _vpcal_capture  # noqa: F401
    except ImportError:
        pass
    else:
        pytest.skip("vpcal._vpcal_capture is built in this environment")
    with pytest.raises(PreconditionError, match="DECKLINK_SDK_DIR"):
        open_backend(CaptureConfig(backend="decklink"))


@pytest.mark.parametrize(
    "device,expected",
    [
        ("0", (0, "")),
        ("0:sdi", (0, "sdi")),
        ("1:hdmi", (1, "hdmi")),
        ("2:optical-sdi", (2, "optical_sdi")),
        (" 3 : HDMI ", (3, "hdmi")),
    ],
)
def test_parse_decklink_device_valid(device, expected):
    assert parse_decklink_device(device) == expected


@pytest.mark.parametrize("device", ["abc", "0:", "1:usb", "x:sdi", "0:ethernet"])
def test_parse_decklink_device_invalid(device):
    with pytest.raises(ArgumentError):
        parse_decklink_device(device)


class _FakeRaw:
    def __init__(self, pixel_format, width=4, height=2, row_bytes=8, frame_rate=0.0):
        self.pixel_format = pixel_format
        self.width = width
        self.height = height
        self.row_bytes = row_bytes
        self.data = b"\x00" * (row_bytes * height)
        self.timecode = ""
        self.frame_rate = frame_rate


class _FakeImpl:
    """Minimal stand-in for _vpcal_capture.DeckLinkInput."""

    def __init__(self, frames):
        self._frames = list(frames)

    def next_frame(self):
        return self._frames.pop(0) if self._frames else None

    def stop(self):
        pass


def _decklink_with_impl(impl):
    b = DecklinkBackend.__new__(DecklinkBackend)  # bypass the native import guard
    b._impl = impl
    b._config = CaptureConfig(backend="decklink", device="0")
    return b


@pytest.mark.parametrize("pixel_format", ["r210", "unknown"])
def test_decklink_frames_reject_non_yuv(pixel_format):
    b = _decklink_with_impl(_FakeImpl([_FakeRaw(pixel_format)]))
    with pytest.raises(PreconditionError, match="not supported for calibration"):
        list(b.frames())


def test_decklink_frames_accept_uyvy():
    b = _decklink_with_impl(_FakeImpl([_FakeRaw("uyvy")]))
    frames = _take(b, 1)
    assert frames[0].gray.shape == (2, 4)
    assert frames[0].meta["pixel_format"] == "uyvy"
    # No detected rate yet (0.0) → no frame_rate key, so the CLI fps fallback holds.
    assert "frame_rate" not in frames[0].meta


def test_decklink_frames_surface_detected_frame_rate():
    b = _decklink_with_impl(_FakeImpl([_FakeRaw("uyvy", frame_rate=59.94)]))
    frames = _take(b, 1)
    assert frames[0].meta["frame_rate"] == 59.94


def test_uvc_backend_bad_device_raises():
    with pytest.raises(PreconditionError, match="could not be opened"):
        open_backend(CaptureConfig(backend="uvc", device="/nonexistent/video-device"))
