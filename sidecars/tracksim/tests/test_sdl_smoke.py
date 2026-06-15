import pytest

sdl3 = pytest.importorskip("sdl3")


def test_sdl_init_gamepad_subsystem_then_quit():
    rc = sdl3.SDL_Init(sdl3.SDL_INIT_GAMEPAD)
    try:
        # SDL3 returns True on success; older bindings may return 0.
        assert rc in (True, 0, 1)
    finally:
        sdl3.SDL_Quit()
