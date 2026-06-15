# python-sidecar/tests/test_calibrate_sl.py
import json
import numpy as np
import pytest

from lmt_vba_sidecar.ipc import (
    CabinetArray, CabinetRect, CodeSpec, SequenceSpec, ReconstructProject,
    ShapePriorCurved, ShapePriorCurvedBody, StructuredLightDot, StructuredLightMeta,
    CalibrateStructuredLightInput,
)
from lmt_vba_sidecar.nominal import nominal_dot_positions_world
from lmt_vba_sidecar.sl_feasibility import look_at_pose, project_point
from lmt_vba_sidecar.calibrate_sl import run_calibrate_structured_light

K_TRUE = np.array([[3000.0, 0.0, 2000.0], [0.0, 3000.0, 1500.0], [0.0, 0.0, 1.0]])
IMG = (4000, 3000)


def _grid_meta(cols, rows, radius_mm=4000.0, grid=4, px=540):
    """A cols x rows curved wall with grid x grid dots per cabinet. radius_mm=None
    => flat. Default 1-row preserves the original single-row substrate for the
    under-constraint refusal tests that need a wide/thin wall."""
    cab = CabinetArray(cols=cols, rows=rows, cabinet_size_mm=[500.0, 500.0])
    shape = "flat" if radius_mm is None else ShapePriorCurved(curved=ShapePriorCurvedBody(radius_mm=radius_mm))
    rects, dots, did = [], [], 0
    for r in range(rows):
        for c in range(cols):
            rects.append(CabinetRect(col=c, row=r, input_rect_px=[c*px, r*px, px, px], pixel_pitch_mm=[500.0/px, 500.0/px]))
            for i in range(grid):
                for j in range(grid):
                    u = c*px + (i + 0.5) * px / grid
                    v = r*px + (j + 0.5) * px / grid
                    dots.append(StructuredLightDot(id=did, u=float(u), v=float(v), cabinet=[c, r])); did += 1
    meta = StructuredLightMeta(
        schema_version=1, screen_id="MAIN", screen_resolution=[cols*px, rows*px], dot_radius_px=4,
        code=CodeSpec(data_bits=8, total_bits=9), sequence=SequenceSpec(n_code_frames=9, hold_ms=100, fps=30),
        cabinets=rects, dots=dots,
    )
    proj = ReconstructProject(screen_id="MAIN", cabinet_array=cab, shape_prior=shape)
    return meta, proj, cab, shape


def _curved_meta(cols=4, radius_mm=4000.0, grid=4):
    """Original single-row (wide/thin) curved substrate — kept for the
    under-constraint refusal tests. NOT well-conditioned (see _well_meta)."""
    return _grid_meta(cols, 1, radius_mm=radius_mm, grid=grid)


def _well_meta():
    """GENUINELY well-conditioned substrate: a 3x3 curved wall (2D image coverage,
    non-coplanar). Pair with _well_poses for the happy tests."""
    return _grid_meta(cols=3, rows=3, radius_mm=6000.0, grid=3)


def _write_corr(tmp, meta, world, poses, sha="sha-test", noise=0.0, seed=0):
    rng = np.random.default_rng(seed)
    paths = []
    for vi, (R, t) in enumerate(poses):
        pts = []
        for d in meta.dots:
            p = project_point(K_TRUE, R, t, world[d.id]) + rng.normal(0, noise, 2)
            pts.append({"id": d.id, "u": d.u, "v": d.v, "x": float(p[0]), "y": float(p[1])})
        cp = tmp / f"corr_{vi}.json"
        cp.write_text(json.dumps({
            "schema_version": 1, "screen_id": "MAIN", "sl_meta_sha256": sha,
            "screen_resolution": meta.screen_resolution, "camera_image_size": list(IMG),
            "source_input": f"/cap/pose{vi}.mp4", "points": pts,
        }))
        paths.append(str(cp))
    return paths


def _ring_poses(n=4, dist_m=6.0):
    # Cameras on a shallow arc in front of the wall (meters; world is meters).
    # Single distance, near fronto-parallel -> UNDER-CONSTRAINED (refusal substrate).
    poses = []
    for k in range(n):
        x = -1.0 + 2.0 * k / max(1, n - 1)
        poses.append(look_at_pose(np.array([x, 0.0, -dist_m]), np.array([1.0, 0.0, 0.0])))
    return poses


