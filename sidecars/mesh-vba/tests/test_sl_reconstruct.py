import pytest
from lmt_vba_sidecar.ipc import CorrespondenceFile
from lmt_vba_sidecar.sl_reconstruct import validate_sl_provenance


def _corr(screen_id="MAIN", sha="abc", src="/cap/p.mp4"):
    return CorrespondenceFile.model_validate({
        "schema_version": 1, "screen_id": screen_id, "sl_meta_sha256": sha,
        "screen_resolution": [960, 540], "camera_image_size": [4000, 3000],
        "source_input": src,
        "points": [{"id": 0, "u": 1.0, "v": 2.0, "x": 3.0, "y": 4.0}]})


def test_provenance_accepts_consistent_set():
    validate_sl_provenance([_corr(src="/cap/p0.mp4"), _corr(src="/cap/p1.mp4")],
                           expected_sha="abc", expected_screen_id="MAIN")


def test_provenance_rejects_duplicate_source_input():
    # same capture decoded twice -> would inflate observed views past the gate
    with pytest.raises(ValueError, match="source_input"):
        validate_sl_provenance([_corr(src="same"), _corr(src="same")],
                               expected_sha="abc", expected_screen_id="MAIN")


def test_provenance_rejects_mixed_screen_id():
    with pytest.raises(ValueError, match="screen_id"):
        validate_sl_provenance([_corr(screen_id="MAIN"), _corr(screen_id="FLOOR")],
                               expected_sha="abc", expected_screen_id="MAIN")


def test_provenance_rejects_sha_mismatch_vs_meta():
    with pytest.raises(ValueError, match="sl_meta_sha256"):
        validate_sl_provenance([_corr(sha="abc")], expected_sha="DIFFERENT",
                               expected_screen_id="MAIN")


def test_provenance_rejects_screen_id_not_matching_project():
    with pytest.raises(ValueError, match="project"):
        validate_sl_provenance([_corr(screen_id="MAIN")], expected_sha="abc",
                               expected_screen_id="FLOOR")


import json, hashlib, pathlib
import numpy as np
import pytest
from lmt_vba_sidecar.ipc import GenerateStructuredLightInput, ReconstructStructuredLightInput
from lmt_vba_sidecar.structured_light import run_generate_structured_light
from lmt_vba_sidecar.sl_geometry import sl_local_mm
from lmt_vba_sidecar.sl_feasibility import look_at_pose, project_point
from lmt_vba_sidecar.sl_reconstruct import run_reconstruct_structured_light


def _gen_two_cabinet_meta(tmp_path):
    cmd = GenerateStructuredLightInput.model_validate({
        "command": "generate_structured_light", "version": 1,
        "project": {"screen_id": "MAIN",
                    "cabinet_array": {"cols": 2, "rows": 1, "absent_cells": [],
                                      "cabinet_size_mm": [500, 500]}},
        "output_dir": str(tmp_path / "sl"), "screen_resolution": [960, 480],
        "dot_spacing_px": 80, "margin_px": 60})
    assert run_generate_structured_light(cmd) == 0
    return tmp_path / "sl" / "sl_meta.json"


def _write_intrinsics(tmp_path, f=3000.0, cx=2000.0, cy=1500.0, w=4000, h=3000):
    p = tmp_path / "intr.json"
    p.write_text(json.dumps({"K": [[f, 0, cx], [0, f, cy], [0, 0, 1]],
                             "dist_coeffs": [0, 0, 0, 0, 0], "image_size": [w, h]}))
    return p, np.array([[f, 0, cx], [0, f, cy], [0, 0, 1]], float)


