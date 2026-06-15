"""In-process CLI command coverage via Click's CliRunner (adapter layer + flows)."""

from __future__ import annotations

import json

from click.testing import CliRunner

from vpcal.cli.main import cli


def _json(result):
    return json.loads(result.output)


def test_screen_create_plane(tmp_path):
    runner = CliRunner()
    out = tmp_path / "wall.json"
    r = runner.invoke(cli, [
        "screen", "create", "--name", "studio", "--out", str(out),
        "--cabinet-size", "500", "500", "--pixel-pitch", "2.8",
        "--section-type", "plane", "--width", "2000", "--height", "1500", "--output", "json",
    ])
    assert r.exit_code == 0, r.output
    assert out.exists()
    assert _json(r)["status"] == "ok"


def test_screen_create_arc(tmp_path):
    runner = CliRunner()
    out = tmp_path / "arc.json"
    r = runner.invoke(cli, [
        "screen", "create", "--name", "arc", "--out", str(out),
        "--section-type", "arc", "--arc-radius", "9550", "--arc-angle", "180",
        "--height", "12000", "--output", "json",
    ])
    assert r.exit_code == 0, r.output
    assert out.exists()


def test_screen_create_plane_missing_width_errors(tmp_path):
    runner = CliRunner()
    r = runner.invoke(cli, [
        "screen", "create", "--name", "x", "--out", str(tmp_path / "x.json"),
        "--section-type", "plane", "--height", "1000", "--output", "json",
    ])
    assert r.exit_code == 2
    assert _json(r)["error"]["code"] == "ARG_VALIDATION"


def test_pattern_generate(tmp_path):
    runner = CliRunner()
    screen = tmp_path / "wall.json"
    runner.invoke(cli, [
        "screen", "create", "--name", "s", "--out", str(screen),
        "--section-type", "plane", "--width", "1500", "--height", "1000", "--output", "json",
    ])
    r = runner.invoke(cli, [
        "pattern", "generate", "--screen", str(screen), "--output-dir", str(tmp_path / "pat"),
        "--max-dim", "1024", "--output", "json",
    ])
    assert r.exit_code == 0, r.output
    data = _json(r)["data"]
    assert len(data["files"]) == 2  # normal + inverted
    assert (tmp_path / "pat" / "normal.png").exists()
    assert (tmp_path / "pat" / "inverted.png").exists()


def test_full_flow_simulate_quick_report_export(tmp_path):
    runner = CliRunner()
    screen = tmp_path / "wall.json"
    runner.invoke(cli, [
        "screen", "create", "--name", "s", "--out", str(screen),
        "--section-type", "plane", "--width", "2400", "--height", "1600", "--output", "json",
    ])
    session_dir = tmp_path / "session"
    r = runner.invoke(cli, [
        "simulate", "--screen", str(screen), "--num-poses", "8", "--noise-px", "0",
        "--output-dir", str(session_dir), "--no-images", "--output", "json",
    ])
    assert r.exit_code == 0, r.output

    r = runner.invoke(cli, ["quick", "run", "--config", str(session_dir / "session.json"), "--output", "json"])
    assert r.exit_code == 0, r.output
    assert _json(r)["data"]["result"]["quality"]["reprojection_rms_px"] < 0.01

    out = session_dir / "output"
    r = runner.invoke(cli, ["report", "generate", "--result", str(out / "result.json"), "--output", "json"])
    assert r.exit_code == 0, r.output
    assert "reprojection" in _json(r)["data"]

    r = runner.invoke(cli, [
        "export", "opentrackio", "--result", str(out / "result.json"),
        "--session", str(session_dir / "session.json"), "--out", str(tmp_path / "otio.jsonl"), "--output", "json",
    ])
    assert r.exit_code == 0, r.output
    assert (tmp_path / "otio.jsonl").exists()


def test_quick_run_dry_run(tmp_path):
    runner = CliRunner()
    screen = tmp_path / "wall.json"
    runner.invoke(cli, [
        "screen", "create", "--name", "s", "--out", str(screen),
        "--section-type", "plane", "--width", "2400", "--height", "1600", "--output", "json",
    ])
    session_dir = tmp_path / "session"
    runner.invoke(cli, [
        "simulate", "--screen", str(screen), "--num-poses", "6", "--output-dir", str(session_dir),
        "--no-images", "--output", "json",
    ])
    r = runner.invoke(cli, ["quick", "run", "--config", str(session_dir / "session.json"), "--dry-run", "--output", "json"])
    assert r.exit_code == 0, r.output
    assert "dry_run_plan" in _json(r)["data"]


def test_quick_run_stage_solve_text_output(tmp_path):
    runner = CliRunner()
    screen = tmp_path / "wall.json"
    runner.invoke(cli, [
        "screen", "create", "--name", "s", "--out", str(screen),
        "--section-type", "plane", "--width", "2400", "--height", "1600", "--output", "json",
    ])
    session_dir = tmp_path / "session"
    runner.invoke(cli, [
        "simulate", "--screen", str(screen), "--num-poses", "8", "--output-dir", str(session_dir),
        "--no-images", "--output", "json",
    ])
    r = runner.invoke(cli, ["quick", "run", "--config", str(session_dir / "session.json"), "--stage", "solve", "--scipy"])
    assert r.exit_code == 0, r.output
    assert "Stage 'solve' complete" in r.output


def test_screen_import_obj(tmp_path):
    runner = CliRunner()
    # build an OBJ by sampling a plane
    from vpcal.models.screen import PlaneSection
    plane = PlaneSection(name="wall", width_mm=3000, height_mm=1500, origin=[0, 0, 0])
    lines = ["g wall"]
    import numpy as np
    for v in np.linspace(0, 1, 6):
        for u in np.linspace(0, 1, 6):
            w = plane.uv_to_world(u, v)
            lines.append(f"v {w[0]} {w[1]} {w[2]}")
    lines.append("f 1 2 3")
    obj = tmp_path / "wall.obj"
    obj.write_text("\n".join(lines))
    out = tmp_path / "imported.json"
    r = runner.invoke(cli, [
        "screen", "import", "--obj", str(obj), "--name", "imp", "--out", str(out),
        "--cabinet-size", "500", "500", "--output", "json",
    ])
    assert r.exit_code == 0, r.output
    assert out.exists()
