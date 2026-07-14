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
    # scikit-build-core / Ninja can activate cl.exe without exporting
    # WindowsSdkVerBinPath, leaving midl.exe off PATH. Fall back to the
    # installed Windows SDK bin directories (newest version first).
    file(GLOB _wk_sdk_dirs
      "C:/Program Files (x86)/Windows Kits/10/bin/10.*"
      "C:/Program Files/Windows Kits/10/bin/10.*")
    list(SORT _wk_sdk_dirs ORDER DESCENDING)
    set(_midl_hints)
    foreach(_wk ${_wk_sdk_dirs})
      list(APPEND _midl_hints "${_wk}/x64" "${_wk}/x86")
    endforeach()
    find_program(MIDL_EXECUTABLE midl PATHS ${_midl_hints})
  endif()
  if(NOT MIDL_EXECUTABLE)
    message(FATAL_ERROR
      "vpcal_capture: midl.exe not found. Build from a Developer Command Prompt "
      "(run vcvars64.bat first) or install the Windows SDK, or pass "
      "-DMIDL_EXECUTABLE=<path-to-midl.exe>.")
  endif()
  message(STATUS "vpcal_capture: using MIDL at ${MIDL_EXECUTABLE}")
  # DeckLinkAPI.idl `import "unknwn.idl"` (a Windows SDK system idl). midl finds
  # it via the INCLUDE env, which a non-vcvars build (e.g. scikit-build-core,
  # which activates cl but not the full SDK env) leaves unset. Derive the SDK
  # include dirs from the midl path and pass them explicitly so the build works
  # without a Developer Command Prompt.
  set(_midl_sys_includes)
  get_filename_component(_midl_arch_dir "${MIDL_EXECUTABLE}" DIRECTORY)   # bin/<ver>/x64
  get_filename_component(_midl_ver_dir "${_midl_arch_dir}" DIRECTORY)      # bin/<ver>
  get_filename_component(_sdk_ver "${_midl_ver_dir}" NAME)                 # <ver>
  get_filename_component(_wk_bin_dir "${_midl_ver_dir}" DIRECTORY)         # bin
  get_filename_component(_wk_root "${_wk_bin_dir}" DIRECTORY)              # Windows Kits/10
  set(_sdk_inc_root "${_wk_root}/Include/${_sdk_ver}")
  foreach(_sub shared um winrt)
    if(EXISTS "${_sdk_inc_root}/${_sub}")
      list(APPEND _midl_sys_includes /I "${_sdk_inc_root}/${_sub}")
    endif()
  endforeach()
  set(_idl_out_dir "${CMAKE_CURRENT_BINARY_DIR}/decklink_idl")
  file(MAKE_DIRECTORY "${_idl_out_dir}")
  set(_idl_header "${_idl_out_dir}/DeckLinkAPI_h.h")
  set(_idl_iid "${_idl_out_dir}/DeckLinkAPI_i.c")
  add_custom_command(
    OUTPUT "${_idl_header}" "${_idl_iid}"
    COMMAND "${MIDL_EXECUTABLE}" /nologo /env x64 /notlb
            # midl shells out to the C preprocessor (default: bare "cl"). Under
            # Ninja/scikit-build, cl.exe is invoked by full path and is not on
            # PATH, so point midl at the compiler CMake already located.
            /cpp_cmd "${CMAKE_CXX_COMPILER}"
            /I "${_decklink_sdk}" ${_midl_sys_includes}
            /h DeckLinkAPI_h.h /iid DeckLinkAPI_i.c
            "${_decklink_sdk}/DeckLinkAPI.idl"
    WORKING_DIRECTORY "${_idl_out_dir}"
    DEPENDS "${_decklink_sdk}/DeckLinkAPI.idl"
    COMMENT "MIDL-compiling DeckLinkAPI.idl → DeckLinkAPI_h.h + DeckLinkAPI_i.c"
    VERBATIM)
  # The generated IID table is a .c file. This project enables only CXX, so
  # CMake cannot deduce a language for the .c and would silently drop it from
  # the target as a non-compiled source (no error) — leaving the COM IID/CLSID
  # symbols undefined at link (LNK2001). Force it through the C++ compiler; a
  # midl /iid table is plain GUID definitions that compile cleanly as C++.
  set_source_files_properties("${_idl_iid}" PROPERTIES LANGUAGE CXX)
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
