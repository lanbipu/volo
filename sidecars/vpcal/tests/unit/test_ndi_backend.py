"""NDI SDK backend tests with a deterministic cyndilib facade."""

from __future__ import annotations

import enum
import itertools
from fractions import Fraction
from types import SimpleNamespace

import numpy as np
import pytest

from vpcal.core import ndi
from vpcal.core.capture_backend import CaptureConfig, NDI_HX_REFUSAL, open_backend
from vpcal.core.errors import PreconditionError


class FourCC(enum.Enum):
    P216 = 1
    PA16 = 2
    UYVY = 3


class FakeVideoFrame:
    def __init__(self):
        self.frame = None

    def get_resolution(self):
        return (0, 0) if self.frame is None else (self.frame["width"], self.frame["height"])

    def get_fourcc(self):
        return self.frame["fourcc"]

    def get_line_stride(self):
        return self.frame["stride"]

    def get_array(self):
        return self.frame["data"]

    def get_timestamp_posix(self):
        return self.frame.get("timestamp", 0.0)

    def get_timecode_posix(self):
        return self.frame.get("timecode", 0.0)

    def get_frame_rate(self):
        return self.frame.get("fps", Fraction(30, 1))


def fake_api(frames=(), names=("CAMERA (Program)",), connect_error=None):
    scripted_frames = list(frames)
    receivers = []

    class Finder:
        def open(self):
            pass

        def close(self):
            pass

        def wait_for_sources(self, _timeout):
            return bool(names)

        def get_source_names(self):
            return list(names)

        def get_source(self, name):
            return SimpleNamespace(name=name)

    class FrameSync:
        def __init__(self):
            self.video_frame = None
            self.frames = iter(scripted_frames)

        def set_video_frame(self, video_frame):
            self.video_frame = video_frame

        def capture_video(self, _format):
            try:
                self.video_frame.frame = next(self.frames)
            except StopIteration:
                pass

    class Receiver:
        def __init__(self, **_kwargs):
            self.frame_sync = FrameSync()
            self.disconnected = False
            receivers.append(self)

        def connect_to(self, _source):
            if connect_error is not None:
                raise connect_error

        def disconnect(self):
            self.disconnected = True

        def get_num_connections(self):
            return 0 if self.disconnected else 1

    return SimpleNamespace(
        Finder=Finder,
        Receiver=Receiver,
        VideoFrameSync=FakeVideoFrame,
        FrameFormat=SimpleNamespace(progressive="progressive"),
        RecvColorFormat=SimpleNamespace(best="best"),
        RecvBandwidth=SimpleNamespace(highest="highest"),
        receivers=receivers,
    )


def p216_frame(values, *, timestamp=1.0):
    y = np.asarray(values, dtype="<u2")
    chroma = np.zeros_like(y)
    return {
        "width": y.shape[1], "height": y.shape[0], "stride": y.shape[1] * 2,
        "fourcc": FourCC.P216, "data": np.concatenate([y.ravel(), chroma.ravel()]).view(np.uint8),
        "timestamp": timestamp, "timecode": timestamp, "fps": Fraction(60, 1),
    }


def uyvy_frame(rows, *, timestamp=1.0):
    data = np.asarray(rows, dtype=np.uint8)
    return {
        "width": data.shape[1] // 2, "height": data.shape[0], "stride": data.shape[1],
        "fourcc": FourCC.UYVY, "data": data.ravel(), "timestamp": timestamp,
        "timecode": timestamp, "fps": Fraction(30, 1),
    }


def test_enumerate_sources(monkeypatch):
    monkeypatch.setattr(ndi, "load_cyndilib", lambda: fake_api(names=("Z (B)", "A (A)")))
    assert ndi.enumerate_sources(0.0) == [{"name": "A (A)"}, {"name": "Z (B)"}]


