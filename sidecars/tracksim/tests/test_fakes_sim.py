import pytest

from tracksim.domain.errors import TransportError
from tracksim.domain.pose import CameraPose
from tests.fakes import FakeClock, FakeEmitter, FakePoseSource


def test_fake_pose_source_counts_and_advances_frame():
    src = FakePoseSource()
    p0 = src.next(0.5)
    p1 = src.next(0.5)
    assert src.calls == 2
    assert src.dts == [0.5, 0.5]
    assert isinstance(p0, CameraPose)
    assert p0.frame == 0
    assert p1.frame == 1


def test_fake_pose_source_exhausts_after_limit():
    src = FakePoseSource(limit=2)
    src.next(0.1)
    src.next(0.1)
    with pytest.raises(StopIteration):
        src.next(0.1)


def test_fake_pose_source_close_sets_flag():
    src = FakePoseSource()
    src.close()
    assert src.closed is True


def test_fake_emitter_records_poses():
    em = FakeEmitter(name="freed")
    pose = CameraPose()
    em.emit(pose)
    assert em.name == "freed"
    assert em.emitted == [pose]


def test_fake_emitter_can_fail():
    em = FakeEmitter(name="freed", fail_times=1)
    with pytest.raises(TransportError):
        em.emit(CameraPose())
    em.emit(CameraPose())  # second emit succeeds
    assert len(em.emitted) == 1


def test_fake_clock_advances_on_sleep():
    clock = FakeClock()
    assert clock.now() == 0.0
    clock.sleep(0.25)
    assert clock.now() == 0.25
    assert clock.sleeps == [0.25]
