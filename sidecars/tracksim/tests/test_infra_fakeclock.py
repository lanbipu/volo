import time

from tracksim.infra.clock import FakeClock


def test_fakeclock_starts_at_zero_by_default():
    clock = FakeClock()
    assert clock.now() == 0.0


def test_fakeclock_honors_start():
    clock = FakeClock(start=10.0)
    assert clock.now() == 10.0


def test_fakeclock_sleep_advances_virtual_time():
    clock = FakeClock()
    clock.sleep(0.5)
    clock.sleep(0.25)
    assert clock.now() == 0.75


def test_fakeclock_advance_helper():
    clock = FakeClock(start=1.0)
    clock.advance(2.0)
    assert clock.now() == 3.0


def test_fakeclock_now_consumes_no_real_time():
    clock = FakeClock()
    start = time.monotonic()
    for _ in range(1000):
        clock.now()
    assert time.monotonic() - start < 0.05


def test_fakeclock_nonpositive_sleep_does_not_move_time():
    clock = FakeClock(start=5.0)
    clock.sleep(0.0)
    clock.sleep(-1.0)
    assert clock.now() == 5.0