def test_synthetic_sl_reconstruction_recovers_cabinet_offset_mm(tmp_path):
    """Synthetic perfect correspondences (+0.1px noise) for a 2-cabinet wall with
    a KNOWN deviation on cabinet 1; recovered pose must place it within mm of
    the true (deviated) position. This is the Phase-3 gating test."""
    meta_path = _gen_two_cabinet_meta(tmp_path)
    meta = json.loads(meta_path.read_text())
    intr_path, K = _write_intrinsics(tmp_path)
    rect_by_cr = {(c["col"], c["row"]): c["input_rect_px"] for c in meta["cabinets"]}
    pitch_by_cr = {(c["col"], c["row"]): c["pixel_pitch_mm"] for c in meta["cabinets"]}
    cab_by_id = {d["id"]: tuple(d["cabinet"]) for d in meta["dots"]}

    # True world: root (0,0) frame = world; cabinet (1,0) nominally +500mm x,
    # plus a KNOWN 4mm deviation (3mm x, 2mm y, 1mm z) we expect to recover.
    nominal_offset = np.array([500.0, 0.0, 0.0])
    deviation = np.array([3.0, 2.0, 1.0])
    cab_world_t = {(0, 0): np.zeros(3), (1, 0): nominal_offset + deviation}

    truth_world = {}
    for d in meta["dots"]:
        cr = cab_by_id[d["id"]]
        p_local = sl_local_mm(tuple(rect_by_cr[cr]), d["u"], d["v"],
                              pitch_by_cr[cr][0], pitch_by_cr[cr][1])
        truth_world[d["id"]] = p_local + cab_world_t[cr]   # identity cabinet rotation

    sha = hashlib.sha256(meta_path.read_bytes()).hexdigest()
    poses = [look_at_pose(np.array([px, 0.0, -3500.0]), np.array([250.0, 0.0, 0.0]))
             for px in (-1200.0, -400.0, 400.0, 1200.0)]
    rng = np.random.default_rng(0)
    corr_paths = []
    for vi, (R, t) in enumerate(poses):
        pts = []
        for d in meta["dots"]:
            p = project_point(K, R, t, truth_world[d["id"]]) + rng.normal(0, 0.1, 2)
            pts.append({"id": d["id"], "u": d["u"], "v": d["v"],
                        "x": float(p[0]), "y": float(p[1])})
        cp = tmp_path / f"corr_{vi}.json"
        cp.write_text(json.dumps({
            "schema_version": 1, "screen_id": "MAIN", "sl_meta_sha256": sha,
            "screen_resolution": meta["screen_resolution"], "camera_image_size": [4000, 3000],
            "source_input": f"/cap/pose{vi}.mp4", "points": pts}))
        corr_paths.append(str(cp))

    report_path = tmp_path / "report.json"
    cmd = ReconstructStructuredLightInput.model_validate({
        "command": "reconstruct_structured_light", "version": 1,
        "project": {"screen_id": "MAIN",
                    "cabinet_array": {"cols": 2, "rows": 1, "absent_cells": [],
                                      "cabinet_size_mm": [500, 500]}},
        "correspondence_paths": corr_paths, "sl_meta_path": str(meta_path),
        "intrinsics_path": str(intr_path), "pose_report_path": str(report_path)})
    assert run_reconstruct_structured_light(cmd) == 0

    report = json.loads(report_path.read_text())
    by_id = {c["cabinet_id"]: c for c in report["cabinet_poses"]}
    # SL output now lands in the NOMINAL DESIGN frame (gauge_strategy=align_to_nominal):
    # the whole wall is rigidly placed onto the nominal grid, so absolute positions are
    # the design positions — NOT the root-local frame. The recovered DEVIATION is
    # gauge-invariant (a rigid transform preserves the inter-cabinet vector), so assert
    # the RELATIVE geometry against the known true deviation.
    assert report["frame"]["gauge_strategy"] == "align_to_nominal"
    got0 = np.array(by_id["V000_R000"]["position_mm"])
    got1 = np.array(by_id["V001_R000"]["position_mm"])
    true_rel = cab_world_t[(1, 0)] - cab_world_t[(0, 0)]   # [503, 2, 1] mm (offset + deviation)
    assert np.linalg.norm((got1 - got0) - true_rel) < 5.0  # mm (BA + 0.1px noise)
    # Absolute frame check: cabinet 0 sits at its nominal design center (250,250,0) mm
    # for a 2x1 wall of 500mm cabinets (within the alignment residual).
    assert np.linalg.norm(got0 - np.array([250.0, 250.0, 0.0])) < 5.0

    # Finding-2 guard: correspondence (u,v) must be IGNORED (canonical (u,v) comes
    # from sl_meta). Corrupt every corr point's u,v to garbage, reconstruct again ->
    # identical cabinet pose. If p_local trusted corr (u,v), this would diverge/fail.
    for cp in corr_paths:
        d = json.loads(pathlib.Path(cp).read_text())
        for p in d["points"]:
            p["u"], p["v"] = 0.0, 0.0
        pathlib.Path(cp).write_text(json.dumps(d))
    report2 = tmp_path / "report2.json"
    assert run_reconstruct_structured_light(cmd.model_copy(update={"pose_report_path": str(report2)})) == 0
    got2 = np.array({c["cabinet_id"]: c for c in json.loads(report2.read_text())["cabinet_poses"]}
                    ["V001_R000"]["position_mm"])
    np.testing.assert_allclose(got1, got2, atol=1e-6)


