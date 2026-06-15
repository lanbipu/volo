from tracksim.ports.controller_input import (
    CONTROLLER_AXES,
    CONTROLLER_BUTTONS,
    CONTROLLER_SOURCES,
)


def test_sources_cover_paddles_sticks_triggers():
    assert {"p1", "p2", "p3", "p4"} <= CONTROLLER_BUTTONS
    assert {"a", "b", "x", "y", "leftshoulder", "rightshoulder", "back", "start"} <= CONTROLLER_BUTTONS
    assert {"leftx", "lefty", "rightx", "righty", "lefttrigger", "righttrigger"} == CONTROLLER_AXES


def test_sources_is_union_and_disjoint():
    assert CONTROLLER_SOURCES == CONTROLLER_AXES | CONTROLLER_BUTTONS
    assert CONTROLLER_AXES.isdisjoint(CONTROLLER_BUTTONS)
