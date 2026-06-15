import sys
import types

import pytest

from tracksim.domain.errors import NoControllerError
from tracksim.ports.controller_input import ControllerDevice


def _install_fake_sdl3(monkeypatch, *, gamepad_ids):
    """Install a minimal fake `sdl3` module covering the ~10 functions used."""
    mod = types.ModuleType("sdl3")

    # constants
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

    state = {"init": False, "opened": None, "axes": {}, "buttons": {}}

    def SDL_Init(flags):
        state["init"] = True
        return True

    def SDL_Quit():
        state["init"] = False

    def SDL_GetGamepads(count_ptr=None):
        return list(gamepad_ids)

    def SDL_OpenGamepad(instance_id):
        state["opened"] = instance_id
        return ("gp", instance_id)

    def SDL_CloseGamepad(gp):
        state["opened"] = None

    def SDL_UpdateGamepads():
        return None

    def SDL_GetGamepadName(gp):
        return b"Fake Xbox Pad"

    def SDL_GetGamepadNameForID(instance_id):
        return b"Fake Xbox Pad"

    def SDL_GetGamepadGUIDForID(instance_id):
        return b"0303" + bytes(str(instance_id), "ascii")

    def SDL_GetGamepadAxis(gp, axis):
        return state["axes"].get(axis, 0)

    def SDL_GetGamepadButton(gp, button):
        return state["buttons"].get(button, False)

    mod.SDL_Init = SDL_Init
    mod.SDL_Quit = SDL_Quit
    mod.SDL_GetGamepads = SDL_GetGamepads
    mod.SDL_OpenGamepad = SDL_OpenGamepad
    mod.SDL_CloseGamepad = SDL_CloseGamepad
    mod.SDL_UpdateGamepads = SDL_UpdateGamepads
    mod.SDL_GetGamepadName = SDL_GetGamepadName
    mod.SDL_GetGamepadNameForID = SDL_GetGamepadNameForID
    mod.SDL_GetGamepadGUIDForID = SDL_GetGamepadGUIDForID
    mod.SDL_GetGamepadAxis = SDL_GetGamepadAxis
    mod.SDL_GetGamepadButton = SDL_GetGamepadButton

    monkeypatch.setitem(sys.modules, "sdl3", mod)
    return mod, state


def test_list_devices_maps_gamepad_ids(monkeypatch):
    _install_fake_sdl3(monkeypatch, gamepad_ids=[11, 22])
    from tracksim.infra.sdl_controller import SDLControllerInput

    ctrl = SDLControllerInput()
    devices = ctrl.list_devices()
    assert [d.index for d in devices] == [0, 1]
    assert all(isinstance(d, ControllerDevice) for d in devices)
    assert devices[0].name == "Fake Xbox Pad"
    assert devices[0].guid != ""


def test_open_with_no_devices_raises_no_controller(monkeypatch):
    _install_fake_sdl3(monkeypatch, gamepad_ids=[])
    from tracksim.infra.sdl_controller import SDLControllerInput

    ctrl = SDLControllerInput()
    with pytest.raises(NoControllerError):
        ctrl.open(0)


def test_open_out_of_range_raises_no_controller(monkeypatch):
    _install_fake_sdl3(monkeypatch, gamepad_ids=[11])
    from tracksim.infra.sdl_controller import SDLControllerInput

    ctrl = SDLControllerInput()
    with pytest.raises(NoControllerError):
        ctrl.open(5)
