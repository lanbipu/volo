// vpcal_capture — DeckLink input shim implementation (Phase 2a).
//
// Compiles only against a locally provided DeckLink SDK (CMake gate). The
// platform seams (COM on Windows vs dispatch TU elsewhere) are isolated in
// make_iterator(); everything else is plain SDK API.

#include "capture.h"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <stdexcept>

#ifdef _WIN32
#include <comdef.h>
#endif

namespace vpcal_capture {

namespace {

IDeckLinkIterator* make_iterator() {
#ifdef _WIN32
  // COM must be initialised on this thread before CoCreateInstance. S_FALSE
  // (already initialised) and RPC_E_CHANGED_MODE (a different apartment model
  // is already active) are both fine for our use; a short-lived sidecar
  // process intentionally never calls CoUninitialize.
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  IDeckLinkIterator* it = nullptr;
  if (FAILED(CoCreateInstance(CLSID_CDeckLinkIterator, nullptr, CLSCTX_ALL,
                              IID_IDeckLinkIterator, reinterpret_cast<void**>(&it)))) {
    return nullptr;
  }
  return it;
#else
  return CreateDeckLinkIteratorInstance();
#endif
}

// BMDVideoConnection bit ↔ stable connector id. Iteration order (SDI first)
// determines the order connectors are listed and auto-selected.
struct ConnectorEntry {
  BMDVideoConnection bit;
  const char* id;
};
constexpr ConnectorEntry kConnectors[] = {
    {bmdVideoConnectionSDI, "sdi"},
    {bmdVideoConnectionHDMI, "hdmi"},
    {bmdVideoConnectionOpticalSDI, "optical_sdi"},
    {bmdVideoConnectionComponent, "component"},
    {bmdVideoConnectionComposite, "composite"},
    {bmdVideoConnectionSVideo, "svideo"},
};

std::vector<std::string> connectors_from_mask(int64_t mask) {
  std::vector<std::string> out;
  for (const auto& e : kConnectors) {
    if (mask & e.bit) out.emplace_back(e.id);
  }
  return out;
}

// Returns the connection bit for a connector id, or 0 for an unknown id.
BMDVideoConnection connector_bit(const std::string& id) {
  for (const auto& e : kConnectors) {
    if (id == e.id) return e.bit;
  }
  return static_cast<BMDVideoConnection>(0);
}

// A device's advertised input connections. Empty on failure or for output-only
// cards (no capture connectors) — never an error.
std::vector<std::string> query_input_connectors(IDeckLink* dev) {
  IDeckLinkProfileAttributes* attrs = nullptr;
  if (dev->QueryInterface(IID_IDeckLinkProfileAttributes,
                          reinterpret_cast<void**>(&attrs)) != S_OK ||
      !attrs) {
    return {};
  }
  int64_t mask = 0;
  const HRESULT hr = attrs->GetInt(BMDDeckLinkVideoInputConnections, &mask);
  attrs->Release();
  if (hr != S_OK) return {};
  return connectors_from_mask(mask);
}

// SDK pixel format → the id the Python side unpacks. Explicit mapping so an RGB
// (10BitRGB/r210) or unexpected format is never mislabelled as UYVY.
std::string pixel_format_id(BMDPixelFormat fmt) {
  switch (fmt) {
    case bmdFormat10BitYUV:
      return "v210";
    case bmdFormat8BitYUV:
      return "uyvy";
    case bmdFormat10BitRGB:
      return "r210";
    default:
      return "unknown";
  }
}

std::string to_std_string(
#ifdef _WIN32
    BSTR s
#elif defined(__APPLE__)
    CFStringRef s
#else
    const char* s
#endif
) {
#ifdef _WIN32
  if (!s) return {};
  _bstr_t b(s, false);
  return std::string(static_cast<const char*>(b));
#elif defined(__APPLE__)
  if (!s) return {};
  char buf[256] = {0};
  CFStringGetCString(s, buf, sizeof(buf), kCFStringEncodingUTF8);
  CFRelease(s);
  return std::string(buf);
#else
  if (!s) return {};
  std::string out(s);
  free(const_cast<char*>(s));
  return out;
#endif
}

IDeckLink* device_at(int32_t index) {
  IDeckLinkIterator* it = make_iterator();
  if (!it) {
    throw std::runtime_error(
        "DeckLink driver not installed (CreateDeckLinkIteratorInstance failed)");
  }
  IDeckLink* dev = nullptr;
  int32_t i = 0;
  while (it->Next(&dev) == S_OK) {
    if (i == index) {
      it->Release();
      return dev;  // caller owns
    }
    dev->Release();
    ++i;
  }
  it->Release();
  throw std::runtime_error("DeckLink device index out of range: " +
                           std::to_string(index) + " (found " + std::to_string(i) + ")");
}

std::string timecode_string(IDeckLinkVideoInputFrame* frame) {
  // TODO(bench): RP188 source priority (VITC1 → VITC2 → LTC) to be tuned on
  // real signal chains; auto-detect order below is the common case.
  // bmdTimecodeRP188Any already returns the first valid RP188 timecode
  // (HFRTC/VITC1/VITC2/LTC); bmdTimecodeSerial covers standalone serial LTC.
  static const BMDTimecodeFormat kFormats[] = {bmdTimecodeRP188Any, bmdTimecodeVITC,
                                               bmdTimecodeSerial};
  for (BMDTimecodeFormat fmt : kFormats) {
    IDeckLinkTimecode* tc = nullptr;
    if (frame->GetTimecode(fmt, &tc) == S_OK && tc) {
      uint8_t hh = 0, mm = 0, ss = 0, ff = 0;
      tc->GetComponents(&hh, &mm, &ss, &ff);
      const bool drop = (tc->GetFlags() & bmdTimecodeIsDropFrame) != 0;
      tc->Release();
      char buf[16];
      snprintf(buf, sizeof(buf), "%02u:%02u:%02u%c%02u", hh, mm, ss, drop ? ';' : ':', ff);
      return buf;
    }
  }
  return {};
}

}  // namespace

std::vector<DeviceInfo> list_devices() {
  std::vector<DeviceInfo> out;
  IDeckLinkIterator* it = make_iterator();
  if (!it) return out;  // no driver — empty list, Python raises the guided error
  IDeckLink* dev = nullptr;
  int32_t i = 0;
  while (it->Next(&dev) == S_OK) {
#ifdef _WIN32
    BSTR name = nullptr;
#elif defined(__APPLE__)
    CFStringRef name = nullptr;
#else
    const char* name = nullptr;
#endif
    DeviceInfo info;
    info.index = i++;
    if (dev->GetDisplayName(&name) == S_OK) info.name = to_std_string(name);
    info.connectors = query_input_connectors(dev);
    out.push_back(std::move(info));
    dev->Release();
  }
  it->Release();
  return out;
}

DeckLinkInput::DeckLinkInput(int32_t device_index, const std::string& connector) {
  device_ = device_at(device_index);
  if (device_->QueryInterface(IID_IDeckLinkInput,
                              reinterpret_cast<void**>(&input_)) != S_OK) {
    device_->Release();
    device_ = nullptr;
    throw std::runtime_error("device has no capture interface (output-only card?)");
  }
  // A throw from a constructor does NOT run this object's destructor, so every
  // early exit below must release what it has acquired by hand.
  if (!connector.empty()) {
    const BMDVideoConnection bit = connector_bit(connector);
    const std::vector<std::string> available = query_input_connectors(device_);
    const bool valid =
        bit != 0 &&
        std::find(available.begin(), available.end(), connector) != available.end();
    if (!valid) {
      std::string have;
      for (const std::string& c : available) {
        if (!have.empty()) have += ", ";
        have += c;
      }
      input_->Release();
      input_ = nullptr;
      device_->Release();
      device_ = nullptr;
      throw std::runtime_error("connector '" + connector +
                               "' not available on this device (have: " +
                               (have.empty() ? "none" : have) + ")");
    }
    if (device_->QueryInterface(IID_IDeckLinkConfiguration,
                                reinterpret_cast<void**>(&config_)) != S_OK ||
        !config_) {
      input_->Release();
      input_ = nullptr;
      device_->Release();
      device_ = nullptr;
      throw std::runtime_error(
          "device has no configuration interface for connector selection");
    }
    if (config_->SetInt(bmdDeckLinkConfigVideoInputConnection, bit) != S_OK) {
      config_->Release();
      config_ = nullptr;
      input_->Release();
      input_ = nullptr;
      device_->Release();
      device_ = nullptr;
      throw std::runtime_error("failed to select connector '" + connector + "'");
    }
    // Session-scoped only: deliberately NOT calling
    // WriteConfigurationToPreferences — this must not mutate the persistent
    // Desktop Video Setup input selection.
  }
}

DeckLinkInput::~DeckLinkInput() {
  stop();
  if (config_) config_->Release();
  if (input_) input_->Release();
  if (device_) device_->Release();
}

void DeckLinkInput::start() {
  std::lock_guard<std::mutex> lock(mutex_);
  if (running_) return;
  input_->SetCallback(this);
  // Enable with format auto-detection: start in 1080p25/v210 and let
  // VideoInputFormatChanged renegotiate to the actual signal.
  // TODO(bench): verify the auto-detect path across 1080p50/59.94/60 and
  // 4K modes on the real card matrix (acceptance checklist item 2).
  HRESULT hr = input_->EnableVideoInput(bmdModeHD1080p25, pixel_format_,
                                        bmdVideoInputEnableFormatDetection);
  if (hr != S_OK) {
    char buf[96];
    std::snprintf(buf, sizeof(buf),
                  "EnableVideoInput failed (hr=0x%08lX%s)",
                  static_cast<unsigned long>(hr),
                  // BMD's Windows driver reports an in-use device as E_FAIL
                  // (verified on UltraStudio 4K Mini), not just E_ACCESSDENIED.
                  hr == E_ACCESSDENIED || hr == E_FAIL
                      ? ", device busy / in use by another application"
                      : "");
    throw std::runtime_error(buf);
  }
  hr = input_->StartStreams();
  if (hr != S_OK) {
    input_->DisableVideoInput();
    char buf[64];
    std::snprintf(buf, sizeof(buf), "StartStreams failed (hr=0x%08lX)",
                  static_cast<unsigned long>(hr));
    throw std::runtime_error(buf);
  }
  running_ = true;
}

void DeckLinkInput::stop() {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!running_) return;
    running_ = false;
  }
  input_->StopStreams();
  input_->DisableVideoInput();
  input_->SetCallback(nullptr);
  cv_.notify_all();
}

