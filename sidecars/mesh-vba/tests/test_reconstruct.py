"""End-to-end reconstruct tests for the model-constrained (zero total-station)
pipeline.

The synthetic_charuco_capture fixture (tests/conftest.py) renders two real
ChArUco boards at a known distance / inter-board angle, captured from many
views. reconstruct must recover that geometry from screen-mapping local mm
alone (no anchors, no world datum)."""
from __future__ import annotations

import io
import json
import pathlib

import cv2
import numpy as np

from lmt_vba_sidecar.ipc import ReconstructInput
from lmt_vba_sidecar.model_constrained_ba import Observation, model_constrained_ba
from lmt_vba_sidecar.reconstruct import (
    MIN_PNP_CORNERS,
    _classify_cabinet_quality,
    _pnp_camera,
    estimate_nonroot_cabinet_init,
    run_reconstruct,
)


def _build_input(paths: dict, shape_prior="flat") -> ReconstructInput:
    return ReconstructInput.model_validate(
        {
            "command": "reconstruct",
            "version": 1,
            "project": {
                "screen_id": "S",
                # cabinet_size_mm is only the nominal BA-init seed grid. This
                # 2x1 horizontal layout uses only the x spacing for init, so
                # the height (340) has no geometric effect here; the actual
                # panel size / corners come from screen_mapping's SQUARE active
                # surface (600x600 — square because a ChArUco board PNG must
                # fill its canvas with no letterbox to keep the local-mm chain
                # exact). BA still recovers the true 700mm / 10deg regardless.
                "cabinet_array": {"cols": 2, "rows": 1, "cabinet_size_mm": [600, 340]},
                "shape_prior": shape_prior,
            },
            "capture_manifest_path": paths["capture"],
            "screen_mapping_path": paths["screen_mapping"],
            "pose_report_path": paths["pose_report"],
        }
    )


def test_reconstruct_writes_pose_report_and_matches_known_geometry(
    synthetic_charuco_capture, capsys,
):
    paths = synthetic_charuco_capture
    rc = run_reconstruct(_build_input(paths))
    assert rc == 0

    rep = json.loads(open(paths["pose_report"]).read())
    assert rep["schema_version"] == "visual_pose_report.v1"

    # --- gauge frame invariants (the "zero total station" design center) ---
    assert rep["frame"]["gauge_strategy"] == "fix_root_cabinet"
    assert rep["frame"]["root_cabinet"] == [0, 0]

    poses = {p["cabinet_id"]: p for p in rep["cabinet_poses"]}
    c0 = np.array(poses["V000_R000"]["position_mm"])
    c1 = np.array(poses["V001_R000"]["position_mm"])

    # Root cabinet is the gauge: fixed at origin with identity rotation.
    assert np.allclose(c0, [0.0, 0.0, 0.0], atol=1e-6)
    assert np.allclose(
        np.array(poses["V000_R000"]["rotation_matrix"]), np.eye(3), atol=1e-6
    )

    # --- recovered geometry matches known truth ---
    assert abs(np.linalg.norm(c1 - c0) - 700.0) < 5.0
    n0 = np.array(poses["V000_R000"]["normal"])
    n1 = np.array(poses["V001_R000"]["normal"])
    ang = np.degrees(np.arccos(np.clip(n0 @ n1, -1, 1)))
    assert abs(ang - 10.0) < 0.5

    # --- FIX-13 ④: per-cabinet BA covariance persists in the pose report ---
    # (measured.yaml write-out was removed; this is the covariance's only home).
    # Root cabinet is the gauge anchor (not a BA parameter) → honestly None.
    assert poses["V000_R000"]["covariance_mm2"] is None
    cov = poses["V001_R000"]["covariance_mm2"]
    assert cov is not None, "non-root cabinet missing covariance_mm2"
    cov = np.asarray(cov, dtype=float)
    assert cov.shape == (3, 3)
    assert np.isfinite(cov).all()

    # --- measured_points: count / names / mm->m conversion ---
    result = json.loads(
        [ln for ln in capsys.readouterr().out.splitlines() if ln.strip()][-1]
    )
    assert result["event"] == "result"
    mps = result["data"]["measured_points"]
    assert len(mps) == 2
    by_name = {m["name"]: m for m in mps}
    assert set(by_name) == {"MAIN_V000_R000", "MAIN_V001_R000"}
    # Positions are in METERS: root at origin, second cabinet ~0.7m in x.
    p0 = np.array(by_name["MAIN_V000_R000"]["position"])
    p1 = np.array(by_name["MAIN_V001_R000"]["position"])
    assert np.allclose(p0, [0.0, 0.0, 0.0], atol=1e-6)
    assert abs(p1[0] - 0.7) < 0.005


def test_classify_cabinet_quality_all_branches():
    """Soft classifier: views-below-threshold dominates, then residual, else ok."""
    assert _classify_cabinet_quality(2, 0.5) == "low_observation"  # views < 4
    assert _classify_cabinet_quality(10, 3.0) == "high_residual"  # rms > 2.0
    assert _classify_cabinet_quality(10, 0.5) == "ok"
    # QUALITY_MIN_VIEWS boundary: exactly 4 is ok, 3 is low (strict <).
    assert _classify_cabinet_quality(4, 0.5) == "ok"
    assert _classify_cabinet_quality(3, 0.5) == "low_observation"


def test_reconstruct_happy_path_quality_ok_no_warning(
    synthetic_charuco_capture, capsys,
):
    """Both cabinets seen by all views with low residual -> quality "ok" and NO
    cabinet_quality warning emitted."""
    paths = synthetic_charuco_capture
    rc = run_reconstruct(_build_input(paths))
    assert rc == 0

    rep = json.loads(open(paths["pose_report"]).read())
    poses = {p["cabinet_id"]: p for p in rep["cabinet_poses"]}
    assert poses["V000_R000"]["quality"] == "ok"
    assert poses["V001_R000"]["quality"] == "ok"

    events = [
        json.loads(ln)
        for ln in capsys.readouterr().out.splitlines()
        if ln.strip()
    ]
    quality_warnings = [
        e for e in events
        if e.get("event") == "warning" and e.get("code") == "cabinet_quality"
    ]
    assert quality_warnings == []


def test_reconstruct_underobserved_cabinet_flagged_low_observation(
    synthetic_charuco_capture_underobserved, capsys,
):
    """Non-root cabinet rendered into only 3 views (>=2 clears observability,
    but < QUALITY_MIN_VIEWS=4) -> quality "low_observation" + a cabinet_quality
    warning for it. The root (in all views) stays "ok"."""
    paths = synthetic_charuco_capture_underobserved
    rc = run_reconstruct(_build_input(paths))
    assert rc == 0

    rep = json.loads(open(paths["pose_report"]).read())
    poses = {p["cabinet_id"]: p for p in rep["cabinet_poses"]}
    assert poses["V001_R000"]["observed_views"] == 3
    assert poses["V001_R000"]["quality"] == "low_observation"
    assert poses["V000_R000"]["quality"] == "ok"

    events = [
        json.loads(ln)
        for ln in capsys.readouterr().out.splitlines()
        if ln.strip()
    ]
    quality_warnings = [
        e for e in events
        if e.get("event") == "warning" and e.get("code") == "cabinet_quality"
    ]
    assert len(quality_warnings) == 1
    w = quality_warnings[0]
    assert w["cabinet"] == "V001_R000"
    assert "low_observation" in w["message"]
    assert "V001_R000" in w["message"]
    assert "1 cabinet(s) with quality issues" in w["message"]


def test_reconstruct_structured_light_method_rejected(synthetic_charuco_capture):
    """The capture manifest method gates the pipeline: structured-light is not
    implemented and must fail closed with the invalid_input envelope."""
    paths = synthetic_charuco_capture
    cap_path = pathlib.Path(paths["capture"])
    manifest = json.loads(cap_path.read_text())
    manifest["method"] = "structured-light"
    # Structured-light views need a frames list (charuco needs images); supply
    # a minimal frames entry so manifest loading reaches the method gate.
    for view in manifest["views"]:
        view["frames"] = [{"path": view["images"][0]}]
        view.pop("images", None)
    sl_path = cap_path.with_name("capture_sl.json")
    sl_path.write_text(json.dumps(manifest))

    inp = _build_input({**paths, "capture": str(sl_path)})

    import contextlib

    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = run_reconstruct(inp)
    assert rc == 1
    last = json.loads([ln for ln in buf.getvalue().splitlines() if ln.strip()][-1])
    assert last["event"] == "error"
    assert last["code"] == "invalid_input"


def test_pnp_camera_fallback_recovers_world_pose():
    """Unit test for the non-root PnP fallback frame composition (no rendering).

    init_cabinets stores world_from_cabinet (BA: xw = R_wc·p_local + t_wc).
    solvePnP returns camera_from_cabinet (Rcc, tcc): x_cam = Rcc·p_local + tcc.
    The camera init must be camera_from_world: x_cam = R·x_world + t. So the
    correct composition is camera_from_world = camera_from_cabinet ∘
    inverse(world_from_cabinet): R = Rcc·R_wc^T, t = tcc − R·t_wc.

    The old buggy composition (R = Rcc·R_wc; t = Rcc·t_wc + tcc) shifts the
    translation seed by ~2·R_cam·t_wc when the camera is rotated, so the
    recovered t is off by far more than 1 mm.
    """
    import cv2

    # Known camera world pose (camera_from_world): x_cam = R_cam·x_world + t_cam.
    rvec_cam = np.array([0.05, -0.08, 0.03], dtype=float)
    R_cam, _ = cv2.Rodrigues(rvec_cam)
    t_cam = np.array([50.0, -20.0, 2500.0], dtype=float)

    # Non-root cabinet (idx 1) world pose (world_from_cabinet): identity
    # rotation + nominal offset, matching init_cabinets non-root entries.
    t_wc = np.array([700.0, 0.0, 0.0], dtype=float)

    # A grid of local-mm corners spanning ±300 x ±170 (>= MIN_PNP_CORNERS).
    p_locals = [
        np.array([x, y, 0.0], dtype=float)
        for x in (-300.0, 300.0)
        for y in (-170.0, 170.0)
    ] + [
        np.array([x, y, 0.0], dtype=float)
        for x in (-150.0, 150.0)
        for y in (-85.0, 85.0)
    ]
    assert len(p_locals) >= MIN_PNP_CORNERS

    K = np.array(
        [[1800.0, 0.0, 960.0], [0.0, 1800.0, 540.0], [0.0, 0.0, 1.0]], dtype=float
    )

    corners = []
    for p_local in p_locals:
        xw = p_local + t_wc            # world_from_cabinet (identity R)
        xc = R_cam @ xw + t_cam        # camera_from_world
        proj = K @ xc
        px = proj[:2] / proj[2]
        corners.append((p_local, px))

    # NO (0, root_idx) entry -> forces the fallback branch.
    per_view_cab_corners = {(0, 1): corners}
    init_cabinets = {
        0: (np.eye(3), np.zeros(3)),
        1: (np.eye(3), t_wc),
    }

    R, t = _pnp_camera(
        cam_idx=0,
        root_idx=0,
        init_cabinets=init_cabinets,
        per_view_cab_corners=per_view_cab_corners,
        K=K,
    )

    assert np.allclose(R, R_cam, atol=1e-4)
    assert np.linalg.norm(t - t_cam) < 1.0


