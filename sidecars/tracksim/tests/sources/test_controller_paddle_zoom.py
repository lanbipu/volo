from tracksim.config import DEFAULT_CONTROLLER_MAPPING
from tracksim.ports.controller_input import ControllerState
from tracksim.sources.controller import ControllerPoseSource


class _FakeController:
    def __init__(self, states):
        self._states = states
        self._i = 0

    def list_devices(self):
        return []

    def open(self, index):
        return None

    def poll(self):
        s = self._states[min(self._i, len(self._states) - 1)]
        self._i += 1
        return s

    def close(self):
        return None


class _StubClock:
    def now(self):
        return 0.0

    def sleep(self, seconds):
        return None


def _btn(**pressed):
    # All four paddles present; only the named ones True.
    buttons = {"p1": False, "p2": False, "p3": False, "p4": False}
    buttons.update(pressed)
    return ControllerState(axes={}, buttons=buttons, connected=True)


def _zoom_source(states):
    # Use the real built-in default mapping (p1 +50mm/s, p3 -50mm/s on focal_length, clamp 12..300).
    return ControllerPoseSource(_FakeController(states), DEFAULT_CONTROLLER_MAPPING, _StubClock())


def test_p1_raises_focal_length():
    # focal_length seeds at 35; holding P1 for 3 ticks @ dt=0.1, scale=50 -> +15 -> 50.
    src = _zoom_source([_btn(p1=True)] * 3)
    src.next(0.1)
    src.next(0.1)
    pose = src.next(0.1)
    assert pose.focal_length == 50.0


def test_p3_lowers_focal_length():
    # Holding P3 for 2 ticks @ dt=0.1, scale=50 -> -10 -> 25.
    src = _zoom_source([_btn(p3=True)] * 2)
    src.next(0.1)
    pose = src.next(0.1)
    assert pose.focal_length == 25.0


def test_both_paddles_cancel():
    # P1 and P3 both held -> net zero change -> stays at seed 35.
    src = _zoom_source([_btn(p1=True, p3=True)])
    pose = src.next(0.1)
    assert pose.focal_length == 35.0


def test_focal_length_clamps_at_300():
    # Hold P1 long enough to exceed 300; must cap at clamp_max=300.
    src = _zoom_source([_btn(p1=True)] * 100)
    pose = None
    for _ in range(100):
        pose = src.next(0.1)  # 35 + 100*0.1*50 = 535, clamped to 300
    assert pose.focal_length == 300.0
