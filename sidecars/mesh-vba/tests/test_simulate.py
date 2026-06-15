import numpy as np
from lmt_vba_sidecar.ipc import SimulateInput
from lmt_vba_sidecar.simulate import build_scene


def _inp(seed=42, n=12, vis=1.0, pitch=0.0):
    return SimulateInput.model_validate({
        "command": "simulate", "version": 1,
        "scene": {"cabinet_array": {"cols": 2, "rows": 1, "cabinet_size_mm": [600, 340]},
                  "shape_prior": "flat", "inter_board_angle_deg": 10.0},
        "cameras": {"n_views": n, "distance_mm_range": [1500, 3000],
                    "yaw_deg_range": [-40, 40], "pitch_deg_range": [-20, 20]},
        "intrinsics": {"K": [[2000, 0, 960], [0, 2000, 540], [0, 0, 1]],
                       "dist_coeffs": [0, 0, 0, 0, 0], "image_size": [1920, 1080]},
        "noise": {"pixel_sigma": 0.0, "visibility_frac": vis, "pixel_pitch_error_frac": pitch},
        "seed": seed})


def test_scene_is_deterministic_per_seed():
    a = build_scene(_inp(seed=7, vis=0.8))
    b = build_scene(_inp(seed=7, vis=0.8))
    assert np.allclose(a.true_camera_poses[0][1], b.true_camera_poses[0][1])
    assert np.allclose(a.observations[0].pixel, b.observations[0].pixel)
    assert len(a.observations) == len(b.observations)
    c = build_scene(_inp(seed=99, vis=0.8))
    assert not np.allclose(a.true_camera_poses[0][1], c.true_camera_poses[0][1])


def test_zero_noise_observations_reproject_exactly():
    scene = build_scene(_inp(seed=1))
    K = scene.K
    for o in scene.observations[:50]:
        Rc, tc = scene.true_camera_poses[o.camera_idx]
        Rb, tb = scene.true_cabinet_poses[o.cabinet_idx]
        xw = Rb @ o.p_local + tb
        xc = Rc @ xw + tc
        p = K @ xc
        assert np.linalg.norm(p[:2] / p[2] - o.pixel) < 1e-6


def test_inter_board_angle_is_applied():
    scene = build_scene(_inp())
    n0 = scene.true_cabinet_poses[0][0] @ np.array([0, 0, 1.])
    n1 = scene.true_cabinet_poses[1][0] @ np.array([0, 0, 1.])
    ang = np.degrees(np.arccos(np.clip(n0 @ n1, -1, 1)))
    assert abs(ang - 10.0) < 1e-6


def test_two_by_two_grid_positions():
    # FIX-10a: angle==0 walls are placed by the nominal SE(3) poses (y-up model
    # frame, row 0 = wall top — nominal.py's convention declaration), no longer
    # the legacy y-down corner lattice.
    inp = _inp()
    inp = inp.model_copy(update={"scene": inp.scene.model_copy(update={
        "cabinet_array": inp.scene.cabinet_array.model_copy(update={"rows": 2}),
        "inter_board_angle_deg": 0.0})})
    scene = build_scene(inp)
    # Poses are re-expressed in the root cabinet (j=0) frame, so j=0 = (I, 0).
    assert np.allclose(scene.true_cabinet_poses[0][1], [0, 0, 0])
    # j=2 -> col=0,row=1 (bottom row), one cabinet-height below root
    assert np.allclose(scene.true_cabinet_poses[2][1], [0, -340, 0])
    assert np.allclose(scene.true_cabinet_poses[3][1], [600, -340, 0])
    # row 0 (wall top, root) sits ABOVE row 1
    assert scene.true_cabinet_poses[0][1][1] > scene.true_cabinet_poses[2][1][1]