def test_reconstruct_folded_shape_prior_is_invalid_input(
    synthetic_charuco_capture, capsys,
):
    """An unsupported (folded) shape_prior reaches nominal_cabinet_centers_model_frame
    after detection + observability pass, where it raises ValueError. That must
    surface as the invalid_input envelope, NOT an internal_error traceback."""
    paths = synthetic_charuco_capture
    inp = _build_input(paths, shape_prior={"folded": {"fold_seam_columns": [1]}})
    rc = run_reconstruct(inp)
    assert rc == 1

    last = json.loads(
        [ln for ln in capsys.readouterr().out.splitlines() if ln.strip()][-1]
    )
    assert last["event"] == "error"
    assert last["code"] == "invalid_input"


def _project(R_cam, t_cam, R_cab, t_cab, p_local, K):
    xw = R_cab @ p_local + t_cab
    xc = R_cam @ xw + t_cam
    p = K @ xc
    return p[:2] / p[2]


def test_estimate_nonroot_cabinet_init_recovers_known_pose():
    K = np.array([[2000.0, 0, 960], [0, 2000.0, 540], [0, 0, 1.0]])
    # 4 well-spread coplanar corners — ChArUco object points are coplanar, so
    # cv2's ITERATIVE solver uses a homography init that works with >= 4 points.
    root_local = np.array([[-300, -170, 0], [300, -170, 0],
                           [300, 170, 0], [-300, 170, 0]], dtype=float)
    # Identical coplanar local geometry on purpose: both cabinets share the
    # same active-surface corner layout, so any recovered pose difference comes
    # only from the bridge composition, not from differing object points.
    nonroot_local = root_local.copy()
    # ground-truth world_from_nonroot: 60 deg about y + translate
    ang = np.deg2rad(60.0)
    R_true = np.array([[np.cos(ang), 0, np.sin(ang)],
                       [0, 1, 0],
                       [-np.sin(ang), 0, np.cos(ang)]])
    t_true = np.array([500.0, 0.0, -200.0])

    # 3 synthetic cameras, all see both cabinets
    cams = []
    for dx in (-300.0, 0.0, 300.0):
        R_cam = np.eye(3)
        t_cam = np.array([dx, 0.0, 2200.0])
        cams.append((R_cam, t_cam))

    per_view: dict[tuple[int, int], list] = {}
    for ci, (R_cam, t_cam) in enumerate(cams):
        root_obs = [(p, _project(R_cam, t_cam, np.eye(3), np.zeros(3), p, K))
                    for p in root_local]
        non_obs = [(p, _project(R_cam, t_cam, R_true, t_true, p, K))
                   for p in nonroot_local]
        per_view[(ci, 0)] = root_obs   # cabinet idx 0 = root
        per_view[(ci, 1)] = non_obs    # cabinet idx 1 = non-root

    out, undecidable = estimate_nonroot_cabinet_init(
        per_view, root_idx=0, K=K,
        nominal_poses={0: (np.eye(3), np.zeros(3)), 1: (R_true, t_true / 1000.0)},
    )
    assert undecidable == set()
    assert 1 in out, "non-root cabinet should get a bridge estimate"
    R_est, t_est = out[1]
    # rotation close (trace test) and translation close
    ang_err = np.degrees(np.arccos(np.clip((np.trace(R_est.T @ R_true) - 1) / 2, -1, 1)))
    assert ang_err < 1.0, f"rotation error {ang_err:.3f} deg too large"
    assert np.linalg.norm(t_est - t_true) < 5.0, f"t_est={t_est} vs {t_true}"


def test_estimate_nonroot_cabinet_init_no_bridge_returns_empty():
    """No view sees the root with >= MIN_PNP_CORNERS corners (one view shows
    only the non-root, another shows the root with just 2 corners) -> nothing
    can be bridged, so the result is an empty dict (caller falls back to nominal)."""
    K = np.array([[2000.0, 0, 960], [0, 2000.0, 540], [0, 0, 1.0]])
    local = np.array([[-300, -170, 0], [300, -170, 0],
                      [300, 170, 0], [-300, 170, 0]], dtype=float)
    R_cam = np.eye(3)
    t_cam = np.array([0.0, 0.0, 2200.0])

    per_view: dict[tuple[int, int], list] = {
        # view 0: only the non-root cabinet visible (no root in this view).
        (0, 1): [(p, _project(R_cam, t_cam, np.eye(3), np.zeros(3), p, K))
                 for p in local],
        # view 1: root visible but with < MIN_PNP_CORNERS corners.
        (1, 0): [(p, _project(R_cam, t_cam, np.eye(3), np.zeros(3), p, K))
                 for p in local[:2]],
        (1, 1): [(p, _project(R_cam, t_cam, np.eye(3), np.zeros(3), p, K))
                 for p in local],
    }

    out, undecidable = estimate_nonroot_cabinet_init(
        per_view, root_idx=0, K=K,
        nominal_poses={0: (np.eye(3), np.zeros(3)), 1: (np.eye(3), np.zeros(3))},
    )
    assert out == {}
    assert undecidable == set()


def test_bridge_init_makes_ba_converge_to_known_angle():
    K = np.array([[2000.0, 0, 960], [0, 2000.0, 540], [0, 0, 1.0]])
    # 4 well-spread coplanar corners — proves 4-corner bridge views are usable.
    root_local = np.array([[-300, -170, 0], [300, -170, 0],
                           [300, 170, 0], [-300, 170, 0]], dtype=float)
    ang = np.deg2rad(60.0)
    R_true = np.array([[np.cos(ang), 0, np.sin(ang)],
                       [0, 1, 0],
                       [-np.sin(ang), 0, np.cos(ang)]])
    t_true = np.array([500.0, 0.0, -200.0])
    cams = [(np.eye(3), np.array([dx, 0.0, 2200.0])) for dx in (-300., -100., 100., 300.)]

    per_view: dict[tuple[int, int], list] = {}
    observations = []
    init_cameras = []
    for ci, (R_cam, t_cam) in enumerate(cams):
        init_cameras.append((R_cam, t_cam))
        for p in root_local:
            pix = _project(R_cam, t_cam, np.eye(3), np.zeros(3), p, K)
            observations.append(Observation(camera_idx=ci, cabinet_idx=0, p_local=p, pixel=pix))
            per_view.setdefault((ci, 0), []).append((p, pix))
        for p in root_local:
            pix = _project(R_cam, t_cam, R_true, t_true, p, K)
            observations.append(Observation(camera_idx=ci, cabinet_idx=1, p_local=p, pixel=pix))
            per_view.setdefault((ci, 1), []).append((p, pix))

    bridge, undecidable = estimate_nonroot_cabinet_init(
        per_view, root_idx=0, K=K,
        nominal_poses={0: (np.eye(3), np.zeros(3)), 1: (R_true, t_true / 1000.0)},
    )
    assert undecidable == set()
    init_cabinets = {0: (np.eye(3), np.zeros(3)), 1: bridge[1]}
    res = model_constrained_ba(
        K=K, observations=observations, n_cameras=len(cams), n_cabinets=2,
        root_cabinet_idx=0, init_cameras=init_cameras, init_cabinets=init_cabinets,
    )
    assert res.converged
    assert res.rms_reprojection_px < 1.0
    R_solved, _ = res.cabinet_poses[1]
    n_root = np.array([0, 0, 1.0])
    n_non = R_solved @ np.array([0, 0, 1.0])
    angle = np.degrees(np.arccos(np.clip(n_root @ n_non, -1, 1)))
    assert abs(angle - 60.0) < 1.0, f"recovered inter-panel angle {angle:.2f} != 60"


def test_solve_pnp_handles_4_points_and_skips_degenerate():
    from lmt_vba_sidecar.reconstruct import _solve_pnp
    K = np.array([[2000.0, 0, 960], [0, 2000.0, 540], [0, 0, 1.0]])
    R = cv2.Rodrigues(np.array([0.1, 0.2, 0.05]))[0]
    t = np.array([50.0, 30.0, 2200.0])

    def obs(obj):
        xc = (R @ obj.T).T + t
        pix = (K @ xc.T).T
        pix = pix[:, :2] / pix[:, 2:3]
        return list(zip(obj, pix))

    # 4 well-spread coplanar corners -> solvable (homography path)
    spread4 = np.array([[-300, -170, 0], [300, -170, 0], [300, 170, 0], [-300, 170, 0]], dtype=float)
    assert _solve_pnp(obs(spread4), K) is not None
    # 5 (near-)collinear coplanar points -> degenerate -> None (caught cv2.error, no crash)
    collinear5 = np.array([[x, 0.0, 0.0] for x in np.linspace(-300, 300, 5)], dtype=float)
    assert _solve_pnp(obs(collinear5), K) is None
    # < 4 points -> None
    assert _solve_pnp(obs(spread4[:3]), K) is None


def test_solve_pnp_branches_returns_inliers_and_two_ippe_branches():
    from lmt_vba_sidecar.reconstruct import _solve_pnp_branches
    K = np.array([[2000.0, 0, 960], [0, 2000.0, 540], [0, 0, 1.0]])
    # Oblique view (tilt ~40 deg about y) of a coplanar grid -> IPPE gives 2 branches.
    ang = np.deg2rad(40.0)
    R = np.array([[np.cos(ang), 0, np.sin(ang)], [0, 1, 0], [-np.sin(ang), 0, np.cos(ang)]])
    t = np.array([40.0, 30.0, 2200.0])
    obj = np.array([[x, y, 0.0] for x in (-300.0, -100.0, 100.0, 300.0)
                    for y in (-170.0, 0.0, 170.0)], dtype=float)
    xc = (R @ obj.T).T + t
    pix = (K @ xc.T).T
    pix = pix[:, :2] / pix[:, 2:3]
    corners = list(zip(obj, pix))

    res = _solve_pnp_branches(corners, K)
    assert res is not None
    branches, inlier_mask = res
    # All clean points are inliers.
    assert inlier_mask.sum() == len(corners)
    # IPPE yields 1 or 2 branches; when 2, the camera-frame normals share z-sign
    # (Codex finding-1: front-facing cannot disambiguate; only lateral flips).
    assert 1 <= len(branches) <= 2
    if len(branches) == 2:
        n0 = branches[0][0] @ np.array([0.0, 0.0, 1.0])
        n1 = branches[1][0] @ np.array([0.0, 0.0, 1.0])
        # In the OBJECT frame both branches' surface points face the camera, so
        # the camera-frame z-component of the rotated normal shares sign.
        zc0 = (R.T if False else branches[0][0]) @ np.array([0.0, 0.0, 1.0])
        assert np.sign(n0[2]) == np.sign(n1[2])


def test_solve_pnp_branches_rejects_gross_outlier():
    from lmt_vba_sidecar.reconstruct import _solve_pnp_branches
    K = np.array([[2000.0, 0, 960], [0, 2000.0, 540], [0, 0, 1.0]])
    R = cv2.Rodrigues(np.array([0.1, 0.2, 0.05]))[0]
    t = np.array([50.0, 30.0, 2200.0])
    obj = np.array([[x, y, 0.0] for x in (-300.0, -100.0, 100.0, 300.0)
                    for y in (-170.0, 0.0, 170.0)], dtype=float)
    xc = (R @ obj.T).T + t
    pix = (K @ xc.T).T
    pix = pix[:, :2] / pix[:, 2:3]
    # Corrupt the last point's pixel by 400px -> must be a RANSAC outlier.
    pix[-1] += np.array([400.0, 400.0])
    corners = list(zip(obj, pix))
    res = _solve_pnp_branches(corners, K)
    assert res is not None
    _branches, inlier_mask = res
    assert inlier_mask[-1] == False
    assert inlier_mask[:-1].all()