std::shared_ptr<RawFrame> DeckLinkInput::next_frame(double timeout_s) {
  std::unique_lock<std::mutex> lock(mutex_);
  cv_.wait_for(lock, std::chrono::duration<double>(timeout_s),
               [&] { return !queue_.empty() || !running_; });
  if (queue_.empty()) return nullptr;
  auto frame = queue_.front();
  queue_.pop_front();
  return frame;
}

void DeckLinkInput::push_frame(std::shared_ptr<RawFrame> frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!running_) return;
  if (queue_.size() >= kQueueDepth) {
    queue_.pop_front();  // latest-wins: drop the oldest
    frames_dropped_.fetch_add(1);
  }
  queue_.push_back(std::move(frame));
  cv_.notify_one();
}

HRESULT DeckLinkInput::VideoInputFormatChanged(BMDVideoInputFormatChangedEvents,
                                               IDeckLinkDisplayMode* mode,
                                               BMDDetectedVideoInputFormatFlags flags) {
  // Renegotiate to the detected mode; prefer 10-bit when the signal is YUV.
  pixel_format_ = (flags & bmdDetectedVideoInputRGB444) ? bmdFormat10BitRGB
                                                        : bmdFormat10BitYUV;
  // Cache the detected frame rate (fps = timeScale / frameDuration) so the
  // capture reports the real signal rate — the auto-detect path starts at
  // 1080p25 and only knows the true rate once the mode is detected here.
  BMDTimeValue frame_duration = 0;
  BMDTimeScale time_scale = 0;
  if (mode->GetFrameRate(&frame_duration, &time_scale) == S_OK && frame_duration > 0) {
    frame_rate_.store(static_cast<double>(time_scale) / static_cast<double>(frame_duration));
  }
  input_->PauseStreams();
  input_->EnableVideoInput(mode->GetDisplayMode(), pixel_format_,
                           bmdVideoInputEnableFormatDetection);
  input_->FlushStreams();
  input_->StartStreams();
  return S_OK;
}

