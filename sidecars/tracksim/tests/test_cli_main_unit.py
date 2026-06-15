import io
import json

from tracksim.cli import main as cli_main
from tracksim.domain.errors import TransportError, TracksimError


def test_build_parser_has_global_flags():
    parser = cli_main.build_parser()
    help_text = parser.format_help()
    for flag in ("--output", "--dry-run", "--config", "--no-color", "--no-input", "--log-level", "--quiet", "--verbose", "--yes"):
        assert flag in help_text


def test_emit_success_json_to_stdout():
    out = io.StringIO()
    cli_main.emit_success(
        out, "meta.version", {"version": "0.1.0"}, fmt="json",
        request_id="r1", timestamp="2026-06-02T00:00:00Z", duration_ms=1,
    )
    obj = json.loads(out.getvalue())
    assert obj["status"] == "ok"
    assert obj["operation_id"] == "meta.version"
    assert obj["data"]["version"] == "0.1.0"


def test_emit_error_json_to_stdout():
    out = io.StringIO()
    err = TransportError("send failed", details={"host": "127.0.0.1"})
    cli_main.emit_error(
        out, "sim.send", err, fmt="json",
        request_id="r2", timestamp="2026-06-02T00:00:01Z", duration_ms=2,
    )
    obj = json.loads(out.getvalue())
    assert obj["status"] == "error"
    assert obj["error"]["code"] == "TRANSPORT_SEND_FAILED"
    assert obj["error"]["exit_code"] == 11
    assert obj["error"]["retryable"] is True
    assert obj["error"]["details"] == {"host": "127.0.0.1"}


def test_exit_for_error_uses_error_exit_code():
    err = TransportError("x")
    assert cli_main.exit_for_error(err) == 11
    assert cli_main.exit_for_error(TracksimError("y")) == 1


def test_global_flags_work_after_subcommand():
    # 防回归 F1：全局 flag 必须在子命令（含嵌套叶子）之后也可用
    parser = cli_main.build_parser()
    a = parser.parse_args(["version", "--output", "json"])
    assert a.command == "version" and a.output == "json"
    b = parser.parse_args(["config", "init", "--dry-run", "--output", "json"])
    assert b.command == "config" and b.subcommand == "init"
    assert b.dry_run is True and b.output == "json"
    c = parser.parse_args(["send", "--output", "json", "--pan", "10"])
    assert c.command == "send" and c.output == "json" and c.pan == 10.0


def test_global_flags_before_subcommand_not_clobbered():
    # 子命令之前给出的全局 flag 不能被 subparser 的默认值覆盖
    parser = cli_main.build_parser()
    a = parser.parse_args(["--output", "json", "send"])
    assert a.command == "send" and a.output == "json"
    b = parser.parse_args(["--yes", "config", "init"])
    assert b.command == "config" and b.subcommand == "init" and b.yes is True
