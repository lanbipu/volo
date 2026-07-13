# vpcal_capture — Blackmagic DeckLink input shim (live-capture plan Phase 2a).
#
# The DeckLink SDK headers are NOT redistributable, so this module only builds
# when the user points DECKLINK_SDK_DIR (env var or CMake cache) at a local
# SDK's include directory. On macOS/Linux that directory holds DeckLinkAPI.h
# (+ DeckLinkAPIDispatch.cpp); on Windows the SDK ships only DeckLinkAPI.idl,
# which we compile with MIDL into DeckLinkAPI_h.h (+ DeckLinkAPI_i.c) at build
# time. Without a usable SDK the build SKIPS this target with a status note —
# the Python side then raises a guided PreconditionError at runtime
# (core/capture_backend.py DecklinkBackend).

set(_decklink_sdk "$ENV{DECKLINK_SDK_DIR}")
if(DECKLINK_SDK_DIR)
  set(_decklink_sdk "${DECKLINK_SDK_DIR}")
endif()

# Windows gates on the IDL (no shipped header); every other platform on the header.
if(WIN32)
  set(_decklink_gate "${_decklink_sdk}/DeckLinkAPI.idl")
  set(_decklink_gate_name "DeckLinkAPI.idl")
else()
  set(_decklink_gate "${_decklink_sdk}/DeckLinkAPI.h")
  set(_decklink_gate_name "DeckLinkAPI.h")
endif()

if(NOT _decklink_sdk OR NOT EXISTS "${_decklink_gate}")
  message(STATUS
    "vpcal_capture: DECKLINK_SDK_DIR not set (or ${_decklink_gate_name} not found) — "
    "skipping the DeckLink capture module. The decklink backend will report a "
    "guided precondition error at runtime.")
  return()
endif()

message(STATUS "vpcal_capture: building against DeckLink SDK at ${_decklink_sdk}")

set(_capture_sources bindings.cpp capture.cpp)
set(_capture_extra_includes "${_decklink_sdk}")

if(WIN32)
  # No shipped header — MIDL-compile DeckLinkAPI.idl into DeckLinkAPI_h.h and
  # the IID definitions DeckLinkAPI_i.c. Outputs land in the build tree only;
  # the SDK directory is never written to.
  find_program(MIDL_EXECUTABLE midl
    PATHS "$ENV{WindowsSdkVerBinPath}x64" "$ENV{WindowsSdkVerBinPath}x86")
  if(NOT MIDL_EXECUTABLE)
    message(FATAL_ERROR
      "vpcal_capture: midl.exe not found. Build from a Developer Command Prompt "
      "(run vcvars64.bat first) or install the Windows SDK, or pass "
      "-DMIDL_EXECUTABLE=<path-to-midl.exe>.")
  endif()
  set(_idl_out_dir "${CMAKE_CURRENT_BINARY_DIR}/decklink_idl")
  file(MAKE_DIRECTORY "${_idl_out_dir}")
  set(_idl_header "${_idl_out_dir}/DeckLinkAPI_h.h")
  set(_idl_iid "${_idl_out_dir}/DeckLinkAPI_i.c")
  add_custom_command(
    OUTPUT "${_idl_header}" "${_idl_iid}"
    COMMAND "${MIDL_EXECUTABLE}" /nologo /env x64 /notlb
            /I "${_decklink_sdk}"
            /h DeckLinkAPI_h.h /iid DeckLinkAPI_i.c
            "${_decklink_sdk}/DeckLinkAPI.idl"
    WORKING_DIRECTORY "${_idl_out_dir}"
    DEPENDS "${_decklink_sdk}/DeckLinkAPI.idl"
    COMMENT "MIDL-compiling DeckLinkAPI.idl → DeckLinkAPI_h.h + DeckLinkAPI_i.c"
    VERBATIM)
  list(APPEND _capture_sources "${_idl_iid}")
  list(APPEND _capture_extra_includes "${_idl_out_dir}")
elseif(EXISTS "${_decklink_sdk}/DeckLinkAPIDispatch.cpp")
  # macOS/Linux SDKs ship a dispatch TU that must be compiled into the consumer.
  list(APPEND _capture_sources "${_decklink_sdk}/DeckLinkAPIDispatch.cpp")
endif()

pybind11_add_module(_vpcal_capture ${_capture_sources})

target_include_directories(_vpcal_capture PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}
  ${_capture_extra_includes})

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
