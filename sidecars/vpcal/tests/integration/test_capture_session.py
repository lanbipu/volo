"""Closed-loop capture session (core/capture_session.py + CLI) — plan Phase 1b.

End-to-end without hardware: a synthetic video backend plays the generated
VP-QSP pattern (simulating a camera that frames the whole LED wall), a FreeD
UDP loopback sender simulates the tracked camera parking on successive poses,
and the state machine must settle→burst→detect→advance into a session
directory that `vpcal quick run` accepts (validate + detect stages).
"""

from __future__ import annotations

import json
import itertools
import socket
import threading
import time
from pathlib import Path

import cv2
import numpy as np
import pytest

from vpcal.core.capture_backend import CaptureConfig, CapturedFrame, SyntheticBackend
from vpcal.core.capture_session import CaptureSessionRunner, SessionCaptureConfig
from vpcal.core.errors import PreconditionError
from vpcal.core.freed import FreeDPose, encode_freed_d1
from vpcal.core.pattern import generate_pattern_images
from vpcal.io.screen_io import save_screen
from vpcal.models.screen import PlaneSection, ScreenDefinition
from vpcal.models.session import SessionConfig


def _screen() -> ScreenDefinition:
    return ScreenDefinition(
        name="bench", unit="mm", cabinet_size=(500, 500), led_pixel_pitch_mm=2.0,
        markers_per_cabinet=4,
        sections=[PlaneSection(name="w", width_mm=1000, height_mm=1000, origin=[0, 0, 0])],
    )


def _lens_json(tmp_path: Path, w: int, h: int) -> Path:
    lens = {
        "focal_length_mm": 24.0, "sensor_width_mm": 36.0, "sensor_height_mm": 24.0,
        "image_width_px": w, "image_height_px": h,
    }
    p = tmp_path / "lens.json"
    p.write_text(json.dumps(lens))
    return p


class _FreeDSender:
    """60 Hz FreeD loopback: still 0.9 s at x = k·0.3 m, then 0.45 s ramp."""

    STILL_S = 0.9
    RAMP_S = 0.45

    def __init__(self, port: int) -> None:
        self.port = port
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def __enter__(self) -> "_FreeDSender":
        self._thread.start()
        return self

    def __exit__(self, *exc) -> None:
        self._stop.set()
        self._thread.join(timeout=2.0)

    def _x_at(self, t: float) -> float:
        period = self.STILL_S + self.RAMP_S
        seg, within = divmod(t, period)
        base = seg * 0.3
        if within <= self.STILL_S:
            return base
        return base + 0.3 * (within - self.STILL_S) / self.RAMP_S

    def _run(self) -> None:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        t0 = time.monotonic()
        while not self._stop.is_set():
            t = time.monotonic() - t0
            pose = FreeDPose(1, 10.0, 5.0, 0.0, self._x_at(t), 0.0, 1.5, 0, 0)
            sock.sendto(encode_freed_d1(pose), ("127.0.0.1", self.port))
            time.sleep(1 / 60)
        sock.close()


def _free_udp_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _pattern_backend(tmp_path: Path, screen: ScreenDefinition) -> tuple[SyntheticBackend, int, int]:
    generate_pattern_images(screen, tmp_path / "pattern", markers_per_cabinet=4)
    img = cv2.imread(str(tmp_path / "pattern" / "normal.png"), cv2.IMREAD_GRAYSCALE)
    assert img is not None
    backend = SyntheticBackend()
    backend.open(CaptureConfig(backend="synthetic", fps=30,
                               extra={"script": [img], "realtime": True}))
    return backend, img.shape[1], img.shape[0]