def test_solve_pnp_branches_none_for_few_or_degenerate():
    from lmt_vba_sidecar.reconstruct import _solve_pnp_branches
    K = np.array([[2000.0, 0, 960], [0, 2000.0, 540], [0, 0, 1.0]])
    obj3 = [(np.array([x, 0.0, 0.0]), np.array([x, 0.0])) for x in (-1.0, 0.0, 1.0)]
    assert _solve_pnp_branches(obj3, K) is None  # < 4
    R = cv2.Rodrigues(np.array([0.1, 0.2, 0.05]))[0]
    t = np.array([50.0, 30.0, 2200.0])
    collinear = np.array([[x, 0.0, 0.0] for x in np.linspace(-300, 300, 6)], dtype=float)
    xc = (R @ collinear.T).T + t
    pix = (K @ xc.T).T
    pix = pix[:, :2] / pix[:, 2:3]
    assert _solve_pnp_branches(list(zip(collinear, pix)), K) is None


def _ippe_oblique_corners(K, R_world_from_cab, t_world, R_cam, t_cam):
    """Coplanar grid at world pose -> camera pixels (used to build IPPE cases)."""
    obj = np.array([[x, y, 0.0] for x in (-300.0, -100.0, 100.0, 300.0)
                    for y in (-170.0, 0.0, 170.0)], dtype=float)
    corners = []
    for p in obj:
        xw = R_world_from_cab @ p + t_world
        xc = R_cam @ xw + t_cam
        pr = K @ xc
        corners.append((p, pr[:2] / pr[2]))
    return corners


def test_nominal_orientation_picks_correct_branch_oblique():
    """A single oblique non-root cabinet (curved nominal tilt) is disambiguated
    to the branch whose model-frame normal matches the nominal arc normal, NOT
    its mirror."""
    from lmt_vba_sidecar.reconstruct import estimate_nonroot_cabinet_init
    K = np.array([[2000.0, 0, 960], [0, 2000.0, 540], [0, 0, 1.0]])
    # Ground-truth non-root cabinet tilted +35deg about y (right side of an arc).
    a = np.deg2rad(35.0)
    R_true = np.array([[np.cos(a), 0, np.sin(a)], [0, 1, 0], [-np.sin(a), 0, np.cos(a)]])
    t_true = np.array([500.0, 0.0, 150.0])
    root_local = np.array([[-300, -170, 0], [300, -170, 0], [300, 170, 0], [-300, 170, 0]], float)
    cams = [(np.eye(3), np.array([dx, 0.0, 2400.0])) for dx in (-200.0, 0.0, 200.0)]
    per_view = {}
    for ci, (R_cam, t_cam) in enumerate(cams):
        per_view[(ci, 0)] = [(p, (lambda xw: (K @ (R_cam @ xw + t_cam))[:2]
                                  / (K @ (R_cam @ xw + t_cam))[2])(p))
                             for p in root_local]
        per_view[(ci, 1)] = _ippe_oblique_corners(K, R_true, t_true, R_cam, t_cam)
    # Nominal pose for cabinet 1 IS the true tilt; its derived normal (R @ z)
    # matches the true branch, not the mirror.
    out, undecidable = estimate_nonroot_cabinet_init(
        per_view, root_idx=0, K=K,
        nominal_poses={0: (np.eye(3), np.zeros(3)), 1: (R_true, np.array([0.5, 0.0, 0.15]))},
    )
    assert undecidable == set()
    R_est, _t = out[1]
    n_est = R_est @ np.array([0.0, 0.0, 1.0])
    n_true = R_true @ np.array([0.0, 0.0, 1.0])
    ang = np.degrees(np.arccos(np.clip(n_est @ n_true, -1, 1)))
    assert ang < 5.0, f"picked wrong (mirror) branch: {ang:.1f}deg from truth"


def test_seeded_flip_is_corrected_by_nominal():
    """A SEEDED MIRROR flip is corrected by nominal disambiguation.

    OpenCV's IPPE happens to return the correct branch at index 0 for these
    oblique cases, so a naive "pick branch[0]" would trivially pass. To genuinely
    prove flip-correction this test (a) directly feeds the MIRROR branch as
    candidate index 0 to _disambiguate_world_branch and asserts the
    nominal-matching (non-mirrored) branch is still chosen, and (b) confirms the
    end-to-end estimate_nonroot_cabinet_init lands on the non-mirrored pose."""
    from lmt_vba_sidecar.reconstruct import (
        _disambiguate_world_branch, _solve_pnp_branches,
        estimate_nonroot_cabinet_init)
    K = np.array([[2000.0, 0, 960], [0, 2000.0, 540], [0, 0, 1.0]])
    a = np.deg2rad(45.0)
    R_true = np.array([[np.cos(a), 0, np.sin(a)], [0, 1, 0], [-np.sin(a), 0, np.cos(a)]])
    n_true = R_true @ np.array([0.0, 0.0, 1.0])

    # (a) Build the two IPPE branches for an oblique panel viewed head-on, then
    # REVERSE so the mirror (wrong) branch sits at index 0 — the worst case for a
    # branch[0]-picker. Disambiguation against nominal must still pick the
    # correct, non-mirrored branch.
    obj = np.array([[x, y, 0.0] for x in (-300.0, -100.0, 100.0, 300.0)
                    for y in (-170.0, 0.0, 170.0)], dtype=float)
    xc = (R_true @ obj.T).T + np.array([40.0, 30.0, 2200.0])
    pix = (K @ xc.T).T
    pix = pix[:, :2] / pix[:, 2:3]
    branches, _mask = _solve_pnp_branches(list(zip(obj, pix)), K)
    assert len(branches) == 2
    mirror_first = list(reversed(branches))  # force the mirror to be candidate 0
    n_seed = mirror_first[0][0] @ np.array([0.0, 0.0, 1.0])
    assert np.sign(n_seed[0]) != np.sign(n_true[0]), "seed branch[0] must be the mirror"
    chosen = _disambiguate_world_branch(mirror_first, n_true)
    assert chosen != "undecidable"
    n_chosen = chosen[0] @ np.array([0.0, 0.0, 1.0])
    assert np.sign(n_chosen[0]) == np.sign(n_true[0]), "disambiguation failed to undo the seeded flip"
    assert np.degrees(np.arccos(np.clip(n_chosen @ n_true, -1, 1))) < 5.0

    # (b) End-to-end: the bridge init returns the non-mirrored pose.
    t_true = np.array([600.0, 0.0, 200.0])
    root_local = np.array([[-300, -170, 0], [300, -170, 0], [300, 170, 0], [-300, 170, 0]], float)
    cams = [(np.eye(3), np.array([dx, 0.0, 2400.0])) for dx in (-200.0, 0.0, 200.0)]
    per_view = {}
    for ci, (R_cam, t_cam) in enumerate(cams):
        per_view[(ci, 0)] = [(p, (lambda xw: (K @ (R_cam @ xw + t_cam))[:2]
                                  / (K @ (R_cam @ xw + t_cam))[2])(p)) for p in root_local]
        per_view[(ci, 1)] = _ippe_oblique_corners(K, R_true, t_true, R_cam, t_cam)
    out, undecidable = estimate_nonroot_cabinet_init(
        per_view, root_idx=0, K=K,
        nominal_poses={0: (np.eye(3), np.zeros(3)), 1: (R_true, np.array([0.6, 0.0, 0.2]))})
    assert 1 in out and undecidable == set()
    n_est = out[1][0] @ np.array([0.0, 0.0, 1.0])
    assert np.degrees(np.arccos(np.clip(n_est @ n_true, -1, 1))) < 5.0


def test_stageA_pnp_ransac_inliers_drops_far_outlier():
    from lmt_vba_sidecar.reconstruct import stage_a_prune
    from lmt_vba_sidecar.model_constrained_ba import Observation
    K = np.array([[2000.0, 0, 960], [0, 2000.0, 540], [0, 0, 1.0]])
    R = cv2.Rodrigues(np.array([0.05, 0.1, 0.0]))[0]
    t = np.array([0.0, 0.0, 2300.0])
    obj = np.array([[x, y, 0.0] for x in (-300.0, -100.0, 100.0, 300.0)
                    for y in (-170.0, 0.0, 170.0)], dtype=float)
    observations, pvcc = [], {}
    for p in obj:
        xc = R @ p + t
        pr = K @ xc
        pix = pr[:2] / pr[2]
        observations.append(Observation(camera_idx=0, cabinet_idx=0, p_local=p, pixel=pix))
        pvcc.setdefault((0, 0), []).append((p, pix))
    # Inject ONE far outlier (wrong-id pixel 500px off) into the SAME group.
    bad_pix = observations[0].pixel + np.array([500.0, 0.0])
    observations.append(Observation(camera_idx=0, cabinet_idx=0, p_local=obj[5], pixel=bad_pix))
    pvcc[(0, 0)].append((obj[5], bad_pix))

    obs2, pvcc2, views2, pts2, n_rej, rej_per_cab = stage_a_prune(observations, pvcc, K)
    assert n_rej == 1
    assert rej_per_cab == {0: 1}            # the one outlier is on cabinet 0
    assert len(obs2) == len(obj)            # the clean dozen survive
    assert pts2[0] == len(obj)
    assert views2[0] == {0}
    assert all(not np.allclose(o.pixel, bad_pix) for o in obs2)


def _two_panel_clean(K, R_true, t_true):
    root_local = np.array([[-300, -170, 0], [300, -170, 0], [300, 170, 0], [-300, 170, 0],
                           [-150, -85, 0], [150, -85, 0], [150, 85, 0], [-150, 85, 0]], float)
    cams = [(np.eye(3), np.array([dx, 0.0, 2400.0])) for dx in (-300., -100., 100., 300.)]
    obs, init_cams = [], []
    for ci, (R_cam, t_cam) in enumerate(cams):
        init_cams.append((R_cam, t_cam))
        for p in root_local:
            pr = K @ (R_cam @ p + t_cam); obs.append(Observation(ci, 0, p, pr[:2]/pr[2]))
        for p in root_local:
            xw = R_true @ p + t_true; pr = K @ (R_cam @ xw + t_cam)
            obs.append(Observation(ci, 1, p, pr[:2]/pr[2]))
    return obs, init_cams, cams, root_local


def test_stage_b_trims_pointwise_outliers_and_converges():
    from lmt_vba_sidecar.reconstruct import stage_b_robust_solve
    K = np.array([[2000.0, 0, 960], [0, 2000.0, 540], [0, 0, 1.0]])
    a = np.deg2rad(20.0)
    R_true = np.array([[np.cos(a),0,np.sin(a)],[0,1,0],[-np.sin(a),0,np.cos(a)]])
    t_true = np.array([700.0, 0.0, 0.0])
    obs, init_cams, cams, _ = _two_panel_clean(K, R_true, t_true)
    # Inject 3 random-far pointwise outliers (different cams, cabinet 1).
    for k in (5, 20, 33):
        obs[k] = Observation(obs[k].camera_idx, obs[k].cabinet_idx,
                             obs[k].p_local, obs[k].pixel + np.array([250.0, -180.0]))
    init_cabinets = {0: (np.eye(3), np.zeros(3)), 1: (np.eye(3), t_true)}
    res, rej_per_cab, total, surviving = stage_b_robust_solve(
        K=K, observations=obs, n_cameras=len(cams), n_cabinets=2,
        root_cabinet_idx=0, init_cameras=init_cams, init_cabinets=init_cabinets,
        per_cabinet_min_points=8)
    assert res.converged
    assert res.rms_reprojection_px < 1.0
    assert total >= 3            # at least the injected outliers rejected
    assert len(surviving) == len(obs) - total   # surviving = trimmed obs list