HRESULT DeckLinkInput::VideoInputFrameArrived(IDeckLinkVideoInputFrame* video,
                                              IDeckLinkAudioInputPacket*) {
  if (!video) return S_OK;
  if (video->GetFlags() & bmdFrameHasNoInputSource) return S_OK;

  auto frame = std::make_shared<RawFrame>();
  frame->width = static_cast<int32_t>(video->GetWidth());
  frame->height = static_cast<int32_t>(video->GetHeight());
  frame->row_bytes = static_cast<int32_t>(video->GetRowBytes());
  frame->pixel_format = pixel_format_id(video->GetPixelFormat());
  frame->frame_rate = frame_rate_.load();

  // SDK 16.0 (14.3+) removed IDeckLinkVideoFrame::GetBytes; frame memory is now
  // reached through IDeckLinkVideoBuffer inside an explicit access window. Any
  // step failing just drops this frame — the callback thread must never throw.
  IDeckLinkVideoBuffer* buffer = nullptr;
  if (video->QueryInterface(IID_IDeckLinkVideoBuffer,
                            reinterpret_cast<void**>(&buffer)) != S_OK ||
      !buffer) {
    return S_OK;
  }
  if (buffer->StartAccess(bmdBufferAccessRead) != S_OK) {
    buffer->Release();
    return S_OK;
  }
  void* bytes = nullptr;
  if (buffer->GetBytes(&bytes) == S_OK && bytes) {
    const auto* src = static_cast<const uint8_t*>(bytes);
    frame->data.assign(src,
                       src + static_cast<size_t>(frame->row_bytes) * frame->height);
  }
  buffer->EndAccess(bmdBufferAccessRead);
  buffer->Release();
  if (frame->data.empty()) return S_OK;  // buffer access failed — drop the frame

  frame->timecode = timecode_string(video);
  timecode_present_.store(!frame->timecode.empty());

  BMDTimeValue t = 0, dur = 0;
  if (video->GetHardwareReferenceTimestamp(1000000, &t, &dur) == S_OK) {
    frame->hardware_time_s = static_cast<double>(t) / 1e6;
  }

  frames_seen_.fetch_add(1);
  push_frame(std::move(frame));
  return S_OK;
}

HRESULT DeckLinkInput::QueryInterface(REFIID, LPVOID*) { return E_NOINTERFACE; }
ULONG DeckLinkInput::AddRef() { return ++ref_count_; }
ULONG DeckLinkInput::Release() { return --ref_count_; }  // lifetime owned by C++ side

}  // namespace vpcal_capture
