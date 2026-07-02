# vpcal_capture — Blackmagic DeckLink input shim (live-capture plan Phase 2a).
#
# The DeckLink SDK headers are NOT redistributable, so this module only builds
# when the user points DECKLINK_SDK_DIR (env var or CMake cache) at a local
# SDK's include directory (the one containing DeckLinkAPI.h on Win/Linux, or
# DeckLinkAPI.h + DeckLinkAPIDispatch.cpp on macOS/Linux). Without it the
# build SKIPS this target with a status note — the Python side then raises a
# guided PreconditionError at runtime (core/capture_backend.py DecklinkBackend).

set(_decklink_sdk "$ENV{DECKLINK_SDK_DIR}")
if(DECKLINK_SDK_DIR)
  set(_decklink_sdk "${DECKLINK_SDK_DIR}")
endif()

if(NOT _decklink_sdk OR NOT EXISTS "${_decklink_sdk}/DeckLinkAPI.h")
  message(STATUS
    "vpcal_capture: DECKLINK_SDK_DIR not set (or DeckLinkAPI.h not found) — "
    "skipping the DeckLink capture module. The decklink backend will report a "
    "guided precondition error at runtime.")
  return()
endif()

message(STATUS "vpcal_capture: building against DeckLink SDK at ${_decklink_sdk}")

set(_capture_sources bindings.cpp capture.cpp)
# macOS/Linux SDKs ship a dispatch TU that must be compiled into the consumer;
# Windows uses COM (IID lookups via CoCreateInstance) and has no dispatch file.
if(NOT WIN32 AND EXISTS "${_decklink_sdk}/DeckLinkAPIDispatch.cpp")
  list(APPEND _capture_sources "${_decklink_sdk}/DeckLinkAPIDispatch.cpp")
endif()

pybind11_add_module(_vpcal_capture ${_capture_sources})

target_include_directories(_vpcal_capture PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}
  "${_decklink_sdk}")

set_target_properties(_vpcal_capture PROPERTIES
  CXX_STANDARD 17
  CXX_STANDARD_REQUIRED ON)

if(APPLE)
  target_link_libraries(_vpcal_capture PRIVATE "-framework CoreFoundation")
elseif(WIN32)
  target_link_libraries(_vpcal_capture PRIVATE ole32 oleaut32 comsuppw)
else()
  target_link_libraries(_vpcal_capture PRIVATE dl pthread)
endif()

# Installed into the vpcal package (same convention as _vpcal_solver):
# `from vpcal import _vpcal_capture` — a top-level name would collide with
# this source directory under editable installs (PEP 420 namespace package).
install(TARGETS _vpcal_capture DESTINATION vpcal)
