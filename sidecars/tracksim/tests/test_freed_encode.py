from tracksim.domain.pose import CameraPose
from tracksim.emitters.freed import FreeDScaling, encode_d1
from tracksim.cli.commands.decode import freed_decode


def _d24(bs: bytes) -> int:
    v = (bs[0] << 16) | (bs[1] << 8) | bs[2]
    if v & 0x800000:
        v -= 0x1000000
    return v


def _decode_d1(frame: bytes, scaling: FreeDScaling):
    assert len(frame) == 29
    assert frame[0] == 0xD1
    camera_id = frame[1]
    pan = _d24(frame[2:5]) / scaling.angle_lsb_per_deg
    tilt = _d24(frame[5:8]) / scaling.angle_lsb_per_deg
    roll = _d24(frame[8:11]) / scaling.angle_lsb_per_deg
    x = _d24(frame[11:14]) / scaling.pos_lsb_per_m
    y = _d24(frame[14:17]) / scaling.pos_lsb_per_m
    z = _d24(frame[17:20]) / scaling.pos_lsb_per_m
    return camera_id, pan, tilt, roll, x, y, z


def test_encode_d1_length_is_29():
    frame = encode_d1(CameraPose(), camera_id=0, scaling=FreeDScaling())
    assert len(frame) == 29
    assert frame[0] == 0xD1


def test_encode_d1_checksum_formula():
    frame = encode_d1(
        CameraPose(pan=10.0, tilt=-5.0, roll=0.0, x=1.0, y=2.0, z=1.5),
        camera_id=3,
        scaling=FreeDScaling(),
    )
    expected_ck = (0x40 - sum(frame[:28])) & 0xFF
    assert frame[28] == expected_ck


def test_encode_d1_known_bytes():
    # lsb=0 关闭 zoom/focus，保持这个已知字节向量只验证角度/位置打包。
    frame = encode_d1(
        CameraPose(pan=10.0, tilt=-5.0, roll=0.0, x=1.0, y=2.0, z=1.5),
        camera_id=3,
        scaling=FreeDScaling(zoom_lsb_per_mm=0.0, focus_lsb_per_m=0.0),
    )
    assert frame.hex() == "d103050000fd800000000000fa0001f400017700000000000000000083"
    assert frame[28] == 0x83


def test_encode_d1_zoom_focus_from_pose():
    """zoom/focus bytes derive from pose.focal_length(mm)/focus_distance(m) via lsb scaling."""
    frame = encode_d1(
        CameraPose(focal_length=50.0, focus_distance=2.0),
        camera_id=0,
        scaling=FreeDScaling(zoom_lsb_per_mm=1000.0, focus_lsb_per_m=1000.0),
    )
    assert frame[20:23] == bytes([0x00, 0xC3, 0x50])  # 50.0 * 1000 = 50000 = 0x00C350
    assert frame[23:26] == bytes([0x00, 0x07, 0xD0])  # 2.0 * 1000 = 2000 = 0x0007D0
    assert frame[26:28] == b"\x00\x00"


def test_encode_d1_zoom_unsigned_large_value_round_trips():
    """A zoom raw >= 0x800000 (high bit set) must pack/decode as UNSIGNED u24,
    not sign-extend to negative."""
    # 300mm * 30000 = 9_000_000 = 0x895440  (>= 0x800000)
    scaling = FreeDScaling(zoom_lsb_per_mm=30000.0, focus_lsb_per_m=1000.0)
    frame = encode_d1(
        CameraPose(focal_length=300.0, focus_distance=3.0), camera_id=0, scaling=scaling
    )
    assert frame[20:23] == bytes([0x89, 0x54, 0x40]), f"zoom bytes wrong: {frame[20:23].hex()}"
    op, result = freed_decode(frame)
    assert result["zoom_raw"] == 9_000_000
    assert result["focus_raw"] == 3000


def test_encode_d1_zoom_focus_saturate_at_u24_max():
    """Overflow past 0xFFFFFF saturates instead of wrapping around."""
    scaling = FreeDScaling(zoom_lsb_per_mm=1_000_000.0, focus_lsb_per_m=1_000_000.0)
    frame = encode_d1(
        CameraPose(focal_length=300.0, focus_distance=100.0), camera_id=0, scaling=scaling
    )
    assert frame[20:23] == bytes([0xFF, 0xFF, 0xFF])
    assert frame[23:26] == bytes([0xFF, 0xFF, 0xFF])


def test_encode_d1_zoom_focus_track_pose():
    """REGRESSION: FreeD zoom/focus must derive from pose.focal_length/focus_distance,
    not be a constant. Two poses with different lens values must produce different
    zoom/focus bytes."""
    s = FreeDScaling(zoom_lsb_per_mm=1000.0, focus_lsb_per_m=1000.0)
    near = encode_d1(CameraPose(focal_length=24.0, focus_distance=1.0), camera_id=0, scaling=s)
    far = encode_d1(CameraPose(focal_length=85.0, focus_distance=5.0), camera_id=0, scaling=s)
    assert near[20:23] != far[20:23], "zoom bytes must change with focal_length"
    assert near[23:26] != far[23:26], "focus bytes must change with focus_distance"


def test_encode_d1_round_trip():
    scaling = FreeDScaling()
    pose = CameraPose(pan=10.0, tilt=-5.0, roll=2.5, x=1.0, y=-2.0, z=1.5)
    frame = encode_d1(pose, camera_id=7, scaling=scaling)
    camera_id, pan, tilt, roll, x, y, z = _decode_d1(frame, scaling)
    assert camera_id == 7
    assert abs(pan - 10.0) < 1e-3
    assert abs(tilt - -5.0) < 1e-3
    assert abs(roll - 2.5) < 1e-3
    assert abs(x - 1.0) < 1e-4
    assert abs(y - -2.0) < 1e-4
    assert abs(z - 1.5) < 1e-4
