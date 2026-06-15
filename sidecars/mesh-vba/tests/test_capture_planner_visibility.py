import numpy as np

from lmt_vba_sidecar.capture_planner.visibility import (
    Camera,
    intrinsics_from_fov,
    look_at_camera,
    point_visible,
)

FLAT_NORMAL = np.array([0.0, 0.0, 1.0])
WALL_PT = np.array([250.0, 250.0, 0.0])   # a point on a flat wall facing +z


def test_intrinsics_from_fov_horizontal():
    K = intrinsics_from_fov((1920, 1080), hfov_deg=90.0)
    # f = (W/2)/tan(45deg) = 960
    assert np.isclose(K[0, 0], 960.0)
    assert np.isclose(K[1, 1], 960.0)
    assert np.isclose(K[0, 2], 960.0)
    assert np.isclose(K[1, 2], 540.0)


def test_point_visible_frontal_true():
    K = intrinsics_from_fov((1920, 1080), hfov_deg=50.0)
    cam = look_at_camera(K, [250.0, 250.0, 3000.0], WALL_PT, (1920, 1080))
    assert point_visible(cam, WALL_PT, FLAT_NORMAL) is True


def test_point_visible_behind_camera_false_cheirality():
    K = intrinsics_from_fov((1920, 1080), hfov_deg=50.0)
    cam = look_at_camera(K, [250.0, 250.0, 3000.0], WALL_PT, (1920, 1080))
    behind = np.array([250.0, 250.0, 6000.0])  # past the camera, +z further out
    assert point_visible(cam, behind, FLAT_NORMAL) is False


def test_point_visible_out_of_frame_false():
    K = intrinsics_from_fov((1920, 1080), hfov_deg=50.0)
    cam = look_at_camera(K, [250.0, 250.0, 3000.0], WALL_PT, (1920, 1080))
    far_side = np.array([9000.0, 250.0, 0.0])   # way off to the right, off-sensor
    assert point_visible(cam, far_side, FLAT_NORMAL) is False


def test_point_visible_grazing_incidence_false():
    K = intrinsics_from_fov((1920, 1080), hfov_deg=50.0)
    # camera almost in the wall plane -> ~88deg incidence on a +z normal
    cam = look_at_camera(K, [5250.0, 250.0, 100.0], WALL_PT, (1920, 1080))
    assert point_visible(cam, WALL_PT, FLAT_NORMAL, incidence_max_deg=60.0) is False


from lmt_vba_sidecar.ipc import CabinetArray
from lmt_vba_sidecar.capture_planner.geometry import expand_screen
from lmt_vba_sidecar.capture_planner.visibility import coverage_report, vis_count
from lmt_vba_sidecar.capture_planner import gates


def _single_flat_cabinet():
    cab = CabinetArray(cols=1, rows=1, cabinet_size_mm=[500.0, 500.0], absent_cells=[])
    return expand_screen(cab, "flat", sample_grid=(4, 4))


def _good_cam(K, pos, geom):
    # a camera that frontally sees the whole single cabinet
    return look_at_camera(K, pos, geom.cabinets[0].center_mm, (1920, 1080))


def test_guardrail_center_in_frame_but_points_clipped_is_not_covered():
    # Codex guardrail: the cabinet CENTER projects in-frame (the old
    # center-shortcut would PASS), but a tiny 64x64 frame with long focal length
    # clips every off-center sample point -> vis_count 0 -> NOT covered.
    geom = _single_flat_cabinet()
    cabg = geom.cabinets[0]
    K = np.array([[2000.0, 0.0, 32.0], [0.0, 2000.0, 32.0], [0.0, 0.0, 1.0]])
    cam = look_at_camera(K, [250.0, 250.0, 1000.0], cabg.center_mm, (64, 64))
    # the geometric center would have passed a center-only test:
    assert point_visible(cam, cabg.center_mm, cabg.normal) is True
    # but per-point gating sees < MIN_PNP_CORNERS sample points:
    assert vis_count(cam, cabg) < gates.MIN_PNP_CORNERS
    per_cab, _ = coverage_report(geom, [cam])
    assert per_cab[0].reconstructable is False


def test_one_view_not_reconstructable_even_if_all_points_visible():
    geom = _single_flat_cabinet()
    K = intrinsics_from_fov((1920, 1080), hfov_deg=50.0)
    cam = _good_cam(K, [250.0, 250.0, 3000.0], geom)
    assert vis_count(cam, geom.cabinets[0]) == 16   # sees all sample points
    per_cab, _ = coverage_report(geom, [cam])
    cov = per_cab[0]
    assert cov.total_observations >= gates.MIN_POINTS_PER_CABINET  # points gate OK
    assert len(cov.covering_cams) == 1
    assert cov.reconstructable is False              # ... but views gate fails


