"""vpcal marker-map — surveyed marker map workflows (AR mode, plan A3/B2)."""

from __future__ import annotations

import click

from vpcal.cli._common import OperationOutput, common_options, run_operation


@click.group(name="marker-map")
@click.pass_context
def marker_map(ctx: click.Context) -> None:
    """Create, validate and transform surveyed marker maps (AR calibration)."""


@marker_map.command()
@click.option("--from-csv", "csv_path", required=True, type=click.Path(), help="Survey CSV (rich or name,x,y,z,note layout).")
@click.option("--frame-name", required=True, help="Stage-frame definition text (origin/axes semantics; RH, Z up).")
@click.option("--name", "map_name", default=None, help="Optional map name.")
@click.option("--out", "out_path", required=True, type=click.Path(), help="Output marker map JSON path.")
@common_options
@click.pass_context
def create(ctx, csv_path, frame_name, map_name, out_path, **flags) -> None:
    """Import a survey CSV into a marker map JSON."""

    def body() -> OperationOutput:
        from vpcal.core.marker_map import validate_marker_map
        from vpcal.io.marker_map_io import marker_map_from_csv, save_marker_map

        mm = marker_map_from_csv(csv_path, frame_name=frame_name, name=map_name)
        report = validate_marker_map(mm)
        if flags.get("dry_run"):
            return OperationOutput(
                data={"exit_code": 0, "dry_run_plan": {"out": out_path, "markers": len(mm.markers)}},
                text="Dry run OK.",
            )
        save_marker_map(mm, out_path)
        data = {"output": out_path, "markers": len(mm.markers), "validation": report}
        text = (
            f"Imported {len(mm.markers)} marker(s) → {out_path}\n"
            + "\n".join(f"  ! {w}" for w in report["warnings"])
        ).rstrip()
        return OperationOutput(data=data, text=text)

    run_operation("marker_map.create", body, **flags)


@marker_map.command()
@click.argument("map_path", type=click.Path())
@common_options
@click.pass_context
def validate(ctx, map_path, **flags) -> None:
    """Geometric / degeneracy checks of a marker map (exit 6 on hard failure)."""

    def body() -> OperationOutput:
        from vpcal.core.marker_map import fit_ground_plane, validate_marker_map, world_alignment_uncertainty
        from vpcal.io.marker_map_io import load_marker_map

        mm = load_marker_map(map_path)
        report = validate_marker_map(mm)
        ground = fit_ground_plane(mm)
        alignment = world_alignment_uncertainty(mm)
        data = {"validation": report, "ground_plane": ground, "world_alignment": alignment}
        lines = [
            f"Marker map OK: {report['num_markers']} markers "
            f"({report['num_detectable']} detectable, {report['num_points']} points, "
            f"span {report['span_mm']:.0f} mm)",
            f"  world alignment  : {alignment['grade']}"
            + (f" (max {alignment['max_uncertainty_mm']:.1f} mm)" if alignment["max_uncertainty_mm"] is not None else ""),
        ]
        if ground["available"]:
            lines.append(
                f"  ground plane     : {ground['num_ground_markers']} markers, "
                f"residual RMS {ground['residual_rms_mm']:.2f} mm, "
                f"tilt {ground['tilt_from_z_deg']:.3f}°, offset {ground['offset_from_z0_mm']:.2f} mm"
            )
        for w in report["warnings"] + ground.get("warnings", []):
            lines.append(f"  ! {w}")
        return OperationOutput(data=data, text="\n".join(lines))

    run_operation("marker_map.validate", body, **flags)


