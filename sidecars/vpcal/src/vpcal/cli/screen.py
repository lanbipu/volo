"""vpcal screen — screen definition management (screen.create / screen.import)."""

from __future__ import annotations

import click

from vpcal.cli._common import OperationOutput, common_options, run_operation
from vpcal.core.errors import ArgumentError


@click.group()
@click.pass_context
def screen(ctx: click.Context) -> None:
    """Create and manage screen definitions."""


@screen.command()
@click.option("--name", required=True, help="Screen name.")
@click.option("--out", "out_path", required=True, type=click.Path(), help="Output screen JSON path.")
@click.option("--cabinet-size", nargs=2, type=float, default=None, help="Cabinet width height (mm). Auto-calculated from screen dimensions if omitted.")
@click.option("--pixel-pitch", type=float, default=2.8, show_default=True, help="LED pixel pitch (mm).")
@click.option("--section-type", type=click.Choice(["plane", "arc"]), default="plane", show_default=True)
@click.option("--section-name", default="wall", show_default=True)
@click.option("--width", type=float, default=None, help="Plane width (mm).")
@click.option("--height", type=float, required=True, help="Section height (mm).")
@click.option("--arc-radius", type=float, default=None, help="Arc radius (mm).")
@click.option("--arc-angle", type=float, default=None, help="Arc angle (deg).")
@click.option("--arc-center-angle", type=float, default=180.0, show_default=True, help="Arc centre angle (deg).")
@click.option("--origin", nargs=3, type=float, default=(0.0, 0.0, 0.0), help="Section origin (mm).")
@common_options
@click.pass_context
def create(ctx, name, out_path, cabinet_size, pixel_pitch, section_type, section_name,
           width, height, arc_radius, arc_angle, arc_center_angle, origin, **flags) -> None:
    """Create a single-section screen definition JSON."""

    def body() -> OperationOutput:
        from vpcal.io.screen_io import save_screen
        from vpcal.models.screen import ArcSection, PlaneSection, ScreenDefinition
        from vpcal.core.screen_geometry import auto_cabinet_size, cabinet_coverage_warning

        if section_type == "plane":
            if width is None:
                raise ArgumentError("--width is required for a plane section")
            section = PlaneSection(name=section_name, width_mm=width, height_mm=height, origin=list(origin))
        else:
            if arc_radius is None or arc_angle is None:
                raise ArgumentError("--arc-radius and --arc-angle are required for an arc section")
            section = ArcSection(
                name=section_name, arc_radius_mm=arc_radius, arc_angle_deg=arc_angle,
                arc_center_angle_deg=arc_center_angle, height_mm=height, origin=list(origin),
            )
        auto = cabinet_size is None
        effective_cabinet = auto_cabinet_size([section], led_pixel_pitch_mm=pixel_pitch) if auto else cabinet_size
        effective_mpc = 1 if auto else 4
        screen_def = ScreenDefinition(
            name=name, unit="mm", cabinet_size=effective_cabinet, led_pixel_pitch_mm=pixel_pitch,
            markers_per_cabinet=effective_mpc, sections=[section],
        )
        warnings = []
        warn = cabinet_coverage_warning(screen_def)
        if warn:
            warnings.append(warn)
        if flags.get("dry_run"):
            return OperationOutput(data={"exit_code": 0, "dry_run_plan": {"output": out_path}}, text="Dry run OK.")
        save_screen(screen_def, out_path)
        data = {"output": out_path, "sections": [section_name], "cabinet_size": list(effective_cabinet)}
        if warnings:
            data["warnings"] = warnings
        auto_label = " (auto)" if cabinet_size is None else ""
        text = f"Wrote screen definition → {out_path} (cabinet {effective_cabinet[0]:.0f}×{effective_cabinet[1]:.0f}mm{auto_label})"
        if warnings:
            text += "\n" + "\n".join(f"WARNING: {w}" for w in warnings)
        return OperationOutput(data=data, text=text)

    run_operation("screen.create", body, **flags)


@screen.command(name="import")
@click.option("--obj", "obj_path", required=True, type=click.Path(exists=True), help="Input OBJ mesh.")
@click.option("--name", required=True, help="Screen name.")
@click.option("--out", "out_path", required=True, type=click.Path(), help="Output screen JSON path.")
@click.option("--cabinet-size", nargs=2, type=float, default=None, help="Cabinet width height (mm). Auto-calculated if omitted.")
@click.option("--pixel-pitch", type=float, default=2.8, show_default=True, help="LED pixel pitch (mm).")
@common_options
@click.pass_context
def import_(ctx, obj_path, name, out_path, cabinet_size, pixel_pitch, **flags) -> None:
    """Import a screen definition from an OBJ mesh (auto-fit plane/arc sections)."""

    def body() -> OperationOutput:
        from vpcal.io.screen_io import import_obj, save_screen
        from vpcal.core.screen_geometry import auto_cabinet_size, cabinet_coverage_warning

        auto = cabinet_size is None
        initial_cabinet = (500.0, 500.0) if auto else cabinet_size
        screen_def = import_obj(obj_path, name=name, cabinet_size=initial_cabinet, led_pixel_pitch_mm=pixel_pitch)
        if auto:
            effective = auto_cabinet_size(screen_def.sections, led_pixel_pitch_mm=pixel_pitch)
            screen_def = screen_def.model_copy(update={"cabinet_size": effective, "markers_per_cabinet": 1})
        warnings = []
        warn = cabinet_coverage_warning(screen_def)
        if warn:
            warnings.append(warn)
        if flags.get("dry_run"):
            return OperationOutput(
                data={"exit_code": 0, "dry_run_plan": {"output": out_path, "sections": [s.name for s in screen_def.sections]}},
                text="Dry run OK.",
            )
        save_screen(screen_def, out_path)
        names = [s.name for s in screen_def.sections]
        data: dict = {"output": out_path, "sections": names}
        if warnings:
            data["warnings"] = warnings
        text = f"Imported {len(names)} section(s) → {out_path}"
        if warnings:
            text += "\n" + "\n".join(f"WARNING: {w}" for w in warnings)
        return OperationOutput(data=data, text=text)

    run_operation("screen.import", body, **flags)
