// vpcal_capture — DeckLink input shim (live-capture plan Phase 2a).
//
// Wraps one DeckLink input device: device enumeration, input-mode negotiation
// (format auto-detect), the capture callback, and a bounded latest-wins ring
// buffer handed to Python as raw frames. Everything vision-related (v210
// unpack, detection) stays in Python (core/v210.py) — this shim only moves
// bytes across as fast as the card delivers them.
//
// Compiled ONLY when a local DeckLink SDK is present (see CMakeLists.txt);
// the on-card bring-up items (mode fallback matrix, RP188 source priority,
// reference-status polling) are marked TODO(bench) and belong to the
// hardware acceptance checklist (docs/decklink-bench-checklist.md).

#pragma once

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#ifdef _WIN32
// Windows has no shipped DeckLinkAPI.h — the SDK ships only DeckLinkAPI.idl,
// which MIDL compiles into DeckLinkAPI_h.h (+ DeckLinkAPI_i.c) at build time
// (see CMakeLists.txt). Mac/Linux use the header directly.
#include "DeckLinkAPI_h.h"
#else
#include "DeckLinkAPI.h"
#endif

namespace vpcal_capture {

// One captured frame, copied out of the DeckLink-owned buffer inside the
// callback (the SDK recycles its frame as soon as the callback returns).
struct RawFrame {
  std::vector<uint8_t> data;
  int32_t width = 0;
  int32_t height = 0;
  int32_t row_bytes = 0;
  std::string pixel_format;  // "v210" | "uyvy"
  std::string timecode;      // RP188/VITC "HH:MM:SS[:;]FF", empty if absent
  double hardware_time_s = 0.0;  // card hardware reference clock, seconds
  double frame_rate = 0.0;   // detected signal fps (0 until the mode is known)
};

struct DeviceInfo {
  int32_t index = 0;
  std::string name;
  // Available input connectors, as stable ids: "sdi" | "hdmi" | "optical_sdi" |
  // "component" | "composite" | "svideo". Empty for output-only cards (or when
  // the attribute query is unsupported) — never an error.
  std::vector<std::string> connectors;
};

// Enumerate attached DeckLink devices (empty when the driver is absent).
std::vector<DeviceInfo> list_devices();

// One opened input device. start() enables auto-detected input and begins
// streaming into an internal latest-wins queue (depth ~4: a stalled Python
// consumer drops old frames rather than growing without bound — the capture
// state machine only ever wants the freshest frame anyway).
class DeckLinkInput final : public IDeckLinkInputCallback {
 public:
  // connector (optional): one of the ids from DeviceInfo::connectors. When
  // non-empty it is validated against the card's advertised input connections
  // and selected for this session via IDeckLinkConfiguration (session-scoped —
  // never written to Desktop Video Setup preferences).
  explicit DeckLinkInput(int32_t device_index, const std::string& connector = "");
  // Not `override`: the COM base (IDeckLinkInputCallback → IUnknown) declares no
  // virtual destructor, so MSVC (correctly) rejects an overriding destructor.
  ~DeckLinkInput();

  void start();
  void stop();

  // Blocking pop with timeout; nullptr after stop() or on timeout.
  std::shared_ptr<RawFrame> next_frame(double timeout_s = 1.0);

  // Diagnostics for the session metadata / sync gate (plan Phase 2c).
  int64_t frames_seen() const { return frames_seen_.load(); }
  int64_t frames_dropped() const { return frames_dropped_.load(); }
  bool timecode_present() const { return timecode_present_.load(); }

  // IDeckLinkInputCallback
  HRESULT VideoInputFormatChanged(BMDVideoInputFormatChangedEvents events,
                                  IDeckLinkDisplayMode* mode,
                                  BMDDetectedVideoInputFormatFlags flags) override;
  HRESULT VideoInputFrameArrived(IDeckLinkVideoInputFrame* video,
                                 IDeckLinkAudioInputPacket* audio) override;

  // IUnknown (minimal, single-owner lifetime managed by this class)
  HRESULT QueryInterface(REFIID iid, LPVOID* ppv) override;
  ULONG AddRef() override;
  ULONG Release() override;

 private:
  void push_frame(std::shared_ptr<RawFrame> frame);

  IDeckLink* device_ = nullptr;
  IDeckLinkInput* input_ = nullptr;
  IDeckLinkConfiguration* config_ = nullptr;  // held when a connector is selected
  BMDPixelFormat pixel_format_ = bmdFormat10BitYUV;
  std::atomic<double> frame_rate_{0.0};  // detected mode fps, updated on format change

  std::mutex mutex_;
  std::condition_variable cv_;
  std::deque<std::shared_ptr<RawFrame>> queue_;
  static constexpr size_t kQueueDepth = 4;
  bool running_ = false;

  std::atomic<int64_t> frames_seen_{0};
  std::atomic<int64_t> frames_dropped_{0};
  std::atomic<bool> timecode_present_{false};
  std::atomic<ULONG> ref_count_{1};
};

}  // namespace vpcal_capture