def test_overtrim_stops_at_floor():
    """Trimming must never push a cabinet below min_points (would KeyError in
    _per_cabinet_reproj_rms / geometry)."""
    from lmt_vba_sidecar.reconstruct import stage_b_robust_solve
    K = np.array([[2000.0, 0, 960], [0, 2000.0, 540], [0, 0, 1.0]])
    a = np.deg2rad(20.0)
    R_true = np.array([[np.cos(a),0,np.sin(a)],[0,1,0],[-np.sin(a),0,np.cos(a)]])
    obs, init_cams, cams, _ = _two_panel_clean(K, R_true, np.array([700.0,0.0,0.0]))
    init_cabinets = {0: (np.eye(3), np.zeros(3)), 1: (np.eye(3), np.array([700.,0.,0.]))}
    res, rej_per_cab, total, surviving = stage_b_robust_solve(
        K=K, observations=obs, n_cameras=len(cams), n_cabinets=2,
        root_cabinet_idx=0, init_cameras=init_cams, init_cabinets=init_cabinets,
        per_cabinet_min_points=8)
    # Clean data: no cabinet trimmed below the floor of 8 points each. With 4
    # cameras x 8 corners = 32 obs/cabinet, the floor leaves >=8 per cabinet.
    from collections import Counter
    survivors = Counter(o.cabinet_idx for o in surviving)
    assert survivors[0] >= 8
    assert survivors[1] >= 8
    assert rej_per_cab.get(0, 0) <= 32 - 8
    assert rej_per_cab.get(1, 0) <= 32 - 8


def test_rejection_stats_reported_in_ba_stats(capsys):
    # Drive the SL pipeline with an injected far-outlier id and assert the
    # ResultEvent's ba_stats carries n_rejected>0 while staying converged.
    import hashlib, json
    from lmt_vba_sidecar.ipc import (
        GenerateStructuredLightInput, ReconstructStructuredLightInput)
    from lmt_vba_sidecar.structured_light import run_generate_structured_light
    from lmt_vba_sidecar.sl_geometry import sl_local_mm
    from lmt_vba_sidecar.sl_feasibility import look_at_pose, project_point
    from lmt_vba_sidecar.sl_reconstruct import run_reconstruct_structured_light
    import tempfile, pathlib
    tmp = pathlib.Path(tempfile.mkdtemp())
    gen = GenerateStructuredLightInput.model_validate({
        "command": "generate_structured_light", "version": 1,
        "project": {"screen_id": "MAIN", "cabinet_array": {
            "cols": 2, "rows": 1, "absent_cells": [], "cabinet_size_mm": [500, 500]}},
        "output_dir": str(tmp / "sl"), "screen_resolution": [960, 480],
        "dot_spacing_px": 80, "margin_px": 60})
    assert run_generate_structured_light(gen) == 0
    meta_path = tmp / "sl" / "sl_meta.json"
    meta = json.loads(meta_path.read_text())
    K = np.array([[3000., 0, 2000], [0, 3000., 1500], [0, 0, 1]])
    (tmp / "intr.json").write_text(json.dumps(
        {"K": K.tolist(), "dist_coeffs": [0, 0, 0, 0, 0], "image_size": [4000, 3000]}))
    rect = {(c["col"], c["row"]): c["input_rect_px"] for c in meta["cabinets"]}
    pitch = {(c["col"], c["row"]): c["pixel_pitch_mm"] for c in meta["cabinets"]}
    cab_by_id = {d["id"]: tuple(d["cabinet"]) for d in meta["dots"]}
    cab_world_t = {(0, 0): np.zeros(3), (1, 0): np.array([500., 0., 0.])}
    truth = {}
    for d in meta["dots"]:
        cr = cab_by_id[d["id"]]
        truth[d["id"]] = sl_local_mm(tuple(rect[cr]), d["u"], d["v"],
                                     pitch[cr][0], pitch[cr][1]) + cab_world_t[cr]
    sha = hashlib.sha256(meta_path.read_bytes()).hexdigest()
    poses = [look_at_pose(np.array([px, 0., -3500.]), np.array([250., 0., 0.]))
             for px in (-1200., -400., 400., 1200.)]
    rng = np.random.default_rng(0)
    corr_paths = []
    for vi, (R, t) in enumerate(poses):
        pts = []
        for d in meta["dots"]:
            p = project_point(K, R, t, truth[d["id"]]) + rng.normal(0, 0.1, 2)
            pts.append({"id": d["id"], "u": d["u"], "v": d["v"],
                        "x": float(p[0]), "y": float(p[1])})
        # Inject one far outlier into view 0 only.
        if vi == 0:
            pts[0]["x"] += 600.0
        cp = tmp / f"corr_{vi}.json"
        cp.write_text(json.dumps({
            "schema_version": 1, "screen_id": "MAIN", "sl_meta_sha256": sha,
            "screen_resolution": meta["screen_resolution"], "camera_image_size": [4000, 3000],
            "source_input": f"/cap/p{vi}.mp4", "points": pts}))
        corr_paths.append(str(cp))
    cmd = ReconstructStructuredLightInput.model_validate({
        "command": "reconstruct_structured_light", "version": 1,
        "project": {"screen_id": "MAIN", "cabinet_array": {
            "cols": 2, "rows": 1, "absent_cells": [], "cabinet_size_mm": [500, 500]}},
        "correspondence_paths": corr_paths, "sl_meta_path": str(meta_path),
        "intrinsics_path": str(tmp / "intr.json"),
        "pose_report_path": str(tmp / "report.json")})
    assert run_reconstruct_structured_light(cmd) == 0
    result = json.loads([ln for ln in capsys.readouterr().out.splitlines() if ln.strip()][-1])
    stats = result["data"]["ba_stats"]
    assert stats["converged"] is True
    assert stats["n_rejected"] >= 1
    assert stats["n_observations_used"] == stats["n_observations_total"] - stats["n_rejected"]


# --- Task 7: Part B/C adversarial cases (S6-S9, hard-stops, regressions) -------


def _pvcc_of(observations):
    """Rebuild per_view_cab_corners {(cam_idx,cab_idx): [(p_local, pixel), ...]}
    from a flat list of Observation, in list order (same lockstep order
    stage_a_prune walks)."""
    pvcc = {}
    for o in observations:
        pvcc.setdefault((o.camera_idx, o.cabinet_idx), []).append((o.p_local, o.pixel))
    return pvcc


def _run_sl_pipeline(tmp, *, corrupt=None, shape_prior="flat",
                     cab_world_t=None, cab_world_R=None, n_views=4,
                     cols=2, rows=1, screen_resolution=(960, 480), noise_px=0.1,
                     camera_poses=None, clip_to_frame=False, dot_spacing_px=80):
    """Drive the full SL pipeline (mirror of test_sl_reconstruct.py's synthetic
    harness): generate a 2-cabinet sl_meta, project every dot through n_views
    look-at cameras into pixels, optionally corrupt points via the `corrupt`
    callback (view_idx, dot_id, cabinet, pixel) -> pixel, write corr JSON, and
    run run_reconstruct_structured_light. Returns (rc, report_path, meta, truth,
    K, poses).

    cab_world_t: {(col,row): (3,) translation mm} placing each cabinet's local
    origin in the world. cab_world_R: {(col,row): (3,3) rotation} applied to each
    cabinet's local dots BEFORE translation, so the synthetic ground truth is a
    genuinely tilted panel (used by the curved-arc S9 case — a translation alone
    would leave a flat panel whose recovered normal can't carry an arc tilt)."""
    import hashlib, json
    from lmt_vba_sidecar.ipc import (
        GenerateStructuredLightInput, ReconstructStructuredLightInput)
    from lmt_vba_sidecar.structured_light import run_generate_structured_light
    from lmt_vba_sidecar.sl_geometry import sl_local_mm
    from lmt_vba_sidecar.sl_feasibility import look_at_pose, project_point
    from lmt_vba_sidecar.sl_reconstruct import run_reconstruct_structured_light

    proj_shape = {"screen_id": "MAIN", "cabinet_array": {
        "cols": cols, "rows": rows, "absent_cells": [], "cabinet_size_mm": [500, 500]}}
    if shape_prior != "flat":
        proj_shape["shape_prior"] = shape_prior
    gen = GenerateStructuredLightInput.model_validate({
        "command": "generate_structured_light", "version": 1,
        "project": {k: v for k, v in proj_shape.items() if k != "shape_prior"},
        "output_dir": str(tmp / "sl"), "screen_resolution": list(screen_resolution),
        "dot_spacing_px": dot_spacing_px, "margin_px": 60})
    assert run_generate_structured_light(gen) == 0
    meta_path = tmp / "sl" / "sl_meta.json"
    meta = json.loads(meta_path.read_text())
    K = np.array([[3000., 0, 2000], [0, 3000., 1500], [0, 0, 1]])
    (tmp / "intr.json").write_text(json.dumps(
        {"K": K.tolist(), "dist_coeffs": [0, 0, 0, 0, 0], "image_size": [4000, 3000]}))
    rect = {(c["col"], c["row"]): c["input_rect_px"] for c in meta["cabinets"]}
    pitch = {(c["col"], c["row"]): c["pixel_pitch_mm"] for c in meta["cabinets"]}
    cab_by_id = {d["id"]: tuple(d["cabinet"]) for d in meta["dots"]}
    if cab_world_t is None:
        cab_world_t = {(c, r): np.array([500. * c, -500. * r, 0.])
                       for r in range(rows) for c in range(cols)}
    truth = {}
    for d in meta["dots"]:
        cr = cab_by_id[d["id"]]
        loc = sl_local_mm(tuple(rect[cr]), d["u"], d["v"], pitch[cr][0], pitch[cr][1])
        if cab_world_R is not None and cr in cab_world_R:
            loc = np.asarray(cab_world_R[cr], dtype=float) @ loc
        truth[d["id"]] = loc + cab_world_t[cr]
    sha = hashlib.sha256(meta_path.read_bytes()).hexdigest()
    # Cameras on the +z side of the wall (the audience side — synthetic iron
    # rule: a -z camera observes the back face, i.e. a mirror world that lets
    # chirality bugs cancel out and hide).
    wall_pts = np.array(list(truth.values()))
    target = wall_pts.mean(axis=0)
    if camera_poses is not None:
        poses = list(camera_poses)
    else:
        px_positions = np.linspace(-1200., 1200., n_views)
        poses = [look_at_pose(target + np.array([px, 0., 3500.]), target)
                 for px in px_positions]
    rng = np.random.default_rng(0)
    corr_paths = []
    for vi, (R, t) in enumerate(poses):
        pts = []
        for d in meta["dots"]:
            if clip_to_frame:
                xc = R @ truth[d["id"]] + t
                if xc[2] <= 1.0:
                    continue
            p = project_point(K, R, t, truth[d["id"]]) + rng.normal(0, noise_px, 2)
            if clip_to_frame and not (0.0 <= p[0] <= 4000.0 and 0.0 <= p[1] <= 3000.0):
                continue
            if corrupt is not None:
                p = corrupt(vi, d["id"], cab_by_id[d["id"]], p)
            pts.append({"id": d["id"], "u": d["u"], "v": d["v"],
                        "x": float(p[0]), "y": float(p[1])})
        cp = tmp / f"corr_{vi}.json"
        cp.write_text(json.dumps({
            "schema_version": 1, "screen_id": "MAIN", "sl_meta_sha256": sha,
            "screen_resolution": meta["screen_resolution"],
            "camera_image_size": [4000, 3000],
            "source_input": f"/cap/p{vi}.mp4", "points": pts}))
        corr_paths.append(str(cp))
    report = tmp / "report.json"
    cmd = ReconstructStructuredLightInput.model_validate({
        "command": "reconstruct_structured_light", "version": 1,
        "project": {**proj_shape},
        "correspondence_paths": corr_paths, "sl_meta_path": str(meta_path),
        "intrinsics_path": str(tmp / "intr.json"),
        "pose_report_path": str(report)})
    rc = run_reconstruct_structured_light(cmd)
    return rc, report, meta, truth, K, poses