def _valid_corr(tmp_path, sha, n=2, screen_res=(960, 480)):
    """n minimal corr files that pass provenance (shared screen_id MAIN + sha,
    DISTINCT source_input per file so the duplicate-view gate is not tripped)."""
    paths = []
    for i in range(n):
        cp = tmp_path / f"vc{i}.json"
        cp.write_text(json.dumps({
            "schema_version": 1, "screen_id": "MAIN", "sl_meta_sha256": sha,
            "screen_resolution": list(screen_res), "camera_image_size": [4000, 3000],
            "source_input": f"cap{i}", "points": [{"id": 0, "u": 1, "v": 1, "x": 1, "y": 1}]}))
        paths.append(str(cp))
    return paths


def test_run_rejects_duplicate_source_input(tmp_path):
    # two corr files with the SAME source_input = same capture decoded twice;
    # must not be counted as two camera views (would bypass min_views gate).
    meta_path = _gen_two_cabinet_meta(tmp_path)
    sha = hashlib.sha256(meta_path.read_bytes()).hexdigest()
    intr_path, _ = _write_intrinsics(tmp_path)
    for i in range(2):
        (tmp_path / f"dup{i}.json").write_text(json.dumps({
            "schema_version": 1, "screen_id": "MAIN", "sl_meta_sha256": sha,
            "screen_resolution": [960, 480], "camera_image_size": [4000, 3000],
            "source_input": "/cap/SAME.mp4", "points": [{"id": 0, "u": 1, "v": 1, "x": 1, "y": 1}]}))
    cmd = ReconstructStructuredLightInput.model_validate({
        "command": "reconstruct_structured_light", "version": 1,
        "project": {"screen_id": "MAIN",
                    "cabinet_array": {"cols": 2, "rows": 1, "absent_cells": [],
                                      "cabinet_size_mm": [500, 500]}},
        "correspondence_paths": [str(tmp_path / "dup0.json"), str(tmp_path / "dup1.json")],
        "sl_meta_path": str(meta_path), "intrinsics_path": str(intr_path)})
    assert run_reconstruct_structured_light(cmd) == 1


