"""Localhost preview streaming server (plan Phase 0 PoC + Phase 1 preview chain).

Serves the *preview* stream only — an independently downsampled JPEG feed.
The calibration chain writes full-quality PNGs elsewhere and never touches
this encoder (precision red line #1).

Channels (PoC candidates, plan §5 Phase 0):

1. ``GET /preview.mjpg``  — MJPEG multipart/x-mixed-replace, for a webview
   ``<img src>`` (zero JS).
2. ``GET /preview.ws``    — minimal RFC 6455 WebSocket pushing binary frames:
   ``[8-byte little-endian float64 server wall-clock seconds][JPEG bytes]``,
   for a ``<canvas>`` consumer that can also measure end-to-end latency.
3. ``GET /poc``           — self-contained HTML measurement page exercising
   both channels and reporting fps / latency / dropped frames.

Dependency-free (stdlib ``http.server`` + ``hashlib``/``base64`` for the WS
handshake); JPEG encoding via the existing OpenCV dependency.
"""

from __future__ import annotations

import base64
import hashlib
import socket
import struct
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

_WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
_BOUNDARY = "vpcalframe"


class PreviewSink:
    """Thread-safe holder of the latest preview JPEG.

    ``publish`` downsamples + JPEG-encodes on the producer thread; consumers
    (HTTP/WS handler threads) block on a condition until a newer sequence
    number appears.  Slow consumers skip frames (latest-wins), never queue.
    """

    def __init__(self, max_width: int | None = 1920, jpeg_quality: int = 80) -> None:
        self.max_width = max_width
        self.jpeg_quality = jpeg_quality
        self._cond = threading.Condition()
        self._jpeg: bytes | None = None
        self._seq = 0
        self._ts = 0.0
        self._closed = False

    def publish(self, frame: np.ndarray) -> None:
        """Encode ``frame`` (grayscale or BGR, uint8/uint16) as the new preview."""
        import cv2

        img = frame
        if img.dtype == np.uint16:  # preview is 8-bit; keep top bits
            img = (img >> 8).astype(np.uint8)
        if self.max_width is not None and img.shape[1] > self.max_width:
            scale = self.max_width / img.shape[1]
            img = cv2.resize(img, (self.max_width, max(1, round(img.shape[0] * scale))),
                             interpolation=cv2.INTER_AREA)
        ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, self.jpeg_quality])
        if not ok:
            return
        with self._cond:
            self._jpeg = buf.tobytes()
            self._seq += 1
            self._ts = time.time()
            self._cond.notify_all()

    def close(self) -> None:
        with self._cond:
            self._closed = True
            self._cond.notify_all()

    @property
    def closed(self) -> bool:
        return self._closed

    def wait_next(self, last_seq: int, timeout: float = 5.0):
        """Block until a frame newer than ``last_seq`` → ``(jpeg, seq, ts)`` or None."""
        with self._cond:
            self._cond.wait_for(lambda: self._closed or self._seq > last_seq, timeout=timeout)
            if self._closed or self._jpeg is None or self._seq <= last_seq:
                return None
            return self._jpeg, self._seq, self._ts