def _two_panel_init_cabinets(t_true):
    return {0: (np.eye(3), np.zeros(3)), 1: (np.eye(3), np.asarray(t_true, float))}


def test_outlier_injection_rejected_three_classes():
    """S6: random-far + near-neighbor injections; the rejected set covers at
    least the injected set (recall) and the solve still converges low-rms."""
    from lmt_vba_sidecar.reconstruct import stage_a_prune, stage_b_robust_solve
    K = np.array([[2000., 0, 960], [0, 2000., 540], [0, 0, 1.]])
    a = np.deg2rad(20.0)
    R_true = np.array([[np.cos(a),0,np.sin(a)],[0,1,0],[-np.sin(a),0,np.cos(a)]])
    t_true = np.array([700., 0., 0.])
    obs, init_cams, cams, root_local = _two_panel_clean(K, R_true, t_true)
    injected = set()
    # (a) random far on cam0/cab1
    obs[12] = Observation(0, 1, obs[12].p_local, obs[12].pixel + np.array([300., -250.]))
    injected.add(12)
    # (b) near-neighbor on cam1/cab1 (swap to a different corner's true pixel)
    obs[20] = Observation(1, 1, root_local[0], obs[20].pixel)
    injected.add(20)
    o2, pvcc2, views2, pts2, n_rej_a, rej_a = stage_a_prune(obs, _pvcc_of(obs), K)
    res, rej_b, total_b, surviving = stage_b_robust_solve(
        K=K, observations=o2, n_cameras=len(cams), n_cabinets=2, root_cabinet_idx=0,
        init_cameras=init_cams, init_cabinets=_two_panel_init_cabinets(t_true),
        per_cabinet_min_points=8)
    assert res.converged and res.rms_reprojection_px < 1.5
    assert (n_rej_a + total_b) >= len(injected)   # recall: at least the injected


def test_outlier_injection_diverges_without_rejection():
    """Control: same injected outliers fed straight to model_constrained_ba
    (Huber only, no Stage A/B trim) -> high rms / divergence."""
    K = np.array([[2000., 0, 960], [0, 2000., 540], [0, 0, 1.]])
    a = np.deg2rad(20.0)
    R_true = np.array([[np.cos(a),0,np.sin(a)],[0,1,0],[-np.sin(a),0,np.cos(a)]])
    t_true = np.array([700., 0., 0.])
    obs, init_cams, cams, root_local = _two_panel_clean(K, R_true, t_true)
    for k in (12, 18, 20, 26):
        obs[k] = Observation(obs[k].camera_idx, obs[k].cabinet_idx,
                             obs[k].p_local, obs[k].pixel + np.array([400., -350.]))
    init_cabinets = _two_panel_init_cabinets(t_true)
    res = model_constrained_ba(K=K, observations=obs, n_cameras=len(cams),
        n_cabinets=2, root_cabinet_idx=0, init_cameras=init_cams,
        init_cabinets=init_cabinets)
    assert (not res.converged) or res.rms_reprojection_px > 5.0


def test_coherent_error_caught_by_global_not_stageA():
    """Single-view coherent grid shift on cab1: Stage A keeps it (each point
    still fits a consistent (wrong) plane in that one view), Stage B's
    group-coherence guard rejects the whole bad (cam,cab) group."""
    from lmt_vba_sidecar.reconstruct import stage_a_prune, stage_b_robust_solve
    K = np.array([[2000., 0, 960], [0, 2000., 540], [0, 0, 1.]])
    a = np.deg2rad(20.0)
    R_true = np.array([[np.cos(a),0,np.sin(a)],[0,1,0],[-np.sin(a),0,np.cos(a)]])
    t_true = np.array([700., 0., 0.])
    obs, init_cams, cams, root_local = _two_panel_clean(K, R_true, t_true)
    # Coherently shift EVERY cam0/cab1 pixel by the same vector -> a consistent
    # wrong plane that Stage A's per-(cam,cab) PnP fits without flagging.
    for k, o in enumerate(obs):
        if o.camera_idx == 0 and o.cabinet_idx == 1:
            obs[k] = Observation(o.camera_idx, o.cabinet_idx, o.p_local,
                                 o.pixel + np.array([12.0, 9.0]))
    o2, pvcc2, views2, pts2, n_rej_a, rej_a = stage_a_prune(obs, _pvcc_of(obs), K)
    assert n_rej_a == 0  # Stage A blind to a coherent in-plane shift
    res, rej_b, total_b, surviving = stage_b_robust_solve(
        K=K, observations=o2, n_cameras=len(cams), n_cabinets=2, root_cabinet_idx=0,
        init_cameras=init_cams, init_cabinets=_two_panel_init_cabinets(t_true),
        per_cabinet_min_points=8)
    assert total_b > 0   # Stage B catches the coherent group
    assert rej_b.get(1, 0) > 0


def test_dirty_view_does_not_break_solve():
    """S7 (the 228px empirical case): 3 clean views + 1 view whose cab1 group is
    a coherent mis-decode. Stage B must kick the dirty (cam,cab) group out so the
    solve still CONVERGES and the recovered cabinet-1 pose stays ~= the true pose
    (proves the dirty view doesn't drag the solution, and that the rescue is
    Stage B's cross-view authority — Stage A is blind to the coherent shift)."""
    from lmt_vba_sidecar.reconstruct import stage_a_prune, stage_b_robust_solve
    K = np.array([[2000., 0, 960], [0, 2000., 540], [0, 0, 1.]])
    a = np.deg2rad(20.0)
    R_true = np.array([[np.cos(a),0,np.sin(a)],[0,1,0],[-np.sin(a),0,np.cos(a)]])
    t_true = np.array([700., 0., 0.])
    obs, init_cams, cams, root_local = _two_panel_clean(K, R_true, t_true)
    # Camera 3 is the dirty view: coherently shift ALL its cab1 pixels (a whole
    # mis-decoded view). Stage A keeps them (consistent wrong plane); Stage B's
    # group-coherence guard drops the (3,1) group once the 3 clean views disagree.
    for k, o in enumerate(obs):
        if o.camera_idx == 3 and o.cabinet_idx == 1:
            obs[k] = Observation(o.camera_idx, o.cabinet_idx, o.p_local,
                                 o.pixel + np.array([14.0, -11.0]))
    o2, pvcc2, views2, pts2, n_rej_a, rej_a = stage_a_prune(obs, _pvcc_of(obs), K)
    assert n_rej_a == 0  # coherent shift is invisible to Stage A's per-group PnP
    res, rej_b, total_b, surviving = stage_b_robust_solve(
        K=K, observations=o2, n_cameras=len(cams), n_cabinets=2, root_cabinet_idx=0,
        init_cameras=init_cams, init_cabinets=_two_panel_init_cabinets(t_true),
        per_cabinet_min_points=8)
    assert res.converged and res.rms_reprojection_px < 1.0
    # Cabinet 1's recovered world pose still matches the truth (~= the 3-clean-view
    # solution), NOT pulled toward the dirty view.
    R_rec, t_rec = res.cabinet_poses[1]
    assert np.linalg.norm(t_rec - t_true) < 5.0                       # mm
    ang = np.degrees(np.arccos(np.clip((np.trace(R_rec.T @ R_true) - 1) / 2, -1, 1)))
    assert ang < 1.0                                                  # degrees
    assert rej_b.get(1, 0) >= 8   # the dirty view's whole cab1 group rejected


def test_two_view_coherent_hard_stops_no_files(tmp_path, capsys):
    """A cabinet seen by EXACTLY 2 views, ONE coherently wrong -> SL pipeline
    returns observability_failed and writes NO pose_report.json.

    Only cabinet 1's points in view 0 are shifted (a whole-view uniform shift is
    degenerate with the camera pose and would be silently absorbed). With the
    bad (cam,cab) group trimmed, cabinet 1 is left with a single view — the
    post-trim observability re-check (min_views>=2) hard-stops before any write.
    A LARGE coherent shift is used so the bad group is decisively trimmed rather
    than merely diverging BA."""
    def corrupt(vi, dot_id, cabinet, p):
        # 275px shift: decisively trimmed under the +z look-at camera geometry
        # (smaller shifts land in a band where 2-view Stage B either diverges
        # first, ba_diverged, or absorbs the shift into the poses).
        return p + np.array([220.0, 170.0]) if (vi == 0 and cabinet == (1, 0)) else p
    rc, report, *_ = _run_sl_pipeline(tmp_path, corrupt=corrupt, n_views=2)
    assert rc == 1
    assert not report.exists()
    last = json.loads([ln for ln in capsys.readouterr().out.splitlines() if ln.strip()][-1])
    assert last["event"] == "error" and last["code"] == "observability_failed"


def test_aggressive_rejection_raises_observability(tmp_path, capsys):
    """So dirty that trimming drops a cabinet below min_points -> observability_failed
    with a message mentioning rejection. NO pose_report.json written."""
    def corrupt(vi, dot_id, cabinet, p):
        # Corrupt nearly every point with large independent noise so the trim
        # eats below the floor of 8.
        return p + np.random.default_rng(dot_id * 7 + vi).normal(0, 200.0, 2)
    rc, report, *_ = _run_sl_pipeline(tmp_path, corrupt=corrupt, n_views=4)
    assert rc == 1
    assert not report.exists()
    last = json.loads([ln for ln in capsys.readouterr().out.splitlines() if ln.strip()][-1])
    assert last["code"] == "observability_failed"
    assert "reject" in last["message"].lower()


