import json
import os
import socket
import subprocess
import sys
import threading
import time

import pytest

from tracksim.manifest import build_manifest

_ENV = {**os.environ, "PYTHONPATH": os.path.abspath("src"), "PYSDL3_NO_UPDATE_CHECK": "1", "SDL_CHECK_VERSION": "0"}


def _run(args, **kw):
    return subprocess.run(
        [sys.executable, "-m", "tracksim", *args],
        capture_output=True, text=True, env=_ENV, **kw
    )


def test_version_json_stdout_pure_stderr_empty():
    proc = _run(["version", "--output", "json"])
    assert proc.returncode == 0
    obj = json.loads(proc.stdout)
    assert obj["operation_id"] == "meta.version"
    assert obj["status"] == "ok"
    assert proc.stderr == ""


def test_bad_flag_exit_2_json_stdout_valid():
    proc = _run(["version", "--definitely-not-a-flag", "--output", "json"])
    assert proc.returncode == 2
    obj = json.loads(proc.stdout)
    assert obj["status"] == "error"
    assert obj["error"]["exit_code"] == 2


def test_config_init_dry_run_exposes_plan_and_writes_nothing(tmp_path):
    target = tmp_path / "out.toml"
    proc = _run(["config", "init", "--path", str(target), "--dry-run", "--output", "json"])
    assert proc.returncode == 0
    obj = json.loads(proc.stdout)
    assert "dry_run_plan" in obj["data"]
    assert obj["data"]["dry_run_plan"]["path"] == str(target)
    assert not target.exists()


def test_manifest_operation_ids_match_build_manifest():
    proc = _run(["manifest", "--output", "json"])
    assert proc.returncode == 0
    obj = json.loads(proc.stdout)
    ids = {op["operation_id"] for op in obj["data"]["operations"]}
    expected = {op["operation_id"] for op in build_manifest()["operations"]}
    assert ids == expected


def _udp_collect(sock, packets, stop):
    sock.settimeout(0.2)
    while not stop.is_set():
        try:
            data, _ = sock.recvfrom(2048)
            packets.append(data)
        except socket.timeout:
            continue


def test_send_freed_packet_arrives_on_udp():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    packets: list[bytes] = []
    stop = threading.Event()
    t = threading.Thread(target=_udp_collect, args=(sock, packets, stop))
    t.start()
    try:
        cfg = _make_freed_config(port)
        proc = _run(["send", "--config", cfg, "--protocol", "freed", "--pan", "10", "--output", "json"])
        assert proc.returncode == 0, proc.stderr
        time.sleep(0.3)
    finally:
        stop.set()
        t.join()
        sock.close()
    assert any(len(p) == 29 and p[0] == 0xD1 for p in packets)


def test_send_opentrackio_packet_arrives_on_udp():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    packets: list[bytes] = []
    stop = threading.Event()
    t = threading.Thread(target=_udp_collect, args=(sock, packets, stop))
    t.start()
    try:
        cfg = _make_otrk_config(port)
        proc = _run(["send", "--config", cfg, "--protocol", "opentrackio", "--pan", "5", "--output", "json"])
        assert proc.returncode == 0, proc.stderr
        time.sleep(0.3)
    finally:
        stop.set()
        t.join()
        sock.close()
    assert any(p[0:4] == b"OTrk" for p in packets)


def test_run_json_is_single_object_not_ndjson(tmp_path):
    # 防回归 F2：流式命令在 --output json 下 stdout 必须是单个合法 JSON 对象（不得混入 ndjson 行）
    cfg = _make_freed_config(59999)  # 发往 127.0.0.1:59999；本测试不校验送达，仅校验 stdout 形态
    proc = _run([
        "run", "--config", cfg, "--protocol", "freed",
        "--source", "script", "--rate", "20", "--duration", "0.1", "--output", "json",
    ])
    assert proc.returncode == 0, proc.stderr
    obj = json.loads(proc.stdout)  # 单个对象；若混入 ndjson 行此处会抛 JSONDecodeError
    assert obj["operation_id"] == "sim.run"
    assert obj["status"] == "ok"
    assert obj["data"]["ticks"] >= 1


def test_controllers_monitor_json_no_device_single_error_object():
    # 防回归 F2：streaming 命令在 json 模式即使报错也只输出单个 JSON error envelope
    pytest.importorskip("sdl3")  # 无 SDL3 运行库时跳过（功能由 Section 5 FakeControllerInput 覆盖）
    proc = _run(["controllers", "monitor", "--samples", "1", "--output", "json"])
    assert proc.returncode == 10  # NO_CONTROLLER（无手柄）
    obj = json.loads(proc.stdout)
    assert obj["status"] == "error"
    assert obj["error"]["code"] == "NO_CONTROLLER"


def test_run_controller_source_reaches_sdl_not_unsupported():
    # 防回归 F5：run --source controller 必须接线到 SDL（无手柄 -> NO_CONTROLLER/exit 10），
    # 而不是落到 factory 的 UNSUPPORTED_PROTOCOL/exit 12
    pytest.importorskip("sdl3")
    proc = _run(["run", "--source", "controller", "--duration", "0.1", "--rate", "10", "--output", "json"])
    assert proc.returncode == 10, proc.stderr
    obj = json.loads(proc.stdout)
    assert obj["status"] == "error"
    assert obj["error"]["code"] == "NO_CONTROLLER"


def _make_freed_config(port: int) -> str:
    import tempfile

    content = (
        "[protocols]\nfreed = true\nopentrackio = false\n\n"
        "[freed]\ntransport = \"udp_unicast\"\n"
        f"target_ip = \"127.0.0.1\"\nport = {port}\n"
        "serial_device = \"/dev/null\"\nbaud = 38400\ncamera_id = 0\nrate_hz = 10.0\n\n"
        "[freed.scaling]\nvariant = \"native\"\nangle_lsb_per_deg = 32768.0\npos_lsb_per_m = 64000.0\n"
    )
    fh = tempfile.NamedTemporaryFile("w", suffix=".toml", delete=False)
    fh.write(content)
    fh.close()
    return fh.name


def _make_otrk_config(port: int) -> str:
    import tempfile

    content = (
        "[protocols]\nfreed = false\nopentrackio = true\n\n"
        "[opentrackio]\ntransport = \"unicast\"\nsource_number = 1\n"
        f"ip = \"127.0.0.1\"\nport = {port}\nencoding = \"json\"\nrate_hz = 10.0\n"
    )
    fh = tempfile.NamedTemporaryFile("w", suffix=".toml", delete=False)
    fh.write(content)
    fh.close()
    return fh.name