_POC_PAGE = """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>vpcal preview PoC</title>
<style>
body { font-family: -apple-system, "PingFang SC", "Source Han Sans SC", sans-serif;
       background: #1a1a1a; color: #eee; margin: 16px; line-height: 1.7; }
.row { display: flex; gap: 16px; flex-wrap: wrap; }
.col { flex: 1; min-width: 480px; }
img, canvas { width: 100%; background: #000; border: 1px solid #444; }
code { font-family: ui-monospace, monospace; color: #8fd; }
.stats { white-space: pre; font-family: ui-monospace, monospace; font-size: 13px; }
</style></head><body>
<h2>vpcal 预览通道 PoC</h2>
<div class="row">
  <div class="col"><h3>通道 1：MJPEG <code>&lt;img&gt;</code>（显示路径，零 JS）</h3>
    <img id="mjpeg" src="/preview.mjpg">
    <div class="stats" id="mjpegStats">测量中（经 fetch 流解析旁路统计）…</div></div>
  <div class="col"><h3>通道 2：WebSocket + <code>&lt;canvas&gt;</code></h3>
    <canvas id="wsCanvas"></canvas>
    <div class="stats" id="wsStats">连接中…</div></div>
</div>
<script>
function mkStats() { return { n: 0, t0: performance.now(), lat: [], last: performance.now() }; }
function fmt(s, extra) {
  const dt = (performance.now() - s.t0) / 1000;
  const fps = dt > 0 ? (s.n / dt).toFixed(1) : "0";
  let lat = "n/a";
  if (s.lat.length) {
    const a = s.lat.slice(-90).sort((x, y) => x - y);
    lat = a[a.length >> 1].toFixed(0) + " ms (p50) / " + a[Math.floor(a.length * 0.9)].toFixed(0) + " ms (p90)";
  }
  return "帧数 " + s.n + "  fps " + fps + "  端到端延迟 " + lat + (extra || "");
}
// 通道 2:WS 二进制 [8B float64 服务器时钟秒][JPEG]
const ws = new WebSocket("ws://" + location.host + "/preview.ws");
ws.binaryType = "arraybuffer";
const wsS = mkStats(), canvas = document.getElementById("wsCanvas"), ctx2 = canvas.getContext("2d");
ws.onmessage = async (ev) => {
  const dv = new DataView(ev.data);
  const serverTs = dv.getFloat64(0, true);
  wsS.lat.push(Date.now() - serverTs * 1000);
  const blob = new Blob([ev.data.slice(8)], { type: "image/jpeg" });
  const bmp = await createImageBitmap(blob);
  if (canvas.width !== bmp.width) { canvas.width = bmp.width; canvas.height = bmp.height; }
  ctx2.drawImage(bmp, 0, 0); bmp.close();
  wsS.n++;
  document.getElementById("wsStats").textContent = fmt(wsS);
};
ws.onclose = () => { document.getElementById("wsStats").textContent += "  [已断开]"; };
// 通道 1 旁路统计:fetch 解析 multipart 边界计帧,X-Timestamp 头算延迟。
(async () => {
  const s = mkStats(), dec = new TextDecoder();
  const resp = await fetch("/preview.mjpg");
  const reader = resp.body.getReader();
  let tail = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    tail = (tail + dec.decode(value, { stream: true })).slice(-65536);
    let i;
    while ((i = tail.indexOf("X-Timestamp: ")) >= 0) {
      const j = tail.indexOf("\\r", i);
      if (j < 0) break;
      const ts = parseFloat(tail.slice(i + 13, j));
      if (isFinite(ts)) { s.n++; s.lat.push(Date.now() - ts * 1000); }
      tail = tail.slice(j + 1);
    }
    document.getElementById("mjpegStats").textContent = fmt(s, "  (旁路 fetch 统计)");
  }
})();
</script></body></html>
"""


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    sink: PreviewSink  # set by server factory

    def log_message(self, *args) -> None:  # stdout must stay data-only
        pass

    def do_GET(self) -> None:  # noqa: N802 — http.server API
        path = self.path.split("?", 1)[0]
        if path == "/preview.mjpg":
            self._serve_mjpeg()
        elif path == "/preview.ws":
            self._serve_ws()
        elif path in ("/", "/poc"):
            body = _POC_PAGE.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()

    def _serve_mjpeg(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", f"multipart/x-mixed-replace; boundary={_BOUNDARY}")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        last = 0
        try:
            while True:
                nxt = self.sink.wait_next(last)
                if nxt is None:
                    if self.sink.closed:
                        return
                    continue  # idle (signal drop): keep the stream open
                jpeg, last, ts = nxt
                part = (f"--{_BOUNDARY}\r\nContent-Type: image/jpeg\r\n"
                        f"Content-Length: {len(jpeg)}\r\nX-Timestamp: {ts:.6f}\r\n\r\n"
                        ).encode("ascii") + jpeg + b"\r\n"
                self.wfile.write(part)
        except (BrokenPipeError, ConnectionResetError, OSError):
            return

    def _serve_ws(self) -> None:
        key = self.headers.get("Sec-WebSocket-Key")
        if self.headers.get("Upgrade", "").lower() != "websocket" or not key:
            self.send_response(400)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        accept = base64.b64encode(
            hashlib.sha1((key + _WS_GUID).encode("ascii")).digest()
        ).decode("ascii")
        self.send_response(101, "Switching Protocols")
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()
        # Drain client frames in a side thread so close/ping don't stall us.
        stop = threading.Event()
        threading.Thread(target=self._ws_drain, args=(stop,), daemon=True).start()
        last = 0
        try:
            while not stop.is_set():
                nxt = self.sink.wait_next(last)
                if nxt is None:
                    if self.sink.closed:
                        return
                    continue  # idle (signal drop): keep the socket open
                jpeg, last, ts = nxt
                payload = struct.pack("<d", ts) + jpeg
                self.wfile.write(_ws_frame(payload))
        except (BrokenPipeError, ConnectionResetError, OSError):
            return
        finally:
            stop.set()

    def _ws_drain(self, stop: threading.Event) -> None:
        try:
            while not stop.is_set():
                hdr = self.rfile.read(2)
                if len(hdr) < 2:
                    break
                opcode = hdr[0] & 0x0F
                length = hdr[1] & 0x7F
                masked = bool(hdr[1] & 0x80)
                if length == 126:
                    length = struct.unpack("!H", self.rfile.read(2))[0]
                elif length == 127:
                    length = struct.unpack("!Q", self.rfile.read(8))[0]
                if masked:
                    self.rfile.read(4)
                if length:
                    self.rfile.read(length)
                if opcode == 0x8:  # close
                    break
        except OSError:
            pass
        finally:
            stop.set()
            try:
                self.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


def _ws_frame(payload: bytes) -> bytes:
    """Server→client unmasked binary frame (FIN + opcode 0x2)."""
    n = len(payload)
    if n < 126:
        header = bytes([0x82, n])
    elif n < 1 << 16:
        header = bytes([0x82, 126]) + struct.pack("!H", n)
    else:
        header = bytes([0x82, 127]) + struct.pack("!Q", n)
    return header + payload


class PreviewServer:
    """Threaded localhost preview server bound to 127.0.0.1.

    ``port=0`` picks a free port; read it back from ``.port`` after ``start()``.
    """

    def __init__(self, sink: PreviewSink, port: int = 0) -> None:
        self.sink = sink
        handler = type("BoundHandler", (_Handler,), {"sink": sink})
        self._httpd = ThreadingHTTPServer(("127.0.0.1", port), handler)
        self._httpd.daemon_threads = True
        self.port = self._httpd.server_address[1]
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self._thread = threading.Thread(target=self._httpd.serve_forever,
                                        name="vpcal-preview", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self.sink.close()
        self._httpd.shutdown()
        self._httpd.server_close()
        if self._thread is not None:
            self._thread.join(timeout=2.0)
            self._thread = None


__all__ = ["PreviewSink", "PreviewServer"]