@pytest.mark.slow
def test_session_end_to_end_quick_run_compatible(tmp_path):
    screen = _screen()
    screen_path = tmp_path / "screen.json"
    save_screen(screen, screen_path)
    backend, w, h = _pattern_backend(tmp_path, screen)
    port = _free_udp_port()
    out = tmp_path / "session"
    events: list[tuple[str, dict]] = []

    cfg = SessionCaptureConfig(
        out_dir=out, screen_path=screen_path,
        backend=CaptureConfig(backend="synthetic"),
        track_port=port, poses_target=3,
        settle_duration_s=0.2, settle_speed_mm_s=5.0, move_speed_mm_s=25.0,
        burst_frames=3, lens_path=_lens_json(tmp_path, w, h),
    )
    with _FreeDSender(port):
        runner = CaptureSessionRunner(cfg, backend, lambda t, p: events.append((t, p)))
        data = runner.run()

    # ── session artifact ─────────────────────────────────────────────
    assert data["poses_captured"] == 3
    assert data["lens_ready"] is True
    for i in (1, 2, 3):
        assert (out / "captures" / "normal" / f"{i:04d}.png").is_file()
    poses = [json.loads(ln) for ln in
             (out / "tracking" / "poses.jsonl").read_text().splitlines() if ln.strip()]
    assert [p["frame_id"] for p in poses] == [1, 2, 3]
    # Successive poses parked ~300 mm apart (allow generous jitter).
    xs = [p["position"][0] for p in poses]
    assert xs[1] - xs[0] == pytest.approx(300.0, abs=60.0)
    assert xs[2] - xs[1] == pytest.approx(300.0, abs=60.0)

    meta = json.loads((out / "capture_meta.json").read_text())
    assert meta["capture"]["clock_domain"] == "time.monotonic"
    assert meta["timings"]["total_s"] > 0
    assert len(meta["timings"]["poses"]) == 3

    # ── event stream ─────────────────────────────────────────────────
    kinds = [k for k, _ in events]
    assert kinds.count("pose_captured") == 3
    assert kinds.count("detect_feedback") == 3
    assert kinds.count("coverage_update") == 3
    hits = [p["marker_hits"] for k, p in events if k == "detect_feedback"]
    # Full wall in frame → all markers (2×2 cabinets × 4 markers each).
    assert all(hit == 16 for hit in hits), hits
    cov = [p for k, p in events if k == "coverage_update"][-1]
    assert cov["screen_coverage_pct"] == 1.0
    assert {item["key"] for item in cov["gate_checklist"]} == {
        "angular_spread", "edge_observations", "poses", "observations",
        "sensor_corners", "sensor_center",
    }
    assert cov["angular_spread_deg"] >= 0.0
    assert 0.0 <= cov["edge_obs_fraction"] <= 1.0

    # ── quick run consumes it (validate + detect stages) ─────────────
    from vpcal.core.pipeline import run_quick

    raw = json.loads((out / "session.json").read_text())
    session = SessionConfig.model_validate(raw)
    r = run_quick(session, out, tmp_path / "qr", raw_session=raw, stage="validate")
    assert r["exit_code"] == 0
    assert r["validation"]["matched"] == 3
    r = run_quick(session, out, tmp_path / "qr", raw_session=raw, stage="detect")
    assert r["exit_code"] == 0


@pytest.mark.slow
def test_session_inverted_via_pattern_ready_ack(tmp_path):
    """Control-channel pattern switching: inverted frames land per pose."""
    screen = _screen()
    screen_path = tmp_path / "screen.json"
    save_screen(screen, screen_path)
    backend, _w, _h = _pattern_backend(tmp_path, screen)
    port = _free_udp_port()
    out = tmp_path / "session"
    events: list[tuple[str, dict]] = []

    cfg = SessionCaptureConfig(
        out_dir=out, screen_path=screen_path,
        backend=CaptureConfig(backend="synthetic"),
        track_port=port, poses_target=1,
        settle_duration_s=0.2, burst_frames=2, inverted=True, pattern_wait_s=5.0,
    )
    with _FreeDSender(port):
        runner = CaptureSessionRunner(cfg, backend, lambda t, p: events.append((t, p)))

        def _ack_pump() -> None:
            # Ack every playback request as soon as it appears.
            seen = 0
            for _ in range(200):
                reqs = [p for k, p in events if k == "request_pattern"]
                for req in reqs[seen:]:
                    runner.post({"cmd": "pattern_ready", "pattern": req["pattern"]})
                seen = len(reqs)
                time.sleep(0.05)

        threading.Thread(target=_ack_pump, daemon=True).start()
        data = runner.run()

    assert data["poses_captured"] == 1
    assert (out / "captures" / "inverted" / "0001.png").is_file()
    pose_evt = next(p for k, p in events if k == "pose_captured")
    assert pose_evt["inverted_captured"] is True


