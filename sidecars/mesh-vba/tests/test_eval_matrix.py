"""Seed-matrix eval gate: model-constrained BA must beat free-point BA.

Phase 0 exit criterion: median(mc) < median(fp) on 5 fixed seeds, plus
nominal-tier absolute thresholds for the model-constrained method.
"""
import numpy as np
from lmt_vba_sidecar.ipc import SimulateInput
from lmt_vba_sidecar.simulate import build_scene
from lmt_vba_sidecar.eval_runner import run_method, reconstruct_cabinet_geometry


def _inp(seed, pixel_sigma=0.3, n=20, vis=0.8):
    return SimulateInput.model_validate({
        "command": "simulate", "version": 1,
        "scene": {"cabinet_array": {"cols": 2, "rows": 1, "cabinet_size_mm": [600, 340]},
                  "shape_prior": "flat", "inter_board_angle_deg": 10.0},
        "cameras": {"n_views": n, "distance_mm_range": [1500, 3000],
                    "yaw_deg_range": [-40, 40], "pitch_deg_range": [-20, 20]},
        "intrinsics": {"K": [[2000, 0, 960], [0, 2000, 540], [0, 0, 1]],
                       "dist_coeffs": [0, 0, 0, 0, 0], "image_size": [1920, 1080]},
        "noise": {"pixel_sigma": pixel_sigma, "visibility_frac": vis},
        "seed": seed})


def test_model_constrained_beats_free_point_on_seed_matrix():
    seeds = [0, 1, 2, 3, 4]
    mc, fp, fp_ang = [], [], []
    for s in seeds:
        scene = build_scene(_inp(s))
        mc.append(run_method(scene, "charuco")["max_distance_error_mm"])
        fp_res = run_method(scene, "free_point")
        fp.append(fp_res["max_distance_error_mm"])
        fp_ang.append(fp_res["max_angle_error_deg"])
    print(f"\nmc max_distance_error_mm per seed: {mc}")
    print(f"fp max_distance_error_mm per seed: {fp}")
    print(f"median(mc)={np.median(mc):.4f}  median(fp)={np.median(fp):.4f}")
    # fp angle should no longer have ~170 deg outliers (normal sign disambiguated)
    print(f"fp max_angle_error_deg per seed: {fp_ang}  median={np.median(fp_ang):.4f}")
    assert np.median(mc) < np.median(fp)          # new algorithm more accurate
    assert np.median(mc) < 3.0                      # nominal-tier distance error (starter threshold)


def test_nominal_tier_thresholds():
    errs = [run_method(build_scene(_inp(s)), "charuco") for s in range(5)]
    size_vals = [e["max_size_error_mm"] for e in errs]
    ang_vals = [e["max_angle_error_deg"] for e in errs]
    print(f"\nsize errors per seed: {size_vals}  median={np.median(size_vals):.4f}")
    print(f"angle errors per seed: {ang_vals}  median={np.median(ang_vals):.4f}")
    # NOTE: for 'charuco' the size error is structurally 0 — size comes from the
    # known local corner model (a fixed BA constraint), so true==est regardless
    # of pose. This assertion is a design sanity gate; a real size error only
    # appears under pixel-pitch / panel-size input error (Task 3.1). The angle
    # assertion below is the genuinely meaningful accuracy check here.
    assert np.median(size_vals) < 2.0
    assert np.median(ang_vals) < 0.3


def test_pitch_error_sweep_scale_error_monotonic():
    from lmt_vba_sidecar.eval_runner import pitch_sweep
    def _builder(pitch):
        return SimulateInput.model_validate({
            "command":"simulate","version":1,
            "scene":{"cabinet_array":{"cols":2,"rows":1,"cabinet_size_mm":[600,340]},
                     "shape_prior":"flat","inter_board_angle_deg":10.0},
            "cameras":{"n_views":20,"distance_mm_range":[1500,3000],
                       "yaw_deg_range":[-40,40],"pitch_deg_range":[-20,20]},
            "intrinsics":{"K":[[2000,0,960],[0,2000,540],[0,0,1]],
                          "dist_coeffs":[0,0,0,0,0],"image_size":[1920,1080]},
            "noise":{"pixel_sigma":0.0,"visibility_frac":1.0,"pixel_pitch_error_frac":pitch},
            "seed":7})
    rows = pitch_sweep(_builder, [0.0, 0.002, 0.005])
    d = [r["max_distance_error_mm"] for r in rows]
    print(f"\npitch sweep max_distance_error_mm: {d}")
    assert d[0] < d[1] < d[2]          # monotonic in pitch error
    assert d[0] < 0.5                   # zero pitch → ~0 distance error
    assert d[1] < 10.0                  # typical 0.002 stays within 10mm budget