def _curved_inp(cols=8, rows=2, radius=3000.0, n=10, trajectory="along_wall",
                dist=(1200, 1500), seed=3, sigma=0.0):
    return SimulateInput.model_validate({
        "command": "simulate", "version": 1,
        "scene": {"cabinet_array": {"cols": cols, "rows": rows, "cabinet_size_mm": [500, 500]},
                  "shape_prior": {"curved": {"radius_mm": radius}},
                  "inter_board_angle_deg": 0.0},
        "cameras": {"n_views": n, "distance_mm_range": list(dist),
                    "yaw_deg_range": [-5, 5], "pitch_deg_range": [-5, 5],
                    "trajectory": trajectory},
        "intrinsics": {"K": [[3000, 0, 2000], [0, 3000, 1500], [0, 0, 1]],
                       "dist_coeffs": [0, 0, 0, 0, 0], "image_size": [4000, 3000]},
        "noise": {"pixel_sigma": sigma},
        "seed": seed})


def test_curved_scene_is_true_arc_not_in_place_fan():
    """FIX-10a: a curved shape_prior must yield a TRUE constant-radius arc —
    cabinet centers deflect off the z=0 plane AND tiles tilt tangent to the
    arc (matching the nominal SE(3) poses). The pre-fix stand-in rotated tiles
    in place on a flat lattice (zero center deflection)."""
    from lmt_vba_sidecar.nominal import nominal_cabinet_poses_model_frame
    from lmt_vba_sidecar.ipc import CabinetArray
    inp = _curved_inp()
    scene = build_scene(inp)
    cab = CabinetArray(cols=8, rows=2, cabinet_size_mm=[500.0, 500.0])
    poses = nominal_cabinet_poses_model_frame(cab, {"curved": {"radius_mm": 3000.0}})
    # Simulate re-expresses into root (j=0) frame; do the same for comparison.
    R0, t0_m = poses[(0, 0)]
    t0 = np.asarray(t0_m) * 1000.0
    for j in range(16):
        col, row = j % 8, j // 8
        R_n, t_m = poses[(col, row)]
        t_root = R0.T @ (np.asarray(t_m) * 1000.0 - t0)
        R_root = R0.T @ R_n
        np.testing.assert_allclose(scene.true_cabinet_poses[j][1], t_root, atol=1e-9)
        np.testing.assert_allclose(scene.true_cabinet_poses[j][0], R_root, atol=1e-12)
    # real deflection: edge columns bow off the chord plane
    z = [scene.true_cabinet_poses[j][1][2] for j in range(8)]
    assert max(z) - min(z) > 50.0


def test_curved_plus_inter_board_angle_rejected():
    inp = _curved_inp()
    inp = inp.model_copy(update={"scene": inp.scene.model_copy(update={
        "inter_board_angle_deg": 5.0})})
    import pytest
    with pytest.raises(ValueError, match="mutually .?exclusive|exclusive"):
        build_scene(inp)


def test_fov_clipping_drops_out_of_frame_pixels():
    """FIX-10a: every observation's pixel lies inside the image bounds, and a
    close-in along-wall station genuinely sees only PART of the wall (the
    pre-fix simulator projected every corner into every view)."""
    scene = build_scene(_curved_inp())
    for o in scene.observations:
        assert 0.0 <= o.pixel[0] <= 4000.0 and 0.0 <= o.pixel[1] <= 3000.0
    seen_by_cam0 = {o.cabinet_idx for o in scene.observations if o.camera_idx == 0}
    assert len(seen_by_cam0) < scene.n_cabinets, "camera 0 sees the whole wall — no clipping?"


def test_along_wall_stations_spread_and_face_their_segment():
    """FIX-10a: along_wall stations advance along the wall (camera centers span
    most of the wall width) instead of orbiting the centroid."""
    scene = build_scene(_curved_inp())
    centers = np.array([-(R.T @ t) for R, t in scene.true_camera_poses])
    # Max pairwise distance between any two camera centers — along-wall stations
    # must span a significant fraction of the wall width, not cluster at one spot.
    from scipy.spatial.distance import pdist
    span = float(pdist(centers).max())
    assert span > 1500.0, f"camera spread {span:.0f}mm too small for along-wall"
    # stations are at standoff distance from the wall, not at orbit radii
    wall_pts = np.array([t for _R, t in scene.true_cabinet_poses.values()])
    for c in centers:
        d = np.linalg.norm(wall_pts - c, axis=1).min()
        assert 800.0 < d < 2500.0
