"""sidecar 'plan_capture' entrypoint: project geometry + intrinsics + reachable
shell -> recipe seed -> greedy optimize -> CapturePlan result event."""
from __future__ import annotations

import math

import numpy as np

from lmt_vba_sidecar.io_utils import write_event
from lmt_vba_sidecar.ipc import (
    CabinetCoverageData,
    CaptureStationData,
    ErrorEvent,
    PlanCaptureInput,
    PlanCaptureResultData,
    PlanCaptureResultEvent,
    UnreachableRegionData,
)
from lmt_vba_sidecar.capture_planner import gates
from lmt_vba_sidecar.capture_planner.geometry import expand_screen
from lmt_vba_sidecar.capture_planner.visibility import intrinsics_from_fov
from lmt_vba_sidecar.capture_planner.seed import Shell, seed_cameras
from lmt_vba_sidecar.capture_planner.optimize import optimize


def _aim_point_on_wall(cam) -> np.ndarray:
    center = -cam.R.T @ cam.t
    axis = cam.R.T @ np.array([0.0, 0.0, 1.0])     # optical axis, world frame
    if abs(axis[2]) < 1e-9:
        return center
    return center + (-center[2] / axis[2]) * axis


def run_plan_capture(cmd: PlanCaptureInput) -> int:
    image_size = (int(cmd.intrinsics.image_size[0]), int(cmd.intrinsics.image_size[1]))
    try:
        K = intrinsics_from_fov(image_size, cmd.intrinsics.hfov_deg, cmd.intrinsics.vfov_deg)
        geom = expand_screen(cmd.project.cabinet_array, cmd.project.shape_prior,
                             tuple(cmd.sample_grid))
    except ValueError as exc:
        write_event(ErrorEvent(event="error", code="invalid_input",
                               message=str(exc), fatal=True))
        return 1

    shell = Shell(cmd.shell.standoff_min_mm, cmd.shell.standoff_max_mm,
                  cmd.shell.height_min_mm, cmd.shell.height_max_mm)
    seed_stations = seed_cameras(geom, K, image_size, shell, n_fan=cmd.n_fan)
    seed_cams = [s.camera for s in seed_stations]
    score_kwargs = dict(pixel_sigma=cmd.pixel_sigma_px,
                        nominal_deviation_mm=cmd.nominal_deviation_mm,
                        focal_err_frac=cmd.focal_err_frac,
                        incidence_max_deg=cmd.incidence_max_deg,
                        trials=cmd.trials, seed=cmd.seed,
                        target_p95_residual_mm=cmd.target_p95_residual_mm,
                        min_views=cmd.min_views)
    result = optimize(geom, K, image_size, shell, seed_cams=seed_cams,
                      max_stations=cmd.max_stations, n_standoff=cmd.n_standoff,
                      n_height=cmd.n_height, n_azimuth=cmd.n_azimuth,
                      score_kwargs=score_kwargs)

    # Single source of truth: optimize already computed the final report (all
    # per-cabinet fields) and the per-(cam, cabinet) `counts` for the chosen
    # cameras. Reuse both instead of re-running coverage_report.
    counts = result.counts

    roles = ([s.role for s in seed_stations]
             + ["added"] * (len(result.cameras) - len(seed_cams)))
    cx = geom.total_width_mm / 2.0
    stations = []
    for ci, cam in enumerate(result.cameras):
        pos = -cam.R.T @ cam.t
        aim = _aim_point_on_wall(cam)
        covers = [[c.col, c.row] for c in geom.cabinets
                  if counts.get((ci, (c.col, c.row)), 0) >= gates.MIN_PNP_CORNERS]
        stations.append(CaptureStationData(
            id=f"S{ci + 1:02d}",
            position_mm=[float(x) for x in pos],
            look_at_mm=[float(x) for x in aim],
            standoff_mm=float(math.hypot(pos[0] - cx, pos[2])),
            height_mm=float(pos[1]),
            role=roles[ci],
            covers_cabinets=covers,
        ))

    coverage = []
    for cabg in geom.cabinets:
        v = result.report[(cabg.col, cabg.row)]
        p95 = v["p95_mm"]
        coverage.append(CabinetCoverageData(
            col=cabg.col, row=cabg.row,
            p95_residual_mm=(None if (p95 is None or math.isnan(p95)) else float(p95)),
            n_views=v["n_views"], total_observations=v["total_observations"],
            reconstructable=v["reconstructable"], low_observation=v["low_observation"],
            bridged=v["bridged"], pass_=v["pass"], fail_reason=v["fail_reason"],
        ))

    unreachable = []
    if result.unreachable:
        unreachable.append(UnreachableRegionData(
            cabinets=[[col, row] for (col, row) in result.unreachable],
            reason="no shell placement meets target (raise shell / split arc / add bridging)",
        ))

    write_event(PlanCaptureResultEvent(event="result", data=PlanCaptureResultData(
        stations=stations, coverage=coverage, unreachable_regions=unreachable,
        all_pass=(len(result.unreachable) == 0),
        target_p95_residual_mm=cmd.target_p95_residual_mm,
    )))
    return 0