def _wall_center(meta, cab, shape):
    world = nominal_dot_positions_world(meta, cab, shape)
    return np.array(list(world.values())).mean(0)


def _well_poses(center):
    """6 poses with REAL diversity: oblique azimuth/elevation orbit at TWO distinct
    camera distances. This is the operating envelope the gates require to pass."""
    cx, cy, cz = center
    poses = []
    for az, el, dist in [(-25, -12, 4.5), (20, 10, 4.5), (-15, 15, 8.0),
                         (30, -18, 8.0), (0, 0, 6.0), (-35, 5, 5.5)]:
        a, e = np.radians(az), np.radians(el)
        pos = np.array([cx + dist * np.sin(a) * np.cos(e),
                        cy + dist * np.sin(e),
                        cz - dist * np.cos(a) * np.cos(e)])
        poses.append(look_at_pose(pos, center))
    return poses


def _run(tmp, meta, proj, paths):
    import hashlib
    meta_path = tmp / "sl_meta.json"
    meta_path.write_text(meta.model_dump_json())
    sha = hashlib.sha256(meta_path.read_bytes()).hexdigest()
    for p in paths:
        d = json.loads(open(p).read()); d["sl_meta_sha256"] = sha; open(p, "w").write(json.dumps(d))
    out = tmp / "sl_intrinsics.json"
    cmd = CalibrateStructuredLightInput(
        command="calibrate_structured_light", version=1, project=proj,
        correspondence_paths=paths, sl_meta_path=str(meta_path), output_path=str(out),
    )
    rc = run_calibrate_structured_light(cmd)
    return rc, out


def test_recovers_K_noise_free(tmp_path):
    # Well-conditioned: 3x3 curved wall (2D coverage) + oblique, multi-distance
    # poses. This is the operating envelope the tightened gates require.
    meta, proj, cab, shape = _well_meta()
    world = nominal_dot_positions_world(meta, cab, shape)
    poses = _well_poses(_wall_center(meta, cab, shape))
    paths = _write_corr(tmp_path, meta, world, poses, noise=0.0)
    rc, out = _run(tmp_path, meta, proj, paths)
    assert rc == 0
    intr = json.loads(out.read_text())
    K = np.array(intr["K"])
    assert abs(K[0, 0] - 3000.0) / 3000.0 < 0.01
    assert abs(K[0, 2] - 2000.0) < 1.5
    assert abs(K[1, 2] - 1500.0) < 1.5
    assert intr["calibration_method"] == "structured_light_nominal"
    assert intr["frames_used"] == len(poses)


def test_recovers_K_with_noise_within_budget(tmp_path):
    meta, proj, cab, shape = _well_meta()
    world = nominal_dot_positions_world(meta, cab, shape)
    poses = _well_poses(_wall_center(meta, cab, shape))
    paths = _write_corr(tmp_path, meta, world, poses, noise=0.3)
    rc, out = _run(tmp_path, meta, proj, paths)
    assert rc == 0
    K = np.array(json.loads(out.read_text())["K"])
    assert abs(K[0, 0] - 3000.0) / 3000.0 < 0.02


def test_structured_deviation_within_budget_or_refused(tmp_path):
    # As-built arc radius deviates +2% from nominal (6000 -> 6120). Calibrate
    # against nominal; global deviation is absorbed into the per-pose extrinsics,
    # not K (spec §2.1), so K stays within budget (or the solve refuses).
    meta, proj, cab, shape = _well_meta()  # nominal radius 6000mm
    dev_shape = ShapePriorCurved(curved=ShapePriorCurvedBody(radius_mm=6120.0))
    truth_world = nominal_dot_positions_world(meta, cab, dev_shape)
    poses = _well_poses(_wall_center(meta, cab, shape))
    paths = _write_corr(tmp_path, meta, truth_world, poses, noise=0.3)
    rc, out = _run(tmp_path, meta, proj, paths)
    if rc == 0:
        K = np.array(json.loads(out.read_text())["K"])
        assert abs(K[0, 0] - 3000.0) / 3000.0 < 0.02, "absorbed deviation blew the focal budget without refusing"
    else:
        assert rc == 1