def test_run_rejects_malformed_sl_meta(tmp_path):
    bad = tmp_path / "bad_meta.json"
    bad.write_text('{"schema_version": 1, "screen_id": "MAIN"}')   # missing required fields
    intr_path, _ = _write_intrinsics(tmp_path)
    cmd = ReconstructStructuredLightInput.model_validate({
        "command": "reconstruct_structured_light", "version": 1,
        "project": {"screen_id": "MAIN",
                    "cabinet_array": {"cols": 2, "rows": 1, "absent_cells": [],
                                      "cabinet_size_mm": [500, 500]}},
        "correspondence_paths": _valid_corr(tmp_path, "x"),
        "sl_meta_path": str(bad), "intrinsics_path": str(intr_path)})
    assert run_reconstruct_structured_light(cmd) == 1     # invalid_input, not a traceback


def test_run_rejects_meta_project_cabinet_mismatch(tmp_path):
    # sl_meta present = {(0,0),(1,0)}; project declares (1,0) ABSENT -> {(0,0)}.
    meta_path = _gen_two_cabinet_meta(tmp_path)
    sha = hashlib.sha256(meta_path.read_bytes()).hexdigest()
    intr_path, _ = _write_intrinsics(tmp_path)
    cmd = ReconstructStructuredLightInput.model_validate({
        "command": "reconstruct_structured_light", "version": 1,
        "project": {"screen_id": "MAIN",
                    "cabinet_array": {"cols": 2, "rows": 1, "absent_cells": [[1, 0]],
                                      "cabinet_size_mm": [500, 500]}},
        "correspondence_paths": _valid_corr(tmp_path, sha),
        "sl_meta_path": str(meta_path), "intrinsics_path": str(intr_path)})
    assert run_reconstruct_structured_light(cmd) == 1     # cabinet-set mismatch -> invalid_input


def test_run_rejects_provenance_mismatch(tmp_path):
    meta_path = _gen_two_cabinet_meta(tmp_path)
    intr_path, _ = _write_intrinsics(tmp_path)
    # two corr files with DIFFERENT sha -> invalid_input (return 1)
    for vi, sha in enumerate(("aaa", "bbb")):
        (tmp_path / f"c{vi}.json").write_text(json.dumps({
            "schema_version": 1, "screen_id": "MAIN", "sl_meta_sha256": sha,
            "screen_resolution": [960, 480], "camera_image_size": [4000, 3000],
            "source_input": "x", "points": [{"id": 0, "u": 1, "v": 1, "x": 1, "y": 1}]}))
    cmd = ReconstructStructuredLightInput.model_validate({
        "command": "reconstruct_structured_light", "version": 1,
        "project": {"screen_id": "MAIN",
                    "cabinet_array": {"cols": 2, "rows": 1, "absent_cells": [],
                                      "cabinet_size_mm": [500, 500]}},
        "correspondence_paths": [str(tmp_path / "c0.json"), str(tmp_path / "c1.json")],
        "sl_meta_path": str(meta_path), "intrinsics_path": str(intr_path)})
    assert run_reconstruct_structured_light(cmd) == 1


# Codex #7 fix: shape_prior CANNOT be the bare string "curved" (IPC ShapePrior accepts only
# Literal "flat" or {"curved": {"radius_mm": ...}}). This uses the proven FLAT 2-cabinet
# synthetic (sl_local_mm + per-cabinet translation, MM — the geometry the reconstruct BA
# expects) so the BA fits, with an anchor + NOISE-FREE projection so the flat-wall self-cal
# recovers ~K_TRUE with ~zero distortion and the cross-check passes (a flat wall's distortion
# only overfits in the presence of pixel noise).
def _write_anchor(tmp_path, K, name="anchor.json"):
    p = tmp_path / name
    p.write_text(json.dumps({"K": K.tolist(), "dist_coeffs": [0, 0, 0, 0, 0], "image_size": [4000, 3000]}))
    return p


