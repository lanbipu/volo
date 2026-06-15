import sys
import types

import pytest

from tracksim.domain.errors import NoControllerError


def _install_fake_sdl3(monkeypatch, *, gamepad_ids, axes=None, buttons=None):
    mod = types.ModuleType("sdl3")
    mod.SDL_INIT_GAMEPAD = 0x2000
    mod.SDL_GAMEPAD_AXIS_LEFTX = 0
    mod.SDL_GAMEPAD_AXIS_LEFTY = 1
    mod.SDL_GAMEPAD_AXIS_RIGHTX = 2
    mod.SDL_GAMEPAD_AXIS_RIGHTY = 3
    mod.SDL_GAMEPAD_AXIS_LEFT_TRIGGER = 4
    mod.SDL_GAMEPAD_AXIS_RIGHT_TRIGGER = 5
    mod.SDL_GAMEPAD_BUTTON_SOUTH = 0
    mod.SDL_GAMEPAD_BUTTON_EAST = 1
    mod.SDL_GAMEPAD_BUTTON_WEST = 2
    mod.SDL_GAMEPAD_BUTTON_NORTH = 3
    mod.SDL_GAMEPAD_BUTTON_LEFT_SHOULDER = 9
    mod.SDL_GAMEPAD_BUTTON_RIGHT_SHOULDER = 10
    mod.SDL_GAMEPAD_BUTTON_BACK = 4
    mod.SDL_GAMEPAD_BUTTON_START = 6
    mod.SDL_GAMEPAD_BUTTON_RIGHT_PADDLE1 = 16
    mod.SDL_GAMEPAD_BUTTON_LEFT_PADDLE1 = 17
    mod.SDL_GAMEPAD_BUTTON_RIGHT_PADDLE2 = 18
    mod.SDL_GAMEPAD_BUTTON_LEFT_PADDLE2 = 19

    state = {"closed": False, "axes": axes or {}, "buttons": buttons or {}}

    mod.SDL_Init = lambda flags: True
    mod.SDL_Quit = lambda: None
    mod.SDL_GetGamepads = lambda count_ptr=None: list(gamepad_ids)
    mod.SDL_OpenGamepad = lambda iid: ("gp", iid)

    def SDL_CloseGamepad(gp):
        state["closed"] = True

    mod.SDL_CloseGamepad = SDL_CloseGamepad
    mod.SDL_UpdateGamepads = lambda: None
    mod.SDL_GetGamepadName = lambda gp: b"Fake Xbox Pad"
    mod.SDL_GetGamepadNameForID = lambda iid: b"Fake Xbox Pad"
    mod.SDL_GetGamepadGUIDForID = lambda iid: b"03030000"
    mod.SDL_GetGamepadAxis = lambda gp, axis: state["axes"].get(axis, 0)
    mod.SDL_GetGamepadButton = lambda gp, button: state["buttons"].get(button, False)

    monkeypatch.setitem(sys.modules, "sdl3", mod)
    return mod, state


def test_poll_normalizes_sticks_and_triggers(monkeypatch):
    _install_fake_sdl3(
        monkeypatch,
        gamepad_ids=[7],
        axes={
            0: 32767,   # leftx: full right -> +1.0
            1: -32767,  # lefty: full up    -> -1.0
            2: 16384,   # rightx: ~half     -> ~+0.5
            3: 0,       # righty: center    -> 0.0
            4: 32767,   # lefttrigger full  -> 1.0
            5: 0,       # righttrigger idle -> 0.0
        },
    )
    from tracksim.infra.sdl_controller import SDLControllerInput

    ctrl = SDLControllerInput()
    ctrl.open(0)
    s = ctrl.poll()
    assert s.axes["leftx"] == pytest.approx(1.0)
    assert s.axes["lefty"] == pytest.approx(-1.0)
    assert s.axes["rightx"] == pytest.approx(0.5, abs=0.01)
    assert s.axes["righty"] == pytest.approx(0.0)
    assert s.axes["lefttrigger"] == pytest.approx(1.0)
    assert s.axes["righttrigger"] == pytest.approx(0.0)
    assert s.connected is True


def test_poll_axis_value_clamped_to_range(monkeypatch):
    _install_fake_sdl3(
        monkeypatch,
        gamepad_ids=[7],
        axes={0: 40000, 4: 40000},  # beyond +32767 must clamp
    )
    from tracksim.infra.sdl_controller import SDLControllerInput

    ctrl = SDLControllerInput()
    ctrl.open(0)
    s = ctrl.poll()
    assert s.axes["leftx"] == pytest.approx(1.0)
    assert s.axes["lefttrigger"] == pytest.approx(1.0)


def test_poll_maps_buttons(monkeypatch):
    _install_fake_sdl3(
        monkeypatch,
        gamepad_ids=[7],
        buttons={0: True, 1: False, 9: True, 6: True},
    )
    from tracksim.infra.sdl_controller import SDLControllerInput

    ctrl = SDLControllerInput()
    ctrl.open(0)
    s = ctrl.poll()
    from tracksim.ports.controller_input import CONTROLLER_BUTTONS
    assert set(s.buttons) == CONTROLLER_BUTTONS
    assert s.buttons["a"] is True
    assert s.buttons["b"] is False
    assert s.buttons["leftshoulder"] is True
    assert s.buttons["start"] is True


def test_poll_before_open_raises(monkeypatch):
    _install_fake_sdl3(monkeypatch, gamepad_ids=[7])
    from tracksim.infra.sdl_controller import SDLControllerInput

    ctrl = SDLControllerInput()
    with pytest.raises(NoControllerError):
        ctrl.poll()


def test_close_then_poll_raises(monkeypatch):
    _, state = _install_fake_sdl3(monkeypatch, gamepad_ids=[7])
    from tracksim.infra.sdl_controller import SDLControllerInput

    ctrl = SDLControllerInput()
    ctrl.open(0)
    ctrl.close()
    assert state["closed"] is True
    with pytest.raises(NoControllerError):
        ctrl.poll()


def test_poll_reads_elite_paddles(monkeypatch):
    _install_fake_sdl3(
        monkeypatch,
        gamepad_ids=[7],
        buttons={16: True, 17: False, 18: True, 19: False},
    )
    from tracksim.infra.sdl_controller import SDLControllerInput

    ctrl = SDLControllerInput()
    ctrl.open(0)
    s = ctrl.poll()
    assert s.buttons["p1"] is True   # RIGHT_PADDLE1 右上
    assert s.buttons["p3"] is False  # LEFT_PADDLE1  左上
    assert s.buttons["p2"] is True   # RIGHT_PADDLE2 右下
    assert s.buttons["p4"] is False  # LEFT_PADDLE2  左下
