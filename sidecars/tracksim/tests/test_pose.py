from tracksim.domain.pose import CameraPose


def test_camera_pose_defaults():
    p = CameraPose()
    assert p.pan == 0.0
    assert p.tilt == 0.0
    assert p.roll == 0.0
    assert p.x == 0.0
    assert p.y == 0.0
    assert p.z == 0.0
    assert p.focal_length == 35.0
    assert p.focus_distance == 3.0
    assert p.iris is None
    assert p.entrance_pupil is None
    assert p.frame == 0
    assert p.timestamp == 0.0
    assert p.rate == 60.0


def test_camera_pose_explicit_values():
    p = CameraPose(
        pan=10.0, tilt=-5.0, roll=1.5,
        x=1.0, y=2.0, z=3.0,
        focal_length=50.0, focus_distance=4.2,
        iris=2.8, entrance_pupil=0.05,
        frame=12, timestamp=0.2, rate=30.0,
    )
    assert p.pan == 10.0
    assert p.tilt == -5.0
    assert p.roll == 1.5
    assert p.x == 1.0 and p.y == 2.0 and p.z == 3.0
    assert p.focal_length == 50.0
    assert p.focus_distance == 4.2
    assert p.iris == 2.8
    assert p.entrance_pupil == 0.05
    assert p.frame == 12
    assert p.timestamp == 0.2
    assert p.rate == 30.0


def test_camera_pose_is_pydantic_model():
    p = CameraPose(pan=3.0)
    dumped = p.model_dump()
    assert dumped["pan"] == 3.0
    assert "focal_length" in dumped
    reloaded = CameraPose.model_validate(dumped)
    assert reloaded == p