def test_near_flat_single_pose_refused(tmp_path):
    cab = CabinetArray(cols=1, rows=1, cabinet_size_mm=[500.0, 500.0])
    px = 540
    rect = CabinetRect(col=0, row=0, input_rect_px=[0, 0, px, px], pixel_pitch_mm=[500.0/px, 500.0/px])
    dots, did = [], 0
    for i in range(6):
        for j in range(6):
            dots.append(StructuredLightDot(id=did, u=(i+0.5)*px/6, v=(j+0.5)*px/6, cabinet=[0, 0])); did += 1
    meta = StructuredLightMeta(schema_version=1, screen_id="MAIN", screen_resolution=[px, px], dot_radius_px=4,
        code=CodeSpec(data_bits=8, total_bits=9), sequence=SequenceSpec(n_code_frames=9, hold_ms=100, fps=30),
        cabinets=[rect], dots=dots)
    proj = ReconstructProject(screen_id="MAIN", cabinet_array=cab, shape_prior="flat")
    world = nominal_dot_positions_world(meta, cab, "flat")
    paths = _write_corr(tmp_path, meta, world, _ring_poses(1), noise=0.0)
    rc, _ = _run(tmp_path, meta, proj, paths)
    assert rc == 1


def test_near_duplicate_poses_refused(tmp_path, capsys):
    # 3 captures from almost the same viewpoint of the well-conditioned 3x3 wall
    # at close range: coverage PASSES (2D, ~0.33) so the refusal is the
    # rotation-diversity gate firing on baseline collapse — pose count (3) is
    # satisfied but baseline diversity is not (F2). A single-row wall would refuse
    # here too, but via coverage, masking the diversity gate.
    meta, proj, cab, shape = _well_meta()
    world = nominal_dot_positions_world(meta, cab, shape)
    center = _wall_center(meta, cab, shape)
    dup = [look_at_pose(np.array([center[0] + 1e-3 * k, center[1], center[2] - 3.0]), center) for k in range(3)]
    paths = _write_corr(tmp_path, meta, world, dup, noise=0.1)
    rc, _ = _run(tmp_path, meta, proj, paths)
    assert rc == 1
    errs = [json.loads(l) for l in capsys.readouterr().out.splitlines()
            if l.strip() and json.loads(l).get("event") == "error"]
    assert errs[0]["code"] == "observability_failed"
    assert "view-axis diversity" in errs[0]["message"].lower(), errs[0]["message"]


def test_single_pose_near_planar_refused(tmp_path, capsys):
    # FIX-27: single pose on a near-planar target (depth/width ratio < 0.1) is
    # now refused at the geometry gate, before any covariance check. The 3×3
    # curved wall has ratio ~0.026 — genuine 3D but too shallow for single-pose.
    meta, proj, cab, shape = _well_meta()
    world = nominal_dot_positions_world(meta, cab, shape)
    center = _wall_center(meta, cab, shape)
    single = [look_at_pose(np.array([center[0], center[1], center[2] - 3.0]), center)]
    paths = _write_corr(tmp_path, meta, world, single, noise=0.3)
    rc, _ = _run(tmp_path, meta, proj, paths)
    assert rc == 1
    errs = [json.loads(l) for l in capsys.readouterr().out.splitlines()
            if l.strip() and json.loads(l).get("event") == "error"]
    assert len(errs) == 1, errs
    assert errs[0]["code"] == "observability_failed"
    assert "single pose" in errs[0]["message"].lower()


def test_single_pose_noise_free_also_refused(tmp_path, capsys):
    # FIX-27: even with zero noise, a single pose on a near-planar target
    # (ratio ~0.026) is refused — the geometry gate fires regardless of noise.
    meta, proj, cab, shape = _well_meta()
    world = nominal_dot_positions_world(meta, cab, shape)
    center = _wall_center(meta, cab, shape)
    single = [look_at_pose(np.array([center[0], center[1], center[2] - 3.0]), center)]
    paths = _write_corr(tmp_path, meta, world, single, noise=0.0)
    rc, _ = _run(tmp_path, meta, proj, paths)
    assert rc == 1
    errs = [json.loads(l) for l in capsys.readouterr().out.splitlines()
            if l.strip() and json.loads(l).get("event") == "error"]
    assert errs[0]["code"] == "observability_failed"


def test_shallow_arc_few_pose_refused(tmp_path):
    # The reviewer's case: a shallow-curved (sagitta ~0.09m) single-row wall seen
    # from 2 fronto-parallel-ish poses recovers fx 1-10% WRONG but at low RMS.
    # FAIL-SAFE: this MUST refuse (under-constrained focal/pp). foc_std ~6% > 0.5%
    # and min-axis coverage ~0.06 < 0.20 both fire.
    meta, proj, cab, shape = _curved_meta(cols=4, radius_mm=5560.0)  # sagitta ~0.09m over 2m
    world = nominal_dot_positions_world(meta, cab, shape)
    rc, _ = _run(tmp_path, meta, proj, _write_corr(tmp_path, meta, world, _ring_poses(2), noise=0.3))
    assert rc == 1