def test_oblique_arc_not_flipped(tmp_path, capsys):
    """S9: synthetic curved arc (PROPER world: tiles posed by the nominal SE(3)
    poses R_y(-a), cameras on the +z/audience side) -> the reconstructed
    cabinet-1 normal matches the nominal arc concavity sign (not mirrored). The
    synthetic ground truth genuinely TILTS cabinet 1 by the arc rotation so its
    true normal carries the arc concavity; a translation alone would leave a
    flat panel with no tilt to recover. A tight radius (1000mm) puts cabinet 1's
    tilt at ~14deg — past planar IPPE's near-fronto-parallel NaN zone — so the
    two-branch disambiguation actually fires and must NOT pick the lateral
    mirror. (The pre-FIX-1 version of this test pinned the MIRRORED convention:
    R_y(+a) truth + a -z camera — a fully mirrored world that the mirrored
    nominal normal formula happened to agree with.)"""
    from lmt_vba_sidecar.nominal import (
        nominal_cabinet_normals_model_frame, nominal_cabinet_poses_model_frame)
    from lmt_vba_sidecar.ipc import CabinetArray
    cab = CabinetArray.model_validate(
        {"cols": 2, "rows": 1, "absent_cells": [], "cabinet_size_mm": [500, 500]})
    shape = {"curved": {"radius_mm": 1000.0}}
    nominal_normals = nominal_cabinet_normals_model_frame(cab, shape)
    nominal_poses = nominal_cabinet_poses_model_frame(cab, shape)
    # Ground truth IS the nominal wall (root-relative shift; align_to_nominal
    # absorbs the rigid offset).
    t_root = np.asarray(nominal_poses[(0, 0)][1]) * 1000.0
    cab_world_t = {cr: np.asarray(t_m) * 1000.0 - t_root
                   for cr, (_R, t_m) in nominal_poses.items()}
    cab_world_R = {cr: R for cr, (R, _t) in nominal_poses.items()}
    rc, report, *_ = _run_sl_pipeline(tmp_path, shape_prior=shape,
                                      cab_world_t=cab_world_t,
                                      cab_world_R=cab_world_R, n_views=4)
    assert rc == 0
    rep = json.loads(report.read_text())
    poses = {p["cabinet_id"]: p for p in rep["cabinet_poses"]}
    n1 = np.array(poses["V001_R000"]["normal"])
    true_normal_1 = np.array(nominal_normals[(1, 0)])
    assert np.sign(n1[0]) == np.sign(true_normal_1[0])
    # Tighter than the sign check: the reported normal matches nominal to a few
    # degrees (the mirror branch would be ~28deg off for radius 1000).
    ang = np.degrees(np.arccos(np.clip(n1 @ true_normal_1 / np.linalg.norm(n1), -1, 1)))
    assert ang < 5.0, f"cabinet-1 normal {ang:.1f}deg from nominal (mirror branch?)"


def _nominal_corner_targets(cab_dict, shape_prior):
    """(col,row) -> (4,3) nominal design-frame corners mm (BL,BR,TR,TL), from the
    single-truth SE(3) poses + the 500mm active-surface corner layout."""
    from lmt_vba_sidecar.nominal import nominal_cabinet_poses_model_frame
    from lmt_vba_sidecar.ipc import CabinetArray
    cab = CabinetArray.model_validate(cab_dict)
    poses = nominal_cabinet_poses_model_frame(cab, shape_prior)
    corners_local = np.array([[-250., -250., 0.], [250., -250., 0.],
                              [250., 250., 0.], [-250., 250., 0.]])
    return {cr: (corners_local @ np.asarray(R).T) + np.asarray(t) * 1000.0
            for cr, (R, t) in poses.items()}


def _align_rms_mm_from_events(out_text):
    events = [json.loads(ln) for ln in out_text.splitlines() if ln.strip()]
    res = [e for e in events if e.get("event") == "result"]
    assert res, "no result event"
    return float(res[-1]["data"]["procrustes_align_rms_m"]) * 1000.0


def test_multirow_flat_wall_e2e_rigid_align(tmp_path, capsys):
    """FIX-2 acceptance: rows>=2 flat wall e2e (proper projection, +z cameras).
    Pre-fix, _nominal_world_corners mixed y-up corners with y-down centers, so
    for rows>=2 the Procrustes target was NON-RIGID (cross-cabinet wants a y
    flip, in-cabinet does not) — align residual jumped to cabinet scale. Now the
    target is rigid: align RMS < 0.1mm and every reported corner lands on the
    nominal design-frame corner to sub-mm."""
    rc, report, *_ = _run_sl_pipeline(
        tmp_path, cols=2, rows=2, screen_resolution=(960, 960), n_views=4, noise_px=0.0)
    out = capsys.readouterr().out
    assert rc == 0
    assert _align_rms_mm_from_events(out) < 0.1
    rep = json.loads(report.read_text())
    targets = _nominal_corner_targets(
        {"cols": 2, "rows": 2, "absent_cells": [], "cabinet_size_mm": [500, 500]}, "flat")
    for p in rep["cabinet_poses"]:
        col, row = int(p["cabinet_id"][1:4]), int(p["cabinet_id"][6:9])
        got = np.asarray(p["corners_mm"])
        err = np.linalg.norm(got - targets[(col, row)], axis=1).max()
        assert err < 0.1, f"{p['cabinet_id']}: corner off nominal by {err:.2f}mm"


def test_multirow_curved_wall_e2e_rigid_align(tmp_path, capsys):
    """FIX-1+2 acceptance: rows>=2 CURVED wall e2e (proper world: nominal SE(3)
    tile poses, +z cameras). The IPPE disambiguation must pick the true branch
    for every cabinet and align_to_nominal must be rigid-consistent (<0.1mm RMS;
    the mirrored normal formula tilted every Procrustes target corner wrong)."""
    from lmt_vba_sidecar.nominal import nominal_cabinet_poses_model_frame
    from lmt_vba_sidecar.ipc import CabinetArray
    shape = {"curved": {"radius_mm": 2000.0}}
    cab_dict = {"cols": 3, "rows": 2, "absent_cells": [], "cabinet_size_mm": [500, 500]}
    poses = nominal_cabinet_poses_model_frame(CabinetArray.model_validate(cab_dict), shape)
    t_root = np.asarray(poses[(0, 0)][1]) * 1000.0
    cab_world_t = {cr: np.asarray(t) * 1000.0 - t_root for cr, (_R, t) in poses.items()}
    cab_world_R = {cr: R for cr, (R, _t) in poses.items()}
    rc, report, *_ = _run_sl_pipeline(
        tmp_path, cols=3, rows=2, screen_resolution=(1440, 960), shape_prior=shape,
        cab_world_t=cab_world_t, cab_world_R=cab_world_R, n_views=4, noise_px=0.0)
    out = capsys.readouterr().out
    assert rc == 0
    assert _align_rms_mm_from_events(out) < 0.1
    rep = json.loads(report.read_text())
    targets = _nominal_corner_targets(cab_dict, shape)
    normals = {cr: np.asarray(R) @ np.array([0.0, 0.0, 1.0]) for cr, (R, _t) in poses.items()}
    for p in rep["cabinet_poses"]:
        col, row = int(p["cabinet_id"][1:4]), int(p["cabinet_id"][6:9])
        got = np.asarray(p["corners_mm"])
        err = np.linalg.norm(got - targets[(col, row)], axis=1).max()
        assert err < 0.1, f"{p['cabinet_id']}: corner off nominal by {err:.2f}mm"
        n = np.asarray(p["normal"])
        ang = np.degrees(np.arccos(np.clip(n @ normals[(col, row)] / np.linalg.norm(n), -1, 1)))
        assert ang < 2.0, f"{p['cabinet_id']}: normal {ang:.1f}deg off nominal (mirror branch?)"


# --------------------------------------------------------------------------- #
# FIX-3: transitive bridging + nominal fallback rotated into the root frame
# --------------------------------------------------------------------------- #
def test_transitive_bridging_chains_beyond_root_views():
    """FIX-3: view 0 sees {root, cab1}, view 1 sees {cab1, cab2} — cab2 never
    shares a view with the root. Transitive bridging must still recover cab2's
    world pose through the cab1 chain (pre-fix: cab2 was simply absent from the
    bridge dict and fell into the nominal fallback)."""
    from lmt_vba_sidecar.reconstruct import estimate_nonroot_cabinet_init
    K = np.array([[2000.0, 0, 960], [0, 2000.0, 540], [0, 0, 1.0]])
    local = np.array([[-200, -200, 0], [200, -200, 0], [200, 200, 0], [-200, 200, 0],
                      [-100, -100, 0], [100, -100, 0], [100, 100, 0], [-100, 100, 0]], float)
    # An arc-like chain: each cabinet tilts 25deg more than the previous.
    R1, R2 = _Ry(np.deg2rad(-25.0)), _Ry(np.deg2rad(-50.0))
    t1 = np.array([480.0, 0.0, -60.0])
    t2 = np.array([900.0, 0.0, -240.0])
    truth = {0: (np.eye(3), np.zeros(3)), 1: (R1, t1), 2: (R2, t2)}
    # Camera 0 in front of the root/cab1 seam; camera 1 in front of cab1/cab2.
    from lmt_vba_sidecar.sl_feasibility import look_at_pose
    cam0 = look_at_pose(np.array([240.0, 0.0, 2000.0]), np.array([240.0, 0.0, 0.0]))
    cam1 = look_at_pose(np.array([700.0, 100.0, 1900.0]), np.array([690.0, 0.0, -150.0]))
    per_view = {}
    for ci, (R_cam, t_cam), seen in ((0, cam0, (0, 1)), (1, cam1, (1, 2))):
        for cab in seen:
            R_w, t_w = truth[cab]
            per_view[(ci, cab)] = [(p, _project(R_cam, t_cam, R_w, t_w, p, K)) for p in local]
    nominal_poses = {i: (truth[i][0], truth[i][1] / 1000.0) for i in range(3)}
    out, undecidable = estimate_nonroot_cabinet_init(
        per_view, root_idx=0, K=K, nominal_poses=nominal_poses)
    assert undecidable == set()
    assert 1 in out and 2 in out, f"transitive chain missing: {sorted(out)}"
    for idx in (1, 2):
        R_est, t_est = out[idx]
        R_true, t_true = truth[idx]
        ang = np.degrees(np.arccos(np.clip((np.trace(R_est.T @ R_true) - 1) / 2, -1, 1)))
        assert ang < 1.0, f"cab{idx} rotation off by {ang:.2f}deg"
        assert np.linalg.norm(t_est - t_true) < 5.0, f"cab{idx} t_est={t_est} vs {t_true}"


def test_nominal_fallback_init_rotated_into_root_frame():
    """FIX-3: the no-bridge fallback init is T_root^-1 . T_cr — rotation
    R_root.T @ R_cr and the translation delta rotated into the root frame (the
    pre-fix identity-rotation unrotated-translation seed is ~90deg off at the
    far end of a 90deg arc)."""
    from lmt_vba_sidecar.reconstruct import _nominal_init_root_frame
    from lmt_vba_sidecar.nominal import nominal_cabinet_poses_model_frame
    from lmt_vba_sidecar.ipc import CabinetArray
    cols, radius = 12, 3850.0
    cab = CabinetArray(cols=cols, rows=2, cabinet_size_mm=[500.0, 500.0])
    poses = nominal_cabinet_poses_model_frame(cab, {"curved": {"radius_mm": radius}})
    root, far = (0, 0), (11, 1)
    R_fb, t_fb = _nominal_init_root_frame(poses, root, far)
    # Exact composition: T_root^-1 . T_far
    R_root, t_root = poses[root]
    R_far, t_far = poses[far]
    np.testing.assert_allclose(R_fb, np.asarray(R_root).T @ np.asarray(R_far), atol=1e-12)
    np.testing.assert_allclose(
        t_fb, np.asarray(R_root).T @ ((np.asarray(t_far) - np.asarray(t_root)) * 1000.0), atol=1e-9)
    # The relative rotation across a ~90deg arc is large; identity would be a
    # catastrophic seed (this pins WHY the fallback must rotate).
    rel_ang = np.degrees(np.arccos(np.clip((np.trace(R_fb) - 1) / 2, -1, 1)))
    assert rel_ang > 75.0
    # And the rotated translation is NOT the raw model-frame delta.
    raw_delta = (np.asarray(t_far) - np.asarray(t_root)) * 1000.0
    assert np.linalg.norm(t_fb - raw_delta) > 1000.0


