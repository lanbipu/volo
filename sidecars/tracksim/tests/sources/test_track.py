import pytest

from tracksim.domain.pose import CameraPose
from tracksim.track import Track
from tracksim.sources.track import TrackPoseSource


def _track():
    return Track(rate=10.0, camera="c", frames=[(0.0, CameraPose(pan=0.0, x=0.0)),
                                                (1.0, CameraPose(pan=10.0, x=2.0))])


def test_first_emit_is_start_then_progresses():
    src = TrackPoseSource(_track(), rate=2.0)        # dt=0.5
    p0 = src.next(0.5)                                # cursor 0.0 -> 起始帧
    assert p0.pan == 0.0 and p0.x == 0.0
    assert p0.frame == 1 and p0.timestamp == pytest.approx(0.5) and p0.rate == 2.0
    p1 = src.next(0.5)                                # cursor 0.5 -> 中点
    assert p1.pan == pytest.approx(5.0) and p1.x == pytest.approx(1.0)


def test_reaches_last_frame_then_stops():
    src = TrackPoseSource(_track(), rate=1.0)         # dt=1.0
    assert src.next(1.0).pan == 0.0                   # cursor 0 -> 起始
    assert src.next(1.0).pan == pytest.approx(10.0)   # cursor 1.0 -> 末帧
    with pytest.raises(StopIteration):
        src.next(1.0)                                 # cursor 2.0 > 1.0+0.5 -> 耗尽


def test_single_frame_track_emits_then_stops():
    src = TrackPoseSource(Track(rate=10.0, camera="c", frames=[(0.0, CameraPose(pan=7.0))]), rate=10.0)
    assert src.next(0.1).pan == 7.0                   # cursor 0.0 -> 发
    with pytest.raises(StopIteration):
        src.next(0.1)                                 # cursor 0.1 > 0.0+0.05 -> 停


def test_noninteger_fps_plays_all_frames():
    rate = 24000.0 / 1001.0                           # 23.976
    n = 50
    frames = [(i / rate, CameraPose(pan=float(i))) for i in range(n)]
    src = TrackPoseSource(Track(rate=rate, camera="c", frames=frames), rate=rate)
    dt = 1.0 / rate
    got = []
    while True:
        try:
            got.append(src.next(dt).pan)
        except StopIteration:
            break
    assert len(got) == n          # 防 off-by-one：全部 N 帧都发
    assert got[-1] == pytest.approx(float(n - 1))   # 末值为插值结果，差一个浮点 epsilon，用 approx


def test_loop_wraps_instead_of_stopping():
    src = TrackPoseSource(_track(), rate=2.0, loop=True)   # dt=0.5, period=1.0
    poses = [src.next(0.5) for _ in range(6)]              # cursor 0,0.5,1.0,1.5,2.0,2.5
    assert [p.frame for p in poses] == [1, 2, 3, 4, 5, 6]  # 连续递增，从不 StopIteration
    assert poses[0].pan == 0.0                             # cursor 0.0 → 首帧
    assert poses[1].pan == pytest.approx(5.0)              # cursor 0.5 → 中点
    assert poses[2].pan == pytest.approx(0.0)              # cursor 1.0 → 回绕回首帧
    assert poses[5].timestamp == pytest.approx(3.0)        # timestamp 连续累加，不重置


def test_loop_first_frame_when_track_starts_nonzero():
    # t 不从 0 的 track（period 不整除 start），loop 第一帧必须是首帧（修 cursor 初始化 / 负模 bug）
    track = Track(rate=1.0, camera="c", frames=[(5.0, CameraPose(pan=0.0)), (7.0, CameraPose(pan=10.0))])
    src = TrackPoseSource(track, rate=1.0, loop=True)     # dt=1.0, period=2.0
    assert src.next(1.0).pan == 0.0                        # 旧码 phase=5+(0-5)%2=6 → 误发中点 pan=5


def test_loop_deterministic_across_iterations():
    # 非 2 次幂间隔（0.2s）多帧跨多个循环：相位须由整数 tick 驱动，逐循环序列一致（无浮点累积漂移）
    frames = [(i * 0.2, CameraPose(pan=float(i * 10))) for i in range(5)]   # t=0..0.8, period=0.8
    src = TrackPoseSource(Track(rate=5.0, camera="c", frames=frames), rate=5.0, loop=True)
    pans = [src.next(0.2).pan for _ in range(12)]          # period/dt=4 → 3 个周期
    assert pans[0:4] == pytest.approx(pans[4:8])           # 循环间逐帧一致
    assert pans[4:8] == pytest.approx(pans[8:12])
