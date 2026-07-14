// vpcal_capture — pybind11 surface (Phase 2a).
//
// Python contract consumed by core/capture_backend.py::DecklinkBackend:
//
//   vpcal._vpcal_capture.list_devices()
//       -> [{"index": int, "name": str, "connectors": [str, ...]}, ...]
//       connectors are stable ids ("sdi"/"hdmi"/…); empty for output-only cards.
//   inp = vpcal._vpcal_capture.DeckLinkInput(device_index, connector="")
//       connector selects an input line (session-scoped); "" keeps the current.
//   inp.start(); raw = inp.next_frame()  # None on stop/timeout
//   raw.data / raw.width / raw.height / raw.row_bytes / raw.pixel_format
//   raw.timecode ("" → None handled Python-side) / raw.hardware_time_s
//   raw.frame_rate (detected signal fps; 0.0 until the mode is known)
//   inp.frames_seen / inp.frames_dropped / inp.timecode_present
//   inp.stop()

#include <pybind11/pybind11.h>
#include <pybind11/stl.h>

#include "capture.h"

namespace py = pybind11;
using vpcal_capture::DeckLinkInput;
using vpcal_capture::DeviceInfo;
using vpcal_capture::RawFrame;

PYBIND11_MODULE(_vpcal_capture, m) {
  m.doc() = "Blackmagic DeckLink input shim for vpcal (built against a local SDK)";

  py::class_<RawFrame, std::shared_ptr<RawFrame>>(m, "RawFrame")
      .def_property_readonly("data",
                             [](const RawFrame& f) {
                               return py::bytes(
                                   reinterpret_cast<const char*>(f.data.data()),
                                   f.data.size());
                             })
      .def_readonly("width", &RawFrame::width)
      .def_readonly("height", &RawFrame::height)
      .def_readonly("row_bytes", &RawFrame::row_bytes)
      .def_readonly("pixel_format", &RawFrame::pixel_format)
      .def_readonly("timecode", &RawFrame::timecode)
      .def_readonly("hardware_time_s", &RawFrame::hardware_time_s)
      .def_readonly("frame_rate", &RawFrame::frame_rate);

  m.def("list_devices", [] {
    py::list out;
    for (const DeviceInfo& d : vpcal_capture::list_devices()) {
      py::dict item;
      item["index"] = d.index;
      item["name"] = d.name;
      item["connectors"] = d.connectors;
      out.append(std::move(item));
    }
    return out;
  });

  py::class_<DeckLinkInput>(m, "DeckLinkInput")
      .def(py::init<int32_t, const std::string&>(), py::arg("device_index"),
           py::arg("connector") = "")
      .def("start", &DeckLinkInput::start)
      .def("stop", &DeckLinkInput::stop)
      .def(
          "next_frame",
          [](DeckLinkInput& self, double timeout_s) -> py::object {
            std::shared_ptr<RawFrame> frame;
            {
              // Release the GIL while blocking on the capture queue.
              py::gil_scoped_release release;
              frame = self.next_frame(timeout_s);
            }
            if (!frame) return py::none();
            return py::cast(frame);
          },
          py::arg("timeout_s") = 1.0)
      .def_property_readonly("frames_seen", &DeckLinkInput::frames_seen)
      .def_property_readonly("frames_dropped", &DeckLinkInput::frames_dropped)
      .def_property_readonly("timecode_present", &DeckLinkInput::timecode_present);
}