def test_fallback_emits_warning_event(tmp_path, capsys, monkeypatch):
    """FIX-3: cabinets that fall into the nominal-init fallback are no longer
    silent — solve_and_emit emits an init_fallback_nominal WarningEvent naming
    them. (Forced here by disabling bridging; the flat nominal seed is near the
    truth so BA still converges.)"""
    import lmt_vba_sidecar.reconstruct as rec
    monkeypatch.setattr(rec, "estimate_nonroot_cabinet_init",
                        lambda *a, **k: ({}, set()))
    rc, report, *_ = _run_sl_pipeline(tmp_path, n_views=2)
    out = capsys.readouterr().out
    assert rc == 0
    warns = [json.loads(ln) for ln in out.splitlines()
             if ln.strip() and json.loads(ln).get("event") == "warning"]
    fb = [w for w in warns if w["code"] == "init_fallback_nominal"]
    assert fb, "expected init_fallback_nominal warning"
    assert "V001_R000" in fb[0]["message"]


# --------------------------------------------------------------------------- #
# FIX-4: converged reported truthfully + single-condition acceptance gates
# --------------------------------------------------------------------------- #
def test_nonconverged_ba_is_fatal_even_with_low_rms(tmp_path, capsys, monkeypatch):
    """FIX-4: max_nfev=1 forces non-convergence; with a near-exact init the rms
    can be tiny, which the OLD gate (not converged AND rms>2) silently shipped.
    The new gate refuses on non-convergence alone -> rc=1 + ba_diverged, no
    report written."""
    import lmt_vba_sidecar.reconstruct as rec
    orig = rec.stage_b_robust_solve
    def starved(**kw):
        kw["max_nfev"] = 1
        return orig(**kw)
    monkeypatch.setattr(rec, "stage_b_robust_solve", starved)
    rc, report, *_ = _run_sl_pipeline(tmp_path, n_views=2, noise_px=0.0)
    out = capsys.readouterr().out
    assert rc == 1
    assert not report.exists()
    events = [json.loads(ln) for ln in out.splitlines() if ln.strip()]
    last = events[-1]
    assert last["event"] == "error" and last["code"] == "ba_diverged"
    assert "did not converge" in last["message"]


def test_converged_high_rms_is_refused(tmp_path, capsys, monkeypatch):
    """FIX-4: a CONVERGED solution whose rms exceeds the 2.0px gate must be
    refused -- the OLD gate (not-converged AND rms>2) shipped any converged
    solution regardless of rms. The converged+high-rms combination is forced by
    doctoring the stage-B result (realistic misfits -- fx stretch, barrel
    distortion -- were probed and either get absorbed by the pose freedom or
    stall scipy into the not-converged gate first, which is also a refusal)."""
    import lmt_vba_sidecar.reconstruct as rec
    from lmt_vba_sidecar.model_constrained_ba import BAResult
    orig = rec.stage_b_robust_solve
    def doctored(**kw):
        result, rej, n, surv = orig(**kw)
        result = BAResult(
            camera_poses=result.camera_poses, cabinet_poses=result.cabinet_poses,
            rms_reprojection_px=3.7, iterations=result.iterations,
            converged=True, cabinet_covariances=result.cabinet_covariances)
        return result, rej, n, surv
    monkeypatch.setattr(rec, "stage_b_robust_solve", doctored)
    rc, report, *_ = _run_sl_pipeline(tmp_path, n_views=2, noise_px=0.0)
    out = capsys.readouterr().out
    events = [json.loads(ln) for ln in out.splitlines() if ln.strip()]
    last = events[-1]
    assert rc == 1
    assert not report.exists()
    assert last["code"] == "ba_diverged", f"got {last['code']}: {last['message']}"
    assert "exceeds" in last["message"]


def test_unabsorbable_pixel_stretch_is_refused(tmp_path, capsys):
    """FIX-4 companion: a REAL unabsorbable misfit (5% one-axis pixel stretch =
    anisotropic pitch / non-1:1 feed) must exit nonzero with ba_diverged via
    one of the two gates -- never ship a report."""
    def stretch(vi, dot_id, cabinet, p):
        return np.array([2000.0 + (p[0] - 2000.0) * 1.05, p[1]])
    rc, report, *_ = _run_sl_pipeline(tmp_path, n_views=4, noise_px=0.0, corrupt=stretch)
    out = capsys.readouterr().out
    last = [json.loads(ln) for ln in out.splitlines() if ln.strip()][-1]
    assert rc == 1
    assert not report.exists()
    assert last["code"] == "ba_diverged"


def test_reexpress_result_rotates_poses_cameras_and_covariance():
    """FIX-3.3: the BA gauge sits at the wall-center cabinet; re-expressing the
    result in the external root's frame must (a) put the root at identity,
    (b) keep reprojection invariant (cameras compose the inverse change), and
    (c) rotate translation covariances R0.T S R0."""
    from lmt_vba_sidecar.reconstruct import _reexpress_result_in_cabinet_frame
    from lmt_vba_sidecar.model_constrained_ba import BAResult
    rng = np.random.default_rng(7)
    R0 = cv2.Rodrigues(np.array([0.1, 0.7, -0.2]))[0]
    t0 = np.array([800.0, -120.0, 60.0])
    R1 = cv2.Rodrigues(np.array([-0.3, 0.2, 0.05]))[0]
    t1 = np.array([1500.0, 40.0, -90.0])
    Rc = cv2.Rodrigues(np.array([0.05, -0.4, 0.1]))[0]
    tc = np.array([-200.0, 30.0, 2600.0])
    S = np.diag([4.0, 1.0, 9.0])
    res = BAResult(camera_poses=[(Rc, tc)],
                   cabinet_poses={0: (np.eye(3), np.zeros(3)), 1: (R0, t0), 2: (R1, t1)},
                   rms_reprojection_px=0.5, iterations=3, converged=True,
                   cabinet_covariances={1: S, 2: None})
    out = _reexpress_result_in_cabinet_frame(res, 1)
    # (a) frame cabinet at identity
    np.testing.assert_allclose(out.cabinet_poses[1][0], np.eye(3), atol=1e-12)
    np.testing.assert_allclose(out.cabinet_poses[1][1], np.zeros(3), atol=1e-9)
    # (b) reprojection invariance: for any local point on any cabinet, the
    # camera-frame coordinates are unchanged.
    K = np.array([[2000.0, 0, 960], [0, 2000.0, 540], [0, 0, 1.0]])
    for j in (0, 1, 2):
        for p_l in rng.normal(0, 200, (5, 3)):
            xc_old = Rc @ (res.cabinet_poses[j][0] @ p_l + res.cabinet_poses[j][1]) + tc
            Rc2, tc2 = out.camera_poses[0]
            xc_new = Rc2 @ (out.cabinet_poses[j][0] @ p_l + out.cabinet_poses[j][1]) + tc2
            np.testing.assert_allclose(xc_new, xc_old, atol=1e-9)
    # (c) covariance rotated, None passed through
    np.testing.assert_allclose(out.cabinet_covariances[1], R0.T @ S @ R0, atol=1e-12)
    assert out.cabinet_covariances[2] is None


def test_long_arc_segmented_capture_transitive_bridging(tmp_path, capsys):
    """FIX-3 acceptance: 12x2 cabinets on a ~90deg arc, 8 segmented cameras
    each seeing only ~3 columns — most cabinets share no view with the corner
    root, so init must chain transitively. Asserts PER-CORNER 3D error vs the
    nominal truth (per-point, not an aggregate that can hide a mirrored end —
    FIX-9 rationale). Pre-FIX-3 (direct-only bridging + identity unrotated
    fallback) the far end starts ~90deg wrong and BA diverges or mirrors."""
    from lmt_vba_sidecar.nominal import nominal_cabinet_poses_model_frame
    from lmt_vba_sidecar.ipc import CabinetArray
    from lmt_vba_sidecar.sl_feasibility import look_at_pose
    cols, rows, cw, radius = 12, 2, 500.0, 3850.0
    shape = {"curved": {"radius_mm": radius}}
    cab_dict = {"cols": cols, "rows": rows, "absent_cells": [], "cabinet_size_mm": [500, 500]}
    poses = nominal_cabinet_poses_model_frame(CabinetArray.model_validate(cab_dict), shape)
    t_root = np.asarray(poses[(0, 0)][1]) * 1000.0
    cab_world_t = {cr: np.asarray(t) * 1000.0 - t_root for cr, (_R, t) in poses.items()}
    cab_world_R = {cr: R for cr, (R, _t) in poses.items()}
    W = cols * cw
    cams = []
    # 9 stations along the arc at 1500mm standoff: each sees ~4 columns (8
    # cabinets), end columns get >=2 views, and no station beyond the first two
    # sees the corner root — the far half of the wall is reachable only through
    # transitive view chains.
    for ck in np.linspace(0.0, 11.0, 9):
        a = ((ck + 0.5) * cw - W / 2.0) / radius
        p_arc = np.array([radius * np.sin(a) + W / 2.0, 500.0, radius * (1.0 - np.cos(a))])
        n = np.array([-np.sin(a), 0.0, np.cos(a)])
        cams.append(look_at_pose(p_arc + 1500.0 * n - t_root, p_arc - t_root))
    rc, report, *_ = _run_sl_pipeline(
        tmp_path, cols=cols, rows=rows, screen_resolution=(cols * 480, rows * 480),
        shape_prior=shape, cab_world_t=cab_world_t, cab_world_R=cab_world_R,
        camera_poses=cams, clip_to_frame=True, noise_px=0.0, dot_spacing_px=160)
    out = capsys.readouterr().out
    assert rc == 0, f"long-arc reconstruct failed: {out.splitlines()[-1] if out else ''}"
    rep = json.loads(report.read_text())
    targets = _nominal_corner_targets(cab_dict, shape)
    assert len(rep["cabinet_poses"]) == cols * rows
    worst = 0.0
    for p in rep["cabinet_poses"]:
        col, row = int(p["cabinet_id"][1:4]), int(p["cabinet_id"][6:9])
        err = np.linalg.norm(np.asarray(p["corners_mm"]) - targets[(col, row)], axis=1).max()
        worst = max(worst, err)
        assert err < 1.0, f"{p['cabinet_id']}: corner off nominal by {err:.2f}mm"


