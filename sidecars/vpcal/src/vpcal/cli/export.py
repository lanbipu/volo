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




@export.command()
@click.option("--result", "result_path", required=True, type=click.Path(), help="Path to result.json.")
@click.option("--session", "session_path", required=True, type=click.Path(), help="Path to session.json (lens + coords).")
@click.option("--out", "out_path", required=True, type=click.Path(), help="Output OpenTrackIO JSONL path.")
@click.option("--frame", "frame", type=click.Choice(["spec", "ue"]), default="spec", show_default=True,
              help="Pose frame: 'spec' = OpenTrackIO RH Z-up Y-forward; 'ue' = Unreal LH (non-spec).")
@click.option("--apply-delay", "apply_delay_ms", type=float, default=None,
              help="Re-timestamp samples by this video↔tracking delay (ms, tracking-leads-video).")
@click.option("--delay-profile", "delay_profile_path", type=click.Path(), default=None,
              help="Read the delay from a timing/delay_profile.json (capture delay-cal output).")
@common_options
@click.pass_context
def opentrackio(ctx, result_path, session_path, out_path, frame, apply_delay_ms,
                delay_profile_path, **flags) -> None:
    """Export calibrated camera poses as OpenTrackIO JSONL."""

    def body() -> OperationOutput:
        from vpcal.core.errors import ArgumentError
        from vpcal.io.export.opentrackio import export_opentrackio
        from vpcal.io.tracking_io import load_tracking, to_internal_poses
        from vpcal.models.session import SessionConfig

        rp, sp = Path(result_path), Path(session_path)
        for label, p in [("result", rp), ("session", sp)]:
            if not p.exists():
                raise ResourceNotFoundError(f"{label} not found: {p}", details={"path": str(p)})
        result = json.loads(rp.read_text())
        session = SessionConfig.model_validate(json.loads(sp.read_text()))

        delay_ms = apply_delay_ms
        if delay_profile_path is not None:
            if apply_delay_ms is not None:
                raise ArgumentError("--apply-delay and --delay-profile are mutually exclusive")
            dp = Path(delay_profile_path)
            if not dp.exists():
                raise ResourceNotFoundError(f"delay profile not found: {dp}", details={"path": str(dp)})
            profile = json.loads(dp.read_text())
            cameras = profile.get("cameras") or []
            if not cameras or "delay_ms" not in cameras[0]:
                raise ArgumentError(f"delay profile has no cameras[0].delay_ms: {dp}")
            delay_ms = float(cameras[0]["delay_ms"])

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
        from vpcal.models.lens import effective_lens

        lens = effective_lens(session.lens, lens_estimate) if session_estimate else session.lens

        if flags.get("dry_run"):
            return OperationOutput(
                data={"exit_code": 0, "dry_run_plan": {"output": out_path, "samples": len(tracker_poses),
                                                        "session_estimate": session_estimate,
                                                        "applied_delay_ms": delay_ms}},
                text="Dry run OK.",
            )
        n = export_opentrackio(tracker_poses, t2s, c2t, lens, out_path, session_estimate=session_estimate,
                               frame=frame, applied_delay_ms=delay_ms)
        text = f"Exported {n} OpenTrackIO samples → {out_path}"
        if delay_ms is not None:
            text += f" (delay-compensated {delay_ms:+.1f} ms; flagged in tracker.notes)"
        return OperationOutput(data={"output": out_path, "samples": n, "session_estimate": session_estimate,
                                     "applied_delay_ms": delay_ms},
                               text=text)

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
