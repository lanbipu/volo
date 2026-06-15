import io
import json

from tracksim.cli import render
from tracksim.domain.pose import CameraPose
from tracksim.envelope import success_envelope, error_envelope
from tracksim.simulator import SimStarted, SimTick, SimWarning, SimStopped


def test_render_success_json_is_pure_json():
    env = success_envelope(
        "meta.version", {"version": "0.1.0"},
        request_id="r1", duration_ms=1, timestamp="2026-06-02T00:00:00Z",
    )
    out = render.render_success(env, "json")
    assert json.loads(out) == env


def test_render_error_json_is_pure_json():
    env = error_envelope(
        "sim.send", code="TRANSPORT_SEND_FAILED", exit_code=11,
        message="boom", retryable=True, details={"k": "v"},
        request_id="r2", duration_ms=2, timestamp="2026-06-02T00:00:01Z",
    )
    out = render.render_error(env, "json")
    assert json.loads(out) == env


def test_render_success_text_is_human_readable():
    env = success_envelope(
        "meta.version", {"version": "0.1.0"},
        request_id="r1", duration_ms=1, timestamp="2026-06-02T00:00:00Z",
    )
    out = render.render_success(env, "text")
    assert "0.1.0" in out
    assert not out.startswith("{")


def test_render_error_text_includes_code_and_message():
    env = error_envelope(
        "sim.send", code="TRANSPORT_SEND_FAILED", exit_code=11,
        message="boom", retryable=True, details={},
        request_id="r2", duration_ms=2, timestamp="2026-06-02T00:00:01Z",
    )
    out = render.render_error(env, "text")
    assert "TRANSPORT_SEND_FAILED" in out
    assert "boom" in out


def test_render_success_ndjson_single_final_line():
    env = success_envelope(
        "config.show", {"k": "v"},
        request_id="r1", duration_ms=1, timestamp="2026-06-02T00:00:00Z",
    )
    out = render.render_success(env, "ndjson")
    lines = [ln for ln in out.splitlines() if ln]
    assert len(lines) == 1
    obj = json.loads(lines[0])
    assert obj["type"] == "result"
    assert obj["final"] is True
    assert obj["status"] == "ok"
    assert obj["operation_id"] == "config.show"


def test_ndjson_writer_emits_sequenced_events():
    buf = io.StringIO()
    w = render.NdjsonWriter(buf, request_id="rq", timestamp="2026-06-02T00:00:00Z")
    w.start({"protocols": ["freed"]})
    w.progress({"completed": 1, "total": 3})
    w.warning("slow")
    w.result(status="ok", data={"total_packets": 3})
    objs = [json.loads(ln) for ln in buf.getvalue().splitlines() if ln]
    assert [o["type"] for o in objs] == ["start", "progress", "warning", "result"]
    assert [o["sequence"] for o in objs] == [0, 1, 2, 3]
    for o in objs:
        assert o["request_id"] == "rq"
        assert o["schema_version"] == "1.0"
        assert o["timestamp"] == "2026-06-02T00:00:00Z"
    assert objs[-1]["final"] is True
    assert objs[0]["protocols"] == ["freed"]
    assert objs[1]["completed"] == 1
    assert objs[2]["message"] == "slow"
    assert objs[3]["data"]["total_packets"] == 3


def test_sim_event_to_ndjson_mapping():
    pose = CameraPose(pan=10.0)
    started = render.sim_event_fields(SimStarted(protocols=["freed"], rate=60.0))
    tick = render.sim_event_fields(SimTick(pose=pose, packets_sent=1, rate_actual=59.9))
    warn = render.sim_event_fields(SimWarning(message="hi"))
    stopped = render.sim_event_fields(SimStopped(reason="duration", total_packets=7))
    assert started["type"] == "start"
    assert started["protocols"] == ["freed"]
    assert started["rate"] == 60.0
    assert tick["type"] == "progress"
    assert tick["packets_sent"] == 1
    assert tick["rate_actual"] == 59.9
    assert tick["pose"]["pan"] == 10.0
    assert warn["type"] == "warning"
    assert warn["message"] == "hi"
    assert stopped["type"] == "result"
    assert stopped["status"] == "ok"
    assert stopped["reason"] == "duration"
    assert stopped["total_packets"] == 7