def test_p216_luma_is_left_aligned_uint16(monkeypatch):
    values = np.array([[0x1000, 0x2340], [0xABC0, 0xFFF0]], dtype=np.uint16)
    monkeypatch.setattr(ndi, "load_cyndilib", lambda: fake_api([p216_frame(values)]))
    backend = open_backend(CaptureConfig(backend="ndi", device="CAMERA (Program)"))
    frame = next(backend.frames())
    backend.close()
    np.testing.assert_array_equal(frame.gray, values)
    assert frame.gray.dtype == np.uint16
    assert frame.meta["fourcc"] == "P216"
    assert frame.meta["bit_depth"] == 16
    assert frame.meta["is_hx"] is False


def test_uyvy_luma_values_when_preview_allows_hx(monkeypatch):
    rows = np.array([[10, 20, 30, 40], [50, 60, 70, 80]], dtype=np.uint8)
    monkeypatch.setattr(ndi, "load_cyndilib", lambda: fake_api([uyvy_frame(rows)]))
    backend = open_backend(CaptureConfig(
        backend="ndi", device="CAMERA (Program)", extra={"allow_hx": True},
    ))
    frame = next(backend.frames())
    backend.close()
    np.testing.assert_array_equal(frame.gray, [[20, 40], [60, 80]])
    assert frame.gray.dtype == np.uint8
    assert frame.meta["is_hx"] is True


def test_uyvy_is_rejected_for_calibration(monkeypatch):
    monkeypatch.setattr(
        ndi, "load_cyndilib",
        lambda: fake_api([uyvy_frame([[10, 20, 30, 40]])]),
    )
    backend = open_backend(CaptureConfig(backend="ndi", device="CAMERA (Program)"))
    with pytest.raises(PreconditionError, match=NDI_HX_REFUSAL) as exc:
        next(backend.frames())
    assert exc.value.details["reason"] == "ndi_hx"
    backend.close()


def test_idle_timeout_is_structured_no_signal(monkeypatch):
    monkeypatch.setattr(ndi, "load_cyndilib", lambda: fake_api())
    backend = open_backend(CaptureConfig(
        backend="ndi", device="CAMERA (Program)",
        extra={"idle_timeout_s": 0.0, "poll_interval_s": 0.0},
    ))
    with pytest.raises(PreconditionError) as exc:
        next(backend.frames())
    assert exc.value.details["reason"] == "no_signal"
    backend.close()


def test_connect_failure_disconnects_receiver(monkeypatch):
    api = fake_api(connect_error=RuntimeError("connect refused"))
    monkeypatch.setattr(ndi, "load_cyndilib", lambda: api)
    with pytest.raises(RuntimeError, match="connect refused"):
        open_backend(CaptureConfig(backend="ndi", device="CAMERA (Program)"))
    assert api.receivers[0].disconnected is True


def test_source_not_found_reports_available_sources(monkeypatch):
    monkeypatch.setattr(ndi, "load_cyndilib", lambda: fake_api(names=("OTHER (A)",)))
    with pytest.raises(PreconditionError) as exc:
        open_backend(CaptureConfig(backend="ndi", device="MISSING (B)"))
    assert exc.value.details["reason"] == "source_not_found"
    assert exc.value.details["available"] == ["OTHER (A)"]


def test_framesync_static_sender_repeats_at_source_rate(monkeypatch):
    values = np.array([[0x1000]], dtype=np.uint16)
    monkeypatch.setattr(
        ndi, "load_cyndilib",
        lambda: fake_api([p216_frame(values, timestamp=1.0)]),
    )
    backend = open_backend(CaptureConfig(
        backend="ndi", device="CAMERA (Program)", extra={"poll_interval_s": 0.0},
    ))
    frames = list(itertools.islice(backend.frames(), 2))
    backend.close()
    assert [frame.meta["timestamp_s"] for frame in frames] == [1.0, 1.0]
    assert [frame.frame_index for frame in frames] == [0, 1]