def test_session_no_tracking_times_out(tmp_path):
    screen = _screen()
    screen_path = tmp_path / "screen.json"
    save_screen(screen, screen_path)
    backend = SyntheticBackend()
    backend.open(CaptureConfig(backend="synthetic", width=64, height=64, fps=120,
                               extra={"realtime": False}))
    cfg = SessionCaptureConfig(
        out_dir=tmp_path / "s", screen_path=screen_path,
        backend=CaptureConfig(backend="synthetic"),
        track_port=_free_udp_port(), tracking_wait_s=0.5)
    runner = CaptureSessionRunner(cfg, backend, lambda t, p: None)
    with pytest.raises(PreconditionError, match="no tracking packets"):
        runner.run()


def test_session_stop_command_aborts(tmp_path):
    screen = _screen()
    screen_path = tmp_path / "screen.json"
    save_screen(screen, screen_path)
    backend = SyntheticBackend()
    backend.open(CaptureConfig(backend="synthetic", width=64, height=64, fps=60))
    port = _free_udp_port()
    cfg = SessionCaptureConfig(
        out_dir=tmp_path / "s", screen_path=screen_path,
        backend=CaptureConfig(backend="synthetic"), track_port=port)
    with _FreeDSender(port):
        runner = CaptureSessionRunner(cfg, backend, lambda t, p: None)
        threading.Timer(0.8, lambda: runner.post({"cmd": "stop"})).start()
        with pytest.raises(PreconditionError, match="aborted"):
            runner.run()


@pytest.mark.parametrize(
    "decoded_inverted,expected",
    [(True, True), (False, False), (None, False)],
)
def test_graycode_evidence_is_fail_closed_even_with_ack(
    tmp_path, monkeypatch, decoded_inverted, expected
):
    from vpcal.core.graycode import DecodedTag

    screen_path = tmp_path / "screen.json"
    save_screen(_screen(), screen_path)
    backend = SyntheticBackend()
    cfg = SessionCaptureConfig(
        out_dir=tmp_path / "s", screen_path=screen_path,
        backend=CaptureConfig(backend="synthetic"), graycode_sync=True,
        allow_ack_without_graycode=False, pattern_wait_s=0.15,
    )
    events = []
    runner = CaptureSessionRunner(cfg, backend, lambda kind, payload: events.append((kind, payload)))
    runner.post({"cmd": "pattern_ready", "pattern": "inverted"})
    if decoded_inverted is None:
        monkeypatch.setattr("vpcal.core.capture_session.decode_tag", lambda *_a, **_k: None)
    else:
        tag = DecodedTag(1, decoded_inverted, "tl", 1.0)
        monkeypatch.setattr("vpcal.core.capture_session.decode_tag", lambda *_a, **_k: tag)
    tick = iter([0.0, 0.05, 0.10, 0.20, 0.30])
    monkeypatch.setattr("vpcal.core.capture_session.time.monotonic", lambda: next(tick))
    frame = CapturedFrame(np.zeros((64, 320), np.uint8), recv_ts=0.0)
    _out, ok = runner._wait_pattern(itertools.repeat(frame), "inverted")
    assert ok is expected
    if decoded_inverted is False:
        assert any(kind == "warning" and "contradicts" in payload["message"]
                   for kind, payload in events)


@pytest.mark.slow
def test_cli_session_ndjson_stream(tmp_path):
    """CLI adapter: NDJSON event flow + final result envelope + exit 0."""
    from click.testing import CliRunner

    from vpcal.cli.main import cli

    screen = _screen()
    screen_path = tmp_path / "screen.json"
    save_screen(screen, screen_path)
    port = _free_udp_port()
    out = tmp_path / "session"

    with _FreeDSender(port):
        result = CliRunner().invoke(cli, [
            "capture", "session",
            "--screen", str(screen_path), "--out", str(out),
            "--backend", "synthetic", "--width", "320", "--height", "180", "--fps", "60",
            "--track-port", str(port), "--poses", "1",
            "--settle-ms", "200", "--burst", "2",
            "--no-control-stdin", "--output", "ndjson",
        ])
    assert result.exit_code == 0, result.output
    lines = [json.loads(ln) for ln in result.output.splitlines() if ln.strip()]
    assert lines[0]["type"] == "start"
    kinds = [ln["type"] for ln in lines]
    assert "progress" in kinds and "pose_captured" in kinds
    final = lines[-1]
    assert final["type"] == "result" and final["final"] is True
    assert final["status"] == "ok" and final["operation_id"] == "capture.session"
    assert final["data"]["poses_captured"] == 1
    # Sequences strictly increase.
    seqs = [ln["sequence"] for ln in lines]
    assert seqs == sorted(seqs) and len(set(seqs)) == len(seqs)