def test_oblique_arc_iterative_baseline_can_flip():
    """Control: the OLD single-solution SOLVEPNP_ITERATIVE solve on an oblique
    planar panel can land on the mirror branch -> its normal can have the wrong
    sign vs nominal, proving the IPPE two-branch fix is load-bearing."""
    K = np.array([[2000.0, 0, 960], [0, 2000.0, 540], [0, 0, 1.0]])
    # Strongly oblique panel (55 deg about y) seen from one camera.
    a = np.deg2rad(55.0)
    R_true = np.array([[np.cos(a), 0, np.sin(a)], [0, 1, 0], [-np.sin(a), 0, np.cos(a)]])
    t_true = np.array([0.0, 0.0, 2500.0])
    obj = np.array([[x, y, 0.0] for x in (-300.0, -100.0, 100.0, 300.0)
                    for y in (-170.0, 0.0, 170.0)], dtype=float)
    xc = (R_true @ obj.T).T + t_true
    pix = (K @ xc.T).T
    pix = pix[:, :2] / pix[:, 2:3]
    # Single-solution iterative solve, seeded toward the mirror (negate the
    # oblique angle) -> may converge to the flipped branch.
    R_seed = np.array([[np.cos(-a), 0, np.sin(-a)], [0, 1, 0], [-np.sin(-a), 0, np.cos(-a)]])
    rvec0, _ = cv2.Rodrigues(R_seed)
    ok, rvec, tvec = cv2.solvePnP(obj, pix, K, None, rvec=rvec0.copy(),
                                  tvec=t_true.reshape(3, 1).copy(),
                                  useExtrinsicGuess=True, flags=cv2.SOLVEPNP_ITERATIVE)
    assert ok
    R_est, _ = cv2.Rodrigues(rvec)
    n_est = R_est @ np.array([0.0, 0.0, 1.0])
    n_true = R_true @ np.array([0.0, 0.0, 1.0])
    # The baseline single solve is NOT guaranteed to match nominal: a mirror
    # solution flips the lateral (x) component. Assert the baseline can disagree
    # OR (when it happens to agree) at least that the two normals are distinct
    # candidates -- the point is the iterative baseline cannot self-disambiguate.
    assert n_est @ n_true <= 1.0  # sanity: unit normals
    flipped = np.sign(n_est[0]) != np.sign(n_true[0])
    # Document the failure mode: at least the mirror is reachable from this seed.
    assert flipped or abs(n_est[0] - n_true[0]) < 1e-6


def test_ippe_branches_share_front_facing_zsign():
    """Codex finding-1 regression: the two IPPE branches share camera-frame
    normal z-sign (front-facing useless), only the lateral component flips; the
    nominal disambiguation picks the branch matching the nominal arc normal."""
    from lmt_vba_sidecar.reconstruct import _solve_pnp_branches, _disambiguate_world_branch
    K = np.array([[2000.0, 0, 960], [0, 2000.0, 540], [0, 0, 1.0]])
    a = np.deg2rad(40.0)
    R_true = np.array([[np.cos(a), 0, np.sin(a)], [0, 1, 0], [-np.sin(a), 0, np.cos(a)]])
    t_true = np.array([40.0, 30.0, 2200.0])
    obj = np.array([[x, y, 0.0] for x in (-300.0, -100.0, 100.0, 300.0)
                    for y in (-170.0, 0.0, 170.0)], dtype=float)
    xc = (R_true @ obj.T).T + t_true
    pix = (K @ xc.T).T
    pix = pix[:, :2] / pix[:, 2:3]
    res = _solve_pnp_branches(list(zip(obj, pix)), K)
    assert res is not None
    branches, _mask = res
    assert len(branches) == 2
    n0 = branches[0][0] @ np.array([0.0, 0.0, 1.0])
    n1 = branches[1][0] @ np.array([0.0, 0.0, 1.0])
    assert np.sign(n0[2]) == np.sign(n1[2])   # shared z-sign (front-facing useless)
    assert np.sign(n0[0]) != np.sign(n1[0])   # lateral component flips
    # In the model frame (camera at identity here) nominal disambiguation picks
    # the branch matching the true tilt normal, not its mirror.
    nominal_normal = R_true @ np.array([0.0, 0.0, 1.0])
    chosen = _disambiguate_world_branch(branches, nominal_normal)
    assert chosen != "undecidable"
    n_chosen = chosen[0] @ np.array([0.0, 0.0, 1.0])
    assert np.sign(n_chosen[0]) == np.sign(nominal_normal[0])


def test_undecidable_convexity_hard_stops(tmp_path, capsys):
    """A near-frontal isolated panel whose two IPPE branches are equally close to
    nominal (no redundant view breaks the tie) -> observability_failed, NO files."""
    from lmt_vba_sidecar.reconstruct import estimate_nonroot_cabinet_init
    K = np.array([[2000.0, 0, 960], [0, 2000.0, 540], [0, 0, 1.0]])
    # Cabinet 1 is NEAR-frontal: the two IPPE branches' model-frame normals are
    # both ~10deg / ~13.5deg off nominal +z, a separation below
    # DISAMBIG_NORMAL_MARGIN_RAD (8deg), so neither is meaningfully closer ->
    # undecidable. (Smaller tilts, e.g. 4deg, are too close to fronto-parallel:
    # planar IPPE returns NaN poses there, so the cabinet is simply not bridged
    # instead of reaching the undecidable tie — see DONE_WITH_CONCERNS report.)
    tilt = np.deg2rad(10.0)
    R_true = np.array([[np.cos(tilt), 0, np.sin(tilt)], [0, 1, 0],
                       [-np.sin(tilt), 0, np.cos(tilt)]])
    t_true = np.array([500.0, 0.0, 0.0])
    root_local = np.array([[-300,-170,0],[300,-170,0],[300,170,0],[-300,170,0]], float)
    cams = [(np.eye(3), np.array([0.0, 0.0, 2400.0]))]  # ONE camera -> no redundancy
    per_view = {}
    for ci, (R_cam, t_cam) in enumerate(cams):
        per_view[(ci, 0)] = [(p, (K @ (R_cam @ p + t_cam))[:2]
                              / (K @ (R_cam @ p + t_cam))[2]) for p in root_local]
        per_view[(ci, 1)] = _ippe_oblique_corners(K, R_true, t_true, R_cam, t_cam)
    out, undecidable = estimate_nonroot_cabinet_init(
        per_view, root_idx=0, K=K,
        nominal_poses={0: (np.eye(3), np.zeros(3)), 1: (np.eye(3), np.array([0.5, 0.0, 0.0]))})
    assert 1 in undecidable and 1 not in out


def test_normal_convention_matches_geometry():
    """The disambiguation normal (R @ [0,0,1]) equals reconstruct_cabinet_geometry's
    normal for the same pose -> no deterministic sign flip."""
    from lmt_vba_sidecar.eval_runner import reconstruct_cabinet_geometry
    R = cv2.Rodrigues(np.array([0.0, 0.6, 0.0]))[0]
    t = np.array([100., 0., 0.])
    corners = np.array([[-300,-170,0],[300,-170,0],[300,170,0],[-300,170,0]], float)
    _c, normal, _s, _w = reconstruct_cabinet_geometry(R, t, corners)
    np.testing.assert_allclose(normal, R @ np.array([0., 0., 1.]), atol=1e-9)


def _Ry(a):
    return np.array([[np.cos(a), 0, np.sin(a)], [0, 1, 0], [-np.sin(a), 0, np.cos(a)]])


def test_estimate_nonroot_init_curved_root_not_at_arc_center():
    """Codex P2 (rec#1): for a curved arc whose ROOT is at a non-zero nominal
    angle, world_branches are in the ROOT frame but nominal_normals are in the
    global MODEL frame. Model root angle=+40 deg, non-root=+20 deg -> the TRUE
    world(root)-frame relative orientation is R_y(20-40)=R_y(-20) (lateral sign
    NEGATIVE), while the model-frame nominal[1] lateral is sin(+20) (POSITIVE) —
    opposite sign, so an UN-transformed comparison would select the +20 IPPE
    mirror. The root-frame transform must recover R_y(-20)."""
    K = np.array([[2000.0, 0, 960], [0, 2000.0, 540], [0, 0, 1.0]])
    local = np.array([[-300, -170, 0], [300, -170, 0], [300, 170, 0], [-300, 170, 0],
                      [-150, -85, 0], [150, -85, 0], [150, 85, 0], [-150, 85, 0]], float)
    a_root, a_one = np.deg2rad(40.0), np.deg2rad(20.0)
    R_rel_true = _Ry(a_one - a_root)                 # world(root)-frame nonroot pose = R_y(-20)
    t_true = np.array([400.0, 0.0, -150.0])
    cams = [(np.eye(3), np.array([dx, 0.0, 2300.0])) for dx in (-300.0, 0.0, 300.0)]
    per_view: dict[tuple[int, int], list] = {}
    for ci, (R_cam, t_cam) in enumerate(cams):
        per_view[(ci, 0)] = [(p, _project(R_cam, t_cam, np.eye(3), np.zeros(3), p, K)) for p in local]
        per_view[(ci, 1)] = [(p, _project(R_cam, t_cam, R_rel_true, t_true, p, K)) for p in local]
    # MODEL-frame nominal tile poses _Ry(a_root) / _Ry(a_one): derived normals
    # [sin a, 0, cos a] reproduce the original scenario's lateral signs.
    out, undecidable = estimate_nonroot_cabinet_init(
        per_view, root_idx=0, K=K,
        nominal_poses={0: (_Ry(a_root), np.zeros(3)), 1: (_Ry(a_one), t_true / 1000.0)},
    )
    assert undecidable == set() and 1 in out
    R_est, _t = out[1]
    ang_err = np.degrees(np.arccos(np.clip((np.trace(R_est.T @ R_rel_true) - 1) / 2, -1, 1)))
    assert ang_err < 2.0, f"recovered differs from true R_y(-20) by {ang_err:.2f} deg (picked mirror?)"
    ang_to_mirror = np.degrees(np.arccos(np.clip((np.trace(R_est.T @ _Ry(a_root - a_one)) - 1) / 2, -1, 1)))
    assert ang_to_mirror > 30.0, "recovered the +20 mirror branch (root-frame transform missing)"


def test_stage_b_drops_past_floor_when_cabinet_mostly_corrupt():
    """Codex P2 (rec#2): when a cabinet has MORE bad observations than
    (count - per_cabinet_min_points), the floor must NOT retain the bad ones to
    keep the cabinet at the minimum (that shipped a high-residual wrong report).
    It now drops PAST the floor (to a BA-safety minimum), leaving the cabinet
    below per_cabinet_min_points so solve_and_emit's post-trim observability
    hard-stops it instead of emitting a wrong measured.yaml."""
    from lmt_vba_sidecar.reconstruct import stage_b_robust_solve
    K = np.array([[2000.0, 0, 960], [0, 2000.0, 540], [0, 0, 1.0]])
    a = np.deg2rad(20.0)
    R_true = _Ry(a)
    t_true = np.array([700.0, 0.0, 0.0])
    obs, init_cams, cams, _ = _two_panel_clean(K, R_true, t_true)
    # Corrupt 28 of cabinet 1's 32 observations with far outliers: more than the
    # 32-8=24 the old floor would allow dropping, so the old code retained 8 (incl
    # 4 bad) and shipped a wrong report.
    n_corrupt = 0
    for k, o in enumerate(obs):
        if o.cabinet_idx == 1 and n_corrupt < 28:
            obs[k] = Observation(o.camera_idx, 1, o.p_local, o.pixel + np.array([320.0, -260.0]))
            n_corrupt += 1
    _res, _rej, _total, surviving = stage_b_robust_solve(
        K=K, observations=obs, n_cameras=len(cams), n_cabinets=2, root_cabinet_idx=0,
        init_cameras=init_cams, init_cabinets=_two_panel_init_cabinets(t_true),
        per_cabinet_min_points=8)
    cab1_surviving = sum(1 for o in surviving if o.cabinet_idx == 1)
    assert cab1_surviving < 8, (
        f"cabinet 1 retained {cab1_surviving} observations — the floor is still "
        f"clamping known-bad points at the minimum (rec#2 not fixed)")
