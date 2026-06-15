import io
import json

import pytest

from tracksim.cli import render
from tracksim.cli.commands import controllers
from tracksim.domain.errors import NoControllerError
from tracksim.ports.controller_input import ControllerDevice, ControllerState


class FakeControllerInput:
    def __init__(self, devices, states=None):
        self._devices = devices
        self._states = states or []
        self._i = 0
        self.opened = None
        self.closed = False

    def list_devices(self):
        return list(self._devices)

    def open(self, index: int) -> None:
        if not self._devices:
            raise NoControllerError("no controller", details={"index": index})
        self.opened = index

    def poll(self) -> ControllerState:
        st = self._states[min(self._i, len(self._states) - 1)]
        self._i += 1
        return st

    def close(self) -> None:
        self.closed = True


class FakeClock:
    def __init__(self) -> None:
        self.t = 0.0

    def now(self) -> float:
        return self.t

    def sleep(self, seconds: float) -> None:
        self.t += seconds


def test_list_controllers_returns_devices():
    ci = FakeControllerInput([ControllerDevice(index=0, name="Pad", guid="g0")])
    op, data = controllers.list_controllers(ci)
    assert op == "controllers.list"
    assert data["devices"] == [{"index": 0, "name": "Pad", "guid": "g0"}]


def test_list_controllers_empty_ok():
    ci = FakeControllerInput([])
    op, data = controllers.list_controllers(ci)
    assert op == "controllers.list"
    assert data["devices"] == []


def test_monitor_stream_emits_samples():
    states = [
        ControllerState(axes={"leftx": 0.5}, buttons={"a": True}),
        ControllerState(axes={"leftx": -0.5}, buttons={"a": False}),
    ]
    ci = FakeControllerInput([ControllerDevice(index=0, name="Pad", guid="g0")], states)
    buf = io.StringIO()
    writer = render.NdjsonWriter(buf, request_id="rq", timestamp="2026-06-02T00:00:00Z")
    op, data = controllers.monitor_stream(ci, writer, clock=FakeClock(), rate=10.0, samples=2)
    assert op == "controllers.monitor"
    objs = [json.loads(ln) for ln in buf.getvalue().splitlines() if ln]
    progress = [o for o in objs if o["type"] == "progress"]
    assert len(progress) == 2
    assert progress[0]["axes"]["leftx"] == 0.5
    assert progress[0]["buttons"]["a"] is True
    assert objs[-1]["type"] == "result"
    assert objs[-1]["final"] is True
    assert ci.opened == 0


def test_monitor_stream_no_device_raises():
    ci = FakeControllerInput([])
    buf = io.StringIO()
    writer = render.NdjsonWriter(buf, request_id="rq", timestamp="2026-06-02T00:00:00Z")
    with pytest.raises(NoControllerError):
        controllers.monitor_stream(ci, writer, clock=FakeClock(), rate=10.0, samples=2)


def test_monitor_stream_without_writer_no_stdout():
    # 防回归 F2：writer=None（json/text 模式）不写 stdout，返回 summary（含最后一帧）
    states = [ControllerState(axes={"leftx": 0.5}, buttons={"a": True})]
    ci = FakeControllerInput([ControllerDevice(index=0, name="Pad", guid="g0")], states)
    op, data = controllers.monitor_stream(ci, None, clock=FakeClock(), rate=10.0, samples=2)
    assert op == "controllers.monitor"
    assert data["samples"] == 2
    assert data["last"]["axes"]["leftx"] == 0.5