@marker_map.command()
@click.option("--dict", "dictionary", required=True, help="cv2.aruco dictionary, e.g. DICT_APRILTAG_36h11.")
@click.option("--ids", "id_spec", required=True, help="Tag ids, e.g. '0-11' or '0,3,7'.")
@click.option("--size-mm", type=float, default=160.0, show_default=True, help="Printed tag edge length (mm).")
@click.option("--out-dir", required=True, type=click.Path(file_okay=False), help="Output directory for the board PNGs.")
@common_options
@click.pass_context
def board(ctx, dictionary, id_spec, size_mm, out_dir, **flags) -> None:
    """Generate printable marker boards (PNG + survey CSV template)."""

    def body() -> OperationOutput:
        from vpcal.core.marker_boards import generate_boards, parse_id_range

        ids = parse_id_range(id_spec)
        if flags.get("dry_run"):
            return OperationOutput(
                data={"exit_code": 0, "dry_run_plan": {"ids": ids, "out_dir": out_dir}},
                text="Dry run OK.",
            )
        summary = generate_boards(dictionary, ids, out_dir, size_mm=size_mm)
        return OperationOutput(
            data=summary,
            text=(f"Generated {len(summary['boards'])} board(s) ({dictionary}, "
                  f"{size_mm:.0f} mm) → {out_dir}\n"
                  f"  survey template: {summary['survey_template']}"),
        )

    run_operation("marker_map.board", body, **flags)


@marker_map.command()
@click.option("--size-mm", type=float, default=300.0, show_default=True, help="Cube edge length (mm).")
@click.option("--dict", "dictionary", required=True, help="cv2.aruco dictionary, e.g. DICT_APRILTAG_36h11.")
@click.option("--start-id", type=int, default=0, show_default=True, help="First tag id (5 consecutive ids used).")
@click.option("--tolerance-mm", type=float, default=1.0, show_default=True,
              help="Manufacturing tolerance recorded as the map's uncertainty_mm.")
@click.option("--out-dir", required=True, type=click.Path(file_okay=False), help="Output directory.")
@common_options
@click.pass_context
def cube(ctx, size_mm, dictionary, start_id, tolerance_mm, out_dir, **flags) -> None:
    """Generate DIY calibration-cube face sheets + the CAD-truth map JSON."""

    def body() -> OperationOutput:
        from vpcal.core.marker_boards import generate_cube

        if flags.get("dry_run"):
            return OperationOutput(
                data={"exit_code": 0, "dry_run_plan": {"size_mm": size_mm, "out_dir": out_dir}},
                text="Dry run OK.",
            )
        summary = generate_cube(
            dictionary, out_dir, size_mm=size_mm, start_id=start_id, tolerance_mm=tolerance_mm
        )
        return OperationOutput(
            data=summary,
            text=(f"Generated {summary['num_markers']} cube face sheet(s) "
                  f"({size_mm:.0f} mm edge, tag {summary['tag_mm']:.0f} mm) → {out_dir}\n"
                  f"  marker map: {summary['marker_map']}"),
        )

    run_operation("marker_map.cube", body, **flags)


@marker_map.command()
@click.argument("map_path", type=click.Path())
@click.option("--to-ground", "to_ground", is_flag=True, required=True,
              help="Re-base the stage frame so the fitted ground plane is Z=0.")
@click.option("--out", "out_path", required=True, type=click.Path(), help="Output (re-based) marker map JSON.")
@common_options
@click.pass_context
def rebase(ctx, map_path, to_ground, out_path, **flags) -> None:
    """Explicitly re-base the map's stage frame (audited; never automatic)."""

    def body() -> OperationOutput:
        from vpcal.core.marker_map import rebase_to_ground
        from vpcal.io.marker_map_io import load_marker_map, save_marker_map

        mm = load_marker_map(map_path)
        rebased, audit = rebase_to_ground(mm)
        if flags.get("dry_run"):
            return OperationOutput(
                data={"exit_code": 0, "dry_run_plan": {"out": out_path, "audit": audit}},
                text="Dry run OK.",
            )
        save_marker_map(rebased, out_path)
        return OperationOutput(
            data={"output": out_path, "audit": audit},
            text=(f"Re-based marker map → {out_path}\n"
                  f"  corrected tilt {audit['tilt_corrected_deg']:.3f}°, "
                  f"offset {audit['offset_corrected_mm']:.2f} mm (transform recorded in rebase_history)"),
        )

    run_operation("marker_map.rebase", body, **flags)