def test_two_views_reconstructable_but_low_observation():
    geom = _single_flat_cabinet()
    K = intrinsics_from_fov((1920, 1080), hfov_deg=50.0)
    cams = [
        _good_cam(K, [-1500.0, 250.0, 3000.0], geom),
        _good_cam(K, [2000.0, 250.0, 3000.0], geom),
    ]
    per_cab, _ = coverage_report(geom, cams)
    cov = per_cab[0]
    assert len(cov.covering_cams) == 2
    assert cov.reconstructable is True
    assert cov.low_observation is True               # 2 < QUALITY_MIN_VIEWS(4)


def test_coverage_min_views_param_tightens_reconstructable():
    # The same 2-covering-view single cabinet as the low_observation test: reconstructable
    # at the default min_views=2, but NOT at the precision profile's min_views=3.
    geom = _single_flat_cabinet()
    K = intrinsics_from_fov((1920, 1080), hfov_deg=50.0)
    cams = [
        _good_cam(K, [-1500.0, 250.0, 3000.0], geom),
        _good_cam(K, [2000.0, 250.0, 3000.0], geom),
    ]
    per2, _ = coverage_report(geom, cams, min_views=2)
    per3, _ = coverage_report(geom, cams, min_views=3)
    assert len(per2[0].covering_cams) == 2
    assert per2[0].reconstructable is True
    assert per3[0].reconstructable is False


def test_four_views_not_low_observation():
    geom = _single_flat_cabinet()
    K = intrinsics_from_fov((1920, 1080), hfov_deg=50.0)
    cams = [
        _good_cam(K, [-1500.0, 250.0, 3000.0], geom),
        _good_cam(K, [600.0, 250.0, 3000.0], geom),
        _good_cam(K, [2000.0, 250.0, 3000.0], geom),
        _good_cam(K, [250.0, 1800.0, 3000.0], geom),
    ]
    per_cab, _ = coverage_report(geom, cams)
    cov = per_cab[0]
    assert len(cov.covering_cams) == 4
    assert cov.reconstructable is True
    assert cov.low_observation is False


from lmt_vba_sidecar.capture_planner.visibility import bridging_report


def test_bridging_single_camera_covering_two_adjacent_is_one_component():
    cab = CabinetArray(cols=2, rows=1, cabinet_size_mm=[500.0, 500.0], absent_cells=[])
    geom = expand_screen(cab, "flat", sample_grid=(4, 4))
    K = intrinsics_from_fov((1920, 1080), hfov_deg=70.0)
    # one camera centered on the 2-wide wall, far enough to cover both cabinets
    center = np.array([500.0, 250.0, 0.0])
    cam = look_at_camera(K, center + [0.0, 0.0, 4000.0], center, (1920, 1080))
    rep = bridging_report(geom, [cam])
    assert rep.broken_edges == []
    assert rep.n_components == 1


def test_bridging_disjoint_cameras_break_the_chain():
    cab = CabinetArray(cols=2, rows=1, cabinet_size_mm=[500.0, 500.0], absent_cells=[])
    geom = expand_screen(cab, "flat", sample_grid=(4, 4))
    K = intrinsics_from_fov((1920, 1080), hfov_deg=30.0)
    # two tight-FOV cameras close in, each frontal to ONE cabinet only; at 800mm
    # the other cabinet's nearest (seam) column projects off-sensor -> no shared cover
    left_c = np.array([250.0, 250.0, 0.0])
    right_c = np.array([750.0, 250.0, 0.0])
    cams = [
        look_at_camera(K, left_c + [0.0, 0.0, 800.0], left_c, (1920, 1080)),
        look_at_camera(K, right_c + [0.0, 0.0, 800.0], right_c, (1920, 1080)),
    ]
    rep = bridging_report(geom, cams)
    assert ((0, 0), (1, 0)) in rep.broken_edges or ((1, 0), (0, 0)) in rep.broken_edges
    assert rep.n_components == 2


from lmt_vba_sidecar.capture_planner.geometry import ArcOccluder
from lmt_vba_sidecar.capture_planner.visibility import point_visible as pv


