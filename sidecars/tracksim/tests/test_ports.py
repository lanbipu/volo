from tracksim.domain.pose import CameraPose
from tracksim.ports.pose_source import PoseSource
from tracksim.ports.emitter import Emitter
from tracksim.ports.transport import Transport
from tracksim.ports.clock import Clock
from tracksim.ports.controller_input import (
    ControllerDevice,
    ControllerState,
    ControllerInput,
)


class FakePoseSource:
    def next(self, dt: float) -> CameraPose:
        return CameraPose(timestamp=dt)

    def close(self) -> None:
        pass


class FakeTransport:
    def __init__(self) -> None:
        self.sent: list[bytes] = []

    def send(self, data: bytes) -> None:
        self.sent.append(data)

    def close(self) -> None:
        pass


class FakeEmitter:
    name = "fake"

    def __init__(self) -> None:
        self.poses: list[CameraPose] = []

    def emit(self, pose: CameraPose) -> None:
        self.poses.append(pose)

    def close(self) -> None:
        pass


class FakeClock:
    def now(self) -> float:
        return 1.0

    def sleep(self, seconds: float) -> None:
        pass


class FakeControllerInput:
    def list_devices(self) -> list[ControllerDevice]:
        return [ControllerDevice(index=0, name="Xbox", guid="abc")]

    def open(self, index: int) -> None:
        pass

    def poll(self) -> ControllerState:
        return ControllerState()

    def close(self) -> None:
        pass


def test_fakes_satisfy_protocols():
    src: PoseSource = FakePoseSource()
    tp: Transport = FakeTransport()
    em: Emitter = FakeEmitter()
    clk: Clock = FakeClock()
    ci: ControllerInput = FakeControllerInput()

    assert isinstance(src.next(0.5), CameraPose)
    tp.send(b"x")
    assert tp.sent == [b"x"]
    em.emit(CameraPose())
    assert len(em.poses) == 1
    assert em.name == "fake"
    assert clk.now() == 1.0
    clk.sleep(0.0)
    assert ci.list_devices()[0].name == "Xbox"
    ci.open(0)
    assert isinstance(ci.poll(), ControllerState)


def test_controller_device_dataclass():
    d = ControllerDevice(index=2, name="Pad", guid="g-1")
    assert d.index == 2
    assert d.name == "Pad"
    assert d.guid == "g-1"


def test_controller_state_defaults():
    s = ControllerState()
    assert s.axes == {}
    assert s.buttons == {}
    assert s.connected is True


def test_controller_state_default_isolation():
    a = ControllerState()
    b = ControllerState()
    a.axes["leftx"] = 0.5
    a.buttons["a"] = True
    assert b.axes == {}
    assert b.buttons == {}


def test_controller_state_explicit():
    s = ControllerState(
        axes={"leftx": -0.3, "righttrigger": 0.8},
        buttons={"a": True, "start": False},
        connected=False,
    )
    assert s.axes["leftx"] == -0.3
    assert s.axes["righttrigger"] == 0.8
    assert s.buttons["a"] is True
    assert s.connected is False