def test_intrinsics_auto_self_calibrates(tmp_path, capsys):
    meta_path = _gen_two_cabinet_meta(tmp_path)          # FLAT 2-cabinet wall (MM via sl_local_mm)
    meta = json.loads(meta_path.read_text())
    _, K = _write_intrinsics(tmp_path)                   # K_TRUE = synthesis camera
    anchor = _write_anchor(tmp_path, K)                  # independent anchor == K_TRUE
    rect_by_cr = {(c["col"], c["row"]): c["input_rect_px"] for c in meta["cabinets"]}
    pitch_by_cr = {(c["col"], c["row"]): c["pixel_pitch_mm"] for c in meta["cabinets"]}
    cab_by_id = {d["id"]: tuple(d["cabinet"]) for d in meta["dots"]}
    cab_world_t = {(0, 0): np.zeros(3), (1, 0): np.array([500.0, 0.0, 0.0])}
    truth = {}
    for d in meta["dots"]:
        cr = cab_by_id[d["id"]]
        truth[d["id"]] = sl_local_mm(tuple(rect_by_cr[cr]), d["u"], d["v"],
                                     pitch_by_cr[cr][0], pitch_by_cr[cr][1]) + cab_world_t[cr]
    sha = hashlib.sha256(meta_path.read_bytes()).hexdigest()
    # Standoff close enough that the ~1000x500mm wall fills > 20% of both image axes (the
    # self-cal coverage gate), oblique for focal/pp observability.
    poses = [look_at_pose(np.array([px, py, -1800.0]), np.array([250.0, 0.0, 0.0]))
             for (px, py) in [(-700, -300), (-300, 300), (300, -300), (700, 300), (0, 500), (0, -500)]]
    corr_paths = []
    for vi, (R, t) in enumerate(poses):
        pts = [{"id": d["id"], "u": d["u"], "v": d["v"],
                **dict(zip(("x", "y"), project_point(K, R, t, truth[d["id"]]).tolist()))}  # noise-free
               for d in meta["dots"]]
        cp = tmp_path / f"corr_{vi}.json"
        cp.write_text(json.dumps({"schema_version": 1, "screen_id": "MAIN", "sl_meta_sha256": sha,
            "screen_resolution": meta["screen_resolution"], "camera_image_size": [4000, 3000],
            "source_input": f"/cap/p{vi}.mp4", "points": pts}))
        corr_paths.append(str(cp))
    report = tmp_path / "rep.json"
    cmd = ReconstructStructuredLightInput.model_validate({
        "command": "reconstruct_structured_light", "version": 1,
        "project": {"screen_id": "MAIN", "cabinet_array": {"cols": 2, "rows": 1,
                    "absent_cells": [], "cabinet_size_mm": [500, 500]}},   # default shape_prior="flat"
        "correspondence_paths": corr_paths, "sl_meta_path": str(meta_path),
        "intrinsics_path": "auto", "crosscheck_intrinsics_path": str(anchor),
        "pose_report_path": str(report)})
    assert run_reconstruct_structured_light(cmd) == 0
    events = [json.loads(l) for l in capsys.readouterr().out.splitlines() if l.strip()]
    result = [e for e in events if e.get("event") == "result"][-1]
    assert result["data"]["intrinsics_source"] == "auto_self_calibrated"
    # Solved WITH an anchor -> no no_intrinsics_anchor warning in the event stream.
    assert not any(e.get("event") == "warning" and e.get("code") == "no_intrinsics_anchor"
                   for e in events)
    by_id = {c["cabinet_id"]: c for c in json.loads(report.read_text())["cabinet_poses"]}
    rel = np.array(by_id["V001_R000"]["position_mm"]) - np.array(by_id["V000_R000"]["position_mm"])
    assert np.linalg.norm(rel - np.array([500.0, 0.0, 0.0])) < 8.0  # self-cal noisier than given K

    # Codex P3: a missing/malformed crosscheck anchor maps to invalid_input (a clean
    # user error), NOT an internal_error traceback. Reuse the good corr; only break the
    # anchor path so the self-cal succeeds and the anchor load is what fails.
    bad = ReconstructStructuredLightInput.model_validate({
        "command": "reconstruct_structured_light", "version": 1,
        "project": {"screen_id": "MAIN", "cabinet_array": {"cols": 2, "rows": 1,
                    "absent_cells": [], "cabinet_size_mm": [500, 500]}},
        "correspondence_paths": corr_paths, "sl_meta_path": str(meta_path),
        "intrinsics_path": "auto", "crosscheck_intrinsics_path": str(tmp_path / "nope.json"),
        "pose_report_path": str(tmp_path / "bad.json")})
    assert run_reconstruct_structured_light(bad) == 1
    errs = [json.loads(l) for l in capsys.readouterr().out.splitlines()
            if l.strip() and json.loads(l).get("event") == "error"]
    assert errs[-1]["code"] == "invalid_input"