def test_arc_occlusion_isolates_check_d():
    # A strong concave arc point that passes (a) cheirality, (b) in-frame, and
    # (c) incidence — but the near arc physically blocks it from an off-side
    # camera. Asserting visible WITHOUT the occluder and occluded WITH it proves
    # check (d) is the differentiator (not grazing/back-facing).
    #
    # Post-FIX-1 geometry: the concave wall's LEFT limb faces +x/+z (toward the
    # audience center), so the camera that sees it face-on while the NEAR (right)
    # limb crosses the sight line is one grazing low past the right edge.
    cab = CabinetArray(cols=10, rows=1, cabinet_size_mm=[500.0, 500.0], absent_cells=[])
    geom = expand_screen(cab, {"curved": {"radius_mm": 2200.0}}, sample_grid=(4, 4))
    arc = geom.arc_occluder
    cabg = next(c for c in geom.cabinets if (c.col, c.row) == (1, 0))
    q = cabg.sample_points_mm[5]            # a point that flips under (d)
    n = cabg.normal
    K = intrinsics_from_fov((3840, 2160), hfov_deg=70.0)
    cam = look_at_camera(K, [6000.0, 250.0, 500.0],
                         [0.3 * geom.total_width_mm, 250.0, 800.0], (3840, 2160))
    assert pv(cam, q, n, arc=None) is True       # passes (a)(b)(c)
    assert pv(cam, q, n, arc=arc) is False        # ... but (d) occludes it


def test_arc_occlusion_does_not_block_frontal_view():
    radius = 2500.0
    width = 6000.0
    arc = ArcOccluder(cx=width / 2.0, cz=radius, radius=radius,
                      a_min=-width / (2 * radius), a_max=width / (2 * radius),
                      y_min=0.0, y_max=500.0)
    q = np.array([arc.cx, 250.0, 0.0])
    n = np.array([0.0, 0.0, 1.0])
    K = intrinsics_from_fov((3840, 2160), hfov_deg=70.0)
    cam = look_at_camera(K, [arc.cx, 250.0, 5000.0], q, (3840, 2160))
    assert pv(cam, q, n, arc=arc) is True


def test_arc_occlusion_verdict_invariant_across_standoff():
    # FIX-16 验收:浅弧墙(箱体外侧采样点矢高 ~mm 级)正面站位,3m/5m/8m 站距
    # 下每个采样点的遮挡判定必须一致。旧段长比例 epsilon(1e-3·段长)随站距
    # 变化,恰骑在矢高量级上 —— "是否自遮挡"取决于站距而非几何。
    cab = CabinetArray(cols=16, rows=2, cabinet_size_mm=[500.0, 500.0], absent_cells=[])
    geom = expand_screen(cab, {"curved": {"radius_mm": 8000.0}}, sample_grid=(4, 4))
    arc = geom.arc_occluder
    cx = geom.total_width_mm / 2.0
    cy = geom.total_height_mm / 2.0
    K = intrinsics_from_fov((3840, 2160), hfov_deg=80.0)
    verdicts = []
    for standoff in (3000.0, 5000.0, 8000.0):
        cam = look_at_camera(K, [cx, cy, standoff], [cx, cy, 0.0], (3840, 2160))
        cam_center = np.array([cx, cy, standoff])
        from lmt_vba_sidecar.capture_planner.visibility import _arc_occludes
        verdicts.append(tuple(
            _arc_occludes(arc, cam_center, p)
            for cabg in geom.cabinets for p in cabg.sample_points_mm
        ))
    assert verdicts[0] == verdicts[1] == verdicts[2], (
        "occlusion verdicts must depend on geometry, not standoff"
    )
    # 浅弧正面视角:不应有任何点被自家矢高"遮挡"。
    assert not any(verdicts[0]), "shallow arc frontal view must have zero self-occlusion"


def test_arc_occlusion_sightline_over_wall_top_not_blocked():
    # FIX-16 验收:同一 XZ 几何(check_d 用例:右侧掠射相机 → 左肢采样点,
    # 视线确实横跨近弧),低位相机被真实遮挡;把相机抬高,XZ 投影不变但
    # 3D 交点越过墙顶(y_max=500)—— 旧无限高圆柱误判遮挡,y 裁剪必须放行。
    from lmt_vba_sidecar.capture_planner.visibility import _arc_occludes
    cab = CabinetArray(cols=10, rows=1, cabinet_size_mm=[500.0, 500.0], absent_cells=[])
    geom = expand_screen(cab, {"curved": {"radius_mm": 2200.0}}, sample_grid=(4, 4))
    arc = geom.arc_occluder
    assert (arc.y_min, arc.y_max) == (0.0, 500.0)
    cabg = next(c for c in geom.cabinets if (c.col, c.row) == (1, 0))
    q = cabg.sample_points_mm[5]
    cam_lo = np.array([6000.0, 250.0, 500.0])
    assert _arc_occludes(arc, cam_lo, q) is True, "low sightline crosses the wall body"
    cam_hi = np.array([6000.0, 6000.0, 500.0])
    assert _arc_occludes(arc, cam_hi, q) is False, (
        "sightline passing OVER the wall top must not be occluded"
    )