def test_one_dimensional_coverage_refused(tmp_path):
    # A wide/short wall (8x1 cabinets) seen fronto-parallel projects to a thin
    # horizontal band: the vertical image axis collapses (~0.04 span) so fy/cy are
    # unconstrained. FAIL-SAFE: the min-axis coverage gate must refuse (a max()
    # gate would let the dominant axis carry it through).
    meta, proj, cab, shape = _grid_meta(cols=8, rows=1, radius_mm=None, grid=4)
    world = nominal_dot_positions_world(meta, cab, shape)
    center = _wall_center(meta, cab, shape)
    poses = [look_at_pose(np.array([center[0] + dx, 0.0, -10.0]), center) for dx in (-1.0, 0.0, 1.0)]
    rc, _ = _run(tmp_path, meta, proj, _write_corr(tmp_path, meta, world, poses, noise=0.3))
    assert rc == 1


def test_sl_meta_subset_of_project_cells_refused(tmp_path, capsys):
    # Stale sl_meta covering only a SUBSET of the project's present cells must be
    # refused (parity with reconstruct-structured-light). Project stays at full
    # cols=4; meta drops the last cabinet's rect AND its dots (so the kept dots
    # only reference present cabinets -> nominal_dot_positions_world's own per-dot
    # raise does NOT pre-empt; the cabinet-SET gate must be what fires).
    meta, proj, cab, shape = _curved_meta(cols=4)
    drop_cr = (3, 0)
    sub_rects = [r for r in meta.cabinets if (r.col, r.row) != drop_cr]
    sub_dots = [d for d in meta.dots if tuple(d.cabinet) != drop_cr]
    sub_meta = StructuredLightMeta(
        schema_version=1, screen_id="MAIN", screen_resolution=meta.screen_resolution,
        dot_radius_px=meta.dot_radius_px, code=meta.code, sequence=meta.sequence,
        cabinets=sub_rects, dots=sub_dots,
    )
    # World built from the subset meta so the kept dots have valid 3D + projections.
    world = nominal_dot_positions_world(sub_meta, cab, shape)
    paths = _write_corr(tmp_path, sub_meta, world, _ring_poses(4), noise=0.0)
    rc, _ = _run(tmp_path, sub_meta, proj, paths)
    assert rc == 1
    errs = [json.loads(l) for l in capsys.readouterr().out.splitlines()
            if l.strip() and json.loads(l).get("event") == "error"]
    assert len(errs) == 1, errs
    assert errs[0]["code"] == "invalid_input"
    msg = errs[0]["message"].lower()
    assert "cabinet set" in msg and "present cells" in msg, errs[0]["message"]


def test_output_records_distortion_model(tmp_path):
    meta, proj, cab, shape = _well_meta()
    world = nominal_dot_positions_world(meta, cab, shape)
    poses = _well_poses(_wall_center(meta, cab, shape))
    paths = _write_corr(tmp_path, meta, world, poses, noise=0.0)
    rc, out = _run(tmp_path, meta, proj, paths)
    assert rc == 0
    intr = json.loads(out.read_text())
    assert intr["distortion_model"] in ("radial2", "full")


def test_flat_wall_no_anchor_refused(tmp_path, capsys):
    # _grid_meta(radius_mm=None) builds a FLAT (coplanar) wall; no crosscheck anchor
    # -> the anti-absorption guard refuses (cannot separate screen pitch/1:1 from K).
    meta, proj, cab, shape = _grid_meta(cols=3, rows=3, radius_mm=None, grid=3)
    world = nominal_dot_positions_world(meta, cab, shape)
    poses = _well_poses(_wall_center(meta, cab, shape))
    paths = _write_corr(tmp_path, meta, world, poses, noise=0.0)
    rc, _ = _run(tmp_path, meta, proj, paths)  # no crosscheck path
    assert rc == 1
    errs = [json.loads(l) for l in capsys.readouterr().out.splitlines()
            if l.strip() and json.loads(l).get("event") == "error"]
    assert errs[-1]["code"] == "observability_failed"
    assert "anchor" in errs[-1]["message"].lower()
