"""Preview streaming server (core/preview_server.py) — MJPEG + WebSocket."""

from __future__ import annotations

import base64
import hashlib
import socket
import struct
import threading
import time
import urllib.request

import numpy as np
import pytest

from vpcal.core.preview_server import PreviewServer, PreviewSink


@pytest.fixture()
def server():
    sink = PreviewSink(max_width=320, jpeg_quality=70)
    srv = PreviewServer(sink, port=0)
    srv.start()
    stop = threading.Event()

    def _pump() -> None:
        i = 0
        while not stop.is_set():
            frame = np.full((180, 320), (i * 16) % 256, dtype=np.uint8)
            sink.publish(frame)
            i += 1
            time.sleep(1 / 60)

    t = threading.Thread(target=_pump, daemon=True)
    t.start()
    yield srv
    stop.set()
    t.join(timeout=2.0)
    srv.stop()


def test_mjpeg_stream_delivers_jpeg_parts(server):
    with urllib.request.urlopen(
            f"http://127.0.0.1:{server.port}/preview.mjpg", timeout=5) as resp:
        assert "multipart/x-mixed-replace" in resp.headers["Content-Type"]
        blob = resp.read(60_000)
    assert b"--vpcalframe" in blob
    assert b"Content-Type: image/jpeg" in blob
    assert b"X-Timestamp: " in blob
    assert b"\xff\xd8\xff" in blob  # JPEG SOI marker


def test_websocket_frames_carry_timestamp_prefix(server):
    key = base64.b64encode(b"0123456789abcdef").decode()
    sock = socket.create_connection(("127.0.0.1", server.port), timeout=5)
    sock.sendall((f"GET /preview.ws HTTP/1.1\r\nHost: 127.0.0.1:{server.port}\r\n"
                  "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                  f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
                  ).encode())
    sock.settimeout(5)
    buf = b""
    while b"\r\n\r\n" not in buf:
        buf += sock.recv(4096)
    headers, rest = buf.split(b"\r\n\r\n", 1)
    assert b"101" in headers.splitlines()[0]
    expect = base64.b64encode(
        hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest())
    assert expect in headers

    def _read(n: int) -> bytes:
        nonlocal rest
        while len(rest) < n:
            rest += sock.recv(4096)
        out, rest = rest[:n], rest[n:]
        return out

    hdr = _read(2)
    assert hdr[0] == 0x82  # FIN + binary opcode
    length = hdr[1] & 0x7F
    if length == 126:
        length = struct.unpack("!H", _read(2))[0]
    elif length == 127:
        length = struct.unpack("!Q", _read(8))[0]
    payload = _read(length)
    ts = struct.unpack("<d", payload[:8])[0]
    assert abs(time.time() - ts) < 10.0
    assert payload[8:11] == b"\xff\xd8\xff"
    sock.close()


def test_poc_page_served(server):
    with urllib.request.urlopen(f"http://127.0.0.1:{server.port}/poc", timeout=5) as resp:
        html = resp.read().decode("utf-8")
    assert "preview.mjpg" in html and "preview.ws" in html


def test_preview_downsamples_wide_frames(server):
    # 1920-wide input published through a 320-max sink must stay small on the
    # wire: read one JPEG part and sanity-check its size (< ~80 KB).
    sink: PreviewSink = server.sink
    sink.publish(np.random.default_rng(0).integers(0, 255, (1080, 1920), dtype=np.uint8))
    got = sink.wait_next(0, timeout=2.0)
    assert got is not None
    jpeg, _seq, _ts = got
    assert len(jpeg) < 80_000