def _warp_local(pl, kind):
    """Inject a screen-side pitch/1:1 error into a centered-origin local-mm point."""
    if kind == "anisotropic":
        return pl * np.array([1.03, 1.0, 1.0])              # 3% x-stretch -> aspect drift > 1%
    if kind == "remap":                                     # smooth radial barrel: +2% at the edge
        r = float(np.hypot(pl[0], pl[1]))
        r_max = 353.0                                        # ~half-diagonal of a 500mm cabinet
        s = 1.0 + 0.02 * (r / r_max) ** 2
        return pl * np.array([s, s, 1.0])
    raise ValueError(kind)


@pytest.mark.parametrize("kind", ["anisotropic", "remap"])
def test_pitch_absorption_guard(tmp_path, kind):
    """P6 red line — END-TO-END no-ship property: a K-absorbable screen-pitch error injected
    into a flat-wall auto capture is REFUSED before any file write, and a control run (no
    injection, same anchor) passes (so the refusal is error-caused, not anchor-caused).

    HONEST SCOPE (per code-review): on a FLAT wall the injected warp also inflates the self-cal
    reproj RMS / principal-point stddev past solve_sl_intrinsics' GENERIC quality gates, which
    fire BEFORE crosscheck_intrinsics is reached — so this integration test proves "caught before
    export" but does NOT, by itself, prove the cross-check is what caught it. The cross-check's
    own refusal logic (focal/aspect/distortion deviation vs an anchor) is unit-tested directly in
    test_intrinsics_solve.py::test_crosscheck_refuses_when_anchor_disagrees_on_{aspect,distortion}.
    (Isotropic scale -> nominal_misfit guard, tested in Plan 3.)"""
    meta_path = _gen_two_cabinet_meta(tmp_path)             # FLAT wall
    meta = json.loads(meta_path.read_text())
    _, K = _write_intrinsics(tmp_path)
    anchor = _write_anchor(tmp_path, K)                     # K_TRUE, dist=0
    rect_by_cr = {(c["col"], c["row"]): c["input_rect_px"] for c in meta["cabinets"]}
    pitch_by_cr = {(c["col"], c["row"]): c["pixel_pitch_mm"] for c in meta["cabinets"]}
    cab_by_id = {d["id"]: tuple(d["cabinet"]) for d in meta["dots"]}
    cab_world_t = {(0, 0): np.zeros(3), (1, 0): np.array([500.0, 0.0, 0.0])}
    poses = [look_at_pose(np.array([px, py, -1800.0]), np.array([250.0, 0.0, 0.0]))
             for (px, py) in [(-700, -300), (-300, 300), (300, -300), (700, 300), (0, 500), (0, -500)]]

    def _corr(inject):
        paths = []
        sha = hashlib.sha256(meta_path.read_bytes()).hexdigest()
        for vi, (R, t) in enumerate(poses):
            pts = []
            for d in meta["dots"]:
                cr = cab_by_id[d["id"]]
                pl = sl_local_mm(tuple(rect_by_cr[cr]), d["u"], d["v"], pitch_by_cr[cr][0], pitch_by_cr[cr][1])
                if inject:
                    pl = _warp_local(pl, kind)
                p = project_point(K, R, t, pl + cab_world_t[cr])     # noise-free
                pts.append({"id": d["id"], "u": d["u"], "v": d["v"], "x": float(p[0]), "y": float(p[1])})
            cp = tmp_path / f"corr_{inject}_{vi}.json"
            cp.write_text(json.dumps({"schema_version": 1, "screen_id": "MAIN", "sl_meta_sha256": sha,
                "screen_resolution": meta["screen_resolution"], "camera_image_size": [4000, 3000],
                "source_input": f"/cap/{inject}{vi}.mp4", "points": pts}))
            paths.append(str(cp))
        return paths

    base = {"command": "reconstruct_structured_light", "version": 1,
            "project": {"screen_id": "MAIN", "cabinet_array": {"cols": 2, "rows": 1,
                        "absent_cells": [], "cabinet_size_mm": [500, 500]}},   # default flat
            "sl_meta_path": str(meta_path), "intrinsics_path": "auto",
            "crosscheck_intrinsics_path": str(anchor)}

    # GUARD ON, error injected -> the absorbed deviation trips the cross-check -> refuse, no file.
    rep_on = tmp_path / "on.json"
    cmd_on = ReconstructStructuredLightInput.model_validate(
        {**base, "correspondence_paths": _corr(inject=True), "pose_report_path": str(rep_on)})
    assert run_reconstruct_structured_light(cmd_on) == 1
    assert not rep_on.exists()                              # no silent wrong file

    # CONTROL, no injection, same anchor -> self-cal ~ anchor -> passes (refusal was error-caused).
    rep_ctl = tmp_path / "ctl.json"
    cmd_ctl = ReconstructStructuredLightInput.model_validate(
        {**base, "correspondence_paths": _corr(inject=False), "pose_report_path": str(rep_ctl)})
    assert run_reconstruct_structured_light(cmd_ctl) == 0


