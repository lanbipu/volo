"""vpcal pattern — calibration pattern generation (operation pattern.generate)."""

from __future__ import annotations

import click

from vpcal.cli._common import OperationOutput, common_options, run_operation


@click.group()
@click.pass_context
def pattern(ctx: click.Context) -> None:
    """Generate and manage calibration patterns."""


@pattern.command()
@click.option("--screen", "screen_path", required=True, type=click.Path(exists=True), help="Screen definition JSON.")
@click.option("--output-dir", required=True, type=click.Path(file_okay=False), help="Directory for pattern images.")
@click.option("--max-dim", type=int, default=8192, show_default=True, help="Max image dimension (px).")
@click.option("--screen-id", type=int, default=0, show_default=True, help="VP-QSP screen_id (0-15).")
@click.option("--cab-col-offset", type=int, default=0, show_default=True, help="Cabinet column offset for multi-screen setups.")
@click.option("--graycode-tags", is_flag=True,
              help="Embed corner Gray-code sequence tags for playback sync (C1.3).")
@common_options
@click.pass_context
def generate(ctx, screen_path, output_dir, max_dim, screen_id, cab_col_offset, graycode_tags, **flags) -> None:
    """Generate VP-QSP patterns (normal + inverted) for a screen.

    For multi-screen setups, use --cab-col-offset to assign unique marker IDs
    per screen (e.g. screen A: offset 0, screen B: offset 16).
    """

    def body() -> OperationOutput:
        from vpcal.core.pattern import generate_pattern_images
        from vpcal.io.screen_io import load_screen

        screen = load_screen(screen_path)
        if flags.get("dry_run"):
            return OperationOutput(
                data={"exit_code": 0, "dry_run_plan": {"output_dir": output_dir}},
                text="Dry run OK.",
            )
        summary = generate_pattern_images(
            screen, output_dir, markers_per_cabinet=screen.markers_per_cabinet,
            max_dim=max_dim, screen_id=screen_id, cab_col_offset=cab_col_offset,
            graycode_tags=graycode_tags,
        )
        text = f"Generated {len(summary['files'])} pattern image(s) ({summary['num_markers']} markers)."
        if cab_col_offset:
            text += f" (cab_col offset: {cab_col_offset})"
        if summary["warnings"]:
            text += "\n  " + "\n  ".join(summary["warnings"])
        return OperationOutput(data=summary, text=text)

    run_operation("pattern.generate", body, **flags)
