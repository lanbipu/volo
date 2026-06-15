"""SDL3 (PySDL3) backend for the ControllerInput port.

This is the ONLY module in the package allowed to import `sdl3`.
The import is deferred so the package loads even when SDL3 is absent;
`NoControllerError` is raised when a device is requested but unavailable.
"""

from __future__ import annotations

from typing import Any

from tracksim.domain.errors import NoControllerError
from tracksim.ports.controller_input import ControllerDevice, ControllerState

_STICK_DIVISOR = 32767.0


def _guid_to_str(sdl: Any, guid_raw: Any) -> str:
    if isinstance(guid_raw, (bytes, str)):
        return _decode(guid_raw)
    import ctypes
    buf = ctypes.create_string_buffer(64)
    sdl.SDL_GUIDToString(guid_raw, buf, 64)
    return buf.value.decode("ascii")


def _decode(value: Any) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    if value is None:
        return ""
    return str(value)


def _clamp(value: float, lo: float, hi: float) -> float:
    if value < lo:
        return lo
    if value > hi:
        return hi
    return value


class SDLControllerInput:
    """ControllerInput implementation backed by SDL3 gamepad API via PySDL3."""

    def __init__(self) -> None:
        self._sdl: Any | None = None
        self._gamepad: Any | None = None
        self._initialized = False

    def _ensure_sdl(self) -> Any:
        if self._sdl is None:
            import os as _os
            _os.environ.setdefault("PYSDL3_NO_UPDATE_CHECK", "1")  # legacy name, keep for safety
            _os.environ.setdefault("SDL_CHECK_VERSION", "0")  # actual env var used by PySDL3
            import sdl3  # deferred: only place importing sdl3

            self._sdl = sdl3
        if not self._initialized:
            self._sdl.SDL_Init(self._sdl.SDL_INIT_GAMEPAD)
            self._initialized = True
        return self._sdl

    def _instance_ids(self) -> list[int]:
        import ctypes

        sdl = self._ensure_sdl()
        count = ctypes.c_int(0)
        ids = sdl.SDL_GetGamepads(ctypes.byref(count))
        if ids is None:
            return []
        # Fakes (tests) return a plain Python list; real SDL returns a ctypes pointer.
        if isinstance(ids, list):
            return ids
        n = count.value
        return [ids[i] for i in range(n)] if n > 0 else []

    def list_devices(self) -> list[ControllerDevice]:
        sdl = self._ensure_sdl()
        devices: list[ControllerDevice] = []
        for index, instance_id in enumerate(self._instance_ids()):
            name = _decode(sdl.SDL_GetGamepadNameForID(instance_id))
            guid_raw = sdl.SDL_GetGamepadGUIDForID(instance_id)
            guid = _guid_to_str(sdl, guid_raw)
            devices.append(ControllerDevice(index=index, name=name, guid=guid))
        return devices

    def open(self, index: int) -> None:
        sdl = self._ensure_sdl()
        ids = self._instance_ids()
        if index < 0 or index >= len(ids):
            raise NoControllerError(
                f"no controller at index {index} (found {len(ids)})"
            )
        self._gamepad = sdl.SDL_OpenGamepad(ids[index])
        if not self._gamepad:
            raise NoControllerError(f"failed to open controller at index {index}")

    def poll(self) -> ControllerState:
        if self._gamepad is None:
            raise NoControllerError("poll() called before open()")
        sdl = self._ensure_sdl()
        sdl.SDL_UpdateGamepads()
        gp = self._gamepad

        def axis(code: int) -> int:
            return sdl.SDL_GetGamepadAxis(gp, code)

        def button(code: int) -> bool:
            return bool(sdl.SDL_GetGamepadButton(gp, code))

        axes = {
            "leftx": _clamp(axis(sdl.SDL_GAMEPAD_AXIS_LEFTX) / _STICK_DIVISOR, -1.0, 1.0),
            "lefty": _clamp(axis(sdl.SDL_GAMEPAD_AXIS_LEFTY) / _STICK_DIVISOR, -1.0, 1.0),
            "rightx": _clamp(axis(sdl.SDL_GAMEPAD_AXIS_RIGHTX) / _STICK_DIVISOR, -1.0, 1.0),
            "righty": _clamp(axis(sdl.SDL_GAMEPAD_AXIS_RIGHTY) / _STICK_DIVISOR, -1.0, 1.0),
            "lefttrigger": _clamp(
                axis(sdl.SDL_GAMEPAD_AXIS_LEFT_TRIGGER) / _STICK_DIVISOR, 0.0, 1.0
            ),
            "righttrigger": _clamp(
                axis(sdl.SDL_GAMEPAD_AXIS_RIGHT_TRIGGER) / _STICK_DIVISOR, 0.0, 1.0
            ),
        }
        buttons = {
            "a": button(sdl.SDL_GAMEPAD_BUTTON_SOUTH),
            "b": button(sdl.SDL_GAMEPAD_BUTTON_EAST),
            "x": button(sdl.SDL_GAMEPAD_BUTTON_WEST),
            "y": button(sdl.SDL_GAMEPAD_BUTTON_NORTH),
            "leftshoulder": button(sdl.SDL_GAMEPAD_BUTTON_LEFT_SHOULDER),
            "rightshoulder": button(sdl.SDL_GAMEPAD_BUTTON_RIGHT_SHOULDER),
            "back": button(sdl.SDL_GAMEPAD_BUTTON_BACK),
            "start": button(sdl.SDL_GAMEPAD_BUTTON_START),
            "p1": button(sdl.SDL_GAMEPAD_BUTTON_RIGHT_PADDLE1),
            "p2": button(sdl.SDL_GAMEPAD_BUTTON_RIGHT_PADDLE2),
            "p3": button(sdl.SDL_GAMEPAD_BUTTON_LEFT_PADDLE1),
            "p4": button(sdl.SDL_GAMEPAD_BUTTON_LEFT_PADDLE2),
        }
        return ControllerState(axes=axes, buttons=buttons, connected=True)

    def close(self) -> None:
        if self._gamepad is not None and self._sdl is not None:
            self._sdl.SDL_CloseGamepad(self._gamepad)
            self._gamepad = None
        if self._initialized and self._sdl is not None:
            self._sdl.SDL_Quit()
            self._initialized = False