def test_self_calibrate_inline_curved_no_anchor_emits_warning(capsys):
    # Codex P2: --intrinsics auto on a NON-coplanar (curved) target WITHOUT an anchor is
    # admitted but UNGUARDED, and must emit a no_intrinsics_anchor WarningEvent (which the
    # adapter collects onto the result for the headless CLI). Uses the curved 3x3 well
    # geometry directly so it exercises this branch without the full reconstruct pipeline
    # (flat-wall + no anchor would instead be REFUSED, so it can't reach this branch).
    from types import SimpleNamespace

    import lmt_vba_sidecar.sl_reconstruct as slr
    from lmt_vba_sidecar.sl_feasibility import project_point
    from lmt_vba_sidecar.nominal import nominal_dot_positions_world
    from test_calibrate_sl import _well_meta, _wall_center, _well_poses, K_TRUE, IMG

    meta, _proj, cab, shape = _well_meta()
    world = nominal_dot_positions_world(meta, cab, shape)
    poses = _well_poses(_wall_center(meta, cab, shape))
    ids = sorted(world.keys())
    corr_files = []
    for (R, t) in poses:
        pts = [SimpleNamespace(id=i, **dict(zip(("x", "y"),
               (float(v) for v in project_point(K_TRUE, R, t, world[i]))))) for i in ids]
        corr_files.append(SimpleNamespace(camera_image_size=list(IMG), points=pts))
    cmd = SimpleNamespace(project=SimpleNamespace(cabinet_array=cab, shape_prior=shape),
                          crosscheck_intrinsics_path=None)

    _K, _dist, _size = slr._self_calibrate_inline(meta, corr_files, cmd)
    events = [json.loads(l) for l in capsys.readouterr().out.splitlines() if l.strip()]
    assert any(e.get("event") == "warning" and e.get("code") == "no_intrinsics_anchor"
               for e in events)


