import time

from tracksim.infra.clock import WallClock


def test_wallclock_now_monotonic_nondecreasing():
    clock = WallClock()
    t0 = clock.now()
    t1 = clock.now()
    assert isinstance(t0, float)
    assert t1 >= t0


def test_wallclock_sleep_advances_real_time():
    clock = WallClock()
    start = time.monotonic()
    clock.sleep(0.02)
    elapsed = time.monotonic() - start
    assert elapsed >= 0.015
