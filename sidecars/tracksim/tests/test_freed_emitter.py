from tracksim.domain.pose import CameraPose
from tracksim.emitters.freed import FreeDEmitter, FreeDScaling, encode_d1


class FakeTransport:
    def __init__(self) -> None:
        self.sent: list[bytes] = []
        self.closed = False

    def send(self, data: bytes) -> None:
        self.sent.append(data)

    def close(self) -> None:
        self.closed = True


def test_freed_emitter_name():
    assert FreeDEmitter(FakeTransport()).name == "freed"


def test_freed_emitter_sends_encoded_frame():
    transport = FakeTransport()
    scaling = FreeDScaling()
    emitter = FreeDEmitter(transport, camera_id=5, scaling=scaling)
    pose = CameraPose(pan=12.0, tilt=3.0, x=0.5, y=-0.5, z=1.2)
    emitter.emit(pose)
    assert len(transport.sent) == 1
    assert transport.sent[0] == encode_d1(pose, camera_id=5, scaling=scaling)
    assert len(transport.sent[0]) == 29


def test_freed_emitter_close_forwards():
    transport = FakeTransport()
    FreeDEmitter(transport).close()
    assert transport.closed is True


def test_freed_emitter_default_scaling_not_shared_between_instances():
    """Two FreeDEmitter() instances must NOT share the same FreeDScaling object."""
    e1 = FreeDEmitter(FakeTransport())
    e2 = FreeDEmitter(FakeTransport())
    assert e1._scaling is not e2._scaling
    # Mutating one must not affect the other
    e1._scaling.zoom_lsb_per_mm = 9999.0
    assert e2._scaling.zoom_lsb_per_mm != 9999.0
