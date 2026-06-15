"""vpcal export — export calibrated tracking (operation export.opentrackio)."""

from __future__ import annotations

import json
from pathlib import Path

import click
import numpy as np

from vpcal.cli._common import OperationOutput, common_options, run_operation
from vpcal.core.errors import ResourceNotFoundError


@click.group()
@click.pass_context
def export(ctx: click.Context) -> None:
    """Export calibration results."""


def _effective_lens(nominal, lens_estimate: dict):
    """Rebuild the effective LensProfile from a result.json ``lens_estimate`` block.

    Each param's stored ``value`` is the estimate when kept, else the nominal
    fallback, so the values can be used directly (QLE review P2).
    """
    from vpcal.models.lens import BrownConradyDistortion, LensProfile

    d = nominal.distortion
    focal = nominal.focal_length_mm
    if lens_estimate.get("focal_length_mm"):
        focal = lens_estimate["focal_length_mm"]["value"]
    ppo = list(nominal.principal_point_offset_mm)
    pp = lens_estimate.get("principal_point_offset_mm")
    if pp:
        ppo = [pp[0]["value"], pp[1]["value"]]
    k1 = lens_estimate["distortion_k1"]["value"] if lens_estimate.get("distortion_k1") else d.k1
    k2 = lens_estimate["distortion_k2"]["value"] if lens_estimate.get("distortion_k2") else d.k2
    return LensProfile(
        focal_length_mm=focal, sensor_width_mm=nominal.sensor_width_mm,
        sensor_height_mm=nominal.sensor_height_mm, principal_point_offset_mm=(ppo[0], ppo[1]),
        image_width_px=nominal.image_width_px, image_height_px=nominal.image_height_px,
        distortion=BrownConradyDistortion(k1=k1, k2=k2, k3=d.k3, p1=d.p1, p2=d.p2),
    )


@export.command()
@click.option("--result", "result_path", required=True, type=click.Path(), help="Path to result.json.")
@click.option("--session", "session_path", required=True, type=click.Path(), help="Path to session.json (lens + coords).")
@click.option("--out", "out_path", required=True, type=click.Path(), help="Output OpenTrackIO JSONL path.")
@click.option("--frame", "frame", type=click.Choice(["spec", "ue"]), default="spec", show_default=True,
              help="Pose frame: 'spec' = OpenTrackIO RH Z-up Y-forward; 'ue' = Unreal LH (non-spec).")
@common_options
@click.pass_context
def opentrackio(ctx, result_path, session_path, out_path, frame, **flags) -> None:
    """Export calibrated camera poses as OpenTrackIO JSONL."""

    def body() -> OperationOutput:
        from vpcal.io.export.opentrackio import export_opentrackio
        from vpcal.io.tracking_io import load_tracking, to_internal_poses
        from vpcal.models.session import SessionConfig

        rp, sp = Path(result_path), Path(session_path)
        for label, p in [("result", rp), ("session", sp)]:
            if not p.exists():
                raise ResourceNotFoundError(f"{label} not found: {p}", details={"path": str(p)})
        result = json.loads(rp.read_text())
        session = SessionConfig.model_validate(json.loads(sp.read_text()))

        tracking_path = sp.parent / session.tracking.path
        frames = load_tracking(tracking_path)
        poses = to_internal_poses(frames, session.tracking.coordinate_system, session.tracking.custom_transform)
        tracker_poses = [
            (f.frame_id, f.timestamp_s, poses[f.frame_id][0], poses[f.frame_id][1])
            for f in frames if f.frame_id in poses
        ]
        t2s = (np.asarray(result["tracker_to_stage"]["rotation"]), np.asarray(result["tracker_to_stage"]["translation"]))
        c2t = (np.asarray(result["tracker_to_camera"]["rotation"]), np.asarray(result["tracker_to_camera"]["translation"]))

        # If the result carries a Quick Lens Estimate, export that (session-coupled,
        # non-master) lens rather than the nominal session lens (QLE review P2).
        lens_estimate = (result.get("quality") or {}).get("lens_estimate")
        session_estimate = lens_estimate is not None
        lens = _effective_lens(session.lens, lens_estimate) if session_estimate else session.lens

        if flags.get("dry_run"):
            return OperationOutput(
                data={"exit_code": 0, "dry_run_plan": {"output": out_path, "samples": len(tracker_poses),
                                                        "session_estimate": session_estimate}},
                text="Dry run OK.",
            )
        n = export_opentrackio(tracker_poses, t2s, c2t, lens, out_path, session_estimate=session_estimate,
                               frame=frame)
        return OperationOutput(data={"output": out_path, "samples": n, "session_estimate": session_estimate},
                               text=f"Exported {n} OpenTrackIO samples → {out_path}")

    run_operation("export.opentrackio", body, **flags)


@export.command()
@click.option("--result", "result_path", required=True, type=click.Path(), help="Path to result.json.")
@click.option("--screen", "screen_path", required=True, type=click.Path(), help="Path to screen definition JSON.")
@click.option("--out-dir", required=True, type=click.Path(file_okay=False), help="Output directory for the nDisplay config.")
@common_options
@click.pass_context
def ndisplay(ctx, result_path, screen_path, out_dir, **flags) -> None:
    """Export calibrated screen geometry + transforms for UE nDisplay (version-locked)."""

    def body() -> OperationOutput:
        from vpcal.io.export.ndisplay import TARGET_UE_VERSION, export_ndisplay
        from vpcal.io.screen_io import load_screen

        rp, sp = Path(result_path), Path(screen_path)
        for label, p in [("result", rp), ("screen", sp)]:
            if not p.exists():
                raise ResourceNotFoundError(f"{label} not found: {p}", details={"path": str(p)})
        result = json.loads(rp.read_text())
        screen = load_screen(str(sp))

        if flags.get("dry_run"):
            return OperationOutput(
                data={"exit_code": 0, "dry_run_plan": {"out_dir": out_dir, "target_ue_version": TARGET_UE_VERSION}},
                text="Dry run OK.",
            )
        summary = export_ndisplay(screen, result, out_dir)
        return OperationOutput(
            data=summary,
            text=(f"Exported nDisplay config ({summary['num_screens']} screens, "
                  f"UE {summary['target_ue_version']}) → {out_dir}/ndisplay.json (+ README.md)"),
        )

    run_operation("export.ndisplay", body, **flags)
