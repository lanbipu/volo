import numpy as np

from lmt_vba_sidecar.ipc import CabinetArray
from lmt_vba_sidecar.capture_planner.geometry import expand_screen
from lmt_vba_sidecar.capture_planner.visibility import intrinsics_from_fov, coverage_report
from lmt_vba_sidecar.capture_planner.seed import Shell, fov_fill_standoff, seed_cameras


def _wall(cols, rows):
    cab = CabinetArray(cols=cols, rows=rows, cabinet_size_mm=[500.0, 500.0], absent_cells=[])
    return expand_screen(cab, "flat", sample_grid=(4, 4))


def test_fov_fill_standoff_fits_width_with_margin():
    K = intrinsics_from_fov((1920, 1080), hfov_deg=60.0)
    # a 3 m wide wall, fill 0.8: projected width should be ~0.8*1920 px
    standoff = fov_fill_standoff(K, (1920, 1080), 3000.0, 1000.0, fill=0.8)
    proj_w = K[0, 0] * 3000.0 / standoff
    assert np.isclose(proj_w, 0.8 * 1920, rtol=1e-6)


def test_fov_fill_standoff_clamps_into_shell():
    K = intrinsics_from_fov((1920, 1080), hfov_deg=60.0)
    shell = Shell(standoff_min_mm=2000.0, standoff_max_mm=2500.0,
                  height_min_mm=300.0, height_max_mm=2500.0)
    # raw fit for a tiny wall would be < 2000 -> clamp up to standoff_min
    standoff = seed_cameras(_wall(1, 1), K, (1920, 1080), shell)[0].standoff_used_mm
    assert 2000.0 <= standoff <= 2500.0


def test_seed_has_fan_plus_top_and_bottom_at_shell_heights():
    K = intrinsics_from_fov((1920, 1080), hfov_deg=60.0)
    shell = Shell(2000.0, 8000.0, 300.0, 2600.0)
    geom = _wall(3, 2)
    cams = seed_cameras(geom, K, (1920, 1080), shell, n_fan=5)
    assert len(cams) == 5 + 2                       # fan + top + bottom
    ys = sorted(c.position_mm[1] for c in cams)
    assert np.isclose(ys[0], 300.0)                 # bottom station at height_min
    assert np.isclose(ys[-1], 2600.0)               # top station at height_max
    cy = geom.total_height_mm / 2.0
    fan_ys = [c.position_mm[1] for c in cams if abs(c.position_mm[1] - cy) < 1e-6]
    assert len(fan_ys) == 5                          # fan all at mid height


def test_seed_makes_small_flat_wall_mostly_reconstructable():
    K = intrinsics_from_fov((1920, 1080), hfov_deg=60.0)
    shell = Shell(2500.0, 8000.0, 300.0, 2600.0)
    geom = _wall(3, 2)
    cams = [c.camera for c in seed_cameras(geom, K, (1920, 1080), shell, n_fan=5)]
    per_cab, _ = coverage_report(geom, cams)
    n_ok = sum(1 for c in per_cab if c.reconstructable)
    assert n_ok >= 5                                 # >=5 of 6 cabinets reconstructable


def test_seed_fan_height_clamped_into_shell():
    # Tall wall (10 rows -> mid-height 2500mm) but a shell that tops out at 2200:
    # fan cameras must NOT be placed at 2500 (outside the reachable shell).
    K = intrinsics_from_fov((1920, 1080), hfov_deg=60.0)
    shell = Shell(2500.0, 9000.0, 400.0, 2200.0)
    cab = CabinetArray(cols=2, rows=10, cabinet_size_mm=[500.0, 500.0], absent_cells=[])
    geom = expand_screen(cab, "flat", sample_grid=(4, 4))
    for s in seed_cameras(geom, K, (1920, 1080), shell, n_fan=5):
        assert 400.0 - 1e-6 <= s.position_mm[1] <= 2200.0 + 1e-6, \
            f"{s.role} station at y={s.position_mm[1]} outside shell"