def _reconstruct_two_cabinet_at_scale(tmp_path, scale):
    """Reconstruct the flat 2-cabinet wall with all p_local scaled by `scale` — a GLOBAL
    isotropic pitch error that rigid Procrustes to nominal cannot absorb (P5 class)."""
    meta_path = _gen_two_cabinet_meta(tmp_path)
    meta = json.loads(meta_path.read_text())
    intr_path, K = _write_intrinsics(tmp_path)
    rect_by_cr = {(c["col"], c["row"]): c["input_rect_px"] for c in meta["cabinets"]}
    pitch_by_cr = {(c["col"], c["row"]): c["pixel_pitch_mm"] for c in meta["cabinets"]}
    cab_by_id = {d["id"]: tuple(d["cabinet"]) for d in meta["dots"]}
    cab_world_t = {(0, 0): np.zeros(3), (1, 0): np.array([500.0, 0.0, 0.0])}
    truth = {}
    for d in meta["dots"]:
        cr = cab_by_id[d["id"]]
        pl = sl_local_mm(tuple(rect_by_cr[cr]), d["u"], d["v"], pitch_by_cr[cr][0], pitch_by_cr[cr][1])
        truth[d["id"]] = pl * scale + cab_world_t[cr]
    sha = hashlib.sha256(meta_path.read_bytes()).hexdigest()
    poses = [look_at_pose(np.array([px, 0.0, -3500.0]), np.array([250.0, 0.0, 0.0]))
             for px in (-1200.0, -400.0, 400.0, 1200.0)]
    rng = np.random.default_rng(0)
    corr_paths = []
    for vi, (R, t) in enumerate(poses):
        pts = [{"id": d["id"], "u": d["u"], "v": d["v"],
                **dict(zip(("x", "y"), (project_point(K, R, t, truth[d["id"]]) + rng.normal(0, 0.1, 2)).tolist()))}
               for d in meta["dots"]]
        cp = tmp_path / f"corr_{vi}.json"
        cp.write_text(json.dumps({"schema_version": 1, "screen_id": "MAIN", "sl_meta_sha256": sha,
            "screen_resolution": meta["screen_resolution"], "camera_image_size": [4000, 3000],
            "source_input": f"/cap/p{vi}.mp4", "points": pts}))
        corr_paths.append(str(cp))
    cmd = ReconstructStructuredLightInput.model_validate({
        "command": "reconstruct_structured_light", "version": 1,
        "project": {"screen_id": "MAIN", "cabinet_array": {"cols": 2, "rows": 1,
                    "absent_cells": [], "cabinet_size_mm": [500, 500]}},
        "correspondence_paths": corr_paths, "sl_meta_path": str(meta_path),
        "intrinsics_path": str(intr_path), "pose_report_path": str(tmp_path / "rep.json")})
    assert run_reconstruct_structured_light(cmd) == 0


def _warn_codes(capsys):
    return [json.loads(l)["code"] for l in capsys.readouterr().out.splitlines()
            if l.strip() and json.loads(l).get("event") == "warning"]


def test_nominal_misfit_warns_on_global_scale(tmp_path, capsys):
    # A GLOBAL ISOTROPIC pitch scale (the non-absorbable class, P5): rigid Procrustes to
    # nominal cannot absorb it, so the align residual is large -> nominal_misfit warning.
    # Reconstruction still completes (it is a warning, not a refusal). 2% scale ~ 4.9mm > 3.0.
    _reconstruct_two_cabinet_at_scale(tmp_path, scale=1.02)
    assert "nominal_misfit" in _warn_codes(capsys)


def test_no_nominal_misfit_on_clean_reconstruction(tmp_path, capsys):
    # Negative control: a faithful (scale=1.0) reconstruction aligns to nominal at sub-mm
    # (~0.18mm), so it must NOT spuriously emit nominal_misfit.
    _reconstruct_two_cabinet_at_scale(tmp_path, scale=1.0)
    assert "nominal_misfit" not in _warn_codes(capsys)
