"""Capture backend abstraction (core/capture_backend.py)."""

from __future__ import annotations

import itertools

import numpy as np
import pytest

from vpcal.core.capture_backend import (
    CaptureConfig,
    SyntheticBackend,
    open_backend,
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


def test_ndi_backend_guides_installation():
    with pytest.raises(PreconditionError, match="cyndilib"):
        open_backend(CaptureConfig(backend="ndi"))


def test_decklink_backend_guides_sdk_setup():
    # No vpcal_capture module in the test venv → guided precondition error.
    with pytest.raises(PreconditionError, match="DECKLINK_SDK_DIR"):
        open_backend(CaptureConfig(backend="decklink"))


def test_uvc_backend_bad_device_raises():
    with pytest.raises(PreconditionError, match="could not be opened"):
        open_backend(CaptureConfig(backend="uvc", device="/nonexistent/video-device"))
