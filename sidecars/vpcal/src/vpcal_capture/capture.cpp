// vpcal_capture — DeckLink input shim implementation (Phase 2a).
//
// Compiles only against a locally provided DeckLink SDK (CMake gate). The
// platform seams (COM on Windows vs dispatch TU elsewhere) are isolated in
// make_iterator(); everything else is plain SDK API.

#include "capture.h"

#include <chrono>
#include <stdexcept>

#ifdef _WIN32
#include <comdef.h>
#endif

namespace vpcal_capture {

namespace {

IDeckLinkIterator* make_iterator() {
#ifdef _WIN32
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
  static const BMDTimecodeFormat kFormats[] = {bmdTimecodeRP188Any, bmdTimecodeVITC,
                                               bmdTimecodeLTC};
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
    out.push_back(std::move(info));
    dev->Release();
  }
  it->Release();
  return out;
}

DeckLinkInput::DeckLinkInput(int32_t device_index) {
  device_ = device_at(device_index);
  if (device_->QueryInterface(IID_IDeckLinkInput,
                              reinterpret_cast<void**>(&input_)) != S_OK) {
    device_->Release();
    device_ = nullptr;
    throw std::runtime_error("device has no capture interface (output-only card?)");
  }
}

DeckLinkInput::~DeckLinkInput() {
  stop();
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
    throw std::runtime_error("EnableVideoInput failed (signal/driver state)");
  }
  if (input_->StartStreams() != S_OK) {
    input_->DisableVideoInput();
    throw std::runtime_error("StartStreams failed");
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
  frame->pixel_format =
      (video->GetPixelFormat() == bmdFormat10BitYUV) ? "v210" : "uyvy";

  void* bytes = nullptr;
  if (video->GetBytes(&bytes) != S_OK || !bytes) return S_OK;
  const auto* src = static_cast<const uint8_t*>(bytes);
  frame->data.assign(src, src + static_cast<size_t>(frame->row_bytes) * frame->height);

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
