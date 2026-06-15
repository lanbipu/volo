import re
import uuid

from tracksim.cli import runtime


def test_new_request_id_is_uuid4():
    rid = runtime.new_request_id()
    assert str(uuid.UUID(rid)) == rid


def test_utc_now_iso_format():
    ts = runtime.utc_now_iso()
    assert re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}", ts)
    assert ts.endswith("Z")


def test_resolve_output_explicit_wins():
    assert runtime.resolve_output("ndjson", ai_agent_env=True, is_tty=True) == "ndjson"


def test_resolve_output_ai_agent_env_json():
    assert runtime.resolve_output(None, ai_agent_env=True, is_tty=True) == "json"


def test_resolve_output_tty_text():
    assert runtime.resolve_output(None, ai_agent_env=False, is_tty=True) == "text"


def test_resolve_output_pipe_defaults_text():
    assert runtime.resolve_output(None, ai_agent_env=False, is_tty=False) == "text"


def test_color_disabled_by_flag():
    assert runtime.color_enabled(no_color_flag=True, no_color_env=False, is_tty=True) is False


def test_color_disabled_by_env():
    assert runtime.color_enabled(no_color_flag=False, no_color_env=True, is_tty=True) is False


def test_color_disabled_when_not_tty():
    assert runtime.color_enabled(no_color_flag=False, no_color_env=False, is_tty=False) is False


def test_color_enabled_when_tty_and_no_overrides():
    assert runtime.color_enabled(no_color_flag=False, no_color_env=False, is_tty=True) is True
